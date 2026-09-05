"""Read the dimensions a drafter printed, and check them against the linework.

A dimension string is the only place a drawing states a distance in words. That
makes it two useful things at once: a check on the trace, and a check on itself.
The text says 8'-0"; the geometry it brackets measures some number of points;
multiply by the scale and the two either agree or they do not. Nothing else on
the sheet is self-validating like that, which is why this is the scoreboard the
tracer is judged against rather than another thing the tracer produces.

## What marks the ends

Not the extension lines, and not the dimension line. Both are long, plain, and
indistinguishable from the drawing they sit beside. What is distinctive is the
TERMINATOR: the small mark where the dimension line stops. Every drafter draws
one, and there are only two kinds in practice.

  arrowhead   two or more short segments sharing one endpoint. The shared
              endpoint IS the measured point. Southern Integrity draws these in
              #000080 -- four segments at an interior station, one arrow each
              way, and two at the ends of a chain.

  tick        one short 45-degree slash crossing the dimension line. Nothing is
              shared, so the measured point is the slash's own midpoint.
              SketchUp LayOut draws these, 4.8pt long, in plain black.

Both reduce to a point on a line, so both feed the same chain builder. Reading
them as one primitive is what lets this work on two drafters who agree on
nothing else -- not colour, not line weight, not even whether a wall is drawn
hollow or filled solid.

## Why the pen is not the filter

Tempting, since both drafters do give dimensions their own pen (#000080 and
#004080 on one sheet, plain black on the other). But black is also the WALL pen
on the LayOut sheets, so filtering by pen there either keeps everything or loses
the ticks. The chain structure filters better and needs no per-drawing constant:
a run of collinear terminators, two or more, with a parsable dimension string
sitting on it. Hatching throws off hundreds of short diagonals and not one of
them lands in a collinear run beside text saying how long it is.
"""

import math
import re
from collections import defaultdict

import pymupdf

# A terminator is small. A tick measures 4.8pt and an arrow barb 7.6pt on the
# two sheets to hand; the cap is loose enough for a heavier hand and still far
# under the shortest thing that could be mistaken for one.
MAX_TERMINATOR_PT = 12.0
# Two segment ends this close are the same point. Arrow barbs meet exactly in
# both files; the tolerance is for drafters whose export does not.
APEX_TOL_PT = 0.6
# How far off a shared row or column a terminator may sit and still belong to
# the same dimension line. Arrowhead barb midpoints straddle their apex by
# about a point, so this cannot be tight.
CHAIN_TOL_PT = 3.5
# A span shorter than this is a leader or a hatch artefact, not a dimension.
MIN_SPAN_PT = 10.0
# How far across its chain a dimension string may sit. The drafter leaves a gap
# between the text and the line; nobody leaves this much.
TEXT_BAND_PT = 26.0
# Two slanted strokes meeting at a wider angle than this are a pattern, not an
# arrowhead. Real barbs measure 25 degrees apart; hexagonal tile meets at 60.
APEX_MAX_SPREAD_DEG = 45.0
# How far a span may miss its printed value and still be that value's span.
# Wide enough for the half-inch the drafters routinely round away, tight enough
# that a spurious station cannot masquerade as a real one.
ALIGN_TOL_IN = 3.0
# Two strokes whose midpoints are within this, at the same heading, are one
# stroke drawn twice. Well under a tick's 4.8pt length, so two genuinely
# distinct terminators are never merged.
DUP_TOL_PT = 1.0
DUP_ANGLE_DEG = 5.0
# What it costs the alignment to leave a string unmatched. Equal to the match
# tolerance, so any span that fits at all beats skipping, and nothing worse
# than the tolerance is ever forced through to avoid a gap.
SKIP_PENALTY_IN = ALIGN_TOL_IN

