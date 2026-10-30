import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rng } from '../lib/rng.mjs';
import { compareRounds, regressionReport, regressionMarkdown, regressionVerdict, refusedBeforeScoring, parseSystems, tostP, maxConcurrent, tInterval, pairedBootstrap, mean, cellKey,
  REGRESSION_SCHEMA, REGRESSION_SYSTEMS, MAIN_VARIANTS, EQUIVALENCE_MARGIN, REGRESSION_SAMPLES } from '../lib/report/index.mjs';

// The regression check, docs/V1-ROUND4-PLAN.md section 3.

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' is not within ' + tolerance + ' of ' + expected);
const NOW = new Date('2026-10-30T12:00:00Z');
const SET = 'test-2026-10';
const [ASTRA, OPUS] = REGRESSION_SYSTEMS.map(cellKey);
const SCORER = { version: '1.1.0', sha256: 'a'.repeat(64) };
const STACK = { node_version: 'v26.12.0', node_sha256: '8'.repeat(64), cli_version: '1.0.0', cli_sha256: 'b'.repeat(64), runner_sha256: 'c'.repeat(64), prompt_version: 'p1',
  tools_sha256: 'd'.repeat(64), runtime_sha256: 'e'.repeat(64), protocol: 'e3d-v1' };
// An object effect both rounds share, so pairing by object removes it.
const OBJECT_EFFECT = (() => { const random = rng('regression-objects'); return Array.from({ length: 40 }, () => 30 * (random.next() - 0.5)); })();

// One round's attempts on `objects` objects of the set, in the shape
// collectRuns gives. `systems` are [system, model, effort, base]; `value`
// (object, variant, attempt, normal) -> score overrides the noisy default;
// `skip` lists task ids without a counted sample; `excluded` maps task ids to
// an excluded status (an extra attempt that is not a sample).
function round(label, { systems = REGRESSION_SYSTEMS.map((spec, i) => [spec.system, spec.model, spec.effort, i ? 66 : 73]), objects = 24, attempts = 1, noise = 3, shift = 0,
  variants = MAIN_VARIANTS, set = SET, value = null, skip = [], excluded = {}, scorer = SCORER, stack = () => STACK, overlap = false, start = Date.UTC(2026, 9, 1) } = {}) {
  const random = rng('regression/' + label);
  const normal = () => Math.sqrt(-2 * Math.log(1 - random.next())) * Math.cos(2 * Math.PI * random.next());
  const result = { attempts: [], batches: [], problems: [], taskInfo: new Map(), plans: [] };
  let clock = start;
  systems.forEach(([system, model, effort, base], s) => {
    const batch = label + '-' + system + '-' + model + '-' + (effort ?? 'none');
    result.batches.push({ id: batch, manifest: stack(batch, s) });
    for (let o = 0; o < objects; o++) {
      for (const variant of variants) {
        const task = 'o' + o + '-' + variant;
        for (let a = 1; a <= attempts; a++) {
          if (skip.includes(task)) continue;
          const score = value ? value(o, variant, a, normal) : Math.max(0, Math.min(100, base + OBJECT_EFFECT[o] + shift + noise * normal()));
          // One attempt after another, 300 s each, 600 s apart; with `overlap` every other one starts before the last has finished.
          const started = clock, finished = clock + (overlap ? 900 : 300) * 1000;
          clock += 600 * 1000;
          result.attempts.push({ batch, task_id: task, attempt: a, slot: 'a' + a, system, model, effort, set, object: 'o' + o, variant, archetype: 'house',
            status: 'completed', excluded: false, valid: true, score, report: { valid: true, score, ...(scorer ? { scorer } : {}) },
            started_at: new Date(started).toISOString(), finished_at: new Date(finished).toISOString(), artifact_sha256: null });
        }
        if (excluded[task]) {
          result.attempts.push({ batch, task_id: task, attempt: attempts + 1, slot: 'a' + (attempts + 1), system, model, effort, set, object: 'o' + o, variant, archetype: 'house',
            status: excluded[task], excluded: true, valid: false, score: 0, report: null, started_at: null, finished_at: null, artifact_sha256: null });
        }
      }
    }
  });
  return result;
}

const rowOf = (result, key) => result.systems.find(row => row.key === key);
const compare = (before, after, options = {}) => compareRounds({ baseline: before, current: after, now: NOW, ...options });

test('equivalent: the 90% Student-t and bootstrap intervals both inside ±2, the t half being the paired TOST', () => {
  const before = round('r3', { attempts: 3 }), after = round('r4', { shift: 0.2 });
  const result = compare(before, after);
  assert.equal(result.schema, REGRESSION_SCHEMA);
  assert.equal(result.plan_systems, true);
  assert.deepEqual([result.owed.tasks, result.owed.objects, result.owed.placeholders], [72, 24, []]);
  for (const key of [ASTRA, OPUS]) {
    const row = rowOf(result, key), d = row.difference;
    assert.equal(row.verdict, 'equivalent', row.statement);
    assert.equal(row.reason, null);
    assert.equal(row.cross_round, 'main score only');
    assert.deepEqual([row.baseline.tasks, row.current.tasks, row.baseline.missing, row.current.missing], [72, 72, [], []]);
    assert.deepEqual([row.baseline.attempts_per_task, row.current.attempts_per_task], [{ min: 3, max: 3 }, { min: 1, max: 1 }]);
    // Per object: this round's mean over its three tasks minus Round 3's mean
    // over the same tasks, each task the mean of its attempts.
    const scores = (source, object) => mean(MAIN_VARIANTS.map(variant => mean(source.attempts.filter(item => cellKey(item) === key && item.task_id === object + '-' + variant)
      .map(item => item.score))));
    // In object order, as the report resamples them.
    const expected = Array.from({ length: 24 }, (_, o) => 'o' + o).sort((p, q) => p.localeCompare(q)).map(object => scores(after, object) - scores(before, object));
    assert.deepEqual(d.per_object.map(item => item.difference), expected);
    assert.equal(d.objects, 24);
    assert.equal(d.tasks, 72);
    near(d.mean, mean(expected));
    // With every task on both sides, the mean difference is the difference of the two main scores.
    near(d.mean, row.current.score.mean - row.baseline.score.mean);
    assert.deepEqual(d.t_ci90, tInterval(expected, 0.9));
    assert.deepEqual(d.t_ci95, tInterval(expected, 0.95));
    const seed = 'e3d-regression/' + SET + '/' + key + '/difference';
    assert.deepEqual(d.bootstrap_ci90, pairedBootstrap(expected, { seed, level: 0.9 }).ci95);
    assert.deepEqual(d.bootstrap_ci95, pairedBootstrap(expected, { seed, level: 0.95 }).ci95);
    assert.equal(d.samples, REGRESSION_SAMPLES);
    for (const ci of [d.t_ci90, d.bootstrap_ci90]) assert.ok(ci[0] > -EQUIVALENCE_MARGIN && ci[1] < EQUIVALENCE_MARGIN);
    assert.ok(d.tost_p < 0.05);
    assert.match(row.statement, /^codex|^claude-code/);
    assert.match(row.statement, /equivalent \(等价\)/);
    assert.match(row.statement, /main score only/);
  }
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.notes, []);
  const markdown = regressionMarkdown(result);
  assert.match(markdown, /# Regression check: Round 3 → Round 4/);
  assert.match(markdown, /72 tasks on 24 objects/);
  assert.match(markdown, /\| codex \/ gpt-6-astra \/ high \| equivalent \(等价\) \|/);
});

