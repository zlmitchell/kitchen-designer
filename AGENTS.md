# Working on the plan extractor

This covers `tools/` — turning a scaled architectural PDF into an architect3d
design. For the app itself see `README.md`.

**There is now a second implementation of this pipeline**, in JavaScript, at
`app/src/app/import/`. It is what the app's File → Import runs, because a
browser cannot call any of this: PyMuPDF is a C library with no WebAssembly
build. It is a port of `layers.py`, `walls.py`, `opening_truth.py`, `spaces.py`
and `build.py`, constant for constant, and it was verified against them stage by
stage - see ROADMAP.md, "the drawing importer".

**So a change here needs the same change there, and vice versa.** The window
spec is the live example: `extract.window_item` and `design.js`'s `windowItem`
write the same object, and a field added to one is a field the other has to
grow. Two known differences today:

- `opening_truth.find` matches a box's face lines with a tolerance of `1e-6`
  against values `walls.coalesce` rounded to three decimals. That only succeeds
  by luck, and when it fails it fails silently: `find` returns no gaps and the
  structural half of the opening detection is dead while the trace still
  succeeds. On the sample sheet it finds 0 openings where the JS finds 17. The
  JS uses `1e-3`; **this side should follow**, and has not been changed only
  because it changes what the tracer finds on the kitchen plan it is scored
  against.
- `extract.find_openings` WELDS adjacent window spans into one opening, on the
  grounds that a mullion between two sashes is drawn as a jamb. The spans it
  discards are the units the window is built from. Measured on the kitchen
  sheet: the 63.17in window at y=302.83 is really 31.61 + 31.56, a twin, and
  the 91.17in one at y=588.01 is 20.11 + 51.00 + 20.06 - a picture pane between
  two flankers, reported as a single 91in sash. The JS does not merge, so each
  sash gets its own frame and the mullions appear where they were drawn.
  `data/opening_truth.json` carries the merged widths and would need
  regenerating if this side follows.
- The JS reads DXF directly, which nothing here does.

`generated:window` was a third and is closed. This side moved to a spec first,
the way `door_item` writes `generated:door`, and for a while the JS still wrote
a scaled `whitewindow.glb` - 123.0769cm wide and no other width, so `scale_x`
stretched the stiles with the glass and `scale_z` squashed the sash into the
wall plane on a thin partition, and the sample sheet's eight windows wanted five
different widths. `design.js` now writes the same spec: `type`, `width`,
`height`, `sillHeight`, `wallThickness`, `grille`, `openFraction`, all three
scale factors at 1, and `ypos` at `sillHeight + height / 2` so the file agrees
with itself before `applyWindowPlacement` runs.

**Working on the app instead?** Read `app/docs/generated-items.md` first. It
covers how a parametric part is built and — the part that is expensive to
rediscover — how to test one: which of the two containers to run in and why,
the two lines that make the model layer run headlessly, how to render the real
scene without a GPU, and the bookkeeping files that fail late.

Read this before changing anything in `tools/`. Most of it is a record of
things that were tried and failed, which is the part that is expensive to
rediscover.

---

## The pipeline

Build the house up in layers, in this order. Each stage consumes the one above
and nothing else.

```
1. LAYERS      layers.py       split the sheet by (colour, width, fill)
2. WALLS       walls.py        the structure layer -> boxes -> centrelines
3. OPENINGS    opening_truth.py   symbols + face gaps -> windows and doors
4. ROOMS       spaces.py       the complement of the wall union
5. FIXTURES    -- not built --  plumbing pen: sink, tub, toilet
6. CABINETS    -- not built --  filled rects at nominal sizes + elevation text
```

The order matters and was arrived at the hard way. Almost every difficult bug
in this tracer came from asking a later question before an earlier one was
settled — telling a wall from a counter by *shape*, when the drawing had
already separated them by *pen*.

### Tools

| | what it does |
|---|---|
| `layers.py` | splits a page into layers; ranks which is the structure |
| `layer_check.py` | draws every layer on its own → `data/layers.png` |
| `walls.py` | wall boxes from a layer's segments |
| `box_check.py` | draws the traced walls over the drawing → `data/box_check.png` |
| `wall_truth.py` | the wall fixture and its score → `data/wall_truth.{json,png}` |
| `opening_truth.py` | the opening fixture and its score → `data/opening_truth.{json,png}` |
| `spaces.py` | rooms → `data/spaces.png` |
| `dimensions.py` | reads printed dimension strings and checks them |
| `measure.py` | measures a distance off the linework by hand |
| `extract.py`, `rooms.py`, `openings.py`, `trace_check.py` | **the old lattice tracer.** Superseded by the above. Still present because `extract.py` is what writes `design.json`; retire together. |

