import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, link, stat, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { encodePNG } from '../lib/png.mjs';
import { modelToGLB } from '../lib/model.mjs';
import { DEFAULT_BUDGET, layout } from '../lib/contract.mjs';
import { sampleModel } from '../fixtures/sample-model.mjs';
import { objectHash } from '../../lib/io.mjs';
import { parseCodexEvents, parseClaudeEvents, toolSurfaceProblems } from '../lib/runner/events.mjs';
import { captureProcess, childEnvironment, assertCleanEnvironment, commandOf } from '../lib/runner/process.mjs';
import { classifyStatus, scoreOf } from '../lib/runner/status.mjs';
import { buildPrompt, TOOL_DESCRIPTIONS } from '../lib/runner/prompt.mjs';
import { readArtifact } from '../lib/runner/workspace.mjs';
import { codexConfig, claudeSettings, ADAPTERS, codexGlobalInstructions } from '../lib/runner/adapters.mjs';
import { probePlan, evaluateProbes, verdict, extractProbeOutput, PROBE_SCRIPT } from '../lib/runner/probes.mjs';
import { CREDENTIAL_NAME } from '../lib/runner/process.mjs';
import { prepare, preflight, execute, manifestHash, summarize } from '../lib/runner/index.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = path => access(path).then(() => true, () => false);
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'e3d-runner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------- fixtures

async function makeDataRoot(root, taskIds, { wall = DEFAULT_BUDGET.wall_seconds } = {}) {
  const png = encodePNG(16, 12, new Uint8Array(16 * 12 * 3).map((_, i) => (i * 13) & 255), 3);
  for (const id of taskIds) {
    const task = { schema: 'e3d-task-v1', id, title: 'Two-storey gabled house', prompt: 'Rebuild the house.', variant: 't1',
      target_state: 'As photographed in 2025-09.', frame: { unit: 'metre', up: '+Y', origin: 'Front wall midpoint.', front: 'Front faces +Z.' },
      scale_evidence: 'none', inputs: [{ id: 'source-1', path: 'inputs/01-photo-front.png', kind: 'photo', captured_at: '2025-09',
        description: 'Front photograph', sha256: sha(png), bytes: png.length }],
      output: { model: 'output/model.glb', notes: 'output/notes.md', rules: ['GLB 2.0'] }, budget: { ...DEFAULT_BUDGET, wall_seconds: wall } };
    await mkdir(join(root, 'tasks', id, 'inputs'), { recursive: true });
    await writeFile(join(root, 'tasks', id, 'inputs', '01-photo-front.png'), png);
    await writeFile(join(root, 'tasks', id, 'task.json'), JSON.stringify(task, null, 2));
    await mkdir(join(root, 'truth', id), { recursive: true });
    await writeFile(join(root, 'truth', id, 'truth.json'), JSON.stringify({ schema: 'e3d-truth-v1', task_id: id, task_sha256: objectHash(task),
      object: 'fixture', variant: 't1', scale_evidence: 'none', evidence: ['photo-front'], alternates: [] }));
  }
}

const fakeInstallTools = async destination => {
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'README.md'), '# Preview tool\n');
  await writeFile(join(destination, 'preview.mjs'), 'console.log("preview");\n');
  return { files: ['README.md', 'preview.mjs'] };
};

// A fake CLI: one Node script per test with its behaviour baked in, because the
// runner scrubs the environment and a fake cannot be steered through it.
//   events      JSON lines printed on stdout
//   artifact    'glb' | 'invalid' | 'throw' | 'symlink-truth' | 'hardlink' | null
//   sleep       seconds to wait after printing (simulates a long session)
//   exit        exit code
//   grandchild  path of a heartbeat file a detached grandchild keeps touching
//   envDump     path where the environment variable names are written
//   tamperInput modify input/task.json (a fake is not sandboxed)
//   marker      file created on every start (to prove an attempt was not re-run)
async function fakeCLI(dir, name, behaviour) {
  const path = join(dir, name);
  await writeFile(path, `#!${process.execPath}
const fs = require('fs'), path = require('path'), { spawn, spawnSync } = require('child_process');
const behaviour = ${JSON.stringify(behaviour)};
const args = process.argv.slice(2);
if (args[0] === 'sandbox') {
  // An unconfined "sandbox": runs the command as is, which preflight must catch.
  const command = args.slice(-2);
  const run = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
const cIndex = args.indexOf('-C'), ws = cIndex >= 0 ? args[cIndex + 1] : process.cwd();
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
if (behaviour.marker) fs.appendFileSync(behaviour.marker, 'started\\n');
if (behaviour.envDump) fs.writeFileSync(behaviour.envDump, JSON.stringify(Object.keys(process.env).sort()));
if (behaviour.tamperInput) { const file = path.join(ws, 'input', 'task.json'); fs.chmodSync(file, 0o644); fs.appendFileSync(file, ' '); }
const out = path.join(ws, 'output', 'model.glb');
if (behaviour.artifact === 'glb') fs.copyFileSync(${JSON.stringify(join(dir, 'sample.glb'))}, out);
if (behaviour.artifact === 'invalid') fs.writeFileSync(out, 'INVALID');
if (behaviour.artifact === 'throw') fs.writeFileSync(out, 'THROW');
if (behaviour.artifact === 'symlink-truth') fs.symlinkSync(behaviour.truthPath, out);
if (behaviour.artifact === 'hardlink') fs.linkSync(behaviour.truthPath, out);
if (behaviour.notes) fs.writeFileSync(path.join(ws, 'output', 'notes.md'), 'notes');
if (behaviour.grandchild) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => require("fs").writeFileSync(' + JSON.stringify(behaviour.grandchild) + ', String(Date.now())), 100)'],
    { detached: true, stdio: 'ignore' });
  child.unref();
}
for (const event of behaviour.events ?? []) process.stdout.write(JSON.stringify(event) + '\\n');
setTimeout(() => process.exit(behaviour.exit ?? 0), (behaviour.sleep ?? 0) * 1000);
`);
  await chmod(path, 0o755);
  return path;
}

