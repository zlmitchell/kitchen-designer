"""Ground truth for windows and doors: where the wall stops, and what fills it.

A second layer beside wall_truth.py, deliberately separate. Walls and openings
fail in different ways and want different eyes on them -- a wall can be in the
right place with every opening in it missed, and an opening can be found exactly
where its wall is two inches off. Scoring them together hides both.

## Where an opening comes from

Not from hunting symbols. The wall's own face lines STOP at each jamb, and the
gap between them is the opening -- measured on this plan the gaps reproduce the
symbol detector's thirteen openings at the same places and the same widths, to
within an inch, with no glazing detection, no swing-arc fitting and no jamb
bracketing. See walls.py for how the box spans the gap so the wall stays
continuous while the faces still record where it stopped.

The symbol pen is still wanted, but only to say WHAT is in an opening already
located, which is a far easier question than finding one:

    window   glazing runs jamb to jamb, one piece, on the wall's centreline
    door     a swing arc off to one side, or two overlapping bypass leaves
    cased    nothing drawn in it at all

## Correcting it, not authoring it

`--emit` writes what the tracer currently believes and draws it over the plan.
That is a PROPOSAL: a fixture made by the tracer cannot score the tracer. Fix
the JSON, re-render, look again. Openings are cheap to check by eye because a
wrong one is either in a wall that has no hole or missing from a hole that is
plainly there.

    python tools/opening_truth.py --emit   # -> data/opening_truth.{json,png}
    python tools/opening_truth.py          # score the trace against the fixture
"""

import argparse
import json
import os
import sys

import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import extract  # noqa: E402
import walls  # noqa: E402

DEFAULT_PDF = "plans/25-025 Jo and Zach Kitchen Kitchen.pdf"
DEFAULT_CLIP = (1500, 380, 2440, 980)
FIXTURE = "data/opening_truth.json"
RENDER = "data/opening_truth.png"

# Narrower than this is a break in the linework; wider is a room, not a hole.
MIN_OPENING_IN = 12.0
MAX_OPENING_IN = 96.0
# How far an opening may sit from its counterpart and still be the same one.
PLACE_TOL_IN = 6.0

COLOUR = {
    "window": (0.10, 0.35, 0.95),
    "door": (0.85, 0.10, 0.70),
    "cased": (0.95, 0.60, 0.05),
    "unknown": (0.45, 0.45, 0.45),
}


def find(traced):
    """Every gap in a wall's own face coverage, along the wall it belongs to."""
    out = []
    for box in traced["boxes"]:
        runs = traced["faces"][0 if box["horizontal"] else 1]
        # ONLY the pair this box was built from. Every other line in the band
        # -- the window frame above all, which spans exactly the opening --
        # fills the gap that marks it.
        mine = [(lo, hi) for coord, lo, hi in runs
                if abs(coord - box["near"]) < 1e-6 or abs(coord - box["far"]) < 1e-6]
        if not mine:
            continue
        clipped = [(max(lo, box["drawn_lo"]), min(hi, box["drawn_hi"]))
                   for lo, hi in mine]
        cover = walls._cover([(0, lo, hi) for lo, hi in clipped if hi > lo])
        for one, two in zip(cover, cover[1:]):
            width = two[0] - one[1]
            if not MIN_OPENING_IN <= width <= MAX_OPENING_IN:
                continue
            out.append({
                "kind": "unknown",
                "horizontal": box["horizontal"],
                "centre": round(box["centre"], 2),
                "thickness": round(box["thickness"], 2),
                "lo": round(one[1], 2),
                "hi": round(two[0], 2),
                "width_in": round(width, 2),
            })
    return sorted(out, key=lambda o: (not o["horizontal"], o["centre"], o["lo"]))


def label(openings, page, clip, scale):
    """Ask the symbol pen what is in each opening. Guesses, never invented.

    Only the classification is taken from symbols -- the opening was already
    located by the linework, so a symbol that cannot be read costs a label and
    not a window.
    """
    symbol_h, symbol_v = extract.segments(page, clip, scale,
                                          colour=extract.SYMBOLS)
    swings = extract.swing_boxes(
        extract.diagonals(page, clip, scale, colour=extract.SYMBOLS))
    for opening in openings:
        along = (opening["lo"], opening["hi"])
        centre = opening["centre"]
        near = [s for s in swings
                if _within(s, along, centre, opening["horizontal"])]
        if near:
            opening["kind"] = "door"
            continue
        runs = symbol_h if opening["horizontal"] else symbol_v
        glazing = sum(min(hi, along[1]) - max(lo, along[0])
                      for coord, lo, hi in runs
                      if abs(coord - centre) <= opening["thickness"]
                      and hi > along[0] and lo < along[1])
        span = along[1] - along[0]
        if span > 0 and glazing / span >= 0.6:
            opening["kind"] = "window"
        elif glazing <= 1.0:
            opening["kind"] = "cased"
    return openings


