import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { API_ADAPTERS } from '../lib/runner/api/adapter.mjs';
import { nodeRuntime } from '../lib/runner/adapters.mjs';
import { startMock } from '../lib/runner/api/mock/server.mjs';
import { parseApiEvents } from '../lib/runner/api/events.mjs';
import { readJSONLines } from '../lib/runner/events.mjs';
import { detectInfra, INFRA_REASONS } from '../lib/runner/infra.mjs';
import { classifyStatus } from '../lib/runner/status.mjs';
import { classifyFailure, rateLimitWait, durationMs } from '../lib/runner/api/errors.mjs';
import { createBudget, noticeText } from '../lib/runner/api/budget.mjs';
import { redactor } from '../lib/runner/api/http.mjs';

// The API loop on its own, against the mocks: how each HTTP failure ends a
// session, the budget, the key. The runner-level consequences (holds, stops,
// re-runs) are the existing machinery, exercised in runner-api.test.mjs.

// The loop runs its shell under /usr/bin/sandbox-exec, which only macOS has;
// elsewhere the sessions are skipped and only the pure shapes are checked.
const MACOS_ONLY = process.platform !== 'darwin' && 'macOS only: needs Seatbelt (/usr/bin/sandbox-exec)';

const FAST_RETRY = { backoff_ms: [20, 20, 20], rate_wait_max_ms: 1500, rate_wait_total_ms: 3000, rate_default_ms: 50 };

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'e3d-api-loop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ws = join(dir, 'workspace');
  for (const sub of ['input', 'output', 'tmp', 'tools', 'node_modules']) await mkdir(join(ws, sub), { recursive: true });
  await writeFile(join(ws, 'input', 'task.json'), '{"schema":"e3d-task-v1"}\n');
  await writeFile(join(ws, 'package.json'), '{"type":"module"}\n');
  await mkdir(join(dir, 'harness'));
  return { dir, ws };
}

// One loop process against a mock. Returns the events, the exit code, the
// summary the runner derives, and the runner's infra verdict and status.
async function runLoop(t, { protocol = 'anthropic', script, budget = { tokens: 100000, tool_calls: 20 }, key = 'sk-test-loop-' + randomBytes(8).toString('hex'), maxOutputTokens, keyMissing = false }) {
  const { dir, ws } = await workspace(t);
  const mock = await startMock({ protocol, script });
  t.after(() => mock.close());
  const adapter = API_ADAPTERS['api-' + protocol], node = await nodeRuntime();
  const env = { [adapter.provider.keyVariable]: key, [adapter.provider.baseVariable]: mock.url };
  const harness = await adapter.inspect({ model: 'mock-model', effort: 'low', budget, maxOutputTokens, retry: FAST_RETRY, env });
  const spec = adapter.invocation({ harness, model: harness.model, effort: harness.effort, workspace: ws, attemptDir: dir, node, wallSeconds: 60 });
  for (const [path, content] of Object.entries(spec.files)) await writeFile(path, JSON.stringify(content));
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(adapter.stdin('Build the house.', keyMissing ? {} : env));
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const code = await new Promise(resolve => child.on('close', resolve));
  const events = readJSONLines(stdout), summary = parseApiEvents(events);
  const run = { exit_code: code, signal: null, timed_out: false, launch_error: null, wall_seconds: 1, finished_at: new Date().toISOString(), stderr };
  const infra = detectInfra({ system: 'api-' + protocol, events, run, summary });
  const status = classifyStatus({ run, summary, infra, artifact: { present: false } });
  return { events, code, summary, infra, status, mock, stdout, stderr, key, ws, result: events.findLast(event => event.type === 'result') };
}

const tool = (name, args) => ({ name, args });

