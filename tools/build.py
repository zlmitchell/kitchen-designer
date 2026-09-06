"""Turn a scaled architectural PDF into an architect3d design.

The entry point for the box pipeline. Replaces extract.py, which built walls on
a lattice of bare centrelines and is kept only until nothing needs it.

    python tools/build.py "plans/your-plan.pdf" -o data/design.json

It writes two things into `data/`, which compose serves at `/plan`:

    design.json    walls, their real thicknesses, and the windows and doors
    underlay.png   the same region of the sheet, aligned to those walls

## What it does, in order

    1. split the sheet into layers by (colour, width, fill)      layers.py
    2. trace the structure layer into wall boxes                 walls.py
    3. find the windows and doors: symbols, and face gaps        opening_truth.py
    4. split each box's centreline where another crosses it      here
    5. write it, with the underlay wired up as a carbon sheet    here

Every stage takes the one above and nothing else. See AGENTS.md for why the
order matters and for the rules that govern each step.

## What reaches the app

Walls carry their MEASURED thickness, face to face, so a 2x4 partition and a
10in exterior wall arrive as themselves rather than as architect3d's configured
default. floorplan.js round-trips the field.

Windows and doors are ITEMS, not gaps: InWallItem and InWallFloorItem belong to
a wall and cut into it, so a wall runs continuously past its own openings and
is split only where it meets another wall or changes height.

A pony wall is still a flag. The drawing draws it as a single thin stroke below
the thickness a wall can be, and nothing yet reads that as a low wall.
"""

import argparse
import json
import math
import os
import sys
import uuid
from collections import defaultdict

import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import extract  # noqa: E402  (items_for, parse_half_wall, the underlay maths)
import layers  # noqa: E402
import opening_truth  # noqa: E402
import walls as wallmod  # noqa: E402

CM_PER_INCH = 2.54
QUARTER_SCALE = 2 / 3
WALL_TEXTURE = {"url": "rooms/textures/wallmap.png", "stretch": True, "scale": 0}
# corner.js welds corners closer than this. It is 20cm there; in inches here,
# because everything upstream of the writer is in inches.
WELD_IN = 20.0 / CM_PER_INCH


def bridge_openings(boxes, openings):
    """Join collinear walls across a gap that one of their openings fills.

    walls.combine() bridges a wall over an opening only where a jamb stub
    survives on the wall's own line. Across a 5ft picture window the wall face
    is simply absent -- the frame is drawn on another line -- so four gaps were
    left on this plan and every one of them produced two loose ends. A loose
    end matters here in a way it does not elsewhere: architect3d finds a room
    by walking a closed loop of corners, and a wall that stops in mid-air
    breaks the loop for the room on both sides of it.

    By this point the openings are known, and a gap an opening fills is not a
    gap in the wall -- it is the hole the wall is drawn around. So the two
    stretches are one wall.
    """
    merged = [dict(box) for box in boxes]
    changed = True
    while changed:
        changed = False
        for one in merged:
            for two in merged:
                if one is two or one["horizontal"] != two["horizontal"]:
                    continue
                if abs(one["centre"] - two["centre"]) > max(one["thickness"],
                                                            two["thickness"]) / 2.0:
                    continue
                lo, hi = min(one["drawn_hi"], two["drawn_hi"]), max(one["drawn_lo"],
                                                                   two["drawn_lo"])
                if hi <= lo:
                    continue
                # By how much of the gap the opening COVERS, not by whether it
                # lines up with it. A wall's face stops short of its own jamb --
                # the door on the y=10.14ft line starts 3.3in inside a 52.3in
                # gap -- so requiring the two to coincide within a couple of
                # inches never fired, the stretch beyond was left unbridged, and
                # the length filter then dropped it. The door was placed on a
                # wall that no longer existed, which the traced-plan suite
                # caught as "Closed Door at (244.44, 297.17) is on no wall
                # line".
                spanned = any(
                    o["horizontal"] == one["horizontal"]
                    and abs(o["centre"] - one["centre"]) <= max(one["thickness"], 6.0)
                    and min(o["hi"], hi) - max(o["lo"], lo) >= (hi - lo) * 0.6
                    for o in openings)
                if not spanned:
                    continue
                one["drawn_lo"] = min(one["drawn_lo"], two["drawn_lo"])
                one["drawn_hi"] = max(one["drawn_hi"], two["drawn_hi"])
                merged.remove(two)
                changed = True
                break
            if changed:
                break
    return merged


