import { join, resolve } from 'node:path';
import { writeJSON } from '../../../lib/io.mjs';
import { layout, VARIANTS, PROTOCOL } from '../contract.mjs';
import { collectRuns, DEFAULT_EXCLUDED_STATUSES } from './collect.mjs';
import { finite, mean, median, summarise, BOOTSTRAP_SAMPLES, LOW_EVIDENCE_OBJECTS } from './stats.mjs';

export const LEADERBOARD_SCHEMA = 'e3d-leaderboard-v1';
export const VARIANT_ORDER = Object.keys(VARIANTS);
// Each rung adds one kind of evidence; deltas are paired by object.
export const LADDER = [['t2', 't1'], ['t3', 't2'], ['t4', 't3']];

export const cellKey = attempt => [attempt.system, attempt.model, attempt.effort ?? '-'].join(' / ');

// Share of contested probes on which the candidate sided with the primary
// (as-photographed) state, over all alternates of one report.
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

// Per-object values of a metric: attempts are averaged within a task, tasks
// within an object. valueOf returning a non-number leaves the attempt out.
function perObject(attempts, valueOf, filter = () => true) {
  const tasks = new Map();
  let used = 0;
  for (const attempt of attempts) {
    if (!filter(attempt)) continue;
    const value = valueOf(attempt);
    if (!finite(value)) continue;
    used++;
    if (!tasks.has(attempt.task_id)) tasks.set(attempt.task_id, { object: attempt.object, values: [] });
    tasks.get(attempt.task_id).values.push(value);
  }
  const objects = new Map();
  for (const { object, values } of tasks.values()) {
    if (!objects.has(object)) objects.set(object, []);
    objects.get(object).push(mean(values));
  }
  return { values: new Map([...objects].map(([object, means]) => [object, mean(means)])), attempts: used, tasks: tasks.size };
}

