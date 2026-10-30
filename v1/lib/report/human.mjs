import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { rng } from '../rng.mjs';
import { finite } from './stats.mjs';
import { scorerVersion } from './collect.mjs';
import { rosterPath } from './roster.mjs';
import { TIE_GAP, scoreGap } from '../study/panel.mjs';
import { CURVE_SCHEMA, CURVE_REASONS, INTERVAL_REASONS, OUTCOMES, SHARES, binOf, binShares, curveClusters, curveSampler, halfWinAt, shareInterval } from '../study/curve.mjs';

// The human curve in the results report (docs/V1-ROUND4-PLAN.md section 6).
// The curve itself is the study's (study/curve.mjs, `study.mjs curve`); the
// report reads it with --human-curve, prints it, and adds to every pairwise
// comparison the column "panel half-score win rate of A":
//
// - Tasks: those both configurations ran where both delivered a model the
//   curve applies to, under the study's own conditions (counted, valid report
//   with a finite score, a model file, not a t1 task; collect.mjs already
//   makes an attempt with integrity problems invalid). A task where either
//   side failed, scored 0 for integrity or has no sample is left out; the
//   column says what share of the pair's tasks it covers.
// - Per task, the gap g between A's and B's score is looked up in the bin of
//   |g|: W when A scored higher, 1 - W when B did, 0.5 when the scores are
//   equal in the curve's sense (|g| < TIE_GAP: such pairs have no higher side
//   and no bin of their own). With several attempts per task every pair of
//   A's and B's eligible attempts counts once (the curve was measured on
//   single submissions), averaged within the task. Then tasks are averaged
//   within an object and objects over the pair.
// - Interval: a two-level bootstrap. Each of HUMAN_SAMPLES resamples draws,
//   independently, the study's objects (the curve's W per bin recomputed from
//   the drawn pairs, the bins and weights as they are) and the pair's
//   objects, then recomputes the column; percentiles 2.5 and 97.5. Fewer than
//   `minObjects` objects (2; 8 in the real tier), a value of exactly 0 or 1,
//   or the same value in every resample: no interval.

export const HUMAN_SAMPLES = 10000;
export const HUMAN_LEVEL = 0.95;

// Refuses a curve file that does not hold together: its bins must tile the
// gap scale and its pairs reproduce the shares it states.
export function parseHumanCurve(data, { file = null, sha256 = null } = {}) {
  const where = 'human curve' + (file ? ' ' + file : '');
  if (!data || typeof data !== 'object' || data.schema !== CURVE_SCHEMA) throw new Error(where + ': schema must be ' + CURVE_SCHEMA);
  if (typeof data.available !== 'boolean') throw new Error(where + ': no "available"');
  if (!data.scorer || typeof data.scorer.version !== 'string') throw new Error(where + ': no scorer version');
  if (!Array.isArray(data.skipped_variants)) throw new Error(where + ': no skipped_variants');
  if (!data.available) {
    if (!(data.reason in CURVE_REASONS)) throw new Error(where + ': unavailable without a known reason');
    return { ...data, file, sha256, clusters: null, half_win: null };
  }
  const bins = data.bins;
  if (!Array.isArray(bins) || bins.length < 2) throw new Error(where + ': needs two bins or more');
  bins.forEach((bin, k) => {
    if (!finite(bin.min) || !finite(bin.max) || !(bin.max > bin.min) || (k === 0 ? bin.min !== 0 : bin.min !== bins[k - 1].max)) {
      throw new Error(where + ': bin ' + k + ' does not continue the bins before it');
    }
  });
  if (!Array.isArray(data.pairs) || !data.pairs.every(pair => typeof pair.object === 'string' && Number.isInteger(pair.bin) && pair.bin >= 0 && pair.bin < bins.length &&
    OUTCOMES.includes(pair.outcome))) throw new Error(where + ': pairs must name their object, bin and outcome');
  const clusters = curveClusters(data.pairs, bins.length);
  const totals = new Float64Array(3 * bins.length);
  for (const row of clusters) row.forEach((value, j) => { totals[j] += value; });
  bins.forEach((bin, k) => {
    const shares = binShares(totals, k);
    for (const share of SHARES) {
      if (!shares || Math.abs(shares[share] - bin.shares?.[share]?.value) > 1e-12) throw new Error(where + ': bin ' + k + ' ' + share + ' does not match its pairs');
    }
  });
  return { ...data, file, sha256, clusters, half_win: Float64Array.from(bins, (_, k) => halfWinAt(totals, k)) };
}

export async function readHumanCurve(file) {
  const bytes = await readFile(file), shown = rosterPath(file);
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); } catch (error) { throw new Error('human curve ' + shown + ': ' + error.message); }
  return parseHumanCurve(data, { file: shown, sha256: createHash('sha256').update(bytes).digest('hex') });
}

// What the leaderboard records of the curve: everything but its pairs.
export const humanCurveProvenance = curve => curve ? {
  file: curve.file, sha256: curve.sha256, schema: curve.schema, study: curve.study ?? null, scorer: curve.scorer, available: curve.available, reason: curve.reason ?? null,
  panel: curve.panel, tie_gap: curve.tie_gap, min_bin_pairs: curve.min_bin_pairs, seed: curve.seed, samples: curve.samples, skipped_variants: curve.skipped_variants,
  originals: curve.originals ?? null, binned: curve.binned ?? null, stratum_pairs: curve.stratum_pairs ?? null,
  equal: curve.equal ? { pairs: curve.equal.pairs, panel: curve.equal.panel } : null,
  bins: curve.bins ?? null, bootstrap: curve.bootstrap ?? null, notes: curve.notes ?? [],
} : null;

