import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { writeJSON } from '../../../lib/io.mjs';
import { layout } from '../contract.mjs';
import { collectRuns, DEFAULT_EXCLUDED_STATUSES, scorerIdentity, scorerVersion } from './collect.mjs';
import { taskMeans, cellKey, signedText, intervalText } from './aggregate.mjs';
import { finite, mean, sampleSD, bootstrapMean, pairedBootstrap, tInterval, tTestP, studentCDF, PAIRWISE_SAMPLES, TIE_TOLERANCE } from './stats.mjs';

// The regression check (docs/V1-ROUND4-PLAN.md section 3): two systems run
// again, one attempt per task, on the frozen Round 4 stack, on the old test
// set's main tasks, and compared object by object with their Round 3 rows
// (the mean of three attempts per task). It is a report of its own: the
// leaderboard merges every batch of one configuration, and here the two
// rounds of one configuration must stay apart.
//
//   node v1/cli.mjs regression --baseline R3A,R3B --batches R4A,R4B --out .local/v1/reports/regression
//
// The judgement, in order, first that applies, only for a system with a
// counted sample on every main task in both rounds:
//   equivalent  the 90 % paired Student-t interval and the 90 % paired
//               bootstrap interval of (this round - the earlier one) both lie
//               inside +-2 points. The t half is the paired TOST at
//               alpha = 0.05; the percentile bootstrap runs narrow at 24
//               objects, so it never decides alone. When both 95 % intervals
//               also exclude zero the report adds "a small but measurable change";
//   drift       both 95 % intervals exclude zero, on the same side;
//   undecided   anything else, and every system with a task missing in this
//               round (by the deadline in the private record the plan judges
//               it undecided; until then its batches may still be running).
// Only an equivalent system is compared across rounds, and only on its main
// score: equivalence was tested on the mean of the three variants, which a
// rise on one variant and a fall on another can leave unmoved. A comparison
// the report cannot make at all (no earlier row, an earlier row with gaps,
// two scoring definitions, this round's batches on different stacks) is
// `not_judged`: a data problem to fix, not one of the plan's verdicts.

export const REGRESSION_SCHEMA = 'e3d-regression-v1';
// Round 3's test set; from Round 4 on, the regression set (plan section 10).
export const REGRESSION_SET = 'test-2026-10';
// The main score's variants: Round 3's three-variant headline, Round 4's 主分.
export const MAIN_VARIANTS = ['t2', 't4', 'c1'];
// The plan's two regression anchors, as result.json records them.
export const REGRESSION_SYSTEMS = Object.freeze([
  Object.freeze({ system: 'codex', model: 'gpt-6-astra', effort: 'high' }),
  Object.freeze({ system: 'claude-code', model: 'claude-opus-5-5', effort: 'high' }),
]);
// Points on the 0-100 main score: about the round's resolution (the Round 3
// Opus re-test was -0.59 [-1.87, +0.66]).
export const EQUIVALENCE_MARGIN = 2;
// 90 % intervals inside the margin = two one-sided tests at 5 % each.
export const EQUIVALENCE_LEVEL = 0.90;
export const REGRESSION_SAMPLES = PAIRWISE_SAMPLES;

export const REGRESSION_VERDICTS = { equivalent: 'equivalent (等价)', drift: 'drift (漂移)', undecided: 'undecided (未定)', not_judged: 'not judged (data problem)' };
export const REGRESSION_REASONS = {
  // undecided
  incomplete: 'a main task without a counted sample in this round',
  few_objects: 'fewer than 2 objects, so no interval',
  no_variation: 'the per-object differences do not vary, so no interval is available',
  inconclusive: 'neither inside the margin nor clear of zero',
  // not judged
  no_baseline: 'no counted attempt in the earlier round\'s batches',
  baseline_incomplete: 'a main task without a counted sample in the earlier round (were the right batches given?)',
  scorer_mismatch: 'the two rounds were not scored under one scorer version (rescore one side)',
  mixed_stack: 'this round\'s batches were not run on one stack',
};

