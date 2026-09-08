Kitchen designer — a fork of architect3d (three.js r185, Vue 3, Docker) that
turns our architect's PDF into a walkable 3D kitchen. Work goes straight onto
`main`; there are no other branches.

Live: https://zlmitchell.github.io/kitchen-designer/ (GitHub Pages, deploys on
every push to main). The repo is public; `data/` and `plans/` are gitignored and
never reach the build, so the demo opens the stock room.

READ FIRST, in this order:
  ROADMAP.md                    what the app cannot express yet, and the phase
                                order. It is kept current — trust it over this
                                file, which is a summary and will drift.
  app/docs/generated-items.md   how to build a parametric part and HOW TO TEST
                                one. The testing section is the expensive part:
                                which of the two compose services to run in,
                                the two lines that make the model layer run
                                headlessly, how to render the real scene
                                without a GPU, and how to draw a thumbnail.
  AGENTS.md                     only if touching tools/ (the PDF tracer).

WHERE THINGS STAND

  Phases 0, 1, 2, 4 and 5 are closed. 8a (maps on the material library) is done.

  Phase 6, lighting, is closed but for two things: ceiling FANS, which are the
  whole of the animation story and the only consumer 0d's frame clock is waiting
  for, and windows admitting light as GLASS rather than as a hole, which waits
  on 8b's `transmission`.

  **Phase 3, runs, is next.** It is the last unbuilt phase in the spine and four
  finished phases are already deferring to it: phase 2 parked the farmhouse
  sink, the built-in fridge and the vessel sink there; phase 4's panel-ready
  fronts are matched to their neighbours by hand until it lands; and phase 7
  falls out with no new model work only because its method is to walk the runs,
  of which there are none. 3a — the blind corner — is the piece that decides the
  requirements mechanism, because it is the first case that is peer to peer
  rather than child to host.

  Phase 9, the walkthrough, hangs off nothing and could be done at any time. It
  adds no model: a door has taken `openFraction` since phase 5 and a fixture has
  taken `on` since phase 6, and nobody standing in the room can touch either.

HOW TO WORK

  docker compose run --build --rm test        # ~1910 tests; --build MATTERS
  docker compose run --build --rm test npx vue-tsc --noEmit -p tsconfig.json
  docker compose run --build --rm test npx eslint src tests tools --max-warnings 0
  docker compose up dev                       # localhost:5173, auto-loads data/design.json

  Anything that WRITES a file runs in `dev`, not `test` — `test` has no bind
  mount and its output is thrown away with the container:

  docker compose run --rm --no-deps dev npm run thumbnails -- --list
  docker compose run --rm --no-deps dev npm run manifest    # after adding to public/
  docker compose run --rm --no-deps dev npm run favicon

  python tools/build.py "plans/your-plan.pdf" -o data/design.json
  python tools/fitout.py plans/design.blueprint3d --wall 2 --uppers to-ceiling -o data/design.json

  The repo's own rule is LOOK AT IT — numbers do not show geometry in the wrong
  place. There is no GPU in the container, so render offline; the recipe is in
  generated-items.md and it has now caught more bugs than the test suite has.
  The most recent: a cabinet hood whose vertex count said three sections while
  the picture said two.

  Commits explain the MECHANISM and record what failed, in the present tense.
  The failures are the valuable part.

TRAPS THAT HAVE ALREADY BITTEN

- A stale generated artefact is not evidence about the code that makes it.
  Regenerate before diagnosing.
- Measure an asset, don't trust its name (open_door.glb was a closed door).
- ShapeUtils.triangulateShape DISCARDS a hole that strays outside its
  contour — silently, in full. Bit the wall openings and the counter cutouts.
- mergeMeshes recomputes each mesh from its parent's CURRENT world matrix, so
  shifting a group after the last update moves some children and not others.
- Plan axes are not item axes: a wall has two half edges and the one an item
  binds to sets its rotation. A half edge also runs to the MITRE, so it reaches
  past the wall's own end — which is why `metadata.wallEdge` names the face
  rather than the code guessing it back from distance.
- **A generated build is recentred on its own bounds.** The frame a builder
  reasons in — canopy bottom at y = 0 — is gone by the time anything else sees
  it. `RoofItem` recentres AGAIN, on `(max - min)` rather than `(max + min)`, so
  its origin is the TOP of the geometry: `-halfSize.y` is the MIDDLE of a
  ceiling fitting and not its bottom. That put every lamp inside its own body.
- **A swept or lathed shell has vertices only where a RING is.** Sampling
  between two of them finds nothing, and a test that samples where two parts
  meet measures both.
- **Bare node cannot import this project's source** — `materials.json` has no
  import attribute. A TOOL should use Vite's `createServer` + `ssrLoadModule`
  (see tools/make-thumbnails.mjs); only scratch code belongs in a vitest file.
- Three bookkeeping files fail late: tsconfig.json's type ledger,
  public/asset-manifest.json (npm run manifest), and the catalog count in
  tests/catalog-and-shim.test.js.
