import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { modelToGLB } from '../lib/model.mjs';
import { sampleModel } from '../fixtures/sample-model.mjs';
import { prepare, preflight, execute, summarize } from '../lib/runner/index.mjs';
import { startMock } from '../lib/runner/api/mock/server.mjs';
import { makeDataRoot, fakeInstallTools, fakeScorer, buildSteps } from '../lib/runner/api/mock/fixtures.mjs';
import { textSource } from '../lib/runner/hostsleep.mjs';
import { writeReport, aggregate } from '../lib/report/index.mjs';

// End to end against the local mock APIs: prepare, the model-free preflight
// (plus its one live request, here to the mock), run, a scored result, and
// the report over the batch. The loop, the sandbox and the file tools are the
// real ones; only the model and the scorer are stand-ins.
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = path => lstat(path).then(() => true, () => false);
const GLB = modelToGLB(sampleModel());
const FAST_RETRY = { backoff_ms: [20, 20, 20], rate_wait_max_ms: 2000, rate_wait_total_ms: 4000, rate_default_ms: 50 };
const FAST = { limitStepsMs: [300, 600], retryStepsMs: [100, 200], resetJitterMs: [0, 50], backoffJitter: 0.1, minimumWaitMs: 0, resumeSpacingMs: 100 };
const VARIABLES = { anthropic: ['ANTHROPIC_API_KEY', 'E3D_ANTHROPIC_BASE_URL'], openai: ['OPENAI_API_KEY', 'E3D_OPENAI_BASE_URL'] };
// The power log of a machine that never slept: the counter does not move.
const AWAKE = textSource('', { sleepCount: 1705 });

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'e3d-runner-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Every file under a directory, as text (binary files too: a key must not be in any of them).
async function everyFile(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await everyFile(path));
    else if (entry.isFile()) found.push({ path, text: (await readFile(path)).toString('latin1') });
  }
  return found;
}

// A prepared API batch against a fresh mock. The key is random per batch, so
// a leak anywhere on disk is found by searching for it.
export async function apiBatch(t, { protocol = 'anthropic', script = null, tasks = ['house-a-t1'], attempts = 1, tokenBudget, toolBudget, wall, id = 'api-1', withKey = true } = {}) {
  const dir = await scratch(t), dataRoot = join(dir, 'data'), home = join(dir, 'home');
  await makeDataRoot(dataRoot, tasks, { wall });
  await mkdir(join(home, '.ssh'), { recursive: true });
  // The first step answers preflight's live request.
  const mock = await startMock({ protocol, script: script ?? [{ text: 'OK' }, ...buildSteps(GLB.toString('base64'))] });
  t.after(() => mock.close());
  const key = 'sk-test-e3d-' + randomBytes(12).toString('hex');
  const [keyVariable, baseVariable] = VARIABLES[protocol];
  const env = { [baseVariable]: mock.url, ...(withKey ? { [keyVariable]: key } : {}) };
  const scorer = join(dir, 'fake-scorer.mjs');
  await writeFile(scorer, fakeScorer(join(dir, 'scorer-calls.log')));
  const { batchDir, manifest } = await prepare({ id, system: 'api-' + protocol, model: 'mock-model', effort: 'high', tasks, attempts, dataRoot, tokenBudget, toolBudget,
    deps: { installTools: fakeInstallTools, env, apiRetry: FAST_RETRY } });
  const deps = { scorerModule: scorer, graceSeconds: 1, schedule: FAST, env, hostSleep: AWAKE,
    home, keychain: null, internet: { host: '127.0.0.1', port: 1, url: 'http://127.0.0.1:1/' } };
  return { dir, dataRoot, batchDir, manifest, mock, key, env, deps, keyVariable };
}

