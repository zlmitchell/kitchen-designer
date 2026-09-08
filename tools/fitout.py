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

## Two modes

**A schedule**, which is the one to use:

    python tools/fitout.py plans/design.blueprint3d --schedule data/fitout.json

A schedule is the kitchen written down -- every cabinet, appliance, worktop,
sink and light, at the plan coordinates it was measured at, off the drawing's
elevations. This does the arithmetic and none of the deciding: it turns a run
and an along-the-wall extent into a position and a rotation, and it knows the
trade's heights. Nothing about any particular house is in this file, which is
the point -- the schedule lives in `data/`, with the plan it belongs to, and
`data/README.md` says where its numbers came from.

**Or a wall to fill**, which is the stand-in it started as: given a wall, it
picks stock widths that add up, lays a counter over them and drops a sink in.
Kept because it needs no schedule and answers "does a run of cabinets look
right" on any traced plan at all.

Either way it is a stand-in for the extractor's unbuilt stage 6. `AGENTS.md`
lists CABINETS as "filled rects at nominal sizes + elevation text"; until that
is written, nothing reads a cabinet run off the drawing on its own.

## What it fixes on the way through

Zero-length walls are dropped. They are the remnant of a wall whose two corners
fused: below `cornerTolerance` a wall used to weld itself shut and vanish, and a
design saved while that was possible carries the stub. The editor cannot do it
any more, but the files already written still have them.

Legacy `whitewindow.glb` windows are dropped when a schedule supplies its own.
A design exported before windows were generated carries the model and three
scale factors; a schedule that lists windows is stating the real ones, and
keeping both would put two windows in every opening.
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
FLOAT_HEIGHT = 25.4          # 10in: a drawer box hung under a worktop
COUNTER_THICKNESS = 3.81     # 1.5in
COUNTER_OVERHANG = 2.54      # 1in past the cabinet face
SINK_WIDTH = 76.2
SINK_FRONT_TO_BACK = 47.0
SINK_DEPTH = 24.1

# What you can buy. A run is filled from the widest down, and whatever is left
# over becomes a filler rather than a cabinet of impossible width.
STOCK_WIDTHS_IN = [36, 33, 30, 27, 24, 21, 18, 15, 12, 9]

# Ceiling cans over the run.
#
# How far OUT from the wall face they sit is the number that matters, and it is
# not "over the middle of the counter". A can directly above the worktop is
# behind whoever is standing at it, so the person casts a shadow on their own
# work. The trade puts them over the FRONT edge of the counter or a little
# beyond, which lights the work surface past the body -- about 60cm out from a
# 61cm cabinet.
CAN_OFFSET = 60.0
# Roughly a can every 4ft along the run. Closer than the spacing rule of thumb
# (half the ceiling height) because a kitchen is a work surface, not a lounge.
CAN_SPACING = 110.0
# How far the fitting sits below the ceiling plane. A can whose position IS the
# ceiling is a light source inside the ceiling slab, and the slab is what it
# lights.
CAN_DROP = 6.0


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


def write(design, out, walls):
    """Save the dressed design, and say what came out."""
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "w", newline="\n") as handle:
        json.dump(design, handle, indent=1)
    print(f"  -> {out}  ({len(design['items'])} items, {len(walls)} walls)")
    return 0


def on_face(built, sched, run, along):
    """Name the wall face this item stands on, if the design offered one.

    Only for the item types that bind to a wall - 2 and 9. A counter, a sink and
    a ceiling light are placed outright and have no wall to be on.
    """
    if built["item_type"] in (2, 9) and sched.get("_faces"):
        named = face_for(sched["_faces"], run, along)
        if named:
            built["wallEdge"] = named
    return built


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


# ---------------------------------------------------------------------------
# The schedule
#
# A schedule says WHERE things are in plan coordinates and WHAT they are; this
# half says how tall they stand and which way they face. The split is the point:
# every number below is the trade's or a builder's, so a schedule never has to
# restate one, and a builder that changes its mind is changed here once.
# ---------------------------------------------------------------------------

