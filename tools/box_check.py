"""Draw the traced wall boxes back over the drawing they came from.

The companion to trace_check.py, for the box tracer rather than the lattice one.
Numbers cannot tell you a wall is in the wrong place -- a box list that reads
perfectly well can still be three chunks at the windows of a wall that is
continuous, which is exactly what happened and what one look showed instantly.

    python tools/box_check.py            # -> data/box_check.png

  blue    the face lines, after snapping and welding
  red     the wall boxes built from them, drawn at their real thickness
"""

import argparse
import os
import sys

import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import layers  # noqa: E402
import walls  # noqa: E402

DEFAULT_PDF = "plans/25-025 Jo and Zach Kitchen Kitchen.pdf"
DEFAULT_CLIP = (1500, 380, 2440, 980)


def render(pdf, page_no, clip_box, scale, out, dpi=150, layer=None):
    page = pymupdf.open(pdf)[page_no - 1]
    clip = pymupdf.Rect(*clip_box)
    # From the structure LAYER, not from every black line on the sheet. The
    # counter, the window frame and the cabinet runs are drawn with other pens
    # and simply are not in here to be mistaken for walls.
    horizontal, vertical, key = layers.structure(page, clip, scale, layer)
    print(f"structure layer: {key[0] or 'no stroke'} w={key[1]:g}"
          + (f" fill {key[2]}" if key[2] else ""))
    traced = walls.trace(horizontal, vertical)

    pixmap = page.get_pixmap(dpi=dpi, clip=clip)
    sheet = pymupdf.open()
    canvas = sheet.new_page(width=pixmap.width, height=pixmap.height)
    canvas.insert_image(pymupdf.Rect(0, 0, pixmap.width, pixmap.height),
                        pixmap=pixmap)

    per_point = dpi / 72.0

    def px(inches):
        return (inches / scale - clip.x0) * per_point

    def py(inches):
        return (inches / scale - clip.y0) * per_point

    for coord, lo, hi in traced["faces"][0]:
        canvas.draw_line(pymupdf.Point(px(lo), py(coord)),
                         pymupdf.Point(px(hi), py(coord)),
                         color=(0, 0, 1), width=0.6)
    for coord, lo, hi in traced["faces"][1]:
        canvas.draw_line(pymupdf.Point(px(coord), py(lo)),
                         pymupdf.Point(px(coord), py(hi)),
                         color=(0, 0, 1), width=0.6)

    for box in traced["boxes"]:
        half = box["thickness"] / 2.0
        # The drawn run, which close_corners() has already carried out to the
        # centreline of whatever each end meets. NOT lo..hi: that includes the
        # overshoot, which exists to make crossings detectable and is a device
        # rather than wall -- drawing it hangs every wall a full thickness past
        # its corner.
        if box["horizontal"]:
            rect = pymupdf.Rect(px(box["drawn_lo"]), py(box["centre"] - half),
                                px(box["drawn_hi"]), py(box["centre"] + half))
        else:
            rect = pymupdf.Rect(px(box["centre"] - half), py(box["drawn_lo"]),
                                px(box["centre"] + half), py(box["drawn_hi"]))
        canvas.draw_rect(rect, color=(1, 0, 0), fill=(1, 0, 0),
                         fill_opacity=0.35, width=0.8)

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    canvas.get_pixmap(dpi=100).save(out)

    length = sum(box["drawn_hi"] - box["drawn_lo"] for box in traced["boxes"])
    faces_found = len(traced["faces"][0]) + len(traced["faces"][1])
    print(f"{faces_found} faces, {len(traced['boxes'])} boxes "
          f"({len(traced['segments'])} pieces after splitting)")
    print(f"  thicknesses in use: "
          + ", ".join(f'{t:g}"' for t in traced["thicknesses"]))
    print(f"  {length / 12:.1f}ft of wall -> {out}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pdf", nargs="?", default=DEFAULT_PDF)
    parser.add_argument("-o", "--out", default="data/box_check.png")
    parser.add_argument("--page", type=int, default=2, help="1-indexed")
    parser.add_argument("--clip", nargs=4, type=float, default=DEFAULT_CLIP,
                        metavar=("X0", "Y0", "X1", "Y1"))
    parser.add_argument("--scale", type=float, default=2 / 3,
                        help="real inches per PDF point")
    parser.add_argument("--layer", default=None,
                        help='structure layer, e.g. "#000000,0.5" or '
                             '"none,0,#646464"; default is the best-ranked')
    args = parser.parse_args()
    render(args.pdf, args.page, args.clip, args.scale, args.out,
           layer=layers.parse_key(args.layer) if args.layer else None)


if __name__ == "__main__":
    main()
