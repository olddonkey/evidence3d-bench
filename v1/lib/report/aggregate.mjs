import { join, resolve } from 'node:path';
import { writeJSON } from '../../../lib/io.mjs';
import { layout, VARIANTS, CONFLICT_VARIANTS, PROTOCOL } from '../contract.mjs';
import { collectRuns, DEFAULT_EXCLUDED_STATUSES, UNNAMED_SET, UNKNOWN_SET, UNKNOWN_ARCHETYPE, scorerIdentity } from './collect.mjs';
import { finite, mean, median, spread, sampleSD, summarise, pairedBootstrap, tInterval, tTestP, holmAdjust, pooledSD, sdRange, detectableDifference,
  BOOTSTRAP_SAMPLES, PAIRWISE_SAMPLES, LOW_EVIDENCE_OBJECTS, SMALL_SAMPLE_OBJECTS, TIE_TOLERANCE, FAMILY_ALPHA } from './stats.mjs';
import { LADDERS, LADDER_RULE, MISSING_SHARE_LIMIT, inferLadders, parseRoster, rosterProvenance } from './roster.mjs';
import { timeCurve, T95_SHARE, T95_MIN_FINAL, ON_TIME_SECONDS } from './curves.mjs';

// v3: ladders, Holm-corrected verdicts, reference rows (rank null) when a roster is given.
// v4: incomplete pairs (verdict 'incomplete', in every family with p = 1), frozen
// families, demoted configurations (rank null) and set.completeness.
export const LEADERBOARD_SCHEMA = 'e3d-leaderboard-v4';
export const VARIANT_ORDER = Object.keys(VARIANTS);
// Adjacent rungs of the evidence ladder (kept for readers of earlier
// leaderboards); evidence_deltas covers every pair of variants present.
export const LADDER = [['t2', 't1'], ['t3', 't2'], ['t4', 't3']];
// A standard deviation estimated with fewer degrees of freedom than this is
// shown with its range and marked as resting on little data: at 10 df its 95 %
// range is still about x0.69 to x1.75, at 4 df x0.60 to x2.9.
export const LITTLE_DATA_DF = 10;
// The next round's planned size (Round 4: 72 objects, docs/V1-ROUND4-PLAN.md
// section 3); variance projections are made to this many objects.
export const PLANNED_OBJECTS = 72;
// The real tier compares two configurations only on the objects both
// completed (every task of the object), and decides only with at least this
// many (docs/V1-ROUND4-PLAN.md section 3); below it, no interval either.
export const REAL_TIER_MIN_OBJECTS = 8;

// What a named set is, where the report knows more than its name. A set is
// recorded per task in truth.json; the dev set's objects were used while the
// scorer and the pipeline were being tuned.
export const SET_NOTES = {
  dev: 'Development set: its seeds are public (v1/sets/dev.json) and its objects were used to develop and tune the scorer (tolerances, ' +
    'weights) and the task pipeline. Its numbers are development measurements, not test results.',
};

// Which ladder a variant belongs to: generated objects (t1-t4 and the conflict
// task c1), memory tasks on named landmarks (m2, m3) or real buildings (r2,
// r4). Variants of different families pose different objects, so a difference
// between them is no evidence delta and they are never paired.
export const variantFamily = variant => VARIANTS[variant]?.memory ? 'memory' : VARIANTS[variant]?.real ? 'real' : 'generated';

// Every pair of variants present within one family, later rung minus earlier in
// VARIANT_ORDER (t1 t2 t3 t4 c1 m2 m3 r2 r4): t4 - t2, c1 - t2, c1 - t4 when
// t2, t4 and c1 were run; m3 - m2; r4 - r2.
export function variantPairs(variants) {
  const present = VARIANT_ORDER.filter(variant => variants.includes(variant)), pairs = [];
  for (let j = 1; j < present.length; j++) for (let i = 0; i < j; i++) if (variantFamily(present[i]) === variantFamily(present[j])) pairs.push([present[j], present[i]]);
  return pairs;
}

export const cellKey = attempt => [attempt.system, attempt.model, attempt.effort ?? '-'].join(' / ');

// Variants whose truth carries an alternate state (contract CONFLICT_VARIANTS),
// by what the alternate stands for. On c1 it is the earlier state the stale
// drawings show; on the memory tasks the structure as published, which the
// contestant may remember. "Closer to primary" means following the evidence on
// both, but the two are reported apart: they measure different temptations.
export const CONFLICT_KINDS = [
  { id: 'conflict', label: 'Conflict', variants: CONFLICT_VARIANTS.filter(variant => !VARIANTS[variant].memory),
    primary: 'as photographed', alternate: 'out-of-date drawings', share: 'closer to the as-photographed state' },
  { id: 'memory', label: 'Memory', variants: CONFLICT_VARIANTS.filter(variant => VARIANTS[variant].memory),
    primary: 'evidence', alternate: 'memory', share: 'closer to the surveyed object (the evidence) than to the published figures (memory)' },
];
export const conflictKind = variant => CONFLICT_KINDS.find(kind => kind.variants.includes(variant)) ?? null;

// Share of contested probes on which the candidate sided with the primary
// state (the evidence), over all alternates of one report.
export function conflictShare(report) {
  let primary = 0, total = 0;
  for (const alternate of report?.alternates ?? []) {
    for (const contested of alternate.contested ?? []) { total++; if (contested.closer_to === 'primary') primary++; }
  }
  if (total) return primary / total;
  const fractions = (report?.alternates ?? []).map(alternate => alternate.closer_to_primary_fraction).filter(finite);
  return fractions.length ? mean(fractions) : undefined;
}

function conflictCounts(attempts) {
  const counts = { primary: 0, alternate: 0, neither: 0 };
  for (const attempt of attempts) {
    if (!attempt.valid) continue;
    for (const alternate of attempt.report.alternates ?? []) {
      for (const contested of alternate.contested ?? []) {
        const side = contested.closer_to in counts ? contested.closer_to : 'neither';
        counts[side]++;
      }
    }
  }
  return counts;
}

// Detail categories in the order DESIGN.md lists them; any other category a
// report names comes after these, by name.
export const DETAIL_CATEGORIES = ['massing', 'roof', 'openings', 'entrance', 'attachments', 'structure', 'ornament'];

// The categories the valid reports among `attempts` scored, in that order.
export function detailCategories(attempts) {
  const found = new Set();
  for (const attempt of attempts) {
    if (!attempt.valid) continue;
    for (const row of attempt.report?.detail?.categories ?? []) if (typeof row?.id === 'string' && row.id && finite(row.f)) found.add(row.id);
  }
  const rank = id => DETAIL_CATEGORIES.includes(id) ? DETAIL_CATEGORIES.indexOf(id) : DETAIL_CATEGORIES.length;
  return [...found].sort((p, q) => rank(p) - rank(q) || p.localeCompare(q));
}

// 100 x the mean group F of one category in one report (detail.score is the
// mean of these over categories); undefined when the report scored no group
// of that category.
export function categoryScore(report, id) {
  const row = (report?.detail?.categories ?? []).find(category => category?.id === id);
  return row && finite(row.f) ? 100 * row.f : undefined;
}

// The named dimensions of one report, counted as the scorer's probe_summary
// counts them: probes the evidence shows whose ray hits the truth. A probe
// whose ray hits nothing on the submission is missed and has no error. Per
// report: the median absolute error in metres and as a fraction of the truth
// diagonal, and the share missed; null when the report has no such probe.
export function probeErrors(report) {
  const evaluated = (Array.isArray(report?.probes) ? report.probes : []).filter(probe => probe?.evidenced === true && finite(probe.truth_m));
  if (!evaluated.length) return null;
  const hits = evaluated.filter(probe => probe.missed !== true && finite(probe.measured_m));
  const middle = median(hits.map(probe => finite(probe.error_m) ? Math.abs(probe.error_m) : Math.abs(probe.measured_m - probe.truth_m)));
  const diagonal = report.global?.diagonal_m;
  return { evaluated: evaluated.length, missed: evaluated.length - hits.length, missed_share: (evaluated.length - hits.length) / evaluated.length,
    median_m: middle, median_fraction: finite(middle) && finite(diagonal) && diagonal > 0 ? middle / diagonal : null };
}

// The tolerance rows of one report, whatever fractions the scorer used. Which
// rows enter shape_score is taken from the report when it says so (a boolean
// `in_shape_score` on the row, or a list of fractions); otherwise null, which
// the page shows as "not stated" rather than guessing.
function shapeFractions(report) {
  for (const list of [report?.global?.shape_fractions, report?.global?.shape_score_fractions, report?.shape_fractions, report?.shape?.fractions]) {
    if (Array.isArray(list) && list.length && list.every(finite)) return list;
  }
  return null;
}
export function toleranceRows(report) {
  const rows = Array.isArray(report?.global?.thresholds) ? report.global.thresholds : [];
  const named = shapeFractions(report);
  return rows.filter(row => row && finite(row.fraction)).map(row => ({
    fraction: row.fraction, tau_m: finite(row.tau_m) ? row.tau_m : null,
    precision: finite(row.precision) ? row.precision : null, recall: finite(row.recall) ? row.recall : null, f: finite(row.f) ? row.f : null,
    in_shape_score: typeof row.in_shape_score === 'boolean' ? row.in_shape_score
      : named ? named.some(fraction => Math.abs(fraction - row.fraction) < 1e-9) : null,
  })).sort((a, b) => a.fraction - b.fraction);
}

