"""Split a drawing into layers before asking anything else of it.

Every hard bug this tracer has had came from one cause: it looked at the sheet
as a single undifferentiated pile of geometry and tried to tell a wall from a
counter by shape. The drawing already separates them and says so in the pen.

    the window FRAME paired like a wall and plugged all three windows
    the sink COUNTER paired with the half-wall line and made a wall
    a 3in mark inside the wall counted as a jamb and ate a picture window

None of those is a geometry problem. A frame, a counter and a vent are drawn
with different pens from the wall they sit in, and every one of those failures
would have been impossible if the wall layer had been isolated first.

## The key

A layer is (stroke colour, stroke width, fill colour). All three, because no
one of them separates on its own -- proven on two drafters who agree on nothing:

    Southern Integrity   every pen 0.5pt wide, separated ENTIRELY by colour
                         #000000 walls, #804040 plumbing, #4b4b4b cabinets,
                         #6d86a9 elevation markers, #004080 dimensions
    SketchUp LayOut      every pen black, separated ENTIRELY by width
                         0.2 / 0.4 / 0.6 / 0.8 / 1.0 / 1.2 / 1.8

Key on colour alone and LayOut collapses to one layer. Key on width alone and
Southern Integrity does. Key on both and each drafter's convention falls out
without either being named.

Fill belongs in the key too, and is not decoration: Jay Osborne poche-fills his
walls solid #646464, while Southern Integrity leaves walls hollow and fills the
CABINETS. The same "is it filled" question gives opposite answers on the two
sheets, so it has to be observed per drawing rather than assumed.

## What this does and does not do

It splits, measures and describes. It does NOT decide which layer is the wall
layer -- see rank(), which is a first attempt and is meant to be checked
against layer_check.py's renders rather than trusted. Getting the split right
is worth having on its own: even hand-picking a layer by eye from a labelled
list beats the tracer guessing from shape, which is what it does today.
"""

import math
from collections import defaultdict

# Segments shorter than this are noise for measurement purposes -- hatching
# ends, glyph fragments. They stay in the layer, they just do not vote.
MIN_MEASURE_IN = 1.0
# Off-axis by less than this and a segment counts as axis-aligned.
AXIS_TOL = 0.3
# Parallel pair gaps outside this range tell us nothing about wall thickness.
PAIR_MIN_IN = 2.0
PAIR_MAX_IN = 14.0
# Two faces must run alongside each other this far to count as a pair.
PAIR_OVERLAP_IN = 18.0


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


def _hex(colour):
    if colour is None:
        return None
    return "#%02x%02x%02x" % tuple(int(round(c * 255)) for c in colour)


def split(page, clip, scale):
    """Every path in `clip`, grouped by (stroke colour, width, fill colour).

    Geometry comes back in real inches, already sorted into horizontal runs,
    vertical runs, diagonals and curves -- which is what every consumer wants
    and what each of them currently re-derives for itself.
    """
    layers = {}
    for path in page.get_drawings():
        if not _overlaps(clip, path["rect"]):
            continue
        key = (_hex(path.get("color")),
               round(path.get("width") or 0.0, 2),
               _hex(path.get("fill")))
        layer = layers.get(key)
        if layer is None:
            layer = layers[key] = {
                "colour": key[0], "width": key[1], "fill": key[2],
                "horizontal": [], "vertical": [], "diagonal": [],
                "curves": 0, "paths": 0, "rects": [],
            }
        layer["paths"] += 1
        if path.get("fill") is not None:
            rect = path["rect"]
            layer["rects"].append((rect.x0 * scale, rect.y0 * scale,
                                   rect.x1 * scale, rect.y1 * scale))
        for item in path["items"]:
            if item[0] == "c":
                layer["curves"] += 1
                continue
            if item[0] != "l":
                continue
            a, b = item[1], item[2]
            if not (clip.contains(a) and clip.contains(b)):
                continue
            ax, ay, bx, by = (a.x * scale, a.y * scale, b.x * scale, b.y * scale)
            if abs(ay - by) < AXIS_TOL and abs(ax - bx) >= AXIS_TOL:
                layer["horizontal"].append((ay, min(ax, bx), max(ax, bx)))
            elif abs(ax - bx) < AXIS_TOL and abs(ay - by) >= AXIS_TOL:
                layer["vertical"].append((ax, min(ay, by), max(ay, by)))
            elif abs(ax - bx) >= AXIS_TOL or abs(ay - by) >= AXIS_TOL:
                layer["diagonal"].append((ax, ay, bx, by))
    for layer in layers.values():
        describe(layer)
    return layers


