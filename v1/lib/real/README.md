# Real-building tier (variants `r2`, `r4`)

Generated tasks measure an upper bound: their evidence is rendered from the
truth and is cleaner than reality. The real tier poses real buildings. The
contestant gets real photographs (and, in `r4`, survey notes); the hidden truth
is a model authored by hand from the building's planning-application drawings,
which the contestant never sees. The kernel already has the variants
(`v1/lib/contract.mjs`: `r2` photographs + aerial, scale-free; `r4` + notes,
metric; evidence selected by kind) and the object writer
(`writeProvidedObject` in `v1/lib/pack.mjs`). This module builds objects from an
authoring directory, prepares photographs, estimates cameras and checks the
truth against the drawings.

| File | What it does |
| --- | --- |
| `build.mjs` | `buildRealObject` (authoring directory -> object + `r2`/`r4` tasks), `preparePhotographs`, `loadAuthoring`, `checkNotes`, `forbiddenHits`, `coverageSummary` |
| `verify.mjs` | sheet registration (`solveRegistration`), orthographic renders on the sheet's pixel grid, line residuals, overlay PNGs (`verifySheets`) |
| `resect.mjs` | camera pose <-> kernel camera (`cameraFromPose`), resection from identified points (`resect`) |
| `v1/scripts/real.mjs` | `prepare`, `build`, `verify`, `coverage` commands |
| `v1/test/real.test.mjs` | tests (fixture authoring directory; the real object; the real overlays when the reference pack is on the machine) |

## Authoring directory (`v1/real/<name>/`)

- `model.mjs` — default export `() => e3d-model-v1`. Every number carries a
  comment with the sheet and the dimension string or pixel reading it comes
  from. Frame as the kernel wants it (DESIGN.md 3): the front faces +Z, +X to
  the right, origin on the ground at the midpoint of the front wall. Groups and
  probes follow the generator's conventions (kit helpers from
  `v1/lib/generator/kit.mjs` are used directly). `meta.truth_uncertainty_m`
  states how closely the truth follows the real building.
- `evidence.mjs` — `PHOTOS`: `{ id, kind: 'photo'|'aerial', file, captured_at
  (YYYY-MM), description, camera, occluders, prepared_from }`. `camera` is a
  pose (`position`, `heading_deg` with 0 = looking along -Z and 90 = along +X,
  `pitch_deg`, `roll_deg`, `fov_y_deg`, `width`, `height`) or a kernel camera
  JSON (the aerial). `occluders` use the contract's shapes. `prepared_from`
  says how `prepare` makes the file from the reference pack (crop, masks).
  `FORBIDDEN` lists words no public text may contain (required).
  `OBJECT_ID` is the public, neutral object id; `NOTES_CAPTURED_AT` dates the
  notes; `CAMERA_POINTS` keeps the points each camera was resected from.
- `notes.md` — survey notes for `r4`, in the style of
  `v1/lib/evidence/notes.mjs`. Every number in them must be one of the model's
  named `dimensions` (to 10 mm, or to the millimetre when written in mm):
  `build` refuses notes that contradict the truth.
- `sheets.mjs` — `SHEETS`: per drawing sheet, the view, crop, registration
  anchors and the main lines to measure (see below).
- `PROVENANCE.md` — every dimension -> sheet and dimension string, conflicts
  between sheets and which was believed, uncertainty, what is out of scope, how
  the cameras were estimated.

## Commands

    # Crop, mask and strip the photographs out of the reference pack (needs macOS sips).
    node v1/scripts/real.mjs prepare --source v1/real/mcd-homestead \
      --pack PATH/TO/REFERENCE_PACK --sources-root .local/v1/real-sources/mcd-homestead

    # Object + r2 / r4 tasks (refuses an existing object), then the kernel's checks.
    # The prompt's scoring paragraph (v1/lib/pack.mjs) is that of the set's tasks already
    # built under the data root (real-2026-10: version 1); --task-prompt N only chooses
    # it for a set's first object (default: the latest), and must agree with it otherwise.
    node v1/scripts/real.mjs build --source v1/real/mcd-homestead \
      --sources-root .local/v1/real-sources/mcd-homestead --set real-2026-10 [--task-prompt N] [--data DIR]
    node v1/cli.mjs verify
    node v1/cli.mjs score --task real-0001-r4 --glb truth --full true

    # Overlays of the truth on the sheets and line residuals (metres).
    node v1/scripts/real.mjs verify --source v1/real/mcd-homestead \
      --sheets PATH/TO/REFERENCE_PACK/planning-and-dimensions/key-sheets
    #   -> .local/v1/real/mcd-homestead/verify/<sheet>.png and residuals.json

    # How much of the truth surface the evidence shows, by facing, elevation and item.
    node v1/scripts/real.mjs coverage --task real-0001-r2

