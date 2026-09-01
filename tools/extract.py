"""Turn a scaled architectural PDF floor plan into an architect3d design.

The output is a first draft, not a survey. Automatic tracing of a builder's
drawing cannot be trusted: cabinet runs, counters, fixtures and door swings all
produce the same parallel-line pairs that walls do, and no threshold separates
them cleanly. So this does two things and leaves the third to a human:

  1. traces the wall skeleton -- pairs of parallel lines a plausible wall
     thickness apart become one centreline;
  2. renders the same region of the PDF to a PNG and wires it up as
     architect3d's carbon sheet, aligned to the traced walls.

The design then opens with the real drawing showing through underneath, so
anything mistraced is visible immediately and can be dragged into place in the
2D editor. That is a better use of the editor than a cleverer tracer would be.

    python tools/extract.py plans/plan.pdf -o data/design.json
"""

import argparse
import json
import math
import os
import uuid

import pymupdf

QUARTER_SCALE = 2 / 3  # pt -> real inches at 1/4" = 1'-0"
CM_PER_INCH = 2.54

# A traced pair of lines is a wall if it is between these two apart. 2x4
# interior partitions finish around 4.5" and 2x6 exterior walls around 6.5"; the
# band is wide enough for both plus the drafter's line weight, and narrow enough
# to reject a 24" counter or a 12" cabinet.
WALL_MIN_IN, WALL_MAX_IN = 3.0, 9.0
MIN_OVERLAP_IN = 18.0  # shorter than this is trim, not structure
SNAP_IN = 3.0  # corner weld radius

WALL_TEXTURE = {"url": "rooms/textures/wallmap.png", "stretch": True, "scale": 0}


def segments(page, clip, k):
    """Axis-aligned line segments inside `clip`, in real inches."""
    horiz, vert = [], []
    for path in page.get_drawings():
        for item in path["items"]:
            if item[0] != "l":
                continue
            a, b = item[1], item[2]
            if not (clip.contains(a) and clip.contains(b)):
                continue
            if abs(a.y - b.y) < 0.3 and abs(a.x - b.x) > 0.5:
                horiz.append((a.y * k, min(a.x, b.x) * k, max(a.x, b.x) * k))
            elif abs(a.x - b.x) < 0.3 and abs(a.y - b.y) > 0.5:
                vert.append((a.x * k, min(a.y, b.y) * k, max(a.y, b.y) * k))
    return horiz, vert


def merge_collinear(runs, tol=0.5, join=1.5):
    """Collapse segments sharing a line into maximal runs."""
    out = []
    for coord, lo, hi in sorted(runs):
        for run in out:
            if abs(run[0] - coord) < tol and lo <= run[2] + join and hi >= run[1] - join:
                run[1], run[2] = min(run[1], lo), max(run[2], hi)
                break
        else:
            out.append([coord, lo, hi])
    return out


def centrelines(runs):
    """Pair parallel runs a wall-thickness apart into single centrelines."""
    found = []
    runs = sorted(runs)
    for i, (c1, lo1, hi1) in enumerate(runs):
        for c2, lo2, hi2 in runs[i + 1:]:
            gap = c2 - c1
            if gap > WALL_MAX_IN:
                break
            if gap < WALL_MIN_IN:
                continue
            lo, hi = max(lo1, lo2), min(hi1, hi2)
            if hi - lo >= MIN_OVERLAP_IN:
                found.append([(c1 + c2) / 2.0, lo, hi])
    # One wall traced from several overlapping pairs appears several times.
    return merge_collinear(found, tol=2.0, join=6.0)


def build_graph(horiz, vert):
    """Split centrelines where they cross, then weld coincident endpoints.

    architect3d derives rooms by walking closed loops of corners, so walls that
    merely overlap on screen are not enough -- a T-junction has to be a real
    corner shared by three walls, or the room on either side of it is never
    found.
    """
    hcuts = [set() for _ in horiz]
    vcuts = [set() for _ in vert]
    for i, (hy, hx0, hx1) in enumerate(horiz):
        for j, (vx, vy0, vy1) in enumerate(vert):
            if hx0 - SNAP_IN <= vx <= hx1 + SNAP_IN and vy0 - SNAP_IN <= hy <= vy1 + SNAP_IN:
                hcuts[i].add(vx)
                vcuts[j].add(hy)

    corners, walls = {}, []

    def corner_at(x, y):
        for cid, (cx, cy) in corners.items():
            if math.hypot(cx - x, cy - y) <= SNAP_IN:
                return cid
        cid = str(uuid.uuid4())
        corners[cid] = (x, y)
        return cid

    for runs, cutsets, horizontal in ((horiz, hcuts, True), (vert, vcuts, False)):
        for (coord, lo, hi), cuts in zip(runs, cutsets):
            stops = sorted({lo, hi} | {c for c in cuts if lo < c < hi})
            for a, b in zip(stops, stops[1:]):
                if b - a < SNAP_IN:
                    continue
                ends = ((a, coord), (b, coord)) if horizontal else ((coord, a), (coord, b))
                c1, c2 = corner_at(*ends[0]), corner_at(*ends[1])
                if c1 != c2:
                    walls.append((c1, c2))
    return corners, walls


