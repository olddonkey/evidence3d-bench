import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir, symlink, link, unlink, cp } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { rng } from '../lib/rng.mjs';
import { decodePNG } from '../lib/png.mjs';
import { aggregate, buildLeaderboard, writeReport, bootstrapMean, conflictShare, normaliseUsage, comparePair, pairedBootstrap, tInterval,
  studentQuantile, chiSquareQuantile, sdRange, pooledSD, detectableDifference, pickRepresentatives, variantPairs, summaryMarkdown, attemptShareText,
  varianceStatement } from '../lib/report/index.mjs';
import { writeSampleRuns, syntheticDesign, SAMPLE_ATTEMPTS } from '../lib/report/sample-runs.mjs';

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' is not within ' + tolerance + ' of ' + expected);
const NOW = new Date('2026-09-30T12:00:00Z');
const CODEX = 'codex / gpt-demo / high', CLAUDE = 'claude-code / opus-demo / max';

async function withData(options, run) {
  const root = await mkdtemp(join(tmpdir(), 'e3d-report-'));
  try {
    const info = await writeSampleRuns(join(root, 'data'), options);
    return await run(join(root, 'data'), info, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('bootstrap intervals are seeded and behave like intervals', () => {
  const random = rng('synthetic-normal');
  const normal = () => Math.sqrt(-2 * Math.log(1 - random.next())) * Math.cos(2 * Math.PI * random.next());
  const values = Array.from({ length: 40 }, () => 50 + 10 * normal());
  const sampleMean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - sampleMean) ** 2, 0) / (values.length - 1));
  const [low, high] = bootstrapMean(values, { seed: 'a' });
  assert.ok(low < sampleMean && sampleMean < high);
  const analytic = 2 * 1.96 * sd / Math.sqrt(values.length);
  assert.ok((high - low) > 0.75 * analytic && (high - low) < 1.25 * analytic, 'width ' + (high - low) + ' vs analytic ' + analytic);
  assert.deepEqual(bootstrapMean(values, { seed: 'a' }), [low, high]);
  assert.notDeepEqual(bootstrapMean(values, { seed: 'b' }), [low, high]);
  assert.deepEqual(bootstrapMean([7, 7, 7, 7], { seed: 'a' }), [7, 7]);
  assert.equal(bootstrapMean([42]), null);
  assert.equal(bootstrapMean([]), null);
  // Coverage: across many synthetic samples the 95 % interval should contain
  // the true mean most of the time (percentile intervals run a little narrow).
  const source = rng('coverage');
  let covered = 0;
  const trials = 300;
  for (let trial = 0; trial < trials; trial++) {
    const sample = Array.from({ length: 20 }, () => 100 * source.next());
    const interval = bootstrapMean(sample, { seed: 'trial-' + trial, samples: 1000 });
    if (interval[0] <= 50 && 50 <= interval[1]) covered++;
  }
  assert.ok(covered / trials > 0.88 && covered / trials < 0.99, 'coverage ' + covered / trials);
});

test('aggregation counts failures as zero, weighs objects equally and keeps harness failures out', async () => {
  await withData({ withModels: false }, async dataRoot => {
    const board = await aggregate({ dataRoot, batches: ['demo-codex', 'demo-claude'], outFile: null, now: NOW });
    const codex = board.entries.find(entry => entry.key === CODEX), claude = board.entries.find(entry => entry.key === CLAUDE);
    // Object means: a = mean(t1 (40 + 0) / 2, t2 60, c1 50) = 43.33, b = mean(30, 0) = 15, c = 90.
    near(codex.score.mean, (130 / 3 + 15 + 90) / 3);
    assert.equal(codex.score.objects, 3);
    assert.equal(codex.score.attempts, 7, 'the infra_error attempt is excluded, the timeout is counted');
    assert.equal(codex.low_evidence, false);
    assert.ok(codex.score.ci95[0] < codex.score.mean && codex.score.mean < codex.score.ci95[1]);
    assert.deepEqual([codex.success.valid, codex.success.attempts], [5, 7]);
    assert.deepEqual(codex.status_counts, { ok: 6, timeout: 1 });
    assert.deepEqual(board.excluded.map(item => [item.task_id, item.attempt, item.status]), [['demo-house-b-t1', 2, 'infra_error']]);
    near(codex.variants.t1.mean, 25);
    assert.equal(codex.variants.t1.low_evidence, true);
    near(codex.variants.t2.mean, 50);
    assert.equal(codex.variants.t2.low_evidence, false);
    assert.equal(codex.variants.t3, undefined, 'a variant that was not run is absent, not zero');
    // Detail: failures count as 0 too; frame error only over valid attempts.
    assert.equal(codex.detail.attempts, 7);
    assert.equal(codex.frame_error.offset_fraction.attempts, 5);
    assert.equal(codex.scale_error_pct.attempts, 1, 'only the metric c1 task carries a scale error');
    near(codex.scale_error_pct.mean, 4, 1e-6);
    assert.equal(codex.wall_seconds.attempts, 7);
    assert.equal(codex.tokens.attempts_reporting, 7);
    assert.equal(codex.cost_usd.mean, null, 'cost not reported stays null, never 0');
    // Low evidence is flagged, not hidden.
    assert.equal(claude.low_evidence, true);
    assert.equal(claude.score.low_evidence, true);
    near(claude.score.mean, 60);
    assert.ok(claude.score.ci95, 'two objects still give an interval');
    const task = board.tasks.find(item => item.task_id === 'demo-house-a-t1');
    near(task.cells[CODEX].mean, 20);
    assert.deepEqual(task.cells[CODEX].attempts.map(attempt => attempt.valid), [true, false]);
    assert.deepEqual(board.problems, []);
  });
});

test('ladder deltas are paired by object', async () => {
  await withData({ withModels: false }, async dataRoot => {
    const board = await aggregate({ dataRoot, outFile: null, now: NOW });
    const codex = board.entries.find(entry => entry.key === CODEX);
    // Object a: t2 60 - t1 20 = +40; object b: t2 0 - t1 30 = -30; object c has no t1.
    const ladder = codex.ladder['t2-t1'];
    near(ladder.mean, 5);
    assert.deepEqual([ladder.pairs, ladder.unpaired_objects, ladder.low_evidence], [2, 1, true]);
    assert.ok(ladder.ci95[0] >= -30 && ladder.ci95[1] <= 40);
    // Unpaired, the same data would claim mean(t2) - mean(t1) = 50 - 25 = +25.
    near(codex.variants.t2.mean - codex.variants.t1.mean, 25);
    assert.equal(codex.ladder['t3-t2'].pairs, 0);
    assert.equal(codex.ladder['t3-t2'].mean, null);
  });
  // The same rule on hand-made attempts: two objects, t1 and t2 on both, plus an
  // object with only t2 that must not move the delta.
  const attempt = (object, variant, score) => ({ batch: 'b', task_id: object + '-' + variant, attempt: 1, system: 's', model: 'm', effort: null,
    status: 'ok', excluded: false, valid: true, score, object, variant, scale_evidence: 'none', usage: null, wall_seconds: null, cost_usd: null,
    report: { valid: true, score, alignment: { frame_error: { offset_fraction: 0, offset_m: 0, yaw_deg: 0 } }, detail: { score: 0 }, shape: { scale: 1 } } });
  const board = buildLeaderboard({ attempts: [attempt('x', 't1', 10), attempt('x', 't2', 30), attempt('y', 't1', 50), attempt('y', 't2', 60), attempt('z', 't2', 100)],
    batches: [], problems: [] }, { now: NOW });
  near(board.entries[0].ladder['t2-t1'].mean, 15);
});

test('conflict share counts contested probes closer to the primary state', async () => {
  near(conflictShare({ alternates: [{ contested: [{ closer_to: 'primary' }, { closer_to: 'neither' }] }, { contested: [{ closer_to: 'alternate' }, { closer_to: 'primary' }] }] }), 0.5);
  near(conflictShare({ alternates: [{ closer_to_primary_fraction: 0.25 }] }), 0.25);
  assert.equal(conflictShare({ alternates: [] }), undefined);
  await withData({ withModels: false }, async dataRoot => {
    const board = await aggregate({ dataRoot, outFile: null, now: NOW });
    const codex = board.entries.find(entry => entry.key === CODEX), claude = board.entries.find(entry => entry.key === CLAUDE);
    near(codex.conflict.mean, 2 / 3);
    assert.deepEqual(codex.conflict.probes, { primary: 2, alternate: 1, neither: 0 });
    assert.deepEqual([codex.conflict.c1_attempts, codex.conflict.failed_attempts, codex.conflict.objects], [1, 0, 1]);
    assert.equal(codex.conflict.ci95, null);
    assert.equal(claude.conflict.mean, null, 'no c1 task run: not evaluated');
  });
});

