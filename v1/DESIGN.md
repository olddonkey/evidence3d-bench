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
    alternates/<alt-id>/model.json  model.glb  change.json     earlier state (decoy)
    evidence/evidence.json                every rendered evidence item + cameras
    evidence/<files>                      photos/*.jpg  drawings/*.png  notes/*.md
tasks/<task-id>/task.json  inputs/*       the public pack — all a contestant gets
truth/<task-id>/truth.json                which object/variant/evidence the task used
runs/<batch-id>/…                         generation attempts and their scores
reports/<name>/…                          aggregated results
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

Generation under isolation for two harnesses, `codex` and `claude-code`, with
preflight probes, timing, token accounting, and scoring of what was produced.

### G. Rendering, contestant preview tool, report — `v1/lib/render/**`, `v1/tools/**`, `v1/lib/report/**`

```js
export function shadeSoup(soup, camera, options);       // → { width, height, pixels RGB }
export async function installTools(destination);        // copies the contestant tool kit
export async function aggregate({ dataRoot, batches }); // → leaderboard object
export async function writeReport({ dataRoot, batches, outDir });   // static HTML + JSON
```

### Orchestrator — `v1/lib/pack.mjs`, `v1/cli.mjs`, this file

Builds objects (model → GLB → evidence), assembles task packs and truth,
exposes the CLI, wires modules together.

## 9. Scoring definition (module D implements exactly this)

Let `D` be the ground-truth bounding-box diagonal.

1. **Validity gate.** `soupFromGLB` with the task budget. Invalid → `valid:
   false`, `score: 0`, the reason, and nothing else is computed.
2. **Visible-surface sampling.** Truth and candidate are each rendered from 25
   orthographic directions (8 azimuths × elevations 0°, 30°, 60°, plus top),
   framed on their own bounds; hit pixels are unprojected and thinned on a voxel
   grid so spacing ≈ 0.4 % of that soup's diagonal. Only first-visible surfaces
   count: interiors and hidden faces are neither rewarded nor punished. Each
   truth point keeps its part id and normal.
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
5. **Headline.** At τ ∈ {1 %, 2 %, 5 %} of `D`: precision = share of candidate
   points within τ of a truth point; recall = share of evidenced truth points
   within τ of a candidate point; candidate points whose nearest truth point is
   not evidenced are left out of precision. `F = 2PR/(P+R)`. **`shape_score =
   100 × the mean of F@1 %, F@2 % and F@5 %`** — a single tolerance is a cliff
   (at 2 % a model 5 % too large still scores 99.9); the mean gives graded
   credit for coarse, medium and fine agreement. **`score = (shape_score +
   detail.score) / 2`** (shape alone when no detail group could be scored):
   surface agreement is dominated by large flat faces, so a bare bounding box
   of a slab tower earns 82 on shape; detail is what separates a model of the
   object from a box around it. Also reported: `strict` (no fitting at all) and `shape` (scale
   fitted even on metric tasks), so "shape right, scale wrong" is distinguishable
   from "shape wrong".
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
  "task_id": "…", "object": "…", "variant": "t2",
  "valid": true, "error": null, "score": 71.3,
  "global": { "diagonal_m": 14.2, "normal_consistency": 0.93,
    "thresholds": [ { "fraction": 0.01, "tau_m": 0.142, "precision": 0.6, "recall": 0.5, "f": 0.55 }, … ],
    "points": { "truth": 0, "truth_evidenced": 0, "candidate": 0, "candidate_counted": 0 } },
  "alignment": { "yaw_deg": 1.2, "scale": 1, "scale_locked": true, "translation_m": [0, 0, 0],
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
- flattening small details leaves the headline almost unchanged and lowers
  `detail.score` — the headline is about massing, the detail score about detail;
- a bounding-box "massing only" model scores clearly below the truth and near 0
  on detail; a mirrored model of an asymmetric object scores clearly lower;
- on `t1` a front-only shell is not punished for the unseen rear, on `t2` it is.
