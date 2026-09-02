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


## Why walls come out exactly axis-aligned

They are built on a lattice rather than snapped onto one afterwards.

The first version of this welded any two corners within 3in of each other, which
is the obvious thing to do and is wrong: a horizontal wall whose right-hand end
welds to a corner 2in higher than its left-hand end is no longer horizontal. It
is a wall at 0.4 degrees, and a floor plan full of them looks - correctly - like
it was traced by hand in the dark.

So instead: every horizontal centreline's y is clustered with its neighbours and
replaced by the cluster's single shared value, and the same for every vertical's
x. Wall ENDS are then snapped onto the perpendicular axis' clustered values.
A horizontal wall therefore takes its y from one canonical value and both of its
x's from another two, so its endpoints cannot differ in y -- not because
anything rounded them into agreement, but because there is only one y in play.
Corners are looked up by exact coordinate, and welding is gone entirely.

`verify()` asserts this rather than trusting it, and the CLI prints the result.

    python tools/extract.py plans/plan.pdf -o data/design.json
"""

import argparse
import json
import os
import uuid
from collections import defaultdict

import pymupdf

QUARTER_SCALE = 2 / 3  # pt -> real inches at 1/4" = 1'-0"
CM_PER_INCH = 2.54

# A traced pair of lines is a wall if it is between these two apart. 2x4
# interior partitions finish around 4.5" and 2x6 exterior walls around 6.5"; the
# band is wide enough for both plus the drafter's line weight, and narrow enough
# to reject a 24" counter or a 12" cabinet.
WALL_MIN_IN, WALL_MAX_IN = 3.0, 9.0
MIN_OVERLAP_IN = 18.0  # shorter than this is trim, not structure

# How far apart two centrelines can be and still be the same wall line. Pairing
# noise is well under an inch; a real jog in a wall is a stud width or more.
AXIS_TOL_IN = 3.0
# How far a wall END can be from a crossing wall's line and still be meant to
# meet it. Traced ends overshoot or fall short by up to half a wall thickness.
END_TOL_IN = 8.0
GRID_IN = 0.125  # 1/8", finer than anything a builder dimensions to
MIN_WALL_IN = 6.0

WALL_TEXTURE = {"url": "rooms/textures/wallmap.png", "stretch": True, "scale": 0}


def quantise(value):
    return round(value / GRID_IN) * GRID_IN


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


def cluster(values, tol):
    """Single-linkage 1-D clustering. Returns one shared value per cluster."""
    if not values:
        return []
    groups = [[min(values)]]
    for value in sorted(values)[1:]:
        if value - groups[-1][-1] <= tol:
            groups[-1].append(value)
        else:
            groups.append([value])
    return [quantise(sum(g) / len(g)) for g in groups]


def snap(value, canon, tol):
    """Pull `value` onto the nearest canonical axis, if one is close enough."""
    if not canon:
        return quantise(value)
    nearest = min(canon, key=lambda c: abs(c - value))
    return nearest if abs(nearest - value) <= tol else quantise(value)


def lattice(horiz, vert):
    """Put every centreline onto shared axes. This is what makes walls square."""
    ys = cluster([c for c, _, _ in horiz], AXIS_TOL_IN)
    xs = cluster([c for c, _, _ in vert], AXIS_TOL_IN)

    def place(runs, own, cross):
        out = []
        for coord, lo, hi in runs:
            c = snap(coord, own, AXIS_TOL_IN)
            a, b = snap(lo, cross, END_TOL_IN), snap(hi, cross, END_TOL_IN)
            if b - a >= MIN_WALL_IN:
                out.append((c, a, b))
        # Snapping can drop two runs onto the same line; merge them again so a
        # wall is one run and not two overlapping ones.
        return [tuple(r) for r in merge_collinear([list(r) for r in out], tol=1e-9, join=GRID_IN)]

    return place(horiz, ys, xs), place(vert, xs, ys)


def build_graph(horiz, vert):
    """Split centrelines where they cross. Corners are exact lattice points.

    architect3d derives rooms by walking closed loops of corners, so walls that
    merely overlap on screen are not enough -- a T-junction has to be a real
    corner shared by three walls, or the room on either side of it is never
    found. Hence the split; hence also that the cut lands on a coordinate both
    walls already hold, so the corner is shared by identity rather than by
    proximity.
    """
    hcuts = [set() for _ in horiz]
    vcuts = [set() for _ in vert]
    for i, (hy, hx0, hx1) in enumerate(horiz):
        for j, (vx, vy0, vy1) in enumerate(vert):
            if hx0 <= vx <= hx1 and vy0 <= hy <= vy1:
                hcuts[i].add(vx)
                vcuts[j].add(hy)

    corners, walls = {}, []
    by_point = {}

    def corner_at(x, y):
        key = (round(x, 4), round(y, 4))
        if key not in by_point:
            by_point[key] = str(uuid.uuid4())
            corners[by_point[key]] = key
        return by_point[key]

    for runs, cutsets, horizontal in ((horiz, hcuts, True), (vert, vcuts, False)):
        for (coord, lo, hi), cuts in zip(runs, cutsets):
            stops = sorted({lo, hi} | {c for c in cuts if lo < c < hi})
            for a, b in zip(stops, stops[1:]):
                if b - a < MIN_WALL_IN:
                    continue
                ends = ((a, coord), (b, coord)) if horizontal else ((coord, a), (coord, b))
                pair = (corner_at(*ends[0]), corner_at(*ends[1]))
                if pair[0] != pair[1] and pair not in walls and pair[::-1] not in walls:
                    walls.append(pair)
    return corners, walls


def drop_islands(corners, walls, max_area_sqft=40.0):
    """Discard wall runs that are detached from the building and small.

    The bathtub is the motivating case: its rim is two parallel lines a
    plausible stud-wall apart, so it traces as a tidy closed rectangle, and
    nothing local to those four walls says they are a bath and not a closet.
    What does say it is that they touch no other wall in the drawing. Real
    structure is connected -- a room is bounded by walls that are bounded by
    other walls -- so an island is a fixture, and a SMALL island doubly so.

    Detachment alone is not enough, and assuming it was dropped real walls: a
    run of wall with a doorway at each end is disconnected too, which is how a
    first attempt at this deleted half the pantry. The extra test is that the
    island is CLOSED -- every corner joining exactly two walls, so the run comes
    back to where it started. A tub rim does that. A wall between two openings
    cannot: it has two loose ends.

    So all three have to hold: detached, closed, and small.
    """
    adjacency = defaultdict(set)
    for a, b in walls:
        adjacency[a].add(b)
        adjacency[b].add(a)

    seen, components = set(), []
    for start in corners:
        if start in seen:
            continue
        stack, group = [start], []
        seen.add(start)
        while stack:
            node = stack.pop()
            group.append(node)
            for peer in adjacency[node]:
                if peer not in seen:
                    seen.add(peer)
                    stack.append(peer)
        components.append(set(group))

    biggest = max(components, key=len) if components else set()
    keep = set()
    dropped = 0
    for group in components:
        points = [corners[c] for c in group]
        width = max(p[0] for p in points) - min(p[0] for p in points)
        height = max(p[1] for p in points) - min(p[1] for p in points)
        closed = all(len(adjacency[c]) == 2 for c in group)
        if (group is biggest or not closed
                or (width * height) / 144.0 >= max_area_sqft):
            keep |= group
        else:
            dropped += 1

    return ({cid: xy for cid, xy in corners.items() if cid in keep},
            [w for w in walls if w[0] in keep and w[1] in keep],
            dropped)


def verify(corners, walls):
    """What the CLI prints instead of asking anybody to eyeball it.

    Off-axis is the number that matters: it is the defect this rewrite exists to
    remove, and it should be exactly zero, not merely small.
    """
    worst = 0.0
    for a, b in walls:
        (x1, y1), (x2, y2) = corners[a], corners[b]
        worst = max(worst, min(abs(x1 - x2), abs(y1 - y2)))

    degree = defaultdict(int)
    for a, b in walls:
        degree[a] += 1
        degree[b] += 1
    return {
        "off_axis_in": worst,
        "dangling": sum(1 for c in corners if degree[c] == 1),
        "junctions": sum(1 for c in corners if degree[c] >= 3),
    }


def design(corners, walls, ceiling_in, underlay):
    ox = min(x for x, _ in corners.values())
    oy = min(y for _, y in corners.values())
    elev = round(ceiling_in * CM_PER_INCH, 2)
    return {
        "floorplan": {
            # Declared, so the loader reads these as centimetres rather than
            # falling back to "whatever display unit was active at save time".
            "units": "cm",
            "corners": {
                cid: {"x": round((x - ox) * CM_PER_INCH, 4),
                      "y": round((y - oy) * CM_PER_INCH, 4),
                      "elevation": elev}
                for cid, (x, y) in corners.items()
            },
            "walls": [{"corner1": a, "corner2": b,
                       "frontTexture": dict(WALL_TEXTURE),
                       "backTexture": dict(WALL_TEXTURE)}
                      for a, b in walls],
            "rooms": {},
            "wallTextures": [], "floorTextures": {}, "newFloorTextures": {},
            # Left neutral on purpose. loadFloorplan() would read this in the
            # display unit; `underlay` below carries the same sheet in units
            # that mean one thing only, and bootDesign() applies it.
            "carbonSheet": {"url": "", "transparency": 1, "x": 0, "y": 0,
                            "anchorX": 0, "anchorY": 0,
                            "width": 0.01, "height": 0.01},
            "underlay": underlay,
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
    ap.add_argument("--max-island", type=float, default=40.0,
                    help="sq ft; detached runs smaller than this are fixtures")
    args = ap.parse_args()

    page = pymupdf.open(args.pdf)[args.page - 1]
    clip = pymupdf.Rect(*args.clip)

    horiz, vert = segments(page, clip, args.scale)
    hc, vc = lattice(centrelines(merge_collinear(horiz)),
                     centrelines(merge_collinear(vert)))
    corners, walls = build_graph(hc, vc)
    corners, walls, islands = drop_islands(corners, walls, args.max_island)
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
    # Two different units, neither of them obvious, both from carbonsheet.js:
    #
    #   width/height  go through `Dimensioning.cmFromMeasureRaw`, so they are in
    #                 the DISPLAY unit in force when the design loads - metres,
    #                 for this app at boot. Writing centimetres there asks for a
    #                 sheet a mile wide, drawn far enough off screen to look
    #                 like it never loaded at all.
    #   anchorX/Y     are multiplied by `_scaleX`, which is
    #                 screenPixels/imagePixels - so they are in RAW IMAGE PIXELS.
    #
    # Rather than guess the display unit, this writes the honest physical
    # numbers under a key of our own and lets bootDesign() convert. See
    # useDesignIO.js.
    pixels_per_inch = pix.width / (clip.width * args.scale)
    underlay = {
        "url": args.url_prefix + args.underlay,
        "transparency": 0.5,
        "widthCm": round(clip.width * args.scale * CM_PER_INCH, 3),
        "heightCm": round(clip.height * args.scale * CM_PER_INCH, 3),
        "anchorXPx": round((ox - clip.x0 * args.scale) * pixels_per_inch, 2),
        "anchorYPx": round((oy - clip.y0 * args.scale) * pixels_per_inch, 2),
    }

    with open(args.out, "w", newline="\n") as fh:
        json.dump(design(corners, walls, args.ceiling, underlay), fh, indent=1)

    checks = verify(corners, walls)
    span_x = max(x for x, _ in corners.values()) - ox
    span_y = max(y for _, y in corners.values()) - oy
    print(f"traced {len(hc)} horizontal + {len(vc)} vertical centrelines")
    print(f"  -> {len(corners)} corners, {len(walls)} walls "
          f"({islands} detached fixture run{'' if islands == 1 else 's'} dropped)")
    print(f"  -> extent {span_x / 12:.1f} x {span_y / 12:.1f} ft, ceiling {args.ceiling}\"")
    print(f"  -> off-axis {checks['off_axis_in']:.6f}\" "
          f"({'square' if checks['off_axis_in'] == 0 else 'NOT SQUARE'}), "
          f"{checks['junctions']} junctions, {checks['dangling']} loose ends")
    print(f"  -> {args.out}  (+ {args.underlay}, {pix.width}x{pix.height}px)")


if __name__ == "__main__":
    main()
