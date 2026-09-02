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
import math
import os
import uuid
from collections import defaultdict

import pymupdf

import rooms

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


# The drawing says which lines are architecture. It was there all along.
#
# This sheet carries no CAD layers -- `get_ocgs()` returns nothing -- but the
# export kept the pen each entity was drawn with, and the drafter used them the
# way the AIA layer conventions intend. On page 2, inside the plan:
#
#   #000000 w1.0    75 segs, 38H/37V, no diagonals   the NEW walls
#   #000000 w0.5   761 segs                          existing walls, jambs, leaves
#   #804040       2675 segs, 547 diagonal            plumbing: tub, toilet, sink
#   #4b4b4b        444 segs                          cabinet fills and hatching
#   #6d86a9       1548 segs, 1094 diagonal           the E1-E5 elevation markers
#   #004080/#000080                                  dimension strings
#
# Five separate attempts were made to tell a wall from a countertop by
# geometry - pair thickness, ink coverage, traced length, endpoint anchoring,
# symbol evidence - and every one of them failed, because geometrically they
# are the same thing. The colour is not a heuristic: it is the drafter saying
# which is which, and reading it drops 22,000 segments to 836 and takes the
# bathtub, the toilet, the sink and every cabinet out of the wall problem
# before it starts.
ARCHITECTURE = (0.0, 0.0, 0.0)
# The symbol pen: every door and window on this sheet - jambs, swing arcs, the
# bypass panels on the closets - is drawn in a neutral grey. Nothing else is,
# which is why swings taken from it come out as seven door-sized clusters with
# no hatching to reject, where taking them from every pen returned the shaded
# cabinet runs as one enormous door.
SYMBOLS = "grey"


def _wanted(path, colour):
    if colour is None:
        return True
    stroke = path.get("color")
    if colour == SYMBOLS:
        return (stroke is not None
                and abs(stroke[0] - stroke[1]) < 1e-6
                and abs(stroke[1] - stroke[2]) < 1e-6
                and 0.15 < stroke[0] < 0.85)
    return stroke == colour


def segments(page, clip, k, colour=ARCHITECTURE):
    """Axis-aligned line segments inside `clip`, in real inches.

    `colour` filters to one pen; None takes everything, which is what the
    opening detectors want since a door leaf and a window sash are drawn in the
    same black as the wall they sit in.
    """
    horiz, vert = [], []
    for path in page.get_drawings():
        if not _wanted(path, colour):
            continue
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


def axes(horiz, vert):
    """The canonical wall lines: one shared x per vertical, y per horizontal.

    Exposed because rooms.py decomposes the plan into the grid these form.
    """
    return (cluster([c for c, _, _ in vert], AXIS_TOL_IN),
            cluster([c for c, _, _ in horiz], AXIS_TOL_IN))


def lattice(horiz, vert):
    """Put every centreline onto shared axes. This is what makes walls square."""
    xs, ys = axes(horiz, vert)

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


def build_graph(horiz, vert, height_of=None):
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

    def corner_at(x, y, height):
        # Keyed by height as well as position, so a half wall can meet a full
        # one. architect3d takes a wall's height from its two corners
        # (wall.js:394), so one corner cannot be both 42in and 96in - the pony
        # wall and the wall it runs into need separate corners at the same spot.
        key = (round(x, 4), round(y, 4), round(height, 4))
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
                height = height_of(coord, a, b, horizontal) if height_of else None
                ends = ((a, coord), (b, coord)) if horizontal else ((coord, a), (coord, b))
                pair = (corner_at(*ends[0], height), corner_at(*ends[1], height))
                if pair[0] != pair[1] and pair not in walls and pair[::-1] not in walls:
                    walls.append(pair)
    return corners, walls



