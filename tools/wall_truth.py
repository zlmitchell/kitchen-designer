"""Ground truth for the wall tracer: what is drawn where, checked by a human.

Nothing else in this toolchain can say whether a traced wall is in the right
PLACE. dimensions.py checks measurements against the strings the drafter
printed, which is a real check and a narrow one -- a plan with no dimension
chain gets no score at all, and even a well-dimensioned one says nothing about
the walls between its dimension lines. The only source for "is this wall real
and is it here" is somebody looking at the drawing.

So this keeps a fixture of wall rectangles in real inches, and scores a trace
against it.

## Drawn walls, not continuous ones

The fixture records the wall as DRAWN: solid stretches, broken at every opening.
That is the distinction the drawing itself makes and it took a while to see. A
window is not a continuous wall with a symbol laid over it -- the wall's own
face lines stop at the jamb, and the window FRAME carries on across the gap on
its own pair of lines, standing about an inch proud of the wall face. Measured
on the kitchen plan's north wall:

    y=2.11in  wall faces cover  0.14-6.19, 9.19-18.06, 21.06-28.69, 34.03-38.69
    y=0.00in  frame covers only 5.89-9.47, 17.78-21.36, 28.39-34.31

The gaps in the first line are the windows, and their widths come out at
2'-11", 2'-11" and 5'-3" -- the same three the symbol detector finds by hunting
glazing and swing arcs, to within an inch, and for none of the effort.

Which means the fixture scores two things at once:

    the green stretches   ->  are the walls in the right place
    the gaps between      ->  are the openings in the right place

## Correcting it, not authoring it

`--emit` writes the current trace out as a starting fixture and draws it back
over the plan in green. That is a PROPOSAL, not ground truth -- a fixture made
by the tracer cannot score the tracer. It becomes ground truth once a human has
been through the render and fixed what is wrong, which is a much smaller job
than measuring forty rectangles by hand. Fix the JSON, re-render, look again.

    python tools/wall_truth.py --emit     # proposal -> data/wall_truth.{json,png}
    python tools/wall_truth.py            # score the trace against the fixture
"""

import argparse
import json
import os
import sys

import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import layers  # noqa: E402
import opening_truth  # noqa: E402
import walls  # noqa: E402

DEFAULT_PDF = "plans/25-025 Jo and Zach Kitchen Kitchen.pdf"
DEFAULT_CLIP = (1500, 380, 2440, 980)
FIXTURE = "data/wall_truth.json"
RENDER = "data/wall_truth.png"

# How far a traced wall may sit from its counterpart and still be it.
PLACE_TOL_IN = 3.0
# An opening narrower than a cupboard door is a break in the linework.
MIN_OPENING_IN = 12.0
MAX_OPENING_IN = 96.0
# A face run this short is a jamb mark, not a stretch of wall face.
MAX_JAMB_IN = 14.0


def drawn(traced, openings=None):
    """Each wall line: how far it runs, and which parts of it are solid.

    The openings are SUBTRACTED from the wall's extent rather than derived here
    from gaps in the face coverage. Deriving them worked on the top wall and
    failed on the left and bottom ones, whose chosen face pair happens to run
    unbroken straight through its own windows -- so those walls came back solid
    end to end with every opening in them missing.

    opening_truth already answers this properly, by running the symbol detector
    and the gap reader together, and it gets the exterior walls right. Asking a
    second, weaker derivation of the same question for a second time was only
    ever going to disagree with it. So: this owns where the walls ARE, that
    owns where the holes are, and the drawn wall is the one minus the other.
    """
    lines = {}
    for box in traced["boxes"]:
        key = (box["horizontal"], round(box["centre"] / PLACE_TOL_IN))
        entry = lines.get(key)
        if entry is None:
            lines[key] = {
                "horizontal": box["horizontal"],
                "centre": box["centre"],
                "thickness": box["thickness"],
                "runs": [(box["drawn_lo"], box["drawn_hi"])],
            }
            continue
        entry["runs"].append((box["drawn_lo"], box["drawn_hi"]))
        entry["thickness"] = max(entry["thickness"], box["thickness"])

    out = []
    for entry in lines.values():
        extent = walls._cover([(0, lo, hi) for lo, hi in entry["runs"]])
        mine = sorted(
            (o["lo"], o["hi"]) for o in (openings or [])
            if o["horizontal"] == entry["horizontal"]
            and abs(o["centre"] - entry["centre"]) <= PLACE_TOL_IN)
        solid = _minus(extent, mine)
        out.append({
            "horizontal": entry["horizontal"],
            "centre": round(entry["centre"], 2),
            "thickness": round(entry["thickness"], 2),
            "solid": [[round(lo, 2), round(hi, 2)] for lo, hi in solid],
            "openings": [[round(lo, 2), round(hi, 2)] for lo, hi in mine],
        })
    return sorted(out, key=lambda w: (not w["horizontal"], w["centre"]))


