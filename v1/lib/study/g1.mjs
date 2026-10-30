import { cohenKappa, fleissKappa, CATEGORIES } from './kappa.mjs';
import { STRATA } from './select.mjs';
import {
  CANDIDATE_WEIGHTS, CURRENT_SCORER, NEXT_SCORER, BOOTSTRAP_RESAMPLES, TIE_GAP,
  isOriginal, weightedScore, scoreGap, rescorePair, panelOriginals, objectBootstrap, proportionInterval,
} from './panel.mjs';

// Gate G1 of the Round 4 plan (docs/V1-ROUND4-PLAN.md section 5.2): do the
// qualified raters' majority choices agree better with another weighting of
// shape and detail than with scorer 1.1.0's 50/50?
//
// The evaluation set is fixed before any weight is tried: the original pairs
// on which the panel's majority (section 5.1) is A or B. Under weights w a
// pair scores 1 when the majority chose the side w ranks higher, 0 when it
// chose the other, 1/2 when w puts the two within TIE_GAP. A(w) is the mean.
// A(w) - A(50/50) = sum d_o / sum n_o over objects o (d_o: the object's score
// under w minus under 50/50, n_o: its pairs), with a 95 % interval from the
// bootstrap over objects. w replaces 50/50 (scorer 1.2.0) only when the lower
// bound is above zero and at least 10 objects have d_o != 0; of two such
// candidates the larger difference wins, and equal ones keep 1.1.0.

export const G1_MIN_PANEL = 2;
export const G1_MIN_CHANGED_OBJECTS = 10;
export const TARGET_AGREEMENT = 0.7;

// Points in halves (0, 1, 2), so sums stay integers and ties compare exactly.
function halfPoints(pair, choice, weights) {
  const a = weightedScore(pair.a, weights), b = weightedScore(pair.b, weights);
  if (a === null || b === null) return null;
  if (scoreGap(a, b) < TIE_GAP) return 1;
  return choice === (a > b ? 'a' : 'b') ? 2 : 0;
}

function byObject(items) {
  const clusters = new Map();
  for (const item of items) {
    if (!clusters.has(item.object)) clusters.set(item.object, []);
    clusters.get(item.object).push(item);
  }
  return [...clusters.keys()].sort().map(object => ({ object, items: clusters.get(object) }));
}

// Per rater (descriptive, section 12 "各自的一致率"): on the original pairs the
// rater decided, the same half-point agreement with scorer 1.1.0 as the panel's.
function raterAgreement(key, rater, latest, seed, samples) {
  const items = key.pairs.filter(isOriginal).map(pair => ({ pair, choice: latest?.get(pair.id)?.choice }))
    .filter(item => item.choice === 'a' || item.choice === 'b')
    .map(item => ({ object: item.pair.object, points: halfPoints(item.pair, item.choice, null) }))
    .filter(item => item.points !== null);
  const clusters = byObject(items).map(cluster => ({ num: cluster.items.reduce((sum, item) => sum + item.points, 0) / 2, den: cluster.items.length }));
  return { rater, pairs: items.length, objects: clusters.length, agreement: proportionInterval(clusters, { seed: seed + '/rater/' + rater, samples }) };
}

// Between two panel raters: the share of the same choice (A, cannot tell, B)
// on the original pairs, over objects, with Cohen's kappa as a point estimate.
function raterPair(key, first, second, latestByRater, seed, samples) {
  const items = key.pairs.filter(isOriginal).map(pair => ({ object: pair.object, p: latestByRater.get(first)?.get(pair.id)?.choice, q: latestByRater.get(second)?.get(pair.id)?.choice }))
    .filter(item => item.p && item.q);
  const clusters = byObject(items).map(cluster => ({ num: cluster.items.filter(item => item.p === item.q).length, den: cluster.items.length }));
  return { raters: [first, second], pairs: items.length, same_choice: proportionInterval(clusters, { seed: seed + '/pair/' + first + '/' + second, samples }),
    cohen_kappa: cohenKappa(items.map(item => [item.p, item.q])).kappa };
}

