import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { rng } from '../rng.mjs';
import { finite } from './stats.mjs';
import { scorerVersion } from './collect.mjs';
import { rosterPath } from './roster.mjs';
import { TIE_GAP, scoreGap } from '../study/panel.mjs';
import { STRATA } from '../study/select.mjs';
import { CURVE_SCHEMA, CURVE_REASONS, INTERVAL_REASONS, OUTCOMES, SHARES, binOf, binShares, curveClusters, curveSampler, curveScorer, halfWinAt, shareInterval } from '../study/curve.mjs';

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

const count = value => Number.isInteger(value) && value >= 0;
const isProportion = value => finite(value) && value >= 0 && value <= 1;

// Refuses a curve file that does not hold together, so that the page, the
// Markdown and the column never meet a missing number: its scorer must be a
// candidate of section 5.2, its tie gap G1's, its bins the study's strata
// merged and covering the whole gap scale [0, 100], and its pair rows must
// reproduce every bin's counts, objects, mean gap and shares; each share
// carries a finite value and either an interval within [0, 1] or a known
// reason for having none.
export function parseHumanCurve(data, { file = null, sha256 = null } = {}) {
  const where = 'human curve' + (file ? ' ' + file : ''), fail = message => { throw new Error(where + ': ' + message); };
  if (!data || typeof data !== 'object' || data.schema !== CURVE_SCHEMA) fail('schema must be ' + CURVE_SCHEMA);
  if (typeof data.available !== 'boolean') fail('no "available"');
  if (!data.scorer || typeof data.scorer.version !== 'string') fail('no scorer version');
  let scorer;
  try { scorer = curveScorer(data.scorer.weights ?? null); } catch { fail('its weights are not a candidate of section 5.2'); }
  if (scorer.version !== data.scorer.version) fail('scorer ' + data.scorer.version + ' does not go with weights ' + (scorer.weights?.id ?? '50/50'));
  if (data.tie_gap !== TIE_GAP) fail('its tie gap must be ' + TIE_GAP);
  if (!Array.isArray(data.skipped_variants) || !data.skipped_variants.every(variant => typeof variant === 'string')) fail('no skipped_variants');
  const panel = data.panel;
  if (!panel || !Array.isArray(panel.raters) || !panel.raters.every(rater => typeof rater === 'string') || panel.size !== panel.raters.length ||
    new Set(panel.raters).size !== panel.raters.length || !Array.isArray(panel.considered)) fail('the panel must list its raters, each once');
  if (data.equal !== undefined && !(data.equal && count(data.equal.pairs) && ['a', 'tie', 'b'].every(choice => count(data.equal.panel?.[choice])) &&
    data.equal.panel.a + data.equal.panel.tie + data.equal.panel.b === data.equal.pairs)) fail('its equal-score tally does not add up');
  if (!Array.isArray(data.notes) || !data.notes.every(note => typeof note === 'string')) fail('no notes');
  if (!data.available) {
    if (!(data.reason in CURVE_REASONS)) fail('unavailable without a known reason');
    return { ...data, file, sha256, clusters: null, half_win: null };
  }
  const bins = data.bins, last = STRATA[STRATA.length - 1].max;
  if (!Array.isArray(bins) || bins.length < 2) fail('needs two bins or more');
  bins.forEach((bin, k) => {
    if (!finite(bin?.min) || !finite(bin.max) || !(bin.max > bin.min) || (k === 0 ? bin.min !== 0 : bin.min !== bins[k - 1].max)) fail('bin ' + k + ' does not continue the bins before it');
    const strata = STRATA.filter(stratum => stratum.min >= bin.min && stratum.max <= bin.max);
    if (!strata.length || strata[0].min !== bin.min || strata[strata.length - 1].max !== bin.max || JSON.stringify(bin.strata) !== JSON.stringify(strata.map(stratum => stratum.id))) {
      fail('bin ' + k + ' is not a run of the study\'s strata');
    }
  });
  if (bins[bins.length - 1].max !== last) fail('its bins must cover the gap scale up to ' + last);
  if (!Array.isArray(data.pairs) || !data.pairs.every(pair => pair && typeof pair.object === 'string' && Number.isInteger(pair.bin) && pair.bin >= 0 && pair.bin < bins.length &&
    OUTCOMES.includes(pair.outcome) && finite(pair.gap) && pair.gap >= TIE_GAP && binOf(pair.gap, bins) === pair.bin && bins[pair.bin].strata.includes(pair.stratum))) {
    fail('pairs must name their object, their gap (in their bin and stratum) and outcome');
  }
  const clusters = curveClusters(data.pairs, bins.length);
  const totals = new Float64Array(3 * bins.length);
  for (const row of clusters) row.forEach((value, j) => { totals[j] += value; });
  bins.forEach((bin, k) => {
    const inBin = data.pairs.filter(pair => pair.bin === k), shares = binShares(totals, k);
    if (!shares || bin.pairs !== inBin.length || bin.objects !== new Set(inBin.map(pair => pair.object)).size ||
      !(Math.abs(bin.mean_gap - inBin.reduce((sum, pair) => sum + pair.gap, 0) / inBin.length) <= 1e-9) ||
      !OUTCOMES.every((outcome, j) => bin.counts?.[outcome] === totals[3 * k + j])) fail('bin ' + k + ' does not match its pairs');
    for (const share of SHARES) {
      const stated = bin.shares?.[share];
      if (!stated || !finite(stated.value) || !(Math.abs(shares[share] - stated.value) <= 1e-12)) fail('bin ' + k + ' ' + share + ' does not match its pairs');
      const interval = stated.ci95 === null ? stated.interval in INTERVAL_REASONS
        : Array.isArray(stated.ci95) && stated.ci95.length === 2 && stated.ci95.every(isProportion) && stated.ci95[0] <= stated.ci95[1] && stated.interval === null;
      if (!interval) fail('bin ' + k + ' ' + share + ' needs an interval within [0, 1] or a reason for none');
    }
  });
  const b = data.bootstrap;
  if (!b || !count(b.clusters) || b.clusters !== clusters.length || !count(b.resamples) || !count(b.redrawn) || !count(data.min_bin_pairs)) fail('no bootstrap record');
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

// Sums of 1 / n over attempt pairs drift by a few ulps (three attempts a side
// that all win give 1.0000000000000002). The column is settled to 1e-12, far
// below anything it shows, so that a value of 0 or 1, 1 - x and a constant
// resample are exact before the rules of section 4 look at them.
const settle = value => Math.min(1, Math.max(0, Math.round(value * 1e12) / 1e12));

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
  const value = settle(valueOf(observedSums, curve.half_win, rows.length));
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
    values.push(settle(valueOf(sums, W, rows.length)));
  }
  const share = shareInterval(value, Float64Array.from(values).sort(), { level });
  return { win_rate_a: value, ci95: share.ci95, interval: share.interval, samples: values.length, ...coverage };
}

// The same column read the other way round (B's half-score win rate).
export const flipHuman = human => human ? { ...human, win_rate_a: finite(human.win_rate_a) ? settle(1 - human.win_rate_a) : human.win_rate_a,
  ci95: human.ci95 ? [settle(1 - human.ci95[1]), settle(1 - human.ci95[0])] : null } : human ?? null;

export const humanIntervalReason = reason => INTERVAL_REASONS[reason] ?? reason;
