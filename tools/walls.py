"""Walls as boxes: a rectangle per run, overlapping freely at the junctions.

The tracer this replaces reduced a wall to a CENTRELINE -- one number, with the
thickness thrown away -- and then worked on a lattice of those numbers. Three of
its four failure modes come straight out of that choice:

  * a wall band's two faces became two independent lattice coordinates, the thin
    cell between them was dropped as a cavity, and the cells either side each
    emitted their own wall. Every wall came out DOUBLED, with a slot down the
    middle: x=17.45 and x=18.20 are one 9in wall reported as two.
  * a short return beside a doorway lost its own face to the long run alongside
    it when collinear segments were merged, so it never paired and never became
    a wall. Two partitions went missing entirely on the kitchen plan.
  * ends were made to meet by snapping to a shared axis within 8in, which is
    both too loose (real jogs get welded straight) and too tight (a hairline
    gap survives and leaves a loose end).

A box fixes all three by construction rather than by tolerance.

## The model

A wall is a rectangle: one axis, two face coordinates, and a run. Thickness is
face-to-face, so it is measured rather than assumed -- 2x4 partitions and 2x6
exterior walls come out as themselves instead of architect3d's flat 10cm.

Boxes are NOT trimmed where they meet. Each spans its own natural run and they
overlap, and the overlap IS the junction. That is how the drafter drew it: no
mitring, no trimming, two rectangles crossing. Modelling it the same way means
there is no corner logic to get wrong.

Boxes are also deliberately OVER-EXTENDED at both ends, by one thickness. A
traced face stops at the neighbouring wall's near face, which can leave a
hairline gap -- and a hairline gap means the union does not close and two
centrelines that should cross do not. Overshooting makes the overlap certain
instead of hoped-for, and it is what replaces the old END_TOL_IN snapping.

## What comes out

Two things, for two different consumers:

  the union of the boxes   is the wall region: what to draw, and whose
                           complement is the rooms.
  each box's centreline    is an architect3d wall, split where another box's
                           centreline crosses it so that a junction is a real
                           shared corner and a room can close around it.

The centreline never has to be recovered from the union, because it was never
lost -- the box was built from its own two faces and knows its own axis. That
is the whole advantage over skeletonising a traced polygon, which throws spurs
at every end and junction and then needs them pruned.
"""

import math
from collections import defaultdict

# A pair of faces this far apart is a wall. Wide enough for a 2x6 exterior wall
# with finishes, narrow enough to reject a 12in cabinet -- but only used to seed
# thickness discovery, which then narrows to what THIS drawing actually uses.
THICKNESS_MIN_IN = 2.0
THICKNESS_MAX_IN = 12.0
# How far a measured gap may sit from a discovered thickness and still be it.
THICKNESS_TOL_IN = 0.75
# Two faces must run alongside each other for at least this much to be a pair.
# Short, because a return beside a doorway is short and is exactly what the old
# 18in minimum was throwing away.
MIN_PAIR_IN = 2.5
# Faces within this of each other on the same line are one face.
FACE_JOIN_IN = 2.0
# How far to overshoot each end of a box, as a multiple of its thickness.
OVERSHOOT = 1.0
# Slack when asking whether a run sits between two others rather than beside
# them. A jamb is drawn with a little overlap either way.
GAP_TOUCH_IN = 2.0
# A wall may be bridged across an opening no wider than this. Wider than a
# double door and a cased opening; narrower than a room.
MAX_OPENING_IN = 96.0
# A jamb mark is a stub. Longer than this and it is a piece of wall face, which
# would have paired on its own and needs no bridging.
MAX_JAMB_IN = 14.0
# How much wall a width needs behind it to count as a construction type rather
# than a coincidence. A closet is the smallest real case: two walls of about
# 7ft between them on this plan.
MIN_TYPE_LENGTH_IN = 72.0
# How much longer than it is thick a wall attached at only one end has to be.
MIN_STUB_RATIO = 3.0
# Two stretches are the same wall only if built from the same two face lines,
# to within this. Snapping moves a face by well under an inch.
SAME_PAIR_IN = 1.0
# Centrelines closer than this are the same wall however they were paired.
# Well under a stud width, so two genuinely different walls cannot collide.
SAME_LINE_IN = 1.5