// The stack a round's batches freeze (plan section 5, step 2): Node, the
// client's binary, the runner and prompt source and what it builds. The
// scorer and the generator are not part of it.
const STACK_FIELDS = [['node_version', 'Node'], ['cli_version', 'CLI version'], ['cli_sha256', 'CLI binary'], ['runner_sha256', 'runner source'],
  ['prompt_version', 'prompt version'], ['tools_sha256', 'contestant tool kit'], ['runtime_sha256', 'three.js runtime'], ['protocol', 'protocol']];

const distinct = values => [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b)));
const plural = (count, word) => count + ' ' + word + (count === 1 ? '' : 's');
const firstFew = (list, count = 3) => list.slice(0, count).join(', ') + (list.length > count ? ', ...' : '');
const placeholder = (object, variant) => object + ' ' + variant + ' (no task in these batches)';
const sameConfiguration = spec => item => item.system === spec.system && item.model === spec.model && (item.effort ?? null) === (spec.effort ?? null);

// "codex/gpt-6-astra/high,claude-code/claude-opus-5-5/high" (effort "-" for a
// run without an effort flag) -> [{ system, model, effort }].
export function parseSystems(text) {
  const items = String(text ?? '').split(',').map(item => item.trim()).filter(Boolean);
  if (!items.length) throw new Error('--systems needs system/model/effort[,system/model/effort...]');
  const systems = items.map(item => {
    const parts = item.split('/').map(part => part.trim());
    if (parts.length !== 3 || parts.some(part => !part)) throw new Error('--systems: "' + item + '" is not system/model/effort (effort "-" for none)');
    return { system: parts[0], model: parts[1], effort: parts[2] === '-' ? null : parts[2] };
  });
  const keys = systems.map(cellKey);
  if (new Set(keys).size < keys.length) throw new Error('--systems names a configuration twice');
  return systems;
}

// Two one-sided tests of |mean| >= margin on paired differences: the larger of
// the two one-sided p-values, below alpha exactly when the (1 - 2 alpha) t
// interval lies inside (-margin, +margin). null where the t test is undefined
// (fewer than 2 values, or values that do not vary).
export function tostP(values, margin = EQUIVALENCE_MARGIN) {
  const list = values.filter(finite);
  if (tTestP(list) === null) return null;
  const n = list.length, centre = mean(list), se = sampleSD(list) / Math.sqrt(n);
  const lower = 1 - studentCDF((centre + margin) / se, n - 1), upper = studentCDF((centre - margin) / se, n - 1);
  return Math.max(lower, upper);
}

// The main tasks of the set: every task of a main variant that either round
// ran or planned, or that the set's build record lists (`taskInfo`). Every
// object owes each main variant; one with no task of a variant in these
// batches owes it under a placeholder id, which no attempt can fill.
function owedTasks(sources, set, variants) {
  const known = new Map();
  for (const source of sources) {
    for (const attempt of source.attempts) {
      if (attempt.set === set && variants.includes(attempt.variant)) known.set(attempt.task_id, { object: attempt.object, variant: attempt.variant });
    }
    for (const [task, info] of source.taskInfo ?? []) {
      if (info.set === set && variants.includes(info.variant) && !known.has(task)) known.set(task, { object: info.object, variant: info.variant });
    }
  }
  const objects = distinct([...known.values()].map(info => info.object)), tasks = new Map(known), placeholders = [];
  for (const object of objects) {
    for (const variant of variants) {
      if ([...known.values()].some(info => info.object === object && info.variant === variant)) continue;
      tasks.set(placeholder(object, variant), { object, variant });
      placeholders.push(placeholder(object, variant));
    }
  }
  return { tasks, objects, placeholders };
}

// Most attempts of one configuration running at once, from their start and
// finish times (a round run at concurrency 2 has this difference in it too;
// plan section 8). Attempts without both times are counted, not guessed.
export function maxConcurrent(attempts) {
  const events = [];
  for (const attempt of attempts) {
    const start = Date.parse(attempt.started_at ?? ''), end = Date.parse(attempt.finished_at ?? '');
    if (finite(start) && finite(end) && end > start) events.push([start, 1], [end, -1]);
  }
  // An attempt that ends as another starts did not overlap it.
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let running = 0, most = 0;
  for (const [, step] of events) { running += step; most = Math.max(most, running); }
  return { max: events.length ? most : null, timed: events.length / 2, untimed: attempts.length - events.length / 2 };
}

