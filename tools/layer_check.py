"""Draw each layer of a drawing on its own, so the split can be checked by eye.

rank() in layers.py scores which layer is the structure and it is only a guess
-- the evidence behind its rules is two drafters, which is the sample size that
produced an earlier rule the next drawing demolished. A contact sheet settles
in one look what a score cannot: which pen drew the walls, which drew the
cabinets, and whether anything has been split that should be together.

    python tools/layer_check.py             # -> data/layers.png

Each panel is one (colour, width, fill) layer, drawn alone, captioned with what
it measures. Read them for the shape of the thing, not the ink: the wall layer
looks like a floor plan, the cabinet layer looks like a kitchen, and the
annotation layer looks like a scatter of ticks around the edge.
"""

import argparse
import os
import sys

import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import layers  # noqa: E402

DEFAULT_PDF = "plans/25-025 Jo and Zach Kitchen Kitchen.pdf"
DEFAULT_CLIP = (1500, 380, 2440, 980)
COLUMNS = 3
CAPTION_PT = 26
MIN_SEGMENTS = 20


def draw(page, clip, scale, layer, width_px):
    """One panel: this layer's geometry alone, on white."""
    height_px = int(width_px * clip.height / clip.width)
    sheet = pymupdf.open()
    panel = sheet.new_page(width=width_px, height=height_px + CAPTION_PT)
    per_inch = width_px / (clip.width * scale)

    def px(inches):
        return (inches - clip.x0 * scale) * per_inch

    def py(inches):
        return (inches - clip.y0 * scale) * per_inch + CAPTION_PT

    ink = (0, 0, 0)
    for coord, lo, hi in layer["horizontal"]:
        panel.draw_line(pymupdf.Point(px(lo), py(coord)),
                        pymupdf.Point(px(hi), py(coord)), color=ink, width=0.7)
    for coord, lo, hi in layer["vertical"]:
        panel.draw_line(pymupdf.Point(px(coord), py(lo)),
                        pymupdf.Point(px(coord), py(hi)), color=ink, width=0.7)
    for ax, ay, bx, by in layer["diagonal"]:
        panel.draw_line(pymupdf.Point(px(ax), py(ay)),
                        pymupdf.Point(px(bx), py(by)),
                        color=(0.85, 0.1, 0.1), width=0.7)

    name = (f'{layer["colour"] or "no stroke"}  w={layer["width"]:g}'
            + (f'  fill {layer["fill"]}' if layer["fill"] else ""))
    gap = max(layer["pairs"].items(), key=lambda kv: kv[1])[0] if layer["pairs"] else None
    detail = (f'{layer["segments"]} segs   {layer["ink_in"] / 12:.0f}ft   '
              f'axis {layer["axis_share"]:.2f}   '
              f'conc {layers.concentration(layer):.2f}'
              + (f'   gap {gap:g}"' if gap else ""))
    panel.insert_text(pymupdf.Point(6, 11), name, fontsize=8.5)
    panel.insert_text(pymupdf.Point(6, 22), detail, fontsize=7.5,
                      color=(0.35, 0.35, 0.35))
    panel.draw_rect(pymupdf.Rect(0.5, 0.5, width_px - 0.5,
                                 height_px + CAPTION_PT - 0.5),
                    color=(0.75, 0.75, 0.75), width=0.8)
    return sheet, panel.rect


def render(pdf, page_no, clip_box, scale, out, width_px=460):
    page = pymupdf.open(pdf)[page_no - 1]
    clip = pymupdf.Rect(*clip_box)
    found = layers.split(page, clip, scale)
    area = (clip.width * scale) * (clip.height * scale)
    ordered = [s for s in layers.rank(found, area)
               if s["layer"]["segments"] >= MIN_SEGMENTS]

    if not ordered:
        raise SystemExit("no layers with enough geometry -- check --clip")

    panels = [draw(page, clip, scale, s["layer"], width_px) for s in ordered]
    panel_w, panel_h = panels[0][1].width, panels[0][1].height
    rows = (len(panels) + COLUMNS - 1) // COLUMNS

    sheet = pymupdf.open()
    contact = sheet.new_page(width=panel_w * COLUMNS, height=panel_h * rows)
    for index, (single, rect) in enumerate(panels):
        column, row = index % COLUMNS, index // COLUMNS
        target = pymupdf.Rect(column * panel_w, row * panel_h,
                              (column + 1) * panel_w, (row + 1) * panel_h)
        contact.show_pdf_page(target, single, 0)

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    contact.get_pixmap(dpi=110).save(out)

    print(f"{len(found)} layers, {len(ordered)} with >= {MIN_SEGMENTS} segments")
    print(f'{"colour":9s} {"w":>5s} {"fill":9s} {"segs":>6s} {"ink ft":>8s} '
          f'{"axis":>5s} {"conc":>5s} {"gap":>6s}  structure')
    for s in ordered:
        layer, key = s["layer"], s["key"]
        print(f'{str(key[0] or "-"):9s} {key[1]:5.2f} {str(key[2] or "-"):9s} '
              f'{layer["segments"]:6d} {layer["ink_in"] / 12:8.1f} '
              f'{layer["axis_share"]:5.2f} {s["concentration"]:5.2f} '
              f'{(str(s["modal_gap"]) + chr(34)) if s["modal_gap"] else "-":>6s}  '
              f'{s["structure"]:7.2f}')
    print(f"  -> {out}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pdf", nargs="?", default=DEFAULT_PDF)
    parser.add_argument("-o", "--out", default="data/layers.png")
    parser.add_argument("--page", type=int, default=2)
    parser.add_argument("--clip", nargs=4, type=float, default=DEFAULT_CLIP,
                        metavar=("X0", "Y0", "X1", "Y1"))
    parser.add_argument("--scale", type=float, default=2 / 3)
    args = parser.parse_args()
    render(args.pdf, args.page, args.clip, args.scale, args.out)


if __name__ == "__main__":
    main()
