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
| Window types | Generated: fixed, picture, single/double hung, casement, slider, awning | **Done** |
| Muntins / grille in the glass | `grille: {pattern, rows, cols}` — none/colonial/prairie/craftsman | **Done** |
| Window width / height | Generated: `width`/`height`/`sillHeight` in the spec, nothing scaled | **Done** |
| Floor-to-ceiling windows | `fullHeight` — the item asks its wall how tall it is | **Done** |
| Door width / height / style | Generated: `width`/`height` in the spec, and `leaf` — flush, two-panel, six-panel, glazed | **Done** |
| Sliding patio door (glazed) | `operation: sliding` — bypass geometry at door scale, glazed, on a sill track | **Done** |
| Bypass closet doors | `operation: bypass` — two leaves offset across the wall, clearing half the opening, and `opening_truth.py` now separates one from a window by the leaves' offset | **Done** |
| Pocket door | `operation: pocket`, and the wall is checked for thickness and run — it can refuse | **Done** |
| Bifold closet doors | `operation: bifold`, 2 or 4 panels, folding along the head track | **Done** |
| Barn door | `operation: barn`, as a type 9 `WallFloorItem` on the wall FACE — its track is its bounds | **Done** |
| Door open / closed state | Generated: `openFraction` 0..1, hinged leaf on a pivot. `open_door.glb` held no open leaf — 7.62cm deep | **Done** |
| Ceiling lights | `Chandelier`, `Ceilingfan` and `Lampsquareceiling` now carry a fixture and emit | **Done** |
| Any placeable light | `model/light.js` — mount x throw, kelvin, lumens, beam; `three/fixtures.js` builds the emitters | **Done** |
| Colour temperature | `kelvin` on every fixture, through `core/color_temperature.js` | **Done** |
| Wall sconces | `Lampwall` carries a `wall`-mount fixture and lights its shade | **Done** |
| Sconce uplight / downlight | `throw: up \| down \| both \| diffuse`, and `both` is two emitters sharing the output | **Done** |
| Ceiling fans | `Ceilingfan` is type 4 (`ceilingFan.gltf`) — emits nothing, and does not turn | No |
| Fan: hugger vs downrod, light kit | — | No |
| Anything animated | The render loop is continuous (`three/main.js:513`) but there is **no clock** — no `AnimationMixer`, no `Clock`, no `getDelta` in `src/` | No |
| Base cabinets | `Kitchencabinet` (Kenney, fixed width) | No |
| Cabinet width, parametric | `Item.resize()` → `setScale(x,y,z)` (`items/item.js:436`) | No — cause A |
| Cabinet material | Per-material **colour tint only** (`setMaterialColor`) | No |
| Door front style | — | No |
| Counter depth / cabinet depth | Mesh stretch | No |
| Upper cabinet depth / height | 4 fixed Kenney uppers | No |
| Countertops | `generated:counter` — slab, edge profile, backsplash, cutouts | **Done** |
| Counter around a corner | One rectangle; `slabShape` draws four points | No |
| Corner cabinet (blind, susan, corner drawer) | — | No |
| Cabinet with an exposed end or back (island, peninsula) | Draws a ply back and a raw ply side, always | No |
| Floating drawers (no toe kick) | — | No |
| Sinks | `Kitchensink` is a **floor item** — it does not cut a counter | No |
| Sink mount: on-counter / in-counter / farmhouse / vessel | — | No |
| Round or oval basins (bath vessels) | `Bathroomsink`, `Bathroomsinksquare` — fixed meshes | No |
| Sink material: fireclay, stainless, composite, enamel, glass, stone, copper | Colour tint on one mesh | No |
| Range / cooktop | `generated:appliance`, `subkind: range` — freestanding vs slide-in, gas grates vs electric rings | **Done** |
| Fridge, built-in vs freestanding | `subkind: fridge`, plus four door layouts | **Done** |
| Vent hood | `subkind: hood` — under-cabinet, wall chimney, island, downdraft, `ductless` | **Done** |
| Microwave: counter / in-cabinet / over-range | `subkind: microwave`, four mounts; over-range grows a vent and lights | **Done** |
| Dishwasher | `subkind: dishwasher`, front or hidden controls. Was absent from the catalog entirely | **Done** |
| Panel-ready appliance fronts | The face is built by `cabinet.js`'s own `frontPanel`, in the run's profile | **Done** |

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

**Cabinets, counters and sinks are built.** `generated:cabinet` (base / wall /
tall, face-frame or frameless, slab / shaker / raised fronts, doors and drawer
banks, knob or pull), `generated:counter` (slab, edge profile, backsplash,
cutouts) and `generated:sink` (five mounts, rect / round / oval, bowl splits,
material-driven wall thickness). **Appliances too** - see phase 4, which was
built here rather than after runs, because only the built-in fridge's face
alignment actually waited on a run and the other four did not.

The sink confirmed the design the audit argued for: **five mounts are one
builder**, differing only in where the rim sits against the slab plus at most one
extra piece — a flange for a drop-in, an apron for a farmhouse. Nothing else.

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

#### 3a. Corners, and the cabinet that is not simply against a wall

An L kitchen is two runs meeting, and the corner is where every assumption in
`cabinet.js` runs out. The builder assumes **exactly one face is the front and
everything else is buried**: a back in carcass ply, two raw ply sides, and a full
face carrying doors across its whole width. Three cases break that, and the
corner is the one that breaks it hardest.