test('aggregate writes deterministic JSON and survives bad files', async () => {
  await withData({ withModels: false }, async dataRoot => {
    const first = await aggregate({ dataRoot, batches: ['demo-codex', 'demo-claude'], now: NOW });
    const path = join(dataRoot, 'reports', 'demo-codex+demo-claude', 'leaderboard.json');
    const written = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(written.schema, 'e3d-leaderboard-v2');
    assert.deepEqual(written, JSON.parse(JSON.stringify(first)));
    const again = await aggregate({ dataRoot, batches: ['demo-codex', 'demo-claude'], outFile: null, now: NOW });
    assert.deepEqual(JSON.parse(JSON.stringify(again)), written);
    // A corrupt result and an attempt that cannot be placed are reported, not fatal.
    await writeFile(join(dataRoot, 'runs', 'demo-claude', 'demo-house-a-t1', 'a1', 'result.json'), '{ not json');
    const orphan = join(dataRoot, 'runs', 'demo-claude', 'unknown-task', 'a1');
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, 'result.json'), JSON.stringify({ task_id: 'unknown-task', attempt: 1, system: 'x', model: 'y', status: 'error' }));
    const damaged = await aggregate({ dataRoot, outFile: null, now: NOW });
    assert.ok(damaged.problems.some(problem => /invalid JSON/.test(problem)));
    assert.ok(damaged.problems.some(problem => /cannot tell which object/.test(problem)));
    assert.equal(damaged.entries.find(entry => entry.key === CLAUDE).attempts, 1);
    const missing = await aggregate({ dataRoot, batches: ['no-such-batch'], outFile: null, now: NOW });
    assert.deepEqual(missing.entries, []);
    assert.ok(missing.problems.some(problem => /not found/.test(problem)));
  });
  assert.deepEqual(normaliseUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 }),
    { input: 10, output: 5, total: 15, cached_input: 3, cache_write: null, reasoning: null });
  assert.equal(normaliseUsage(null), null);
});