// What one round shows for one configuration: its batches and their stack,
// which tasks have a counted sample, the scorer behind its reports, and its
// main score (attempts within a task, tasks within an object, objects).
function roundSide(source, spec, owed, { seed, samples }) {
  const mine = source.attempts.filter(sameConfiguration(spec));
  const owedAttempts = mine.filter(attempt => owed.tasks.has(attempt.task_id)), counted = owedAttempts.filter(attempt => !attempt.excluded);
  const sampled = new Set(counted.map(attempt => attempt.task_id));
  const tasks = taskMeans(counted), perTask = [...tasks.values()].map(task => task.attempts);
  const objects = new Map();
  for (const { object, mean: value } of tasks.values()) {
    if (!objects.has(object)) objects.set(object, []);
    objects.get(object).push(value);
  }
  const objectMeans = [...objects.values()].map(mean);
  const batchIds = distinct([...mine.map(attempt => attempt.batch), ...(source.plans ?? []).filter(sameConfiguration(spec)).map(plan => plan.batch)]);
  const batches = (source.batches ?? []).filter(batch => batchIds.includes(batch.id));
  const stack = Object.fromEntries(STACK_FIELDS.map(([field]) => [field, distinct(batches.map(batch => stackValue(batch, field)).filter(value => value !== null))]));
  // The scoring definition is the scorer's version; its hash pins the code,
  // which can change without moving a number (version.mjs).
  const reported = counted.filter(attempt => attempt.report);
  const excluded = {};
  for (const attempt of owedAttempts.filter(attempt => attempt.excluded)) excluded[attempt.status] = (excluded[attempt.status] ?? 0) + 1;
  return {
    batches: batchIds,
    attempts: counted.length,
    excluded,
    // Attempts of this configuration on tasks that are not main tasks of the set (other variants, other sets).
    outside: mine.length - owedAttempts.length,
    tasks: sampled.size,
    missing: [...owed.tasks.keys()].filter(task => !sampled.has(task)).sort(),
    attempts_per_task: perTask.length ? { min: Math.min(...perTask), max: Math.max(...perTask) } : null,
    objects: objects.size,
    score: { mean: mean(objectMeans), ci95: bootstrapMean(objectMeans, { seed, samples }) },
    scorer_versions: distinct(reported.map(attempt => scorerVersion(attempt.report) ?? 'unstamped')),
    scorer_sha256: distinct(reported.map(attempt => scorerIdentity(attempt.report)).filter(Boolean)),
    stack,
    stack_disagreements: disagreements(batches),
    concurrency: maxConcurrent(mine),
    task_means: tasks,
  };
}

function stackValue(batch, field) {
  const value = batch.manifest?.[field] ?? null;
  return Array.isArray(value) ? (value.length ? value.join(',') : null) : value;
}

// Stack fields on which the batches differ; a field recorded for some batches
// and not for others is a difference too (a batch prepared by another runner).
function disagreements(batches) {
  const found = [];
  for (const [field, label] of STACK_FIELDS) {
    const values = new Map(batches.map(batch => [batch.id, stackValue(batch, field)]));
    if ([...values.values()].every(value => value === null) || new Set(values.values()).size < 2) continue;
    found.push({ field, label, values: Object.fromEntries([...values].map(([batch, value]) => [batch, value ?? 'not recorded'])) });
  }
  return found;
}

