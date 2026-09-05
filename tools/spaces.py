"""Rooms as the complement of the walls, which is now simply true.

rooms.py -- the lattice tracer's room finder -- opens by explaining why you
cannot flood fill a floor plan: "a DOOR is a real gap in the wall, so the fill
leaks through every doorway and merges the house into one blob". That was
correct about the geometry it had. It is not correct about the box tracer's.

A box wall is CONTINUOUS. combine() bridges it over its own openings, because
architect3d wants one wall carrying its windows and doors as placed items
rather than a wall chopped up at every hole. So the union of the boxes has no
gaps at the doors, the fill cannot leak, and the rooms are just the connected
regions left over. The whole apparatus rooms.py needed -- a canonical grid, a
per-edge coverage fraction, a threshold for how much of an edge has to be drawn
on -- exists only to work around a leak that no longer happens.

## What comes out

Every enclosed region, with its area and the labels sitting inside it. Closets
and pantries are rooms here: they are enclosed, they have a floor, and calling
a 19 sqft pantry "not a room" was a threshold rooms.py needed because its
regions were unreliable. The area is reported and left to the caller.

The outside is a region too, and is identified rather than assumed: it is the
one touching the edge of the clip.

    python tools/spaces.py           # -> data/spaces.png
"""

import argparse
import os
import sys
from collections import deque

import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import layers  # noqa: E402
import opening_truth  # noqa: E402
import walls  # noqa: E402

DEFAULT_PDF = "plans/25-025 Jo and Zach Kitchen Kitchen.pdf"
DEFAULT_CLIP = (1500, 380, 2440, 980)
# Grid step for the fill, in real inches. Fine enough to keep a 3in wall solid,
# coarse enough that a whole house is a few hundred thousand cells.
CELL_IN = 1.5
# A region smaller than this is a gap between two walls drawn close together,
# not a space anyone stands in.
MIN_AREA_SQFT = 4.0

PALETTE = [(0.20, 0.55, 0.90), (0.95, 0.55, 0.15), (0.30, 0.72, 0.35),
           (0.85, 0.30, 0.55), (0.55, 0.40, 0.85), (0.90, 0.75, 0.15),
           (0.20, 0.70, 0.70), (0.80, 0.35, 0.25)]


def paint(boxes, bounds, openings=()):
    """A grid with every wall box burned into it, openings included.

    A door is still a wall PLANE for the purpose of enclosing a room -- you do
    not stop being in the kitchen because the doorway is open. So the openings
    are painted as barriers too, and they have to be: combine() bridges a wall
    over an opening only where a jamb stub survives on the wall's own line, and
    across a 5ft picture window the wall face is simply absent, the frame being
    drawn on another line. Four gaps were left on this plan, and the two widest
    -- a 64in window in the top wall, a 33in door in the right one -- let the
    fill escape and took the kitchen and the great room outside with it.
    """
    x0, y0, x1, y1 = bounds
    wide = int((x1 - x0) / CELL_IN) + 2
    high = int((y1 - y0) / CELL_IN) + 2
    grid = bytearray(wide * high)
    for box in list(boxes) + [dict(o, drawn_lo=o["lo"], drawn_hi=o["hi"])
                              for o in openings]:
        half = box["thickness"] / 2.0
        if box["horizontal"]:
            lo, hi = box["drawn_lo"], box["drawn_hi"]
            near, far = box["centre"] - half, box["centre"] + half
        else:
            near, far = box["drawn_lo"], box["drawn_hi"]
            lo, hi = box["centre"] - half, box["centre"] + half
        for row in range(max(0, int((near - y0) / CELL_IN)),
                         min(high, int((far - y0) / CELL_IN) + 1)):
            base = row * wide
            for column in range(max(0, int((lo - x0) / CELL_IN)),
                                min(wide, int((hi - x0) / CELL_IN) + 1)):
                grid[base + column] = 1
    return grid, wide, high


def regions(grid, wide, high):
    """Connected runs of unpainted cells, flood filled."""
    label = [0] * (wide * high)
    found = []
    for start in range(wide * high):
        if grid[start] or label[start]:
            continue
        index = len(found) + 1
        queue = deque([start])
        label[start] = index
        cells = 0
        touches_edge = False
        while queue:
            cell = queue.popleft()
            cells += 1
            column, row = cell % wide, cell // wide
            if column in (0, wide - 1) or row in (0, high - 1):
                touches_edge = True
            for nc, nr in ((column - 1, row), (column + 1, row),
                           (column, row - 1), (column, row + 1)):
                if not (0 <= nc < wide and 0 <= nr < high):
                    continue
                other = nr * wide + nc
                if grid[other] or label[other]:
                    continue
                label[other] = index
                queue.append(other)
        found.append({"index": index, "cells": cells, "outside": touches_edge,
                      "area_sqft": cells * CELL_IN * CELL_IN / 144.0})
    return label, found