Every check tool writes into `data/`, which is gitignored. Nothing in `data/`
is precious — regenerate it.

---

## Rules

### Split by pen before you measure anything

A layer is **(stroke colour, stroke width, fill)** — all three. Neither alone
separates, proven on two drafters who share no conventions:

```
Southern Integrity   every pen 0.5pt, separated ENTIRELY by colour
SketchUp LayOut      every pen black, separated ENTIRELY by width
```

Key on colour alone and LayOut collapses to one layer; on width alone and
Southern Integrity does. Fill belongs in the key and is not decoration: Jay
Osborne poché-fills his walls, Southern Integrity fills its *cabinets* and
leaves walls hollow. "Is it filled" gives opposite answers on the two sheets.

### A wall is a box, not a line

`(centreline, thickness, run)`. Thickness is measured face to face, so 2x4
partitions and 10in exterior walls come out as themselves.

- Boxes are **not trimmed** at junctions. They overlap, and the overlap *is*
  the junction — which is how the drafter drew it, so no mitring logic exists.
- Boxes are over-extended by one thickness so crossings are certain. That
  overshoot is a **device, never drawn**: `drawn_lo`/`drawn_hi` is the wall,
  `lo`/`hi` includes the overshoot.
- A wall **ends on the centreline of what it runs into**. Not at the
  neighbour's face (leaves daylight at every corner), not at the overshoot
  (hangs a whole thickness past it).

### A wall is continuous; openings are items on it

architect3d holds `height` and `thickness` **per wall** (`model/wall.js`), and
a window is `InWallItem` (type 3), a door `InWallFloorItem` (type 7) — they
*belong to* a wall and cut into it (`items/factory.js`).

So split a wall at:

- **junctions** — rooms are found by walking closed corner loops, so a
  T-junction has to be a real shared corner
- **height or thickness changes** — the only way to express a half wall

and never at an opening: the item would have no wall to attach to.

### Two things sharing a line are two walls

If two stretches **overlap** but were built from different face pairs, they are
different things — in the kitchen, `12.058in` is both the middle wall's far
face and the half wall's near edge. Keep them apart.

If they are separated by a **gap**, they are one wall interrupted by a door
whose face broke there. Bridge them.

### The drawing distinguishes by span, not just by presence

- A **jamb** reaches from one face of the wall to the other. A mark drawn
  *inside* the wall (a casement operator, a vent) does not. Both are `#4b4b4b`
  here, so colour cannot separate them — span can.
- A **dimension terminator leans**. Ticks are 45° slashes, arrow barbs are
  slanted Vs; extension lines, wall faces, hatching and cabinet edges are
  square to the page.

### Printed dimensions are not the geometry