#: Legacy window model. A design exported before windows were generated carries
#: it; a schedule that lists windows replaces every one.
LEGACY_WINDOW = "models/js-glb/whitewindow.glb"

#: How far a ceiling fitting with no drop of its own hangs below the plane. A
#: source AT the ceiling is inside the slab, and the slab is what it lights.
CEILING_CLEAR = 5.0

#: What an appliance's bounding box does that its stated height does not.
#: `buildAppliance` centres what it returns and `Item` places that middle, so a
#: part standing proud of the box moves the middle -- and a freestanding range's
#: backguard is 17.78cm of exactly that.
BACKGUARD = 17.78

#: How much deeper a built part is than the depth its spec asked for.
#:
#: A builder draws the CARCASS to `depth` and then hangs a face on the front of
#: it -- a door, a knob, an appliance's bar handle -- and `Item` recentres the
#: lot. So an item placed half its spec depth off the wall stands with its back
#: INSIDE the wall by half the overhang, and its doors past the worktop by the
#: other half: measured on the first fit-out, every cabinet front was 1cm proud
#: of the counter that was supposed to overhang it.
#:
#: Measured off the builders rather than derived, because they are the authority
#: and the parts differ -- a knob is 7.0 and a drawer pull 6.7. Re-measure by
#: building each spec and taking its bounding box; `tests/generated-door.test.js`
#: is the pattern.
STANDOFF = {"cabinet": 7.0, "appliance": 8.3, "hood": 0.0}


def run_frame(run):
    """Which way a run travels, and which way what stands on it faces.

    A run is `(axis, face, facing)`: the axis it travels along in plan, the
    coordinate of the WALL FACE its backs sit on, and which way is into the
    room. Everything else here is that, resolved.

    Rotating by theta sends local +z to `(sin, 0, cos)`, and
    `WallItem.changeWallEdge` points local +z along the half edge's normal --
    into the room. So the rotation a run needs is the one that puts +z on
    `facing`, which is what the table below is.
    """
    axis = run["axis"]
    facing = 1.0 if run.get("facing", 1) >= 0 else -1.0
    if axis == "h":
        rotation = 0.0 if facing > 0 else math.pi
    else:
        rotation = math.pi / 2 if facing > 0 else -math.pi / 2
    return axis, float(run["face"]), facing, rotation


def run_place(run, along, offset):
    """Plan (along the run, out from its face) to world (x, z), and a rotation.

    `offset` is measured from the wall face into the room, so a cabinet passes
    half its own depth and lands with its back on the wall.
    """
    axis, face, facing, rotation = run_frame(run)
    across = face + facing * offset
    if axis == "h":
        return along, across, rotation
    return across, along, rotation


def local_offset(run, plan_offset):
    """A distance along the run, in the item's OWN x.

    A counter's cutout is placed in the counter's frame and measured in the
    plan's, and the two run opposite ways on half the walls in a house. Getting
    this wrong is invisible on a symmetric run and looks, on any other, like a
    hole in the worktop with the sink somewhere else.
    """
    axis, _face, facing, _rotation = run_frame(run)
    flip = (axis == "h" and facing < 0) or (axis == "v" and facing > 0)
    return -plan_offset if flip else plan_offset


