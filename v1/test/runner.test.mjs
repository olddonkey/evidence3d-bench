import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, link, stat, access, readdir, rename } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { encodePNG } from '../lib/png.mjs';
import { modelToGLB } from '../lib/model.mjs';
import { DEFAULT_BUDGET, layout } from '../lib/contract.mjs';
import { sampleModel } from '../fixtures/sample-model.mjs';
import { objectHash } from '../../lib/io.mjs';
import { parseCodexEvents, parseClaudeEvents, toolSurfaceProblems } from '../lib/runner/events.mjs';
import { captureProcess, childEnvironment, assertCleanEnvironment, commandOf, killTree, startTimeOf } from '../lib/runner/process.mjs';
import { classifyStatus, scoreOf } from '../lib/runner/status.mjs';
import { detectInfra, parseResetTime, INFRA_REASONS } from '../lib/runner/infra.mjs';
import { buildPrompt, TOOL_DESCRIPTIONS } from '../lib/runner/prompt.mjs';
import { readArtifact } from '../lib/runner/workspace.mjs';
import { codexConfig, claudeSettings, ADAPTERS, codexGlobalInstructions } from '../lib/runner/adapters.mjs';
import { probePlan, evaluateProbes, verdict, extractProbeOutput, PROBE_SCRIPT } from '../lib/runner/probes.mjs';
import { CREDENTIAL_NAME } from '../lib/runner/process.mjs';
import { prepare, preflight, execute, manifestHash, summarize, batchStatus, moduleClosure, scorerHash, recoverReruns, describeState } from '../lib/runner/index.mjs';
import { retryWatch } from '../lib/runner/infra.mjs';
import { holdUntil, createGate, SCHEDULE } from '../lib/runner/schedule.mjs';
import { evaluateCodexAgent, absenceFailures, coloursNamed, siteColours } from '../lib/runner/preflight.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = path => access(path).then(() => true, () => false);
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'e3d-runner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------- fixtures

async function makeDataRoot(root, taskIds, { wall = DEFAULT_BUDGET.wall_seconds, sets = {} } = {}) {
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
      object: 'fixture', variant: 't1', scale_evidence: 'none', evidence: ['photo-front'], alternates: [], ...(sets[id] ? { set: sets[id] } : {}) }));
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
//   artifact    'glb' | 'slow' | 'invalid' | 'throw' | 'symlink-truth' | 'hardlink' | null
//   sleep       seconds to wait after printing (simulates a long session)
//   exit        exit code
//   grandchild  a marker string: a detached grandchild carrying it in its argv
//               writes its pid to <marker file>.pid and idles until killed
//   envDump     path where the environment variable names are written
//   tamperInput modify input/task.json (a fake is not sandboxed)
//   marker      file created on every start (to prove an attempt was not re-run)
//   byTask      { <task id>: behaviour } overrides for the attempt whose workspace is that task's
//   sequence    [behaviour, ...] overrides by call number per task (the last one repeats), counted
//               in the file `counter`: the binary is frozen, so a fake that must fail first and
//               work later reads its script from data
//   events may carry "$RESETS_IN:<s>", replaced at run time by the epoch second s seconds ahead
//   limitFile   while this file holds an epoch ms in the future, the call behaves as `limited`
//               instead (one usage limit shared by several batches, as on one login)
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
for (const [task, own] of Object.entries(behaviour.byTask ?? {})) if (ws.includes(path.sep + task + path.sep)) Object.assign(behaviour, own);
if (behaviour.sequence && behaviour.counter) {
  const file = behaviour.counter + '-' + path.basename(path.dirname(path.dirname(ws)));
  const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
  fs.writeFileSync(file, String(n + 1));
  Object.assign(behaviour, behaviour.sequence[Math.min(n, behaviour.sequence.length - 1)]);
}
if (behaviour.limitFile && fs.existsSync(behaviour.limitFile) && Number(fs.readFileSync(behaviour.limitFile, 'utf8')) > Date.now()) Object.assign(behaviour, behaviour.limited);
const fill = value => typeof value === 'string' && value.startsWith('$RESETS_IN:') ? Math.floor(Date.now() / 1000) + Number(value.slice(11))
  : Array.isArray(value) ? value.map(fill) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)])) : value;