for (const protocol of ['anthropic', 'openai']) {
  test(`api-${protocol}: prepare, a model-free preflight, a run and a scored result with usage, turns and tools`, async t => {
    const { batchDir, manifest, mock, key, deps, dataRoot } = await apiBatch(t, { protocol, tokenBudget: 500000, toolBudget: 50 });
    assert.equal(manifest.system, 'api-' + protocol); assert.equal(manifest.rules.api_keys, true);
    assert.equal(manifest.harness.key_present, true); assert.equal(manifest.harness.base_url, mock.url);
    assert.deepEqual([manifest.harness.budget.tokens, manifest.harness.budget.tool_calls], [500000, 50]);
    const invocation = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'invocation.json'));
    assert.equal(invocation.wall_seconds, 3600, 'the wall clock is a safety cap of twice the task budget');
    assert.deepEqual(invocation.args.slice(-1), [join(batchDir, 'house-a-t1', 'a1', 'harness', 'api-config.json')]);
    const config = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'harness', 'api-config.json'));
    assert.match(config.sandbox.profile, /\(deny default\)/); assert.equal(config.effort, 'high');
    const report = await preflight({ batchDir, deps });
    const failed = report.checks.filter(check => check.status === 'fail' || check.status === 'not_evaluated');
    assert.equal(report.passed, true, JSON.stringify(failed, null, 1));
    for (const prefix of ['sandbox:', 'shell:', 'agent:', 'live:']) assert.ok(report.checks.some(check => check.id.startsWith(prefix) && check.status === 'pass'), prefix);
    assert.equal(report.probe_session.live.model_reported, 'mock-model');
    const summary = await execute({ batchDir, deps });
    const result = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
    assert.equal(result.status, 'completed', JSON.stringify(result.errors)); assert.equal(result.score, 71.5);
    assert.equal(result.turns, 6); assert.equal(result.commands, 1);
    assert.deepEqual(result.tools, { list_dir: 1, read_file: 1, view_image: 2, write_file: 2, shell: 1 });
    assert.deepEqual(result.usage, { input_tokens: 6000, cached_input_tokens: 4800, output_tokens: 1200 });
    assert.equal(result.cost_usd, null); assert.equal(result.model_reported, 'mock-model'); assert.equal(result.notes_present, true);
    assert.equal(result.wall_limit_seconds, 3600); assert.ok(result.load_1m && result.started_at && result.finished_at);
    assert.deepEqual(result.host_sleep_check, { checked: true, method: 'sleep-count', sleeps: [], asleep_seconds: 0, sleep_count: { start: 1705, end: 1705 } });
    assert.equal(summary.complete, true); assert.equal(summary.mean_score, 71.5);
    assert.deepEqual(mock.violations, [], 'every request followed the documented protocol');
    // The image of view_image went back in the provider's own form.
    const last = mock.requests.at(-1).body;
    const images = JSON.stringify(protocol === 'anthropic' ? last.messages : last.input);
    assert.ok(protocol === 'anthropic' ? /"type":"image","source":\{"type":"base64","media_type":"image\/png"/.test(images) : /"type":"input_image","image_url":"data:image\/png;base64,/.test(images));
    // The key went to the mock in its header and nowhere else.
    const header = protocol === 'anthropic' ? mock.requests[0].headers['x-api-key'] : mock.requests[0].headers.authorization;
    assert.ok(header.includes(key));
    for (const file of await everyFile(batchDir)) assert.ok(!file.text.includes(key), 'the key is in ' + file.path);
    // The report module reads the batch as it reads a CLI batch.
    const board = await aggregate({ dataRoot, batches: ['api-1'], outFile: null });
    assert.equal(board.problems.filter(problem => /api-1/.test(problem) && !/model\.json|archetype/.test(problem)).length, 0, JSON.stringify(board.problems));
  });
}

// Runner-level tests bind a passing verdict to the manifest the way preflight
// does (the real preflight is covered above), so they cost no probe sites.
async function passPreflight(batchDir) {
  const { manifestHash } = await import('../lib/runner/index.mjs');
  const manifest = await readJSON(join(batchDir, 'manifest.json'));
  await writeFile(join(batchDir, 'preflight.json'), JSON.stringify({ schema: 'e3d-preflight-v1', passed: true, manifest_sha256: manifestHash(manifest), checks: [] }));
}