def merge_runs(runs, join):
    """Weld overlapping and nearly-touching runs on the same line."""
    out = []
    for coord, lo, hi in sorted(runs):
        for run in out:
            if abs(run[0] - coord) < 1e-6 and lo <= run[2] + join and hi >= run[1] - join:
                run[1], run[2] = min(run[1], lo), max(run[2], hi)
                break
        else:
            out.append([coord, lo, hi])
    return [tuple(r) for r in out]


def faces(segments, tol_in):
    """Axis-aligned runs, snapped onto shared lines and welded.

    Snapping happens BEFORE welding, not after. Two collinear pieces of one
    face that differ by a thousandth of an inch are not on the same line by an
    exact test, so they never weld, and each pairs separately with the opposite
    face to make two boxes where there is one wall.
    """
    # Single-linkage, not a rounding grid. Rounding puts two pieces of one face
    # at 0.24 and 0.26 into different buckets, so they never weld, each starts
    # its own band, and one exterior wall comes back as four boxes along the
    # same line -- which is the doubling this whole rewrite exists to remove,
    # reappearing one level down.
    groups = []
    for coord, lo, hi in sorted(segments):
        if groups and coord - groups[-1][-1][0] <= tol_in:
            groups[-1].append((coord, lo, hi))
        else:
            groups.append([(coord, lo, hi)])

    out = []
    for group in groups:
        shared = sum(c for c, _, _ in group) / len(group)
        out.extend(merge_runs([(shared, lo, hi) for _, lo, hi in group], FACE_JOIN_IN))
    return sorted(out)


def candidates(runs):
    """Every face pair that could be a wall, with where the two run together.

    No grouping and no seed. Grouping faces into bands first was the previous
    attempt and it fails for a reason that has nothing to do with the pairing
    rule: a band is built greedily from whichever line sorts first, and on the
    kitchen plan's north wall that line is the WINDOW FRAME, which projects an
    inch proud of the wall face.

        y= 0.00in   only at 5.89-9.47, 17.78-21.36, 28.39-34.31 ft   the windows
        y= 2.11in   only at 0.14-6.19, 9.19-18.06, 21.06-28.69, ...  the wall
        y= 8.23in   the inner face
        y=10.00in   the same three window stretches as y=0

    Seeded at y=0 the band takes y=10 as its opposite face -- the two are
    perfectly co-extensive, being the two sides of the same window frame -- and
    the wall between the windows never gets considered at all. That is why the
    trace produced boxes at the three windows and nowhere else.

    So every pair is scored on its own and the strongest wins globally. The
    frame pair still scores, but only over 3.5ft; the real face pair scores
    over 27ft and is taken first, after which the frame is shadowed by it.
    """
    out = []
    for index, (c1, lo1, hi1) in enumerate(runs):
        for c2, lo2, hi2 in runs[index + 1:]:
            gap = c2 - c1
            if gap > THICKNESS_MAX_IN:
                break
            if gap < THICKNESS_MIN_IN:
                continue
            together = min(hi1, hi2) - max(lo1, lo2)
            if together >= MIN_PAIR_IN:
                out.append({"near": c1, "far": c2, "gap": gap,
                            "lo": max(lo1, lo2), "hi": min(hi1, hi2),
                            "together": together})
    return out


def coalesce(found):
    """Sum each face pair's co-extent over every stretch it runs together.

    A face arrives in pieces -- broken at every doorway and every crossing wall
    -- so one wall shows up as several candidates on the same two lines. Judging
    them piece by piece lets a 3.5ft window frame outscore a 27ft wall that
    happens to be drawn in four parts.
    """
    merged = defaultdict(list)
    for pair in found:
        merged[(round(pair["near"], 3), round(pair["far"], 3))].append(pair)
    out = []
    for (near, far), group in merged.items():
        out.append({
            "near": near, "far": far, "gap": far - near,
            "pieces": sorted((p["lo"], p["hi"]) for p in group),
            "together": sum(p["together"] for p in group),
        })
    return sorted(out, key=lambda p: -p["together"])