# --- openings -------------------------------------------------------------
#
# Windows and doors are drawn quite differently, and neither is a gap in the
# wall: the wall's face lines run straight through both.
#
# A window is glazing drawn INSIDE the wall band - pairs of lines about an inch
# apart running along the wall, bracketed by jamb marks, with a small box at
# the mullion. So the signature is a line pair far too close together to be a
# wall, sitting on the wall's own centreline.
#
# A door is a swing: a quarter circle from the hinge, drawn as a short polyline
# rather than a bezier (the only real curves on this sheet are the toilet, the
# tub and the sink). Its bounding box is a square whose side is the door's
# width, and one edge of that square lies along the wall - which is the
# opening.
GLASS_MIN_IN, GLASS_MAX_IN = 0.4, 2.2
GLASS_MIN_LEN_IN = 6.0
GLASS_JOIN_IN = 3.0      # bridge the mullion box between two sashes
SWING_MIN_IN, SWING_MAX_IN = 18.0, 44.0
SWING_MAX_SEGMENTS = 14  # a swing is a few long chords; hatching is hundreds
ON_WALL_TOL_IN = 6.0

# Both models measure in centimetres, read from their GLB POSITION accessors.
WINDOW = {"model": "models/js-glb/whitewindow.glb", "type": 3,
          "name": "Window", "w": 123.0769, "h": 170.473,
          "height_cm": 152.4, "centre_cm": 157.0}   # 60" tall, 32" sill
DOOR = {"model": "models/js-glb/closed-door28x80_baked.glb", "type": 7,
        "name": "Closed Door", "w": 97.1, "h": 221.58,
        "height_cm": 203.2, "centre_cm": 101.6}     # 80" tall, on the floor


def diagonals(page, clip, k, colour=ARCHITECTURE):
    """Segments that are neither horizontal nor vertical: arcs, mostly."""
    out = []
    for path in page.get_drawings():
        if not _wanted(path, colour):
            continue
        for item in path["items"]:
            if item[0] != "l":
                continue
            a, b = item[1], item[2]
            if not (clip.contains(a) and clip.contains(b)):
                continue
            if abs(a.x - b.x) > 0.3 and abs(a.y - b.y) > 0.3:
                out.append((min(a.x, b.x) * k, min(a.y, b.y) * k,
                            max(a.x, b.x) * k, max(a.y, b.y) * k))
    return out


def swing_boxes(diags):
    """Cluster arc chords into door swings, and reject the hatching."""
    groups = []
    for box in diags:
        for g in groups:
            if not (box[0] > g[2] + 3 or box[2] < g[0] - 3
                    or box[1] > g[3] + 3 or box[3] < g[1] - 3):
                g[0], g[1] = min(g[0], box[0]), min(g[1], box[1])
                g[2], g[3] = max(g[2], box[2]), max(g[3], box[3])
                g[4] += 1
                break
        else:
            groups.append([box[0], box[1], box[2], box[3], 1])

    swings = []
    for x0, y0, x1, y1, n in groups:
        w, h = x1 - x0, y1 - y0
        # Square-ish, door-sized, and cheap to draw. The shaded cabinet runs in
        # the kitchen are hundreds of chords in a box this size and would
        # otherwise read as an enormous door.
        if (n <= SWING_MAX_SEGMENTS
                and SWING_MIN_IN <= w <= SWING_MAX_IN
                and SWING_MIN_IN <= h <= SWING_MAX_IN
                and 0.6 <= w / h <= 1.6):
            swings.append((x0, y0, x1, y1))
    return swings


def glass_pairs(runs):
    """Line pairs an inch or so apart -- glazing, not structure."""
    found = []
    runs = sorted(runs)
    for i, (c1, lo1, hi1) in enumerate(runs):
        for c2, lo2, hi2 in runs[i + 1:]:
            gap = c2 - c1
            if gap > GLASS_MAX_IN:
                break
            if gap < GLASS_MIN_IN:
                continue
            lo, hi = max(lo1, lo2), min(hi1, hi2)
            if hi - lo >= GLASS_MIN_LEN_IN:
                found.append([(c1 + c2) / 2.0, lo, hi])
    return merge_collinear(found, tol=GLASS_MAX_IN, join=GLASS_JOIN_IN)