test('the report builds from fixtures: pages, renders after alignment, offline links, escaping', async () => {
  const hostile = SAMPLE_ATTEMPTS.map(spec => spec.batch === 'demo-claude' && spec.object === 'demo-house-b' ? { ...spec, model: '<img src=x onerror=alert(1)>' } : spec);
  await withData({ attempts: hostile }, async (dataRoot, info, root) => {
    const outDir = join(root, 'site');
    const result = await writeReport({ dataRoot, batches: info.batches, outDir, size: 200, now: NOW });
    assert.equal(result.tasks, info.tasks.length);
    const index = await readFile(join(outDir, 'index.html'), 'utf8');
    assert.match(index, /<table>/);
    assert.match(index, /codex/);
    assert.match(index, /&dagger;/, 'low-evidence cells are marked');
    assert.match(index, /n\/a/);
    assert.ok(!index.includes('<img src=x'), 'data is escaped');
    assert.ok(index.includes('&lt;img src=x onerror=alert(1)&gt;'));
    const leaderboard = JSON.parse(await readFile(join(outDir, 'leaderboard.json'), 'utf8'));
    assert.equal(leaderboard.entries.length, 3);
    const pages = (await readdir(join(outDir, 'tasks'))).sort();
    assert.deepEqual(pages, info.tasks.map(task => task + '.html').sort());
    // Every local reference resolves; nothing points off the machine.
    for (const file of ['index.html', ...pages.map(page => 'tasks/' + page)]) {
      const html = await readFile(join(outDir, file), 'utf8');
      assert.ok(!/(src|href)="(https?:)?\/\//.test(html), file + ' references an external URL');
      for (const [, reference] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
        await readFile(resolve(dirname(join(outDir, file)), reference.replace(/&amp;/g, '&')));
      }
    }
    const page = await readFile(join(outDir, 'tasks', 'demo-house-a-t1.html'), 'utf8');
    assert.match(page, /Evidence given/);
    assert.match(page, /01-photo-front\.png/);
    assert.match(page, /Detail groups/);
    assert.match(page, /Roof ridge height/);
    assert.match(page, /no score report \(status timeout\)/);
    const c1 = await readFile(join(outDir, 'tasks', 'demo-house-a-c1.html'), 'utf8');
    assert.match(c1, /Conflict: out-of-date evidence/);
    assert.match(c1, /predate the entrance canopy/);
    const invalid = await readFile(join(outDir, 'tasks', 'demo-house-b-t2.html'), 'utf8');
    assert.match(invalid, /not scored: Triangle limit exceeded/);

    // The full-model candidate, drawn after the reported alignment, matches the
    // truth from the same camera; the one missing chimney and canopy does not.
    // The truth is rendered once per object; candidates per task.
    const renders = join(outDir, 'assets', 'renders', 'demo-house-a-t1'), truths = join(outDir, 'assets', 'renders', 'objects', 'demo-house-a');
    const image = async name => decodePNG(await readFile(name.startsWith('truth-') ? join(truths, name) : join(renders, name)));
    const agreement = (a, b) => {
      assert.deepEqual([a.width, a.height], [b.width, b.height]);
      let same = 0;
      for (let i = 0; i < a.pixels.length; i += 3) if ([0, 1, 2].every(c => Math.abs(a.pixels[i + c] - b.pixels[i + c]) <= 8)) same++;
      return same / (a.pixels.length / 3);
    };
    for (const view of ['iso', 'front', 'top', 'iso-rear']) {
      const truth = await image('truth-' + view + '.png');
      assert.ok(agreement(truth, await image('demo-claude--a1-' + view + '.png')) > 0.99, view + ': aligned candidate should match the truth');
    }
    assert.ok(agreement(await image('truth-iso.png'), await image('demo-codex--a1-iso.png')) < 0.995, 'a candidate missing parts must look different');
    const truthPixels = (await image('truth-front.png')).pixels;
    assert.ok(truthPixels.some((value, i) => i % 3 === 0 && value < 120), 'the truth render is not blank');
  });
});

// ------------------------------------------------------------ pairwise, sets, provenance

// An in-memory attempt as collectRuns would produce it.
const made = ({ object, variant = 't2', score, model = 'A', attempt = 1, batch = 'b-' + model, set, archetype, status = 'completed', excluded = false, valid = true }) => ({
  batch, task_id: object + '-' + variant, attempt, slot: 'a' + attempt, system: 'sys', model, effort: null, set, archetype, status, excluded, valid, score,
  object, variant, scale_evidence: 'none', usage: null, wall_seconds: null, cost_usd: null,
  report: { valid, score, alignment: { frame_error: { offset_fraction: 0, offset_m: 0, yaw_deg: 0 } }, detail: { score: 0 }, shape: { scale: 1 } } });

// Synthetic two-level design: object effect (shared by both configurations, so
// pairing removes it), attempt noise, a true difference `delta`, three
// attempts per task for A and one for B.
function pairedDesign(random, { objects = 24, delta = 4, objectSD = 12, attemptSD = 5 } = {}) {
  const normal = () => Math.sqrt(-2 * Math.log(1 - random.next())) * Math.cos(2 * Math.PI * random.next());
  const a = [], b = [];
  for (let o = 0; o < objects; o++) {
    const object = 'o' + o, effect = 60 + objectSD * normal();
    for (const variant of ['t2', 't4', 'c1']) {
      for (let n = 1; n <= 3; n++) a.push(made({ object, variant, attempt: n, model: 'A', score: effect + delta + attemptSD * normal() }));
      b.push(made({ object, variant, model: 'B', score: effect + attemptSD * normal() }));
    }
  }
  return { a: { key: 'A', attempts: a }, b: { key: 'B', attempts: b } };
}

test('paired bootstrap: coverage of a known difference, sign, and the gain from pairing', () => {
  const random = rng('paired-design');
  const trials = 200;
  let covered = 0, aHigher = 0, separatedUnderNull = 0, tCovered = 0;
  for (let trial = 0; trial < trials; trial++) {
    const { a, b } = pairedDesign(random, { delta: 4 });
    const pair = comparePair(a, b, { seed: 'cover-' + trial, samples: 2000 });
    assert.equal(pair.objects, 24);
    assert.equal(pair.tasks, 72);
    if (pair.ci95[0] <= 4 && 4 <= pair.ci95[1]) covered++;
    if (pair.t_ci95[0] <= 4 && 4 <= pair.t_ci95[1]) tCovered++;
    if (pair.verdict === 'a_higher') aHigher++;
    const nullDesign = pairedDesign(random, { delta: 0 });
    if (comparePair(nullDesign.a, nullDesign.b, { seed: 'null-' + trial, samples: 2000 }).excludes_zero) separatedUnderNull++;
  }
  // 24 objects: the percentile bootstrap runs a little narrow (about 93 %).
  assert.ok(covered / trials > 0.88 && covered / trials < 0.99, 'bootstrap coverage ' + covered / trials);
  assert.ok(tCovered / trials > 0.9, 't coverage ' + tCovered / trials);
  // Per-object difference sd is about 3.3, so +4 over 24 objects is ~6 standard errors.
  assert.equal(aHigher, trials, 'a true +4 is always found with the right sign');
  assert.ok(separatedUnderNull / trials < 0.12, 'false separations under no difference: ' + separatedUnderNull / trials);

  // Pairing removes the object effect: the paired interval is far narrower
  // than either configuration's own interval over objects.
  const { a, b } = pairedDesign(rng('width'), { delta: 4, objectSD: 15 });
  const pair = comparePair(a, b, { seed: 'w' });
  const board = buildLeaderboard({ attempts: [...a.attempts, ...b.attempts], batches: [], problems: [] }, { now: NOW });
  const own = board.entries.find(entry => entry.key === 'sys / A / -').score.ci95;
  assert.ok(pair.ci95[1] - pair.ci95[0] < 0.5 * (own[1] - own[0]), 'paired ' + (pair.ci95[1] - pair.ci95[0]) + ' vs own ' + (own[1] - own[0]));
  assert.ok(pair.share_a_higher > 0.99);
  assert.match(pair.statement, /^A scored higher than B: A - B = \+\d\.\d points per object; the 95% bootstrap interval \[\+[\d.]+, \+[\d.]+\] and the Student-t interval \[\+[\d.]+, \+[\d.]+\] both exclude zero/);
  assert.ok(!pair.small_sample);
  // Same seed, same numbers.
  assert.deepEqual(comparePair(a, b, { seed: 'w' }), pair);
});

test('pairwise by hand: hierarchical means, common tasks only, ties, unequal attempt counts', () => {
  const a = [
    // x-t2: A attempts 10, 20, 90 -> task mean 40; B one attempt 40 -> level on this task.
    made({ object: 'x', variant: 't2', attempt: 1, score: 10 }), made({ object: 'x', variant: 't2', attempt: 2, score: 20 }), made({ object: 'x', variant: 't2', attempt: 3, score: 90 }),
    // x-t4: A 70; B 50 -> +20. Object x: A (40 + 70) / 2 = 55, B (40 + 50) / 2 = 45 -> +10.
    made({ object: 'x', variant: 't4', score: 70 }),
    // y-t2: A 30 vs B 30 -> a tie on the object.
    made({ object: 'y', variant: 't2', score: 30 }),
    // y-c1 is run by A only: left out of the pair.
    made({ object: 'y', variant: 'c1', score: 100 }),
    // z-t2: A 20 vs B 60 -> -40.
    made({ object: 'z', variant: 't2', score: 20 }),
  ];
  const b = [made({ object: 'x', variant: 't2', model: 'B', score: 40 }), made({ object: 'x', variant: 't4', model: 'B', score: 50 }),
    made({ object: 'y', variant: 't2', model: 'B', score: 30 }), made({ object: 'z', variant: 't2', model: 'B', score: 60 }),
    made({ object: 'w', variant: 't2', model: 'B', score: 99 })];
  const pair = comparePair({ key: 'A', attempts: a }, { key: 'B', attempts: b }, { seed: 'hand' });
  assert.deepEqual(pair.per_object.map(row => [row.object, row.tasks, row.a, row.b, row.difference]),
    [['x', 2, 55, 45, 10], ['y', 1, 30, 30, 0], ['z', 1, 20, 60, -40]]);
  near(pair.mean_difference, -10);
  assert.deepEqual([pair.won, pair.tied, pair.lost], [1, 1, 1]);
  assert.deepEqual([pair.objects, pair.tasks, pair.unpaired_objects, pair.unpaired_tasks], [3, 4, 1, 2]);
  assert.equal(pair.verdict, 'not_separated');
  assert.ok(pair.small_sample && !pair.low_evidence);
  // t interval on [10, 0, -40]: mean -10, sd 26.458, t(0.975, 2) = 4.3027.
  near(pair.t_ci95[0], -10 - 4.302653 * 26.457513 / Math.sqrt(3), 1e-3);
  assert.match(pair.statement, /^Not separated: A - B = -10\.0 points per object; the 95% bootstrap interval \[-[\d.]+, \+[\d.]+\] and the Student-t interval \[-[\d.]+, \+[\d.]+\] both include zero/);
  assert.match(pair.statement, /Only 3 objects: at this size the bootstrap interval runs too narrow/);
  assert.match(pair.statement, /won 1, tied 1, lost 1 of 3 objects/);
  // Five objects, all won (the pilot's two strongest configurations): the
  // bootstrap interval excludes zero, the t interval just includes it, so the
  // pair is unsettled rather than separated, and the bound near zero is not
  // printed as 0.0.
  const five = [3.085, 6.4075, 1.98333, 8.02333, 0.28667];
  const close = comparePair({ key: 'A', attempts: five.map((d, i) => made({ object: 'p' + i, score: 70 + d })) },
    { key: 'B', attempts: five.map((d, i) => made({ object: 'p' + i, model: 'B', score: 70 })) }, { seed: 'pilot-like' });
  assert.equal(close.excludes_zero, true);
  assert.equal(close.t_excludes_zero, false);
  assert.equal(close.verdict, 'unsettled');
  assert.deepEqual([close.won, close.lost, close.share_a_higher], [5, 0, 1]);
  assert.match(close.statement, /^Unsettled: A - B = \+4\.0 points per object; the 95% bootstrap interval \[\+[\d.]+, \+[\d.]+\] excludes zero but the Student-t interval \[-0\.00\d, \+7\.9\] includes it \(A ahead in all 10000 resamples; A won 5, tied 0, lost 0 of 5 objects\)/);
  // Ranked higher on its own tasks, lower on the tasks both ran: A also ran c1,
  // which B did not, so A leads the leaderboard while B wins every paired object.
  const ranked = buildLeaderboard({ attempts: [
    ...[0, 1, 2, 3, 4].flatMap(i => [made({ object: 'o' + i, variant: 't2', score: 50 }), made({ object: 'o' + i, variant: 'c1', score: 100 })]),
    ...[60, 61, 59, 62, 58].map((score, i) => made({ object: 'o' + i, variant: 't2', score, model: 'B' })),
  ], batches: [], problems: [] }, { now: NOW });
  assert.deepEqual(ranked.entries.map(entry => entry.key), ['sys / A / -', 'sys / B / -']);
  const reversed = ranked.sets[0].pairwise.pairs[0];
  assert.deepEqual([reversed.a, reversed.verdict, reversed.lost, reversed.unpaired_tasks], ['sys / A / -', 'b_higher', 5, 5]);
  near(reversed.mean_difference, -10);
  assert.match(reversed.statement, /^sys \/ B \/ - scored higher than sys \/ A \/ - on the objects both ran: A - B = -10\.0 points per object/);
  // One paired object: no interval, said in words.
  const single = comparePair({ key: 'A', attempts: a.filter(item => item.object === 'z') }, { key: 'B', attempts: b }, { seed: 'one' });
  assert.equal(single.verdict, 'not_evaluated');
  assert.equal(single.ci95, null);
  assert.match(single.statement, /not evaluated, only 1 object run by both/);
  assert.equal(pairedBootstrap([3]), null);
  const all = pairedBootstrap([1, 2, 3], { seed: 's', samples: 500 });
  assert.deepEqual([all.share_a_higher, all.share_b_higher, all.share_level], [1, 0, 0]);
  near(studentQuantile(0.975, 4), 2.776445, 1e-5);
  near(tInterval([1, 2, 3, 4, 5])[1], 3 + 2.776445 * Math.sqrt(2.5) / Math.sqrt(5), 1e-5);
});

test('excluded attempts are not samples; configurations with different attempt counts compare on means', async () => {
  // Excluded attempts never reach a pair: A's infra_error 0 on x would otherwise
  // drag A's x-t2 mean from 50 to 25.
  const attempts = [made({ object: 'x', score: 50 }), made({ object: 'x', attempt: 2, score: 0, status: 'infra_error', excluded: true, valid: false }),
    made({ object: 'y', score: 70 }), made({ object: 'x', model: 'B', score: 40 }), made({ object: 'y', model: 'B', score: 60 }),
    made({ object: 'x', model: 'C', score: 0, status: 'infra_error', excluded: true, valid: false })];
  const board = buildLeaderboard({ attempts, batches: [], problems: [] }, { now: NOW });
  const set = board.sets[0];
  assert.equal(set.id, 'unnamed');
  assert.deepEqual(set.configurations, ['sys / A / -', 'sys / B / -']);
  assert.deepEqual(set.unranked, [{ key: 'sys / C / -', excluded_attempts: 1 }], 'a configuration with only excluded attempts is listed, not dropped');
  assert.equal(set.pairwise.pairs.length, 1);
  assert.deepEqual(set.pairwise.pairs[0].per_object.map(row => row.difference), [10, 10]);
  assert.equal(board.entries[0].score.attempts, 2);
  assert.deepEqual(board.entries[0].attempts_per_task, { min: 1, max: 1, mean: 1 });
  assert.deepEqual(board.excluded.map(item => item.cell), ['sys / A / -', 'sys / C / -']);

  // From files: the synthetic multi-attempt design (two strong configurations at
  // three attempts per task, one weak at one, an infra_error, a timeout).
  await withData({ attempts: syntheticDesign({ objects: 4, sets: ['solo'] }), withModels: false, withInputs: false }, async dataRoot => {
    const board = await aggregate({ dataRoot, outFile: null, now: NOW });
    const strong = board.entries.find(entry => entry.model === 'synthetic-strong'), weak = board.entries.find(entry => entry.model === 'synthetic-weak');
    assert.deepEqual(strong.attempts_per_task, { min: 3, max: 3, mean: 3 });
    assert.deepEqual(weak.attempts_per_task, { min: 1, max: 1, mean: 1 });
    assert.equal(weak.attempts, 11, '12 tasks, one infra_error left out');
    assert.equal(weak.tasks, 11);
    assert.deepEqual(board.excluded.map(item => [item.cell, item.status, item.reason]), [['codex / synthetic-weak / low', 'infra_error', 'rate_limit']]);
    const second = board.entries.find(entry => entry.model === 'synthetic-second');
    assert.equal(second.status_counts.timeout, 1, 'a timeout is a sample and scores 0');
    assert.equal(second.attempts, 36);
    // The weak configuration's pairs use 11 common tasks; the task it lost to the
    // harness is unpaired, not a zero.
    const pair = board.sets[0].pairwise.pairs.find(item => item.b === weak.key && item.a === strong.key);
    assert.deepEqual([pair.objects, pair.tasks, pair.unpaired_tasks], [4, 11, 1]);
    assert.equal(pair.verdict, 'a_higher');
    // score_error is excluded by default: the scorer failed, not the contestant.
    assert.ok(board.method.excluded_statuses.includes('score_error'));
  });
});

test('sets are never pooled: grouping, separate ranks and pairs, unnamed and unknown sets', async () => {
  const design = syntheticDesign({ objects: 4, sets: ['alpha', 'beta'] });
  // The demo tasks carry no set at all.
  const unnamed = SAMPLE_ATTEMPTS.filter(spec => spec.batch === 'demo-claude');
  await withData({ attempts: [...design, ...unnamed], withModels: false, withInputs: false }, async (dataRoot, info, root) => {
    // A task whose truth.json is missing entirely.
    await rm(join(dataRoot, 'truth', 'demo-house-b-t1'), { recursive: true });
    const board = await aggregate({ dataRoot, outFile: null, now: NOW });
    assert.deepEqual(board.sets.map(set => set.id), ['alpha', 'beta', 'unnamed', 'unknown']);
    assert.deepEqual(board.sets.map(set => set.named), [true, true, false, false]);
    for (const set of board.sets) {
      const entries = board.entries.filter(entry => entry.set === set.id);
      assert.deepEqual(entries.map(entry => entry.rank), entries.map((_, index) => index + 1));
      assert.deepEqual(set.configurations, entries.map(entry => entry.key));
      // Every pair compares two configurations of this set on this set's objects only.
      const objects = new Set(board.tasks.filter(task => task.set === set.id).map(task => task.object));
      for (const pair of set.pairwise.pairs) for (const row of pair.per_object) assert.ok(objects.has(row.object));
    }
    const alpha = board.entries.filter(entry => entry.set === 'alpha'), beta = board.entries.filter(entry => entry.set === 'beta');
    assert.equal(alpha.length, 3);
    assert.equal(beta.length, 3);
    assert.deepEqual([alpha[0].objects, beta[0].objects], [2, 2], 'the same configuration is ranked once per set, on that set\'s objects');
    assert.equal(board.sets.find(set => set.id === 'alpha').pairwise.comparisons, 3);
    assert.ok(board.problems.some(problem => /no truth\.json for task demo-house-b-t1/.test(problem)));
    assert.equal(board.tasks.find(task => task.task_id === 'demo-house-b-t1').set, 'unknown');

    const outDir = join(root, 'site');
    await writeReport({ dataRoot, outDir, size: 64, now: NOW });
    const index = await readFile(join(outDir, 'index.html'), 'utf8');
    assert.match(index, /This report covers 4 task sets/);
    assert.match(index, /no number on this page pools two sets/);
    for (const id of ['alpha', 'beta', 'unnamed', 'unknown']) assert.match(index, new RegExp('<section id="set-' + id + '">'));
    assert.equal((index.match(/<h3>Pairwise comparison<\/h3>/g) ?? []).length, 4);
    const page = await readFile(join(outDir, 'tasks', design[0].object + '-t2.html'), 'utf8');
    assert.match(page, /<dt>Set<\/dt><dd><code>alpha<\/code>/);
  });
});

test('batches of one configuration merge; provenance is shown and disagreements are flagged', async () => {
  const design = syntheticDesign({ objects: 3, sets: ['solo'] });
  const batchMeta = {
    // The second batch of the strong configuration ran a newer CLI and its
    // reports are stamped with a scorer hash; the second configuration's
    // reports carry other tolerance rows and name the shape rows.
    'synth-strong-2': { cli_version: 'synthetic-codex 0.0.1', report_scorer_sha256: 'a'.repeat(64) },
    'synth-second': { thresholds: [0.005, 0.01, 0.03], shapeFractions: [0.01, 0.03] },
  };
  await withData({ attempts: design, withModels: false, withInputs: false, batchMeta }, async (dataRoot, info, root) => {
    // A batch listed twice is read once; an unfinished attempt has no result.json.
    await mkdir(join(dataRoot, 'runs', 'synth-weak', design[0].object + '-t2', 'a2'), { recursive: true });
    const board = await aggregate({ dataRoot, batches: [...info.batches, 'synth-weak'], outFile: null, now: NOW });
    assert.ok(board.problems.some(problem => /listed more than once were read once: synth-weak/.test(problem)));
    const strong = board.entries.find(entry => entry.model === 'synthetic-strong');
    assert.deepEqual(strong.batches, ['synth-strong-1', 'synth-strong-2']);
    assert.equal(strong.attempts, 27);
    assert.deepEqual(strong.attempts_per_task, { min: 3, max: 3, mean: 3 });
    assert.deepEqual(strong.provenance_conflicts.map(conflict => conflict.field).sort(), ['cli_sha256', 'cli_version', 'scorer']);
    assert.ok(board.problems.some(problem => /codex \/ synthetic-strong \/ high merges batches that differ in CLI version: synth-strong-1 = synthetic-codex 0\.0\.0; synth-strong-2 = synthetic-codex 0\.0\.1/.test(problem)));
    // The same scorer difference is a set-level warning: configurations scored differently.
    assert.ok(board.sets[0].warnings.some(warning => /differ in scorer/.test(warning)));
    const weak = board.batches.find(batch => batch.id === 'synth-weak');
    assert.equal(weak.unfinished, 1);
    assert.equal(weak.attempts, 9);
    assert.equal(weak.excluded, 1);
    assert.equal(weak.preflight.passed, true);
    assert.equal(weak.preflight.bound_to_manifest, true);
    assert.equal(weak.manifest.cli_version, 'synthetic-codex 0.0.0');
    assert.equal(weak.manifest.prompt_sha256.length, 1);
    assert.match(weak.first_started_at, /^2026-09-/);
    assert.ok(weak.first_started_at < weak.last_finished_at);
    assert.equal(board.batches.find(batch => batch.id === 'synth-strong-2').scorer_sha256[0], 'a'.repeat(64));
    // Tolerance rows are read as they come: the union, and the rows named as shape rows.
    assert.deepEqual(board.tolerances.fractions, [0.005, 0.01, 0.02, 0.03, 0.05]);
    assert.equal(board.tolerances.consistent, false);
    assert.deepEqual(board.tolerances.shape_score_fractions, [0.01, 0.03]);

    const outDir = join(root, 'site');
    await writeReport({ dataRoot, batches: info.batches, outDir, size: 64, now: NOW });
    const index = await readFile(join(outDir, 'index.html'), 'utf8');
    assert.match(index, /<h2>Provenance<\/h2>/);
    assert.match(index, /synthetic-codex 0\.0\.1/);
    assert.match(index, /class="differs"/);
    assert.match(index, /Configurations merged from batches that differ/);
    assert.match(index, /e3d-runner-prompt-v1/);
    assert.match(index, /bound to this manifest/);
    assert.match(index, /not recorded/, 'batches whose reports carry no scorer hash say so');
    assert.match(index, /2026-09-0\d \d\d:\d\d:\d\dZ/);
    // The task page shows the tolerance rows the reports carry and marks the shape rows.
    const task = await readFile(join(outDir, 'tasks', design[0].object + '-t2.html'), 'utf8');
    assert.match(task, /F@0\.5%/);
    assert.match(task, /F@3% <span title="enters the shape score">/);
    assert.match(task, /F@2% <small>/, 'a row no report names is not marked');
    assert.match(task, /rows marked &#9670; where the report names them/);
    assert.ok(!/mean F at 1, 2, 5/.test(task));
  });
});

test('the runner\'s batch-relative report path and a model the harness reported differently', async () => {
  await withData({ attempts: SAMPLE_ATTEMPTS.filter(spec => spec.batch === 'demo-claude'), withModels: false, withInputs: false }, async dataRoot => {
    const dir = join(dataRoot, 'runs', 'demo-claude', 'demo-house-a-t1', 'a1');
    const report = JSON.parse(await readFile(join(dir, 'score', 'report.json'), 'utf8'));
    await rm(join(dir, 'score'), { recursive: true });
    await mkdir(join(dir, 'scored'), { recursive: true });
    await writeFile(join(dir, 'scored', 'report.json'), JSON.stringify({ ...report, score: 64 }));
    const result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
    await writeFile(join(dir, 'result.json'), JSON.stringify({ ...result, score: 64, report: 'demo-house-a-t1/a1/scored/report.json', model_reported: 'opus-demo-2' }));
    const board = await aggregate({ dataRoot, outFile: null, now: NOW });
    const task = board.tasks.find(item => item.task_id === 'demo-house-a-t1');
    assert.equal(task.cells[CLAUDE].mean, 64);
    assert.ok(board.problems.some(problem => /requested model opus-demo but the harness reported opus-demo-2/.test(problem)));
    assert.deepEqual(board.batches[0].models_reported, ['opus-demo-2']);
    // A batch copied under a second name carries the same artifacts: flagged.
    await cp(join(dataRoot, 'runs', 'demo-claude'), join(dataRoot, 'runs', 'demo-claude-copy'), { recursive: true });
    for (const batch of ['demo-claude', 'demo-claude-copy']) {
      const path = join(dataRoot, 'runs', batch, 'demo-house-b-t1', 'a1', 'result.json');
      await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), artifact: { sha256: 'b'.repeat(64) } }));
    }
    const copied = await aggregate({ dataRoot, outFile: null, now: NOW });
    assert.ok(copied.problems.some(problem => /byte-identical submissions in demo-claude\/demo-house-b-t1\/a1, demo-claude-copy\/demo-house-b-t1\/a1/.test(problem)));
  });
});