function cellEntry(key, attempts, seed) {
  const first = attempts[0], seedFor = metric => seed + '/' + key + '/' + metric;
  const metric = (name, valueOf, filter, basis) => {
    const { values, attempts: used, tasks } = perObject(attempts, valueOf, filter);
    return summarise(values, { seed: seedFor(name), attempts: used, tasks, basis });
  };
  const variants = {};
  for (const variant of VARIANT_ORDER) {
    if (!attempts.some(attempt => attempt.variant === variant)) continue;
    variants[variant] = metric('variant/' + variant, attempt => attempt.score, attempt => attempt.variant === variant, 'all attempts; failures count as 0');
  }
  const ladder = {};
  for (const [high, low] of LADDER) {
    const upper = perObject(attempts, attempt => attempt.score, attempt => attempt.variant === high).values;
    const lower = perObject(attempts, attempt => attempt.score, attempt => attempt.variant === low).values;
    const deltas = new Map();
    for (const [object, value] of upper) if (lower.has(object)) deltas.set(object, value - lower.get(object));
    ladder[high + '-' + low] = { ...summarise(deltas, { seed: seedFor('ladder/' + high + '-' + low), basis: 'paired by object; failures count as 0' }),
      pairs: deltas.size, unpaired_objects: new Set([...upper.keys(), ...lower.keys()]).size - deltas.size };
  }
  const conflictAttempts = attempts.filter(attempt => attempt.variant === 'c1');
  const conflict = {
    ...metric('conflict', attempt => attempt.valid ? conflictShare(attempt.report) : undefined, attempt => attempt.variant === 'c1',
      'valid c1 attempts; share of contested probes closer to the primary (as photographed) state'),
    probes: conflictCounts(conflictAttempts),
    c1_attempts: conflictAttempts.length,
    failed_attempts: conflictAttempts.filter(attempt => !attempt.valid).length,
  };
  const frameError = attempt => attempt.valid ? attempt.report.alignment?.frame_error : undefined;
  const statuses = {};
  for (const attempt of attempts) statuses[attempt.status] = (statuses[attempt.status] ?? 0) + 1;
  const valid = attempts.filter(attempt => attempt.valid).length;
  const walls = attempts.map(attempt => attempt.wall_seconds).filter(finite);
  const usages = attempts.map(attempt => attempt.usage).filter(Boolean);
  const totals = usages.map(usage => usage.total).filter(finite);
  const costs = attempts.map(attempt => attempt.cost_usd).filter(finite);
  return {
    key, system: first.system, model: first.model, effort: first.effort,
    attempts: attempts.length,
    tasks: new Set(attempts.map(attempt => attempt.task_id)).size,
    objects: new Set(attempts.map(attempt => attempt.object)).size,
    low_evidence: new Set(attempts.map(attempt => attempt.object)).size < LOW_EVIDENCE_OBJECTS,
    score: metric('score', attempt => attempt.score, undefined, 'all attempts; failures count as 0'),
    variants,
    ladder,
    conflict,
    shape: metric('shape', attempt => attempt.valid ? attempt.report.shape_score : 0, undefined,
      'all attempts; failures count as 0; mean of F@1%, F@2%, F@5%'),
    detail: metric('detail', attempt => attempt.valid ? attempt.report.detail?.score : 0, undefined,
      'all attempts; failures count as 0; valid reports without a detail score are left out'),
    frame_error: {
      offset_fraction: metric('frame/offset_fraction', attempt => frameError(attempt)?.offset_fraction, undefined, 'valid attempts only; fraction of the truth diagonal'),
      offset_m: metric('frame/offset_m', attempt => frameError(attempt)?.offset_m, undefined, 'valid attempts only'),
      yaw_deg: metric('frame/yaw_deg', attempt => finite(frameError(attempt)?.yaw_deg) ? Math.abs(frameError(attempt).yaw_deg) : undefined, undefined, 'valid attempts only; absolute degrees'),
    },
    scale_error_pct: metric('scale', attempt => attempt.valid && finite(attempt.report.shape?.scale) ? Math.abs(attempt.report.shape.scale - 1) * 100 : undefined,
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
  };
}

export function buildLeaderboard(collected, { seed = 'e3d-leaderboard', now = new Date(), excludeStatuses = DEFAULT_EXCLUDED_STATUSES } = {}) {
  const counted = collected.attempts.filter(attempt => !attempt.excluded);
  const cells = new Map();
  for (const attempt of counted) {
    const key = cellKey(attempt);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(attempt);
  }
  const entries = [...cells].map(([key, attempts]) => cellEntry(key, attempts, seed));
  entries.sort((a, b) => (b.score.mean ?? -Infinity) - (a.score.mean ?? -Infinity) || a.key.localeCompare(b.key));
  const tasks = new Map();
  for (const attempt of collected.attempts) {
    if (!tasks.has(attempt.task_id)) {
      tasks.set(attempt.task_id, { task_id: attempt.task_id, object: attempt.object, variant: attempt.variant, scale_evidence: attempt.scale_evidence, cells: {} });
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
  return {
    schema: LEADERBOARD_SCHEMA,
    protocol: PROTOCOL,
    generated_at: now.toISOString(),
    batches: collected.batches.map(batch => ({ id: batch.id, attempts: batch.attempts, summary: batch.summary })),
    method: {
      score: 'mean of report.score = (shape_score + detail.score) / 2, where shape_score = 100 x mean of F@1%, F@2%, F@5%; attempts without a valid report count as 0',
      averaging: 'attempts are averaged within a task, tasks within an object, then objects are averaged; every object weighs the same',
      ci95: 'percentile bootstrap over objects (' + BOOTSTRAP_SAMPLES + ' resamples, seeded with "' + seed + '"); null with fewer than 2 objects',
      low_evidence: 'flagged when fewer than ' + LOW_EVIDENCE_OBJECTS + ' objects back the number',
      ladder: 'per object: mean score on the higher rung minus mean score on the lower rung; only objects with both rungs',
      conflict: 'c1 tasks: share of contested probes whose measurement is closer to the as-photographed state',
      excluded_statuses: excludeStatuses,
    },
    entries,
    tasks: [...tasks.values()].sort((a, b) => a.object.localeCompare(b.object) || variantRank(a.variant) - variantRank(b.variant) || a.task_id.localeCompare(b.task_id)),
    excluded: collected.attempts.filter(attempt => attempt.excluded)
      .map(attempt => ({ batch: attempt.batch, task_id: attempt.task_id, attempt: attempt.attempt, cell: cellKey(attempt), status: attempt.status })),
    problems: collected.problems,
  };
}

export const reportName = batches => (batches?.length ? batches.join('+') : 'all-batches').replace(/[^A-Za-z0-9._+-]/g, '_').slice(0, 120);

// -> leaderboard object. Also written as JSON to `outFile`, by default
// <data>/reports/<batches>/leaderboard.json; outFile: null writes nothing.
export async function aggregate({ dataRoot, batches, outFile, seed, now, excludeStatuses = DEFAULT_EXCLUDED_STATUSES } = {}) {
  const collected = await collectRuns({ dataRoot, batches, excludeStatuses });
  const board = buildLeaderboard(collected, { seed, now, excludeStatuses });
  const target = outFile === undefined ? join(layout(resolve(dataRoot)).reports, reportName(batches), 'leaderboard.json') : outFile;
  if (target) await writeJSON(target, board);
  return board;
}
