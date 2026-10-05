import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, lstat, readdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { modelToGLB } from '../lib/model.mjs';
import { sampleModel } from '../fixtures/sample-model.mjs';
import { prepare, preflight, execute, manifestHash, attemptInvocation } from '../lib/runner/index.mjs';
import { makeDataRoot, fakeInstallTools, fakeScorer } from '../lib/runner/api/mock/fixtures.mjs';
import { ADAPTERS, grok, GROK_ENV, GROK_EFFORTS, GROK_PROFILE, GROK_DISALLOWED_TOOLS, GROK_HOME_DENY, grokSandboxProfile } from '../lib/runner/adapters.mjs';
import { parseGrokEvents, parseEvents, toolSurfaceProblems, GROK_TOOLS } from '../lib/runner/events.mjs';
import { detectInfra, grokReason, INFRA_REASONS } from '../lib/runner/infra.mjs';
import { buildPrompt, TOOL_DESCRIPTIONS } from '../lib/runner/prompt.mjs';
import { buildProbeSite, snapshot, evaluateGrokAgent, agentProbePrompt, grokResult, grokContextCheck, PROBE_COLOURS } from '../lib/runner/preflight.mjs';
import { extractProbeOutput } from '../lib/runner/probes.mjs';
import { BASE_PATH, CREDENTIAL_NAME } from '../lib/runner/process.mjs';
import { textSource } from '../lib/runner/hostsleep.mjs';

// The grok system (Grok Build CLI 1.0.46): its event stream, infrastructure
// errors, invocation, sandbox profile, staging, inspect, execution and
// preflight. The real CLI is never started here: two fake `grok` binaries
// stand in for it (a /bin/sh one for execution, whose timing must be tight,
// and a Node one that carries out preflight's tool calls), and every Grok
// shape below was captured from the real CLI unless marked otherwise.

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'e3d-grok-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------- captured streams

// The agent session of the live preflight of probe-grok-1 (grok-4.6, effort
// low, 2026-10-05), every event as the CLI printed it, anonymised: the probe
// site's path is {site}, the home directory {home}, ids, uuids and thinking
// signatures are replaced, long file contents are cut, and a tool result's
// JSON text is shown as the object it encodes. Filled in by liveEvents():
// {canary}, {control} (the control image's colour), {control_png}, and the
// shell result's raw output bytes. It ran before ~/.grok/bundled was denied,
// so its init lists Grok's 19 bundled skills.
const LIVE_PREFLIGHT = String.raw`
{"type":"system","subtype":"init","session_id":"session-1","apiKeySource":"oauth","model":"grok-4.6","cwd":"{site}/workspace","permissionMode":"bypassPermissions","tools":["run_terminal_command","read_file","search_replace","list_dir","grep","write"],"slash_commands":["compact","always-approve","context","session-info","feedback","goal","build-with-ai","code-review","create-skill","create-workflow","design","execute-plan","game-assets","bundled:imagine","implement","learn","long-running-background-tasks","pr-babysit","resume-claude","resume-codex","resume-cursor","review","skill-design-principles","statusline","threejs-frame-conventions"],"mcp_servers":[],"skills":["build-with-ai","code-review","create-skill","create-workflow","design","execute-plan","game-assets","bundled:imagine","implement","learn","long-running-background-tasks","pr-babysit","resume-claude","resume-codex","resume-cursor","review","skill-design-principles","statusline","threejs-frame-conventions"]}
{"type":"assistant","message":{"id":"msg_0","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"thinking","thinking":"I will execute the requested tool calls in order.","signature":"sig"},{"type":"text","text":"Running the listed tool calls in order, starting with the probe script."},{"type":"tool_use","id":"call-0","name":"run_terminal_command","input":{"command":"node .e3d-probe/probe.mjs","description":"Run isolation probe script"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":5818,"output_tokens":207,"cache_read_input_tokens":512,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-0","content":{"type":"Bash","output":"{probe_bytes}","output_for_prompt":"{probe_wrapped}","exit_code":0,"command":"node .e3d-probe/probe.mjs","truncated":false,"signal":null,"timed_out":false,"description":"Run isolation probe script","current_dir":"{site}/workspace","output_file":"{home}/.grok/sessions/{site_enc}%2Fworkspace/session-1/terminal/call-0.log","total_bytes":"{probe_length}"},"is_error":false}]}}
{"type":"assistant","message":{"id":"msg_1","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"thinking","thinking":"Proceeding with the next tool calls in order.","signature":"sig"},{"type":"tool_use","id":"call-1","name":"read_file","input":{"target_file":"{site}/secret/canary.txt"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":7273,"output_tokens":136,"cache_read_input_tokens":640,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-1","content":{"type":"ReadFile","PermissionDenied":"Permission denied: {site}/secret/canary.txt"},"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_2","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-2","name":"read_file","input":{"target_file":".e3d-probe/link-file"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":306,"output_tokens":25,"cache_read_input_tokens":7808,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-2","content":{"type":"ReadFile","PermissionDenied":"Permission denied: {site}/workspace/.e3d-probe/link-file"},"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_3","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-3","name":"read_file","input":{"target_file":".e3d-probe/link-dir/canary.txt"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":146,"output_tokens":29,"cache_read_input_tokens":8064,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-3","content":{"type":"ReadFile","PermissionDenied":"Permission denied: {site}/workspace/.e3d-probe/link-dir/canary.txt"},"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_4","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-4","name":"read_file","input":{"target_file":".e3d-probe/dangling-agent"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":122,"output_tokens":25,"cache_read_input_tokens":8192,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-4","content":{"type":"ReadFile","FileNotFound":"Error: {site}/workspace/.e3d-probe/dangling-agent does not exist.\nNote: your current working directory is {site}/workspace"},"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_5","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-5","name":"read_file","input":{"target_file":"input/task.json"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":278,"output_tokens":19,"cache_read_input_tokens":8192,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-5","content":{"type":"ReadFile","FileContent":{"content":"1→{\n  \"schema\": \"e3d-task-v1\",\n  \"id\": \"house-0011-t2\",\n  \"title\": \"Two-and-a-half-storey detached house with a hipped r…","content_concise":"1→{\n  \"schema\": \"e3d-task-v1\",\n  \"id\": \"house-0011-t2\",\n  \"title\": \"Two-and-a-half-storey detached house with a hipped r…","absolute_path":"{site}/workspace/input/task.json","offset":null,"raw_output":"{\n  \"schema\": \"e3d-task-v1\",\n  \"id\": \"house-0011-t2\",\n  \"title\": \"Two-and-a-half-storey detached house with a hipped roo…","total_lines":79}},"is_error":false}]}}
{"type":"assistant","message":{"id":"msg_6","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-6","name":"grep","input":{"pattern":"{canary}","path":"{site}/secret"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":1610,"output_tokens":84,"cache_read_input_tokens":8448,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-6","content":{"type":"GrepSearch","stdout":"Error calling tool: rg: {site}/secret: IO error for operation on {site}/secret: Operation not permitted (os error 1)\n (exit 2, root: {site}/workspace)","stderr":"rg: {site}/secret: IO error for operation on {site}/secret: Operation not permitted (os error 1)\n","exit_code":2,"match_count":0,"file_matches":[]},"is_error":false}]}}
{"type":"assistant","message":{"id":"msg_7","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-7","name":"grep","input":{"pattern":"{canary}","path":"."}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":346,"output_tokens":35,"cache_read_input_tokens":9984,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-7","content":{"type":"GrepSearch","stdout":"<workspace_result workspace_path=\"{site}/workspace\">\nNo matches found\n</workspace_result>","stderr":"","exit_code":1,"match_count":0,"file_matches":[]},"is_error":false}]}}
{"type":"assistant","message":{"id":"msg_8","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-8","name":"list_dir","input":{"target_directory":"{site}/secret"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":201,"output_tokens":65,"cache_read_input_tokens":10240,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-8","content":{"type":"ListDir","PermissionDenied":"Permission denied: {site}/secret"},"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_9","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-9","name":"list_dir","input":{"target_directory":".e3d-probe/link-dir"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":199,"output_tokens":25,"cache_read_input_tokens":10368,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-9","content":{"type":"ListDir","PermissionDenied":"Permission denied: {site}/workspace/.e3d-probe/link-dir"},"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_10","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-10","name":"write","input":{"file_path":"output/.agent-write.txt","content":"ok"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":167,"output_tokens":23,"cache_read_input_tokens":10496,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-10","content":{"type":"SearchReplace","EditsApplied":{"old_string":"","new_string":"ok","tool_output_for_prompt":"The file {site}/workspace/output/.agent-write.txt has been created.","tool_output_for_prompt_concise":"The file {site}/workspace/output/.agent-write.txt has been created.","absolute_path":"{site}/workspace/output/.agent-write.txt","edits":{"details":[{"old_string":"","old_line":1,"new_string":"ok","new_line":1,"context_before":"","context_after":"","line_prefix":""}]}}},"is_error":false}]}}
{"type":"assistant","message":{"id":"msg_11","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-11","name":"write","input":{"file_path":"input/.agent-write.txt","content":"x"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":133,"output_tokens":23,"cache_read_input_tokens":10624,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-11","content":{"type":"SearchReplace","EditsApplied":{"old_string":"","new_string":"x","tool_output_for_prompt":"The file {site}/workspace/input/.agent-write.txt has been created.","tool_output_for_prompt_concise":"The file {site}/workspace/input/.agent-write.txt has been created.","absolute_path":"{site}/workspace/input/.agent-write.txt","edits":{"details":[{"old_string":"","old_line":1,"new_string":"x","new_line":1,"context_before":"","context_after":"","line_prefix":""}]}}},"is_error":false}]}}
{"type":"assistant","message":{"id":"msg_12","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-12","name":"write","input":{"file_path":"{site}/secret/agent-written.txt","content":"x"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":99,"output_tokens":72,"cache_read_input_tokens":10752,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-12","content":{"error":"tool_execution_failed","message":"IO Error: File exists (os error 17)"},"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_13","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-13","name":"write","input":{"file_path":".e3d-probe/link-out","content":"PATCHED"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":196,"output_tokens":34,"cache_read_input_tokens":10752,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-13","content":{"error":"tool_execution_failed","message":"IO Error: Operation not permitted (os error 1)"},"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_14","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-14","name":"write","input":{"file_path":".e3d-probe/dangling-agent","content":"x"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":128,"output_tokens":27,"cache_read_input_tokens":10880,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-14","content":{"error":"tool_execution_failed","message":"IO Error: Operation not permitted (os error 1)"},"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_15","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-15","name":"write","input":{"file_path":".e3d-probe/link-dir/agent-new.txt","content":"x"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":53,"output_tokens":32,"cache_read_input_tokens":11008,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-15","content":{"error":"tool_execution_failed","message":"IO Error: File exists (os error 17)"},"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_16","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-16","name":"search_replace","input":{"file_path":"output/.agent-write.txt","old_string":"ok","new_string":"okay"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":110,"output_tokens":33,"cache_read_input_tokens":11008,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-16","content":{"type":"SearchReplace","EditsApplied":{"old_string":"ok","new_string":"okay","tool_output_for_prompt":"The file output/.agent-write.txt has been updated successfully.","tool_output_for_prompt_concise":"The file output/.agent-write.txt has been updated.","absolute_path":"{site}/workspace/output/.agent-write.txt","edits":{"details":[{"old_string":"ok","old_line":1,"new_string":"okay","new_line":1,"context_before":"","context_after":"","line_prefix":""}]}}},"is_error":false}]}}
{"type":"assistant","message":{"id":"msg_17","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-17","name":"read_file","input":{"target_file":"{site}/secret/canary.png"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":164,"output_tokens":69,"cache_read_input_tokens":11008,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-17","content":{"type":"ReadFile","PermissionDenied":"Permission denied: {site}/secret/canary.png"},"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_18","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-18","name":"read_file","input":{"target_file":".e3d-probe/link-image.png"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":170,"output_tokens":26,"cache_read_input_tokens":11136,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-18","content":{"type":"ReadFile","PermissionDenied":"Permission denied: {site}/workspace/.e3d-probe/link-image.png"},"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_19","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-19","name":"read_file","input":{"target_file":".e3d-probe/control.png"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":140,"output_tokens":32,"cache_read_input_tokens":11264,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-19","content":{"type":"ReadFile","ImageContent":{"data":"{control_png}","mime_type":"image/png"}},"is_error":false}]}}
{"type":"assistant","message":{"id":"msg_20","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"text","text":"{control}"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":107,"output_tokens":16,"cache_read_input_tokens":11392,"cache_creation_input_tokens":0}}}
{"type":"result","subtype":"success","is_error":false,"duration_ms":42449,"duration_api_ms":39535,"num_turns":21,"result":"{control}","stop_reason":"end_turn","total_cost_usd":0.04696692,"usage":{"input_tokens":17766,"output_tokens":1037,"cache_read_input_tokens":192768,"cache_creation_input_tokens":0,"server_tool_use":{"web_search_requests":0}},"modelUsage":{"grok-4.6-build":{"inputTokens":17766,"outputTokens":1037,"cacheReadInputTokens":192768,"cacheCreationInputTokens":0,"webSearchRequests":0,"costUSD":0.04696692}},"session_id":"session-1"}
`;

