"""Draw a traced design back over the drawing it came from.

The extractor's own output cannot tell you whether it traced the right lines.
This does: it renders the walls in red on top of the underlay PNG, in the
underlay's pixel space, using the same carbon-sheet numbers the app uses to
position it. A wall that sits on the drawing's linework is right; one floating
in a room is a bathtub or a cabinet that got mistaken for structure.

It doubles as a check on the carbon sheet itself. If the red drifts steadily
across the sheet rather than sitting on the black, the alignment is wrong and
the underlay is decorative rather than a straightedge.

    python tools/trace_check.py            # data/design.json -> data/trace_check.png
"""

import argparse
import json
import os

import pymupdf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("design", nargs="?", default="data/design.json")
    ap.add_argument("-o", "--out", default="data/trace_check.png")
    ap.add_argument("--dpi", type=int, default=120)
    args = ap.parse_args()

    document = json.load(open(args.design))
    plan = document["floorplan"]
    sheet, corners = plan["underlay"], plan["corners"]

    underlay = os.path.join(os.path.dirname(args.design) or ".",
                            os.path.basename(sheet["url"]))
    if not os.path.exists(underlay):
        raise SystemExit(f"no underlay at {underlay} -- re-run extract.py")

    # pymupdf draws vectors onto pages, not bitmaps, so the PNG goes through a
    # one-page PDF wrapper. Nothing is rescaled: the page is the image's size.
    image = pymupdf.open(underlay)
    page = pymupdf.open("pdf", image.convert_to_pdf())[0]
    image.close()

    # The page is NOT the PNG at 1:1. convert_to_pdf() lays the image out in
    # points at 72dpi, so a 1959px-wide underlay rendered at 150dpi becomes a
    # 940pt page - while anchorXPx is in image pixels. Mixing the two shifts
    # every wall down and right by about the anchor, which looks exactly like a
    # bad trace and is not one. The app has no such problem: carbonsheet.js
    # scales the anchor by screenPixels/imagePixels itself.
    pixels = pymupdf.Pixmap(underlay)
    to_page = page.rect.width / pixels.width
    px_per_cm_x = page.rect.width / sheet["widthCm"]
    px_per_cm_y = page.rect.height / sheet["heightCm"]
    ax = sheet["anchorXPx"] * to_page
    ay = sheet["anchorYPx"] * to_page

    def at(corner):
        return pymupdf.Point(corner["x"] * px_per_cm_x + ax,
                             corner["y"] * px_per_cm_y + ay)

    shape = page.new_shape()
    for wall in plan["walls"]:
        shape.draw_line(at(corners[wall["corner1"]]), at(corners[wall["corner2"]]))
    shape.finish(color=(1, 0, 0), width=2.0)
    for corner in corners.values():
        shape.draw_circle(at(corner), 2.5)
    shape.finish(color=(0, 0, 1), fill=(0, 0, 1))

    # Openings, so a window on a cabinet run or a door in the wrong wall is as
    # obvious as a mistraced wall is.
    for item in document.get("items", []):
        window = "window" in item["model_url"]
        centre = pymupdf.Point(item["xpos"] * px_per_cm_x + ax,
                               item["zpos"] * px_per_cm_y + ay)
        shape.draw_circle(centre, 7)
        shape.finish(color=(0, 0.55, 0) if window else (1, 0.5, 0),
                     fill=(0, 0.8, 0) if window else (1, 0.65, 0), width=1.5)
    shape.commit()

    page.get_pixmap(dpi=args.dpi).save(args.out)
    openings = document.get("items", [])
    print(f"{len(plan['walls'])} walls, {len(corners)} corners, "
          f"{len(openings)} openings -> {args.out}")


if __name__ == "__main__":
    main()