def describe(layer):
    """Measure a layer, so it can be judged without being looked at."""
    runs = layer["horizontal"] + layer["vertical"]
    axis_ink = sum(hi - lo for _, lo, hi in runs if hi - lo >= MIN_MEASURE_IN)
    diagonal_ink = sum(math.hypot(bx - ax, by - ay)
                       for ax, ay, bx, by in layer["diagonal"]
                       if math.hypot(bx - ax, by - ay) >= MIN_MEASURE_IN)

    xs = [c for c, _, _ in layer["vertical"]] + \
         [v for _, lo, hi in layer["horizontal"] for v in (lo, hi)]
    ys = [c for c, _, _ in layer["horizontal"]] + \
         [v for _, lo, hi in layer["vertical"] for v in (lo, hi)]

    layer["segments"] = len(runs) + len(layer["diagonal"])
    layer["ink_in"] = axis_ink + diagonal_ink
    layer["axis_share"] = axis_ink / (axis_ink + diagonal_ink) if axis_ink + diagonal_ink else 0.0
    layer["extent"] = ((min(xs), min(ys), max(xs), max(ys))
                       if xs and ys else None)
    layer["pairs"] = pair_gaps(layer)
    return layer


def pair_gaps(layer):
    """Gaps between parallel runs that lie alongside each other, tallied.

    A wall layer piles these up on one or two values -- the thicknesses that
    drafter builds in -- because a wall is two faces a construction thickness
    apart, held over the whole sheet. A cabinet layer scatters them across
    every depth in the kitchen, and an annotation layer produces none at all.
    That difference is what makes a layer's role measurable rather than named.
    """
    tally = defaultdict(float)
    for runs in (layer["horizontal"], layer["vertical"]):
        ordered = sorted(runs)
        for index, (c1, lo1, hi1) in enumerate(ordered):
            for c2, lo2, hi2 in ordered[index + 1:]:
                gap = c2 - c1
                if gap > PAIR_MAX_IN:
                    break
                if gap < PAIR_MIN_IN:
                    continue
                overlap = min(hi1, hi2) - max(lo1, lo2)
                if overlap >= PAIR_OVERLAP_IN:
                    tally[round(gap * 2) / 2] += overlap
    return dict(tally)


def concentration(layer):
    """How much of a layer's pairing sits on its single commonest gap.

    High means one repeated thickness, which is construction. Low means a
    scatter of depths, which is cabinetry and fixtures.
    """
    tally = layer["pairs"]
    if not tally:
        return 0.0
    return max(tally.values()) / sum(tally.values())


def rank(layers, page_area_sqin):
    """A first guess at which layer is which. Check it, do not trust it.

    Deliberately a separate step from split(), and deliberately weak. The
    evidence for these rules is two drafters, which is exactly the sample size
    that produced "colour first, weight second" earlier in this project -- a
    rule the LayOut sheets then demolished. Treat the score as a shortlist for
    a human, not a decision.
    """
    scored = []
    for key, layer in layers.items():
        if layer["segments"] < 20 or not layer["extent"]:
            continue
        x0, y0, x1, y1 = layer["extent"]
        spread = ((x1 - x0) * (y1 - y0)) / page_area_sqin if page_area_sqin else 0.0
        conc = concentration(layer)
        # Structure: axis-aligned, spread across the plan, and pairing up on a
        # repeated thickness. All three, because any two of them also describe
        # a run of kitchen cabinets.
        structure = (layer["axis_share"] * min(spread * 3.0, 1.0)
                     * conc * math.log1p(layer["ink_in"]))
        scored.append({
            "key": key, "layer": layer, "spread": spread,
            "concentration": conc, "structure": structure,
            "modal_gap": (max(layer["pairs"].items(), key=lambda kv: kv[1])[0]
                          if layer["pairs"] else None),
        })
    return sorted(scored, key=lambda s: -s["structure"])
