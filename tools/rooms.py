"""Find rooms first, and let the walls fall out of them.

The first tracer worked the other way round: pair up parallel lines, call each
pair a wall, and hope the result joined up. It reported "62 walls, off-axis
0.000000" and looked like a success. Painting those walls solid and flood
filling the plan produced ONE region of 1613 sq ft -- the whole sheet. The walls
enclosed nothing: the north wall stopped 270px short of the west wall, and no
metric in that pipeline could see it, because none of them asked the only
question that matters, which is whether the output describes rooms.

So the order is inverted. Rooms come first and walls are whatever bounds them,
which makes the loose ends that plagued the line tracer impossible rather than
merely rare -- a room boundary is closed by construction.


## Why this does not flood fill

The obvious way to find rooms in a floor plan is to threshold the image and
flood fill the white. Tried, and it fails twice over on a drawing like this:

  * A DOOR is a real gap in the wall, so the fill leaks through every doorway
    and merges the house into one blob. (A WINDOW is not a gap -- the wall's
    face lines run through it and only the glazing sits inside - so windows are
    never a problem.)
  * Sealing the doorways by painting the traced walls on solidly fixes the leak
    and introduces a worse bug: the traced walls include phantoms taken from
    counter edges and cabinet runs, and painting those cuts real rooms in half.

Both failures come from asking one global question of the whole raster. So this
asks a local one instead, of each edge of the grid the canonical wall lines
already form: how much of THIS edge is drawn on? Everything inside a cell --
cabinets, counters, the bathtub, the hatched fills in the kitchen - is
irrelevant to that question, because none of it lies along a grid line.

Cells that are not separated by a drawn edge are the same room. Walls are the
edges that separate different rooms, emitted once per edge rather than once per
room, so adjoining rooms share a wall instead of each bringing their own.

An edge that is NOT drawn on, between two cells that would otherwise be
different rooms, is an opening -- which is how the kitchen and the great room
end up as one space without anybody having to detect the cased opening between
them.
"""

MIN_CELL_IN = 14.0   # narrower than this is a wall cavity, not a room
# Two canonical lines closer than this are the two faces of one wall. Kept well
# under MIN_CELL_IN: a closet is a genuine room barely wider than a wall band,
# and collapsing at 14in merged its two sides and swallowed the closet.
COLLAPSE_IN = 8.0
# A closet is not a room. The drawing's pantry is 19 sqft and its bath 28.
MIN_ROOM_SQFT = 24.0
# Fraction of a grid edge that has to be drawn on for it to count as a wall.
SOLID_FRACTION = 0.55

OUTSIDE = 0


def covered(segments, coord, a, b, tol=MIN_CELL_IN / 2):
    """Fraction of the span a..b on line `coord` that traced walls cover.

    The evidence is the CENTRELINES, not the raster. A counter edge, a cabinet
    face and a wall are all equally black, so raw ink cannot tell them apart and
    reported fifteen rooms where there are seven -- every counter drawn across
    the kitchen cut it into strips. The centrelines already carry the
    distinction, because they only exist where two parallel lines sat a stud
    wall apart (3-9in). Reusing that judgement here means it is made once.

    A doorway is a hole in the coverage, which is what we want: a 32in door in a
    12ft wall still leaves it 78% covered and it stays a wall, while a cased
    opening most of a cell wide drops below the threshold and the two rooms
    become one. That is the kitchen and the great room, decided by arithmetic
    rather than by a symbol detector.
    """
    span = b - a
    if span <= 0:
        return 0.0
    total = 0.0
    for c, lo, hi in segments:
        # Within a tolerance, not exactly: collapse() moves an axis to the
        # midpoint of the band it merged, so it no longer equals the snapped
        # coordinate of the centrelines that made it. Matching exactly found
        # nothing, every edge read as open, and the house came back as one room.
        if abs(c - coord) > tol:
            continue
        total += max(0.0, min(b, hi) - max(a, lo))
    return min(1.0, total / span)


def coverage_map(cells, xs, ys, walls_h, walls_v):
    """Wall coverage for every edge between two cells."""
    solid = {}
    for (i, j) in cells:
        for right in (True, False):
            other = (i + 1, j) if right else (i, j + 1)
            if other not in cells:
                continue
            if right:
                value = covered(walls_v, xs[i + 1], ys[j], ys[j + 1])
            else:
                value = covered(walls_h, ys[j + 1], xs[i], xs[i + 1])
            solid[((i, j), other)] = value
    return solid


