"""Draw one small house three times: as a PDF, an SVG and a DXF.

`plans/` is gitignored and stays that way - it is our house, with our address
on it - so nothing in there can be a test fixture. This writes a synthetic
plan instead, small enough to reason about and drawn the way a real sheet is
drawn: walls as PAIRS OF FACES on an architecture pen, openings as breaks in
those faces with jambs, glazing and swing arcs on a separate symbol pen.

    python tools/fixture_plan.py            # -> app/tests/drawings/plan.*

The point is a drawing where the answer is known by construction, so the JS
tracer and the Python one can be held against each other AND against the truth:

    envelope         20ft x 15ft, walls 6in thick
    partitions       one vertical and two horizontal, all 4in - four rooms
    openings         a 36in window in the top wall, a 32in door in each
                     partition, each with a swing arc

Four rooms rather than three because `layers.rank` refuses a layer with fewer
than 20 segments, and three rooms is 18. A fixture that a rule quietly declines
to look at is worse than no fixture: it fails as "no layer looks like
structure", which is what a bad clip looks like too.

Three formats, one geometry, because the readers have to agree before the
tracer can be blamed for anything. The PDF and SVG are drawn at 1/4in = 1ft,
where one point is 2/3 of a real inch; the DXF is drawn in real inches, which
is what a DXF is for and why it needs no scale to be typed.
"""

import math
import os
import sys

#: Real inches per point at 1/4in = 1ft, the scale the flat drawings are at.
QUARTER_SCALE = 2 / 3
#: Where the plan's origin sits on the page, in points.
MARGIN = 20.0

BLACK = (0.0, 0.0, 0.0)
#: `extract.SYMBOLS` is any grey with equal channels strictly between 0.15 and
#: 0.85, which is how the symbol pen is told from the architecture pen.
GREY = (0.5, 0.5, 0.5)

WALL_PEN = 0.5
SYMBOL_PEN = 0.35

WIDTH_IN = 240.0
HEIGHT_IN = 180.0
EXTERIOR = 6.0
PARTITION = 4.0

#: The vertical partition's two faces, and the horizontal partitions'.
V_NEAR, V_FAR = 118.0, 122.0
H_NEAR, H_FAR = 98.0, 102.0

WINDOW = (60.0, 96.0)      # in the top wall
V_DOOR = (80.0, 112.0)     # in the vertical partition
H_DOOR = (150.0, 182.0)    # in the right-hand horizontal partition
L_DOOR = (40.0, 72.0)      # in the left-hand one


def _minus(span, holes):
    """`span` with `holes` cut out of it, as a list of pieces."""
    pieces = [span]
    for lo, hi in holes:
        out = []
        for a, b in pieces:
            if hi <= a or lo >= b:
                out.append((a, b))
                continue
            if a < lo:
                out.append((a, lo))
            if hi < b:
                out.append((hi, b))
        pieces = out
    return pieces


def architecture():
    """Every wall face, as (x0, y0, x1, y1) in real inches.

    A wall is two faces a construction thickness apart, and an opening is a
    BREAK in both of them - which is the whole structural signal the tracer
    reads. Nothing here draws a wall as a single line or as a filled box.
    """
    lines = []

    # Top wall: both faces broken by the window.
    for y in (0.0, EXTERIOR):
        for a, b in _minus((0.0, WIDTH_IN), [WINDOW]):
            lines.append((a, y, b, y))
    # Bottom wall.
    for y in (HEIGHT_IN - EXTERIOR, HEIGHT_IN):
        lines.append((0.0, y, WIDTH_IN, y))
    # Left and right walls, full height.
    for x in (0.0, EXTERIOR, WIDTH_IN - EXTERIOR, WIDTH_IN):
        lines.append((x, 0.0, x, HEIGHT_IN))

    # The vertical partition, broken by its door.
    for x in (V_NEAR, V_FAR):
        for a, b in _minus((EXTERIOR, HEIGHT_IN - EXTERIOR), [V_DOOR]):
            lines.append((x, a, x, b))
    # The two horizontal partitions, each broken by its door.
    for y in (H_NEAR, H_FAR):
        for a, b in _minus((V_FAR, WIDTH_IN - EXTERIOR), [H_DOOR]):
            lines.append((a, y, b, y))
        for a, b in _minus((EXTERIOR, V_NEAR), [L_DOOR]):
            lines.append((a, y, b, y))
    return lines