**The blind corner.** Where two base runs meet, one run's end cabinet is
*blind*: the other run butts its side into that cabinet's face, so part of the
face is behind the adjacent run and can carry nothing. Two things follow, and
both are the neighbour's numbers rather than the cabinet's own:

- **The blind portion is blank.** No door, no drawer front, no pull — a filler
  panel or nothing at all, because it is behind the other run. A door drawn there
  opens into a carcass. Today `carcassAt` divides the whole opening into doors
  and has no way to say "this much of the width is not face".
- **The blind width comes from the ADJACENT run's depth**, not from this
  cabinet. It is that depth plus a filler — typically 3in — so the door beside it
  can swing clear of the other run's face frame and its hardware.
- **And the depth has to match the adjacent run's depth.** If it does not, the
  two faces step at the corner and the counter above cannot be one slab. This is
  the thing to get right first: it is one number, it is not the cabinet's own,
  and everything visible at the corner depends on it.

The other two corner solutions are worth naming now so the field is not designed
around only one of them: a **corner susan**, whose front is a 45° angled face
across the corner and which is therefore not a rectangle in plan; and a **corner
drawer** unit, whose drawers run diagonally. Both are still "one cabinet spanning
the corner", so they belong to the same member rather than to a new kind.

**The exposed end and the exposed back.** The same assumption, one step out. A
run that ends in open floor shows a raw ply side where a finished end panel
belongs, and an island or peninsula shows a ply back — or wants doors on it,
which is a peninsula's whole point. Neither is expressible today.

**Why this settles the requirements mechanism rather than just using it.** The
roadmap already wants one rule — an item declares requirements of its host and
the host validates — with the farmhouse sink and the pocket door as its two
cases. Both of those are a child constraining its *container*. The corner is a
third shape and the one that decides the design: a cabinet in run A needs a
number that belongs to run B, so it is **peer to peer, not child to host**. Two
cases were enough to see a pattern; this is the one that says whether the pattern
is general or whether it was only ever "ask your parent".

**The counter turns the same corner**, and that half is nearly free: an L outline
is six points instead of four, `ShapeUtils.triangulateShape` handles the concave
polygon, the bullnose bevel survives the reflex vertex without self-intersecting,
and a sink cutout still cuts — measured at exactly the requested overall size.
Two things it does need: the bevel inset must be applied **per edge** rather than
by shrinking half-extents, which is a rectangle-only shortcut, and the backsplash
has to follow the back edges round instead of being one box. Butting two
rectangular counters instead leaves the two splashes stopping short of each
other, with an open notch at exactly the inside corner where a real kitchen has a
continuous return.

### Phase 4 — appliances ✅

Built. All one `kind: "appliance"` with a `subkind`, because they are all a box
with a face treatment and a size that has to be honest:

- **range**: 30/36in, freestanding (with a backguard) vs slide-in (with a front
  control band), gas grates vs electric rings on ceramic
- **fridge**: freestanding vs built-in / panel-ready, and four door layouts —
  french, side-by-side, top-freezer, bottom-freezer
- **dishwasher**: 24in, front controls or hidden. Absent from the catalog before
  this.
- **microwave** with a `mount`: `counter | in-cabinet | over-range | drawer`
- **vent hood**: `under-cabinet | wall-chimney | island | downdraft`, with a
  `ductless` flag that stops the flue short of the ceiling

The design claim is the sink's, one level out: **five appliances are one
builder**. There is one `faceRects` that divides the front into panels, one
`facePanel` that builds one, one `barHandle`, and a short `extras` per subkind
for the things that genuinely are extra. The face layout IS the difference
between these objects, and it is a list of rectangles.

**Panel-ready is not a colour.** `finish: panel-ready` builds the face with
`cabinet.js`'s own `frontPanel`, in the run's shaker / slab / raised profile —
which is what panel-ready means, and the reason `frontPanel` is now exported.
A white box would have been the one thing this app exists not to do.

Five things the work turned up, and **four of them were invisible to every
number**. A vertex count said each part existed; the offline render said where
it was:

- **The hood's filter was inside its own canopy.** A canopy is a solid, so
  setting the filter where a real one sits swallowed it whole: the render from
  below showed a blank cap. It hangs proud now.
- **The over-range microwave's vent baffles were inside the carcass**, one
  centimetre up. Same shape of error, same only-visible-from-below place.
- **The gas grates fell between the burners.** Bars spread evenly across the
  width rather than over each burner column gave five stripes and four dots.
  Nothing about a bar's dimensions says whether there is a burner under it.
- **A chimney hood's flue overhung its canopy and stood on nothing.** A frustum
  is symmetric by construction and a wall hood is not, so the canopy's top ring
  is sheared back to put its rectangle at the wall. `CylinderGeometry` with four
  radial segments is that frustum in one call — the same trade the sink's lathe
  makes.
- **The reveals did not read.** On a stainless machine the body behind the
  fronts is stainless too, so a cabinet's 1/8in gap between two panels rendered
  as one unbroken sheet. Appliance door gaps are wider in life and are wider
  here, over a dark liner — the gasket line you actually see.

