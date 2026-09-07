"""Dress a traced plan with a kitchen, so the generated parts can be seen in it.

    python tools/fitout.py plans/design.blueprint3d -o data/design.json

## What this is, and what it is not

It is a stand-in for the extractor's unbuilt stage 6. `AGENTS.md` lists CABINETS
as "filled rects at nominal sizes + elevation text", and until that is written
nothing reads a cabinet run off the drawing. So this places one where a human
says, which is honest about being a placeholder and is enough to walk through.

It is NOT tracing. Nothing here looks at the PDF. Given a wall, it fills it with
cabinets, lays a counter over them and drops a sink into the counter -- the
arithmetic a run will do for itself in phase 3, done once, in Python, so the
result can be looked at now.

## Why it takes an exported design rather than the traced one

Because the interesting plan is the edited one. The half wall and its post are
decisions made in the editor -- the drawing does not record them -- so a fit-out
built from `build.py` output would be missing exactly the part worth seeing.
Point it at whatever you last exported.

## What it fixes on the way through

Zero-length walls are dropped. They are the remnant of a wall whose two corners
fused: below `cornerTolerance` a wall used to weld itself shut and vanish, and a
design saved while that was possible carries the stub. The editor cannot do it
any more, but the files already written still have them.
"""

import argparse
import json
import math
import os
import sys
import uuid

CM_PER_INCH = 2.54

# The trade's numbers, in centimetres. Same values as the builders' own defaults;
# repeated here because this script has to do the arithmetic the builders do
# rather than call them.
BASE_HEIGHT = 87.63          # 34.5in, so a 1.5in counter lands work at 36in
BASE_DEPTH = 61.0            # 24in
WALL_CAB_HEIGHT = 76.2       # 30in
WALL_CAB_DEPTH = 30.48       # 12in
WALL_CAB_BOTTOM = 137.16     # 54in: 18in of splash above the counter
COUNTER_THICKNESS = 3.81     # 1.5in
COUNTER_OVERHANG = 2.54      # 1in past the cabinet face
SINK_WIDTH = 76.2
SINK_FRONT_TO_BACK = 47.0
SINK_DEPTH = 24.1

# What you can buy. A run is filled from the widest down, and whatever is left
# over becomes a filler rather than a cabinet of impossible width.
STOCK_WIDTHS_IN = [36, 33, 30, 27, 24, 21, 18, 15, 12, 9]


def item(name, kind_url, item_type, x, y, z, rotation, spec):
    return {
        "id": str(uuid.uuid4()),
        "item_name": name,
        "item_type": item_type,
        "format": "generated",
        "model_url": kind_url,
        "xpos": round(x, 2),
        "ypos": round(y, 2),
        "zpos": round(z, 2),
        "rotation": round(rotation, 6),
        "scale_x": 1, "scale_y": 1, "scale_z": 1,
        "fixed": False,
        "spec": spec,
    }


def fill_widths(run_cm):
    """Stock cabinet widths that add up to `run_cm`, widest first.

    A kitchen is not one 13ft cabinet, and the seams between boxes are most of
    what makes a run look like cabinetry - so the run is divided the way it
    would actually be bought.
    """
    widths = []
    left = run_cm
    while left > 22.0:
        for inches in STOCK_WIDTHS_IN:
            cm = inches * CM_PER_INCH
            if cm <= left + 0.01:
                widths.append(cm)
                left -= cm
                break
        else:
            break
    return widths, left