def jambs_on(wall, perpendicular):
    """Where a wall is interrupted, in wall-length coordinates.

    A jamb is drawn as a short line across the wall's thickness at each side of
    an opening -- two of them an inch apart, in this drawing. Nothing else in a
    floor plan is a stub exactly one wall thick sitting astride a wall's
    centreline, which is what makes this the sharp edge of the detection: the
    glazing says WHAT the opening is, but the jambs say exactly where it starts
    and stops.
    """
    coord, lo, hi = wall
    marks = []
    for pc, pa, pb in perpendicular:
        length = pb - pa
        if not (WALL_MIN_IN <= length <= WALL_MAX_IN + 3):
            continue
        # Must straddle the centreline, not merely touch the wall.
        # Contains the centreline within a tolerance rather than strictly
        # straddling it: clustering the canonical axes moves a wall line by up
        # to the cluster tolerance, so a jamb drawn dead centre on the real wall
        # can sit wholly to one side of the line that represents it.
        if pa - 3.0 <= coord <= pb + 3.0 and lo - 2 <= pc <= hi + 2:
            marks.append(pc)
    # The pair an inch apart is one jamb.
    out = []
    for x in sorted(marks):
        if out and x - out[-1][-1] <= 2.5:
            out[-1].append(x)
        else:
            out.append([x])
    return [sum(g) / len(g) for g in out]


def bracket(marks, a, b, slack=8.0):
    """Widen a span out to the jambs on either side of it."""
    before = [m for m in marks if m <= a + slack]
    after = [m for m in marks if m >= b - slack]
    if not before or not after:
        return None
    lo, hi = max(before), min(after)
    return (lo, hi) if hi - lo >= 12.0 else None


def find_openings(walls, perpendicular, glass, swings, horizontal):
    """Windows and doors: found by their contents, sized by their jambs.

    `walls` are lattice centrelines (coord, lo, hi); `coord` is y for horizontal
    walls and x for vertical ones, so one body serves both.

    The evidence comes first and the jambs only size it. Working the other way
    round - taking each pair of adjacent jambs as an opening - looks natural and
    quietly halves every double window, because the mullion between two sashes
    is drawn as a jamb too. A 36in window came out as two 18in ones, neither
    wide enough to hold the glazing that proved it was a window at all, so both
    were discarded.

    So: glazing on the wall's centreline is a window and a swing box resting on
    the wall is a door, and each is then widened out to the nearest jamb on
    either side, which is what turns "there is glass around here" into a rough
    opening with a real width.
    """
    # Grouped by coordinate, not taken segment by segment. A door is a gap in
    # the wall, so the centreline through a doorway is traced as two pieces with
    # the door between them -- and testing the door against either piece put it
    # outside both. Every swing on this sheet sat within 3in of a wall LINE and
    # was rejected by its SEGMENT, which is how seven doors became none.
    lines = {}
    for coord, lo, hi in walls:
        span = lines.get(coord)
        lines[coord] = (min(span[0], lo), max(span[1], hi)) if span else (lo, hi)

    out = []
    for coord, (lo, hi) in sorted(lines.items()):
        marks = jambs_on((coord, lo, hi), perpendicular)

        for gc, ga, gb in glass:
            if abs(gc - coord) > 2.5 or ga < lo - 12 or gb > hi + 12:
                continue
            # No fallback to the glazing's own extent. Jambs on both sides are
            # the evidence that this is an opening in a wall and not two lines
            # an inch apart that happen to lie along one - a cabinet run, a
            # counter edge, a dimension string. Without this the drawing yields
            # twenty-one windows, most of them inside the house.
            span = bracket(marks, ga, gb)
            if span and 18.0 <= span[1] - span[0] <= 144.0:
                out.append(("window", (span[0] + span[1]) / 2.0, coord,
                            span[1] - span[0], horizontal))

        for x0, y0, x1, y1 in swings:
            near = (y0, y1) if horizontal else (x0, x1)
            along = (x0, x1) if horizontal else (y0, y1)
            if min(abs(near[0] - coord), abs(near[1] - coord)) > ON_WALL_TOL_IN:
                continue
            if along[0] < lo - 12 or along[1] > hi + 12:
                continue
            span = bracket(marks, along[0], along[1]) or along
            if 20.0 <= span[1] - span[0] <= 60.0:
                out.append(("door", (span[0] + span[1]) / 2.0, coord,
                            span[1] - span[0], horizontal))
    return out