// What the collected reports say about tolerances: every fraction that occurs,
// and the fractions named as entering shape_score (null when no report names them).
export function toleranceSummary(attempts) {
  const fractions = new Map(), named = new Map();
  let reports = 0, naming = 0;
  for (const attempt of attempts) {
    if (!attempt.valid) continue;
    reports++;
    const rows = toleranceRows(attempt.report);
    if (rows.some(row => row.in_shape_score !== null)) naming++;
    for (const row of rows) {
      const key = String(row.fraction);
      fractions.set(key, (fractions.get(key) ?? 0) + 1);
      if (row.in_shape_score) named.set(key, (named.get(key) ?? 0) + 1);
    }
  }
  const sorted = map => [...map.keys()].map(Number).sort((a, b) => a - b);
  return { fractions: sorted(fractions), shape_score_fractions: naming ? sorted(named) : null, reports, reports_naming_shape_rows: naming,
    consistent: [...fractions.values()].every(count => count === reports) };
}

// Hierarchical means, level 1: attempts averaged within a task. valueOf
// returning a non-number leaves the attempt out.
export function taskMeans(attempts, valueOf = attempt => attempt.score, filter = () => true) {
  const tasks = new Map();
  for (const attempt of attempts) {
    if (!filter(attempt)) continue;
    const value = valueOf(attempt);
    if (!finite(value)) continue;
    if (!tasks.has(attempt.task_id)) tasks.set(attempt.task_id, { object: attempt.object, values: [] });
    tasks.get(attempt.task_id).values.push(value);
  }
  return new Map([...tasks].map(([task, { object, values }]) => [task, { object, mean: mean(values), attempts: values.length }]));
}

// Level 2: tasks averaged within an object, so every object weighs the same
// however many tasks and attempts it has.
function perObject(attempts, valueOf, filter = () => true) {
  const tasks = taskMeans(attempts, valueOf, filter), objects = new Map();
  for (const { object, mean: value } of tasks.values()) {
    if (!objects.has(object)) objects.set(object, []);
    objects.get(object).push(value);
  }
  return { values: new Map([...objects].map(([object, means]) => [object, mean(means)])),
    attempts: [...tasks.values()].reduce((sum, task) => sum + task.attempts, 0), tasks: tasks.size };
}

// Per object: mean score on variant `high` minus mean score on variant `low`
// (attempts within a task, tasks within the object), over objects with both.
function variantDelta(attempts, high, low, seed) {
  const upper = perObject(attempts, attempt => attempt.score, attempt => attempt.variant === high).values;
  const lower = perObject(attempts, attempt => attempt.score, attempt => attempt.variant === low).values;
  const deltas = new Map();
  for (const [object, value] of upper) if (lower.has(object)) deltas.set(object, value - lower.get(object));
  return { ...summarise(deltas, { seed, basis: 'paired by object; failures count as 0' }), t_ci95: tInterval([...deltas.values()]),
    pairs: deltas.size, unpaired_objects: new Set([...upper.keys(), ...lower.keys()]).size - deltas.size };
}

function cellEntry(key, set, attempts, seed, { deltaPairs = [], archetypes = [], categories = [] } = {}) {
  const first = attempts[0];
  // The unnamed set keeps the seed path it always had, so a report of the
  // same batches reproduces earlier intervals exactly.
  const seedFor = metric => seed + '/' + (set === UNNAMED_SET ? '' : set + '/') + key + '/' + metric;
  const metric = (name, valueOf, filter, basis) => {
    const { values, attempts: used, tasks } = perObject(attempts, valueOf, filter);
    return summarise(values, { seed: seedFor(name), attempts: used, tasks, basis });
  };
  // The same per-object values with their median and interquartile range over
  // objects. Errors of position, size and named dimensions are skewed (one
  // model turned round adds 180 degrees to its object), so the page shows the
  // median; the mean and its interval stay alongside, seeded as before.
  const diagnostic = (name, valueOf, filter, basis) => {
    const { values, attempts: used, tasks } = perObject(attempts, valueOf, filter);
    return { ...summarise(values, { seed: seedFor(name), attempts: used, tasks, basis }), ...spread([...values.values()]) };
  };
  const probeResults = new Map(attempts.filter(attempt => attempt.valid).map(attempt => [attempt, probeErrors(attempt.report)]));
  const probesOf = attempt => probeResults.get(attempt) ?? null;
  const detailByCategory = {};
  for (const category of categories) {
    detailByCategory[category] = metric('detail/' + category, attempt => attempt.valid ? categoryScore(attempt.report, category) : undefined, undefined,
      'valid attempts whose report scored a group of this category; 100 x the mean F of its groups');
  }
  const variants = {};
  for (const variant of VARIANT_ORDER) {
    if (!attempts.some(attempt => attempt.variant === variant)) continue;
    variants[variant] = metric('variant/' + variant, attempt => attempt.score, attempt => attempt.variant === variant, 'all attempts; failures count as 0');
  }
  const ladder = {};
  for (const [high, low] of LADDER) ladder[high + '-' + low] = variantDelta(attempts, high, low, seedFor('ladder/' + high + '-' + low));
  // Every pair of variants present in the set, not only adjacent rungs; the
  // same seed as the ladder where they overlap, so both give the same interval.
  const evidenceDeltas = {};
  for (const [high, low] of deltaPairs) evidenceDeltas[high + '-' + low] = { high, low, ...variantDelta(attempts, high, low, seedFor('ladder/' + high + '-' + low)) };
  const byArchetype = {};
  for (const archetype of archetypes) {
    if (!attempts.some(attempt => attempt.archetype === archetype)) continue;
    byArchetype[archetype] = metric('archetype/' + archetype, attempt => attempt.score, attempt => attempt.archetype === archetype, 'all attempts; failures count as 0');
  }
  // One entry per kind of alternate: `conflict` (c1) and `memory` (m2, m3).
  const evidenceUse = kind => {
    const inKind = attempt => kind.variants.includes(attempt.variant), counted = attempts.filter(inKind);
    return {
      ...metric(kind.id, attempt => attempt.valid ? conflictShare(attempt.report) : undefined, inKind,
        'valid ' + kind.variants.join(' / ') + ' attempts; share of contested probes ' + kind.share),
      probes: conflictCounts(counted),
      variants: kind.variants,
      // c1_attempts is the name earlier leaderboards used for the conflict task.
      [kind.id === 'conflict' ? 'c1_attempts' : kind.id + '_attempts']: counted.length,
      failed_attempts: counted.filter(attempt => !attempt.valid).length,
    };
  };
  const [conflict, memory] = CONFLICT_KINDS.map(evidenceUse);
  const frameError = attempt => attempt.valid ? attempt.report.alignment?.frame_error : undefined;
  const statuses = {};
  for (const attempt of attempts) statuses[attempt.status] = (statuses[attempt.status] ?? 0) + 1;
  const valid = attempts.filter(attempt => attempt.valid).length;
  const walls = attempts.map(attempt => attempt.wall_seconds).filter(finite);
  const usages = attempts.map(attempt => attempt.usage).filter(Boolean);
  const totals = usages.map(usage => usage.total).filter(finite);
  const costs = attempts.map(attempt => attempt.cost_usd).filter(finite);
  const perTask = taskMeans(attempts);
  const attemptCounts = [...perTask.values()].map(task => task.attempts);
  return {
    key, set, system: first.system, model: first.model, effort: first.effort,
    batches: [...new Set(attempts.map(attempt => attempt.batch))].sort(),
    attempts: attempts.length,
    tasks: new Set(attempts.map(attempt => attempt.task_id)).size,
    objects: new Set(attempts.map(attempt => attempt.object)).size,
    attempts_per_task: { min: Math.min(...attemptCounts), max: Math.max(...attemptCounts), mean: mean(attemptCounts) },
    low_evidence: new Set(attempts.map(attempt => attempt.object)).size < LOW_EVIDENCE_OBJECTS,
    score: metric('score', attempt => attempt.score, undefined, 'all attempts; failures count as 0'),
    variants,
    archetypes: byArchetype,
    ladder,
    evidence_deltas: evidenceDeltas,
    conflict,
    memory,
    shape: metric('shape', attempt => attempt.valid ? attempt.report.shape_score : 0, undefined,
      'all attempts; failures count as 0; shape_score as reported by the scorer'),
    detail: metric('detail', attempt => attempt.valid ? attempt.report.detail?.score : 0, undefined,
      'all attempts; failures count as 0; valid reports without a detail score are left out'),
    // Diagnostics: where a delivered model loses its score. Valid attempts
    // only; a failure has no model to diagnose and is counted in `success`.
    detail_categories: detailByCategory,
    probe_error: {
      cm: diagnostic('probes/error_cm', attempt => finite(probesOf(attempt)?.median_m) ? 100 * probesOf(attempt).median_m : undefined, undefined,
        'valid attempts only; per attempt the median absolute error, in cm, of the evidenced probes whose ray hit the submission'),
      diagonal_pct: diagnostic('probes/error_pct', attempt => finite(probesOf(attempt)?.median_fraction) ? 100 * probesOf(attempt).median_fraction : undefined, undefined,
        'valid attempts only; per attempt the median absolute probe error as a percentage of the truth diagonal'),
      missed: metric('probes/missed', attempt => probesOf(attempt)?.missed_share, undefined,
        'valid attempts only; per attempt the share of evidenced probes whose ray hit nothing on the submission'),
      probes: { evaluated: [...probeResults.values()].reduce((sum, item) => sum + (item?.evaluated ?? 0), 0),
        missed: [...probeResults.values()].reduce((sum, item) => sum + (item?.missed ?? 0), 0),
        attempts: [...probeResults.values()].filter(Boolean).length },
    },
    frame_error: {
      offset_fraction: diagnostic('frame/offset_fraction', attempt => frameError(attempt)?.offset_fraction, undefined, 'valid attempts only; fraction of the truth diagonal'),
      offset_m: diagnostic('frame/offset_m', attempt => frameError(attempt)?.offset_m, undefined, 'valid attempts only'),
      yaw_deg: diagnostic('frame/yaw_deg', attempt => finite(frameError(attempt)?.yaw_deg) ? Math.abs(frameError(attempt).yaw_deg) : undefined, undefined, 'valid attempts only; absolute degrees'),
    },
    scale_error_pct: diagnostic('scale', attempt => attempt.valid && finite(attempt.report.shape?.scale) ? Math.abs(attempt.report.shape.scale - 1) * 100 : undefined,
      attempt => attempt.scale_evidence === 'metric', 'valid attempts on metric tasks; |fitted scale - 1| in percent'),
    success: { rate: attempts.length ? valid / attempts.length : null, valid, attempts: attempts.length, basis: 'attempts with a valid score report' },
    status_counts: statuses,
    wall_seconds: { median: median(walls), mean: mean(walls), attempts: walls.length },
    tokens: {
      mean_total: mean(totals), median_total: median(totals),
      mean_input: mean(usages.map(usage => usage.input)), mean_output: mean(usages.map(usage => usage.output)),
      mean_cached_input: mean(usages.map(usage => usage.cached_input)),
      attempts_reporting: usages.length, attempts: attempts.length,
      basis: 'as recorded in result.json; total = input (cached reads included) + output',
    },
    cost_usd: { mean: mean(costs), total: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null, attempts_reporting: costs.length },
    time_curve: timeCurve(attempts, (name, valueOf, basis) => metric(name, valueOf, undefined, basis)),
  };
}