test('candidate models that are links or fail their recorded hash are not drawn', async () => {
  await withData({ withModels: true }, async (dataRoot, info, root) => {
    const secret = join(root, 'secret.glb');
    await writeFile(secret, await readFile(join(dataRoot, 'runs', 'demo-claude', 'demo-house-a-t1', 'a1', 'output', 'model.glb')));
    const planted = join(dataRoot, 'runs', 'demo-claude', 'demo-house-a-t1', 'a1', 'output', 'model.glb');
    await unlink(planted);
    await symlink(secret, planted);
    const hardLinked = join(dataRoot, 'runs', 'demo-claude', 'demo-house-b-t1', 'a1', 'output', 'model.glb');
    await link(hardLinked, join(root, 'second-name.glb'));
    const hashed = join(dataRoot, 'runs', 'demo-codex', 'demo-house-c-t2', 'a1', 'result.json');
    await writeFile(hashed, JSON.stringify({ ...JSON.parse(await readFile(hashed, 'utf8')), artifact: { sha256: 'f'.repeat(64) } }));
    const result = await writeReport({ dataRoot, batches: info.batches, outDir: join(root, 'site'), size: 96, now: NOW });
    // The return value is compact; the full leaderboard is in leaderboard.json.
    const problems = JSON.parse(await readFile(result.leaderboard, 'utf8')).problems.join('\n');
    assert.ok(result.problems >= 3);
    assert.match(problems, /demo-house-a-t1\/a1\/output\/model\.glb is a link/);
    assert.match(problems, /demo-house-b-t1\/a1\/output\/model\.glb is a link/);
    assert.match(problems, /does not match the artifact hash/);
    const page = await readFile(join(root, 'site', 'tasks', 'demo-house-a-t1.html'), 'utf8');
    assert.match(page, /model file not found/);
    // The recorded hash is checked when the file is about to be drawn.
    assert.match(await readFile(join(root, 'site', 'tasks', 'demo-house-c-t2.html'), 'utf8'), /model file does not match its recorded hash; not drawn/);
    assert.ok(!(await readdir(join(root, 'site', 'assets', 'renders', 'demo-house-c-t2'))).some(name => name.startsWith('demo-codex--a1-')));
    const renders = await readdir(join(root, 'site', 'assets', 'renders', 'demo-house-a-t1'));
    assert.ok(!renders.some(name => name.startsWith('demo-claude--a1')), 'the linked file must not be rendered');
    assert.ok(renders.some(name => name.startsWith('demo-codex--a1')), 'other candidates still are');
  });
});