def design(corners, walls, ceiling_in, underlay):
    ox = min(x for x, _ in corners.values())
    oy = min(y for _, y in corners.values())
    elev = round(ceiling_in * CM_PER_INCH, 2)
    return {
        "floorplan": {
            # Declared, so the loader reads these as centimetres rather than
            # falling back to "whatever unit was on screen when it was saved".
            "units": "cm",
            "corners": {
                cid: {"x": round((x - ox) * CM_PER_INCH, 2),
                      "y": round((y - oy) * CM_PER_INCH, 2),
                      "elevation": elev}
                for cid, (x, y) in corners.items()
            },
            "walls": [{"corner1": a, "corner2": b,
                       "frontTexture": dict(WALL_TEXTURE),
                       "backTexture": dict(WALL_TEXTURE)}
                      for a, b in walls],
            "rooms": {},
            "wallTextures": [], "floorTextures": {}, "newFloorTextures": {},
            "carbonSheet": underlay,
        },
        "items": [],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("-o", "--out", default="data/design.json")
    ap.add_argument("--page", type=int, default=2, help="1-indexed")
    ap.add_argument("--clip", nargs=4, type=float, default=[1500, 380, 2440, 980],
                    metavar=("X0", "Y0", "X1", "Y1"), help="plan region, PDF points")
    ap.add_argument("--ceiling", type=float, default=96.0, help="inches")
    ap.add_argument("--scale", type=float, default=QUARTER_SCALE)
    ap.add_argument("--underlay", default="underlay.png",
                    help="written beside --out; referenced by the carbon sheet")
    ap.add_argument("--url-prefix", default="plan/",
                    help="where the app serves --out's directory from")
    args = ap.parse_args()

    page = pymupdf.open(args.pdf)[args.page - 1]
    clip = pymupdf.Rect(*args.clip)

    horiz, vert = segments(page, clip, args.scale)
    hc = centrelines(merge_collinear(horiz))
    vc = centrelines(merge_collinear(vert))
    corners, walls = build_graph(hc, vc)
    if not corners:
        raise SystemExit("traced nothing -- check --clip against the sheet")

    outdir = os.path.dirname(args.out) or "."
    os.makedirs(outdir, exist_ok=True)

    # Rendered from the same clip the walls were traced in, so its pixel extent
    # covers the same real inches. That is what lets the carbon sheet line up
    # without hand-nudging.
    pix = page.get_pixmap(dpi=150, clip=clip)
    pix.save(os.path.join(outdir, args.underlay))

    ox = min(x for x, _ in corners.values())
    oy = min(y for _, y in corners.values())
    underlay = {
        "url": args.url_prefix + args.underlay,
        "transparency": 0.5,
        "x": 0, "y": 0,
        "anchorX": round((ox - clip.x0 * args.scale) * CM_PER_INCH, 2),
        "anchorY": round((oy - clip.y0 * args.scale) * CM_PER_INCH, 2),
        "width": round(clip.width * args.scale * CM_PER_INCH, 2),
        "height": round(clip.height * args.scale * CM_PER_INCH, 2),
    }

    with open(args.out, "w") as fh:
        json.dump(design(corners, walls, args.ceiling, underlay), fh, indent=1)

    span_x = max(x for x, _ in corners.values()) - ox
    span_y = max(y for _, y in corners.values()) - oy
    print(f"traced {len(hc)} horizontal + {len(vc)} vertical centrelines")
    print(f"  -> {len(corners)} corners, {len(walls)} walls")
    print(f"  -> extent {span_x / 12:.1f} x {span_y / 12:.1f} ft, ceiling {args.ceiling}\"")
    print(f"  -> {args.out}  (+ {args.underlay}, {pix.width}x{pix.height}px)")


if __name__ == "__main__":
    main()
