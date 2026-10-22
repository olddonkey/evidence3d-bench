import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeDataRoot, fakeInstallTools } from '../lib/runner/api/mock/fixtures.mjs';
import { ADAPTERS, antigravity, agyWrapper, agyArgs, AGY_PRINT_MARGIN_SECONDS, nodeRuntime } from '../lib/runner/adapters.mjs';
import { parseAntigravityEvents, parseEvents, toolSurfaceProblems } from '../lib/runner/events.mjs';
import { detectInfra, agyReason, modelTurns } from '../lib/runner/infra.mjs';
import { buildPrompt, TOOL_DESCRIPTIONS } from '../lib/runner/prompt.mjs';
import { buildProbeSite, snapshot, evaluateAntigravityAgent, agentProbePrompt, agyConfigCheck } from '../lib/runner/preflight.mjs';
import { agyRequiredSettings, agySettingsProblems, agyMergedSettings, agyDiscovered, agyConfigProblems, agySettingsPath } from '../lib/runner/antigravity-config.mjs';
import { CREDENTIAL_NAME } from '../lib/runner/process.mjs';

// The antigravity system (Google Antigravity CLI, `agy`). Unlike the Grok
// tests, nothing here was captured from the real CLI: it was written on a
// machine without agy, and every stream below follows the shapes of agy's
// headless documentation (2026-10-22). These tests pin what the runner does
// with those shapes; preflight on the machine that runs a batch is what shows
// whether agy really produces them.

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'e3d-agy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const line = (event, payload) => ({ event, [event]: payload });
const step = (index, state, fields) => line('step_update', { conversation_id: 'conv-1', step_index: index, state, ...fields });
const tool = (index, name, parameters, output, error) => [
  step(index, 'ACTIVE', { step_type: 'tool', tool_name: name, tool_info: { name, parameters } }),
  step(index, 'DONE', { step_type: 'tool', tool_name: name, duration_seconds: 0.4, tool_info: { name, parameters, output, ...(error ? { error } : {}) } }),
];
const USAGE = { input_tokens: 10418, output_tokens: 589, thinking_tokens: 551, cache_read_tokens: 8113, total_tokens: 11007 };

// ---------------------------------------------------------------- events

test('agy events: one count per step, usage as documented, the reply from the result', () => {
  const events = [
    line('init', { cwd: '/w', tools: ['run_command', 'view_file', 'write_to_file', 'search_web'], permission_mode: 'proceed-in-sandbox', model: 'Gemini 3.7 Flash' }),
    step(0, 'DONE', { step_type: 'user_input' }),
    step(1, 'ACTIVE', { step_type: 'agent_response', text_delta: 'Reading ' }),
    step(1, 'DONE', { step_type: 'agent_response', text_delta: 'the task.' }),
    ...tool(2, 'view_file', { AbsolutePath: '/w/input/task.json' }, '{"schema":"e3d-task-v1"}'),
    ...tool(3, 'run_command', { CommandLine: 'node build.mjs' }, 'ok'),
    ...tool(4, 'run_command', { CommandLine: 'node tools/preview.mjs output/model.glb --out output/preview' }, 'wrote 4 images'),
    ...tool(5, 'search_web', { query: 'x' }, null, { type: 'PERMISSION_DENIED', message: 'read_url denied by rule read_url(*)' }),
    line('result', { conversation_id: 'conv-1', status: 'SUCCESS', response: 'Built the house.', duration_seconds: 812.4, num_turns: 9, usage: USAGE }),
  ];
  const summary = parseAntigravityEvents(events);
  assert.deepEqual(parseEvents('antigravity', events), summary);
  assert.deepEqual(summary.tools, { view_file: 1, run_command: 2, search_web: 1 });
  assert.equal(summary.commands, 2);
  assert.equal(summary.turns, 9);
  assert.deepEqual(summary.usage, { input_tokens: 10418, cached_input_tokens: 8113, output_tokens: 589 });
  assert.equal(summary.usage_detail.thinking_tokens, 551);
  assert.equal(summary.cost_usd, null);
  assert.equal(summary.final_message, 'Built the house.');
  assert.equal(summary.model_reported, 'Gemini 3.7 Flash');
  assert.equal(summary.completed, true);
  assert.deepEqual(summary.forbidden_calls, [{ name: 'search_web', failed: true }]);
  // A refused web tool is no problem; one that ran, or a run with every permission granted, is.
  assert.deepEqual(toolSurfaceProblems('antigravity', summary), []);
  assert.deepEqual(toolSurfaceProblems('antigravity', { ...summary, forbidden_calls: [{ name: 'read_url_content', failed: false }] }), ['agy ran read_url_content without a refusal']);
  assert.deepEqual(toolSurfaceProblems('antigravity', { ...summary, init: { permission_mode: 'always-proceed' } }), ['agy ran with permission mode always-proceed']);
  // Model activity: every update of a reply or a tool step, not the echoed prompt.
  assert.equal(modelTurns('antigravity', events), 10);
  // No result: the turns are the replies seen, the reply is the last one streamed, and it did not complete.
  const cut = parseAntigravityEvents(events.slice(0, 4));
  assert.deepEqual([cut.turns, cut.final_message, cut.completed, cut.usage], [1, 'Reading the task.', false, null]);
  const failed = parseAntigravityEvents([line('result', { status: 'ERROR', error: 'invalid model selection: "gemini-9"' })]);
  assert.deepEqual([failed.completed, failed.errors], [false, ['invalid model selection: "gemini-9"']]);
});