def dedupe_openings(openings):
    """One opening per place, whichever orientation found it first."""
    kept = []
    for kind, along, coord, width, horizontal in openings:
        x, y = (along, coord) if horizontal else (coord, along)
        if any(abs(x - kx) < 12 and abs(y - ky) < 12 for _, kx, ky, _, _ in kept):
            continue
        kept.append((kind, x, y, width, horizontal))
    return kept


def items_for(openings, ox, oy):
    """architect3d items. Wall items snap to the nearest wall edge on load, so
    an approximate position along the right wall is enough to orient them."""
    items = []
    for index, (kind, x, y, width, horizontal) in enumerate(openings):
        spec = WINDOW if kind == "window" else DOOR
        items.append({
            "id": f"{kind}-{index}",
            "item_name": spec["name"],
            "item_type": spec["type"],
            "model_url": spec["model"],
            "format": "gltf",
            "xpos": round((x - ox) * CM_PER_INCH, 2),
            "ypos": spec["centre_cm"],
            "zpos": round((y - oy) * CM_PER_INCH, 2),
            "rotation": 0 if horizontal else math.pi / 2,
            # Width from the drawing; height from the standard the drawing does
            # not give in plan view. Both are editable in the inspector.
            "scale_x": round(width * CM_PER_INCH / spec["w"], 4),
            "scale_y": round(spec["height_cm"] / spec["h"], 4),
            "scale_z": 1,
            "fixed": False,
            "resizable": True,
            "material_colors": [],
        })
    return items


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
        (x1, y1, _), (x2, y2, _) = corners[a], corners[b]
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


