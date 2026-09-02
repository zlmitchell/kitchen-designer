"""Windows and doors, and what their existence proves about the walls.

A door is evidence a wall is there. That is the useful direction, and it is why
this module exists separately from the wall tracing rather than after it: no
amount of looking at a pair of parallel lines distinguishes a stud wall from a
countertop, because the drawing draws them the same, but nobody puts a door in
a countertop. Every opening found here anchors the line it sits on as real.

It also fixes a counting problem. Rooms merge when the wall between them is
missing, and the wall between two rooms is almost always the one with the door
in it -- that is how you get from one to the other. So finding the doors and
finding the rooms are the same job approached from opposite ends.

Three symbols, and none of them is a gap in the wall:

  swing    A leaf drawn at an angle plus its arc. The arc is a POLYLINE, not a
           bezier -- the only true curves on this sheet are the toilet, the tub
           and the sink -- so it is found by clustering short diagonal chords.

  slider   Two thin panels, each about 25in by 1.3in, OFFSET across the wall by
           an inch or two and OVERLAPPING along it. Closets get these, which is
           why closets never separated while only swings were detected.

  glazing  Line pairs about an inch apart lying ON the wall's centreline, side
           by side and NOT overlapping, one per sash.

The slider and the glazing are the pair worth being careful about: both are
thin parallel lines inside a wall, and reading a closet's bypass doors as a
window is an easy mistake. What separates them is that slider panels are offset
across the wall and overlap along it, while sashes share the centreline and sit
end to end.

Everything is then widened out to the jambs either side. Jambs are required,
not optional: they are what says the wall is actually interrupted, and without
them every cabinet door in the kitchen reads as a closet.
"""

PANEL_GAP_IN = (0.8, 2.6)      # thickness of a drawn door panel or sash
PANEL_MIN_IN = 16.0
SLIDER_OFFSET_IN = (1.2, 4.5)  # how far the two leaves sit apart across the wall
SLIDER_OVERLAP_IN = 6.0
GLAZING_GAP_IN = (0.4, 2.2)
GLAZING_MIN_IN = 6.0
GLAZING_JOIN_IN = 3.0
ON_WALL_IN = 2.5  # tight: 4.0 let cabinet lines read as glazing (15 windows, some 10ft)
JAMB_SPAN_IN = (3.0, 12.0)     # a jamb crosses the wall, so it is wall-thick
JAMB_PAIR_IN = 2.5
JAMB_STRADDLE_IN = 3.0
BRACKET_SLACK_IN = 8.0
MIN_OPENING_IN, MAX_OPENING_IN = 18.0, 144.0
SWING_SIDE_IN = (18.0, 44.0)
SWING_MAX_CHORDS = 14


def thin_pairs(runs, gap=PANEL_GAP_IN, min_length=PANEL_MIN_IN):
    """Thin rectangles drawn along a wall: door leaves and window sashes."""
    out = []
    runs = sorted(runs)
    for i, (c1, a1, b1) in enumerate(runs):
        for c2, a2, b2 in runs[i + 1:]:
            separation = c2 - c1
            if separation > gap[1]:
                break
            if separation < gap[0]:
                continue
            lo, hi = max(a1, a2), min(b1, b2)
            if hi - lo >= min_length:
                out.append(((c1 + c2) / 2.0, lo, hi))
    return out


def sliders(panels):
    """Leaf pairs that bypass: offset across the wall, overlapping along it."""
    found, seen = [], set()
    for i, (c1, a1, b1) in enumerate(panels):
        for c2, a2, b2 in panels[i + 1:]:
            offset = abs(c2 - c1)
            if not SLIDER_OFFSET_IN[0] <= offset <= SLIDER_OFFSET_IN[1]:
                continue
            if min(b1, b2) - max(a1, a2) < SLIDER_OVERLAP_IN:
                continue
            span = (min(a1, a2), max(b1, b2))
            key = (round(span[0]), round(span[1]), round((c1 + c2) / 2))
            if key not in seen:
                seen.add(key)
                found.append(((c1 + c2) / 2.0, span[0], span[1]))
    return found


def glazing(runs):
    """Sashes: thin pairs on the centreline, merged across their mullions."""
    from extract import merge_collinear
    pairs = thin_pairs(runs, GLAZING_GAP_IN, GLAZING_MIN_IN)
    return [tuple(run) for run in
            merge_collinear([list(p) for p in pairs],
                            tol=GLAZING_GAP_IN[1], join=GLAZING_JOIN_IN)]


