# Evidence3D v1 — engineering contract

This is the contract every v1 module is built against. If code and this file
disagree, this file wins until it is changed deliberately.

## 1. What v1 changes and why

v0 could score only tasks that hand the model a complete parts list (a
transcription test), and could not score the real-photo tasks at all (no ground
truth, no defined frame). v1 inverts the construction:

1. A **hidden ground-truth model** is generated first (parametric, seeded).
2. **Evidence is rendered from it**: photographs, an aerial view, scaled line
   drawings, survey notes. The contestant sees only this evidence.
3. Scoring compares the submitted GLB with the hidden model. It is fully
   automatic, continuous, and separates *frame/scale error* from *shape error*.
4. The same object is posed at several **evidence levels** (variants), and a
   **conflict** variant supplies out-of-date drawings, so "does the model use
   evidence correctly" is measured by geometry, not by reading its notes.

The capability under test: *given evidence, build a 3D model whose dimensions
and structure are right — from the evidence, not from memory.*

## 2. Rules for everyone building v1

- Work only inside the paths your brief assigns. Kernel files (section 4) are
  read-only for you; if the kernel is wrong or missing something, do not edit
  it — say so in your final report and work around it inside your own module.
- No `git commit`, no `git add`, no branch changes. The orchestrator integrates.
- No new npm dependencies. Available: Node >= 22 built-ins, `three@0.180.0`,
  `ajv`. No Python packages outside Blender's bundled Python.
- Do not touch v0 (`lib/`, `site/`, `test/`, `cli.mjs`, `docs/`, `.local/` apart
  from `.local/v1/`). Importing from `lib/glb.mjs` or `lib/io.mjs` is fine.
- Tests use `node:test`, live in `v1/test/<module>.test.mjs`, write only to
  `mkdtemp` directories, and must pass with `node --test v1/test/<module>.test.mjs`.
  Run only your own test file plus `v1/test/kernel.test.mjs`.
- Style: ES modules, 2-space indent, semicolons, single quotes, readable names;
  comments explain *why*, not what. Match `v1/lib/raster.mjs`.
- Determinism: everything derives from seeds through `v1/lib/rng.mjs`. No
  `Math.random()`, no wall-clock-dependent output (timestamps only in logs/reports).
- Honesty: a check that cannot be evaluated must report "not evaluated", never a
  pass. Never fabricate human ratings, costs, or model results.
- The scratch space for experiments is a `mkdtemp` directory or
  `.local/v1/scratch/<your-module>/`.

## 3. Frame and naming

- Metres, right-handed, **+Y up** (glTF convention). Ground is `y = 0`.
- The object's **front** faces **+Z**. **+X is to the right** for a viewer who
  stands in front of the object and looks at it.
- "left" / "right" always mean that viewer's left (−X side) and right (+X side).
- Each model states its origin in words (`model.frame.origin`); for buildings it
  is *on the ground at the midpoint of the main front wall, front wall face at
  z = 0*, so the body extends towards −Z and porches/canopies project to +Z.
- Angles in JSON are radians unless a field name ends in `_deg`.
- Rotation about +Y by `yaw`: `x' = x·cos + z·sin`, `z' = −x·sin + z·cos`.

## 4. Kernel (done, tested, read-only)

| File | What it gives you |
| --- | --- |
| `v1/lib/rng.mjs` | `rng(seed)` → `{ next, range, int, pick, chance, fork }` |
| `v1/lib/png.mjs` | `encodePNG(width, height, pixels, channels)`, `decodePNG(bytes)` |
| `v1/lib/model.mjs` | `validateModel`, `buildScene` (three.js group, one mesh per part), `modelToGLB`, `PRIMITIVE_TYPES` |
| `v1/lib/soup.mjs` | `soupFromModel`, `soupFromGLB` (enforces the static GLB contract), `soupFromScene`, `soupFromOccluders`, `mergeSoups`, `filterSoup`, `transformSoup`, `transformPoint`, `soupBounds` |
| `v1/lib/raster.mjs` | `orthoCamera`, `perspectiveCamera`, `orthoViewOfBounds(bounds, 'front'|'rear'|'left'|'right'|'top')`, `render(soup, camera)` → nearest depth + triangle id per pixel, `projectPoint`, `unproject`, `raycast`, `triangleNormal`, vector helpers |
| `v1/lib/contract.mjs` | protocol names, `VARIANTS`, `STANDARD_ITEMS`, `layout(dataRoot)`, `validateTask`, `validateTruth`, `validateEvidenceItem`, `occluderScene`, `DEFAULT_BUDGET` |
| `v1/fixtures/sample-model.mjs` | `sampleModel()` — a fixed two-storey house; develop and test against it |

