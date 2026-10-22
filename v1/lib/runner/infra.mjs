// Infrastructure errors: telling "the model failed" from "the harness could
// not run the model". An attempt whose session was ended by a usage or rate
// limit, a lost login, the network, an overloaded or failing service, or a CLI
// that died before the model did anything is not a sample of the model: it is
// recorded as status `infra_error` with a reason, the raw evidence and, when
// the CLI states one, the time the limit resets.
//
// The shapes below were read from the CLIs themselves (codex-cli 0.159.2,
// Claude Code 2.1.285). Each is marked in README.md as observed live (a real
// session, or the real CLI against a local server returning the error) or
// inferred (message text found in the binary only). A pattern that is not
// recognised is never guessed at: a session that produced model turns and
// then ended with an unrecognised error stays a model failure.

// reason -> what a scheduler should do about it
//   wait   the account is limited until a stated or unknown time
//   retry  transient; a fresh attempt is expected to work
//   stop   needs a human (login, billing, model id); retrying cannot help
//   host_suspended (any system): the machine slept during the attempt (hostsleep.mjs)
//   request_rejected (API systems): the API refused the frozen request before
//   any model turn (an effort or a parameter the model does not take)
export const INFRA_REASONS = {
  usage_limit: 'wait', rate_limit: 'wait',
  overloaded: 'retry', server_error: 'retry', network: 'retry', cli_crash: 'retry', cli_stalled: 'retry', runner_interrupted: 'retry', host_suspended: 'retry',
  auth: 'stop', billing: 'stop', model_unavailable: 'stop', request_rejected: 'stop',
};

// The API systems (api-anthropic, api-openai) run our own loop, which
// classifies every HTTP failure itself (api/errors.mjs) and states its
// verdict in its final `result` event; nothing is read from message text.
const isApi = system => /^api-/.test(system ?? '');

// A timed-out session counts as infrastructure only if the CLI was still
// retrying or waiting on the service when the wall clock expired: its last
// event is an infrastructure retry, nothing the model did came after it, and
// it arrived this close to the deadline (Codex repeats "waiting for network"
// about every 45 s; Claude's api_retry states its own delay, which is added).
export const TIMEOUT_WINDOW_MS = 180000;

const SYNTHETIC_MODEL = '<synthetic>';

// Text that means the model (or the task) caused the failure, whatever else
// the message says. Checked before any infrastructure pattern.
const NOT_INFRA = [
  /context window|ran out of room|prompt is too long|too many tokens|maximum context|context_length/i,
  /cyber policy|bio policy|misalignment|policy violation|safety (classifier|monitor)|content filter|flagged/i,
  /max_output_tokens|output token maximum/i,
];

// Codex messages, most specific first. [reason, pattern]
const CODEX_PATTERNS = [
  ['usage_limit', /hit your usage limit/i],                                         // live (fake server): UsageLimitReached
  ['billing', /out of credits|spend cap|Quota exceeded|upgrade to Plus|usage not included/i], // live (fake server): insufficient_quota
  ['model_unavailable', /model is not supported|model_not_found|model .{1,80} does not exist/i], // live: bogus model id
  ['rate_limit', /exceeded retry limit, last status: 429|rate limit/i],             // live (fake server): plain 429
  ['auth', /status 401|status 403|Unauthorized|access token could not be refreshed|sign in again|Not logged in|refresh token|Missing bearer|authentication/i], // live: no login
  ['overloaded', /high demand|server overloaded|overloaded|at capacity|capacity unavailable/i], // live (fake server): 500 -> "high demand"
  ['server_error', /exceeded retry limit, last status: 5\d\d|unexpected status 5\d\d|internal server error|internal_server_error|Error while reading the server response/i], // live (fake server): 503
  ['network', /stream disconnected|Connection failed|waiting for network|error sending request|workspace routing discovery failed|request timed out|timed out|connection (reset|refused|closed)|broken pipe|\bdns\b|\btls\b|certificate|websocket/i], // live: no network, TLS, refused, pilot logs
];