def swings(diagonals):
    """Door swing arcs, clustered out of the short chords that draw them."""
    groups = []
    for box in diagonals:
        for group in groups:
            if not (box[0] > group[2] + 3 or box[2] < group[0] - 3
                    or box[1] > group[3] + 3 or box[3] < group[1] - 3):
                group[0], group[1] = min(group[0], box[0]), min(group[1], box[1])
                group[2], group[3] = max(group[2], box[2]), max(group[3], box[3])
                group[4] += 1
                break
        else:
            groups.append([box[0], box[1], box[2], box[3], 1])

    out = []
    for x0, y0, x1, y1, chords in groups:
        width, height = x1 - x0, y1 - y0
        # Square-ish, door-sized, and cheap to draw. The hatched cabinet fills
        # are hundreds of chords in a box this size and would read as one very
        # large door.
        if (chords <= SWING_MAX_CHORDS
                and SWING_SIDE_IN[0] <= width <= SWING_SIDE_IN[1]
                and SWING_SIDE_IN[0] <= height <= SWING_SIDE_IN[1]
                and 0.6 <= width / height <= 1.6):
            out.append((x0, y0, x1, y1))
    return out


def jambs_on(wall, perpendicular):
    """Where a wall is interrupted, in wall-length coordinates."""
    coord, lo, hi = wall
    marks = []
    for pc, pa, pb in perpendicular:
        if not JAMB_SPAN_IN[0] <= pb - pa <= JAMB_SPAN_IN[1]:
            continue
        # Contains the centreline within a tolerance rather than strictly
        # straddling it. Clustering the canonical axes moves a wall line by up
        # to the cluster tolerance, so a jamb drawn dead centre on the real wall
        # can sit wholly to one side of the line that represents it -- which
        # rejected every closet slider in the plan and found zero of them.
        if pa - JAMB_STRADDLE_IN <= coord <= pb + JAMB_STRADDLE_IN and lo - 2 <= pc <= hi + 2:
            marks.append(pc)
    grouped = []
    for mark in sorted(marks):
        if grouped and mark - grouped[-1][-1] <= JAMB_PAIR_IN:
            grouped[-1].append(mark)
        else:
            grouped.append([mark])
    return [sum(group) / len(group) for group in grouped]


def bracket(marks, a, b, slack=BRACKET_SLACK_IN):
    """Widen a span out to the jambs either side of it."""
    before = [m for m in marks if m <= a + slack]
    after = [m for m in marks if m >= b - slack]
    if not before or not after:
        return None
    lo, hi = max(before), min(after)
    return (lo, hi) if hi - lo >= MIN_OPENING_IN else None


def on_walls(walls, perpendicular, glazed, slid, swung, horizontal):
    """Match each symbol to the wall it sits in, and size it by the jambs."""
    out = []
    for coord, lo, hi in walls:
        marks = jambs_on((coord, lo, hi), perpendicular)

        for kind, items in (("window", glazed), ("slider", slid)):
            for centre, a, b in items:
                if abs(centre - coord) > ON_WALL_IN or a < lo - 12 or b > hi + 12:
                    continue
                span = bracket(marks, a, b)
                if span and MIN_OPENING_IN <= span[1] - span[0] <= MAX_OPENING_IN:
                    out.append((kind, (span[0] + span[1]) / 2.0, coord,
                                span[1] - span[0], horizontal))

        for x0, y0, x1, y1 in swung:
            near = (y0, y1) if horizontal else (x0, x1)
            along = (x0, x1) if horizontal else (y0, y1)
            if min(abs(near[0] - coord), abs(near[1] - coord)) > 6.0:
                continue
            if along[0] < lo - 12 or along[1] > hi + 12:
                continue
            span = bracket(marks, along[0], along[1]) or along
            if 20.0 <= span[1] - span[0] <= 60.0:
                out.append(("door", (span[0] + span[1]) / 2.0, coord,
                            span[1] - span[0], horizontal))
    return out


def dedupe(openings):
    """One opening per place. A slider outranks a window at the same spot."""
    rank = {"slider": 0, "door": 1, "window": 2}
    kept = []
    for kind, along, coord, width, horizontal in sorted(
            openings, key=lambda o: rank.get(o[0], 3)):
        x, y = (along, coord) if horizontal else (coord, along)
        if any(abs(x - kx) < 12 and abs(y - ky) < 12 for _, kx, ky, _, _ in kept):
            continue
        kept.append((kind, x, y, width, horizontal))
    return kept