def wall_faces(design):
    """Every wall FACE in the design, named the way the app names it.

    `HalfEdge.id` is `${wall.id}:front|back`, and `core/wall_identity.js` derives
    `wall.id` from the corner pair the file already carries -- sorted, so the
    direction somebody drew it cannot matter, plus an ordinal for the second and
    later walls on one pair. Both rules are mirrored here, because the whole
    point of a derived id is that anything holding the same file can reproduce
    it.

    Which of the two faces is `front` is the one thing that is not written down
    anywhere: it is the side you reach by turning LEFT-to-RIGHT off the wall's
    own direction, so a wall drawn along +x has its front on +y. Verified
    against the app rather than reasoned about -- `tools/fitout.py --check-walls`
    prints what this believes, and the binding it produces is asserted in
    `app/tests/wall-binding.test.js`.

    @returns a list of dicts: the face's id, the axis it runs along, the
             coordinate of the face, the span it covers, and the way it looks.
    """
    plan = design["floorplan"]
    corners = plan["corners"]
    seen = {}
    faces = []
    for wall in plan["walls"]:
        a, b = corners[wall["corner1"]], corners[wall["corner2"]]
        dx, dy = b["x"] - a["x"], b["y"] - a["y"]
        length = math.hypot(dx, dy)
        if length < 1.0:
            continue
        key = "~".join(sorted([str(wall["corner1"]), str(wall["corner2"])]))
        ordinal = seen.get(key, 0)
        seen[key] = ordinal + 1
        wall_id = "wall:" + key + ("#%d" % ordinal if ordinal else "")
        half = wall.get("thickness", 10.0) / 2.0
        # Turning the direction left-to-right: (dx, dy) -> (-dy, dx).
        nx, ny = -dy / length, dx / length
        for name, sign in (("front", 1.0), ("back", -1.0)):
            faces.append({
                "id": "%s:%s" % (wall_id, name),
                "nx": nx * sign, "ny": ny * sign,
                "x0": a["x"] + nx * sign * half, "y0": a["y"] + ny * sign * half,
                "x1": b["x"] + nx * sign * half, "y1": b["y"] + ny * sign * half,
            })
    return faces


#: How far a run's stated face may be from a wall's, and still be that wall's.
#: The pony wall's face is 0.85cm off the wall beside it, because they are
#: different thicknesses meeting on one line.
FACE_TOLERANCE = 2.5


def face_for(faces, run, along):
    """The wall face a part on this run at `along` actually stands against.

    Named rather than left to `WallItem.closestWallEdge`, which decides by
    distance and gets a corner wrong: a half edge runs to the MITRE rather than
    to its wall's own end, so a wall reaches past the corner and can be nearer to
    a cabinet on the OTHER wall than that cabinet's own wall is. Measured on this
    plan: 31.5cm against 34.0cm, and the cabinet came out facing ninety degrees
    off with no way to drag it straight.
    """
    axis, face, facing, _rotation = run_frame(run)
    # The direction the fronts look. Same table as `run_frame`, in plan terms.
    want = (0.0, facing) if axis == "h" else (facing, 0.0)
    best = None
    for candidate in faces:
        if abs(candidate["nx"] - want[0]) > 0.01 or abs(candidate["ny"] - want[1]) > 0.01:
            continue
        # The face's own coordinate, and the stretch of wall it covers.
        if axis == "h":
            here, lo, hi = candidate["y0"], candidate["x0"], candidate["x1"]
        else:
            here, lo, hi = candidate["x0"], candidate["y0"], candidate["y1"]
        if abs(here - face) > FACE_TOLERANCE:
            continue
        lo, hi = min(lo, hi), max(lo, hi)
        # How far along this face the part sits: inside is 0, outside is how far
        # outside. A cabinet straddling a junction belongs to the wall its MIDDLE
        # is on, which is the wall it mostly stands against.
        outside = max(lo - along, along - hi, 0.0)
        if best is None or outside < best[0]:
            best = (outside, candidate["id"])
    return best[1] if best else None


