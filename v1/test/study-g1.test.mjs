import test, { mock } from 'node:test';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeSampleRuns } from '../lib/report/sample-runs.mjs';
import { STRATA, higherSide } from '../lib/study/select.mjs';
import { prepareStudy, exportStudy, studyDir } from '../lib/study/index.mjs';
import { analyzeStudy, analysisMarkdown, writeAnalysis } from '../lib/study/analyze.mjs';
import { addCatchPairs, devModels, KEY_BACKUP } from '../lib/study/catch.mjs';
import { g1Analysis, g1Decision, targetVerdict } from '../lib/study/g1.mjs';
import {
  TIE_GAP, CANDIDATE_WEIGHTS, scoreGap, weightedScore, weightedGap, rescorePair, isOriginal, isCatch, isRepeat, latestVotes,
  qualifyRater, qualifyRaters, qualifyStudy, pluralityChoice, panelOriginals, percentileInterval, objectBootstrap, proportionInterval,
} from '../lib/study/panel.mjs';
import { lockVoting, VOTING_LOCK } from '../lib/study/votes.mjs';

// Round 4 plan (docs/V1-ROUND4-PLAN.md): rater qualification and the panel
// (section 5.1), gate G1 (section 5.2), intervals (section 4), catch pairs.

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' is not within ' + tolerance + ' of ' + expected);
const W = Object.fromEntries(CANDIDATE_WEIGHTS.map(weights => [weights.id, weights]));

