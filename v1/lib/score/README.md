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
not punished. Then, measuring from each point to the other model's visible
surface (not to its nearest sample point): how much of the submission lies
near the truth (precision), how much of the shown truth the submission covers
(recall), and their balance F, at tolerances of 0.25 %, 0.5 % and 1 % of the
object's size. The shape score is the mean of the three F values; the score is
the mean of the shape score and the detail score. Small features are judged
separately at their own scale, named dimensions are measured with rays,
colours are compared, and error pictures are drawn.

## Every number in the report

**`valid`, `error`, `score`, `scorer_failed`.** `score` = (`shape_score` +
`detail.score`) / 2, or `shape_score` alone when no detail group could be
scored. `valid: false` means the GLB broke the static-track contract, the task
budget, or has no visible surface; `score` is then 0 and `error` says why.
`scorer_failed: true` (present only then) means the scorer itself failed: it
caught an internal error, the report has `valid: false`, `score` 0 and an error
starting `Scorer error:`, and it is a scorer bug, not a contestant fault. Whoever
runs the scorer must not count it as an invalid model: the runner scores the
same file again, twice, and then records a `score_error` with no score
(`v1/lib/runner/README.md`, Statuses). Reports from before the flag (scorer
stamp `f36c91ed…` and older) carry only the `Scorer error:` prefix; the runner
counts that as the scorer's failure too.

**`scorer`** — `{ version, sha256 }`: which scorer wrote the report.
`version` names the scoring definition (1.1.0 since these tolerances; reports
without the field come from 1.0.0, 1 / 2 / 5 % point to point); `sha256`
covers the source of every `v1/lib/score/*.mjs` and every repository file
they import (the kernel and `lib/glb.mjs`, `lib/io.mjs`), computed once when
the scorer is loaded (`version.mjs`). A report re-scored later carries the
re-scoring code's stamp, so it can be told from one written at run time.
Compare scores only between reports with the same `version`; equal `sha256`
means exactly the same code (a comment edit changes it too). Adding
`scorer_failed` changed the `sha256` and no number in any report, so the
version stayed 1.1.0.

**`shape_score`** — 100 × the mean F over the threshold rows marked
`in_shape_score` (0.25 %, 0.5 % and 1 % of D; the list is
`global.shape_fractions`). A single tolerance is a cliff; the mean over a
geometric ladder gives graded credit for coarse, medium and fine agreement.

**`global.diagonal_m`** — D, the ground truth's bounding-box diagonal. Every
tolerance is a fraction of it.

**`global.thresholds[]`** — one row per tolerance, `fraction` of D and `tau_m`
in metres: 0.25 %, 0.5 %, 1 % (these enter `shape_score`), 2 % and 5 %
(diagnostics only). Do not assume the fractions: read `fraction`, and
`in_shape_score` or `global.shape_fractions`.
- `precision`: of the submission's visible surface that the evidence speaks
  for, the share within tau of the truth's visible surface. Surface whose
  nearest truth surface the evidence never showed is left out (you are not
  punished for inventing the back of a house nobody photographed) — unless a
  supplied camera looks straight through that place and sees something farther
  away: then the evidence shows it empty, and it counts (a second house beside
  the first, inside the photograph, is junk).
- `recall`: of the truth surface the evidence shows, the share within tau of
  the submission's visible surface.
- `f`: 2PR / (P + R). `in_shape_score`: whether the row enters `shape_score`.

Distances are measured from each sample point to the other model's
first-visible surface (`global.distance: "point-to-visible-surface"`, see
`surface.mjs`), not to its nearest sample point: two samplings of the same
surface lie up to a sample spacing (0.4 % of D) apart, which would be noise at
these tolerances.

**`global.shape_fractions`** — the fractions whose F values make
`shape_score`.

**`global.normal_consistency`** — mean |cos| of the angle between matched
truth and submission sample points within 2 %; 1 means every matched surface
faces the right way.

**`global.points`** — sample sizes: `truth` visible truth points,
`truth_evidenced` those the evidence shows, `candidate` visible submission
points, `candidate_counted` those that entered precision.