// The decision from the candidates (50/50 first, then the others with their
// `difference`): those that beat 50/50; of two, the larger difference (in half
// points, so the comparison is exact); equal ones keep 1.1.0.
export function g1Decision(candidates) {
  const better = candidates.filter(candidate => candidate.difference?.better).sort((p, q) => q.difference.half_points - p.difference.half_points);
  if (!better.length) return { scorer: CURRENT_SCORER, weights: '50/50', reason: 'no candidate agrees better with the panel than 50/50 by the rule of section 5.2' };
  if (better.length > 1 && better[0].difference.half_points === better[1].difference.half_points) {
    return { scorer: CURRENT_SCORER, weights: '50/50', reason: better.map(item => item.weights).join(' and ') + ' beat 50/50 by the same difference: ' + CURRENT_SCORER + ' stays' };
  }
  return { scorer: NEXT_SCORER, weights: better[0].weights, reason: better[0].weights + ' agrees better with the panel than 50/50 (lower bound of the difference above 0)' };
}

// The 70 % target on 50/50's agreement: reached when the lower bound is at
// least 70 %, below when the upper bound is under it, otherwise (or with no
// interval) not confirmed.
export function targetVerdict(agreement) {
  if (agreement?.available && agreement.low >= TARGET_AGREEMENT) return 'reached';
  if (agreement?.available && agreement.high < TARGET_AGREEMENT) return 'below';
  return 'not_confirmed';
}

