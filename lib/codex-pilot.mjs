import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdir, cp, realpath, symlink, readdir, lstat, unlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { exportTask } from './prepare.mjs';
import { readJSON, writeJSON, sha256, objectHash, verifySources } from './io.mjs';
import { validateTask, validateSubmission } from './contracts.mjs';
import { registerDetailSubmission } from './detail-registration.mjs';
import { evaluate } from './evaluate.mjs';

export const PILOT_VERSION = 'codex-pilot-v2';
export const DEFAULT_PILOT_TASKS = [
  'calibration-facade-v1', 'calibration-arcade-v1',
  'calibration-rotunda-v1', 'calibration-reflector-v1',
];

// This is a model-under-test runner, not an API-key integration. The host CLI
// uses its existing ChatGPT login; credentials never enter worker commands.
export function hostEnvironment() {
  return Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR',
    'SSL_CERT_FILE', 'SSL_CERT_DIR'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
}

export function workerConfig({ workspace, runtime, node, blender }) {
  const profile = 'evidence3d-pilot';
  const values = {
    default_permissions: profile, approval_policy: 'never', web_search: 'disabled',
    model_reasoning_effort: 'high', project_doc_max_bytes: 0,
    'shell_environment_policy.inherit': 'none',
    'shell_environment_policy.set': {
      PATH: [dirname(node), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      TMPDIR: join(workspace, 'tmp'), LANG: 'en_US.UTF-8',
    },
    [`permissions.${profile}.filesystem`]: {
      ':minimal': 'read', ':tmpdir': 'deny', ':slash_tmp': 'deny',
      [workspace]: 'write', [join(workspace, 'input')]: 'read',
      [runtime]: 'read', '/opt/homebrew/Cellar': 'read', '/opt/homebrew/opt': 'read',
      '/opt/homebrew/etc/openssl@3': 'read',
    },
    [`permissions.${profile}.network.enabled`]: false,
  };
  if (blender) values[`permissions.${profile}.filesystem`][resolve(blender, '../../..')] = 'read';
  for (const feature of ['apps', 'plugins', 'memories', 'hooks', 'shell_snapshot',
    'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external',
    'computer_use', 'in_app_browser', 'image_generation', 'workspace_dependencies',
    'skill_mcp_dependency_install', 'remote_plugin', 'recommended_plugins']) {
    values['features.' + feature] = false;
  }
  values['features.skip_host_skill_discovery'] = true;
  // This function returns TOML values for argv, never shell source.
  const toml = v => typeof v === 'object' && v !== null
    ? '{' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + '=' + toml(x)).join(',') + '}'
    : JSON.stringify(v);
  return Object.entries(values).flatMap(([key, value]) => ['-c', key + '=' + toml(value)]);
}

export function pilotPrompt({ node, blender, task }) {
  return `Complete this one 3D reconstruction task autonomously. You are the model being evaluated.
Read input/task.json, input/input-lock.json, and the allowlisted files under input/inputs.
Use only these task sources as evidence. Do not seek evaluator files, existing target models,
other projects, prior conversations, memory, the internet, or another AI model.
The filesystem and network restrictions enforce this experiment's input boundary.

Create output/model.glb as a real GLB 2.0 binary, following every output_contract rule.
Also leave your editable construction source in output/ and output/notes.md documenting
observed, inferred, and unresolved features and any limitations. Do not create submission scores.
Keep units, origin, axes, and all supported details in the supplied task. Do not add scenery.
Inspect your own result and correct errors within the budget. No evaluator feedback is supplied.
Your run has a hard limit of ${task.budget.wall_seconds} seconds, including reasoning and tool work.
Do not ask questions; record reasonable assumptions where the input is incomplete.

Tools are local shell, file editing, image inspection, Node.js (${node}),
and Three.js 0.180.0 (importable as 'three').
${blender ? `Blender is also available at ${blender}; use --background --factory-startup.` : ''}
Node has no browser DOM. All scripts, temporary files and renders must stay in this workspace.
Write final deliverables to output/. Finish with a concise account of what you produced.
`;
}

function stopGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
}