Photographs of real buildings and everything derived from the truth stay under
`.local/` (git-ignored). The public object id names the task packs, so it is
neutral (`real-0001`); the model's own id may name the building and stays in the
private files (`v1/cli.mjs verify` fails a pack that contains it). `build`
also refuses public text (title, scope note, frame, photo ids, descriptions,
file names, notes, and the built packs) that contains a forbidden word
(`FORBIDDEN` in `evidence.mjs`: the operator's brand, the address; required, so
a forgotten list cannot pass for an empty one).

## Registering a sheet (verify.mjs)

A drawing is axis-aligned and uniformly scaled, so the map from the view's
model coordinates (u to the sheet's right, v up the sheet, metres) to sheet
pixels is `px = a + s·u`, `py = b − s·v`: three unknowns. Anchors read off the
sheet fix them, by weighted least squares:

- a **scale** anchor: d metres span Δ pixels. For an elevation drawn at
  3/16" = 1'-0" and rendered at 100 dpi this is 18.75 px/ft exactly, held fixed
  (`exact`); for a plan, the sheet's graphic scale bar or a printed dimension;
- **row** anchors: the printed elevation datums (T/SLAB +0'-0", B/WINDOW +3'-1",
  B/CANOPY +9'-0", T/WINDOW +14'-5", T/PARAPET +18'-10", +20'-6"), each the row
  of its leader line;
- a **column** anchor: one building end on that sheet (a plan: one wall face).

So two known dimensions fix the scale (the printed scale, confirmed by the
datums' spacing), one datum fixes the height offset and one end the position
along the facade. The datum residuals are reported (within 1-2 px on every
sheet, 3.4 px for the tallest datum of one): they show that the drawn datums and
the printed scale agree. A free fit of the datums alone would let a 1 px
misreading of a leader change the scale by 0.5 %, which moves the far end of a
50 m facade by 0.25 m: hence the held scale.

The truth is then rendered with an orthographic camera whose pixel grid is the
sheet crop's pixel grid, and its edges (a change of part, a step in depth, or
the silhouette; two parts of one material meeting flush are not an edge) are
drawn in red over the washed-out sheet. For each named line the truth's edge is
located in the render and the sheet's ink line in the sheet by the same 1-D
search (strongest row or column over the line's span within ±`search_m` of the
expected position), so neither number is typed in; the residual is truth minus
sheet in metres. A line not found on either side is reported as not found,
never as a pass. Where the truth deliberately follows another sheet,
`sheet_at` centres the sheet search on where this sheet draws the line, and the
residual reports the disagreement.

## Cameras (resect.mjs)

Real photographs record no camera. Each photograph's camera is resected from
7-10 building points identified in it (corners of the tower, pilaster, windows,
doors, the ends of a block) by Levenberg-Marquardt on the reprojection error,
with the field of view held where the lens is known (a panorama viewer's
default view) and fitted where it is not. The result is the kernel's
`perspectiveCamera` JSON, exactly what rendered photographs record, so coverage
treats real and rendered photographs alike. Precision of a few pixels (a few
centimetres at the building) is far more than coverage needs.

## What the tests cover

`node --test v1/test/real.test.mjs`: a fixture authoring directory builds into
`r2` / `r4` packs that pass `verifyTasks`, whose truth scores ≥ 99 on both,
`r2` without notes and scale-free, `r4` with notes and metric, no forbidden
word or private id in any pack; a missing `FORBIDDEN` refused; coverage (rear unseen, roof seen by the aerial);
immutability and clean-up on failure; refusal of forbidden words, contradicting
notes and photographs whose size differs from their camera; the registration
maths and the line search on a synthetic sheet (including a deliberately
misdrawn line); resection of a known camera; photo crop/mask; the authored
object (valid, probes robust within 0.12 m, z-fight-free in the standard views,
neutral public text, every camera sees the building); and, when the reference
pack is on the machine, the real overlays (every line within 0.2 m apart from
the declared conflicts).

## Limits

- The aerial is treated as orthographic (a satellite tile leans tall edges by
  up to a metre); coverage on the roof is all it decides.
- The coverage test of the scorer takes |cos| and a depth tolerance, so an
  unseen face keeps a pixel-wide strip of "evidenced" surface along the
  silhouette corners (1-2 % of the face here). It is the scorer's definition,
  not changed here.
- Sheet conversion uses macOS `sips` (JPEG decoding); a PNG sheet needs nothing.