// ------------------------------------------------------------ variance, breakdowns, scale

test('variance components match a hand calculation', () => {
  // Distribution functions against table values.
  near(chiSquareQuantile(0.025, 4), 0.484419, 1e-5);
  near(chiSquareQuantile(0.975, 4), 11.143287, 1e-5);
  near(chiSquareQuantile(0.025, 1), 0.000982069, 1e-8);
  near(chiSquareQuantile(0.975, 1), 5.023886, 1e-5);
  near(chiSquareQuantile(0.975, 23), 38.075627, 1e-4);
  near(studentQuantile(0.8, 2), 1.060660, 1e-5);
  near(studentQuantile(0.8, 23), 0.857530, 1e-5);
  // Pooled SD: groups [1, 3] and [2, 4, 6] give squares 2 + 8 over 1 + 2 df; a single value adds nothing.
  assert.deepEqual(pooledSD([[1, 3], [2, 4, 6], [5]]), { sd: Math.sqrt(10 / 3), df: 3, groups: 2, values: 5 });
  assert.deepEqual(pooledSD([[1], [2]]), { sd: null, df: 0, groups: 0, values: 0 });
  // 95 % range of an SD of 2 on 4 df: 2 * sqrt(4 / chi2(0.975)) .. 2 * sqrt(4 / chi2(0.025)).
  const range = sdRange(2, 4);
  near(range[0], 2 * Math.sqrt(4 / 11.143287), 1e-5);
  near(range[1], 2 * Math.sqrt(4 / 0.484419), 1e-4);
  assert.equal(sdRange(null, 4), null);
  // sd 3 over 9 objects: se 1, t(0.975, 8) = 2.306004, t(0.8, 8) = 0.888890.
  const detect = detectableDifference(3, 9);
  near(detect.resolution, 2.306004, 1e-5);
  near(detect.detectable, 2.306004 + 0.888890, 1e-5);
  assert.equal(detectableDifference(3, 1), null);

  // A: two attempts on four of six tasks; B: one attempt everywhere.
  const A = [['x', 't2', [50, 54]], ['x', 't4', [70]], ['y', 't2', [40, 46]], ['y', 't4', [60, 64]], ['z', 't2', [80]], ['z', 't4', [90, 86]]];
  const B = [['x', 't2', 45], ['x', 't4', 66], ['y', 't2', 44], ['y', 't4', 58], ['z', 't2', 70], ['z', 't4', 85]];
  const attempts = [
    ...A.flatMap(([object, variant, scores]) => scores.map((score, i) => made({ object, variant, score, attempt: i + 1 }))),
    ...B.map(([object, variant, score]) => made({ object, variant, score, model: 'B' })),
  ];
  const board = buildLeaderboard({ attempts, batches: [], problems: [] }, { now: NOW, plannedObjects: 24 });
  const variance = board.sets[0].variance;
  const [a, b] = variance.configurations;
  assert.deepEqual([a.key, b.key], ['sys / A / -', 'sys / B / -']);
  // Between attempts, A: squared deviations 8 + 18 + 8 + 8 = 42 over 4 df.
  near(a.attempt_sd.sd, Math.sqrt(42 / 4));
  assert.deepEqual([a.attempt_sd.df, a.attempt_sd.tasks, a.attempt_sd.attempts, a.attempt_sd.failures, a.attempt_sd.little_data], [4, 4, 8, 0, true]);
  near(a.attempt_sd.ci95[0], Math.sqrt(10.5) * Math.sqrt(4 / 11.143287), 1e-4);
  assert.equal(b.attempt_sd.sd, null, 'no task run twice: no attempt SD');
  assert.equal(b.attempt_sd.df, 0);
  // Between objects, A: object means 61, 52.5, 84; B: 55.5, 51, 77.5.
  const sd = values => { const m = values.reduce((s, v) => s + v, 0) / values.length; return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1)); };
  near(a.object_sd.sd, sd([61, 52.5, 84]));
  near(b.object_sd.sd, sd([55.5, 51, 77.5]));
  assert.deepEqual([a.object_sd.df, a.object_sd.objects], [2, 3]);
  // Attempt noise in A's object means: per object sum(1 / attempts) / tasks^2 = 0.375, 0.25, 0.375.
  near(a.object_sd.attempt_share, 10.5 * (1 / 3) / sd([61, 52.5, 84]) ** 2);
  // Paired differences 5.5, 1.5, 6.5: mean 4.5, SD sqrt(7).
  const [pair] = variance.pairs;
  near(pair.difference_sd.sd, Math.sqrt(7));
  assert.equal(pair.difference_sd.df, 2);
  near(pair.resolution, 4.302653 * Math.sqrt(7) / Math.sqrt(3), 1e-4);
  near(pair.detectable, (4.302653 + 1.060660) * Math.sqrt(7) / Math.sqrt(3), 1e-4);
  near(pair.projected.resolution, 2.068658 * Math.sqrt(7) / Math.sqrt(24), 1e-4);
  near(pair.projected.detectable, (2.068658 + 0.857530) * Math.sqrt(7) / Math.sqrt(24), 1e-4);
  assert.equal(pair.projected.objects, 24);
  // Only A ran tasks twice: its attempt noise is a lower bound on the share, 10.5 * (1/3) / 7 = 0.5.
  assert.equal(pair.attempt_share, null);
  near(pair.attempt_share_at_least, 0.5);
  assert.match(pair.statement, /SD 2\.6 over 3 objects \(95% range 1\.4 to 16\.6\), which rests on little data/);
  assert.match(pair.statement, /must exceed 6\.6 points/);
  assert.match(pair.statement, /at least 50% of that variance/);
  // The set summary pools attempts over configurations and says the df is small.
  near(variance.attempt_sd_pooled.sd, Math.sqrt(10.5));
  assert.match(variance.summary, /between attempts on the same task with SD 3\.2 \(pooled, 4 degrees of freedom, little data\)/);
  // A share estimated from two noisy variances can exceed 100 %: said as "all", never capped silently.
  assert.deepEqual([attemptShareText(0.4), attemptShareText(1.42), attemptShareText(0.5, { atLeast: true }), attemptShareText(2.3, { atLeast: true }), attemptShareText(null)],
    ['40%', 'all (estimate 142%)', '≥ 50%', 'all (lower bound estimate 230%)', null]);
  const over = { a: 'A', b: 'B', objects: 24, difference_sd: { sd: 2, df: 23, ci95: [1.5, 2.8], little_data: false }, resolution: 0.8, detectable: 1.2,
    detectable_range: [0.9, 1.7], projected: null, attempt_share: 1.3, attempt_share_at_least: null, without_attempt_noise: { sd: 0, at_objects: 0, at_planned: 0 } };
  assert.match(varianceStatement(over), /Attempt noise alone accounts for all of that variance \(its estimate is 130% of it\)/);
  assert.ok(!/would be 0\.0/.test(varianceStatement(over)), 'no detectable difference of 0.0 is claimed');
  // Projections are only made to more objects than the data has.
  assert.equal(buildLeaderboard({ attempts, batches: [], problems: [] }, { now: NOW, plannedObjects: 3 }).sets[0].variance.pairs[0].projected, null);
});