def connect(cells, solid, threshold):
    """Group cells into rooms, crossing every edge that is not a wall."""
    parent = {cell: cell for cell in cells}

    def find(cell):
        while parent[cell] != cell:
            parent[cell] = parent[parent[cell]]
            cell = parent[cell]
        return cell

    for (one, two), value in solid.items():
        if value < threshold:
            a, b = find(one), find(two)
            if a != b:
                parent[a] = b

    rooms = {}
    for cell in cells:
        rooms.setdefault(find(cell), []).append(cell)
    return rooms


def walls_from_cells(label_of, xs, ys, keep):
    """A wall wherever two neighbouring cells belong to different rooms.

    Looked at from between the two cells rather than by walking around each of
    them, so a shared wall is emitted once. That is the deduplication the line
    tracer never did.
    """
    def room(i, j):
        label = label_of.get((i, j), OUTSIDE)
        return label if label in keep else OUTSIDE

    vertical, horizontal = [], []
    for (i, j) in label_of:
        here = room(i, j)
        if here != room(i + 1, j):
            vertical.append((xs[i + 1], ys[j], ys[j + 1]))
        if here != room(i - 1, j):
            vertical.append((xs[i], ys[j], ys[j + 1]))
        if here != room(i, j + 1):
            horizontal.append((ys[j + 1], xs[i], xs[i + 1]))
        if here != room(i, j - 1):
            horizontal.append((ys[j], xs[i], xs[i + 1]))
    return sorted(set(horizontal)), sorted(set(vertical))


def join_runs(runs):
    """Weld end-to-end collinear segments into single walls."""
    out = []
    for coord, lo, hi in sorted(runs):
        if out and out[-1][0] == coord and abs(out[-1][2] - lo) < 1e-6:
            out[-1][2] = hi
        else:
            out.append([coord, lo, hi])
    return [tuple(run) for run in out]


def collapse(values, tol=COLLAPSE_IN):
    """Merge canonical lines closer together than a room can be.

    Two wall lines 11in apart are the two sides of one wall, not a room. Left
    alone they make a cell too thin to keep, which is dropped -- and dropping it
    puts a hole in the grid, so the cells either side stop being neighbours and
    each emits its own wall against the gap. One wall becomes two with a slot
    between them. Collapsing to the midpoint first means the band IS the wall
    line, which is what it was drawn as.
    """
    if not values:
        return []
    groups = [[values[0]]]
    for value in values[1:]:
        if value - groups[-1][-1] < tol:
            groups[-1].append(value)
        else:
            groups.append([value])
    return [sum(group) / len(group) for group in groups]


def detect(xs, ys, walls_h, walls_v, threshold=SOLID_FRACTION):
    """Rooms, and the walls that bound them.

    `xs`/`ys` are the canonical wall lines. Their outermost members are the
    building envelope, so every cell of the grid they form is inside the house
    and there is no exterior region to identify.
    """
    # Thin cells are wall cavities, not rooms, and are left out of the grid.
    #
    # collapse() was an attempt to merge them into a single wall line instead,
    # so that the cells either side stayed neighbours. It trades one bug for
    # another: at a tolerance wide enough to merge a wall band it also merges
    # the two sides of a closet and swallows the closet, and at a tolerance
    # narrow enough to keep the closet the cavity survives as its own cell and
    # chains every room together through it. Dropping them is the lesser
    # problem -- it doubles some walls, which is visible and fixable, rather
    # than losing rooms, which is not.
    xs, ys = sorted(xs), sorted(ys)
    cells = [(i, j)
             for i in range(len(xs) - 1) if xs[i + 1] - xs[i] >= MIN_CELL_IN
             for j in range(len(ys) - 1) if ys[j + 1] - ys[j] >= MIN_CELL_IN]

    solid = coverage_map(cells, xs, ys, walls_h, walls_v)
    groups = connect(cells, solid, threshold)

    label_of, areas = {}, {}
    for index, (_, members) in enumerate(sorted(groups.items()), start=1):
        area = sum((xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j])
                   for i, j in members) / 144.0
        if area < MIN_ROOM_SQFT:
            continue
        areas[index] = area
        for cell in members:
            label_of[cell] = index

    horizontal, vertical = walls_from_cells(label_of, xs, ys, set(areas))
    return {
        "xs": xs,
        "ys": ys,
        "cells": label_of,
        "areas": areas,
        "walls_h": join_runs(horizontal),
        "walls_v": join_runs(vertical),
        "solid": solid,
    }
