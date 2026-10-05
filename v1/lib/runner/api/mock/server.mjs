import http from 'node:http';

// Local stand-ins for the two model APIs, for tests: an HTTP server on
// 127.0.0.1 that speaks the Messages API (protocol 'anthropic') or the
// Responses API (protocol 'openai'), checks every request against the rules
// the documentation states (README "The API systems"), and answers from a
// script, one step per request:
//   { text }                          a reply without tool calls (the session ends)
//   { tools: [{ name, args }], text? } a reply with tool calls (args: an object, or raw text for OpenAI)
//   { cut_off: true, tools?, text? }  a reply cut off at the output limit
//   { refusal: true }                 a refusal
//   { status, message?, code?, type?, retry_after?, reset_in?, echo_key? }
//                                     an HTTP error; retry_after sets the retry-after header (seconds),
//                                     reset_in the provider's rate-limit reset headers instead;
//                                     echo_key puts the key the request carried into the message
//   { context_length: true }          the provider's context-window error (HTTP 400)
//   { drop: true }                    the connection is closed without an answer
//   usage: { input, cached, cache_write, output, reasoning }   on any reply step (defaults below)
//   delay_ms                          wait before answering
// When the script runs out, the reply is { text: 'Done.' }. A request that
// breaks a protocol rule is answered 400 with the rule, and recorded in
// `violations`.
const DEFAULT_USAGE = { input: 1000, cached: 0, cache_write: 0, output: 200, reasoning: 50 };

function anthropicRules(request) {
  const { headers, body } = request, problems = [];
  if (!headers['x-api-key']) problems.push('no x-api-key header');
  if (headers['anthropic-version'] !== '2023-06-01') problems.push('anthropic-version must be 2023-06-01');
  if (!/^application\/json/.test(headers['content-type'] ?? '')) problems.push('content-type must be application/json');
  if (typeof body?.model !== 'string' || !Number.isInteger(body.max_tokens)) problems.push('model and max_tokens are required');
  if (!Array.isArray(body?.messages) || !body.messages.length) return [...problems, 'messages must be a non-empty array'];
  if (body.messages[0].role !== 'user') problems.push('the first message must be from the user');
  if (body.messages.at(-1).role !== 'user') problems.push('This model does not support assistant message prefill. The conversation must end with a user message.');
  for (const tool of body.tools ?? []) if (!tool.name || !tool.input_schema || tool.input_schema.type !== 'object') problems.push('tool ' + tool.name + ' needs an object input_schema');
  const breakpoints = JSON.stringify(body).split('"cache_control"').length - 1;
  if (breakpoints > 4) problems.push('at most 4 cache_control breakpoints, got ' + breakpoints);
  body.messages.forEach((message, i) => {
    if (message.role !== 'assistant') return;
    const uses = (message.content ?? []).filter(block => block.type === 'tool_use').map(block => block.id);
    if (!uses.length) return;
    const next = body.messages[i + 1];
    const blocks = Array.isArray(next?.content) ? next.content : [];
    const results = blocks.filter(block => block.type === 'tool_result').map(block => block.tool_use_id);
    const firstText = blocks.findIndex(block => block.type !== 'tool_result');
    if (next?.role !== 'user' || uses.some(id => !results.includes(id))) problems.push('tool_use ids were found without tool_result blocks immediately after: ' + uses.join(','));
    if (firstText >= 0 && blocks.slice(firstText).some(block => block.type === 'tool_result')) problems.push('tool_result blocks must come first in the user message content');
    for (const block of blocks) if (block.type === 'tool_result' && Array.isArray(block.content)) {
      for (const part of block.content) if (!['text', 'image', 'document', 'search_result'].includes(part.type)) problems.push('tool_result content type ' + part.type + ' is not allowed');
    }
  });
  return problems;
}

function openaiRules(request) {
  const { headers, body } = request, problems = [];
  if (!/^Bearer \S+/.test(headers.authorization ?? '')) problems.push('no bearer authorization header');
  if (typeof body?.model !== 'string') problems.push('model is required');
  if (body?.store !== false) problems.push('the harness must send store: false');
  if (!Array.isArray(body?.input)) return [...problems, 'input must be an array'];
  for (const tool of body.tools ?? []) {
    if (tool.type !== 'function' || !tool.name || tool.parameters?.type !== 'object') problems.push('function tool ' + tool.name + ' is malformed');
    if (tool.strict !== false && Object.keys(tool.parameters?.properties ?? {}).some(key => !(tool.parameters.required ?? []).includes(key))) {
      problems.push('strict mode (the default) needs every property of ' + tool.name + ' required');
    }
  }
  const calls = new Set(), outputs = new Set();
  body.input.forEach(item => {
    if (item.type === 'function_call') calls.add(item.call_id);
    if (item.type === 'function_call_output') {
      if (!calls.has(item.call_id)) problems.push('No tool call found for function call output with call_id ' + item.call_id);
      outputs.add(item.call_id);
      if (Array.isArray(item.output)) for (const part of item.output) if (!['input_text', 'input_image', 'input_file'].includes(part.type)) problems.push('function_call_output part ' + part.type + ' is not allowed');
    }
    if (item.type === 'reasoning' && typeof item.encrypted_content !== 'string') problems.push('a reasoning item replayed without its encrypted_content (store is false)');
  });
  for (const id of calls) if (!outputs.has(id)) problems.push('No tool output found for function call ' + id);
  return problems;
}

function usageOf(step, n) {
  const u = { ...DEFAULT_USAGE, ...(n > 1 ? { cached: 800 } : {}), ...step.usage };
  return u;
}

