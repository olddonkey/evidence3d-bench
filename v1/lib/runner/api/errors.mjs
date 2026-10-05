// What an HTTP failure from a model API means for an attempt. Both providers
// map their answers onto one verdict:
//   { action: 'retry' | 'wait' | 'stop' | 'model', reason, message, wait_ms?, retry_after_source? }
//   retry  overloaded / server_error: retried in the loop with backoff (3 times), then infra_error
//   wait   rate_limit: waited out in the loop if the stated wait is short, else infra_error with retry_after
//   stop   auth / billing / model_unavailable / request_rejected: infra_error at once, the batch stops for a human
//   model  the model's own failure (its context is full, its history too large, a request it shaped): generation_failed
// Sources (read 2026-10-05): platform.claude.com/docs/en/api/errors.md and
// /api/rate-limits.md; developers.openai.com/api/docs/guides/error-codes and
// /guides/rate-limits.

const CONTEXT = /prompt is too long|context window|context length|context_length_exceeded|maximum context|too many (input )?tokens|exceeds? the (model'?s? )?(maximum|context)/i;
const BILLING = /credit balance|billing|spend limit|spending limit|reached your specified (workspace )?API usage limits|quota|payment/i;

// Seconds from a retry-after header (seconds, or an HTTP date).
function retryAfterMs(value, now) {
  if (value === undefined || value === null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

// "1s", "6m0s", "20ms", "1h2m3.5s" (OpenAI's x-ratelimit-reset-*).
export function durationMs(text) {
  const value = String(text ?? '').trim();
  if (!/^(\d+(\.\d+)?(h|ms|m|s))+$/.test(value)) return null;
  let total = 0;
  for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s)/g)) total += Number(amount) * { h: 3600000, m: 60000, s: 1000, ms: 1 }[unit];
  return total;
}

// How long a rate limit asks to wait, best source first: retry-after; then
// Anthropic's anthropic-ratelimit-*-reset (RFC 3339 times; the latest of the
// limits that are exhausted, else of all); then OpenAI's x-ratelimit-reset-*
// (durations). null when nothing is stated.
export function rateLimitWait(headers = {}, now = Date.now()) {
  const stated = retryAfterMs(headers['retry-after'], now);
  if (stated !== null) return { wait_ms: stated, source: 'retry-after' };
  const resets = Object.keys(headers).filter(name => /^anthropic-ratelimit-.*-reset$/.test(name));
  if (resets.length) {
    const exhausted = resets.filter(name => Number(headers[name.replace(/-reset$/, '-remaining')]) === 0);
    const times = (exhausted.length ? exhausted : resets).map(name => Date.parse(headers[name])).filter(Number.isFinite);
    if (times.length) return { wait_ms: Math.max(0, Math.max(...times) - now), source: 'anthropic-ratelimit-reset' };
  }
  const durations = ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens'].map(name => durationMs(headers[name])).filter(value => value !== null);
  if (durations.length) return { wait_ms: Math.max(...durations), source: 'x-ratelimit-reset' };
  return { wait_ms: null, source: null };
}

// status: HTTP status; error: { type, code, message, details } from the body;
// turns: model responses so far in the session (a refused request before any
// is a configuration problem, after some it is the model's doing).
export function classifyFailure({ status, headers = {}, error = {}, turns = 0, now = Date.now(), billingCodes = [] }) {
  const message = String(error.message ?? '').slice(0, 1000) || 'HTTP ' + status;
  const code = String(error.code ?? error.details?.error_code ?? '');
  const verdict = (action, reason, extra = {}) => ({ action, reason, message, status, code: code || null, type: error.type ?? null, ...extra });
  if (status === 429) {
    if (billingCodes.includes(code) || /spend_limit|usage_limit|quota|credit/i.test(code)) return verdict('stop', 'billing');
    if (BILLING.test(message) && !/rate limit/i.test(message)) return verdict('stop', 'billing');
    const wait = rateLimitWait(headers, now);
    return verdict('wait', 'rate_limit', { wait_ms: wait.wait_ms, retry_after_source: wait.source });
  }
  if (status === 529 || status === 503) return verdict('retry', 'overloaded');
  if (status >= 500 || status === 408 || status === 409) return verdict('retry', 'server_error');
  if (status === 401 || status === 403) return verdict('stop', 'auth');
  if (status === 402) return verdict('stop', 'billing');
  if (status === 404) return /model/i.test(message + code) ? verdict('stop', 'model_unavailable') : verdict('stop', 'request_rejected');
  if (code === 'model_not_found') return verdict('stop', 'model_unavailable');
  if (BILLING.test(message) || /spend_limit|quota/i.test(code)) return verdict('stop', 'billing');
  if (CONTEXT.test(message) || /context_length/i.test(code)) return verdict('model', 'context_length');
  if (status === 413) return turns ? verdict('model', 'request_too_large') : verdict('stop', 'request_rejected');
  return turns ? verdict('model', 'bad_request') : verdict('stop', 'request_rejected');
}