test('the TOST p-value is below 0.05 exactly when the 90% t interval lies inside the margin', () => {
  const random = rng('tost');
  for (let trial = 0; trial < 300; trial++) {
    const n = 2 + Math.floor(random.next() * 30), centre = 4 * (random.next() - 0.5), spread = 0.2 + 4 * random.next();
    const values = Array.from({ length: n }, () => centre + spread * (random.next() - 0.5));
    const ci = tInterval(values, 0.9), inside = ci[0] > -2 && ci[1] < 2, p = tostP(values, 2);
    // Exactly at the boundary both are within rounding of it; avoid those.
    if (Math.abs(ci[0] + 2) < 1e-9 || Math.abs(ci[1] - 2) < 1e-9) continue;
    assert.equal(p < 0.05, inside, 'n ' + n + ', interval ' + ci + ', p ' + p);
  }
  assert.equal(tostP([1, 1, 1], 2), null, 'constant differences: no test');
  assert.equal(tostP([1], 2), null);
  near(tostP([-1, 1], 2), Math.max(1 - 0.5 - Math.atan(2) / Math.PI, 0.5 + Math.atan(-2) / Math.PI), 1e-9);
});

test('drift: both 95% intervals exclude zero on the same side; no comparison across rounds', () => {
  const result = compare(round('r3', { attempts: 3 }), round('r4', { shift: -5 }));
  for (const key of [ASTRA, OPUS]) {
    const row = rowOf(result, key);
    assert.equal(row.verdict, 'drift', row.statement);
    assert.equal(row.direction, 'down');
    assert.ok(row.difference.t_ci95[1] < 0 && row.difference.bootstrap_ci95[1] < 0);
    assert.equal(row.cross_round, 'none');
    assert.match(row.statement, /drift \(漂移\), downwards/);
    assert.match(row.statement, /No comparison across rounds/);
  }
});

test('equivalent with a small but measurable change when both 95% intervals also exclude zero', () => {
  const result = compare(round('r3', { attempts: 3, noise: 0.5 }), round('r4', { shift: 1, noise: 0.5 }));
  for (const key of [ASTRA, OPUS]) {
    const row = rowOf(result, key);
    assert.equal(row.verdict, 'equivalent', row.statement);
    assert.equal(row.small_change, true);
    assert.equal(row.direction, 'up');
    assert.ok(row.difference.t_ci95[0] > 0 && row.difference.bootstrap_ci95[0] > 0);
    assert.match(row.statement, /有小而可测的变化/);
  }
  // Without the shift there is nothing measurable.
  const level = rowOf(compare(round('r3', { attempts: 3, noise: 0.5 }), round('r4', { noise: 0.5 })), ASTRA);
  assert.equal(level.verdict, 'equivalent');
  assert.equal(level.small_change, false);
});

test('undecided when the intervals are neither inside the margin nor clear of zero', () => {
  const result = compare(round('r3', { attempts: 3, noise: 12 }), round('r4', { noise: 12, shift: 1 }));
  for (const key of [ASTRA, OPUS]) {
    const row = rowOf(result, key), d = row.difference;
    assert.equal(row.verdict, 'undecided', row.statement);
    assert.equal(row.reason, 'inconclusive');
    assert.ok(!(d.t_ci90[0] > -2 && d.t_ci90[1] < 2) || !(d.bootstrap_ci90[0] > -2 && d.bootstrap_ci90[1] < 2));
    assert.ok(!(d.t_ci95[0] > 0 || d.t_ci95[1] < 0) || !(d.bootstrap_ci95[0] > 0 || d.bootstrap_ci95[1] < 0));
    assert.equal(row.cross_round, 'none');
  }
});