Read the source of these files; the comments are the documentation. A **soup**
is `{ positions: Float64Array(9T), triPart: Int32Array(T), colors:
Float32Array(3T) linear-sRGB, parts: string[], bounds, triangles }`.

Camera JSON (also what evidence items store) is exactly what `orthoCamera` /
`perspectiveCamera` return: `right`, `up`, `forward = up × right` unit vectors in
model space, depth grows along `forward`, pixel (0,0) top-left.

## 5. Ground-truth model (`e3d-model-v1`)

```jsonc
{
  "schema": "e3d-model-v1",
  "id": "house-0007",            // [a-z0-9._-]
  "archetype": "house", "seed": 7,
  "title": "Two-storey gabled house",   // neutral, safe to show contestants
  "frame": { "origin": "…sentence…", "front": "…sentence…" },   // copied into the task
  "scope_note": "What is and is not part of the object",
  "materials": { "render": { "color": "#d8cfc0", "roughness": 0.9, "metalness": 0, "kind": "wall" } },
  "groups": [ { "id": "front.windows.ground", "title": "Ground-floor windows",
                "category": "openings", "detail_size_m": 0.07, "facade": "front" } ],
  "probes": [ { "id": "ridge-height", "label": "Roof ridge height",
                "origin": [0, 40, -3.5], "direction": [0, -1, 0] } ],
  "dimensions": [ { "id": "overall-width", "label": "Overall width", "value_m": 9,
                    "a": [-4.5, 0, 0], "b": [4.5, 0, 0], "view": "front" } ],
  "parts": [ { "id": "wall-front", "type": "extrude", "material": "render", "group": "body", … } ]
}
```

- **parts**: primitives `box`, `cylinder`, `torus`, `lathe`, `beam`, `extrude`,
  `mesh` (semantics in `model.mjs`). Optional `position`, `rotation` (Euler XYZ).
  `extrude` runs from local z = 0 to z = depth — position places its *back* face.
- **No coplanar overlapping faces** between parts and no interpenetrating faces
  that show: they z-fight in every renderer. Inset by ≥ 2 cm.
- **groups** are the units of detail scoring. `detail_size_m` is the smallest
  feature that distinguishes the group being modelled from it being faked (frame
  width, recess depth, post diameter). `category` buckets groups for weighting
  (`massing`, `roof`, `openings`, `entrance`, `attachments`, `structure`,
  `ornament` …). `facade` ∈ front/left/right/rear/roof/all says where to look
  from. Every visible part should belong to a group.
- **probes** are rays whose first-hit distance is a named dimension (ridge
  height, wall position, canopy height). The generator supplies origin and unit
  direction only; the true distance is measured from the geometry.
- **dimensions** are the true named dimensions drawn on drawings and written in
  notes: two 3-D points, the value, and the view it is drawn in.

## 6. Data layout (under a data root, default `.local/v1`)

```
objects/<object-id>/
    model.json  model.glb                 private ground truth
    alternates/<alt-id>/model.json  model.glb  change.json     the alternate state: `earlier` (the
                                          decoy behind c1's stale drawings) or `remembered` (a
                                          landmark to its published figures, memory tasks)
    evidence/evidence.json                every evidence item + cameras
    evidence/<files>                      photos/*.jpg  drawings/*.png  notes/*.md
tasks/<task-id>/task.json  inputs/*       the public pack — all a contestant gets
truth/<task-id>/truth.json                which object/variant/evidence the task used
runs/<batch-id>/…                         generation attempts and their scores
reports/<name>/…                          aggregated results
sets/<name>.json                          private sets (test, memory): seeds, never in git
study/<name>/…                            a human-agreement study: pairs, key, images, votes
real-sources/<source>/…                   photographs of real buildings (never in git)
```

