# Results report (module G)

Reads run batches, aggregates them into a leaderboard (`e3d-leaderboard-v2`)
and writes a static site that opens from disk: `index.html` (per task set:
what the set is, leaderboard, pairwise comparison, where the noise is,
evidence deltas, archetypes, detail by category, named dimensions, frame and
scale, evidence use and cost, task index; then provenance, excluded attempts,
data problems), `summary.md` (the same numbers in Markdown,
to paste into a document), one page per task under `tasks/`, renders and
copied evidence under `assets/`, and the full leaderboard as
`leaderboard.json`.

```sh
node v1/cli.mjs report --batches A,B,C --out .local/v1/reports/NAME
```

```js
import { aggregate, writeReport, comparePair } from './index.mjs';
await aggregate({ dataRoot, batches, outFile });        // -> leaderboard object (JSON written unless outFile: null)
await writeReport({ dataRoot, batches, outDir });       // -> compact summary, see below
```

`writeReport` returns only what a terminal should show (the CLI prints it):
`{ outDir, index, summary, leaderboard, tasks, attempts, attempts_drawn,
images, problems, sets: [{ id, kind, objects, tasks, counted, ranking: [{ rank,
key, score, ci95 }], pairs: [{ a, b, difference, ci95, t_ci95, verdict }] }],
timing: { collect_s, aggregate_s, parse_s, render_s, pages_s, total_s } }`.
Everything else is in `leaderboard.json`.

## What counts

- **Attempts** are `runs/<batch>/<task>/a<n>/result.json` with their score
  report (`result.report`, relative to the attempt or, as the runner writes
  it, to the batch; else `score/report.json`). A directory without
  `result.json` is unfinished: counted per batch, never a sample. An earlier
  try the runner archived after an infrastructure error (`a<n>.infra-<k>/`) is
  counted in the provenance and is never a sample.
- **Excluded statuses** (`DEFAULT_EXCLUDED_STATUSES`: `infra_error`,
  `harness_error`, `preflight_failed`, `cancelled`, `skipped`, `score_error`)
  are failures of the harness, the machine or the scorer. They are listed with
  the runner's reason (`result.infra.reason`) and are left out of every mean
  and every comparison. Every other attempt without a valid report scores 0
  (timeouts without a model, invalid GLBs, missing artifacts).
- **Configurations** are `system / model / effort` as requested in
  `result.json`. Batches of one configuration merge; when the merged batches
  differ in CLI version or binary, prompt, runner, tool kit, runtime, protocol,
  the scorer source frozen in the manifest or the scorer stamped in the
  reports, the configuration is flagged on the page and in `problems`.
- **Sets**: tasks are grouped by the optional `set` of their `truth.json`
  (`unnamed` when absent, `unknown` when `truth.json` is missing). Every set is
  ranked and compared on its own; nothing pools two sets. Each set carries a
  `description` (`kind`: development / named / unnamed / unknown): `dev` is
  the development set, whose objects were used to tune the scorer, so its
  numbers are flagged as not test results; an unnamed set whose tasks appear
  in `sets/dev.built.json` is flagged the same way. Set files under
  `<data>/sets/` (`private`, `created_at`, `built_at`) are shown as facts.
- **Averaging** is hierarchical: attempts within a task, tasks within an
  object, then objects, so a configuration with three attempts per task and
  one with one attempt compare on the same footing.

## Uncertainty

- Leaderboard cells: mean over objects with a 95 % percentile bootstrap over
  objects (2000 resamples, seeded through `v1/lib/rng.mjs`); flagged below 3
  objects.
- **Pairwise** (`comparePair`), for every pair of configurations in a set, A
  being the higher-ranked: per object, on the tasks both ran, mean of A minus
  mean of B; then the mean difference, a 95 % paired bootstrap over objects
  (10 000 resamples), a Student-t interval of the same differences, the share
  of resamples with A ahead (a description of the sample, not a probability),
  and objects won / tied / lost. Verdict: `a_higher` / `b_higher` when both
  intervals exclude zero, `not_separated` when both include it, `unsettled`
  when they disagree, `not_evaluated` below two objects. The page says this in
  words per pair and notes that intervals are not corrected for multiple
  comparisons.