// ---------------------------------------------------------------- infrastructure errors

test('agy infrastructure errors: documented messages and Google status words, the model\'s own failures left alone', () => {
  for (const [text, reason] of [
    ['invalid model selection: "Gemini 9"', 'model_unavailable'],
    ['Error: authentication required', 'auth'],
    ['Error: failed to retrieve token: secret keyring is locked', 'auth'],
    ['Individual quota reached. Try again later.', 'usage_limit'],
    ['rpc error: code = ResourceExhausted desc = RESOURCE_EXHAUSTED', 'rate_limit'],
    ['UNAVAILABLE: the service is currently unavailable', 'overloaded'],
    ['rpc error: code = Internal desc = INTERNAL', 'server_error'],
    ['dial tcp: lookup example.googleapis.com: no such host', 'network'],
    ['The input token count exceeds the maximum number of tokens allowed', null],
    ['the model gave up', null],
  ]) assert.equal(agyReason(text), reason, text);

  const run = (fields = {}) => ({ exit_code: 1, signal: null, timed_out: false, wall_seconds: 3, stderr: '', ...fields });
  const detect = (events, fields) => detectInfra({ system: 'antigravity', events, run: run(fields), summary: parseAntigravityEvents(events), wallLimitSeconds: 1800 });
  assert.equal(detect([line('result', { status: 'ERROR', error: 'invalid model selection: "x"' })]).reason, 'model_unavailable');
  assert.equal(detect([], { stderr: 'Error: authentication required\n' }).reason, 'auth');
  const crash = detect([], { stderr: 'panic: something\n' });
  assert.deepEqual([crash.reason, crash.during], ['cli_crash', 'startup']);
  assert.equal(detect([line('result', { status: 'SUCCESS', response: 'done' })], { exit_code: 0 }), null);
  // After model turns, an unrecognised error stays the model's.
  const worked = [...tool(1, 'run_command', { CommandLine: 'ls' }, 'x'), line('result', { status: 'ERROR', error: 'something odd' })];
  assert.equal(detect(worked), null);
  assert.equal(detect([...worked.slice(0, 2), line('result', { status: 'ERROR', error: 'Individual quota reached' })]).reason, 'usage_limit');
});

// ---------------------------------------------------------------- invocation

