# Building the parts the plan needs

An audit of what the app can express today against the parts our floor plan
actually contains, and the order to build the rest in.

`README.md` §"What this adds to architect3d" states the four gaps in one
paragraph each. This is that list opened up into the ~20 things a kitchen needs,
with the mechanism for each. Read `AGENTS.md` before touching `tools/`.

---

## The audit

Upstream architect3d is a floor planner: rooms, walls, and a palette of fixed
meshes. Every "no" below comes back to the same two root causes.

| Part | Today | Verdict |
|---|---|---|
| Half / pony walls | `Wall.setHeight`, and a Full/Half control on the wall panel | **Done** |
| Window types | One `whitewindow.glb` plus two Kenney wall panels | No |
| Muntins / grille in the glass | — | No |
| Window width / height | Mesh `setScale` — stretches the frame along with the glass | No |
| Floor-to-ceiling windows | — | No |
| Door width / height / style | Two GLBs (`closed-door28x80`, `open_door`) | No |
| Sliding patio door (glazed) | — | No |
| Bypass closet doors | The **old** tracer detects them (`openings.py:72`); the new one has no slider case and `items_for` writes a swinging door | Detected, then discarded |
| Pocket door | — | No, and it needs a wall cavity |
| Bifold closet doors | — | No |
| Barn door | — | No, and it is not an in-wall item at all |
| Door open / closed state | Generated: `openFraction` 0..1, hinged leaf on a pivot. `open_door.glb` held no open leaf — 7.62cm deep | **Done** |
| Ceiling lights | `RoofItem` already snaps to the ceiling plane; `Chandelier`, `Ceilingfan`, `Lampsquareceiling` exist **as meshes that emit no light** | Placement yes, light no |
| Any placeable light | `three/lights.js` is 3 global lights, total | No |
| Colour temperature | — | No |
| Wall sconces | `Lampwall` is already type 2 and already binds to a wall edge — and emits nothing | Placement yes, light no |
| Sconce uplight / downlight | — | No |
| Ceiling fans | `Ceilingfan` is type 4 (`ceilingFan.gltf`) — emits nothing, and does not turn | No |
| Fan: hugger vs downrod, light kit | — | No |
| Anything animated | The render loop is continuous (`three/main.js:513`) but there is **no clock** — no `AnimationMixer`, no `Clock`, no `getDelta` in `src/` | No |
| Base cabinets | `Kitchencabinet` (Kenney, fixed width) | No |
| Cabinet width, parametric | `Item.resize()` → `setScale(x,y,z)` (`items/item.js:436`) | No — cause A |
| Cabinet material | Per-material **colour tint only** (`setMaterialColor`) | No |
| Door front style | — | No |
| Counter depth / cabinet depth | Mesh stretch | No |
| Upper cabinet depth / height | 4 fixed Kenney uppers | No |
| Countertops | The word does not appear anywhere in `app/src` | No |
| Floating drawers (no toe kick) | — | No |
| Sinks | `Kitchensink` is a **floor item** — it does not cut a counter | No |
| Sink mount: on-counter / in-counter / farmhouse / vessel | — | No |
| Round or oval basins (bath vessels) | `Bathroomsink`, `Bathroomsinksquare` — fixed meshes | No |
| Sink material: fireclay, stainless, composite, enamel, glass, stone, copper | Colour tint on one mesh | No |
| Range / cooktop | `Kitchenstove`, `Kitchenstoveelectric` | Mesh only |
| Fridge, built-in vs freestanding | 4 fixed Kenney fridges | Mesh only |
| Vent hood | `Hoodlarge`, `Hoodmodern` — type 0, "anywhere" | Mesh only |
| Microwave: counter / in-cabinet / over-range | `Kitchenmicrowave`, type 0 | No |
| Dishwasher | **Absent from the catalog entirely** | No |

Two root causes, and they are the whole plan:

**A. Everything is a static mesh, resized by scaling it.** `Item.resize()` calls
`setScale(x, y, z)`. Ask a 24in cabinet for 36in and you get 1.5x-wide door
panels, stiles, toe kick and hardware. There is no width you can ask for that is
correct, so no amount of catalog work fixes it — a cabinet has to be
*generated*. The traced plan already shows the damage: all 19 of its windows and
doors are one of two models at `scale_x: 0.7258, scale_y: 0.894`.

**B. Nothing in the model knows what a kitchen is.** No countertop, no carcass,
no run, no appliance, no light fixture. `grep -riE 'countertop|carcass|dishwasher'
app/src` returns nothing.

### What we already get for free

Worth knowing before building anything, because each of these is a thing not to
write:

- **The wall cuts its own hole.** `WallItem.redrawWall()` → `edge.js` cuts the
  opening from the item's reported `halfSize`. A parametric window that reports
  honest bounds gets its hole with no new code. Same for doors —
  `InWallFloorItem` is the class.
  - **But a hole that strays outside the wall is discarded, not clipped.**
    `ShapeUtils.triangulateShape` drops it entirely and silently: measured on a
    100x200 contour, a hole reaching 0.5mm below the bottom edge gives two
    triangles and a solid face where the same hole starting at zero gives six.
    A doorway's hole is meant to reach the floor *exactly*, so `position.y ==
    halfSize.y` — and `halfSize` is float32 off a bounding box while
    `position.y` is float64 out of the file. Three microns of disagreement made
    every doorway in the traced plan solid, with no error anywhere. `edge.js`
    now clamps holes strictly inside the contour (`HOLE_INSET`), and
    `tests/wall-openings.test.js` pins all three cases. **Phase 5's windows sit
    in the same code path** — a floor-to-ceiling window is the same trap at the
    other end of the wall.
- **Corner elevation already drives wall height, and is already saved.** Half
  walls are a bug fix and a UI control, not a feature.
- **`RoofItem.closestCeilingPoint()` already snaps to the ceiling.** Ceiling
  light *placement* is done.
- **`core/geometry_merge.js` and `core/geometry_builders.js` exist.** Panel
  assembly has a home.
- **Items already persist a sparse per-instance blob** (`material_colors`). A
  `spec` field is the same shape and the same round-trip.
- Walls are unlit `MeshBasicMaterial` under the `classic` render profile. **Every
  lighting change below is invisible unless the profile is `studio`.**

---

## The plan

### Phase 0 — the spine (no user-visible feature)

Nothing else works without this, and everything after it is cheap.

**0a. Parametric items.** One `spec` object per item, persisted as one new
optional field in the save format, beside `material_colors`:

```json
{"kind": "base-cabinet", "width": 91.44, "depth": 61, "front": "shaker",
 "material": {"front": "paint-white", "carcass": "birch-ply"},
 "drawers": [15, 0, 0]}