test('api: a rate limit too long for the loop holds the batch until the stated time, then the attempt runs again without using up the cap', async t => {
  const { batchDir, deps, mock, key } = await apiBatch(t, { protocol: 'anthropic', script: [{ status: 429, retry_after: 3, echo_key: true }, ...buildSteps(GLB.toString('base64'))] });
  await passPreflight(batchDir);
  const events = [];
  const summary = await execute({ batchDir, deps, maxReruns: 0, log: event => events.push(event) });
  const first = await readJSON(join(batchDir, 'house-a-t1', 'a1.infra-1', 'result.json'));
  assert.deepEqual([first.status, first.infra.reason, first.infra.action, first.infra.retry_after_source], ['infra_error', 'rate_limit', 'wait', 'retry-after']);
  assert.ok(Date.parse(first.infra.retry_after) > Date.parse(first.finished_at), 'retry_after is after the attempt ended');
  const waiting = events.find(event => event.event === 'waiting');
  assert.deepEqual([waiting.reason, waiting.basis], ['rate_limit', 'retry_after']);
  assert.ok(Date.parse(waiting.until_at) >= Date.parse(first.infra.retry_after), 'held at least until the stated time');
  const second = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
  assert.deepEqual([second.status, second.try, second.score], ['completed', 2, 71.5]);
  assert.equal(summary.complete, true); assert.deepEqual(summary.infra.capped, []);
  assert.deepEqual(mock.violations, []);
  // The 429 echoed the key back: it was redacted from the infra record, the events and everything else.
  assert.match(first.infra.message, /\[REDACTED\]/);
  for (const file of await everyFile(batchDir)) assert.ok(!file.text.includes(key), 'the key is in ' + file.path);
});

test('api: a rejected key stops the batch for a human, with advice about the variable; once fixed the attempt runs again', async t => {
  const { batchDir, deps, mock } = await apiBatch(t, { protocol: 'openai', script: [{ status: 401 }] });
  await passPreflight(batchDir);
  const stopped = await execute({ batchDir, deps }).catch(error => error);
  assert.equal(stopped.code, 'E3D_STOPPED'); assert.equal(stopped.stop.reason, 'auth');
  assert.match(stopped.stop.advice, /^set OPENAI_API_KEY to a valid key/);
  assert.match(await readFile(join(batchDir, 'progress.log'), 'utf8'), /STOP auth: .* -> set OPENAI_API_KEY/);
  mock.push(...buildSteps(GLB.toString('base64')));
  const summary = await execute({ batchDir, deps });
  assert.equal(summary.complete, true);
  const result = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
  assert.deepEqual([result.status, result.try, result.tries[0].reason], ['completed', 2, 'auth']);
});

test('api: an exhausted budget is a scored sample (budget_exhausted), a full context a failure, and the report reads the batch', async t => {
  const steps = buildSteps(GLB.toString('base64'));
  // house-a builds its model, then keeps calling tools until its 6 calls are used up;
  // house-b fills its context.
  const script = [...steps.slice(0, 4), { tools: [{ name: 'list_dir', args: { path: '.' } }, { name: 'list_dir', args: { path: 'output' } }] }, { tools: [{ name: 'list_dir', args: { path: 'tmp' } }] },
    { tools: [{ name: 'list_dir', args: { path: '.' } }] }, { context_length: true }];
  const { batchDir, deps, dataRoot, mock } = await apiBatch(t, { protocol: 'anthropic', script, tasks: ['house-a-t1', 'house-b-t1'], toolBudget: 6, id: 'api-budget' });
  await passPreflight(batchDir);
  const summary = await execute({ batchDir, deps });
  const a = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json')), b = await readJSON(join(batchDir, 'house-b-t1', 'a1', 'result.json'));
  assert.deepEqual([a.status, a.score, a.infra], ['budget_exhausted', 71.5, null], JSON.stringify(a.errors));
  assert.equal(Object.values(a.tools).reduce((sum, n) => sum + n, 0), 6);
  assert.deepEqual([b.status, b.score, b.infra], ['generation_failed', 0, null]);
  assert.match(b.errors.join(' '), /prompt is too long/);
  assert.equal(summary.counts.budget_exhausted, 1); assert.equal(summary.samples, 2); assert.equal(summary.mean_score, 35.75);
  assert.deepEqual(mock.violations, []);
  // The report module: budget_exhausted is a sample like timeout, the failure counts 0.
  const site = join(dataRoot, 'reports', 'api');
  const report = await writeReport({ dataRoot, batches: ['api-budget'], outDir: site, size: 64 });
  assert.equal(report.attempts, 2); assert.ok(await exists(join(site, 'index.html')) && await exists(join(site, 'leaderboard.json')));
  const leaderboard = await readJSON(join(site, 'leaderboard.json'));
  const text = JSON.stringify(leaderboard);
  assert.ok(text.includes('api-anthropic'), 'the configuration is named by its system');
  const batch = leaderboard.batches.find(item => item.id === 'api-budget');
  assert.deepEqual([batch.counted, batch.excluded, batch.status_counts.budget_exhausted], [2, 0, 1]);
});

