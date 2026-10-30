import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rng } from '../rng.mjs';
import { quantile } from '../report/stats.mjs';
import { STRATA, stratumOf } from './select.mjs';
import { CATEGORIES } from './kappa.mjs';
import { readVoteFiles } from './votes.mjs';
import { LEGACY_RATER } from './page/state.js';

// The rating panel of the Round 4 plan (docs/V1-ROUND4-PLAN.md) and what gate
// G1 and the human curve share: which pairs are originals, each rater's last
// vote, whether a rater qualifies (section 5.1), the panel's decision on a pair
// (section 5.1), a submission's headline score under other weights and the
// tie threshold (section 5.2), and the bootstrap over objects with its edge
// cases (section 4, "区间算法").

// Two headline scores closer than this are level (sections 5.2 and 6).
export const TIE_GAP = 0.05;
// Section 4: 10 000 resamples of the objects, 2.5 % and 97.5 % quantiles.
export const BOOTSTRAP_RESAMPLES = 10000;
// Section 5.2: the candidate weights of the headline score. 50/50 is scorer 1.1.0.
export const CANDIDATE_WEIGHTS = Object.freeze([
  Object.freeze({ id: '50/50', shape: 0.5, detail: 0.5 }),
  Object.freeze({ id: '65/35', shape: 0.65, detail: 0.35 }),
  Object.freeze({ id: '35/65', shape: 0.35, detail: 0.65 }),
]);
export const CURRENT_SCORER = '1.1.0';
export const NEXT_SCORER = '1.2.0';
// Section 5.1: at least 7 of the 10 repeats the same choice (a "cannot tell"
// both times counts), at least 5 of the 6 catch pairs right ("cannot tell" is
// wrong). With another number of repeats or catch pairs the same shares apply.
export const QUALIFICATION = Object.freeze({ repeats: Object.freeze([7, 10]), catch: Object.freeze([5, 6]) });

const finite = value => typeof value === 'number' && Number.isFinite(value);
const required = (n, [k, of]) => Math.ceil(k * n / of);

// A catch pair (rater qualification) or a repeat (self-consistency) is not an
// original: neither counts in G1, the human curve or any agreement.
export const isCatch = pair => Boolean(pair?.catch);
export const isRepeat = pair => Boolean(pair?.repeat_of);
export const isOriginal = pair => !isRepeat(pair) && !isCatch(pair);

// |a - b| with the floating-point noise of the subtraction removed (scores have
// at most four decimals): 70.15 - 70.10 is 0.05, not 0.05000000000001.
export const scoreGap = (a, b) => Math.round(Math.abs(a - b) * 1e6) / 1e6;

// A submission's headline score (0-100) under `weights` ({ shape, detail }),
// rounded to two decimals as the scorer rounds it; shape alone when the
// evidence scored no detail (detail_score null), as the scorer does. null
// weights: the score key.json holds (scorer 1.1.0). null when a half is missing.
export function weightedScore(side, weights = null) {
  if (!weights) return finite(side?.score) ? side.score : null;
  const shape = side?.shape_score, detail = side?.detail_score;
  if (!finite(shape)) return null;
  if (detail === null || detail === undefined) return shape;
  if (!finite(detail)) return null;
  return Number((weights.shape * shape + weights.detail * detail).toFixed(2));
}

export function weightedGap(pair, weights = null) {
  const a = weightedScore(pair.a, weights), b = weightedScore(pair.b, weights);
  return a === null || b === null ? null : scoreGap(a, b);
}

// A pair under `weights`: both scores, the gap, the higher side ('tie' below
// TIE_GAP) and the stratum of the gap (section 5.2 "若改": the study's higher
// side, gap and stratum under new weights; choices and votes do not change).
export function rescorePair(pair, weights = null, strata = STRATA) {
  const scoreA = weightedScore(pair.a, weights), scoreB = weightedScore(pair.b, weights);
  if (scoreA === null || scoreB === null) return { id: pair.id, score_a: scoreA, score_b: scoreB, gap: null, higher: null, stratum: null };
  const gap = scoreGap(scoreA, scoreB), index = stratumOf(gap, strata);
  return { id: pair.id, score_a: scoreA, score_b: scoreB, gap, higher: gap < TIE_GAP ? 'tie' : scoreA > scoreB ? 'a' : 'b', stratum: index < 0 ? null : strata[index].id };
}

