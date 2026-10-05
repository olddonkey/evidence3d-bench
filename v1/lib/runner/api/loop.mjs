#!/usr/bin/env node
// The API systems' agent loop, one process per attempt, started by the runner
// like a CLI (it is the "harness binary" of api-anthropic and api-openai):
//   node loop.mjs <attempt>/harness/api-config.json
// stdin: one JSON object { key, prompt }. The key is read from the runner's
// environment at launch and handed over here, never through argv or the
// environment (both are visible to other processes) and never written to a
// file; the loop holds it in memory and redacts it from everything it prints.
// stdout: the event stream (one JSON object per line; schema in README "The
// API systems"), stderr: diagnostics. Exit 0 when the session ended on its own
// terms (the model finished, or a budget was used up), 1 otherwise.
//
// The loop: send the conversation; log the usage; run the tool calls in
// order (each one counted against the tool budget); send the results back
// (with a one-time budget notice at 85 %); repeat until the model replies
// without a tool call or a budget is exhausted. No compaction: a context that
// fills up is the model's failure. HTTP failures are retried or waited out in
// the loop within limits, then end the session with an infrastructure verdict
// the runner turns into infra_error.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { postJSON, redactor } from './http.mjs';
import { createBudget, noticeText } from './budget.mjs';
import { createTools } from './tools.mjs';
import { classifyFailure } from './errors.mjs';
import { ANTHROPIC } from './anthropic.mjs';
import { OPENAI } from './openai.mjs';

const PROVIDERS = { anthropic: ANTHROPIC, openai: OPENAI };
export const LOOP_VERSION = 'e3d-api-loop-v1';

let redact = redactor();
const emit = event => process.stdout.write(redact(JSON.stringify({ ...event, t: Math.round(performance.now()) })) + '\n');
const warn = text => process.stderr.write(redact(text) + '\n');

// The arguments of a tool call as they are logged: enough to follow the
// session, never a whole file.
function summarise(name, args) {
  if (!args || typeof args !== 'object') return args ?? null;
  if (name === 'write_file') return { path: args.path, bytes: typeof args.content === 'string' ? Buffer.byteLength(args.content) : null };
  if (name === 'shell') return { command: String(args.command ?? '').slice(0, 2000), timeout_seconds: args.timeout_seconds ?? null };
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 500) : value]));
}