def design(corners, walls, ceiling_in, underlay, items):
    ox = min(x for x, _, _ in corners.values())
    oy = min(y for _, y, _ in corners.values())
    return {
        "floorplan": {
            # Declared, so the loader reads these as centimetres rather than
            # falling back to "whatever display unit was active at save time".
            "units": "cm",
            "corners": {
                cid: {"x": round((x - ox) * CM_PER_INCH, 4),
                      "y": round((y - oy) * CM_PER_INCH, 4),
                      "elevation": round((height or ceiling_in) * CM_PER_INCH, 2)}
                for cid, (x, y, height) in corners.items()
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
        "items": items,
    }


def parse_half_wall(spec, xs, ys):
    """`h,12.0,25.0,38.0` -> a horizontal pony wall at y=12ft, x 25..38ft.

    Feet from the plan origin, because that is what somebody reading the
    drawing has. Snapped onto the nearest canonical line so the pony wall lands
    on a real wall rather than beside one.
    """
    axis, coord, start, end = spec.split(",")
    horizontal = axis.strip().lower().startswith("h")
    ox, oy = min(xs), min(ys)
    origin, along = (oy, ox) if horizontal else (ox, oy)
    lines = ys if horizontal else xs
    want = origin + float(coord) * 12.0
    return {
        "horizontal": horizontal,
        "coord": min(lines, key=lambda v: abs(v - want)),
        "lo": along + float(start) * 12.0,
        "hi": along + float(end) * 12.0,
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
    ap.add_argument("--half-wall", metavar="AXIS,COORD,FROM,TO",
                    help="a pony wall, in feet from the plan origin, e.g. "
                         "h,12.0,25.0,38.0 for a horizontal one at y=12ft")
    ap.add_argument("--half-wall-height", type=float, default=42.0,
                    help="inches; 42 is a normal pony wall")
    args = ap.parse_args()

    page = pymupdf.open(args.pdf)[args.page - 1]
    clip = pymupdf.Rect(*args.clip)

    # Walls read only the architectural pen; openings read every pen, because a
    # door's swing arc and a window's glazing are not drawn in the same colour
    # as the wall they interrupt. Filtering both to black found one window and
    # no doors at all.
    horiz, vert = segments(page, clip, args.scale)
    sym_h, sym_v = segments(page, clip, args.scale, colour=SYMBOLS)
    merged_h, merged_v = merge_collinear(horiz), merge_collinear(vert)
    hc, vc = lattice(centrelines(merged_h), centrelines(merged_v))
    # Walls come from the ROOM BOXES, not from the traced lines.
    #
    # Tracing lines leaves the short returns beside a doorway out: the stub's
    # own face pairs with a face that merged into the long wall run beside it,
    # so their overlap is only the stub's length and it falls under the minimum.
    # Lowering that minimum recovers a quarter of them and adds noise. Deriving
    # the walls from the room boundaries instead makes the question moot -- a
    # room box is closed, so the return beside its door is part of it by
    # construction. Measured on this plan: 26 loose ends becomes 0.
    xs, ys = axes(centrelines(merged_h), centrelines(merged_v))
    plan = rooms.detect(xs, ys, hc, vc)

    half = parse_half_wall(args.half_wall, xs, ys) if args.half_wall else None

    def height_of(coord, lo, hi, horizontal):
        if half and half["horizontal"] == horizontal                 and abs(coord - half["coord"]) <= 6.0                 and lo >= half["lo"] - 6.0 and hi <= half["hi"] + 6.0:
            return args.half_wall_height
        return args.ceiling

    swings = swing_boxes(diagonals(page, clip, args.scale, colour=SYMBOLS))
    # RAW segments, not the merged runs: merging welds a jamb stub into the
    # wall face line it touches, which is exactly the signature being looked
    # for. Same for glazing, whose pairs glass_pairs() merges itself.
    # Matched against the ROOM BOX walls, which is what the design will
    # contain. Matching against the traced centrelines instead put openings a
    # few inches off the wall that ends up in the file, because the box walls
    # sit on the canonical lattice and the traced ones do not quite.
    openings = dedupe_openings(
        find_openings(plan["walls_h"], sym_v, glass_pairs(sym_h), swings, True)
        + find_openings(plan["walls_v"], sym_h, glass_pairs(sym_v), swings, False))

    corners, walls = build_graph(plan["walls_h"], plan["walls_v"], height_of)
    islands = 0

    if not corners:
        raise SystemExit("traced nothing -- check --clip against the sheet")

    outdir = os.path.dirname(args.out) or "."
    os.makedirs(outdir, exist_ok=True)

    # Rendered from the same clip the walls were traced in, so its pixel extent
    # covers the same real inches. That is what lets the carbon sheet line up
    # without hand-nudging.
    pix = page.get_pixmap(dpi=150, clip=clip)
    pix.save(os.path.join(outdir, args.underlay))

    ox = min(x for x, _, _ in corners.values())
    oy = min(y for _, y, _ in corners.values())
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
        json.dump(design(corners, walls, args.ceiling, underlay,
                         items_for(openings, ox, oy)), fh, indent=1)

    checks = verify(corners, walls)
    span_x = max(x for x, _, _ in corners.values()) - ox
    span_y = max(y for _, y, _ in corners.values()) - oy
    print(f"traced {len(hc)} horizontal + {len(vc)} vertical centrelines")
    print(f"  -> {len(corners)} corners, {len(walls)} walls "
          f"({islands} detached fixture run{'' if islands == 1 else 's'} dropped)")
    print(f"  -> extent {span_x / 12:.1f} x {span_y / 12:.1f} ft, ceiling {args.ceiling}\"")
    print(f"  -> off-axis {checks['off_axis_in']:.6f}\" "
          f"({'square' if checks['off_axis_in'] == 0 else 'NOT SQUARE'}), "
          f"{checks['junctions']} junctions, {checks['dangling']} loose ends")
    windows = [o for o in openings if o[0] == "window"]
    doors = [o for o in openings if o[0] == "door"]
    print(f"  -> {len(windows)} windows, {len(doors)} doors")
    for kind, x, y, width, _ in sorted(openings, key=lambda o: (o[0], o[1])):
        feet, inches = divmod(round(width), 12)
        print(f"       {kind:6s} {feet}'-{inches}\"".ljust(24)
              + f"at ({(x - ox) / 12:5.1f}ft, {(y - oy) / 12:5.1f}ft)")
    print(f"  -> {args.out}  (+ {args.underlay}, {pix.width}x{pix.height}px)")


if __name__ == "__main__":
    main()