- Why both intervals: on a synthetic design (object effect, configuration ×
  object interaction, attempt noise, 3 vs 1 attempts per task) the percentile
  bootstrap covered the true difference 84 % of the time with 5 objects, 92 %
  with 10 and 93 % with 24, and separated two equal configurations 16 %, 10 %
  and 6 % of the time; the t interval stayed at 94–96 % and 5–6 %.

## Where the noise is (`set.variance`)

All on `report.score`, failures as 0, excluded attempts left out.

- `configurations[].attempt_sd`: standard deviation between attempts on the
  same task, pooled over the tasks a configuration ran at least twice
  (`pooledSD`), with its degrees of freedom, failures among them, and a 95 %
  chi-square range (`sdRange`, normal noise assumed). Null when no task ran
  twice.
- `configurations[].object_sd`: standard deviation of the per-object mean
  scores, and `attempt_share`, the part of its variance that attempt noise
  alone would produce (σ²_attempt × mean over objects of Σ_t(1/n_t)/T²).
- `pairs[]`: standard deviation of the per-object differences of a pair (what
  the pairwise interval resamples), `resolution` (half-width of the 95 % t
  interval: the smallest observed difference whose interval excludes zero) and
  `detectable` (true difference found with 80 % power by a two-sided 95 % t
  test, `detectableDifference`), each with the range implied by the SD's own
  uncertainty, `projected` to `PLANNED_OBJECTS` (24) objects with the same
  attempts and tasks per object, and the share of the paired variance that is
  attempt noise (`attempt_share`; `attempt_share_at_least` when only one side
  ran tasks twice; `without_attempt_noise`, the floor with attempts averaged
  away).
- Every SD on fewer than `LITTLE_DATA_DF` (10) degrees of freedom is marked as
  resting on little data, on the page and in the JSON (`little_data`).

## Breakdowns

- `entry.variants[v]`: mean score per variant.
- `entry.evidence_deltas['hi-lo']`: for every pair of variants of one family
  present in the set (`variantPairs`, later minus earlier in `VARIANT_ORDER`,
  so t4 − t2, c1 − t2 and c1 − t4 for the planned design), per object the mean
  score on one minus the mean on the other, over objects with both, with
  bootstrap and t intervals and paired/unpaired object counts. Families
  (`variantFamily`): generated objects (t1–t4, c1), memory tasks on named
  landmarks (m2, m3) and real buildings (r2, r4); variants of different
  families are never paired (an m2 object is not a t2 object). `entry.ladder`
  (adjacent t rungs only) is kept for readers of earlier leaderboards.
- `entry.archetypes[a]`: mean score over the objects of each archetype
  (`objects/<id>/model.json` → `archetype`; `unknown` when model.json is
  missing, which is also a problem).
- `entry.conflict`: on c1 tasks, the share of contested probes closer to the
  as-photographed state.
- `entry.memory`: on the memory tasks m2 and m3 (a named landmark whose
  surveyed form differs from its published figures; the truth's alternate
  `remembered` is the structure as published), the share of contested probes
  closer to the surveyed object the evidence shows. Both come from the
  contract's `CONFLICT_VARIANTS`, split by `CONFLICT_KINDS` (a memory variant
  is one with `memory: true`): they measure different temptations, out-of-date
  drawings and remembered figures, so they are never pooled. The index page,
  `summary.md` and the task pages label each for what it means; the Memory
  column appears only in a set that has memory tasks.

## Diagnostics

Where a delivered model loses its score, per configuration. Valid attempts
only: a failure has no model to diagnose and is counted in `success` (the
Detail column, which counts failures as 0, therefore runs lower than the
categories). Same averaging as the score: attempts within a task, tasks within
an object.

- `entry.detail_categories[c]`: for every category of `report.detail.categories`
  present in the set (`set.detail_categories`, each with the number of objects
  that have a scored group of it; `DETAIL_CATEGORIES` gives the DESIGN.md order,
  other categories follow by name), 100 × the category's mean group F. A
  report's `detail.score` is the mean of these over its categories. Which
  categories a task scores depends on the evidence, not on the contestant.
  Mean over objects with the bootstrap interval, like the leaderboard.