// Grok Build's messages (1.0.46), most specific first: the result event's
// errors[] (or its result text), else stderr. Observed live: unknown model id.
// The rest is the CLI's own text found in its binary (inferred), see README.
// No Grok message found states when a limit resets, so retry_after stays null.
const GROK_NOT_INFRA = /exceed_context_size|context_length_exceeded|maximum context length|maximum prompt length|prompt is too long|context window|output limit|max_tokens/i;
const GROK_PATTERNS = [
  ['model_unavailable', /unknown model id|Couldn't set model|is not in your available models|model_not_found|model isn't available/i], // live: bogus model id
  ['usage_limit', /hit your (free |weekly )?(usage )?limit|usage limit reached|usage limit for now|free-usage-exhausted/i], // inferred
  ['billing', /out of credits|spending limit|usage balance exhausted|purchase credits|status 402|payment required/i], // inferred
  ['rate_limit', /hit the rate limit|rate limit exceeded|rate limited|status 429|too many requests/i],              // inferred
  // Before auth: a transient outage of the sign-in service, not a lost login.
  ['overloaded', /authentication temporarily unavailable/i],                                                       // inferred
  ['auth', /Not logged in|session (has )?expired|credentials were rejected|could not renew it|sign-in was rejected|sign in again|deployment key was rejected|status 40[13]\b|unauthorized|authentication/i], // inferred
  ['overloaded', /overloaded|temporarily unavailable|service is busy|service unavailable|service_unavailable|status 503|at capacity/i], // inferred
  ['server_error', /internal server error|bad gateway|gateway timeout|status 50[0-9]\b|went wrong on (our|the server)|server-side stream error|server returned an unexpected error/i], // inferred
  ['network', /error sending request|connection (refused|reset|closed)|connection failed|secure connection to Grok failed|connection to Grok timed out|check your network|tcp connect|dns error|failed to lookup|resolve host|network is unreachable|timed out|stopped responding|stream disconnected/i], // inferred
];

export function grokReason(text) {
  text = String(text ?? '');
  if (GROK_NOT_INFRA.test(text) || NOT_INFRA.some(pattern => pattern.test(text))) return null;
  for (const [reason, pattern] of GROK_PATTERNS) if (pattern.test(text)) return reason;
  return null;
}

// Antigravity CLI messages, most specific first: the result event's error,
// else stderr. From the documentation only (2026-10-22): "invalid model
// selection" (unknown --model, exit 1), "authentication required" (no login),
// "failed to retrieve token: secret keyring is locked", "Individual quota
// reached" (a user report). The rest are the usual Google API status words
// (RESOURCE_EXHAUSTED, UNAVAILABLE, ...), inferred; codes are matched in
// capitals only, so a sentence that merely says "unavailable" is not one.
const AGY_NOT_INFRA = /input token count|token limit|context (length|window)|exceeds the maximum/i;
const AGY_PATTERNS = [
  ['model_unavailable', /invalid model selection|unknown model|model (is )?not (available|found|supported)|not available (on|for) your plan/i],
  ['usage_limit', /quota reached|individual quota|quota (has been )?exceeded|usage limit|(weekly|five.hour|5.hour) limit|limit reached|out of quota/i],
  ['billing', /insufficient credits|out of credits|purchase credits|payment required|billing/i],
  ['rate_limit', /rate.?limit|too many requests|\b429\b|RESOURCE_EXHAUSTED/i],
  ['auth', /authentication required|not authenticated|not logged in|login required|sign in again|failed to retrieve token|keyring is locked|UNAUTHENTICATED|PERMISSION_DENIED|\b40[13]\b/i],
  ['overloaded', /\bUNAVAILABLE\b|\b503\b/],
  ['overloaded', /overloaded|high demand|at capacity|service unavailable/i],
  ['server_error', /\bINTERNAL\b|\b50[024]\b/],
  ['server_error', /internal (server )?error|bad gateway|gateway timeout/i],
  ['network', /dial tcp|connection (refused|reset)|no such host|TLS handshake|i\/o timeout|network is unreachable|could not connect|failed to connect|unexpected EOF|DEADLINE_EXCEEDED/i],
];