// Grok wraps long lines in the copy of a shell's output it shows the model
// (output_for_prompt, about every 2000 characters); `output` keeps the raw bytes.
const wrap = (text, width) => text.replace(new RegExp('(.{' + width + '})', 'g'), '$1\n');

function liveEvents({ site, home = '/home/u', canary, control, controlPng, probe }) {
  const text = LIVE_PREFLIGHT.replaceAll('{site_enc}', encodeURIComponent(site)).replaceAll('{site}', site).replaceAll('{home}', home)
    .replaceAll('{canary}', canary).replaceAll('{control}', control);
  return text.trim().split('\n').map(line => JSON.parse(line)).map(event => {
    for (const block of event.type === 'user' ? event.message.content : []) {
      const content = block.content;
      if (content.type === 'Bash') Object.assign(content, { output: [...Buffer.from(probe)], output_for_prompt: 'exit: 0\n' + wrap(probe, 2000), total_bytes: Buffer.byteLength(probe) });
      if (content.type === 'GrepSearch') for (const key of ['stdout', 'stderr']) content[key] = [...Buffer.from(content[key])];
      if (content.ImageContent) content.ImageContent.data = controlPng.toString('base64');
      block.content = JSON.stringify(content); // the CLI sends every tool result as a JSON text
    }
    return event;
  });
}

// An unknown model id (live, 2026-10-05; captured before the compatibility
// switches were set, so the user's MCP servers, here renamed, were pending).
const UNKNOWN_MODEL_EVENTS = String.raw`
{"type":"system","subtype":"init","session_id":"session-0","apiKeySource":"oauth","model":"no-such-model-e3d","cwd":"/ws","permissionMode":"bypassPermissions","tools":[],"slash_commands":[],"mcp_servers":[{"name":"user-mcp-1","status":"pending"},{"name":"user-mcp-2","status":"connected"}],"skills":[]}
{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":0,"duration_api_ms":0,"num_turns":0,"stop_reason":null,"total_cost_usd":0.0,"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"server_tool_use":{"web_search_requests":0}},"modelUsage":{},"errors":["Couldn't set model 'no-such-model-e3d': Invalid params: \"unknown model id\". Run 'grok models' to see available models."],"session_id":"session-0"}
`.trim().split('\n').map(line => JSON.parse(line));
const UNKNOWN_MODEL_STDERR = 'Error: Couldn\'t set model \'no-such-model-e3d\': Invalid params: "unknown model id". Run \'grok models\' to see available models.\n';

// `grok models` (live, shortened: the user's proxy models are left out but one).
const MODELS_TEXT = 'You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n  - grok-4.5\n  - ocx-kimi-k3\n';

// A small session in the same shapes, for the execution tests.
const INIT = { type: 'system', subtype: 'init', session_id: 'session-2', apiKeySource: 'oauth', model: 'grok-4.6', cwd: '/ws', permissionMode: 'bypassPermissions',
  tools: GROK_TOOLS, slash_commands: ['compact'], mcp_servers: [], skills: [] };
const USAGE = { input_tokens: 300, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };
const call = (id, name, input) => ({ type: 'assistant', message: { id: 'msg_' + id, type: 'message', role: 'assistant', model: 'grok-4.6',
  content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', stop_sequence: null, usage: USAGE } });
const answer = (id, content, isError = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(content), is_error: isError }] } });
const WORK = [INIT, call('c0', 'read_file', { target_file: 'input/task.json' }), answer('c0', { type: 'ReadFile', FileContent: { content: '1→{}' } }),
  call('c1', 'run_terminal_command', { command: 'node build.mjs' }), answer('c1', { type: 'Bash', output: [...Buffer.from('ok\n')], output_for_prompt: 'exit: 0\nok\n', exit_code: 0 })];
const SESSION = [...WORK, { type: 'assistant', message: { id: 'msg_end', type: 'message', role: 'assistant', model: 'grok-4.6', content: [{ type: 'text', text: 'Built the house.' }], stop_reason: 'end_turn', usage: USAGE } },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'Built the house.', total_cost_usd: 0.0123,
    usage: { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
    modelUsage: { 'grok-4.6-build': { inputTokens: 900, outputTokens: 300, cacheReadInputTokens: 3000, cacheCreationInputTokens: 0, costUSD: 0.0123 } }, session_id: 'session-2' }];
// The shape an error result takes (live for an unknown model; the texts below are inferred).
const failedWith = (text, turns) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: turns, stop_reason: null, total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {}, errors: [text], session_id: 'session-2' });

// ---------------------------------------------------------------- fakes