test('the two 90% intervals must both lie strictly inside the margin, and both 95% intervals clear zero on one side', () => {
  // Differences alternating +-5.8: the percentile bootstrap's 90% interval
  // fits inside +-2, the Student-t one (wider, with its n - 1 and t tail) does not.
  const before = round('r3', { attempts: 3, value: () => 60 }), after = round('r4', { value: o => 60 + (o % 2 ? 5.8 : -5.8) });
  const row = rowOf(compare(before, after), ASTRA), d = row.difference;
  assert.ok(d.bootstrap_ci90[0] > -2 && d.bootstrap_ci90[1] < 2, 'bootstrap ' + d.bootstrap_ci90);
  assert.ok(d.t_ci90[0] < -2 && d.t_ci90[1] > 2, 't ' + d.t_ci90);
  assert.deepEqual([row.verdict, row.reason], ['undecided', 'inconclusive']);
  // The rules on given intervals.
  const verdict = intervals => regressionVerdict({ difference: { intervals_available: true, objects: 24, ...intervals } });
  const level = { t_ci95: [-1.5, 1.4], bootstrap_ci95: [-1.4, 1.3] };
  assert.equal(verdict({ t_ci90: [-1.2, 1.1], bootstrap_ci90: [-1.1, 1.0], ...level }).verdict, 'equivalent');
  // A bound exactly on the margin is not inside it, on either side and for either interval.
  for (const t_ci90 of [[-2, 1.1], [-1.2, 2]]) assert.deepEqual(verdict({ t_ci90, bootstrap_ci90: [-1.1, 1.0], ...level }), { verdict: 'undecided', reason: 'inconclusive' });
  for (const bootstrap_ci90 of [[-2, 1.0], [-1.1, 2]]) assert.equal(verdict({ t_ci90: [-1.2, 1.1], bootstrap_ci90, ...level }).verdict, 'undecided');
  // Only one 95% interval clear of zero: no drift, and no small-change note.
  const wide = { t_ci90: [0.2, 3.4], bootstrap_ci90: [0.3, 3.3] };
  assert.deepEqual(verdict({ ...wide, t_ci95: [0.1, 3.6], bootstrap_ci95: [-0.1, 3.5] }), { verdict: 'undecided', reason: 'inconclusive' });
  assert.deepEqual(verdict({ ...wide, t_ci95: [-0.1, 3.6], bootstrap_ci95: [0.1, 3.5] }), { verdict: 'undecided', reason: 'inconclusive' });
  // An interval touching zero does not exclude it; two that exclude it on opposite sides do not agree.
  assert.equal(verdict({ ...wide, t_ci95: [0, 3.6], bootstrap_ci95: [0.1, 3.5] }).verdict, 'undecided');
  assert.equal(verdict({ ...wide, t_ci95: [0.1, 3.6], bootstrap_ci95: [-3.5, -0.1] }).verdict, 'undecided');
  assert.deepEqual(verdict({ ...wide, t_ci95: [0.1, 3.6], bootstrap_ci95: [0.2, 3.5] }), { verdict: 'drift', reason: null, direction: 'up' });
  const narrow = { t_ci90: [0.2, 1.4], bootstrap_ci90: [0.3, 1.3] };
  assert.equal(verdict({ ...narrow, t_ci95: [0.1, 1.5], bootstrap_ci95: [-0.1, 1.4] }).small_change, false);
  assert.equal(verdict({ ...narrow, t_ci95: [0, 1.5], bootstrap_ci95: [0.1, 1.4] }).small_change, false);
  assert.deepEqual(verdict({ ...narrow, t_ci95: [-1.5, -0.1], bootstrap_ci95: [-1.4, -0.2] }), { verdict: 'equivalent', reason: null, small_change: true, direction: 'down' });
  // Data problems first, then gaps, then missing intervals.
  const any = { intervals_available: true, objects: 24, t_ci90: [-1, 1], bootstrap_ci90: [-1, 1], t_ci95: [-1, 1], bootstrap_ci95: [-1, 1] };
  assert.equal(regressionVerdict({ difference: any, blockers: [{ reason: 'mixed_stack' }], missing: ['o1-t2'] }).reason, 'mixed_stack');
  assert.equal(regressionVerdict({ difference: any, missing: ['o1-t2'] }).reason, 'incomplete');
  assert.equal(regressionVerdict({ difference: { ...any, intervals_available: false } }).reason, 'no_variation');
});

test('a system missing a main task in this round is undecided; what both rounds have is a description only', () => {
  const before = round('r3', { attempts: 3 });
  // An infra error is not a sample: o5-c1 has an attempt, but none that counts.
  const after = round('r4', { skip: ['o3-t4', 'o5-c1'], excluded: { 'o5-c1': 'infra_error' }, systems: [['codex', 'gpt-6-astra', 'high', 73]] });
  const row = rowOf(compare(before, after), ASTRA);
  assert.equal(row.verdict, 'undecided');
  assert.equal(row.reason, 'incomplete');
  assert.deepEqual(row.current.missing, ['o3-t4', 'o5-c1']);
  assert.deepEqual(row.current.excluded, { infra_error: 1 });
  assert.equal(row.cross_round, 'none');
  // Still 24 objects, on the 70 tasks both rounds have; the intervals are kept as a description.
  assert.deepEqual([row.difference.objects, row.difference.tasks], [24, 70]);
  assert.ok(row.difference.t_ci90);
  assert.match(row.statement, /no counted sample on 2 main tasks of 72 \(o3-t4, o5-c1\)/);
  assert.match(row.statement, /a description only/);
  // Even with every interval inside the margin: the plan does not judge part of the tasks.
  assert.ok(row.difference.t_ci90[0] > -2 && row.difference.t_ci90[1] < 2, 'the gap is small, but the verdict waits for every task');
  // A system this round never ran at all.
  const opus = rowOf(compare(before, after), OPUS);
  assert.deepEqual([opus.verdict, opus.reason, opus.current.missing.length, opus.difference.objects], ['undecided', 'incomplete', 72, 0]);
  assert.match(opus.statement, /No task has a sample in both rounds/);
});