// This round minus the earlier one, per object, on the tasks both rounds
// sampled; the 90 % and 95 % paired intervals (the bootstrap ones from the
// same resamples) and the TOST p-value.
function roundDifference(before, after, { seed, samples, margin }) {
  const objects = new Map();
  for (const [task, x] of after) {
    const y = before.get(task);
    if (!y) continue;
    if (!objects.has(x.object)) objects.set(x.object, { before: [], after: [] });
    objects.get(x.object).before.push(y.mean);
    objects.get(x.object).after.push(x.mean);
  }
  const rows = [...objects].sort(([p], [q]) => p.localeCompare(q)).map(([object, entry]) => {
    const earlier = mean(entry.before), later = mean(entry.after);
    return { object, tasks: entry.after.length, baseline: earlier, current: later, difference: later - earlier };
  });
  const values = rows.map(row => row.difference);
  // The plan's "interval not available": fewer than two objects, or
  // differences that do not vary (every resample the same, a zero SD). Such
  // intervals meet no threshold, so they are not given at all.
  const available = tTestP(values) !== null;
  const boot = level => available ? pairedBootstrap(values, { seed, samples, level }) : null;
  const boot90 = boot(EQUIVALENCE_LEVEL), boot95 = boot(0.95);
  const higher = values.filter(value => value > TIE_TOLERANCE).length, lower = values.filter(value => value < -TIE_TOLERANCE).length;
  return {
    objects: rows.length, tasks: rows.reduce((sum, row) => sum + row.tasks, 0),
    mean: mean(values),
    intervals_available: available,
    t_ci90: available ? tInterval(values, EQUIVALENCE_LEVEL) : null,
    bootstrap_ci90: boot90?.ci95 ?? null,
    t_ci95: available ? tInterval(values, 0.95) : null,
    bootstrap_ci95: boot95?.ci95 ?? null,
    samples: boot90?.samples ?? null, seed,
    p_t: tTestP(values),
    tost_p: tostP(values, margin),
    higher, tied: values.length - higher - lower, lower,
    per_object: rows,
  };
}

const inside = (ci, margin) => Boolean(ci) && ci[0] > -margin && ci[1] < margin;
// 1 above zero, -1 below, 0 when the interval includes it (or is missing).
const sideOf = ci => !ci ? 0 : ci[0] > 0 ? 1 : ci[1] < 0 ? -1 : 0;
const clearOfZero = (a, b) => sideOf(a) !== 0 && sideOf(a) === sideOf(b) ? sideOf(a) : 0;

// The data problems that stop a judgement, each { reason, text }.
function blockers(key, before, after, labels) {
  const found = [];
  if (!before.attempts) found.push({ reason: 'no_baseline', text: labels.baseline + ' has no counted attempt of ' + key + ' on the set\'s main tasks' });
  else if (before.missing.length) {
    found.push({ reason: 'baseline_incomplete', text: labels.baseline + ' has no counted sample of ' + key + ' on ' + plural(before.missing.length, 'main task') +
      ' (' + firstFew(before.missing) + ')' });
  }
  const versions = distinct([...before.scorer_versions, ...after.scorer_versions]);
  if (versions.length > 1) {
    found.push({ reason: 'scorer_mismatch', text: key + ' was scored under scorer ' + (before.scorer_versions.join(' and ') || 'no report') + ' in ' + labels.baseline + ' and ' +
      (after.scorer_versions.join(' and ') || 'no report') + ' in ' + labels.current + '; both rounds must use one scorer version (plan section 3)' });
  }
  if (after.stack_disagreements.length) {
    found.push({ reason: 'mixed_stack', text: labels.current + '\'s batches of ' + key + ' differ in ' + after.stack_disagreements.map(item => item.label).join(', ') +
      '; a gate rerun after a forced stack change uses new batches only (plan section 5)' });
  }
  return found;
}

function judge(row, margin) {
  const d = row.difference;
  if (row.blockers.length) return { verdict: 'not_judged', reason: row.blockers[0].reason };
  if (row.current.missing.length) return { verdict: 'undecided', reason: 'incomplete' };
  if (!d.intervals_available) return { verdict: 'undecided', reason: d.objects < 2 ? 'few_objects' : 'no_variation' };
  if (inside(d.t_ci90, margin) && inside(d.bootstrap_ci90, margin)) {
    const change = clearOfZero(d.t_ci95, d.bootstrap_ci95);
    return { verdict: 'equivalent', reason: null, small_change: change !== 0, direction: change > 0 ? 'up' : change < 0 ? 'down' : null };
  }
  const drift = clearOfZero(d.t_ci95, d.bootstrap_ci95);
  if (drift) return { verdict: 'drift', reason: null, direction: drift > 0 ? 'up' : 'down' };
  return { verdict: 'undecided', reason: 'inconclusive' };
}

const points = value => signedText(value, 2) + ' points per object';
const span = ci => ci ? intervalText(ci, 2) : 'not available';