// Each rater's last vote per pair of the study (a revision is a later line).
// `votes` in the order cast, each naming its rater (readVoteFiles, with the
// legacy rater filled in); votes for pairs not in key.json are left out.
export function latestVotes(key, votes) {
  const known = new Set(key.pairs.map(pair => pair.id)), byRater = new Map();
  for (const vote of votes) {
    if (!known.has(vote.pair)) continue;
    if (!byRater.has(vote.rater)) byRater.set(vote.rater, new Map());
    byRater.get(vote.rater).set(vote.pair, vote);
  }
  return byRater;
}

// Section 5.1: a rater qualifies when they rated every pair of the study and
// pass the repeats and the catch pairs. Reads the votes, the repeats and the
// catch pairs' answers only: nothing here depends on a score. `latest`: the
// rater's last vote per pair (Map pair id -> vote).
export function qualifyRater(key, rater, latest = new Map()) {
  const total = key.pairs.length, rated = key.pairs.filter(pair => latest.has(pair.id)).length;
  const repeats = key.pairs.filter(isRepeat), catches = key.pairs.filter(isCatch);
  let consistent = 0, bothRated = 0;
  for (const repeat of repeats) {
    const first = latest.get(repeat.repeat_of), second = latest.get(repeat.id);
    if (!first || !second) continue;
    bothRated++;
    // The repeat shows the two submissions with the sides swapped.
    if (first.choice === { a: 'b', b: 'a', tie: 'tie' }[second.choice]) consistent++;
  }
  let correct = 0, wrong = 0, ties = 0, catchRated = 0;
  for (const pair of catches) {
    const vote = latest.get(pair.id);
    if (!vote) continue;
    catchRated++;
    if (vote.choice === pair.catch.correct) correct++;
    else if (vote.choice === 'tie') ties++;
    else wrong++;
  }
  const result = {
    rater, pairs_total: total, pairs_rated: rated, complete: rated === total,
    repeats: { total: repeats.length, both_rated: bothRated, consistent, required: required(repeats.length, QUALIFICATION.repeats) },
    catch: { total: catches.length, rated: catchRated, correct, wrong, ties, required: required(catches.length, QUALIFICATION.catch) },
  };
  result.repeats.ok = repeats.length > 0 && consistent >= result.repeats.required;
  result.catch.ok = catches.length > 0 && correct >= result.catch.required;
  const reasons = [];
  if (!result.complete) reasons.push('rated ' + rated + ' of ' + total + ' pairs');
  if (!repeats.length) reasons.push('the study has no repeated pairs');
  else if (!result.repeats.ok) reasons.push('same choice on ' + consistent + ' of ' + repeats.length + ' repeats (needs ' + result.repeats.required + ')');
  if (!catches.length) reasons.push('the study has no catch pairs');
  else if (!result.catch.ok) reasons.push(correct + ' of ' + catches.length + ' catch pairs right (needs ' + result.catch.required + '; "cannot tell" counts as wrong)');
  result.qualified = !reasons.length;
  result.reasons = reasons;
  return result;
}

export function qualifyRaters(key, raters, latestByRater) {
  return raters.map(rater => qualifyRater(key, rater, latestByRater.get(rater)));
}

// The qualification check of a study directory (section 5.1: it reads only
// the votes files and key.json's repeats and catch pairs, never a score, and
// prints counts, never which pairs are catch pairs). `raters`: only these.
export async function qualifyStudy(studyDir, { legacyRater = LEGACY_RATER, raters = null } = {}) {
  const key = JSON.parse(await readFile(join(studyDir, 'key.json'), 'utf8'));
  const read = await readVoteFiles(studyDir, { legacyRater });
  const latest = latestVotes(key, read.votes);
  const voters = [...latest.keys()].sort(), chosen = raters ? voters.filter(id => raters.includes(id)) : voters;
  const results = qualifyRaters(key, chosen, latest);
  const panel = results.filter(item => item.qualified).map(item => item.rater);
  return {
    study: key.name, pairs: key.pairs.length, originals: key.pairs.filter(isOriginal).length, repeats: key.pairs.filter(isRepeat).length, catch_pairs: key.pairs.filter(isCatch).length,
    malformed_lines: read.malformed, ignored_files: read.ignored, raters_not_found: (raters ?? []).filter(id => !voters.includes(id)),
    raters: results, panel, g1: panel.length >= 2 ? 'the panel has ' + panel.length + ' qualified raters' : 'fewer than 2 qualified raters: no G1 and no human curve (plan section 5.1)',
  };
}

