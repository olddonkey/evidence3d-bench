// The budget of an API session, frozen at prepare: tokens (the sum over
// requests of input + output tokens as the API reports them, cached input
// counted in full) and tool calls. The wall clock is only a safety cap,
// enforced by the runner. A budget is exhausted when the session wants more
// than is left: the token budget is checked before each request (so the
// request that crosses it is the last one, and its tool calls still run), the
// tool budget before each call (so at most `tool_calls` calls run). Once,
// when either reaches `notice` of its total, the model is told how much is left.
export const DEFAULT_BUDGET = { tokens: 2000000, tool_calls: 200, notice: 0.85 };

export function createBudget({ tokens = DEFAULT_BUDGET.tokens, tool_calls: toolCalls = DEFAULT_BUDGET.tool_calls, notice = DEFAULT_BUDGET.notice } = {}) {
  let used = 0, calls = 0, noticed = false;
  return {
    addTokens(n) { used += Number(n) || 0; },
    addCall() { calls++; },
    get tokensUsed() { return used; },
    get callsUsed() { return calls; },
    tokensExhausted: () => used >= tokens,
    callsExhausted: () => calls >= toolCalls,
    // The notice, the first time a budget passes the notice fraction; else null.
    noticeDue() {
      if (noticed || (used < notice * tokens && calls < notice * toolCalls)) return null;
      noticed = true;
      return { tokens_left: Math.max(0, tokens - used), calls_left: Math.max(0, toolCalls - calls) };
    },
    snapshot: () => ({ tokens_used: used, tokens: tokens, tool_calls_used: calls, tool_calls: toolCalls, notice_given: noticed }),
  };
}

const round = n => n >= 10000 ? Math.round(n / 1000).toLocaleString('en-US') + ',000' : n.toLocaleString('en-US');

export function noticeText({ tokens_left, calls_left }) {
  return '[harness] Budget notice: about ' + round(tokens_left) + ' tokens and ' + calls_left + ' tool calls are left. Write output/model.glb now.';
}