def _within(swing, along, centre, horizontal):
    x0, y0, x1, y1 = swing[:4] if len(swing) >= 4 else (0, 0, 0, 0)
    lo, hi = (x0, x1) if horizontal else (y0, y1)
    across = (y0 + y1) / 2.0 if horizontal else (x0 + x1) / 2.0
    return (hi > along[0] - PLACE_TOL_IN and lo < along[1] + PLACE_TOL_IN
            and abs(across - centre) <= 60.0)


def score(fixture, found):
    """Match by wall line and overlap; report what is missed and invented."""
    used, hits = set(), []
    for truth in fixture:
        best, best_gap = None, None
        for index, mine in enumerate(found):
            if index in used or mine["horizontal"] != truth["horizontal"]:
                continue
            if abs(mine["centre"] - truth["centre"]) > PLACE_TOL_IN:
                continue
            overlap = (min(mine["hi"], truth["hi"])
                       - max(mine["lo"], truth["lo"]))
            if overlap <= 0:
                continue
            gap = abs(mine["width_in"] - truth["width_in"])
            if best_gap is None or gap < best_gap:
                best, best_gap = index, gap
        if best is not None:
            used.add(best)
            hits.append((truth, found[best]))
    right_kind = sum(1 for t, m in hits if t["kind"] == m["kind"])
    widths = sorted(abs(t["width_in"] - m["width_in"]) for t, m in hits)
    return {
        "in_fixture": len(fixture),
        "traced": len(found),
        "matched": len(hits),
        "missed": len(fixture) - len(hits),
        "invented": len(found) - len(hits),
        "kind_right": right_kind,
        "width_median_in": widths[len(widths) // 2] if widths else None,
        "width_max_in": widths[-1] if widths else None,
    }


def render(pdf, page_no, clip_box, scale, openings, out, dpi=150):
    page = pymupdf.open(pdf)[page_no - 1]
    clip = pymupdf.Rect(*clip_box)
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

    for opening in openings:
        half = max(opening["thickness"], 5.0) / 2.0 + 1.5
        colour = COLOUR.get(opening["kind"], COLOUR["unknown"])
        if opening["horizontal"]:
            rect = pymupdf.Rect(px(opening["lo"]), py(opening["centre"] - half),
                                px(opening["hi"]), py(opening["centre"] + half))
        else:
            rect = pymupdf.Rect(px(opening["centre"] - half), py(opening["lo"]),
                                px(opening["centre"] + half), py(opening["hi"]))
        canvas.draw_rect(rect, color=colour, fill=colour, fill_opacity=0.55,
                         width=1.0)

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    canvas.get_pixmap(dpi=100).save(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pdf", nargs="?", default=DEFAULT_PDF)
    parser.add_argument("--emit", action="store_true")
    parser.add_argument("--fixture", default=FIXTURE)
    parser.add_argument("--render", default=RENDER)
    parser.add_argument("--page", type=int, default=2)
    parser.add_argument("--clip", nargs=4, type=float, default=DEFAULT_CLIP,
                        metavar=("X0", "Y0", "X1", "Y1"))
    parser.add_argument("--scale", type=float, default=2 / 3)
    args = parser.parse_args()

    page = pymupdf.open(args.pdf)[args.page - 1]
    clip = pymupdf.Rect(*args.clip)
    horizontal, vertical = extract.segments(page, clip, args.scale)
    traced = walls.trace(horizontal, vertical)
    found = label(find(traced), page, clip, args.scale)

    if args.emit:
        os.makedirs(os.path.dirname(args.fixture) or ".", exist_ok=True)
        with open(args.fixture, "w", newline="\n") as handle:
            json.dump(found, handle, indent=1)
        render(args.pdf, args.page, args.clip, args.scale, found, args.render)
        kinds = {}
        for opening in found:
            kinds[opening["kind"]] = kinds.get(opening["kind"], 0) + 1
        summary = ", ".join(f"{n} {k}" for k, n in sorted(kinds.items()))
        print(f"proposal: {len(found)} openings ({summary or 'none'})")
        print(f"  -> {args.fixture}  (edit this)")
        print(f"  -> {args.render}  (blue window, magenta door, orange cased)")
        print("  NOT ground truth until you have corrected it.")
        return

    if not os.path.exists(args.fixture):
        raise SystemExit(f"no fixture at {args.fixture} -- run with --emit first")
    with open(args.fixture) as handle:
        fixture = json.load(handle)
    result = score(fixture, found)
    print(f"openings {result['matched']}/{result['in_fixture']} found "
          f"({result['traced']} traced)")
    print(f"  missed   {result['missed']}")
    print(f"  invented {result['invented']}")
    if result["width_median_in"] is not None:
        print(f"  width    median {result['width_median_in']:.2f}\"  "
              f"max {result['width_max_in']:.2f}\"")
    print(f"  kind     {result['kind_right']}/{result['matched']} labelled right")


if __name__ == "__main__":
    main()