// The verdict in words, with the rule that produced it and what it allows.
export function regressionStatement(row, { margin = EQUIVALENCE_MARGIN, labels = ROUND_LABELS } = {}) {
  const d = row.difference, diff = labels.current + ' − ' + labels.baseline;
  const over = ' over ' + plural(d.objects, 'object') + ' (' + labels.current + ' higher on ' + d.higher + ', tied on ' + d.tied + ', lower on ' + d.lower + ')';
  const intervals = '90% Student-t interval ' + span(d.t_ci90) + ', 90% bootstrap interval ' + span(d.bootstrap_ci90);
  const wide = '95% Student-t interval ' + span(d.t_ci95) + ', 95% bootstrap interval ' + span(d.bootstrap_ci95);
  const head = row.key + ': ' + REGRESSION_VERDICTS[row.verdict];
  const none = ' No comparison across rounds.';
  if (row.verdict === 'not_judged') return head + ': ' + row.blockers.map(item => item.text).join('; ') + '.';
  if (row.verdict === 'equivalent') {
    return head + '. ' + diff + ' = ' + points(d.mean) + over + '; the ' + intervals + ' both lie inside ±' + margin + ' (paired TOST p ' + pValue(d.tost_p) + ').' +
      (row.small_change ? ' Both 95% intervals exclude zero (' + wide + '): a small but measurable change (有小而可测的变化), ' + (row.direction === 'up' ? 'upwards' : 'downwards') + '.' : '') +
      ' This system may be compared across rounds on its main score only (the mean of ' + MAIN_VARIANTS.join(', ') + '); its per-variant scores and evidence deltas stay within their rounds.';
  }
  if (row.verdict === 'drift') {
    return head + ', ' + (row.direction === 'up' ? 'upwards' : 'downwards') + '. ' + diff + ' = ' + points(d.mean) + over + '; the ' + wide + ' both exclude zero, and the ' +
      intervals + ' do not both lie inside ±' + margin + '.' + none;
  }
  if (row.reason === 'incomplete') {
    return head + ': ' + labels.current + ' has no counted sample on ' + plural(row.current.missing.length, 'main task') + ' of ' + row.owed_tasks + ' (' + firstFew(row.current.missing) +
      '). The plan judges only a complete system; at the deadline in the private record this is final, before it the batches may still be running. ' +
      (d.objects ? 'On the tasks both rounds have, ' + diff + ' = ' + points(d.mean) + over + ', a description only.' : 'No task has a sample in both rounds.') + none;
  }
  if (row.reason === 'few_objects' || row.reason === 'no_variation') {
    return head + ': ' + REGRESSION_REASONS[row.reason] + '. ' + diff + ' = ' + (finite(d.mean) ? points(d.mean) : 'n/a') + over + '.' + none;
  }
  return head + '. ' + diff + ' = ' + points(d.mean) + over + '; the ' + intervals + ' do not both lie inside ±' + margin + ', and the ' + wide + ' do not both exclude zero.' + none;
}

const pValue = p => !finite(p) ? 'n/a' : p < 0.001 ? '< 0.001' : '= ' + p.toFixed(3);

export const ROUND_LABELS = Object.freeze({ baseline: 'Round 3', current: 'Round 4' });