export function agyReason(text) {
  text = String(text ?? '');
  if (AGY_NOT_INFRA.test(text) || NOT_INFRA.some(pattern => pattern.test(text))) return null;
  for (const [reason, pattern] of AGY_PATTERNS) if (pattern.test(text)) return reason;
  return null;
}

// Claude Code's own classification of an API error, carried on the synthetic
// assistant message (`error`) and on system/api_retry events (live: all of
// rate_limit, server_error, authentication_failed, billing_error,
// model_not_found, unknown; inferred: the rest).
const CLAUDE_CATEGORIES = {
  rate_limit: 'rate_limit', overloaded: 'overloaded', server_error: 'server_error', billing_error: 'billing', model_not_found: 'model_unavailable',
  authentication_failed: 'auth', oauth_org_not_allowed: 'auth', account_on_hold: 'auth', verification_required: 'auth', cloud_credential_error: 'auth',
};

// Refinements of Claude's category by its message text.
function claudeReason(category, text, status) {
  text = String(text ?? '');
  if (NOT_INFRA.some(pattern => pattern.test(text))) return null;
  if (/not your usage limit/i.test(text)) return 'rate_limit';                       // inferred: "Server is temporarily limiting requests (not your usage limit)"
  if (/hit your .{0,40}limit|usage limit reached|limit reached/i.test(text)) return 'usage_limit'; // inferred: "You've hit your session limit · resets 7:50pm (Zone)"
  if (/experiencing high load|Overloaded|\b529\b/i.test(text)) return 'overloaded'; // live (fake server): "API Error: 529 Overloaded."
  if (/Can't reach|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|Connection (refused|to the API was lost|lost|error)|Unable to connect|certificate|\bTLS\b|socket hang up|stalled before|went to sleep|Request timed out|no response (headers|was produced)/i.test(text)) return 'network'; // live: no network, refused, DNS, TLS
  if (category === 'rate_limit' && status !== 429 && /credits? (are )?required|extra usage/i.test(text)) return 'billing';
  if (CLAUDE_CATEGORIES[category]) return CLAUDE_CATEGORIES[category];
  if (category === 'invalid_request') {
    if (/not available with the Claude \w+ plan/i.test(text)) return 'model_unavailable';
    if (/disabled Claude subscription access|organization has disabled/i.test(text)) return 'auth';
    return null;
  }
  if (Number.isInteger(status) && status >= 500) return 'server_error';
  return null;
}

function codexReason(text) {
  text = String(text ?? '');
  if (NOT_INFRA.some(pattern => pattern.test(text))) return null;
  for (const [reason, pattern] of CODEX_PATTERNS) if (pattern.test(text)) return reason;
  return null;
}

// ---------------------------------------------------------------- model activity

// Events that show the model working: a turn, a message, a tool call or its
// result, thinking. A CLI that never got this far did not run the model.
export function isModelActivity(system, event) {
  if (!event || typeof event !== 'object') return false;
  if (isApi(system)) return (event.type === 'request' && event.ok === true) || event.type === 'tool' || event.type === 'text';
  if (system === 'codex') {
    if (event.type === 'turn.completed') return true;
    return /^item\./.test(event.type ?? '') && event.item && event.item.type !== 'error';
  }
  // agy: a step the model produced (its reply or a tool call), not the prompt echoed back.
  if (system === 'antigravity') return event.event === 'step_update' && ['agent_response', 'tool'].includes(event.step_update?.step_type);
  if (event.type === 'assistant') return event.message?.model !== SYNTHETIC_MODEL && !event.is_api_error_message;
  if (event.type === 'user' || event.type === 'tool_progress') return true;
  return event.type === 'system' && event.subtype === 'thinking_tokens';
}

export function modelTurns(system, events) {
  return events.filter(event => isModelActivity(system, event)).length;
}

// The CLI telling us it is retrying or waiting on the service.
function infraSignal(system, event) {
  if (isApi(system)) {
    if (event?.type !== 'retry' || !INFRA_REASONS[event.reason]) return null;
    return { reason: event.reason, text: JSON.stringify({ retry: event.attempt, reason: event.reason, status: event.status ?? null, delay_ms: event.delay_ms, message: String(event.message ?? '').slice(0, 300) }),
      delay_ms: Number(event.delay_ms) || 0 };
  }
  if (system === 'codex') {
    const text = event?.type === 'error' ? event.message : event?.type === 'item.completed' && event.item?.type === 'error' ? event.item.message : null;
    if (typeof text !== 'string') return null;
    // "Model metadata ... not found" and similar notices are not about the service.
    if (!/Reconnecting|Falling back from WebSockets|waiting for network|retry limit|usage limit|unexpected status|stream disconnected|Connection failed/i.test(text)) return null;
    const reason = codexReason(text);
    return reason ? { reason, text, delay_ms: 0 } : null;
  }
  if (event?.type === 'system' && event.subtype === 'api_retry') {
    const reason = event.error === 'unknown' && event.error_status == null ? 'network' : (CLAUDE_CATEGORIES[event.error] ?? (event.error_status >= 500 ? 'server_error' : null));
    return reason ? { reason, text: JSON.stringify({ subtype: 'api_retry', attempt: event.attempt, max_retries: event.max_retries, error: event.error, error_status: event.error_status, retry_delay_ms: event.retry_delay_ms }), delay_ms: Number(event.retry_delay_ms) || 0 } : null;
  }
  return null;
}

// ---------------------------------------------------------------- retry watchdog
//
// Codex waits for an unreachable service indefinitely ("Reconnecting...
// waiting for network", about every 45 s), so an outage would otherwise eat
// an attempt's whole wall clock before it is recognised. The watchdog follows
// the event stream as it arrives and says when the CLI has been retrying the
// service, with no sign of the model in between, for `stallMs`; the runner
// then stops the CLI and records an infrastructure error at once. "Still
// retrying" needs a fresh retry event (within TIMEOUT_WINDOW_MS plus the
// CLI's own stated delay), and a streak is only continuous while its retry
// events follow each other that closely: a stream that came back silently
// while the model thinks is not cut off, and a lone reconnect minutes later
// starts a streak of its own instead of extending the old one. A CLI that has
// printed nothing at all for `stallMs` is stalled. The time spent in retry
// streaks the session recovered from is summed in `lostMs` (a diagnostic:
// such a session is still a sample).
export function retryWatch(system, { stallMs, windowMs = TIMEOUT_WINDOW_MS } = {}) {
  let streak = null, lost = 0, events = 0;
  return {
    onEvent(event, ms) {
      events++;
      const signal = infraSignal(system, event);
      if (signal) {
        if (streak && ms - streak.last > windowMs + (streak.delay ?? 0)) { lost += streak.last - streak.since; streak = null; }
        if (!streak) streak = { since: ms, retries: 0 };
        Object.assign(streak, { last: ms, delay: signal.delay_ms, reason: signal.reason, text: signal.text, retries: streak.retries + 1 });
      } else if (streak && isModelActivity(system, event)) {
        lost += ms - streak.since;
        streak = null;
      }
    },
    // ms: time since the CLI started. Returns why to stop it, or null.
    check(ms) {
      if (!stallMs) return null;
      if (!events && ms >= stallMs) return { reason: 'cli_stalled', kind: 'silent', since_ms: 0, last_ms: null, retries: 0, text: null };
      if (streak && ms - streak.since >= stallMs && ms - streak.last <= windowMs + (streak.delay ?? 0)) {
        return { reason: streak.reason, kind: 'retrying', since_ms: streak.since, last_ms: streak.last, retries: streak.retries, text: streak.text };
      }
      return null;
    },
    lostMs: () => lost,
  };
}

// ---------------------------------------------------------------- terminal errors

const lastActivity = (system, events) => events.findLastIndex(event => isModelActivity(system, event));

// What ended a Codex session: the last turn.failed, else an error event that
// nothing the model did came after (an earlier reconnect that recovered is
// not the cause of anything).
function codexTerminal(events) {
  const failed = events.findLast(event => event?.type === 'turn.failed');
  if (failed) return { text: failed.error?.message ?? JSON.stringify(failed.error ?? failed), source: 'turn.failed' };
  const index = events.findLastIndex(event => event?.type === 'error');
  return index > lastActivity('codex', events) ? { text: events[index].message ?? JSON.stringify(events[index]), source: 'error' } : null;
}

// What ended a Claude session: an error result, with Claude's own category
// taken from the synthetic assistant message that carries the API error. The
// category is used only when the result says the session ended on an API
// error; a session that ended for another reason (max turns, an internal
// error) is not blamed on an API error it recovered from earlier.
function claudeTerminal(events) {
  const result = events.findLast(event => event?.type === 'result');
  const index = events.findLastIndex(event => event?.type === 'assistant' && (event.is_api_error_message || event.message?.model === SYNTHETIC_MODEL) && event.error);
  const synthetic = index > lastActivity('claude-code', events) ? events[index] : null;
  if (result && !result.is_error) return null;
  if (!result && !synthetic) return null;
  const apiError = !result || !result.terminal_reason || result.terminal_reason === 'api_error';
  const text = typeof result?.result === 'string' ? result.result
    : (synthetic?.message?.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join(' ');
  return {
    text, category: apiError ? synthetic?.error ?? null : null, status: apiError ? result?.api_error_status ?? null : null,
    terminal_reason: result?.terminal_reason ?? null, subtype: result?.subtype ?? null, source: result ? 'result' : 'assistant',
  };
}

// ---------------------------------------------------------------- reset times

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function zoneParts(epochMs, timeZone) {
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(epochMs))) parts[part.type] = Number(part.value);
  return parts;
}