def _minus(spans, holes):
    """What is left of `spans` once `holes` are cut out of them."""
    out = []
    for lo, hi in spans:
        pieces = [(lo, hi)]
        for a, b in holes:
            nxt = []
            for plo, phi in pieces:
                if b <= plo or a >= phi:
                    nxt.append((plo, phi))
                    continue
                if a > plo:
                    nxt.append((plo, a))
                if b < phi:
                    nxt.append((b, phi))
            pieces = nxt
        out.extend(p for p in pieces if p[1] - p[0] > 1.0)
    return out


def _by_line(records):
    """One record per wall LINE, not one per box.

    combine() leaves several boxes sharing a centreline -- a wall bridged over
    its openings, plus whatever fragments beyond them did not merge -- and
    emitting each of them separately put the same wall in the fixture two and
    three times over. A person correcting it would then have to correct it
    twice and could not tell which copy mattered.
    """
    lines = {}
    for record in records:
        key = (record["horizontal"], round(record["centre"] / PLACE_TOL_IN))
        kept = lines.get(key)
        if kept is None:
            lines[key] = dict(record)
            continue
        kept["solid"] = [list(span) for span in
                         walls._cover([(0, lo, hi) for lo, hi
                                       in kept["solid"] + record["solid"]])]
        kept["openings"] = [[a[1], b[0]] for a, b in
                            zip(kept["solid"], kept["solid"][1:])
                            if MIN_OPENING_IN <= b[0] - a[1] <= MAX_OPENING_IN]
        if record["thickness"] > kept["thickness"]:
            kept["thickness"] = record["thickness"]
    for record in lines.values():
        record["solid"] = [[round(lo, 2), round(hi, 2)]
                           for lo, hi in record["solid"]]
        record["openings"] = [[round(lo, 2), round(hi, 2)]
                              for lo, hi in record["openings"]]
    return sorted(lines.values(),
                  key=lambda w: (not w["horizontal"], w["centre"]))


def _matches(one, two):
    return (one["horizontal"] == two["horizontal"]
            and abs(one["centre"] - two["centre"]) <= PLACE_TOL_IN)


def score(fixture, traced, openings=None):
    """Compare a trace against the fixture, by length and by opening."""
    mine = drawn(traced, openings)
    hit = wrong = 0.0
    missed = 0.0
    matched_walls = 0
    for truth in fixture:
        partners = [w for w in mine if _matches(truth, w)]
        matched_walls += 1 if partners else 0
        for lo, hi in truth["solid"]:
            covered = 0.0
            for wall in partners:
                for a, b in wall["solid"]:
                    covered += max(0.0, min(hi, b) - max(lo, a))
            hit += min(covered, hi - lo)
            missed += max(0.0, (hi - lo) - covered)
    for wall in mine:
        partners = [t for t in fixture if _matches(wall, t)]
        for lo, hi in wall["solid"]:
            covered = 0.0
            for truth in partners:
                for a, b in truth["solid"]:
                    covered += max(0.0, min(hi, b) - max(lo, a))
            wrong += max(0.0, (hi - lo) - covered)

    truth_openings = sum(len(t["openings"]) for t in fixture)
    mine_openings = sum(len(w["openings"]) for w in mine)
    found = 0
    for truth in fixture:
        for lo, hi in truth["openings"]:
            centre = (lo + hi) / 2.0
            for wall in mine:
                if not _matches(truth, wall):
                    continue
                if any(a - PLACE_TOL_IN <= centre <= b + PLACE_TOL_IN
                       for a, b in wall["openings"]):
                    found += 1
                    break
    return {
        "walls_in_fixture": len(fixture),
        "walls_traced": len(mine),
        "walls_matched": matched_walls,
        "recall": hit / (hit + missed) if hit + missed else 0.0,
        "precision": hit / (hit + wrong) if hit + wrong else 0.0,
        "missed_ft": missed / 12.0,
        "wrong_ft": wrong / 12.0,
        "openings_in_fixture": truth_openings,
        "openings_traced": mine_openings,
        "openings_found": found,
    }