def cabinet_part(sched, run, part):
    """A cabinet, base or wall, filling one extent of a run."""
    variant = part.get("variant", "base")
    width = part["to"] - part["from"]
    wall = variant == "wall"
    # Hung rather than standing: a wall cabinet and a floating drawer are both
    # held at a height by the wall behind them, which is what makes them item
    # type 2 and what makes `mountHeight` mean anything.
    hung = wall or variant == "floating"
    depth = part.get("depth", WALL_CAB_DEPTH if wall else BASE_DEPTH)
    height = part.get("height", WALL_CAB_HEIGHT if wall else
                      (FLOAT_HEIGHT if variant == "floating" else BASE_HEIGHT))
    mount = part.get("mountHeight", WALL_CAB_BOTTOM)
    finish = sched["materials"][part.get("finish", "wall" if wall else "base")]

    spec = {
        "kind": "cabinet", "variant": variant,
        "width": round(width, 2), "height": round(height, 2),
        "depth": round(depth, 2),
        "layout": part.get("layout", "doors"),
        "doors": part.get("doors", 2 if width > 55 else 1),
        "drawers": part.get("drawers", []),
        "front": sched.get("front", "shaker"),
        "frame": sched.get("frame", "face"),
        "glazing": part.get("glazing", "none"),
        "hardware": part.get("hardware", "knob"),
        "toeKick": part.get("toeKick", not (wall or variant == "floating")),
        # A corner unit is two legs at right angles, so it needs to be told which
        # way it turns and how far. Passed straight through: the builder is what
        # knows what an L is, and a schedule saying "corner" is stating a fact
        # about the kitchen rather than asking for geometry.
        **{k: part[k] for k in ("corner", "hand", "returnWidth", "returnDepth")
           if k in part},
        "underLight": part.get("underLight", False),
        "material": dict(finish),
    }
    if wall:
        spec["topTreatment"] = part.get("topTreatment", "standard")
        spec["ceilingHeight"] = round(sched["ceiling"], 2)
    if hung:
        spec["mountHeight"] = round(mount, 2)
    along = (part["from"] + part["to"]) / 2.0
    x, z, rotation = run_place(run, along, (depth + STANDOFF["cabinet"]) / 2.0)
    y = mount + height / 2.0 if hung else height / 2.0
    default_name = {"wall": "Wall Cabinet", "floating": "Floating Drawer"}.get(
        variant, "Base Cabinet")
    return on_face(item(part.get("name", default_name),
                        "generated:cabinet", 2 if hung else 9, x, y, z, rotation, spec),
                   sched, run, along)


def counter_part(sched, run, part):
    """One worktop across a run, with the sink cutouts that belong to it."""
    thickness = part.get("thickness", COUNTER_THICKNESS)
    depth = part.get("depth", BASE_DEPTH + COUNTER_OVERHANG)
    middle = (part["from"] + part["to"]) / 2.0
    cutouts = []
    for hole in part.get("cutouts", []):
        cutouts.append({
            "x": round(local_offset(run, hole["at"] - middle), 2),
            "z": round(hole.get("z", 0), 2),
            "width": round(hole["width"], 2),
            "depth": round(hole["depth"], 2),
        })
    x, z, rotation = run_place(run, middle, depth / 2.0)
    return item("Countertop", "generated:counter", 0, x,
                BASE_HEIGHT + thickness / 2.0, z, rotation, {
        "kind": "counter", "width": round(part["to"] - part["from"], 2),
        "depth": round(depth, 2), "thickness": thickness,
        "edge": sched.get("edge", "eased"),
        "backsplash": part.get("backsplash", 0),
        "cutouts": cutouts,
        "material": dict(sched["materials"]["counter"]),
    })


def shelf_part(sched, run, part):
    """An open shelf, which is a worktop that is not on a cabinet.

    No new builder: a shelf IS a slab of a width, a depth and a thickness, and
    `generated:counter` is that. `height` is the shelf's TOP, because that is
    the number an elevation gives -- a run of shelves is dimensioned by the
    gaps between them -- so the item's middle is half a board below it.
    """
    thickness = part.get("thickness", 3.2)
    depth = part.get("depth", WALL_CAB_DEPTH)
    x, z, rotation = run_place(run, (part["from"] + part["to"]) / 2.0, depth / 2.0)
    return item(part.get("name", "Shelf"), "generated:counter", 0, x,
                part["height"] - thickness / 2.0, z, rotation, {
        "kind": "counter", "width": round(part["to"] - part["from"], 2),
        "depth": round(depth, 2), "thickness": thickness, "edge": "eased",
        "backsplash": 0, "cutouts": [],
        "material": dict(sched["materials"].get("shelf",
                                                sched["materials"]["counter"])),
    })