// Epoch ms of a wall-clock time in a time zone (two passes settle DST edges).
export function zonedEpoch({ year, month, day, hour, minute }, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let pass = 0; pass < 2; pass++) {
    const p = zoneParts(guess, timeZone);
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(guess / 1000) * 1000;
    guess = wall - offset;
  }
  return guess;
}

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// "7:50 PM", "7pm", "Oct 3rd, 2026 7:50 PM", "Oct 3, 7pm" relative to `now`.
// Without a date the time is today in that zone, or tomorrow if that has
// already passed (the message may cross midnight before it is read).
export function parseResetTime(text, { now = Date.now(), timeZone = localZone() } = {}) {
  const match = /(?:([A-Z][a-z]{2})[a-z]* (\d{1,2})(?:st|nd|rd|th)?,? (?:(\d{4}),? )?)?(\d{1,2})(?::(\d{2}))?\s?([AaPp][Mm])\b/.exec(String(text ?? ''));
  if (!match) return null;
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem] = match;
  let zone = timeZone;
  const named = /\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)+|UTC)\)/.exec(String(text).slice(match.index));
  if (named) { try { new Intl.DateTimeFormat('en-US', { timeZone: named[1] }); zone = named[1]; } catch {} }
  let hour = Number(hourText) % 12;
  if (/p/i.test(meridiem)) hour += 12;
  const minute = Number(minuteText ?? 0), today = zoneParts(now, zone);
  let epoch;
  if (monthName) {
    const month = MONTHS[monthName.toLowerCase()];
    if (!month) return null;
    let year = yearText ? Number(yearText) : today.year;
    epoch = zonedEpoch({ year, month, day: Number(dayText), hour, minute }, zone);
    if (!yearText && epoch < now - 86400000) epoch = zonedEpoch({ year: year + 1, month, day: Number(dayText), hour, minute }, zone);
  } else {
    epoch = zonedEpoch({ year: today.year, month: today.month, day: today.day, hour, minute }, zone);
    if (epoch < now - 300000) epoch += 86400000;
  }
  // A stated reset more than eight days out, or long past, is not believed.
  if (!Number.isFinite(epoch) || epoch < now - 300000 || epoch > now + 8 * 86400000) return null;
  return { at: new Date(epoch).toISOString(), zone };
}