### Evidence item (`evidence.json` is `{ schema: "e3d-evidence-v1", object, items: [...] }`)

```jsonc
{ "id": "photo-front",                  // one of STANDARD_ITEMS, or "<item>@<alt-id>" for a stale version
  "kind": "photo",                      // photo | aerial | elevation | plan | notes
  "file": "photos/front.jpg",           // relative to the evidence directory
  "captured_at": "2025-09",
  "description": "Street-level photograph of the front",   // public caption
  "metric": false,                      // does this item fix absolute size?
  "source_model": "primary",            // or the alternate id it was rendered from
  "camera": { …kernel camera JSON… },   // photo, aerial, elevation; null for plan and notes
  "occluders": [ … ],                   // see contract.mjs; [] when none
  "sha256": "…", "bytes": 12345 }
```

### `task.json` (`e3d-task-v1`, public) — see `validateTask`

`id`, `title`, `prompt`, `variant`, `target_state`, `frame { unit, up, origin,
front }`, `scale_evidence` (`none` | `metric`), `inputs[] { id, path, kind,
captured_at, description, sha256, bytes }`, `output { model, notes, rules[] }`,
`budget`.

### `truth.json` (`e3d-truth-v1`, private) — see `validateTruth`

`task_id`, `task_sha256` (canonical-JSON hash, `objectHash` in `lib/io.mjs`),
`object`, `variant`, `scale_evidence`, `evidence[]` (item ids actually given),
`alternates[] { id, contested_probes[], note }`.

## 7. Variants

| Variant | Evidence | Scale |
| --- | --- | --- |
| `t1` | one front photograph | not fixed → scored up to scale |
| `t2` | four photographs (front, left, right, rear) + aerial | not fixed |
| `t3` | t2 + plan + front and right elevation drawings with scale bars | metric |
| `t4` | t3 + survey notes with named dimensions | metric |
| `c1` | t3, but the drawings show an earlier state; photographs are newer and the task asks for the building as photographed | metric |
| `m2` | as t2, of a **named landmark** whose surveyed proportions differ from the published ones | not fixed |
| `m3` | as t3, of the same | metric |
| `r2` | every photograph and the aerial of a **real building** (items chosen by kind, not by standard id) | not fixed |
| `r4` | r2 + survey notes with a handful of dimensions | metric |

`GENERATED_VARIANTS` (t1–t4, c1) are what every generated object supports and what
`new-set` / `build-set` build by default. `CONFLICT_VARIANTS` (c1, m2, m3) are the
variants whose truth carries an alternate state; the scorer judges every contested
probe as closer to the primary, closer to the alternate, or neither, and the report
gives the share closer to the primary — "followed the photographs, not the stale
drawings" for c1, "followed the evidence, not the memory" for m2/m3 (reported
separately: they are different temptations).

The task prompt is the same text for every variant except its evidence rule:
generated objects — "Use only this evidence. Do not rely on knowing a similar real
building."; memory tasks — "…even where it disagrees with what you know or remember
about this structure. The surveyed object is what is scored, not published figures.";
real buildings — "…Do not rely on knowing this or a similar real building. The
photographs are real: expect lens distortion, people, vehicles and signage." The
target-state date is the date of the newest photograph among the inputs.

## 8. Module contracts

Each module owns its paths and exports exactly these entry points.

### A. Generator — `v1/lib/generator/**`

```js
export const ARCHETYPES;                                // string[] of archetype ids
export function generateModel({ archetype, seed });     // → validated e3d-model-v1
export function decoyModel(model, { seed });            // → { model, change } an earlier state
```

`decoyModel` returns the same building before a plausible alteration: 1–3
visible, measurable differences (an extension that did not exist yet, a lower
tower, a different number of bays, a canopy added later). `change = { note:
"sentence describing what changed", contested_probes: [probe ids] }`; contested
probes exist in **both** models with the same id/origin/direction and hit
measurably different distances (≥ 4 % of the bbox diagonal apart).

**Landmarks** (`v1/lib/generator/landmarks/**`, not part of `ARCHETYPES`):

```js
export const LANDMARKS;                                 // elizabeth-tower, arc-de-triomphe, washington-monument, lincoln-memorial
export function generateLandmark({ landmark, seed });   // → { model, alternate: { id: 'remembered', model, change, stale: false } }
export function publishedModel(landmark);               // the structure to its published figures (sources cited in the code)
```

