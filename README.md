# Kitchen Designer

A local-first, containerised kitchen and dining room designer: walk the room in
first person, try cabinet styles and colours, and light it properly -- recessed,
under-cabinet, in-cabinet and pendant fixtures with real colour temperature --
then get a cabinet takeoff and price it.

Built as a fork of [architect3d](https://github.com/amitukind/architect3d)
(ISC, three.js r185, Vue 3 + Vite), which supplies the 2D floorplan editor, the
wall/room model, the GLTF item pipeline and a first-person walkthrough. See
`app/UPSTREAM_SHA` for the commit this was forked from, and `app/LICENSE` for
the upstream licence.

## Running it

Nothing to install but Docker. The 3D rendering happens in your browser, so the
container needs no GPU.

```sh
docker compose up dev              # http://localhost:5173  -- vite + HMR, source bind-mounted
docker compose up app              # http://localhost:8088  -- the real production build
docker compose run --build --rm test   # the full suite (1323 tests)
docker compose run --build --rm test npx eslint . --max-warnings 0
```

`--build` matters: the test service runs the image's copy of the source, so
without it a source edit is invisible to the suite. That is the price of the
next paragraph.

Tests deliberately run against the image's copy of the source rather than the
bind mount: reading many small files across a Windows bind mount is slow enough
to blow vitest's 5s default timeout in `tests/asset-integrity.test.js`, which
looks like a failing test and is a slow filesystem.

## Getting a plan in

`tools/extract.py` traces a scaled architectural PDF into a design the app can
open. It needs `pymupdf` (`pip install -r tools/requirements.txt`).

```sh
python tools/extract.py "plans/your-plan.pdf" -o data/design.json
```

It writes two things into `data/`, which compose serves at `/plan`:

- `design.json` -- walls traced from the drawing, in centimetres
- `underlay.png` -- the same region of the PDF, wired up as architect3d's
  carbon sheet and aligned to those walls

The app opens that plan on boot if it is there, and the stock demo room if it
is not. **Expect the trace to be imperfect.** Cabinet runs, counters and door
swings produce the same parallel-line pairs walls do, and no threshold
separates them cleanly, so some furniture arrives as walls and some walls
arrive short. That is what the underlay is for: the real drawing shows through
underneath, and anything wrong can be dragged into place in the 2D editor.

A pony wall is a flag, because it is a design decision and not something the
drawing records. Feet from the plan's north-west corner:

```sh
python tools/extract.py "plans/your-plan.pdf" -o data/design.json     --half-wall h,12.0,25.0,38.0 --half-wall-height 42
```

Useful flags: `--clip X0 Y0 X1 Y1` picks the region of the sheet holding the
plan (PDF points), `--page` picks the sheet, `--ceiling` sets wall height in
inches, `--scale` if the drawing is not 1/4" = 1'-0".

Walls are derived from the ROOM boxes, not traced as lines. Tracing lines
leaves out the short returns beside a doorway, and deriving them from a closed
room boundary makes that impossible rather than rare -- 26 loose ends became 0
on this plan. Walls crossing each other is fine and expected: they are split at
their intersections into shared corners, and a boundary two rooms share is
emitted once.

It also places windows and doors. Neither is a gap in the wall -- the wall's
face lines run through both -- so they are found by what is drawn inside the
opening: glazing (line pairs about an inch apart, lying on the wall's own
centreline) for a window, and a swing arc resting on the wall for a door. Each
is then widened out to the jambs either side, which is what gives it a real
width. Jambs on both sides are required: without that, every cabinet run and
counter edge in the kitchen reads as a window.

Expect it to miss some doors. The swing arcs are polylines rather than curves
and vary in how they are drawn, so detection is deliberately conservative --
a missing door is a two-click fix, a phantom one in a cabinet run is confusing.

Check what it traced before trusting it -- this draws the walls back over the
drawing they came from, so a wall floating in the middle of a room (a bathtub,
a cabinet run) is obvious:

```sh
python tools/trace_check.py          # -> data/trace_check.png
```

`tools/measure.py` is the companion for checking a dimension against the
linework rather than against a callout:

```sh
python tools/measure.py "plans/your-plan.pdf" --near "Elevation 3"
```

## Layout

```
app/       forked architect3d (vendored, history stripped -- see UPSTREAM_SHA)
docker/    nginx config for the production image
tools/     PDF plan extraction and measurement
plans/     the architect's drawings          [gitignored -- personal]
data/      saved designs, extracted geometry [gitignored -- personal]
```

Anything identifying the house -- the drawings, the extracted floor plan, the
saved designs -- stays out of git by design. Keep it that way.

## What this adds to architect3d

Upstream is a floor planner. These are the gaps it leaves, in build order.

**1. Parametric cabinets.** Cabinets are data, not meshes -- carcass, face frame,
door style, drawer split, shelves -- generated procedurally. Everything else
depends on this: style swaps become free, and the cabinet schedule *is* the
model, so the takeoff needs no separate step.

**2. A real lighting system.** Upstream's entire lighting is three lights: one
hemisphere, one overhead directional key, one weak fill. There is no concept of
a light you place in the room. Replaced with placeable, persisted fixtures:

- recessed cans, under-cabinet strips, in-cabinet, pendants, toe-kick
- colour temperature per fixture and per group (2200K-5000K)
- exposure control, so comparisons are not confounded by tone mapping
- day/night, and window daylight with correct direction for the time of day

**3. Cabinet run configuration.** A run of uppers is one object with a width
split, so you can compare `[24,21,30,24]` against `[36,36,27]` and see the
interior divisions appear and disappear. Also: centre-stile toggle, frameless vs
face-frame, shelf count, glass fronts, door open/closed, and height-to-ceiling
options (to-ceiling / open gap / soffit / stacked uppers).

**4. Takeoff and pricing.** BOM out of the model, in stock cabinet nomenclature,
against more than one cabinet system so layouts can be compared on price.

## Notes

Upstream's `classic` render profile draws walls as unlit `MeshBasicMaterial`.
Stay on `studio` (or a profile derived from it) or lighting changes will not
show up on a wall.