async function withTemp(run) {
  const root = await mkdtemp(join(tmpdir(), 'e3d-g1-'));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('score gap, weighted headline scores and a pair rescored under other weights', () => {
  // Floating-point noise of the subtraction does not decide a tie.
  assert.equal(70.15 - 70.10 > 0.05, true);
  assert.equal(scoreGap(70.15, 70.10), 0.05);
  assert.equal(scoreGap(0.15, 0.10), 0.05);
  assert.equal(scoreGap(70.10, 70.15) < TIE_GAP, false);
  assert.equal(scoreGap(70.14, 70.10) < TIE_GAP, true);
  // Two decimals, as the scorer rounds; shape alone without detail; key.json's score with no weights.
  assert.equal(weightedScore({ shape_score: 80, detail_score: 41 }, W['65/35']), 66.35);
  assert.equal(weightedScore({ shape_score: 80.123, detail_score: 41.004 }, W['35/65']), 54.7);
  assert.equal(weightedScore({ score: 77.77, shape_score: 77.77, detail_score: null }, W['35/65']), 77.77);
  assert.equal(weightedScore({ score: 59.5, shape_score: 80, detail_score: 39 }, null), 59.5);
  // 50/50 gives back what the scorer wrote: round((shape + detail) / 2, 2).
  for (const [shape, detail] of [[80.12, 41.07], [33.33, 66.67], [12.345, 98.765]]) {
    assert.equal(weightedScore({ shape_score: shape, detail_score: detail }, W['50/50']), Number(((shape + detail) / 2).toFixed(2)));
  }
  assert.equal(weightedScore({ shape_score: null, detail_score: 40 }, W['50/50']), null);
  assert.equal(weightedScore({ shape_score: 50, detail_score: Number.NaN }, W['50/50']), null);
  const pair = { id: 'p', a: { score: 60, shape_score: 80, detail_score: 40 }, b: { score: 59, shape_score: 60, detail_score: 58 } };
  assert.deepEqual(rescorePair(pair), { id: 'p', score_a: 60, score_b: 59, gap: 1, higher: 'a', stratum: '0-3' });
  assert.deepEqual(rescorePair(pair, W['35/65']), { id: 'p', score_a: 54, score_b: 58.7, gap: 4.7, higher: 'b', stratum: '3-8' });
  assert.equal(weightedGap(pair, W['65/35']), 6.7);
  assert.equal(rescorePair({ id: 'q', a: { score: 50.02 }, b: { score: 50 } }).higher, 'tie');
  assert.equal(rescorePair({ id: 'q', a: { score: null }, b: { score: 50 } }).gap, null);
});

test('the panel\'s majority: most votes among A, B and cannot tell; a tie for the most is cannot tell', () => {
  assert.equal(pluralityChoice(['a', 'a', 'b']), 'a');
  assert.equal(pluralityChoice(['b', 'tie', 'b']), 'b');
  assert.equal(pluralityChoice(['tie', 'tie', 'a']), 'tie');
  assert.equal(pluralityChoice(['a', 'b', 'tie']), 'tie');
  // Two raters decide only when they agree.
  assert.equal(pluralityChoice(['a', 'a']), 'a');
  assert.equal(pluralityChoice(['a', 'b']), 'tie');
  assert.equal(pluralityChoice(['a', 'tie']), 'tie');
  assert.equal(pluralityChoice(['a', 'a', 'b', 'b']), 'tie');
  assert.equal(pluralityChoice([]), null);
});

// A key with 10 originals, 10 repeats of them and 6 catch pairs.
function qualificationKey() {
  const side = score => ({ score, shape_score: score, detail_score: score });
  const pairs = [];
  for (let i = 0; i < 10; i++) pairs.push({ id: 'o' + i, object: 'obj-' + i, stratum: '15-100', a: side(80), b: side(50), repeat_of: null });
  for (let i = 0; i < 10; i++) pairs.push({ id: 'r' + i, object: 'obj-' + i, stratum: '15-100', a: side(50), b: side(80), repeat_of: 'o' + i });
  for (let i = 0; i < 6; i++) pairs.push({ id: 'c' + i, object: 'dev-' + i, stratum: null, a: { kind: 'truth' }, b: { kind: 'drop_group' }, repeat_of: null, catch: { correct: i % 2 ? 'b' : 'a' } });
  return { name: 'q', strata: STRATA, pairs };
}
const ballot = entries => new Map(entries.map(([pair, choice]) => [pair, { pair, choice }]));
// Originals all A; repeats the same choice (B, sides swapped) on `same` of 10, else A;
// catch pairs right on the first `right`, then the given wrong choices.
function rater({ same = 10, right = 6, wrong = [], skip = [] } = {}) {
  const entries = [];
  for (let i = 0; i < 10; i++) entries.push(['o' + i, 'a'], ['r' + i, i < same ? 'b' : 'a']);
  for (let i = 0; i < 6; i++) {
    const correct = i % 2 ? 'b' : 'a';
    entries.push(['c' + i, i < right ? correct : wrong[i - right] ?? (correct === 'a' ? 'b' : 'a')]);
  }
  return ballot(entries.filter(([pair]) => !skip.includes(pair)));
}

test('qualification: every pair, 7 of 10 repeats, 5 of 6 catch pairs, "cannot tell" on a catch pair is wrong', () => {
  const key = qualificationKey();
  assert.deepEqual(key.pairs.map(pair => [isOriginal(pair), isRepeat(pair), isCatch(pair)]).reduce((tally, flags) => tally.map((n, k) => n + flags[k]), [0, 0, 0]), [10, 10, 6]);
  const pass = qualifyRater(key, 'ann', rater({ same: 7, right: 5 }));
  assert.equal(pass.qualified, true);
  assert.deepEqual([pass.pairs_rated, pass.pairs_total, pass.repeats.consistent, pass.repeats.required, pass.catch.correct, pass.catch.wrong, pass.catch.required], [26, 26, 7, 7, 5, 1, 5]);
  assert.deepEqual(pass.reasons, []);
  const repeats = qualifyRater(key, 'bob', rater({ same: 6 }));
  assert.equal(repeats.qualified, false);
  assert.deepEqual(repeats.reasons, ['same choice on 6 of 10 repeats (needs 7)']);
  // "Cannot tell" twice on a repeat is the same choice.
  const ties = new Map(rater({ same: 6 }));
  for (const id of ['o9', 'r9']) ties.set(id, { pair: id, choice: 'tie' });
  assert.equal(qualifyRater(key, 'bob', ties).repeats.consistent, 7);
  // A catch pair answered "cannot tell" is wrong.
  const unsure = qualifyRater(key, 'cy', rater({ right: 4, wrong: ['tie', 'tie'] }));
  assert.deepEqual([unsure.qualified, unsure.catch.correct, unsure.catch.ties, unsure.catch.wrong], [false, 4, 2, 0]);
  assert.match(unsure.reasons[0], /4 of 6 catch pairs right \(needs 5; "cannot tell" counts as wrong\)/);
  const incomplete = qualifyRater(key, 'dan', rater({ skip: ['c5'] }));
  assert.deepEqual([incomplete.qualified, incomplete.complete, incomplete.catch.rated], [false, false, 5]);
  assert.deepEqual(incomplete.reasons, ['rated 25 of 26 pairs']);
  // Without repeats or catch pairs nobody can qualify.
  const bare = { ...key, pairs: key.pairs.filter(isOriginal) };
  assert.deepEqual(qualifyRater(bare, 'ann', rater()).reasons, ['the study has no repeated pairs', 'the study has no catch pairs']);
  assert.deepEqual(qualifyRaters(key, ['ann', 'eve'], new Map([['ann', rater()]])).map(item => [item.rater, item.qualified, item.pairs_rated]), [['ann', true, 26], ['eve', false, 0]]);
  // Nothing in the result names a pair: printing it does not tell which pairs are catch pairs.
  assert.doesNotMatch(JSON.stringify(pass), /"c\d"|"o\d"|"r\d"/);
});

test('intervals: the boundary and constant cases are not available; the bootstrap is seeded and paired', () => {
  assert.deepEqual(percentileInterval(1, Float64Array.from([0.9, 1, 1]), { proportion: true }), { estimate: 1, low: null, high: null, available: false, reason: 'observed 1: a proportion at the boundary' });
  assert.equal(percentileInterval(0, [0, 0.1], { proportion: true }).available, false);
  assert.equal(percentileInterval(0.5, [0.5, 0.5, 0.5]).reason, 'every resample gives the same value');
  const plain = percentileInterval(0.5, Float64Array.from({ length: 101 }, (_, i) => i / 100));
  assert.equal(plain.available, true);
  near(plain.low, 0.025, 1e-12); near(plain.high, 0.975, 1e-12);
  // Two objects at 0 and 1: resampled means are 0, 1/2 or 1 with chances 1/4, 1/2, 1/4.
  const clusters = [{ value: 0 }, { value: 1 }];
  const mean = list => list.reduce((sum, item) => sum + item.value, 0) / list.length;
  const result = objectBootstrap(clusters, mean, { seed: 'two', samples: 4000 });
  assert.deepEqual([result.estimate, result.low, result.high, result.available], [0.5, 0, 1, true]);
  assert.deepEqual(objectBootstrap(clusters, mean, { seed: 'two', samples: 4000 }), result);
  assert.throws(() => objectBootstrap(clusters, mean, {}), /needs a seed/);
  // One object: every resample is the same.
  assert.equal(objectBootstrap([{ value: 3 }], mean, { seed: 's' }).available, false);
  // Vector statistics share the resamples: x - x is 0 in every one of them.
  const both = objectBootstrap([{ value: 1 }, { value: 2 }, { value: 4 }], list => [mean(list), mean(list) - mean(list)], { seed: 'v', samples: 500 });
  assert.equal(both[0].available, true);
  assert.equal(both[1].reason, 'every resample gives the same value');
  // A ratio over objects: 3 / 4 here, interval within [1/2, 1].
  const ratio = proportionInterval([{ num: 1, den: 2 }, { num: 2, den: 2 }], { seed: 'r', samples: 2000 });
  assert.deepEqual([ratio.estimate, ratio.low, ratio.high], [0.75, 0.5, 1]);
});

// ------------------------------------------------------------ gate G1, by hand

const sub = (shape, detail) => ({ score: Number(((shape + detail) / 2).toFixed(2)), shape_score: shape, detail_score: detail });
// Pair kinds: the two submissions and the panel's choice.
//   agree   every weighting ranks A higher; the panel chose A.
//   detail  50/50 (60 v 59) and 65/35 rank A higher, 35/65 ranks B higher; the panel chose B.
//   shape   50/50 (59 v 60) and 35/65 rank B higher, 65/35 ranks A higher; the panel chose A.
//   level   50/50 puts them level (55 v 55), 65/35 ranks A higher, 35/65 B; the panel chose A.
//   split   the panel cannot tell (A, B and cannot tell).
//   wrong   every weighting ranks A higher; the panel chose B.
const KINDS = {
  agree: [sub(70, 70), sub(50, 50), ['a', 'a', 'a']],
  detail: [sub(80, 40), sub(60, 58), ['b', 'b', 'a']],
  shape: [sub(58, 60), sub(40, 80), ['a', 'a', 'tie']],
  level: [sub(60, 50), sub(50, 60), ['a', 'a', 'b']],
  split: [sub(70, 70), sub(50, 50), ['a', 'b', 'tie']],
  wrong: [sub(70, 70), sub(50, 50), ['b', 'b', 'b']],
};
const PANEL = ['ann', 'bob', 'cy'], EVERYONE = [...PANEL, 'dan', 'eve'];
// `objects`: per object the kinds of its original pairs. The first ten
// originals are repeated with the sides swapped; six catch pairs follow.
function g1Study(objects) {
  const pairs = [];
  objects.forEach((kinds, o) => kinds.forEach((kind, k) => {
    const [a, b] = KINDS[kind], gap = scoreGap(a.score, b.score);
    pairs.push({ id: 'p' + o + '-' + k, object: 'obj-' + String(o).padStart(2, '0'), kind, stratum: STRATA.find(item => gap >= item.min && gap < item.max)?.id ?? '15-100', gap, a, b,
      repeat_of: null, variant: 't2', higher: higherSide(a.score, b.score), higher_shape: higherSide(a.shape_score, b.shape_score), higher_detail: higherSide(a.detail_score, b.detail_score) });
  }));
  const originals = pairs.slice();
  for (const original of originals.slice(0, 10)) {
    pairs.push({ ...original, id: 'r-' + original.id, a: original.b, b: original.a, repeat_of: original.id, higher: higherSide(original.b.score, original.a.score) });
  }
  for (let i = 0; i < 6; i++) pairs.push({ id: 'c' + i, object: 'house-0011', stratum: null, gap: null, a: { kind: 'truth' }, b: { kind: 'drop_group' }, repeat_of: null, catch: { correct: i < 3 ? 'a' : 'b' } });
  const key = { name: 'g1', strata: STRATA.map(item => ({ ...item })), pairs };
  const votes = [];
  let second = 0;
  const cast = (rater, pair, choice) => votes.push({ rater, pair, choice, ms: 1000, hidden_ms: 0, at: new Date(Date.UTC(2026, 10, 1, 0, 0, second++)).toISOString() });
  const swapped = { a: 'b', b: 'a', tie: 'tie' };
  for (const [index, rater] of PANEL.entries()) {
    for (const pair of originals) cast(rater, pair.id, KINDS[pair.kind][2][index]);
    for (const pair of pairs.filter(isRepeat)) cast(rater, pair.id, swapped[KINDS[originals.find(item => item.id === pair.repeat_of).kind][2][index]]);
    for (const pair of pairs.filter(isCatch)) cast(rater, pair.id, pair.catch.correct);
  }
  // dan rated everything against the panel and missed two catch pairs; eve skipped one pair.
  for (const pair of originals) cast('dan', pair.id, swapped[KINDS[pair.kind][2][0]]);
  for (const pair of pairs.filter(isRepeat)) cast('dan', pair.id, KINDS[originals.find(item => item.id === pair.repeat_of).kind][2][0]);
  for (const [i, pair] of pairs.filter(isCatch).entries()) cast('dan', pair.id, i < 2 ? swapped[pair.catch.correct] : pair.catch.correct);
  for (const pair of pairs.slice(1)) cast('eve', pair.id, 'a');
  return { key, votes };
}
const range = (n, kinds) => Array.from({ length: n }, () => kinds.slice());

test('G1 on a hand-computed panel: 35/65 agrees better, 65/35 changes too few objects, the 70 % target is missed', () => {
  // obj-00..09: agree, detail; obj-00..05 one more agree; obj-10, obj-11: agree, shape;
  // obj-00 also a level pair, obj-01 a split one (out of the evaluation set).
  const objects = [...range(10, ['agree', 'detail']), ...range(2, ['agree', 'shape'])];
  for (let o = 0; o < 6; o++) objects[o].push('agree');
  objects[0].push('level');
  objects[1].push('split');
  const { key, votes } = g1Study(objects);
  const analysis = analyzeStudy({ key, votes, raters: EVERYONE, g1Seed: 'g1-hand' });
  assert.equal(analysis.schema, 'e3d-study-analysis-v3');
  // Catch pairs are no originals: not in any rater's agreement or between raters.
  assert.deepEqual([analysis.votes.pairs_total, analysis.votes.originals_total, analysis.votes.catch_total], [48, 32, 6]);
  assert.equal(analysis.raters.find(item => item.rater === 'ann').votes.originals_total, 32);
  assert.equal(analysis.between_raters.pairwise[0].both_rated, 32);
  assert.deepEqual(analysis.qualification.map(item => [item.rater, item.qualified]), [['ann', true], ['bob', true], ['cy', true], ['dan', false], ['eve', false]]);
  assert.match(analysis.qualification[3].reasons.join(), /4 of 6 catch pairs right/);
  assert.equal(analysis.qualification[4].reasons[0], 'rated 47 of 48 pairs');

  const g1 = analysis.g1;
  assert.deepEqual([g1.run, g1.panel, g1.not_qualified, g1.seed, g1.samples], [true, PANEL, ['dan', 'eve'], 'g1-hand', 10000]);
  // dan voted against the panel throughout and is not on it: 31 of the 32 originals are decided.
  assert.deepEqual([g1.evaluation_set.originals, g1.evaluation_set.panel_a_or_b, g1.evaluation_set.panel_cannot_tell, g1.evaluation_set.objects], [32, 31, 1, 12]);
  // Half points over 62: 50/50 18 agree x 2 + level 1 = 37; 65/35 36 + shape 4 + level 2 = 42; 35/65 36 + detail 20 = 56.
  const [even, shapeHeavy, detailHeavy] = g1.candidates;
  assert.deepEqual(g1.candidates.map(item => [item.weights, item.points, item.level_pairs]), [['50/50', 18.5, 1], ['65/35', 21, 0], ['35/65', 28, 0]]);
  near(even.agreement.estimate, 37 / 62); near(shapeHeavy.agreement.estimate, 42 / 62); near(detailHeavy.agreement.estimate, 56 / 62);
  assert.equal(even.difference, undefined);
  near(shapeHeavy.difference.estimate, 5 / 62); near(detailHeavy.difference.estimate, 19 / 62);
  // 65/35 differs from 50/50 on obj-00 (level) and obj-10, obj-11 (shape): 3 objects.
  assert.deepEqual([shapeHeavy.difference.objects_changed, shapeHeavy.difference.better], [3, false]);
  assert.match(shapeHeavy.difference.reasons.at(-1), /only 3 objects with d_o != 0 \(needs 10\)/);
  // 35/65 on obj-00..09 (obj-00: detail +2, level -1).
  assert.deepEqual([detailHeavy.difference.half_points, detailHeavy.difference.objects_changed, detailHeavy.difference.better], [19, 10, true]);
  assert.ok(detailHeavy.difference.low > 0 && detailHeavy.difference.high <= 1);
  assert.deepEqual(g1.decision, { scorer: '1.2.0', weights: '35/65', reason: '35/65 agrees better with the panel than 50/50 (lower bound of the difference above 0)' });
  // Per object 50/50 is at most 2/3, so no resample reaches 70 %.
  assert.equal(g1.target.verdict, 'below');
  assert.ok(g1.target.agreement.high < 0.7);
  // Under 35/65 every original pair gets its new higher side, gap and stratum.
  assert.equal(g1.rescored.pairs.length, 32);
  assert.deepEqual(g1.rescored.pairs.find(pair => pair.id === 'p0-1'), { id: 'p0-1', score_a: 54, score_b: 58.7, gap: 4.7, higher: 'b', stratum: '3-8' });
  // The panel: per rater and per two raters, over objects; Fleiss over the three.
  assert.deepEqual(g1.raters.map(item => [item.rater, item.pairs, item.objects]), [['ann', 32, 12], ['bob', 32, 12], ['cy', 29, 12]]);
  assert.deepEqual(g1.pairwise.map(item => [item.raters.join('-'), item.pairs]), [['ann-bob', 32], ['ann-cy', 32], ['bob-cy', 32]]);
  assert.equal(g1.fleiss.pairs, 32);
  // The same seed gives the same G1; the markdown says what was decided.
  assert.deepEqual(analyzeStudy({ key, votes, raters: EVERYONE, g1Seed: 'g1-hand' }).g1, g1);
  const markdown = analysisMarkdown(analysis);
  assert.match(markdown, /## Rater qualification\n/);
  assert.match(markdown, /\| dan \| 48 \/ 48 \| 10 \/ 10 \(7\) \| 4 \/ 6 \(5\) \| 0 \| no: 4 of 6 catch pairs right/);
  assert.match(markdown, /## Gate G1: scorer 1\.1\.0 or 1\.2\.0\n\nRound 4 plan section 5\.2\. Panel \(the qualified raters\): ann, bob, cy\. Not qualified, reported on their own: dan, eve\./);
  assert.match(markdown, /Evaluation set: the 31 original pairs \(of 32\) on which the panel's majority chose A or B, from 12 objects; the majority was "cannot tell" on 1\./);
  assert.match(markdown, /\| 35\/65 \| 90\.3% \[[^|]+\] \| 0 \| \+30\.6 pts \[[^|]+\] \| 10 \| yes \|/);
  assert.match(markdown, /\*\*Decision: scorer 1\.2\.0 \(35\/65\)\.\*\*/);
  assert.match(markdown, /\*\*70 % target:\*\* the agreement of 50\/50, 59\.7% \[[^\]]+\], is below the 70 % target/);
  assert.match(markdown, /chosen after seeing these data and is optimistic/);
});

test('G1 keeps 1.1.0 with fewer than 10 changed objects; the 70 % target is reached or not confirmed', () => {
  // Nine objects where 35/65 would gain: not enough.
  const nine = g1Study([...range(9, ['agree', 'detail']), ...range(3, ['agree', 'agree'])]);
  const kept = analyzeStudy({ ...nine, raters: PANEL, g1Seed: 'nine' }).g1;
  const detailHeavy = kept.candidates[2].difference;
  assert.deepEqual([detailHeavy.objects_changed, detailHeavy.better], [9, false]);
  assert.match(detailHeavy.reasons.join(), /only 9 objects with d_o != 0/);
  assert.deepEqual([kept.decision.scorer, kept.decision.weights, kept.rescored], ['1.1.0', '50/50', null]);
  // 64 of 68 half points: per object 1 or 1/2, the lower bound stays above 70 %.
  const high = analyzeStudy({ ...g1Study([...range(10, ['agree', 'agree', 'agree']), ...range(2, ['agree', 'detail'])]), raters: PANEL, g1Seed: 'high' }).g1;
  near(high.candidates[0].agreement.estimate, 32 / 34);
  assert.equal(high.target.verdict, 'reached');
  assert.ok(high.target.agreement.low >= 0.7);
  // Full agreement is a proportion at the boundary: no interval, so not confirmed; no candidate can beat it.
  const all = analyzeStudy({ ...g1Study(range(12, ['agree', 'agree'])), raters: PANEL, g1Seed: 'all' }).g1;
  assert.deepEqual([all.candidates[0].agreement.estimate, all.candidates[0].agreement.available, all.target.verdict, all.decision.scorer], [1, false, 'not_confirmed', '1.1.0']);
  assert.equal(all.candidates[1].difference.reasons[0], 'interval not available (every resample gives the same value)');
  assert.match(analysisMarkdown(analyzeStudy({ ...g1Study(range(12, ['agree', 'agree'])), raters: PANEL, g1Seed: 'all' })), /100\.0% \(interval not available: observed 1: a proportion at the boundary\), is not confirmed to reach the 70 % target/);
});

test('G1: a difference that is the same on every resample has no interval, also when the agreement differs by object', () => {
  // 20 objects of five originals: one detail pair (35/65 gains a point on it), then k agreeing and 4 - k wrong ones.
  const objects = Array.from({ length: 20 }, (_, o) => ['detail', ...Array.from({ length: 4 }, (_, i) => i < o % 5 ? 'agree' : 'wrong')]);
  const g1 = analyzeStudy({ ...g1Study(objects), raters: PANEL, g1Seed: 'constant' }).g1;
  const difference = g1.candidates[2].difference;
  assert.deepEqual([difference.estimate, difference.available, difference.objects_changed, difference.better], [0.2, false, 20, false]);
  assert.equal(difference.reason, 'every resample gives the same value');
  assert.equal(g1.candidates[0].agreement.available, true);
  assert.deepEqual([g1.decision.scorer, g1.decision.weights], ['1.1.0', '50/50']);
  // Values a rounding step apart are the same value.
  assert.equal(percentileInterval(0.2, [0.19999999999999996, 0.2, 0.20000000000000007]).available, false);
  assert.equal(percentileInterval(0.2, [0.19, 0.2, 0.21]).available, true);
});

test('G1 with an empty evaluation set keeps 1.1.0, also through the command line', async () => {
  // Two qualified raters who never agree, or a panel that always says "cannot tell": no pair to compare on.
  const study = g1Study(range(12, ['split', 'split']));
  const g1 = analyzeStudy({ ...study, raters: PANEL, g1Seed: 's' }).g1;
  assert.deepEqual([g1.run, g1.panel, g1.decision.scorer, g1.target.verdict], [false, PANEL, '1.1.0', 'not_confirmed']);
  assert.match(g1.reason, /evaluation set is empty/);
  assert.match(analysisMarkdown(analyzeStudy({ ...study, raters: PANEL, g1Seed: 's' })), /\*\*G1 not computed:\*\* the panel chose A or B on no original pair[^\n]*\n\n\*\*70 % target:\*\* the agreement of 50\/50, n\/a, is not confirmed/);
  await withTemp(async root => {
    const cli = fileURLToPath(new URL('../scripts/study.mjs', import.meta.url));
    const run = (name, { key, votes }) => {
      const dir = join(root, 'study', name);
      return mkdir(dir, { recursive: true })
        .then(() => writeFile(join(dir, 'key.json'), JSON.stringify(key)))
        .then(() => writeFile(join(dir, 'votes.jsonl'), votes.map(vote => JSON.stringify(vote)).join('\n') + '\n'))
        .then(() => spawnSync(process.execPath, [cli, 'analyze', '--name', name, '--data', root, '--raters', PANEL.join(','), '--g1-seed', 's'], { encoding: 'utf8' }));
    };
    const empty = await run('empty', study);
    assert.equal(empty.status, 0, empty.stderr);
    const printed = JSON.parse(empty.stdout.trim().split('\n').at(-1)).g1;
    assert.deepEqual([printed.decision.scorer, printed.target], ['1.1.0', 'not_confirmed']);
    const decided = await run('decided', g1Study([...range(10, ['agree', 'detail']), ...range(2, ['agree', 'agree'])]));
    assert.equal(decided.status, 0, decided.stderr);
    const summary = JSON.parse(decided.stdout.trim().split('\n').at(-1)).g1;
    assert.deepEqual([summary.decision.weights, summary.agreement.map(item => item.weights)], ['35/65', ['50/50', '65/35', '35/65']]);
  });
});

test('G1 needs two qualified raters and a seed; unqualified raters never vote in the panel', () => {
  const { key, votes } = g1Study(range(12, ['agree', 'detail']));
  // Only ann and dan named: one qualified rater, no G1, 1.1.0 stays.
  const alone = analyzeStudy({ key, votes, raters: ['ann', 'dan'], g1Seed: 's' }).g1;
  assert.deepEqual([alone.run, alone.panel, alone.decision.scorer], [false, ['ann'], '1.1.0']);
  assert.match(alone.reason, /fewer than 2 qualified raters \(1\)/);
  assert.match(analysisMarkdown(analyzeStudy({ key, votes, raters: ['ann', 'dan'], g1Seed: 's' })), /\*\*G1 not computed:\*\* fewer than 2 qualified raters \(1\)[^\n]*Decision: scorer 1\.1\.0 \(50\/50\)\./);
  // Without the seed of the private record, or without the panel named, G1 is not computed, and decides nothing.
  const unseeded = analyzeStudy({ key, votes, raters: PANEL }).g1;
  assert.deepEqual([unseeded.run, unseeded.decision], [false, null]);
  assert.match(unseeded.reason, /--g1-seed/);
  const unnamed = analyzeStudy({ key, votes, g1Seed: 's' }).g1;
  assert.deepEqual([unnamed.run, unnamed.decision, unnamed.panel], [false, null, PANEL]);
  assert.match(unnamed.reason, /the panel is not named: pass --raters/);
  // Two raters: they decide only where they agree.
  const two = analyzeStudy({ key, votes, raters: ['ann', 'cy'], g1Seed: 's' }).g1;
  assert.deepEqual([two.panel, two.evaluation_set.panel_a_or_b, two.evaluation_set.panel_cannot_tell, two.fleiss], [['ann', 'cy'], 12, 12, null]);
  // dan's votes against the panel change nothing.
  const latest = latestVotes(key, votes);
  assert.deepEqual(panelOriginals(key, latest, PANEL).map(item => item.choice), panelOriginals(key, latest, [...PANEL]).map(item => item.choice));
  assert.equal(panelOriginals(key, latest, ['ann']), null);
  assert.deepEqual(analyzeStudy({ key, votes, raters: [...PANEL, 'dan'], g1Seed: 's' }).g1.candidates, analyzeStudy({ key, votes, raters: PANEL, g1Seed: 's' }).g1.candidates);
  // A score in key.json that is not (shape + detail) / 2 stops G1.
  const broken = structuredClone(key);
  broken.pairs[0].a.score += 1;
  const refused = g1Analysis({ key: broken, latestByRater: latest, qualification: qualifyRaters(broken, PANEL, latest), named: true, seed: 's' });
  assert.deepEqual([refused.run, refused.decision], [false, null]);
  assert.match(refused.reason, /not \(shape \+ detail\) \/ 2: p0-0/);
});

test('the decision rule: no candidate, one, or two with the same difference', () => {
  const candidate = (weights, better, halfPoints) => ({ weights, difference: { better, half_points: halfPoints } });
  const base = { weights: '50/50' };
  assert.equal(g1Decision([base, candidate('65/35', false, 9), candidate('35/65', false, 4)]).scorer, '1.1.0');
  assert.deepEqual(g1Decision([base, candidate('65/35', true, 9), candidate('35/65', false, 12)]).weights, '65/35');
  assert.deepEqual(g1Decision([base, candidate('65/35', true, 9), candidate('35/65', true, 12)]).weights, '35/65');
  const level = g1Decision([base, candidate('65/35', true, 9), candidate('35/65', true, 9)]);
  assert.deepEqual([level.scorer, level.weights], ['1.1.0', '50/50']);
  assert.match(level.reason, /same difference/);
  assert.equal(targetVerdict({ available: true, low: 0.7, high: 0.8 }), 'reached');
  assert.equal(targetVerdict({ available: true, low: 0.6, high: 0.6999 }), 'below');
  assert.equal(targetVerdict({ available: true, low: 0.6, high: 0.7 }), 'not_confirmed');
  assert.equal(targetVerdict({ available: false }), 'not_confirmed');
  assert.equal(targetVerdict(null), 'not_confirmed');
});

test('the owner\'s votes from before raters had names join their later ones with --legacy-rater', async () => {
  await withTemp(async dir => {
    const { key, votes } = g1Study([...range(10, ['agree', 'detail']), ...range(2, ['agree', 'agree'])]);
    await writeFile(join(dir, 'key.json'), JSON.stringify(key));
    // ann's first 14 votes carry no rater (votes.jsonl as it was), the rest name her; bob and cy sent theirs back.
    const own = votes.filter(vote => vote.rater === 'ann');
    await writeFile(join(dir, 'votes.jsonl'), own.map((vote, i) => JSON.stringify(i < 14 ? { ...vote, rater: undefined } : vote)).join('\n') + '\n');
    for (const rater of ['bob', 'cy']) await writeFile(join(dir, 'votes-' + rater + '.jsonl'), votes.filter(vote => vote.rater === rater).map(vote => JSON.stringify(vote)).join('\n') + '\n');
    const split = await qualifyStudy(dir);
    assert.deepEqual(split.raters.map(item => [item.rater, item.pairs_rated, item.qualified]), [['ann', 26, false], ['bob', 40, true], ['cy', 40, true], ['r0', 14, false]]);
    assert.deepEqual([split.pairs, split.originals, split.repeats, split.catch_pairs, split.panel], [40, 24, 10, 6, ['bob', 'cy']]);
    const merged = await qualifyStudy(dir, { legacyRater: 'ann' });
    assert.deepEqual(merged.raters.map(item => [item.rater, item.pairs_rated, item.qualified]), [['ann', 40, true], ['bob', 40, true], ['cy', 40, true]]);
    assert.match(merged.g1, /3 qualified raters/);
    // qualify prints counts only: no pair id, no score.
    assert.doesNotMatch(JSON.stringify(merged), /"p\d+-\d"|"c\d"|score|agreement/);
    const { analysis } = await writeAnalysis(dir, { legacyRater: 'ann', raters: PANEL, g1Seed: 'legacy' });
    assert.deepEqual([analysis.g1.run, analysis.g1.panel, analysis.g1.decision.weights], [true, PANEL, '35/65']);
    assert.equal(JSON.parse(await readFile(join(dir, 'analysis.json'), 'utf8')).g1.decision.scorer, '1.2.0');
    assert.match(await readFile(join(dir, 'analysis.md'), 'utf8'), /## Gate G1/);
  });
});

// ------------------------------------------------------------ catch pairs

const RUN_SPECS = [];
for (const [object, archetype] of [['demo-house-a', 'house'], ['demo-house-b', 'hall']]) {
  for (const variant of ['t2', 't4']) {
    RUN_SPECS.push(
      { system: 'codex', model: 'gpt-demo', effort: 'high', batch: 'demo-codex', object, variant, archetype, attempt: 1, score: 70 },
      { system: 'codex', model: 'gpt-demo', effort: 'high', batch: 'demo-codex', object, variant, archetype, attempt: 2, score: 71, dropGroups: ['chimney'] },
      { system: 'claude-code', model: 'opus-demo', effort: 'max', batch: 'demo-claude', object, variant, archetype, attempt: 1, score: 65, dropGroups: ['front.canopy'] },
      { system: 'claude-code', model: 'opus-demo', effort: 'max', batch: 'demo-claude', object, variant, archetype, attempt: 2, score: 59, dropGroups: ['roof'] },
      { system: 'claude-code', model: 'opus-demo', effort: 'max', batch: 'demo-claude', object, variant, archetype, attempt: 3, score: 40, dropGroups: ['roof', 'chimney', 'front.canopy'] });
  }
}

test('add-catch: six catch pairs after the last rated pair, votes untouched, drawn like the study, marked in key.json only', async () => {
  await withTemp(async root => {
    const dataRoot = join(root, 'data');
    await writeSampleRuns(dataRoot, { attempts: RUN_SPECS, withInputs: false });
    await prepareStudy({ dataRoot, name: 'unit', batches: ['demo-codex', 'demo-claude'], pairs: 8, seed: 'prep', size: { width: 96, height: 72 } });
    const dir = studyDir(dataRoot, 'unit');
    const before = { pairs: JSON.parse(await readFile(join(dir, 'pairs.json'), 'utf8')), key: JSON.parse(await readFile(join(dir, 'key.json'), 'utf8')) };
    // The owner rated the first pair and the third, without a rater id.
    const votesText = [0, 2].map(i => JSON.stringify({ pair: before.pairs.pairs[i].id, choice: 'a', ms: 1, at: 't' + i })).join('\n') + '\n';
    await writeFile(join(dir, 'votes.jsonl'), votesText);
    await assert.rejects(addCatchPairs({ dataRoot, name: 'unit', objects: ['demo-house-a'], seed: 's' }), /not objects of the development set[^\n]*demo-house-a/);
    await assert.rejects(addCatchPairs({ dataRoot, name: 'unit', objects: ['retail-0012'], seed: 's' }), /only 1 massing or roof groups of retail-0012/);
    const objects = ['house-0011', 'tower-0013', 'hall-0014', 'structure-0015'];
    const added = await addCatchPairs({ dataRoot, name: 'unit', objects, seed: 'catch', now: () => new Date('2026-10-30T12:00:00Z') });
    assert.deepEqual([added.added, added.pairs, added.after_position, added.images], [6, 15, 2, 6 * 3 * 4]);
    assert.deepEqual(added.groups.map(item => item.object), ['house-0011', 'tower-0013', 'hall-0014', 'structure-0015', 'house-0011', 'tower-0013']);
    for (const item of added.groups) assert.ok(['massing', 'roof'].includes(item.category) && item.changed_share >= 0.15, JSON.stringify(item));
    assert.doesNotMatch(JSON.stringify(added), /"[0-9a-f]{8}"/);

    const pairs = JSON.parse(await readFile(join(dir, 'pairs.json'), 'utf8')), key = JSON.parse(await readFile(join(dir, 'key.json'), 'utf8'));
    assert.deepEqual(pairs.pairs.map(pair => pair.id), key.pairs.map(pair => pair.id));
    assert.deepEqual(key.pairs.map(pair => pair.position), key.pairs.map((_, index) => index));
    // Nothing moved up to the last rated pair; the others keep their order; the votes are untouched.
    assert.deepEqual(pairs.pairs.slice(0, 3), before.pairs.pairs.slice(0, 3));
    assert.deepEqual(pairs.pairs.filter(pair => before.pairs.pairs.some(item => item.id === pair.id)), before.pairs.pairs);
    assert.deepEqual(key.pairs.filter(pair => !isCatch(pair)).map(({ position, ...pair }) => pair), before.key.pairs.map(({ position, ...pair }) => pair));
    assert.equal(await readFile(join(dir, 'votes.jsonl'), 'utf8'), votesText);
    const catches = key.pairs.filter(isCatch);
    assert.equal(catches.length, 6);
    assert.ok(catches.every(pair => pair.position > 2));
    assert.equal(catches.filter(pair => pair.catch.correct === 'a').length, 3);
    assert.deepEqual(key.catch_pairs, { added_at: '2026-10-30T12:00:00.000Z', seed: 'catch', count: 6, objects, dev_set: 'dev', generator: key.catch_pairs.generator,
      categories: ['massing', 'roof'], min_changed_share: 0.15, after_position: 2 });
    // pairs.json: the same four fields as every pair, a real title and a variant of the study.
    const dev = await devModels();
    for (const pair of catches) {
      const shown = pairs.pairs.find(item => item.id === pair.id);
      assert.deepEqual(Object.keys(shown), ['id', 'title', 'variant', 'images']);
      assert.equal(shown.title, dev.get(pair.catch.object).model.title);
      assert.ok(['t2', 't4'].includes(shown.variant));
      assert.equal(pair[pair.catch.correct].kind, 'truth');
      assert.equal(pair[pair.catch.correct === 'a' ? 'b' : 'a'].group, pair.catch.group);
    }
    const publicText = JSON.stringify(pairs);
    for (const word of ['catch', 'drop', 'truth', 'correct', 'changed', 'house-0011', 'tower-0013', 'dev']) assert.ok(!publicText.includes(word), word + ' in pairs.json');
    // Drawn like the study: the truth side is the reference picture; the other differs in the views.
    for (const pair of catches) {
      const other = pair.catch.correct === 'a' ? 'b' : 'a';
      let differs = 0;
      for (const view of key.views) {
        const reference = await readFile(join(dir, 'images', pair.images[view.id].r));
        assert.ok(reference.equals(await readFile(join(dir, 'images', pair.images[view.id][pair.catch.correct]))));
        if (!reference.equals(await readFile(join(dir, 'images', pair.images[view.id][other])))) differs++;
      }
      assert.ok(differs >= 2, pair.id + ': ' + differs);
    }
    assert.equal((await readdir(join(dir, 'images'))).length, 9 * 3 * 4 + 6 * 3 * 4);

    // The analysis leaves them out of every agreement; qualify sees them.
    const { analysis } = await writeAnalysis(dir);
    assert.deepEqual([analysis.votes.pairs_total, analysis.votes.originals_total, analysis.votes.catch_total], [15, 8, 6]);
    assert.deepEqual(analysis.raters[0].curve.map(row => row.pairs).reduce((sum, n) => sum + n, 0), 8);
    const qualified = await qualifyStudy(dir);
    assert.deepEqual([qualified.catch_pairs, qualified.raters[0].catch.total, qualified.panel], [6, 6, []]);
    // Exported with the study; never added twice.
    const out = join(root, 'for-ann');
    assert.equal((await exportStudy({ dataRoot, name: 'unit', out })).pairs, 15);
    await assert.rejects(addCatchPairs({ dataRoot, name: 'unit', objects, seed: 'again' }), /already has catch pairs/);
  });
});

test('add-catch refuses once another rater has voted, stops voting while it runs, and is seeded', async () => {
  await withTemp(async root => {
    const dataRoot = join(root, 'data');
    await writeSampleRuns(dataRoot, { attempts: RUN_SPECS, withInputs: false });
    for (const name of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) await prepareStudy({ dataRoot, name, batches: ['demo-codex', 'demo-claude'], pairs: 8, seed: 'prep', size: { width: 48, height: 36 } });
    const objects = ['house-0011', 'hall-0014', 'structure-0015', 'retail-0012'];
    const pairsOf = name => readFile(join(studyDir(dataRoot, name), 'pairs.json'), 'utf8');
    const keyOf = name => readFile(join(studyDir(dataRoot, name), 'key.json'), 'utf8');
    const idAt = (pairsText, index) => JSON.parse(pairsText).pairs[index].id;
    const vote = (pair, rater) => JSON.stringify({ ...(rater ? { rater } : {}), pair, choice: 'a', ms: 1, at: 't' }) + '\n';
    // A rater's votes sent back, or votes of another rater taking turns on this machine.
    await writeFile(join(studyDir(dataRoot, 'one'), 'votes-ann.jsonl'), vote(idAt(await pairsOf('one'), 0), 'ann'));
    await assert.rejects(addCatchPairs({ dataRoot, name: 'one', objects, seed: 's' }), /votes-ann\.jsonl holds a rater's votes/);
    const four = await pairsOf('four');
    await writeFile(join(studyDir(dataRoot, 'four'), 'votes.jsonl'), vote(idAt(four, 0)) + vote(idAt(four, 2), 'ann') + vote(idAt(four, 1), 'lls'));
    await assert.rejects(addCatchPairs({ dataRoot, name: 'four', objects, seed: 's' }), /holds votes of ann, lls besides the owner \(r0\)[^\n]*--legacy-rater/);
    await assert.rejects(addCatchPairs({ dataRoot, name: 'four', objects, seed: 's', legacyRater: 'lls' }), /holds votes of ann besides the owner \(lls\)/);
    // With the owner named, their votes with and without the name are theirs: nothing goes before the last one.
    await writeFile(join(studyDir(dataRoot, 'four'), 'votes.jsonl'), vote(idAt(four, 0)) + vote(idAt(four, 2), 'lls'));
    assert.equal((await addCatchPairs({ dataRoot, name: 'four', objects, seed: 's', legacyRater: 'lls' })).after_position, 2);

    // Voting stops while it runs: held by another step, it refuses; a vote saved while it drew stops it before anything is written.
    const five = await pairsOf('five'), fiveDir = studyDir(dataRoot, 'five'), fiveKey = await keyOf('five');
    await writeFile(join(fiveDir, 'votes.jsonl'), vote(idAt(five, 0)));
    const unlock = await lockVoting(fiveDir);
    await assert.rejects(addCatchPairs({ dataRoot, name: 'five', objects, seed: 's' }), /add-catch is changing this study/);
    await unlock();
    let late = false;
    const log = () => { if (!late) { late = true; appendFileSync(join(fiveDir, 'votes.jsonl'), vote(idAt(five, 5))); } };
    await assert.rejects(addCatchPairs({ dataRoot, name: 'five', objects, seed: 's', log }), /votes changed while the catch pairs were drawn/);
    assert.deepEqual([await pairsOf('five'), await keyOf('five')], [five, fiveKey]);
    assert.ok(!(await readdir(fiveDir)).includes(VOTING_LOCK), 'the lock is released');
    assert.equal((await readdir(join(fiveDir, 'images'))).length, 9 * 3 * 4);
    assert.equal((await addCatchPairs({ dataRoot, name: 'five', objects, seed: 's' })).after_position, 5);
    // A vote being saved as add-catch starts is waited for, and counts.
    const six = await pairsOf('six'), sixDir = studyDir(dataRoot, 'six');
    const saving = await lockVoting(sixDir, { kind: 'vote' });
    const adding = addCatchPairs({ dataRoot, name: 'six', objects, seed: 's' });
    await new Promise(resolve => setTimeout(resolve, 50));
    appendFileSync(join(sixDir, 'votes.jsonl'), vote(idAt(six, 4)));
    await saving();
    assert.equal((await adding).after_position, 4);
    // Two runs at once: one adds its catch pairs, the other changes nothing (the study is read under the lock).
    const runs = await Promise.allSettled(['first', 'second'].map(seed => addCatchPairs({ dataRoot, name: 'seven', objects, seed })));
    assert.equal(runs.filter(run => run.status === 'fulfilled').length, 1);
    assert.match(runs.find(run => run.status === 'rejected').reason.message, /add-catch is changing this study|already has catch pairs/);
    const seven = JSON.parse(await keyOf('seven'));
    assert.equal(seven.pairs.filter(isCatch).length, 6);
    assert.equal(seven.catch_pairs.seed, runs[0].status === 'fulfilled' ? 'first' : 'second');

    await addCatchPairs({ dataRoot, name: 'two', objects, seed: 's', now: () => new Date(0) });
    await addCatchPairs({ dataRoot, name: 'three', objects, seed: 's', now: () => new Date(0) });
    // With no votes the catch pairs may go anywhere, and the same seed puts them in the same places.
    assert.equal(await pairsOf('two'), (await pairsOf('three')).replace('"three"', '"two"'));
    assert.equal(JSON.parse(await readFile(join(studyDir(dataRoot, 'two'), 'key.json'), 'utf8')).catch_pairs.after_position, -1);
  });
});

// Runs `run` with fs/promises' `name` failing whenever `fails(...arguments)` returns an error.
async function failing(name, fails, run) {
  const original = fsp[name];
  const stub = mock.method(fsp, name, (...args) => { const error = fails(...args); return error ? Promise.reject(error) : original(...args); });
  syncBuiltinESMExports();
  try { return await run(); } finally { stub.mock.restore(); syncBuiltinESMExports(); }
}

test('add-catch changes key.json and pairs.json together or not at all', async () => {
  await withTemp(async root => {
    const dataRoot = join(root, 'data');
    await writeSampleRuns(dataRoot, { attempts: RUN_SPECS, withInputs: false });
    await prepareStudy({ dataRoot, name: 'unit', batches: ['demo-codex', 'demo-claude'], pairs: 8, seed: 'prep', size: { width: 48, height: 36 } });
    const dir = studyDir(dataRoot, 'unit'), objects = ['house-0011', 'hall-0014', 'structure-0015', 'retail-0012'];
    const texts = async () => [await readFile(join(dir, 'key.json'), 'utf8'), await readFile(join(dir, 'pairs.json'), 'utf8')];
    const before = await texts();
    const leftovers = async () => (await readdir(dir)).filter(name => /tmp|before|lock/.test(name));
    const ioError = () => Object.assign(new Error('input/output error'), { code: 'EIO' });
    // pairs.json cannot be put in place: key.json goes back.
    await assert.rejects(failing('rename', (from, to) => String(to).endsWith('pairs.json') ? ioError() : null,
      () => addCatchPairs({ dataRoot, name: 'unit', objects, seed: 's' })), /could not write pairs\.json \(input\/output error\); key\.json was put back, nothing changed/);
    assert.deepEqual(await texts(), before);
    assert.deepEqual(await leftovers(), []);
    // Nor can key.json go back: the old one stays aside, and add-catch says how to recover.
    await assert.rejects(failing('rename', (from, to) => String(to).endsWith('pairs.json') || String(from).endsWith(KEY_BACKUP) ? ioError() : null,
      () => addCatchPairs({ dataRoot, name: 'unit', objects, seed: 's' })), /could not put the old key\.json back[^\n]*key\.json\.before-add-catch to [^\n]*key\.json before anyone votes/);
    assert.equal((await texts())[1], before[1]);
    assert.equal(await readFile(join(dir, KEY_BACKUP), 'utf8'), before[0]);
    await assert.rejects(addCatchPairs({ dataRoot, name: 'unit', objects, seed: 's' }), /an add-catch did not finish; [^\n]*key\.json\.before-add-catch is key\.json from before it/);
    await fsp.rename(join(dir, KEY_BACKUP), join(dir, 'key.json'));
    assert.deepEqual(await texts(), before);
    // The new files cannot be written: nothing changed.
    await assert.rejects(failing('writeFile', path => String(path).endsWith('.add-catch.tmp') ? ioError() : null,
      () => addCatchPairs({ dataRoot, name: 'unit', objects, seed: 's' })), /could not write the study \(input\/output error\); nothing changed/);
    assert.deepEqual(await texts(), before);
    assert.deepEqual(await leftovers(), []);
    assert.equal((await addCatchPairs({ dataRoot, name: 'unit', objects, seed: 's' })).added, 6);
    assert.deepEqual(await leftovers(), []);
  });
});