test('variance from files: attempt noise is recovered and its share of a paired difference estimated', async () => {
  await withData({ attempts: syntheticDesign({ objects: 12, sets: ['solo'], attemptSD: 4 }), withModels: false, withInputs: false }, async dataRoot => {
    const board = await aggregate({ dataRoot, outFile: null, now: NOW });
    const variance = board.sets[0].variance;
    const strong = variance.configurations.find(item => item.key === 'codex / synthetic-strong / high');
    // 36 tasks x 3 attempts: 72 df, the true attempt SD is 4 (scores are rounded to 0.01).
    assert.equal(strong.attempt_sd.df, 72);
    assert.equal(strong.attempt_sd.little_data, false);
    assert.ok(strong.attempt_sd.sd > 3.2 && strong.attempt_sd.sd < 5, 'attempt SD ' + strong.attempt_sd.sd);
    assert.ok(strong.attempt_sd.ci95[0] < 4 && 4 < strong.attempt_sd.ci95[1]);
    assert.equal(strong.object_sd.df, 11);
    // The second configuration's timeout (a 0 among ~60s) shows up as a failure inside its attempt SD.
    const second = variance.configurations.find(item => item.key === 'claude-code / synthetic-second / high');
    assert.equal(second.attempt_sd.failures, 1);
    assert.ok(second.attempt_sd.sd > strong.attempt_sd.sd);
    // The weak configuration ran each task once: nothing to pool.
    const weak = variance.configurations.find(item => item.key === 'codex / synthetic-weak / low');
    assert.equal(weak.attempt_sd.sd, null);
    // Strong vs weak: only the strong side's attempt noise is known, so the share is a lower bound;
    // strong vs second: both are known, and the design has no configuration-by-object effect, so
    // nearly all of the paired variance is attempt noise.
    const strongWeak = variance.pairs.find(row => row.a === strong.key && row.b === weak.key);
    assert.equal(strongWeak.attempt_share, null);
    assert.ok(strongWeak.attempt_share_at_least > 0);
    const strongSecond = variance.pairs.find(row => [row.a, row.b].includes(strong.key) && [row.a, row.b].includes(second.key));
    assert.ok(strongSecond.attempt_share > 0.5, 'attempt share ' + strongSecond.attempt_share);
    assert.ok(strongSecond.without_attempt_noise.sd < strongSecond.difference_sd.sd);
    assert.equal(strongSecond.projected.objects, 24);
    assert.ok(strongSecond.projected.detectable < strongSecond.detectable);
  });
});