def sink_part(sched, run, part):
    """A bowl in a worktop. Undermount, so its rim is at the slab's underside."""
    depth = part.get("depth", 24.1)
    counter_depth = part.get("counterDepth", BASE_DEPTH + COUNTER_OVERHANG)
    x, z, rotation = run_place(run, part["at"], counter_depth / 2.0)
    return item("Sink", "generated:sink", 0, x,
                BASE_HEIGHT - (depth + 0.3) / 2.0, z, rotation, {
        "kind": "sink", "mount": part.get("mount", "undermount"),
        "shape": part.get("shape", "rect"),
        "width": round(part["width"], 2),
        "frontToBack": round(part.get("frontToBack", 47.0), 2),
        "depth": round(depth, 2),
        "bowls": part.get("bowls", [1]), "drain": True,
        "material": {"basin": "metal-stainless", "apron": "metal-stainless"},
    })


def appliance_part(sched, run, part):
    """A range, fridge, dishwasher or hood, in the gap the run leaves for it."""
    subkind = part["subkind"]
    hood = subkind == "hood"
    width = part.get("width", (part["to"] - part["from"]) if "to" in part else 76.2)
    depth = part.get("depth", 50.8 if hood else 63.5)
    height = part.get("height", 15.24 if hood else 91.44)
    along = part["at"] if "at" in part else (part["from"] + part["to"]) / 2.0

    spec = {"kind": "appliance", "subkind": subkind,
            "width": round(width, 2), "height": round(height, 2),
            "depth": round(depth, 2),
            "finish": part.get("finish", "stainless")}
    for key in ("style", "fuel", "doors", "controls", "mount", "ductless"):
        if key in part:
            spec[key] = part[key]

    if hood:
        mount = part.get("mountHeight", 167.64)
        spec["ceilingHeight"] = round(sched["ceiling"], 2)
        spec["mountHeight"] = round(mount, 2)
        # The chimney reaches the ceiling, so the box is the canopy plus that --
        # and the filter hangs 1.6cm below the canopy.
        reach = max(height + 10.0, sched["ceiling"] - mount)
        y = mount + (reach - 1.6) / 2.0
        item_type = 2
    else:
        standing = (subkind == "range"
                    and part.get("style", "freestanding") == "freestanding")
        y = (height + (BACKGUARD if standing else 0.0)) / 2.0
        item_type = 9
    standoff = STANDOFF["hood"] if hood else STANDOFF["appliance"]
    x, z, rotation = run_place(run, along, (depth + standoff) / 2.0)
    return on_face(item(part.get("name", subkind.title()), "generated:appliance",
                        item_type, x, y, z, rotation, spec), sched, run, along)


def light_part(sched, run, part):
    """A fitting, on the ceiling or on a wall.

    The height is worked out from the mount rather than given, because a fitting
    hangs from a surface and the surface is what is known: a can is in the
    ceiling, a pendant hangs a stated drop below it. A sconce is the exception
    and states its own, because eye level is a decision.
    """
    ceiling = sched["ceiling"]
    mount = part.get("mount", "recessed")
    diameter = part.get("diameter", 10.16)
    radius = max(2.0, diameter / 2.0)
    spec = {"kind": "fixture", "mount": mount,
            "throw": part.get("throw", "down"),
            "kelvin": part.get("kelvin", 2700),
            "lumens": part.get("lumens", 800),
            "on": part.get("on", True),
            "diameter": round(diameter, 2),
            "castShadow": part.get("castShadow", mount != "wall")}
    if "beamAngle" in part:
        spec["beamAngle"] = part["beamAngle"]

    if mount == "wall":
        # Built from the wall out, so its middle is half its projection into the
        # room. Mirrors `sconceProjection` in items/generated/fixture.js.
        projection = max(6.0, diameter) + 2.0
        x, z, rotation = run_place(run, part["at"], projection / 2.0)
        return on_face(item(part.get("name", "Wall Light"), "generated:fixture", 2,
                            x, part["height"], z, rotation, spec),
                       sched, run, part["at"])

    if mount in ("pendant", "rod"):
        drop = part.get("drop", 45)
        spec["drop"] = drop
        height = ceiling - (drop + radius * 1.1) / 2.0
    elif mount == "surface":
        fitting = part.get("fittingDepth", 2.2)
        spec["depth"] = fitting
        height = ceiling - fitting
    else:
        height = ceiling - part.get("drop", CEILING_CLEAR)
    return item(part.get("name", "Ceiling Light"), "generated:fixture", 4,
                part["x"], height, part["y"], 0.0, spec)