// ---------------------------------------------------------------- pairwise

// A bound that rounds to 0.0 keeps one significant digit, so "[-0.002, +7.9]"
// is not printed as "[0.0, +7.9]" next to the words "includes zero".
export const signedText = (value, digits = 1) => value === 0 ? (0).toFixed(digits)
  : (value > 0 ? '+' : '') + (Math.abs(value) < 0.5 * 10 ** -digits ? value.toPrecision(1) : value.toFixed(digits));
export const intervalText = (ci, digits = 1) => '[' + signedText(ci[0], digits) + ', ' + signedText(ci[1], digits) + ']';
const excludesZero = ci => ci ? ci[0] > 0 || ci[1] < 0 : null;
// Bootstrap shares in words; "all" and "none" only when literally so.
export const shareText = (share, samples) => share === 1 ? 'all ' + samples : share === 0 ? 'none of ' + samples
  : (share > 0.99 || share < 0.01 ? (100 * share).toFixed(2) : Math.round(100 * share)) + '% of ' + samples;

// A versus B on the objects both ran. Per object: on the tasks both have
// (at least one counted attempt each), attempts are averaged within a task and
// tasks within the object, then B's mean is subtracted from A's. Objects are
// resampled for the interval; attempts and tasks are not resampled separately,
// because their noise is already inside each object's difference.
export function comparePair(a, b, { seed = 'e3d-pairwise', samples = PAIRWISE_SAMPLES } = {}) {
  const tasksA = taskMeans(a.attempts), tasksB = taskMeans(b.attempts);
  const objects = new Map();
  for (const [task, x] of tasksA) {
    const y = tasksB.get(task);
    if (!y) continue;
    if (!objects.has(x.object)) objects.set(x.object, { a: [], b: [], tasks: [] });
    const entry = objects.get(x.object);
    entry.a.push(x.mean); entry.b.push(y.mean); entry.tasks.push(task);
  }
  const perObject = [...objects].sort(([p], [q]) => p.localeCompare(q)).map(([object, entry]) => {
    const scoreA = mean(entry.a), scoreB = mean(entry.b);
    return { object, tasks: entry.tasks.length, a: scoreA, b: scoreB, difference: scoreA - scoreB };
  });
  const differences = perObject.map(row => row.difference);
  const won = differences.filter(value => value > TIE_TOLERANCE).length, lost = differences.filter(value => value < -TIE_TOLERANCE).length;
  const boot = pairedBootstrap(differences, { seed, samples });
  const objectsA = new Set([...tasksA.values()].map(task => task.object)), objectsB = new Set([...tasksB.values()].map(task => task.object));
  const pairedTasks = perObject.reduce((sum, row) => sum + row.tasks, 0);
  const row = {
    a: a.key, b: b.key,
    objects: perObject.length, tasks: pairedTasks,
    unpaired_objects: new Set([...objectsA, ...objectsB]).size - perObject.length,
    unpaired_tasks: tasksA.size + tasksB.size - 2 * pairedTasks,
    mean_difference: mean(differences),
    ci95: boot?.ci95 ?? null,
    share_a_higher: boot?.share_a_higher ?? null,
    share_b_higher: boot?.share_b_higher ?? null,
    samples: boot?.samples ?? null,
    t_ci95: tInterval(differences),
    // Two-sided paired t test; the corrected verdicts adjust this p-value.
    p_t: tTestP(differences),
    won, tied: differences.length - won - lost, lost,
    excludes_zero: excludesZero(boot?.ci95 ?? null),
    small_sample: perObject.length < SMALL_SAMPLE_OBJECTS,
    low_evidence: perObject.length < LOW_EVIDENCE_OBJECTS,
    per_object: perObject,
  };
  row.t_excludes_zero = excludesZero(row.t_ci95);
  // The percentile bootstrap undercovers with few objects (measured on the
  // synthetic design: 84 % coverage at 5 objects, 92 % at 10, 93 % at 24;
  // the t interval 94-96 %), so a pair counts as separated only when both
  // intervals exclude zero, and as unsettled when they disagree.
  row.verdict = !row.ci95 || !row.t_ci95 ? 'not_evaluated'
    : row.excludes_zero && row.t_excludes_zero ? (row.ci95[0] > 0 ? 'a_higher' : 'b_higher')
      : !row.excludes_zero && !row.t_excludes_zero ? 'not_separated' : 'unsettled';
  row.statement = pairStatement(row);
  return row;
}

// The verdict in words. It is about these objects and this design, and says so.
export function pairStatement(row) {
  const record = 'won ' + row.won + ', tied ' + row.tied + ', lost ' + row.lost + ' of ' + row.objects + ' object' + (row.objects === 1 ? '' : 's');
  if (row.verdict === 'not_evaluated') {
    return row.a + ' vs ' + row.b + ': not evaluated, ' + (row.objects ? 'only ' + row.objects + ' object' : 'no object') + ' run by both' +
      (row.objects ? ' (' + record + ')' : '') + '.';
  }
  const facts = ' (A ahead in ' + shareText(row.share_a_higher, row.samples) + ' resamples; A ' + record + ').';
  const difference = signedText(row.mean_difference) + ' points per object';
  const boot = '95% bootstrap interval ' + intervalText(row.ci95), t = 'Student-t interval ' + intervalText(row.t_ci95);
  let text;
  if (row.verdict === 'a_higher') text = row.a + ' scored higher than ' + row.b + ': A - B = ' + difference + '; the ' + boot + ' and the ' + t + ' both exclude zero' + facts;
  else if (row.verdict === 'b_higher') text = row.b + ' scored higher than ' + row.a + ' on the objects both ran: A - B = ' + difference + '; the ' + boot + ' and the ' + t + ' both exclude zero' + facts;
  else if (row.verdict === 'not_separated') text = 'Not separated: ' + row.a + ' - ' + row.b + ' = ' + difference + '; the ' + boot + ' and the ' + t + ' both include zero' + facts;
  else {
    text = 'Unsettled: ' + row.a + ' - ' + row.b + ' = ' + difference + '; the ' + boot + (row.excludes_zero ? ' excludes' : ' includes') + ' zero but the ' + t +
      (row.t_excludes_zero ? ' excludes' : ' includes') + ' it' + facts;
  }
  if (row.small_sample) text += ' Only ' + row.objects + ' objects: at this size the bootstrap interval runs too narrow.';
  return text;
}

// ------------------------------------------------------ multiple comparisons
//
// A table of pairwise verdicts makes many claims at once: with 66 pairs at
// 95 % each, one or more false separations are likely even if no configuration
// differed. Each family is therefore corrected on its own, by Holm's step-down
// method at family-wise FAMILY_ALPHA on the two-sided paired t p-value:
//   all            every pair of formal configurations of a set (the pairwise table);
//   default, top   the pairs of one ladder;
//   effort         top minus default effort of one client and model.
// A pair is separated after correction when its Holm-adjusted p is below
// FAMILY_ALPHA and its uncorrected verdict already separates it (both 95 %
// intervals exclude zero), so correction only ever removes separations. The
// same pair can stay separated in a small family and not in a large one: the
// larger table makes more claims, and every table states its m.
//
// A family's members are fixed by the roster (docs/V1-ROUND4-PLAN.md section
// 4): every pair it implies counts in m, also one that cannot be decided. Such
// a pair is `incomplete`: it keeps its gap (and, where they exist, its
// intervals) but gets no verdict and enters Holm with p = 1, so it can never
// make another pair easier to separate. The reasons, in the order checked:

export const INCOMPLETE_REASONS = {
  demoted: 'a configuration the roster demoted',
  missing_tasks: 'tasks the roster lists as missing',
  unlisted_gaps: 'tasks without a counted sample that the roster does not list as missing (a data problem)',
  few_complete_objects: 'fewer than ' + REAL_TIER_MIN_OBJECTS + ' objects both completed (real tier)',
  few_objects: 'fewer than 2 objects run by both',
  undefined_test: 'the paired t test is undefined (the per-object differences do not vary)',
};

const SEPARATED = new Set(['a_higher', 'b_higher']);