// The reset time a session stated, best source first: Claude's structured
// rate_limit_event (status "rejected", resetsAt in epoch seconds; inferred,
// only "allowed" was seen live), then the message text.
function retryAfter(system, events, text, now) {
  if (system === 'claude-code') {
    const rejected = events.findLast(event => event?.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected');
    const resetsAt = Number(rejected?.rate_limit_info?.resetsAt);
    if (Number.isFinite(resetsAt) && resetsAt * 1000 > now - 300000) {
      return { retry_after: new Date(resetsAt * 1000).toISOString(), retry_after_source: 'rate_limit_event', retry_after_text: JSON.stringify(rejected.rate_limit_info) };
    }
  }
  const phrase = system === 'codex' ? /try again at ([^.]*\d[^.]*(?:AM|PM))/i.exec(text ?? '') : /resets ([^·\n]*?(?:am|pm)(?: \([^)]+\))?)/i.exec(text ?? '');
  if (!phrase) return { retry_after: null, retry_after_source: null, retry_after_text: null };
  const parsed = parseResetTime(phrase[1], { now });
  return { retry_after: parsed?.at ?? null, retry_after_source: parsed ? 'message' : null, retry_after_text: phrase[0] };
}

// ---------------------------------------------------------------- detection

function record(reason, fields) {
  return { reason, action: INFRA_REASONS[reason], retry_after: null, retry_after_source: null, retry_after_text: null, ...fields };
}