// A home directory with the parts of ~/.grok the adapter looks at: the model
// catalogue (as Grok caches it) and directories the sandbox profile denies.
async function fakeHome(dir) {
  const home = join(dir, 'home'), grokDir = join(home, '.grok');
  for (const sub of ['memory-v2', 'logs', 'bundled/skills/threejs-frame-conventions', 'sessions']) await mkdir(join(grokDir, sub), { recursive: true });
  const efforts = ['xhigh', 'high', 'medium', 'low'].map(value => ({ id: value, value, label: value, default: value === 'high' }));
  await writeFile(join(grokDir, 'models_cache.json'), JSON.stringify({ grok_version: '1.0.46', models: {
    'grok-4.7': { info: { model: 'grok-4.7', reasoning_effort: 'high', supports_reasoning_effort: true, reasoning_efforts: efforts } },
    'grok-4.6': { info: { model: 'grok-4.6', reasoning_effort: 'high', supports_reasoning_effort: true, reasoning_efforts: efforts } } } }));
  await writeFile(join(grokDir, 'auth.json'), '{"note":"fake login file of a test home"}\n');
  return home;
}

// The adapters read os.homedir(), which follows HOME.
async function withHome(home, fn) {
  const saved = process.env.HOME;
  process.env.HOME = home;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; }
}

// A fake `grok` as a /bin/sh script (it starts in milliseconds under any
// load, so what it prints is there before a short deadline). Like the real
// CLI it refuses to start unless the profile named by --sandbox is in
// <cwd>/.grok/sandbox.toml and the prompt file is there. `sequence` gives its
// behaviour by call number (the last one repeats): events, stderr, artifact
// 'glb', sleep, exit. `record` keeps what each call found at launch.
async function shellGrok(dir, name, { models = MODELS_TEXT, modelsExit = 0, record = null, sequence = [{}] } = {}) {
  const path = join(dir, name), q = text => "'" + String(text).replaceAll("'", "'\\''") + "'", counter = q(join(dir, name + '.calls'));
  const lines = ['#!/bin/sh',
    'case "$1" in --version) echo ' + q('grok 1.0.46 (fake)') + '; exit 0;; models) printf %s ' + q(models) + '; exit ' + modelsExit + ';; esac',
    'ws=; pf=; sb=',
    'while [ $# -gt 0 ]; do case "$1" in --cwd) ws=$2; shift;; --prompt-file) pf=$2; shift;; --sandbox) sb=$2; shift;; esac; shift; done',
    'cat > /dev/null',
    'grep -qx "\\[profiles\\.$sb\\]" "$ws/.grok/sandbox.toml" 2>/dev/null || { echo "Error: Custom sandbox profile $sb not found. Refusing to start with its protections missing." >&2; exit 1; }',
    '[ -f "$pf" ] || { echo "Error: could not read $pf" >&2; exit 1; }',
    'n=$(cat ' + counter + ' 2>/dev/null || echo 0); echo $((n + 1)) > ' + counter];
  if (record) {
    const r = q(record);
    lines.push('cp "$ws/.grok/sandbox.toml" ' + r + '/profile-$n.toml; cp "$pf" ' + r + '/prompt-$n.txt; echo "$ws" > ' + r + '/ws-$n.txt; env | cut -d= -f1 | sort > ' + r + '/env-$n.txt');
  }
  lines.push('case $n in');
  sequence.forEach((step, i) => {
    const body = [];
    if (step.artifact === 'glb') body.push('cp ' + q(join(dir, 'sample.glb')) + ' "$ws/output/model.glb"');
    for (const event of step.events ?? []) body.push('printf "%s\\n" ' + q(JSON.stringify(event)));
    if (step.stderr) body.push('printf %s ' + q(step.stderr) + ' >&2');
    body.push('sleep ' + (step.sleep ?? 0), 'exit ' + (step.exit ?? 0));
    lines.push('  ' + (i === sequence.length - 1 ? '*' : i) + ') ' + body.join('; ') + ';;');
  });
  lines.push('esac');
  await writeFile(path, lines.join('\n') + '\n');
  await chmod(path, 0o755);
  return path;
}
const calls = async (dir, name = 'grok') => Number(await readFile(join(dir, name + '.calls'), 'utf8').catch(() => '0'));

// A fake `grok` that carries out preflight's agent prompt with real file
// operations and prints Grok's event shapes (the ListDir success shape is its
// own; Grok refused every listing in the live run). confine: false, nothing
// is refused; true, the file tools refuse whatever resolves outside the
// workspace and writes into input/, tools/ and node_modules/, and the shell
// refuses to run at all (so nothing it does can be mistaken for a file tool).
// Serialised with Function.prototype.toString into the fake's own script.
function fakeGrokAgent(confine, COLOURS, MODELS) {
  const fs = require('fs'), path = require('path'), zlib = require('zlib'), { spawnSync } = require('child_process');
  const args = process.argv.slice(2), at = flag => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  if (args[0] === '--version') { process.stdout.write('grok 1.0.46 (fake)\n'); return; }
  if (args[0] === 'models') { process.stdout.write(MODELS); return; }
  try { fs.readFileSync(0); } catch {}
  const ws = at('--cwd'), profile = path.join(ws, '.grok', 'sandbox.toml');
  if (!fs.existsSync(profile) || !fs.readFileSync(profile, 'utf8').includes('[profiles.' + at('--sandbox') + ']')) {
    process.stderr.write('Error: Custom sandbox profile ' + at('--sandbox') + ' not found. Refusing to start with its protections missing.\n');
    process.exitCode = 1;
    return;
  }
  const prompt = fs.readFileSync(at('--prompt-file'), 'utf8'), model = at('-m');
  const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
  const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  emit({ type: 'system', subtype: 'init', session_id: 'fake-session', apiKeySource: 'oauth', model, cwd: ws, permissionMode: at('--permission-mode'),
    tools: at('--tools').split(','), slash_commands: ['compact'], mcp_servers: [], skills: [] });
  // Grok's record of the session's context (the unconfined fake loaded the AGENTS.md planted beside the workspace).
  const record = path.join(process.env.HOME, '.grok', 'sessions', encodeURIComponent(ws), 'fake-session');
  fs.mkdirSync(record, { recursive: true });
  fs.writeFileSync(path.join(record, 'prompt_context.json'), JSON.stringify({ version: 1, prompt_mode: 'extend', include_browser_verification: true,
    agents_md_files: confine ? [] : [path.join(path.dirname(ws), 'AGENTS.md')], persona_summaries: [], memory_enabled: false, memory_v2_enabled: false, is_non_interactive: true }));
  const root = fs.realpathSync(ws);
  // Where a path really leads, symlinks (dangling ones too) followed.
  const resolved = target => {
    let full = path.resolve(ws, target);
    for (let hops = 0; hops < 20; hops++) {
      let info;
      try { info = fs.lstatSync(full); } catch { break; }
      if (!info.isSymbolicLink()) break;
      full = path.resolve(path.dirname(full), fs.readlinkSync(full));
    }
    try { return path.join(fs.realpathSync(path.dirname(full)), path.basename(full)); } catch { return full; }
  };
  const under = (target, sub) => { const real = resolved(target), base = path.join(root, sub); return real === base || real.startsWith(base + path.sep); };
  const refused = target => confine && !under(target, '');
  const unwritable = target => confine && (!under(target, '') || ['input', 'tools', 'node_modules'].some(sub => under(target, sub)));
  const colourOf = bytes => {
    const parts = [];
    for (let pos = 8; pos < bytes.length;) {
      const length = bytes.readUInt32BE(pos);
      if (bytes.toString('latin1', pos + 4, pos + 8) === 'IDAT') parts.push(bytes.subarray(pos + 8, pos + 8 + length));
      pos += 12 + length;
    }
    const raw = zlib.inflateSync(Buffer.concat(parts)), rgb = [raw[1], raw[2], raw[3]];
    let best = null, distance = Infinity;
    for (const [name, colour] of Object.entries(COLOURS)) {
      const d = colour.reduce((sum, value, i) => sum + (value - rgb[i]) ** 2, 0);
      if (d < distance) { distance = d; best = name; }
    }
    return best;
  };
  // As ripgrep does by default: hidden entries (.grok, .e3d-probe) are skipped, links not followed.
  const files = dir => fs.readdirSync(dir).filter(name => !name.startsWith(".")).flatMap(name => {
    const full = path.join(dir, name), info = fs.lstatSync(full);
    return info.isDirectory() ? files(full) : info.isFile() ? [full] : [];
  });
  let n = 0, said = 'nothing';
  for (const [, tool, rest] of prompt.matchAll(/^\d+\. (\w+): (.*)$/gm)) {
    const id = 'call-' + n++;
    let input, content, isError = false;
    if (tool === 'run_terminal_command') {
      input = { command: rest, description: 'probe' };
      if (confine) content = { type: 'Bash', output: [...Buffer.from('sandbox: node: Operation not permitted\n')], output_for_prompt: 'exit: 126\nsandbox: node: Operation not permitted\n', exit_code: 126 };
      else {
        const run = spawnSync('/bin/sh', ['-c', rest], { cwd: ws }), bytes = Buffer.concat([run.stdout, run.stderr]);
        // Grok wraps at about 2000 characters; this fake wraps at 500, so a probe report is always cut.
        content = { type: 'Bash', output: [...bytes], output_for_prompt: 'exit: ' + run.status + '\n' + bytes.toString('utf8').replace(/(.{500})/g, '$1\n'), exit_code: run.status, command: rest };
      }
    } else if (tool === 'read_file') {
      const target = /^target_file (\S+)/.exec(rest)[1], full = path.resolve(ws, target);
      input = { target_file: target };
      if (refused(target)) { content = { type: 'ReadFile', PermissionDenied: 'Permission denied: ' + full }; isError = true; }
      else if (!fs.existsSync(full)) { content = { type: 'ReadFile', FileNotFound: 'Error: ' + full + ' does not exist.' }; isError = true; }
      else if (full.endsWith('.png')) {
        const bytes = fs.readFileSync(full);
        content = { type: 'ReadFile', ImageContent: { data: bytes.toString('base64'), mime_type: 'image/png' } };
        said = colourOf(bytes);
      } else { const text = fs.readFileSync(full, 'utf8'); content = { type: 'ReadFile', FileContent: { content: text, raw_output: text, absolute_path: full } }; }
    } else if (tool === 'grep') {
      const [, pattern, target] = /^pattern (\S+), path (\S+)/.exec(rest), full = path.resolve(ws, target);
      input = { pattern, path: target };
      if (refused(target)) content = { type: 'GrepSearch', stdout: [...Buffer.from('Error calling tool: rg: ' + full + ': Operation not permitted (os error 1)')], stderr: [], exit_code: 2, match_count: 0, file_matches: [] };
      else {
        const hits = files(full).filter(file => fs.readFileSync(file, 'latin1').includes(pattern));
        content = { type: 'GrepSearch', stdout: [...Buffer.from(hits.map(file => file + ':1:' + pattern).join('\n') || 'No matches found')], stderr: [], exit_code: hits.length ? 0 : 1, match_count: hits.length };
      }
    } else if (tool === 'list_dir') {
      const target = /^target_directory (\S+)/.exec(rest)[1], full = path.resolve(ws, target);
      input = { target_directory: target };
      if (refused(target)) { content = { type: 'ListDir', PermissionDenied: 'Permission denied: ' + full }; isError = true; }
      else content = { type: 'ListDir', entries: fs.readdirSync(full) };
    } else {
      const match = tool === 'write' ? /^file_path (\S+), content (.*)$/.exec(rest) : /^file_path (\S+), old_string (\S+), new_string (\S+)$/.exec(rest);
      const target = match[1], full = path.resolve(ws, target);
      input = tool === 'write' ? { file_path: target, content: match[2] } : { file_path: target, old_string: match[2], new_string: match[3] };
      if (unwritable(target)) { content = { error: 'tool_execution_failed', message: 'IO Error: Operation not permitted (os error 1)' }; isError = true; }
      else {
        fs.writeFileSync(full, tool === 'write' ? match[2] : fs.readFileSync(full, 'utf8').replace(match[2], match[3]));
        content = { type: 'SearchReplace', EditsApplied: { old_string: tool === 'write' ? '' : match[2], new_string: tool === 'write' ? match[2] : match[3], absolute_path: full } };
      }
    }
    emit({ type: 'assistant', message: { id: 'msg_' + n, type: 'message', role: 'assistant', model, content: [{ type: 'tool_use', id, name: tool, input }], stop_reason: 'tool_use', usage } });
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(content), is_error: isError }] } });
  }
  emit({ type: 'assistant', message: { id: 'msg_end', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: said }], stop_reason: 'end_turn', usage } });
  emit({ type: 'result', subtype: 'success', is_error: false, num_turns: n + 1, result: said, total_cost_usd: 0.001, usage: { ...usage, input_tokens: 100 * (n + 1) },
    modelUsage: { [model + '-build']: { inputTokens: 100 * (n + 1), outputTokens: 10 } }, session_id: 'fake-session' });
}