// baseline, current: collectRuns results for the earlier round's batches and
// this round's. -> the regression object (schema e3d-regression-v1).
export function compareRounds({ baseline, current, set = REGRESSION_SET, variants = MAIN_VARIANTS, systems = REGRESSION_SYSTEMS, margin = EQUIVALENCE_MARGIN,
  seed = 'e3d-regression', samples = REGRESSION_SAMPLES, labels: given = {}, buildRecord = null, excludeStatuses = DEFAULT_EXCLUDED_STATUSES, now = new Date() } = {}) {
  const labels = { ...ROUND_LABELS, ...given };
  const idsOf = source => new Set([...(source.batches ?? []).map(batch => batch.id), ...source.attempts.map(attempt => attempt.batch)]);
  const shared = [...idsOf(baseline)].filter(id => idsOf(current).has(id));
  if (shared.length) throw new Error('batch ' + shared.join(', ') + ' is in both rounds; a regression compares two sets of batches');
  if (!(margin > 0)) throw new Error('the equivalence margin must be a positive number of points');
  const problems = [...new Set([...(baseline.problems ?? []).map(text => labels.baseline + ': ' + text), ...(current.problems ?? []).map(text => labels.current + ': ' + text)])];
  const owed = owedTasks([baseline, current], set, variants);
  if (!owed.tasks.size) problems.push('no task of set ' + set + ' in variants ' + variants.join(', ') + ' in either round\'s batches');
  if (owed.placeholders.length) problems.push(plural(owed.placeholders.length, 'object variant') + ' of set ' + set + ' have no task in these batches: ' + firstFew(owed.placeholders));
  // A submission byte for byte the same in both rounds is a copied attempt, not a re-run.
  const before = new Set(baseline.attempts.filter(attempt => attempt.artifact_sha256).map(attempt => attempt.task_id + '|' + attempt.artifact_sha256));
  const copied = current.attempts.filter(attempt => attempt.artifact_sha256 && before.has(attempt.task_id + '|' + attempt.artifact_sha256));
  if (copied.length) problems.push(plural(copied.length, 'submission') + ' of ' + labels.current + ' are byte-identical to one of ' + labels.baseline + ' on the same task (' +
    firstFew(copied.map(attempt => attempt.batch + '/' + attempt.task_id + '/' + attempt.slot)) + '): copied, not run again?');
  // Facts a reader needs to weigh a verdict, which are not data problems.
  const notes = [];
  const rows = systems.map(spec => {
    const key = cellKey(spec), sideSeed = seed + '/' + set + '/' + key;
    const earlier = roundSide(baseline, spec, owed, { seed: sideSeed + '/baseline', samples });
    const later = roundSide(current, spec, owed, { seed: sideSeed + '/current', samples });
    const row = { key, system: spec.system, model: spec.model, effort: spec.effort ?? null, owed_tasks: owed.tasks.size,
      baseline: earlier, current: later, difference: roundDifference(earlier.task_means, later.task_means, { seed: sideSeed + '/difference', samples, margin }) };
    row.blockers = blockers(key, earlier, later, labels);
    Object.assign(row, judge(row, margin));
    row.cross_round = row.verdict === 'equivalent' ? 'main score only' : 'none';
    row.statement = regressionStatement(row, { margin, labels });
    for (const side of [earlier, later]) delete side.task_means;
    for (const [side, label] of [[earlier, labels.baseline], [later, labels.current]]) {
      const per = side.attempts_per_task;
      // The plan's design is three attempts on every task in Round 3 and one
      // in Round 4 (shown per round). A mixture usually means another run of
      // the configuration (a re-test, a G2 batch) was given too for some
      // tasks; it is averaged in, and said.
      if (per && per.min !== per.max) notes.push(label + ': ' + key + ' has ' + per.min + ' to ' + per.max + ' counted attempts per task');
      if (side.concurrency.max > 1) notes.push(label + ': up to ' + side.concurrency.max + ' attempts of ' + key + ' ran at once; the difference includes that (plan section 8)');
    }
    const hashes = distinct([...earlier.scorer_sha256, ...later.scorer_sha256]);
    if (row.verdict !== 'not_judged' && hashes.length > 1) {
      notes.push(key + ': one scorer version (' + earlier.scorer_versions.join(', ') + '), ' + hashes.length + ' scorer source hashes; the scoring definition is the same, the code is not');
    }
    return row;
  });
  return {
    schema: REGRESSION_SCHEMA,
    generated_at: now.toISOString(),
    plan: 'docs/V1-ROUND4-PLAN.md section 3',
    set, variants, labels,
    rule: {
      difference: labels.current + ' minus ' + labels.baseline + ', per object: attempts averaged within a task, the object\'s ' + variants.join(', ') +
        ' tasks averaged; failures count as 0, excluded statuses (' + excludeStatuses.join(', ') + ') are not samples',
      equivalent: 'the 90% paired Student-t interval (the paired TOST at alpha 0.05) and the 90% paired bootstrap interval both inside ±' + margin +
        ' points; also both 95% intervals clear of zero: a small but measurable change',
      drift: 'both 95% intervals (paired Student-t and bootstrap) exclude zero, on the same side',
      undecided: 'anything else, and any system without a counted sample on every main task in ' + labels.current,
      intervals: 'bootstrap over objects, ' + samples + ' resamples from seed "' + seed + '/' + set + '/<configuration>/difference" (90% and 95% from the same resamples); ' +
        'not available below 2 objects or when the per-object differences do not vary',
      cross_round: 'only an equivalent system, and only its main score',
    },
    margin, level: EQUIVALENCE_LEVEL, samples, seed,
    plan_systems: systems.length === REGRESSION_SYSTEMS.length && REGRESSION_SYSTEMS.every(spec => systems.some(item => cellKey(item) === cellKey(spec))),
    baseline_batches: [...idsOf(baseline)].sort(), current_batches: [...idsOf(current)].sort(),
    owed: { tasks: owed.tasks.size, objects: owed.objects.length, placeholders: owed.placeholders,
      build_record: buildRecord && (buildRecord.built_at || buildRecord.built_tasks?.length) ? 'sets/' + set + '.built.json' : null },
    systems: rows,
    notes,
    problems,
  };
}