And the tests had to be told the same thing twice: materials pool BY NAME, so on
a stainless appliance the body, the face and the handles arrive as ONE merged
group. Six of the first measurements were reporting the whole object. The specs
under test hand the part being measured its own material, which is the note
already standing on `cabinets.test.js`.

`microwave-integrated` is **deliberately not a hood style**. It is not a shape —
it is an over-range microwave and the absence of a hood, which is a decision
about what occupies the slot above the range. Phase 3's run is what will refuse
to put both in one slot; the microwave's `over-range` mount grows the vent and
the underside lights that make it able to do the job.

### Phase 5 — windows and doors

Same builder machinery, and the wall already cuts the hole.

**The windows are done.** ✅ `src/scripts/items/generated/window.js`, and the
glazing they need lives in `items/generated/opening.js` beside the door's, which
is the "one opening builder, not two" below reduced to its actual content: the
box primitive, the plan-space handing, the casing that laps both wall faces, and
the sash. `door.js` and `window.js` are now only the part that differs — which
members make up the lining, and what moves. The patio slider can therefore be a
door that reaches the floor and is glazed, with no glazing code written twice.

A window is: rough frame, jamb liner, sash frame(s), one glass plane, optional
operator hardware, and **optional grille** —
`grille: {pattern: none|colonial|prairie|craftsman, rows, cols}` as thin bars
across the glass. That field is "with or without mouldings in the glass".
Types = sash count plus divide direction: fixed, single/double-hung, casement,
slider, awning, picture.

Sizing is `width` / `height` / `sillHeight`, plus a `fullHeight` flag that pins
the head to the wall top and the sill to the floor.

#### What it took, and the four things that were wrong

The measurements were all green while three of these were true. Every one was
found by rendering the thing and looking at it, which is the rule this repo
keeps for exactly this reason.

- **A window is the first generated item whose POSITION is part of what it is.**
  A door's is not: it stands on the floor and `WallItem.resized` re-seats it
  there. A window sits at its sill height, and there was nowhere to put that
  number — `extract.py` baked `ypos: 157` and the height lived only in a mesh
  scale. So `sillHeight` is a spec field, `onBound` applies it, and a new
  `Item.onPlaced` — the other direction of `onBound`, called from
  `WallItem.moveToPosition` — writes it back when somebody drags the window up
  the wall. One direction alone means the panel and the mouse hold two different
  numbers and the next bind silently discards the drag.
- **`fullHeight` is the item asking its host a question**, and it is the
  smallest instance of the phase 3 mechanism: the height a floor-to-ceiling
  window wants belongs to the *wall*, so `onBound` reads it off the wall it just
  bound to and rebuilds through `setSpec`. It is also the hole trap at the other
  end of the wall, as promised above — and the test for it **had to be forced**.
  Built to exactly the wall height the float32 bounding box rounded the safe way
  and the hole was cut with `HOLE_INSET` disabled, so the regression only proves
  anything when the head is pushed three microns past the wall top deliberately.
- **The handle was authored in the frame's coordinates**, so it stayed hanging in
  the middle of the empty opening the moment a casement swung away from it. Every
  measurement of its position passed: the triangles were exactly where they were
  put. It belongs to whatever moves, the way a door's knob is under the pivot.
- **A slider slid the wrong way** — away from the fixed sash instead of behind
  it — so the operable sash left the frame entirely and hung in free air beside
  the window. This is the mistake named below, arrived at from the other side,
  and a measurement of *travel* passes either way.
- **A double hung given both sashes the full travel simply swaps them.** The
  lower goes to the top, the upper comes to the bottom, and every part of the
  opening is still covered — `openFraction: 1` rendered indistinguishably from
  shut. Half the travel each is what leaves a gap at the head *and* at the sill,
  and it is also how the thing is used.
- And one that is only a detail: **a full-height window has nowhere to put head
  or sill casing.** Casing stands proud of the opening by its own face width, and
  the opening already fills the wall, so both runs land inside the ceiling and
  under the floor. `buildCasing` takes `top` and `bottom` now; a door has no
  bottom run because it stands on the floor, and a floor-to-ceiling window has
  neither.

`tools/extract.py` writes `generated:window`, so the sample sheet's eight
windows arrive at five different widths with the same stiles. **This is one of
the two-implementation changes `AGENTS.md` warns about and only the Python side
has it** — `app/src/app/import/design.js` still writes a scaled
`whitewindow.glb`, and porting `window_item` across is a small, mechanical job
left for whoever owns that file.

**One opening builder, not two.** A sliding patio door settles this: it reaches
the floor, so it is a door (type 7, `InWallFloorItem`), and it is mostly glass, so
it needs the sash, glazing and grille work above. Build windows and doors as one
`opening` builder with `reachesFloor`, `glazed` and `operation` as fields, or the
patio slider forces the glazing code to be written a second time inside the door
builder. Same reason `casing` and `jamb liner` belong to the opening rather than
to either.

**`operation`** is the axis the whole door question turns on, and it is
independent of the slab style and of whether it is glazed:

- `swing` — one leaf, `hand: lo|hi`, `openFraction` 0..1.
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
  hole-cutting both. Built as a type 9 `WallFloorItem` — a `WallItem` that stands
  on the floor — which is the class that was already there for it.

`openFraction` earns its place here more than it does on a swing door: it is how
you check that a slider actually leaves a path through, and for a bypass it is
what shows that half the opening is never available.