async function agentGrok(dir, { confine }) {
  const path = join(dir, 'grok-agent');
  await writeFile(path, '#!' + process.execPath + '\n(' + fakeGrokAgent.toString() + ')(' + JSON.stringify(confine) + ', ' + JSON.stringify(PROBE_COLOURS) + ', ' + JSON.stringify(MODELS_TEXT) + ');\n');
  await chmod(path, 0o755);
  return path;
}

const FAST = { limitStepsMs: [300, 600], retryStepsMs: [100, 200], resetJitterMs: [0, 50], backoffJitter: 0.1, minimumWaitMs: 0, resumeSpacingMs: 100 };

// prepare() for grok with the real inspect against the shell fake, under a
// fake home; the preflight verdict is written as preflight would bind it.
async function grokBatch(t, { sequence, tasks = ['house-a-t1'], wall, id = 'grok-1' } = {}) {
  const dir = await scratch(t), dataRoot = join(dir, 'data'), home = await fakeHome(dir), record = join(dir, 'record');
  await mkdir(record);
  await makeDataRoot(dataRoot, tasks, { wall });
  await writeFile(join(dir, 'sample.glb'), modelToGLB(sampleModel()));
  const binary = await shellGrok(dir, 'grok', { record, sequence });
  const scorer = join(dir, 'scorer.mjs');
  await writeFile(scorer, fakeScorer(join(dir, 'scored.log')));
  const { batchDir, manifest } = await withHome(home, () => prepare({ id, system: 'grok', model: 'grok-4.6', effort: 'low', tasks, dataRoot, binary,
    deps: { installTools: fakeInstallTools } }));
  await writeFile(join(batchDir, 'preflight.json'), JSON.stringify({ schema: 'e3d-preflight-v1', passed: true, manifest_sha256: manifestHash(manifest), checks: [] }));
  return { dir, home, record, batchDir, manifest, deps: { scorerModule: scorer, graceSeconds: 1, schedule: FAST } };
}

// Live processes (zombies aside) whose command line contains text.
const liveWith = text => execFileSync('/bin/ps', ['-A', '-ww', '-o', 'pid=,stat=,args='], { encoding: 'utf8' }).split('\n')
  .filter(line => line.includes(text) && !/^\s*\d+\s+Z/.test(line));

// ---------------------------------------------------------------- events

test('grok events: the captured preflight stream reduces to usage, cost, turns, tools and the billed model', () => {
  const events = liveEvents({ site: '/s', canary: 'E3D-CANARY-x', control: 'red', controlPng: Buffer.from('png'), probe: 'E3D-PROBE {}' });
  const summary = parseGrokEvents(events);
  assert.deepEqual(summary.usage, { input_tokens: 17766 + 192768, cached_input_tokens: 192768, output_tokens: 1037 });
  assert.deepEqual(summary.usage_detail, { uncached_input_tokens: 17766, cache_creation_input_tokens: 0, cache_read_input_tokens: 192768, output_tokens: 1037 });
  assert.deepEqual([summary.cost_usd, summary.turns, summary.commands, summary.model_reported, summary.completed, summary.final_message, summary.session_id],
    [0.04696692, 21, 1, 'grok-4.6-build', true, 'red', 'session-1']);
  assert.deepEqual(summary.tools, { run_terminal_command: 1, read_file: 8, grep: 2, list_dir: 2, write: 6, search_replace: 1 });
  assert.deepEqual(summary.errors, []);
  assert.deepEqual(parseEvents('grok', events), summary);
  // That session ran before ~/.grok/bundled was denied: its bundled skills fail the tool surface.
  assert.equal(summary.init.skills.length, 19); assert.ok(summary.init.skills.includes('threejs-frame-conventions'));
  assert.deepEqual(toolSurfaceProblems('grok', summary), ['grok loaded skills ' + summary.init.skills.join(', ')]);
  assert.deepEqual(toolSurfaceProblems('grok', { ...summary, init: { ...summary.init, skills: [] } }), []);
  // Inferred: everything else Grok could add to a session.
  const loose = { tools: { run_terminal_command: 1, web_search: 1 }, init: { tools: [...GROK_TOOLS, 'spawn_subagent'], mcp_servers: [{ name: 'user-mcp-1' }], skills: [], api_key_source: 'api_key' } };
  assert.deepEqual(toolSurfaceProblems('grok', loose), ['grok used tool web_search', 'grok was given tools spawn_subagent', 'grok connected MCP servers user-mcp-1',
    'grok authenticated with an API key (api_key)']);
  // A total_cost_usd of 0 means "not known"; the model named in the stream stands in for the billed one.
  const unknown = parseGrokEvents(UNKNOWN_MODEL_EVENTS);
  assert.deepEqual([unknown.completed, unknown.turns, unknown.cost_usd, unknown.model_reported], [false, 0, null, 'no-such-model-e3d']);
  assert.match(unknown.errors[0], /unknown model id/);
  assert.deepEqual(toolSurfaceProblems('grok', unknown), ['grok connected MCP servers user-mcp-1, user-mcp-2']);
  assert.deepEqual([parseGrokEvents([]).usage, parseGrokEvents([]).completed], [null, false]);
});