def graph(boxes, ceiling_in, height_of=None):
    """Wall boxes -> corners and walls, split where centrelines cross.

    architect3d walks closed loops of corners to find a room, so two walls that
    merely overlap on screen are not enough: a T-junction has to be a corner
    they share. Splitting here rather than in walls.py keeps the box model
    whole for everything else that reads it.

    Corners are keyed by height as well as position. architect3d takes a wall's
    height from its two corners, so one corner cannot be both 42in and 96in --
    a pony wall and the wall it runs into need separate corners in the same
    place.
    """
    cuts = defaultdict(set)
    for index, box in enumerate(boxes):
        for other in boxes:
            if other["horizontal"] == box["horizontal"]:
                continue
            if (box["drawn_lo"] < other["centre"] < box["drawn_hi"]
                    and other["drawn_lo"] <= box["centre"] <= other["drawn_hi"]):
                cuts[index].add(other["centre"])

    corners, walls, by_point = {}, [], {}

    def corner_at(x, y, height):
        key = (round(x, 4), round(y, 4), round(height, 4))
        if key not in by_point:
            by_point[key] = str(uuid.uuid4())
            corners[by_point[key]] = key
        return by_point[key]

    for index, box in enumerate(boxes):
        stops = _thin(sorted({box["drawn_lo"], box["drawn_hi"]} | cuts[index]))
        for lo, hi in zip(stops, stops[1:]):
            if hi - lo < wallmod.MIN_PAIR_IN:
                continue
            height = (height_of(box, lo, hi) if height_of else None) or ceiling_in
            if box["horizontal"]:
                ends = ((lo, box["centre"]), (hi, box["centre"]))
            else:
                ends = ((box["centre"], lo), (box["centre"], hi))
            pair = (corner_at(*ends[0], height), corner_at(*ends[1], height))
            if pair[0] == pair[1]:
                continue
            walls.append({"corner1": pair[0], "corner2": pair[1],
                          "thickness_in": box["thickness"]})
    return corners, walls


def _thin(stops):
    """Drop a cut that would leave a piece the app is going to weld anyway.

    corner.js welds any two corners within cornerTolerance of each other, and
    that constant is 20 CENTIMETRES -- near enough eight inches, where the
    walls on this plan are three to seven and a half thick. So a wall stub
    shorter than that cannot survive being loaded: its two corners merge, the
    wall between them becomes zero-length, and the 3D view builds a room
    polygon around a degenerate edge. Two of them on this plan produced the
    shards in the middle of the floor.

    A stub that short is not worth its own wall in any case. Keeping the outer
    stops and dropping the cut merges it into the neighbour it was split from,
    which also closes the loose end the split created.
    """
    kept = [stops[0]]
    for stop in stops[1:-1]:
        if stop - kept[-1] >= WELD_IN:
            kept.append(stop)
    if len(stops) > 1:
        if stops[-1] - kept[-1] < WELD_IN and len(kept) > 1:
            kept.pop()
        kept.append(stops[-1])
    return kept