def bands(runs, horizontal):
    """Group parallel faces that overlap into wall bands, outer face to outer.

    Pairing every face with every other face within a thickness range was the
    first attempt, and a builder's drawing breaks it immediately: an exterior
    wall is drawn with THREE or more parallel lines -- outer face, sheathing,
    inner face -- so pairing produced a box for every combination. On the
    kitchen plan that returned seven distinct "thicknesses" (4.0, 5.25, 6.0,
    6.75, 7.0, 7.25, 10.0) where the drafter used two, and four separate boxes
    sharing one centreline where there is one wall.

    A band is the right unit. All the lines drawn for one wall are collected,
    and the wall is the OUTERMOST two of them: 10in outside to outside, with
    whatever was drawn in between belonging to it rather than competing with it.
    """
    out = []
    for coord, lo, hi in sorted(runs):
        for band in out:
            if coord - band["near"] > THICKNESS_MAX_IN:
                continue
            # It only joins the band if it runs ALONGSIDE it. Two faces the
            # right distance apart that do not overlap are opposite sides of
            # different rooms, not two sides of one wall.
            if lo > band["hi"] - MIN_PAIR_IN or hi < band["lo"] + MIN_PAIR_IN:
                continue
            band["far"] = max(band["far"], coord)
            band["lo"] = min(band["lo"], lo)
            band["hi"] = max(band["hi"], hi)
            band["lines"].append((coord, lo, hi))
            break
        else:
            out.append({"near": coord, "far": coord, "lo": lo, "hi": hi,
                        "lines": [(coord, lo, hi)]})
    return [b for b in out if len(b["lines"]) >= 2]


def face_pairs(band):
    """Every candidate face pair in a band, best co-extent first.

    A band's two faces are NOT its outermost lines. Taking the extremes was the
    first attempt and it fails on any wall carrying detail: the north wall of
    the kitchen plan absorbed its own window glazing, the glazing became the
    far face, and since glazing exists only at a window the wall produced boxes
    at its three windows and nowhere else. Every plain stretch between them had
    a perfectly good face pair that a line further out had taken the slot from.

    The right test is CO-EXTENT. An outer and an inner face run together for
    the whole length of the wall; glazing runs for three feet, a jamb mark for
    four inches. Choosing the pair that runs together longest picks the wall's
    real faces and leaves everything else as what it is -- detail belonging to
    the wall rather than a candidate to define it.
    """
    out = []
    lines = sorted(band["lines"])
    for index, (c1, lo1, hi1) in enumerate(lines):
        for c2, lo2, hi2 in lines[index + 1:]:
            gap = c2 - c1
            if gap > THICKNESS_MAX_IN:
                break
            if gap < THICKNESS_MIN_IN:
                continue
            together = min(hi1, hi2) - max(lo1, lo2)
            if together >= MIN_PAIR_IN:
                out.append({"near": c1, "far": c2, "gap": gap,
                            "together": together})
    return sorted(out, key=lambda p: -p["together"])


def thicknesses(horizontal, vertical):
    """What wall thicknesses this drawing actually uses.

    Discovered, not declared. A drafter picks a thickness per wall type and
    holds it over the whole sheet, so the gaps pile up on a couple of values
    and everything else is scattered. Each candidate votes with the distance
    its two faces actually run together, so one long exterior wall outvotes a
    dozen short coincidences -- which is what keeps a 12in cabinet run from
    becoming a wall without anyone having to name a pen or a colour.
    """
    tally = defaultdict(float)
    for pair in list(horizontal) + list(vertical):
        tally[round(pair["gap"] * 4) / 4] += pair["together"]
    if not tally:
        return []

    # A flat floor, in feet of wall, and nothing relative.
    #
    # Two cleverer rules failed first. Keeping every bucket above a fraction of
    # the PEAK measures a short partition against the longest exterior wall in
    # the house: 4.5in carried 25ft of 2x4 partition and was thrown out, and
    # the closet's 3.2in walls went with it, which is why the middle bedroom
    # had no closet at all. Clustering the buckets into modes and judging each
    # mode failed differently -- the distribution is not modal. There is a
    # bucket at nearly every quarter inch from 3 to 11, so any join tolerance
    # wide enough to gather one wall type chains the lot into a single mode.
    #
    # That is not noise, it is the drawing: this is a remodel, and existing
    # walls, new walls and furred-out walls are genuinely different thicknesses.
    # So the only honest question is whether a width is backed by enough wall
    # to be a construction type rather than a coincidence, and that is an
    # absolute quantity.
    return sorted(w for w, weight in tally.items() if weight >= MIN_TYPE_LENGTH_IN)