const fakeScorer = callLog => `import { appendFileSync } from 'node:fs';
export async function scoreSubmission({ glb, taskDir, truthDir, outDir }) {
  appendFileSync(${JSON.stringify(callLog)}, 'x');
  const text = glb.subarray(0, 7).toString('latin1');
  if (text === 'THROW') throw new Error('scorer exploded');
  if (text === 'INVALID') return { schema: 'e3d-report-v1', valid: false, error: 'Invalid GLB 2.0 header', score: 0 };
  return { schema: 'e3d-report-v1', valid: true, error: null, score: 71.5, bytes: glb.length, taskDir, truthDir, outDir };
}
`;

const CODEX_EVENTS = [
  { type: 'thread.started', thread_id: 't-1' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'node build.mjs', aggregated_output: 'ok', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'node tools/preview.mjs', aggregated_output: 'ok', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'output/notes.md', kind: 'add' }], status: 'completed' } },
  { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'Built the house.' } },
  { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 120 } },
];

const CLAUDE_EVENTS = [
  { type: 'system', subtype: 'init', session_id: 's-1', tools: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'], mcp_servers: [], model: 'claude-test-1',
    permissionMode: 'dontAsk', apiKeySource: 'none', plugins: [{ name: 'cc-plugin-agents-md' }], claude_code_version: '2.1.285' },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'input/task.json' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: '{}' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u2', name: 'Bash', input: { command: 'node build.mjs' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u2', content: 'ok' }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0.0123, result: 'Done.',
    usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 150 }, permission_denials: [] },
];

// prepare() with a fake harness; returns everything a test needs.
async function fakeBatch(t, { system = 'codex', behaviour = {}, tasks = ['house-a-t1'], attempts = 1, wall, codexHome } = {}) {
  const dir = await scratch(t), dataRoot = join(dir, 'data');
  await makeDataRoot(dataRoot, tasks, { wall });
  await writeFile(join(dir, 'sample.glb'), modelToGLB(sampleModel()));
  const events = behaviour.events ?? (system === 'codex' ? CODEX_EVENTS : CLAUDE_EVENTS);
  const binary = await fakeCLI(dir, 'fake-' + system, { ...behaviour, events });
  const scorer = join(dir, 'fake-scorer.mjs');
  await writeFile(scorer, fakeScorer(join(dir, 'scorer-calls.log')));
  const inspect = async ({ model, effort }) => ({ system, binary, binary_realpath: binary, binary_sha256: sha(await readFile(binary)),
    version: 'fake 1.0', release_root: dir, login: 'test', model, effort: effort ?? 'low', effort_levels: ['low', 'high'], codex_home: codexHome });
  const { batchDir, manifest } = await prepare({ id: 'batch-1', system, model: 'test-model', effort: 'low', tasks, attempts, dataRoot,
    deps: { inspect, installTools: fakeInstallTools } });
  const deps = { scorerModule: scorer, graceSeconds: 1 };
  return { dir, dataRoot, batchDir, manifest, binary, scorer, deps };
}

// Execution tests need a passed preflight; the real one needs a real harness,
// so it is written here, bound to the manifest exactly as preflight binds it.
async function passPreflight(batchDir) {
  const manifest = await readJSON(join(batchDir, 'manifest.json'));
  await writeFile(join(batchDir, 'preflight.json'), JSON.stringify({ schema: 'e3d-preflight-v1', passed: true, manifest_sha256: manifestHash(manifest), checks: [] }));
}

// ---------------------------------------------------------------- events

test('codex events: usage is summed from turn.completed, commands are counted, absent usage stays null', () => {
  const summary = parseCodexEvents(CODEX_EVENTS);
  assert.deepEqual(summary.usage, { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 300 });
  assert.equal(summary.usage_detail.reasoning_output_tokens, 120);
  assert.equal(summary.commands, 2); assert.equal(summary.file_changes, 1); assert.equal(summary.turns, 1);
  assert.equal(summary.completed, true); assert.equal(summary.cost_usd, null); assert.equal(summary.final_message, 'Built the house.');
  const failed = parseCodexEvents([{ type: 'thread.started' }, { type: 'turn.failed', error: { message: 'usage limit' } }]);
  assert.equal(failed.usage, null); assert.equal(failed.completed, false); assert.deepEqual(failed.errors, ['usage limit']);
});