// ----------------------------------------------------------------- Markdown

const fixed = (value, digits = 1) => finite(value) ? value.toFixed(digits) : 'n/a';
const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
function table(head, rows, left = 1) {
  return ['| ' + head.map(cell).join(' | ') + ' |', '|' + head.map((_, i) => i < left ? ' --- |' : ' ---: |').join(''), ...rows.map(row => '| ' + row.map(cell).join(' | ') + ' |')].join('\n');
}
const verdictCell = row => REGRESSION_VERDICTS[row.verdict] + (row.reason ? ': ' + REGRESSION_REASONS[row.reason] : '') + (row.small_change ? '; small but measurable change' : '') +
  (row.verdict === 'drift' ? ', ' + row.direction + 'wards' : '');
const listOrNone = list => list.length ? list.join(', ') : 'not recorded';

export function regressionMarkdown(result) {
  const { labels } = result, diff = labels.current + ' − ' + labels.baseline;
  const lines = ['# Regression check: ' + labels.baseline + ' → ' + labels.current, '',
    'Set `' + result.set + '`, main tasks (' + result.variants.join(', ') + '): ' + plural(result.owed.tasks, 'task') + ' on ' + plural(result.owed.objects, 'object') +
      (result.owed.build_record ? ' (with the build record ' + result.owed.build_record + ')' : ' (no build record: the tasks the batches ran or planned)') + '. ' +
      'Rules: ' + result.plan + '. Generated ' + result.generated_at + '.', '',
    '- **Difference**: ' + result.rule.difference + '.',
    '- **Equivalent (等价)**: ' + result.rule.equivalent + '.',
    '- **Drift (漂移)**: ' + result.rule.drift + '.',
    '- **Undecided (未定)**: ' + result.rule.undecided + '.',
    '- **Intervals**: ' + result.rule.intervals + '.',
    '- **Across rounds**: ' + result.rule.cross_round + '; per-variant scores and evidence deltas are reported within each round only.', ''];
  if (!result.plan_systems) lines.push('These are not the plan\'s two regression systems (' + REGRESSION_SYSTEMS.map(cellKey).join(', ') + '); the plan\'s verdicts apply to those only.', '');
  lines.push(table(['System', 'Verdict', labels.baseline, labels.current, diff, '90% t', '90% bootstrap', '95% t', '95% bootstrap', 'TOST p', 'Objects', 'Across rounds'],
    result.systems.map(row => row.verdict === 'not_judged' ? [row.key, verdictCell(row), ...Array(9).fill('—'), row.cross_round]
      : [row.key, verdictCell(row), fixed(row.baseline.score.mean, 2), fixed(row.current.score.mean, 2),
        finite(row.difference.mean) ? signedText(row.difference.mean, 2) : 'n/a', span(row.difference.t_ci90), span(row.difference.bootstrap_ci90),
        span(row.difference.t_ci95), span(row.difference.bootstrap_ci95), pValue(row.difference.tost_p).replace(/^= /, ''), row.difference.objects, row.cross_round]), 2), '',
    'Main scores are each round\'s mean over the objects with a counted sample; the difference is over the objects with a task in both rounds. A system that is not judged shows no comparison.', '');
  for (const row of result.systems) {
    lines.push('## ' + row.key, '', row.statement, '');
    const side = item => [item.batches.join(', ') || 'none', item.attempts, item.tasks + ' / ' + row.owed_tasks,
      item.attempts_per_task ? (item.attempts_per_task.min === item.attempts_per_task.max ? item.attempts_per_task.min : item.attempts_per_task.min + '–' + item.attempts_per_task.max) : 'n/a',
      Object.entries(item.excluded).map(([status, count]) => status + ' ' + count).join(', ') || 'none',
      item.scorer_versions.join(', ') || 'no report', listOrNone(item.stack.cli_version), listOrNone(item.stack.node_version),
      item.concurrency.max ?? 'n/a', fixed(item.score.mean, 2) + (item.score.ci95 ? ' [' + fixed(item.score.ci95[0], 2) + ', ' + fixed(item.score.ci95[1], 2) + ']' : '')];
    lines.push(table(['Round', 'Batches', 'Counted attempts', 'Tasks sampled', 'Attempts per task', 'Excluded', 'Scorer', 'CLI', 'Node', 'Most at once', 'Main score [95% bootstrap]'],
      [[labels.baseline, ...side(row.baseline)], [labels.current, ...side(row.current)]], 2), '');
    if (row.current.missing.length) lines.push(labels.current + ' has no counted sample on: ' + row.current.missing.join(', ') + '.', '');
    if (row.baseline.missing.length && row.baseline.attempts) lines.push(labels.baseline + ' has no counted sample on: ' + row.baseline.missing.join(', ') + '.', '');
    for (const item of row.current.stack_disagreements) {
      lines.push(labels.current + ' batches differ in ' + item.label + ': ' + Object.entries(item.values).map(([batch, value]) => batch + ' ' + value).join(', ') + '.', '');
    }
    if (row.difference.per_object.length && row.verdict !== 'not_judged') {
      lines.push(table(['Object', 'Tasks', labels.baseline, labels.current, diff], row.difference.per_object.map(item =>
        [item.object, item.tasks, fixed(item.baseline, 2), fixed(item.current, 2), signedText(item.difference, 2)])), '');
    }
  }
  if (result.notes.length) lines.push('## Notes', '', ...result.notes.map(note => '- ' + note), '');
  lines.push('## Problems', '', ...(result.problems.length ? result.problems.map(problem => '- ' + problem) : ['None.']), '');
  return lines.join('\n');
}