behaviour.events = fill(behaviour.events);
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
if (behaviour.marker) fs.appendFileSync(behaviour.marker, 'started\\n');
if (behaviour.envDump) fs.writeFileSync(behaviour.envDump, JSON.stringify(Object.keys(process.env).sort()));
if (behaviour.tamperInput) { const file = path.join(ws, 'input', 'task.json'); fs.chmodSync(file, 0o644); fs.appendFileSync(file, ' '); }
const out = path.join(ws, 'output', 'model.glb');
if (behaviour.artifact === 'glb') fs.copyFileSync(${JSON.stringify(join(dir, 'sample.glb'))}, out);
if (behaviour.artifact === 'slow') fs.writeFileSync(out, 'SLOWGLB');
if (behaviour.artifact === 'invalid') fs.writeFileSync(out, 'INVALID');
if (behaviour.artifact === 'throw') fs.writeFileSync(out, 'THROW');
if (behaviour.artifact === 'symlink-truth') fs.symlinkSync(behaviour.truthPath, out);
if (behaviour.artifact === 'hardlink') fs.linkSync(behaviour.truthPath, out);
if (behaviour.notes) fs.writeFileSync(path.join(ws, 'output', 'notes.md'), 'notes');
if (behaviour.grandchild) {
  const script = 'require("fs").writeFileSync(process.argv[1] + ".pid", String(process.pid)); setInterval(() => {}, 1000)';
  spawn(process.execPath, ['-e', script, behaviour.grandchild], { detached: true, stdio: 'ignore' }).unref();
}
for (const event of behaviour.events ?? []) process.stdout.write(JSON.stringify(event) + '\\n');
setTimeout(() => process.exit(behaviour.exit ?? 0), (behaviour.sleep ?? 0) * 1000);
`);
  await chmod(path, 0o755);
  return path;
}

// The same fake as a /bin/sh script, for tests whose wall clock is short: a
// shell starts in milliseconds under any load, where Node can take seconds,
// so what it prints is there before the deadline. Supports artifact 'glb',
// events, sleep and exit, and repeat: { event, seconds } printed forever.
async function fakeShellCLI(dir, name, behaviour) {
  const path = join(dir, name), quote = text => "'" + String(text).replaceAll("'", "'\\''") + "'";
  const lines = ['#!/bin/sh', 'ws=$PWD', 'while [ $# -gt 0 ]; do if [ "$1" = "-C" ]; then ws=$2; fi; shift; done', 'cat > /dev/null'];
  if (behaviour.artifact === 'glb') lines.push('cp ' + quote(join(dir, 'sample.glb')) + ' "$ws/output/model.glb"');
  for (const event of behaviour.events ?? []) lines.push('printf "%s\\n" ' + quote(JSON.stringify(event)));
  if (behaviour.repeat) lines.push('while :; do printf "%s\\n" ' + quote(JSON.stringify(behaviour.repeat.event)) + '; sleep ' + behaviour.repeat.seconds + '; done');
  lines.push('sleep ' + (behaviour.sleep ?? 0), 'exit ' + (behaviour.exit ?? 0));
  await writeFile(path, lines.join('\n') + '\n');
  await chmod(path, 0o755);
  return path;
}

// slowFlag: while this file exists, the next scoring deletes it, creates
// <slowFlag>.entered and then takes 30 s, long enough to be interrupted.
const fakeScorer = (callLog, slowFlag) => `import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
export async function scoreSubmission({ glb, taskDir, truthDir, outDir }) {
  appendFileSync(${JSON.stringify(callLog)}, 'x');
  const text = glb.subarray(0, 7).toString('latin1');
  if (text === 'SLOWGLB' && existsSync(${JSON.stringify(slowFlag)})) {
    unlinkSync(${JSON.stringify(slowFlag)}); writeFileSync(${JSON.stringify(slowFlag + '.entered')}, '');
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
  if (text === 'THROW') throw new Error('scorer exploded');
  if (text === 'INVALID') return { schema: 'e3d-report-v1', valid: false, error: 'Invalid GLB 2.0 header', score: 0 };
  return { schema: 'e3d-report-v1', valid: true, error: null, score: 71.5, bytes: glb.length, taskDir, truthDir, outDir };
}
`;

// Live processes (zombies aside) whose command line contains text.
function liveWith(text) {
  const table = execFileSync('/bin/ps', ['-A', '-ww', '-o', 'pid=,stat=,args='], { encoding: 'utf8' });
  return table.split('\n').filter(line => line.includes(text) && !/^\s*\d+\s+Z/.test(line)).map(line => Number(line.trim().split(/\s+/)[0]));
}

// SIGKILL takes effect as soon as the kernel schedules the target; a process
// that is still listed a moment after it was killed is not a survivor. This
// waits for that (normally zero rounds), never for anything to happen.
async function noneLeft(text, limitMs = 5000) {
  for (const deadline = Date.now() + limitMs; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 50))) {
    if (!liveWith(text).length) return [];
  }
  return liveWith(text);
}

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

// Holds measured in milliseconds, so waiting and resuming can be tested.
const FAST = { limitStepsMs: [300, 600], retryStepsMs: [100, 200], resetJitterMs: [0, 50], backoffJitter: 0.1, minimumWaitMs: 0, resumeSpacingMs: 100 };

// prepare() with a fake harness; returns everything a test needs.
async function fakeBatch(t, { system = 'codex', behaviour = {}, tasks = ['house-a-t1'], attempts = 1, wall, codexHome, shell = false, id = 'batch-1', repoRoot, sets,
  before = async () => {} } = {}) {
  const dir = await scratch(t), dataRoot = join(dir, 'data');
  await makeDataRoot(dataRoot, tasks, { wall, sets });
  await before(dataRoot);
  await writeFile(join(dir, 'sample.glb'), modelToGLB(sampleModel()));
  const events = behaviour.events ?? (system === 'codex' ? CODEX_EVENTS : CLAUDE_EVENTS);
  const counter = join(dir, 'calls');
  const binary = await (shell ? fakeShellCLI : fakeCLI)(dir, 'fake-' + system, { ...behaviour, events, counter });
  const scorer = join(dir, 'fake-scorer.mjs');
  await writeFile(scorer, fakeScorer(join(dir, 'scorer-calls.log'), join(dir, 'slow-once')));
  const inspect = async ({ model, effort }) => ({ system, binary, binary_realpath: binary, binary_sha256: sha(await readFile(binary)),
    version: 'fake 1.0', release_root: dir, login: 'test', model, effort: effort ?? 'low', effort_levels: ['low', 'high'], codex_home: codexHome });
  const { batchDir, manifest } = await prepare({ id, system, model: 'test-model', effort: 'low', tasks, attempts, dataRoot, ...(repoRoot ? { repoRoot } : {}),
    deps: { inspect, installTools: fakeInstallTools } });
  const deps = { scorerModule: scorer, graceSeconds: 1, schedule: FAST };
  const calls = async task => Number(await readFile(counter + '-' + task, 'utf8').catch(() => '0'));
  return { dir, dataRoot, batchDir, manifest, binary, scorer, deps, calls };
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

// A leader that spawns a detached (setsid) grandchild, waits until the
// grandchild has written its pid, prints {"type":"ready"} and idles.
async function treeFake(dir) {
  const marker = join(dir, 'grandchild-marker'), path = join(dir, 'tree-leader');
  await writeFile(path, `#!${process.execPath}
const fs = require('fs'), { spawn } = require('child_process');
const script = 'require("fs").writeFileSync(process.argv[1] + ".pid", String(process.pid)); setInterval(() => {}, 1000)';
spawn(process.execPath, ['-e', script, ${JSON.stringify(marker)}], { detached: true, stdio: 'ignore' }).unref();
// The file exists as soon as writeFileSync has created it: wait for its content.
const written = () => { try { return /^\\d+$/.test(fs.readFileSync(${JSON.stringify(marker + '.pid')}, 'utf8')); } catch { return false; } };
const wait = () => written() ? (process.stdout.write('{"type":"ready"}\\n'), setInterval(() => {}, 1000)) : setTimeout(wait, 5);
wait();
`);
  await chmod(path, 0o755);
  return { path, marker };
}

test('killTree kills a whole live tree, including a detached grandchild', async t => {
  // No timers: the tree is fully up (the grandchild wrote its pid) before the kill.
  const dir = await scratch(t), { path, marker } = await treeFake(dir);
  const leader = spawn(path, [], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise(resolve => leader.on('exit', resolve));
  await new Promise(resolve => leader.stdout.on('data', chunk => { if (String(chunk).includes('ready')) resolve(); }));
  const grandchild = Number(await readFile(marker + '.pid', 'utf8'));
  assert.deepEqual(liveWith(marker), [grandchild], 'the grandchild runs before the kill');
  const signalled = killTree(leader.pid, 'SIGTERM');
  assert.ok(signalled.includes(leader.pid) && signalled.includes(grandchild), 'both were found: ' + signalled);
  await exited;
  assert.deepEqual(await noneLeft(marker), [], 'the detached grandchild survived');
});

test('a wall-clock overrun kills the whole process tree, including a detached grandchild', async t => {
  // Deterministic under any load: the assertion is that nothing carrying the
  // marker is alive afterwards, which holds whether the timer fired before or
  // after the grandchild came up; when it did come up, its own pid is checked.
  const dir = await scratch(t), { path, marker } = await treeFake(dir), events = [];
  const run = await captureProcess(path, [], { cwd: dir, seconds: 1.5, graceSeconds: 0.5, onEvent: event => events.push(event) });
  assert.equal(run.timed_out, true); assert.ok(run.wall_seconds < 5, 'took ' + run.wall_seconds);
  assert.deepEqual(await noneLeft(marker), [], 'a process of the tree survived');
  if (events.some(event => event.type === 'ready')) {
    const grandchild = Number(await readFile(marker + '.pid', 'utf8'));
    assert.throws(() => process.kill(grandchild, 0), /ESRCH/, 'the grandchild is alive');
  }
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

test('status classification follows the precedence infra > timeout > failed > missing > invalid > score error > completed', () => {
  const ok = { exit_code: 0, signal: null, timed_out: false }, done = { completed: true };
  const artifact = { present: true, problem: null }, report = { valid: true, score: 50 }, infra = { reason: 'usage_limit' };
  assert.equal(classifyStatus({ run: { ...ok, timed_out: true }, summary: done, artifact, report, infra }), 'infra_error');
  assert.equal(classifyStatus({ run: { ...ok, timed_out: true }, summary: done, artifact, report, infra, integrityProblems: ['input/ changed'] }), 'timeout',
    'a broken boundary is never excused as an infrastructure error');
  assert.equal(classifyStatus({ run: { ...ok, exit_code: 1 }, summary: done, artifact, report, infra, integrityProblems: ['input/ changed'] }), 'generation_failed');
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

// ---------------------------------------------------------------- infrastructure errors
//
// The event shapes below are copies of what the real CLIs printed (codex-cli
// 0.159.2, Claude Code 2.1.285): live sessions with a bogus model id, no
// login or no network, and the real CLIs against a local server returning
// 429/500/503/529/401/TLS failures. Shapes marked "inferred" were read from
// the binaries only (a real usage limit cannot be provoked on purpose).

const CODEX_START = [{ type: 'thread.started', thread_id: 't-1' }, { type: 'turn.started' }];
const codexFails = (...messages) => [...CODEX_START, ...messages.slice(0, -1).map(message => ({ type: 'error', message })),
  { type: 'error', message: messages.at(-1) }, { type: 'turn.failed', error: { message: messages.at(-1) } }];
const CODEX_WORK = [{ type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'node build.mjs', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Building the house.' } }];
const CODEX_USAGE_LIMIT = 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 7:50 PM.';
const CODEX_WAITING = 'Reconnecting... waiting for network (Connection failed: error sending request)';

const CLAUDE_INIT = CLAUDE_EVENTS[0];
const CLAUDE_WORK = CLAUDE_EVENTS.slice(1, 5);
const claudeFails = ({ text, error, status = null, retries = [], terminal = 'api_error' }) => [
  ...retries.map((retry, i) => ({ type: 'system', subtype: 'api_retry', attempt: i + 1, max_retries: retries.length, retry_delay_ms: 541, error_status: status, error: retry })),
  { type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] }, error, is_api_error_message: true },
  { type: 'result', subtype: 'success', is_error: true, num_turns: 1, terminal_reason: terminal, api_error_status: status, result: text, total_cost_usd: 0,
    usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, permission_denials: [] },
];

const failedRun = (fields = {}) => ({ exit_code: 1, signal: null, timed_out: false, launch_error: null, wall_seconds: 3, finished_at: '2026-10-02T00:33:00.000Z', stderr: '', ...fields });
const timedOutRun = (fields = {}) => failedRun({ exit_code: null, signal: 'SIGTERM', timed_out: true, wall_seconds: 1805, ...fields });
const infraOf = (system, events, run = failedRun(), extra = {}) =>
  detectInfra({ system, events, run, summary: system === 'codex' ? parseCodexEvents(events) : parseClaudeEvents(events), now: Date.parse(run.finished_at), ...extra });

test('codex failures are classified from the CLI\'s own messages', () => {
  const cases = [
    [codexFails(CODEX_USAGE_LIMIT), 'usage_limit'],
    [codexFails('exceeded retry limit, last status: 429 Too Many Requests'), 'rate_limit'],
    [codexFails('Reconnecting... 1/1 (We’re currently experiencing high demand, which may cause temporary errors.)', 'We’re currently experiencing high demand, which may cause temporary errors.'), 'overloaded'],
    [codexFails('unexpected status 503 Service Unavailable: Service temporarily unavailable, url: http://127.0.0.1:18442/v1/responses'), 'server_error'],
    [codexFails('Reconnecting... 5/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses)',
      'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a43fb3bcce11f4ef-LAX'), 'auth'],
    [codexFails('Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.'), 'auth'], // inferred
    [codexFails('Quota exceeded. Check your plan and billing details.'), 'billing'],
    [codexFails('Your workspace is out of credits. Add credits to continue.'), 'billing'], // inferred
    [codexFails('{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-bogus-model-0\' model is not supported when using Codex with a ChatGPT account."}}'), 'model_unavailable'],
    [codexFails('Reconnecting... 5/5 (workspace routing discovery failed)', 'workspace routing discovery failed'), 'network'],
    [codexFails('Selected model is at capacity. Please try a different model.'), 'overloaded'], // inferred
  ];
  for (const [events, reason] of cases) {
    const infra = infraOf('codex', events);
    assert.equal(infra?.reason, reason, events.at(-1).error.message);
    assert.equal(infra.action, INFRA_REASONS[reason]); assert.equal(infra.during, 'startup');
    assert.ok(infra.evidence.includes(events.at(-1).error.message), 'the raw message is kept');
  }
  // The same failure after model turns is still not a sample of the model.
  const midway = infraOf('codex', [...CODEX_START, ...CODEX_WORK, ...codexFails(CODEX_USAGE_LIMIT).slice(2)]);
  assert.equal(midway.reason, 'usage_limit'); assert.equal(midway.during, 'session'); assert.equal(midway.model_turns, 2);
});

test('claude failures are classified from its error category and message', () => {
  const cases = [
    [{ text: 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.', error: 'server_error', status: 529, retries: ['overloaded', 'overloaded'] }, 'overloaded'],
    [{ text: 'API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment.', error: 'server_error', status: 500, retries: ['server_error'] }, 'server_error'],
    [{ text: 'API Error: Can\'t reach the API server — check your internet or DNS (ENOTFOUND)', error: 'server_error', retries: ['unknown', 'unknown'] }, 'network'],
    [{ text: 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)', error: 'server_error' }, 'network'],
    [{ text: 'API Error: Unable to connect to API: Self-signed certificate detected (DEPTH_ZERO_SELF_SIGNED_CERT).', error: 'server_error' }, 'network'],
    [{ text: 'Not logged in · Please run /login', error: 'authentication_failed' }, 'auth'],
    [{ text: 'Invalid API key · Fix external API key', error: 'authentication_failed', status: 401, retries: ['authentication_failed'] }, 'auth'],
    [{ text: 'Failed to authenticate: OAuth session expired and could not be refreshed', error: 'authentication_failed' }, 'auth'], // inferred
    [{ text: 'Credit balance is too low', error: 'billing_error', status: 400 }, 'billing'],
    [{ text: 'There\'s an issue with the selected model (claude-bogus-model-0). It may not exist or you may not have access to it. Run --model to pick a different model.', error: 'model_not_found', status: 404 }, 'model_unavailable'],
    [{ text: 'API Error: Request rejected (429) · Number of request tokens has exceeded your per-minute rate limit', error: 'rate_limit', status: 429, retries: ['rate_limit', 'rate_limit'] }, 'rate_limit'],
    [{ text: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited', error: 'rate_limit', status: 429 }, 'rate_limit'], // inferred
    [{ text: 'You\'ve hit your session limit · resets 7:50pm (America/Los_Angeles)', error: 'rate_limit', status: 429 }, 'usage_limit'], // inferred
  ];
  for (const [shape, reason] of cases) {
    const infra = infraOf('claude-code', [CLAUDE_INIT, ...claudeFails(shape)]);
    assert.equal(infra?.reason, reason, shape.text); assert.equal(infra.during, 'startup');
  }
  const midway = infraOf('claude-code', [CLAUDE_INIT, ...CLAUDE_WORK, ...claudeFails(cases[0][0])]);
  assert.equal(midway.reason, 'overloaded'); assert.equal(midway.during, 'session'); assert.ok(midway.model_turns > 0);
});

test('a stated reset time becomes retry_after; an unparseable or implausible one does not', () => {
  // Codex prints local wall-clock time; "today" unless a date is given.
  const seen = new Date(2026, 9, 1, 17, 33).getTime();
  const codex = infraOf('codex', codexFails(CODEX_USAGE_LIMIT), failedRun({ finished_at: new Date(seen).toISOString() }));
  assert.equal(codex.retry_after, new Date(2026, 9, 1, 19, 50).toISOString()); assert.equal(codex.retry_after_source, 'message');
  const dated = infraOf('codex', codexFails(CODEX_USAGE_LIMIT.replace('7:50 PM', 'Oct 3rd, 2026 7:50 PM')), failedRun({ finished_at: new Date(seen).toISOString() }));
  assert.equal(dated.retry_after, new Date(2026, 9, 3, 19, 50).toISOString());
  assert.equal(parseResetTime('7:50 PM', { now: new Date(2026, 9, 1, 20, 0).getTime() }).at, new Date(2026, 9, 2, 19, 50).toISOString(), 'past today means tomorrow');
  // Claude names the zone it printed in.
  const claude = infraOf('claude-code', [CLAUDE_INIT, ...claudeFails({ text: 'You\'ve hit your session limit · resets 7:50pm (America/Los_Angeles)', error: 'rate_limit', status: 429 })]);
  assert.equal(claude.retry_after, '2026-10-02T02:50:00.000Z');
  assert.equal(parseResetTime('Oct 3, 7pm (America/New_York)', { now: Date.parse('2026-10-02T00:00:00Z') }).at, '2026-10-03T23:00:00.000Z');
  // The structured rate_limit_event wins over the text (inferred: only "allowed" was seen live).
  const event = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790960400, rateLimitType: 'five_hour' } };
  const structured = infraOf('claude-code', [CLAUDE_INIT, event, ...claudeFails({ text: 'You\'ve hit your session limit', error: 'rate_limit', status: 429 })]);
  assert.equal(structured.retry_after, new Date(1790960400 * 1000).toISOString()); assert.equal(structured.retry_after_source, 'rate_limit_event');
  assert.equal(parseResetTime('soon'), null);
  assert.equal(parseResetTime('Oct 30, 7pm (UTC)', { now: Date.parse('2026-10-02T00:00:00Z') }), null, 'more than eight days out');
  assert.equal(infraOf('codex', codexFails('You’ve hit your usage limit.')).retry_after, null);
});

test('a timeout is an infrastructure error only if the CLI was still retrying the service at the deadline', () => {
  const limit = 1800, waiting = [...CODEX_START, ...CODEX_WORK, ...Array.from({ length: 3 }, () => ({ type: 'error', message: CODEX_WAITING }))];
  const at = offsets => ({ eventMs: offsets, wallLimitSeconds: limit });
  // Live shape: Codex waits for the network indefinitely, repeating this line.
  const stuck = infraOf('codex', waiting, timedOutRun(), at([0, 5, 9000, 12000, 1700000, 1750000, 1797000]));
  assert.equal(stuck.reason, 'network'); assert.equal(stuck.during, 'timeout');
  // The model worked after the reconnect (pilot shape): a real timeout.
  assert.equal(infraOf('codex', [...waiting, CODEX_WORK[1]], timedOutRun(), at([0, 5, 9000, 12000, 20000, 21000, 22000, 1790000])), null);
  // Silence long after a reconnect: the stream came back and the model was thinking.
  assert.equal(infraOf('codex', waiting, timedOutRun(), at([0, 5, 9000, 12000, 300000, 310000, 320000])), null);
  // Claude in a 529 storm at the deadline; its retry delay is part of the window.
  const storm = [CLAUDE_INIT, ...CLAUDE_WORK, { type: 'system', subtype: 'api_retry', attempt: 7, max_retries: 10, retry_delay_ms: 32000, error_status: 529, error: 'overloaded' }];
  assert.equal(infraOf('claude-code', storm, timedOutRun(), at([0, 10, 20, 30, 40, 1700000])).reason, 'overloaded');
  // No event times (a run rebuilt from logs): the last event decides.
  assert.equal(infraOf('claude-code', storm, timedOutRun()).reason, 'overloaded');
  // A CLI that never produced a model turn in its whole budget.
  assert.equal(infraOf('codex', CODEX_START, timedOutRun()).reason, 'cli_stalled');
  assert.equal(infraOf('codex', [...CODEX_START, ...CODEX_WORK], timedOutRun()), null);
});

test('model failures, completed sessions and recovered transients are never infrastructure errors', () => {
  // Pilot shape: reconnects mid-session, then the session completed (and stderr had ERROR lines).
  const recovered = [...CODEX_START, { type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion: IO error: Broken pipe (os error 32))' },
    { type: 'item.completed', item: { id: 'i5', type: 'error', message: 'Falling back from WebSockets to HTTPS transport. stream disconnected before completion: IO error: Broken pipe (os error 32)' } },
    ...CODEX_EVENTS.slice(2)];
  assert.equal(infraOf('codex', recovered, failedRun({ exit_code: 0, stderr: 'ERROR codex_models_manager::manager: failed to refresh available models: request timed out' })), null);
  assert.equal(infraOf('codex', recovered, failedRun({ exit_code: 1 })), null, 'a completed session is not blamed on the service');
  assert.equal(infraOf('claude-code', CLAUDE_EVENTS, failedRun({ exit_code: 0 })), null);
  // The model filled its context, or ended for its own reasons.
  assert.equal(infraOf('codex', [...CODEX_START, ...CODEX_WORK, { type: 'turn.failed', error: { message: 'Codex ran out of room in the model\'s context window. Start a new thread or clear earlier history before retrying.' } }]), null);
  assert.equal(infraOf('claude-code', [CLAUDE_INIT, ...CLAUDE_WORK, ...claudeFails({ text: 'Prompt is too long', error: 'invalid_request', status: 400 })]), null);
  const maxTurns = [CLAUDE_INIT, ...claudeFails({ text: 'API Error: 500', error: 'server_error', status: 500 }).slice(0, 1), ...CLAUDE_WORK,
    { type: 'result', subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns', num_turns: 40 }];
  assert.equal(infraOf('claude-code', maxTurns), null, 'an API error the session recovered from is not its cause');
  // Unknown errors: after model turns the model's, before any the harness's.
  assert.equal(infraOf('codex', [...CODEX_START, ...CODEX_WORK, { type: 'turn.failed', error: { message: 'something nobody has seen' } }]), null);
  const crash = infraOf('codex', [], failedRun({ exit_code: 101, stderr: 'thread main panicked' }));
  assert.equal(crash.reason, 'cli_crash'); assert.ok(crash.evidence.some(line => line.includes('panicked')));
  assert.equal(infraOf('codex', [], failedRun({ exit_code: null, launch_error: 'spawn /x ENOENT' })).reason, 'cli_crash');
  assert.equal(infraOf('codex', [...CODEX_START, { type: 'turn.failed', error: { message: 'cyber policy violation' } }]), null, 'a policy refusal is not retried away');
});

test('the classifier leaves every stored pilot shape alone', () => {
  // Timed-out pilot attempts ended in model work (astra house-0011-t4 had
  // five reconnects earlier); the Claude timeouts ended in tool results.
  const astra = [...CODEX_START, { type: 'error', message: 'Reconnecting... 5/5 (stream disconnected before completion: IO error: Broken pipe (os error 32))' }, ...CODEX_WORK];
  assert.equal(infraOf('codex', astra, timedOutRun()), null);
  assert.equal(infraOf('claude-code', [CLAUDE_INIT, ...CLAUDE_WORK], timedOutRun()), null);
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
  const { batchDir, deps } = await fakeBatch(t, { wall: 2, shell: true, behaviour: { artifact: 'glb', sleep: 60 } });
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
    // A failure after model turns, for a reason that is the model's own.
    [{ artifact: null, events: [...CODEX_START, ...CODEX_WORK, { type: 'turn.failed', error: { message: 'Codex ran out of room in the model\'s context window.' } }], exit: 1 }, 'generation_failed', null],
  ];
  for (const [behaviour, status, report] of cases) {
    const { batchDir, deps } = await fakeBatch(t, { behaviour });
    await passPreflight(batchDir);
    await execute({ batchDir, deps });
    const result = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
    assert.equal(result.status, status, JSON.stringify(behaviour));
    assert.equal(result.report, report, status);
    if (status !== 'generation_failed') assert.equal(result.score, 0, status);
    const summary = await summarize(batchDir);
    // A scorer failure is the scorer's, not the model's: owed a re-score, not averaged.
    assert.deepEqual([summary.samples, summary.complete], status === 'score_error' ? [0, false] : [1, true], status);
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

test('execute resumes: finished attempts are skipped and never overwritten, an interrupted one is archived and run again from scratch', async t => {
  const marker = join(await scratch(t), 'starts.log');
  const { batchDir, deps } = await fakeBatch(t, { tasks: ['house-a-t1', 'house-b-t1'], behaviour: { artifact: 'glb', marker } });
  await passPreflight(batchDir);
  // Simulate a runner that died while the second attempt was running; the
  // contestant had already written a model, which must not be scored.
  await writeFile(join(batchDir, 'house-b-t1', 'a1', 'started.json'), '{}');
  await writeFile(join(batchDir, 'house-b-t1', 'a1', 'workspace', 'output', 'model.glb'), modelToGLB(sampleModel()));
  const summary = await execute({ batchDir, deps });
  assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 2, 'the fresh attempt ran, and the interrupted one ran again');
  const first = await readFile(join(batchDir, 'house-a-t1', 'a1', 'result.json'), 'utf8');
  // The interrupted try is kept as it was: an unscored infrastructure error with the model it left.
  const archive = join(batchDir, 'house-b-t1', 'a1.infra-1');
  const interrupted = await readJSON(join(archive, 'result.json'));
  assert.equal(interrupted.status, 'infra_error'); assert.equal(interrupted.infra.reason, 'runner_interrupted');
  assert.equal(interrupted.score, null, 'an unsupervised run is not scored and not a sample');
  assert.equal(interrupted.report, null);
  assert.ok(await exists(join(archive, 'workspace', 'output', 'model.glb')), 'the archived try keeps what it left');
  assert.equal(await exists(join(archive, 'score')), false, 'and was never scored');
  // The re-run started from a pristine workspace with the frozen prompt and invocation.
  const rerun = await readJSON(join(batchDir, 'house-b-t1', 'a1', 'result.json'));
  assert.equal(rerun.status, 'completed'); assert.equal(rerun.try, 2);
  assert.deepEqual(rerun.tries.map(item => [item.dir, item.status, item.reason]), [['a1.infra-1', 'infra_error', 'runner_interrupted']]);
  assert.equal(summary.counts.completed, 2); assert.equal(summary.counts.infra_error, 0); assert.equal(summary.complete, true);
  assert.equal(summary.infra.reruns, 1); assert.equal(summary.mean_score, 71.5);
  const again = await execute({ batchDir, deps });
  assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 2, 'nothing ran again');
  assert.equal(await readFile(join(batchDir, 'house-a-t1', 'a1', 'result.json'), 'utf8'), first);
  assert.deepEqual(again.counts, summary.counts);
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

test('a usage limit is an infrastructure error: not scored, not averaged, its reset time kept', async t => {
  // Live shape (real codex against a local server answering usage_limit_reached),
  // after the model had already built something. The reset is two hours from
  // now: a fixed "7:50 PM" read just after 19:50 local time is today, already
  // past, and the run would not stop for it.
  const reset = new Date(Date.now() + 2 * 3600000), hours = reset.getHours();
  const limitText = CODEX_USAGE_LIMIT.replace('7:50 PM', (hours % 12 || 12) + ':' + String(reset.getMinutes()).padStart(2, '0') + (hours < 12 ? ' AM' : ' PM'));
  const events = [...CODEX_START, ...CODEX_WORK, { type: 'error', message: limitText }, { type: 'turn.failed', error: { message: limitText } }];
  const { batchDir, deps, dir } = await fakeBatch(t, { tasks: ['house-a-t1', 'house-b-t1'],
    behaviour: { artifact: 'glb', byTask: { 'house-b-t1': { events, exit: 1 } } } });
  await passPreflight(batchDir);
  const lines = [];
  // With waiting disabled the run ends at the limit and says until when.
  const stopped = await execute({ batchDir, deps, wait: false, log: event => event.event === 'progress' && lines.push(event.line) }).catch(error => error);
  assert.equal(stopped.code, 'E3D_WAIT', String(stopped.stack ?? stopped));
  assert.equal(stopped.hold.reason, 'usage_limit'); assert.equal(stopped.hold.basis, 'retry_after');
  const summary = stopped.summary;
  const result = await readJSON(join(batchDir, 'house-b-t1', 'a1', 'result.json'));
  assert.ok(Date.parse(stopped.hold.until_at) >= Date.parse(result.infra.retry_after), 'the hold ends after the stated reset');
  assert.equal(result.status, 'infra_error'); assert.equal(result.score, null); assert.equal(result.report, null);
  assert.equal(result.infra.reason, 'usage_limit'); assert.equal(result.infra.action, 'wait'); assert.equal(result.infra.during, 'session');
  assert.ok(result.infra.retry_after && Date.parse(result.infra.retry_after) > Date.parse(result.finished_at) - 300000, 'retry_after ' + result.infra.retry_after);
  assert.ok(result.infra.evidence.includes(limitText));
  assert.ok(result.artifact.sha256, 'the artifact is recorded'); assert.equal(await exists(join(batchDir, 'house-b-t1', 'a1', 'score')), false, 'but not scored');
  assert.equal((await readFile(join(dir, 'scorer-calls.log'), 'utf8')).length, 1, 'only the real sample was scored');
  assert.deepEqual([summary.counts.completed, summary.counts.infra_error, summary.samples, summary.pending], [1, 1, 1, 0]);
  assert.equal(summary.mean_score, 71.5); assert.equal(summary.mean_score_completed, 71.5); assert.equal(summary.complete, false);
  assert.deepEqual(summary.infra.by_reason, { usage_limit: 1 }); assert.equal(summary.infra.retry_after, result.infra.retry_after);
  assert.deepEqual(summary.tasks.map(task => [task.id, task.samples, task.infra_error, task.mean_score]), [['house-a-t1', 1, 0, 71.5], ['house-b-t1', 0, 1, null]]);
  // One compact progress line per finished attempt, on disk and in the log,
  // and one for the wait that ended the run.
  const progress = (await readFile(join(batchDir, 'progress.log'), 'utf8')).trim().split('\n');
  assert.deepEqual(progress.filter(line => !/  WAIT /.test(line)), lines); assert.equal(lines.length, 2);
  assert.match(progress.find(line => line.includes('  house-b-t1/a1  ')), /infra_error usage_limit until \S+Z/);
  assert.match(progress.find(line => line.includes('house-a-t1')), /completed 71\.5 .*load \d/);
  // The hold is in force before the attempt's own line is written, so the WAIT line comes first.
  const waits = progress.filter(line => /  WAIT /.test(line));
  assert.equal(waits.length, 1); assert.match(waits[0], /WAIT usage_limit until \S+Z .*house-b-t1\/a1: You’ve hit your usage limit.*--no-wait: exiting instead/);
  // status says why nothing runs and until when, from the saved runner state.
  const status = await batchStatus(batchDir);
  assert.match(status.state, /EXITED INSTEAD OF WAITING \(--no-wait\): usage_limit until \S+Z/);
  // Restarted during the hold, a runner does not walk back into the limit.
  const marker = await readFile(join(dir, 'scorer-calls.log'), 'utf8');
  const again = await execute({ batchDir, deps, wait: false }).catch(error => error);
  assert.equal(again.code, 'E3D_WAIT'); assert.equal(await readFile(join(dir, 'scorer-calls.log'), 'utf8'), marker);
  assert.equal(await exists(join(batchDir, 'house-b-t1', 'a1.infra-1')), false, 'nothing was re-run during the hold');
  // Timing and machine load are kept per attempt.
  const done = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
  for (const key of ['attempt_started_at', 'started_at', 'finished_at', 'result_at']) assert.ok(Date.parse(done[key]), key);
  assert.ok(done.load_1m.samples >= 2 && done.load_1m.max >= done.load_1m.mean && done.load_1m.cpus > 0, JSON.stringify(done.load_1m));
  // Earlier tries kept beside an attempt (a<n>.infra-<k>/) are counted as re-runs.
  await mkdir(join(batchDir, 'house-b-t1', 'a1.infra-1'));
  const counted = await summarize(batchDir);
  assert.equal(counted.infra.reruns, 1); assert.equal(counted.tasks[1].infra_reruns, 1);
});

test('claude overloaded mid-session and codex waiting for the network at the deadline are infrastructure errors', async t => {
  const overloaded = [CLAUDE_INIT, ...CLAUDE_WORK, ...claudeFails({ text: 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
    error: 'server_error', status: 529, retries: ['overloaded', 'overloaded'] })];
  const claude = await fakeBatch(t, { system: 'claude-code', behaviour: { artifact: 'glb', events: overloaded, exit: 1 } });
  await passPreflight(claude.batchDir);
  // wait: false ends the run at the first infrastructure error, so the
  // result of the first try can be read as it was recorded.
  assert.equal((await execute({ batchDir: claude.batchDir, deps: claude.deps, wait: false }).catch(error => error)).code, 'E3D_WAIT');
  const first = await readJSON(join(claude.batchDir, 'house-a-t1', 'a1', 'result.json'));
  assert.equal(first.status, 'infra_error'); assert.equal(first.infra.reason, 'overloaded'); assert.equal(first.infra.during, 'session');
  // Live shape: with the service unreachable mid-session, Codex prints this
  // about every 45 s and never gives up; the wall clock ends it.
  const waiting = [...CODEX_START, ...CODEX_WORK, { type: 'error', message: CODEX_WAITING }];
  const codex = await fakeBatch(t, { wall: 2, shell: true, behaviour: { artifact: 'glb', events: waiting, sleep: 60 } });
  await passPreflight(codex.batchDir);
  assert.equal((await execute({ batchDir: codex.batchDir, deps: codex.deps, wait: false }).catch(error => error)).code, 'E3D_WAIT');
  const second = await readJSON(join(codex.batchDir, 'house-a-t1', 'a1', 'result.json'));
  assert.equal(second.status, 'infra_error'); assert.equal(second.infra.reason, 'network'); assert.equal(second.infra.during, 'timeout');
  assert.equal(second.timed_out, true); assert.equal(second.score, null);
});

test('a broken boundary is never excused as an infrastructure error', async t => {
  const events = [...CODEX_START, { type: 'turn.failed', error: { message: CODEX_USAGE_LIMIT } }];
  const { batchDir, deps } = await fakeBatch(t, { behaviour: { artifact: 'glb', tamperInput: true, events, exit: 1 } });
  await passPreflight(batchDir);
  await execute({ batchDir, deps });
  const result = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
  assert.equal(result.status, 'generation_failed'); assert.equal(result.score, 0); assert.equal(result.infra, null);
  assert.equal(result.infra_ignored.reason, 'usage_limit', 'the finding is kept for diagnosis');
});

test('stopping the runner mid-generation kills the CLI tree, records an infrastructure error and releases the batch', async t => {
  const outside = await scratch(t), grandchild = join(outside, 'grandchild-marker');
  const quick = { sleep: 0, grandchild: null, events: CODEX_EVENTS };
  const { batchDir, deps, calls } = await fakeBatch(t, { tasks: ['house-a-t1', 'house-b-t1'],
    behaviour: { artifact: 'glb', sequence: [{ grandchild, sleep: 120, events: [...CODEX_START, ...CODEX_WORK] }, quick], byTask: { 'house-b-t1': { sequence: [quick] } } } });
  await passPreflight(batchDir);
  const controller = new AbortController();
  // Stopped once the fake has provably started (it counted its call, so the
  // restart gets the quick behaviour) and, if it comes up in time, once the
  // grandchild is there to be killed; never on a timer alone.
  const stopWhenRunning = async () => {
    for (let i = 0; i < 1000 && await calls('house-a-t1') < 1; i++) await new Promise(resolve => setTimeout(resolve, 20));
    for (let i = 0; i < 150 && !await exists(grandchild + '.pid'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort('test-stop');
  };
  const stopping = execute({ batchDir, deps, signal: controller.signal,
    log: event => { if (event.event === 'started') stopWhenRunning(); } });
  await assert.rejects(stopping, error => error.code === 'E3D_INTERRUPTED' && /test-stop/.test(error.message));
  const result = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
  assert.equal(result.status, 'infra_error'); assert.equal(result.infra.reason, 'runner_interrupted'); assert.equal(result.score, null);
  assert.equal(await exists(join(batchDir, 'house-b-t1', 'a1', 'started.json')), false, 'no attempt starts after the stop');
  assert.deepEqual(await noneLeft(grandchild), [], 'a process of the CLI tree survived the stop');
  if (await exists(grandchild + '.pid')) assert.throws(() => process.kill(Number(readFileSync(grandchild + '.pid', 'utf8')), 0), /ESRCH/);
  assert.equal(await exists(join(batchDir, 'run.lock')), false, 'the lock was released');
  // A restart picks up where it stopped: the interrupted try is archived as it
  // was and the attempt runs again from scratch.
  const before = await readFile(join(batchDir, 'house-a-t1', 'a1', 'result.json'), 'utf8');
  const summary = await execute({ batchDir, deps });
  assert.equal(await readFile(join(batchDir, 'house-a-t1', 'a1.infra-1', 'result.json'), 'utf8'), before);
  assert.equal((await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'))).status, 'completed');
  assert.equal((await readJSON(join(batchDir, 'house-b-t1', 'a1', 'result.json'))).status, 'completed');
  assert.deepEqual([summary.counts.infra_error, summary.counts.completed, summary.pending, summary.infra.reruns], [0, 2, 0, 1]);
});

test('a real SIGINT to a running runner stops it the same way', async t => {
  const outside = await scratch(t), grandchild = join(outside, 'grandchild-marker');
  const { batchDir, scorer } = await fakeBatch(t, { behaviour: { artifact: 'glb', grandchild, sleep: 30, events: [...CODEX_START, ...CODEX_WORK] } });
  await passPreflight(batchDir);
  const driver = join(outside, 'driver.mjs');
  await writeFile(driver, `import { execute } from ${JSON.stringify(new URL('../lib/runner/index.mjs', import.meta.url).href)};
try { await execute({ batchDir: process.argv[2], deps: { scorerModule: process.argv[3], graceSeconds: 1 }, handleSignals: true, log: event => console.log(JSON.stringify(event)) }); }
catch (error) { console.log(JSON.stringify({ error: error.message, code: error.code })); process.exitCode = error.code === 'E3D_INTERRUPTED' ? 130 : 1; }
`);
  const runner = spawn(process.execPath, [driver, batchDir, scorer], { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  runner.stdout.on('data', chunk => {
    output += chunk;
    if (String(chunk).includes('"event":"started"')) setTimeout(() => runner.kill('SIGINT'), 300);
  });
  const code = await new Promise(resolve => runner.on('exit', resolve));
  assert.equal(code, 130, output);
  assert.match(output, /"event":"interrupt","reason":"SIGINT"/);
  const result = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
  assert.equal(result.status, 'infra_error'); assert.equal(result.infra.reason, 'runner_interrupted');
  assert.deepEqual(await noneLeft(grandchild), []);
  assert.equal(await exists(join(batchDir, 'run.lock')), false);
});

test('stopping the runner mid-scoring leaves the attempt to be scored again, keeping the partial scoring aside', async t => {
  const { batchDir, deps, dir } = await fakeBatch(t, { behaviour: { artifact: 'slow' } });
  await passPreflight(batchDir);
  await writeFile(join(dir, 'slow-once'), '');
  const controller = new AbortController();
  // Stopped once the scorer is provably inside its slow phase, however long it took to get there.
  const entered = async () => {
    for (let i = 0; i < 3000 && !await exists(join(dir, 'slow-once.entered')); i++) await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort('test-stop');
  };
  await assert.rejects(execute({ batchDir, deps, signal: controller.signal,
    log: event => { if (event.event === 'scoring') entered(); } }), /Interrupted/);
  const attemptDir = join(batchDir, 'house-a-t1', 'a1');
  assert.equal(await exists(join(attemptDir, 'result.json')), false, 'an interrupted scoring records nothing');
  assert.ok(await exists(join(attemptDir, 'process.json')));
  const worker = await readJSON(join(attemptDir, 'score', 'worker.json'));
  assert.equal(commandOf(worker.pid), null, 'the scorer was stopped');
  const summary = await execute({ batchDir, deps });
  const result = await readJSON(join(attemptDir, 'result.json'));
  assert.equal(result.status, 'completed'); assert.equal(result.score, 71.5); assert.equal(summary.complete, true);
  assert.ok(await exists(join(attemptDir, 'score.interrupted-1', 'job.json')), 'the interrupted scoring is kept');
  assert.equal((await readFile(join(dir, 'scorer-calls.log'), 'utf8')).length, 2);
});

test('one runner per batch: a live lock refuses, a stale lock and stale temporaries are taken over', async t => {
  const { batchDir, deps } = await fakeBatch(t, { behaviour: { artifact: 'glb' } });
  await passPreflight(batchDir);
  const lock = join(batchDir, 'run.lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid, started: startTimeOf(process.pid), host: hostname(), at: 'now' }));
  await assert.rejects(execute({ batchDir, deps }), /already being run by pid/);
  assert.equal(await exists(join(batchDir, 'house-a-t1', 'a1', 'started.json')), false);
  // A runner killed outright leaves its lock and possibly a half-written temporary.
  await writeFile(lock, JSON.stringify({ pid: 999999, started: 'Thu Jan  1 00:00:00 2026', host: hostname(), at: 'then' }));
  const stale = join(batchDir, 'house-a-t1', 'a1', 'result.json.999999.1.tmp');
  await writeFile(stale, '{"status":');
  const summary = await execute({ batchDir, deps });
  assert.equal(summary.counts.completed, 1);
  assert.equal(await exists(lock), false); assert.equal(await exists(stale), false);
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

// ---------------------------------------------------------------- waiting, re-runs, stopping (items 2 and 3)

const MINUTE = 60000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const CODEX_UNAUTHORIZED = 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses';
const CODEX_LIMIT_NO_TIME = 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again later.';

test('the retry watchdog stops a CLI that keeps retrying the service, and only that', () => {
  const waiting = { type: 'error', message: CODEX_WAITING };
  // Live shape: Codex repeats "waiting for network" about every 45 s, forever.
  const stuck = retryWatch('codex', { stallMs: 10 * MINUTE });
  CODEX_START.forEach((event, i) => stuck.onEvent(event, i));
  for (let ms = 45000; ms <= 14 * 45000; ms += 45000) stuck.onEvent(waiting, ms);
  assert.equal(stuck.check(10 * MINUTE), null, 'not ten minutes of retrying yet');
  const found = stuck.check(10 * MINUTE + 50000);
  assert.deepEqual([found.reason, found.kind, found.since_ms, found.retries], ['network', 'retrying', 45000, 14]);
  // A streak that went quiet (the stream came back; the model is thinking) is not cut off...
  assert.equal(stuck.check(14 * 45000 + 181000), null, 'no fresh retry event');
  // ...and a lone reconnect minutes later starts a streak of its own.
  const quiet = retryWatch('codex', { stallMs: 10 * MINUTE });
  quiet.onEvent(CODEX_START[0], 0); quiet.onEvent(waiting, MINUTE); quiet.onEvent(waiting, 11 * MINUTE);
  assert.equal(quiet.check(11 * MINUTE + 1000), null, 'one minute of retrying, ten minutes apart, is not a stall');
  // Model activity ends a streak; the time it cost is kept as a diagnostic.
  const recovered = retryWatch('codex', { stallMs: 10 * MINUTE });
  recovered.onEvent(waiting, MINUTE); recovered.onEvent(CODEX_WORK[0], 2 * MINUTE); recovered.onEvent(waiting, 11 * MINUTE);
  assert.equal(recovered.check(11 * MINUTE + 1000), null); assert.equal(recovered.lostMs(), MINUTE);
  // Claude's api_retry states its own delay, which widens the window.
  const storm = retryWatch('claude-code', { stallMs: 10 * MINUTE });
  storm.onEvent(CLAUDE_INIT, 0);
  for (let i = 0; i <= 10; i++) storm.onEvent({ type: 'system', subtype: 'api_retry', attempt: i + 1, max_retries: 20, retry_delay_ms: 60000, error_status: 529, error: 'overloaded' }, 1000 + i * 60000);
  assert.equal(storm.check(10.5 * MINUTE).reason, 'overloaded');
  // A CLI that printed nothing at all is stalled; without a limit nothing is watched.
  const silent = retryWatch('claude-code', { stallMs: 10 * MINUTE });
  assert.equal(silent.check(9 * MINUTE), null); assert.deepEqual([silent.check(10 * MINUTE).reason, silent.check(10 * MINUTE).kind], ['cli_stalled', 'silent']);
  assert.equal(retryWatch('codex', {}).check(1e9), null);
});

test('holds: a stated reset plus jitter, else exponential backoff; the jitter differs per batch and is reproducible', () => {
  const now = Date.parse('2026-10-03T12:00:00Z'), reset = '2026-10-03T14:00:00.000Z';
  const holds = ['login-a', 'login-b', 'login-c', 'login-d'].map(seed => holdUntil({ kind: 'limit', retryAfter: reset, now, seed, draw: 1 }));
  for (const hold of holds) {
    assert.equal(hold.basis, 'retry_after');
    assert.ok(hold.until >= Date.parse(reset) + 30000 && hold.until <= Date.parse(reset) + 150000, new Date(hold.until).toISOString());
  }
  // Four batches on one login, all told the same reset time, resume at four different moments, seconds apart.
  const sorted = holds.map(hold => hold.until).sort((a, b) => a - b);
  assert.ok(sorted.every((until, i) => i === 0 || until - sorted[i - 1] >= 1000), JSON.stringify(sorted.map(until => until - Date.parse(reset))));
  assert.deepEqual(holdUntil({ kind: 'limit', retryAfter: reset, now, seed: 'login-a', draw: 1 }), holds[0], 'reproducible');
  assert.notEqual(holdUntil({ kind: 'limit', retryAfter: reset, now, seed: 'login-a', draw: 2 }).until, holds[0].until, 'each hold draws anew');
  // No stated time: 2, 4, 8, 16, 30, 30 minutes for a limit; 1, 2, 4, 8, 16, 30 for a failing service.
  [2, 4, 8, 16, 30, 30].forEach((minutes, streak) => {
    const hold = holdUntil({ kind: 'limit', streak, now, seed: 's', draw: streak });
    assert.equal(hold.basis, 'backoff');
    assert.ok(hold.until - now >= minutes * MINUTE + 30000 && hold.until - now <= minutes * MINUTE + 150000, 'limit step ' + streak);
  });
  [1, 2, 4, 8, 16, 30, 30].forEach((minutes, streak) => {
    const length = holdUntil({ kind: 'retry', streak, now, seed: 's', draw: streak }).until - now;
    assert.ok(length >= minutes * MINUTE && length <= minutes * MINUTE * 1.25, 'retry step ' + streak);
  });
  // A reset that is (nearly) due is waited out for a minute anyway; one that did not hold is not trusted alone.
  assert.ok(holdUntil({ kind: 'limit', retryAfter: new Date(now + 1000).toISOString(), now, seed: 's' }).until - now >= MINUTE);
  assert.ok(holdUntil({ kind: 'limit', retryAfter: new Date(now + 1000).toISOString(), streak: 3, now, seed: 's' }).until - now >= 8 * MINUTE);
  assert.equal(SCHEDULE.limitStepsMs[0], 2 * MINUTE); assert.equal(SCHEDULE.limitStepsMs.at(-1), 30 * MINUTE);
});

test('the launch gate: a hold stops launches, attempts already running join it, a resume is spaced, success resets the backoff, --no-wait refuses', async () => {
  const events = [], schedule = { ...FAST, limitStepsMs: [300, 600, 900] };
  const gate = createGate({ seed: 'gate', concurrency: 2, schedule, onEvent: event => events.push(event) });
  assert.equal(await gate.pass(), true); assert.equal(gate.holding(), false);
  const t0 = Date.now();
  gate.holdFor({ kind: 'limit', reason: 'usage_limit', attempt: 'house-a-t1/a1', launchedAt: t0 - 20 });
  assert.equal(events.at(-1).event, 'waiting'); assert.equal(events.at(-1).basis, 'backoff'); assert.equal(gate.holding(), true);
  // Another attempt that was already running meets the same limit: it joins the hold, the backoff does not grow.
  gate.holdFor({ kind: 'limit', reason: 'usage_limit', attempt: 'house-b-t1/a1', launchedAt: t0 - 10 });
  assert.match(events.at(-1).event, /^wait_(joined|extended)$/); assert.equal(gate.snapshot().streak.limit, 1);
  assert.equal(await gate.pass(), true, 'resumes after the hold');
  assert.ok(Date.now() - t0 >= 280, 'waited ' + (Date.now() - t0) + ' ms');
  assert.equal(events.at(-1).event, 'resumed');
  const t1 = Date.now();
  assert.equal(await gate.pass(), true);
  assert.ok(Date.now() - t1 >= 90, 'the second launch after a resume is spaced out');
  // A launch after the resume that meets the limit again: a longer hold.
  const resumedLaunch = Date.now();
  gate.holdFor({ kind: 'limit', reason: 'usage_limit', launchedAt: resumedLaunch });
  assert.equal(gate.snapshot().streak.limit, 2);
  assert.ok(Date.parse(gate.snapshot().hold.until_at) - Date.now() >= 550);
  // A sample from a launch after the last resume resets the backoff.
  gate.success({ launchedAt: Date.now() });
  assert.deepEqual(gate.snapshot().streak, { limit: 0, retry: 0 });
  // --no-wait: the gate refuses and says why and until when; an abort ends a wait at once.
  const strict = createGate({ seed: 'gate', wait: false, schedule });
  strict.holdFor({ kind: 'retry', reason: 'network', attempt: 'house-c-t1/a1' });
  assert.equal(await strict.pass(), false); assert.equal(strict.blocked.reason, 'network'); assert.ok(Date.parse(strict.blocked.until_at) > Date.now());
  const waiting = createGate({ seed: 'gate', schedule: { ...schedule, retryStepsMs: [60000] } });
  waiting.holdFor({ kind: 'retry', reason: 'server_error' });
  const controller = new AbortController(), started = Date.now();
  setTimeout(() => controller.abort('stop'), 50);
  assert.equal(await waiting.pass(controller.signal), false); assert.ok(Date.now() - started < 30000);
  // A restarted runner restores a hold still in force (from runner-state.json).
  const restored = createGate({ seed: 'gate', schedule, initial: gate.snapshot() });
  assert.equal(restored.holding(), true); assert.equal(restored.hold.restored, true);
});

test('a usage limit holds the batch inside one run: running attempts finish, nothing new launches, and the attempt runs again from a pristine workspace', async t => {
  const limited = { events: codexFails(CODEX_LIMIT_NO_TIME), exit: 1 };
  const { batchDir, deps, calls, dir } = await fakeBatch(t, { tasks: ['house-a-t1', 'house-b-t1', 'house-c-t1'],
    behaviour: { artifact: 'glb', byTask: { 'house-a-t1': { sequence: [limited, {}] }, 'house-b-t1': { sequence: [{ sleep: 1 }] }, 'house-c-t1': { sequence: [{}] } } } });
  await passPreflight(batchDir);
  const seen = [];
  let during = null;
  // While it waits, `status` says why and until when.
  const watchStatus = async () => {
    for (let i = 0; i < 200; i++) {
      const state = (await batchStatus(batchDir)).state;
      if (/^WAITING/.test(state)) return state;
      await pause(10);
    }
    return null;
  };
  const summary = await execute({ batchDir, deps: { ...deps, schedule: { ...FAST, limitStepsMs: [2500, 5000] } }, concurrency: 2,
    log: event => { seen.push({ ...event, t: Date.now() }); if (event.event === 'waiting') during = watchStatus(); } });
  assert.equal(summary.complete, true); assert.equal(summary.counts.completed, 3); assert.equal(summary.counts.infra_error, 0);
  assert.deepEqual([await calls('house-a-t1'), await calls('house-b-t1'), await calls('house-c-t1')], [2, 1, 1]);
  const waiting = seen.find(event => event.event === 'waiting'), resumed = seen.find(event => event.event === 'resumed');
  assert.deepEqual([waiting.reason, waiting.basis, waiting.attempt, waiting.wait], ['usage_limit', 'backoff', 'house-a-t1/a1', 'in-process']);
  assert.ok(resumed && resumed.t > waiting.t);
  const launched = seen.filter(event => event.event === 'started');
  assert.equal(launched.length, 4);
  assert.ok(launched.every(event => event.t <= waiting.t || event.t >= resumed.t), 'an attempt was launched during the hold');
  assert.match(await during, /^WAITING: usage_limit until \S+Z \(.*backoff, no reset time stated\); evidence house-a-t1\/a1: You’ve hit your usage limit.*; runner pid \d+/);
  // The limited try is kept as it was, unscored; the attempt ran again from scratch.
  const archive = join(batchDir, 'house-a-t1', 'a1.infra-1'), first = await readJSON(join(archive, 'result.json'));
  assert.deepEqual([first.status, first.infra.reason, first.score, first.try], ['infra_error', 'usage_limit', null, 1]);
  assert.ok(await exists(join(archive, 'workspace', 'output', 'model.glb')), 'the archived try keeps what it left');
  assert.equal(await exists(join(archive, 'score')), false, 'and was never scored');
  const again = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
  assert.deepEqual([again.status, again.try, again.tries.map(item => [item.dir, item.reason])], ['completed', 2, [['a1.infra-1', 'usage_limit']]]);
  assert.equal((await readJSON(join(batchDir, 'house-a-t1', 'a1', 'rerun.json'))).archived, 'a1.infra-1');
  assert.equal((await readFile(join(dir, 'scorer-calls.log'), 'utf8')).length, 3, 'only samples were scored');
  // One line when it starts waiting and one when it resumes.
  const progress = (await readFile(join(batchDir, 'progress.log'), 'utf8')).trim().split('\n');
  assert.equal(progress.filter(line => /  WAIT usage_limit until \S+Z \(.*backoff\) \| house-a-t1\/a1: You’ve hit/.test(line)).length, 1, progress.join('\n'));
  assert.equal(progress.filter(line => /  RESUME after \S+ \(usage_limit\)$/.test(line)).length, 1, progress.join('\n'));
  assert.equal(summary.infra.reruns, 1); assert.equal(summary.runner.phase, 'finished');
  assert.match(describeState(summary.runner), /^FINISHED/);
});

test('a lost login stops the batch for a human; once it is back the attempt runs again without using up a re-run', async t => {
  const lost = { events: codexFails('Reconnecting... 5/5 (' + CODEX_UNAUTHORIZED + ')', CODEX_UNAUTHORIZED), exit: 1 };
  const { batchDir, deps, calls } = await fakeBatch(t, { tasks: ['house-a-t1', 'house-b-t1'],
    behaviour: { artifact: 'glb', byTask: { 'house-a-t1': { sequence: [lost, {}] }, 'house-b-t1': { sequence: [{}] } } } });
  await passPreflight(batchDir);
  const stopped = await execute({ batchDir, deps }).catch(error => error);
  assert.equal(stopped.code, 'E3D_STOPPED', String(stopped.stack ?? stopped));
  assert.equal(stopped.stop.reason, 'auth'); assert.match(stopped.message, /log in again/);
  assert.equal(await calls('house-b-t1'), 0, 'nothing is launched after the stop');
  assert.equal(stopped.summary.counts.infra_error, 1); assert.equal(stopped.summary.pending, 1);
  assert.match((await batchStatus(batchDir)).state, /^STOPPED: auth \(house-a-t1\/a1\): unexpected status 401 .* -> log in again .*; no runner alive$/);
  assert.match(await readFile(join(batchDir, 'progress.log'), 'utf8'), /  STOP auth: unexpected status 401.* \(house-a-t1\/a1\) -> log in again/);
  // Logged in again: the same command continues. A stop-class try is not counted against the re-run cap.
  const summary = await execute({ batchDir, deps, maxReruns: 0 });
  assert.equal(summary.complete, true); assert.equal(summary.counts.completed, 2);
  assert.equal((await readJSON(join(batchDir, 'house-a-t1', 'a1.infra-1', 'result.json'))).infra.reason, 'auth');
  assert.equal((await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'))).try, 2);
});

test('infrastructure re-runs are capped per attempt, and every try is archived and listed', async t => {
  // A CLI that dies before any model turn, every time (cli_crash: counted).
  const crash = { events: [], exit: 1, artifact: null };
  const { batchDir, deps, calls } = await fakeBatch(t, { tasks: ['house-a-t1', 'house-b-t1'],
    behaviour: { artifact: 'glb', byTask: { 'house-a-t1': { sequence: [crash] }, 'house-b-t1': { sequence: [{}] } } } });
  await passPreflight(batchDir);
  const capped = [];
  const summary = await execute({ batchDir, deps, maxReruns: 2, log: event => event.event === 'rerun_capped' && capped.push(event) });
  assert.equal(await calls('house-a-t1'), 3, 'the first try and two re-runs');
  assert.deepEqual(summary.infra.capped, ['house-a-t1/a1']); assert.equal(summary.complete, false);
  assert.deepEqual([summary.counts.infra_error, summary.counts.completed, summary.pending], [1, 1, 0]);
  assert.equal(capped.length, 1); assert.equal(capped[0].counted, 3);
  for (const k of [1, 2]) assert.equal((await readJSON(join(batchDir, 'house-a-t1', 'a1.infra-' + k, 'result.json'))).infra.reason, 'cli_crash');
  const last = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
  assert.deepEqual([last.status, last.infra.reason, last.try, last.tries.map(item => item.dir)], ['infra_error', 'cli_crash', 3, ['a1.infra-1', 'a1.infra-2']]);
  const row = summary.attempts.find(item => item.task_id === 'house-a-t1');
  assert.deepEqual([row.try, row.tries_archived, row.rerun_capped], [3, 2, true]);
  assert.match(await readFile(join(batchDir, 'progress.log'), 'utf8'), /  CAP house-a-t1\/a1: 3 tries ended by .* \(at most 2 re-runs\); left as infra_error/);
  assert.match((await batchStatus(batchDir)).summary.infra.capped.join(), /house-a-t1\/a1/);
  // A later run with the same cap leaves it alone; a higher cap allows one more try.
  await execute({ batchDir, deps, maxReruns: 2 });
  assert.equal(await calls('house-a-t1'), 3);
  await execute({ batchDir, deps, maxReruns: 3 });
  assert.equal(await calls('house-a-t1'), 4); assert.ok(await exists(join(batchDir, 'house-a-t1', 'a1.infra-3')));
});

test('the watchdog stops a CLI that keeps retrying an unreachable service, or prints nothing, long before its wall clock', async t => {
  const waiting = { type: 'error', message: CODEX_WAITING };
  for (const [behaviour, reason, kind] of [[{ events: CODEX_START, repeat: { event: waiting, seconds: 0.2 } }, 'network', 'retrying'], [{ events: [], sleep: 100 }, 'cli_stalled', 'silent']]) {
    const { batchDir, deps } = await fakeBatch(t, { shell: true, wall: 300, behaviour });
    await passPreflight(batchDir);
    const started = Date.now();
    const summary = await execute({ batchDir, deps, maxReruns: 0, retryStallSeconds: 1.5 });
    const result = await readJSON(join(batchDir, 'house-a-t1', 'a1', 'result.json'));
    assert.deepEqual([result.status, result.infra.reason, result.infra.during, result.watchdog.kind, result.timed_out], ['infra_error', reason, 'startup', kind, false], kind);
    assert.ok(result.wall_seconds < 120 && Date.now() - started < 150000, 'stopped after ' + result.wall_seconds + ' s, not at the 300 s wall clock');
    assert.match(result.infra.message, kind === 'silent' ? /^the CLI printed nothing for 1\.5 s; stopped by the runner$/ : /^the CLI had been retrying the service for 1\.5 s with no model activity; stopped by the runner: Reconnecting/);
    assert.deepEqual(summary.infra.capped, ['house-a-t1/a1']);
  }
});

test('two batches on one login wait on their own evidence and both finish', async t => {
  const shared = await scratch(t), limitFile = join(shared, 'limited-until');
  const limited = { events: codexFails(CODEX_LIMIT_NO_TIME), exit: 1, artifact: null };
  const one = await fakeBatch(t, { id: 'login-a', tasks: ['house-a-t1', 'house-b-t1'], behaviour: { artifact: 'glb', limitFile, limited } });
  const two = await fakeBatch(t, { id: 'login-b', tasks: ['house-c-t1', 'house-d-t1'], behaviour: { artifact: 'glb', limitFile, limited } });
  await passPreflight(one.batchDir); await passPreflight(two.batchDir);
  // The login is limited until both batches have met the limit (however long
  // their start takes under load), then the limit is lifted.
  await writeFile(limitFile, String(Date.now() + 3600000));
  const logs = [[], []], met = [false, false];
  const results = await Promise.all([one, two].map((batch, i) => execute({ batchDir: batch.batchDir, deps: batch.deps, log: event => {
    logs[i].push(event);
    if (event.event === 'waiting') { met[i] = true; if (met[0] && met[1]) writeFileSync(limitFile, '0'); }
  } })));
  for (const [i, summary] of results.entries()) {
    assert.equal(summary.complete, true, 'batch ' + i); assert.equal(summary.counts.completed, 2);
    const own = i ? ['house-c-t1/a1', 'house-d-t1/a1'] : ['house-a-t1/a1', 'house-b-t1/a1'];
    const holds = logs[i].filter(event => event.event === 'waiting');
    assert.ok(holds.length >= 1, 'batch ' + i + ' met the limit itself');
    assert.ok(holds.every(event => own.includes(event.attempt)), 'each batch waits on its own evidence: ' + holds.map(event => event.attempt));
    assert.ok(summary.infra.reruns >= 1);
  }
  // Each runner kept its own state; neither saw the other's lock.
  for (const batch of [one, two]) assert.equal((await readJSON(join(batch.batchDir, 'runner-state.json'))).phase, 'finished');
});

test('an interrupted re-run swap is finished or discarded on restart', async t => {
  const { batchDir, manifest } = await fakeBatch(t);
  const dir = join(batchDir, 'house-a-t1', 'a1'), fresh = dir + '.fresh', logged = [];
  // Cut short while the new directory was being built: it is discarded.
  await mkdir(fresh); await writeFile(join(fresh, 'prompt.txt'), 'partial');
  await recoverReruns(batchDir, manifest, event => logged.push(event));
  assert.equal(await exists(fresh), false); assert.ok(await exists(join(dir, 'invocation.json')));
  // Cut short between the two renames: the complete new directory is moved in.
  await rename(dir, dir + '.infra-1'); await mkdir(fresh); await writeFile(join(fresh, 'rerun.json'), '{}');
  await recoverReruns(batchDir, manifest, event => logged.push(event));
  assert.ok(await exists(join(dir, 'rerun.json'))); assert.equal(logged.at(-1).event, 'rerun_recovered');
  // Neither is complete: refused, naming the way out.
  await rm(dir, { recursive: true }); await mkdir(fresh);
  await assert.rejects(recoverReruns(batchDir, manifest, () => {}), /restore house-a-t1\/a1 from its newest \.infra-<k> copy/);
});

test('describeState says why a batch is not running and until when', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  const hold = { kind: 'limit', reason: 'usage_limit', since: '2026-10-03T11:50:00.000Z', until_at: '2026-10-03T14:30:00.000Z', basis: 'retry_after',
    attempt: 'house-a-t1/a2', evidence: 'You’ve hit your usage limit.' };
  assert.match(describeState({ alive: true, pid: 42, since: 'x', phase: 'waiting', hold }, now),
    /^WAITING: usage_limit until 2026-10-03T14:30:00.000Z \(.*, in 2h 30m; reset time stated by the CLI\); evidence house-a-t1\/a2: You’ve hit your usage limit\.; runner pid 42 \(since x\)$/);
  assert.match(describeState({ alive: false, phase: 'waiting', hold: { ...hold, basis: 'backoff' } }, now), /^WAS WAITING \(runner gone\): .*backoff, no reset time stated.*; no runner alive$/);
  assert.match(describeState({ alive: true, pid: 7, since: 'x', phase: 'preflight_waiting', hold }, now), /^WAITING IN PREFLIGHT: usage_limit until/);
  assert.match(describeState({ alive: false, phase: 'would_wait', hold }, now), /^EXITED INSTEAD OF WAITING \(--no-wait\): usage_limit until .*; run again after that/);
  assert.match(describeState({ alive: false, phase: 'stopped', stop: { reason: 'billing', attempt: 'house-a-t1/a1', message: 'Quota exceeded.', advice: 'check the plan' } }, now),
    /^STOPPED: billing \(house-a-t1\/a1\): Quota exceeded\. -> check the plan; no runner alive$/);
  assert.match(describeState({ alive: false, phase: null }, now), /^never run/);
});

// ---------------------------------------------------------------- freezing the scorer and the task set

const REAL_REPO = fileURLToPath(new URL('../..', import.meta.url));

test('the scorer and the objects are frozen with the batch: a change refuses the run, one mid-batch stops it before the next launch or scoring', async t => {
  // A small repository: a scorer, a kernel file it imports, a data file and a package.
  const repo = join(await scratch(t), 'repo'), kernel = join(repo, 'v1', 'lib', 'kernel.mjs');
  await mkdir(join(repo, 'v1', 'lib', 'score'), { recursive: true }); await mkdir(join(repo, 'node_modules'));
  await symlink(join(REAL_REPO, 'node_modules', 'three'), join(repo, 'node_modules', 'three'));
  await writeFile(kernel, 'export const K = 1;\n');
  await writeFile(join(repo, 'v1', 'lib', 'score', 'index.mjs'), "import { K } from '../kernel.mjs';\nimport * as THREE from 'three';\nexport const scoreSubmission = async () => ({ K, THREE });\n");
  await writeFile(join(repo, 'v1', 'lib', 'score', 'weights.json'), '{ "shape": 0.5 }\n');
  const closure = ['node_modules/three/package.json', 'v1/lib/kernel.mjs', 'v1/lib/score/index.mjs', 'v1/lib/score/weights.json'];
  assert.deepEqual(await moduleClosure(repo, ['v1/lib/score']), closure);
  const tasks = ['house-a-t1', 'house-b-t1', 'house-c-t1'];
  const { batchDir, manifest, deps, calls, dataRoot } = await fakeBatch(t, { repoRoot: repo, tasks, behaviour: { artifact: 'glb', sequence: [{}] } });
  assert.deepEqual(manifest.scorer_source.files.map(file => file.path), closure);
  assert.equal(manifest.scorer_source.sha256, (await scorerHash(repo)).sha256);
  assert.ok(manifest.runner_source.sha256 && manifest.generator_source.sha256);
  await passPreflight(batchDir);
  const run = log => execute({ batchDir, deps, repoRoot: repo, log });
  // Changed before the run: refused outright.
  await writeFile(kernel, 'export const K = 2;\n');
  await assert.rejects(run(), /Frozen batch changed: .*scorer source changed since the batch was frozen/);
  assert.equal(await calls('house-a-t1'), 0);
  await writeFile(kernel, 'export const K = 1;\n');
  // Changed while house-a generates: its generation is kept, its scoring waits, nothing else launches.
  let stopped = await run(event => { if (event.event === 'started' && event.task_id === 'house-a-t1') writeFileSync(kernel, 'export const K = 3;\n'); }).catch(error => error);
  assert.equal(stopped.code, 'E3D_STOPPED', String(stopped.stack ?? stopped)); assert.equal(stopped.stop.reason, 'frozen');
  assert.match(stopped.message, /scorer source changed since the batch was frozen/);
  const a = join(batchDir, 'house-a-t1', 'a1');
  assert.equal(await exists(join(a, 'result.json')), false); assert.ok(await exists(join(a, 'process.json')));
  assert.equal(await calls('house-b-t1'), 0);
  assert.match((await batchStatus(batchDir)).state, /^STOPPED: frozen .*-> restore what changed/);
  // Restored: house-a is scored from its logs (not generated again), house-b runs, then a change stops the batch before house-c.
  await writeFile(kernel, 'export const K = 1;\n');
  stopped = await run(event => { if (event.event === 'finished' && event.task_id === 'house-b-t1') writeFileSync(kernel, 'export const K = 4;\n'); }).catch(error => error);
  assert.equal(stopped.code, 'E3D_STOPPED'); assert.match(stopped.message, /scorer source changed/);
  assert.equal(await calls('house-a-t1'), 1, 'house-a was not generated again');
  assert.equal((await readJSON(join(a, 'result.json'))).status, 'completed');
  assert.equal((await readJSON(join(batchDir, 'house-b-t1', 'a1', 'result.json'))).status, 'completed');
  assert.equal(await calls('house-c-t1'), 0);
  await writeFile(kernel, 'export const K = 1;\n');
  assert.equal((await run()).complete, true);
  // The objects the scorer reads are frozen too (absent then, present now is a change).
  await mkdir(join(dataRoot, 'objects', 'fixture'), { recursive: true });
  await writeFile(join(dataRoot, 'objects', 'fixture', 'model.json'), '{}');
  await assert.rejects(run(), /object fixture model\.json changed \(task house-a-t1\)/);
});

test('prepare records the set, object, variant and generator of every task, and summary and status show the sets', async t => {
  const model = { generator: { version: 'e3d-generator-test' } };
  const { batchDir, manifest } = await fakeBatch(t, { tasks: ['house-a-t1', 'house-b-t1'], sets: { 'house-a-t1': 'dev' },
    before: async dataRoot => { await mkdir(join(dataRoot, 'objects', 'fixture'), { recursive: true }); await writeFile(join(dataRoot, 'objects', 'fixture', 'model.json'), JSON.stringify(model)); } });
  assert.deepEqual(manifest.sets, ['dev', null], 'a task without a set is recorded as null, never pooled silently');
  assert.deepEqual(manifest.tasks.map(task => [task.id, task.set, task.object, task.variant, task.generator_version]),
    [['house-a-t1', 'dev', 'fixture', 't1', 'e3d-generator-test'], ['house-b-t1', null, 'fixture', 't1', 'e3d-generator-test']]);
  assert.deepEqual(manifest.tasks[0].object_files, { 'model.json': sha(JSON.stringify(model)), 'evidence/evidence.json': null });
  const summary = await summarize(batchDir);
  assert.deepEqual(summary.sets, ['dev', null]); assert.deepEqual(summary.tasks.map(task => task.set), ['dev', null]);
});

// ---------------------------------------------------------------- preflight under infrastructure errors

test('an infrastructure error during preflight is waited out or reported, never a failed boundary, and status says until when', async t => {
  const internet = { host: '127.0.0.1', port: 1, url: 'http://127.0.0.1:1/' };
  // Inferred shape: a subscriber's limit, with the structured reset time.
  const resets = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: '$RESETS_IN:3', rateLimitType: 'five_hour' } };
  const limited = [CLAUDE_INIT, resets, ...claudeFails({ text: 'You\'ve hit your session limit · resets 7:50pm (UTC)', error: 'rate_limit', status: 429 })];
  const { batchDir, deps } = await fakeBatch(t, { system: 'claude-code', behaviour: { events: limited, exit: 1 } });
  const quick = { internet, schedule: FAST };
  const refused = await preflight({ batchDir, wait: false, deps: quick });
  assert.equal(refused.passed, false); assert.deepEqual(refused.failed, [], 'no check failed on evidence');
  assert.deepEqual([refused.infra.reason, refused.infra.gave_up, refused.infra.retry_after_source], ['usage_limit', 'no-wait', 'rate_limit_event']);
  assert.ok(Date.parse(refused.infra.hold.until_at) >= Date.parse(refused.infra.retry_after));
  assert.match((await batchStatus(batchDir)).state, /^EXITED INSTEAD OF WAITING \(--no-wait\): usage_limit until \S+Z .*evidence preflight\/agent/);
  await assert.rejects(execute({ batchDir, deps }), /could not finish \(infrastructure: usage_limit until \S+Z\); run preflight again/);
  // Waiting: the stated reset is waited out and the probe runs again in a fresh site.
  let during = null;
  const watchStatus = async () => {
    for (let i = 0; i < 300; i++) {
      const state = (await batchStatus(batchDir)).state;
      if (/^WAITING IN PREFLIGHT/.test(state)) return state;
      await pause(10);
    }
    return null;
  };
  const waited = await preflight({ batchDir, deps: { ...quick, preflightInfraTries: 2 }, log: event => { if (event.event === 'preflight_waiting' && !during) during = watchStatus(); } });
  assert.deepEqual([waited.passed, waited.infra.gave_up, waited.infra.tries], [false, 'tries', 2]); assert.deepEqual(waited.failed, []);
  assert.match(await during, /^WAITING IN PREFLIGHT: usage_limit until \S+Z \(.*reset time stated by the CLI\); evidence preflight\/agent: .*; runner pid \d+/);
  assert.ok(await exists(join(batchDir, waited.directory, 'agent-infra-1', 'events.jsonl')), 'probed again in a fresh site');
  assert.deepEqual(Object.keys(waited.probe_session).filter(key => key.startsWith('infra_')), ['infra_1', 'infra_2']);
  assert.equal(await exists(join(batchDir, 'run.lock')), false, 'the lock was released');
  // A lost login stops preflight at once, with advice.
  const auth = await fakeBatch(t, { system: 'claude-code', behaviour: { events: [CLAUDE_INIT, ...claudeFails({ text: 'Not logged in · Please run /login', error: 'authentication_failed' })], exit: 1 } });
  const stopped = await preflight({ batchDir: auth.batchDir, deps: quick });
  assert.deepEqual([stopped.infra.reason, stopped.infra.gave_up, stopped.failed.length], ['auth', 'stop', 0]);
  assert.match((await batchStatus(auth.batchDir)).state, /^STOPPED: auth \(preflight\/agent\): Not logged in · Please run \/login -> log in again/);
  // Stopped by a signal: no verdict is written, an earlier one stays.
  await writeFile(join(auth.batchDir, 'preflight.json'), '{"passed":"earlier"}');
  const controller = new AbortController();
  controller.abort('test-stop');
  await assert.rejects(preflight({ batchDir: auth.batchDir, deps: quick, signal: controller.signal }), error => error.code === 'E3D_INTERRUPTED');
  assert.equal(await readFile(join(auth.batchDir, 'preflight.json'), 'utf8'), '{"passed":"earlier"}');
});

// ---------------------------------------------------------------- item 6: Codex image views in code mode

test('a Codex image view counts as refused only on view_image\'s own permission error for exactly that path', async t => {
  const root = await scratch(t), secret = join(root, 'secret'), workspace = join(root, 'workspace'), probe = join(workspace, '.e3d-probe');
  await mkdir(join(workspace, 'output'), { recursive: true }); await mkdir(join(workspace, 'input')); await mkdir(probe); await mkdir(secret);
  await writeFile(join(secret, 'outside.txt'), 'OUTSIDE-ORIGINAL\n');
  const site = { root, secret, workspace, colours: { control: 'blue', canary: 'magenta', linked: 'orange' } };
  const before = { 'outside-symlink-write': sha(Buffer.from('OUTSIDE-ORIGINAL\n')) };
  const canary = join(secret, 'canary.png'), linked = join(probe, 'link-image.png'), control = join(probe, 'control.png');
  const router = text => '2026-10-01T10:24:22.258940Z ERROR codex_core::tools::router: error=' + text;
  const refusal = path => router('unable to locate image at `' + path + '`: Operation not permitted (os error 1)');
  const answer = fields => ({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: JSON.stringify({ view_results: ['an error', 'an error'], control_colour: 'blue',
    isolate: { require: 'undefined', process: 'undefined', fetch: 'undefined', import_fs: 'error', import_net: 'error' }, tools: ['functions.exec', 'tools.view_image', 'tools.apply_patch'], ...fields }) } });
  const judge = async (lines, fields = {}, extra = []) => Object.fromEntries((await evaluateCodexAgent({ site, events: [...extra, answer(fields)], stderr: lines.join('\n'), before,
    codeModeExpected: true })).checks.map(check => [check.id, check]));
  const status = (checks, ...ids) => ids.map(id => checks['agent:' + id].status);
  // The pilot2-astra shape: both refusals on record (absolute or workspace-relative), the control named.
  let checks = await judge([refusal(canary), refusal('.e3d-probe/link-image.png')]);
  assert.deepEqual(status(checks, 'view-canary', 'view-symlink', 'view-control', 'code-mode-isolate'), ['pass', 'pass', 'pass', 'pass']);
  assert.match(checks['agent:view-canary'].observed, /Operation not permitted \(os error 1\)/, 'the refusal is cited');
  // Silence: a skipped call, or a view that worked (in code mode neither leaves an event).
  checks = await judge([]);
  assert.deepEqual(status(checks, 'view-canary', 'view-symlink'), ['fail', 'fail']); assert.equal(checks['agent:view-canary'].absence, true);
  // A refusal of another path does not stand in for this one.
  checks = await judge([refusal(canary + '.bak'), refusal(linked + '2')]);
  assert.deepEqual(status(checks, 'view-canary', 'view-symlink'), ['fail', 'fail']);
  // Errors that are not refusals: the file is missing, or its bytes were read.
  checks = await judge([router('unable to locate image at `' + canary + '`: No such file or directory (os error 2)'), router('failed to decode image at `' + linked + '`: unsupported image format')]);
  assert.deepEqual(status(checks, 'view-canary', 'view-symlink'), ['fail', 'fail']);
  assert.match(checks['agent:view-symlink'].reason, /without a permission refusal/); assert.equal(checks['agent:view-symlink'].absence, undefined);
  // A refusal on record, but the model named the outside image's colour: it was shown.
  checks = await judge([refusal(canary), refusal(linked)], { view_results: ['a solid magenta square', 'an error'] });
  assert.equal(checks['agent:view-canary'].status, 'fail'); assert.match(checks['agent:view-canary'].reason, /reported the colour of the outside image \(magenta\)/);
  // A colour word inside a quoted path is not a colour seen.
  checks = await judge([refusal(canary), refusal(linked)], { view_results: ['unable to locate image at `/runs/pilot-magenta/canary.png`', 'denied at /x/orange/link.png'] });
  assert.deepEqual(status(checks, 'view-canary', 'view-symlink'), ['pass', 'pass']);
  // The control: a wrong colour fails, two colours or none is unanswered, an error on record fails.
  assert.equal((await judge([refusal(canary), refusal(linked)], { control_colour: 'green' }))['agent:view-control'].status, 'fail');
  assert.equal((await judge([refusal(canary), refusal(linked)], { control_colour: 'blue or green' }))['agent:view-control'].status, 'not_evaluated');
  assert.equal((await judge([refusal(canary), refusal(linked)], { control_colour: 'error reading /w/blue/control.png' }))['agent:view-control'].status, 'not_evaluated');
  assert.equal((await judge([refusal(canary), refusal(linked), refusal(control)]))['agent:view-control'].status, 'fail');
  // A patch rejection that names no path counts for input/ only when every other refused patch has its own record.
  const others = ['link-out', 'dangling-agent', join('link-dir', 'agent-new.txt')].map(name => join(probe, name));
  const changes = paths => paths.map((path, i) => ({ type: 'item.completed', item: { id: 'p' + i, type: 'file_change', changes: [{ path, kind: 'add' }], status: 'failed' } }));
  const pathless = router('patch rejected: writing outside of the project; rejected by user approval settings');
  checks = await judge([refusal(canary), refusal(linked), pathless], {}, changes(others));
  assert.deepEqual(status(checks, 'patch-input', 'patch-symlink', 'patch-dangling', 'patch-dir-symlink'), ['pass', 'pass', 'pass', 'pass']);
  checks = await judge([refusal(canary), refusal(linked), pathless], {}, changes(others.slice(0, 2)));
  assert.deepEqual(status(checks, 'patch-input', 'patch-dir-symlink'), ['not_evaluated', 'not_evaluated'], 'the pathless line may be the missing one');
  // After an infrastructure error, only failures for something absent become unanswered; evidence stays a failure.
  const converted = absenceFailures([{ id: 'a', status: 'fail', absence: true, reason: 'no refusal' }, { id: 'b', status: 'fail', reason: 'canary came back' }], { reason: 'usage_limit' });
  assert.deepEqual(converted.map(check => check.status), ['not_evaluated', 'fail']); assert.match(converted[0].reason, /infrastructure error \(usage_limit\)/);
});

test('probe colours are drawn per site, the control from colours with one name; colour words in paths do not count', () => {
  const drawn = Array.from({ length: 200 }, (_, i) => siteColours('site-' + i));
  for (const colours of drawn) {
    assert.ok(['red', 'green', 'blue', 'yellow'].includes(colours.control), colours.control);
    assert.equal(new Set([colours.control, colours.canary, colours.linked]).size, 3);
  }
  assert.equal(new Set(drawn.map(colours => colours.control)).size, 4, 'the control is not guessable');
  assert.deepEqual(siteColours('same'), siteColours('same'));
  assert.deepEqual(coloursNamed('Turquoise, or maybe teal'), ['cyan']);
  assert.deepEqual(coloursNamed('error at `/runs/red-batch/canary.png` and /x/blue.png'), []);
});

const PILOT_ASTRA = join(REAL_REPO, '.local', 'v1', 'runs', 'pilot2-astra', 'preflight');

test('the stored code-mode preflight of pilot2-astra passes its image views on logged refusals, and fails them without that log',
  { skip: !existsSync(PILOT_ASTRA) && 'the pilot2-astra preflight is not on this machine' }, async () => {
    const root = join(PILOT_ASTRA, readdirSync(PILOT_ASTRA).sort()[0], 'agent');
    const events = (await readFile(join(root, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const stderr = await readFile(join(root, 'stderr.log'), 'utf8');
    const site = { root, secret: join(root, 'secret'), workspace: join(root, 'workspace') };
    const before = { 'outside-symlink-write': sha(Buffer.from('OUTSIDE-ORIGINAL\n')) };
    const { checks } = await evaluateCodexAgent({ site, events, stderr, before, codeModeExpected: true });
    const byId = Object.fromEntries(checks.map(check => [check.id.slice(6), check]));
    for (const id of ['view-canary', 'view-symlink', 'view-control', 'patch-output', 'patch-input', 'patch-symlink', 'patch-dangling', 'patch-dir-symlink', 'tool-list', 'code-mode-isolate']) {
      assert.equal(byId[id].status, 'pass', id + ': ' + byId[id].reason);
    }
    assert.match(byId['view-canary'].observed, /^unable to locate image at `.*\/secret\/canary\.png`: Operation not permitted \(os error 1\)$/);
    assert.match(byId['view-symlink'].observed, /^unable to locate image at `.*\/\.e3d-probe\/link-image\.png`: Operation not permitted \(os error 1\)$/);
    // The nested tools.view_image calls left no event: without stderr there is no proof.
    const blind = Object.fromEntries((await evaluateCodexAgent({ site, events, stderr: '', before, codeModeExpected: true })).checks.map(check => [check.id.slice(6), check.status]));
    assert.deepEqual([blind['view-canary'], blind['view-symlink']], ['fail', 'fail']);
  });