test('claude events: cache reads and writes fold into input tokens, cost and turns come from the result', () => {
  const summary = parseClaudeEvents(CLAUDE_EVENTS);
  assert.deepEqual(summary.usage, { input_tokens: 3210, cached_input_tokens: 3000, output_tokens: 150 });
  assert.equal(summary.cost_usd, 0.0123); assert.equal(summary.turns, 4); assert.equal(summary.commands, 1);
  assert.deepEqual(summary.tools, { Read: 1, Bash: 1 }); assert.equal(summary.model_reported, 'claude-test-1'); assert.equal(summary.completed, true);
  const noResult = parseClaudeEvents(CLAUDE_EVENTS.slice(0, 3));
  assert.equal(noResult.usage, null); assert.equal(noResult.cost_usd, null); assert.equal(noResult.completed, false);
  const errored = parseClaudeEvents([...CLAUDE_EVENTS.slice(0, -1), { ...CLAUDE_EVENTS.at(-1), is_error: true, subtype: 'error_max_turns' }]);
  assert.equal(errored.completed, false); assert.equal(errored.errors.length, 1);
});

test('tool surface: extra tools, MCP servers, API-key auth and foreign codex items are reported', () => {
  assert.deepEqual(toolSurfaceProblems('claude-code', parseClaudeEvents(CLAUDE_EVENTS)), []);
  const init = { ...CLAUDE_EVENTS[0], tools: [...CLAUDE_EVENTS[0].tools, 'WebFetch'], mcp_servers: [{ name: 'x' }], apiKeySource: 'ANTHROPIC_API_KEY' };
  const problems = toolSurfaceProblems('claude-code', parseClaudeEvents([init, ...CLAUDE_EVENTS.slice(1)]));
  assert.equal(problems.length, 3);
  const codex = parseCodexEvents([...CODEX_EVENTS, { type: 'item.completed', item: { type: 'web_search', query: 'house' } }]);
  assert.deepEqual(toolSurfaceProblems('codex', codex), ['codex produced a web_search item']);
});

// ---------------------------------------------------------------- processes

test('captureProcess reassembles JSON lines split across writes and keeps the exact raw log', async t => {
  const dir = await scratch(t), events = [];
  const run = await captureProcess(process.execPath, ['-e',
    'process.stdout.write("{\\"type\\":"); setTimeout(() => process.stdout.write("\\"turn.completed\\"}\\nnot json\\n"), 40)'],
  { cwd: dir, seconds: 5, stdoutPath: join(dir, 'events.jsonl'), stderrPath: join(dir, 'stderr.log'), onEvent: event => events.push(event) });
  assert.equal(run.exit_code, 0); assert.equal(run.timed_out, false);
  assert.deepEqual(events, [{ type: 'turn.completed' }]); assert.equal(run.lines_unparsed, 1);
  assert.equal(await readFile(join(dir, 'events.jsonl'), 'utf8'), '{"type":"turn.completed"}\nnot json\n');
});

