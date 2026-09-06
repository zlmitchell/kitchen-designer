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

MIN_OPENING_IN, MAX_OPENING_IN = 18.0, 144.0

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


def build_graph(horiz, vert, height_of=None, cuts=None):
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
        for (coord, lo, hi), crossings in zip(runs, cutsets):
            # Crossings split a run because another wall meets it there. `cuts`
            # splits it because we need the piece: a post is a short length of
            # the same wall left at full height, and without a cut it is simply
            # part of the longer segment and takes that segment's height.
            asked = (cuts or {}).get((horizontal, round(coord, 4)), ())
            stops = sorted({lo, hi} | {c for c in crossings if lo < c < hi}
                           | {c for c in asked if lo < c < hi})
            for a, b in zip(stops, stops[1:]):
                # A run shorter than the minimum is noise, unless it is short
                # because we asked for it to be: a 4x4 post is 4in of wall, and
                # the minimum is 6.
                if b - a < MIN_WALL_IN and a not in asked and b not in asked:
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
#
# `d` is the model's own depth, and it matters because an in-wall item is not
# fitted to its wall. half_edge.js sets `offset = wall.thickness / 2`, and
# InWallItem.getWallOffset() places the item at `-offset + 0.5` -- flush to the
# near face, at whatever depth the model happens to be. While every wall was
# the configured 10cm that was invisible. Measured walls are 7.7 to 19cm, so a
# 8cm door in a 19cm wall is buried in it and a 14.75cm window in a 7.7cm wall
# stands proud of both faces.
WINDOW = {"model": "models/js-glb/whitewindow.glb", "type": 3,
          "name": "Window", "w": 123.0769, "h": 170.473, "d": 14.75,
          "height_cm": 152.4, "centre_cm": 157.0}   # 60" tall, 32" sill
DOOR = {"model": "models/js-glb/closed-door28x80_baked.glb", "type": 7,
        "name": "Closed Door", "w": 97.1, "h": 221.58, "d": 8.036,
        "height_cm": 203.2, "centre_cm": 101.6}     # 80" tall, on the floor
# open_door.glb is NOT an open door, and this is where believing it was cost the
# most. Decoded, it holds the same frame, the same in-plane leaf panel
# (85.1 x 215.1 x 1.5) and the same four hinges as the closed door, with the
# three doorknob parts deleted -- and its whole bounding box is
# 97.1 x 221.58 x 7.624cm. A 32in leaf swung 90 degrees projects about 81cm.
# Nothing in that file leaves the wall, so no placement could show a door open.
#
# The depth scaling below would have flattened a correct asset anyway: scaling z
# by thickness/89 squashes an 81cm swing into the wall plane. So a door is now
# GENERATED -- see app/src/scripts/items/generated/door.js -- which also lets a
# handing be stated instead of half-encoded in a rotation.
DOOR_JAMB_CM = 1.9      # 3/4in jamb stock; the builder's default
DOOR_OPEN_FRACTION = 0.75   # how far an interior door is drawn open
GENERATED_DOOR = {"model": "generated:door", "type": 7, "format": "generated",
                  "name": "Door", "height_cm": 203.2}


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


MIN_JAMB_SPAN = 0.6   # of the wall's own thickness


def jambs_on(wall, perpendicular, thickness=None):
    """Where a wall is interrupted, in wall-length coordinates.

    A jamb is drawn as a short line across the wall's thickness at each side of
    an opening -- two of them an inch apart, in this drawing. Nothing else in a
    floor plan is a stub exactly one wall thick sitting astride a wall's
    centreline, which is what makes this the sharp edge of the detection: the
    glazing says WHAT the opening is, but the jambs say exactly where it starts
    and stops.
    """
    coord, lo, hi = wall[:3]
    # A jamb reaches from one face of the wall to the other. Anything shorter
    # that still straddles the centreline is a symbol drawn INSIDE the wall,
    # and the casement operator is exactly that: a 3.0in mark on a 6.1in wall,
    # centred, two of them per opening sash.
    #
    #   wall faces     y 23.90 -> 24.41   6.1in
    #   jamb           y 23.89 -> 24.42   6.4in   face to face
    #   operator mark  y 24.06 -> 24.31   3.0in   inside
    #
    # Read as jambs they chop each opening sash into 1.7in slivers, every one
    # of them under the 12in minimum, and a three-section picture window comes
    # back as its middle pane alone -- the only one with no opening sash and so
    # no operator to confuse it.
    floor = thickness * MIN_JAMB_SPAN if thickness else WALL_MIN_IN
    marks = []
    for pc, pa, pb in perpendicular:
        length = pb - pa
        if not (floor <= length <= WALL_MAX_IN + 3):
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