test('evidence deltas for every pair of variants and archetype breakdowns, paired by object', async () => {
  assert.deepEqual(variantPairs(['c1', 't4', 't2']), [['t4', 't2'], ['c1', 't2'], ['c1', 't4']]);
  assert.deepEqual(variantPairs(['t1', 't2', 't3', 't4']).map(pair => pair.join('-')), ['t2-t1', 't3-t1', 't3-t2', 't4-t1', 't4-t2', 't4-t3']);
  assert.deepEqual(variantPairs(['t2']), []);
  const attempts = [
    made({ object: 'p', variant: 't2', score: 40, archetype: 'house' }), made({ object: 'p', variant: 't4', score: 60, archetype: 'house' }),
    made({ object: 'p', variant: 'c1', score: 55, archetype: 'house' }),
    made({ object: 'q', variant: 't2', score: 50, archetype: 'house' }), made({ object: 'q', variant: 't4', score: 65, archetype: 'house' }),
    made({ object: 'q', variant: 't4', score: 75, attempt: 2, archetype: 'house' }), made({ object: 'q', variant: 'c1', score: 60, archetype: 'house' }),
    made({ object: 'r', variant: 't2', score: 30, archetype: 'tower' }), made({ object: 'r', variant: 't4', score: 56, archetype: 'tower' }),
    // B ran t2 only: its deltas are not evaluated, never zero.
    made({ object: 'p', variant: 't2', score: 20, model: 'B', archetype: 'house' }), made({ object: 'r', variant: 't2', score: 25, model: 'B', archetype: 'tower' }),
  ];
  const board = buildLeaderboard({ attempts, batches: [], problems: [] }, { now: NOW });
  const set = board.sets[0];
  assert.deepEqual(set.variants, ['t2', 't4', 'c1']);
  assert.deepEqual(set.variant_pairs, ['t4-t2', 'c1-t2', 'c1-t4']);
  assert.deepEqual(set.archetypes, [{ id: 'house', objects: 2 }, { id: 'tower', objects: 1 }]);
  const a = board.entries.find(entry => entry.key === 'sys / A / -'), b = board.entries.find(entry => entry.key === 'sys / B / -');
  // t4 - t2 per object: p 20, q (65 + 75) / 2 - 50 = 20, r 26.
  const t4t2 = a.evidence_deltas['t4-t2'];
  assert.deepEqual([t4t2.high, t4t2.low, t4t2.pairs, t4t2.unpaired_objects], ['t4', 't2', 3, 0]);
  near(t4t2.mean, 22);
  near(t4t2.t_ci95[0], 22 - 4.302653 * Math.sqrt(12) / Math.sqrt(3), 1e-4);
  // c1 - t4: p -5, q -10; r has no c1.
  const c1t4 = a.evidence_deltas['c1-t4'];
  near(c1t4.mean, -7.5);
  assert.deepEqual([c1t4.pairs, c1t4.unpaired_objects, c1t4.low_evidence], [2, 1, true]);
  near(a.evidence_deltas['c1-t2'].mean, 12.5);
  // The ladder of adjacent rungs agrees where it overlaps (same seed, same interval).
  assert.deepEqual(a.ladder['t4-t3'].pairs, 0);
  assert.equal(b.evidence_deltas['t4-t2'].mean, null);
  assert.equal(b.evidence_deltas['t4-t2'].pairs, 0);
  // Archetypes: house = mean(p 51.67, q 60), tower = r 43; the same averaging as the score.
  near(a.archetypes.house.mean, ((40 + 60 + 55) / 3 + (50 + 70 + 60) / 3) / 2);
  near(a.archetypes.tower.mean, 43);
  assert.deepEqual([a.archetypes.house.objects, a.archetypes.tower.objects, a.archetypes.tower.low_evidence], [2, 1, true]);
  near(b.archetypes.house.mean, 20);

  // From files: the archetype comes from objects/<id>/model.json.
  await withData({ attempts: syntheticDesign({ objects: 6, sets: ['solo'] }), withModels: false, withInputs: false }, async dataRoot => {
    const fromFiles = await aggregate({ dataRoot, outFile: null, now: NOW });
    assert.deepEqual(fromFiles.sets[0].archetypes, [{ id: 'hall', objects: 2 }, { id: 'house', objects: 2 }, { id: 'tower', objects: 2 }]);
    assert.ok(fromFiles.tasks.every(task => ['hall', 'house', 'tower'].includes(task.archetype)));
    const strong = fromFiles.entries.find(entry => entry.model === 'synthetic-strong');
    assert.deepEqual(Object.keys(strong.evidence_deltas), ['t4-t2', 'c1-t2', 'c1-t4']);
    // The synthetic variant effects are t2 -8, t4 +8, c1 +2: t4 - t2 = 16 and c1 - t4 = -6 plus noise.
    assert.ok(Math.abs(strong.evidence_deltas['t4-t2'].mean - 16) < 4, 't4 - t2 ' + strong.evidence_deltas['t4-t2'].mean);
    assert.ok(Math.abs(strong.evidence_deltas['c1-t4'].mean + 6) < 4, 'c1 - t4 ' + strong.evidence_deltas['c1-t4'].mean);
    // A missing model.json is a problem, and the object's archetype is "unknown".
    await rm(join(dataRoot, 'objects', fromFiles.tasks[0].object, 'model.json'));
    const missing = await aggregate({ dataRoot, outFile: null, now: NOW });
    assert.ok(missing.problems.some(problem => /no model\.json for object/.test(problem)));
    assert.ok(missing.sets[0].archetypes.some(item => item.id === 'unknown'));
  });
});

test('representatives: best, median and worst counted attempt per configuration; the rest collapsed', () => {
  const list = [
    ...[10, 50, 30, 90, 70].map((score, i) => made({ object: 'x', score, attempt: i + 1 })),
    made({ object: 'x', score: 0, attempt: 6, status: 'infra_error', excluded: true, valid: false }),
    made({ object: 'x', score: 40, model: 'B' }), made({ object: 'x', score: 40, model: 'B', attempt: 2 }),
    made({ object: 'x', score: 66, model: 'C' }),
    made({ object: 'x', score: 0, model: 'D', status: 'infra_error', excluded: true, valid: false }),
  ];
  const { shown, collapsed } = pickRepresentatives(list, ['sys / C / -', 'sys / A / -']);
  // Leaderboard order first (C, A), the rest by name (B, D).
  assert.deepEqual(shown.map(item => [item.attempt.model, item.attempt.score, item.role, item.of]),
    [['C', 66, null, 1], ['A', 90, 'best', 5], ['A', 50, 'median', 5], ['A', 10, 'worst', 5], ['B', 40, 'best', 2], ['B', 40, 'worst', 2]]);
  // Ties are broken by batch and attempt directory, so the order is stable.
  assert.deepEqual(shown.filter(item => item.attempt.model === 'B').map(item => item.attempt.slot), ['a1', 'a2']);
  assert.deepEqual(collapsed.map(item => [item.model, item.score, item.excluded]).sort(),
    [['A', 0, true], ['A', 30, false], ['A', 70, false], ['D', 0, true]].sort());
  // Four attempts: the median is the lower middle by score.
  const four = pickRepresentatives([80, 60, 40, 20].map((score, i) => made({ object: 'x', score, attempt: i + 1 })));
  assert.deepEqual(four.shown.map(item => [item.attempt.score, item.role]), [[80, 'best'], [60, 'median'], [20, 'worst']]);
});

test('scale: the truth is rendered once per object, only representatives are drawn, the return value is compact', async () => {
  const design = syntheticDesign({ objects: 2, sets: ['dev'] });
  // Two more attempts of the strong configuration on one task: five in all, so two are collapsed.
  const first = design.find(spec => spec.model === 'synthetic-strong' && spec.variant === 't2');
  const extra = [4, 5].map(attempt => ({ ...first, attempt, batch: 'synth-strong-2', score: first.score - 3 * attempt }));
  await withData({ attempts: [...design, ...extra], withModels: true, withInputs: true }, async (dataRoot, info, root) => {
    const outDir = join(root, 'site');
    const result = await writeReport({ dataRoot, batches: info.batches, outDir, size: 64, now: NOW });
    // Compact: no leaderboard in the return value, which the CLI prints.
    assert.deepEqual(Object.keys(result).sort(), ['attempts', 'attempts_drawn', 'images', 'index', 'leaderboard', 'outDir', 'problems', 'sets', 'summary', 'tasks', 'timing']);
    assert.ok(JSON.stringify(result).length < 4000, 'return value is ' + JSON.stringify(result).length + ' bytes');
    assert.deepEqual(result.sets.map(set => [set.id, set.kind, set.development]), [['dev', 'development', true]]);
    assert.deepEqual(result.sets[0].ranking.map(row => row.rank), [1, 2, 3]);
    assert.equal(result.sets[0].pairs.length, 3);
    assert.ok(result.sets[0].pairs.every(pair => ['a_higher', 'b_higher', 'not_separated', 'unsettled', 'not_evaluated'].includes(pair.verdict)));
    assert.ok(['collect_s', 'aggregate_s', 'render_s', 'total_s'].every(key => typeof result.timing[key] === 'number'));
    // 2 objects x 3 tasks; per task 3 + 3 + 1 drawn (the extra strong attempts and the weak infra_error are not).
    const counted = design.length + extra.length - 1;
    assert.equal(result.attempts, design.length + extra.length);
    assert.equal(result.attempts_drawn, counted - 2 - 1, 'the timeout has no model to draw');
    assert.equal(result.images, 4 * (2 + result.attempts_drawn), 'four views per drawn attempt plus four per object for the truth');
    // Truth renders live once per object, not per task.
    for (const object of info.objects.filter(id => id.startsWith('synth-'))) {
      assert.deepEqual((await readdir(join(outDir, 'assets', 'renders', 'objects', object))).sort(), ['truth-front.png', 'truth-iso-rear.png', 'truth-iso.png', 'truth-top.png']);
    }
    const taskId = first.object + '-t2';
    const renders = await readdir(join(outDir, 'assets', 'renders', taskId));
    assert.ok(!renders.some(name => name.startsWith('truth-')));
    assert.equal(renders.filter(name => name.startsWith('synth-strong')).length, 3 * 4, 'three strong attempts drawn, four views each');
    const page = await readFile(join(outDir, 'tasks', taskId + '.html'), 'utf8');
    assert.match(page, /best of 5/);
    assert.match(page, /median of 5/);
    assert.match(page, /worst of 5/);
    assert.match(page, /<summary>2 more attempts, not drawn<\/summary>/);
    assert.match(page, /\(7 of 9 attempts\)/);
    assert.match(page, /<dt>Set<\/dt><dd><code>dev<\/code> <small class="low">development set: its objects were used to tune the scorer, so these are not test results/);
    // Evidence shared by the tasks of an object is stored once, by content.
    const inputs = await readdir(join(outDir, 'assets', 'inputs'));
    assert.equal(new Set(inputs).size, inputs.length);
    assert.ok(inputs.length < info.tasks.length * 3, inputs.length + ' input files for ' + info.tasks.length + ' tasks');
    // Every local reference resolves.
    for (const file of ['index.html', 'tasks/' + taskId + '.html']) {
      const html = await readFile(join(outDir, file), 'utf8');
      for (const [, reference] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) await readFile(resolve(dirname(join(outDir, file)), reference.replace(/&amp;/g, '&')));
    }
  });
});