test('differences that do not vary give no interval, so no verdict but undecided', () => {
  // Round 4 is exactly 1.5 points above every Round 3 task mean.
  const before = round('r3', { attempts: 3, value: (o, variant, a) => 60 + o + (variant === 't4' ? 10 : 0) + a });
  const after = round('r4', { value: (o, variant) => 60 + o + (variant === 't4' ? 10 : 0) + 2 + 1.5 });
  const row = rowOf(compare(before, after), ASTRA);
  near(row.difference.mean, 1.5, 1e-9);
  assert.equal(row.difference.intervals_available, false);
  assert.deepEqual([row.difference.t_ci90, row.difference.bootstrap_ci90, row.difference.t_ci95, row.difference.bootstrap_ci95, row.difference.tost_p], [null, null, null, null, null]);
  assert.deepEqual([row.verdict, row.reason], ['undecided', 'no_variation']);
  assert.match(row.statement, /do not vary, so no interval is available/);
  assert.match(regressionMarkdown(compare(before, after)), /not available/);
  // Every object scoring the same in a round: no interval for that round's score either.
  const flat = compare(round('r3', { attempts: 3, value: () => 50 }), round('r4', { value: () => 50 }));
  for (const side of ['baseline', 'current']) assert.deepEqual(rowOf(flat, ASTRA)[side].score, { mean: 50, ci95: null });
  assert.match(regressionMarkdown(flat), /\| 50\.00 \(interval not available\) \|/);
  // One object: no interval either.
  const one = rowOf(compare(round('r3', { attempts: 3, objects: 1 }), round('r4', { objects: 1 })), ASTRA);
  assert.deepEqual([one.verdict, one.reason, one.difference.objects], ['undecided', 'few_objects', 1]);
});

test('two scorer versions, an earlier row with gaps or none, or this round on two stacks: not judged', () => {
  const before = round('r3', { attempts: 3 });
  // G1 moved the scorer to 1.2.0 but only this round was rescored.
  const rescored = compare(before, round('r4', { scorer: { version: '1.2.0', sha256: 'f'.repeat(64) } }));
  for (const key of [ASTRA, OPUS]) {
    const row = rowOf(rescored, key);
    assert.deepEqual([row.verdict, row.reason, row.cross_round], ['not_judged', 'scorer_mismatch', 'none']);
    assert.match(row.statement, /scored under scorer 1\.1\.0 in Round 3 and 1\.2\.0 in Round 4/);
  }
  const markdown = regressionMarkdown(rescored);
  assert.match(markdown, /\| codex \/ gpt-6-astra \/ high \| not judged \(data problem\): the two rounds were not scored under one scorer version \(rescore one side\) \| — \|/);
  assert.doesNotMatch(markdown, /\| Object \| Tasks \|/, 'no per-object comparison for a row that is not judged');
  // Reports without a stamp were written by scorer 1.0.0: not the same definition either.
  assert.equal(rowOf(compare(before, round('r4', { scorer: null })), ASTRA).reason, 'scorer_mismatch');
  // An artifact the runner refused before scoring (a link, say) has a report with no scorer stamp: a 0, not another scorer.
  const refusing = round('r4');
  const refused = refusing.attempts.find(item => item.system === 'codex' && item.task_id === 'o4-t2');
  Object.assign(refused, { valid: false, score: 0, report: { schema: 'e3d-report-v1', task_id: 'o4-t2', object: null, variant: null, valid: false, error: 'output/model.glb is a symbolic link',
    score: 0, produced_by: 'v1.2.4 (refused before scoring)' } });
  assert.equal(refusedBeforeScoring(refused.report), true);
  assert.equal(refusedBeforeScoring({ valid: false, score: 0, produced_by: 'v1.2.4' }), false);
  const withRefusal = rowOf(compare(before, refusing), ASTRA);
  assert.notEqual(withRefusal.verdict, 'not_judged', withRefusal.statement);
  assert.deepEqual([withRefusal.current.scorer_versions, withRefusal.current.refused_before_scoring, withRefusal.current.tasks], [['1.1.0'], 1, 72]);
  assert.equal(withRefusal.difference.per_object.find(item => item.object === 'o4').current < withRefusal.difference.per_object.find(item => item.object === 'o4').baseline - 15, true);
  // The same version from another build of the scorer (a change that moves no number): judged, with a note.
  const rebuilt = compare(before, round('r4', { scorer: { version: '1.1.0', sha256: '9'.repeat(64) } }));
  assert.equal(rowOf(rebuilt, ASTRA).verdict, 'equivalent');
  assert.ok(rebuilt.notes.some(note => /one scorer version \(1\.1\.0\), 2 scorer source hashes/.test(note)), rebuilt.notes.join('\n'));
  // This round's batches of one system on two stacks (two batches of Astra, one with a newer CLI).
  const split = round('r4');
  const astra = split.attempts.filter(item => item.system === 'codex');
  astra.slice(36).forEach(item => { item.batch = 'r4-codex-second'; });
  split.batches.push({ id: 'r4-codex-second', manifest: { ...STACK, cli_version: '1.0.1' } });
  const mixed = rowOf(compare(before, split), ASTRA);
  assert.deepEqual([mixed.verdict, mixed.reason], ['not_judged', 'mixed_stack']);
  assert.match(mixed.statement, /differ in CLI version/);
  assert.equal(rowOf(compare(before, split), OPUS).verdict, 'equivalent', 'the other system is judged on its own');
  // One Node version from two builds is two stacks as well.
  const rebuiltNode = round('r4');
  rebuiltNode.attempts.filter(item => item.system === 'codex').slice(36).forEach(item => { item.batch = 'r4-codex-second'; });
  rebuiltNode.batches.push({ id: 'r4-codex-second', manifest: { ...STACK, node_sha256: '7'.repeat(64) } });
  const node = rowOf(compare(before, rebuiltNode), ASTRA);
  assert.deepEqual([node.verdict, node.reason], ['not_judged', 'mixed_stack']);
  assert.match(node.statement, /differ in Node binary;/);
  // The same in Round 3 is history, not a reason to refuse (Round 3 changed CLIs between batches).
  const history = round('r3', { attempts: 3 });
  history.attempts.filter(item => item.system === 'codex').slice(108).forEach(item => { item.batch = 'r3-codex-later'; });
  history.batches.push({ id: 'r3-codex-later', manifest: { ...STACK, cli_version: '0.9.9' } });
  const judged = rowOf(compare(history, round('r4')), ASTRA);
  assert.equal(judged.verdict, 'equivalent');
  assert.deepEqual(judged.baseline.stack.cli_version, ['0.9.9', '1.0.0']);
  // No Round 3 row, or one with a gap.
  const none = rowOf(compare(round('r3', { attempts: 3, systems: [['claude-code', 'claude-opus-5-5', 'high', 66]] }), round('r4')), ASTRA);
  assert.deepEqual([none.verdict, none.reason], ['not_judged', 'no_baseline']);
  const gap = rowOf(compare(round('r3', { attempts: 3, skip: ['o7-t2'] }), round('r4')), ASTRA);
  assert.deepEqual([gap.verdict, gap.reason, gap.baseline.missing], ['not_judged', 'baseline_incomplete', ['o7-t2']]);
});