def fuse_parallel(boxes):
    """Merge parallel walls too close together for the app to keep apart.

    corner.js welds corners within cornerTolerance -- 20cm, near enough eight
    inches -- so two parallel walls 3.77in apart put corner pairs inside that
    on every wall they both cross, and the loader merges them blind. The wall
    between the merged pair becomes zero-length and the 3D view builds a room
    polygon around a degenerate edge: the shards in the middle of the floor.

    Welding the corners here instead does not help, and is worse. Two corners
    at different places cannot both be kept, so the survivor moves, and moving
    it in x throws the vertical wall through it off its axis. Measured: 3.36in
    of skew merging to the group mean, 3.77in merging to a member, against a
    plan whose whole point is that it is exactly square.

    So the merge belongs here, where a whole wall moves at once and every wall
    stays axis-aligned by construction. The longer of the two keeps its
    centreline, for the same reason the dominant face pair sets thickness.
    """
    out = []
    for box in sorted(boxes, key=lambda b: -(b["drawn_hi"] - b["drawn_lo"])):
        for kept in out:
            if kept["horizontal"] != box["horizontal"]:
                continue
            if abs(kept["centre"] - box["centre"]) >= WELD_IN:
                continue
            if min(kept["drawn_hi"], box["drawn_hi"]) <= max(kept["drawn_lo"],
                                                             box["drawn_lo"]):
                continue
            kept["drawn_lo"] = min(kept["drawn_lo"], box["drawn_lo"])
            kept["drawn_hi"] = max(kept["drawn_hi"], box["drawn_hi"])
            kept["thickness"] = max(kept["thickness"], box["thickness"])
            break
        else:
            out.append(dict(box))
    return out


def verify(corners, walls):
    """Assert what the box model is supposed to guarantee, rather than hope."""
    worst = 0.0
    for wall in walls:
        (x1, y1, _), (x2, y2, _) = corners[wall["corner1"]], corners[wall["corner2"]]
        worst = max(worst, min(abs(x1 - x2), abs(y1 - y2)))
    degree = defaultdict(int)
    for wall in walls:
        degree[wall["corner1"]] += 1
        degree[wall["corner2"]] += 1
    return {
        "off_axis_in": worst,
        "dangling": sum(1 for c in corners if degree[c] == 1),
        "junctions": sum(1 for c in corners if degree[c] >= 3),
    }