// -> one entry per row, in order: { family, comparisons, p_adjusted, verdict }.
// Every row counts in m; an incomplete one enters with p = 1.
export function correctFamily(rows, family) {
  const tested = rows.map(row => row.verdict === 'incomplete' || !finite(row.p_t) ? 1 : row.p_t);
  const adjusted = holmAdjust(tested), comparisons = rows.length;
  return rows.map((row, index) => ({ family, comparisons, p_adjusted: adjusted[index],
    verdict: row.verdict === 'incomplete' ? 'incomplete' : adjusted[index] < FAMILY_ALPHA && SEPARATED.has(row.verdict) ? row.verdict : 'not_separated' }));
}

function familySummary(rows, family) {
  const tested = rows.filter(row => row.holm);
  return { family, method: 'holm', alpha: FAMILY_ALPHA, test: 'paired t test, two-sided', comparisons: tested.length,
    separated_uncorrected: tested.filter(row => SEPARATED.has(row.verdict)).length, separated: tested.filter(row => SEPARATED.has(row.holm.verdict)).length,
    incomplete: tested.filter(row => row.verdict === 'incomplete').length };
}

// Marks a pair as undecidable, keeping its gap; `intervals: false` also drops
// its intervals (the real tier gives none below its object minimum).
function makeIncomplete(pair, reason, { intervals = true } = {}) {
  if (!intervals) Object.assign(pair, { ci95: null, t_ci95: null, share_a_higher: null, share_b_higher: null, samples: null, excludes_zero: false, t_excludes_zero: false });
  pair.verdict = 'incomplete';
  pair.incomplete = reason;
  pair.statement = pair.a + ' vs ' + pair.b + ': incomplete, no verdict: ' + INCOMPLETE_REASONS[reason] + '. ' +
    (pair.objects ? 'A - B = ' + signedText(pair.mean_difference) + ' points per object over ' + pair.objects + ' object' + (pair.objects === 1 ? '' : 's') +
      (pair.ci95 ? ' (95% bootstrap interval ' + intervalText(pair.ci95) + (pair.t_ci95 ? ', Student-t ' + intervalText(pair.t_ci95) : '') + ')' : '') + '.'
      : 'No object run by both.');
  return pair;
}

// A p-value as printed: three decimals, below 0.001 as a bound.
export const pText = p => !finite(p) ? 'n/a' : p < 0.001 ? '< 0.001' : '= ' + p.toFixed(3);

export function holmSentence(row) {
  if (!row.holm) return '';
  if (row.holm.verdict === 'incomplete') return ' It counts among the ' + row.holm.comparisons + ' pairs of Holm\'s correction for this table with p = 1.';
  const after = SEPARATED.has(row.holm.verdict) ? 'still separated' : SEPARATED.has(row.verdict) ? 'no longer separated' : 'not separated';
  return ' After Holm\'s correction over the ' + row.holm.comparisons + ' pairs of this table (adjusted p ' + pText(row.holm.p_adjusted) + '): ' + after + '.';
}

// For a set: pair -> a note when the same pair, in the table of every formal
// configuration, is corrected to the other verdict (a smaller family corrects
// less, so a ladder can separate what the large table does not), else ''.
export function allPairsNote(set) {
  const holms = new Map();
  for (const pair of set.pairwise.pairs) if (pair.holm) holms.set(pair.a + '|' + pair.b, pair.holm).set(pair.b + '|' + pair.a, pair.holm);
  return pair => {
    const other = pair.holm ? holms.get(pair.a + '|' + pair.b) : null;
    if (!other || other === pair.holm || other.verdict === 'incomplete' || pair.holm.verdict === 'incomplete' ||
      SEPARATED.has(other.verdict) === SEPARATED.has(pair.holm.verdict)) return '';
    return (SEPARATED.has(other.verdict) ? 'separated' : 'not separated') + ' in the table of all ' + other.comparisons + ' pairs (adj. p ' + pText(other.p_adjusted) + ')';
  };
}

// A pair without its per-object rows, for the ladder and effort tables.
const slimPair = pair => ({ a: pair.a, b: pair.b, objects: pair.objects, tasks: pair.tasks, mean_difference: pair.mean_difference, ci95: pair.ci95,
  t_ci95: pair.t_ci95, p_t: pair.p_t, won: pair.won, tied: pair.tied, lost: pair.lost, verdict: pair.verdict, incomplete: pair.incomplete ?? null,
  small_sample: pair.small_sample, low_evidence: pair.low_evidence });

// The same comparison read the other way round, B - A.
const flip = ci => ci ? [-ci[1], -ci[0]] : null;
const OPPOSITE = { a_higher: 'b_higher', b_higher: 'a_higher' };
const reversed = pair => ({ ...pair, a: pair.b, b: pair.a, mean_difference: finite(pair.mean_difference) ? -pair.mean_difference : pair.mean_difference,
  ci95: flip(pair.ci95), t_ci95: flip(pair.t_ci95), won: pair.lost, lost: pair.won, verdict: OPPOSITE[pair.verdict] ?? pair.verdict });

// The two ladders of one set and the effort pairs between them. `order` is
// the set's configurations in score order (then roster configurations with no
// counted attempt), so a ladder's pairs keep the pairwise table's orientation.
// With a roster a ladder's members are the roster's, present or not, demoted
// or not: its family is fixed. A ladder ranks its present, undemoted members.
function setLadders(order, entryOf, pairs, roster, cells) {
  const byKeys = new Map(pairs.map(pair => [pair.a + '|' + pair.b, pair]));
  const pairOf = (a, b) => byKeys.has(a + '|' + b) ? slimPair(byKeys.get(a + '|' + b)) : reversed(slimPair(byKeys.get(b + '|' + a)));
  const infoOf = key => roster?.keys.get(key) ?? entryOf.get(key);
  const corrected = (rows, family) => {
    correctFamily(rows, family).forEach((holm, index) => { rows[index].holm = holm; });
    return { pairs: rows, correction: familySummary(rows, family) };
  };
  const members = new Map();
  const ladders = LADDERS.map(ladder => {
    const on = order.filter(key => !(roster && !roster.keys.has(key)) && (infoOf(key)?.ladders ?? []).includes(ladder.id));
    members.set(ladder.id, on);
    const rows = [];
    for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) rows.push(pairOf(on[i], on[j]));
    // Ranked members first, in score order, then the demoted ones (no rank).
    const present = on.filter(key => entryOf.has(key));
    let rank = 0;
    const entries = [...present.filter(key => !entryOf.get(key).demoted), ...present.filter(key => entryOf.get(key).demoted)]
      .map(key => ({ key, rank: entryOf.get(key).demoted ? null : ++rank }));
    return { id: ladder.id, label: ladder.label, entries,
      // Listed in the roster for this ladder, but no counted attempt in this set.
      missing: roster ? roster.configurations.filter(item => item.ladders.includes(ladder.id) && !cells.has(item.key)).map(item => item.key) : [],
      pairwise: corrected(rows, ladder.id) };
  });
  const effort = [];
  for (const top of members.get('top')) {
    const high = infoOf(top), base = members.get('default').find(key => infoOf(key).system === high.system && infoOf(key).model === high.model);
    if (!base || base === top) continue;
    effort.push({ system: high.system, model: high.model, default_effort: infoOf(base).effort, top_effort: high.effort, ...pairOf(top, base) });
  }
  return { ladders, effort: corrected(effort, 'effort') };
}

// Every task of a set: those an attempt ran, and those a batch planned or the
// roster lists (`taskInfo`, collectRuns), run or not.
function setTasks(set, inSet, taskInfo) {
  const tasks = new Map();
  for (const attempt of inSet) tasks.set(attempt.task_id, { object: attempt.object, variant: attempt.variant });
  for (const [task, info] of taskInfo ?? []) if (info.set === set && !tasks.has(task)) tasks.set(task, { object: info.object, variant: info.variant });
  return tasks;
}

// The tasks a set asks of every formal configuration: all of them, or those of
// the roster's required variants when it names them.
const owedTasks = (tasks, roster) => roster?.required_variants ? new Map([...tasks].filter(([, info]) => roster.required_variants.includes(info.variant))) : tasks;

// One roster configuration against what the set asks: tasks with a counted
// sample, the gaps the roster lists (with its reasons) and those it does not.
function completenessOf(item, attempts, expected) {
  const sampled = new Set(attempts.map(attempt => attempt.task_id)), listed = new Map(item.missing_tasks.map(gap => [gap.task, gap.reason]));
  const gaps = [...expected.keys()].filter(task => !sampled.has(task)).sort();
  return {
    key: item.key, present: attempts.length > 0, expected: expected.size, sampled: expected.size - gaps.length,
    missing: gaps.filter(task => listed.has(task)).map(task => ({ task, reason: listed.get(task) })),
    unlisted: gaps.filter(task => !listed.has(task)),
    listed_but_sampled: [...listed.keys()].filter(task => expected.has(task) && sampled.has(task)).sort(),
    demoted: item.demoted,
  };
}

const share = (count, total) => total ? count / total : 0;
const percentText = value => (Math.round(1000 * value) / 10) + ' %';
const firstFew = (list, count = 3) => list.slice(0, count).join(', ') + (list.length > count ? ', ...' : '');