```

- A **builder registry**: `spec.kind` → `(spec) => {groups, bounds}`. Kinds:
  `base-cabinet`, `wall-cabinet`, `tall-cabinet`, `drawer-bank`,
  `floating-drawer`, `counter`, `window`, `door`, `appliance`.
- `item.setSpec(next)` rebuilds geometry in place, keeping position and
  rotation. **Never `setScale`.**
- A **schema** per kind drives the inspector, the way `useCatalog` reads
  `catalog.json` — so adding a cabinet option is a data change, not a Vue
  change.
- Parametric is orthogonal to placement: a base cabinet is still type 9
  (`WallFloorItem`), an upper type 2, an appliance type 1. No new item types.

**0b. A material library.** New `src/catalog/materials.json`, shaped like
`textures.json` but PBR: colour, roughness, metalness, optional map. Paint =
colour + roughness 0.35. Stain = wood map + 0.5. Quartz = map + 0.15. Items get
a material *per face group* (`carcass`, `frame`, `front`, `counter`,
`hardware`), not one tint for the whole mesh. This single change is what turns
"choose material / front style / colour" into three dropdowns over one list.

**0c. Kelvin → RGB.** One pure function, Planckian approximation, 2200–5000K.
Unit-testable on its own, and Phase 6 needs it.

**0d. A frame tick.** The render loop already runs every frame unconditionally —
`renderer.setAnimationLoop` at `three/main.js:513` calls `render()` with no
dirty check — so **motion costs no extra frames**, which is the usual objection
and it does not apply here. What is missing is elapsed time: there is no `Clock`,
no `AnimationMixer` and no `getDelta` anywhere in `src/`. Add a delta source and
a list of per-frame updaters that honours the existing `pauseRender`, and a
ceiling fan turns. Nothing else on the list needs it, so keep it to about twenty
lines and resist building an animation system.

### Phase 1 — half walls ✅

Done. `AGENTS.md` records the cost of not having had it: the kitchen and great
room read as **one 385 sqft space**, because the wall between them was not there.

What it turned out to need, beyond the obvious:

- **The elevation event fired backwards.** `value - this._elevation < 1e-6` is a
  one-way test wearing a two-way tolerance — true when a corner moves *down*,
  false when it moves *up*. The floorplan turns that event into `update()` and so
  into the ChangeSet the 3D view rebuilds from, so a wall could be dropped to
  half height and never brought back. Compared as a magnitude now.
- **Corner identity had to become elevation-aware.** A wall takes its height from
  its two corners, so one corner cannot be both 42in and 96in — a pony wall
  meeting a full wall shares a point on the plan and must not share a corner.
  `newCorner` keys on position *and* height now, which is the rule
  `extract.py:246` has used since it first wrote a pony wall out.
- **`Wall.setHeight` splits only the corners it must.** An end that carries
  nothing else, or whose neighbours are coming along, is simply set; only a
  junction with something staying tall gains a corner. Verified on the traced
  plan: the target wall dropped to 106.68cm, its three neighbours stayed at
  243.84, and the corner count went 28 → 30.
- **`wall.height` is derived from the corners.** It was a second, unserialized
  height that drove texture repeat and new-item placement, and it disagreed with
  the corners the moment anything moved. This one has a visible consequence and
  is an **intended departure from the r98 parity golden**: that golden's corners
  are 250/250/310/280 while `wall.height` was the configured 250, so a wall
  tiled its texture to 310/250 = 1.24 — the image ran 24% past the top of the
  wall. `geometry-r98.json` cannot be regenerated (the capture tool needs r98 and
  refuses to run without it), so the departure is asserted in the test instead.
  It matters beyond tidiness: a half wall's corners are always below the
  configured default, so every pony wall would have been textured for a wall
  twice its height.

**A post is an item, not a very short wall.** `README.md` reasoned that
architect3d has no column primitive but a wall is 10cm thick by default, so 4in
of one is a 4x4 and needs no model and no new concept. The first half is true;
the second is not, and it fails destructively. Two floors get in the way:
`snapTolerance` quantises grid snapping to 25cm, so the shortest wall you can
drag or type is 9.84in — which is where "the smallest was 10 inches" comes from —
and `cornerTolerance` is a hardcoded 20cm, so two corners closer than that
**fuse**. Measured: asked for 8in a wall survives; asked for 6in its ends merge
and the wall ceases to exist, with no error. An exported design carried a 0.56cm
wall, the remnant. So `generated:post` — any size, cannot collapse, and not part
of the wall loops rooms are found from. It does not follow a wall when the wall
moves, which for a post capping a pony wall is usually right and is the honest
trade.

Still open: the top of a half wall is drawn (commit `01f5fa9` gave every wall a
top) but in the wall's own colour. A counter-height rail wants a cap in a counter
material, which is a Phase 2 material question rather than a geometry one. And
`build.py` still does not trace a pony wall — `--half-wall` remains on the old
`extract.py`, so the decision is made in the editor.

#### What it was, before

1. Fix `Corner.elevation` (`model/corner.js:190`). The condition is
   `value - this._elevation < 1e-6`, so `_hasChanged` is set when a corner moves
   **down** and not when it moves up — raising a corner dispatches nothing and
   the 3D view never rebuilds. Backwards.
2. Stop corners merging across different elevations in the 2D editor
   (`cornerTolerance = 20`). `extract.py:246` already keys corners by
   `(x, y, height)` for exactly this reason: a pony wall meeting a full wall
   needs two corners at one point, and today the editor snaps them into one and
   the half wall comes back full height.
3. A wall-level "Half wall" control in `Wall2DInspector` that sets both corners
   together — it exposes only Straight/Curved and Length today. Plus a **cap** on
   top in the counter material: `edge.js:buildFillerUniformHeight` already draws
   that surface, it just needs its own material.
4. Retire `wall.height`, or derive it from the corners. It is a second,
   *unserialized* height that drives texture repeat and new-item placement, and
   it will keep disagreeing with the corners until one of them goes.
5. Port `--half-wall` / `--post` from `extract.py` into `build.py` —
   `AGENTS.md` lists this under "still open".

### Phase 2 — cabinets and counters

**Cabinets and counters are built.** `generated:cabinet` (base / wall / tall,
face-frame or frameless, slab / shaker / raised fronts, doors and drawer banks,
knob or pull) and `generated:counter` (slab, edge profile, backsplash, cutouts).
Sinks and appliances are what remain.

Four things the work turned up, all of which a triangle count would have missed:

- **The raised panel did not stand out.** Its inset chose a sign and then passed
  it through `Math.abs()`, so both styles built the same panel.
- **An overflowing drawer was silently dropped** rather than the set being
  scaled — four drawers into a 68.6cm opening came out as three and a gap.
- **`mergeMeshes` recomputes each mesh from its parent's CURRENT world matrix**,
  so shifting a group after the last update moves some children and not others.
  Centring a cabinet moved the carcass and left the fronts, which read as a 68cm
  cabinet measuring 71.5.
- **A hole reaching the slab's edge is discarded, not clipped** — the same trap
  as the wall openings, one file over. Counter cutouts are clamped inside.

Also settled: `floatHeight` was removed rather than left in. A gap below is not
geometry, so it cannot survive in a bounding box, and every floor-bound item
class pins the bottom of the bounds to the floor. A floating drawer hangs from
the counter, which makes it a run question — phase 3.

The spine of the app. A cabinet is **panels, not a box**:

- carcass: 2 sides, deck, back, top stretcher
- toe kick, recessed, 3in x 4.5in high — *omitted* for a floating drawer, which
  takes a `floatHeight` instead
- face frame: 1.5in stiles and rails, or frameless with a 0.75in reveal
- fronts standing 0.75in proud, with a **reveal gap between them** — the gap is
  what makes a run read as cabinetry rather than as a wall
- front style as a profile: slab = 1 box; shaker = outer frame + recessed centre
  = 5 boxes; raised panel = the same plus a bevelled centre. No CSG needed, and
  at walkthrough distance this is indistinguishable from the real thing.
- one knob or pull box per front. Trivial, and its absence is exactly what makes
  a render look like blocking.

Width is free, with a snap list (9/12/15/18/21/24/27/30/33/36in) because that is
what you can buy. Depth defaults 24in base, 12in upper; heights 34.5in base,
30/36/42in upper.

**Counters** are their own `kind`: a slab with a depth, an overhang, an edge
profile and a material. Cutouts come from `THREE.Shape` with `holes` →
`ExtrudeGeometry` — native, no CSG library.

**Sinks.** A sink is a counter cutout plus a basin, so it only exists once the
counter does. The Kenney `Kitchensink` mesh becomes a fallback, not the
mechanism.

```json
{"kind": "sink", "mount": "undermount", "material": "fireclay", "shape": "rect",
 "width": 76.2, "frontToBack": 47, "depth": 24.1,
 "bowls": [1], "ledge": false}