// Section 5.1: the option with the most votes among the panel's (A, B,
// cannot tell); a tie for the most votes is "cannot tell". Two raters decide
// only when they agree. null without votes.
export function pluralityChoice(choices) {
  if (!choices.length) return null;
  const counts = CATEGORIES.map(choice => choices.filter(item => item === choice).length);
  const most = Math.max(...counts), top = CATEGORIES.filter((_, index) => counts[index] === most);
  return top.length === 1 ? top[0] : 'tie';
}

// The panel's decision on every original pair, or null when the panel has
// fewer than two raters (section 5.1: then no G1 and no human curve).
// `panel`: the qualified raters, who have rated every pair.
export function panelOriginals(key, latestByRater, panel) {
  if (panel.length < 2) return null;
  return key.pairs.filter(isOriginal).map(pair => {
    const choices = Object.fromEntries(panel.map(rater => [rater, latestByRater.get(rater)?.get(pair.id)?.choice ?? null]));
    const cast = Object.values(choices).filter(Boolean);
    return { id: pair.id, object: pair.object, stratum: pair.stratum, gap: pair.gap, a: pair.a, b: pair.b, choice: pluralityChoice(cast), votes: cast.length, choices };
  });
}

// ---------------------------------------------------------------- bootstrap

// Resamples closer together than this give the same value: the spread is
// rounding (a study's statistics move in steps of 1 / (2 * pairs) or more).
export const SAME_VALUE = 1e-12;

// Section 4: an interval from sorted resample values. Not available when a
// proportion was observed at exactly 0 or 1, or when every resample gave the
// same value: then only the estimate is reported, and an unavailable interval
// meets no threshold.
export function percentileInterval(estimate, sorted, { level = 0.95, proportion = false } = {}) {
  const tail = (1 - level) / 2, none = reason => ({ estimate, low: null, high: null, available: false, reason });
  if (!finite(estimate)) return none('no estimate');
  if (proportion && (estimate === 0 || estimate === 1)) return none('observed ' + estimate + ': a proportion at the boundary');
  if (!sorted.length || !(sorted[sorted.length - 1] - sorted[0] > SAME_VALUE)) return none('every resample gives the same value');
  return { estimate, low: quantile(sorted, tail), high: quantile(sorted, 1 - tail), available: true, reason: null };
}

// Percentile bootstrap over objects (clusters): `samples` times, draw as many
// clusters as there are, with replacement, and compute `statistic` on them.
// `statistic(clusters)` returns a number or an array of numbers; with an array
// every component is computed on the same resamples (so differences are
// paired), and `proportion` may be an array too. Returns the interval (or one
// per component) with the estimate on all clusters. `seed` is required: the
// plan writes it into the private record.
export function objectBootstrap(clusters, statistic, { seed, samples = BOOTSTRAP_RESAMPLES, level = 0.95, proportion = false } = {}) {
  if (seed === undefined || seed === null || seed === '') throw new Error('the bootstrap needs a seed');
  const observed = statistic(clusters), vector = Array.isArray(observed), estimates = vector ? observed : [observed];
  const values = estimates.map(() => new Float64Array(samples));
  const random = rng(String(seed)), n = clusters.length, drawn = new Array(n);
  if (n) {
    for (let b = 0; b < samples; b++) {
      for (let i = 0; i < n; i++) drawn[i] = clusters[Math.floor(random.next() * n)];
      const value = statistic(drawn);
      (vector ? value : [value]).forEach((item, k) => { values[k][b] = item; });
    }
  }
  const intervals = estimates.map((estimate, k) => percentileInterval(estimate, n ? values[k].sort() : [],
    { level, proportion: Array.isArray(proportion) ? Boolean(proportion[k]) : proportion }));
  return vector ? intervals : intervals[0];
}

// A proportion (agreement) over objects: `clusters` are { num, den } per
// object, the proportion is sum(num) / sum(den).
export function proportionInterval(clusters, { seed, samples = BOOTSTRAP_RESAMPLES, level = 0.95 } = {}) {
  const ratio = list => { let num = 0, den = 0; for (const item of list) { num += item.num; den += item.den; } return den ? num / den : null; };
  return objectBootstrap(clusters, ratio, { seed, samples, level, proportion: true });
}