// The roster's completeness rules (docs/V1-ROUND4-PLAN.md section 2). Over the
// limit without being demoted refuses the roster; the rest are data problems.
function checkCompleteness(record, { set, realTier, roster, problems }) {
  const name = 'roster' + (roster.file ? ' ' + roster.file : ''), part = share(record.missing.length, record.expected);
  if (!realTier && !record.demoted && part > MISSING_SHARE_LIMIT) {
    throw new Error(name + ' refused: in set ' + set + ', ' + record.key + ' misses ' + record.missing.length + ' of ' + record.expected + ' tasks (' +
      percentText(part) + '), more than ' + percentText(MISSING_SHARE_LIMIT) + '; the roster must mark it demoted, with the reason');
  }
  if (!realTier && record.demoted && part <= MISSING_SHARE_LIMIT) {
    problems.push(name + ' demotes ' + record.key + ', but in set ' + set + ' it misses only ' + record.missing.length + ' of ' + record.expected + ' listed tasks (' +
      percentText(part) + '), within the ' + percentText(MISSING_SHARE_LIMIT) + ' that keeps a configuration ranked');
  }
  if (record.unlisted.length) {
    problems.push('set ' + set + ': ' + record.key + ' has no counted sample on ' + record.unlisted.length + ' task' + (record.unlisted.length === 1 ? '' : 's') +
      ' that the roster does not list as missing (' + firstFew(record.unlisted) + '); its pairs get no verdict');
  }
  if (record.listed_but_sampled.length) {
    problems.push(name + ' lists ' + firstFew(record.listed_but_sampled) + ' as missing for ' + record.key + ', but set ' + set + ' has a counted sample; the sample counts');
  }
}

// --------------------------------------------------------------- variance
//
// Where the noise is. Three standard deviations, all on report.score with
// failures as 0 and excluded attempts left out, as everywhere else:
//   between attempts  on the same task, pooled over every task of a
//                     configuration with at least two counted attempts;
//   between objects   of a configuration's per-object mean scores (what its
//                     own leaderboard interval resamples);
//   paired difference of the per-object differences of two configurations
//                     (what a pairwise interval resamples: pairing removes the
//                     object effect both share, so this is usually far smaller).
// From the last, the smallest difference the design resolves. Each SD carries
// its degrees of freedom and an approximate 95 % range, and is marked when it
// rests on fewer than LITTLE_DATA_DF degrees of freedom.

// Per task: its object and the counted scores of its attempts.
function taskScores(attempts) {
  const tasks = new Map();
  for (const attempt of attempts) {
    if (!finite(attempt.score)) continue;
    if (!tasks.has(attempt.task_id)) tasks.set(attempt.task_id, { object: attempt.object, values: [], failures: 0 });
    const task = tasks.get(attempt.task_id);
    task.values.push(attempt.score);
    if (!attempt.valid) task.failures++;
  }
  return tasks;
}

const sdEntry = (sd, df, extra = {}) => ({ sd, df, ci95: sdRange(sd, df), little_data: df < LITTLE_DATA_DF, ...extra });

// Between-attempt noise of one configuration.
export function attemptNoise(attempts) {
  const repeated = [...taskScores(attempts).values()].filter(task => task.values.length >= 2);
  const pooled = pooledSD(repeated.map(task => task.values));
  return sdEntry(pooled.sd, pooled.df, { tasks: pooled.groups, attempts: pooled.values, failures: repeated.reduce((sum, task) => sum + task.failures, 0),
    basis: 'pooled over tasks with at least two counted attempts; failures count as 0' });
}

// sum over the given tasks of 1 / attempts, divided by tasks^2, per object: times an
// attempt variance, the variance that attempt noise adds to that object's mean.
function attemptWeights(tasks, objectFilter = () => true) {
  const weights = new Map();
  for (const task of tasks) {
    if (!objectFilter(task.object)) continue;
    if (!weights.has(task.object)) weights.set(task.object, { sum: 0, tasks: 0 });
    const entry = weights.get(task.object);
    entry.sum += 1 / task.attempts; entry.tasks++;
  }
  return new Map([...weights].map(([object, { sum, tasks: count }]) => [object, sum / count ** 2]));
}

function configurationVariance(entry, attempts) {
  const attempt = attemptNoise(attempts);
  const objects = [...perObject(attempts, item => item.score).values.values()];
  const sd = sampleSD(objects);
  // How much of the spread between object means is only attempt noise.
  let share = null;
  if (finite(attempt.sd) && finite(sd) && sd > 0) {
    const weights = [...attemptWeights([...taskMeans(attempts).values()]).values()];
    share = attempt.sd ** 2 * mean(weights) / sd ** 2;
  }
  return { key: entry.key, attempts_per_task: entry.attempts_per_task, attempt_sd: attempt,
    object_sd: sdEntry(sd, objects.length - 1, { objects: objects.length, attempt_share: share,
      basis: 'standard deviation of the per-object mean scores (attempts within a task, tasks within the object)' }) };
}

function pairVariance(pair, attemptsA, attemptsB, noiseA, noiseB, plannedObjects) {
  const differences = pair.per_object.map(row => row.difference), n = differences.length;
  const sd = sampleSD(differences), range = sdRange(sd, n - 1);
  const current = detectableDifference(sd, n);
  const projectAt = objects => {
    const at = detectableDifference(sd, objects);
    return at ? { objects, resolution: at.resolution, detectable: at.detectable,
      detectable_range: range ? [detectableDifference(range[0], objects).detectable, detectableDifference(range[1], objects).detectable] : null } : null;
  };
  // Attempt noise inside each per-object difference: sigma_A^2 * w_A + sigma_B^2 * w_B,
  // with w the per-object attempt weights over the paired tasks.
  const paired = new Set(pair.per_object.map(row => row.object));
  const tasksA = taskMeans(attemptsA), tasksB = taskMeans(attemptsB);
  const common = [...tasksA.keys()].filter(task => tasksB.has(task) && paired.has(tasksA.get(task).object));
  const weightsA = attemptWeights(common.map(task => tasksA.get(task))), weightsB = attemptWeights(common.map(task => tasksB.get(task)));
  const part = (noise, weights) => finite(noise.sd) ? noise.sd ** 2 * mean([...weights.values()]) : null;
  const partA = part(noiseA, weightsA), partB = part(noiseB, weightsB);
  let attemptShare = null, attemptShareAtLeast = null, floor = null;
  if (finite(sd) && sd > 0) {
    if (partA !== null && partB !== null) {
      attemptShare = (partA + partB) / sd ** 2;
      // With attempt noise averaged away entirely (many attempts per task),
      // what would remain of the per-object difference SD.
      const structural = Math.sqrt(Math.max(0, sd ** 2 - partA - partB));
      floor = { sd: structural, at_objects: detectableDifference(structural, n)?.detectable ?? null,
        at_planned: detectableDifference(structural, Math.max(n, plannedObjects))?.detectable ?? null };
    } else if (partA !== null || partB !== null) attemptShareAtLeast = (partA ?? partB) / sd ** 2;
  }
  const row = {
    a: pair.a, b: pair.b, objects: n,
    difference_sd: sdEntry(sd, n - 1, { basis: 'standard deviation of the per-object differences A - B on the tasks both ran' }),
    resolution: current?.resolution ?? null, detectable: current?.detectable ?? null,
    detectable_range: current && range ? [detectableDifference(range[0], n).detectable, detectableDifference(range[1], n).detectable] : null,
    projected: plannedObjects > n ? projectAt(plannedObjects) : null,
    attempt_share: attemptShare, attempt_share_at_least: attemptShareAtLeast, without_attempt_noise: floor,
    attempts_estimated: { a: finite(noiseA.sd), b: finite(noiseB.sd) },
  };
  row.statement = varianceStatement(row);
  return row;
}

const fixed = (value, digits = 1) => finite(value) ? value.toFixed(digits) : 'n/a';

// An attempt-noise share as text. Estimated from two noisy variances, it can
// exceed 100 %: attempt noise alone would then predict more spread than was
// observed, which is reported as "all", with the estimate, never as a cap.
export function attemptShareText(share, { atLeast = false } = {}) {
  if (!finite(share)) return null;
  const percent = Math.round(100 * share) + '%';
  if (share > 1) return 'all (' + (atLeast ? 'lower bound ' : '') + 'estimate ' + percent + ')';
  return (atLeast ? '≥ ' : '') + percent;
}

export function varianceStatement(row) {
  if (!finite(row.difference_sd.sd)) return row.a + ' vs ' + row.b + ': fewer than two paired objects, no spread can be estimated.';
  const sd = row.difference_sd, range = sd.ci95 ? ' (95% range ' + fixed(sd.ci95[0]) + ' to ' + fixed(sd.ci95[1]) + ')' : '';
  let text = row.a + ' vs ' + row.b + ': the per-object difference varies with SD ' + fixed(sd.sd) + ' over ' + row.objects + ' objects' + range +
    (sd.little_data ? ', which rests on little data' : '') + '. With these objects an observed mean difference must exceed ' + fixed(row.resolution) +
    ' points for its t interval to exclude zero; a true difference of ' + fixed(row.detectable) + ' would be found about 80% of the time' +
    (row.detectable_range ? ' (' + fixed(row.detectable_range[0]) + ' to ' + fixed(row.detectable_range[1]) + ' given the uncertainty of the SD)' : '') + '.';
  if (row.projected) {
    text += ' At ' + row.projected.objects + ' objects with the same attempts and tasks per object: ' + fixed(row.projected.resolution) + ' and ' +
      fixed(row.projected.detectable) + (row.projected.detectable_range ? ' (' + fixed(row.projected.detectable_range[0]) + ' to ' + fixed(row.projected.detectable_range[1]) + ')' : '') + '.';
  }
  if (finite(row.attempt_share) && row.attempt_share >= 1) {
    text += ' Attempt noise alone accounts for all of that variance (its estimate is ' + Math.round(100 * row.attempt_share) + '% of it): beyond attempt noise, ' +
      'no object-to-object variation in the difference is measurable here, and more attempts per task would narrow the comparison.';
  } else if (finite(row.attempt_share)) {
    text += ' Attempt noise makes up about ' + Math.round(100 * row.attempt_share) + '% of that variance' +
      (row.without_attempt_noise ? '; with it averaged away the detectable difference would be ' + fixed(row.without_attempt_noise.at_objects) +
        (row.projected ? ' (' + fixed(row.without_attempt_noise.at_planned) + ' at ' + row.projected.objects + ' objects)' : '') : '') + '.';
  } else if (finite(row.attempt_share_at_least) && row.attempt_share_at_least >= 1) {
    text += ' The attempt noise of the configuration that ran tasks more than once already accounts for all of that variance (estimate ' +
      Math.round(100 * row.attempt_share_at_least) + '%); the other ran each task once, so its share cannot be estimated.';
  } else if (finite(row.attempt_share_at_least)) {
    text += ' Attempt noise makes up at least ' + Math.round(100 * row.attempt_share_at_least) + '% of that variance (only one of the two ran a task more than once).';
  } else text += ' How much of it is attempt noise cannot be estimated: neither configuration ran a task more than once.';
  return text;
}