test('agy invocation: the frozen binary under a runner-owned script, the prompt as -p, sandbox on, no permission bypass', async t => {
  const dir = await realpath(await scratch(t)), node = await nodeRuntime();
  assert.equal(ADAPTERS.antigravity, antigravity);
  const workspace = join(dir, 'a1', 'workspace');
  await mkdir(join(workspace, 'tmp'), { recursive: true });
  const harness = { binary_realpath: join(dir, 'fake-agy') };
  const spec = antigravity.invocation({ harness, model: 'Gemini 3.7 Flash', effort: 'high', workspace, attemptDir: join(dir, 'a1'), node, wallSeconds: 1800 });
  const wrapper = join(dir, 'a1', 'harness', 'agy-run.sh');
  assert.equal(spec.command, '/bin/sh');
  assert.deepEqual(spec.args, [wrapper, '--output-format', 'stream-json', '--model', 'Gemini 3.7 Flash', '--effort', 'high', '--sandbox', '--disable-slash-commands',
    '--print-timeout', (1800 + AGY_PRINT_MARGIN_SECONDS) + 's']);
  assert.ok(!spec.args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(agyArgs({ model: 'm' }).slice(-2), ['--print-timeout', (3600 + AGY_PRINT_MARGIN_SECONDS) + 's']);
  assert.equal(spec.cwd, workspace);
  assert.equal(spec.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
  assert.equal(spec.env.TMPDIR, join(workspace, 'tmp'));
  assert.ok(Object.keys(spec.env).every(key => !CREDENTIAL_NAME.test(key)));
  assert.deepEqual(Object.keys(spec.files), [wrapper]);
  assert.equal(spec.files[wrapper], agyWrapper({ binary: harness.binary_realpath, promptPath: join(dir, 'a1', 'prompt.txt') }));

  // Run for real: the prompt (quotes, $, backticks, newlines and all) reaches
  // agy as the argument of -p, the flags follow, and stdin is not passed on.
  const prompt = 'Read input/task.json first.\nIt\'s "quoted", costs $5 and `ticks`.';
  await writeFile(join(dir, 'a1', 'prompt.txt'), prompt);
  await writeFile(harness.binary_realpath, '#!/bin/sh\nfor a in "$@"; do printf "[%s]\\n" "$a"; done\nprintf "stdin=%s\\n" "$(cat)"\n');
  await chmod(harness.binary_realpath, 0o755);
  await mkdir(join(dir, 'a1', 'harness'), { recursive: true });
  await writeFile(wrapper, spec.files[wrapper]);
  const ran = spawnSync(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, input: 'THE PROMPT ON STDIN', encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, ['[-p]', '[' + prompt + ']', ...spec.args.slice(1).map(arg => '[' + arg + ']'), 'stdin=', ''].join('\n'));
});

test('the agy prompt differs from the others only in the paragraph that names its tools', () => {
  const task = { id: 'house-a-t1', budget: { wall_seconds: 1800 } };
  const agy = buildPrompt({ system: 'antigravity', task, threeVersion: '0.180.0' }), grok = buildPrompt({ system: 'grok', task, threeVersion: '0.180.0' });
  assert.ok(agy.includes(TOOL_DESCRIPTIONS.antigravity));
  assert.equal(agy.replace(TOOL_DESCRIPTIONS.antigravity, '<tools>'), grok.replace(TOOL_DESCRIPTIONS.grok, '<tools>'));
});

// ---------------------------------------------------------------- the operator's configuration

test('agy settings: the values a batch needs, judged as the CLI stores them (defaults left out)', async t => {
  const node = { bin: '/opt/homebrew/Cellar/node/26.12.0/bin', read_roots: ['/opt/homebrew/Cellar/node/26.12.0', '/opt/homebrew/Cellar'] };
  const required = agyRequiredSettings({ node });
  assert.deepEqual(agySettingsProblems(required, { node }), []);
  // The CLI saves only non-default values: the same settings without them still hold.
  const stored = { ...required };
  for (const key of ['allowNonWorkspaceAccess', 'useG1Credits', 'agentMode', 'modelProvider']) delete stored[key];
  assert.deepEqual(agySettingsProblems({ ...stored, colorScheme: 'dark', trustedWorkspaces: ['/x'] }, { node }), []);
  const broken = { ...required, useG1Credits: true, agentMode: 'auto', toolPermission: 'always-proceed', sandboxProxy: { http: {} },
    permissions: { allow: [...required.permissions.allow, 'read_url(*)'], deny: required.permissions.deny.filter(rule => rule !== 'mcp(*)') } };
  assert.deepEqual(agySettingsProblems(broken, { node }), [
    'toolPermission is "always-proceed", needs "proceed-in-sandbox"', 'useG1Credits is true, needs false', 'agentMode is "auto", needs "default"',
    'sandboxProxy is set; remove it', 'permissions.deny lacks mcp(*)', 'permissions.allow has rules the runner does not set: read_url(*)']);
  assert.deepEqual(agySettingsProblems(null, { node }), ['no settings object']);
  // Merging keeps the operator's other keys and deny rules, and repairs the rest.
  const merged = agyMergedSettings({ ...broken, colorScheme: 'dark', permissions: { ...broken.permissions, deny: ['command(sudo *)'] } }, { node });
  assert.deepEqual(agySettingsProblems(merged, { node }), []);
  assert.equal(merged.colorScheme, 'dark');
  assert.ok(merged.permissions.deny.includes('command(sudo *)'));

  // What lives under ~/.gemini: blank files and empty MCP lists configure nothing.
  const home = await scratch(t), g = join(home, '.gemini');
  assert.equal(agySettingsPath(home), join(g, 'antigravity-cli', 'settings.json'));
  await mkdir(join(g, 'config', 'rules'), { recursive: true });
  await writeFile(join(g, 'GEMINI.md'), '   \n');
  await writeFile(join(g, 'config', 'mcp_config.json'), '{"mcpServers":{}}');
  assert.deepEqual(Object.values(await agyDiscovered(home)).flat(), []);
  await writeFile(join(g, 'AGENTS.md'), 'Always answer in French.\n');
  await writeFile(join(g, 'config', 'rules', 'style.md'), 'x');
  await writeFile(join(g, 'config', 'mcp_config.json'), '{"mcpServers":{"fs":{"command":"x"}}}');
  const found = await agyDiscovered(home);
  assert.deepEqual([found.rules, found.mcp_servers], [[join(g, 'AGENTS.md'), join(g, 'config', 'rules')], [join(g, 'config', 'mcp_config.json')]]);
  const problems = await agyConfigProblems({ node, home });
  assert.equal(problems[0], agySettingsPath(home) + ' does not exist');
  assert.match(problems.join('\n'), /agy would load rules from .*AGENTS\.md/);
  assert.match(problems.join('\n'), /agy would load mcp servers from /);
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

// A probe session in the documented shape in which every refusal holds: the
// calls the probe prompt asks for, in order, with agy's (assumed) tool names.
function passingSession(site, probe) {
  const ws = site.workspace, denied = { type: 'PERMISSION_DENIED', message: 'access outside the workspace is not allowed' };
  const steps = [
    ['run_command', { CommandLine: 'node .e3d-probe/probe.mjs', Cwd: ws }, probe],
    ['view_file', { AbsolutePath: join(site.secret, 'canary.txt') }, null, denied],
    ['view_file', { AbsolutePath: join(ws, '.e3d-probe/link-file') }, null, denied],
    ['view_file', { AbsolutePath: join(ws, '.e3d-probe/link-dir/canary.txt') }, null, denied],
    ['view_file', { AbsolutePath: join(ws, '.e3d-probe/dangling-agent') }, null, denied],
    ['view_file', { AbsolutePath: '../secret/canary.txt' }, null, denied],
    ['view_file', { AbsolutePath: join(ws, 'input/task.json') }, '{"schema":"e3d-task-v1","id":"house-a-t1"}'],
    ['grep_search', { SearchPath: site.secret, Query: site.canary }, null, denied],
    ['grep_search', { SearchPath: ws, Query: site.canary }, 'No results found'],
    ['grep_search', { SearchPath: join(ws, '.e3d-probe/link-dir'), Query: site.canary }, null, denied],
    ['list_dir', { DirectoryPath: site.secret }, null, denied],
    ['list_dir', { DirectoryPath: join(ws, '.e3d-probe/link-dir') }, null, denied],
    ['list_dir', { DirectoryPath: '..' }, null, denied],
    ['write_to_file', { TargetFile: join(ws, 'output/.agent-write.txt'), CodeContent: 'ok' }, 'Created file'],
    ['write_to_file', { TargetFile: join(ws, 'input/.agent-write.txt'), CodeContent: 'x' }, null, { type: 'PERMISSION_DENIED', message: 'denied by rule write_file(input/)' }],
    ['write_to_file', { TargetFile: join(site.secret, 'agent-written.txt'), CodeContent: 'x' }, null, denied],
    ['write_to_file', { TargetFile: join(ws, '.e3d-probe/link-out'), CodeContent: 'PATCHED' }, null, denied],
    ['write_to_file', { TargetFile: join(ws, '.e3d-probe/dangling-agent'), CodeContent: 'x' }, null, denied],
    ['write_to_file', { TargetFile: join(ws, '.e3d-probe/link-dir/agent-new.txt'), CodeContent: 'x' }, null, denied],
    ['write_to_file', { TargetFile: join(ws, '.agents/rules/e3d.md'), CodeContent: 'x' }, null, { type: 'PERMISSION_DENIED', message: 'denied by rule write_file(.agents/)' }],
    ['replace_file_content', { TargetFile: join(ws, 'output/.agent-write.txt'), TargetContent: 'ok', ReplacementContent: 'okay' }, 'Edited file'],
    ['search_web', { query: 'Evidence3D preflight ' + site.canary }, null, { type: 'PERMISSION_DENIED', message: 'read_url denied' }],
    ['read_url_content', { Url: 'https://example.com/' }, null, { type: 'PERMISSION_DENIED', message: 'read_url(example.com) denied' }],
    ['view_file', { AbsolutePath: join(site.secret, 'canary.png') }, null, denied],
    ['view_file', { AbsolutePath: join(ws, '.e3d-probe/link-image.png') }, null, denied],
    ['view_file', { AbsolutePath: join(ws, '.e3d-probe/control.png') }, [{ type: 'image', mime_type: 'image/png', data: '<control>' }]],
  ];
  const events = [line('init', { cwd: ws, tools: ['run_command', 'view_file', 'list_dir', 'grep_search', 'write_to_file', 'replace_file_content', 'search_web', 'read_url_content'],
    permission_mode: 'proceed-in-sandbox' })];
  steps.forEach(([name, parameters, output, error], i) => events.push(...tool(i + 1, name, parameters, output, error)));
  const response = JSON.stringify({ view_results: ['access outside the workspace is not allowed', 'access outside the workspace is not allowed'],
    control_colour: site.colours.control, tools: ['run_command', 'view_file'] });
  events.push(line('result', { status: 'SUCCESS', response, num_turns: 27, usage: USAGE }));
  return events;
}

test('preflight\'s agy evaluation: every refusal and control passes on a passing session, and leaks are caught on evidence', async t => {
  const dir = await scratch(t), site = await probeSite(dir), before = await snapshot(site);
  const report = { version: 'e3d-probe-v1', results: { 'input-read': { outcome: 'allowed' } } };
  const probe = 'E3D-PROBE ' + JSON.stringify(report);
  await writeFile(join(site.workspace, 'output', '.agent-write.txt'), 'okay');
  const judged = await evaluateAntigravityAgent({ site, events: passingSession(site, probe), before });
  assert.deepEqual(judged.checks.filter(check => check.status !== 'pass').map(check => [check.id, check.status, check.reason]), []);
  assert.equal(judged.checks.length, 25);
  assert.deepEqual(judged.probeOutput, report);
  const prompt = agentProbePrompt('antigravity', site);
  for (const text of ['1. run_command: node .e3d-probe/probe.mjs', '2. view_file: ' + join(site.secret, 'canary.txt'), '6. view_file: ../secret/canary.txt',
    '13. With your directory-listing tool (not a shell command), list ..', '23. With your URL-reading tool (read_url_content), if you have one, read https://example.com/',
    '26. view_file: .e3d-probe/control.png (look at the image yourself)']) assert.ok(prompt.includes(text), text);
  assert.match(prompt, /reply with only one JSON object: \{"view_results"/);

  const judge = async change => {
    const events = passingSession(site, probe);
    await change(events);
    return Object.fromEntries((await evaluateAntigravityAgent({ site, events, before })).checks.map(check => [check.id, check]));
  };
  const done = (events, name, path) => events.find(event => event.step_update?.state === 'DONE' && event.step_update.tool_info.name === name &&
    JSON.stringify(event.step_update.tool_info.parameters).includes(path)).step_update.tool_info;
  const leaked = await judge(events => {
    Object.assign(done(events, 'view_file', 'canary.txt'), { output: '1: ' + site.canary, error: undefined });
    Object.assign(done(events, 'list_dir', '"..'), { output: ['AGENTS.md', 'secret/', 'workspace/'], error: undefined });
  });
  assert.deepEqual([leaked['agent:read-canary'].status, leaked['agent:read-canary'].reason], ['fail', 'canary content or name came back']);
  assert.equal(leaked['agent:list-parent'].status, 'fail');
  const canaryPng = await readFile(join(site.secret, 'canary.png'));
  const shown = await judge(events => Object.assign(done(events, 'view_file', 'secret/canary.png'), { output: [{ type: 'image', data: canaryPng.toString('base64') }], error: undefined }));
  assert.deepEqual([shown['agent:view-canary'].status, shown['agent:view-canary'].reason], ['fail', 'view_file returned the outside image']);
  const web = await judge(events => {
    Object.assign(done(events, 'read_url_content', 'example.com'), { output: '<h1>Example Domain</h1>', error: undefined });
    Object.assign(done(events, 'search_web', 'Evidence3D'), { output: 'Result 1: Evidence3D benchmark ...', error: undefined });
  });
  assert.deepEqual([web['agent:read-url'].status, web['agent:web-search'].status], ['fail', 'fail']);
  // A web tool agy did not offer passes by its absence; one offered but not called is unanswered.
  const absent = await judge(events => {
    events[0].init.tools = events[0].init.tools.filter(name => name !== 'search_web');
    events.splice(events.findIndex(event => event.step_update?.tool_info?.name === 'search_web'), 2);
  });
  assert.equal(absent['agent:web-search'].status, 'pass');
  const unanswered = await judge(events => events.splice(events.findIndex(event => event.step_update?.tool_info?.name === 'read_url_content'), 2));
  assert.deepEqual([unanswered['agent:read-url'].status, unanswered['agent:read-url'].reason], ['not_evaluated', 'the model did not make this call']);
  const misnamed = await judge(events => { events.at(-1).result.response = JSON.stringify({ view_results: [site.colours.canary, ''], control_colour: site.colours.control }); });
  assert.match(misnamed['agent:view-canary'].reason, /the model reported the colour of the outside image/);
  // Judged on disk: a project-configuration file that exists fails, whatever the tool said.
  await mkdir(join(site.workspace, '.agents', 'rules'), { recursive: true });
  await writeFile(join(site.workspace, '.agents', 'rules', 'e3d.md'), 'x');
  assert.equal((await judge(() => {}))['agent:write-config'].status, 'fail');

  // The configuration check reads the operator's real home: here it only has to run.
  const config = await agyConfigCheck({ node: await nodeRuntime() });
  assert.equal(config.id, 'agent:agy-config');
  assert.ok(['pass', 'fail'].includes(config.status));
});

// ---------------------------------------------------------------- prepare and run, against a fake agy

async function withHome(home, fn) {
  const saved = process.env.HOME;
  process.env.HOME = home;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; }
}

// A fake `agy` as a /bin/sh script: --version, `models`, and a session that
// copies a sample GLB into output/ and prints a documented-shape stream with
// the prompt it was given and the settings it found.
async function fakeAgy(dir, sample) {
  const path = join(dir, 'agy');
  await writeFile(path, `#!/bin/sh
case "$1" in
  --version) echo "agy 1.3.5"; exit 0;;
  models) printf 'Gemini 3.7 Flash\\nGemini 3.1 Pro\\n'; exit 0;;
esac
[ "$1" = "-p" ] || { echo "expected -p first" >&2; exit 2; }
prompt="$2"
mkdir -p output && cp '${sample}' output/model.glb && printf 'notes\\n' > output/notes.md
printf '{"event":"init","init":{"cwd":"%s","tools":["run_command","view_file","write_to_file"],"permission_mode":"proceed-in-sandbox","model":"Gemini 3.7 Flash"}}\\n' "$PWD"
printf '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"cp"},"output":"ok"}}}\\n'
case "$prompt" in "You are taking part in a 3D reconstruction benchmark."*) said="prompt ok";; *) said="prompt missing";; esac
printf '{"event":"result","result":{"status":"SUCCESS","response":"%s","num_turns":3,"usage":{"input_tokens":1200,"output_tokens":300,"thinking_tokens":200,"cache_read_tokens":800,"total_tokens":1500}}}\\n' "$said"
`);
  await chmod(path, 0o755);
  return path;
}

test('agy end to end: prepare refuses until the settings hold, then a batch runs through the frozen script and is scored', async t => {
  const { prepare, execute, manifestHash } = await import('../lib/runner/index.mjs');
  const { fakeScorer } = await import('../lib/runner/api/mock/fixtures.mjs');
  const { modelToGLB } = await import('../lib/model.mjs');
  const { sampleModel } = await import('../fixtures/sample-model.mjs');
  const dir = await realpath(await scratch(t)), home = join(dir, 'home'), dataRoot = join(dir, 'data'), sample = join(dir, 'sample.glb');
  await mkdir(home);
  await writeFile(sample, modelToGLB(sampleModel()));
  await makeDataRoot(dataRoot, ['house-a-t1']);
  const binary = await fakeAgy(dir, sample), node = await nodeRuntime();
  const scorer = join(dir, 'scorer.mjs');
  await writeFile(scorer, fakeScorer(join(dir, 'scored.log')));
  const go = (id, model = 'Gemini 3.7 Flash') => withHome(home, () => prepare({ id, system: 'antigravity', model, effort: 'high', tasks: ['house-a-t1'], dataRoot, binary,
    deps: { installTools: fakeInstallTools } }));
  await assert.rejects(go('agy-0'), /agy is not configured for a batch:[\s\S]*settings\.json does not exist[\s\S]*antigravity-settings/);
  await mkdir(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  await writeFile(join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify(agyMergedSettings({}, { node })));
  await assert.rejects(go('agy-0', 'Gemini 9 Ultra'), /Model Gemini 9 Ultra is not among the models agy lists/);
  const { batchDir, manifest } = await go('agy-1');
  assert.deepEqual([manifest.system, manifest.model, manifest.effort, manifest.harness.version], ['antigravity', 'Gemini 3.7 Flash', 'high', 'agy 1.3.5']);
  assert.match(manifest.harness.models_listing, /Gemini 3\.1 Pro/);
  const invocation = JSON.parse(await readFile(join(batchDir, 'house-a-t1', 'a1', 'invocation.json'), 'utf8'));
  assert.equal(invocation.command, '/bin/sh');
  assert.ok(invocation.args.includes('--sandbox'));
  await writeFile(join(batchDir, 'preflight.json'), JSON.stringify({ schema: 'e3d-preflight-v1', passed: true, manifest_sha256: manifestHash(manifest), checks: [] }));
  const summary = await withHome(home, () => execute({ batchDir, deps: { scorerModule: scorer, graceSeconds: 1 } }));
  assert.equal(summary.counts.completed, 1);
  const result = JSON.parse(await readFile(join(batchDir, 'house-a-t1', 'a1', 'result.json'), 'utf8'));
  assert.deepEqual([result.status, result.score, result.turns, result.commands, result.model_reported], ['completed', 71.5, 3, 1, 'Gemini 3.7 Flash']);
  assert.deepEqual(result.usage, { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 300 });
  assert.deepEqual(result.integrity_problems, []);
  const events = (await readFile(join(batchDir, 'house-a-t1', 'a1', 'events.jsonl'), 'utf8')).trim().split('\n').map(text => JSON.parse(text));
  assert.equal(events.at(-1).result.response, 'prompt ok');

  // The settings are checked again before every launch: a changed file stops the batch.
  const { batchDir: second, manifest: secondManifest } = await go('agy-2');
  await writeFile(join(second, 'preflight.json'), JSON.stringify({ schema: 'e3d-preflight-v1', passed: true, manifest_sha256: manifestHash(secondManifest), checks: [] }));
  await writeFile(join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ ...agyMergedSettings({}, { node }), useG1Credits: true }));
  await assert.rejects(withHome(home, () => execute({ batchDir: second, deps: { scorerModule: scorer, graceSeconds: 1 } })), /useG1Credits is true/);
});
