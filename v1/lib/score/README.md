# Evidence3D v1 scorer (module D)

Compares a submitted GLB with the hidden ground-truth model of a task and
writes an `e3d-report-v1` report. It implements DESIGN.md section 9; where it
departs from the letter of section 9 this file says so and why (see
"Departures"). Everything is deterministic: no randomness, no wall clock in
any number except `timing_ms`.

```js
import { scoreSubmission, scoreSoup, loadContext, makeContext, mutations, calibrate } from './v1/lib/score/index.mjs';

const context = await loadContext({ taskDir, truthDir, dataRoot });          // once per task
const report = await scoreSubmission({ glb, taskDir, truthDir, dataRoot, outDir, context }); // context optional
const rows = calibrate(context);                                              // mutation table
```

`scoreSubmission` never throws for a bad submission: an unreadable or
over-budget GLB gives `valid: false, score: 0` and the reason. It does throw
when the benchmark's own data is broken (missing truth, evidence item named in
truth.json but absent from evidence.json): that is not the contestant's fault
and must not be scored as if it were.

## How a score is made, in one paragraph

Both models are looked at from 25 directions and every first-visible surface
point is kept (about one point per 0.4 % of the object's size). A ground-truth
point counts only if the evidence the contestant was given actually shows it
(a supplied photograph or drawing sees it, not hidden by the building or a
tree, not edge-on). The submission is turned, moved and — when the evidence has
no scale — resized to fit the truth as well as possible; that fit is reported,
not punished. Then: how much of the submission lies near the truth
(precision), how much of the shown truth the submission covers (recall), and
their balance F. The headline is F at a tolerance of 2 % of the object's size.
Small features are judged separately at their own scale, named dimensions are
measured with rays, colours are compared, and error pictures are drawn.

## Every number in the report

**`valid`, `error`, `score`.** `score` is 100 × F at 2 % of the diagonal (the
headline). `valid: false` means the GLB broke the static-track contract, the
task budget, or has no visible surface; `score` is then 0 and `error` says why.
An error starting `Scorer error:` is a scorer bug, not a contestant fault.

**`global.diagonal_m`** — D, the ground truth's bounding-box diagonal. Every
tolerance is a fraction of it.

**`global.thresholds[]`** — for tolerances of 1 %, 2 % and 5 % of D (`tau_m`):
- `precision`: of the submission's visible surface that the evidence speaks
  for, the share within tau of the truth. Surface whose nearest truth surface
  the evidence never showed is left out (you are not punished for inventing the
  back of a house nobody photographed) — unless a supplied camera looks
  straight through that place and sees something farther away: then the
  evidence shows it empty, and it counts (a second house beside the first,
  inside the photograph, is junk).
- `recall`: of the truth surface the evidence shows, the share within tau of
  the submission.
- `f`: 2PR / (P + R). The 2 % row is the headline.

**`global.normal_consistency`** — mean |cos| of the angle between matched
truth and submission surface directions at 2 %; 1 means every matched surface
faces the right way.

**`global.points`** — sample sizes: `truth` visible truth points,
`truth_evidenced` those the evidence shows, `candidate` visible submission
points, `candidate_counted` those that entered precision.

**`alignment`** — the fit that maps the submission onto the truth:
`p' = scale · Ry(yaw) · p + translation_m`. `scale_locked` is true on metric
tasks (scale 1). `start` names the start that won the multi-start search
(`as delivered` means the submission's own frame).

**`alignment.frame_error`** — the same fit in plain words. `yaw_deg`: how far
the scorer had to turn the model. `offset_m`: how far from the frame's correct
place the submission put the object's centre (the truth's box centre, mapped
back into the submission). `offset_fraction`: that over D. `scale_log`: ln of
the fitted scale (0 when locked; −0.095 means the model was about 10 % too
big). A right shape in the wrong place shows up here and only here.

**`strict.f`** — F at 2 % with no fitting at all: the model exactly as
delivered. Strict ≈ score means the contestant used the frame correctly.

**`shape.f`, `shape.scale`** — F at 2 % with the scale fitted even on a metric
task, and that scale. On a metric task, `shape.f` high but `score` low means
"right shape, wrong size"; `shape.scale` says by how much.

**`detail`** — small features, judged at their own scale.
- `groups[]`: one row per model group. `tau_m` = 0.6 × the group's detail
  size. `scored` is false (with `reason`) when under half of the group is shown
  by the evidence (`evidenced_fraction`). `precision`/`recall`/`f` are as
  above but at `tau_m`, inside the group's own box, and a match also needs the
  two surfaces to face the same way (within 45°). `local_offset_m` is the
  small shift (at most 2 % of D) the scorer allowed the group, `local_offset`
  the shift vector; `frame_offset_m` is how far the group's own frame (fitted to
  the rest of the object) moved it from the global fit.