def _plugs_a_gap(centre, lo, hi, taken):
    """True if this run sits in a gap between two accepted stretches of one wall.

    A window is drawn a little wider than the wall it sits in, so its frame is
    a parallel pair too -- 10in where the wall is 7in on the kitchen plan's
    north wall -- and it lives exactly where the wall's own faces stop. Nothing
    overlaps it, so the shadow test never sees it, and it gets accepted as a
    wall that neatly plugs every window. The openings then vanish.

    Sitting between two stretches of the same wall line, and touching neither,
    is what a frame does and what a wall never does.
    """
    same = [box for box in taken
            if abs(centre - box["centre"]) <= max(box["thickness"], 1.0)]
    if not same:
        return False
    # By the MIDPOINT, not the ends. A window frame is drawn a little wider
    # than the hole it fills, so it overlaps the wall face either side of it by
    # an inch or two -- and an endpoint test then finds nothing "before" it and
    # lets the frame through. On the north wall that let the frame take the
    # whole run, shadow the real wall down to its last four feet, and swallow
    # all three windows.
    middle = (lo + hi) / 2.0
    before = [box for box in same if box["drawn_hi"] <= middle]
    after = [box for box in same if box["drawn_lo"] >= middle]
    if not (before and after):
        return False
    # And it has to actually be a hole in that wall, not a continuation of it.
    left = max(box["drawn_hi"] for box in before)
    right = min(box["drawn_lo"] for box in after)
    return right - left <= MAX_OPENING_IN


def select(pairs, thickness_set, horizontal):
    """Take the strongest face pairs first, letting each shadow weaker overlaps.

    Best-first rather than in drawing order. Two candidates covering the same
    stretch of the same wall are the same wall described twice -- the real face
    pair and some inner line paired with an outer one -- and the one that runs
    together longest is the one the drafter drew as the wall.
    """
    taken = []
    for pair in pairs:
        if not any(abs(pair["gap"] - t) <= THICKNESS_TOL_IN for t in thickness_set):
            continue
        centre = (pair["near"] + pair["far"]) / 2.0
        for lo, hi in _cover([(0, lo, hi) for lo, hi in pair["pieces"]]):
            if hi - lo < MIN_PAIR_IN:
                continue
            # Shadowed if an accepted wall already occupies this ground: its
            # band contains this centreline and its run covers most of this one.
            if any(abs(centre - box["centre"]) <= box["thickness"] / 2.0
                   and min(hi, box["drawn_hi"]) - max(lo, box["drawn_lo"])
                   > (hi - lo) * 0.5
                   for box in taken):
                continue
            # Or if it fills a GAP in a wall already accepted on this line,
            # which makes it an opening symbol rather than a wall.
            #
            # A window is drawn a little wider than the wall it sits in, so its
            # frame is a parallel pair too -- 10in where the wall is 7in on the
            # kitchen plan's north wall -- and it lives exactly where the wall's
            # own faces stop. Nothing overlaps it, so the shadow test above
            # never sees it, and it gets accepted as a wall that neatly plugs
            # every window. The openings then vanish: the north wall reads as
            # one continuous run and its three windows are gone.
            #
            # Sitting between two stretches of the same wall line, and touching
            # neither, is what a frame does and what a wall never does.
            if _plugs_a_gap(centre, lo, hi, taken):
                continue
            reach = pair["gap"] * OVERSHOOT
            taken.append({
                "centre": centre,
                "thickness": pair["gap"],
                # The two lines this box was actually built from. Kept because
                # a tolerance band around the centreline is not good enough to
                # find them again later: the band also contains the window
                # frame, which covers exactly the openings, so reading the band
                # back fills every gap and the openings vanish.
                "near": pair["near"],
                "far": pair["far"],
                "lo": lo - reach,
                "hi": hi + reach,
                "horizontal": horizontal,
                # Kept so a later pass can tell a box's true extent from its
                # overshoot -- the overshoot makes junctions meet, it is not a
                # claim about where the wall stops.
                "drawn_lo": lo,
                "drawn_hi": hi,
            })
    return taken


def _cover(lines):
    """The intervals one face covers, merged, in order."""
    spans = sorted((lo, hi) for _, lo, hi in lines)
    out = []
    for lo, hi in spans:
        # Bridged across small breaks: a face is interrupted by every doorway
        # and every wall crossing it, and those interruptions are the wall, not
        # gaps in it.
        if out and lo <= out[-1][1] + FACE_JOIN_IN:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return out