CONNECTED = 0.92     # a window's glazing runs jamb to jamb
GLAZING_TOL_IN = 4.0


def spans_linework(runs, coord, a, b, tol=GLAZING_TOL_IN):
    """How the drawing fills the opening: (covered fraction, piece count).

    This is the whole window/door test, and it comes from how the symbols are
    drawn rather than from their shape. A window's glazing CONNECTS the two
    jambs -- one continuous run, corner to corner. A door does not: a swing is
    an arc off to one side, and a bypass slider is two leaves that overlap each
    other and stop short, because they are drawn where they actually sit.

    Measured on this sheet: the 36in window is 100% covered in one piece; the
    49in closet slider is 77% covered in two, with an 11in gap. Nothing else is
    needed to tell them apart.
    """
    width = b - a
    if width <= 0:
        return 0.0, 0
    pieces = []
    for c, lo, hi in runs:
        if abs(c - coord) > tol:
            continue
        lo, hi = max(lo, a), min(hi, b)
        if hi > lo:
            pieces.append([lo, hi])
    pieces.sort()
    merged = []
    for lo, hi in pieces:
        if merged and lo <= merged[-1][1] + 0.6:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    return sum(hi - lo for lo, hi in merged) / width, len(merged)


def find_openings(walls, perpendicular, symbol, architecture, swings, horizontal):
    """Where the wall stops, and what the drawing put there instead.

    Two pens answer two different questions, and between consecutive jambs they
    are near-perfect complements. Measured on the north wall of this plan:

        span 107in   architecture 100%   symbol   1%    solid wall
        span  18in   architecture   0%   symbol 100%    opening
        span  92in   architecture 100%   symbol  24%    solid wall
        span  32in   architecture   0%   symbol 100%    opening

    So the wall's own pen says WHERE it stops -- an opening is a span the
    architecture line does not cross - and the symbol pen says WHAT is in it.
    A window's glazing connects the two jambs, one run corner to corner; a door
    does not, because a swing is an arc off to one side and a bypass slider is
    two leaves that overlap each other and stop short of the far jamb. The
    closet slider measures 77% in two pieces with an 11in gap; the window next
    to it measures 100% in one.

    Adjacent windows are merged afterwards: a mullion between two sashes is
    drawn as a jamb too, so a 36in double window arrives as two 18in spans.
    """
    lines = {}
    for wall in walls:
        coord, lo, hi = wall[:3]
        thickness = wall[3] if len(wall) > 3 else None
        span = lines.get(coord)
        if span:
            lines[coord] = (min(span[0], lo), max(span[1], hi),
                            thickness or span[2])
        else:
            lines[coord] = (lo, hi, thickness)

    out = []
    for coord, (lo, hi, thickness) in sorted(lines.items()):
        marks = jambs_on((coord, lo, hi), perpendicular, thickness)
        found = []
        for a, b in zip(marks, marks[1:]):
            width = b - a
            if not 12.0 <= width <= MAX_OPENING_IN:
                continue
            solid, _ = spans_linework(architecture, coord, a, b)
            if solid >= 0.5:
                continue                       # the wall runs straight through
            covered, pieces = spans_linework(symbol, coord, a, b)
            swung = any(
                min(abs((y0 if horizontal else x0) - coord),
                    abs((y1 if horizontal else x1) - coord)) <= ON_WALL_TOL_IN
                and (x0 if horizontal else y0) >= a - 8
                and (x1 if horizontal else y1) <= b + 8
                for x0, y0, x1, y1 in swings)
            # The swing is checked BEFORE giving up on an empty span, not after.
            # A swing arc is drawn out into the room, not along the wall, so a
            # plain hinged door leaves the wall line itself blank - the two
            # bedroom doorways on this plan measure 1.6% architecture and 2.7%
            # symbol, and were being discarded as gaps with nothing in them.
            if not swung and covered < 0.25:
                continue
            connected = covered >= CONNECTED and pieces == 1
            found.append(["window" if connected and not swung else "door", a, b])

        merged = []
        for kind, a, b in found:
            if merged and merged[-1][0] == kind == "window"                     and abs(merged[-1][2] - a) < 1e-6:
                merged[-1][2] = b
            else:
                merged.append([kind, a, b])

        for kind, a, b in merged:
            if MIN_OPENING_IN <= b - a <= MAX_OPENING_IN:
                out.append((kind, (a + b) / 2.0, coord, b - a, horizontal))
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


