// Event-stream parsers. Each harness prints one JSON object per line; these
// reduce a stream to the accounting a result record needs. Nothing here trusts
// what the model says about itself: counts come from tool events, usage from
// the CLI's own usage records, and an absent record stays null (never 0).

const zeroUsage = () => ({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 });

// Codex `exec --json` (checked against codex-cli 0.159.2):
//   thread.started{thread_id}  turn.started  turn.completed{usage}  turn.failed{error}
//   item.started|item.updated|item.completed{item}  error{message}
// item.type: agent_message, reasoning, command_execution{command, aggregated_output,
// exit_code, status}, file_change{changes, status}, mcp_tool_call, web_search,
// todo_list, collab_tool_call, error. view_image calls are not reported as items.
// Codex usage follows the Responses API: input_tokens includes the cached part,
// output_tokens includes reasoning_output_tokens.
export function parseCodexEvents(events) {
  const usage = zeroUsage(), detail = { reasoning_output_tokens: 0, cache_write_input_tokens: 0 };
  const tools = {}, errors = [], commandLines = [];
  let completedTurns = 0, failedTurns = 0, commands = 0, fileChanges = 0, finalMessage = null, threadId = null, sawUsage = false;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'thread.started') threadId = event.thread_id ?? null;
    else if (event.type === 'turn.completed') {
      completedTurns++;
      if (event.usage && typeof event.usage === 'object') {
        sawUsage = true;
        for (const key of Object.keys(usage)) usage[key] += Number(event.usage[key]) || 0;
        for (const key of Object.keys(detail)) detail[key] += Number(event.usage[key]) || 0;
      }
    } else if (event.type === 'turn.failed') { failedTurns++; errors.push(event.error?.message ?? JSON.stringify(event.error ?? event)); }
    else if (event.type === 'error') errors.push(event.message ?? JSON.stringify(event));
    else if (event.type === 'item.completed' && event.item) {
      const item = event.item;
      tools[item.type] = (tools[item.type] ?? 0) + 1;
      if (item.type === 'command_execution') { commands++; commandLines.push(item.command); }
      else if (item.type === 'file_change') fileChanges++;
      else if (item.type === 'agent_message' && typeof item.text === 'string') finalMessage = item.text;
      else if (item.type === 'error') errors.push(item.message ?? JSON.stringify(item));
    }
  }
  return {
    harness: 'codex', thread_id: threadId, turns: completedTurns, failed_turns: failedTurns, commands, file_changes: fileChanges,
    usage: sawUsage ? usage : null, usage_detail: sawUsage ? detail : null, cost_usd: null, tools, errors,
    final_message: finalMessage, model_reported: null,
    // Codex exec ends a successful run with turn.completed and no turn.failed.
    completed: completedTurns > 0 && failedTurns === 0,
  };
}

// The tool call types a Codex contestant may produce. Anything else (MCP,
// web search, sub-agents) means the boundary configuration did not hold.
export const CODEX_ALLOWED_ITEMS = new Set(['agent_message', 'reasoning', 'command_execution', 'file_change', 'todo_list', 'error']);

