
Kitchen designer — a fork of architect3d (three.js r185, Vue 3, Docker) that
turns our architect's PDF into a walkable 3D kitchen. Continuing work on branch
`generated-openings`.

READ FIRST, in this order:
  ROADMAP.md                    what the app can't express yet, and the phase
                                order. Phases 0, 1 and most of 2 are done.
  app/docs/generated-items.md   how to build a parametric part and HOW TO TEST
                                one. The testing section is the expensive part:
                                which of the two compose services to run in,
                                the two lines that make the model layer run
                                headlessly, and how to render the real scene
                                without a GPU.
  AGENTS.md                     only if touching tools/ (the PDF tracer).

WHERE THINGS STAND
  Done: generated doors (openFraction, plan-space handing), half walls
  (Wall.setHeight splits corners), posts, cabinets (base/wall/tall, shaker/
  slab/raised, drawer banks, topTreatment to-ceiling/soffit/stacked),
  counters (Shape+holes cutouts), sinks (5 mounts, rect/round/oval), a PBR
  material library, a schema-driven inspector with scoped style changes, and
  wall paint.

  Next in phase 2: APPLIANCES — range, fridge (freestanding vs panel-ready),
  dishwasher, microwave with its four mounts (counter / in-cabinet /
  over-range / drawer), vent hood.

  Then phase 3: RUNS. Right now tools/fitout.py does the placement arithmetic
  in Python — cabinets, one counter across them, a sink centred on its sink
  base. That belongs in the app as a run object. The general mechanism the
  roadmap wants: an item declares requirements of its host, and the host
  validates (a farmhouse sink removes the cabinet front below it; a vessel
  sink dictates its counter height; a pocket door needs wall thickness).

HOW TO WORK
  docker compose run --build --rm test        # 1520 tests; --build matters
  docker compose up dev                       # localhost:5173, auto-loads data/design.json
  python tools/fitout.py plans/design.blueprint3d --wall 2 --uppers to-ceiling -o data/design.json

  The repo's own rule is LOOK AT IT — numbers do not show geometry in the wrong
  place. There is no GPU in the container, so render offline; the recipe is in
  generated-items.md and it has caught four bugs a triangle count could not.

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
  binds to sets its rotation.
- Three bookkeeping files fail late: tsconfig.json's type ledger,
  public/asset-manifest.json (npm run manifest), and the catalog tests.

NOT MINE: app/src/app/import/ and tests/import-*.test.js are the owner's
in-progress PDF import work. Don't commit or refactor them.
