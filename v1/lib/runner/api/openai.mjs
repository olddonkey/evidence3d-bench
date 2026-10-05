import { classifyFailure } from './errors.mjs';

// The OpenAI Responses API (POST /v1/responses), non-streaming and stateless.
// Wire format as documented (read 2026-10-05; platform.openai.com/docs
// redirects to developers.openai.com/api/docs):
//   function tools { type: "function", name, description, parameters, strict };
//   strict is on by default in the Responses API and needs every property
//   required, so it is set to false to keep one schema for both providers;
//   function_call items { call_id, name, arguments (JSON text) };
//   function_call_output { call_id, output }, where output may be "an array of
//   image or file objects instead of a string" for a function that returns an
//   image (so view_image answers with [input_text, input_image]); reasoning
//   items must be passed back with the tool outputs
//     developers.openai.com/api/docs/guides/function-calling
//     developers.openai.com/api/reference/resources/responses/methods/create
//   input_image { image_url: "data:image/png;base64,...", detail: "auto" }
//     developers.openai.com/api/docs/guides/images-vision
//   reasoning.effort (none, minimal, low, medium, high, xhigh, max; support
//   varies by model); store: false makes reasoning items carry
//   encrypted_content, so the whole output is replayed as input each turn;
//   include ["reasoning.encrypted_content"] is still accepted (legacy);
//   usage input_tokens (cached included), input_tokens_details.cached_tokens,
//   output_tokens (reasoning included), output_tokens_details.reasoning_tokens;
//   status "incomplete" with incomplete_details.reason "max_output_tokens"
//     developers.openai.com/api/docs/guides/reasoning
//     developers.openai.com/api/docs/guides/conversation-state
//   errors (429 codes for credit and spend limits, 503 overloaded),
//   retry-after and x-ratelimit-reset-* headers
//     developers.openai.com/api/docs/guides/error-codes, /guides/rate-limits
// Prompt caching is automatic; prompt_cache_key keeps one attempt's requests
// together.
const BILLING_CODES = ['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded', 'billing_hard_limit_reached'];

export const OPENAI = {
  id: 'openai', system: 'api-openai', api: 'responses',
  keyVariable: 'OPENAI_API_KEY', baseVariable: 'E3D_OPENAI_BASE_URL', defaultBase: 'https://api.openai.com',
  efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],

  url: base => base.replace(/\/+$/, '') + '/v1/responses',
  headers: key => ({ authorization: 'Bearer ' + key, 'content-type': 'application/json' }),

  start(prompt) { return { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }] }; },

  tools: specs => specs.map(spec => ({ type: 'function', name: spec.name, description: spec.description, parameters: spec.schema, strict: false })),

  body(config, state, { maxTokens = config.max_output_tokens } = {}) {
    return {
      model: config.model, instructions: config.system_prompt, input: state.input, tools: this.tools(config.tools),
      store: false, include: ['reasoning.encrypted_content'], max_output_tokens: maxTokens,
      ...(config.effort ? { reasoning: { effort: config.effort } } : {}),
      ...(config.cache_key ? { prompt_cache_key: config.cache_key } : {}),
    };
  },

  parse(json) {
    if (!json || !Array.isArray(json.output)) return null;
    const u = json.usage ?? {};
    const calls = [], texts = [];
    let refused = false;
    for (const item of json.output) {
      if (item.type === 'function_call') {
        let args = null, parseError = null;
        try { args = JSON.parse(item.arguments ?? '{}'); } catch (error) { parseError = 'the arguments are not valid JSON: ' + error.message; }
        calls.push({ id: item.call_id, name: item.name, args, parse_error: parseError });
      } else if (item.type === 'message') {
        for (const part of item.content ?? []) {
          if (part.type === 'output_text' && part.text) texts.push(part.text);
          else if (part.type === 'refusal') { refused = true; if (part.refusal) texts.push(part.refusal); }
        }
      }
    }
    const reason = json.incomplete_details?.reason ?? null;
    return {
      id: json.id ?? null, model: json.model ?? null, stop: json.status === 'incomplete' ? 'incomplete:' + reason : json.status ?? null,
      texts, thinking: json.output.filter(item => item.type === 'reasoning').length, calls,
      usage: { input_tokens: Number(u.input_tokens) || 0, cached_input_tokens: Number(u.input_tokens_details?.cached_tokens) || 0,
        cache_creation_input_tokens: null, uncached_input_tokens: (Number(u.input_tokens) || 0) - (Number(u.input_tokens_details?.cached_tokens) || 0),
        output_tokens: Number(u.output_tokens) || 0, reasoning_tokens: Number(u.output_tokens_details?.reasoning_tokens) || 0 },
      raw_usage: json.usage ?? null,
      cut_off: json.status === 'incomplete' && reason === 'max_output_tokens',
      refused: refused || (json.status === 'incomplete' && reason === 'content_filter'),
      failed: json.status === 'failed' ? (json.error ?? { message: 'the response failed' }) : null,
    };
  },

  // Output items go back as input exactly as they came (reasoning items with
  // their encrypted content, function calls, messages).
  record(state, json) { state.input.push(...json.output); },

  respond(state, results, notice) {
    for (const result of results) {
      state.input.push({ type: 'function_call_output', call_id: result.id,
        output: result.image ? [{ type: 'input_text', text: result.text }, { type: 'input_image', image_url: 'data:' + result.image.media_type + ';base64,' + result.image.data, detail: 'auto' }] : result.text });
    }
    if (notice) this.say(state, notice);
  },

  say(state, text) { state.input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }); },

  failure({ status, headers, json, turns, now }) {
    return classifyFailure({ status, headers, error: json?.error ?? { message: null }, turns, now, billingCodes: BILLING_CODES });
  },

  requestId: (headers, json) => headers?.['x-request-id'] ?? json?.id ?? null,
};