#### What the operations took, and the five things that were wrong

**All eight are done.** ✅ `src/scripts/items/generated/door.js`, with the leaf
itself in `opening.js` beside the sash, because **a glazed leaf IS a sash** — a
french door and a patio slider are stiles, rails, one pane and a grille at door
scale, which is `buildSash` exactly. That is the "one opening builder, not two"
rule paying for itself a second time: the patio door needed no glazing code.

`leaf` — `flush | two-panel | six-panel | glazed` — is orthogonal to `operation`
and reaches all seven operations that have a leaf. The operation supplies its own
defaults for the two cases where the word means the glass (`french` and
`sliding` are glazed unless the spec says otherwise), which is what keeps
`operation` the single field anybody actually sets.

The measurements were green while four of these were true. Every one was found by
rendering the thing and looking at it.

- **Hardware proud of both faces makes two passing leaves intersect.** A bypass
  leaf carries a finger pull, and a pull standing 6mm off the inner face of each
  leaf put the two leaf assemblies 0.8cm *through* each other at the 2mm track
  clearance — with both leaves correctly placed, correctly offset and correctly
  sized. This is why real bypass hardware is *recessed*, and a recess is the one
  thing a box cannot be, so the pull goes on the face nothing passes in front of.
  Nothing about travel or leaf position can see this; the test that catches it
  measures the leaf bounds **with the hardware included**.
- **A barn door's pull overhung its own leaf by 7cm.** A 24cm bar placed 5cm in
  from the leading edge the way a knob is. The leaf was the right size and the
  bar was on it, so every measurement passed.
- **A barn door's geometry is honestly asymmetric**, and it is the one build here
  that is. Its track runs a full leaf width past one jamb and stops at the other,
  because that is the wall a barn door needs — so `recentre` moves the origin
  onto the geometry, **geometry and children together**. Doing it to one of them
  is the bug `docs/generated-items.md` rule 2 describes.
- **A pocket door rendered on its own is a door that has fallen off.** The leaf
  goes into the wall, and the wall is the host, so with no wall there is nothing
  to hide it and it stands in mid air beside the frame. Its catalog thumbnail
  therefore carries a cutaway stub of wall — the far half of the thickness only,
  because a whole wall swallows the leaf and leaves an empty doorway beside a
  blank panel. The same shape of limitation as the window shots needing a sky.
- **And one that was right first time and is worth stating, because it looks
  wrong until it is derived.** A bifold is *two* rotations: the outer panel turns
  θ about the jamb, the inner one turns **−2θ** about the joint between them.
  The free end then sits at `2 × panel × cos θ` from the jamb with the two z
  components cancelling **exactly**, so it runs along the head and never leaves
  the wall line. Hinged to each other with one rotation it describes an arc and
  swings into the room, which is a pair of doors and not a bifold.

**The wall's thickness now wins.** `spec.wallThickness` is baked by `extract.py`
and nothing had ever re-read it, so a door dragged onto a different wall kept the
first wall's number and its lining stopped filling its opening. `applyDoorFit`
reads it off the wall on binding and rebuilds through `setSpec` — the same shape
as the window's `fullHeight`, and the pocket check is worthless without it, since
it would otherwise be validating against a number from another wall.

**The pocket door refuses, and refusing is not rewriting.** `pocketFit` is pure:
it wants 4 1/4in of finished wall to hold the leaf, and half the opening plus the
jamb plus a whole leaf plus framing of *run* on the side the pocket is framed
into. The run is side-dependent, so it is a question about the **handing** as
much as about the wall, and `hand` is stated in plan axes — which means the
answer is only available once the item has bound and `resolveHanding` has run.
What refuses is the **drawing**: the spec is left exactly as the user wrote it and
the leaf is drawn shut, because a leaf with nowhere to go does not open. The
reason goes to `item.specNotices`, which `SpecInspector` renders above the
fields. Silently turning a pocket door into a swing door would be worse than the
fault.

**A barn door is a type 9 `WallFloorItem`, and its track is its bounds.** Putting
the whole track — a leaf width past the opening — in the item's own geometry is
what makes "needs clear wall to one side" true with no validation code at all:
`boundMove` clamps travel along the wall by `sizeX / 2`, so the drag will not put
it where the track would run off the end. `boundToFloor` seats it by half its own
height, which is what the floor guide is doing down there. The opening it covers
is a separate `cased` item, which is what a barn door is on a drawing too.

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

#### What landed first, and what it cost

**The fixture model and the emitters are built.** `model/light.js` is the record
and every piece of arithmetic on it, and imports no three; `three/fixtures.js` is
the only file that knows what a `SpotLight` is. Persistence is a top-level
`lights: []` block plus a per-item `fixtures` array, and the four catalog lamps
the audit called "placement yes, light no" now carry one and emit.

**Nesting was decided on day one, as this section demanded**, and the shape it
took is worth stating because it is what made it cheap: a fixture's `position` is
in **its host's frame** when an item carries it, and in world centimetres when
the document does. So the emitter is added as a *child of the host object* and
the host's transform carries it — dragging a fan moves its light kit, and a
spot's target moves with it because the target is a child of the same group. The
alternative, a world position kept in step with its host by hand, is a class of
bug this shape cannot have. `collectFixtures` is the single reader both paths go
through.

