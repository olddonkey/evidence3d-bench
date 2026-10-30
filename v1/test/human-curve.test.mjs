import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { STRATA } from '../lib/study/select.mjs';
import { mergeBins, binOf, humanCurve, curveMarkdown, writeHumanCurve, curveSampler, curveClusters, CURVE_SCHEMA, MIN_BIN_PAIRS } from '../lib/study/curve.mjs';
import { rng } from '../lib/rng.mjs';
import { buildLeaderboard, summaryMarkdown, parseRoster, parseHumanCurve, readHumanCurve, panelWinRate, humanEligible, writeReport } from '../lib/report/index.mjs';
import { indexPage } from '../lib/report/index-page.mjs';
import { writeSampleRuns } from '../lib/report/sample-runs.mjs';

// The human curve and the panel's half-score win rate (docs/V1-ROUND4-PLAN.md section 6).

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' is not within ' + tolerance + ' of ' + expected);
const NOW = new Date('2026-10-30T12:00:00Z');
const PANEL = ['ann', 'bob', 'cy'];

async function withTemp(run) {
  const root = await mkdtemp(join(tmpdir(), 'e3d-human-'));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

// An original pair as panelOriginals gives it: A scored `a`, B scored `b`
// (shape and detail both equal to the score, so every weighting agrees unless
// `shape` / `detail` are given), and the panel's choice as shown.
const side = (score, shape = score, detail = score) => ({ score, shape_score: shape, detail_score: detail });
const original = (id, object, a, b, choice) => ({ id, object, a: typeof a === 'number' ? side(a) : a, b: typeof b === 'number' ? side(b) : b, choice });

// `count` pairs at `gap` on objects o0..o(objects - 1) in turn, with the given
// outcomes relative to the higher-scored side (cycled).
function band(prefix, count, gap, outcomes, { objects = 6, higherOnA = true } = {}) {
  const list = [];
  for (let i = 0; i < count; i++) {
    const outcome = outcomes[i % outcomes.length], high = higherOnA ? 'a' : 'b', low = higherOnA ? 'b' : 'a';
    const choice = outcome === 'higher' ? high : outcome === 'lower' ? low : 'tie';
    list.push(original(prefix + i, 'o' + (i % objects), higherOnA ? 50 + gap : 50, higherOnA ? 50 : 50 + gap, choice));
  }
  return list;
}

test('bins: a short stratum merges into the next one up and is checked again; the largest merges down; fewer than two is no curve', () => {
  const ids = bins => bins.map(bin => bin.strata.join('+') + ':' + bin.pairs);
  assert.deepEqual(ids(mergeBins([12, 15, 11, 30])), ['0-3:12', '3-8:15', '8-15:11', '15-100:30']);
  // [0, 3) short: into [3, 8); still short, so into [8, 15) too.
  assert.deepEqual(ids(mergeBins([3, 4, 5, 20])), ['0-3+3-8+8-15:12', '15-100:20']);
  assert.deepEqual(ids(mergeBins([3, 12, 4, 20])), ['0-3+3-8:15', '8-15+15-100:24']);
  // The largest short after the upward pass: into the one below.
  // [8, 15) short: into [15, 100], still short and now the largest: into [3, 8).
  assert.deepEqual(ids(mergeBins([30, 12, 4, 5])), ['0-3:30', '3-8+8-15+15-100:21']);
  assert.deepEqual(ids(mergeBins([30, 12, 11, 9])), ['0-3:30', '3-8:12', '8-15+15-100:20']);
  assert.deepEqual(ids(mergeBins([5, 2, 1, 1])), ['0-3+3-8+8-15+15-100:9']);
  assert.deepEqual(ids(mergeBins([0, 0, 0, 25])), ['0-3+3-8+8-15+15-100:25']);
  assert.equal(MIN_BIN_PAIRS, 10);
  const bins = mergeBins([12, 15, 11, 30]);
  assert.deepEqual([0, 2.99, 3, 7.99, 8, 15, 99.9, 100, 100.01, -1, NaN].map(gap => binOf(gap, bins)), [0, 0, 1, 1, 2, 3, 3, 3, -1, -1, -1]);
  assert.deepEqual(bins.map(bin => [bin.min, bin.max]), STRATA.map(stratum => [stratum.min, stratum.max]));
});

test('the curve by hand: equal scores apart, three shares and W per bin, intervals, and none at 0 or 1', () => {
  const originals = [
    ...band('s', 12, 1, ['higher', 'tie', 'lower', 'higher']),          // [0, 3): 6 higher, 3 tie, 3 lower
    ...band('m', 10, 5, ['higher', 'higher', 'tie', 'higher', 'lower'], { higherOnA: false }), // [3, 8): 6, 2, 2
    ...band('l', 10, 10, ['higher']),                                     // [8, 15): all higher
    ...band('x', 10, 30, ['higher', 'higher', 'higher', 'higher', 'tie']), // [15, 100]: 8 higher, 2 tie
    // Equal scores in the curve's sense (gap < 0.05), whatever the panel said.
    original('e1', 'o1', 70.15, 70.11, 'a'), original('e2', 'o2', 50, 50, 'tie'), original('e3', 'o3', 40.04, 40, 'b'),
  ];
  // 0.15 - 0.10 is 0.04999999999999999 in floating point: still a gap of 0.05, binned.
  originals.push(original('f1', 'o4', 0.15, 0.10, 'a'));
  const curve = humanCurve(originals, { panel: PANEL, seed: 'hand', samples: 2000 });
  assert.equal(curve.schema, CURVE_SCHEMA);
  assert.equal(curve.available, true);
  assert.deepEqual(curve.scorer, { version: '1.1.0', weights: null });
  assert.deepEqual(curve.equal.panel, { a: 1, tie: 1, b: 1 });
  assert.equal(curve.equal.pairs, 3);
  assert.deepEqual(curve.stratum_pairs, { '0-3': 13, '3-8': 10, '8-15': 10, '15-100': 10 });
  assert.deepEqual(curve.bins.map(bin => [bin.strata, bin.pairs, bin.counts]), [
    [['0-3'], 13, { higher: 7, tie: 3, lower: 3 }], [['3-8'], 10, { higher: 6, tie: 2, lower: 2 }],
    [['8-15'], 10, { higher: 10, tie: 0, lower: 0 }], [['15-100'], 10, { higher: 8, tie: 2, lower: 0 }]]);
  const [small, , large, top] = curve.bins;
  near(small.shares.higher.value, 7 / 13);
  near(small.shares.half_win.value, (7 + 1.5) / 13);
  near(top.shares.half_win.value, 0.9);
  for (const bin of curve.bins) for (const share of Object.values(bin.shares)) {
    if (share.ci95) assert.ok(share.ci95[0] <= share.value + 1e-12 && share.value <= share.ci95[1] + 1e-12, JSON.stringify(share));
  }
  // A share of exactly 0 or 1 has no interval (section 4), the half-score win rate included.
  assert.deepEqual([large.shares.higher, large.shares.tie, large.shares.half_win, top.shares.lower].map(share => [share.value, share.ci95, share.interval]),
    [[1, null, 'boundary'], [0, null, 'boundary'], [1, null, 'boundary'], [0, null, 'boundary']]);
  assert.ok(small.shares.higher.ci95 && small.shares.higher.ci95[0] < small.shares.higher.ci95[1]);
  assert.equal(curve.bootstrap.clusters, 6);
  // Seeded: the same seed gives the same curve; the seed moves only the intervals, never the shares.
  assert.deepEqual(humanCurve(originals, { panel: PANEL, seed: 'hand', samples: 2000 }), curve);
  const other = humanCurve(originals, { panel: PANEL, seed: 'other', samples: 2000 });
  assert.equal(other.seed, 'other');
  assert.deepEqual(other.bins.map(bin => [bin.counts, Object.values(bin.shares).map(share => share.value)]),
    curve.bins.map(bin => [bin.counts, Object.values(bin.shares).map(share => share.value)]));
  assert.match(curve.notes.join(' '), /assumes that the gap a human can see does not depend on the task set/);
  assert.doesNotMatch(curve.notes.join(' '), /only 2 qualified raters/);
  const markdown = curveMarkdown(curve);
  assert.match(markdown, /\| \[0, 3\) \| 0-3 \| 13 \| 6 \|/);
  assert.match(markdown, /\| \[15, 100\] \| 15-100 \| 10 \|/);
  assert.match(markdown, /Pairs with equal scores \(gap < 0\.05\), in no bin: 3 \(panel: A 1, cannot tell 1, B 1\)/);
  assert.throws(() => humanCurve(originals, { panel: PANEL }), /needs a seed/);
  assert.throws(() => humanCurve([original('z', 'o1', 60, 50, 'maybe')], { panel: PANEL, seed: 1 }), /must be a, tie or b/);
});

test('the curve rebins at the scorer\'s weights, needs two raters, and says when the data are too few', () => {
  // Gap 2 at 1.1.0 (shape 60 / 52, detail 40 / 44): at 65/35 the gap is 0.65 * 8 - 0.35 * 4 = 3.8, the other bin.
  const moving = original('w', 'o1', side(50, 60, 40), side(48, 52, 44), 'a');
  const filler = [...band('s', 10, 1, ['higher']), ...band('m', 10, 5, ['lower'])];
  const at110 = humanCurve([moving, ...filler], { panel: PANEL, seed: 'w', samples: 200 });
  const at120 = humanCurve([moving, ...filler], { panel: PANEL, seed: 'w', samples: 200, weights: { shape: 0.65, detail: 0.35 } });
  assert.deepEqual(at110.bins.map(bin => bin.pairs), [11, 10]);
  assert.deepEqual(at120.bins.map(bin => bin.pairs), [10, 11]);
  assert.deepEqual(at120.scorer, { version: '1.2.0', weights: { id: '65/35', shape: 0.65, detail: 0.35 } });
  assert.equal(at120.pairs.find(pair => pair.id === 'w').gap, 3.8);
  assert.throws(() => humanCurve(filler, { panel: PANEL, seed: 'w', weights: { shape: 0.6, detail: 0.4 } }), /one of the candidates/);
  // Fewer than two qualified raters: panelOriginals gives null and there is no curve.
  const none = humanCurve(null, { panel: ['ann'], seed: 'w' });
  assert.deepEqual([none.available, none.reason, none.panel.size], [false, 'panel', 1]);
  assert.match(curveMarkdown(none), /fewer than 2 qualified raters/);
  // Fewer than two bins of ten after merging: 人眼数据不够.
  const few = humanCurve(band('s', 9, 1, ['higher']), { panel: PANEL, seed: 'w' });
  assert.deepEqual([few.available, few.reason, few.bins.length], [false, 'too_few_pairs', 1]);
  assert.match(curveMarkdown(few), /人眼数据不够/);
  // Two raters: the report says that "cannot tell" is more frequent.
  assert.match(humanCurve(filler, { panel: ['ann', 'bob'], seed: 'w', samples: 100 }).notes.join(' '), /only 2 qualified raters/);
});

test('one draw of the objects serves every bin; a draw that leaves a bin empty is drawn again and counted', () => {
  // The [3, 8) bin rests on one object of ten: about (9/10)^10 = 35 % of draws miss it.
  const originals = [...band('s', 20, 1, ['higher', 'lower'], { objects: 10 }), ...Array.from({ length: 10 }, (_, i) => original('m' + i, 'o0', 55, 50, i % 3 ? 'a' : 'tie'))];
  const curve = humanCurve(originals, { panel: PANEL, seed: 'empty', samples: 1000 });
  assert.ok(curve.bootstrap.redrawn > 200 && curve.bootstrap.redrawn < 800, 'redrawn ' + curve.bootstrap.redrawn);
  assert.equal(curve.bootstrap.resamples, 1000);
  // All its pairs on one object: every resample gives the same shares, so none has an interval
  // (6 higher, 4 tie, no lower: the lower share is 0, which has none anyway).
  const shares = curve.bins[1].shares;
  assert.deepEqual([shares.higher, shares.tie, shares.half_win, shares.lower].map(share => [share.ci95, share.interval]),
    [[null, 'constant'], [null, 'constant'], [null, 'constant'], [null, 'boundary']]);
  // The sampler sums whole objects: the bins of a draw add up to the drawn objects' pairs.
  const clusters = curveClusters(curve.pairs, curve.bins.length), sampler = curveSampler(clusters, curve.bins.length, rng('sum'));
  const totals = sampler.draw();
  assert.ok(totals.reduce((sum, value) => sum + value, 0) % 1 === 0);
});

// ----------------------------------------------------------------- the report

// A curve the report reads: W = 0.6 in [0, 3), 0.8 in [3, 100] (pairs on six objects).
function reportCurve({ version = '1.1.0' } = {}) {
  const originals = [...band('s', 10, 1, ['higher', 'higher', 'tie', 'tie', 'lower']), ...band('l', 10, 10, ['higher', 'higher', 'higher', 'tie', 'tie', 'higher', 'higher', 'higher', 'lower', 'higher'])];
  const curve = humanCurve(originals, { panel: PANEL, seed: 'report', samples: 500, study: { name: 'unit' } });
  return JSON.parse(JSON.stringify({ ...curve, scorer: { ...curve.scorer, version } }));
}

const attempt = (config, task, object, score, extra = {}) => ({ batch: config, task_id: task, attempt: 1, slot: 'a1', system: config, model: 'm', effort: 'high', status: 'ok',
  excluded: false, valid: true, score, object, variant: 't2', set: 'test', archetype: 'house', scale_evidence: 'none', usage: null, wall_seconds: null, cost_usd: null,
  model_path: '/runs/' + config + '/' + task + '/model.glb',
  report: { valid: true, score, scorer: { version: '1.1.0', sha256: 'f'.repeat(64) }, alignment: { frame_error: { offset_fraction: 0, offset_m: 0, yaw_deg: 0 } }, detail: { score: 0 }, shape: { scale: 1 } },
  ...extra });

test('the panel half-score win rate of A by hand: W per task, 1 - W, 0.5, tasks outside the curve, averaged like the score', () => {
  const curve = parseHumanCurve(reportCurve());
  near(curve.half_win[0], 0.6);
  near(curve.half_win[1], 0.8);
  const A = [
    attempt('A', 'o1-t2', 'o1', 61), attempt('A', 'o1-t4', 'o1', 50, { variant: 't4' }),   // +1 -> 0.6; -10 -> 1 - 0.8
    attempt('A', 'o2-t2', 'o2', 70.02),                                                      // +0.02: equal scores -> 0.5
    attempt('A', 'o2-t1', 'o2', 90, { variant: 't1' }),                                      // t1: not what the curve measured
    attempt('A', 'o3-t2', 'o3', 0, { valid: false, failure: 'invalid' }),                    // A failed: left out
    attempt('A', 'o3-t4', 'o3', 0, { variant: 't4', valid: false, failure: 'integrity problems: x' }),
    attempt('A', 'o4-t2', 'o4', 40, { status: 'infra_error', excluded: true }),             // not a sample at all
  ];
  const B = [
    attempt('B', 'o1-t2', 'o1', 60), attempt('B', 'o1-t4', 'o1', 60, { variant: 't4' }),
    attempt('B', 'o2-t2', 'o2', 70), attempt('B', 'o2-t1', 'o2', 10, { variant: 't1' }),
    attempt('B', 'o3-t2', 'o3', 50), attempt('B', 'o3-t4', 'o3', 50, { variant: 't4' }), attempt('B', 'o4-t2', 'o4', 40),
  ];
  const human = panelWinRate(A, B, curve, { seed: 'pair', samples: 400 });
  // o1: (0.6 + 0.2) / 2; o2: 0.5; o3 has no covered task.
  near(human.win_rate_a, ((0.6 + 0.2) / 2 + 0.5) / 2);
  assert.deepEqual([human.tasks, human.tasks_paired, human.objects, human.attempt_pairs, human.equal_scores], [3, 6, 2, 3, 1]);
  near(human.share, 0.5);
  assert.ok(human.ci95[0] < human.win_rate_a && human.win_rate_a < human.ci95[1]);
  assert.equal(human.samples, 400);
  // The other way round: 1 - the value.
  near(panelWinRate(B, A, curve, { seed: 'pair', samples: 400 }).win_rate_a, 1 - human.win_rate_a);
  assert.equal(humanEligible(A[3], curve), false);
  // Several attempts per task: every pair of eligible attempts counts once within the task.
  const twice = panelWinRate([attempt('A', 'o1-t2', 'o1', 61), attempt('A', 'o1-t2', 'o1', 45, { slot: 'a2' })], [attempt('B', 'o1-t2', 'o1', 60)], curve, { samples: 10 });
  near(twice.win_rate_a, (0.6 + 0.2) / 2);
  assert.deepEqual([twice.attempt_pairs, twice.interval], [2, 'few_objects']);
  // A value of 1: every task in the top bin with W = ... 1 needs W = 1; with no
  // covered task there is no value at all.
  const empty = panelWinRate([attempt('A', 'o3-t2', 'o3', 0, { valid: false })], [attempt('B', 'o3-t2', 'o3', 50)], curve);
  assert.deepEqual([empty.win_rate_a, empty.interval, empty.tasks, empty.tasks_paired], [null, 'no_value', 0, 1]);
});

test('the two-level interval carries the curve\'s own uncertainty', () => {
  const curve = parseHumanCurve(reportCurve());
  // Twelve objects, A ahead by 5 everywhere: only the curve varies between resamples of the pair's objects.
  const A = Array.from({ length: 12 }, (_, o) => attempt('A', 'o' + o + '-t2', 'o' + o, 60)), B = Array.from({ length: 12 }, (_, o) => attempt('B', 'o' + o + '-t2', 'o' + o, 55));
  const human = panelWinRate(A, B, curve, { seed: 'two-level', samples: 2000 });
  near(human.win_rate_a, 0.8);
  // The curve's own interval for its [3, 100] bin, which is all this pair looks up.
  const bin = curve.bins[1].shares.half_win;
  assert.ok(human.ci95[1] - human.ci95[0] > 0.5 * (bin.ci95[1] - bin.ci95[0]), JSON.stringify([human.ci95, bin.ci95]));
  assert.deepEqual(panelWinRate(A, B, curve, { seed: 'two-level', samples: 2000 }), human);
  // The real tier asks for 8 objects.
  const few = panelWinRate(A.slice(0, 5), B.slice(0, 5), curve, { minObjects: 8, fewReason: 'real_tier' });
  assert.deepEqual([few.ci95, few.interval], [null, 'real_tier']);
});

test('a curve file is refused when its bins or shares do not match its pairs', () => {
  const good = reportCurve();
  assert.equal(parseHumanCurve(good).available, true);
  assert.throws(() => parseHumanCurve({ ...good, schema: 'x' }), /schema must be/);
  const tampered = JSON.parse(JSON.stringify(good));
  tampered.bins[1].shares.half_win.value = 0.99;
  assert.throws(() => parseHumanCurve(tampered), /half_win does not match its pairs/);
  const gap = JSON.parse(JSON.stringify(good));
  gap.bins[1].min = 4;
  assert.throws(() => parseHumanCurve(gap), /does not continue/);
  const unavailable = humanCurve(null, { panel: [], seed: 1 });
  assert.equal(parseHumanCurve(JSON.parse(JSON.stringify(unavailable))).available, false);
});

// Hand-made attempts, one per task, t2 / t4 / c1 on `objects` objects: [system, model, effort, mean].
function design(configurations, { objects = 10, version = '1.1.0' } = {}) {
  const random = rng('human-design'), attempts = [];
  for (let o = 0; o < objects; o++) {
    for (const [system, model, effort, base] of configurations) {
      for (const variant of ['t2', 't4', 'c1']) {
        const score = Math.round(100 * Math.max(0, Math.min(100, base + 6 * (random.next() - 0.5)))) / 100;
        attempts.push(attempt(system, 'o' + o + '-' + variant, 'o' + o, score, { batch: [system, model, effort].join('-'), system, model, effort, variant,
          report: { ...attempt(system, 'x', 'o', score).report, scorer: { version, sha256: 'f'.repeat(64) } } }));
      }
    }
  }
  return { attempts, batches: [], problems: [] };
}
const FOUR = [['codex', 'astra', 'high', 70], ['codex', 'astra', 'max', 76], ['claude-code', 'opus', 'high', 66], ['claude-code', 'opus', 'max', 72]];
const keyOf = (system, model, effort) => [system, model, effort].join(' / ');
const ROSTER = parseRoster({ schema: 'e3d-roster-v1', round: 'test', configurations: [
  { system: 'codex', model: 'astra', effort: 'high', ladder: 'default' }, { system: 'codex', model: 'astra', effort: 'max', ladder: 'top' },
  { system: 'claude-code', model: 'opus', effort: 'high', ladder: 'default' }, { system: 'claude-code', model: 'opus', effort: 'max', ladder: 'top' }] });

test('the leaderboard: every pair, ladder pair and effort pair carries the column, oriented like its row', () => {
  const curve = parseHumanCurve(reportCurve(), { file: 'study/unit/human-curve.json', sha256: 'a'.repeat(64) });
  const board = buildLeaderboard(design(FOUR), { now: NOW, roster: ROSTER, humanCurve: curve });
  const set = board.sets[0];
  assert.deepEqual(set.human, { available: true, reason: null, versions: ['1.1.0'] });
  assert.ok(set.pairwise.pairs.every(pair => pair.human && Number.isFinite(pair.human.win_rate_a) && pair.human.tasks === 30 && pair.human.share === 1));
  const all = new Map(set.pairwise.pairs.map(pair => [pair.a + '|' + pair.b, pair]));
  for (const ladder of set.ladders) {
    for (const pair of ladder.pairwise.pairs) {
      const same = all.get(pair.a + '|' + pair.b), other = all.get(pair.b + '|' + pair.a);
      if (same) assert.deepEqual(pair.human, same.human);
      else { near(pair.human.win_rate_a, 1 - other.human.win_rate_a); near(pair.human.ci95[0], 1 - other.human.ci95[1]); }
    }
  }
  const effort = set.effort.pairs.find(pair => pair.model === 'astra');
  const astra = all.get(keyOf('codex', 'astra', 'max') + '|' + keyOf('codex', 'astra', 'high')) ?? all.get(keyOf('codex', 'astra', 'high') + '|' + keyOf('codex', 'astra', 'max'));
  near(effort.human.win_rate_a, astra.a === keyOf('codex', 'astra', 'max') ? astra.human.win_rate_a : 1 - astra.human.win_rate_a);
  // Higher-ranked A wins more than half the time on these gaps.
  const top = set.pairwise.pairs[0];
  assert.ok(top.human.win_rate_a > 0.5);
  assert.equal(board.human_curve.file, 'study/unit/human-curve.json');
  assert.equal(board.human_curve.pairs, undefined, 'the leaderboard does not copy the study\'s pairs');
  assert.match(board.method.human_win_rate, /not the probability that the panel prefers A/);

  const html = indexPage(board);
  assert.match(html, /<h2 id="human-curve">Human curve<\/h2>/);
  assert.match(html, /Panel &frac12;-win of A<small>half-score win rate, 95%<\/small>/);
  assert.match(html, /30 \/ 30 tasks/);
  assert.match(html, /assumes that the gap a human can see does not depend on the task set/);
  const markdown = summaryMarkdown(board);
  assert.match(markdown, /\| Panel half-score win rate of A \[95%\] \|/);
  assert.match(markdown, /## Human curve/);
  assert.match(markdown, /\| \[3, 100\] \| 10 \|/);

  // Without a curve: no column, no section, nothing in the JSON.
  const plain = buildLeaderboard(design(FOUR), { now: NOW, roster: ROSTER });
  assert.equal(plain.human_curve, null);
  assert.equal(plain.sets[0].human, null);
  assert.ok(plain.sets[0].pairwise.pairs.every(pair => pair.human === null));
  assert.doesNotMatch(indexPage(plain), /Human curve|Panel &frac12;-win/);
  // The same numbers as before the column existed.
  assert.deepEqual(plain.sets[0].pairwise.pairs.map(pair => [pair.mean_difference, pair.ci95, pair.verdict, pair.holm]),
    set.pairwise.pairs.map(pair => [pair.mean_difference, pair.ci95, pair.verdict, pair.holm]));
});

test('the column needs the curve\'s scorer, and an unavailable curve says why', () => {
  const curve = parseHumanCurve(reportCurve({ version: '1.2.0' }));
  const board = buildLeaderboard(design(FOUR), { now: NOW, humanCurve: curve });
  assert.deepEqual(board.sets[0].human, { available: false, reason: 'scorer', versions: ['1.1.0'] });
  assert.ok(board.sets[0].pairwise.pairs.every(pair => pair.human === null));
  assert.ok(board.problems.some(problem => /no panel half-score win rate: the human curve .* is for scorer 1\.2\.0, the reports of this set were scored by 1\.1\.0/.test(problem)));
  assert.match(indexPage(board), /No panel half-score win rate<\/strong> in this set: the reports were not all scored by the scorer the curve was made for \(1\.1\.0\)/);
  // Unstamped reports are not the curve's scorer either.
  const unstamped = design(FOUR);
  for (const item of unstamped.attempts) delete item.report.scorer;
  assert.deepEqual(buildLeaderboard(unstamped, { now: NOW, humanCurve: parseHumanCurve(reportCurve()) }).sets[0].human.versions, ['unstamped']);

  const none = parseHumanCurve(JSON.parse(JSON.stringify(humanCurve(null, { panel: ['ann'], seed: 1 }))));
  const without = buildLeaderboard(design(FOUR), { now: NOW, humanCurve: none });
  assert.deepEqual(without.sets[0].human, { available: false, reason: 'panel', versions: [] });
  assert.match(indexPage(without), /<strong>No human curve:<\/strong> fewer than 2 qualified raters/);
  assert.match(summaryMarkdown(without), /\*\*No human curve\*\*: fewer than 2 qualified raters/);
});

test('study.mjs curve and report --human-curve, end to end on files', async () => {
  await withTemp(async root => {
    // A study directory with key.json and three raters' votes.
    const dir = join(root, 'study'), key = { name: 'unit', created_at: '2026-10-05T00:00:00.000Z', batches: ['b1'], strata: STRATA, pairs: [] };
    const originals = [...band('s', 12, 1, ['higher', 'tie', 'lower']), ...band('l', 12, 10, ['higher', 'higher', 'tie'])];
    key.pairs = originals.map(pair => ({ id: pair.id, object: pair.object, repeat_of: null, a: pair.a, b: pair.b, stratum: pair.id.startsWith('s') ? '0-3' : '8-15' }));
    // Ten repeats (sides swapped) and six catch pairs, so that every rater can qualify (section 5.1).
    const opposite = { a: 'b', b: 'a', tie: 'tie' };
    const repeats = originals.slice(0, 10).map(pair => ({ id: 'r-' + pair.id, object: pair.object, repeat_of: pair.id, a: pair.b, b: pair.a, choice: opposite[pair.choice] }));
    const catches = Array.from({ length: 6 }, (_, i) => ({ id: 'c' + i, object: 'dev' + i, repeat_of: null, a: side(80), b: side(60), catch: { correct: i % 2 ? 'a' : 'b' } }));
    key.pairs.push(...repeats.map(({ choice, ...pair }) => pair), ...catches);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'key.json'), JSON.stringify(key));
    // ann and bob agree with the panel's choice; cy says the opposite on every original (and its
    // repeat, so cy is consistent) but gets the catch pairs right: on the panel, outvoted.
    const lines = rater => [...originals, ...repeats].map(pair => JSON.stringify({ rater, pair: pair.id, choice: rater === 'cy' ? opposite[pair.choice] : pair.choice, ms: 1, at: 't' }))
      .concat(catches.map(pair => JSON.stringify({ rater, pair: pair.id, choice: pair.catch.correct, ms: 1, at: 't' }))).join('\n') + '\n';
    await writeFile(join(dir, 'votes.jsonl'), lines('ann'));
    await writeFile(join(dir, 'votes-bob.jsonl'), lines('bob'));
    await writeFile(join(dir, 'votes-cy.jsonl'), lines('cy'));
    // Like G1, only with the panel named.
    await assert.rejects(writeHumanCurve(dir, { seed: 'files' }), /needs the named panel/);
    const { curve, files } = await writeHumanCurve(dir, { seed: 'files', raters: PANEL, samples: 300 });
    assert.deepEqual(curve.panel.raters, ['ann', 'bob', 'cy']);
    assert.deepEqual(curve.bins.map(bin => bin.counts), [{ higher: 4, tie: 4, lower: 4 }, { higher: 8, tie: 4, lower: 0 }]);
    assert.deepEqual(curve.study.votes_files, ['votes.jsonl', 'votes-bob.jsonl', 'votes-cy.jsonl']);
    assert.match(await readFile(files[1], 'utf8'), /# Human curve: unit/);
    await assert.rejects(writeHumanCurve(dir, { seed: 'files', raters: ['ann', 'dee'] }), /no votes for rater dee/);

    // The report reads it; the sample runs' reports get the curve's scorer stamp.
    const data = join(root, 'data');
    const sample = await writeSampleRuns(data);
    for (const batch of await readdir(join(data, 'runs'))) {
      for (const task of await readdir(join(data, 'runs', batch)).catch(() => [])) {
        for (const slot of await readdir(join(data, 'runs', batch, task)).catch(() => [])) {
          const file = join(data, 'runs', batch, task, slot, 'score', 'report.json');
          const report = await readFile(file, 'utf8').then(JSON.parse, () => null);
          if (report) await writeFile(file, JSON.stringify({ ...report, scorer: { ...(report.scorer ?? {}), version: '1.1.0' } }));
        }
      }
    }
    const read = await readHumanCurve(files[0]);
    assert.equal(read.file, 'human-curve.json');
    assert.match(read.sha256, /^[a-f0-9]{64}$/);
    const out = join(root, 'report');
    const summary = await writeReport({ dataRoot: data, batches: sample.batches, outDir: out, now: NOW, humanCurve: read });
    const html = await readFile(join(out, 'index.html'), 'utf8');
    assert.match(html, /Human curve/);
    const board = JSON.parse(await readFile(join(out, 'leaderboard.json'), 'utf8'));
    assert.equal(board.human_curve.sha256, read.sha256);
    const withColumn = board.sets.filter(set => set.human?.available);
    assert.ok(withColumn.length, 'some set carries the column');
    for (const set of withColumn) for (const pair of set.pairwise.pairs) assert.ok(pair.human, set.id + ' ' + pair.a + ' vs ' + pair.b);
    assert.ok(summary.sets.some(set => set.pairs.some(pair => 'panel_half_win_a' in pair)));
  });
});
