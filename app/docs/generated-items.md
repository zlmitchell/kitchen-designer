# Building a generated item

How to add a parametric object to this app, and how to prove it works. Read this
before adding a cabinet, a window, a sink or an appliance — they are all the same
shape of job, and most of the traps below cost a day each to find the first time.

For *what* to build and in what order, see `ROADMAP.md`. For the plan extractor,
see `AGENTS.md`. This is only the mechanism.

---

## Why anything is generated at all

Upstream architect3d places models. `Item.resize()` calls `setScale(x, y, z)`, so
asking a 24in cabinet for 36in gives you 1.5×-wide door panels, stiles, toe kick
and hardware. There is no width you can ask for that is correct.

A generated item is **told its size and builds itself**. A 36in cabinet has a 36in
opening and the same 1.5in stiles. That is the whole idea, and every rule below
exists to keep it true.

The first one is `items/generated/door.js`. Read it alongside this.

---

## The shape of a builder

```js
export function buildThing(spec)
{
    return {
        geometry,    // the item's own — and therefore its BOUNDS
        materials,   // parallel array, indexed by geometry group
        parts,       // children: anything that must not affect bounds
        onBound,     // optional; called when the item binds to a wall
    };
}
```

Register it in `items/generated/index.js`, and export a schema beside it:

```js
export const GENERATED_BUILDERS = {door: buildDoor};
export const GENERATED_SCHEMAS  = {door: DOOR_SCHEMA};
```

An item names its builder in `model_url` as `generated:door`, with
`format: "generated"`, and carries its parameters in `spec`. Nothing else in the
save format changed — see `docs/save-format.md`.

### Assembling geometry

Build a `Group` of `Mesh(BoxGeometry, material)` and hand it to
`mergeMeshes(group)` from `core/geometry_merge.js`. It bakes world matrices,
pools materials **by name**, and returns `{geometry, materials}` — the same path
a loaded glTF takes, so a generated item is indistinguishable downstream.

Write boxes as **extents**, not centre-and-size:

```js
box(mat, x0, x1, y0, y1, z0, z1)
```

Every dimension in millwork is naturally a pair of faces — a jamb runs from the
opening edge to the rough-opening edge — and converting each one to a centre by
hand is where sign errors live.

### Materials

Never hardcode a colour. Declare slot defaults and resolve them:

```js
const SLOTS = {frame: 'paint-white', leaf: 'paint-white', hardware: 'metal-brushed-nickel'};
var mats = materialsForSlots(spec.material, SLOTS);
```

`core/materials.js` reads `catalog/materials.json`. A tint cannot tell white
paint from white lacquer from white quartz — same colour, three surfaces, and the
difference is entirely roughness and metalness. `materialsForSlots` keeps your
default for any slot the spec does not name, and falls back rather than throwing
on an id this build has retired, because a saved design outlives the library.

Materials are **fresh per build, never shared**. `Item.removed()` disposes what
its geometry carries, so a shared instance dies with whichever item goes first
and leaves the other drawing with a dead handle.

---

## The five rules

### 1. The item's geometry IS its bounds, and three things read them

`Item.bounds()` reads `this.geometry.boundingBox` and **nothing else**. Children
are invisible to it. Three things downstream read those bounds:

| Reader | What it does |
|---|---|
| `three/edge.js` | cuts the wall's hole from `halfSize.x` / `.y` |
| `WallItem.boundMove` | clamps travel along the wall by `sizeX / 2` |
| `InWallItem.getWallOffset` | centres the item across the wall |

So put in `geometry` exactly the volume the item should *occupy*, and put
everything else in `parts`. For a door that means the geometry is the rough
opening — two jambs and a head — while the leaf (it swings out of the wall), the
casing (it laps the wall face and would widen the hole) and the hinges (they
belong to whichever jamb the handing picks) are all children.

This is free, not clever: `Item extends Mesh extends Object3D` and already adds
children — `item.add(this.canvasPlaneWH)` predates all of this.

### 2. Build centred

`Item`'s constructor recentres geometry on its bounding box in all three axes
(`items/item.js:198`) and does **not** recentre children. Author anywhere but
centred and the frame moves while the leaf stays behind, by half the item.

Build centred and that recentring is a no-op, and child transforms mean what
they say.

### 3. Plan axes are not item axes — resolve on binding

The drawing knows things in **plan** coordinates: which end a door is hinged on,
which side it swings to. The item does not live in those coordinates.

A wall has two half edges, and `WallItem.changeWallEdge` sets `rotation.y` from
the normal of whichever one the item binds to. Two items with identical specs on
two walls therefore come out rotated 180° apart. Measured on the traced plan
before this was fixed: `door-7` and `door-9` were both `lo`/`in` and their leaves
ended up at world dz **+35.9 and −28.9**.

So: keep plan-space fields in the spec, and convert them in `onBound`, which
fires from `changeWallEdge` at the only moment the axes are known.

**Resolve each axis independently.** Rotating by θ sends local +x to
`(cos, 0, −sin)` and local +z to `(sin, 0, cos)`. On a wall running along world z
those carry *opposite* signs. One flip is right on horizontal walls and wrong on
vertical ones — which shows up as half of one elevation hinged backwards. See
`resolveHanding`.