test('a wall-clock overrun kills the whole process tree, including a detached grandchild', async t => {
  const dir = await scratch(t), heartbeat = join(dir, 'heartbeat');
  const fake = await fakeCLI(dir, 'slow', { sleep: 30, grandchild: heartbeat, events: [{ type: 'turn.started' }] });
  const run = await captureProcess(fake, [], { cwd: dir, seconds: 1.5, graceSeconds: 0.5 });
  assert.equal(run.timed_out, true); assert.ok(run.wall_seconds < 5, 'took ' + run.wall_seconds);
  const before = await readFile(heartbeat, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(await readFile(heartbeat, 'utf8'), before, 'the grandchild is still writing its heartbeat');
});

test('the child environment never carries API keys or other credentials', () => {
  const source = { HOME: '/home/x', USER: 'x', PATH: '/evil/bin:/usr/bin', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 'k',
    GITHUB_TOKEN: 'k', NODE_OPTIONS: '--require /tmp/hook.js', TYPESAFE_API_KEY: 'k', LANG: 'C' };
  const env = childEnvironment({ TMPDIR: '/w/tmp' }, source);
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR', 'USER']);
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  assert.throws(() => childEnvironment({ ANTHROPIC_AUTH_TOKEN: 'x' }, source), /credential-like/);
  assert.throws(() => assertCleanEnvironment({ HOME: '/h', MY_PASSWORD: 'x' }), /MY_PASSWORD/);
  for (const adapter of Object.values(ADAPTERS)) {
    const spec = adapter.invocation({ harness: { binary_realpath: '/bin/echo', release_root: '/r' }, model: 'm', effort: 'low',
      workspace: '/w', attemptDir: '/a', node: { bin: '/n/bin', path: '/n/bin/node', read_roots: ['/n'] } });
    assert.doesNotThrow(() => assertCleanEnvironment(spec.env), adapter.id);
  }
});

// ---------------------------------------------------------------- status

test('status classification follows the precedence timeout > failed > missing > invalid > score error > completed', () => {
  const ok = { exit_code: 0, signal: null, timed_out: false }, done = { completed: true };
  const artifact = { present: true, problem: null }, report = { valid: true, score: 50 };
  assert.equal(classifyStatus({ run: { ...ok, timed_out: true }, summary: done, artifact, report }), 'timeout');
  assert.equal(classifyStatus({ run: { ...ok, exit_code: 1 }, summary: done, artifact, report }), 'generation_failed');
  assert.equal(classifyStatus({ run: ok, summary: { completed: false }, artifact, report }), 'generation_failed');
  assert.equal(classifyStatus({ run: ok, summary: done, artifact, report, integrityProblems: ['input/ changed'] }), 'generation_failed');
  assert.equal(classifyStatus({ run: null, summary: null, artifact, report }), 'generation_failed');
  assert.equal(classifyStatus({ run: ok, summary: done, artifact: { present: false } }), 'missing_artifact');
  assert.equal(classifyStatus({ run: ok, summary: done, artifact: { present: true, problem: 'artifact is a symlink' } }), 'invalid_artifact');
  assert.equal(classifyStatus({ run: ok, summary: done, artifact, report: { valid: false, score: 0 } }), 'invalid_artifact');
  assert.equal(classifyStatus({ run: ok, summary: done, artifact, scoreError: 'boom' }), 'score_error');
  assert.equal(classifyStatus({ run: ok, summary: done, artifact, report }), 'completed');
  assert.equal(scoreOf(report), 50); assert.equal(scoreOf({ valid: false, score: 10 }), 0); assert.equal(scoreOf(null), 0);
});

test('the artifact reader refuses symlinks, hard links and oversized files', async t => {
  const dir = await scratch(t), ws = join(dir, 'ws'), secret = join(dir, 'truth.glb');
  await mkdir(join(ws, 'output'), { recursive: true });
  await writeFile(secret, 'TRUTH');
  assert.deepEqual(await readArtifact(ws, 'output/model.glb', { maxBytes: 100 }), { present: false, problem: null });
  await symlink(secret, join(ws, 'output', 'model.glb'));
  assert.match((await readArtifact(ws, 'output/model.glb', { maxBytes: 100 })).problem, /symlink/);
  await rm(join(ws, 'output', 'model.glb'));
  await link(secret, join(ws, 'output', 'model.glb'));
  assert.match((await readArtifact(ws, 'output/model.glb', { maxBytes: 100 })).problem, /hard links/);
  await rm(join(ws, 'output', 'model.glb'));
  await writeFile(join(ws, 'output', 'model.glb'), Buffer.alloc(200));
  assert.match((await readArtifact(ws, 'output/model.glb', { maxBytes: 100 })).problem, /over the 100 byte budget/);
  await writeFile(join(ws, 'output', 'model.glb'), 'glTF');
  const good = await readArtifact(ws, 'output/model.glb', { maxBytes: 100 });
  assert.equal(good.problem, null); assert.equal(good.data.toString(), 'glTF');
});

// ---------------------------------------------------------------- prompt and configuration

test('the prompt is identical across systems apart from the tool paragraph and states every rule', () => {
  const task = { budget: { wall_seconds: 1800 } };
  const codex = buildPrompt({ system: 'codex', task }), claude = buildPrompt({ system: 'claude-code', task });
  assert.equal(codex.replace(TOOL_DESCRIPTIONS.codex, '<tools>'), claude.replace(TOOL_DESCRIPTIONS['claude-code'], '<tools>'));
  for (const needle of ['input/task.json', 'Use only the supplied evidence', 'output/model.glb', 'output/notes.md', 'tools/preview.mjs',
    'no feedback', '30 minutes (1800 seconds)', 'solid-colour materials', 'metres, +Y up', 'no network']) assert.ok(codex.includes(needle), needle);
  assert.throws(() => buildPrompt({ system: 'gemini', task }), /No tool description/);
});

test('harness configurations carry every boundary setting', () => {
  const node = { bin: '/n/bin', path: '/n/bin/node', read_roots: ['/opt/homebrew/Cellar'] };
  const args = codexConfig({ workspace: '/w', effort: 'low', harness: { release_root: '/codex/release' }, node }).join(' ');
  for (const needle of ['default_permissions="evidence3d"', 'network.enabled=false', '":tmpdir"="deny"', '"/w"="write"', '"/w/input"="read"',
    '"/w/node_modules"="read"', '"/codex/release"="read"', 'shell_environment_policy.inherit="none"', 'web_search="disabled"',
    'skills.include_instructions=false', 'agents.enabled=false', 'features.memories=false', 'features.plugins=false', 'features.apps=false',
    'features.multi_agent=false', 'features.browser_use=false', 'features.image_generation=false', 'project_doc_max_bytes=0', 'approval_policy="never"']) {
    assert.ok(args.includes(needle), needle);
  }
  const settings = claudeSettings({ workspace: '/Users/u/ws', home: '/Users/u', node });
  assert.equal(settings.sandbox.enabled, true); assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false); assert.deepEqual(settings.sandbox.network.allowedDomains, []);
  assert.equal(settings.sandbox.network.allowAllUnixSockets, false); assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
  assert.ok(settings.sandbox.filesystem.denyRead.includes('/Users/u')); assert.deepEqual(settings.sandbox.filesystem.allowRead, ['/Users/u/ws']);
  assert.ok(settings.permissions.deny.includes('Edit(//Users/u/ws/input/**)'));
  const spec = ADAPTERS['claude-code'].invocation({ harness: { binary_realpath: '/c' }, model: 'm', effort: 'low', workspace: '/w', attemptDir: '/a', node });
  for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--no-chrome']) {
    assert.ok(spec.args.includes(flag), flag);
  }
  assert.equal(spec.args[spec.args.indexOf('--tools') + 1], 'Bash,Read,Glob,Grep,Edit,Write');
  assert.equal(spec.args[spec.args.indexOf('--permission-mode') + 1], 'dontAsk');
});

// ---------------------------------------------------------------- probes