def _overlap(one, two):
    """Where two sets of intervals run together."""
    out, i, j = [], 0, 0
    while i < len(one) and j < len(two):
        lo = max(one[i][0], two[j][0])
        hi = min(one[i][1], two[j][1])
        if hi > lo:
            out.append((lo, hi))
        if one[i][1] < two[j][1]:
            i += 1
        else:
            j += 1
    return out


def combine(boxes_in, jambs=None):
    """Merge boxes that are the same wall, including across their openings.

    Two jobs, and the second is the one that matters. Overlapping collinear
    boxes are the same wall seen twice -- invisible on a lattice of bare
    centrelines, which is why every wall used to come out doubled, and three
    comparisons here.

    The second job is bridging a wall across its own openings. A wall is drawn
    in the stretches BETWEEN its doors, so a wall that is nearly all door is
    barely drawn at all: the closet in the middle bedroom carries a bypass
    slider across almost its whole width, and all that survives of the wall is
    four jamb stubs 2.7in long. Nothing pairs, nothing is traced, and a wall
    that is plainly there goes missing. The same thing empties the door zone in
    the middle of the house and loses the half wall by the sink.

    So a gap between two collinear boxes is bridged when there is JAMB evidence
    inside it -- a short stub on the wall's own line, which is the drawing
    saying "the wall stops here and starts again there". Requiring the evidence
    is what keeps this from welding two genuinely separate walls that happen to
    share a line with a room in between.

    The result is the CONTINUOUS wall, which is what architect3d wants: one
    wall carrying its windows and doors as placed items. The drawn stretches
    are still recoverable from the face coverage, and wall_truth.py does that.
    """
    stubs = jambs or []
    out = []
    for box in sorted(boxes_in, key=lambda b: (b["horizontal"], b["centre"], b["lo"])):
        for kept in out:
            if kept["horizontal"] != box["horizontal"]:
                continue
            if abs(kept["centre"] - box["centre"]) > max(kept["thickness"],
                                                         box["thickness"]) / 2.0:
                continue
            gap = max(box["lo"] - kept["hi"], kept["lo"] - box["hi"])
            # Two stretches that OVERLAP but were built from different face
            # lines are different things sharing a line, and must stay apart.
            # architect3d keeps height and thickness per WALL, so anything the
            # drafter drew differently has to arrive as its own wall or there
            # is nothing to set the property on. In the kitchen 12.058in is
            # both the middle wall's far face and the half wall's near edge,
            # so merging on centre proximity alone swallowed the half wall
            # into a full-height run and left nothing to designate.
            #
            # A GAP is the opposite case: one wall interrupted by a door, whose
            # face is broken there so a neighbouring line takes over for the
            # next stretch. Applying the same-pair test to those as well cost
            # two doors -- the closet's and the bathroom's -- by splitting the
            # walls they sit in.
            same_pair = (abs(kept["near"] - box["near"]) <= SAME_PAIR_IN
                         and abs(kept["far"] - box["far"]) <= SAME_PAIR_IN)
            # Unless the two centrelines all but coincide, in which case they
            # are one wall that picked up a second pair, not two things sharing
            # a line. The left wall came out as two boxes half an inch apart --
            # 6.87in and 9.83in thick, the second having caught a further face
            # -- and close_corners then honestly snapped the bottom wall to
            # both, leaving two corners half an inch apart where the plan has
            # one. The half wall is 2.8in off the middle wall's centreline and
            # is unaffected.
            on_one_line = abs(kept["centre"] - box["centre"]) <= SAME_LINE_IN
            if gap <= 0 and not same_pair and not on_one_line:
                continue
            if gap > 0:
                if gap > MAX_OPENING_IN:
                    continue
                lo = min(kept["drawn_hi"], box["drawn_hi"])
                hi = max(kept["drawn_lo"], box["drawn_lo"])
                if not _jamb_between(kept, lo, hi, stubs):
                    continue
            kept["lo"] = min(kept["lo"], box["lo"])
            kept["hi"] = max(kept["hi"], box["hi"])
            kept["drawn_lo"] = min(kept["drawn_lo"], box["drawn_lo"])
            kept["drawn_hi"] = max(kept["drawn_hi"], box["drawn_hi"])
            # The DOMINANT contributor sets the thickness, not the first one
            # merged and not the widest.
            #
            # Taking the max let a window frame's 10in win over the 7in wall it
            # sat in. Keeping the first was worse and less obviously wrong: the
            # merge order is by centreline, so on the bathroom's west wall a
            # spurious 10.23in pair sorted ahead of the real 6.8in one and
            # painted its width over the whole wall -- and did the same on the
            # opposite wall, which is why the two matched each other at a width
            # neither of them is.
            #
            # Longest wins, for the same reason it wins in select(): the pair
            # with the most linework behind it is the one the drafter drew.
            kept["faces"] = kept.get("faces", [(kept["near"], kept["far"])])
            kept["faces"].append((box["near"], box["far"]))
            if (box["drawn_hi"] - box["drawn_lo"]) > kept.get("_span", 0.0):
                kept["_span"] = box["drawn_hi"] - box["drawn_lo"]
                kept["thickness"] = box["thickness"]
                kept["centre"] = box["centre"]
                # The pair that won is also the only one entitled to say where
                # this wall's openings are. Reading every merged pair instead
                # lets one that happens to span a doorway fill the gap that
                # marks it, and the opening disappears.
                kept["near"], kept["far"] = box["near"], box["far"]
            break
        else:
            entry = dict(box)
            entry["faces"] = [(box["near"], box["far"])]
            entry["_span"] = box["drawn_hi"] - box["drawn_lo"]
            out.append(entry)
    return out