def design(corners, walls, ceiling_in, underlay, items):
    ox = min(x for x, _, _ in corners.values())
    oy = min(y for _, y, _ in corners.values())
    return {
        "floorplan": {
            "units": "cm",
            "corners": {
                cid: {"x": round((x - ox) * CM_PER_INCH, 4),
                      "y": round((y - oy) * CM_PER_INCH, 4),
                      "elevation": round((height or ceiling_in) * CM_PER_INCH, 2)}
                for cid, (x, y, height) in corners.items()
            },
            "walls": [{"corner1": wall["corner1"], "corner2": wall["corner2"],
                       # Measured face to face, in centimetres like the rest of
                       # the file. floorplan.js reads it if present and keeps
                       # its configured default if not.
                       "thickness": round(wall["thickness_in"] * CM_PER_INCH, 2),
                       "frontTexture": dict(WALL_TEXTURE),
                       "backTexture": dict(WALL_TEXTURE)}
                      for wall in walls],
            "rooms": {},
            "wallTextures": [], "floorTextures": {}, "newFloorTextures": {},
            "carbonSheet": {"url": "", "transparency": 1, "x": 0, "y": 0,
                            "anchorX": 0, "anchorY": 0,
                            "width": 0.01, "height": 0.01},
            "underlay": underlay,
        },
        "items": items,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pdf")
    parser.add_argument("-o", "--out", default="data/design.json")
    parser.add_argument("--page", type=int, default=2, help="1-indexed")
    parser.add_argument("--clip", nargs=4, type=float,
                        default=[1500, 380, 2440, 980],
                        metavar=("X0", "Y0", "X1", "Y1"),
                        help="plan region, PDF points")
    parser.add_argument("--ceiling", type=float, default=96.0, help="inches")
    parser.add_argument("--scale", type=float, default=QUARTER_SCALE)
    parser.add_argument("--layer", default=None,
                        help='structure layer, e.g. "#000000,0.5"; default is '
                             'the best-ranked -- see tools/layer_check.py')
    parser.add_argument("--open-doors", action="store_true",
                        help="draw a door the plan shows swinging as open")
    parser.add_argument("--underlay", default="underlay.png")
    parser.add_argument("--url-prefix", default="plan/")
    args = parser.parse_args()

    page = pymupdf.open(args.pdf)[args.page - 1]
    clip = pymupdf.Rect(*args.clip)
    chosen = layers.parse_key(args.layer) if args.layer else None

    horizontal, vertical, key = layers.structure(page, clip, args.scale, chosen)
    traced = wallmod.trace(horizontal, vertical)
    if not traced["boxes"]:
        raise SystemExit("traced nothing -- check --clip against the sheet")

    openings = opening_truth.hand(
        opening_truth.merge(
            opening_truth.find_by_symbol(traced, page, clip, args.scale, chosen),
            opening_truth.label(opening_truth.find(traced), page, clip, args.scale)),
        page, clip, args.scale)

    # A box shorter than the weld tolerance cannot become a wall: the app
    # merges its two corners on load and the wall between them vanishes. The
    # 3.4in stub at x=5.71ft is what put two corners 9.58cm apart on the wall
    # it crossed, and that pair is what collapsed.
    boxes = [b for b in bridge_openings(traced["boxes"], openings)
             if b["drawn_hi"] - b["drawn_lo"] >= WELD_IN]
    corners, walls = graph(fuse_parallel(boxes), args.ceiling)

    outdir = os.path.dirname(args.out) or "."
    os.makedirs(outdir, exist_ok=True)
    pix = page.get_pixmap(dpi=150, clip=clip)
    pix.save(os.path.join(outdir, args.underlay))

    ox = min(x for x, _, _ in corners.values())
    oy = min(y for _, y, _ in corners.values())
    per_inch = pix.width / (clip.width * args.scale)
    underlay = {
        "url": args.url_prefix + args.underlay,
        "transparency": 0.5,
        "widthCm": round(clip.width * args.scale * CM_PER_INCH, 3),
        "heightCm": round(clip.height * args.scale * CM_PER_INCH, 3),
        "anchorXPx": round((ox - clip.x0 * args.scale) * per_inch, 2),
        "anchorYPx": round((oy - clip.y0 * args.scale) * per_inch, 2),
    }

    # Thickness goes with each opening so the item can be scaled to span its
    # wall. An in-wall item is placed flush to the near face at its own depth,
    # so a door narrower than the wall is simply buried in it.
    placed = extract.items_for(
        [(o["kind"], (o["lo"] + o["hi"]) / 2.0 if o["horizontal"] else o["centre"],
          o["centre"] if o["horizontal"] else (o["lo"] + o["hi"]) / 2.0,
          o["width_in"], o["horizontal"], o["thickness"],
          o.get("hinge"), o.get("swing")) for o in openings],
        ox, oy, open_doors=args.open_doors)

    with open(args.out, "w", newline="\n") as handle:
        json.dump(design(corners, walls, args.ceiling, underlay, placed),
                  handle, indent=1)

    checks = verify(corners, walls)
    span_x = max(x for x, _, _ in corners.values()) - ox
    span_y = max(y for _, y, _ in corners.values()) - oy
    thicknesses = sorted({round(w["thickness_in"], 1) for w in walls})
    kinds = defaultdict(int)
    for opening in openings:
        kinds[opening["kind"]] += 1

    print(f"structure layer {key[0] or 'no stroke'} w={key[1]:g}"
          + (f" fill {key[2]}" if key[2] else ""))
    print(f"  -> {len(traced['boxes'])} wall boxes, {len(boxes)} after bridging "
          f"-> {len(corners)} corners, {len(walls)} walls")
    print(f"  -> extent {span_x / 12:.1f} x {span_y / 12:.1f} ft, "
          f"ceiling {args.ceiling}\"")
    print(f"  -> thicknesses " + ", ".join(f'{t:g}"' for t in thicknesses))
    print(f"  -> off-axis {checks['off_axis_in']:.6f}\" "
          f"({'square' if checks['off_axis_in'] == 0 else 'NOT SQUARE'}), "
          f"{checks['junctions']} junctions, {checks['dangling']} loose ends")
    print(f"  -> " + ", ".join(f"{n} {k}" for k, n in sorted(kinds.items())))
    print(f"  -> {args.out}  (+ {args.underlay}, {pix.width}x{pix.height}px)")


if __name__ == "__main__":
    main()