export async function captureProcess(command, args, { cwd, seconds = 60, stdin, logPrefix, env = hostEnvironment(), onEvent } = {}) {
  const started = new Date().toISOString(), clock = performance.now();
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', pending = '', timedOut = false, launchError = null, killTimer;
  const outFile = logPrefix && createWriteStream(logPrefix + '.jsonl', { flags: 'wx' });
  const errFile = logPrefix && createWriteStream(logPrefix + '.stderr.log', { flags: 'wx' });
  child.stdout.on('data', bytes => {
    outFile?.write(bytes);
    if (stdout.length < 2000000) stdout += bytes;
    pending += bytes.toString();
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) { try { onEvent?.(JSON.parse(line)); } catch {} }
  });
  child.stderr.on('data', bytes => { errFile?.write(bytes); if (stderr.length < 30000) stderr += bytes; });
  child.on('error', error => { launchError = error.message; });
  child.stdin.on('error', () => {});
  child.stdin.end(stdin || '');
  const timer = setTimeout(() => {
    timedOut = true; stopGroup(child.pid, 'SIGTERM');
    killTimer = setTimeout(() => stopGroup(child.pid, 'SIGKILL'), 2000);
  }, seconds * 1000);
  const { code, signal } = await new Promise(res => child.on('close', (code, signal) => res({ code, signal })));
  clearTimeout(timer); clearTimeout(killTimer);
  if (child.pid) stopGroup(child.pid, 'SIGKILL');
  await Promise.all([outFile, errFile].filter(Boolean).map(s => new Promise((res, rej) => { s.on('error', rej); s.end(res); })));
  return { started_at: started, finished_at: new Date().toISOString(), wall_seconds: (performance.now() - clock) / 1000,
    exit_code: code, signal, timed_out: timedOut, launch_error: launchError, stdout, stderr };
}

async function fileInventory(root, prefix = '') {
  const result = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? prefix + '/' + name : name, info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error('Cannot freeze a symlink: ' + path);
    if (info.isDirectory()) result.push(...await fileInventory(root, path));
    else if (info.isFile()) { const bytes = await readFile(join(root, path)); result.push({ path, bytes: bytes.length, sha256: sha256(bytes) }); }
  }
  return result;
}

export async function preparePilot({ root, id, taskIds = DEFAULT_PILOT_TASKS, model = 'gpt-6-astra', codex, blender }) {
  if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(id)) throw new Error('Invalid pilot id');
  if (!taskIds.length || new Set(taskIds).size !== taskIds.length) throw new Error('Tasks must be nonempty and unique');
  root = resolve(root); const dataRoot = join(root, '.local'), batch = join(dataRoot, 'pilots', id);
  const node = await realpath(process.execPath); codex = await realpath(codex); blender = blender ? await realpath(blender) : null;
  const tasks = [];
  for (const taskId of taskIds) {
    if (!/^[a-z0-9][a-z0-9-]+$/.test(taskId)) throw new Error('Invalid task id');
    const task = validateTask(await readJSON(join(dataRoot, 'tasks', taskId, 'task.json')));
    await verifySources(task, join(dataRoot, 'tasks', taskId)); tasks.push(task);
  }
  const version = await captureProcess(codex, ['--version']);
  const login = await captureProcess(codex, ['login', 'status']);
  if (login.exit_code !== 0 || !/Logged in using ChatGPT/.test(login.stdout + login.stderr))
    throw new Error('This pilot requires an existing Codex ChatGPT login; no API keys are configured by the runner');
  const catalogResult = await captureProcess(codex, ['debug', 'models', '--bundled']);
  if (catalogResult.exit_code !== 0) throw new Error('Could not inspect the exact model catalog');
  const catalog = JSON.parse(catalogResult.stdout), models = Array.isArray(catalog) ? catalog : catalog.models;
  const selected = models.find(m => m.slug === model);
  if (!selected || !selected.supported_reasoning_levels.some(r => r.effort === 'high')) throw new Error('Requested model/high is unavailable in the CLI catalog');
  const commit = await captureProcess('git', ['rev-parse', 'HEAD'], { cwd: root });
  const status = await captureProcess('git', ['status', '--porcelain'], { cwd: root });
  await mkdir(join(dataRoot, 'pilots'), { recursive: true });
  await mkdir(batch); // No overwrite, implicit resume, or retry.
  const runtime = join(batch, 'runtime'); await mkdir(join(runtime, 'node_modules'), { recursive: true });
  await cp(join(root, 'node_modules', 'three'), join(runtime, 'node_modules', 'three'), { recursive: true, dereference: true });
  const runtimeFiles = await fileInventory(runtime);
  await writeJSON(join(batch, 'runtime-lock.json'), runtimeFiles);
  const runnerFiles = ['lib/codex-pilot.mjs', 'scripts/run-pilot.mjs'];
  const runnerHash = objectHash(await Promise.all(runnerFiles.map(async path => ({ path, sha256: sha256(await readFile(join(root, path))) }))));
  const manifest = { schema_version: 1, id, kind: 'development_pilot', created_at: new Date().toISOString(),
    model_requested: model, reasoning_effort: 'high', harness: PILOT_VERSION, runner_sha256: runnerHash,
    repository_commit: commit.stdout.trim(), repository_dirty: Boolean(status.stdout.trim()),
    tools: { codex, codex_version: version.stdout.trim(), node, node_version: process.version, blender,
      three_version: '0.180.0', runtime_sha256: objectHash(runtimeFiles) },
    authentication: 'existing_codex_chatgpt_login', cost_usd: null, seed: null,
    attempts_per_task: 1, evaluator_feedback_during_generation: false,
    human_intervention_during_generation: false, official_leaderboard_eligible: false,
    tasks: tasks.map(t => ({ id: t.id, task_sha256: objectHash(t), split: t.split, status: t.status, budget: t.budget })),
  };
  await writeJSON(join(batch, 'manifest.json'), manifest);
  for (const task of tasks) {
    const job = join(batch, task.id), workspace = join(job, 'workspace');
    await mkdir(join(workspace, 'output'), { recursive: true }); await mkdir(join(workspace, 'tmp'));
    await exportTask(join(dataRoot, 'tasks', task.id, 'task.json'), join(workspace, 'input'));
    await symlink(join(runtime, 'node_modules'), join(workspace, 'node_modules'));
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
    const prompt = pilotPrompt({ node, blender, task });
    await writeFile(join(job, 'prompt.txt'), prompt);
    const config = workerConfig({ workspace, runtime, node, blender });
    const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
      '--color', 'never', '--json', '-C', workspace, '-m', model, ...config, '-'];
    const invocation = { command: codex, args, prompt_sha256: sha256(Buffer.from(prompt)), config,
      budget_seconds: task.budget.wall_seconds, workspace };
    await writeJSON(join(job, 'invocation.json'), invocation);
    const entry = manifest.tasks.find(t => t.id === task.id);
    entry.invocation_sha256 = objectHash(invocation);
    entry.input_directory_sha256 = objectHash(await fileInventory(join(workspace, 'input')));
    if (task.status === 'calibration_only') entry.truth_sha256 = objectHash(await readJSON(join(dataRoot, 'private', task.id, 'truth.json')));
  }
  await writeJSON(join(batch, 'manifest.json'), manifest);
  return { batch, manifest };
}