def door_item(index, kind, x, y, width, horizontal, thickness_cm,
              hinge, swing, exterior, open_doors, ox, oy):
    """A generated door: a spec, not a model and not a scale factor.

    Nothing here is scaled. The builder is handed the opening it measured and
    the wall's own thickness and makes a frame that fits, which is what the
    three scale factors were approximating -- badly, since scaling a model
    stretches its casing and its stiles along with its overall size.

    A door the drawing showed swinging is drawn OPEN, because that is what the
    drawing says about it and a closed door hides the fact that the opening
    leads anywhere. A door with no arc -- a bypass slider, a cased opening --
    has no handing and stays shut. So does an exterior door however clearly the
    plan drew its swing: a front door standing open in a walkthrough is simply
    wrong.

    `hand` is the drawing's `lo`/`hi` along the wall, passed straight through.
    That is the plan axis, and the item's own +x is fixed later by
    WallItem.changeWallEdge from the wall normal -- so on a wall whose edge runs
    the other way a door comes out hinged at the far jamb. It is one flag in the
    spec to correct, which is why the field exists at all rather than being
    folded into the rotation the way the swing side used to be.
    """
    height_cm = GENERATED_DOOR["height_cm"]
    # The rough opening: the frame stands outside the clear opening by a jamb on
    # each side and one over the head. Item's constructor recentres geometry, so
    # the item's origin sits at half the ROUGH height, not half the door's.
    rough_height = height_cm + DOOR_JAMB_CM
    spec = {
        "kind": "door",
        "width": round(width * CM_PER_INCH, 2),
        "height": height_cm,
        "wallThickness": round(thickness_cm, 2) if thickness_cm else 11.43,
        # PLAN axes, both of them, because that is what the drawing knows. The
        # item resolves them into its own on binding -- a wall has two half
        # edges and the one an item lands on sets its rotation, so "swings
        # toward -z" points into opposite rooms on two identical doors. Measured
        # before this was split out: door-7 and door-9 carry the same spec and
        # their leaves ended up at world dz +35.9 and -28.9.
        "hand": hinge if hinge in ("lo", "hi") else "lo",
        "swing": swing if swing in ("positive", "negative") else "negative",
        # No swing arc means no leaf. A bypass slider or a cased opening drawn
        # as one slab filling the hole is worse than drawing nothing: the three
        # 48.7in closet openings on this plan came out as solid 48.7in doors,
        # and an opening that should read as open read as a wall.
        "operation": "swing" if hinge else "cased",
        "openFraction": (DOOR_OPEN_FRACTION
                         if (open_doors and hinge and not exterior) else 0),
    }
    return {
        "id": f"{kind}-{index}",
        "item_name": GENERATED_DOOR["name"],
        "item_type": GENERATED_DOOR["type"],
        "model_url": GENERATED_DOOR["model"],
        "format": GENERATED_DOOR["format"],
        "xpos": round((x - ox) * CM_PER_INCH, 2),
        "ypos": round(rough_height / 2.0, 2),
        "zpos": round((y - oy) * CM_PER_INCH, 2),
        # Wall orientation only. The swing side is spec["swing"] now, so this no
        # longer has to carry half a handing -- and it never could: changeWallEdge
        # overwrites rotation.y from the wall normal as soon as the item binds.
        "rotation": (0 if horizontal else math.pi / 2),
        "scale_x": 1,
        "scale_y": 1,
        "scale_z": 1,
        "fixed": False,
        "resizable": True,
        "material_colors": [],
        "spec": spec,
    }