```

- **`mount`** is the whole difference between them, and it is *where the basin
  sits relative to the slab*, not a different model:
  - `drop-in` (on the counter) — the cutout is smaller than the basin; a rim
    flange rests **on top** of the slab and reads as a visible lip. The one that
    needs the cutout undersized, so it is the one that catches a sign error.
  - `undermount` (in the counter) — the cutout **is** the bowl opening, the basin
    hangs below it, and the slab's cut edge is the visible edge. The slab has to
    show polished thickness at the cut, which means the extrude needs its side
    faces, not just a top.
  - `farmhouse` / apron-front — the basin carries a **thick front apron** that
    replaces the cabinet front below it. So it is not only a counter cutout: the
    run member beneath it loses its top rail and its front, and that makes it a
    Phase 3 dependency, the same as the built-in fridge. Reveal above the apron
    is a field (`apronReveal`), because flush and proud both get built.
  - `vessel` (a bath basin standing **on** the counter) — the bowl sits wholly
    above the slab and there is **no bowl cutout at all**, only a ~1.75in hole
    for the drain tailpiece. Same cutout code, a much smaller circle. Two things
    make it more than a placement flag:
    - **The slab has to drop.** A vessel adds 5–7in above the deck, so a vanity
      carrying one sits at 30–32in, not the 34.5in standard, or the rim lands at
      40in and is unusable. So `mount: vessel` implies a counter height, and the
      run needs to be told rather than left at its default. This is the single
      thing that goes wrong with vessels in real life, and it should be a
      constraint in the model, not a note in a doc.
    - **Wall clearance and the faucet.** A vessel needs a tall vessel faucet or a
      wall-mounted one, and either wants deck space or wall behind it that a
      drop-in does not. Worth carrying `deckClearance` even before faucets exist,
      because it is what decides whether the basin can sit tight to the wall.
  - `semi-recessed` — half in, half proud, the bath case between vessel and
    drop-in. Falls out for free once vessel exists: it is `vessel` with the
    cutout reinstated and a `dropDepth` field saying how far in it sits.
  - `integral` / moulded — the basin and the vanity top are **one piece** in one
    material, with a coved transition and no rim anywhere. Not a cutout at all;
    the counter builder owns the basin instead of the sink builder placing it.
    Cheap to add and very common on a bath vanity, but note it inverts the
    ownership, so build it after the other five rather than alongside them.
- **`shape`**: `rect` | `round` | `oval`. Kitchen sinks are rectangles; bath
  vessels are usually not, and this is a real geometry fork, not a parameter.
  - A rectangular basin is panels, like a carcass.
  - A round or oval one is a **`LatheGeometry` over a wall-section profile** —
    revolve a profile that runs down the outside wall, across the floor and back
    up the inside, and radius, wall thickness, floor slope and rim roll all come
    out of the one profile in one call. Oval is the same lathe scaled on one
    axis. This is the right primitive and it is less code than the box case.
  - Bath basins are also a different size class: 14–20in across and 5–6in deep,
    against a kitchen sink's 30–36in wide and 9–10in deep. Separate defaults per
    shape, or every vessel arrives as a trough.
- **`material`** comes out of the Phase 0b library, and they differ in ways
  the PBR values already carry, not in geometry: `fireclay` / ceramic (near-white,
  roughness ~0.25, thick 1in walls and a soft radius), `stainless` (metalness 1,
  roughness 0.35 — brushed, so anisotropy-ish streaks in the map, and thin 2mm
  walls with a tight corner radius), `composite-granite` (matte, roughness 0.7,
  speckle map), `enamel-cast-iron` (glossy, roughness 0.1, thick walls).
  Vessels add the ones a bath uses and a kitchen does not: `glass` (needs the
  same transparency decision as the Phase 5 glazing, so settle it once and share
  it), `stone` (honed marble or granite, thick walls, roughness ~0.4) and
  `copper` / hammered (metalness 1, a normal map doing all the work).
  Stainless is the one to build first: it is the only one where wall thickness is
  visibly thin, so it proves the basin is real geometry and not a box.
- **`bowls`** is a width split, exactly like `run.widths` — `[1]` single,
  `[0.5, 0.5]` a 50/50, `[0.6, 0.4]` an offset double. A divider panel per
  interior boundary, and the divider height is a field (full or low-divide).
  Rectangles only: a round basin is single by construction, so the field is
  absent rather than `[1]` for those.
- **`ledge`** adds the workstation rail step inside the rim, which is one inset
  ledge box per side and worth having because it is what most new sinks are.
  Rectangles only, same reason.

Basin geometry forks on `shape`, and both halves are small. A rectangle is a box
with an inset bottom and a small corner radius, drawn as panels the way a carcass
is: four walls at the material's thickness, a floor sloped a few mm to the drain,
and a drain disc. A round or oval one is the lathe above, where the slope and the
thickness are already in the profile. Sloping the floor costs nothing either way
and is the difference between a basin and a hole.

### Phase 3 — runs

A **run** is a container: an ordered member list sharing a wall edge, a depth, a
counter and a material set. `run.widths = [24, 21, 30, 24]` compares against
`[36, 36, 27]` and you watch the divisions appear. One merged mesh, one counter
slab spanning it. This is where most of the list arrives as fields rather than as
features:

- counter depth and overhang — `run.counterDepth`
- upper depth and height, independently of the base run
- `run.topTreatment`: `to-ceiling | gap | soffit | stacked`
- `mount`: `wall | to-ceiling | soffit | floating-shelf` — "built in vs free
  hanging"
- floating drawers: a member with `floatHeight` and no toe kick
- an **`appliance-slot` member** reserves width without being a cabinet. This is
  how the range, dishwasher and built-in fridge get counter and face alignment
  for free instead of each solving it alone.

### Phase 4 — appliances

All one `kind: "appliance"` with a `subkind`, because they are all a box with a
face treatment and a size that has to be honest:

- **range**: 30/36in, slide-in vs freestanding, gas grates vs electric coils
- **fridge**: freestanding vs built-in / panel-ready (flush with the cabinet
  face — which is a `run` question, hence the ordering)
- **dishwasher**: 24in, panel-ready vs stainless. Absent entirely today.
- **microwave** with a `mount`: `counter | in-cabinet-shelf | over-range |
  drawer`. Over-range claims an upper slot and replaces the hood.
- **vent hood**: `under-cabinet | wall-chimney | island | downdraft |
  microwave-integrated`, width tied to the range, `ductless` flag.

### Phase 5 — windows and doors

Same builder machinery, and the wall already cuts the hole.

A window is: rough frame, jamb liner, sash frame(s), one glass plane, optional
operator hardware, and **optional grille** —
`grille: {pattern: none|colonial|prairie|craftsman, rows, cols}` as thin bars
across the glass. That field is "with or without mouldings in the glass".
Types = sash count plus divide direction: fixed, single/double-hung, casement,
slider, awning, picture.

Sizing is `width` / `height` / `sillHeight`, plus a `fullHeight` flag that pins
the head to the wall top and the sill to the floor.

**One opening builder, not two.** A sliding patio door settles this: it reaches
the floor, so it is a door (type 7, `InWallFloorItem`), and it is mostly glass, so
it needs the sash, glazing and grille work above. Build windows and doors as one
`opening` builder with `reachesFloor`, `glazed` and `operation` as fields, or the
patio slider forces the glazing code to be written a second time inside the door
builder. Same reason `casing` and `jamb liner` belong to the opening rather than
to either.

**`operation`** is the axis the whole door question turns on, and it is
independent of the slab style and of whether it is glazed:

- `swing` — one leaf, `hand: left|right`, `openFraction` 0..1. What exists today.
- `french` — two swing leaves meeting at the middle, each with its own hand.
- `bypass` (sliding closet) — **two leaves offset across the wall thickness**,
  overlapping along it, on a track header. The signature to get right is that a
  bypass **never clears more than about half its opening**: one leaf is always in
  front of the other. A slider drawn as one leaf sliding fully clear looks wrong
  immediately and is the usual mistake.
- `sliding` / patio — the same bypass geometry at door scale and glazed, usually
  one fixed panel and one operable, with a wide sill track and a much heavier
  frame than a closet slider. 60/72/96in wide, and it is the one opening in the
  house big enough that Phase 6 daylight will notice it.
- `pocket` — slides **into the wall**, and this is the only door that constrains
  its wall rather than just occupying it. It needs a cavity: roughly `2 x leaf
  width` of wall to one side, and a wall thick enough to hold a leaf — about
  4.5in finished. Since thickness is per-wall and traced face to face, the app
  can actually **check this and refuse**, rather than letting somebody put a
  pocket door in a 3.5in partition and find out on site. Worth doing: it is a
  cheap validation and the information is already in the model.
- `bifold` — leaves folding to a stack at one jamb, so the visually interesting
  state is half open. Leaf count 2 or 4.
- `barn` — **not an in-wall item at all.** The leaf hangs on the wall *face* on a
  track above the opening and slides clear beside it, so the opening itself is a
  `cased` opening and the door is a `WallItem` overlapping it, needing clear wall
  to one side. Do not try to make it type 7; it will fight `boundMove` and the
  hole-cutting both.

`openFraction` earns its place here more than it does on a swing door: it is how
you check that a slider actually leaves a path through, and for a bypass it is
what shows that half the opening is never available.

**No door in this app has ever stood open, and there were three reasons stacked
on top of each other.** ✅ **Done** — doors are generated, see
`src/scripts/items/generated/door.js`. Kept here because the diagnosis is the
expensive part and the same three shapes will recur for windows:

1. **`open_door.glb` contains no open leaf.** Measured off the file, its bounding
   box is 97.1 x 221.58 x **7.62cm**. A 32in leaf swung 90° projects about 81cm;
   this projects 3.8. Set beside `closed-door28x80_baked.glb` at 97.1 x 221.58 x
   8.04, the pair is a frame and a frame-with-slab — not open and closed. The
   `OPEN_DOOR` comment in `extract.py:317` describes a door "hinged at its own -x
   end and swinging toward -z", and the geometry does not do that.
2. **`scale_z` would flatten a real one anyway.** `items_for` sets
   `scale_z = thickness_cm / spec["d"]` to make the item span its wall. Give it a
   model whose depth includes an 81cm swung leaf and it scales z by `7.7/89`,
   squashing the leaf to under a centimetre and smearing it into the wall plane.
   So a correct asset would look *worse* under the current rule, which is the
   resize-by-stretching antipattern this plan rejects everywhere else.
3. **An in-wall item is assumed symmetric about the wall.**
   `InWallItem.getWallOffset()` returns `-edge.offset + 0.5`, and `boundMove`
   pins `vec3.z` to it — the item's origin sits on the wall centreline. A door
   that is frame-in-the-wall and leaf-in-the-room is inherently asymmetric, so
   centring its bounds on the wall buries half the swing inside it.
A **fourth cause was proposed and was wrong**, and it is recorded because the
mistake is the instructive part. The claim was that `opening_truth.py` discards
the handing the way it discards the slider. It does not: `read_handing` at
`opening_truth.py:232` reads the arc's bounding box — a square whose side is the
door's width with one corner at the hinge — and sets `hinge` and `swing`, and
`build.py:64 mark_exterior` sets `exterior`. Seven of the ten doors get a
handing. What actually misled: `data/design.json` was written **before** the
commit that added all that, so every door in the file on disk was a closed model
and looked like a pipeline that had never carried handing at all. **A stale
artefact is not evidence about the code that generates it** — regenerate first,
then read.

### How it was fixed

- **Both frame and leaf are generated**, so cause 1 and cause 2 stop existing:
  nothing is scaled, the frame is handed its wall's measured thickness and built
  to fit, and `scale_x/y/z` are all 1. The traced plan's walls run 7.7 to 19cm
  and each door now fills its own.
- **The leaf is a child on a pivot at the hinge jamb**, so opening is one
  rotation of one node — which is why `openFraction` is continuous and can be
  animated later for nothing.
- **Children are excluded from the item's bounds for free.** `Item.bounds()`
  reads `this.geometry.boundingBox` and nothing else, so the leaf and the casing
  are already invisible to the three things that must not see them: the wall hole
  (`edge.js:479`), the along-wall drag clamp (`boundMove`), and the across-wall
  centring (`getWallOffset`). Cause 3 needed no code. The item's own geometry is
  exactly the rough opening, which is the hole a carpenter frames.
- **`hand` and `swing` are spec fields**, so all four handings are reachable
  rather than the two a rotation could reach. That limit was never really about
  rotation anyway: `WallItem.changeWallEdge` overwrites `rotation.y` from the
  wall normal the moment an item binds, so a saved swing side did not survive
  binding.
- The **exterior doors stay shut** — 5 of 10 open on the traced plan: 5 interior
  swinging doors open, 2 exterior shut, 3 bypass sliders and cased openings shut
  because they have no handing to draw.

**The handing had to move out of the item's frame.** `hand` and `swing` were
first resolved in the item's own axes, and that is wrong for a reason worth
keeping: a wall has two half edges, `WallItem.changeWallEdge` sets `rotation.y`
from whichever one the item binds to, so two doors with identical specs come out
rotated 180 degrees apart. Measured — `door-7` and `door-9` were both `lo`/`in`
and their leaves landed at world dz +35.9 and -28.9. Both fields are now stated
in **plan** axes and resolved at bind time through a new `Item.onBound` hook.
Note the two axes need resolving *independently*: rotating by theta sends local
+x to world `(cos, 0, -sin)` and local +z to `(sin, 0, cos)`, which carry
opposite signs on a wall running along world z. One flip is right on horizontal
walls and wrong on vertical ones.

**An opening with no swing arc gets no leaf.** `operation: 'cased'` builds the
lined opening and stops. Drawing a single slab across a 48.7in bypass closet —
which is what "every door is a door" produced — makes an opening read as a wall.

Glass: try `transparent, opacity 0.15, roughness 0.05` before reaching for
`MeshPhysicalMaterial.transmission`, which costs a render target. A/B it against
the parity grid. Settle it once here — the Phase 2 glass sink bowl and any glass
cabinet front want the same answer.

**The tracer already knows about sliders, and then forgets.** Worth fixing while
Phase 5 is open, because the drawing has the information and the app is about to
be able to hold it:

- `openings.py:72 sliders()` separates a bypass from a window by the thing that
  actually separates them — the two leaves are **offset across** the wall
  (`SLIDER_OFFSET_IN = (1.2, 4.5)`) and overlap along it, where glazing lies on
  the centreline and runs jamb to jamb. That test belongs to the superseded
  lattice tracer and **was not carried forward**.
- `opening_truth.py:204` has no slider case at all: swing arc → `door`, else
  glazing ≥ **0.6** of the span → `window`. A bypass slider measures **0.77**
  covered (README, and the leaves sit within the `thickness` band the glazing sum
  tests), so a closet slider classifies as a **window**. `data/opening_truth.json`
  is 9 windows and 10 doors with no third kind, so this is worth re-checking by
  eye against `opening_truth.png` before trusting either count.
- `extract.py:564 items_for()` then collapses whatever survived:
  `spec = WINDOW if kind == "window" else DOOR`. Every non-window becomes a
  swinging `closed-door28x80`, which is why all 10 doors in `data/design.json`
  are the same model.

So: port the offset test into `opening_truth.py`, add `slider` and `cased` to the
kinds `items_for` can emit, and have it write an `operation` into the item spec
instead of picking one of two models. Per `AGENTS.md`, check the change on a
LayOut sheet as well as the Southern Integrity one — and re-render, because a
count will not show a slider that moved to the wrong wall.

### Phase 6 — lighting

The biggest single visual win, because three lights is all there is today.

- `model/light.js` — a fixture is data: `{mount, throw, position, target, kelvin,
  lumens, beamAngle, on, group}`.
  - **`mount`**: `recessed | surface | pendant | rod | wall | under-cabinet |
    in-cabinet | toe-kick`. **`throw`**: `down | up | both | diffuse`.
  - Two axes rather than one long `kind` enum, because the real fixtures cut
    across them: a pendant and a sconce differ only in mount, a downlight sconce
    and an uplight sconce only in throw. One enum would need an entry per
    combination and would still miss one.
- `three/fixtures.js` — one three light per fixture. Cans and pendants are
  `SpotLight` / `PointLight`; a strip is a short row of small emitters. An `up`
  or `both` throw is a second emitter aimed at the ceiling, not a flag.
- **A fixture record must nest.** Not only top-level in `lights: []` — a ceiling
  fan with a light kit is one placed object carrying a fixture, and so is an
  in-cabinet puck or a range hood's work light. Decide this on day one of the
  phase; retrofitting nesting later means touching every reader.

**Wall sconces.** Placement is already done: `Lampwall` is type 2, and `WallItem`
binds to a wall edge and rotates itself to that edge's normal. Three things to
get right, none of them the light itself:

- **`throw` matters more here than anywhere else.** Up washes the ceiling and
  lifts the whole room, down scallops the wall in a cone, both is a shade open at
  both ends. Same fixture, three completely different rooms — which is the
  argument for `throw` being a field on every fixture rather than a sconce
  special case.
- **Mounting height is a real input, not a derived one.** 60–66in general, ~40in
  flanking a mirror so it lights a face rather than a forehead, 72in+ for
  uplight. Good news: `WallItem.boundMove` deliberately has no upper clamp (the
  comment says why — it would pin every wall item to one height and stop it
  following a sloped wall), so dragging a sconce up a wall already works.
- **The shade has to be emissive.** A sconce is the fixture most likely to sit at
  eye level in frame during a walkthrough, so the *object* is on screen as much
  as its light is. A lit shade with no `emissive` reads as a dark blob against a
  bright wall and looks broken, which no amount of correct illumination fixes.
  Also expect shadow acne: a light this close to the surface receiving it is
  nearly coplanar with it, the worst case for a shadow map, so `normalBias` will
  want tuning per mount rather than the one global 1.5 studio sets today.

**Ceiling fans.** The one item on the list that is three features in one hat, and
the only one that needs 0d.

- **Hugger vs downrod is a `mount`, and the ceiling picks it.** Flush for an 8ft
  ceiling, a 6–12in rod at 9–10ft, longer above that. Two clearances are worth
  enforcing rather than documenting, because a fan that violates them is wrong in
  a way a render will not show: blades no lower than ~7ft off the floor, and
  8–10in of air above them or the fan moves nothing.
- **The light kit is a nested fixture**, with its own kelvin and lumens — see the
  nesting note above. This is the case that proves it, and `Ceilingfan` and
  `Chandelier` are both already type 4 sitting on the ceiling plane emitting
  nothing, so the two arrive together.
- **The blades turn, and this is the only animation in the app.** Rotate the
  blade *group's* Y, never the geometry. Three speeds, and reverse for winter
  because it is one sign flip. Two cautions:
  - **Blades must not cast shadows.** A rotating shadow-caster restrobes the
    whole room every frame and updates a shadow map every frame to do it. It
    looks terrible and it is the expensive half.
  - **Pick speeds that do not beat against 60fps.** Blade count times revolutions
    per second landing near a multiple of the frame rate gives the wagon-wheel
    effect — blades crawling backwards. Motion blur is out of scope, so the fix
    is choosing the numbers.
- Parametric parts, if fans get a spec: blade count (3/4/5), span (44/52/60in),
  blade pitch and finish, rod length, light-kit presence. Blade geometry is one
  tapered box or a lathe-free extruded profile, instanced around the hub — so the
  blades are nearly free and the hub is the only real modelling.
- **Shadow budget is the real constraint.** A dozen shadow-casting spots will
  not run. Cap the casters (default 4, exposed as a setting), pick them nearest
  the camera, and let the rest light without shadowing.
- `toneMappingExposure` as a slider, so comparing two fixtures is not confounded
  by tone mapping.
- Persist as a new top-level `lights: []` block. A light is not a mesh and should
  not be dragged through the GLB loader to pretend it is.
- Day/night: the existing key light becomes a sun with azimuth and altitude from
  time of day; windows admit a daylight patch; hemisphere drops at night.

### Phase 7 — takeoff

Falls out of Phases 2–4 with no new model work: the specs *are* the schedule.
Walk the runs, emit stock nomenclature, price against more than one system.

---

## Order, and why

```
0 spine ──┬── 1 half walls          cheapest; splits kitchen from great room
          ├── 2 cabinets + counters the point of the app
          │      └── 3 runs
          │            └── 4 appliances   built-in fridge needs face alignment
          ├── 5 windows + doors
          │      └── 6 lighting     daylight needs windows
          └── 7 takeoff             reads the specs from 2-4
