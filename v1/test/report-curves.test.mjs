import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLeaderboard, collectRuns, summaryMarkdown } from '../lib/report/index.mjs';
import { scoreAt, timeToShare, curveTicks, timeCurve, T95_MIN_FINAL } from '../lib/report/curves.mjs';
import { timeSection, timeMarkdown } from '../lib/report/time-chart.mjs';
import { indexPage } from '../lib/report/index-page.mjs';
import { mean } from '../lib/report/stats.mjs';

// The score-over-time curve (v1/lib/report/curves.mjs) from the runner's
// snapshots (result.json snapshots[], v1/lib/runner/snapshots.mjs).

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' is not within ' + tolerance + ' of ' + expected);
const NOW = new Date('2026-10-28T12:00:00Z');

// One attempt as collectRuns normalises it. points: [[t, score, status?, taken at?], ...].
const attempt = (fields = {}) => {
  const { object = 'x', variant = 't2', score = 80, wall = 1000, limit = 1800, points = [], interval = 300, system = 's', model = 'm', ...rest } = fields;
  return { batch: 'b', task_id: object + '-' + variant, attempt: 1, system, model, effort: null, status: 'completed', excluded: false, valid: score > 0, score,
    object, variant, scale_evidence: 'none', usage: null, wall_seconds: wall, wall_limit_seconds: limit, cost_usd: null,
    snapshots: points === null ? null : { interval_seconds: interval, points: points.map(([t, value, status = value === null ? 'score_error' : 'scored', at = t]) => ({ t, at, score: value, status })) },
    report: score > 0 ? { valid: true, score, shape_score: score, detail: { score }, alignment: { frame_error: { offset_fraction: 0, offset_m: 0, yaw_deg: 0 } }, shape: { scale: 1 } } : null,
    ...rest };
};

// metric() as cellEntry passes it, reduced to the plain mean over attempts
// (one per object here); a missing value leaves its attempt out, as there.
const plainMetric = attempts => (name, valueOf) => {
  const values = attempts.map(valueOf).filter(value => Number.isFinite(value));
  return { mean: mean(values), ci95: null, objects: values.length };
};

test('an attempt counts its last snapshot while running, 0 before any model, and its final score once ended', () => {
  const a = attempt({ score: 80, wall: 1000, points: [[300, 0, 'absent'], [600, 40], [900, null]] });
  assert.equal(scoreAt(a, 300), 0);
  assert.equal(scoreAt(a, 450), 0, 'between ticks the last snapshot holds');
  assert.equal(scoreAt(a, 600), 40);
  assert.equal(scoreAt(a, 900), null, 'a snapshot the scorer failed on is missing, not 0');
  assert.equal(scoreAt(a, 1200), 80, 'ended at 1000 s: the final score');
  const timedOut = attempt({ score: 55, wall: 1805, points: [[300, 10], [1500, 50]] });
  assert.equal(scoreAt(timedOut, 1500), 50);
  assert.equal(scoreAt(timedOut, 1800), 55, 'at the wall-clock limit every attempt has its final score');
  const failed = attempt({ score: 0, wall: 1200, points: [[300, 70]] });
  assert.equal(scoreAt(failed, 600), 70); assert.equal(scoreAt(failed, 1500), 0, 'a failure ends at 0 as on the leaderboard');
});

test('an attempt whose snapshot the scorer failed on is left out of that tick and counted as missing', () => {
  const attempts = [attempt({ object: 'x', score: 80, wall: 1000, points: [[300, 40], [600, null, 'score_error']] }),
    attempt({ object: 'y', score: 60, wall: 1000, points: [[300, 20], [600, 50]] }),
    attempt({ object: 'z', score: 70, wall: 1000, points: [[300, null, 'lost'], [600, 0, 'refused']] })];
  const curve = timeCurve(attempts, plainMetric(attempts));
  assert.deepEqual(curve.points.slice(0, 2).map(point => [point.t, point.mean, point.objects, point.missing]), [[300, 30, 2, 1], [600, 25, 2, 1]]);
  assert.equal(curve.score_errors, 2);
  const board = buildLeaderboard({ attempts, batches: [], problems: [] }, { now: NOW });
  const point = board.entries[0].time_curve.points[1];
  near(point.mean, 25); assert.equal(point.missing, 1); assert.equal(point.objects, 2, 'the object with only a missing attempt is not in that tick');
  assert.match(timeSection(board.entries), /1 missing/); assert.match(timeMarkdown(board.entries), /25\.0 \(1 missing\)/);
});