test('api: without the key, preflight still proves the boundary but stops for a human, and run exits 3', async t => {
  const { batchDir, deps, mock } = await apiBatch(t, { protocol: 'anthropic', withKey: false, script: [] });
  const report = await preflight({ batchDir, deps });
  assert.equal(report.passed, false); assert.deepEqual(report.failed, []);
  assert.deepEqual([report.infra.reason, report.infra.action, report.infra.gave_up], ['auth', 'stop', 'stop']);
  assert.match(report.infra.message, /ANTHROPIC_API_KEY is not set/);
  assert.equal(report.checks.find(check => check.id === 'live:request').status, 'not_evaluated');
  assert.ok(report.checks.filter(check => /^(sandbox|shell|agent):/.test(check.id)).every(check => ['pass', 'not_applicable'].includes(check.status)), 'the boundary was proven');
  assert.equal(mock.requests.length, 0, 'nothing was sent without a key');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, E3D_ANTHROPIC_BASE_URL: mock.url };
  const run = spawnSync(process.execPath, [join(REPO, 'v1', 'scripts', 'run.mjs'), 'run', '--batch', batchDir], { env, encoding: 'utf8' });
  assert.equal(run.status, 3, run.stderr);
  assert.match(run.stderr, /ANTHROPIC_API_KEY is not set in the environment/);
  assert.equal(await exists(join(batchDir, 'house-a-t1', 'a1', 'started.json')), false, 'nothing was launched');
});

test('api: prepare refuses settings that do not apply, and freezes only whether the key was set', async t => {
  const dir = await scratch(t), dataRoot = join(dir, 'data');
  await makeDataRoot(dataRoot, ['house-a-t1']);
  const base = { tasks: ['house-a-t1'], dataRoot, deps: { installTools: fakeInstallTools, env: { ANTHROPIC_API_KEY: 'sk-test-e3d-prepare-0123456789' } } };
  await assert.rejects(prepare({ ...base, id: 'x1', system: 'api-anthropic', model: 'm', effort: 'ultra' }), /effort must be one of low, medium, high, xhigh, max/);
  await assert.rejects(prepare({ ...base, id: 'x2', system: 'api-openai', model: 'm', tokenBudget: 100 }), /--token-budget must be an integer of at least 10000/);
  await assert.rejects(prepare({ ...base, id: 'x3', system: 'codex', model: 'm', toolBudget: 5 }), /apply to the API systems only/);
  await assert.rejects(prepare({ ...base, id: 'x4', system: 'api-anthropic', model: 'm', binary: process.execPath }), /runs its own loop/);
  const { batchDir, manifest } = await prepare({ ...base, id: 'x5', system: 'api-anthropic', model: 'claude-opus-5-5', effort: 'max' });
  assert.deepEqual([manifest.harness.key_variable, manifest.harness.key_present, manifest.harness.base_url], ['ANTHROPIC_API_KEY', true, 'https://api.anthropic.com']);
  for (const file of await everyFile(batchDir)) assert.ok(!file.text.includes('sk-test-e3d-prepare'), file.path);
  // The prompts differ from the CLI systems' only in the tool paragraph and the limit, and both API systems get the same one.
  const prompt = await readFile(join(batchDir, 'house-a-t1', 'a1', 'prompt.txt'), 'utf8');
  assert.match(prompt, /There is a hard budget of 2,000,000 tokens \(the input and output of every request, summed\) and 200 tool calls\./);
  assert.match(prompt, /Your tools: shell, which runs a bash command in this directory \(Node\.js is on PATH\); read_file; write_file; list_dir; and view_image/);
  const config = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'harness', 'api-config.json'));
  assert.match(config.system_prompt, /^You work alone in one directory through five tools: shell/);
  assert.match(config.system_prompt, /2,000,000 tokens .* and 200 tool calls\. You are told once when less than 15% of either is left\./s);
  assert.match(config.system_prompt, /wall-clock safety limit of 60 minutes/);
});