def name_them(found, label, wide, bounds, texts):
    """Attach any text label that falls inside a region."""
    x0, y0, _, _ = bounds
    for region in found:
        region["labels"] = []
    by_index = {r["index"]: r for r in found}
    for text, x, y in texts:
        column = int((x - x0) / CELL_IN)
        row = int((y - y0) / CELL_IN)
        cell = row * wide + column
        if 0 <= cell < len(label) and label[cell]:
            region = by_index.get(label[cell])
            if region is not None and not region["outside"]:
                region["labels"].append(text)
    return found


def read_labels(page, clip, scale):
    """Short upright text inside the plan -- room names, most of the time."""
    out = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            spans = [s for s in line["spans"] if s["text"].strip()]
            if not spans:
                continue
            text = " ".join("".join(s["text"] for s in spans).split())
            if not text or len(text) > 24 or any(c.isdigit() for c in text):
                continue
            x0, y0, x1, y1 = line["bbox"]
            out.append((text, (x0 + x1) / 2.0 * scale, (y0 + y1) / 2.0 * scale))
    return out


def detect(page, clip, scale, layer=None):
    horizontal, vertical, _ = layers.structure(page, clip, scale, layer)
    traced = walls.trace(horizontal, vertical)
    if not traced["boxes"]:
        raise SystemExit("no walls traced")
    found = opening_truth.merge(
        opening_truth.find_by_symbol(traced, page, clip, scale, layer),
        opening_truth.label(opening_truth.find(traced), page, clip, scale))
    bounds = (clip.x0 * scale, clip.y0 * scale, clip.x1 * scale, clip.y1 * scale)
    grid, wide, high = paint(traced["boxes"], bounds, found)
    label, found = regions(grid, wide, high)
    found = name_them(found, label, wide, bounds,
                      read_labels(page, clip, scale))
    inside = [r for r in found
              if not r["outside"] and r["area_sqft"] >= MIN_AREA_SQFT]
    return traced, label, wide, high, bounds, sorted(
        inside, key=lambda r: -r["area_sqft"])


def render(pdf, page_no, clip_box, scale, out, layer=None, dpi=110):
    page = pymupdf.open(pdf)[page_no - 1]
    clip = pymupdf.Rect(*clip_box)
    traced, label, wide, high, bounds, rooms = detect(page, clip, scale, layer)

    pixmap = page.get_pixmap(dpi=150, clip=clip)
    sheet = pymupdf.open()
    canvas = sheet.new_page(width=pixmap.width, height=pixmap.height)
    canvas.insert_image(pymupdf.Rect(0, 0, pixmap.width, pixmap.height),
                        pixmap=pixmap)
    per_inch = pixmap.width / (clip.width * scale)
    x0, y0 = bounds[0], bounds[1]
    keep = {r["index"]: n for n, r in enumerate(rooms)}

    for row in range(high):
        run_start, run_index = None, 0
        for column in range(wide + 1):
            here = label[row * wide + column] if column < wide else 0
            here = here if here in keep else 0
            if here != run_index:
                if run_index:
                    canvas.draw_rect(
                        pymupdf.Rect((x0 + run_start * CELL_IN - x0) * per_inch,
                                     (y0 + row * CELL_IN - y0) * per_inch,
                                     (x0 + column * CELL_IN - x0) * per_inch,
                                     (y0 + (row + 1) * CELL_IN - y0) * per_inch),
                        color=None, fill=PALETTE[keep[run_index] % len(PALETTE)],
                        fill_opacity=0.30, width=0)
                run_start, run_index = column, here
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    canvas.get_pixmap(dpi=dpi).save(out)

    print(f"{len(rooms)} enclosed spaces from {len(traced['boxes'])} wall boxes")
    for room in rooms:
        names = ", ".join(room["labels"]) if room["labels"] else "-"
        print(f"   {room['area_sqft']:7.1f} sqft   {names}")
    print(f"  -> {out}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pdf", nargs="?", default=DEFAULT_PDF)
    parser.add_argument("-o", "--out", default="data/spaces.png")
    parser.add_argument("--page", type=int, default=2)
    parser.add_argument("--clip", nargs=4, type=float, default=DEFAULT_CLIP,
                        metavar=("X0", "Y0", "X1", "Y1"))
    parser.add_argument("--scale", type=float, default=2 / 3)
    parser.add_argument("--layer", default=None)
    args = parser.parse_args()
    render(args.pdf, args.page, args.clip, args.scale, args.out,
           layers.parse_key(args.layer) if args.layer else None)


if __name__ == "__main__":
    main()