def _jamb_between(box, lo, hi, stubs):
    """Is there a jamb mark on this wall's line, inside the gap lo..hi?

    A jamb is a short stub lying in the wall's own band. It is what the drafter
    draws where a wall meets an opening, so finding one is the drawing saying
    the wall continues past here rather than ending.
    """
    half = box["thickness"] / 2.0 + 1.0
    for coord, a, b in stubs:
        if abs(coord - box["centre"]) > half:
            continue
        if b - a > MAX_JAMB_IN:
            continue
        if a >= lo - GAP_TOUCH_IN and b <= hi + GAP_TOUCH_IN:
            return True
    return False


def drop_floating(boxes_in):
    """Throw out boxes that meet no other wall at either end.

    A wall runs between other walls, or between a wall and the building
    envelope. It does not float. What floats is a fixture outline that happens
    to be drawn on the architecture pen and happens to pair at a wall-like
    thickness -- in the kitchen, a 30in counter edge pairing with the half-wall
    line, a 9.7in box under the sink, a 2in stub beside the post.

    Those survive every test upstream because they ARE two parallel lines a
    construction thickness apart running alongside each other. Geometry cannot
    tell them from a wall. What tells them apart is that they are connected to
    nothing, and a house is a connected thing.

    Only boxes joined at NEITHER end go. A pony wall stops in open floor at one
    end and is still a wall, so requiring both ends would throw it away.
    """
    def joins(box, edge):
        for other in boxes_in:
            if other is box or other["horizontal"] == box["horizontal"]:
                continue
            if (other["lo"] <= box["centre"] <= other["hi"]
                    and abs(other["centre"] - edge) <= max(other["thickness"],
                                                           box["thickness"])):
                return True
        return False

    out = []
    for box in boxes_in:
        ends = sum(1 for edge in (box["drawn_lo"], box["drawn_hi"])
                   if joins(box, edge))
        if not ends:
            continue
        # A box hanging off ONE end has to be long relative to its thickness.
        # The sink cabinet is 22in long and 9.7in thick -- barely longer than
        # it is wide -- and hangs off the middle wall, so the floating test
        # alone keeps it. A wall is not that shape. Ratio alone is no good
        # either: a real return beside a doorway measures 6.7in on 4.5in, a
        # ratio of 1.49, and it is a wall because it is joined at BOTH ends.
        length = box["drawn_hi"] - box["drawn_lo"]
        if ends == 1 and length < box["thickness"] * MIN_STUB_RATIO:
            continue
        out.append(box)
    return out