// run: captureProcess record (exit_code, signal, timed_out, launch_error,
// wall_seconds, finished_at, stderr); summary: adapter.parse(events);
// eventMs: arrival time of each event in ms after the CLI started, or null
// when the run was rebuilt from its logs; wallLimitSeconds: the budget.
// Returns null when the session ended on its own terms or failed in a way
// that is the model's (or unknown, which is treated as the model's).
export function detectInfra({ system, events = [], eventMs = null, run, summary, wallLimitSeconds = null, now = Date.now() }) {
  if (!run) return null;
  const turns = modelTurns(system, events);
  const during = run.timed_out ? 'timeout' : turns > 0 ? 'session' : 'startup';
  const base = { model_turns: turns, during };
  // The tail of stderr, led by its first error-looking line: a stack trace's
  // last lines rarely say what went wrong.
  const stderrLines = String(run.stderr ?? '').trim().split('\n').filter(line => line.trim());
  const firstError = stderrLines.find(line => /error|panicked|fatal|failed|denied|not found/i.test(line));
  const tail = stderrLines.slice(-5);
  const stderrTail = [...(firstError && !tail.includes(firstError) ? [firstError, '…'] : []), ...tail].join('\n').slice(-1500) || null;
  if (run.launch_error) return record('cli_crash', { ...base, message: 'the CLI could not be started: ' + run.launch_error, evidence: [run.launch_error], retry_after: null });
  // The runner's watchdog stopped a CLI that kept retrying the service (or
  // printed nothing at all) for too long; see retryWatch.
  if (run.watchdog) {
    const dog = run.watchdog, span = dog.stall_ms >= 60000 ? Math.round(dog.stall_ms / 6000) / 10 + ' min' : Math.round(dog.stall_ms / 100) / 10 + ' s';
    const message = dog.kind === 'silent' ? 'the CLI printed nothing for ' + span + '; stopped by the runner'
      : 'the CLI had been retrying the service for ' + span + ' with no model activity; stopped by the runner: ' + dog.text;
    return record(dog.reason, { ...base, during: turns > 0 ? 'session' : 'startup', message,
      evidence: [dog.text ?? stderrTail ?? 'no output', dog.retries + ' retry/wait events in the streak', 'streak began ' + Math.round(dog.since_ms / 1000) + ' s after start'].filter(Boolean),
      ...(dog.text ? retryAfter(system, events, dog.text, now) : {}) });
  }
  // A session that completed did its work, whatever the exit code says
  // afterwards (that stays generation_failed, not an infrastructure error).
  // One that used up its budget (API systems) ended on its own terms too.
  if ((summary?.completed || summary?.budget_exhausted) && !run.timed_out) return null;

  if (run.timed_out) {
    // The last thing that happened before the kill.
    let last = -1;
    for (let i = events.length - 1; i >= 0; i--) if (isModelActivity(system, events[i]) || infraSignal(system, events[i])) { last = i; break; }
    const signal = last >= 0 ? infraSignal(system, events[last]) : null;
    if (signal) {
      const deadline = (wallLimitSeconds ?? run.wall_seconds ?? 0) * 1000;
      const at = eventMs?.[last];
      const recent = at === undefined || at === null ? null : at + signal.delay_ms + TIMEOUT_WINDOW_MS >= deadline;
      if (recent !== false) {
        const repeats = events.filter(event => infraSignal(system, event)).length;
        return record(signal.reason, { ...base, message: 'the wall clock expired while the CLI was retrying the service: ' + signal.text,
          evidence: [signal.text, repeats + ' retry/wait events in the session', at === undefined || at === null ? 'event times unavailable (rebuilt from logs)' : 'last one ' + Math.round((deadline - at) / 1000) + ' s before the deadline'],
          ...retryAfter(system, events, signal.text, now) });
      }
    }
    // A CLI that ran out its whole budget without the model ever acting.
    if (turns === 0) return record('cli_stalled', { ...base, message: 'the wall clock expired before the model produced anything', evidence: [stderrTail ?? 'no stderr', events.length + ' events'], retry_after: null });
    return null;
  }

  if (isApi(system)) return apiInfra(events, base, stderrTail, run);
  if (system === 'grok') return grokInfra(events, base, stderrTail, run, turns);
  if (system === 'antigravity') return agyInfra(events, base, stderrTail, run, turns);
  const terminal = system === 'codex' ? codexTerminal(events) : claudeTerminal(events);
  if (terminal) {
    const reason = system === 'codex' ? codexReason(terminal.text) : claudeReason(terminal.category, terminal.text, terminal.status);
    if (reason) {
      const evidence = [terminal.text];
      if (terminal.category) evidence.push('claude error category: ' + terminal.category + (terminal.status ? ', HTTP ' + terminal.status : ''));
      const retries = events.filter(event => infraSignal(system, event)).length;
      if (retries) evidence.push(retries + ' retry/wait events before it');
      return record(reason, { ...base, message: terminal.text, evidence, ...retryAfter(system, events, terminal.text, now) });
    }
    if (NOT_INFRA.some(pattern => pattern.test(terminal.text ?? ''))) return null;
  }
  // The CLI ended without the model ever acting and without an error we
  // recognise: whatever went wrong, it was not the model.
  if (turns === 0) {
    return record('cli_crash', { ...base, message: terminal?.text ?? 'the CLI exited (' + (run.signal ?? 'exit ' + run.exit_code) + ') before the model produced anything',
      evidence: [terminal?.text, stderrTail, 'exit ' + run.exit_code + (run.signal ? ' ' + run.signal : '')].filter(Boolean), retry_after: null });
  }
  return null;
}