// ---------------------------------------------------------------- replies

function anthropicReply(step, n, body) {
  const content = [{ type: 'thinking', thinking: '', signature: 'mock-signature-' + n }];
  if (step.text) content.push({ type: 'text', text: step.text });
  (step.tools ?? []).forEach((tool, i) => content.push({ type: 'tool_use', id: 'toolu_mock_' + n + '_' + i, name: tool.name, input: tool.args ?? {} }));
  const u = usageOf(step, n);
  return { id: 'msg_mock_' + n, type: 'message', role: 'assistant', model: body.model, content,
    stop_reason: step.cut_off ? 'max_tokens' : step.refusal ? 'refusal' : step.tools?.length ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: u.input - u.cached - u.cache_write, cache_creation_input_tokens: u.cache_write, cache_read_input_tokens: u.cached, output_tokens: u.output } };
}

function openaiReply(step, n, body) {
  const output = [{ type: 'reasoning', id: 'rs_mock_' + n, summary: [], encrypted_content: 'mock-encrypted-' + n }];
  if (step.text || step.refusal) output.push({ type: 'message', id: 'msg_mock_' + n, role: 'assistant', status: 'completed',
    content: [step.refusal ? { type: 'refusal', refusal: 'I can not help with that.' } : { type: 'output_text', text: step.text, annotations: [] }] });
  (step.tools ?? []).forEach((tool, i) => output.push({ type: 'function_call', id: 'fc_mock_' + n + '_' + i, call_id: 'call_mock_' + n + '_' + i, name: tool.name,
    arguments: typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args ?? {}), status: 'completed' }));
  const u = usageOf(step, n);
  return { id: 'resp_mock_' + n, object: 'response', status: step.cut_off ? 'incomplete' : 'completed', model: body.model,
    incomplete_details: step.cut_off ? { reason: 'max_output_tokens' } : null, error: null, output,
    usage: { input_tokens: u.input, input_tokens_details: { cached_tokens: u.cached }, output_tokens: u.output, output_tokens_details: { reasoning_tokens: u.reasoning }, total_tokens: u.input + u.output } };
}

function errorReply(protocol, step, key) {
  let message = step.message ?? ({ 401: 'invalid x-api-key', 403: 'permission denied', 404: 'model: not found', 429: 'Number of request tokens has exceeded your per-minute rate limit',
    500: 'Internal server error', 503: 'Service unavailable', 529: 'Overloaded' }[step.status] ?? 'error');
  if (step.echo_key) message += ' (the key you sent: ' + key + ')';
  if (step.context_length) message = protocol === 'anthropic' ? 'prompt is too long: 1000123 tokens > 1000000 maximum' : 'Your input exceeds the context window of this model.';
  const status = step.context_length ? 400 : step.status;
  const type = step.type ?? { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 429: 'rate_limit_error',
    500: 'api_error', 529: 'overloaded_error' }[status] ?? 'api_error';
  const body = protocol === 'anthropic'
    ? { type: 'error', error: { type, message, ...(step.code ? { details: { error_code: step.code } } : {}) }, request_id: 'req_mock' }
    : { error: { message, type, param: null, code: step.context_length ? 'context_length_exceeded' : step.code ?? null } };
  const headers = {};
  if (step.retry_after !== undefined) headers['retry-after'] = String(step.retry_after);
  if (step.reset_in !== undefined) {
    if (protocol === 'anthropic') {
      headers['anthropic-ratelimit-tokens-remaining'] = '0';
      headers['anthropic-ratelimit-tokens-reset'] = new Date(Date.now() + step.reset_in * 1000).toISOString();
    } else headers['x-ratelimit-reset-tokens'] = step.reset_in + 's';
  }
  return { status, headers, body };
}

export async function startMock({ protocol, script = [] }) {
  if (!['anthropic', 'openai'].includes(protocol)) throw new Error('unknown mock protocol ' + protocol);
  const steps = [...script], requests = [], violations = [];
  const path = protocol === 'anthropic' ? '/v1/messages' : '/v1/responses';
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const n = requests.length + 1, key = protocol === 'anthropic' ? req.headers['x-api-key'] : String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      const request = { n, method: req.method, path: req.url, headers: req.headers, body };
      requests.push(request);
      const send = (status, payload, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_mock_' + n, ...headers }); res.end(JSON.stringify(payload)); };
      if (req.method !== 'POST' || req.url !== path) { send(404, { error: { type: 'not_found_error', message: 'no route ' + req.url } }); return; }
      const problems = protocol === 'anthropic' ? anthropicRules(request) : openaiRules(request);
      if (problems.length) {
        violations.push({ n, problems });
        send(400, protocol === 'anthropic' ? { type: 'error', error: { type: 'invalid_request_error', message: problems.join('; ') } } : { error: { message: problems.join('; '), type: 'invalid_request_error', code: null } });
        return;
      }
      const step = steps.shift() ?? { text: 'Done.' };
      request.step = step;
      if (step.delay_ms) await new Promise(resolve => setTimeout(resolve, step.delay_ms));
      if (step.drop) { req.socket.destroy(); return; }
      if (step.status || step.context_length) { const reply = errorReply(protocol, step, key); send(reply.status, reply.body, reply.headers); return; }
      send(200, protocol === 'anthropic' ? anthropicReply(step, n, body) : openaiReply(step, n, body));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: 'http://127.0.0.1:' + server.address().port, requests, violations,
    push: (...more) => steps.push(...more),
    remaining: () => steps.length,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