### 4. A hole that leaves the wall is discarded, not clipped

`ShapeUtils.triangulateShape` silently drops a hole that strays outside its
contour. Measured on a 100×200 contour: a hole reaching 0.5mm below the bottom
edge gives 2 triangles and a solid face; the same hole starting at zero gives 6
and a real opening.

An item standing on the floor has `position.y == halfSize.y`, so its hole's
bottom edge *is* the contour's. `halfSize` is float32 off a bounding box;
`position.y` is float64 out of the file. On the traced plan they disagreed by
**3×10⁻⁶ cm** and every doorway in the house came out solid, with no error.

`edge.js` now clamps holes inside the contour (`HOLE_INSET`). You get this for
free — but know it is there, because **Phase 5's floor-to-ceiling windows are the
same trap at the other end of the wall**.

### 5. Never scale — rebuild

`Item.setSpec(spec)` asks the builder for the object at the new size and swaps
geometry, materials and children, keeping position and rotation. `scale` stays at
1 for a generated item and nothing should change that.

`getSpec()` hands back a **copy**. Edit the copy, hand the whole thing back. A
field that throws mid-edit then cannot leave a half-applied spec on the item.

`setSpec` disposes the old geometry and materials itself — nothing else will,
because the item is not being removed and `removed()` is the only other place
that frees them.

---

## The inspector comes free

Export a schema and the panel builds itself — `SpecInspector.vue` renders any of
them. Adding an option is a line in your builder, not UI work.

```js
export const DOOR_SCHEMA = {
    label: 'Door',
    fields: [
        {key: 'operation', label: 'Operation', type: 'choice', options: [...]},
        {key: 'width', label: 'Opening width', type: 'length', min: 40, max: 250},
        {key: 'wallThickness', label: 'Wall thickness', type: 'length', readOnly: true},
        {key: 'openFraction', label: 'How far open', type: 'fraction',
         when: {operation: 'swing'}, min: 0, max: 1, step: 0.05},
        {key: 'material.leaf', label: 'Leaf', type: 'material'},
        {key: 'material.hardware', label: 'Hardware', type: 'material', group: 'metal'},
    ],
};
```