```

Phase 5 can move ahead of 2 if the walkthrough needs to stop looking wrong
sooner — every window in the traced plan is a stretched mesh right now.

Three things in Phase 2 reach forward into Phase 3 and land there instead: a
**farmhouse sink**, because its apron replaces the cabinet front beneath it; a
**built-in fridge**, for the same reason; and a **vessel sink**, because it
dictates the height of the counter it stands on. Drop-in and undermount sinks are
wholly Phase 2 — they only touch the slab.

That last one is the general shape of the coupling worth designing for: a sink
that constrains its counter, and a counter that constrains its run. Better as one
rule the run enforces than as three builders each guessing.

Phase 5's **pocket door** is the same shape one level up — an item that
constrains its *wall* (thickness, and clear length for the cavity) rather than
merely sitting in it. Worth building the two against one mechanism: an item may
declare requirements of its host, and the host validates them. Two cases is
enough to see the pattern and few enough to keep it simple.

Phase 0d — the frame tick — is needed by exactly one thing, a turning fan blade,
so it can be deferred to Phase 6 without holding anything up. It is listed in
Phase 0 only because it is shared infrastructure rather than fan code, and it is
the kind of thing that grows into an animation system if it is written in a hurry
inside a feature.

The extractor's unbuilt stages 5 (FIXTURES) and 6 (CABINETS) come **after** the
app side, not before: they need a spec to emit into, and `AGENTS.md`'s first rule
is that each stage consumes the one above and nothing else.