Measured off the DXF, a printed `2'-0"` measures 23.5", `3'-6"` measures 41.5".
A consistent half inch. Trace the geometry; carry the printed value as
metadata. `dimensions.py` reports both and their difference.

### The sheet has no orientation

There is no north arrow and no orientation note on either page. **Use top /
bottom / left / right, or plan coordinates** (`H y=23.77ft`). Compass words
cost real time in this project when "west wall" meant the bottom one.

### Look at it

Numbers do not show a wall in the wrong place. A box list that reads perfectly
well was three chunks at the windows of a wall that is continuous, and one
render showed it instantly. Every check tool exists for this. After any change,
regenerate and *look*.

### Watch total wall length on every change

It catches what a feature count does not. A loose test once grew the plan by
98ft and turned an 8in stub into a 27ft wall; the opening count was unchanged.

### Do not tune to one drawing

The corpus is five drawings by two drafters in `plans/`, four with DXF. A rule
that fits the kitchen plan and nothing else has failed here repeatedly — see
below. Check a new rule on at least the Southern Integrity sheet *and* one
LayOut sheet before believing it.

### Rejected changes are worth re-testing after a structural fix

`MIN_PAIR_IN = 2.5` was tried and rejected for adding a hallway of spurious
walls. After the layer split removed the jamb noise, the same change was clean
and found the pantry door. The change was never wrong; its context was.

---

## Failures worth not repeating

**`clip.intersects()` silently drops axis-aligned lines.** pymupdf treats a
zero-*area* rect as empty, and a path holding one horizontal or vertical line
has exactly that. It cut 10600 black-stroked paths to 36 — the entire wall
layer — while every hatched and filled thing survived. Use `layers._overlaps`.

**The window frame pairs like a wall.** A window is drawn a little wider than
the hole it fills, so its frame is a parallel pair too — 10in where the wall is
7in — living exactly where the wall's faces stop. Nothing overlaps it, so an
overlap test never sees it, and it gets accepted as a wall that neatly plugs
every window. Rejected by: a run sitting *between* two stretches of one wall
line, judged by its **midpoint** (a frame overlaps the wall face either side by
an inch or two, so an endpoint test misses it).

**A band's two faces are not its outermost lines.** Grouping parallel lines and
taking the extremes seeds on whichever sorts first — the frame — and produced
boxes at the three windows and nowhere else. Score every pair by how far the
two run *together*, summed over every stretch, strongest first.

**Concentration ranks cabinets above walls.** A run of kitchen cabinets is
parallel lines at one repeated depth and scores 1.00; a real house has several
wall thicknesses and scores 0.31.

**Spread ranks dimension lines above walls.** They are long, dead straight, and
reach *further* than the building. What they never do is pair at a thickness
anyone could build — Caroline's dimension layer pairs at 9in, her walls at
3.5in.

**A test that is true nearly everywhere.** `reach_across_openings` extended a
wall to any perpendicular it pointed at if "a jamb sat at its end" — satisfied
by the wall's *own* face fragments, which exist at every wall end. It bought
3ft of right wall and cost 40ft of wrong wall. Deleted.

**Mixing orientations.** Passing `h + v` as jamb evidence let a vertical wall's
end be justified by a horizontal stub. Pass the wall's own line.

**Colour first, weight second.** Fitted to one drawing, demolished by the next.
See the layer rule above.

---

## Ground truth

Two fixtures, kept **separate on purpose**. Walls and openings fail in
different ways: a wall can be exactly right with every opening in it missed.
Scored together, both hide.

```
data/wall_truth.json      wall lines, their solid stretches, their openings
data/opening_truth.json   one record per window/door/cased opening
```

`--emit` writes what the tracer currently believes and renders it. **That is a
proposal, not ground truth** — a fixture made by the tracer cannot score the
tracer. It becomes ground truth once a human corrects it, which is a much
smaller job than authoring it.

`wall_truth` owns *where the walls are*; `opening_truth` owns *where the holes
are*; the drawn wall is one minus the other. Do not let both derive openings —
that was tried and they disagreed.

**The DXF is not an answer key.** All 28 `DIMENSION` and 20 `TEXT` entities in
the exports sit on the door/window schedule; every floor plan sheet has zero of
either. The "Messy 2D CAD Export" exploded the plans to bare geometry. The
dimension reader is self-validating instead: a printed `8'-0"` agreeing with the
144pt span it brackets needs no second source.

---

## Still open

- **The half wall** is drawn as a single ~1in stroke, below the wall thickness
  floor, terminated by a 2x4 post. Neither is traced. It stays on the
  `--half-wall` / `--post` flags. The kitchen and great room therefore read as
  one 385 sqft space, which is correct until it is traced.
- **`rank()` picks the wrong layer sometimes.** Deliberately not tuned to fix
  the kitchen plan. `--layer "#000000,0.5"` overrides; `layer_check.py` is how
  you find out which to use.
- **Everything is still single-sheet.** `--page` and `--clip` are hand-set. The
  goal is any plan, which needs region detection (drawing titles occupy their
  own font-size tier — 25pt on one drafter, 16pt on the other — but *extents*
  do not fall out reliably, so a human picks the region).
- **Fixtures and cabinets are not built.** Both are single-layer reads now:
  `#804040` for plumbing, `#c6bfaa`/`#e8e7e4` filled rects at nominal sizes,
  joined to the E1–E5 elevation text for heights.

---

## Conventions

Commits explain the *mechanism* and record what failed, in the present tense,
one subject line as a sentence. The failures are the valuable part — a commit
saying "fixed the wall bug" is worth nothing to whoever hits it next.

Anything identifying the house — `plans/`, `data/` — stays out of git.