**The unit trap is the one that would have cost a day.** three's point and spot
intensities are candela and its `decay: 2` falloff computes `I / d²` with `d` in
**world units** — and ours are centimetres. Feeding a real candela value into a
scene measured in centimetres makes a room 10,000 times too dark, which does not
read as a unit error: a fixture 10,000x too dim is indistinguishable from one
that is switched off. `SCENE_UNITS_PER_METRE` is the single place that converts.

**And three's 1.0 is not a photometric quantity**, so something has to say what
it means before a real lamp can be added without whiting out the frame.
`PHOTOMETRIC_SCALE` is derived from one stated reference — a 4in can, 800lm at
60°, in a 250cm ceiling, on a white floor — rather than dialled in, and there is
a test that re-derives it. **It is what 8c's composer replaces**: when tone
mapping moves off the renderer and onto a pass that takes the profile's knob,
this constant stops being a constant and becomes the exposure.

Three things came out of rendering it rather than measuring it:

- **`both` has to SPLIT the output between its two emitters.** Given the full
  lumens twice, `throw` silently doubles as a brightness control and an uplight
  cannot be compared with a downlight — they are two different bulbs.
- **A strip is a row of emitters and it matters.** One point source under a 60cm
  under-cabinet strip puts a single hard scallop on the splashback where there
  should be an even wash. Five segments over 200cm reads correctly: an even
  worktop and just-visible scallops on the wall above.
- **A fixture reads as an addition, not as the light in the room** — because the
  studio globals are already a hemisphere at `0.38π` and a key at `0.8π`, which
  puts a white floor at or over 1.0 before a single lamp is placed. A can adds a
  visible lift and cannot do more than that. **This is the argument for the
  day/night work below**, and it is why that item is worth doing sooner rather
  than last: the fixtures cannot pay off fully until the globals come down.

Also decided, and cheap because it was decided as data: `castShadow` is **per
mount**, not global. Most of these should never cast — a strip 40cm from the
worktop it lights buys nothing from a shadow map and costs a whole render of the
scene. So is `normalBias`: a sconce is nearly coplanar with the wall it is fixed
to, the worst case for a shadow map, and the one global 1.5 is tuned for a key
light three metres out. On top of that the caster set is **capped and picked
nearest the camera** (`shadowCasters`, default 4), re-chosen only on a frame that
is actually drawn — putting it above `shouldRender` would undo what that check is
for.

#### Daylight, and the control that makes the rest of it visible

Built, and pulled forward from the end of the phase for the reason the note
above gives: with the studio globals at full, a placed fixture adds a lift you
have to look for, so the phase could not pay off until the ambient came down.
`core/daylight.js` is the sun as a pure function, and a **Lighting menu** in the
top bar carries the three controls — ambient fill, daylight with a time of day,
and exposure.

**The sun is a day arc, not an ephemeris.** Sunrise at 06:00, sunset at 18:00,
the equinox everywhere, and a `heading` that turns the *building* under it. That
is deliberate: the question it answers is "which side of the house is the light
coming in, and how warm is it", and a real solar position model is a lot of
arithmetic to move a shadow a few degrees. Normalised so that **noon is the
scene as it was before daylight existed** — every other hour is a departure from
a state the parity grid already captures — and so `NOON_KELVIN` means what it is
named, which it did not until the peak altitude was divided out.

**And a raycast found the thing a render would not have.** The claim the whole
feature rests on is that a window's opening is a real hole in a wall that already
casts shadows, so a low sun throws a patch of floor. Measured on the traced plan:
with the roof as it was, **498 of 875 floor samples saw the sun — through the
ceiling**, and the window made no difference to any of them. `Floor` builds its
roof plane and has never set `castShadow`, so light rained straight down into
every room. That renders as "daylight does nothing", not as "the ceiling is
missing", which is exactly why it needed a yes/no ray rather than a picture.

The fix is a **mode, not a property**: `setSkyOpen` closes the ceilings only when
daylight is on. It cannot be unconditional — `updateShadowCamera` parks the fixed
studio key *above* the plan on purpose, because an overhead light is the cheapest
way to make every room legible, so an opaque ceiling under that key would black
out the house and change every studio frame the parity grid captures. Closed, the
same measurement gives **81 lit samples in a bounded patch**, and turning the
building 90° takes it to zero — which is a north-facing room, correctly.

#### What blocks light, and what does not

Daylight turned "which things cast shadows" from a detail into the feature, and
three separate answers were wrong in three different ways. All three read as
"the sun does nothing".

- **An in-wall item must not cast.** `Item` casts by default, which is right for
  furniture and wrong for anything filling an opening: a window that shadows its
  own hole is, to every light in the scene, bricked-up wall. The traced plan's
  nine windows are legacy `whitewindow.glb`, and `mergeMeshes` flattens frame,
  sash and glazing into ONE mesh — so there is no per-part way to let the glass
  through and every one of them sealed itself. `InWallItem.castShadow = false`.
- **`castShadow` is not inherited, so the leaf had to be told separately.** A
  door's leaf is a CHILD — that is what lets it swing — so turning the item off
  left the leaf casting nothing and a shut exterior door passed daylight straight
  through. The leaf's meshes cast; `sash-glass` does not, which is decided per
  mesh rather than per group precisely so a shut french door still admits light
  through its panes.
