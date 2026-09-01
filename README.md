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
docker compose up dev     # http://localhost:5173  -- vite + HMR, source bind-mounted
docker compose up app     # http://localhost:8088  -- the real production build
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
