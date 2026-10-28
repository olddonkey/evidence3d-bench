import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, lstat, readdir, realpath, stat } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { modelToGLB } from '../lib/model.mjs';
import { sampleModel } from '../fixtures/sample-model.mjs';
import { prepare, preflight, execute, manifestHash, attemptInvocation } from '../lib/runner/index.mjs';
import { makeDataRoot, fakeInstallTools, fakeScorer } from '../lib/runner/api/mock/fixtures.mjs';
import { ADAPTERS, grok, GROK_ENV, GROK_EFFORTS, GROK_DISALLOWED_TOOLS, GROK_READ_ONLY, GROK_AGENT_DEFINITION, grokDenyRules, grokShellWrapper, outsideCover,
  nodeRuntime } from '../lib/runner/adapters.mjs';
import { parseGrokEvents, parseEvents, toolSurfaceProblems, GROK_TOOLS } from '../lib/runner/events.mjs';
import { detectInfra, grokReason, INFRA_REASONS } from '../lib/runner/infra.mjs';
import { buildPrompt, TOOL_DESCRIPTIONS } from '../lib/runner/prompt.mjs';
import { buildProbeSite, snapshot, evaluateGrokAgent, agentProbePrompt, grokResult, grokContextCheck, PROBE_COLOURS } from '../lib/runner/preflight.mjs';
import { extractProbeOutput } from '../lib/runner/probes.mjs';
import { BASE_PATH, CREDENTIAL_NAME } from '../lib/runner/process.mjs';
import { writeHarnessFile } from '../lib/runner/workspace.mjs';
import { textSource } from '../lib/runner/hostsleep.mjs';

// The grok system (Grok Build CLI 1.0.46): its event stream, infrastructure
// errors, invocation, the path rules and the shell wrapper (run for real
// under Seatbelt), staging, inspect, execution and preflight. The real CLI is
// never started here: two fake `grok` binaries stand in for it (a /bin/sh one
// for execution, whose timing must be tight, and a Node one that carries out
// preflight's tool calls), and every Grok shape below was captured from the
// real CLI unless marked otherwise.

// The shell wrapper execs /usr/bin/sandbox-exec, which only macOS has; elsewhere
// the tests that start it are skipped rather than failed.
const MACOS_ONLY = process.platform !== 'darwin' && 'macOS only: needs Seatbelt (/usr/bin/sandbox-exec)';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'e3d-grok-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------- captured streams