- **A pair of leaves needs an astragal.** Two french leaves meet on a 3mm reveal
  and daylight came through it as a vertical line on the floor. Every real pair
  carries a moulding lapping that joint, proud of one face so it does not foul
  its neighbour when the door opens. Found by measuring, not by looking.

One thing that is NOT a defect and cost time before being recognised: where two
leaves BUTT — a bifold's panels are hinged edge to edge — an analytic ray aimed
exactly at the seam passes between the two boxes. A shadow map does not, because
it rasterises depth and two triangles sharing an edge fill adjacent texels. The
sample grid is offset off the centreline rather than the millwork moved, because
moving real geometry to satisfy an artefact of the measurement is how a model
ends up shaped like its test.

#### Still to do in this phase

- **Ceiling fans**, which is the whole of the animation story and the only thing
  that needs 0d. The clock is built and idle (`three/frame_clock.js`); nothing
  turns yet. The two clearances, the blade-beat frequencies, the
  no-shadow-casting rule and the parametric blades are all still ahead.
- **A panel.** `FIXTURE_SCHEMA` is exported in the shape `SpecInspector` already
  renders, and nothing mounts it yet — a fixture can only arrive from a file or
  from a catalog lamp that carries one, and there is no way to place a bare can.
- **Windows do not admit light as glass**, only as a hole. A closed casement is
  an opening in the shadow map exactly like an open one, because the sash is a
  child and children do not cast. Right for now, wrong once 8b's `transmission`
  lands.


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

### Phase 8 — shaders and surfaces

Not a third root cause. A and B are about a room that is built wrong; this is
about a room that is built right and still looks like moulded plastic, which is
the failure left over once Phases 2–6 land.

The gap in one line: `createMaterial` (`core/materials.js:88`) builds a
`MeshStandardMaterial` from colour, roughness and metalness **and nothing
else** — no map of any kind. So `wood-walnut` is a brown solid, `stone-marble-
carrara` is a white solid, and `metal-brushed-nickel` is a grey solid that is
not brushed. Walls and floors, meanwhile, *do* carry images (`textures.json`,
five wall and two floor), which leaves the room grained and the cabinetry in it
flat — backwards, and the wrong way round for a kitchen app.

Two things hold for every part below, so they are said once here:

- **Studio only.** Classic draws walls with `MeshBasicMaterial` and builds no
  environment, so nothing here is visible under it — the same gate every Phase 6
  item carries, and the same gate the per-face paint sheen already sits behind.
- **`npm run parity` is the exit.** `tools/capture-parity.mjs` already renders
  the same states across engines and pairs the PNGs. A render change with no
  before/after in that grid is an opinion.

**8a. Maps on the material library.** ✅ Cheapest, biggest, and independent of
everything else in this phase.

Built, and four things came out differently from the sketch below. **ORM rather
than separate roughness and AO maps** - glTF's packing, so one fetch and one
upload where three greyscales would be three of each. **No normal maps**: at the
distance a cabinet is looked at, grain is a colour phenomenon, and the slot
stays in the schema for the first surface that needs relief. **Three generated
sets, not eleven authored ones** - a map multiplies the entry's colour, so one
neutral wood grain tinted by walnut and again by maple is two convincing woods,
and `tools/make-surface-maps.mjs` rebuilds all six files from a seed. **KTX2 was
not available**: `core/texture_cache.js` cannot hold a `CompressedTexture`, which
`encode-textures.mjs` had already written down, so these ship as JPEG and PNG and
get smaller for free the day that redesign happens.

The cache moved from `three/` to `core/` to make any of it possible - `items/`
and `core/` never import out of their own layer, and it is a renderer-free
resource pool that was in the renderer's directory. It also now degrades without
a DOM, because most of the suite that covers generated items runs headless.

- `materials.json` gains `map` / `normalMap` / `roughnessMap` / `aoMap` beside
  the colour, shaped the way `textures.json` already shapes a url. `createMaterial`
  grows a load path, and it goes through `three/texture_cache.js` — which already
  refcounts, and is why the wall lightmap is one decode for the scene rather than
  one per wall.
- Four earn it immediately, and Phase 2 already wrote the brief for two of them:
  wood grain; marble veining; `stainless`, whose entry asks for "anisotropy-ish
  streaks in the map"; and `copper` / hammered, "a normal map doing all the work".
- **Tiling is per slot, not per material.** The same walnut goes on a 24in door
  and a 12ft run, and at one scale one of them is wrong. `textures.json` settled
  exactly this with `stretch` and `scale`; the item side has no equivalent.
  Decide it with the first map, not the tenth.
- **The ceiling is real and has a number.** `texture-vram` measures 28.71 MB
  against a 47.34 MB limit, and an uploaded texel costs four bytes whatever the
  file compressed to — so a colour+normal+roughness set is three uploads where
  there were zero. The answer is already vendored: `npm run encode:textures`,
  gated by `npm run oracle` at RMS 3.0. Encode as they are added, rather than
  discovering the ceiling with twenty maps in the tree.

**8b. Physical materials, where the stock one cannot reach.** Still no GLSL —
`MeshPhysicalMaterial` and three parameters.

- **`clearcoat` is what a lacquer door is**: pigment under a clear film, and a
  second highlight that does not tint with the base. Today `lacquer-white` is
  `paint-white` at half the roughness and its own comment admits that is the
  entire trick. This is the honest version of it.