# 24'-0"  5'-4 1/2"  18"  7'  3'-9"  11 3/4" -- and the typographic quotes that
# LayOut substitutes, which are why a naive pattern matched nothing at first.
_QUOTES = str.maketrans({"’": "'", "′": "'", "”": '"',
                         "″": '"', "–": "-", "—": "-"})
VALUE = re.compile(r"""^\s*
    (?: (\d+) \s* ' )?                            # feet
    \s* -? \s*
    (?: (\d+) (?: \s+ (\d+)/(\d+) )? \s* " )?     # inches, maybe a fraction
    \s*$""", re.VERBOSE)


def _overlaps(clip, rect):
    """Do these rectangles share any ground?

    Not Rect.intersects(): pymupdf calls a zero-AREA rectangle empty and
    reports no intersection for it, and a path holding a single horizontal or
    vertical line has exactly that -- zero height or zero width. So the test
    silently threw away every axis-aligned line on the sheet. On the kitchen
    plan it cut 10600 black-stroked paths down to 36, which is the wall layer
    reduced to nothing while every hatched and filled thing survived intact.
    """
    return (rect.x1 >= clip.x0 and rect.x0 <= clip.x1
            and rect.y1 >= clip.y0 and rect.y0 <= clip.y1)


def parse_value(text):
    """A dimension string in real inches, or None if it is not one."""
    cleaned = " ".join(text.translate(_QUOTES).split())
    match = VALUE.match(cleaned)
    if not match or not any(match.groups()):
        return None
    feet, inches, numerator, denominator = match.groups()
    total = 12.0 * int(feet or 0) + float(inches or 0)
    if numerator and denominator and int(denominator):
        total += int(numerator) / int(denominator)
    return total if total > 0 else None


def _inside(clip, x, y):
    return clip.x0 <= x <= clip.x1 and clip.y0 <= y <= clip.y1


def short_segments(page, clip):
    """Every drawn segment small enough to be a terminator."""
    out = []
    for path in page.get_drawings():
        if not _overlaps(clip, path["rect"]):
            continue
        for item in path["items"]:
            if item[0] != "l":
                continue
            a, b = item[1], item[2]
            if not (_inside(clip, a.x, a.y) and _inside(clip, b.x, b.y)):
                continue
            if math.hypot(b.x - a.x, b.y - a.y) <= MAX_TERMINATOR_PT:
                out.append(((a.x, a.y), (b.x, b.y)))
    return _dedupe(out)