`model` is the seeded twin: at least three named quantities changed by 12–30 % (or
counts by ≥ 2), never reducible to a uniform scale (so the difference survives the
scale-free `m2` alignment). Every twin keeps a **datum** part identical to the
published model (a plinth, a shaft section, the terrace): the scorer reads contested
probes in the frame fixed by the surface both states share, and without one the
scale-free fit meets a memorised model half way and the probes read "neither".
`node v1/scripts/landmarks.mjs new-set | build-set | check` builds a private set and
checks, per task, that the truth scores 100 with every contested probe on the primary
and the published model scores clearly lower with every contested probe on the
alternate.

### B. Photographs — `v1/lib/evidence/photos.mjs`, `v1/blender/**`

```js
export async function renderPhotos({ model, glbPath, outDir, seed, blender });
// → EvidenceItem[] for photo-front, photo-left, photo-right, photo-rear, aerial
```

### C. Drawings and notes — `v1/lib/evidence/drawings.mjs`, `notes.mjs`, `canvas.mjs`

```js
export async function renderDrawings({ model, outDir, seed, capturedAt, sourceModel = 'primary' });
// → EvidenceItem[] for plan, elevation-front, elevation-right
export async function writeNotes({ model, outDir, seed, capturedAt });
// → EvidenceItem[] for notes
```

### D. Scorer — `v1/lib/score/**`

```js
export async function scoreSubmission({ glb, taskDir, truthDir, dataRoot, outDir });
// glb: Buffer. Always resolves to a report (e3d-report-v1); never throws for a bad submission.
export function scoreSoup({ candidate, context });      // same, from a soup (tests, calibration)
export async function loadContext({ taskDir, truthDir, dataRoot });   // truth soup, evidence, groups, probes
```

### E. Runner — `v1/lib/runner/**`, `v1/scripts/run.mjs`

Generation under isolation, with preflight probes, timing, token accounting, and
scoring of what was produced. Details and the evidence for each boundary:
`v1/lib/runner/README.md`. Systems:

| `--system` | What runs | Budget | Boundary | State |
| --- | --- | --- | --- | --- |
| `codex`, `claude-code` | the vendor CLI with its own tools and built-in prompt | wall clock | the CLI's own Seatbelt sandbox, proven by preflight | used for every result so far |
| `api-anthropic`, `api-openai` | one minimal agent loop of ours (tools `shell`, `read_file`, `write_file`, `list_dir`, `view_image`; same prompts for both) against the Messages / Responses API | tokens and tool calls (wall clock only as a safety cap); exhausting it is the status `budget_exhausted`, a sample | our Seatbelt profile around every shell command, path confinement in code, proven by a model-free preflight | tested against local mock servers only: no API key has been available |
| `grok` | Grok Build CLI | wall clock | Grok applies one Seatbelt profile to itself and every child inherits it: no way to block the shell's network, keep `input/` read-only or hide `~/.grok` | wired, but its preflight fails closed on those three requirements; no batch has run |

A system whose preflight does not pass cannot run: there is no override.

- `result.json` status: `completed`, `timeout`, `budget_exhausted` (API systems),
  `generation_failed`, `missing_artifact`, `invalid_artifact`, `score_error`,
  `infra_error`.
- **Host sleep.** When an attempt ends, the runner checks `pmset -g log`: 30 s or
  more of host sleep inside the attempt, or more than 60 s over its wall limit,
  makes it `infra_error` / `host_suspended` (re-run, not counted towards the re-run
  cap). The rule never looks at the score. Batches frozen before this existed use
  `v1/scripts/host-sleeps.py` + `relabel-host-suspended.mjs` after the fact.
- **`infra_error` is not a sample.** The harness could not run the model (usage
  or rate limit, lost login, network, service outage, CLI crash before any
  model turn, runner interrupted). It has `score: null` and an `infra` block
  with the reason and evidence. `run` archives the attempt as
  `<task>/a<n>.infra-<k>/` and runs it again from a pristine workspace; every
  try is listed in the new `result.json`. An integrity problem is never
  excused as an infrastructure error.