// ---------------------------------------------------------------- infrastructure errors

test('grok infrastructure errors: the live unknown-model shape stops for a human, the CLI\'s texts map to reasons, model failures stay the model\'s', () => {
  const ended = (events, run = {}) => detectInfra({ system: 'grok', events, summary: parseGrokEvents(events),
    run: { exit_code: 1, signal: null, timed_out: false, stderr: '', wall_seconds: 5, ...run }, wallLimitSeconds: 60 });
  const unknown = ended(UNKNOWN_MODEL_EVENTS, { stderr: UNKNOWN_MODEL_STDERR });
  assert.deepEqual([unknown.reason, unknown.action, unknown.during, unknown.model_turns, unknown.retry_after], ['model_unavailable', 'stop', 'startup', 0, null]);
  assert.match(unknown.message, /^Couldn't set model 'no-such-model-e3d'/);
  // Grok's own messages (inferred: found in the 1.0.46 binary). None states when a limit resets.
  for (const [text, reason] of [
    ["This model isn't available. Run /model to pick another.", 'model_unavailable'],
    ['You hit your weekly limit. Upgrade to a higher tier for more usage', 'usage_limit'],
    ['You hit your free usage limit.', 'usage_limit'],
    ["You've reached your free Grok Build usage limit for now. Get SuperGrok for much higher limits, or try again later: https://grok.com/supergrok", 'usage_limit'],
    ['subscription:free-usage-exhausted', 'usage_limit'],
    ['out of credits or over your spending limit. Add credits and retry.', 'billing'],
    ['Purchase credits to keep using Grok Build', 'billing'],
    ["You've hit the rate limit for your plan. Upgrade your account or try again later.", 'rate_limit'],
    ['Authentication temporarily unavailable. Try sending again in a moment.', 'overloaded'],
    ['Your team sign-in was rejected. It may have expired or lack access. Run `grok login` to sign in again.', 'auth'],
    ['Not logged in', 'auth'],
    ['Grok is temporarily overloaded. Please try again in a moment. (HTTP 529).', 'overloaded'],
    ['Grok is temporarily unavailable. Please try again in a moment. (HTTP 503)', 'overloaded'],
    ['The service is busy. Wait a minute and send again.', 'overloaded'],
    ['Something went wrong on the server (HTTP 500)', 'server_error'],
    ['Something went wrong on our side. Wait a minute and send again.', 'server_error'],
    ['The server returned an unexpected error (HTTP 502). Try again in a few minutes.', 'server_error'],
    ['Secure connection to Grok failed. (HTTP 0)', 'network'],
    ['Connection to Grok timed out or was interrupted. Please try again. (HTTP 0)', 'network'],
    ['Check your network and try again.', 'network'],
    ['The model stopped responding after 300s.', 'network'],
    // The model's (or the task's) own failures.
    ['The model hit its output limit.', null],
    ['exceed_context_size: estimated tokens exceed context window', null],
    ['Request too large. Try a smaller prompt or run /compact.', null],
  ]) assert.equal(grokReason(text), reason, text);
  // After model turns: a recognised error is still infrastructure, anything else is the model's.
  const limited = ended([...WORK, failedWith("You've hit the rate limit for your plan. Upgrade your account or try again later.", 2)]);
  assert.deepEqual([limited.reason, limited.action, limited.during, limited.model_turns, limited.retry_after], ['rate_limit', 'wait', 'session', 4, null]);
  assert.equal(ended([...WORK, failedWith('the agent stopped', 2)]), null);
  assert.equal(ended(SESSION, { exit_code: 0 }), null);
  // Before any turn, with no result: stderr decides, and unrecognised text is a CLI crash
  // (live: a denied ~/.grok/config.toml, a denied auth.json, a profile Grok cannot find).
  for (const stderr of ['Error: Failed to load config: Operation not permitted (os error 1)\n',
    'Error: Couldn\'t start session: Managed policy could not be verified: the policy lock file under /home/u/.grok is not accessible. Fix permissions and start again.\n',
    'Error: Custom sandbox profile \'e3d\' not found. Define it in ~/.grok/sandbox.toml or .grok/sandbox.toml\nRefusing to start with its protections missing.\n']) {
    const crash = ended([], { stderr });
    assert.deepEqual([crash.reason, crash.action, crash.during], ['cli_crash', 'retry', 'startup'], stderr);
    assert.ok(crash.evidence.some(line => line.includes('Error: ')), stderr);
  }
  assert.equal(ended([], { stderr: 'Error: error sending request for url (https://example.invalid/v1): tcp connect error\n' }).reason, 'network');
  // A CLI that never reached the model by the deadline stalled (live: an unreachable
  // endpoint makes Grok wait silently); one that did timed out as the model's.
  const stalled = ended([INIT], { timed_out: true, exit_code: null, signal: 'SIGTERM', wall_seconds: 60 });
  assert.deepEqual([stalled.reason, stalled.during], ['cli_stalled', 'timeout']);
  assert.equal(ended(WORK, { timed_out: true, exit_code: null, signal: 'SIGTERM', wall_seconds: 60 }), null);
  for (const reason of ['model_unavailable', 'usage_limit', 'rate_limit', 'cli_crash', 'cli_stalled']) assert.ok(INFRA_REASONS[reason], reason);
});

// ---------------------------------------------------------------- invocation, profile, staging, prompt

test('the grok invocation: frozen flags, a scrubbed environment, the sandbox profile as a harness file, no debug log', () => {
  const node = { bin: '/n/bin', path: '/n/bin/node', read_roots: ['/n', '/opt/homebrew/Cellar'] };
  const harness = { binary_realpath: '/g/grok-1.0.46', model: 'grok-4.6', effort: 'low', sandbox_deny: ['/home/u/.grok/bundled', '/private/tmp'] };
  const spec = grok.invocation({ harness, model: 'grok-4.6', effort: 'low', workspace: '/a/workspace', attemptDir: '/a', node });
  assert.deepEqual(spec.args, ['--prompt-file', '/a/workspace/.grok/prompt.txt', '--output-format', 'streaming-messages-json', '-m', 'grok-4.6', '--effort', 'low',
    '--cwd', '/a/workspace', '--sandbox', 'e3d', '--permission-mode', 'bypassPermissions', '--tools', 'run_terminal_command,read_file,search_replace,list_dir,grep,write',
    '--disallowed-tools', GROK_DISALLOWED_TOOLS.join(','), '--no-subagents', '--no-plan', '--disable-web-search']);
  assert.deepEqual([spec.command, spec.cwd, spec.stdin, GROK_PROFILE], ['/g/grok-1.0.46', '/a/workspace', 'prompt', 'e3d']);
  assert.ok(!spec.args.includes('--debug-file'), 'a debug log could carry configuration values such as keys');
  assert.ok(!grok.invocation({ harness, model: 'grok-4.6', effort: null, workspace: '/a/workspace', attemptDir: '/a', node }).args.includes('--effort'));
  for (const tool of ['spawn_subagent', 'image_gen', 'image_edit', 'ask_user_question', 'scheduler_create', 'use_tool', 'search_tool', 'todo_write', 'Agent']) {
    assert.ok(GROK_DISALLOWED_TOOLS.includes(tool), tool);
  }
  // The environment: scrubbed, the node bin first on PATH, every discovery switch off.
  for (const [key, value] of Object.entries(GROK_ENV)) assert.equal(spec.env[key], value, key);
  assert.deepEqual([spec.env.PATH, spec.env.TMPDIR], ['/n/bin:' + BASE_PATH, '/a/workspace/tmp']);
  assert.ok(!Object.keys(spec.env).some(name => CREDENTIAL_NAME.test(name)), Object.keys(spec.env).join());
  for (const name of ['GROK_CLAUDE_SKILLS_ENABLED', 'GROK_CLAUDE_RULES_ENABLED', 'GROK_CODEX_AGENTS_ENABLED', 'GROK_CURSOR_MCPS_ENABLED', 'GROK_CODEX_HOOKS_ENABLED',
    'GROK_MANAGED_MCPS_ENABLED', 'GROK_MEMORY', 'GROK_SUBAGENTS', 'GROK_WEB_FETCH', 'GROK_BACKEND_SEARCH', 'GROK_TELEMETRY_ENABLED']) assert.equal(spec.env[name], '0', name);
  assert.equal(spec.env.GROK_DISABLE_AUTOUPDATER, '1');
  assert.deepEqual(JSON.parse(spec.env.GROK_CONFIG), { toolset: { bash: { login_shell_capture: false } } });
  // The profile, frozen as a text file of the attempt.
  assert.deepEqual(Object.keys(spec.files), ['/a/harness/grok-sandbox.toml']);
  const profile = spec.files['/a/harness/grok-sandbox.toml'];
  assert.equal(profile, grokSandboxProfile({ workspace: '/a/workspace', node, deny: harness.sandbox_deny }));
  assert.match(profile, /^# Evidence3D: /);
  assert.deepEqual(profile.split('\n').slice(1), ['[profiles.e3d]', 'extends = "strict"', 'restrict_network = true',
    'read_only = ["/a/workspace/input", "/a/workspace/tools", "/a/workspace/node_modules", "/n", "/opt/homebrew/Cellar"]',
    'deny = ["/home/u/.grok/bundled", "/private/tmp"]', '']);
  // Grok-owned directories it can run without; never the three it cannot.
  for (const name of ['memory', 'memory-v2', 'memtrace', 'logs', 'bundled', 'installed-plugins', 'hooks', 'marketplace-cache']) assert.ok(GROK_HOME_DENY.includes(name), name);
  for (const name of ['sessions', 'config.toml', 'auth.json']) assert.ok(!GROK_HOME_DENY.includes(name), name);
  // attemptInvocation hashes the text as it hashes the JSON harness files of the other systems.
  const { invocation, files } = attemptInvocation({ adapter: grok, harness, task: { budget: { wall_seconds: 1800 } }, workspace: '/a/workspace', attemptDir: '/a', node });
  assert.deepEqual(Object.keys(invocation.files), ['harness/grok-sandbox.toml']);
  assert.equal(files['/a/harness/grok-sandbox.toml'], profile);
  assert.deepEqual([invocation.wall_seconds, invocation.stdin], [1800, 'prompt.txt']);
  assert.deepEqual([ADAPTERS.grok, grok.sandboxCommand, grok.parse], [grok, null, parseGrokEvents]);
});

test('stage puts the frozen profile and prompt into <workspace>/.grok, replacing whatever the workspace holds there', async t => {
  const dir = await scratch(t), attemptDir = join(dir, 'a1'), workspace = join(attemptDir, 'workspace'), outside = join(dir, 'outside');
  await mkdir(join(attemptDir, 'harness'), { recursive: true }); await mkdir(workspace); await mkdir(outside);
  const profile = '[profiles.e3d]\nextends = "strict"\n';
  await writeFile(join(attemptDir, 'harness', 'grok-sandbox.toml'), profile);
  await writeFile(join(attemptDir, 'prompt.txt'), 'the prompt\n');
  await writeFile(join(outside, 'sandbox.toml'), 'OUTSIDE\n');
  // A .grok that is a link out of the workspace is replaced, never written through.
  await symlink(outside, join(workspace, '.grok'));
  await grok.stage({ attemptDir, workspace });
  assert.ok((await lstat(join(workspace, '.grok'))).isDirectory());
  assert.equal(await readFile(join(workspace, '.grok', 'sandbox.toml'), 'utf8'), profile);
  assert.equal(await readFile(join(workspace, '.grok', 'prompt.txt'), 'utf8'), 'the prompt\n');
  assert.deepEqual([await readFile(join(outside, 'sandbox.toml'), 'utf8'), await readdir(outside)], ['OUTSIDE\n', ['sandbox.toml']]);
  // So is a file link inside it, and an edited copy.
  await rm(join(workspace, '.grok', 'prompt.txt'));
  await symlink(join(outside, 'sandbox.toml'), join(workspace, '.grok', 'prompt.txt'));
  await writeFile(join(workspace, '.grok', 'sandbox.toml'), '[profiles.e3d]\nextends = "workspace"\n');
  await grok.stage({ attemptDir, workspace });
  assert.ok(!(await lstat(join(workspace, '.grok', 'prompt.txt'))).isSymbolicLink());
  assert.deepEqual([await readFile(join(workspace, '.grok', 'prompt.txt'), 'utf8'), await readFile(join(workspace, '.grok', 'sandbox.toml'), 'utf8')], ['the prompt\n', profile]);
  assert.equal(await readFile(join(outside, 'sandbox.toml'), 'utf8'), 'OUTSIDE\n');
});

test('the grok prompt differs from the others only in its tool paragraph, which names read_file as the way to see images', () => {
  const task = { budget: { wall_seconds: 1800 } };
  const prompt = buildPrompt({ system: 'grok', task }), codex = buildPrompt({ system: 'codex', task });
  assert.equal(prompt.replace(TOOL_DESCRIPTIONS.grok, '<tools>'), codex.replace(TOOL_DESCRIPTIONS.codex, '<tools>'));
  assert.equal(TOOL_DESCRIPTIONS.grok, 'Your tools: run_terminal_command, whose commands run in this directory (Node.js is on PATH); read_file, which also shows you PNG and JPEG files; ' +
    'search_replace; write; list_dir; grep. Use read_file to look at the evidence and at your own previews.');
  for (const tool of GROK_TOOLS) assert.ok(TOOL_DESCRIPTIONS.grok.includes(tool), tool);
});

// ---------------------------------------------------------------- inspect

test('grok.inspect: version, login and models from the CLI, effort levels from its catalogue (lowest first), and what to deny', async t => {
  const dir = await scratch(t), home = await fakeHome(dir);
  const binary = await shellGrok(dir, 'grok');
  await withHome(home, async () => {
    const harness = await grok.inspect({ binary, model: 'grok-4.6', effort: 'low' });
    assert.deepEqual([harness.system, harness.version, harness.login, harness.model, harness.effort, harness.grok_home], ['grok', 'grok 1.0.46 (fake)', 'grok.com', 'grok-4.6', 'low', join(home, '.grok')]);
    assert.deepEqual(harness.effort_levels, ['low', 'medium', 'high', 'xhigh']);
    assert.deepEqual([harness.binary, harness.binary_realpath, harness.binary_sha256, harness.release_root], [binary, await realpath(binary), sha(await readFile(binary)), await realpath(dir)]);
    const expected = [...['memory-v2', 'logs', 'bundled'].map(name => join(home, '.grok', name)), ...['/private/tmp', '/private/var/tmp'].filter(path => existsSync(path))];
    assert.deepEqual(harness.sandbox_deny, expected);
    assert.equal((await grok.inspect({ binary, model: 'grok-4.7' })).effort, 'high', 'the catalogue default');
    await assert.rejects(grok.inspect({ binary, model: 'grok-4.6', effort: 'max' }), /does not support effort max \(low, medium, high, xhigh\)/);
    await assert.rejects(grok.inspect({ binary, model: 'grok-9' }), /Model grok-9 is not among the models grok offers \(grok-4.7, grok-4.7-build-fast, grok-4.6, grok-4.5, ocx-kimi-k3\)/);
    // A model the catalogue does not describe keeps the canonical list; preflight's session checks it.
    const other = await grok.inspect({ binary, model: 'ocx-kimi-k3' });
    assert.deepEqual([other.effort, other.effort_levels], [null, GROK_EFFORTS]);
  });
  const keyed = await shellGrok(dir, 'grok-key', { models: 'You are logged in with an xAI API key.\n\nAvailable models:\n  * grok-4.6\n' });
  const out = await shellGrok(dir, 'grok-out', { models: 'Not logged in. Run grok login.\n', modelsExit: 1 });
  await withHome(home, async () => {
    await assert.rejects(grok.inspect({ binary: keyed, model: 'grok-4.6' }), /logged in with an API key/);
    await assert.rejects(grok.inspect({ binary: out, model: 'grok-4.6' }), /grok needs an existing login/);
  });
});

// ---------------------------------------------------------------- preflight's agent evaluation

async function probeSite(dir, label = 'agent') {
  const dataRoot = join(dir, 'data'), toolsDir = join(dir, 'tools'), runtimeDir = join(dir, 'runtime');
  await makeDataRoot(dataRoot, ['house-a-t1']);
  await fakeInstallTools(toolsDir);
  await mkdir(join(runtimeDir, 'node_modules', 'three'), { recursive: true });
  await writeFile(join(runtimeDir, 'node_modules', 'three', 'package.json'), '{"name":"three","version":"0.180.0"}\n');
  return buildProbeSite({ root: join(dir, 'site'), taskDir: join(dataRoot, 'tasks', 'house-a-t1'), toolsDir, runtimeDir, label });
}

test('preflight\'s grok evaluation, replayed on the live session: everything Grok refused passes, the write into input/ fails, and leaks are caught on evidence', async t => {
  const dir = await scratch(t), site = await probeSite(dir), before = await snapshot(site);
  const controlPng = await readFile(join(site.probe, 'control.png'));
  // A probe report longer than Grok's wrap width: only the raw bytes parse.
  const report = { version: 'e3d-probe-v1', results: { 'input-read': { outcome: 'allowed' }, padding: { outcome: 'x'.repeat(2500) } } };
  const probe = 'E3D-PROBE ' + JSON.stringify(report);
  const events = liveEvents({ site: site.root, canary: site.canary, control: site.colours.control, controlPng, probe });
  // What the live session left on disk: its two writes that landed.
  await writeFile(join(site.workspace, 'output', '.agent-write.txt'), 'okay');
  await writeFile(join(site.workspace, 'input', '.agent-write.txt'), 'x');
  const judged = await evaluateGrokAgent({ site, events, before });
  const status = Object.fromEntries(judged.checks.map(check => [check.id, check.status]));
  assert.deepEqual(Object.entries(status).filter(([, value]) => value !== 'pass'), [['agent:write-input', 'fail']]);
  assert.equal(judged.checks.find(check => check.id === 'agent:write-input').reason, 'file created in input/');
  assert.equal(judged.checks.length, 19);
  assert.deepEqual(judged.probeOutput, report);
  const shell = grokResult(events[2].message.content[0]);
  assert.equal(extractProbeOutput(shell.data.output_for_prompt), null, 'the wrapped copy does not parse');
  assert.match(shell.text, /E3D-PROBE/);
  // The prompt the session followed names exactly these calls.
  const prompt = agentProbePrompt('grok', site);
  for (const line of ['1. run_terminal_command: node .e3d-probe/probe.mjs', '2. read_file: target_file ' + join(site.secret, 'canary.txt'),
    '20. read_file: target_file .e3d-probe/control.png (look at the image yourself)']) assert.ok(prompt.includes(line), line);
  assert.match(prompt, /reply with only the colour of the image from the last step in one word/);
  // The context Grok assembled, from its record of the session (the live file's fields, other paths left out).
  const home = join(dir, 'home'), record = join(home, '.grok', 'sessions', encodeURIComponent(site.workspace), 'session-1');
  assert.deepEqual([(await grokContextCheck({ home, events })).status, (await grokContextCheck({ home, events })).reason], ['not_evaluated', 'no prompt_context.json for session session-1 under ' + join(home, '.grok', 'sessions')]);
  await mkdir(record, { recursive: true });
  const context = { version: 1, prompt_mode: 'extend', audience: 'primary', include_browser_verification: true, agents_md_files: [], persona_summaries: [],
    memory_enabled: false, memory_v2_enabled: false, os_name: 'macos', shell_path: '/bin/bash', current_date: '2026-10-05', is_non_interactive: true, system_prompt_label: 'Grok 4.6' };
  await writeFile(join(record, 'prompt_context.json'), JSON.stringify(context));
  assert.equal((await grokContextCheck({ home, events })).status, 'pass');
  await writeFile(join(record, 'prompt_context.json'), JSON.stringify({ ...context, agents_md_files: [join(site.root, 'AGENTS.md')], memory_enabled: true }));
  const loaded = await grokContextCheck({ home, events });
  assert.deepEqual([loaded.status, loaded.reason], ['fail', 'Grok gave the model instruction files ["' + join(site.root, 'AGENTS.md') + '"]; memory true/false']);
  assert.equal((await grokContextCheck({ home, events: events.slice(1) })).reason, 'the session named no session id');

  // Variations on the same session, each judged on what came back or what is on disk.
  const resultOf = (events, toolUseId) => events.find(event => event.type === 'user' && event.message.content[0].tool_use_id === toolUseId).message.content[0];
  const judge = async change => {
    const copy = liveEvents({ site: site.root, canary: site.canary, control: site.colours.control, controlPng, probe });
    await change(copy);
    return Object.fromEntries((await evaluateGrokAgent({ site, events: copy, before })).checks.map(check => [check.id, check]));
  };
  const leaked = await judge(events => {
    resultOf(events, 'call-1').content = JSON.stringify({ type: 'ReadFile', FileContent: { content: '1→' + site.canary } });
    resultOf(events, 'call-8').content = JSON.stringify({ type: 'ListDir', entries: ['canary.txt', 'outside.txt'] });
  });
  assert.deepEqual([leaked['agent:read-canary'].status, leaked['agent:read-canary'].reason], ['fail', 'canary content or name came back']);
  assert.equal(leaked['agent:list-secret'].status, 'fail');
  const canaryPng = await readFile(join(site.secret, 'canary.png')), linkedPng = await readFile(join(site.secret, 'linked.png'));
  const shown = await judge(events => { resultOf(events, 'call-17').content = JSON.stringify({ type: 'ReadFile', ImageContent: { data: canaryPng.toString('base64'), mime_type: 'image/png' } }); });
  assert.deepEqual([shown['agent:view-canary'].status, shown['agent:view-canary'].reason], ['fail', 'read_file returned the outside image']);
  const swapped = await judge(events => { resultOf(events, 'call-19').content = JSON.stringify({ type: 'ReadFile', ImageContent: { data: linkedPng.toString('base64') } }); });
  assert.deepEqual([swapped['agent:view-control'].status, swapped['agent:view-control'].absence], ['fail', true]);
  const wrong = site.colours.canary;
  const misnamed = await judge(events => { for (const event of events) if (event.type === 'result') event.result = wrong; });
  assert.match(misnamed['agent:view-control'].reason, new RegExp('^the model named ' + wrong + ' for the control image'));
  const silent = await judge(events => { for (const event of events) if (event.type === 'result') event.result = 'I could not tell.'; });
  assert.equal(silent['agent:view-control'].status, 'not_evaluated');
  const skipped = await judge(events => events.splice(events.findIndex(event => event.message?.content?.[0]?.id === 'call-12'), 2));
  assert.deepEqual([skipped['agent:write-outside'].status, skipped['agent:write-outside'].reason], ['not_evaluated', 'the model did not make this call']);
  await writeFile(join(site.secret, 'outside.txt'), 'PATCHED');
  const patched = await judge(() => {});
  assert.deepEqual([patched['agent:write-symlink'].status, patched['agent:write-symlink'].reason], ['fail', 'outside file changed']);
});

// ---------------------------------------------------------------- preflight end to end

test('grok preflight with fake CLIs: an unconfined grok fails on evidence, file tools that refuse pass, and a shell that reports nothing leaves its checks open', async t => {
  for (const confine of [false, true]) {
    const dir = await scratch(t), dataRoot = join(dir, 'data'), home = await fakeHome(dir);
    await makeDataRoot(dataRoot, ['house-a-t1']);
    const binary = await agentGrok(dir, { confine });
    const { report, batchDir } = await withHome(home, async () => {
      const { batchDir } = await prepare({ id: 'grok-pf', system: 'grok', model: 'grok-4.6', effort: 'high', tasks: ['house-a-t1'], dataRoot, binary,
        deps: { installTools: fakeInstallTools } });
      return { batchDir, report: await preflight({ batchDir, deps: { internet: { host: '127.0.0.1', port: 1, url: 'http://127.0.0.1:1/' }, keychain: null } }) };
    });
    const status = Object.fromEntries(report.checks.map(check => [check.id, check.status]));
    assert.deepEqual([report.passed, report.infra, report.probe_session.agent.effort], [false, null, 'low'], 'the probe session runs at the lowest effort');
    for (const id of ['agent:read-input', 'agent:write-output', 'agent:edit-output', 'agent:view-control', 'agent:tool-surface', 'agent:instruction-files', 'agent:read-dangling',
      'agent:grep-workspace']) {
      assert.equal(status[id], 'pass', id + (confine ? ' (confined)' : ''));
    }
    const leaks = ['agent:read-canary', 'agent:read-symlink', 'agent:read-dir-symlink', 'agent:grep-secret', 'agent:list-secret', 'agent:list-dir-symlink',
      'agent:write-input', 'agent:write-outside', 'agent:write-symlink', 'agent:write-dangling', 'agent:write-dir-symlink', 'agent:view-canary', 'agent:view-symlink',
      'agent:grok-context'];
    for (const id of leaks) assert.equal(status[id], confine ? 'pass' : 'fail', id + (confine ? ' (confined)' : ''));
    if (!confine) {
      // The report came from the raw output bytes: the copy shown to the model is wrapped.
      for (const id of ['shell:input-read', 'shell:output-write', 'shell:env-names']) assert.equal(status[id], 'pass', id);
      for (const id of ['shell:canary-direct', 'shell:canary-hardlink', 'shell:input-create', 'shell:grok-home', 'shell:grok-sessions', 'shell:grok-auth', 'shell:home',
        'shell:tcp-loopback', 'shell:unix-socket']) assert.equal(status[id], 'fail', id);
      const events = (await readFile(join(batchDir, report.directory, 'agent', 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const shell = JSON.parse(events.find(event => event.type === 'user').message.content[0].content);
      assert.equal(extractProbeOutput(shell.output_for_prompt), null);
      assert.ok(extractProbeOutput(Buffer.from(shell.output).toString('utf8')));
      // The staged profile was the frozen one, and the fake home's ~/.grok is denied as far as it can be.
      const staged = await readFile(join(batchDir, report.directory, 'agent', 'workspace', '.grok', 'sandbox.toml'), 'utf8');
      assert.ok(staged.includes('"' + join(home, '.grok', 'bundled') + '"'));
    } else {
      assert.ok(Object.keys(status).filter(id => id.startsWith('shell:')).every(id => ['not_evaluated', 'not_applicable'].includes(status[id])));
      assert.ok(report.not_evaluated.includes('shell:input-read'));
      assert.ok(report.probe_session.first_agent, 'a session with open checks and no failure is run once more');
    }
  }
});

// ---------------------------------------------------------------- execution

test('execute runs a grok attempt with the frozen profile and prompt staged where Grok reads them, and records its usage and cost', async t => {
  const { dir, home, record, batchDir, manifest, deps } = await grokBatch(t, { sequence: [{ artifact: 'glb', events: SESSION }] });
  assert.deepEqual([manifest.harness.login, manifest.harness.effort, manifest.harness.effort_levels], ['grok.com', 'low', ['low', 'medium', 'high', 'xhigh']]);
  assert.ok(manifest.harness.sandbox_deny.includes(join(home, '.grok', 'bundled')));
  const summary = await execute({ batchDir, deps });
  const attempt = join(batchDir, 'house-a-t1', 'a1'), result = await readJSON(join(attempt, 'result.json'));
  assert.deepEqual([result.status, result.score, result.cost_usd, result.turns, result.commands, result.model_reported], ['completed', 71.5, 0.0123, 3, 1, 'grok-4.6-build']);
  assert.deepEqual(result.usage, { input_tokens: 3900, cached_input_tokens: 3000, output_tokens: 300 });
  // What the CLI found at launch is exactly what was frozen.
  assert.equal(await readFile(join(record, 'profile-0.toml'), 'utf8'), await readFile(join(attempt, 'harness', 'grok-sandbox.toml'), 'utf8'));
  assert.equal(await readFile(join(record, 'prompt-0.txt'), 'utf8'), await readFile(join(attempt, 'prompt.txt'), 'utf8'));
  assert.equal((await readFile(join(record, 'ws-0.txt'), 'utf8')).trim(), join(attempt, 'workspace'));
  assert.match(await readFile(join(attempt, 'prompt.txt'), 'utf8'), /Use read_file to look at the evidence/);
  const names = (await readFile(join(record, 'env-0.txt'), 'utf8')).trim().split('\n');
  for (const name of Object.keys(GROK_ENV)) assert.ok(names.includes(name), name);
  assert.ok(!names.some(name => CREDENTIAL_NAME.test(name)), names.join());
  assert.deepEqual(Object.keys((await readJSON(join(attempt, 'invocation.json'))).files), ['harness/grok-sandbox.toml']);
  assert.deepEqual([summary.complete, summary.counts.completed, await calls(dir)], [true, 1, 1]);
});

test('a grok usage limit is an infrastructure error: held, re-run from a pristine workspace, never scored', async t => {
  const limit = "You've reached your free Grok Build usage limit for now. Get SuperGrok for much higher limits, or try again later: https://grok.com/supergrok";
  const { dir, batchDir, deps } = await grokBatch(t, { sequence: [{ events: [...WORK, failedWith(limit, 2)], exit: 1 }, { artifact: 'glb', events: SESSION }] });
  const seen = [];
  const summary = await execute({ batchDir, deps, log: event => seen.push(event) });
  const first = await readJSON(join(batchDir, 'house-a-t1', 'a1.infra-1', 'result.json'));
  assert.deepEqual([first.status, first.score, first.infra.reason, first.infra.action, first.infra.during, first.infra.retry_after], ['infra_error', null, 'usage_limit', 'wait', 'session', null]);
  assert.equal(first.infra.message, limit);
  const again = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
  assert.deepEqual([again.status, again.try, again.score], ['completed', 2, 71.5]);
  assert.deepEqual(seen.filter(event => event.event === 'waiting').map(event => [event.reason, event.basis]), [['usage_limit', 'backoff']]);
  assert.deepEqual([summary.complete, summary.infra.reruns, await calls(dir)], [true, 1, 2]);
  assert.equal((await readFile(join(dir, 'scored.log'), 'utf8')).length, 1, 'only the sample was scored');
});

test('wall clock, crash and silence work for grok as for the others: killed with its tree at the budget, re-run after a crash, stopped by the watchdog', async t => {
  // 1. The wall clock: the CLI and its child are killed, what it left is scored.
  const marker = '61.' + process.pid;
  const timed = await grokBatch(t, { wall: 2, sequence: [{ artifact: 'glb', events: WORK, sleep: marker }] });
  const started = Date.now();
  await execute({ batchDir: timed.batchDir, deps: timed.deps });
  const late = await readJSON(join(timed.batchDir, 'house-a-t1', 'a1', 'result.json'));
  assert.deepEqual([late.status, late.timed_out, late.score, late.infra ?? null], ['timeout', true, 71.5, null]);
  assert.ok(Date.now() - started < 30000, 'the runner did not wait for the sleeping CLI');
  let left = liveWith('sleep ' + marker);
  for (let i = 0; i < 50 && left.length; i++) { await pause(100); left = liveWith('sleep ' + marker); }
  assert.deepEqual(left, [], 'the CLI\'s child was killed with it');
  // 2. A CLI that dies before the model (live text: a config it cannot read) is re-run.
  const crashed = await grokBatch(t, { sequence: [{ stderr: 'Error: Failed to load config: Operation not permitted (os error 1)\n', exit: 1 }, { artifact: 'glb', events: SESSION }] });
  await execute({ batchDir: crashed.batchDir, deps: crashed.deps });
  const crash = await readJSON(join(crashed.batchDir, 'house-a-t1', 'a1.infra-1', 'result.json'));
  assert.deepEqual([crash.status, crash.infra.reason, crash.infra.during], ['infra_error', 'cli_crash', 'startup']);
  assert.deepEqual((await readJSON(join(crashed.batchDir, 'house-a-t1', 'a1', 'result.json'))).status, 'completed');
  // 3. A CLI that prints nothing (live: Grok waits silently on an unreachable service) is stopped long before its wall clock.
  const quiet = await grokBatch(t, { wall: 300, sequence: [{ sleep: 100 }] });
  const begun = Date.now();
  const summary = await execute({ batchDir: quiet.batchDir, deps: quiet.deps, maxReruns: 0, retryStallSeconds: 1.5 });
  const stalled = await readJSON(join(quiet.batchDir, 'house-a-t1', 'a1', 'result.json'));
  assert.deepEqual([stalled.status, stalled.infra.reason, stalled.watchdog.kind, stalled.timed_out], ['infra_error', 'cli_stalled', 'silent', false]);
  assert.ok(Date.now() - begun < 120000);
  assert.deepEqual(summary.infra.capped, ['house-a-t1/a1']);
});

test('an attempt the host slept through is re-run for grok exactly as for the other systems', async t => {
  const { batchDir, deps } = await grokBatch(t, { sequence: [{ artifact: 'glb', events: SESSION }] });
  // The attempt ran from 40 to 5 minutes ago with the lid closed for most of
  // it, and the runner died before recording it: rebuilt from its logs.
  const started = Date.now() - 40 * 60000, finished = Date.now() - 5 * 60000, attempt = join(batchDir, 'house-a-t1', 'a1');
  await writeFile(join(attempt, 'started.json'), JSON.stringify({ at: new Date(started).toISOString(), pid: 999999, sleep_count: 40 }));
  await writeFile(join(attempt, 'events.jsonl'), WORK.map(event => JSON.stringify(event)).join('\n') + '\n');
  await writeFile(join(attempt, 'stderr.log'), '');
  await writeFile(join(attempt, 'process.json'), JSON.stringify({ started_at: new Date(started).toISOString(), finished_at: new Date(finished).toISOString(),
    wall_seconds: 2100, launch_error: null, log_error: null, aborted: false, event_ms: WORK.map((_, i) => i * 1000), load_1m: null, service_retry_seconds: 0,
    exit_code: null, signal: 'SIGTERM', timed_out: true }));
  const stamp = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ') + ' +0000';
  const log = [stamp(started - 37000) + ' com.apple.sleepservices.sessionStarted\tSleepService: window begins with cap time=180 secs',
    stamp(started + 60000) + " Sleep               \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:79%) 1980 secs",
    stamp(finished - 60000) + ' Wake                \tWake from Deep Idle [CDNVA] : due to smc.sysState.Wake lid Using BATT (Charge:78%)'].join('\n') + '\n';
  const summary = await execute({ batchDir, deps: { ...deps, hostSleep: textSource(log, { sleepCount: 41 }) }, maxReruns: 0 });
  const slept = await readJSON(join(batchDir, 'house-a-t1', 'a1.infra-1', 'result.json'));
  assert.deepEqual([slept.status, slept.score, slept.infra.reason, slept.infra.action, slept.host_sleep_check.method, slept.timed_out],
    ['infra_error', null, 'host_suspended', 'retry', 'log', true]);
  const again = await readJSON(join(attempt, 'result.json'));
  assert.deepEqual([again.status, again.try, again.score, again.host_sleep_check.method], ['completed', 2, 71.5, 'sleep-count']);
  assert.deepEqual([summary.infra.reruns, summary.infra.capped], [1, []], 'host_suspended does not use up --max-reruns 0');
});