def model_part(sched, part):
    """A catalogue model, for the one thing no builder makes.

    A ceiling fan is a shape rather than a parameter set -- blades, a motor and
    a downrod -- so it is the shipped model, placed by its own bounding box.
    `heightBelowCeiling` is that box: `Item` recentres geometry on load, so the
    file has to know how far down the middle of a fan is before it opens.
    """
    box = part["heightBelowCeiling"]
    built = item(part["name"], part["model"], part.get("itemType", 4),
                 part["x"], sched["ceiling"] - box / 2.0, part["y"],
                 part.get("rotation", 0.0), None)
    del built["spec"]
    built["format"] = part.get("format", "gltf")
    if part.get("fixtures"):
        built["fixtures"] = part["fixtures"]
    return built


def window_part(sched, part):
    """One window UNIT, as a spec.

    One unit, not one opening: a wide opening in this house is a fixed pane
    between two casements, and the drawing draws all three -- two mullions, and
    an operator on the two that open. Merging them into one wide sash puts a
    mullion nowhere and an operator everywhere.
    """
    height = part.get("height", sched["windows"]["height"])
    sill = part.get("sillHeight", sched["windows"]["sillHeight"])
    spec = {
        "kind": "window", "type": part.get("type", "double-hung"),
        "width": round(part["width"], 2),
        "height": round(height, 2), "sillHeight": round(sill, 2),
        "fullHeight": False,
        "wallThickness": round(part["wallThickness"], 2),
        "grille": part.get("grille", {"pattern": "none", "rows": 2, "cols": 2}),
        "openFraction": part.get("openFraction", 0),
    }
    for key in ("hand", "swing", "units", "mullion"):
        if key in part:
            spec[key] = part[key]
    built = item("Window", "generated:window", 3, part["x"],
                 sill + height / 2.0, part["y"], part["rotation"], spec)
    built["resizable"] = True
    built["material_colors"] = []
    return built


PART_BUILDERS = {
    "cabinet": cabinet_part,
    "counter": counter_part,
    "shelf": shelf_part,
    "sink": sink_part,
    "appliance": appliance_part,
    "light": light_part,
}