test('only the main tasks of the set count; an object variant no batch has is owed under a placeholder', () => {
  // Round 3 also ran t1 and t3, and the memory set; none of them is a main task of the regression set.
  const before = round('r3', { attempts: 3, variants: ['t1', 't2', 't3', 't4', 'c1'] });
  const memory = round('r3m', { attempts: 1, objects: 2, variants: ['m2'], set: 'memory-2026-10' });
  before.attempts.push(...memory.attempts.map(item => ({ ...item, batch: item.batch.replace('r3m', 'r3'), task_id: 'lm' + item.task_id, object: 'lm' + item.object })));
  const result = compare(before, round('r4'));
  assert.deepEqual([result.owed.tasks, result.owed.objects], [72, 24]);
  const row = rowOf(result, ASTRA);
  assert.equal(row.baseline.outside, 24 * 2 * 3 + 2);
  assert.equal(row.baseline.attempts, 72 * 3);
  assert.equal(row.verdict, 'equivalent');
  // An object whose main tasks no batch has, seen only through its t1: still owes them.
  const onlyT1 = round('r3', { attempts: 3, variants: ['t1', 't2', 't3', 't4', 'c1'] }), later = round('r4');
  for (const source of [onlyT1, later]) source.attempts = source.attempts.filter(item => item.object !== 'o23' || item.variant === 't1');
  const seen = compare(onlyT1, later);
  assert.deepEqual([seen.owed.tasks, seen.owed.objects], [72, 24]);
  assert.deepEqual(seen.owed.placeholders, ['o23 t2 (no task in these batches)', 'o23 t4 (no task in these batches)', 'o23 c1 (no task in these batches)']);
  assert.deepEqual([rowOf(seen, ASTRA).verdict, rowOf(seen, ASTRA).reason, rowOf(seen, ASTRA).baseline.missing.length], ['not_judged', 'baseline_incomplete', 3]);
  // No batch has a c1 task of o5: owed by everyone, a gap in both rounds, a data problem.
  const noC1 = round('r3', { attempts: 3 }), after = round('r4');
  for (const source of [noC1, after]) source.attempts = source.attempts.filter(item => item.task_id !== 'o5-c1');
  const placed = compare(noC1, after);
  assert.deepEqual(placed.owed.placeholders, ['o5 c1 (no task in these batches)']);
  assert.equal(placed.owed.tasks, 72);
  assert.deepEqual([rowOf(placed, ASTRA).verdict, rowOf(placed, ASTRA).reason], ['not_judged', 'baseline_incomplete']);
  assert.ok(placed.problems.some(problem => /1 object variant of set test-2026-10 have no task in these batches: o5 c1/.test(problem)), placed.problems.join('\n'));
  // A task a batch planned (or the build record lists) is owed although no attempt ran it.
  const planned = round('r4');
  planned.attempts = planned.attempts.filter(item => item.task_id !== 'o9-t4');
  planned.taskInfo.set('o9-t4', { set: SET, object: 'o9', variant: 't4' });
  const owedRow = rowOf(compare(round('r3', { attempts: 3 }), planned), ASTRA);
  assert.deepEqual([owedRow.verdict, owedRow.current.missing], ['undecided', ['o9-t4']]);
});

test('attempts that ran at once are noted, batches in both rounds refused, systems parsed', () => {
  const result = compare(round('r3', { attempts: 3, overlap: true }), round('r4'));
  assert.equal(rowOf(result, ASTRA).baseline.concurrency.max, 2);
  assert.equal(rowOf(result, ASTRA).current.concurrency.max, 1);
  // A second run of some tasks given with the regression batches is averaged in, and said.
  const again = round('r4'), extra = round('r4-again', { objects: 2 });
  again.attempts.push(...extra.attempts.map(item => ({ ...item, attempt: 2, slot: 'a2' })));
  again.batches.push(...extra.batches);
  const twice = compare(round('r3', { attempts: 3 }), again);
  assert.deepEqual(rowOf(twice, ASTRA).current.attempts_per_task, { min: 1, max: 2 });
  assert.ok(twice.notes.some(note => /Round 4: codex \/ gpt-6-astra \/ high has 1 to 2 counted attempts per task/.test(note)), twice.notes.join('\n'));
  assert.ok(result.notes.some(note => /Round 3: up to 2 attempts of codex \/ gpt-6-astra \/ high ran at once/.test(note)), result.notes.join('\n'));
  assert.deepEqual(maxConcurrent([{ started_at: '2026-10-01T00:00:00Z', finished_at: '2026-10-01T00:05:00Z' }, { started_at: '2026-10-01T00:05:00Z', finished_at: '2026-10-01T00:09:00Z' },
    { started_at: null, finished_at: null }]), { max: 1, timed: 2, untimed: 1 });
  assert.equal(maxConcurrent([]).max, null);
  const same = round('r3', { attempts: 3 });
  assert.throws(() => compare(same, same), /is in both rounds/);
  assert.deepEqual(parseSystems('codex/gpt-6-astra/high, claude-code/claude-haiku-4-5-20251001/-'),
    [{ system: 'codex', model: 'gpt-6-astra', effort: 'high' }, { system: 'claude-code', model: 'claude-haiku-4-5-20251001', effort: null }]);
  assert.throws(() => parseSystems('codex/gpt-6-astra'), /is not system\/model\/effort/);
  assert.throws(() => parseSystems('codex/a/high,codex/a/high'), /names a configuration twice/);
  assert.throws(() => parseSystems(''), /--systems needs/);
  // Other systems can be compared, but the plan's verdicts are about its two.
  const other = compare(round('r3', { attempts: 3 }), round('r4'), { systems: [REGRESSION_SYSTEMS[1]] });
  assert.equal(other.plan_systems, false);
  assert.match(regressionMarkdown(other), /These are not the plan's two regression systems/);
});

// ------------------------------------------------------------------ on disk

const here = dirname(fileURLToPath(import.meta.url)), cli = join(here, '..', 'cli.mjs');
const write = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); };