- `type`: `length` (centimetres in the spec, shown in the user's unit),
  `fraction`, `choice`, `material`.
- `when`: only show this field when another field has a given value. A cased
  opening has no leaf, so asking which way it swings is noise.
- `readOnly`: show the number, do not offer to set it. A door's wall thickness is
  the *wall's*; a door that disagrees with its wall is a bug, not a choice.
- `key` may be dotted (`material.leaf`) to reach into a spec block.

---

## How to test

Four levels. Use the cheapest one that can answer your question, and do not stop
at the cheapest if it cannot.

```sh
docker compose run --build --rm test                       # the whole suite
docker compose run --build --rm test npx vitest run tests/generated-door.test.js
docker compose run --build --rm test npx vue-tsc --noEmit -p tsconfig.json
docker compose run --build --rm test npx eslint src tests --max-warnings 0
```

`--build` matters. The test service runs the **image's** copy of the source, so
without it your edit is invisible to the suite.

### 1. Unit-test the builder

It is a pure function: spec in, geometry out. No renderer, no DOM. Assert on
measurements, not on triangle counts — `tests/generated-door.test.js` checks that
the rough opening is the clear opening plus two jambs, that the frame fills its
wall at four different thicknesses, and that an open leaf projects more than
70cm. That last one exists because `open_door.glb` projected 3.8cm and shipped.

### 2. Test through the model layer

Generated items build **synchronously and without network**, on purpose: the
generated branch in `Scene.addItem` sits ahead of both the asset-manifest check
and the `itemLoader` seam. So you can load a whole design in vitest.

You need two things:

```js
// @vitest-environment jsdom          <- Item builds two label canvases
import {installCanvas2D} from './helpers/dom.js';
installCanvas2D(window);              // jsdom has no 2D context
```

Without the second, every item fails with `Cannot set properties of null
(setting 'font')` and you get an empty scene with no obvious cause.

`tests/wall-openings.test.js` does this: builds a room, binds an item, constructs
the real `Edge`, and asks whether any triangle covers the middle of the opening.

### 3. Look at it

Numbers do not show geometry in the wrong place. There is no GL in the container,
so render offline: build the scene the app builds and rasterise it yourself.

```js
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
installCanvas2D(dom.window);

const model = new Model('/textures/');
model.loadSerialized(readFileSync('/plan/design.json', 'utf8'));
await new Promise((r) => setTimeout(r, 100));

const scene = new ThreeScene();
// Edge.init subscribes to the controls AND reads controls.object.position -
// the app fades a wall facing away from the camera, so the stub needs the eye.
const controls = {object: {position: eye}, addEventListener() {}, removeEventListener() {}};
const fp = new Floorplan3D(scene, model.floorplan, controls, null);
fp.redraw();   // it builds on EVENT_CHANGESET, already fired by the load
```

Then walk the scene graph, project the triangles, and z-buffer them into a
`pngjs` image. About 60 lines. This is what proved the doorways were solid.

Mount the plan and an output directory:

```sh
docker compose run --rm --no-deps -T -v "$OUT:/plan-out" dev node /app/render-scene.mjs
```

**Aim the camera at the thing in question.** A general overview cannot answer
"can you see through this opening"; stand 300cm back from one door on its own
axis and look.

### 3b. Which container to run in, and why it matters

Two services, and picking the wrong one wastes a lot of time:

| | `test` | `dev` |
|---|---|---|
| source | the **image's copy** | the **host, bind-mounted** |
| writes reach the host | no | yes |
| use it for | running the suite | anything that must WRITE a file |

So a script that renders a thumbnail into `public/` has to run in `dev`, or it
writes into a container that is then thrown away. `--build` is what makes `test`
see your edit at all; without it you are testing the last image.

**Bare `node` cannot import this project's JSON.** `core/materials.js` does
`import catalog from '../../catalog/materials.json'`, which Vite and vitest
resolve and plain node rejects with `ERR_IMPORT_ATTRIBUTE_MISSING`. So a scratch
script that touches materials — which is any script that builds a part — must go
through vitest rather than `node file.mjs`:

```sh
docker compose run --rm --no-deps dev npx vitest run tests/zz-scratch.test.js
```

Name scratch files `zz-*` so they sort last and are obvious, and delete them
before committing.

### 3c. Mounting a panel

An inspector is testable without the app around it. `@vue/test-utils` plus a
hand-built item, which is a deliberate style here — it pins the contract without
building a scene:

```js
// @vitest-environment jsdom
installCanvas2D(window);                       // jsdom has no 2D context
const item = {rotation: {y: 0}, allowRotate: true, getWidth: () => 10, /* ... */};
const panel = mount(ItemInspector, {props: {item}});
await panel.findAll('input[type=number]').at(3).setValue(90);
```

The trap: a hand-built item is an **incomplete** Item. A real one extends `Mesh`
and therefore always has `rotation`, `scale` and the rest — so when a panel starts
reading one of those, the honest fix is to grow the stub, not to make the panel
defensive about a field that cannot actually be missing.

### 4. Raycast for a yes/no

When the question is binary, do not squint at a render. Cast a ray and report
what it hits:

```js
ray.set(from, through.negate());
const hits = ray.intersectObjects(wallMeshes, false).filter((h) => h.distance < 130);
```

That turned "the doorway looks wrong" into "all ten openings hit WALL at ~54cm"
in one run, which is what located the bug.

### Regression tests must be shown to fail

A test written after a fix, against the fixed code, proves nothing. Bypass the
fix, run it, watch it fail, restore. The float-error case in
`tests/wall-openings.test.js` was confirmed this way — and it was the *only* one
of the three that failed, which is exactly why the other two would not have
caught the bug.

### The ledgers, and other things that fail late

Three bookkeeping files will fail the suite rather than the feature, and all
three are meant to:

- **`tsconfig.json`** — adding a file with `// @ts-check` means updating the
  CHECKED counts. `tests/type-coverage.test.js` enforces both the total and the
  per-directory rows.
- **`public/asset-manifest.json`** — adding any file under `public/` means
  `npm run manifest` (in the `dev` service, so the write lands). The manifest is
  how the app answers "does this build ship that asset" before touching the
  network.
- **the catalog tests** — `catalog-and-shim.test.js` pins the item count and the
  set of formats. A generated entry must also be backed by a registered builder,
  so a typo like `generated:pots` fails the suite instead of failing on click.

### Drawing a thumbnail

A generated item has no model file to screenshot, so render its own geometry.
300x225, opaque white, into `public/models/thumbnails_new/`. Two things that are
not obvious:

- **Show the catalog default.** A thumbnail of a trimmed post is a promise the
  click does not keep.
- **Hold the brightest face below white.** The default finish is white paint and
  the background is white, so a face at full lambert vanishes into it. Roughly
  0.46–0.90 keeps three distinct values and a silhouette.

---

## Traps, in the order they will bite

1. **A stale artefact is not evidence about the code.** `data/design.json` is
   generated. Regenerate it before concluding anything about the pipeline — a
   whole wrong diagnosis came from reading a file written before the commit that
   fixed the thing being diagnosed.
2. **Measure the asset, do not trust its name.** `open_door.glb` is a closed door
   with the doorknobs deleted. Its name and its matching width and height were
   believed; its 7.62cm depth was not checked.
3. **`mergeMeshes` flattens the whole glTF hierarchy.** A leaf authored as its
   own node — which is what Kenney's `doorway.glb` does — is baked in and cannot
   move. This is why children come from the builder, not from the file.
4. **`ShapeGeometry` is indexed.** Reading `position` raw walks the wrong
   triangles. `toNonIndexed()` first.
5. **`resized()` re-seats a floor-bound item** with a +0.01 lift. Expect
   `position.y` to change after `setSpec`; that lift is also what keeps the hole
   clear of the contour edge.
6. **Float32.** Geometry positions are float32, so a 200cm extent resolves to a
   few microns. Never assert an exact zero on a bounding box — 4 decimal places
   is the honest limit.