export async function preflightPilot(batch, root) {
  const manifest = await readJSON(join(batch, 'manifest.json')), results = [];
  const canary = join(batch, 'withheld-canary.txt');
  await writeFile(canary, 'Evaluator-only access probe; this is not task data.\n', { flag: 'wx' });
  for (const t of manifest.tasks) {
    const job = join(batch, t.id), invocation = await readJSON(join(job, 'invocation.json'));
    const { workspace, config } = invocation;
    if (objectHash(invocation) !== t.invocation_sha256) throw new Error('Invocation changed after freeze');
    await symlink(canary, join(workspace, 'outside-probe'));
    const probe = `const fs = require('fs');
const result = {};
function readable(p) { try { fs.readFileSync(p); return true; } catch { return false; } }
result.input_read = readable('input/task.json');
try { fs.writeFileSync('output/probe.txt', 'ok'); result.output_write = true; } catch { result.output_write = false; }
const locked = fs.readFileSync('input/task.json');
try { fs.writeFileSync('input/task.json', locked); result.input_write_blocked = false; } catch { result.input_write_blocked = true; }
result.outside_read_blocked = !readable(${JSON.stringify(canary)});
result.symlink_read_blocked = !readable('outside-probe');
result.evaluator_read_blocked = !readable(${JSON.stringify(join(root, 'lib', 'evaluate.mjs'))});
result.auth_read_blocked = !readable(${JSON.stringify(join(process.env.HOME, '.codex', 'auth.json'))});
result.memory_read_blocked = !readable(${JSON.stringify(join(process.env.HOME, '.codex', 'memories', 'MEMORY.md'))});
result.three_read = Boolean(require('three').REVISION);
fetch('http://127.0.0.1:5198/api/overview', {signal: AbortSignal.timeout(3000)})
.then(() => {result.network_blocked = false;})
.catch(e => {result.network_blocked = ['EPERM','EACCES'].includes(e.cause?.code);})
.finally(() => { console.log(JSON.stringify(result)); process.exitCode = Object.values(result).every(Boolean) ? 0 : 1; });`;
    const run = await captureProcess(manifest.tools.codex, ['sandbox', '-P', 'evidence3d-pilot', '-C', workspace, ...config,
      manifest.tools.node, '-e', probe], { cwd: workspace });
    let checks = null; try { checks = JSON.parse(run.stdout.trim()); } catch {}
    results.push({ task_id: t.id, passed: run.exit_code === 0 && checks && Object.values(checks).every(Boolean), checks,
      exit_code: run.exit_code, stderr: run.stderr });
    if (results.at(-1).passed && manifest.tools.blender) {
      const exportPath = join(workspace, 'output', 'blender-probe.glb');
      const script = 'import bpy; bpy.ops.wm.read_factory_settings(use_empty=True); bpy.ops.mesh.primitive_cube_add(); ' +
        'bpy.ops.export_scene.gltf(filepath=' + JSON.stringify(exportPath) + ',export_format="GLB"); print("BLENDER_EXPORT_OK")';
      const blenderRun = await captureProcess(manifest.tools.codex, ['sandbox', '-P', 'evidence3d-pilot', '-C', workspace, ...config,
        manifest.tools.blender, '--background', '--factory-startup', '--python-expr', script], { cwd: workspace, seconds: 45 });
      results.at(-1).blender = { passed: blenderRun.exit_code === 0 && blenderRun.stdout.includes('BLENDER_EXPORT_OK'),
        exit_code: blenderRun.exit_code, stdout: blenderRun.stdout, stderr: blenderRun.stderr };
      results.at(-1).passed = results.at(-1).blender.passed;
      try { await unlink(exportPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    await verifySources(await readJSON(join(workspace, 'input', 'task.json')), join(workspace, 'input'));
    await unlink(join(workspace, 'outside-probe'));
    try { await unlink(join(workspace, 'output', 'probe.txt')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!results.at(-1).passed) break;
  }
  const report = { passed: results.length === manifest.tasks.length && results.every(r => r.passed), checks: results,
    boundary: 'Codex Seatbelt command execution; model service uses host login. No formal third-party runner attestation.' };
  await writeJSON(join(batch, 'preflight.json'), report);
  return report;
}

export function summarizeEvents(events) {
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  let completed = 0, commands = 0; const errors = [];
  for (const e of events) {
    if (e.type === 'turn.completed') { completed++; for (const k of Object.keys(usage)) usage[k] += e.usage?.[k] || 0; }
    if (e.type === 'item.completed' && e.item?.type === 'command_execution') commands++;
    if (e.type === 'error' || e.type === 'turn.failed') errors.push(e.message || e.error?.message || JSON.stringify(e));
  }
  return { completed_turns: completed, commands, usage: completed ? usage : null, errors };
}

export async function executePilot({ root, batch, onProgress = () => {} }) {
  const manifest = await readJSON(join(batch, 'manifest.json'));
  if (!(await readJSON(join(batch, 'preflight.json'))).passed) throw new Error('Isolation preflight has not passed');
  const runnerHash = objectHash(await Promise.all(['lib/codex-pilot.mjs', 'scripts/run-pilot.mjs'].map(async path =>
    ({ path, sha256: sha256(await readFile(join(root, path))) }))));
  if (runnerHash !== manifest.runner_sha256) throw new Error('Runner changed after freeze; create a new pilot');
  if (objectHash(await fileInventory(join(batch, 'runtime'))) !== manifest.tools.runtime_sha256) throw new Error('Runtime changed after freeze');
  const results = [], dataRoot = join(root, '.local');
  for (const entry of manifest.tasks) {
    const job = join(batch, entry.id), invocation = await readJSON(join(job, 'invocation.json'));
    if (objectHash(invocation) !== entry.invocation_sha256) throw new Error('Invocation changed after freeze');
    if (sha256(await readFile(join(job, 'prompt.txt'))) !== invocation.prompt_sha256) throw new Error('Prompt changed after freeze');
    if (objectHash(await fileInventory(join(invocation.workspace, 'input'))) !== entry.input_directory_sha256) throw new Error('Input pack changed after freeze');
    if ((await readdir(join(invocation.workspace, 'output'))).length) throw new Error('Generation output must start empty');
    const taskPath = join(dataRoot, 'tasks', entry.id, 'task.json'), task = await readJSON(taskPath);
    if (objectHash(task) !== entry.task_sha256) throw new Error('Task changed after pilot freeze');
    await writeFile(join(job, 'started.json'), JSON.stringify({ at: new Date().toISOString() }), { flag: 'wx' });
    onProgress({ event: 'started', task_id: entry.id, limit_seconds: entry.budget.wall_seconds });
    const events = [];
    const run = await captureProcess(invocation.command, invocation.args, {
      cwd: invocation.workspace, seconds: invocation.budget_seconds,
      stdin: await readFile(join(job, 'prompt.txt'), 'utf8'), logPrefix: join(job, 'events'),
      onEvent: event => { events.push(event); if (event.type === 'item.completed' && event.item?.type === 'agent_message')
        onProgress({ event: 'model_message', task_id: entry.id, text: event.item.text }); },
    });
    const eventSummary = summarizeEvents(events), result = { task_id: entry.id, ...eventSummary,
      started_at: run.started_at, finished_at: run.finished_at, wall_seconds: run.wall_seconds,
      timed_out: run.timed_out, exit_code: run.exit_code, signal: run.signal, launch_error: run.launch_error,
      status: run.timed_out ? 'timeout' : run.exit_code !== 0 || !eventSummary.completed_turns ? 'generation_failed' : 'completed',
      cost_usd: null, human_intervention: false, geometry_score: null, visual_score: null,
      official_leaderboard_eligible: false };
    try {
      await verifySources(task, join(invocation.workspace, 'input'));
      if (objectHash(await fileInventory(join(invocation.workspace, 'input'))) !== entry.input_directory_sha256) throw new Error('Input pack changed during generation');
      const outputs = await fileInventory(join(invocation.workspace, 'output'));
      await writeJSON(join(job, 'output-lock.json'), outputs);
      const artifact = outputs.find(f => f.path === 'model.glb');
      if (!artifact) result.status = result.status === 'completed' ? 'missing_artifact' : result.status;
      else {
        const submissionId = manifest.id + '-' + entry.id;
        const submission = validateSubmission({ schema_version: 1, id: submissionId, task_id: task.id,
          task_sha256: objectHash(task), artifact: { path: 'model.glb', sha256: artifact.sha256 },
          system: { name: 'Astra / Codex CLI pilot', model_version: manifest.model_requested,
            harness_version: manifest.harness + ' / ' + manifest.tools.codex_version },
          run: { seed: null, wall_seconds: run.wall_seconds, cost_usd: null, human_intervention: false, resource_accounting: 'runner_measured' },
        }, task);
        const submissionPath = join(invocation.workspace, 'output', 'submission.json');
        await writeJSON(submissionPath, submission);
        result.artifact = join(invocation.workspace, 'output', 'model.glb'); result.submission_id = submissionId;
        const reportDir = join(job, 'evaluation');
        if (entry.truth_sha256 && objectHash(await readJSON(join(dataRoot, 'private', task.id, 'truth.json'))) !== entry.truth_sha256)
          throw new Error('Scoring truth changed after pilot freeze');
        await evaluate({ taskPath, submissionPath, outputDir: reportDir,
          truthPath: task.status === 'calibration_only' ? join(dataRoot, 'private', task.id, 'truth.json') : undefined });
        result.report = join(reportDir, 'report.json');
        const report = await readJSON(result.report);
        result.technical_valid = report.technical.valid; result.eligibility = report.eligibility;
        result.geometry_checks_pass = report.geometry_checks_pass;
        result.metrics = report.metrics; result.details = report.detail_geometry;
        if (!report.technical.valid && result.status === 'completed') result.status = 'invalid_artifact';
        if (result.status === 'completed' && report.detail_geometry) {
          result.registration = await registerDetailSubmission(dataRoot, submissionPath, 'Astra · ' + manifest.id);
        }
      }
    } catch (error) { result.evaluation_error = error.message; if (result.status === 'completed') result.status = 'evaluation_failed'; }
    await writeJSON(join(job, 'result.json'), result); results.push(result);
    await writeJSON(join(batch, 'summary.json'), { manifest, results, complete: results.length === manifest.tasks.length });
    onProgress({ event: 'finished', task_id: entry.id, status: result.status, wall_seconds: result.wall_seconds,
      technical_valid: result.technical_valid, geometry_checks_pass: result.geometry_checks_pass, evaluation_error: result.evaluation_error });
  }
  return results;
}