def close_corners(boxes_in):
    """Run each box's drawn end out to the centreline of the wall it meets.

    OVERSHOOT exists so that two boxes which should cross actually do, and a
    blanket overshoot of one thickness does that -- but it is a device, not a
    claim, and drawing it makes every wall overhang its corner by a whole
    thickness. Rendering the un-extended run instead makes the corners look
    like they failed to close.

    Both are wrong because neither is where the wall ends. Walls meet at each
    other's CENTRELINES, which is the convention the drawing uses and the one
    architect3d wants, so a box's end belongs on the centreline of whatever it
    runs into. Corners then close exactly, with nothing hanging over.
    """
    # To a fixed point, because one pass is order-dependent. Each box is
    # snapped against its neighbours' CURRENT extents, so a box visited early
    # sees runs that later grow: on this plan a wall at y=9.75ft ended 3.77in
    # past the vertical it meets, because when it was visited that vertical had
    # not yet been extended up to reach it. The two corners then sat inside the
    # app's 20cm weld tolerance and it merged them on load.
    for _ in range(8):
        moved = False
        for box in boxes_in:
            reach = box["thickness"] * OVERSHOOT + FACE_JOIN_IN
            for other in boxes_in:
                if other["horizontal"] == box["horizontal"]:
                    continue
                # It has to actually cross, not merely point at us from
                # elsewhere.
                if not (other["lo"] <= box["centre"] <= other["hi"]):
                    continue
                for end in ("drawn_lo", "drawn_hi"):
                    if 0 < abs(other["centre"] - box[end]) <= reach:
                        box[end] = other["centre"]
                        moved = True
        if not moved:
            break
    for box in boxes_in:
        # Both from the ORIGINAL pair. Assigning drawn_lo first and then
        # reading it back to compute drawn_hi collapses the box to a point
        # whenever snapping crossed the two over.
        low, high = box["drawn_lo"], box["drawn_hi"]
        box["drawn_lo"], box["drawn_hi"] = min(low, high), max(low, high)

    return boxes_in


def crossings(boxes_in):
    """Where each box's centreline is cut by another's.

    architect3d walks closed loops of corners to find a room, so two walls that
    merely overlap on screen are not enough: a junction has to be a corner they
    share, or the room around it is never found.
    """
    cuts = defaultdict(set)
    across = [b for b in boxes_in if not b["horizontal"]]
    for index, box in enumerate(boxes_in):
        if not box["horizontal"]:
            continue
        for other in across:
            if (box["lo"] <= other["centre"] <= box["hi"]
                    and other["lo"] <= box["centre"] <= other["hi"]):
                cuts[index].add(other["centre"])
    for index, box in enumerate(boxes_in):
        if box["horizontal"]:
            continue
        for other in boxes_in:
            if not other["horizontal"]:
                continue
            if (box["lo"] <= other["centre"] <= box["hi"]
                    and other["lo"] <= box["centre"] <= other["hi"]):
                cuts[index].add(other["centre"])
    return cuts


def segments_from(boxes_in):
    """Split every box's centreline at its crossings. Ready for a wall graph."""
    cuts = crossings(boxes_in)
    out = []
    for index, box in enumerate(boxes_in):
        stops = sorted({box["lo"], box["hi"]} | cuts.get(index, set()))
        for lo, hi in zip(stops, stops[1:]):
            if hi - lo < 1e-6:
                continue
            out.append({
                "centre": box["centre"],
                "thickness": box["thickness"],
                "lo": lo,
                "hi": hi,
                "horizontal": box["horizontal"],
            })
    return out


def trace(horizontal_segments, vertical_segments, tol_in=0.5):
    """Segments in real inches -> wall boxes, and the pieces they split into."""
    h = faces(horizontal_segments, tol_in)
    v = faces(vertical_segments, tol_in)
    pairs_h = coalesce(candidates(h))
    pairs_v = coalesce(candidates(v))
    found = thicknesses(pairs_h, pairs_v)
    if not found:
        return {"thicknesses": [], "boxes": [], "segments": [],
                "faces": (h, v), "pairs": (pairs_h, pairs_v)}
    built = combine(select(pairs_h, found, True), h)         + combine(select(pairs_v, found, False), v)
    # Zero-length and sliver boxes dropped AFTER the corner pass, since that
    # is what sets a box's final extent.
    built = drop_floating([b for b in close_corners(built)
                           if b["drawn_hi"] - b["drawn_lo"] > MIN_PAIR_IN])
    return {
        "thicknesses": found,
        "boxes": built,
        "segments": segments_from(built),
        "faces": (h, v),
        "pairs": (pairs_h, pairs_v),
    }