async function main() {
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { input = {}; }
  const key = typeof input.key === 'string' ? input.key : '';
  redact = redactor(key);
  delete input.key;
  const provider = PROVIDERS[config.provider];
  if (!provider) throw new Error('unknown provider ' + config.provider);
  const budget = createBudget(config.budget);
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  let requests = 0, turns = 0, waited = 0;
  emit({ type: 'session', loop: LOOP_VERSION, provider: provider.id, api: provider.api, model: config.model, effort: config.effort ?? null,
    base_url: config.base_url, budget: config.budget, max_output_tokens: config.max_output_tokens, tools: config.tools.map(tool => tool.name), at: new Date().toISOString() });
  const finish = (fields, code) => {
    emit({ type: 'result', requests, turns, tool_calls: budget.callsUsed, usage, tokens_used: budget.tokensUsed, budget: budget.snapshot(),
      rate_wait_seconds: Math.round(waited / 100) / 10, infra: null, error: null, error_kind: null, ...fields });
    return code;
  };
  if (!key) return finish({ status: 'error', infra: { reason: 'auth', message: provider.keyVariable + ' was not passed to the loop', status: null } }, 1);
  if (typeof input.prompt !== 'string' || !input.prompt) throw new Error('no prompt on stdin');

  const tools = createTools({ workspace: config.workspace, sandbox: config.sandbox, limits: config.limits });
  const state = provider.start(input.prompt);
  const url = provider.url(config.base_url), headers = provider.headers(key);
  const retry = config.retry;

  // One request, with the in-loop retries. Returns { json, parsed, ... } or { fail }.
  const request = async () => {
    let tries = 0, rateWaited = 0;
    for (;;) {
      requests++;
      const n = requests, started = performance.now();
      let response = null, verdict = null;
      try { response = await postJSON(url, { headers, body: provider.body(config, state), timeoutMs: config.request_timeout_ms }); }
      catch (error) {
        verdict = error.network === false ? { action: 'stop', reason: 'request_rejected', message: error.message }
          : { action: 'retry', reason: 'network', message: (error.code ? error.code + ': ' : '') + error.message, status: null };
      }
      const ms = Math.round(performance.now() - started);
      let parsed = null;
      if (response) {
        parsed = response.status === 200 ? provider.parse(response.json) : null;
        if (parsed && !parsed.failed) return { json: response.json, parsed, ms, n, status: 200, request_id: provider.requestId(response.headers, response.json) };
        if (parsed?.failed) {
          const code = String(parsed.failed.code ?? '');
          verdict = classifyFailure({ status: /rate_limit/.test(code) ? 429 : /invalid_prompt/.test(code) ? 400 : 500, error: parsed.failed, turns });
        } else if (response.status === 200) verdict = { action: 'retry', reason: 'server_error', message: 'HTTP 200 with a body that is not a response: ' + response.text.slice(0, 300), status: 200 };
        else verdict = provider.failure({ status: response.status, headers: response.headers, json: response.json ?? { error: { message: response.text.slice(0, 1000) } }, turns, now: Date.now() });
      }
      const failed = { type: 'request', n, ok: false, status: verdict.status ?? response?.status ?? null, ms, reason: verdict.reason, action: verdict.action,
        message: String(verdict.message ?? '').slice(0, 1000), request_id: response ? provider.requestId(response.headers, response.json) : null };
      if (verdict.action === 'retry' && tries < retry.backoff_ms.length) {
        const delay = retry.backoff_ms[tries++];
        emit(failed);
        emit({ type: 'retry', n, reason: verdict.reason, status: failed.status, attempt: tries, delay_ms: delay, message: failed.message });
        await sleep(delay);
        continue;
      }
      if (verdict.action === 'wait') {
        const delay = verdict.wait_ms ?? retry.rate_default_ms;
        if (delay <= retry.rate_wait_max_ms && rateWaited + delay <= retry.rate_wait_total_ms) {
          rateWaited += delay; waited += delay;
          emit(failed);
          emit({ type: 'retry', n, reason: 'rate_limit', status: failed.status, attempt: ++tries, delay_ms: delay, source: verdict.retry_after_source ?? null, message: failed.message });
          await sleep(delay);
          continue;
        }
      }
      emit(failed);
      if (verdict.action === 'model') return { fail: { error_kind: verdict.reason, error: failed.message, status: failed.status } };
      const retryAfter = verdict.action === 'wait' && Number.isFinite(verdict.wait_ms) ? new Date(Date.now() + verdict.wait_ms).toISOString() : null;
      return { fail: { infra: { reason: verdict.reason, status: failed.status, message: failed.message, retries: tries,
        retry_after: retryAfter, retry_after_source: retryAfter ? verdict.retry_after_source : null } } };
    }
  };

  for (;;) {
    if (budget.tokensExhausted()) return finish({ status: 'budget_exhausted', exhausted: 'tokens', stop_reason: null }, 0);
    const reply = await request();
    if (reply.fail) return finish({ status: 'error', ...reply.fail }, 1);
    const { parsed, json } = reply;
    turns++;
    for (const key of Object.keys(usage)) usage[key] += parsed.usage[key] ?? 0;
    budget.addTokens(parsed.usage.input_tokens + parsed.usage.output_tokens);
    emit({ type: 'request', n: reply.n, ok: true, status: 200, ms: reply.ms, request_id: reply.request_id, id: parsed.id, model: parsed.model, stop_reason: parsed.stop,
      usage: parsed.usage, raw_usage: parsed.raw_usage, thinking_blocks: parsed.thinking, tool_calls: parsed.calls.length, tokens_used: budget.tokensUsed, calls_used: budget.callsUsed });
    for (const text of parsed.texts) emit({ type: 'text', n: reply.n, text: text.slice(0, 20000) });
    provider.record(state, json);
    if (!parsed.calls.length) {
      if (parsed.cut_off) {
        const text = '[harness] Your reply reached the output limit of ' + config.max_output_tokens + ' tokens and was cut off. Continue where you stopped; write long files in parts.';
        emit({ type: 'notice', n: reply.n, kind: 'cut_off', text });
        provider.say(state, text);
        continue;
      }
      return finish({ status: 'completed', stop_reason: parsed.stop, refused: parsed.refused }, 0);
    }
    const results = [];
    let exhausted = false;
    for (const call of parsed.calls) {
      // A reply cut off at the output limit may end in an incomplete call:
      // none of its calls is run.
      if (parsed.cut_off) {
        results.push({ id: call.id, ok: false, text: 'not run: your reply reached the output limit of ' + config.max_output_tokens + ' tokens before this call was complete; make it again, smaller' });
        emit({ type: 'tool', n: reply.n, id: call.id, name: call.name, args: summarise(call.name, call.args), executed: false, ok: false, error: 'cut off at the output limit' });
        continue;
      }
      if (budget.callsExhausted()) { exhausted = true; break; }
      budget.addCall();
      const started = performance.now();
      const result = call.parse_error ? { ok: false, text: call.parse_error, meta: {} } : await tools.run(call.name, call.args);
      const known = !result.meta?.unknown && !call.parse_error;
      emit({ type: 'tool', n: reply.n, call: budget.callsUsed, id: call.id, name: call.name, args: summarise(call.name, call.args), executed: known,
        ms: Math.round(performance.now() - started), ok: result.ok, refused: result.refused ?? false, ...result.meta, unknown: undefined,
        image: result.image ? { media_type: result.image.media_type, width: result.image.width, height: result.image.height } : undefined,
        excerpt: result.text.slice(0, 600) });
      results.push({ id: call.id, ...result });
    }
    if (exhausted) return finish({ status: 'budget_exhausted', exhausted: 'tool_calls', stop_reason: parsed.stop }, 0);
    const due = budget.noticeDue();
    const notice = due ? noticeText(due) : null;
    if (notice) emit({ type: 'notice', n: reply.n, kind: 'budget', ...due, text: notice });
    provider.respond(state, results, notice);
  }
}

// An exception here is the loop's own failure, never the model's.
let code;
try { code = await main(); }
catch (error) {
  warn('loop error: ' + (error.stack ?? error.message));
  emit({ type: 'result', status: 'error', infra: { reason: 'cli_crash', message: 'the API loop failed: ' + String(error.message ?? error).slice(0, 500), status: null }, error: null, error_kind: null });
  code = 1;
}
process.exitCode = code;