test('probe evaluation trusts ground truth over the probe and fails closed on silence', () => {
  const plan = probePlan({ credentialName: CREDENTIAL_NAME, keychain: null, network: { loopbackPort: 9, unixSocket: '/tmp/x.sock' },
    paths: { node: '/n', toolsFile: 'tools/preview.mjs', canaryFile: '/s/canary.txt', outsideWrite: '/s/w.txt', denied: [['truth', '/d/truth.json', 'read', 'truth']] } });
  const results = {};
  for (const probe of plan.probes) results[probe.id] = { outcome: probe.expect === 'allow' ? 'allowed' : 'denied:EPERM' };
  results['three-import'] = { outcome: 'allowed', value: '180' };
  results['preview-tool'] = { outcome: 'ran', status: 0 };
  results['env-names'] = { outcome: 'ran', names: ['HOME', 'PATH', 'CLAUDE_CODE_MESSAGING_TOKEN'] };
  results['http-internet'] = { outcome: 'ran', status: 56, stdout: '000' };
  const ground = { hits: {}, writes: {}, previewImage: { ok: true }, threeRevision: '180', canarySha16: 'abc' };
  assert.equal(verdict(evaluateProbes(plan, { results }, ground)).passed, true);
  // The probe says denied, but the runner's listener accepted a connection.
  const hit = evaluateProbes(plan, { results }, { ...ground, hits: { 'tcp-loopback': 1 } });
  assert.equal(hit.find(check => check.id === 'tcp-loopback').status, 'fail');
  // The probe says denied, but the file is on disk.
  const wrote = evaluateProbes(plan, { results }, { ...ground, writes: { 'outside-write': true } });
  assert.equal(wrote.find(check => check.id === 'outside-write').status, 'fail');
  const leaked = evaluateProbes(plan, { results: { ...results, truth: { outcome: 'allowed', sha256_16: 'abc' } } }, ground);
  assert.match(leaked.find(check => check.id === 'truth').reason, /readable/);
  const env = evaluateProbes(plan, { results: { ...results, 'env-names': { outcome: 'ran', names: ['OPENAI_API_KEY'] } } }, ground);
  assert.equal(env.find(check => check.id === 'env-names').status, 'fail');
  const silent = verdict(evaluateProbes(plan, null, ground));
  assert.equal(silent.passed, false); assert.equal(silent.not_evaluated.length, plan.probes.length);
  assert.equal(extractProbeOutput('noise\nE3D-PROBE {"results":{}}\n').results.constructor, Object);
});

test('the probe script, run without a sandbox, reports the leaks preflight must catch', async t => {
  const dir = await scratch(t), ws = join(dir, 'ws'), secret = join(dir, 'secret');
  await mkdir(join(ws, '.e3d-probe'), { recursive: true }); await mkdir(join(ws, 'input')); await mkdir(join(ws, 'output')); await mkdir(join(ws, 'tmp'));
  await mkdir(secret);
  await writeFile(join(secret, 'canary.txt'), 'E3D-CANARY-test');
  await writeFile(join(ws, 'input', 'task.json'), '{}');
  await writeFile(join(ws, 'package.json'), '{"type":"module"}');
  await symlink(join(secret, 'canary.txt'), join(ws, '.e3d-probe', 'link-file'));
  const plan = probePlan({ credentialName: CREDENTIAL_NAME, keychain: null, network: { loopbackPort: 9, unixSocket: join(dir, 'none.sock') },
    paths: { node: process.execPath, toolsFile: 'tools/preview.mjs', canaryFile: join(secret, 'canary.txt'), outsideWrite: join(secret, 'w.txt'), denied: [] } });
  plan.probes = plan.probes.filter(probe => !['tcp-internet', 'http-internet', 'preview-tool', 'three-import'].includes(probe.id));
  await writeFile(join(ws, '.e3d-probe', 'plan.json'), JSON.stringify(plan));
  await writeFile(join(ws, '.e3d-probe', 'probe.mjs'), PROBE_SCRIPT);
  const run = await captureProcess(process.execPath, ['.e3d-probe/probe.mjs'], { cwd: ws, seconds: 20 });
  const observed = extractProbeOutput(run.stdout);
  assert.ok(observed, run.stderr);
  const canarySha16 = sha(Buffer.from('E3D-CANARY-test')).slice(0, 16);
  const checks = evaluateProbes(plan, observed, { hits: {}, writes: {}, previewImage: null, threeRevision: '180', canarySha16 });
  for (const id of ['canary-direct', 'canary-symlink', 'canary-hardlink', 'outside-write', 'input-write']) {
    assert.equal(checks.find(check => check.id === id).status, 'fail', id);
  }
  assert.match(checks.find(check => check.id === 'canary-direct').reason, /canary came back/);
  assert.ok(!(await readFile(join(ws, '.e3d-probe', 'plan.json'), 'utf8')).includes('E3D-CANARY'), 'the plan must not carry the canary text');
});

// ---------------------------------------------------------------- batches