// Claude Code `-p --output-format stream-json --verbose` (checked against 2.1.285):
//   system{subtype:init, tools, mcp_servers, model, plugins, permissionMode, ...}
//   assistant{message{content:[text|thinking|tool_use{name,input}]}}
//   user{message{content:[tool_result{tool_use_id, is_error, content}]}}
//   result{subtype, is_error, num_turns, total_cost_usd, usage, modelUsage, permission_denials}
// Anthropic usage reports cache reads and cache writes apart from input_tokens;
// they are folded in so input_tokens means "all prompt tokens" as for Codex.
export function parseClaudeEvents(events) {
  const tools = {}, errors = [];
  let init = null, result = null, commands = 0, assistantMessages = 0, finalMessage = null, denials = 0;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'system' && event.subtype === 'init') init = event;
    else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      assistantMessages++;
      if (event.error) errors.push(String(event.error));
      for (const block of event.message.content) {
        if (block.type === 'tool_use') {
          tools[block.name] = (tools[block.name] ?? 0) + 1;
          if (block.name === 'Bash') commands++;
        } else if (block.type === 'text' && block.text) finalMessage = block.text;
      }
    } else if (event.type === 'result') result = event;
  }
  let usage = null, usageDetail = null;
  if (result?.usage && typeof result.usage === 'object') {
    const u = result.usage, n = key => Number(u[key]) || 0;
    usage = {
      input_tokens: n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens'),
      cached_input_tokens: n('cache_read_input_tokens'),
      output_tokens: n('output_tokens'),
    };
    usageDetail = { uncached_input_tokens: n('input_tokens'), cache_creation_input_tokens: n('cache_creation_input_tokens'),
      cache_read_input_tokens: n('cache_read_input_tokens'), output_tokens: n('output_tokens') };
  }
  if (result?.is_error) errors.push(String(result.result ?? result.subtype ?? 'error result'));
  if (Array.isArray(result?.permission_denials)) denials = result.permission_denials.length;
  const cost = Number(result?.total_cost_usd);
  return {
    harness: 'claude-code', session_id: init?.session_id ?? result?.session_id ?? null,
    turns: Number.isInteger(result?.num_turns) ? result.num_turns : assistantMessages,
    commands, usage, usage_detail: usageDetail,
    // The CLI's own list-price estimate; on a subscription login it is not a charge.
    cost_usd: result && Number.isFinite(cost) ? cost : null,
    tools, errors, permission_denials: denials,
    final_message: typeof result?.result === 'string' ? result.result : finalMessage,
    model_reported: init?.model ?? null,
    init: init ? { tools: init.tools ?? null, mcp_servers: init.mcp_servers ?? null, plugins: (init.plugins ?? []).map(p => p.name),
      permission_mode: init.permissionMode ?? null, api_key_source: init.apiKeySource ?? null, version: init.claude_code_version ?? null } : null,
    completed: Boolean(result) && result.is_error !== true && result.subtype === 'success',
  };
}

export const CLAUDE_TOOLS = ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write'];
// Built-in plugins that load even in safe mode; they add no tools (checked via
// the init event, which lists the tool set after plugins have registered).
export const CLAUDE_BUILTIN_PLUGINS = ['cc-plugin-agents-md', 'cc-plugin-telemetry'];

// Problems with the tool surface a finished session actually used or was given.
export function toolSurfaceProblems(system, summary) {
  const problems = [];
  if (system === 'codex') {
    for (const type of Object.keys(summary.tools ?? {})) if (!CODEX_ALLOWED_ITEMS.has(type)) problems.push('codex produced a ' + type + ' item');
  } else {
    for (const name of Object.keys(summary.tools ?? {})) if (!CLAUDE_TOOLS.includes(name)) problems.push('claude used tool ' + name);
    const init = summary.init;
    if (init) {
      const extra = (init.tools ?? []).filter(name => !CLAUDE_TOOLS.includes(name));
      if (extra.length) problems.push('claude was given tools ' + extra.join(', '));
      if ((init.mcp_servers ?? []).length) problems.push('claude connected MCP servers');
      const plugins = (init.plugins ?? []).filter(name => !CLAUDE_BUILTIN_PLUGINS.includes(name));
      if (plugins.length) problems.push('claude loaded plugins ' + plugins.join(', '));
      if (init.api_key_source && init.api_key_source !== 'none') problems.push('claude authenticated with an API key (' + init.api_key_source + ')');
    }
  }
  return problems;
}

export function parseEvents(system, events) {
  if (system === 'codex') return parseCodexEvents(events);
  if (system === 'claude-code') return parseClaudeEvents(events);
  throw new Error('Unknown system ' + system);
}

export function readJSONLines(text) {
  const events = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
  return events;
}