for (const protocol of ['anthropic', 'openai']) {
  test(`api-${protocol}: each HTTP failure ends the session as the classification table says`, { skip: MACOS_ONLY }, async t => {
    const cases = [
      // [script, expected infra reason or null, expected status, note]
      [[{ status: 529 }, { status: 529 }, { status: 529 }, { status: 529 }], 'overloaded', 'infra_error', '529 four times: three retries, then infra'],
      [[{ status: 500 }, { status: 502 }, { status: 503 }, { status: 504 }], 'server_error', 'infra_error', 'server errors, last a 504'],
      [[{ status: 500 }, { status: 529 }, { text: 'Done.' }], null, 'missing_artifact', 'recovered after two retries: a sample'],
      [[{ drop: true }, { drop: true }, { drop: true }, { drop: true }], 'network', 'infra_error', 'connection dropped every time'],
      [[{ status: 401 }], 'auth', 'infra_error', '401 stops at once'],
      [[{ status: 403 }], 'auth', 'infra_error', '403 stops at once'],
      [[{ status: 402 }], 'billing', 'infra_error', '402'],
      [[{ status: 404, message: 'model: mock-model' }], 'model_unavailable', 'infra_error', '404 on the model'],
      [[{ status: 400, message: 'output_config.effort: low is not supported for this model' }], 'request_rejected', 'infra_error', 'a 400 before any model turn'],
      [[{ status: 400, message: 'Your credit balance is too low to access the Anthropic API.' }], 'billing', 'infra_error', 'billing message'],
      [[{ status: 429, code: protocol === 'anthropic' ? 'enforced_spend_limit_reached' : 'insufficient_quota', message: 'You have reached your API usage limits' }], 'billing', 'infra_error', 'spend cap 429'],
      [[{ status: 429, retry_after: 3600 }], 'rate_limit', 'infra_error', 'a long rate limit ends the session with retry_after'],
      [[{ status: 429, retry_after: 0.05 }, { status: 429, reset_in: 0.05 }, { text: 'Done.' }], null, 'missing_artifact', 'short rate limits are waited out in the loop'],
      [[{ tools: [tool('list_dir', { path: '.' })] }, { context_length: true }], null, 'generation_failed', 'a full context is the model\'s failure'],
      [[{ tools: [tool('list_dir', { path: '.' })] }, { status: 400, message: 'messages.3: image exceeds the limit' }], null, 'generation_failed', 'a refused request after model turns is the model\'s'],
    ];
    for (const [script, reason, status, note] of cases) {
      const run = await runLoop(t, { protocol, script });
      assert.equal(run.infra?.reason ?? null, reason, note + ': ' + JSON.stringify(run.result));
      assert.equal(run.status, status, note);
      if (reason) {
        assert.equal(run.infra.action, INFRA_REASONS[reason], note);
        assert.equal(run.code, 1, note);
      }
      if (reason === 'rate_limit') {
        assert.ok(Date.parse(run.infra.retry_after) > Date.now() + 3000 * 1000, 'retry_after comes from retry-after');
        assert.equal(run.infra.retry_after_source, 'retry-after');
      }
      if (/three retries/.test(note)) assert.equal(run.events.filter(event => event.type === 'retry').length, 3, note);
      if (/waited out/.test(note)) {
        const waits = run.events.filter(event => event.type === 'retry');
        assert.deepEqual(waits.map(event => event.source), ['retry-after', protocol === 'anthropic' ? 'anthropic-ratelimit-reset' : 'x-ratelimit-reset']);
        assert.equal(run.result.status, 'completed');
      }
      assert.deepEqual(run.mock.violations, [], note);
    }
  });

  test(`api-${protocol}: the budget notice comes once at 85 %, and an exhausted budget ends the session as budget_exhausted`, { skip: MACOS_ONLY }, async t => {
    // Tokens: every reply costs 1200 (1000 in + 200 out) of 10000 (the
    // smallest budget prepare accepts): the 8th reply crosses 85 % (9600), so
    // the notice goes with its tool results; the 9th crosses the budget, its
    // tool call still runs, and no 10th request is sent.
    const many = Array.from({ length: 12 }, () => ({ tools: [tool('list_dir', { path: '.' })] }));
    const tokens = await runLoop(t, { protocol, script: many, budget: { tokens: 10000, tool_calls: 100 } });
    assert.equal(tokens.result.status, 'budget_exhausted'); assert.equal(tokens.result.exhausted, 'tokens');
    assert.equal(tokens.status, 'budget_exhausted'); assert.equal(tokens.infra, null); assert.equal(tokens.code, 0);
    const notices = tokens.events.filter(event => event.type === 'notice' && event.kind === 'budget');
    assert.equal(notices.length, 1, 'the notice is given once');
    assert.match(notices[0].text, /^\[harness\] Budget notice: about [\d,]+ tokens and \d+ tool calls are left\. Write output\/model\.glb now\.$/);
    const requests = tokens.events.filter(event => event.type === 'request' && event.ok);
    const noticeAfter = requests.find(event => event.tokens_used >= 8500);
    assert.equal(notices[0].n, noticeAfter.n, 'the notice follows the reply that crossed 85 %');
    assert.equal(requests.length, 9); assert.ok(requests.at(-1).tokens_used >= 10000 && requests.at(-2).tokens_used < 10000, 'the request that crossed the budget was the last');
    assert.equal(tokens.events.filter(event => event.type === 'tool' && event.executed).length, 9, 'the tool call of the last reply still ran');
    // The notice reached the model with the next tool results.
    const sent = JSON.stringify(tokens.mock.requests.find(request => request.n === noticeAfter.n + 1).body);
    assert.ok(sent.includes('Budget notice'), 'the notice is in the next request');
    // Tool calls: 4 allowed; the 4th crosses 85 % (the notice goes with its
    // result), the 5th asked for is not run.
    const calls = await runLoop(t, { protocol, script: [{ tools: [tool('list_dir', { path: '.' }), tool('list_dir', { path: 'input' })] },
      { tools: [tool('read_file', { path: 'input/task.json' }), tool('list_dir', { path: 'output' })] }, { tools: [tool('list_dir', { path: 'tmp' })] }],
      budget: { tokens: 100000, tool_calls: 4 } });
    assert.equal(calls.result.status, 'budget_exhausted'); assert.equal(calls.result.exhausted, 'tool_calls');
    assert.equal(calls.events.filter(event => event.type === 'tool' && event.executed).length, 4);
    assert.ok(!calls.events.some(event => event.type === 'tool' && event.args?.path === 'tmp'), 'the call over the budget was not run');
    assert.equal(calls.summary.budget_exhausted, true); assert.equal(calls.status, 'budget_exhausted');
    assert.deepEqual(calls.events.filter(event => event.type === 'notice').map(event => event.calls_left), [0]);
  });

  test(`api-${protocol}: a reply cut off at the output limit is continued and its calls are not run; bad calls come back as errors`, { skip: MACOS_ONLY }, async t => {
    const run = await runLoop(t, { protocol, script: [
      { cut_off: true, tools: [tool('write_file', { path: 'output/half.txt', content: 'x' })] },
      { cut_off: true, text: 'I was writing' },
      { tools: [tool('no_such_tool', { a: 1 }), tool('read_file', {}), ...(protocol === 'openai' ? [tool('list_dir', '{"path": ".",')] : [])] },
      { text: 'Done.' },
    ] });
    assert.equal(run.result.status, 'completed');
    assert.equal(await readFile(join(run.ws, 'output', 'half.txt'), 'utf8').catch(() => null), null, 'a cut-off call was not run');
    const tools = run.events.filter(event => event.type === 'tool');
    assert.deepEqual(tools.map(event => [event.name, event.executed, event.ok]), [['write_file', false, false], ['no_such_tool', false, false], ['read_file', true, false],
      ...(protocol === 'openai' ? [['list_dir', false, false]] : [])]);
    assert.equal(run.summary.tools.read_file, 1); assert.equal(run.summary.tools_not_run.no_such_tool, 1);
    assert.equal(run.events.filter(event => event.type === 'notice' && event.kind === 'cut_off').length, 1);
    assert.deepEqual(run.mock.violations, []);
  });

  test(`api-${protocol}: the key is never printed, even when the API echoes it back`, { skip: MACOS_ONLY }, async t => {
    // A key of no recognisable shape: only the exact-key redaction can catch it.
    const run = await runLoop(t, { protocol, script: [{ status: 401, echo_key: true }], key: 'plain-key-' + randomBytes(10).toString('hex') });
    assert.equal(run.infra.reason, 'auth');
    assert.ok(run.mock.violations.length === 0 && JSON.stringify(run.mock.requests[0].headers).includes(run.key), 'the key reached the API');
    assert.ok(!run.stdout.includes(run.key) && !run.stderr.includes(run.key), 'the key is not in the event stream or stderr');
    assert.match(run.result.infra.message, /\[REDACTED\]/);
    // Without a key the loop does not call the API at all.
    const none = await runLoop(t, { protocol, script: [{ text: 'never' }], keyMissing: true });
    assert.equal(none.infra.reason, 'auth'); assert.equal(none.mock.requests.length, 0);
  });
}