// The agent session of the passing live preflight of probe-grok-2 (grok-4.6,
// effort low, 2026-10-05; the CLI unsandboxed, its shell under our profile,
// its file tools under the deny rules), every event as the CLI printed it,
// anonymised: the probe site's path is {site}, the home directory {home},
// ids and thinking signatures are replaced, the deny rule a refusal names is
// <pattern>, long file contents are cut, backticks are {bt}, and a JSON tool
// result is shown as the object it encodes (a refusal arrives as content
// blocks and is kept as such). Filled in by liveEvents(): {canary},
// {control} (the control image's colour), {control_png}, and the shell
// results' raw output bytes.
const LIVE_PREFLIGHT = String.raw`
{"type":"system","subtype":"init","session_id":"session-1","apiKeySource":"oauth","model":"grok-4.6","cwd":"{site}/workspace","permissionMode":"bypassPermissions","tools":["run_terminal_command","read_file","search_replace","list_dir","grep","write"],"slash_commands":["compact","always-approve","context","session-info","feedback","goal"],"mcp_servers":[],"skills":[]}
{"type":"assistant","message":{"id":"msg_0","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"thinking","thinking":"I will execute the four tool calls in the exact order specified.","signature":"sig"},{"type":"text","text":"Starting the isolation probe in the listed order, one tool call at a time."},{"type":"tool_use","id":"call-0","name":"run_terminal_command","input":{"command":"node .e3d-probe/probe.mjs","description":"Run isolation probe script"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":3863,"output_tokens":202,"cache_read_input_tokens":128,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-0","content":{"type":"Bash","output":"{probe_bytes}","output_for_prompt":"{probe_wrapped}","exit_code":0,"command":"node .e3d-probe/probe.mjs","truncated":false,"signal":null,"timed_out":false,"description":"Run isolation probe script","current_dir":"{site}/workspace","output_file":"{home}/.grok/sessions/{site_enc}%2Fworkspace/session-1/terminal/call-0.log","total_bytes":"{probe_length}"},"is_error":false}]}}
{"type":"assistant","message":{"id":"msg_1","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-1","name":"run_terminal_command","input":{"command":"ln -s input .e3d-probe/shell-link","description":"Create symlink to input directory"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":5113,"output_tokens":40,"cache_read_input_tokens":512,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-1","content":{"type":"Bash","output":"ln: .e3d-probe/shell-link: Operation not permitted\n","output_for_prompt":"exit: 1\nln: .e3d-probe/shell-link: Operation not permitted\n","exit_code":1,"command":"ln -s input .e3d-probe/shell-link","truncated":false,"signal":null,"timed_out":false,"description":"Create symlink to input directory","current_dir":"{site}/workspace","output_file":"{home}/.grok/sessions/{site_enc}%2Fworkspace/session-1/terminal/call-1.log","total_bytes":51},"is_error":false}]}}
{"type":"assistant","message":{"id":"msg_2","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-2","name":"read_file","input":{"target_file":"{site}/secret/canary.txt"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":191,"output_tokens":72,"cache_read_input_tokens":5504,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-2","content":[{"type":"content","content":{"type":"text","text":"Tool {bt}read_file{bt} was not executed: Denied by permission policy: deny rule on read matching \"<pattern>\""}}],"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_3","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-3","name":"read_file","input":{"target_file":".e3d-probe/link-file"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":472,"output_tokens":29,"cache_read_input_tokens":5632,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-3","content":[{"type":"content","content":{"type":"text","text":"Tool {bt}read_file{bt} was not executed: Denied by permission policy: deny rule on read matching \"<pattern>\""}}],"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_4","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-4","name":"read_file","input":{"target_file":".e3d-probe/link-dir/canary.txt"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":454,"output_tokens":28,"cache_read_input_tokens":6016,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-4","content":[{"type":"content","content":{"type":"text","text":"Tool {bt}read_file{bt} was not executed: Denied by permission policy: deny rule on read matching \"<pattern>\""}}],"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_5","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-5","name":"read_file","input":{"target_file":".e3d-probe/dangling-agent"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":435,"output_tokens":24,"cache_read_input_tokens":6400,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-5","content":[{"type":"content","content":{"type":"text","text":"Tool {bt}read_file{bt} was not executed: Denied by permission policy: deny rule on read matching \"<pattern>\""}}],"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_6","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-6","name":"read_file","input":{"target_file":"../secret/canary.txt"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":412,"output_tokens":20,"cache_read_input_tokens":6784,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-6","content":[{"type":"content","content":{"type":"text","text":"Tool {bt}read_file{bt} was not executed: Denied by permission policy: deny rule on read matching \"<pattern>\""}}],"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_7","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-7","name":"read_file","input":{"target_file":"input/task.json"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":385,"output_tokens":18,"cache_read_input_tokens":7168,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-7","content":{"type":"ReadFile","FileContent":{"content":"1→{\n  \"schema\": \"e3d-task-v1\",\n  \"id\": \"house-0011-t2\",\n  \"title\": \"Two-and-a-half-storey detached house with a hipped r…","content_concise":"1→{\n  \"schema\": \"e3d-task-v1\",\n  \"id\": \"house-0011-t2\",\n  \"title\": \"Two-and-a-half-storey detached house with a hipped r…","absolute_path":"{site}/workspace/input/task.json","offset":null,"raw_output":"{\n  \"schema\": \"e3d-task-v1\",\n  \"id\": \"house-0011-t2\",\n  \"title\": \"Two-and-a-half-storey detached house with a hipped roo…","total_lines":79}},"is_error":false}]}}
{"type":"assistant","message":{"id":"msg_8","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-8","name":"grep","input":{"pattern":"{canary}","path":"{site}/secret"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":1588,"output_tokens":85,"cache_read_input_tokens":7552,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-8","content":[{"type":"content","content":{"type":"text","text":"Tool {bt}grep{bt} was not executed: Denied by permission policy: deny rule on read matching \"<pattern>\""}}],"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_9","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-9","name":"grep","input":{"pattern":"{canary}","path":"."}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":470,"output_tokens":34,"cache_read_input_tokens":9088,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-9","content":{"type":"GrepSearch","stdout":"<workspace_result workspace_path=\"{site}/workspace\">\nNo matches found\n</workspace_result>","stderr":"","exit_code":1,"match_count":0,"file_matches":[]},"is_error":false}]}}
{"type":"assistant","message":{"id":"msg_10","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-10","name":"grep","input":{"pattern":"{canary}","path":".e3d-probe/link-dir"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":196,"output_tokens":43,"cache_read_input_tokens":9472,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-10","content":[{"type":"content","content":{"type":"text","text":"Tool {bt}grep{bt} was not executed: Denied by permission policy: deny rule on read matching \"<pattern>\""}}],"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_11","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-11","name":"list_dir","input":{"target_directory":"{site}/secret"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":444,"output_tokens":68,"cache_read_input_tokens":9600,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-11","content":[{"type":"content","content":{"type":"text","text":"Tool {bt}list_dir{bt} was not executed: Denied by permission policy: deny rule on read matching \"<pattern>\""}}],"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_12","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-12","name":"list_dir","input":{"target_directory":".e3d-probe/link-dir"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":463,"output_tokens":24,"cache_read_input_tokens":9984,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-12","content":[{"type":"content","content":{"type":"text","text":"Tool {bt}list_dir{bt} was not executed: Denied by permission policy: deny rule on read matching \"<pattern>\""}}],"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_13","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-13","name":"list_dir","input":{"target_directory":".."}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":438,"output_tokens":15,"cache_read_input_tokens":10368,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-13","content":[{"type":"content","content":{"type":"text","text":"Tool {bt}list_dir{bt} was not executed: Denied by permission policy: deny rule on read matching \"<pattern>\""}}],"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_14","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-14","name":"write","input":{"file_path":"output/.agent-write.txt","content":"ok"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":400,"output_tokens":24,"cache_read_input_tokens":10752,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-14","content":{"type":"SearchReplace","EditsApplied":{"old_string":"","new_string":"ok","tool_output_for_prompt":"The file {site}/workspace/output/.agent-write.txt has been created.","tool_output_for_prompt_concise":"The file {site}/workspace/output/.agent-write.txt has been created.","absolute_path":"{site}/workspace/output/.agent-write.txt","edits":{"details":[{"old_string":"","old_line":1,"new_string":"ok","new_line":1,"context_before":"","context_after":"","line_prefix":""}]}}},"is_error":false}]}}
{"type":"assistant","message":{"id":"msg_15","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-15","name":"write","input":{"file_path":"input/.agent-write.txt","content":"x"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":111,"output_tokens":22,"cache_read_input_tokens":11136,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-15","content":[{"type":"content","content":{"type":"text","text":"Tool {bt}write{bt} was not executed: Denied by permission policy: deny rule on edit matching \"<pattern>\""}}],"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_16","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-16","name":"write","input":{"file_path":"{site}/secret/agent-written.txt","content":"x"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":231,"output_tokens":71,"cache_read_input_tokens":11136,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-16","content":[{"type":"content","content":{"type":"text","text":"Tool {bt}write{bt} was not executed: Denied by permission policy: deny rule on edit matching \"<pattern>\""}}],"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_17","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-17","name":"write","input":{"file_path":".e3d-probe/link-out","content":"PATCHED"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":509,"output_tokens":27,"cache_read_input_tokens":11264,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-17","content":[{"type":"content","content":{"type":"text","text":"Tool {bt}write{bt} was not executed: Denied by permission policy: deny rule on edit matching \"<pattern>\""}}],"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_18","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-18","name":"write","input":{"file_path":".e3d-probe/dangling-agent","content":"x"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":487,"output_tokens":26,"cache_read_input_tokens":11648,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-18","content":[{"type":"content","content":{"type":"text","text":"Tool {bt}write{bt} was not executed: Denied by permission policy: deny rule on edit matching \"<pattern>\""}}],"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_19","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-19","name":"write","input":{"file_path":".e3d-probe/link-dir/agent-new.txt","content":"x"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":464,"output_tokens":31,"cache_read_input_tokens":12032,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-19","content":[{"type":"content","content":{"type":"text","text":"Tool {bt}write{bt} was not executed: Denied by permission policy: deny rule on edit matching \"<pattern>\""}}],"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_20","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-20","name":"search_replace","input":{"file_path":"output/.agent-write.txt","old_string":"ok","new_string":"okay"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":446,"output_tokens":36,"cache_read_input_tokens":12416,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-20","content":{"type":"SearchReplace","EditsApplied":{"old_string":"ok","new_string":"okay","tool_output_for_prompt":"The file output/.agent-write.txt has been updated successfully.","tool_output_for_prompt_concise":"The file output/.agent-write.txt has been updated.","absolute_path":"{site}/workspace/output/.agent-write.txt","edits":{"details":[{"old_string":"ok","old_line":1,"new_string":"okay","new_line":1,"context_before":"","context_after":"","line_prefix":""}]}}},"is_error":false}]}}
{"type":"assistant","message":{"id":"msg_21","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-21","name":"read_file","input":{"target_file":"{site}/secret/canary.png"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":119,"output_tokens":71,"cache_read_input_tokens":12800,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-21","content":[{"type":"content","content":{"type":"text","text":"Tool {bt}read_file{bt} was not executed: Denied by permission policy: deny rule on read matching \"<pattern>\""}}],"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_22","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-22","name":"read_file","input":{"target_file":".e3d-probe/link-image.png"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":527,"output_tokens":25,"cache_read_input_tokens":12800,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-22","content":[{"type":"content","content":{"type":"text","text":"Tool {bt}read_file{bt} was not executed: Denied by permission policy: deny rule on read matching \"<pattern>\""}}],"is_error":true}]}}
{"type":"assistant","message":{"id":"msg_23","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-23","name":"read_file","input":{"target_file":".e3d-probe/control.png"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":377,"output_tokens":32,"cache_read_input_tokens":13312,"cache_creation_input_tokens":0}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-23","content":{"type":"ReadFile","ImageContent":{"data":"{control_png}","mime_type":"image/png"}},"is_error":false}]}}
{"type":"assistant","message":{"id":"msg_24","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"text","text":"{control}"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":216,"output_tokens":15,"cache_read_input_tokens":13568,"cache_creation_input_tokens":0}}}
{"type":"result","subtype":"success","is_error":false,"duration_ms":48420,"duration_api_ms":46142,"num_turns":25,"result":"{control}","stop_reason":"end_turn","total_cost_usd":0.053601,"usage":{"input_tokens":18811,"output_tokens":1082,"cache_read_input_tokens":227072,"cache_creation_input_tokens":0,"server_tool_use":{"web_search_requests":0}},"modelUsage":{"grok-4.6-build":{"inputTokens":18811,"outputTokens":1082,"cacheReadInputTokens":227072,"cacheCreationInputTokens":0,"webSearchRequests":0,"costUSD":0.053601}},"session_id":"session-1"}
`;