**`alignment`** — the fit that maps the submission onto the truth:
`p' = scale · Ry(yaw) · p + translation_m`. `scale_locked` is true on metric
tasks (scale 1). `start` names the start that won the multi-start search
(`as delivered` means the submission's own frame). Detail groups, probes and
contested probes are measured from this pose.

**`alignment.shape_pose`** — the pose the global surface measures
(`global.*`, `shape_score`, `appearance`, the error maps) were taken at.
`stage: "search"` means it is `alignment` itself; `"fine 1 %"`, `"fine 0.5 %"`
or `"fine 0.25 %"` means the fit's last stage (see "How the fit works") found a
pose that raises the shape score, given as `yaw_deg`, `scale`,
`translation_m`, with `moved_m` the most it moves a corner of the truth's
bounding box relative to `alignment`. For a model of the right size the two
coincide; for a mis-sized one the fine pose fits part of it closely instead of
spreading the error evenly.

**`alignment.frame_error`** — the same fit in plain words. `yaw_deg`: how far
the scorer had to turn the model. `offset_m`: how far from the frame's correct
place the submission put the object's centre (the truth's box centre, mapped
back into the submission). `offset_fraction`: that over D. `scale_log`: ln of
the fitted scale (0 when locked; −0.095 means the model was about 10 % too
big). A right shape in the wrong place shows up here and only here.

**`strict.f`** — F at 2 % with no fitting at all: the model exactly as
delivered, point to point on the samples (a diagnostic, not on the
`shape_score` scale). Strict close to the 2 % row of `global.thresholds` means
the contestant used the frame correctly.

**`shape.f`, `shape.scale`** — F at 2 % (point to point) with the scale fitted
even on a metric task, and that scale. On a metric task, `shape.f` high but
`score` low means "right shape, wrong size"; `shape.scale` says by how much.

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
against the earlier state of the object (its own fit, `alignment`, with the
fine stage; `alignment.stage` as in `shape_pose`). `f` is F at 2 % against
that state and `shape_score` the shape score against it. For each contested
probe: the true distance in
both states and the measured one; `closer_to` is `primary`, `alternate`, or
`neither` (both errors more than half the gap). The contested probes are read
in the frame fixed by the surface both states share, so the fit cannot pull an
old-state model towards the new state before it is measured.
`closer_to_primary_fraction` is the share of contested probes closer to the
current state.

**`appearance`** — for truth sample points whose nearest submission sample
point is within 2 % (glass excluded), the CIE76
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
misplaced), both measured to the other model's visible surface as the shape
score measures them. The colour stops are the shape tolerances: green up to
0.25 % of D, shading to yellow at 0.5 %, red at 1 %, dark red from 2 %;
grey hatching is surface that does not count (never shown by the evidence).
The title gives the shape score.

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
radius, Cauchy-weighted inside it, and, once the radius is under 5 % of D,
must face the same way. The best pose by F@2 % wins, except that a pose from a different basin
(turned round, scale or position far off) must beat the as-delivered one by
more than 1.5 points of F@2 % (and must not lose on F@1 %). With one-sided
evidence a model turned round can fit almost as well, and a near tie must not
throw away a correct frame. That pose is `alignment`.

