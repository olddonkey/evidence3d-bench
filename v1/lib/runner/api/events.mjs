import { API_TOOL_NAMES } from './tools.mjs';

// The API loop's event stream (loop.mjs), one JSON object per line:
//   session  { provider, api, model, effort, base_url, budget, max_output_tokens, tools, at }
//   request  { n, ok: true, status, ms, request_id, id, model, stop_reason, usage, raw_usage, thinking_blocks, tool_calls, tokens_used, calls_used }
//            { n, ok: false, status, ms, reason, action, message, request_id }   a failed HTTP request
//   retry    { n, reason, status, attempt, delay_ms, source?, message }        the loop waits and sends it again
//   text     { n, text }                                                       model text
//   tool     { n, call, id, name, args, executed, ms, ok, refused, exit_code?, timed_out?, output_chars?, truncated?, image?, excerpt }
//   notice   { n, kind: budget | cut_off, tokens_left?, calls_left?, text }
//   result   { status: completed | budget_exhausted | error, stop_reason, exhausted: tokens | tool_calls,
//              error_kind, error, infra: { reason, status, message, retry_after, retry_after_source } | null,
//              requests, turns, tool_calls, usage, tokens_used, budget, rate_wait_seconds }
// Every event also carries t, milliseconds since the loop started.
// usage.input_tokens counts all prompt tokens, cached included (Anthropic's
// cache reads and writes are added in, as for the CLI systems);
// output_tokens includes reasoning.
export function parseApiEvents(events) {
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  const detail = { uncached_input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, reasoning_output_tokens: 0, requests: 0, failed_requests: 0 };
  const tools = {}, unknown = {}, errors = [];
  let session = null, result = null, turns = 0, commands = 0, finalMessage = null, model = null, sawUsage = false, notices = 0;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'session') session = event;
    else if (event.type === 'request' && event.ok) {
      turns++; detail.requests++;
      model ??= event.model ?? null;
      const u = event.usage ?? {};
      if (event.usage) sawUsage = true;
      usage.input_tokens += Number(u.input_tokens) || 0;
      usage.cached_input_tokens += Number(u.cached_input_tokens) || 0;
      usage.output_tokens += Number(u.output_tokens) || 0;
      detail.uncached_input_tokens += Number(u.uncached_input_tokens) || 0;
      detail.cache_creation_input_tokens += Number(u.cache_creation_input_tokens) || 0;
      detail.cache_read_input_tokens += Number(u.cached_input_tokens) || 0;
      detail.reasoning_output_tokens += Number(u.reasoning_tokens) || 0;
    } else if (event.type === 'request') { detail.failed_requests++; errors.push((event.reason ?? 'error') + ': ' + (event.message ?? '')); }
    else if (event.type === 'text' && event.text) finalMessage = event.text;
    else if (event.type === 'tool') {
      if (event.executed) { tools[event.name] = (tools[event.name] ?? 0) + 1; if (event.name === 'shell') commands++; }
      else unknown[event.name] = (unknown[event.name] ?? 0) + 1;
    } else if (event.type === 'notice') notices++;
    else if (event.type === 'result') result = event;
  }
  if (result?.error) errors.push(String(result.error));
  if (result?.infra?.message) errors.push(String(result.infra.message));
  return {
    harness: 'api', provider: session?.provider ?? null, turns, commands, usage: sawUsage ? usage : null, usage_detail: sawUsage ? detail : null,
    // No price list is frozen with a batch, so no cost is computed.
    cost_usd: null,
    tools, tools_not_run: unknown, errors, notices,
    final_message: finalMessage, model_reported: model,
    stop_reason: result?.stop_reason ?? null, result: result ? { status: result.status, exhausted: result.exhausted ?? null, error_kind: result.error_kind ?? null } : null,
    completed: result?.status === 'completed',
    budget_exhausted: result?.status === 'budget_exhausted',
    budget: result?.budget ?? null,
  };
}

// Tools an API session ran that are not its own five. The loop runs nothing
// else, so this can only fire if the loop itself is broken.
export function apiToolProblems(summary) {
  return Object.keys(summary.tools ?? {}).filter(name => !API_TOOL_NAMES.includes(name)).map(name => 'the API loop ran an unknown tool ' + name);
}