// What ended an API session: the loop's verdict in its result event. An
// infrastructure verdict is taken as stated; a model failure (its context
// filled up, a request it shaped was refused) is not one; a loop that ended
// without its result record failed itself, whatever the model had done.
function apiInfra(events, base, stderrTail, run) {
  const result = events.findLast(event => event?.type === 'result');
  if (result?.infra?.reason && INFRA_REASONS[result.infra.reason]) {
    const infra = result.infra, retries = events.filter(event => event?.type === 'retry').length;
    return record(infra.reason, { ...base, message: String(infra.message ?? infra.reason),
      evidence: [String(infra.message ?? ''), 'HTTP ' + (infra.status ?? '-'), ...(retries ? [retries + ' in-loop retries/waits before it'] : [])].filter(Boolean),
      retry_after: infra.retry_after ?? null, retry_after_source: infra.retry_after ? infra.retry_after_source ?? 'loop' : null, retry_after_text: null });
  }
  if (result) return null;
  return record('cli_crash', { ...base, message: 'the API loop ended (' + (run.signal ?? 'exit ' + run.exit_code) + ') without its result record',
    evidence: [stderrTail, 'exit ' + run.exit_code + (run.signal ? ' ' + run.signal : '')].filter(Boolean), retry_after: null });
}

// What ended a Grok session: an error result's errors[] (or result text),
// else stderr ("Error: ..."), matched against GROK_PATTERNS. A session that
// never reached the model and says nothing recognisable is a CLI crash;
// after model turns, unrecognised text stays the model's failure.
function grokInfra(events, base, stderrTail, run, turns) {
  const result = events.findLast(event => event?.type === 'result');
  if (result && !result.is_error) return null;
  const text = [...(Array.isArray(result?.errors) ? result.errors : []), typeof result?.result === 'string' ? result.result : '', !result ? stderrTail ?? '' : '']
    .filter(Boolean).join(' | ');
  const reason = grokReason(text) ?? (!result ? grokReason(stderrTail) : null);
  if (reason) return record(reason, { ...base, message: text || stderrTail, evidence: [text, stderrTail].filter(Boolean) });
  if (turns === 0) {
    return record('cli_crash', { ...base, message: text || 'grok exited (' + (run.signal ?? 'exit ' + run.exit_code) + ') before the model produced anything',
      evidence: [text, stderrTail, 'exit ' + run.exit_code + (run.signal ? ' ' + run.signal : '')].filter(Boolean), retry_after: null });
  }
  return null;
}

// What ended an agy session: a result whose status is not SUCCESS carries the
// reason in `error`; a run that printed no result says it on stderr (an
// unauthenticated run exits with "authentication required"). Matched against
// AGY_PATTERNS like Grok's text; a session that never reached the model and
// says nothing recognisable is a CLI crash.
function agyInfra(events, base, stderrTail, run, turns) {
  const result = events.findLast(event => event?.event === 'result')?.result ?? null;
  if (result?.status === 'SUCCESS') return null;
  const text = [typeof result?.error === 'string' ? result.error : '', result && !result.error ? String(result.status ?? '') : '', !result ? stderrTail ?? '' : '']
    .filter(Boolean).join(' | ');
  const reason = agyReason(text) ?? (result ? agyReason(stderrTail) : null);
  if (reason) return record(reason, { ...base, message: text || stderrTail, evidence: [text, stderrTail].filter(Boolean) });
  if (turns === 0) {
    return record('cli_crash', { ...base, message: text || 'agy exited (' + (run.signal ?? 'exit ' + run.exit_code) + ') before the model produced anything',
      evidence: [text, stderrTail, 'exit ' + run.exit_code + (run.signal ? ' ' + run.signal : '')].filter(Boolean), retry_after: null });
  }
  return null;
}