function setVariance(ranked, cells, pairs, plannedObjects) {
  const configurations = ranked.map(entry => configurationVariance(entry, cells.get(entry.key)));
  const noise = new Map(configurations.map(item => [item.key, item.attempt_sd]));
  const pairRows = pairs.map(pair => pairVariance(pair, cells.get(pair.a), cells.get(pair.b), noise.get(pair.a), noise.get(pair.b), plannedObjects));
  // One sentence on where the noise is, from the medians across configurations and pairs.
  const all = pooledSD(ranked.flatMap(entry => [...taskScores(cells.get(entry.key)).values()].map(task => task.values)));
  const objectSD = median(configurations.map(item => item.object_sd.sd)), pairSD = median(pairRows.map(row => row.difference_sd.sd));
  const parts = [];
  if (finite(objectSD)) parts.push('scores of one configuration spread between objects with SD ' + fixed(objectSD) + ' (median over configurations)');
  if (finite(all.sd)) parts.push('between attempts on the same task with SD ' + fixed(all.sd) + ' (pooled, ' + all.df + ' degrees of freedom' + (all.df < LITTLE_DATA_DF ? ', little data' : '') + ')');
  if (finite(pairSD)) parts.push('the paired per-object difference between two configurations with SD ' + fixed(pairSD) + ' (median over pairs)');
  if (parts.length > 1) parts[parts.length - 1] = 'and ' + parts[parts.length - 1];
  const repeats = finite(all.sd) ? '' : ' No task was run more than once, so the noise between attempts cannot be separated from the rest: it is inside every number above.';
  return {
    planned_objects: plannedObjects, little_data_df: LITTLE_DATA_DF,
    attempt_sd_pooled: sdEntry(all.sd, all.df, { tasks: all.groups, basis: 'all configurations of the set pooled' }),
    configurations, pairs: pairRows,
    summary: parts.length ? 'In this set, ' + parts.join(', ') + '.' + repeats : null,
  };
}

// ------------------------------------------------------------- provenance

// Fields that must agree between the batches merged into one configuration, and
// between configurations compared within a set. A field nobody recorded is no
// disagreement (it shows as not recorded on the page); a field recorded for
// some batches and missing for others is one, since it usually means the
// batches came from different versions of the runner or scorer.
const CONFIGURATION_FIELDS = [
  ['cli_version', 'CLI version'], ['cli_sha256', 'CLI binary'], ['prompt_version', 'prompt version'], ['prompt_sha256', 'prompt hash'],
  ['runner_sha256', 'runner source'], ['tools_sha256', 'contestant tool kit'], ['runtime_sha256', 'three.js runtime'], ['protocol', 'protocol'],
  ['scorer_source', 'scorer source frozen in the manifest'],
];
const SET_FIELDS = [['tools_sha256', 'contestant tool kit'], ['protocol', 'protocol'], ['prompt_version', 'prompt version']];

// 'scorer' is the stamp each report carries (what actually computed the
// numbers, after any rescore); 'scorer_source' the runner's hash in the
// manifest. They are different hash schemes over the same code, so each is
// compared only with itself.
function batchValue(batch, field) {
  if (field === 'scorer') {
    const stamps = batch.scorer_sha256 ?? [];
    if (!stamps.length) return null;
    return stamps.join(',') + (batch.reports_unstamped ? ',' + batch.reports_unstamped + ' reports unstamped' : '');
  }
  if (field === 'scorer_source') return batch.manifest?.scorer_sha256 ?? null;
  if (field === 'report_protocol') return batch.report_protocols?.length ? batch.report_protocols.join(',') : null;
  const value = batch.manifest?.[field];
  return Array.isArray(value) ? (value.length ? value.join(',') : null) : value ?? null;
}

function disagreements(batches, fields) {
  const found = [];
  for (const [field, label] of fields) {
    const values = new Map(batches.map(batch => [batch.id, batchValue(batch, field)]));
    if (![...values.values()].some(value => value !== null)) continue;
    if (new Set(values.values()).size > 1) {
      found.push({ field, label, values: Object.fromEntries([...values].map(([batch, value]) => [batch, value ?? 'not recorded'])) });
    }
  }
  return found;
}

// --------------------------------------------------------------- leaderboard

// What the report knows about a set beyond its id: a note for known sets
// (dev), the set file and build record under the data root, and for tasks
// without a recorded set, which built sets list them.
function describeSet(id, taskIds, setFiles) {
  const file = setFiles?.get(id) ?? null;
  const listedIn = [...(setFiles?.values() ?? [])].filter(item => item.built_tasks.some(task => taskIds.has(task))).map(item => item.id).sort();
  const facts = file ? { file: file.file, private: file.private, created_at: file.created_at, built_at: file.built_at, objects_in_file: file.objects } : null;
  let kind, text;
  if (id === UNNAMED_SET) {
    kind = 'unnamed';
    text = 'The truth.json of these tasks records no set, so the report cannot tell development tasks from test tasks.' +
      (listedIn.length ? ' Their tasks are listed in the build record of set' + (listedIn.length > 1 ? 's ' : ' ') + listedIn.map(name => '"' + name + '"').join(', ') + '.' +
        (listedIn.some(name => SET_NOTES[name]) ? ' ' + listedIn.filter(name => SET_NOTES[name]).map(name => SET_NOTES[name]).join(' ') : '') : '');
  } else if (id === UNKNOWN_SET) {
    kind = 'unknown';
    text = 'These tasks have no readable truth.json, so their set is unknown; they are kept apart from every named set.';
  } else if (SET_NOTES[id]) {
    kind = 'development';
    text = SET_NOTES[id];
  } else {
    kind = 'named';
    text = 'Named set "' + id + '"' + (file?.private === true ? ', marked private in its set file (seeds not published)' : '') + '. ' +
      'If it was built after the scorer was frozen and never used to tune it, its numbers are test results; the report cannot verify either.';
  }
  // Development numbers are not test results: the dev set itself, or tasks
  // with no recorded set that the dev build record lists.
  const development = kind === 'development' || (kind === 'unnamed' && listedIn.some(name => SET_NOTES[name]));
  return { kind, development, text, listed_in: listedIn, ...(facts ? { set_file: facts } : {}) };
}