//   key: key.json; latestByRater: each rater's last vote per pair (panel.mjs latestVotes);
//   qualification: qualifyRaters for the raters named for the panel (analyze's
//     --raters, else everyone who voted); the panel is the qualified ones;
//   seed: the bootstrap seed from the private record (required to run G1).
export function g1Analysis({ key, latestByRater, qualification, seed = null, samples = BOOTSTRAP_RESAMPLES }) {
  const panel = qualification.filter(item => item.qualified).map(item => item.rater);
  const base = { panel, not_qualified: qualification.filter(item => !item.qualified).map(item => item.rater), seed, samples,
    weights: CANDIDATE_WEIGHTS.map(item => ({ ...item })), tie_gap: TIE_GAP };
  const keep = reason => ({ ...base, run: false, reason, decision: { scorer: CURRENT_SCORER, weights: '50/50', reason } });
  if (panel.length < G1_MIN_PANEL) return keep('fewer than ' + G1_MIN_PANEL + ' qualified raters (' + panel.length + '): no G1, scorer ' + CURRENT_SCORER + ' stays (plan section 5.1)');
  if (seed === null || seed === undefined || seed === '') return { ...base, run: false, reason: 'no bootstrap seed: pass --g1-seed with the seed written in the private record', decision: null };

  const verdicts = panelOriginals(key, latestByRater, panel);
  const incomplete = verdicts.filter(item => item.votes !== panel.length).map(item => item.id);
  if (incomplete.length) return { ...base, run: false, reason: 'original pairs without every panel vote: ' + incomplete.join(', '), decision: null };
  const evaluation = verdicts.filter(item => item.choice === 'a' || item.choice === 'b');
  // The 50/50 weights must give back the scores key.json holds, or the halves are not what the score was made of.
  const mismatched = evaluation.filter(item => ['a', 'b'].some(role => weightedScore(item[role], CANDIDATE_WEIGHTS[0]) !== weightedScore(item[role], null))).map(item => item.id);
  const unscorable = evaluation.filter(item => CANDIDATE_WEIGHTS.some(weights => halfPoints(item, item.choice, weights) === null)).map(item => item.id);
  if (mismatched.length || unscorable.length) {
    return { ...base, run: false, decision: null,
      reason: [mismatched.length ? 'scores in key.json that are not (shape + detail) / 2: ' + mismatched.join(', ') : null,
        unscorable.length ? 'pairs without a shape or detail score: ' + unscorable.join(', ') : null].filter(Boolean).join('; ') };
  }

  const scored = evaluation.map(item => ({ id: item.id, object: item.object, choice: item.choice, points: CANDIDATE_WEIGHTS.map(weights => halfPoints(item, item.choice, weights)) }));
  const clusters = byObject(scored).map(cluster => ({ object: cluster.object, n: cluster.items.length,
    sums: CANDIDATE_WEIGHTS.map((_, k) => cluster.items.reduce((sum, item) => sum + item.points[k], 0)) }));
  const others = CANDIDATE_WEIGHTS.slice(1);
  // A(w) for every candidate, then A(w) - A(50/50) for the others, on the same resamples.
  const statistic = list => {
    let n = 0;
    const sums = CANDIDATE_WEIGHTS.map(() => 0);
    for (const cluster of list) { n += cluster.n; cluster.sums.forEach((value, k) => { sums[k] += value; }); }
    const rates = sums.map(sum => sum / (2 * n));
    return [...rates, ...others.map((_, k) => rates[k + 1] - rates[0])];
  };
  const intervals = clusters.length ? objectBootstrap(clusters, statistic, { seed, samples, proportion: [...CANDIDATE_WEIGHTS.map(() => true), ...others.map(() => false)] }) : null;

  const candidates = CANDIDATE_WEIGHTS.map((weights, k) => ({
    weights: weights.id, shape: weights.shape, detail: weights.detail,
    points: clusters.reduce((sum, cluster) => sum + cluster.sums[k], 0) / 2,
    level_pairs: scored.filter(item => item.points[k] === 1).length,
    agreement: intervals ? intervals[k] : null,
  }));
  for (const [k, candidate] of candidates.entries()) {
    if (!k) continue;
    const changed = clusters.filter(cluster => cluster.sums[k] !== cluster.sums[0]).length;
    const difference = intervals ? intervals[CANDIDATE_WEIGHTS.length + k - 1] : null;
    const reasons = [];
    if (!difference?.available) reasons.push('interval not available' + (difference?.reason ? ' (' + difference.reason + ')' : ''));
    else if (!(difference.low > 0)) reasons.push('lower bound ' + difference.low.toFixed(4) + ' is not above 0');
    if (changed < G1_MIN_CHANGED_OBJECTS) reasons.push('only ' + changed + ' objects with d_o != 0 (needs ' + G1_MIN_CHANGED_OBJECTS + ')');
    candidate.difference = { ...difference, half_points: clusters.reduce((sum, cluster) => sum + cluster.sums[k] - cluster.sums[0], 0), objects_changed: changed,
      better: !reasons.length, reasons };
  }

  const decision = g1Decision(candidates);
  const current = candidates[0].agreement;
  const target = { target: TARGET_AGREEMENT, agreement: current, verdict: targetVerdict(current) };

  const chosen = CANDIDATE_WEIGHTS.find(weights => weights.id === decision.weights);
  const strata = key.strata?.length ? key.strata : STRATA;
  const result = {
    ...base, run: true, reason: null,
    evaluation_set: { originals: verdicts.length, panel_a_or_b: evaluation.length, panel_cannot_tell: verdicts.filter(item => item.choice === 'tie').length,
      objects: clusters.length, pairs_by_object: Object.fromEntries(clusters.map(cluster => [cluster.object, cluster.n])) },
    candidates, decision, target,
    // Section 5.2 "若改": the higher side, gap and stratum of every original pair under the new weights.
    rescored: decision.scorer === NEXT_SCORER ? { scorer: NEXT_SCORER, weights: decision.weights, pairs: key.pairs.filter(isOriginal).map(pair => rescorePair(pair, chosen, strata)) } : null,
    raters: panel.map(rater => raterAgreement(key, rater, latestByRater.get(rater), seed, samples)),
    pairwise: [],
    fleiss: null,
  };
  for (let i = 0; i < panel.length; i++) for (let j = i + 1; j < panel.length; j++) result.pairwise.push(raterPair(key, panel[i], panel[j], latestByRater, seed, samples));
  if (panel.length >= 3) {
    const counts = key.pairs.filter(isOriginal).map(pair => CATEGORIES.map(category => panel.filter(rater => latestByRater.get(rater)?.get(pair.id)?.choice === category).length));
    const fleiss = fleissKappa(counts);
    result.fleiss = { pairs: fleiss.items, kappa: fleiss.kappa, observed: fleiss.observed, chance: fleiss.chance };
  }
  return result;
}