- `entry.probe_error` (`probeErrors`): the named dimensions, counted as the
  scorer's `probe_summary` counts them (probes the evidence shows whose ray
  hits the truth). Per attempt, the median absolute error of the probes whose
  ray hit the submission, in centimetres (`cm`) and as a percentage of the
  truth diagonal (`diagonal_pct`); `missed`, the share of probes whose ray hit
  nothing on the submission; `probes`, the counts behind them.
- `entry.frame_error` (offset as a fraction of the diagonal, offset in metres,
  absolute yaw) and `entry.scale_error_pct` (|`shape.scale` − 1| on metric
  tasks) as before.

`probe_error.cm`, `probe_error.diagonal_pct`, `frame_error.*` and
`scale_error_pct` also carry `median` and `iqr`: the median and interquartile
range (`spread`, linear-interpolated quartiles) of the per-object values. These
errors are skewed (one model turned round adds 180° to its object), so the page
and `summary.md` show the median with the IQR under it, a description of the
spread and not an interval; the mean and its bootstrap interval stay in the JSON
(same seeds as before) and in each cell's tooltip.

## Scale

Work is bounded per attempt. On a task page only each configuration's best,
median and worst counted attempt (`pickRepresentatives`) is parsed, rendered
(four views) and has its error maps copied; every other attempt, excluded ones
included, is one row in a collapsed table built from the report already in
memory. With three attempts per task, all three are the representatives; the
bound matters above three. Objects are processed one at a time: the truth is
rendered once per object (`assets/renders/objects/<object>/`) and all its
tasks share one frame, computed from the reports' recorded bounds and
alignment (`objectFrame`) without parsing any candidate; one candidate soup is
in memory at a time. Evidence files are stored once by content hash
(`assets/inputs/`), copied with copy-on-write clones where the file system
supports it. A recorded artifact hash is checked only for drawn candidates,
just before they are parsed.

## Provenance

Per batch, from `manifest.json` (and `preflight.json`): CLI version and binary
hash, login kind, runner and runner-source hash, scorer source and generator
source hashes, prompt version and hashes, contestant tool-kit hash, runtime,
protocol, repository commit, whether the isolation preflight passed and is
bound to this manifest (`objectHash(manifest)`); from the attempts: the model
the harness reported, the scorer stamped into the reports (`report.scorer`:
version and sha256) with the number of unstamped reports and of reports
recomputed by `cli rescore` (a `report.previous.json` next to the report), the
first start and last finish, and status counts.

The manifest's `scorer_source.sha256` (runner: `objectHash` of the per-file
hashes of its module closure) and the report's `scorer.sha256` (scorer
`version.mjs`: one sha256 over path, length and bytes of each file) hash the
same code by different schemes. They are shown side by side and each is
compared only across batches, never with the other. If a manifest also
freezes the scorer's own stamp (`manifest.scorer: { version, sha256 }`), every
report's stamp is checked against it and a report computed by another scorer
is a problem (`batches[].reports_off_manifest`).

Tolerance rows of the score reports are shown as they come (`toleranceRows`);
a row is marked as entering `shape_score` only when the report says so
(`in_shape_score: true` on the row, or a `global.shape_fractions` list).

## Synthetic data

`sample-runs.mjs` writes a data root in the documented shapes, every number
made up and labelled synthetic: `SAMPLE_ATTEMPTS` (small) and
`syntheticDesign()` (objects in named sets, archetypes, t2/t4/c1, two
configurations at three attempts per task, one split over two batch
directories, one at one attempt, an `infra_error` and a timeout). A spec with
`contested` on a conflict variant gets an alternate in its truth and report:
`before-canopy` on c1, `remembered` on m2 / m3. Probe errors differ per probe
(`PROBE_ERROR_STEPS` × 10 cm), so a report's median probe error is not its
mean; with groups dropped, the last probe's ray misses. Never mix it with real
results.