test('prepare freezes the batch: layout, hashes, read-only inputs, and no reuse of an id', async t => {
  const { batchDir, manifest, dataRoot } = await fakeBatch(t, { tasks: ['house-a-t1', 'house-b-t1'], attempts: 2 });
  assert.equal(manifest.tasks.length, 2); assert.equal(manifest.tasks[0].attempts.length, 2);
  const dir = join(batchDir, 'house-a-t1', 'a2'), ws = join(dir, 'workspace');
  for (const path of ['input/task.json', 'input/inputs/01-photo-front.png', 'tools/preview.mjs', 'node_modules/three/package.json', 'package.json']) {
    assert.ok(await exists(join(ws, path)), path);
  }
  assert.deepEqual(await readdir(join(ws, 'output')), []);
  assert.equal((await stat(join(ws, 'input', 'task.json'))).mode & 0o222, 0, 'input files are read-only on disk');
  const invocation = await readJSON(join(dir, 'invocation.json'));
  assert.equal(objectHash(invocation), manifest.tasks[0].attempts[1].invocation_sha256);
  assert.equal(invocation.wall_seconds, DEFAULT_BUDGET.wall_seconds);
  assert.equal(sha(await readFile(join(dir, 'prompt.txt'))), manifest.tasks[0].prompt_sha256);
  assert.ok(manifest.runtime.sha256 && manifest.tools.sha256 && manifest.runner_source.sha256 && manifest.harness.binary_sha256);
  await assert.rejects(prepare({ id: 'batch-1', system: 'codex', model: 'm', tasks: ['house-a-t1'], dataRoot,
    deps: { inspect: async () => manifest.harness, installTools: fakeInstallTools } }), /already exists/);
});

test('a prepare that fails half way leaves no batch behind, and a missing tool kit is a clear error', async t => {
  const dir = await scratch(t), dataRoot = join(dir, 'data');
  await makeDataRoot(dataRoot, ['house-a-t1']);
  const inspect = async ({ model }) => ({ system: 'codex', binary: process.execPath, binary_realpath: process.execPath, binary_sha256: 'x',
    version: 'fake', release_root: dir, login: 'test', model, effort: 'low', effort_levels: ['low'] });
  const broken = async () => { throw new Error('kit exploded'); };
  await assert.rejects(prepare({ id: 'b1', system: 'codex', model: 'm', tasks: ['house-a-t1'], dataRoot, deps: { inspect, installTools: broken } }), /kit exploded/);
  assert.equal(await exists(join(dataRoot, 'runs', 'b1')), false);
  await assert.rejects(prepare({ id: 'b1', system: 'codex', model: 'm', tasks: ['house-b-t1'], dataRoot, deps: { inspect, installTools: fakeInstallTools } }), /ENOENT/);
  const { manifest } = await prepare({ id: 'b1', system: 'codex', model: 'm', tasks: ['house-a-t1'], dataRoot, deps: { inspect, installTools: fakeInstallTools } });
  assert.equal(manifest.id, 'b1');
});

test('execute runs a codex attempt, scores it outside the sandbox and records usage', async t => {
  const { batchDir, deps, dir } = await fakeBatch(t, { behaviour: { artifact: 'glb', notes: true, envDump: join(await scratch(t), 'env.json') } });
  await passPreflight(batchDir);
  const summary = await execute({ batchDir, deps });
  const result = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
  assert.equal(result.status, 'completed'); assert.equal(result.score, 71.5);
  assert.deepEqual(result.usage, { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 300 });
  assert.equal(result.cost_usd, null); assert.equal(result.commands, 2); assert.equal(result.turns, 1);
  assert.equal(result.report, 'house-a-t1/a1/score/report.json'); assert.equal(result.notes_present, true);
  assert.ok(result.wall_seconds > 0);
  for (const key of ['task_id', 'attempt', 'system', 'model', 'effort', 'status', 'wall_seconds', 'usage', 'cost_usd', 'turns', 'commands', 'score', 'report']) assert.ok(key in result, key);
  const report = await readJSON(join(batchDir, result.report));
  assert.equal(report.truthDir, layout(join(dir, 'data')).truth('house-a-t1'));
  assert.ok(await exists(join(batchDir, 'house-a-t1', 'a1', 'events.jsonl')));
  assert.equal(summary.complete, true); assert.equal(summary.counts.completed, 1); assert.equal(summary.mean_score, 71.5);
});