// Reads both rounds' batches, writes regression.json and regression.md to
// `outDir`, and returns what a terminal should show.
export async function regressionReport({ dataRoot, baseline, batches, outDir, set = REGRESSION_SET, systems = REGRESSION_SYSTEMS, margin, seed, labels,
  excludeStatuses = DEFAULT_EXCLUDED_STATUSES, now } = {}) {
  if (!baseline?.length) throw new Error('a regression check needs the earlier round\'s batches (--baseline)');
  if (!batches?.length) throw new Error('a regression check needs this round\'s batches (--batches)');
  const shared = baseline.filter(id => batches.includes(id));
  if (shared.length) throw new Error('batch ' + shared.join(', ') + ' is in both rounds; a regression compares two sets of batches');
  const earlier = await collectRuns({ dataRoot, batches: baseline, excludeStatuses });
  // The set's build record names every task built, run or not; read through
  // this round's collection so that each is placed by its truth.json.
  const buildRecord = earlier.setFiles?.get(set) ?? null;
  const later = await collectRuns({ dataRoot, batches, excludeStatuses, alsoTasks: buildRecord?.built_tasks ?? [] });
  const result = compareRounds({ baseline: earlier, current: later, set, systems, margin, seed, labels, buildRecord, excludeStatuses, now });
  const target = resolve(outDir ?? join(layout(resolve(dataRoot)).reports, 'regression'));
  await mkdir(target, { recursive: true });
  await writeJSON(join(target, 'regression.json'), result);
  await writeFile(join(target, 'regression.md'), regressionMarkdown(result));
  return {
    outDir: target, json: join(target, 'regression.json'), markdown: join(target, 'regression.md'), set: result.set, owed_tasks: result.owed.tasks,
    systems: result.systems.map(row => ({ key: row.key, verdict: row.verdict, reason: row.reason, small_change: row.small_change ?? false, difference: row.difference.mean,
      t_ci90: row.difference.t_ci90, bootstrap_ci90: row.difference.bootstrap_ci90, objects: row.difference.objects, missing: row.current.missing.length, cross_round: row.cross_round })),
    notes: result.notes,
    problems: result.problems.length,
  };
}