test('summary.md and the set notices say what a set is; dev numbers are not test results', async () => {
  const design = [...syntheticDesign({ objects: 2, sets: ['dev'] }), ...syntheticDesign({ objects: 2, sets: ['heldout'], seed: 'other' })
    .map(spec => ({ ...spec, object: spec.object.replace('synth-', 'held-') }))];
  await withData({ attempts: [...design, ...SAMPLE_ATTEMPTS.filter(spec => spec.batch === 'demo-claude')], withModels: false, withInputs: false }, async (dataRoot, info, root) => {
    // The unnamed demo tasks are listed in the dev set's build record; the held-out set has a private set file.
    await mkdir(join(dataRoot, 'sets'), { recursive: true });
    await writeFile(join(dataRoot, 'sets', 'dev.built.json'), JSON.stringify({ name: 'dev', built_at: '2026-09-30T00:00:00Z', built: [{ object: 'demo-house-a', tasks: ['demo-house-a-t1'] }] }));
    await writeFile(join(dataRoot, 'sets', 'heldout.json'), JSON.stringify({ name: 'heldout', private: true, created_at: '2026-10-02T00:00:00Z', objects: [{}, {}] }));
    const outDir = join(root, 'site');
    await writeReport({ dataRoot, outDir, size: 48, now: NOW });
    const board = JSON.parse(await readFile(join(outDir, 'leaderboard.json'), 'utf8'));
    const kinds = Object.fromEntries(board.sets.map(set => [set.id, set.description.kind]));
    assert.deepEqual(kinds, { dev: 'development', heldout: 'named', unnamed: 'unnamed' });
    assert.deepEqual(board.sets.map(set => [set.id, set.description.development]), [['dev', true], ['heldout', false], ['unnamed', true]]);
    assert.deepEqual(board.sets.find(set => set.id === 'unnamed').description.listed_in, ['dev']);
    assert.equal(board.sets.find(set => set.id === 'heldout').description.set_file.private, true);
    const index = await readFile(join(outDir, 'index.html'), 'utf8');
    const section = id => index.slice(index.indexOf('<section id="set-' + id + '">'), index.indexOf('</section>', index.indexOf('<section id="set-' + id + '">')));
    assert.match(section('dev'), /<div class="notice dev"><strong>Not test results\.<\/strong> Development set/);
    assert.match(section('unnamed'), /<div class="notice dev"><strong>Not test results\.<\/strong> The truth\.json of these tasks records no set/);
    assert.match(section('heldout'), /<div class="notice plain">Named set &quot;heldout&quot;, marked private in its set file/);
    assert.ok(!/Not test results/.test(section('heldout')));
    assert.match(index, /used to develop and tune the scorer, so its numbers are development measurements, not test results/);
    const markdown = await readFile(join(outDir, 'summary.md'), 'utf8');
    assert.equal(markdown, summaryMarkdown(board), 'summary.md is the Markdown of leaderboard.json');
    for (const heading of ['# Evidence3D results', '## Set: dev', '## Set: heldout', '## Set: unnamed', '### Leaderboard', '### Pairwise comparison', '### Where the noise is',
      '### Evidence deltas (paired by object)', '### By archetype', '## Batches', '## Caveats']) assert.ok(markdown.includes('\n' + heading + '\n') || markdown.startsWith(heading + '\n'), 'missing ' + heading);
    assert.match(markdown, /\*\*Not test results\.\*\* Development set/);
    assert.match(markdown, /\| 1 \| codex \/ synthetic-strong \/ high \| \d+\.\d \[\d+\.\d, \d+\.\d\]/);
    assert.match(markdown, /Scorer: no report carries a scorer stamp/);
    // Plain text: no HTML in the Markdown.
    assert.ok(!/<[a-z]+[ >]/.test(markdown));
  });
});

test('scorer provenance: report stamps and the manifest source are separate and compared only with themselves', async () => {
  const design = syntheticDesign({ objects: 3, sets: ['solo'] });
  const stamp = 'd'.repeat(64), source = 'c'.repeat(64);
  const batchMeta = Object.fromEntries(['synth-strong-1', 'synth-strong-2', 'synth-second', 'synth-weak'].map(id => [id, { scorer_sha256: source, report_scorer_sha256: stamp }]));
  // The second strong batch was prepared from other scorer source but scored by the same scorer.
  batchMeta['synth-strong-2'] = { scorer_sha256: 'e'.repeat(64), report_scorer_sha256: stamp };
  await withData({ attempts: design, withModels: false, withInputs: false, batchMeta }, async (dataRoot, info, root) => {
    // One report recomputed by rescore, which keeps the old one.
    const scoreDir = join(dataRoot, 'runs', 'synth-weak', design[0].object + '-t2', 'a1', 'score');
    await writeFile(join(scoreDir, 'report.previous.json'), '{}');
    const board = await aggregate({ dataRoot, outFile: null, now: NOW });
    // A stamp differing from a manifest hash is never a disagreement.
    assert.ok(!board.problems.some(problem => /scorer stamped in the reports/.test(problem)), board.problems.join('\n'));
    assert.deepEqual(board.sets[0].warnings, []);
    const strong = board.entries.find(entry => entry.model === 'synthetic-strong');
    assert.deepEqual(strong.provenance_conflicts.map(conflict => conflict.field), ['scorer_source']);
    const weak = board.batches.find(batch => batch.id === 'synth-weak');
    assert.deepEqual([weak.scorer_sha256, weak.manifest.scorer_sha256, weak.rescored, weak.reports_unstamped], [[stamp], source, 1, 0]);
    const outDir = join(root, 'site');
    await writeReport({ dataRoot, outDir, size: 48, now: NOW });
    const index = await readFile(join(outDir, 'index.html'), 'utf8');
    assert.match(index, /Scorer <small>stamped in the reports<\/small>/);
    assert.match(index, /Scorer source <small>frozen in the manifest<\/small>/);
    assert.match(index, /1 report recomputed by rescore/);
    const markdown = await readFile(join(outDir, 'summary.md'), 'utf8');
    assert.match(markdown, /Scorer stamped in the reports: dddddddddddd; 1 report was recomputed by rescore\./);
    assert.ok(!/frozen in the manifest<\/small>/.test(index.slice(index.indexOf('Scorer <small>stamped'), index.indexOf('Scorer source <small>'))),
      'no manifest stamp, so no claim about matching it');
  });
  // A manifest that also freezes the scorer's own stamp: a report from another scorer is a problem.
  await withData({ attempts: design.filter(spec => spec.batch === 'synth-weak'), withModels: false, withInputs: false,
    batchMeta: { 'synth-weak': { report_scorer_sha256: stamp } } }, async (dataRoot, info, root) => {
    const manifestPath = join(dataRoot, 'runs', 'synth-weak', 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(await readFile(manifestPath, 'utf8')), scorer: { version: '9.9.9', sha256: stamp } }));
    const clean = await aggregate({ dataRoot, outFile: null, now: NOW });
    assert.equal(clean.batches[0].reports_off_manifest, 0);
    assert.ok(!clean.problems.some(problem => /other than the one frozen/.test(problem)));
    const reportPath = join(dataRoot, 'runs', 'synth-weak', design.find(spec => spec.batch === 'synth-weak').object + '-t2', 'a1', 'score', 'report.json');
    await writeFile(reportPath, JSON.stringify({ ...JSON.parse(await readFile(reportPath, 'utf8')), scorer: { version: '9.9.10', sha256: 'f'.repeat(64) } }));
    const rescored = await aggregate({ dataRoot, outFile: null, now: NOW });
    assert.equal(rescored.batches[0].reports_off_manifest, 1);
    assert.ok(rescored.problems.some(problem => /synth-weak: 1 report was computed by a scorer other than the one frozen in manifest\.json/.test(problem)));
    await writeReport({ dataRoot, outDir: join(root, 'site'), size: 48, now: NOW });
    assert.match(await readFile(join(root, 'site', 'index.html'), 'utf8'), /1 report not by the scorer frozen in the manifest/);
  });
});