// An attempt whose model the curve applies to: the study's conditions.
export const humanEligible = (attempt, curve) => !attempt.excluded && attempt.valid === true && finite(attempt.score) && Boolean(attempt.model_path) &&
  !curve.skipped_variants.includes(attempt.variant);

// Whether the curve applies to a set's scores: every eligible attempt was
// scored by the curve's scorer version (its weights define the curve's gaps).
// -> { available, reason, versions }.
export function humanApplies(curve, attempts) {
  if (!curve) return null;
  if (!curve.available) return { available: false, reason: curve.reason, versions: [] };
  const versions = [...new Set(attempts.filter(attempt => humanEligible(attempt, curve)).map(attempt => scorerVersion(attempt.report) ?? 'unstamped'))].sort();
  const other = versions.filter(version => version !== curve.scorer.version);
  return other.length ? { available: false, reason: 'scorer', versions } : { available: true, reason: null, versions };
}

export const HUMAN_REASONS = { ...CURVE_REASONS, scorer: 'the reports were not all scored by the scorer the curve was made for' };

// The column for one pair: A's and B's counted attempts on the objects the
// pair is compared on.
export function panelWinRate(attemptsA, attemptsB, curve, { seed = 'e3d-human', samples = HUMAN_SAMPLES, level = HUMAN_LEVEL, minObjects = 2, fewReason = 'few_objects' } = {}) {
  const K = curve.bins.length;
  const tasksOf = attempts => {
    const tasks = new Map();
    for (const attempt of attempts) {
      if (attempt.excluded) continue;
      if (!tasks.has(attempt.task_id)) tasks.set(attempt.task_id, { object: attempt.object, eligible: [] });
      if (humanEligible(attempt, curve)) tasks.get(attempt.task_id).eligible.push(attempt.score);
    }
    return tasks;
  };
  const tasksA = tasksOf(attemptsA), tasksB = tasksOf(attemptsB);
  // Per task: the column as beta + alpha · W, averaged over the attempt pairs.
  const objects = new Map();
  let paired = 0, covered = 0, attemptPairs = 0, equal = 0;
  for (const [task, a] of tasksA) {
    const b = tasksB.get(task);
    if (!b) continue;
    paired++;
    if (!a.eligible.length || !b.eligible.length) continue;
    covered++;
    const row = new Float64Array(K + 1), n = a.eligible.length * b.eligible.length;
    for (const x of a.eligible) for (const y of b.eligible) {
      attemptPairs++;
      const gap = scoreGap(x, y);
      if (gap < TIE_GAP) { row[K] += 0.5 / n; equal++; continue; }
      const k = binOf(gap, curve.bins);
      if (k < 0) throw new Error('task ' + task + ': gap ' + gap + ' is outside the curve\'s bins');
      if (x > y) row[k] += 1 / n;
      else { row[K] += 1 / n; row[k] -= 1 / n; }
    }
    if (!objects.has(a.object)) objects.set(a.object, []);
    objects.get(a.object).push(row);
  }
  const rows = [...objects].sort(([p], [q]) => p.localeCompare(q)).map(([, list]) => {
    const row = new Float64Array(K + 1);
    for (const item of list) item.forEach((value, j) => { row[j] += value / list.length; });
    return row;
  });
  const coverage = { tasks: covered, tasks_paired: paired, share: paired ? covered / paired : null, objects: rows.length, attempt_pairs: attemptPairs, equal_scores: equal };
  if (!rows.length) return { win_rate_a: null, ci95: null, interval: 'no_value', samples: 0, ...coverage };
  const valueOf = (sums, W, count) => { let value = sums[K]; for (let k = 0; k < K; k++) value += sums[k] * W[k]; return value / count; };
  const observedSums = new Float64Array(K + 1);
  for (const row of rows) row.forEach((value, j) => { observedSums[j] += value; });
  const value = valueOf(observedSums, curve.half_win, rows.length);
  if (rows.length < minObjects) return { win_rate_a: value, ci95: null, interval: value === 0 || value === 1 ? 'boundary' : fewReason, samples: 0, ...coverage };

  const random = rng(seed), sampler = curveSampler(curve.clusters, K, random.fork('study objects'), { samples }), draws = random.fork('objects');
  const W = new Float64Array(K), sums = new Float64Array(K + 1), values = [];
  for (let b = 0; b < samples; b++) {
    const totals = sampler.draw();
    if (!totals) { values.length = 0; break; }
    for (let k = 0; k < K; k++) W[k] = halfWinAt(totals, k);
    sums.fill(0);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[Math.floor(draws.next() * rows.length)];
      for (let j = 0; j <= K; j++) sums[j] += row[j];
    }
    values.push(valueOf(sums, W, rows.length));
  }
  const share = shareInterval(value, Float64Array.from(values).sort(), { level });
  return { win_rate_a: value, ci95: share.ci95, interval: share.interval, samples: values.length, ...coverage };
}

// The same column read the other way round (B's half-score win rate).
export const flipHuman = human => human ? { ...human, win_rate_a: finite(human.win_rate_a) ? 1 - human.win_rate_a : human.win_rate_a,
  ci95: human.ci95 ? [1 - human.ci95[1], 1 - human.ci95[0]] : null } : human ?? null;

export const humanIntervalReason = reason => INTERVAL_REASONS[reason] ?? reason;
