import { classifyFailure } from './errors.mjs';

// The Claude Messages API (POST /v1/messages), non-streaming. Wire format as
// documented (read 2026-10-05):
//   tools, tool_use / tool_result, images in tool results, is_error, tool_result
//   blocks first in the user message and text after them
//     platform.claude.com/docs/en/agents-and-tools/tool-use/overview.md
//     platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls.md
//   output_config.effort (low, medium, high, xhigh, max; Claude Opus 5.5
//   defaults to medium and always thinks), thinking {type: "adaptive"}
//     platform.claude.com/docs/en/build-with-claude/effort.md
//   cache_control on the system block and the last tool, plus top-level
//   automatic caching (moves the breakpoint to the last cacheable block each
//   turn); usage input_tokens / cache_creation_input_tokens /
//   cache_read_input_tokens, total input = the three summed
//     platform.claude.com/docs/en/build-with-claude/prompt-caching.md
//   errors, request-id, retry-after, anthropic-ratelimit-*-reset, the
//   spend-cap 429 (error.details.error_code enforced_spend_limit_reached)
//     platform.claude.com/docs/en/api/errors.md, /api/rate-limits.md
//   image limits (10 MB base64 per image; 2000 px per side above 20 images)
//     platform.claude.com/docs/en/build-with-claude/vision.md
// The history is append-only: every assistant turn is sent back exactly as it
// came (thinking blocks included, which the API requires unchanged).
export const ANTHROPIC = {
  id: 'anthropic', system: 'api-anthropic', api: 'messages',
  keyVariable: 'ANTHROPIC_API_KEY', baseVariable: 'E3D_ANTHROPIC_BASE_URL', defaultBase: 'https://api.anthropic.com',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  version: '2023-06-01',

  url: base => base.replace(/\/+$/, '') + '/v1/messages',
  headers(key) { return { 'x-api-key': key, 'anthropic-version': this.version, 'content-type': 'application/json' }; },

  start(prompt) { return { messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] }; },

  tools(specs) {
    return specs.map((spec, i) => ({ name: spec.name, description: spec.description, input_schema: spec.schema,
      ...(i === specs.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) }));
  },

  body(config, state, { maxTokens = config.max_output_tokens } = {}) {
    return {
      model: config.model, max_tokens: maxTokens,
      system: [{ type: 'text', text: config.system_prompt, cache_control: { type: 'ephemeral' } }],
      tools: this.tools(config.tools), messages: state.messages,
      thinking: { type: 'adaptive' },
      ...(config.effort ? { output_config: { effort: config.effort } } : {}),
      cache_control: { type: 'ephemeral' },
    };
  },

  // A 200 response reduced to what the loop needs.
  parse(json) {
    if (!json || json.type === 'error' || !Array.isArray(json.content)) return null;
    const u = json.usage ?? {}, n = key => Number(u[key]) || 0;
    const calls = json.content.filter(block => block.type === 'tool_use').map(block => ({ id: block.id, name: block.name, args: block.input ?? {} }));
    return {
      id: json.id ?? null, model: json.model ?? null, stop: json.stop_reason ?? null,
      texts: json.content.filter(block => block.type === 'text' && block.text).map(block => block.text),
      thinking: json.content.filter(block => block.type === 'thinking' || block.type === 'redacted_thinking').length,
      calls,
      usage: { input_tokens: n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens'),
        cached_input_tokens: n('cache_read_input_tokens'), cache_creation_input_tokens: n('cache_creation_input_tokens'),
        uncached_input_tokens: n('input_tokens'), output_tokens: n('output_tokens'), reasoning_tokens: null },
      raw_usage: json.usage ?? null,
      cut_off: json.stop_reason === 'max_tokens',
      refused: json.stop_reason === 'refusal',
    };
  },

  record(state, json) { state.messages.push({ role: 'assistant', content: json.content }); },

  // results: [{ id, ok, text, image? }] in call order; notice: text or null.
  respond(state, results, notice) {
    const content = results.map(result => ({
      type: 'tool_result', tool_use_id: result.id,
      content: result.image ? [{ type: 'text', text: result.text }, { type: 'image', source: { type: 'base64', media_type: result.image.media_type, data: result.image.data } }] : result.text,
      ...(result.ok ? {} : { is_error: true }),
    }));
    if (notice) content.push({ type: 'text', text: notice });
    state.messages.push({ role: 'user', content });
  },

  say(state, text) { state.messages.push({ role: 'user', content: [{ type: 'text', text }] }); },

  failure({ status, headers, json, turns, now }) {
    return classifyFailure({ status, headers, error: json?.error ?? { message: null }, turns, now });
  },

  requestId: (headers, json) => headers?.['request-id'] ?? json?.request_id ?? null,
};