Fine stage: from that pose, point-to-plane refinements with pairing radii of
1 %, 0.5 % and 0.25 % of D in turn (each from the previous one), judged by the
shape score itself (point to surface, on the submission's own sample, so no
re-sampling per pose); one replaces the searched pose for the global surface
measures only if it raises the shape score by more than half a point. It only
refines the pose the search chose, so it never changes the basin. Why: the
search settles at a 2 % radius, which spreads a mis-sized model's error so
that every wall lies within 2 % but few within the finer tolerances. On the
fixture (metric) models 5, 10 and 20 % too large then scored shape 8.7, 49.2
and 32.9 (the 10 % one the search had happened to fit to the walls that
agree), and score 42.8, 47.6, 29.9 — not the monotone fall DESIGN.md section
10 asks for; with the fine stage shape 57.1, 50.2, 32.9 and score 67.0, 48.1,
29.9. The ranking and final radius of the search itself stay at 2 % (with
1 % as tie-break): no test or calibration row showed a problem there. Detail
groups, probes and contested probes keep the searched pose: they were
calibrated with it, and a detail group gets its own frame anyway.

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
7. **Distances are to the other model's visible surface**, not to its nearest
   sample point (9.5 says "within τ of a truth point"). Two samplings of one
   surface with independent pixel and voxel phases (a submission is framed on
   its own bounds) lie up to a sample spacing apart: point to point, the truth
   itself scored F 60.7 at 0.25 % and 99.1 at 0.5 % in the worst of 150
   scorings of the 25 dev tasks (see "Choosing the tolerances"); to the
   surface 99.6 and 99.8, and 100 at 1 %. The distance goes to the triangles
   seen in the voxels of the sample points nearby; a triangle's closest point
   counts only if one of the 25
   sampling views sees it there (the depth map at that pixel's centre is not in
   front of the triangle's own plane there by more than a quarter pixel), else
   the nearest sample's distance stands. So a wall running on behind a porch is
   not matched by a model without the porch, and the sides of a post narrower
   than a voxel (which keeps one point, on its front) are.
8. **The fit has a fine stage** for the shape score's tolerances (see "How the
   fit works"); the global surface measures are taken at its pose
   (`alignment.shape_pose`), everything else at the searched pose.
9. **Edge-on triangles give no samples.** The kernel rasterizer reports hits
   along a triangle seen exactly edge-on when its line falls on a pixel centre
   (a wall plane in a side view), at interpolated depths that can lie behind
   other surfaces; the global sampling drops hits on triangles within 1e-6 of
   edge-on (`raster.mjs` itself is unchanged; the detail views still see them).

## Choosing the tolerances (measured, 2026-10-03)

The shape tolerances were 1 / 2 / 5 % of D. On the first pilot (4
configurations × 17 dev tasks) the two strongest configurations averaged 97.7
and 94.9 on shape and 99–100 on every task with scaled drawings: the measure
had no headroom left. Criteria, in order: (a) the truth and every benign change
score F >= 99.5 at every tolerance used; (b) no configuration's mean above
about 90 or below about 10; (c) three tolerances in a geometric ladder; (d)
the DESIGN.md section 10 behaviours hold. Scripts, raw numbers and the running
log: `.local/v1/scratch/scorer-2/` (`PROGRESS.md`, `noise-summary.txt`,
`pilot-summary.txt`).

Noise floor, through the whole pipeline (fit, re-sampling, metrics). A
submission is framed on its own bounds, so its samples fall elsewhere on the
same surface than the truth's; to reproduce that, the candidate's sampling box
was grown by random fractions of a voxel. Each of the 25 dev tasks was scored
with the truth (as delivered and at two random phases), the truth
re-tessellated (as delivered and at a third phase) and the truth shifted by
0.12 % of D (at the second phase): 150 scorings per row.

| distance | 0.25 % | 0.5 % | 1 % | 2 % | 5 % |
| --- | --- | --- | --- | --- | --- |
| nearest sample point (1.0.0), worst | 60.7 | 99.14 | 99.93 | 100 | 100 |
| nearest sample point (1.0.0), mean | 94.3 | 99.98 | 100 | 100 | 100 |
| visible surface (now), worst | 99.60 | 99.84 | 100 | 100 | 100 |
| visible surface (now), mean | 99.97 | 99.99 | 100 | 100 | 100 |

Point to point, a tolerance near the 0.4 % sample spacing measures the
sampling (125 of the 150 scorings fall below 99.8 at 0.25 %). To the surface
none of the 150 falls below 99.5 at 0.25, 0.5 or 1 %; worst per archetype at
0.25 %: house 99.94, retail 99.75, tower 99.94, hall 99.99, structure 99.60
(six of the seven scorings below 99.8 are the water tower's). Renaming,
recolouring, the calibration's large shift and turns of 0.3, 37, 180 and
−150 degrees on the five calibration tasks: worst 99.95 at 0.25 %, 100 at 0.5
and 1 %.

Pilot means (plain mean over the 17 tasks, a failed delivery counts 0; the
detail score is the same under every row, so the score column moves by half
the shape change; each ladder with its own fine stage):

| shape tolerances | astra | opus | luna | haiku |
| --- | --- | --- | --- | --- |
| shape, 1 / 2 / 5 %, point to point (1.0.0) | 97.7 | 94.9 | 80.2 | 59.0 |
| shape, 0.5 / 1 / 2 %, to the surface | 94.2 | 89.5 | 66.8 | 46.4 |
| shape, 0.25 / 0.5 / 1 %, to the surface | 88.0 | 80.4 | 53.7 | 37.8 |
| score, 1 / 2 / 5 % (1.0.0) | 79.4 | 75.3 | 52.8 | 35.6 |
| score, 0.5 / 1 / 2 % | 77.6 | 72.6 | 46.1 | 29.3 |
| score, 0.25 / 0.5 / 1 % | 74.5 | 68.1 | 39.5 | 25.0 |

0.5 / 1 / 2 % still leaves the best configuration at 94.2, above "about 90"
(92.5–99.9 on the ten tasks with drawings, eight of them above 97), so the
ladder is one step finer: 0.25 / 0.5 / 1 %, which leaves the best at 88.0 and
the weakest at 37.8. Per
evidence level (shape, 0.25 / 0.5 / 1 %): astra 87.8 / 74.4 / 95.6 / 93.9 and
haiku 20.0 / 37.2 / 47.6 / 35.5 on t1 / t2 / t4 / c1. 0.25 % of D is 6 cm on
the dev house: five pixels of its 1.25 cm/px elevations, two of its
photographs; the strongest configuration's F there ranges from 79 to 98 on
the ten drawing tasks (median 93.5). The 2 % and 5 % rows stay in the report
as diagnostics.

## Known limits (measured)

On the fixture (synthetic evidence; `calibrate` and the tests): every
DESIGN.md section 10 property holds on the metric all-round, scale-free
all-round and front-photo contexts except the scale-free roof removal below,
and "flattening small details leaves the headline almost unchanged" holds only
in the weaker form below. On the dev set (`node v1/cli.mjs calibrate`,
2026-10-03): house-0011-t4 40/41 rows pass, retail-0012-t3 37/39,
tower-0013-t2 30/31, hall-0014-t2 36/38, structure-0015-t1 25/26 — 168 of 175.
The seven failures are the ones the 1.0.0 scorer had: six are other groups'
detail F drifting when a large structure is removed (house roof: upper windows
−0.43; hall nave roof: windows −0.10; hall tower top: belfry −0.47, the fit's
scale 3 % off; retail body and storefront: base −0.19 and −0.22; tower shaft:
facade grid −0.10; identical under 1.0.0 where re-checked, house roof and hall
tower top, as the detail stage is unchanged), and one is the water tower's
front shell on its single photograph (score −8.6: the rear members show
through the open frame, so they are evidence). Across the five: truth 99.9–100
with F ≥ 99.5 at every shape tolerance, unchanged (within 0.9) under
re-tessellation, renaming, recolouring, shift and turns; 5 / 10 / 20 % too
large on the two metric tasks 61.8–68.8 / 42.2–50.1 / 26.9–49.1; a bounding
box 10.8–38.4; mirrored 29–55 points lower; a ground plane 29–45 lower; a copy
beside the model 17–48 lower; the front-only shell with four photographs 47–61
lower. Measured with 1.0.0 (2cef4f9) and not repeated: decoy contested probes
resolve correctly for all five archetypes in both directions.

- Size errors on a metric task (fixture, t2): shape 100 → 57.1 / 50.2 / 32.9
  and score 100 → 67.0 / 48.1 / 29.9 for 5 / 10 / 20 % too large. The shape
  pose of the 5 and 10 % models fits part of the model closely (fine stage);
  `shape.scale` names the error exactly either way.
- Downward faces (soffits, canopy undersides, a tank bottom) are seen by the
  25 sampling views only edge-on, from the horizontal ones (no view looks up):
  they get few samples, and the visibility test does not ask views within
  about a degree of a face's plane, so their distances fall back to the
  nearest sample's. What is left of the noise floor sits mostly on the water
  tower (six of the seven of 150 noise scorings below 99.8 at 0.25 %, worst
  99.60); pass 3 traced it to the tank bottom, not re-traced since.
- The shape tolerances are finer than many small features: on the fixture,
  painting the front windows (recessed 14 cm, 0.9 % of D) and door on the wall
  costs 1.95 shape points with all-round evidence and 4.53 with the front
  photograph alone (1.0.0: 0.25 and 0.64), against 35.9 and 87.7 detail
  points. The detail score still carries the detail; the shape score no longer
  ignores it. `calibrate` therefore asks "shape within 2" only of relief within
  the coarsest shape tolerance (1 % of D; 1.0.0 used 2 %, under which
  tower-0013-t2's core, 1.25 m = 1.9 % of D, costing 3.1 shape points, would
  now fail).
- The fine stage raises the shape score most for weak, mis-sized models: pilot
  means without it 87.0 / 78.6 / 49.8 / 33.1, with it 88.0 / 80.4 / 53.7 / 37.8
  (astra / opus / luna / haiku; it replaced the searched pose on 2 / 2 / 12 /
  13 of the 17 submissions). It measures each model at the pose that suits the
  measure, which the searched pose did not; without it the fixture's metric
  scale test fails (5 % too large: shape 8.7, score 42.8; 10 %: 49.2, 47.6).
- Removing a whole roof (35 % of the fixture's surface) on a scale-free task:
  the exposed interior (inner wall faces 0.3 m behind the outer ones, tau
  0.31 m) makes a 2.2 % larger pose the best F@2 % fit, globally and for the
  rest of the object alike; at that scale the gable tops lie on parts of the
  roof (roof F 0.23) and the window rows lose up to 0.07. On a metric task the
  roof falls to 0 and every other group stays within 0.02. On the generated
  house the chimney still loses 0.13 when the roof is removed.
- Removing all walls of a retail building leaves its floating storefront,
  plinth, plant and service openings with no frame of their own: on the seed-3
  retail (1.0.0) their F fell to 0.03–0.59; on retail-0012-t3 the base loses
  0.19 (shape 48.0, detail 88.3, score 68.1). "Other groups stay put" does not
  hold there.
- A bounding box keeps most of a box-like building's surface: on tower-0013-t2
  it scores shape 63.4 (detail 9.6, score 36.5). The score, half detail, is
  what rejects it.
- With junk dominating F on a scale-free task, the F-maximising fit may shrink
  the whole submission to trade recall for precision (front photo + large
  ground plane: scale 0.89, recall 0.89, score 18).
- With a single front photograph the yaw basin is decided by shallow features;
  a model delivered backwards is turned round only because the truth turned
  round loses 2.1 points there (more than the 1.5-point margin). With one
  photograph a roofless model is fitted turned round and lifted (F@2 % +4.1).
- Groups whose relief is at or below their own tau_g (0.6 × detail size) cannot
  be told from their absence: a generated retail plinth standing 2–3 cm proud
  with detail size 5 cm kept F 0.76 when removed (seed-3 retail, 1.0.0; the
  detail stage is unchanged). That is a generator setting.

## Timing

Measured 2026-10-03 on an Apple M5 (4 performance + 6 efficiency cores)
shared with other work, so wall times swing with the load: one process per
scorer, old (1.0.0) and new run side by side on the same stored pilot
submissions, CPU seconds (wall in brackets where the machine was quiet).

| submission | 1.0.0 | now |
| --- | --- | --- |
| astra house-0011-t2 | 21.8 (20.9) | 25.3 (24.2) |
| haiku house-0011-c1 | 52.5 (52.4) | 26.4 (25.9) |
| luna hall-0014-c1 | 38.7 | 27.8 |
| opus retail-0012-t4 | 26.5 | 24.8 |
| astra structure-0015-c1 | 27.4 | 30.9 |
| luna tower-0013-c1 | 279.5 | 85.1 |
| opus tower-0013-t2 | 93.1 | 97.0 |
| haiku tower-0013-t2 | 445.2 * | 77.6 |

\* from an earlier side-by-side run at a load average near 100 (the new
scorer took 68.8 s there).

Loading a task's context takes 1.3–8 s. The detail groups take 50–80 % of a
submission's time under the new scorer (55–94 % under 1.0.0), and the
tower's 80 m `facade.grid` group (430k truth points) about 23 s alone; the new
global measures (point-to-surface distances, the fine stage, the alternates'
re-sampling, the error maps) add up to about 20 % to a typical submission. The detail stage's far
nearest-point queries (a group's local fit and attribution, for every truth
point a wrong model lacks) now go through a k-d tree pruned by node boxes
instead of walking empty grid rings, with the same answers: that is what
removed the 280–445 s cases. The test's 179k-triangle candidate on the
fixture: 8.3 s on a quiet machine; at a load average of 120–160, 19.9 s CPU
and 25.0 s wall (1.0.0: 18.9 s and 27.6 s). The test bounds CPU time at 30 s:
wall time on a shared machine reached 31.4 s once.

## Files

`index.mjs` scoring and report · `surface.mjs` point-to-visible-surface
distance · `context.mjs` truth side (sampling, coverage,
groups, probes, alternates, partial frames) · `align.mjs` multi-start ICP and
plane refinement · `grid.mjs` nearest-neighbour grids and point-to-triangle
distance · `sampling.mjs` visible-surface sampling · `coverage.mjs` evidence
coverage and empty-space test · `metrics.mjs` headline and appearance ·
`detail.mjs` detail groups · `errormap.mjs` PNGs · `mutations.mjs` defect
injectors · `calibrate.mjs` mutation table · `synthetic.mjs` synthetic
evidence cameras for tests and calibration · `version.mjs` the `scorer` stamp
(version and source hash).