def _dedupe(segments):
    """Drop strokes drawn more than once, in either direction.

    LayOut emits every tick twice, forward and reversed. Two segments sharing
    both endpoints then look exactly like an arrowhead -- same apex test, same
    narrow spread, since a duplicate's heading matches its original perfectly
    -- so each tick reported its two ENDS as stations instead of its midpoint.
    Half a 4.8pt tick is 2.4pt is 1.602 real inches, which was the error on
    thirty-five of Caroline's fifty-four dimensions.

    Matched on midpoint and heading rather than on the endpoints, because the
    copies are not exact. One tick came back as (231.873, 992.303)->(236.665,
    987.495) and again as (236.403, 987.500)->(231.603, 992.300): a quarter of
    a point apart, enough to survive an exact test and still close enough for
    the apex test to weld them. Midpoint and heading are the same for a stroke
    and its reverse by construction, so the comparison does not care which way
    round either was drawn.
    """
    grid, out = {}, []
    for segment in segments:
        (ax, ay), (bx, by) = segment
        mx, my = (ax + bx) / 2.0, (ay + by) / 2.0
        heading = _heading(segment)
        cell = (int(mx // DUP_TOL_PT), int(my // DUP_TOL_PT))
        # Neighbours too: two copies a fraction of a point apart can still fall
        # either side of a cell boundary, which is the whole failure being
        # fixed here reappearing one level down.
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for seen_m, seen_h in grid.get((cell[0] + dx, cell[1] + dy), ()):
                    if (math.hypot(mx - seen_m[0], my - seen_m[1]) <= DUP_TOL_PT
                            and _between(heading, seen_h) <= DUP_ANGLE_DEG):
                        break
                else:
                    continue
                break
            else:
                continue
            break
        else:
            grid.setdefault(cell, []).append(((mx, my), heading))
            out.append(segment)
    return out


def _heading(segment):
    """Direction of a segment in degrees, folded to 0-180 (it has no arrow)."""
    (ax, ay), (bx, by) = segment
    return math.degrees(math.atan2(by - ay, bx - ax)) % 180.0


def _between(one, two):
    """Angle between two headings, in degrees, never more than 90."""
    gap = abs(one - two) % 180.0
    return min(gap, 180.0 - gap)


def _leans(segment):
    """A terminator is drawn on the slant. Everything else on a plan is not.

    This one test does all the discriminating. A tick is a 45-degree slash and
    an arrow barb a slanted V, while extension lines, wall faces, hatching and
    cabinet edges are square to the page. Without it, apex detection claimed
    2473 of 2548 short segments on the Caroline sheet -- every corner where two
    axis-aligned strokes met -- and, worse, a tick whose end happens to touch
    its extension line was read as an apex and reported the station half a tick
    off. That is the whole of the +/-1.602" error that pattern produced.
    """
    (ax, ay), (bx, by) = segment
    return abs(bx - ax) >= 0.3 and abs(by - ay) >= 0.3


def terminators(segments):
    """The measured points: arrow apexes, then whatever ticks are left over.

    In that order and not the other way round. A tick is defined here as a
    slanted segment sharing no endpoint, so the arrows have to be claimed first
    -- otherwise every barb reports its own midpoint as a station and a chain
    of five comes back with eighteen.
    """
    slanted = [(index, seg) for index, seg in enumerate(segments) if _leans(seg)]
    heading = {index: _heading(seg) for index, seg in slanted}

    degree = defaultdict(list)
    for index, (a, b) in slanted:
        for end in (a, b):
            cell = (round(end[0] / APEX_TOL_PT), round(end[1] / APEX_TOL_PT))
            degree[cell].append(index)

    apexes, consumed = [], set()
    for cell, members in degree.items():
        if len(members) < 2:
            continue
        # An arrowhead's barbs form a narrow V -- 25 degrees apart on the
        # Southern Integrity sheet. Slanted strokes also meet at the vertices
        # of the hexagonal bathroom tile on the LayOut sheets, but at 60, so
        # the spread separates a terminator from a pattern.
        spread = max(_between(heading[i], heading[j])
                     for i in members for j in members)
        if spread > APEX_MAX_SPREAD_DEG:
            continue
        apexes.append((cell[0] * APEX_TOL_PT, cell[1] * APEX_TOL_PT))
        consumed.update(members)

    ticks = [((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)
             for index, (a, b) in slanted if index not in consumed]
    return apexes + ticks


def chains(points, horizontal):
    """Group terminators onto the dimension lines they share.

    A horizontal chain is a set of stations sharing a y, a vertical one an x.
    Each is returned sorted along its own direction, so consecutive pairs are
    the spans.
    """
    across = (lambda p: p[1]) if horizontal else (lambda p: p[0])
    along = (lambda p: p[0]) if horizontal else (lambda p: p[1])

    groups = []
    for point in sorted(points, key=across):
        if groups and across(point) - across(groups[-1][-1]) <= CHAIN_TOL_PT:
            groups[-1].append(point)
        else:
            groups.append([point])

    out = []
    for group in groups:
        # Stations closer together than a terminator is long are one station
        # counted twice -- an arrow apex that also caught a stray tick.
        ordered, last = [], None
        for point in sorted(group, key=along):
            if last is None or along(point) - last > MAX_TERMINATOR_PT / 2:
                ordered.append(point)
                last = along(point)
        if len(ordered) >= 2:
            out.append(ordered)
    return out


def strings(page, clip):
    """Parsable dimension texts, with their centre and which way they read."""
    found = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            spans = [s for s in line["spans"] if s["text"].strip()]
            if not spans:
                continue
            # Reassembled, not read span by span: LayOut letter-spaces its
            # text, so 24'-0" arrives as six separate spans.
            text = " ".join("".join(s["text"] for s in spans).split())
            value = parse_value(text)
            if value is None:
                continue
            x0, y0, x1, y1 = line["bbox"]
            centre = ((x0 + x1) / 2.0, (y0 + y1) / 2.0)
            if not _inside(clip, *centre):
                continue
            direction = line.get("dir", (1.0, 0.0))
            found.append({
                "text": text,
                "value_in": value,
                "centre": centre,
                "horizontal": abs(direction[0]) > abs(direction[1]),
            })
    return found


def _align(chain, texts, horizontal, scale):
    """Match a chain's texts to its stations, letting the values choose.

    Two earlier shapes failed. Nearest-span matching let each text pick a span
    independently, so one bad choice stole a span from its owner and the error
    walked down the chain -- 7'-8" came back reading 175.83". Zipping texts to
    spans in order fixed that but refused any chain whose counts disagreed, and
    measured across four houses the counts ALWAYS disagree the same way: more
    spans than texts, never fewer. The stations are noisy, the strings are not.

    So the strings pick the stations. A chain of M stations and N texts is an
    alignment: choose N+1 stations, in order, whose N gaps reproduce the N
    printed values. A spurious station is simply never chosen, because the span
    it would make matches nothing the drafter wrote. This is the checksum a
    dimension chain has always carried -- the parts sum to the whole -- used to
    find the parts rather than merely to confirm them afterwards.
    """
    along = (lambda p: p[0]) if horizontal else (lambda p: p[1])
    stations = sorted(chain, key=along)
    if len(texts) < 1 or len(stations) < len(texts) + 1:
        return []

    inf = float("inf")
    # best[k][j]: least cost having considered k texts, sitting at station j.
    # back[k][j]: (previous station, matched?) -- a text may also be SKIPPED.
    #
    # Skipping matters more than it looks. Without it the alignment was all or
    # nothing: one string it could not place left best[N][*] infinite and the
    # whole chain returned empty, taking every good dimension on it down too.
    # That was fourteen of Marilyn's fifteen misses -- not bad measurements,
    # just good ones sharing a chain with a bad one.
    best = [[inf] * len(stations) for _ in range(len(texts) + 1)]
    back = [[None] * len(stations) for _ in range(len(texts) + 1)]
    for j in range(len(stations)):
        best[0][j] = 0.0

    for k, text in enumerate(texts, start=1):
        for j in range(len(stations)):
            # Skip this text and stay put.
            if best[k - 1][j] != inf:
                best[k][j] = best[k - 1][j] + SKIP_PENALTY_IN
                back[k][j] = (j, False)
            # Or match it, arriving at j from some earlier station i.
            for i in range(j):
                if best[k - 1][i] == inf:
                    continue
                measured = (along(stations[j]) - along(stations[i])) * scale
                if measured < MIN_SPAN_PT * scale:
                    continue
                error = abs(measured - text["value_in"])
                if error > ALIGN_TOL_IN:
                    continue
                total = best[k - 1][i] + error
                if total < best[k][j]:
                    best[k][j] = total
                    back[k][j] = (i, True)

    end = min(range(len(stations)), key=lambda j: best[len(texts)][j])
    if best[len(texts)][end] == inf:
        return []

    picked, j = [], end
    for k in range(len(texts), 0, -1):
        previous, matched = back[k][j]
        picked.append((previous, j) if matched else None)
        j = previous
    picked.reverse()

    out = []
    for span, text in zip(picked, texts):
        if span is None:
            continue
        one, two = stations[span[0]], stations[span[1]]
        measured = (along(two) - along(one)) * scale
        out.append({
            "text": text["text"],
            "printed_in": text["value_in"],
            "measured_in": measured,
            "error_in": measured - text["value_in"],
            "p1": one,
            "p2": two,
            "horizontal": horizontal,
        })
    return out


def read(page, clip, scale):
    """Every dimension in `clip`: what it says, and what its span measures.

    `scale` converts PDF points to real inches -- 2/3 at 1/4" = 1'-0". Each
    record carries both numbers and their difference, because they are not
    always equal: in the DXF a printed 2'-0" measures 23.5".
    """
    points = terminators(short_segments(page, clip))
    texts = strings(page, clip)

    # Every chain, in both directions, before any text is assigned: a drafter
    # stacks chains -- the overall 24'-0" sits 13.7pt above the 8'/6'/10' that
    # subdivides it -- so a text has to go to its NEAREST chain and not to
    # every chain whose band it happens to fall in. Claiming it twice left the
    # subdividing chain with four texts for three spans, and the whole chain
    # was then refused for not lining up.
    found = []
    for horizontal in (True, False):
        along = (lambda p: p[0]) if horizontal else (lambda p: p[1])
        across = (lambda p: p[1]) if horizontal else (lambda p: p[0])
        for chain in chains(points, horizontal):
            found.append((horizontal, chain,
                          sum(across(p) for p in chain) / len(chain),
                          along, across))

    claimed = defaultdict(list)
    for text in texts:
        best, best_gap = None, None
        for index, (horizontal, chain, line, along, across) in enumerate(found):
            if horizontal != text["horizontal"]:
                continue
            centre = text["centre"]
            if not along(chain[0]) <= along(centre) <= along(chain[-1]):
                continue
            gap = abs(across(centre) - line)
            if gap > TEXT_BAND_PT:
                continue
            if best_gap is None or gap < best_gap:
                best, best_gap = index, gap
        if best is not None:
            claimed[best].append(text)

    out = []
    for index, (horizontal, chain, line, along, across) in enumerate(found):
        mine = sorted(claimed.get(index, []), key=lambda t: along(t["centre"]))
        out.extend(_align(chain, mine, horizontal, scale))
    return sorted(out, key=lambda d: (not d["horizontal"], d["p1"]))


def _report(pdf, page_no, clip, scale):
    document = pymupdf.open(pdf)
    page = document[page_no - 1]
    box = pymupdf.Rect(*clip) if clip else page.rect
    found = read(page, box, scale)
    total = len(strings(page, box))

    for record in found:
        error = record["error_in"]
        mark = "   " if abs(error) <= 0.5 else ("  ~" if abs(error) <= 2 else " XX")
        print(f"{mark} {record['text']:>12s}  printed {record['printed_in']:8.3f}\""
              f"  measured {record['measured_in']:8.3f}\"  off {error:+7.3f}\"")

    if not found:
        print("no dimensions read -- check --clip and --scale")
        return
    errors = sorted(abs(r["error_in"]) for r in found)
    close = sum(1 for e in errors if e <= 0.5)
    print(f"\n  {len(found)}/{total} strings matched to a span")
    print(f"  median {errors[len(errors) // 2]:.3f}\"  "
          f"p90 {errors[max(0, int(0.9 * len(errors)) - 1)]:.3f}\"  "
          f"max {errors[-1]:.3f}\"")
    print(f"  within 0.5\": {close}/{len(errors)} ({100 * close / len(errors):.0f}%)")


def main():
    import argparse

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pdf")
    parser.add_argument("--page", type=int, default=1, help="1-indexed")
    parser.add_argument("--clip", nargs=4, type=float, default=None,
                        metavar=("X0", "Y0", "X1", "Y1"),
                        help="drawing region in PDF points; default whole page")
    parser.add_argument("--scale", type=float, default=2 / 3,
                        help="real inches per PDF point; 2/3 at 1/4\" = 1'-0\"")
    args = parser.parse_args()
    _report(args.pdf, args.page, args.clip, args.scale)


if __name__ == "__main__":
    main()