def fit_from_schedule(design, sched):
    """Everything the schedule asks for, as items, in the order it lists them."""
    runs = sched["runs"]
    # Resolved once and hung on the schedule, because every wall-bound part needs
    # it and the walls do not change while one is being written.
    sched["_faces"] = wall_faces(design)
    replacing = bool(sched.get("windows", {}).get("units"))
    kept = [i for i in design.get("items", [])
            if not (replacing and i.get("model_url") == LEGACY_WINDOW)]
    dropped = len(design.get("items", [])) - len(kept)
    if dropped:
        print(f"  dropped {dropped} legacy whitewindow.glb window(s) -- the "
              f"schedule states the real ones")

    made = []
    for part in sched.get("parts", []):
        kind = part["kind"]
        if kind == "model":
            made.append(model_part(sched, part))
            continue
        builder = PART_BUILDERS.get(kind)
        if builder is None:
            raise SystemExit(f"unknown part kind {kind!r}")
        run = runs.get(part.get("run"))
        if run is None and not (kind == "light" and "x" in part):
            raise SystemExit(f"a {kind} names run {part.get('run')!r}, which "
                             f"the schedule does not declare")
        made.append(builder(sched, run, part))
    for unit in sched.get("windows", {}).get("units", []):
        made.append(window_part(sched, unit))

    named = sum(1 for made_item in made if made_item.get("wallEdge"))
    print(f"  {named} of {len(made)} items name the wall face they stand on")

    counts = {}
    for made_item in made:
        counts[made_item["model_url"]] = counts.get(made_item["model_url"], 0) + 1
    for url in sorted(counts):
        print(f"  {counts[url]:3} x {url}")
    return kept + made


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
    ap.add_argument("--no-lights", action="store_true",
                    help="skip the ceiling cans over the run")
    ap.add_argument("--list", action="store_true", help="print the walls and stop")
    ap.add_argument("--schedule", default=None,
                    help="a fit-out schedule: the kitchen written down, in plan "
                         "coordinates. Everything else on this line is ignored "
                         "-- a schedule says what goes where, and there is "
                         "nothing left to pick")
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

    if args.schedule:
        with open(args.schedule) as handle:
            sched = json.load(handle)
        print(f"  schedule: {sched.get('name', args.schedule)}")
        design["items"] = fit_from_schedule(design, sched)
        return write(design, args.out, walls)

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

    # Ceiling cans over the run.
    #
    # Placed as ITEMS, not as entries in the document's top-level `lights` block.
    # A bare `lights` entry is a position and a temperature with no geometry, so
    # it lights the room and cannot be seen, clicked or edited - it works and is
    # invisible to the interface, which is worse than not working. A
    # `generated:fixture` item is a real object: selected, dragged, duplicated and
    # inspected by machinery that already exists, and it carries its own light
    # because for a light fitting the spec IS the fixture. See
    # `app/src/scripts/items/generated/fixture.js`.
    #
    # Type 4 is `RoofItem`, which snaps itself to the ceiling plane - so the
    # height below is what it wants rather than what it must be given.
    #
    # The plan's own axes again, so the row follows the wall rather than the world:
    # `place` is what maps (along, across) to (x, y, z), and it already knows
    # which way this wall runs.
    if not args.no_lights:
        run_start = along_lo
        run_length = sum(widths)
        count = max(2, int(round(run_length / CAN_SPACING)))
        can_across = face + inward * CAN_OFFSET
        for i in range(count):
            # Centres of `count` equal shares, so the end cans are half a space in
            # from the ends of the run rather than sitting on them.
            along = run_start + run_length * (i + 0.5) / count
            x, y, z = place(along, can_across, ceiling - CAN_DROP)
            items.append(item(f"Recessed Can", "generated:fixture", 4, x, y, z, 0.0, {
                "kind": "fixture", "mount": "recessed", "throw": "down",
                "kelvin": 3000, "lumens": 800, "beamAngle": 60, "on": True,
                "diameter": 10.16, "castShadow": True,
            }))
        print(f"  lights: {count} cans at {ceiling - CAN_DROP:.0f}cm, "
              f"{CAN_OFFSET:.0f}cm out from the wall face")

    # Undermount, so its rim is at the slab's underside and the cut edge shows.
    sink_height = SINK_DEPTH + 0.3
    if sink_index is None:
        design["items"] = items
        return write(design, args.out, walls)

    x, y, z = place(sink_along, counter_across, BASE_HEIGHT - sink_height / 2.0)
    items.append(item("Sink", "generated:sink", 0, x, y, z, rotation, {
        "kind": "sink", "mount": "undermount", "shape": "rect",
        "width": SINK_WIDTH, "frontToBack": SINK_FRONT_TO_BACK, "depth": SINK_DEPTH,
        "bowls": [1], "drain": True,
        "material": {"basin": "metal-stainless", "apron": "metal-stainless"},
    }))

    design["items"] = items
    return write(design, args.out, walls)


if __name__ == "__main__":
    sys.exit(main())