// A data root with four objects of the set: truth and the build record.
async function dataRoot({ objects = 4 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'e3d-regression-'));
  const built = [];
  for (let o = 0; o < objects; o++) {
    await write(join(root, 'objects', 'o' + o, 'model.json'), { archetype: 'house' });
    const tasks = ['t1', ...MAIN_VARIANTS].map(variant => 'o' + o + '-' + variant);
    for (const task of tasks) await write(join(root, 'truth', task, 'truth.json'), { object: 'o' + o, variant: task.split('-')[1], set: SET });
    built.push({ object: 'o' + o, tasks });
  }
  await write(join(root, 'sets', SET + '.built.json'), { name: SET, built_at: '2026-10-02T00:00:00Z', built });
  return root;
}

// One batch of one system on the four objects' main tasks; `score(object, variant, attempt)`.
async function batch(root, id, { system, model, effort }, { attempts = 1, score, skip = [], integrity = [], manifest = STACK }) {
  const dir = join(root, 'runs', id);
  await write(join(dir, 'manifest.json'), { schema: 'e3d-run-batch-v1', id, system, model, effort, attempts, harness: { version: manifest.cli_version, binary_sha256: manifest.cli_sha256 },
    node: { version: manifest.node_version, sha256: manifest.node_sha256 }, runner_source: { sha256: manifest.runner_sha256 }, prompt_version: manifest.prompt_version, tools: { sha256: manifest.tools_sha256 },
    runtime: { three_version: '0.180.0', sha256: manifest.runtime_sha256 }, protocol: manifest.protocol, tasks: [] });
  let clock = Date.UTC(2026, 9, 20);
  for (let o = 0; o < 4; o++) {
    for (const variant of MAIN_VARIANTS) {
      const task = 'o' + o + '-' + variant;
      if (skip.includes(task)) continue;
      for (let a = 1; a <= attempts; a++) {
        const value = score(o, variant, a);
        await write(join(dir, task, 'a' + a, 'result.json'), { task_id: task, attempt: a, status: 'completed', system, model, effort, score: integrity.includes(task) ? 0 : value,
          integrity_problems: integrity.includes(task) ? ['wrote outside output/'] : [],
          started_at: new Date(clock).toISOString(), finished_at: new Date(clock + 240000).toISOString(),
          report: { schema: 'e3d-report-v1', task_id: task, object: 'o' + o, variant, valid: true, score: value, scorer: SCORER } });
        clock += 300000;
      }
    }
  }
}

const execute = promisify(execFile);