- **Waiting.** A usage or rate limit holds the batch until the stated reset
  time (or a backoff), then continues inside the same `run`. Login, billing
  and model problems stop the batch for a human. A CLI stuck retrying the
  service, or silent, for 10 minutes is stopped and recorded as `infra_error`.
- **Frozen.** `manifest.json` freezes the runner, scorer and generator source,
  the harness binary, the prompt, each task and its object files, and each
  task's `set`. Any of them changing stops the batch.

### G. Rendering, contestant preview tool, report — `v1/lib/render/**`, `v1/tools/**`, `v1/lib/report/**`

```js
export function shadeSoup(soup, camera, options);       // → { width, height, pixels RGB }
export async function installTools(destination);        // copies the contestant tool kit
export async function aggregate({ dataRoot, batches }); // → leaderboard (e3d-leaderboard-v2)
export async function writeReport({ dataRoot, batches, outDir });
// writes index.html, summary.md, leaderboard.json, tasks/, assets/; returns a compact summary
```

Results are grouped by task set and never pooled across sets. Per set: the
leaderboard with object-level bootstrap intervals, every pair of
configurations compared on per-object differences (paired bootstrap and a
Student-t cross-check; a pair counts as separated only when both exclude
zero), variance between attempts and between objects with the smallest
detectable difference, and breakdowns by variant, archetype and evidence
delta. Details: `v1/lib/report/README.md`.

### H. Human-agreement study — `v1/lib/study/**`, `v1/scripts/study.mjs`

A blind paired comparison of the headline score with a human rater. `prepare`
selects pairs of valid submissions for the same task, stratified by score gap
([0,3), [3,8), [8,15), [15,100]), at most two per task, with 10 % repeated pairs
(sides swapped) for self-consistency; renders the truth and both submissions with
identical cameras and neutral shading, each submission in the pose the scorer
fitted; writes `pairs.json` (public: opaque ids and image names only) and
`key.json` (private: attempts, scores, strata). `serve` is a rating page on
127.0.0.1 that appends votes to `votes.jsonl`. `analyze` reports, over the
original pairs, how often the rater chose the higher-scored submission (Wilson
95 %), per stratum and per score component, the tie rate, the self-consistency on
repeats and the largest disagreements. Details: `v1/lib/study/README.md`.

### I. Real buildings — `v1/lib/real/**`, `v1/real/<source>/`, `v1/scripts/real.mjs`

A real object is authored, not generated. `v1/real/<source>/` holds the truth model
(`model.mjs`: every number cites the drawing sheet and dimension string it was read
from), the evidence list (`evidence.mjs`: photographs with fitted cameras and
occluders, and the words that must not appear in a pack), survey notes for `r4`,
the sheet registrations used for verification, and `PROVENANCE.md` (conflicts
between sheets and which was believed, what could not be read, the estimated truth
uncertainty). `real.mjs prepare` copies and cleans the photographs (map labels and
watermarks masked) into `real-sources/`; `build` writes the object with
`writeProvidedObject` and the `r2`/`r4` tasks with `buildTask` under a neutral id
(`real-0001`: task ids are public); `verify` renders the truth onto each drawing
sheet's pixel grid and reports line residuals; `coverage` says which faces the
photographs actually show. The planning drawings are the truth and are never
evidence. Details: `v1/lib/real/README.md`.

### Orchestrator — `v1/lib/pack.mjs`, `v1/cli.mjs`, this file

Builds objects (model → GLB → evidence), assembles task packs and truth,
exposes the CLI, wires modules together.

```js
export async function buildObject({ dataRoot, archetype, seed, model, alternate, id, blender, quality });
// alternate: default = decoyModel's earlier state (+ stale drawings); a memory object passes
// { id: 'remembered', model, change, stale: false }
export async function writeProvidedObject({ dataRoot, model, id, items, alternate });
// an object whose evidence is not rendered (real buildings); files already in <object>/evidence/
export async function buildTask({ dataRoot, objectId, variant, set });
// evidence by standard item, or by kind for the r- variants; every alternates/<id>/ goes into truth.json
```

## 9. Scoring definition (module D implements exactly this)

Let `D` be the ground-truth bounding-box diagonal.

1. **Validity gate.** `soupFromGLB` with the task budget. Invalid → `valid:
   false`, `score: 0`, the reason, and nothing else is computed.