test('a snapshot read late counts from when it was taken, not from its tick', () => {
  // The t = 300 tick was read at 650 s (a busy runner): its model is not the attempt's state at 300 or 600 s.
  const late = attempt({ score: 80, wall: 1700, points: [[300, 78, 'scored', 650], [600, 78, 'scored', 660]] });
  assert.equal(scoreAt(late, 300), 0); assert.equal(scoreAt(late, 600), 0); assert.equal(scoreAt(late, 900), 78);
  assert.equal(timeToShare(late), 650);
});

test('time to 95%: the first snapshot at 95% of the final score, else the end; low finals are left out', () => {
  assert.equal(timeToShare(attempt({ score: 80, wall: 1700, points: [[300, 20], [600, 76], [900, 60], [1200, 79]] })), 600, '76 >= 0.95 x 80; a later dip does not matter');
  assert.equal(timeToShare(attempt({ score: 80, wall: 1700, points: [[300, 20], [600, 70]] })), 1700, 'no snapshot got there: the end');
  assert.equal(timeToShare(attempt({ score: 80, wall: 1700, points: [[300, null]] })), 1700);
  assert.equal(timeToShare(attempt({ score: T95_MIN_FINAL - 0.5, points: [[300, 9]] })), null);
  assert.equal(timeToShare(attempt({ score: 90, wall: null, limit: 1800, points: [] })), 1800, 'no wall time recorded: the limit');
});

test('ticks run to the longest wall-clock limit, which is always a tick', () => {
  assert.deepEqual(curveTicks([attempt({ limit: 1800 })]), [300, 600, 900, 1200, 1500, 1800]);
  assert.deepEqual(curveTicks([attempt({ limit: 1000, interval: 400 })]), [400, 800, 1000]);
  assert.deepEqual(curveTicks([attempt({ limit: 1200, interval: 600 }), attempt({ limit: 1200, interval: 300 })]), [300, 600, 900, 1200]);
});

test('a curve needs snapshots on every counted attempt', () => {
  const attempts = [attempt({ object: 'x' }), attempt({ object: 'y', points: null })];
  const partial = timeCurve(attempts, plainMetric(attempts));
  assert.equal(partial.available, false); assert.match(partial.reason, /1 of 2 counted attempts have no snapshots/);
  assert.equal(timeCurve([attempt({ points: null })], plainMetric([])), null);
});

test('the curve is averaged like the score and ends at the leaderboard score; time to 95% is a median over attempts', () => {
  const attempts = [
    // x: two attempts on one task, averaged first (the object weighs the same as y).
    attempt({ object: 'x', score: 80, wall: 1100, points: [[300, 0, 'absent'], [600, 40], [900, 78]] }),
    attempt({ object: 'x', score: 60, wall: 1805, points: [[300, 10], [600, 20], [900, 30], [1200, 40], [1500, 50]], attempt: 2 }),
    attempt({ object: 'y', score: 0, wall: 700, points: [[300, 5]] }),
    attempt({ object: 'z', score: 90, wall: 400, points: [[300, 90]] }),
  ];
  const board = buildLeaderboard({ attempts, batches: [], problems: [] }, { now: NOW });
  const entry = board.entries[0], curve = entry.time_curve;
  assert.equal(curve.available, true); assert.equal(curve.interval_seconds, 300); assert.equal(curve.wall_limit_seconds, 1800);
  assert.deepEqual(curve.points.map(point => point.t), [300, 600, 900, 1200, 1500, 1800]);
  // At 300 s: x = mean(0, 10) = 5, y = 5, z = 90; at 600 s: x = mean(40, 20) = 30, y still 5 (ends at 700 s), z 90 (ended at 400 s).
  near(curve.points[0].mean, (5 + 5 + 90) / 3);
  near(curve.points[1].mean, (30 + 5 + 90) / 3, 1e-9);
  // At 1200 s: x = mean(80 (ended), 40) = 60.
  near(curve.points[3].mean, (60 + 0 + 90) / 3);
  near(curve.points.at(-1).mean, entry.score.mean, 1e-9);
  assert.equal(curve.points.at(-1).finished, 1); near(curve.points[0].finished, 0);
  near(curve.points[1].finished, 1 / 4);
  assert.ok(curve.points[0].ci95, 'each point has the bootstrap interval of the score');
  // 95%: x a1 at 900 (78 >= 76), x a2 at its end 1805 (50 < 57), z at 300; y (final 0) left out.
  assert.equal(curve.t95.median_seconds, 900); assert.equal(curve.t95.attempts, 3); assert.equal(curve.t95.low_final, 1);
  assert.equal(curve.snapshots, 10); assert.equal(curve.score_errors, 0);
  assert.match(board.method.time_curve, /point at the wall-clock limit is the score/);
});