- `categories[]`: mean group F per category; `score` = 100 × the mean over
  categories. `null` with a `note` when no group could be scored.

**`probes[]`** — named dimensions measured by casting the probe ray at the
truth (`truth_m`) and at the fitted submission (`measured_m`); `error_m` is the
difference. `missed` means the ray hit nothing. `evidenced: false` means the
evidence never showed the spot the ray hits; such probes are listed but left
out of `probe_summary`.

**`probe_summary`** — `evaluated` (evidenced probes), `missed`,
`mean_error_m` (over those that hit), `mean_error_fraction` (over D).

**`alternates[]`** — conflict tasks only: the submission is also scored
against the earlier state of the object (its own fit, `alignment`). `f` is the
headline F against that state. For each contested probe: the true distance in
both states and the measured one; `closer_to` is `primary`, `alternate`, or
`neither` (both errors more than half the gap). The contested probes are read
in the frame fixed by the surface both states share, so the fit cannot pull an
old-state model towards the new state before it is measured.
`closer_to_primary_fraction` is the share of contested probes closer to the
current state.

**`appearance`** — for truth points matched at 2 % (glass excluded), the CIE76
colour difference between solid base colours (linear-sRGB → CIE L*a*b*, D65).
`delta_e_mean`: mean difference (0 identical; about 2.3 is just noticeable).
`match_fraction`: share of pairs with ΔE ≤ 10. Textures and vertex colours
are ignored.

**`technical`** — the submission as read: triangle count, file bytes (null for
an in-memory soup), mesh count, raw bounds before any fitting.

**`artifacts`** — files written to `outDir`: `error-front.png`,
`error-right.png`, `error-rear.png`, `error-top.png`. Left panel: the truth,
coloured by distance to the fitted submission (what is missing). Right panel:
the submission, coloured by distance to the truth (what is extra or
misplaced). Green is within 1 % of D, yellow 2 %, red 5 % and beyond; grey
hatching is surface that does not count (never shown by the evidence).

**`evidence`** — which supplied items gave coverage, and why the others did
not (`stale`, `plan adds no coverage`, `no camera`). **`warnings`** —
data-consistency notes from `loadContext` (task hash mismatch, scale
disagreement). **`timing_ms`**, **`timing_breakdown_ms`** — wall time,
cumulative per stage.

## How the fit works

Starts: the model as delivered, and twelve headings with the box centres
matched (for one or two initial scales when scale is free). Each runs a short
coarse ICP; the best few by F@2 % — and always the as-delivered start — run to
convergence; then a point-to-plane Gauss-Newton polish (yaw, scale,
translation). ICP pairs come from both directions with equal weight (junk only
spoils one, missing parts only the other), are dropped beyond a shrinking
radius, Cauchy-weighted inside it, and in the fine stage must face the same
way. The best pose by F@2 % wins, except that a pose from a different basin
(turned round, scale or position far off) must beat the as-delivered one by
more than 1.5 points of F@2 % (and must not lose on F@1 %). With one-sided
evidence a model turned round can fit almost as well, and a near tie must not
throw away a correct frame.

## Departures from DESIGN.md section 9 (and why)

1. **Precision counts surface the evidence shows to be empty** (9.5 counts
   only candidate points whose nearest truth point is evidenced). Without it,
   on a front-photo task a copy of the house standing beside it, inside the
   photograph, cost 13 points instead of 41, because its nearest truth surface
   is the unphotographed side wall.
2. **Detail matching needs agreeing normals (45°)**, and a candidate element
   is attributed to the truth part whose real surface (hidden faces included)
   it lies on, preferring a surface that points the same way: where two parts
   touch (a frame's outer side against its wall reveal, a buttress against its
   wall) the truth's outward winding tells them apart. Without this a missing
   chimney kept F 0.34 and missing windows 0.25 (the roof around the chimney's
   foot and the wall reveal around a frame lie within tau_g of them), and the
   wall patch behind a dropped buttress or pier was slid onto where it stood.