test('error classification, rate-limit waits and redaction follow the documented shapes', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  assert.deepEqual(rateLimitWait({ 'retry-after': '7' }, now), { wait_ms: 7000, source: 'retry-after' });
  assert.deepEqual(rateLimitWait({ 'anthropic-ratelimit-requests-reset': '2026-10-05T12:00:05Z', 'anthropic-ratelimit-requests-remaining': '3',
    'anthropic-ratelimit-tokens-reset': '2026-10-05T12:00:20Z', 'anthropic-ratelimit-tokens-remaining': '0' }, now), { wait_ms: 20000, source: 'anthropic-ratelimit-reset' });
  assert.deepEqual(rateLimitWait({ 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-reset-tokens': '6m0s' }, now), { wait_ms: 360000, source: 'x-ratelimit-reset' });
  assert.deepEqual(rateLimitWait({}, now), { wait_ms: null, source: null });
  assert.equal(durationMs('20ms'), 20); assert.equal(durationMs('1h2m3.5s'), 3723500); assert.equal(durationMs('soon'), null);
  const verdict = (status, error = {}, turns = 0) => classifyFailure({ status, error, turns, now }).reason;
  assert.equal(verdict(429, { message: 'rate limited' }), 'rate_limit');
  assert.equal(verdict(429, { code: 'credit_balance_exhausted' }), 'billing');
  assert.equal(verdict(400, { message: 'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.' }), 'billing');
  assert.equal(verdict(400, { message: 'prompt is too long: 1000123 tokens > 1000000 maximum' }, 5), 'context_length');
  assert.equal(verdict(400, { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' }, 5), 'context_length');
  assert.equal(verdict(404, { code: 'model_not_found', message: 'The model `x` does not exist or you do not have access to it.' }), 'model_unavailable');
  assert.equal(verdict(404, { message: 'no route /v2/messages' }), 'request_rejected');
  assert.equal(verdict(503, { code: 'server_is_overloaded' }), 'overloaded');
  assert.equal(verdict(413, {}, 3), 'request_too_large');
  const redact = redactor('sk-ant-api03-SECRETSECRET');
  assert.equal(redact('key sk-ant-api03-SECRETSECRET!'), 'key [REDACTED]!');
  assert.equal(redact('{"x-api-key":"abc123456789","authorization":"Bearer xyz987654321"}'), '{"x-api-key":"[REDACTED]","authorization":"Bearer [REDACTED]"}');
  assert.equal(redact('another sk-proj-ABCDEFGH1234 key'), 'another [REDACTED] key');
  const budget = createBudget({ tokens: 1000, tool_calls: 10 });
  budget.addTokens(840); assert.equal(budget.noticeDue(), null);
  budget.addTokens(20); assert.deepEqual(budget.noticeDue(), { tokens_left: 140, calls_left: 10 }); assert.equal(budget.noticeDue(), null);
  assert.equal(noticeText({ tokens_left: 312456, calls_left: 30 }), '[harness] Budget notice: about 312,000 tokens and 30 tool calls are left. Write output/model.glb now.');
});