2. **Visible-surface sampling.** Truth and candidate are each rendered from 25
   orthographic directions (8 azimuths × elevations 0°, 30°, 60°, plus top),
   framed on their own bounds; hit pixels are unprojected and thinned on a voxel
   grid so spacing ≈ 0.4 % of that soup's diagonal. Only first-visible surfaces
   count: interiors and hidden faces are neither rewarded nor punished. Each
   truth point keeps its part id and normal. Hits on triangles seen within
   1e-6 of edge-on are dropped (the kernel rasterizer reports hits along an
   exactly edge-on triangle whose line falls on pixel centres, at depths that
   can lie behind other surfaces).
3. **Evidence coverage.** A truth point is *evidenced* if at least one supplied,
   non-stale item with a camera shows it: it projects inside the image, it is the
   nearest surface there once occluders are rendered, and the surface is not seen
   at a grazing angle (> 80° off the normal). Plans and notes add no coverage.
4. **Alignment.** Fit `p' = s·Ry(yaw)·p + t` from candidate to truth. `yaw` and
   `t` are always fitted (the origin is a convention, not the skill under test).
   `s` is fitted only when `scale_evidence` is `none`; it is locked to 1 when the
   evidence is metric. Multi-start over yaw, then trimmed ICP with a closed-form
   yaw/scale/translation update, on evidenced truth points; the best start by
   F@2 % wins. The fit is reported as `frame_error` (yaw, offset in metres and as
   a fraction of `D`, log-scale) so a right shape in the wrong place is visible
   as exactly that.