// `roster` (roster.mjs parseRoster / readRoster) names the formal
// configurations and their ladders; without one every configuration is formal
// and the ladders are inferred from the recorded effort.
export function buildLeaderboard(collected, { seed = 'e3d-leaderboard', now = new Date(), excludeStatuses = DEFAULT_EXCLUDED_STATUSES, plannedObjects = PLANNED_OBJECTS,
  roster = null } = {}) {
  // A roster read as plain JSON is validated here.
  if (roster && !(roster.keys instanceof Map)) roster = parseRoster(roster);
  const problems = [...(collected.problems ?? [])];
  const batchById = new Map((collected.batches ?? []).map(batch => [batch.id, batch]));
  // Attempts assembled by hand (tests, calibration) may carry no set or archetype.
  const all = collected.attempts.map(attempt => attempt.set && attempt.archetype ? attempt
    : { ...attempt, set: attempt.set || UNNAMED_SET, archetype: attempt.archetype || UNKNOWN_ARCHETYPE });
  const setIds = [...new Set(all.map(attempt => attempt.set))]
    .sort((p, q) => (p === UNKNOWN_SET) - (q === UNKNOWN_SET) || (p === UNNAMED_SET) - (q === UNNAMED_SET) || p.localeCompare(q));
  const entries = [], sets = [];
  for (const set of setIds) {
    const inSet = all.filter(attempt => attempt.set === set);
    const counted = inSet.filter(item => !item.excluded);
    const cells = new Map();
    for (const attempt of counted) {
      const key = cellKey(attempt);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(attempt);
    }
    // Breakdowns use what the set contains, so every configuration of the set
    // has the same columns (a configuration that ran none shows n/a).
    const deltaPairs = variantPairs([...new Set(counted.map(attempt => attempt.variant))]);
    const archetypeIds = [...new Set(counted.map(attempt => attempt.archetype))].sort((p, q) => (p === UNKNOWN_ARCHETYPE) - (q === UNKNOWN_ARCHETYPE) || p.localeCompare(q));
    const categoryIds = detailCategories(counted);
    const ranked = [...cells].map(([key, attempts]) => cellEntry(key, set, attempts, seed, { deltaPairs, archetypes: archetypeIds, categories: categoryIds }));
    ranked.sort((a, b) => (b.score.mean ?? -Infinity) - (a.score.mean ?? -Infinity) || a.key.localeCompare(b.key));
    // Formal configurations are ranked; reference rows (not in the roster) and
    // demoted ones keep their place in score order for the pairwise orientation
    // but get no rank.
    const placement = roster ? null : inferLadders(ranked.map(({ key, system, model, effort }) => ({ key, system, model, effort })));
    let rank = 0;
    for (const entry of ranked) {
      const listed = roster?.keys.get(entry.key);
      entry.reference = roster ? !listed : false;
      entry.demoted = listed?.demoted ?? null;
      entry.ladders = roster ? listed?.ladders ?? [] : placement.ladders.get(entry.key);
      entry.rank = entry.reference || entry.demoted ? null : ++rank;
    }
    for (const entry of ranked) {
      entry.provenance_conflicts = disagreements(entry.batches.map(id => batchById.get(id)).filter(Boolean),
        [...CONFIGURATION_FIELDS, ['scorer', 'scorer stamped in the reports'], ['report_protocol', 'report protocol']]);
      for (const conflict of entry.provenance_conflicts) {
        problems.push('set ' + set + ': ' + entry.key + ' merges batches that differ in ' + conflict.label + ': ' +
          Object.entries(conflict.values).map(([batch, value]) => batch + ' = ' + value).join('; '));
      }
    }
    // Configurations present in the set whose every attempt was excluded: no
    // rank and no score, but listed so they do not silently vanish.
    const unranked = [...new Set(inSet.filter(attempt => attempt.excluded).map(cellKey))].filter(key => !cells.has(key)).sort()
      .map(key => ({ key, excluded_attempts: inSet.filter(attempt => cellKey(attempt) === key).length }));

    // What the set asks of every formal configuration, and the real tier's
    // rule: a set of real-building tasks only (docs/V1-ROUND4-PLAN.md section 3).
    const ofSet = setTasks(set, inSet, collected.taskInfo), expected = owedTasks(ofSet, roster);
    const realTier = ofSet.size > 0 && [...ofSet.values()].every(task => variantFamily(task.variant) === 'real');
    // With a roster the families are frozen: once any roster configuration ran
    // in this set, every roster configuration belongs to it, present or not.
    const frozen = Boolean(roster) && ranked.some(entry => !entry.reference);
    const completeness = frozen ? roster.configurations.map(item => completenessOf(item, cells.get(item.key) ?? [], expected)) : [];
    const byKey = new Map(completeness.map(record => [record.key, record]));
    for (const record of completeness) checkCompleteness(record, { set, realTier, roster, problems });
    const absent = frozen ? roster.configurations.filter(item => !cells.has(item.key)).map(item => item.key) : [];
    const order = [...ranked.map(entry => entry.key), ...absent];
    const isReference = key => Boolean(roster) && !roster.keys.has(key);
    // Real tier: per configuration, the objects it completed (every task of the
    // object in the set sampled, whatever the roster requires).
    const objectTasks = new Map();
    for (const [task, info] of ofSet) {
      if (!objectTasks.has(info.object)) objectTasks.set(info.object, []);
      objectTasks.get(info.object).push(task);
    }
    const completed = new Map(order.map(key => {
      const sampled = new Set((cells.get(key) ?? []).map(attempt => attempt.task_id));
      return [key, new Set([...objectTasks].filter(([, tasks]) => tasks.every(task => sampled.has(task))).map(([object]) => object))];
    }));
    // Why a pair cannot be decided, in the order of INCOMPLETE_REASONS; null when it can.
    const incompleteReason = pair => {
      const records = [byKey.get(pair.a), byKey.get(pair.b)];
      if (records.some(record => record?.demoted)) return 'demoted';
      // The real tier's missing tasks only shrink its completed objects.
      if (!realTier && records.some(record => record?.missing.length)) return 'missing_tasks';
      if (records.some(record => record?.unlisted.length)) return 'unlisted_gaps';
      if (realTier && pair.objects < REAL_TIER_MIN_OBJECTS) return 'few_complete_objects';
      if (pair.objects < 2) return 'few_objects';
      if (!finite(pair.p_t)) return 'undefined_test';
      return null;
    };
    const pairs = [];
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const a = order[i], b = order[j];
        let attemptsA = cells.get(a) ?? [], attemptsB = cells.get(b) ?? [];
        const both = realTier ? new Set([...completed.get(a)].filter(object => completed.get(b).has(object))) : null;
        if (both) { attemptsA = attemptsA.filter(attempt => both.has(attempt.object)); attemptsB = attemptsB.filter(attempt => both.has(attempt.object)); }
        const pairSeed = seed + '/pairwise/' + (set === UNNAMED_SET ? '' : set + '/') + a + '|' + b;
        const pair = comparePair({ key: a, attempts: attemptsA }, { key: b, attempts: attemptsB }, { seed: pairSeed });
        pair.reference = isReference(a) || isReference(b);
        if (both) pair.complete_objects = both.size;
        const reason = incompleteReason(pair);
        pair.incomplete = null;
        if (reason) makeIncomplete(pair, reason, { intervals: reason !== 'few_complete_objects' });
        pairs.push(pair);
      }
    }
    // Holm over every pair of formal configurations (demoted and absent ones
    // included); a pair with a reference row keeps its uncorrected verdict and
    // belongs to no family.
    const formalPairs = pairs.filter(pair => !pair.reference);
    correctFamily(formalPairs, 'all').forEach((holm, index) => { formalPairs[index].holm = holm; formalPairs[index].statement += holmSentence(formalPairs[index]); });
    for (const pair of pairs) pair.holm ??= null;
    const correction = familySummary(formalPairs, 'all');
    const entryOf = new Map(ranked.map(entry => [entry.key, entry]));
    const { ladders, effort } = setLadders(order, entryOf, pairs, roster, cells);
    // Comparisons within a set are only fair if every configuration saw the
    // same tool kit and protocol and was scored by the same scorer.
    const setBatches = [...new Set(inSet.map(attempt => attempt.batch))].map(id => batchById.get(id)).filter(Boolean);
    const warnings = disagreements(setBatches, [...SET_FIELDS, ['scorer', 'scorer stamped in the reports'], ['report_protocol', 'report protocol']])
      .map(conflict => 'batches compared in this set differ in ' + conflict.label + ': ' +
        Object.entries(conflict.values).map(([batch, value]) => batch + ' = ' + value).join('; '));
    for (const warning of warnings) problems.push('set ' + set + ': ' + warning);
    const objectsByArchetype = archetypeIds.map(id => ({ id, objects: new Set(counted.filter(attempt => attempt.archetype === id).map(attempt => attempt.object)).size }));
    // Which objects have a scored group of each category depends on the
    // evidence, not on the contestant: counted from the valid reports.
    const objectsByCategory = categoryIds.map(id => ({ id,
      objects: new Set(counted.filter(attempt => attempt.valid && finite(categoryScore(attempt.report, id))).map(attempt => attempt.object)).size }));
    sets.push({
      id: set, named: set !== UNNAMED_SET && set !== UNKNOWN_SET,
      description: describeSet(set, new Set(inSet.map(attempt => attempt.task_id)), collected.setFiles),
      configurations: ranked.filter(entry => entry.rank !== null).map(entry => entry.key),
      demoted_configurations: ranked.filter(entry => entry.demoted && !entry.reference).map(entry => entry.key),
      reference_configurations: ranked.filter(entry => entry.reference).map(entry => entry.key),
      // Roster configurations with no counted attempt in this set: still in every family.
      absent_configurations: absent,
      tier: realTier ? 'real' : 'main',
      // Per roster configuration, what the set asked of it and what it lacks (null without a roster).
      completeness: frozen ? { expected_tasks: expected.size, required_variants: roster.required_variants, missing_share_limit: realTier ? null : MISSING_SHARE_LIMIT,
        configurations: completeness } : null,
      objects: new Set(inSet.map(attempt => attempt.object)).size,
      variants: VARIANT_ORDER.filter(variant => counted.some(attempt => attempt.variant === variant)),
      variant_pairs: deltaPairs.map(([high, low]) => high + '-' + low),
      archetypes: objectsByArchetype,
      detail_categories: objectsByCategory,
      tasks: new Set(inSet.map(attempt => attempt.task_id)).size,
      attempts: inSet.length, counted: inSet.filter(attempt => !attempt.excluded).length,
      batches: setBatches.map(batch => batch.id).sort(),
      first_started_at: inSet.map(attempt => attempt.started_at).filter(Boolean).sort()[0] ?? null,
      last_finished_at: inSet.map(attempt => attempt.finished_at).filter(Boolean).sort().at(-1) ?? null,
      unranked, warnings,
      tolerances: toleranceSummary(inSet.filter(attempt => !attempt.excluded)),
      ladder_rule: roster ? LADDER_RULE.roster : LADDER_RULE.inferred,
      ladder_notes: placement?.notes ?? [],
      ladders,
      effort,
      pairwise: {
        pairs,
        comparisons: pairs.length,
        correction,
        multiple_comparisons: pairs.length > 1
          ? pairs.length + ' pairs, each with its own 95% interval: if no configuration truly differed, the chance that at least one uncorrected interval ' +
            'would still exclude zero is about ' + Math.round(100 * (1 - 0.95 ** pairs.length)) + '% (1 - 0.95^' + pairs.length + ', for independent pairs). ' +
            'Holm\'s correction over the ' + correction.comparisons + ' pairs of formal configurations (family-wise ' + Math.round(100 * FAMILY_ALPHA) + '%' +
            (correction.incomplete ? '; ' + correction.incomplete + ' of them incomplete, entered with p = 1' : '') + ') keeps ' +
            correction.separated + ' of the ' + correction.separated_uncorrected + ' pairs separated without correction' +
            (pairs.length > formalPairs.length ? '; the ' + (pairs.length - formalPairs.length) + ' pairs with a reference row are not corrected.' : '.')
          : null,
      },
      // Only pairs of configurations with counted attempts carry a paired SD.
      variance: setVariance(ranked, cells, pairs.filter(pair => cells.has(pair.a) && cells.has(pair.b)), plannedObjects),
    });
    entries.push(...ranked.filter(entry => entry.rank !== null), ...ranked.filter(entry => entry.demoted && !entry.reference), ...ranked.filter(entry => entry.reference));
  }

  // A roster entry no batch ran is usually a misspelt system, model or effort.
  if (roster) {
    const ran = new Set(all.map(cellKey)), known = new Set([...all.map(attempt => attempt.task_id), ...(collected.taskInfo?.keys() ?? [])]);
    for (const item of roster.configurations) if (!ran.has(item.key)) problems.push('roster ' + (roster.file ?? '') + ' lists ' + item.key + ', which no attempt in these batches ran');
    // A missing task the report cannot place in a set is checked against nothing.
    const unplaced = [...new Set(rosterTasks(roster))].filter(task => !known.has(task)).sort();
    if (unplaced.length) problems.push('roster ' + (roster.file ?? '') + ' lists missing tasks that no batch planned and no truth.json places in a set: ' + firstFew(unplaced, 5));
  }
  const tasks = new Map();
  for (const attempt of all) {
    if (!tasks.has(attempt.task_id)) {
      tasks.set(attempt.task_id, { task_id: attempt.task_id, set: attempt.set, object: attempt.object, archetype: attempt.archetype, variant: attempt.variant,
        scale_evidence: attempt.scale_evidence, cells: {} });
    }
    const task = tasks.get(attempt.task_id), key = cellKey(attempt);
    task.cells[key] ??= { attempts: [], mean: null };
    task.cells[key].attempts.push({ batch: attempt.batch, attempt: attempt.attempt, status: attempt.status, excluded: attempt.excluded,
      valid: attempt.valid, score: attempt.excluded ? null : attempt.score, failure: attempt.failure });
  }
  for (const task of tasks.values()) {
    for (const cell of Object.values(task.cells)) {
      cell.attempts.sort((a, b) => a.batch.localeCompare(b.batch) || a.attempt - b.attempt);
      cell.mean = mean(cell.attempts.filter(attempt => !attempt.excluded).map(attempt => attempt.score));
    }
  }
  const variantRank = variant => VARIANT_ORDER.indexOf(variant);
  const tolerances = toleranceSummary(all.filter(attempt => !attempt.excluded));
  return {
    schema: LEADERBOARD_SCHEMA,
    protocol: PROTOCOL,
    generated_at: now.toISOString(),
    batches: collected.batches ?? [],
    roster: rosterProvenance(roster),
    method: {
      score: 'report.score as computed by the scorer: (shape_score + detail.score) / 2 (DESIGN.md section 9); attempts without a valid report count as 0',
      tolerances: 'tolerance rows reported: ' + (tolerances.fractions.length ? tolerances.fractions.map(fraction => fraction * 100 + '%').join(', ') : 'none') +
        '; rows named as entering shape_score: ' + (tolerances.shape_score_fractions ? tolerances.shape_score_fractions.map(fraction => fraction * 100 + '%').join(', ') || 'none' : 'not stated by the reports'),
      averaging: 'attempts are averaged within a task, tasks within an object, then objects are averaged; every object weighs the same however many attempts it has',
      ci95: 'percentile bootstrap over objects (' + BOOTSTRAP_SAMPLES + ' resamples, seeded with "' + seed + '"); null with fewer than 2 objects',
      pairwise: 'per pair, on the tasks both configurations ran: per-object mean score of A minus that of B; 95% percentile bootstrap over objects (' +
        PAIRWISE_SAMPLES + ' resamples, seeded) and a Student-t interval of the per-object differences; separated only when both exclude zero, unsettled when they disagree; ' +
        'share of resamples with A ahead; objects won / tied / lost. Intervals are not corrected for multiple comparisons; the corrected verdict is.',
      correction: 'Holm\'s step-down method at family-wise ' + Math.round(100 * FAMILY_ALPHA) + '% on the two-sided paired t p-value, within each family: all pairs of ' +
        'formal configurations of a set; the pairs of one ladder; the effort pairs (top minus default effort, same client and model). Separated after correction = ' +
        'Holm-adjusted p < ' + FAMILY_ALPHA + ' and separated uncorrected (bootstrap and Student-t 95% intervals both exclude zero). With a roster the families are ' +
        'fixed by it: every pair of roster configurations counts, demoted and absent ones included. A pair that cannot be decided is incomplete: no verdict, ' +
        'counted in m with p = 1 (' + Object.values(INCOMPLETE_REASONS).join('; ') + '). Pairs with a reference row are in no family',
      ladders: 'two system ladders (client + model + effort) per set: ' + LADDERS.map(ladder => ladder.id + ' (' + ladder.label.toLowerCase() + ')').join(' and ') + '; ' +
        (roster ? LADDER_RULE.roster : LADDER_RULE.inferred) + '; a ladder ranks its configurations by the same score as the leaderboard',
      sets: 'tasks are grouped by the optional `set` of their truth.json ("' + UNNAMED_SET + '" when absent, "' + UNKNOWN_SET +
        '" when truth.json is missing); results from different sets are never pooled',
      low_evidence: 'flagged when fewer than ' + LOW_EVIDENCE_OBJECTS + ' objects back the number',
      ladder: 'per object: mean score on the higher rung minus mean score on the lower rung; only objects with both rungs',
      evidence_deltas: 'every pair of variants of one family present in the set (generated t1-t4 and c1; memory m2, m3; real r2, r4), later minus earlier in ' +
        VARIANT_ORDER.join(' ') + ': per object, mean score on one minus mean score on the other; only objects with both; bootstrap and Student-t intervals over objects',
      archetypes: 'per archetype (objects/<id>/model.json): mean over that archetype\'s objects, same averaging as the score',
      diagnostics: 'valid attempts only, same averaging as the score. detail_categories: per category of report.detail.categories, 100 x the mean F of its groups. ' +
        'probe_error: per attempt, the median absolute error of the evidenced probes whose ray hit the submission (cm, and % of the truth diagonal), and the share ' +
        'of evidenced probes missed. probe_error, frame_error and scale_error_pct also give the median and interquartile range of the per-object values ' +
        '(a description of spread, not an interval)',
      variance: 'between attempts: pooled SD over tasks with >= 2 counted attempts; between objects: SD of per-object means; paired: SD of per-object differences, ' +
        'from which the half-width of the 95% t interval (resolution) and the true difference detected with 80% power by a two-sided 95% t test, ' +
        'also projected to ' + plannedObjects + ' objects; SD ranges are 95% chi-square intervals (normal noise assumed); fewer than ' + LITTLE_DATA_DF +
        ' degrees of freedom is marked as little data',
      conflict: 'c1 tasks: share of contested probes whose measurement is closer to the as-photographed state',
      memory: 'm2 / m3 tasks (named landmarks whose surveyed form differs from the published one): share of contested probes whose measurement is ' +
        'closer to the surveyed object the evidence shows than to the structure as published',
      time_curve: 'score over time from the runner\'s snapshots of output/model.glb (every interval seconds after the CLI started, scored after the attempt): ' +
        'at each tick an attempt counts its final score once it has ended, else the score of the last snapshot it had taken by then (0 with no or an invalid model, and at every tick with integrity problems; ' +
        'a snapshot counts from its tick when read within ' + ON_TIME_SECONDS + ' s of it, else from the end of its read, and is counted as late; ' +
        'left out of the tick and counted as missing when the scorer failed on that snapshot, also on the runner\'s retries, or the runner could not store it); ' +
        'same averaging and bootstrap as the score, so the point at the wall-clock limit is the score. Time to ' + T95_SHARE * 100 + '%: per attempt with a final score of at least ' +
        T95_MIN_FINAL + ', when its first snapshot at ' + T95_SHARE * 100 + '% of its final score counts from (as above), else its end; median over attempts. ' +
        'Only for configurations whose every counted attempt has snapshots',
      excluded_statuses: excludeStatuses,
    },
    tolerances,
    sets,
    entries,
    tasks: [...tasks.values()].sort((a, b) => setIds.indexOf(a.set) - setIds.indexOf(b.set) || a.object.localeCompare(b.object) ||
      variantRank(a.variant) - variantRank(b.variant) || a.task_id.localeCompare(b.task_id)),
    excluded: all.filter(attempt => attempt.excluded)
      .map(attempt => ({ batch: attempt.batch, set: attempt.set, task_id: attempt.task_id, attempt: attempt.attempt, cell: cellKey(attempt), status: attempt.status,
        reason: attempt.status_reason ?? null })),
    problems: [...new Set(problems)],
  };
}

export const reportName = batches => (batches?.length ? batches.join('+') : 'all-batches').replace(/[^A-Za-z0-9._+-]/g, '_').slice(0, 120);

// -> leaderboard object. Also written as JSON to `outFile`, by default
// <data>/reports/<batches>/leaderboard.json; outFile: null writes nothing.
// The tasks a roster lists as missing, so the report can place them in their sets.
export const rosterTasks = roster => roster ? roster.configurations.flatMap(item => (item.missing_tasks ?? []).map(gap => gap.task)) : [];

export async function aggregate({ dataRoot, batches, outFile, seed, now, excludeStatuses = DEFAULT_EXCLUDED_STATUSES, plannedObjects, roster } = {}) {
  if (roster && !(roster.keys instanceof Map)) roster = parseRoster(roster);
  const collected = await collectRuns({ dataRoot, batches, excludeStatuses, alsoTasks: rosterTasks(roster) });
  const board = buildLeaderboard(collected, { seed, now, excludeStatuses, plannedObjects, roster });
  const target = outFile === undefined ? join(layout(resolve(dataRoot)).reports, reportName(batches), 'leaderboard.json') : outFile;
  if (target) await writeJSON(target, board);
  return board;
}

export { scorerIdentity };
