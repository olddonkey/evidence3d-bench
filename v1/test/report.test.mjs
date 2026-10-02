import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir, symlink, link, unlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { rng } from '../lib/rng.mjs';
import { decodePNG } from '../lib/png.mjs';
import { aggregate, buildLeaderboard, writeReport, bootstrapMean, conflictShare, normaliseUsage } from '../lib/report/index.mjs';
import { writeSampleRuns, SAMPLE_ATTEMPTS } from '../lib/report/sample-runs.mjs';

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
    assert.equal(written.schema, 'e3d-leaderboard-v1');
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
    const renders = join(outDir, 'assets', 'renders', 'demo-house-a-t1');
    const image = async name => decodePNG(await readFile(join(renders, name)));
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
    const problems = result.leaderboard.problems.join('\n');
    assert.match(problems, /demo-house-a-t1\/a1\/output\/model\.glb is a link/);
    assert.match(problems, /demo-house-b-t1\/a1\/output\/model\.glb is a link/);
    assert.match(problems, /does not match the artifact hash/);
    const page = await readFile(join(root, 'site', 'tasks', 'demo-house-a-t1.html'), 'utf8');
    assert.match(page, /model file not found/);
    const renders = await readdir(join(root, 'site', 'assets', 'renders', 'demo-house-a-t1'));
    assert.ok(!renders.some(name => name.startsWith('demo-claude--a1')), 'the linked file must not be rendered');
    assert.ok(renders.some(name => name.startsWith('demo-codex--a1')), 'other candidates still are');
  });
});