3. **Detail groups are judged in a frame fitted to the rest of the object**
   (9.6 says "aligned-candidate points"). The headline fit of a model with a
   missing roof lifts it 0.25 m so its gable tops touch the roof; judged in that
   frame the missing roof kept F 0.36.
4. **The local translation fit** is limited along the facade normal to
   ±0.25 tau_g around the depth offset of the surrounding facade (so a flat
   facade reaches at most 0.75 × the detail size of relief), and may only move
   geometry attributed to the group (plus elements a shift explains clearly
   better). Without the first, a flat box face slid back onto a recessed door
   plane scored door F 0.83 and a bare wall "recalled" pilasters standing out
   exactly their detail size (F 0.72); without the second, gable tops were slid
   onto a missing roof.
5. **Candidate sampling density is the truth's**, not 0.4 % of the candidate's
   own diagonal, and views are framed on area-trimmed bounds with a 400k-point
   budget: junk far away must neither coarsen the sampling of the real model
   nor make scoring take minutes (a 1 km triangle took 228 s before).
6. **Frame preference** (FRAME_MARGIN above): the pose search is "best F@2 %
   wins" only within a basin.

## Known limits (measured)

On the fixture (synthetic evidence; `calibrate`): every DESIGN.md section 10
property holds on the metric all-round, scale-free all-round and front-photo
contexts except the scale-free roof removal below. On generated objects
(seed 3, metric all-round): hall 38/38 and structure 25/25 calibration rows
pass, tower 31/32, house 36/37, retail 35/36; decoy contested probes resolve
correctly for all five archetypes in both directions.

- F@2 % is nearly blind to a 5 % size error once the model is centred: 100 →
  99.87 on a metric task (10 %: 59.7, 20 %: 44.9). The fall is monotone and
  `shape.scale` names the error exactly, but if a 5 % size error must cost
  headline points the headline would need F@1 % or a scale term.
- Removing a whole roof (35 % of the fixture's surface) on a scale-free task:
  the exposed interior (inner wall faces 0.3 m behind the outer ones, tau
  0.31 m) makes a 2.2 % larger pose the best F@2 % fit, globally and for the
  rest of the object alike; at that scale the gable tops lie on parts of the
  roof (roof F 0.23) and the window rows lose up to 0.07. On a metric task the
  roof falls to 0 and every other group stays within 0.02. On the generated
  house the chimney still loses 0.13 when the roof is removed.
- Removing all walls of the generated retail building leaves its floating
  storefront, plinth, plant and service openings with no frame of their own
  (F 0.03 to 0.59). Headline 53.8 and detail 66 are low, but "other groups stay
  put" does not hold there.
- A bounding box earns the massing share of `detail.score` when the building is
  itself box-like (generated tower: detail 28.6, headline 22).
- With junk dominating F on a scale-free task, the F-maximising fit may shrink
  the whole submission to trade recall for precision (front photo + large
  ground plane: scale 0.89, recall 0.89, score 18).
- With a single front photograph the yaw basin is decided by shallow features;
  a model delivered backwards is turned round only because the truth turned
  round loses 2.1 points there (more than the 1.5-point margin). With one
  photograph a roofless model is fitted turned round and lifted (F@2 % +4.1).
- Groups whose relief is at or below their own tau_g (0.6 × detail size) cannot
  be told from their absence: a generated retail plinth standing 2–3 cm proud
  with detail size 5 cm keeps F 0.76 when removed. That is a generator setting.

## Timing

Fixture context 0.3–0.5 s; a fixture-sized candidate 2–5 s; 179k triangles
6.4 s; 717k triangles 28.5 s (with five other scorers running); generated
tower (30k triangles, 9 groups) context 4.1 s, candidate 15–19 s, most of it
in the detail views of its 80 m `facade.grid` group.

## Files

`index.mjs` scoring and report · `context.mjs` truth side (sampling, coverage,
groups, probes, alternates, partial frames) · `align.mjs` multi-start ICP and
plane refinement · `grid.mjs` nearest-neighbour grids and point-to-triangle
distance · `sampling.mjs` visible-surface sampling · `coverage.mjs` evidence
coverage and empty-space test · `metrics.mjs` headline and appearance ·
`detail.mjs` detail groups · `errormap.mjs` PNGs · `mutations.mjs` defect
injectors · `calibrate.mjs` mutation table · `synthetic.mjs` synthetic
evidence cameras for tests and calibration.