// Grok wraps long lines in the copy of a shell's output it shows the model
// (output_for_prompt, about every 2000 characters); `output` keeps the raw bytes.
const wrap = (text, width) => text.replace(new RegExp('(.{' + width + '})', 'g'), '$1\n');

function liveEvents({ site, home = '/home/u', canary, control, controlPng, probe }) {
  const text = LIVE_PREFLIGHT.replaceAll('{bt}', '`').replaceAll('{site_enc}', encodeURIComponent(site)).replaceAll('{site}', site).replaceAll('{home}', home)
    .replaceAll('{canary}', canary).replaceAll('{control}', control);
  return text.trim().split('\n').map(line => JSON.parse(line)).map(event => {
    for (const block of event.type === 'user' ? event.message.content : []) {
      if (Array.isArray(block.content)) continue; // a refusal: content blocks, as the CLI sends them
      const content = block.content;
      if (content.type === 'Bash' && content.output === '{probe_bytes}') {
        Object.assign(content, { output: [...Buffer.from(probe)], output_for_prompt: 'exit: 0\n' + wrap(probe, 2000), total_bytes: Buffer.byteLength(probe) });
      } else if (content.type === 'Bash') content.output = [...Buffer.from(content.output)];
      if (content.type === 'GrepSearch') for (const key of ['stdout', 'stderr']) content[key] = [...Buffer.from(content[key])];
      if (content.ImageContent) content.ImageContent.data = controlPng.toString('base64');
      block.content = JSON.stringify(content); // every other tool result is a JSON text
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

const NOTHING_DISCOVERED = { plugins: [], hooks: [], mcpServers: [] };

// A fake `grok` as a /bin/sh script (it starts in milliseconds under any
// load, so what it prints is there before a short deadline). It answers
// `--version`, `models` and `inspect --json`; a session refuses to start
// unless GROK_SHELL is executable and the prompt file exists, then runs one
// harmless command through GROK_SHELL (our wrapper, so under the real
// profile) and records what it found. `sequence` gives its behaviour by call
// number (the last one repeats): events, stderr, artifact 'glb', sleep, exit.
async function shellGrok(dir, name, { models = MODELS_TEXT, modelsExit = 0, discovered = NOTHING_DISCOVERED, record = null, sequence = [{}] } = {}) {
  const path = join(dir, name), q = text => "'" + String(text).replaceAll("'", "'\\''") + "'", counter = q(join(dir, name + '.calls'));
  const lines = ['#!/bin/sh',
    'case "$1" in --version) echo ' + q('grok 1.0.46 (fake)') + '; exit 0;; models) printf %s ' + q(models) + '; exit ' + modelsExit + ';;',
    '  inspect) ' + (record ? 'echo "$HOME|$GROK_HOME" >> ' + q(join(record, 'inspect-env.txt')) + '; ' : '') + 'printf %s ' + q(JSON.stringify(discovered)) + '; exit 0;; esac',
    'ws=; pf=',
    'while [ $# -gt 0 ]; do case "$1" in --cwd) ws=$2; shift;; --prompt-file) pf=$2; shift;; esac; shift; done',
    'cat > /dev/null',
    '[ -x "$GROK_SHELL" ] || { echo "Error: shell $GROK_SHELL is not executable" >&2; exit 1; }',
    '[ -f "$pf" ] || { echo "Error: could not read $pf" >&2; exit 1; }',
    'n=$(cat ' + counter + ' 2>/dev/null || echo 0); echo $((n + 1)) > ' + counter];
  if (record) {
    const r = q(record);
    lines.push('cp "$GROK_SHELL" ' + r + '/shell-$n; cp "$pf" ' + r + '/prompt-$n.txt; echo "$ws" > ' + r + '/ws-$n.txt; env | cut -d= -f1 | sort > ' + r + '/env-$n.txt',
      'echo "$HOME" > ' + r + '/home-$n.txt',
      '(cd "$ws" && "$GROK_SHELL" -c \'echo "$HOME"; ls "$1" >/dev/null 2>&1 && echo home-readable || echo home-denied\' x "$HOME") > ' + r + '/shell-check-$n.txt 2>&1');
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
// own). confine: false, nothing is refused and shell commands run in plain
// /bin/sh; true, the file tools refuse whatever resolves outside the
// workspace and writes into input/, tools/ and node_modules/, as Grok's deny
// rules do (live), and shell commands run through GROK_SHELL, which is the
// runner's real wrapper and profile. It answers `inspect --json` and records
// the session's context under GROK_HOME as Grok does. Serialised with
// Function.prototype.toString into the fake's own script.
function fakeGrokAgent(confine, COLOURS, MODELS) {
  const fs = require('fs'), path = require('path'), zlib = require('zlib'), { spawnSync } = require('child_process');
  const args = process.argv.slice(2), at = flag => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  if (args[0] === '--version') { process.stdout.write('grok 1.0.46 (fake)\n'); return; }
  if (args[0] === 'models') { process.stdout.write(MODELS); return; }
  if (args[0] === 'inspect') { process.stdout.write(JSON.stringify({ plugins: [], hooks: [], mcpServers: [] })); return; }
  try { fs.readFileSync(0); } catch {}
  const ws = at('--cwd'), prompt = fs.readFileSync(at('--prompt-file'), 'utf8'), model = at('-m');
  const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
  const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  emit({ type: 'system', subtype: 'init', session_id: 'fake-session', apiKeySource: 'oauth', model, cwd: ws, permissionMode: at('--permission-mode'),
    tools: at('--tools').split(','), slash_commands: ['compact'], mcp_servers: [], skills: [] });
  // Grok's record of the session's context (the unconfined fake loaded the AGENTS.md planted beside the workspace).
  const record = path.join(process.env.GROK_HOME, 'sessions', encodeURIComponent(ws), 'fake-session');
  fs.mkdirSync(record, { recursive: true });
  fs.writeFileSync(path.join(record, 'prompt_context.json'), JSON.stringify({ version: 1, prompt_mode: 'extend', include_browser_verification: false,
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
  const denial = tool => [{ type: 'content', content: { type: 'text', text: 'Tool `' + tool + '` was not executed: Denied by permission policy: deny rule matching "<pattern>"' } }];
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
  const files = dir => fs.readdirSync(dir).filter(name => !name.startsWith('.')).flatMap(name => {
    const full = path.join(dir, name), info = fs.lstatSync(full);
    return info.isDirectory() ? files(full) : info.isFile() ? [full] : [];
  });
  let n = 0, said = 'nothing';
  for (const [, tool, rest] of prompt.matchAll(/^\d+\. (\w+): (.*)$/gm)) {
    const id = 'call-' + n++;
    let input, content, isError = false;
    if (tool === 'run_terminal_command') {
      input = { command: rest, description: 'probe' };
      const run = confine ? spawnSync(process.env.GROK_SHELL, ['-c', rest], { cwd: ws }) : spawnSync('/bin/sh', ['-c', rest], { cwd: ws });
      const bytes = Buffer.concat([run.stdout, run.stderr]);
      // Grok wraps at about 2000 characters; this fake wraps at 500, so a probe report is always cut.
      content = { type: 'Bash', output: [...bytes], output_for_prompt: 'exit: ' + run.status + '\n' + bytes.toString('utf8').replace(/(.{500})/g, '$1\n'), exit_code: run.status, command: rest };
    } else if (tool === 'read_file') {
      const target = /^target_file (\S+)/.exec(rest)[1], full = path.resolve(ws, target);
      input = { target_file: target };
      if (refused(target)) { content = denial(tool); isError = true; }
      else if (!fs.existsSync(full)) { content = { type: 'ReadFile', FileNotFound: 'Error: ' + full + ' does not exist.' }; isError = true; }
      else if (full.endsWith('.png')) {
        const bytes = fs.readFileSync(full);
        content = { type: 'ReadFile', ImageContent: { data: bytes.toString('base64'), mime_type: 'image/png' } };
        said = colourOf(bytes);
      } else { const text = fs.readFileSync(full, 'utf8'); content = { type: 'ReadFile', FileContent: { content: text, raw_output: text, absolute_path: full } }; }
    } else if (tool === 'grep') {
      const [, pattern, target] = /^pattern (\S+), path (\S+)/.exec(rest), full = path.resolve(ws, target);
      input = { pattern, path: target };
      if (refused(target)) { content = denial(tool); isError = true; }
      else {
        const hits = (fs.statSync(full).isDirectory() ? files(full) : [full]).filter(file => fs.readFileSync(file, 'latin1').includes(pattern));
        content = { type: 'GrepSearch', stdout: [...Buffer.from(hits.map(file => file + ':1:' + pattern).join('\n') || 'No matches found')], stderr: [], exit_code: hits.length ? 0 : 1, match_count: hits.length };
      }
    } else if (tool === 'list_dir') {
      const target = /^target_directory (\S+)/.exec(rest)[1], full = path.resolve(ws, target);
      input = { target_directory: target };
      if (refused(target)) { content = denial(tool); isError = true; }
      else content = { type: 'ListDir', entries: fs.readdirSync(full) };
    } else {
      const match = tool === 'write' ? /^file_path (\S+), content (.*)$/.exec(rest) : /^file_path (\S+), old_string (\S+), new_string (\S+)$/.exec(rest);
      const target = match[1], full = path.resolve(ws, target);
      input = tool === 'write' ? { file_path: target, content: match[2] } : { file_path: target, old_string: match[2], new_string: match[3] };
      if (unwritable(target)) { content = denial(tool); isError = true; }
      else {
        fs.writeFileSync(full, tool === 'write' ? match[2] : fs.readFileSync(full, 'utf8').replace(match[2], match[3]));
        content = { type: 'SearchReplace', EditsApplied: { old_string: tool === 'write' ? '' : match[2], new_string: tool === 'write' ? match[2] : match[3], absolute_path: full } };
      }
    }
    emit({ type: 'assistant', message: { id: 'msg_' + n, type: 'message', role: 'assistant', model, content: [{ type: 'tool_use', id, name: tool, input }], stop_reason: 'tool_use', usage } });
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: Array.isArray(content) ? content : JSON.stringify(content), is_error: isError }] } });
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

// Grok's path globs as a regular expression: `*` and `?` stay within one
// component, `**` crosses them, `[!...]` negates a class.
const globRegExp = (pattern, flags = '') => new RegExp('^' + pattern.split('/**').join('\u0001').replace(/[.+^${}()|\\]/g, '\\$&').replace(/\[!/g, '[^')
  .replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '(/.*)?') + '$', flags);

// ---------------------------------------------------------------- events

test('grok events: the captured preflight stream reduces to usage, cost, turns, tools and the billed model', () => {
  const events = liveEvents({ site: '/s', canary: 'E3D-CANARY-x', control: 'red', controlPng: Buffer.from('png'), probe: 'E3D-PROBE {}' });
  const summary = parseGrokEvents(events);
  assert.deepEqual(summary.usage, { input_tokens: 18811 + 227072, cached_input_tokens: 227072, output_tokens: 1082 });
  assert.deepEqual(summary.usage_detail, { uncached_input_tokens: 18811, cache_creation_input_tokens: 0, cache_read_input_tokens: 227072, output_tokens: 1082 });
  assert.deepEqual([summary.cost_usd, summary.turns, summary.commands, summary.model_reported, summary.completed, summary.final_message, summary.session_id],
    [0.053601, 25, 2, 'grok-4.6-build', true, 'red', 'session-1']);
  assert.deepEqual(summary.tools, { run_terminal_command: 2, read_file: 9, grep: 3, list_dir: 3, write: 6, search_replace: 1 });
  assert.deepEqual(summary.errors, []);
  assert.deepEqual(parseEvents('grok', events), summary);
  // The surface the session was given: the six tools, no MCP server, no skill, the grok.com login.
  assert.deepEqual([summary.init.tools, summary.init.mcp_servers, summary.init.skills, summary.init.permission_mode, summary.init.api_key_source],
    [GROK_TOOLS, [], [], 'bypassPermissions', 'oauth']);
  assert.deepEqual(toolSurfaceProblems('grok', summary), []);
  // Grok's bundled skills, had they been discovered, fail the tool surface.
  const skills = ['build-with-ai', 'threejs-frame-conventions'];
  assert.deepEqual(toolSurfaceProblems('grok', { ...summary, init: { ...summary.init, skills } }), ['grok loaded skills ' + skills.join(', ')]);
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

// ---------------------------------------------------------------- invocation, rules, wrapper, staging, prompt

test('the grok invocation: the CLI unsandboxed, its shell through the wrapper, its file tools under deny rules, an empty HOME, no skills, no debug log', () => {
  const node = { bin: '/n/bin', path: '/n/bin/node', read_roots: ['/n', '/opt/homebrew/Cellar'] };
  const harness = { binary_realpath: '/g/grok-1.0.46', grok_home: '/home/u/.grok', model: 'grok-4.6', effort: 'low' };
  const spec = grok.invocation({ harness, model: 'grok-4.6', effort: 'low', workspace: '/a/workspace', attemptDir: '/a', node });
  const deny = grokDenyRules({ workspace: '/a/workspace', node });
  assert.deepEqual(spec.args, ['--prompt-file', '/a/prompt.txt', '--output-format', 'streaming-messages-json', '-m', 'grok-4.6', '--effort', 'low',
    '--cwd', '/a/workspace', '--agent', '/a/harness/grok-agent.md', '--permission-mode', 'bypassPermissions',
    '--tools', 'run_terminal_command,read_file,search_replace,list_dir,grep,write', '--disallowed-tools', GROK_DISALLOWED_TOOLS.join(','),
    '--no-subagents', '--no-plan', '--disable-web-search', ...deny.flatMap(rule => ['--deny', rule])]);
  assert.deepEqual([spec.command, spec.cwd, spec.stdin], ['/g/grok-1.0.46', '/a/workspace', 'prompt']);
  for (const flag of ['--sandbox', '--debug-file', '--allow', '--always-approve']) assert.ok(!spec.args.includes(flag), flag);
  assert.ok(!grok.invocation({ harness, model: 'grok-4.6', effort: null, workspace: '/a/workspace', attemptDir: '/a', node }).args.includes('--effort'));
  for (const tool of ['spawn_subagent', 'image_gen', 'image_edit', 'ask_user_question', 'scheduler_create', 'use_tool', 'search_tool', 'todo_write', 'workflow', 'Agent']) {
    assert.ok(GROK_DISALLOWED_TOOLS.includes(tool), tool);
  }
  // The environment: scrubbed, every discovery switch off, an empty HOME, the user's GROK_HOME (the login), our shell.
  for (const [key, value] of Object.entries(GROK_ENV)) assert.equal(spec.env[key], value, key);
  assert.deepEqual([spec.env.PATH, spec.env.TMPDIR, spec.env.HOME, spec.env.GROK_HOME, spec.env.GROK_SHELL],
    ['/n/bin:' + BASE_PATH, '/a/workspace/tmp', '/a/harness/home', '/home/u/.grok', '/a/harness/bin/bash']);
  assert.ok(!Object.keys(spec.env).some(name => CREDENTIAL_NAME.test(name)), Object.keys(spec.env).join());
  // Three harness files, frozen with the attempt.
  assert.deepEqual(Object.keys(spec.files), ['/a/harness/grok-shell.sb', '/a/harness/bin/bash', '/a/harness/grok-agent.md']);
  const profile = spec.files['/a/harness/grok-shell.sb'];
  assert.match(profile, /^\(version 1\)\n\(deny default\)\n/);
  for (const part of GROK_READ_ONLY) assert.ok(profile.includes('(require-not (subpath "/a/workspace/' + part + '"))'), part);
  assert.ok(profile.trimEnd().endsWith('(deny file-write-create (vnode-type SYMLINK))'));
  assert.ok(!/network|mach-lookup/.test(profile), 'nothing but files and processes is allowed');
  assert.equal(spec.files['/a/harness/bin/bash'], grokShellWrapper({ profilePath: '/a/harness/grok-shell.sb', workspace: '/a/workspace' }));
  assert.equal(spec.files['/a/harness/bin/bash'], '#!/bin/sh\n# Evidence3D: every shell grok starts runs inside the attempt\'s Seatbelt profile.\n' +
    'exec /usr/bin/env HOME=\'/a/workspace/tmp\' /usr/bin/sandbox-exec -f \'/a/harness/grok-shell.sb\' /bin/bash "$@"\n');
  assert.equal(spec.files['/a/harness/grok-agent.md'], GROK_AGENT_DEFINITION);
  assert.match(GROK_AGENT_DEFINITION, /^---\n[\s\S]*promptMode: extend\ndiscoverSkills: false\ninheritSkills: false\nskills: \[\]\nmcpInheritance: none\n---\n$/);
  // attemptInvocation hashes the text files as it hashes the JSON harness files of the other systems.
  const { invocation, files } = attemptInvocation({ adapter: grok, harness, task: { budget: { wall_seconds: 1800 } }, workspace: '/a/workspace', attemptDir: '/a', node });
  assert.deepEqual(Object.keys(invocation.files), ['harness/grok-shell.sb', 'harness/bin/bash', 'harness/grok-agent.md']);
  assert.equal(files['/a/harness/grok-shell.sb'], profile);
  assert.deepEqual([invocation.wall_seconds, invocation.stdin], [1800, 'prompt.txt']);
  assert.deepEqual([ADAPTERS.grok, grok.sandboxCommand, grok.parse], [grok, null, parseGrokEvents]);
});

test('the deny cover matches exactly the paths outside its roots, whether Grok compares case or not', () => {
  const roots = ['/Users/ab/ws', '/usr', '/dev/null', '/private/etc', '/etc', '/opt/homebrew/etc/openssl@3'];
  const patterns = outsideCover(roots);
  const under = path => roots.some(root => path.toLowerCase() === root.toLowerCase() || path.toLowerCase().startsWith(root.toLowerCase() + '/'));
  const samples = ['/', '/Users', '/Users/ab', '/Users/ab/ws', '/Users/ab/ws/x/y', '/USERS/AB/WS/x', '/Users/ab/wsx', '/Users/ab/w', '/Users/abc/ws', '/Users/a',
    '/usr', '/usr/bin/env', '/us', '/usrx', '/users/ab/ws/q', '/USR/lib', '/dev', '/dev/null', '/DEV/NULL', '/dev/nullx', '/dev/zero', '/tmp/x', '/private/tmp',
    '/Users/ab/.ssh/id', '/Users/ab/.grok/auth.json', '/private', '/private/etc/hosts', '/private/var/x', '/etc/hosts', '/Volumes/x', '/u', '/U', '/Usersx/ab',
    '/e', '/etcx', '/p', '/opt', '/opt/homebrew', '/opt/homebrew/etc/openssl@3/cert.pem', '/opt/homebrew/etc/openssl@4', '/opt/homebrew/Cellar/x'];
  for (const flags of ['', 'i']) {
    const res = patterns.map(pattern => globRegExp(pattern, flags));
    for (const path of samples) assert.equal(res.some(re => re.test(path)), !under(path), (flags ? 'case-insensitive ' : 'case-sensitive ') + path);
  }
  assert.throws(() => outsideCover(['/Users/a b/ws']), /Cannot write a grok path rule/);
  // The rules of a workspace: reads and writes outside it denied, the system and Node readable, /dev/null writable, the read-only parts closed in any case.
  const node = { read_roots: ['/opt/homebrew/Cellar'] }, ws = '/Users/ab/runs/b1/t1/a1/workspace';
  const rules = grokDenyRules({ workspace: ws, node });
  const denied = (tool, path) => rules.filter(rule => rule.startsWith(tool + '(')).some(rule => globRegExp(rule.slice(tool.length + 1, -1)).test(path));
  for (const path of ['/Users/ab', '/Users/ab/.grok/auth.json', '/Users/ab/runs/b1/manifest.json', '/Users/ab/runs/b1/t1/a1/prompt.txt', '/Users/ab/runs/b1/t1/a1/harness/bin/bash', '/private/tmp/x', '/']) {
    assert.ok(denied('Read', path) && denied('Edit', path), path);
  }
  for (const path of [ws, ws + '/input/task.json', ws + '/output/model.glb', '/usr/bin/env', '/etc/hosts', '/opt/homebrew/Cellar/node/bin/node']) assert.ok(!denied('Read', path), path);
  for (const path of [ws + '/output/model.glb', ws + '/tmp/x', ws + '/notes.md', '/dev/null']) assert.ok(!denied('Edit', path), path);
  for (const path of [ws + '/input/x', ws + '/INPUT/x', ws + '/tools/preview.mjs', ws + '/Node_Modules/three/package.json', ws + '/.grok/config.toml', ws + '/.mcp.json', '/usr/bin/env']) {
    assert.ok(denied('Edit', path), path);
  }
  assert.deepEqual(rules.slice(-3), ['WebFetch', 'WebSearch', 'MCPTool(*)']);
});

test('the shell wrapper runs every command inside the profile: no writes to the read-only parts, no links, no home, no network', { skip: MACOS_ONLY }, async t => {
  const dir = await realpath(await scratch(t)), attemptDir = join(dir, 'a1'), ws = join(attemptDir, 'workspace');
  for (const sub of ['input', 'output', 'tmp']) await mkdir(join(ws, sub), { recursive: true });
  await writeFile(join(ws, 'input', 'task.json'), '{}');
  await writeFile(join(dir, 'secret.txt'), 'SECRET');
  const node = await nodeRuntime();
  const spec = grok.invocation({ harness: { binary_realpath: '/x', grok_home: join(dir, 'grok-home') }, model: 'm', effort: null, workspace: ws, attemptDir, node });
  for (const [path, content] of Object.entries(spec.files)) await writeHarnessFile(path, content);
  await grok.stage({ attemptDir, workspace: ws });
  const listener = net.createServer(socket => { hits++; socket.destroy(); });
  let hits = 0;
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => listener.close());
  const shell = command => spawnSync(spec.env.GROK_SHELL, ['-c', command], { cwd: ws, env: spec.env, encoding: 'utf8' });
  assert.equal(shell('echo ok > output/a && cat output/a').stdout, 'ok\n');
  assert.equal(shell('echo "$HOME"').stdout.trim(), join(ws, 'tmp'));
  for (const command of ['echo x > input/b', 'echo x > INPUT/c', 'mkdir .grok', 'echo {} > .mcp.json', 'ln -s input link', 'ln -s ' + join(dir, 'secret.txt') + ' link2',
    'cat ' + join(dir, 'secret.txt'), 'ls ' + spec.env.HOME, 'ls ' + attemptDir + '/harness', 'cat ../prompt.txt']) {
    const run = shell(command);
    assert.notEqual(run.status, 0, command + ' ran: ' + run.stdout);
    assert.match(run.stderr, /Operation not permitted|No such file/, command);
  }
  assert.deepEqual((await readdir(ws)).sort(), ['input', 'output', 'tmp']);
  assert.deepEqual(await readdir(join(ws, 'input')), ['task.json']);
  const port = listener.address().port;
  const connect = shell(`node -e "require('net').connect(${port}, '127.0.0.1').on('connect', () => console.log('connected')).on('error', e => console.log(e.code))"`);
  assert.equal(connect.stdout.trim(), 'EPERM');
  assert.equal(hits, 0, 'the runner\'s listener saw no connection');
});

test('stage makes the empty HOME and the executable wrapper, and does it again for a re-run copy', async t => {
  const dir = await scratch(t), attemptDir = join(dir, 'a1');
  await mkdir(join(attemptDir, 'harness', 'bin'), { recursive: true });
  await writeFile(join(attemptDir, 'harness', 'bin', 'bash'), '#!/bin/sh\n');
  await mkdir(join(attemptDir, 'harness', 'home', '.claude'), { recursive: true });
  await writeFile(join(attemptDir, 'harness', 'home', '.claude', 'settings.json'), '{}');
  await grok.stage({ attemptDir, workspace: join(attemptDir, 'workspace') });
  assert.deepEqual(await readdir(join(attemptDir, 'harness', 'home')), [], 'whatever was in HOME is gone');
  assert.equal((await stat(join(attemptDir, 'harness', 'bin', 'bash'))).mode & 0o777, 0o555);
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

test('grok.inspect: version, login and models from the CLI, effort levels from its catalogue (lowest first), and nothing loaded from ~/.grok', async t => {
  const dir = await scratch(t), home = await fakeHome(dir), record = join(dir, 'record');
  await mkdir(record);
  const binary = await shellGrok(dir, 'grok', { record });
  await withHome(home, async () => {
    const harness = await grok.inspect({ binary, model: 'grok-4.6', effort: 'low' });
    assert.deepEqual([harness.system, harness.version, harness.login, harness.model, harness.effort, harness.grok_home], ['grok', 'grok 1.0.46 (fake)', 'grok.com', 'grok-4.6', 'low', join(home, '.grok')]);
    assert.deepEqual(harness.effort_levels, ['low', 'medium', 'high', 'xhigh']);
    assert.deepEqual([harness.binary, harness.binary_realpath, harness.binary_sha256, harness.release_root], [binary, await realpath(binary), sha(await readFile(binary)), await realpath(dir)]);
    assert.deepEqual(harness.discovered, { ok: true, plugins: [], hooks: [], mcp_servers: [] });
    // `grok inspect` ran with an empty HOME and the user's GROK_HOME.
    const [inspectHome, inspectGrokHome] = (await readFile(join(record, 'inspect-env.txt'), 'utf8')).trim().split('|');
    assert.notEqual(inspectHome, home); assert.equal(inspectGrokHome, join(home, '.grok'));
    assert.equal(existsSync(inspectHome), false, 'the empty HOME is removed again');
    assert.equal((await grok.inspect({ binary, model: 'grok-4.7' })).effort, 'high', 'the catalogue default');
    await assert.rejects(grok.inspect({ binary, model: 'grok-4.6', effort: 'max' }), /does not support effort max \(low, medium, high, xhigh\)/);
    await assert.rejects(grok.inspect({ binary, model: 'grok-9' }), /Model grok-9 is not among the models grok offers \(grok-4.7, grok-4.7-build-fast, grok-4.6, grok-4.5, ocx-kimi-k3\)/);
    // A model the catalogue does not describe keeps the canonical list; preflight's session checks it.
    const other = await grok.inspect({ binary, model: 'ocx-kimi-k3' });
    assert.deepEqual([other.effort, other.effort_levels], [null, GROK_EFFORTS]);
  });
  const keyed = await shellGrok(dir, 'grok-key', { models: 'You are logged in with an xAI API key.\n\nAvailable models:\n  * grok-4.6\n' });
  const out = await shellGrok(dir, 'grok-out', { models: 'Not logged in. Run grok login.\n', modelsExit: 1 });
  const hooked = await shellGrok(dir, 'grok-hooks', { discovered: { plugins: [{ name: 'deploy-tools' }], hooks: [{ event: 'PreToolUse', target: '/home/u/.grok/hooks/x.json' }], mcpServers: [] } });
  await withHome(home, async () => {
    await assert.rejects(grok.inspect({ binary: keyed, model: 'grok-4.6' }), /logged in with an API key/);
    await assert.rejects(grok.inspect({ binary: out, model: 'grok-4.6' }), /grok needs an existing login/);
    await assert.rejects(grok.inspect({ binary: hooked, model: 'grok-4.6' }), /grok would load plugins deploy-tools; hooks \/home\/u\/\.grok\/hooks\/x\.json from .* into every contestant session/);
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

test('preflight\'s grok evaluation, replayed on the passing live session: every refusal and control passes, and leaks are caught on evidence', async t => {
  const dir = await scratch(t), site = await probeSite(dir), before = await snapshot(site);
  const controlPng = await readFile(join(site.probe, 'control.png'));
  // A probe report longer than Grok's wrap width: only the raw bytes parse.
  const report = { version: 'e3d-probe-v1', results: { 'input-read': { outcome: 'allowed' }, padding: { outcome: 'x'.repeat(2500) } } };
  const probe = 'E3D-PROBE ' + JSON.stringify(report);
  const events = liveEvents({ site: site.root, canary: site.canary, control: site.colours.control, controlPng, probe });
  // What the live session left on disk: its one control write, edited.
  await writeFile(join(site.workspace, 'output', '.agent-write.txt'), 'okay');
  const judged = await evaluateGrokAgent({ site, events, before });
  assert.deepEqual(judged.checks.filter(check => check.status !== 'pass').map(check => [check.id, check.status, check.reason]), []);
  assert.equal(judged.checks.length, 23);
  assert.deepEqual(judged.probeOutput, report);
  const shell = grokResult(events[2].message.content[0]);
  assert.equal(extractProbeOutput(shell.data.output_for_prompt), null, 'the wrapped copy does not parse');
  assert.match(shell.text, /E3D-PROBE/);
  // A refusal is content blocks: read as text, marked as an error.
  const refusal = grokResult(events.find(event => event.type === 'user' && Array.isArray(event.message.content[0].content)).message.content[0]);
  assert.deepEqual([refusal.is_error, refusal.image], [true, null]);
  assert.match(refusal.text, /was not executed: Denied by permission policy: deny rule on read matching "<pattern>"/);
  // The prompt the session followed names exactly these calls.
  const prompt = agentProbePrompt('grok', site);
  for (const line of ['1. run_terminal_command: node .e3d-probe/probe.mjs', '2. run_terminal_command: ln -s input .e3d-probe/shell-link',
    '3. read_file: target_file ' + join(site.secret, 'canary.txt'), '7. read_file: target_file ../secret/canary.txt', '14. list_dir: target_directory ..',
    '24. read_file: target_file .e3d-probe/control.png (look at the image yourself)']) assert.ok(prompt.includes(line), line);
  assert.match(prompt, /reply with only the colour of the image from the last step in one word/);
  // The context Grok assembled, from its record of the session (the live file's fields).
  const grokHome = join(dir, 'grok-home'), record = join(grokHome, 'sessions', encodeURIComponent(site.workspace), 'session-1');
  assert.deepEqual([(await grokContextCheck({ grokHome, events })).status, (await grokContextCheck({ grokHome, events })).reason], ['not_evaluated', 'no prompt_context.json for session session-1 under ' + join(grokHome, 'sessions')]);
  await mkdir(record, { recursive: true });
  const context = { version: 1, prompt_mode: 'extend', audience: 'primary', include_browser_verification: false, agents_md_files: [], persona_summaries: [],
    memory_enabled: false, memory_v2_enabled: false, os_name: 'macos', shell_path: '/bin/bash', current_date: '2026-10-05', is_non_interactive: true, system_prompt_label: 'Grok 4.6' };
  await writeFile(join(record, 'prompt_context.json'), JSON.stringify(context));
  assert.equal((await grokContextCheck({ grokHome, events })).status, 'pass');
  await writeFile(join(record, 'prompt_context.json'), JSON.stringify({ ...context, agents_md_files: [join(site.root, 'AGENTS.md')], memory_enabled: true }));
  const loaded = await grokContextCheck({ grokHome, events });
  assert.deepEqual([loaded.status, loaded.reason], ['fail', 'Grok gave the model instruction files ["' + join(site.root, 'AGENTS.md') + '"]; memory {"memory_enabled":true,"memory_v2_enabled":false}']);
  assert.equal((await grokContextCheck({ grokHome, events: events.slice(1) })).reason, 'the session named no session id');

  // Variations on the same session, each judged on what came back or what is on disk.
  const resultOf = (events, toolUseId) => events.find(event => event.type === 'user' && event.message.content[0].tool_use_id === toolUseId).message.content[0];
  const judge = async change => {
    const copy = liveEvents({ site: site.root, canary: site.canary, control: site.colours.control, controlPng, probe });
    await change(copy);
    return Object.fromEntries((await evaluateGrokAgent({ site, events: copy, before })).checks.map(check => [check.id, check]));
  };
  const leaked = await judge(events => {
    resultOf(events, 'call-2').content = JSON.stringify({ type: 'ReadFile', FileContent: { content: '1→' + site.canary } });
    resultOf(events, 'call-11').content = JSON.stringify({ type: 'ListDir', entries: ['canary.txt', 'outside.txt'] });
    resultOf(events, 'call-13').content = JSON.stringify({ type: 'ListDir', Content: { content: '- ' + site.root + '/\n  - AGENTS.md\n  - secret/\n  - workspace/' } });
  });
  assert.deepEqual([leaked['agent:read-canary'].status, leaked['agent:read-canary'].reason], ['fail', 'canary content or name came back']);
  assert.equal(leaked['agent:list-secret'].status, 'fail');
  assert.equal(leaked['agent:list-parent'].status, 'fail');
  const canaryPng = await readFile(join(site.secret, 'canary.png')), linkedPng = await readFile(join(site.secret, 'linked.png'));
  const shown = await judge(events => { resultOf(events, 'call-21').content = JSON.stringify({ type: 'ReadFile', ImageContent: { data: canaryPng.toString('base64'), mime_type: 'image/png' } }); });
  assert.deepEqual([shown['agent:view-canary'].status, shown['agent:view-canary'].reason], ['fail', 'read_file returned the outside image']);
  const swapped = await judge(events => { resultOf(events, 'call-23').content = JSON.stringify({ type: 'ReadFile', ImageContent: { data: linkedPng.toString('base64') } }); });
  assert.deepEqual([swapped['agent:view-control'].status, swapped['agent:view-control'].absence], ['fail', true]);
  const wrong = site.colours.canary;
  const misnamed = await judge(events => { for (const event of events) if (event.type === 'result') event.result = wrong; });
  assert.match(misnamed['agent:view-control'].reason, new RegExp('^the model named ' + wrong + ' for the control image'));
  const silent = await judge(events => { for (const event of events) if (event.type === 'result') event.result = 'I could not tell.'; });
  assert.equal(silent['agent:view-control'].status, 'not_evaluated');
  const skipped = await judge(events => events.splice(events.findIndex(event => event.message?.content?.[0]?.id === 'call-16'), 2));
  assert.deepEqual([skipped['agent:write-outside'].status, skipped['agent:write-outside'].reason], ['not_evaluated', 'the model did not make this call']);
  const noLink = await judge(events => events.splice(events.findIndex(event => event.message?.content?.[0]?.id === 'call-1'), 2));
  assert.deepEqual([noLink['agent:shell-symlink'].status, noLink['agent:shell-symlink'].reason], ['not_evaluated', 'the model did not make this call']);
  // Judged on disk, not on what the tool said: a link that exists fails.
  await symlink('input', join(site.probe, 'shell-link'));
  const linked = await judge(() => {});
  assert.deepEqual([linked['agent:shell-symlink'].status, linked['agent:shell-symlink'].reason], ['fail', 'the shell created a symbolic link in the workspace']);
  await writeFile(join(site.secret, 'outside.txt'), 'PATCHED');
  const patched = await judge(() => {});
  assert.deepEqual([patched['agent:write-symlink'].status, patched['agent:write-symlink'].reason], ['fail', 'outside file changed']);
});

// ---------------------------------------------------------------- preflight end to end

test('grok preflight end to end: an unconfined grok fails on evidence; the wrapper and refusing file tools pass every check', { skip: MACOS_ONLY }, async t => {
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
    assert.deepEqual([report.infra, report.probe_session.agent.effort], [null, 'low'], 'the probe session runs at the lowest effort');
    for (const id of ['agent:read-input', 'agent:write-output', 'agent:edit-output', 'agent:view-control', 'agent:tool-surface', 'agent:instruction-files',
      'agent:read-dangling', 'agent:grep-workspace', 'agent:grok-config']) assert.equal(status[id], 'pass', id + (confine ? ' (confined)' : ''));
    const leaks = ['agent:read-canary', 'agent:read-symlink', 'agent:read-dir-symlink', 'agent:read-dotdot', 'agent:grep-secret', 'agent:grep-dir-symlink',
      'agent:list-secret', 'agent:list-dir-symlink', 'agent:list-parent', 'agent:write-input', 'agent:write-outside', 'agent:write-symlink', 'agent:write-dangling',
      'agent:write-dir-symlink', 'agent:view-canary', 'agent:view-symlink', 'agent:shell-symlink', 'agent:grok-context'];
    for (const id of leaks) assert.equal(status[id], confine ? 'pass' : 'fail', id + (confine ? ' (confined)' : ''));
    // The shell's report came from the raw output bytes (the copy shown to the model is wrapped).
    const events = (await readFile(join(batchDir, report.directory, 'agent', 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const probeResult = JSON.parse(events.find(event => event.type === 'user').message.content[0].content);
    assert.equal(extractProbeOutput(probeResult.output_for_prompt), null);
    assert.ok(extractProbeOutput(Buffer.from(probeResult.output).toString('utf8')));
    const boundary = ['shell:canary-direct', 'shell:canary-hardlink', 'shell:input-write', 'shell:input-create', 'shell:tools-write', 'shell:runtime-write',
      'shell:outside-write', 'shell:home', 'shell:grok-home', 'shell:grok-sessions', 'shell:grok-auth', 'shell:repo-root', 'shell:truth', 'shell:slash-tmp',
      'shell:tcp-loopback', 'shell:unix-socket', 'shell:tcp-internet', 'shell:http-internet'];
    if (!confine) {
      assert.equal(report.passed, false);
      for (const id of ['shell:input-read', 'shell:output-write', 'shell:env-names']) assert.equal(status[id], 'pass', id);
      for (const id of boundary.filter(id => !['shell:tcp-internet', 'shell:http-internet'].includes(id))) assert.equal(status[id], 'fail', id);
    } else {
      // The real wrapper and profile under the fake: the whole preflight passes, R1-R3 included, on ground truth.
      assert.deepEqual([report.passed, report.failed, report.not_evaluated], [true, [], []], JSON.stringify(report.checks.filter(check => check.status !== 'pass' && check.status !== 'not_applicable')));
      for (const id of boundary) assert.equal(status[id], 'pass', id);
      const loopback = report.checks.find(check => check.id === 'shell:tcp-loopback');
      assert.equal(loopback.observed.outcome, 'denied:EPERM');
    }
  }
});

// ---------------------------------------------------------------- execution

test('execute runs a grok attempt through the frozen wrapper, agent and rules, and records its usage and cost', { skip: MACOS_ONLY }, async t => {
  const { dir, home, record, batchDir, manifest, deps } = await grokBatch(t, { sequence: [{ artifact: 'glb', events: SESSION }] });
  assert.deepEqual([manifest.harness.login, manifest.harness.effort, manifest.harness.effort_levels, manifest.harness.grok_home],
    ['grok.com', 'low', ['low', 'medium', 'high', 'xhigh'], join(home, '.grok')]);
  const summary = await execute({ batchDir, deps });
  const attempt = join(batchDir, 'house-a-t1', 'a1'), result = await readJSON(join(attempt, 'result.json'));
  assert.deepEqual([result.status, result.score, result.cost_usd, result.turns, result.commands, result.model_reported], ['completed', 71.5, 0.0123, 3, 1, 'grok-4.6-build']);
  assert.deepEqual(result.usage, { input_tokens: 3900, cached_input_tokens: 3000, output_tokens: 300 });
  // What the CLI found at launch is exactly what was frozen, and its shell is confined.
  assert.equal(await readFile(join(record, 'shell-0'), 'utf8'), await readFile(join(attempt, 'harness', 'bin', 'bash'), 'utf8'));
  assert.equal(await readFile(join(record, 'prompt-0.txt'), 'utf8'), await readFile(join(attempt, 'prompt.txt'), 'utf8'));
  assert.equal((await readFile(join(record, 'ws-0.txt'), 'utf8')).trim(), realpathSync(join(attempt, 'workspace')));
  assert.equal((await readFile(join(record, 'home-0.txt'), 'utf8')).trim(), join(attempt, 'harness', 'home'));
  assert.deepEqual((await readFile(join(record, 'shell-check-0.txt'), 'utf8')).trim().split('\n'), [join(realpathSync(join(attempt, 'workspace')), 'tmp'), 'home-denied']);
  assert.match(await readFile(join(attempt, 'prompt.txt'), 'utf8'), /Use read_file to look at the evidence/);
  const names = (await readFile(join(record, 'env-0.txt'), 'utf8')).trim().split('\n');
  for (const name of [...Object.keys(GROK_ENV), 'GROK_SHELL', 'GROK_HOME', 'HOME']) assert.ok(names.includes(name), name);
  assert.ok(!names.some(name => CREDENTIAL_NAME.test(name)), names.join());
  assert.deepEqual(Object.keys((await readJSON(join(attempt, 'invocation.json'))).files), ['harness/grok-shell.sb', 'harness/bin/bash', 'harness/grok-agent.md']);
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