test('tasks no truth.json places stop the judgement: a whole object without truth does not drop out unseen', async () => {
  const root = await dataRoot();
  try {
    const [astra, opus] = REGRESSION_SYSTEMS;
    const r3 = (o, variant, a) => 60 + 5 * o + (variant === 't4' ? 8 : 0) + [0, -1, 1.5, -0.5][a] + (o % 2 ? 0.4 : -0.3);
    const r4 = (o, variant) => 60 + 5 * o + (variant === 't4' ? 8 : 0) + [0.3, -0.4, 0.6, -0.1][o];
    for (const [id, spec, attempts, score] of [['r3-astra', astra, 3, r3], ['r3-opus', opus, 3, r3], ['r4-astra', astra, 1, r4], ['r4-opus', opus, 1, r4]]) {
      await batch(root, id, spec, { attempts, score });
    }
    const out = join(root, 'reports', 'regression');
    const run = () => regressionReport({ dataRoot: root, baseline: ['r3-astra', 'r3-opus'], batches: ['r4-astra', 'r4-opus'], outDir: out, now: NOW });
    assert.deepEqual((await run()).systems.map(item => item.verdict), ['equivalent', 'equivalent']);
    // o3's truth files are gone: its attempts fall under the unknown set, and its tasks out of the owed inventory.
    for (const variant of ['t1', ...MAIN_VARIANTS]) await rm(join(root, 'truth', 'o3-' + variant), { recursive: true });
    const summary = await run();
    assert.equal(summary.owed_tasks, 9);
    assert.deepEqual(summary.systems.map(item => [item.verdict, item.reason, item.cross_round]), [['not_judged', 'unplaced_tasks', 'none'], ['not_judged', 'unplaced_tasks', 'none']]);
    const json = JSON.parse(await readFile(join(out, 'regression.json'), 'utf8'));
    assert.deepEqual(json.owed.unplaced, ['o3-c1', 'o3-t1', 'o3-t2', 'o3-t4']);
    assert.deepEqual(rowOf(json, OPUS).unplaced, ['o3-c1', 'o3-t1', 'o3-t2', 'o3-t4']);
    assert.match(rowOf(json, OPUS).statement, /the build record of test-2026-10 lists 4 tasks that no readable truth\.json places in it \(o3-c1, o3-t1, o3-t2, \.\.\.\); claude-code \/ claude-opus-5-5 \/ high ran or planned 3 tasks whose truth\.json is missing or unreadable/);
    assert.ok(json.problems.some(problem => /build record of test-2026-10 lists 4 tasks/.test(problem)), json.problems.join('\n'));
    // Without the build record the configuration's own attempts still show it.
    await rm(join(root, 'sets', SET + '.built.json'));
    const bare = await run();
    assert.deepEqual(bare.systems.map(item => [item.verdict, item.reason]), [['not_judged', 'unplaced_tasks'], ['not_judged', 'unplaced_tasks']]);
    const without = JSON.parse(await readFile(join(out, 'regression.json'), 'utf8'));
    assert.deepEqual([without.owed.unplaced, rowOf(without, ASTRA).unplaced], [[], ['o3-c1', 'o3-t2', 'o3-t4']]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A batch of one configuration outside the comparison: `results` [task, object, variant, status] (one attempt each,
// the score report naming object and variant), `planned` the manifest's task records ({ id, set, object, variant }).
async function sideBatch(root, id, { system, model, effort }, { manifest = STACK, results = [], planned = [] }) {
  const dir = join(root, 'runs', id);
  await write(join(dir, 'manifest.json'), { schema: 'e3d-run-batch-v1', id, system, model, effort, attempts: 1, harness: { version: manifest.cli_version, binary_sha256: manifest.cli_sha256 },
    node: { version: manifest.node_version, sha256: manifest.node_sha256 }, runner_source: { sha256: manifest.runner_sha256 }, prompt_version: manifest.prompt_version, tools: { sha256: manifest.tools_sha256 },
    runtime: { three_version: '0.180.0', sha256: manifest.runtime_sha256 }, protocol: manifest.protocol, tasks: planned });
  for (const [task, object, variant, status] of results) {
    await write(join(dir, task, 'a1', 'result.json'), { task_id: task, attempt: 1, status, system, model, effort, score: 40, integrity_problems: [],
      report: { schema: 'e3d-report-v1', task_id: task, object, variant, valid: true, score: 40, scorer: SCORER } });
  }
}

test('tasks and batches outside the comparison neither stop it nor change its stack', async () => {
  const root = await dataRoot();
  try {
    const [astra, opus] = REGRESSION_SYSTEMS;
    const r3 = (o, variant, a) => 60 + 5 * o + (variant === 't4' ? 8 : 0) + [0, -1, 1.5, -0.5][a] + (o % 2 ? 0.4 : -0.3);
    const r4 = (o, variant) => 60 + 5 * o + (variant === 't4' ? 8 : 0) + [0.3, -0.4, 0.6, -0.1][o];
    for (const [id, spec, attempts, score] of [['r3-astra', astra, 3, r3], ['r3-opus', opus, 3, r3], ['r4-astra', astra, 1, r4], ['r4-opus', opus, 1, r4]]) {
      await batch(root, id, spec, { attempts, score });
    }
    // o3 lost only its t1 truth: o3 still owes its main tasks, and every one has its samples.
    await rm(join(root, 'truth', 'o3-t1'), { recursive: true });
    // Opus ran a memory task (readable truth) on another CLI; another Opus batch on another Node is prepared for a memory
    // task whose truth is gone and for a main task, and has run neither; Astra has an excluded t1 attempt of an object without truth.
    await write(join(root, 'truth', 'lm0-m2', 'truth.json'), { object: 'lm0', variant: 'm2', set: 'memory-2026-10' });
    await write(join(root, 'objects', 'lm0', 'model.json'), { archetype: 'house' });
    await sideBatch(root, 'r4-opus-memory', opus, { manifest: { ...STACK, cli_version: '2.0.0' }, results: [['lm0-m2', 'lm0', 'm2', 'completed']] });
    await sideBatch(root, 'r4-opus-pending', opus, { manifest: { ...STACK, node_sha256: '7'.repeat(64) },
      planned: [{ id: 'lm1-m2', set: 'memory-2026-10', object: 'lm1', variant: 'm2' }, { id: 'o0-t2', set: SET, object: 'o0', variant: 't2' }] });
    await sideBatch(root, 'r4-astra-extra', astra, { results: [['x9-t1', 'x9', 't1', 'infra_error']] });
    const out = join(root, 'reports', 'regression');
    const summary = await regressionReport({ dataRoot: root, baseline: ['r3-astra', 'r3-opus'], batches: ['r4-astra', 'r4-astra-extra', 'r4-opus', 'r4-opus-memory', 'r4-opus-pending'], outDir: out, now: NOW });
    assert.deepEqual(summary.systems.map(item => [item.verdict, item.reason]), [['equivalent', null], ['equivalent', null]]);
    assert.equal(summary.owed_tasks, 12);
    const json = JSON.parse(await readFile(join(out, 'regression.json'), 'utf8'));
    assert.deepEqual([json.owed.unplaced, rowOf(json, ASTRA).unplaced, rowOf(json, OPUS).unplaced], [[], [], []]);
    const opusRow = rowOf(json, OPUS);
    assert.deepEqual([opusRow.current.batches, opusRow.current.other_batches], [['r4-opus'], ['r4-opus-memory', 'r4-opus-pending']]);
    assert.deepEqual([opusRow.current.stack.cli_version, opusRow.current.stack_disagreements], [[STACK.cli_version], []]);
    assert.deepEqual(rowOf(json, ASTRA).current.other_batches, ['r4-astra-extra']);
    assert.match(await readFile(join(out, 'regression.md'), 'utf8'), /Round 4 batches of this configuration with no counted sample on a main task of the set, not part of the comparison \(nor of its stack\): r4-opus-memory, r4-opus-pending\./);
    // A main task's truth gone on an object the set still has: owed under a placeholder that nothing fills, a gap.
    await rm(join(root, 'truth', 'o0-t2'), { recursive: true });
    const lost = await regressionReport({ dataRoot: root, baseline: ['r3-astra', 'r3-opus'], batches: ['r4-astra', 'r4-opus'], outDir: out, now: NOW });
    assert.deepEqual(lost.systems.map(item => [item.verdict, item.reason]), [['not_judged', 'baseline_incomplete'], ['not_judged', 'baseline_incomplete']]);
    // A batch prepared for a main task of the set on an object no other task shows, whose truth is gone: the manifest's record says where it belongs.
    await write(join(root, 'truth', 'o0-t2', 'truth.json'), { object: 'o0', variant: 't2', set: SET });
    await sideBatch(root, 'r4-opus-o9', opus, { planned: [{ id: 'o9-t2', set: SET, object: 'o9', variant: 't2' }] });
    const hidden = await regressionReport({ dataRoot: root, baseline: ['r3-astra', 'r3-opus'], batches: ['r4-astra', 'r4-opus', 'r4-opus-o9'], outDir: out, now: NOW });
    assert.deepEqual(hidden.systems.map(item => [item.verdict, item.reason]), [['equivalent', null], ['not_judged', 'unplaced_tasks']]);
    assert.deepEqual(rowOf(JSON.parse(await readFile(join(out, 'regression.json'), 'utf8')), OPUS).unplaced, ['o9-t2']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('regressionReport and `cli regression` read both rounds from disk and write regression.json and regression.md', async () => {
  const root = await dataRoot();
  try {
    const [astra, opus] = REGRESSION_SYSTEMS;
    const r3 = (o, variant, a) => 60 + 5 * o + (variant === 't4' ? 8 : 0) + [0, -1, 1.5, -0.5][a] + (o % 2 ? 0.4 : -0.3);
    const r4 = (o, variant) => 60 + 5 * o + (variant === 't4' ? 8 : 0) + [0.3, -0.4, 0.6, -0.1][o] + (variant === 'c1' ? 0.2 : 0);
    await batch(root, 'r3-astra', astra, { attempts: 3, score: r3 });
    await batch(root, 'r3-opus', opus, { attempts: 3, score: r3 });
    // Round 4's Astra batch skips o3-c1 (until the second pass below).
    await batch(root, 'r4-astra', astra, { score: r4, skip: ['o3-c1'] });
    await batch(root, 'r4-opus', opus, { score: r4, integrity: ['o2-t2'] });
    const out = join(root, 'reports', 'regression');
    const summary = await regressionReport({ dataRoot: root, baseline: ['r3-astra', 'r3-opus'], batches: ['r4-astra', 'r4-opus'], outDir: out, now: NOW });
    assert.equal(summary.owed_tasks, 12);
    const json = JSON.parse(await readFile(join(out, 'regression.json'), 'utf8'));
    assert.equal(json.owed.build_record, 'sets/' + SET + '.built.json');
    assert.deepEqual(rowOf(json, ASTRA).current.stack.node_sha256, [STACK.node_sha256], 'the Node binary hash comes from the manifest');
    assert.deepEqual(json.baseline_batches, ['r3-astra', 'r3-opus']);
    const astraRow = rowOf(json, ASTRA), opusRow = rowOf(json, OPUS);
    assert.deepEqual([astraRow.verdict, astraRow.reason, astraRow.current.missing], ['undecided', 'incomplete', ['o3-c1']]);
    // The integrity problem scores 0: Opus o2 falls about 65 / 3 points.
    assert.ok(opusRow.difference.per_object.find(item => item.object === 'o2').difference < -20);
    assert.equal(opusRow.current.tasks, 12);
    assert.deepEqual(json.problems, []);
    const markdown = await readFile(join(out, 'regression.md'), 'utf8');
    assert.match(markdown, /12 tasks on 4 objects \(with the build record sets\/test-2026-10\.built\.json\)/);
    assert.match(markdown, /Round 4 has no counted sample on: o3-c1\./);
    // The same through the command line, with o3-c1 run and Opus without its integrity problem.
    await batch(root, 'r4-astra-b', astra, { score: r4 });
    await rm(join(root, 'runs', 'r4-opus'), { recursive: true });
    await batch(root, 'r4-opus', opus, { score: r4 });
    const { stdout } = await execute(process.execPath, [cli, 'regression', '--data', root, '--baseline', 'r3-astra,r3-opus', '--batches', 'r4-astra-b,r4-opus', '--out', out]);
    const printed = JSON.parse(stdout);
    assert.deepEqual(printed.systems.map(item => [item.key, item.verdict, item.missing]), [[ASTRA, 'equivalent', 0], [OPUS, 'equivalent', 0]]);
    // Per object: the shift, a third of the c1 bonus, minus Round 3's object offset (its attempt offsets average out).
    near(printed.systems[0].difference, mean([0.3, -0.4, 0.6, -0.1].map((shift, o) => shift + 0.2 / 3 - (o % 2 ? 0.4 : -0.3))), 1e-9);
    assert.equal(JSON.parse(await readFile(join(out, 'regression.json'), 'utf8')).systems[0].verdict, 'equivalent');
    await assert.rejects(execute(process.execPath, [cli, 'regression', '--data', root, '--baseline', 'r3-astra', '--batches', 'r3-astra']), /is in both rounds/);
    // A task only the build record knows (no batch ran or planned it) is owed by both rounds; its object's other variants under placeholders.
    await write(join(root, 'truth', 'o4-t2', 'truth.json'), { object: 'o4', variant: 't2', set: SET });
    await write(join(root, 'sets', SET + '.built.json'), { name: SET, built_at: '2026-10-02T00:00:00Z', built: [{ object: 'o4', tasks: ['o4-t2'] }] });
    const later = await regressionReport({ dataRoot: root, baseline: ['r3-astra', 'r3-opus'], batches: ['r4-astra-b', 'r4-opus'], outDir: out, now: NOW });
    assert.equal(later.owed_tasks, 15);
    assert.deepEqual(later.systems.map(item => item.verdict), ['not_judged', 'not_judged']);
    const placed = JSON.parse(await readFile(join(out, 'regression.json'), 'utf8'));
    assert.deepEqual(placed.owed.placeholders, ['o4 t4 (no task in these batches)', 'o4 c1 (no task in these batches)']);
    assert.deepEqual(rowOf(placed, ASTRA).baseline.missing, ['o4 c1 (no task in these batches)', 'o4 t4 (no task in these batches)', 'o4-t2']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