- **`transmission` for glass, and this settles a question deferred twice in
  writing** — once in `materials.json`'s `glass-clear` comment, once in Phase 5's
  glazing note. Both say the same thing: it costs a render target, A/B it against
  the parity grid, and the window glazing, the glass cabinet front and the Phase 2
  glass sink bowl all want one answer. Settle it here and let those three read it.
- **`anisotropy` for brushed metal** — the streak that runs along the brush
  rather than around the highlight. It needs a tangent direction, so it is a
  constraint on the panel builders' UVs before it is a material setting. Note the
  collision: `Texture.anisotropy`, which `skybox.js` already sets from
  `getMaxAnisotropy()`, is anisotropic *filtering* and an unrelated thing with
  the same name.
- **three's `sheen` is not our sheen.** Ours is roughness, named for how paint is
  sold; three's is a retroreflective fuzz lobe for cloth. Nobody should wire
  `WALL_SHEENS` to it, which is why it is written down.
- Each of these compiles a larger shader for every material that opts in. Opt in
  per entry, not per group.

**8c. The composer.** `EffectComposer` from `three/examples/jsm`, so no new
dependency — and no cost to the ESM entry either, whose `external` is
`/^three(\/.*)?$/` and already covers addon subpaths. The bytes land on
`lib-iife-gzip` (255,002 of 268,000) and `demo-js-gzip` (545,730 of 573,000),
which is thin enough that the pass list is a budget decision, not a taste one.

- **Contact shadows are the one that changes the room.** The gap under a toe
  kick and the underside of a counter overhang are exactly where a render reads
  as fake, and a 2048 shadow map cannot resolve either. An AO pass can. This is
  the single most valuable pass here and it should be built first.
- **Tone mapping has to move, and this is the trap.** `three/main.js:311` sets
  `ACESFilmicToneMapping` and the profile's exposure on the renderer. Render
  through a composer and that stage is still there — two tone mappings, a look
  nobody chose. When the composer lands the renderer's stage goes to
  `NoToneMapping` and the pass takes the profile's knob.
- **Antialiasing changes meaning rather than improving.** The renderer is built
  `{antialias: true}` (`three/main.js:265`), and MSAA does nothing once the scene
  renders into a render target. SMAA or TAA is therefore a replacement for
  something already working, not an addition — the parity grid will show it
  immediately, which is the point of running it.
- Bloom belongs to Phase 6 by subject — a lit sconce shade, a range hood's work
  light — and is listed here only because it is the same pass in the same chain.
- **`pauseRender` has to reach it.** The loop at `three/main.js:525` skips
  rendering when paused; a composer that runs its own passes past that check
  burns a battery on a still frame.

**8d. Custom GLSL, last and only where nothing else reaches.**

- **Prefer `onBeforeCompile` to a `ShaderMaterial`.** It keeps the lights, the
  shadows, the environment map and the tone mapping, and replaces only the part
  in question. A `ShaderMaterial` gives all of that up to change one line.
- **The colour-space trap is already documented in this tree**, and every shader
  written here inherits it: `three/skybox.js:96` notes that a material writing
  `gl_FragColor` itself opts out of the sRGB encode three appends
  (`ShaderChunk/colorspace_fragment.glsl.js`). `edge.js`'s `RECIPROCAL_PI`
  cancellation and `lights.js`'s `* PI` are the same species of bug at the other
  two ends of the pipeline. Three instances is a pattern, not bad luck.
- What earns it: **procedural grout** (a backsplash is a grid, and a grid beats
  an authored map at every scale and every tile size), edge wear on a painted
  front, and grain that follows the panel rather than the UV island.
- **A time-varying uniform needs Phase 0d.** There is no `Clock` in `src/` at
  all. An animated shader and a turning fan blade want the same delta source, so
  whichever arrives first builds it for both.
- **Pin the version assumption.** `onBeforeCompile` string-patches three's own
  shader source, which is precisely what the r98 → r185 move broke elsewhere
  here. `vite.config.mjs`'s `dropBundledCodecs()` throws when its pattern matches
  nothing, for exactly this reason — copy that shape rather than discovering the
  breakage in a render.

---

## Done, out of band — the drawing importer

Not one of the phases. It arrived because the app could only ever open a plan
somebody had already traced for it on the command line, and that is the whole
of the answer to "how do I get MY house into this".

**What it is.** File → Import (`Ctrl+I`) takes a **PDF, an SVG or a DXF**, shows
the pages, lets you drag a box around the floor plan, asks what scale it is
drawn at, and traces **walls with their real thicknesses, plus the windows and
doors**, straight into the design — with the drawing itself laid underneath as a
carbon sheet to check against.

**Why it is big.** The tracer already existed, in Python, in `tools/`. It could
not be reached from the browser: PyMuPDF is a C library with no WebAssembly
build, so there was no Pyodide route, and the app is a static site with no
server. So the tracer was **ported to JavaScript** — `layers`, `walls`,
`openings`, `spaces` and the design writer, about 2,000 lines of Python, plus
three drawing readers the Python never needed because pymupdf was doing that
job:

| | |
|---|---|
| `import/readers/pdf.js` | pdf.js gives an operator list, not paths. This is the state machine MuPDF runs internally: CTM stack, graphics state, paint op, and the path command stream. |
| `import/readers/svg.js` | Its own XML tokeniser, so the reader needs no DOM and can be tested in the same headless suite as everything else. |
| `import/readers/dxf.js` | The only format that **states its own scale**, so a DXF is never asked what it is drawn at. Lineweights are read out of the LAYER table directly, because dxf-parser drops them. |

**How it was proved.** Not by eye. Every stage was run against the Python on the
same input and diffed:

- the PDF reader, against `pymupdf.get_drawings()` on a real 525-path sheet:
  **525/525 paths identical**, item for item, after three corrections it forced
  (a rectangle is one `re` item and not four lines; a closing edge IS a segment;
  MuPDF's `contains` is half open).
- `layers` and `walls`: the same structure layer picked, the same **55 boxes and
  291 segments**, the same thicknesses.
- the whole pipeline: **identical** corners, walls and items on the committed
  fixture, and 83/83 corners and 77/77 walls agreeing to a hundredth of a
  millimetre on the real sheet.

`tools/fixture_plan.py` draws the fixture — one small house written three times,
as a PDF, an SVG and a DXF — so the readers can be held against each other and
all three against a known answer. `plans/` is our house and can never be a test
fixture.

**One deliberate divergence, and it is a bug in the Python.**
`opening_truth.find` looks up the two face lines a wall was built from by
comparing values that `walls.coalesce` rounded to three decimals against raw
coordinates, with a tolerance of 1e-6. That only matches by luck. MuPDF holds
coordinates as float32 and pdf.js keeps float64, so the two land on opposite
sides of it — and when it fails it fails silently and completely: the structural
half of the opening detection, the half that finds a cased opening with nothing
drawn in it, returns nothing and the trace still succeeds. Measured on the
sample sheet, Python finds **0** openings there and the JS finds **17**. The JS
uses a tolerance that matches the rounding actually applied; `tools/` still has
the 1e-6 and **should be brought into line**, which is left undone here only
because changing it changes what the Python finds on the house it is tuned
against.

**What it cost.** Two size budgets went up, and nothing else should have moved:
`demo-js-gzip` 353 -> 546 KB and `demo-total` 13.69 -> 18.50 MB, all of it
pdf.js and its worker. Both chunks are dynamically imported and emitted as
separate assets, so **first paint is unchanged** — nothing fetches them until
File → Import is opened. `tools/budget.json` records the reasoning beside the
numbers.

**Two deliberate divergences from the Python, both recorded in AGENTS.md.**
The face-match tolerance above, and window sashes: `find_openings` merges
adjacent window spans, which reports a 20 + 51 + 20 triple as one 91in pane.
The JS keeps the sashes apart, so a twin reads as two units and a triple as
three, each with its own frame.

**What it does not do yet.**

- **Fixtures and cabinets are still not traced**, in either implementation —
  stages 5 and 6 of `AGENTS.md`'s pipeline, which wait on a spec to emit into.
- **The region and the scale are asked for, not detected.** A human picks the
  region for the same reason `--clip` is hand-set in `tools/`: drawing extents
  do not fall out of a sheet reliably. There is no scale calibration tool — the
  reported overall size in feet is the check, and it is the one number a wrong
  scale always gets wrong.
- **Two implementations now exist and can drift.** That is the standing cost of
  this decision, and the reason the parity work above is written down rather
  than merely done.

## Order, and why

```
0 spine ──┬── 1 half walls          cheapest; splits kitchen from great room
          ├── 2 cabinets + counters the point of the app
          │      ├── 4 appliances   built BEFORE runs; see below
          │      └── 3 runs
          ├── 5 windows + doors
          │      └── 6 lighting     daylight needs windows
          │            └── 8 shaders  AO needs a lit room; bloom needs fixtures
          └── 7 takeoff             reads the specs from 2-4
```

Phase 5's **windows** were pulled ahead of phase 3 for exactly the reason this
note gave: every window in the traced plan was a stretched mesh. They are
generated now, and `tools/extract.py` writes `generated:window`, so the eight
windows the tracer finds on the sample sheet arrive at five different widths
with the same stiles. The door operations — french, bypass, sliding patio,
pocket, bifold, barn — and the tracer's slider port both landed after it, so
**phase 5 is closed**. Next is phase 3 (runs) or phase 6 (lighting); the
dependency note below is the argument for which.

**Phase 8a is the exception to its own phase and can be pulled forward to any
point after 0b.** Maps go into the material library, and the library exists —
so wood that reads as wood does not wait on lighting, on a composer, or on
anything in Phase 2 beyond the slots that are already there. The rest of Phase 8
genuinely does sit after 6: an ambient-occlusion pass on an unlit room is
measuring nothing, and bloom with no emissive fixture in the scene has nothing
to bloom.

**Phase 4 was pulled ahead of phase 3, and only one thing was lost by it.** The
ordering above put appliances after runs because a built-in fridge has to align
its face with the cabinets beside it. That is true, and it is the *only* part of
an appliance that waits on a run: a range, a dishwasher, a microwave and a hood
are each a box with an honest size, and each of them is placeable by hand today.
So the panel-ready front is built and correct, and *matching* it to the run
beside it is done in the inspector until phase 3 arrives — which is the same
trade the farmhouse sink is already making one row down.

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