test('execute scrubs the harness environment and records claude cost and tokens', async t => {
  const envDump = join(await scratch(t), 'env.json');
  const saved = { ...process.env };
  process.env.OPENAI_API_KEY = 'sk-test'; process.env.ANTHROPIC_API_KEY = 'sk-ant-test'; process.env.SOME_SERVICE_TOKEN = 'x';
  t.after(() => { for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SOME_SERVICE_TOKEN']) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });
  const { batchDir, deps } = await fakeBatch(t, { system: 'claude-code', behaviour: { artifact: 'glb', envDump } });
  await passPreflight(batchDir);
  await execute({ batchDir, deps });
  const names = await readJSON(envDump);
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SOME_SERVICE_TOKEN']) assert.ok(!names.includes(name), name);
  assert.ok(names.includes('CLAUDE_CODE_DISABLE_AUTO_MEMORY') && names.includes('HOME'));
  const result = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
  assert.equal(result.status, 'completed'); assert.equal(result.cost_usd, 0.0123);
  assert.deepEqual(result.usage, { input_tokens: 3210, cached_input_tokens: 3000, output_tokens: 150 });
  assert.equal(result.model_reported, 'claude-test-1');
});

test('a timed-out attempt is killed at the budget and its status is timeout', async t => {
  const { batchDir, deps } = await fakeBatch(t, { wall: 2, behaviour: { artifact: 'glb', sleep: 60 } });
  await passPreflight(batchDir);
  const started = Date.now();
  await execute({ batchDir, deps });
  const result = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
  assert.equal(result.status, 'timeout'); assert.equal(result.timed_out, true);
  assert.ok(Date.now() - started < 20000, 'the runner waited for the sleeping CLI');
  assert.equal(result.score, 71.5, 'an artifact left at the deadline is still scored');
});

test('missing, invalid, unscorable and failed attempts get their own status and a zero score', async t => {
  const cases = [
    [{ artifact: null }, 'missing_artifact', null],
    [{ artifact: 'invalid' }, 'invalid_artifact', 'house-a-t1/a1/score/report.json'],
    [{ artifact: 'throw' }, 'score_error', null],
    [{ artifact: 'glb', exit: 3 }, 'generation_failed', 'house-a-t1/a1/score/report.json'],
    [{ artifact: null, events: [{ type: 'thread.started' }, { type: 'turn.failed', error: { message: 'quota' } }] }, 'generation_failed', null],
  ];
  for (const [behaviour, status, report] of cases) {
    const { batchDir, deps } = await fakeBatch(t, { behaviour });
    await passPreflight(batchDir);
    await execute({ batchDir, deps });
    const result = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
    assert.equal(result.status, status, JSON.stringify(behaviour));
    assert.equal(result.report, report, status);
    if (status !== 'generation_failed') assert.equal(result.score, 0, status);
  }
});

test('an artifact that links to the hidden truth is refused before the scorer sees it', async t => {
  for (const artifact of ['symlink-truth', 'hardlink']) {
    const dir = await scratch(t), truthPath = join(dir, 'secret-truth.glb');
    await writeFile(truthPath, modelToGLB(sampleModel()));
    const { batchDir, deps, dir: base } = await fakeBatch(t, { behaviour: { artifact, truthPath } });
    await passPreflight(batchDir);
    await execute({ batchDir, deps });
    const result = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
    assert.equal(result.status, 'invalid_artifact', artifact); assert.equal(result.score, 0);
    assert.match(result.artifact.problem, artifact === 'hardlink' ? /hard links/ : /symlink/);
    assert.equal(await exists(join(base, 'scorer-calls.log')), false, 'the scorer was called');
  }
});

test('a workspace changed during generation voids the attempt', async t => {
  const { batchDir, deps } = await fakeBatch(t, { behaviour: { artifact: 'glb', tamperInput: true } });
  await passPreflight(batchDir);
  await execute({ batchDir, deps });
  const result = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
  assert.equal(result.status, 'generation_failed'); assert.equal(result.score, 0);
  assert.deepEqual(result.integrity_problems, ['input/ changed during generation']);
});

test('execute resumes: finished attempts are skipped and never overwritten, interrupted ones are not re-run', async t => {
  const marker = join(await scratch(t), 'starts.log');
  const { batchDir, deps } = await fakeBatch(t, { tasks: ['house-a-t1', 'house-b-t1'], behaviour: { artifact: 'glb', marker } });
  await passPreflight(batchDir);
  // Simulate a runner that died while the second attempt was running; the
  // contestant had already written a model, which must not be scored.
  await writeFile(join(batchDir, 'house-b-t1', 'a1', 'started.json'), '{}');
  await writeFile(join(batchDir, 'house-b-t1', 'a1', 'workspace', 'output', 'model.glb'), modelToGLB(sampleModel()));
  await execute({ batchDir, deps });
  assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 1, 'only the fresh attempt ran');
  const first = await readFile(join(batchDir, 'house-a-t1', 'a1', 'result.json'), 'utf8');
  const interrupted = JSON.parse(await readFile(join(batchDir, 'house-b-t1', 'a1', 'result.json'), 'utf8'));
  assert.equal(interrupted.status, 'generation_failed'); assert.match(interrupted.integrity_problems[0], /interrupted/);
  assert.equal(interrupted.score, 0, 'an unsupervised run is not scored');
  const summary = await execute({ batchDir, deps });
  assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 1, 'nothing ran again');
  assert.equal(await readFile(join(batchDir, 'house-a-t1', 'a1', 'result.json'), 'utf8'), first);
  assert.equal(summary.counts.completed, 1); assert.equal(summary.counts.generation_failed, 1); assert.equal(summary.complete, true);
});

test('a runner that died after generation but before scoring is recovered from its logs, not re-run', async t => {
  const marker = join(await scratch(t), 'starts.log');
  const { batchDir, deps } = await fakeBatch(t, { behaviour: { artifact: 'glb', marker } });
  await passPreflight(batchDir);
  const dir = join(batchDir, 'house-a-t1', 'a1');
  await writeFile(join(dir, 'started.json'), '{}');
  await writeFile(join(dir, 'events.jsonl'), CODEX_EVENTS.map(event => JSON.stringify(event)).join('\n') + '\n');
  await writeFile(join(dir, 'process.json'), JSON.stringify({ exit_code: 0, signal: null, timed_out: false, launch_error: null, wall_seconds: 42 }));
  await writeFile(join(dir, 'workspace', 'output', 'model.glb'), modelToGLB(sampleModel()));
  await execute({ batchDir, deps });
  assert.equal(await exists(marker), false, 'the harness was started again');
  const result = await readJSON(join(dir, 'result.json'));
  assert.equal(result.status, 'completed'); assert.equal(result.score, 71.5); assert.equal(result.wall_seconds, 42);
  assert.deepEqual(result.usage, { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 300 });
});