def _arc(cx, cy, radius, start, end, chords=8):
    """A quarter arc as the few long chords a drafter's swing is made of.

    `extract.swing_boxes` rejects a cluster of more than SWING_MAX_SEGMENTS,
    because a shaded cabinet run is hundreds of chords in a door-sized box and
    would otherwise read as an enormous door.
    """
    out = []
    for step in range(chords):
        a = start + (end - start) * step / chords
        b = start + (end - start) * (step + 1) / chords
        out.append((cx + radius * math.cos(a), cy + radius * math.sin(a),
                    cx + radius * math.cos(b), cy + radius * math.sin(b)))
    return out


def symbols():
    """Jambs, glazing and swing arcs, as (x0, y0, x1, y1) in real inches.

    A jamb reaches from one FACE of the wall to the other - that span is what
    tells it from a casement operator or a vent drawn inside the wall, and
    `extract.jambs_on` measures it.
    """
    lines = []

    # The window: a jamb at each end, and glazing running the whole opening.
    for x in WINDOW:
        lines.append((x, 0.0, x, EXTERIOR))
    for y in (EXTERIOR * 0.25, EXTERIOR * 0.75):
        lines.append((WINDOW[0], y, WINDOW[1], y))

    # The vertical partition's door: jambs across the wall, and a swing.
    for y in V_DOOR:
        lines.append((V_NEAR, y, V_FAR, y))
    width = V_DOOR[1] - V_DOOR[0]
    lines.extend(_arc(V_FAR, V_DOOR[0], width, math.pi / 2, 0.0))

    # The two horizontal partitions' doors.
    for x in H_DOOR:
        lines.append((x, H_NEAR, x, H_FAR))
    width = H_DOOR[1] - H_DOOR[0]
    lines.extend(_arc(H_DOOR[0], H_FAR, width, 0.0, math.pi / 2))

    for x in L_DOOR:
        lines.append((x, H_NEAR, x, H_FAR))
    width = L_DOOR[1] - L_DOOR[0]
    lines.extend(_arc(L_DOOR[1], H_NEAR, width, math.pi, 1.5 * math.pi))
    return lines


def _page_size():
    return (MARGIN * 2 + WIDTH_IN / QUARTER_SCALE,
            MARGIN * 2 + HEIGHT_IN / QUARTER_SCALE)


def _to_points(value):
    return MARGIN + value / QUARTER_SCALE


def write_pdf(path):
    import pymupdf

    width, height = _page_size()
    document = pymupdf.open()
    page = document.new_page(width=width, height=height)
    for colour, pen, lines in ((BLACK, WALL_PEN, architecture()),
                               (GREY, SYMBOL_PEN, symbols())):
        for x0, y0, x1, y1 in lines:
            page.draw_line(pymupdf.Point(_to_points(x0), _to_points(y0)),
                           pymupdf.Point(_to_points(x1), _to_points(y1)),
                           color=colour, width=pen)
    document.save(path)
    document.close()


def write_svg(path):
    width, height = _page_size()
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:g}" '
           f'height="{height:g}" viewBox="0 0 {width:g} {height:g}">']
    for name, colour, pen, lines in (("walls", "#000000", WALL_PEN, architecture()),
                                     ("symbols", "#808080", SYMBOL_PEN, symbols())):
        out.append(f'<g id="{name}" stroke="{colour}" stroke-width="{pen:g}" fill="none">')
        for x0, y0, x1, y1 in lines:
            out.append(f'  <line x1="{_to_points(x0):.4f}" y1="{_to_points(y0):.4f}" '
                       f'x2="{_to_points(x1):.4f}" y2="{_to_points(y1):.4f}"/>')
        out.append('</g>')
    out.append('</svg>')
    with open(path, "w", newline="\n") as handle:
        handle.write("\n".join(out) + "\n")