def wall_axis(a, b):
    """Which way a wall runs, and the rotation an item against it needs.

    Plan y is world z, so a wall along plan x runs along world x and something
    standing against it faces world z. The two axis-aligned cases are the only
    ones here: the tracer emits square walls and a run of cabinets on a diagonal
    is not a thing this stand-in needs to do.
    """
    if abs(a["y"] - b["y"]) < 0.5:
        return "h", 0.0
    return "v", math.pi / 2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("design", help="an exported .blueprint3d, or a traced design.json")
    ap.add_argument("-o", "--out", default="data/design.json")
    ap.add_argument("--wall", type=int, default=None,
                    help="index of the wall to fit out; default picks the "
                         "longest wall that has room for a run")
    ap.add_argument("--no-uppers", action="store_true")
    ap.add_argument("--uppers", default="gap",
                    choices=["gap", "to-ceiling", "soffit", "stacked"],
                    help="what happens between the wall cabinets and the "
                         "ceiling. `gap` is what stock cabinets leave and "
                         "nobody wants; the other three are the ways of not "
                         "having it")
    ap.add_argument("--list", action="store_true", help="print the walls and stop")
    args = ap.parse_args()

    with open(args.design) as handle:
        design = json.load(handle)
    plan = design["floorplan"]
    corners = plan["corners"]
    walls = plan["walls"]

    def ends(wall):
        return corners[wall["corner1"]], corners[wall["corner2"]]

    def length(wall):
        a, b = ends(wall)
        return math.hypot(a["x"] - b["x"], a["y"] - b["y"])

    # Drop the remnants of walls that welded themselves shut. See the docstring.
    live = [w for w in walls if length(w) > 1.0]
    dropped = len(walls) - len(live)
    if dropped:
        print(f"  dropped {dropped} zero-length wall(s) -- the remnant of a wall "
              f"whose corners fused")
    plan["walls"] = live
    walls = live

    if args.list:
        for i, wall in enumerate(walls):
            a, b = ends(wall)
            height = max(a.get("elevation", 250), b.get("elevation", 250))
            print(f"  #{i:2} len {length(wall):7.1f}  "
                  f"({a['x']:7.1f},{a['y']:7.1f}) -> ({b['x']:7.1f},{b['y']:7.1f})  "
                  f"h {height:6.1f}  thick {wall.get('thickness', 10):5.1f}")
        return 0

    if args.wall is not None:
        index = args.wall
    else:
        # The longest FULL-HEIGHT wall. A pony wall cannot carry uppers and a
        # run against one would look like a mistake.
        candidates = []
        for i, wall in enumerate(walls):
            a, b = ends(wall)
            if max(a.get("elevation", 250), b.get("elevation", 250)) < 200:
                continue
            candidates.append((length(wall), i))
        candidates.sort(reverse=True)
        index = candidates[0][1]

    wall = walls[index]
    a, b = ends(wall)
    axis, rotation = wall_axis(a, b)
    thickness = wall.get("thickness", 10.0)
    run = length(wall)
    widths, leftover = fill_widths(run)
    if not widths:
        print(f"  wall #{index} is {run:.0f}cm - too short for a run")
        return 1

    print(f"  fitting wall #{index}: {run:.0f}cm, {axis}, thickness {thickness:.1f}")
    print(f"  {len(widths)} cabinets: "
          f"{', '.join(f'{w / CM_PER_INCH:.0f}in' for w in widths)}"
          f"{f' + {leftover:.0f}cm filler' if leftover > 2 else ''}")

    # Along the wall, and across it. The interior face is half a thickness in
    # from the centreline; a cabinet's back sits on it.
    if axis == "h":
        along_lo, along_hi = min(a["x"], b["x"]), max(a["x"], b["x"])
        across = a["y"]
    else:
        along_lo, along_hi = min(a["y"], b["y"]), max(a["y"], b["y"])
        across = a["x"]

    # Which side of the wall the room is on. Everything this plan needs is
    # inward from the boundary, so face whichever direction has more house.
    inward = 1.0
    xs = [c["x"] for c in corners.values()]
    ys = [c["y"] for c in corners.values()]
    middle = (sum(xs) / len(xs)) if axis == "v" else (sum(ys) / len(ys))
    if across > middle:
        inward = -1.0
        rotation += math.pi

    face = across + inward * thickness / 2.0
    back_to_centre = face + inward * BASE_DEPTH / 2.0

    # The ceiling, read off the plan rather than assumed. Corner elevations are
    # what the 3D view draws a wall top to, and a cabinet asked to reach the
    # ceiling has no other way of knowing where it is.
    #
    # The COMMONEST one, not the tallest. An edited plan carries corners the
    # editor made at its configured default (250) alongside the ones the tracer
    # measured (243.84 here, a 96in ceiling), and `max` picks the editor's -
    # which is a ceiling nobody has, and 6cm of cabinet hanging through it.
    # Pony-wall corners are excluded first, or a plan with enough of them would
    # vote for 42in.
    tally = {}
    for corner in corners.values():
        height = round(corner.get("elevation", 250), 2)
        if height < 200:
            continue
        tally[height] = tally.get(height, 0) + 1
    ceiling = max(tally.items(), key=lambda kv: (kv[1], -kv[0]))[0] if tally else 243.84

    def place(along, offset_across, height):
        """Plan (along, across) to world (x, y, z)."""
        if axis == "h":
            return along, height, offset_across
        return offset_across, height, along

    # Which cabinet the sink goes in.
    #
    # A sink is centred on ONE cabinet, because that is how a kitchen is built:
    # the bowl sits between two cabinet sides, and a sink straddling a joint has
    # a carcass side running up the middle of it. So the run is measured first,
    # a sink base is chosen, and the bowl and the cutout both take that
    # cabinet's centre rather than the run's.
    #
    # Wide enough means the bowl clears the carcass sides and the face frame -
    # a 30in sink does not go in a 30in cabinet.
    needed = SINK_WIDTH + 7.6
    centres = []
    cursor = along_lo
    for width in widths:
        centres.append((cursor + width / 2.0, width))
        cursor += width
    run_middle = along_lo + sum(widths) / 2.0
    roomy = [(abs(c - run_middle), i) for i, (c, w) in enumerate(centres) if w >= needed]
    if roomy:
        roomy.sort()
        sink_index = roomy[0][1]
    else:
        sink_index = None
        print(f"  no cabinet is {needed:.0f}cm or wider - the sink is left out")

    items = list(design.get("items", []))
    cursor = along_lo
    for index, width in enumerate(widths):
        centre = cursor + width / 2.0
        is_sink_base = index == sink_index
        x, y, z = place(centre, back_to_centre, BASE_HEIGHT / 2.0)
        items.append(item("Sink Base" if is_sink_base else "Base Cabinet",
                          "generated:cabinet", 9, x, y, z, rotation, {
            "kind": "cabinet", "variant": "base", "width": round(width, 2),
            "doors": 2 if width > 50 else 1,
            # A sink base has no drawer. The bowl is where it would go, which is
            # why a real one carries a false front or nothing at all.
            "drawers": [] if is_sink_base else [15.24],
            "front": "shaker", "frame": "face", "hardware": "knob",
            "material": {"front": "paint-white", "frame": "paint-white",
                         "carcass": "wood-birch-ply", "hardware": "metal-brushed-nickel"},
        }))
        cursor += width

    if not args.no_uppers:
        cursor = along_lo
        upper_centre = face + inward * WALL_CAB_DEPTH / 2.0
        treatment = "standard" if args.uppers == "gap" else args.uppers
        # How tall the whole upper assembly is. The builder works this out for
        # itself from the ceiling and the mount height, but the ITEM has to be
        # placed at the middle of it, and only the caller knows that.
        upper_height = (WALL_CAB_HEIGHT if treatment == "standard"
                        else max(WALL_CAB_HEIGHT, ceiling - WALL_CAB_BOTTOM))
        print(f"  uppers: {args.uppers}, {upper_height:.0f}cm tall "
              f"(ceiling {ceiling:.0f}cm)")
        for width in widths:
            centre = cursor + width / 2.0
            x, y, z = place(centre, upper_centre, WALL_CAB_BOTTOM + upper_height / 2.0)
            items.append(item("Wall Cabinet", "generated:cabinet", 2, x, y, z, rotation, {
                "kind": "cabinet", "variant": "wall", "width": round(width, 2),
                "doors": 2 if width > 50 else 1, "drawers": [],
                "front": "shaker", "frame": "face", "hardware": "knob",
                "topTreatment": treatment,
                "ceilingHeight": round(ceiling, 2),
                "mountHeight": WALL_CAB_BOTTOM,
                "material": {"front": "paint-white", "frame": "paint-white",
                             "carcass": "wood-birch-ply", "hardware": "metal-brushed-nickel"},
            }))
            cursor += width

    # One counter across the lot, which is the point of it being its own kind.
    counter_run = sum(widths)
    counter_depth = BASE_DEPTH + COUNTER_OVERHANG
    counter_centre_along = along_lo + counter_run / 2.0
    counter_across = face + inward * counter_depth / 2.0
    # The cutout goes where the SINK BASE is, not where the counter's middle is.
    sink_along = centres[sink_index][0] if sink_index is not None else counter_centre_along
    sink_offset = sink_along - counter_centre_along
    # The cutout's x is in the COUNTER's own frame, and `sink_offset` was measured
    # in the plan's. The item's rotation is what maps between them, so an offset
    # has to follow the same flip - otherwise the cutout lands the wrong side of
    # centre, which on a symmetric run looks like nothing at all and on this one
    # looks like a hole in the worktop with the sink somewhere else.
    #
    # Rotating by theta sends local +x to world (cos, 0, -sin). A horizontal wall
    # faced the other way is rotated by pi, so local +x runs backwards along the
    # plan's x. A vertical wall at +pi/2 sends local +x to world -z, and the plan's
    # y IS world z - so that one flips too, and the one at 3pi/2 does not.
    if (axis == "h" and inward < 0) or (axis == "v" and inward > 0):
        sink_offset = -sink_offset
    print(f"  sink base: cabinet {sink_index if sink_index is not None else '-'}"
          f"  offset {sink_offset:+.1f}cm from the counter's middle")
    x, y, z = place(counter_centre_along, counter_across,
                    BASE_HEIGHT + COUNTER_THICKNESS / 2.0)
    items.append(item("Countertop", "generated:counter", 0, x, y, z, rotation, {
        "kind": "counter", "width": round(counter_run, 2),
        "depth": round(counter_depth, 2), "thickness": COUNTER_THICKNESS,
        "edge": "eased", "backsplash": 0,
        "cutouts": [{"x": sink_offset, "z": 0,
                     "width": SINK_WIDTH - 4, "depth": SINK_FRONT_TO_BACK - 4}],
        "material": {"counter": "stone-quartz-white", "splash": "stone-quartz-white"},
    }))

    # Undermount, so its rim is at the slab's underside and the cut edge shows.
    sink_height = SINK_DEPTH + 0.3
    if sink_index is None:
        design["items"] = items
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", newline="\n") as handle:
            json.dump(design, handle, indent=1)
        print(f"  -> {args.out}  ({len(items)} items, {len(walls)} walls)")
        return 0

    x, y, z = place(sink_along, counter_across, BASE_HEIGHT - sink_height / 2.0)
    items.append(item("Sink", "generated:sink", 0, x, y, z, rotation, {
        "kind": "sink", "mount": "undermount", "shape": "rect",
        "width": SINK_WIDTH, "frontToBack": SINK_FRONT_TO_BACK, "depth": SINK_DEPTH,
        "bowls": [1], "drain": True,
        "material": {"basin": "metal-stainless", "apron": "metal-stainless"},
    }))

    design["items"] = items
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", newline="\n") as handle:
        json.dump(design, handle, indent=1)
    added = len(items) - len(design.get("items", [])) + len(items) - len(items)
    print(f"  -> {args.out}  ({len(items)} items, {len(walls)} walls)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