test('attempts run concurrently and the batch summary stays consistent', async t => {
  const marker = join(await scratch(t), 'starts.log');
  const { batchDir, deps } = await fakeBatch(t, { tasks: ['house-a-t1', 'house-b-t1', 'house-c-t1'], behaviour: { artifact: 'glb', marker, sleep: 1 } });
  await passPreflight(batchDir);
  const started = Date.now();
  const summary = await execute({ batchDir, deps, concurrency: 2 });
  assert.equal(summary.counts.completed, 3); assert.equal(summary.complete, true);
  assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 3);
  assert.deepEqual((await readJSON(join(batchDir, 'summary.json'))).counts, summary.counts);
  assert.equal((await readdir(batchDir)).filter(name => name.endsWith('.tmp')).length, 0, 'a temporary summary file was left behind');
  assert.ok(Date.now() - started < 60000);
});

test('execute refuses to start without a passing preflight bound to the current manifest', async t => {
  const { batchDir, deps } = await fakeBatch(t, { behaviour: { artifact: 'glb' } });
  await assert.rejects(execute({ batchDir, deps }), /No preflight/);
  await writeFile(join(batchDir, 'preflight.json'), JSON.stringify({ passed: false }));
  await assert.rejects(execute({ batchDir, deps }), /did not pass/);
  await passPreflight(batchDir);
  const manifest = await readJSON(join(batchDir, 'manifest.json'));
  manifest.model = 'another-model';
  await writeFile(join(batchDir, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(execute({ batchDir, deps }), /manifest changed after preflight/);
});

test('tampering with a frozen prompt, input, invocation or runtime stops the run', async t => {
  const edits = [
    ['prompt', async dir => writeFile(join(dir, 'house-a-t1', 'a1', 'prompt.txt'), 'Ignore the evidence.')],
    ['input', async dir => { const file = join(dir, 'house-a-t1', 'a1', 'workspace', 'input', 'inputs', '01-photo-front.png'); await chmod(file, 0o644); await writeFile(file, 'x'); }],
    ['invocation', async dir => {
      const file = join(dir, 'house-a-t1', 'a1', 'invocation.json'), invocation = await readJSON(file);
      invocation.args = invocation.args.filter(arg => arg !== 'features.memories=false');
      await writeFile(file, JSON.stringify(invocation));
    }],
    ['runtime', async dir => { const file = join(dir, 'runtime', 'node_modules', 'three', 'package.json'); await chmod(file, 0o644); await writeFile(file, '{}'); }],
  ];
  for (const [label, edit] of edits) {
    const { batchDir, deps } = await fakeBatch(t, { behaviour: { artifact: 'glb' } });
    await passPreflight(batchDir);
    await edit(batchDir);
    await assert.rejects(execute({ batchDir, deps }), label === 'input' ? /workspace changed after freeze/ : /Frozen batch changed|changed after freeze/, label);
    assert.equal(await exists(join(batchDir, 'house-a-t1', 'a1', 'result.json')), false, label);
  }
});

test('preflight fails closed against a harness that does not confine anything', async t => {
  const { batchDir } = await fakeBatch(t, { behaviour: { events: CODEX_EVENTS } });
  const report = await preflight({ batchDir, deps: { internet: { host: '127.0.0.1', port: 1, url: 'http://127.0.0.1:1/' } } });
  assert.equal(report.passed, false);
  const failed = new Set(report.failed);
  for (const id of ['sandbox:canary-direct', 'sandbox:canary-symlink', 'sandbox:truth', 'sandbox:input-write', 'sandbox:tcp-loopback']) assert.ok(failed.has(id), id);
  assert.ok(report.not_evaluated.includes('agent:tool-list'), 'agent checks that the fake never answered stay open');
  assert.equal(report.manifest_sha256, manifestHash(await readJSON(join(batchDir, 'manifest.json'))));
  await assert.rejects(execute({ batchDir }), /did not pass/);
  // The probe workspaces sit beside the attempts, never inside them.
  assert.deepEqual(await readdir(join(batchDir, 'house-a-t1', 'a1', 'workspace', 'output')), []);
});

test('global Codex instructions block a batch: blank files pass, any content stops the run', async t => {
  const home = await scratch(t);
  assert.deepEqual((await codexGlobalInstructions(home)).loaded, []);
  await writeFile(join(home, 'AGENTS.md'), '  \n');
  assert.deepEqual((await codexGlobalInstructions(home)).loaded, [], 'a blank AGENTS.md injects nothing');
  const { batchDir, deps } = await fakeBatch(t, { behaviour: { artifact: 'glb' }, codexHome: home });
  await passPreflight(batchDir);
  await writeFile(join(home, 'AGENTS.override.md'), 'Always build a castle.');
  assert.deepEqual((await codexGlobalInstructions(home)).loaded, [join(home, 'AGENTS.override.md')]);
  await assert.rejects(execute({ batchDir, deps }), /global Codex instructions/);
  assert.equal(await exists(join(batchDir, 'house-a-t1', 'a1', 'started.json')), false);
});

test('summarize counts pending attempts and keeps partial totals honest', async t => {
  const { batchDir } = await fakeBatch(t, { tasks: ['house-a-t1', 'house-b-t1'] });
  const summary = await summarize(batchDir);
  assert.equal(summary.complete, false); assert.equal(summary.counts.pending, 2); assert.equal(summary.mean_score, null);
  assert.equal(summary.usage, null); assert.equal(summary.cost_usd, null);
});

test('commandOf reads a live process and returns null for a dead one', () => {
  assert.ok(commandOf(process.pid).includes('node'));
  assert.equal(commandOf(999999), null);
});