def write_dxf(path):
    """The same house in real inches, which is what makes a DXF a DXF.

    Colour and lineweight go on the LAYER, the way CAD does it, so the two pens
    survive into whatever the reader turns them into. `$INSUNITS` 1 is inches,
    and it is the only reason the app can know this drawing's scale without
    being told.
    """
    import ezdxf

    document = ezdxf.new(setup=True)
    document.header["$INSUNITS"] = 1
    # ACI 7 is black-or-white, 8 is dark grey. The symbol pen has to land in
    # `extract.SYMBOLS`'s band once it is a colour, so it is given an explicit
    # true colour rather than an index that a renderer may map anywhere.
    document.layers.add("WALLS", color=7, lineweight=50)
    grey = document.layers.add("SYMBOLS", color=8, lineweight=35)
    grey.rgb = (128, 128, 128)

    modelspace = document.modelspace()
    for layer, lines in (("WALLS", architecture()), ("SYMBOLS", symbols())):
        for x0, y0, x1, y1 in lines:
            # DXF is y-up and a plan is drawn y-down, so the drawing is flipped
            # here rather than in the reader: a DXF that opened upside down
            # would be a fixture that tests the wrong thing.
            modelspace.add_line((x0, HEIGHT_IN - y0), (x1, HEIGHT_IN - y1),
                                dxfattribs={"layer": layer})
    document.saveas(path)


def write_boxes_pdf(path):
    """Three boxes, drawn the three ways a PDF draws one.

    A regression fixture, not a plan. MuPDF reports a rectangle as ONE `re`
    item carrying no segments, so a filled box contributes no wall faces - and
    a reader that misses any spelling of "rectangle" hands the wall tracer four
    face lines per cabinet. Measured on a real sheet: 36 spurious runs forming
    9 boxes, which moved that sheet's structure ranking onto the wrong pen.

        re          the `re` operator; pdf.js expands it to moveTo + 3 lineTo
                    + closePath
        polyline    the same box drawn the long way, five points with the last
                    back on the first
        open        three sides only, which is NOT a box and must stay lines
    """
    import pymupdf

    document = pymupdf.open()
    page = document.new_page(width=200, height=200)
    page.draw_rect(pymupdf.Rect(10, 10, 60, 40), color=BLACK, width=WALL_PEN)
    page.draw_polyline([pymupdf.Point(10, 60), pymupdf.Point(60, 60),
                        pymupdf.Point(60, 90), pymupdf.Point(10, 90),
                        pymupdf.Point(10, 60)], color=BLACK, width=WALL_PEN)
    page.draw_polyline([pymupdf.Point(10, 110), pymupdf.Point(60, 110),
                        pymupdf.Point(60, 140), pymupdf.Point(10, 140)],
                       color=BLACK, width=WALL_PEN)
    document.save(path)
    document.close()


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "app/tests/drawings"
    os.makedirs(out, exist_ok=True)
    write_pdf(os.path.join(out, "plan.pdf"))
    write_svg(os.path.join(out, "plan.svg"))
    write_dxf(os.path.join(out, "plan.dxf"))
    write_boxes_pdf(os.path.join(out, "boxes.pdf"))
    width, height = _page_size()
    print(f"{out}/plan.{{pdf,svg,dxf}}")
    print(f"  page {width:.1f} x {height:.1f}pt, plan {WIDTH_IN:g} x {HEIGHT_IN:g}in "
          f"at 1/4in=1ft (scale {QUARTER_SCALE:.4f})")
    print(f"  clip {MARGIN:g} {MARGIN:g} {_to_points(WIDTH_IN):.0f} {_to_points(HEIGHT_IN):.0f}")
    print(f"  {len(architecture())} wall faces, {len(symbols())} symbol marks")


if __name__ == "__main__":
    main()