def items_for(openings, ox, oy, open_doors=False):
    """architect3d items. Wall items snap to the nearest wall edge on load, so
    an approximate position along the right wall is enough to orient them."""
    items = []
    for index, opening in enumerate(openings):
        kind, x, y, width, horizontal = opening[:5]
        # Wall thickness, when the caller knows it. Without it the item keeps
        # its native depth, which is what the lattice pipeline always did
        # because every wall it wrote was the same 10cm.
        thickness_cm = opening[5] * CM_PER_INCH if len(opening) > 5 else None
        hinge = opening[6] if len(opening) > 6 else None
        swing = opening[7] if len(opening) > 7 else None
        exterior = opening[8] if len(opening) > 8 else False
        if kind != "window":
            items.append(door_item(index, kind, x, y, width, horizontal,
                                   thickness_cm, hinge, swing, exterior,
                                   open_doors, ox, oy))
            continue
        spec = WINDOW
        items.append({
            "id": f"{kind}-{index}",
            "item_name": spec["name"],
            "item_type": spec["type"],
            "model_url": spec["model"],
            "format": "gltf",
            "xpos": round((x - ox) * CM_PER_INCH, 2),
            "ypos": spec["centre_cm"],
            "zpos": round((y - oy) * CM_PER_INCH, 2),
            "rotation": (0 if horizontal else math.pi / 2),
            # Width from the drawing; height from the standard the drawing does
            # not give in plan view. Both are editable in the inspector.
            "scale_x": round(width * CM_PER_INCH / spec["w"], 4),
            "scale_y": round(spec["height_cm"] / spec["h"], 4),
            # Scaled to span the wall, so the opening reads as a hole through
            # it rather than a panel stuck on one face.
            "scale_z": (round(thickness_cm / spec["d"], 4)
                        if thickness_cm else 1),
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
    ap.add_argument("--post", choices=("start", "end", "none"), default="none",
                    help="a full-height post at one end of the pony wall")
    ap.add_argument("--post-size", type=float, default=4.0,
                    help="inches; a 4in run of wall is a 4x4, since a wall is "
                         "10cm thick by default")
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

    # The post is just a short run of wall left at full height.
    #
    # architect3d has no column primitive - it knows walls, rooms and items -
    # but a wall is 10cm thick by default, so a 4in length of one is a 4x4 and
    # needs no model, no catalogue entry and no new concept. The pony wall is
    # shortened to make room for it rather than overlapping it, so the two do
    # not fight over the same span.
    cuts = {}
    if half and args.post != "none":
        if args.post == "start":
            edge = half["lo"] + args.post_size
            half["lo"] = edge
        else:
            edge = half["hi"] - args.post_size
            half["hi"] = edge
        cuts[(half["horizontal"], round(half["coord"], 4))] = {edge}

    def height_of(coord, lo, hi, horizontal):
        # By midpoint, not containment. build_graph splits a run at every wall
        # it crosses, so the pony wall arrives as several segments whose ends
        # are lattice coordinates rather than the ends asked for - and once the
        # post shortened the span, containment stopped matching any of them and
        # the pony wall silently came back full height.
        middle = (lo + hi) / 2.0
        if (half and half['horizontal'] == horizontal
                and abs(coord - half['coord']) <= 0.5
                and half['lo'] - 1.0 <= middle <= half['hi'] + 1.0):
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
        find_openings(plan["walls_h"], sym_v, sym_h, horiz, swings, True)
        + find_openings(plan["walls_v"], sym_h, sym_v, vert, swings, False))

    corners, walls = build_graph(plan["walls_h"], plan["walls_v"], height_of, cuts)
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
