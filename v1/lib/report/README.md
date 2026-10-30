# Results report (module G)

Reads run batches, aggregates them into a leaderboard (`e3d-leaderboard-v4`)
and writes a static site that opens from disk: `index.html` (per task set:
what the set is, the two ladders, leaderboard, pairwise comparison, where the
noise is, evidence deltas, archetypes, detail by category, named dimensions,
frame and scale, evidence use and cost, score over time, task index; then
provenance, excluded attempts, data problems), `summary.md` (the same numbers
in Markdown, to paste into a document), one page per task under `tasks/`, renders and
copied evidence under `assets/`, and the full leaderboard as
`leaderboard.json`.

```sh
node v1/cli.mjs report --batches A,B,C --out .local/v1/reports/NAME [--roster v1/rounds/round4.roster.json]
```

```js
import { aggregate, writeReport, comparePair } from './index.mjs';
await aggregate({ dataRoot, batches, outFile, roster });        // -> leaderboard object (JSON written unless outFile: null)
await writeReport({ dataRoot, batches, outDir, roster });       // -> compact summary, see below
const roster = await readRoster('v1/rounds/round3.roster.json'); // optional: formal configurations and ladders
```

`writeReport` returns only what a terminal should show (the CLI prints it):
`{ outDir, index, summary, leaderboard, tasks, attempts, attempts_drawn,
images, problems, sets: [{ id, kind, objects, tasks, counted, ranking: [{ rank,
key, score, ci95, reference?, demoted? }], ladders: [{ id, ranking: [{ rank, key }],
separated }], pairs: [{ a, b, difference, ci95, t_ci95, verdict, incomplete?, holm }] }],
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
  (timeouts without a model, invalid GLBs, missing artifacts), and so does an
  attempt with integrity problems (`result.integrity_problems`, a broken
  boundary), whatever its file scored.
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
  words per pair. These intervals and this verdict are uncorrected; the
  corrected verdict next to them is described under *Multiple comparisons*.
- Why both intervals: on a synthetic design (object effect, configuration ×
  object interaction, attempt noise, 3 vs 1 attempts per task) the percentile
  bootstrap covered the true difference 84 % of the time with 5 objects, 92 %
  with 10 and 93 % with 24, and separated two equal configurations 16 %, 10 %
  and 6 % of the time; the t interval stayed at 94–96 % and 5–6 %.

## Ladders and the roster

Effort moves a model about as much as the gap between models (Round 3: about
five points for each of Astra, gpt-6.1-sol and Opus between high and max), so
a table that mixes effort levels is not a model ladder. Every row is a
**system**: client + model + effort. Per set the report gives two ladders
(`set.ladders`):

- `default`: each client at the effort it uses when none is asked for;
- `top`: each client at the highest effort the round asked it for.

and `set.effort`, top minus default effort for every client and model on both
ladders (oriented that way even when the default scored higher).

Which configurations are on which ladder comes from a **roster file**, decided
before the data like the round's DECISIONS.md:

```sh
node v1/cli.mjs report --batches A,B,C --out .local/v1/reports/NAME --roster v1/rounds/round4.roster.json
```

```json
{
  "schema": "e3d-roster-v1",
  "round": "round4",
  "decided_at": "2026-11-03",
  "decisions": "docs/V1-ROUND4-PLAN.md",
  "required_variants": ["t2", "t4", "c1", "r2", "r4"],
  "configurations": [
    { "system": "codex", "model": "gpt-6-astra", "effort": "high", "ladder": "default" },
    { "system": "codex", "model": "gpt-6-astra", "effort": "max", "ladder": "top",
      "missing_tasks": [{ "task": "obj-17-c1", "reason": "usage limit until the window closed" }] },
    { "system": "claude-code", "model": "claude-haiku-4-5-20251001", "effort": null, "ladder": "default",
      "demoted": "missed 31 of 216 test tasks (account suspended 2026-11-09)" }
  ]
}
```

- `effort: null` is a run without an effort flag (the client's default). The
  key is `system / model / effort` exactly as `result.json` records it,
  including any date suffix (`claude-haiku-4-5-20251001`).
- `ladder` is `"default"`, `"top"`, a list of both (a model with one effort
  level), or absent (a formal configuration on no ladder). A client and model
  may appear on a ladder once.
- `missing_tasks` (optional, per configuration): the tasks it permanently
  lacks once the round's window has closed, each a task id with its reason; `demoted`
  (optional): the reason it is not ranked. `required_variants` (optional,
  top level): the variants whose tasks every configuration owes; absent, it
  owes every task of the set. See *Completeness* below.
- A roster with any problem is refused as a whole. A listed configuration
  that no attempt ran is a data problem (usually a misspelt id); one missing
  from a set is listed under that set's ladder (`ladders[].missing`,
  `set.absent_configurations`) and its pairs stay in the families as
  incomplete.
- Configurations not in the roster are **reference rows**
  (`entry.reference: true`, `entry.rank: null`, `set.reference_configurations`):
  listed after the ranked rows, never ranked, in no corrected family. Their
  pairs keep their uncorrected numbers (folded on the page).
- The leaderboard records the roster (`board.roster`: file relative to the
  repository root, or its name alone when it lies outside, whatever the
  working directory; sha256, round, decided_at, required_variants,
  configurations with their missing tasks and demotions).
- `v1/rounds/round3.roster.json` reproduces the ladders of
  `docs/V1-ROUND3.md` §5 (default: high, Haiku without a flag; top: max for
  Astra, gpt-6.1-sol and Opus). It was written after that round's data, to
  re-report it; it is not a pre-registered decision. It requires `t2`, `t4`
  and `c1` (the test set's three-variant headline: `t1` and `t3` were run by
  some configurations only), so the memory set owes nothing; the real set,
  a real tier, owes all its tasks, and the six configurations that never ran
  it list its four tasks as missing (not run).

Without a roster every configuration is formal and the ladders are inferred
(`inferLadders`, notes in `set.ladder_notes`): `default` is a run without an
effort flag or at the client's documented default (`CLIENT_DEFAULT_EFFORT`:
codex, claude-code and grok `high`); `top` is, per client and model, the
highest effort above that default that the set ran (`EFFORT_ORDER`: none <
minimal < low < medium < high < xhigh < max < ultra). Anything else (below the
default, between default and top, an unknown effort name, a client whose
default the report does not know, two runs that both count as the default) is
on no ladder, with a note. Round 3 inferred gives the same ladders as its
roster file.

A ladder ranks its configurations by the leaderboard's score; its pairs are
the leaderboard's pairs (same numbers, same orientation), corrected over the
ladder alone.

## Completeness and incomplete pairs

`docs/V1-ROUND4-PLAN.md` §2–4. Only the roster records a permanent gap; the
report never infers one.

- **Owed tasks** of a set (`set.completeness.expected_tasks`): every task of
  the set an attempt ran, a batch's manifest planned (run or not) or the
  roster lists as missing, restricted to `required_variants` when given (main
  sets only: a real-tier set owes all its tasks, every formal configuration ×
  object × `r2`, `r4`). With `required_variants`, every object of a main set
  owes each required variant of the families its own tasks belong to (a test
  object owes `t2`, `t4`, `c1`; a memory object none of them); an object with
  no task of one in these batches is owed under a placeholder id
  (`<object> c1 (no task in these batches)`, which no roster can list), so a
  variant no batch ran is an unlisted gap of everyone, reported, and no pair
  is decided. A planned task without a `truth.json` naming its
  object and variant cannot be placed in a set; it is reported as a data
  problem. Per roster configuration, `set.completeness.configurations[]` = `{ key,
  present, expected, sampled, missing: [{ task, reason }], unlisted,
  listed_but_sampled, demoted }`, shown on the page and in `summary.md` as the
  set's Completeness table.
- **Unlisted gap**: an owed task without a counted sample that the roster
  does not list (still running, or a data problem). Reported as a data
  problem; the configuration keeps its rank but its pairs get no verdict.
- **Main sets** (not the real tier): a formal configuration whose listed
  missing tasks exceed `MISSING_SHARE_LIMIT` (5 %; 10 of 216 is within it) of
  the owed tasks must be `demoted`, or the roster is refused
  (`buildLeaderboard` throws).
  Demoted: `entry.rank: null`, `entry.demoted` = the reason,
  `set.demoted_configurations`, listed after the ranked rows; it stays in the
  table of all pairs and on its ladders. Within the limit it stays ranked and
  its pairs are incomplete. Demoting within the limit, or listing a task that
  has a counted sample, is reported.
- **Families are frozen**: with a roster, once any roster configuration took
  part in a set (an attempt, counted or excluded, or a batch whose
  `manifest.json` was prepared with tasks of the set, even one that never
  wrote a `result.json`; matched by the manifest's top-level system, model
  and effort, which the runner copies into every `result.json`), every pair of roster configurations is in the set's families,
  absent and demoted ones included; m never shrinks because a configuration
  failed to deliver.
- **Incomplete pair** (`pair.verdict: 'incomplete'`, `pair.incomplete` = the
  reason; the plan's 缺题，无法判定): no verdict, in m with p = 1, so it can
  never help another pair separate. Reasons, first that applies
  (`INCOMPLETE_REASONS`): `demoted`; `missing_tasks` (main sets);
  `unlisted_gaps`; `few_complete_objects` (real tier); `few_objects` (fewer
  than 2 objects run by both); `undefined_test` (the per-object differences do
  not vary, so t is undefined: `tTestP` returns null). The last two apply
  without a roster too. The gap and its intervals are kept where they exist.
- **Real tier** (`set.tier: 'real'`, a set of `r2` / `r4` tasks only). A
  configuration completed an object when it has a counted sample on every
  task of the object in the set, `r2` and `r4` both among them. An object
  with no task of one of them in these batches is owed by every formal
  configuration under a placeholder id (`<object> r4 (no task in these
  batches)`, which no roster can list): an unlisted gap of everyone,
  reported, so no pair is decided, with or without a roster.
  - A configuration's own figures (score, shape, detail, per variant and
    archetype, evidence deltas, diagnostics, the score-over-time curve, its
    and its pairs' rows in *Where the noise is*) use
    its complete objects only (`entry.real_tier = { complete_objects,
    sampled_objects, intervals }`); a summary resting on fewer than
    `REAL_TIER_MIN_OBJECTS` (8) objects (the configuration's, or its own: an
    archetype row, a curve point) is a point estimate without an interval
    (bootstrap, Student-t or SD range); an attempt SD (a configuration's or
    the set's pooled one) is judged on the objects with a repeated task,
    and with no complete object a configuration has no score and
    no rank (shown as –), but stays in every family. Bookkeeping (attempts,
    success, statuses, time, tokens, cost, batches and their provenance)
    counts every counted attempt.
  - A pair is compared only on the objects both configurations completed
    (`pair.complete_objects`) and needs at least 8 of them; below that it is
    incomplete with no intervals, whatever the reason.
  - Listed missing tasks only shrink those objects (no veto) and never
    require demotion, and a roster demotion does not apply there: the
    configuration is ranked and judged on its complete objects.
- **Which reports take the roster**: only the main-set report and the
  real-tier report. The extras and regression reports read other batches;
  with `--roster` they would list absent configurations and report gaps that
  are not gaps.

## Regression check (`regression.mjs`)

`docs/V1-ROUND4-PLAN.md` §3: two systems, Codex / gpt-6-astra / high and
Claude Code / claude-opus-5-5 / high (`REGRESSION_SYSTEMS`), run again on the
main tasks of `test-2026-10` (`t2`, `t4`, `c1`: 72 tasks on 24 objects), one
attempt each on the frozen Round 4 stack, and compared with their Round 3
rows (three attempts per task). It is a report of its own: the leaderboard
merges every batch of one configuration, and here the two rounds of one
configuration stay apart.

```sh
node v1/cli.mjs regression --baseline R3A,R3B --batches R4A,R4B --out .local/v1/reports/regression [--set test-2026-10] [--systems codex/gpt-6-astra/high,...] [--seed S]
```

```js
import { regressionReport, compareRounds, regressionMarkdown } from './index.mjs';
await regressionReport({ dataRoot, baseline, batches, outDir });  // writes regression.json (e3d-regression-v1) and regression.md
compareRounds({ baseline: collectedEarlier, current: collectedLater }); // the same from two collectRuns results, nothing written
```

`--baseline` are the earlier round's batches (any configurations: only the
regression systems' attempts on the set's main tasks are read), `--batches`
this round's; a batch in both is refused.

- **Owed tasks**: every task of the set in a main variant that either round
  ran or planned, or that the set's build record (`sets/<set>.built.json`)
  lists; every object owes each main variant, one no batch has under a
  placeholder id (`<object> c1 (no task in these batches)`), which nothing can
  fill.
- **Difference**, per object: this round's mean over the object's main tasks
  minus the earlier round's over the same tasks (attempts averaged within a
  task, as everywhere), on the tasks both rounds sampled. Failures count as 0,
  integrity problems as 0, excluded statuses are not samples. Its 90 % and 95 %
  paired Student-t intervals, its 90 % and 95 % paired bootstrap intervals over
  objects (`REGRESSION_SAMPLES` = 10 000 resamples, both levels from the same
  resamples, seed `<seed>/<set>/<configuration>/difference`, default seed
  `e3d-regression`), the two-sided paired t p-value and the TOST p-value
  (`tostP`, margin 2: below 0.05 exactly when the 90 % t interval lies inside
  ±2). With fewer than 2 objects, or per-object differences that do not vary,
  no interval is available (`intervals_available: false`, every interval
  null): the plan's 区间不可用, which meets no threshold.
- **Verdict** (`row.verdict`), first that applies:
  1. `not_judged`, a data problem the report will not judge past
     (`row.blockers`, `row.reason`): `no_baseline` (no counted earlier
     attempt), `baseline_incomplete` (an owed task without a counted earlier
     sample: usually the wrong batches), `scorer_mismatch` (the reports of the
     two rounds name more than one scorer version, an unstamped report
     counting as its own; plan: if G1 moves the scorer to 1.2.0, both rounds
     are rescored), `mixed_stack` (this round's batches of the system differ
     in Node, CLI version or binary, runner source, prompt version, tool kit,
     three.js runtime or protocol; a field recorded for some batches and not
     others counts. The earlier round's stack is shown, never refused: Round 3
     changed CLIs between batches);
  2. `undecided`, `incomplete`: an owed task without a counted sample in this
     round. By the deadline in the private record that is final; before it
     the batches may still be running. The difference on the tasks both
     rounds have is shown as a description;
  3. `undecided`, `few_objects` or `no_variation`: no interval;
  4. `equivalent` (等价): the 90 % t and the 90 % bootstrap interval both lie
     strictly inside ±`EQUIVALENCE_MARGIN` (2). `small_change: true` (有小而可测的变化)
     when both 95 % intervals also exclude zero on the same side
     (`direction`);
  5. `drift` (漂移): both 95 % intervals exclude zero on the same side
     (`direction` `up` or `down`);
  6. `undecided`, `inconclusive`.
- **Across rounds** (`row.cross_round`): `main score only` for an equivalent
  system, else `none`. The page names no per-variant difference: the test
  covered the mean of the three variants only, so per-variant scores and
  evidence deltas stay in each round's own report.
- Shown per round: batches, counted attempts, tasks sampled, attempts per
  task, excluded statuses, scorer versions and hashes, the stack values, the
  main score with a 95 % bootstrap interval, and the most attempts of the
  system that ran at once (`maxConcurrent`, from `started_at` /
  `finished_at`). `notes`: more than one at once in either round (the
  difference includes that, plan §8), and one scorer version with more than
  one source hash. `problems`: both collections' problems, placeholders,
  submissions byte-identical across rounds on one task (a copied attempt).
- `regression.md` gives the rules, a table of both systems, then per system
  the verdict in words, the two rounds side by side and the per-object
  differences (not for a row that is not judged, whose comparison cells are
  blank).

## Multiple comparisons (Holm)

Round 3 had 12 configurations, so 66 pairs: at 95 % each, if no configuration
differed at all, at least one pair would still be "separated" most of the
time. Every pairwise table therefore carries a corrected verdict next to the
uncorrected intervals, which stay as they were.

- **p-value**: the two-sided paired t test of the per-object differences
  (`pair.p_t`, `tTestP`). The 95 % t interval excludes zero exactly when
  `p_t < 0.05`.
- **Families**, each corrected on its own: all pairs of formal
  configurations in a set (`set.pairwise`, `holm.family: 'all'`); the pairs of
  one ladder (`ladders[].pairwise`, `'default'` / `'top'`); the effort pairs
  (`set.effort`, `'effort'`). m counts every pair of the family; an
  incomplete pair enters with p = 1 (see *Completeness* above). Pairs with a
  reference row are in no family.
- **Holm's step-down method** (`holmAdjust`) at family-wise 5 %
  (`FAMILY_ALPHA`): sort the m p-values; the k-th smallest becomes
  (m − k + 1) · p, never below the one before, capped at 1.
- **Separated after correction** (`pair.holm.verdict`): Holm-adjusted
  p < 0.05 **and** separated uncorrected (bootstrap and Student-t 95 %
  intervals both exclude zero). So correction only removes separations; an
  unsettled pair stays unseparated whatever its p.
- `pair.holm` = `{ family, comparisons, p_adjusted, verdict }`;
  `*.correction` = `{ family, method, alpha, test, comparisons,
  separated_uncorrected, separated, incomplete }`. The page prints the Holm column with
  m in its header; each pair's sentence says whether it is still separated.
- A pair can be separated on a ladder and not in the table of every
  configuration: the larger table makes more claims and corrects harder.
  Each table states its own m, and where a ladder or effort pair is corrected
  the other way in the table of all pairs, its Holm cell says so
  (`allPairsNote`). Round 3 `test-final`: Astra max vs gpt-6.1-sol max is
  separated on the top ladder (3 pairs) and not among all pairs. A claim
  about a ladder cites the ladder's family; a claim about the whole table
  cites the table's.
- On synthetic data with ten equal configurations (45 pairs, 10 objects),
  the uncorrected table showed at least one false separation in 75 % of 40
  trials, the Holm column in none (`report-ladders.test.mjs` checks a smaller
  version).

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
  uncertainty, `projected` to `PLANNED_OBJECTS` (72, Round 4's test set) objects with the same
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

## Score over time (`entry.time_curve`)

From the snapshots the runner takes while an attempt runs (copies of
`output/model.glb` every `snapshot_interval_seconds` after the CLI started,
scored after the attempt; `v1/lib/runner/README.md`, *Score-over-time
snapshots*), `curves.mjs` computes per configuration:

- `points[]`: at every tick (each multiple of the interval up to the
  wall-clock limit, and the limit itself) the mean score with the same
  averaging and bootstrap as `entry.score`, where an attempt counts its final
  score once it has ended (`wall_seconds <= t`, or t at its
  `wall_limit_seconds`) and, before that, the score of its last snapshot taken
  at or before t (of those, the one read last, so an older snapshot read late
  never replaces a newer one): 0 with no `model.glb` yet, a refused file or an
  invalid model.
  A snapshot counts from its tick when the runner's read of it ended
  (`read_seconds`) at most 10 s after the tick (`ON_TIME_SECONDS`: the read and
  the wait for a model caught mid-write); one read later, on a busy runner,
  counts from `read_seconds`, so from the next tick after it, and is counted in
  the curve's `late`. An attempt whose snapshot there has no score through
  no fault of the model (the scorer failed on it, also on the runner's retries:
  `score_error`; or the runner could not store it: `lost`) is left out of that
  tick's mean and counted in the point's `missing`; `score_errors` counts those
  snapshots. An attempt with integrity problems is 0 at every tick. The point
  at the limit is therefore `entry.score`. `finished` is the share of attempts
  that had ended by t.
- `t95`: per attempt with a final score of at least 10 (`T95_MIN_FINAL`), when
  its first snapshot at 95 % (`T95_SHARE`) of its final score counts from (its
  tick, or `read_seconds` when read late), or its end (`wall_seconds`) when no
  snapshot got there (the final file is the snapshot at the end);
  `median_seconds`, `q1_seconds`, `q3_seconds` over those attempts (not
  weighted by object), `attempts`, and `low_final`, the attempts left out.

A configuration with no snapshots has `time_curve: null`; one where only some
counted attempts have them gets `{ available: false, reason }` and no curve,
since a curve over a subset would not end at its score. The page draws an
inline SVG (one line per configuration, at most 8, coloured by name; hover
text from SVG titles, no scripts) above a table with every point, its
interval and the share finished; `summary.md` has the table.

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