def render(pdf, page_no, clip_box, scale, fixture, out, dpi=150):
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

    for wall in fixture:
        half = wall["thickness"] / 2.0
        for lo, hi in wall["solid"]:
            if wall["horizontal"]:
                rect = pymupdf.Rect(px(lo), py(wall["centre"] - half),
                                    px(hi), py(wall["centre"] + half))
            else:
                rect = pymupdf.Rect(px(wall["centre"] - half), py(lo),
                                    px(wall["centre"] + half), py(hi))
            canvas.draw_rect(rect, color=(0, 0.6, 0), fill=(0, 0.85, 0),
                             fill_opacity=0.45, width=0.7)

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    canvas.get_pixmap(dpi=100).save(out)


def load(pdf, page_no, clip_box, scale, layer=None):
    page = pymupdf.open(pdf)[page_no - 1]
    horizontal, vertical, _ = layers.structure(
        page, pymupdf.Rect(*clip_box), scale, layer)
    return walls.trace(horizontal, vertical)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pdf", nargs="?", default=DEFAULT_PDF)
    parser.add_argument("--emit", action="store_true",
                        help="write the current trace out as a starting fixture")
    parser.add_argument("--fixture", default=FIXTURE)
    parser.add_argument("--render", default=RENDER)
    parser.add_argument("--page", type=int, default=2)
    parser.add_argument("--clip", nargs=4, type=float, default=DEFAULT_CLIP,
                        metavar=("X0", "Y0", "X1", "Y1"))
    parser.add_argument("--scale", type=float, default=2 / 3)
    parser.add_argument("--layer", default=None)
    args = parser.parse_args()

    chosen = layers.parse_key(args.layer) if args.layer else None
    traced = load(args.pdf, args.page, args.clip, args.scale, chosen)
    page = pymupdf.open(args.pdf)[args.page - 1]
    clip = pymupdf.Rect(*args.clip)
    found = opening_truth.merge(
        opening_truth.find_by_symbol(traced, page, clip, args.scale, chosen),
        opening_truth.label(opening_truth.find(traced), page, clip, args.scale))

    if args.emit:
        fixture = drawn(traced, found)
        os.makedirs(os.path.dirname(args.fixture) or ".", exist_ok=True)
        with open(args.fixture, "w", newline="\n") as handle:
            json.dump(fixture, handle, indent=1)
        render(args.pdf, args.page, args.clip, args.scale, fixture, args.render)
        solid = sum(hi - lo for w in fixture for lo, hi in w["solid"])
        holes = sum(len(w["openings"]) for w in fixture)
        print(f"proposal: {len(fixture)} walls, {solid / 12:.1f}ft drawn, "
              f"{holes} openings")
        print(f"  -> {args.fixture}  (edit this)")
        print(f"  -> {args.render}  (check this, green is what the fixture says)")
        print("  NOT ground truth until you have corrected it.")
        return

    if not os.path.exists(args.fixture):
        raise SystemExit(f"no fixture at {args.fixture} -- run with --emit first")
    with open(args.fixture) as handle:
        fixture = json.load(handle)

    result = score(fixture, traced, found)
    print(f"walls   {result['walls_matched']}/{result['walls_in_fixture']} matched "
          f"({result['walls_traced']} traced)")
    print(f"  recall    {result['recall'] * 100:5.1f}%   "
          f"({result['missed_ft']:.1f}ft of drawn wall not traced)")
    print(f"  precision {result['precision'] * 100:5.1f}%   "
          f"({result['wrong_ft']:.1f}ft traced where nothing is drawn)")
    print(f"openings {result['openings_found']}/{result['openings_in_fixture']} found "
          f"({result['openings_traced']} traced)")


if __name__ == "__main__":
    main()
