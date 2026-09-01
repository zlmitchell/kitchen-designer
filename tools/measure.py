"""Measure a scaled architectural PDF by reading its vector geometry.

Drawing callouts can be wrong or ambiguous; the linework is what the drafter
actually drew. This reads the linework.

Assumes the sheet is plotted at a stated scale (default 1/4" = 1'-0") on a
72dpi PDF, so one point on the page is (12 / (4 * scale_denom_inches)) real
inches -- 2/3" at quarter scale.

    python tools/measure.py plan.pdf --page 2 --near "Elevation 3"
"""

import argparse
import collections

import pymupdf

QUARTER_SCALE = 2 / 3  # pt -> real inches at 1/4" = 1'-0"


def horizontals(page, clip, k):
    """Horizontal segments inside `clip`, as (y_pt, run_real_inches)."""
    out = []
    for path in page.get_drawings():
        for item in path["items"]:
            if item[0] != "l":
                continue
            a, b = item[1], item[2]
            if abs(a.y - b.y) < 0.4 and clip.contains(a):
                out.append((a.y, abs(a.x - b.x) * k))
    return sorted(out)


def label_bbox(page, text):
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            joined = "".join(s["text"] for s in line["spans"]).strip()
            if joined.startswith(text):
                return line["bbox"]
    raise SystemExit(f"no text starting {text!r} on this page")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--page", type=int, default=2, help="1-indexed")
    ap.add_argument("--near", required=True, help="elevation label to measure under")
    ap.add_argument("--scale", type=float, default=QUARTER_SCALE)
    ap.add_argument("--min-run", type=float, default=20.0)
    args = ap.parse_args()

    page = pymupdf.open(args.pdf)[args.page - 1]
    x0, y0, x1, y1 = label_bbox(page, args.near)
    # Elevations are drawn above their label. Only as tall as one storey plus
    # trim, or the search window swallows whatever is drawn above it.
    clip = pymupdf.Rect(x0 - 260, y0 - 330, x1 + 260, y0 - 5)

    lines = horizontals(page, clip, args.scale)
    if not lines:
        raise SystemExit("no horizontal linework found -- widen the clip")
    floor = max(y for y, _ in lines)

    print(f"{args.near}: heights above the floor line\n")
    seen = collections.Counter()
    for y, run in lines:
        height = round((floor - y) * args.scale, 1)
        if run >= args.min_run and not seen[height]:
            seen[height] += 1
            print(f'  {height:7.1f}"  ({height / 12:5.2f} ft)   run {run:6.1f}"')


if __name__ == "__main__":
    main()