test('the page draws one line per configuration and the summary carries the table; without snapshots it says so', () => {
  const attempts = ['x', 'y', 'z'].flatMap(object => [
    attempt({ object, system: 'codex', model: 'fast', score: 70, wall: 600, points: [[300, 65]] }),
    attempt({ object, system: 'claude-code', model: 'slow', score: 85, wall: 1700, points: [[300, 0, 'absent'], [600, 10], [900, 30], [1200, 60], [1500, 82]] }),
  ]);
  const board = buildLeaderboard({ attempts, batches: [], problems: [] }, { now: NOW });
  const html = timeSection(board.entries);
  assert.equal((html.match(/<polyline /g) ?? []).length, 2);
  assert.match(html, /claude-code \/ slow \/ -/); assert.match(html, /95% of final/);
  assert.ok(!html.includes('NaN') && !html.includes('undefined'), 'no broken numbers');
  // Colour follows the name: claude-code sorts first.
  assert.match(html, /stroke: var\(--series-1\)"\/><circle[^>]*><title>claude-code/);
  assert.match(indexPage(board), /<h3>Score over time<\/h3>/);
  const markdown = timeMarkdown(board.entries);
  assert.match(markdown, /\| Configuration \| 5 min \| 10 min \| 15 min \| 20 min \| 25 min \| 30 min \| 95% of final \(median\) \|/);
  assert.match(summaryMarkdown(board), /### Score over time/);
  const bare = buildLeaderboard({ attempts: attempts.map(item => ({ ...item, snapshots: null })), batches: [], problems: [] }, { now: NOW });
  assert.equal(bare.entries[0].time_curve, null);
  assert.match(timeSection(bare.entries), /No score-over-time snapshots/);
  assert.equal(timeMarkdown(bare.entries), '');
  assert.doesNotMatch(summaryMarkdown(bare), /Score over time/);
});

test('collectRuns reads the snapshots from result.json', async t => {
  const root = await mkdtemp(join(tmpdir(), 'e3d-curves-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, 'data'), attemptDir = join(dataRoot, 'runs', 'b1', 'house-t2', 'a1');
  await mkdir(join(dataRoot, 'truth', 'house-t2'), { recursive: true });
  await writeFile(join(dataRoot, 'truth', 'house-t2', 'truth.json'), JSON.stringify({ object: 'house', variant: 't2', scale_evidence: 'none' }));
  await mkdir(join(attemptDir, 'score'), { recursive: true });
  await writeFile(join(attemptDir, 'score', 'report.json'), JSON.stringify({ schema: 'e3d-report-v1', valid: true, score: 70 }));
  await writeFile(join(attemptDir, 'result.json'), JSON.stringify({ task_id: 'house-t2', attempt: 1, system: 's', model: 'm', status: 'completed', score: 70,
    wall_seconds: 1000, wall_limit_seconds: 1800, snapshot_interval_seconds: 300,
    snapshots: [{ t: 600, at_seconds: 600.01, read_seconds: 600.2, status: 'scored', score: 50 }, { t: 300, status: 'absent', score: 0 },
      { t: 900, at_seconds: 1150.5, read_seconds: 1151, status: 'score_error', score: null }] }));
  const { attempts } = await collectRuns({ dataRoot, batches: ['b1'] });
  assert.equal(attempts[0].wall_limit_seconds, 1800);
  assert.deepEqual(attempts[0].snapshots, { interval_seconds: 300, points: [{ t: 300, at: 300, score: 0, status: 'absent' }, { t: 600, at: 600.2, score: 50, status: 'scored' },
    { t: 900, at: 1151, score: null, status: 'score_error' }] }, 'taken at the end of the read; the tick for a record without times');
  await writeFile(join(attemptDir, 'result.json'), JSON.stringify({ task_id: 'house-t2', attempt: 1, status: 'completed', score: 70 }));
  assert.equal((await collectRuns({ dataRoot, batches: ['b1'] })).attempts[0].snapshots, null, 'an older result has none');
});