5. **Headline.** Distances are measured from each sample point to the other
   model's first-visible surface, not to its nearest sample point: the
   triangles seen in the voxels of the sample points nearby, a triangle's
   closest point counting only where one of the 25 sampling views sees it
   (otherwise the nearest sample's distance stands). Two samplings of one
   surface lie up to a sample spacing (0.4 % of `D`) apart, which point to
   point would be noise at the tolerances below. At τ ∈ {0.25 %, 0.5 %, 1 %,
   2 %, 5 %} of `D`: precision = share of candidate points within τ of the
   truth's visible surface; recall = share of evidenced truth points within τ
   of the candidate's visible surface; candidate points whose nearest truth
   point is not evidenced are left out of precision unless a supplied camera
   shows their place to be empty. `F = 2PR/(P+R)`. **`shape_score = 100 × the
   mean of F@0.25 %, F@0.5 % and F@1 %`** — the rows marked `in_shape_score`,
   listed in `global.shape_fractions`; the 2 % and 5 % rows are reported as
   diagnostics only. A single tolerance is a cliff; the mean over a geometric
   ladder gives graded credit for coarse, medium and fine agreement. These
   global surface measures (and appearance and the error maps) are taken at
   the fit's *shape pose*: the searched pose of 9.4, or a point-to-plane
   refinement of it with pairing radii of 1 %, 0.5 % and 0.25 % of `D` when
   that raises `shape_score` by more than half a point (it never leaves the
   searched basin; reported as `alignment.shape_pose`). Detail groups, probes
   and contested probes use the searched pose. **`score = (shape_score +
   detail.score) / 2`** (shape alone when no detail group could be scored):
   surface agreement is dominated by large flat faces, so a bare bounding box
   of a slab tower still earns about 60 on shape; detail is what separates a
   model of the object from a box around it. Also reported: `strict` (F@2 %
   with no fitting at all, point to point) and `shape` (F@2 % with the scale
   fitted even on metric tasks), so "shape right, scale wrong" is
   distinguishable from "shape wrong". Every report carries `scorer: {
   version, sha256 }`, the hash covering the scorer's source and the kernel
   files it imports, so a re-scored report can be told from one written at
   run time.
6. **Detail groups.** For every model group: local orthographic views looking at
   the group's facade (straight on, two obliques, one from above), framed on the
   group's bounding box, pixel ≤ `detail_size_m`/3. Truth pixels that belong to
   the group's parts form the truth set; aligned-candidate points inside the
   group's box (expanded by 2τ_g) form the candidate set; `τ_g = 0.6 ·
   detail_size_m`. Before measuring, a translation-only local fit of at most 2 %
   of `D` is applied and reported (`local_offset_m`), so a correct window 5 cm
   out of place is not scored as a missing window. A group is scored only if
   ≥ 50 % of its truth points are evidenced. `detail.score` = 100 × mean over
   categories of the mean group F in the category.
7. **Probes.** Each probe ray is cast at truth and at the aligned candidate;
   `error_m = |d_candidate − d_truth|`; a miss is recorded as a miss. Probes whose
   truth hit is not evidenced are skipped.
8. **Alternates (conflict tasks).** The candidate is also scored (own alignment)
   against each alternate. For each contested probe: `closer_to` = primary /
   alternate / neither (neither when both errors exceed half the gap).
9. **Appearance (secondary).** For matched pairs at τ = 2 %, CIE76 ΔE between
   solid base colours, excluding truth points whose material kind is `glass`.
   Textures and vertex colours are ignored.
10. **Report** (`e3d-report-v1`):

```jsonc
{ "schema": "e3d-report-v1", "protocol": "evidence3d-v1.0.0",
  "scorer": { "version": "1.1.0", "sha256": "…" },
  "task_id": "…", "object": "…", "variant": "t2",
  "valid": true, "error": null, "score": 71.3, "shape_score": 80.2,
  "global": { "diagonal_m": 14.2, "normal_consistency": 0.93, "distance": "point-to-visible-surface",
    "shape_fractions": [0.0025, 0.005, 0.01],
    "thresholds": [ { "fraction": 0.0025, "tau_m": 0.0355, "precision": 0.6, "recall": 0.5, "f": 0.55, "in_shape_score": true }, … ],
    "points": { "truth": 0, "truth_evidenced": 0, "candidate": 0, "candidate_counted": 0 } },
  "alignment": { "yaw_deg": 1.2, "scale": 1, "scale_locked": true, "translation_m": [0, 0, 0],
    "shape_pose": { "stage": "search", "moved_m": 0 },
    "frame_error": { "yaw_deg": 1.2, "offset_m": 0.3, "offset_fraction": 0.02, "scale_log": 0 } },
  "strict": { "f": 0.4 }, "shape": { "f": 0.74, "scale": 1.08 },
  "detail": { "score": 38.0, "categories": [ { "id": "openings", "f": 0.2 } ],
    "groups": [ { "id": "…", "title": "…", "category": "…", "scored": true, "reason": null,
      "evidenced_fraction": 0.9, "tau_m": 0.04, "precision": 0, "recall": 0, "f": 0, "local_offset_m": 0.06 } ] },
  "probes": [ { "id": "…", "label": "…", "truth_m": 0, "measured_m": 0, "error_m": 0, "evidenced": true } ],
  "probe_summary": { "evaluated": 5, "missed": 0, "mean_error_m": 0.2, "mean_error_fraction": 0.014 },
  "alternates": [ { "id": "…", "f": 0.6, "closer_to_primary_fraction": 1,
    "contested": [ { "probe": "…", "primary_m": 0, "alternate_m": 0, "measured_m": 0, "closer_to": "primary" } ] } ],
  "appearance": { "delta_e_mean": 12, "match_fraction": 0.8, "compared_points": 0 },
  "technical": { "triangles": 0, "bytes": 0, "mesh_count": 0, "bounds": { "min": [], "max": [] } },
  "artifacts": [ "error-front.png" ], "timing_ms": 0 }
```

## 10. What "validated" means for the scorer

The scorer is not trusted until, on the fixture and on generated objects:

- the truth itself scores ≥ 98; re-tessellation, renaming and recolouring leave
  the geometry score unchanged;
- a rigid shift or yaw of a correct model leaves `score` unchanged and shows up
  only in `frame_error`;
- uniform scaling by 5 / 10 / 20 % lowers `score` monotonically on a metric
  task and leaves it unchanged on a scale-free task;
- removing a group drives that group's F towards 0 while other groups stay put;
- flattening small details (relief within the coarsest shape tolerance, 1 %
  of D) costs the shape score at most a few points and the detail score an
  order of magnitude more — the shape score is about massing, the detail
  score about detail;
- a bounding-box "massing only" model scores clearly below the truth and near 0
  on detail; a mirrored model of an asymmetric object scores clearly lower;
- on `t1` a front-only shell is not punished for the unseen rear, on `t2` it is.
