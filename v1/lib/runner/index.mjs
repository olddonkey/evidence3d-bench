import { mkdir, readFile, writeFile, readdir, lstat, access, rm } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { layout, PROTOCOL, validateTask } from '../contract.mjs';
import { adapterFor, nodeRuntime, codexGlobalInstructions } from './adapters.mjs';
import { captureProcess, childEnvironment, commandOf, killTree } from './process.mjs';
import { toolSurfaceProblems, readJSONLines } from './events.mjs';
import { buildPrompt, PROMPT_VERSION } from './prompt.mjs';
import { runPreflight } from './preflight.mjs';
import { classifyStatus, scoreOf, STATUSES } from './status.mjs';
import {
  sha256, sha256File, objectHash, readJSON, writeJSON, inventory, inventoryHash, makeReadOnly,
  buildRuntime, buildWorkspace, workspaceHashes, readArtifact,
} from './workspace.mjs';

// The generation runner: freezes a batch (prepare), proves the isolation
// boundary (preflight), then runs every attempt once under a hard wall clock
// and scores what it left in output/ (execute). Layout under <data>/runs/<id>/:
//   manifest.json  preflight.json  summary.json  runtime/  tools/  preflight/<time>/
//   <task>/a<n>/ workspace/ prompt.txt invocation.json harness/ events.jsonl stderr.log
//                started.json result.json score/{submission.glb, report.json, ...}
export const RUNNER_VERSION = 'e3d-runner-v1';
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../..');
export const DEFAULT_DATA_ROOT = join(REPO_ROOT, '.local', 'v1');
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;

// Source files whose change invalidates a frozen batch.
async function runnerFiles() {
  const own = (await readdir(HERE)).filter(name => name.endsWith('.mjs')).sort().map(name => join('v1/lib/runner', name));
  return [...own, 'v1/scripts/run.mjs', 'v1/lib/contract.mjs', 'v1/lib/png.mjs', 'lib/io.mjs'];
}

async function runnerHash(repoRoot = REPO_ROOT) {
  const files = [];
  for (const path of await runnerFiles()) {
    try { files.push({ path, sha256: sha256(await readFile(join(repoRoot, path))) }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { sha256: objectHash(files), files };
}

async function repositoryState(repoRoot) {
  const head = await captureProcess('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repoRoot, seconds: 20 });
  const status = await captureProcess('/usr/bin/git', ['status', '--porcelain'], { cwd: repoRoot, seconds: 20 });
  return { commit: head.exit_code === 0 ? head.stdout.trim() : null, dirty: status.exit_code === 0 ? Boolean(status.stdout.trim()) : null };
}

async function loadInstallTools(deps) {
  if (deps.installTools) return deps.installTools;
  let module;
  try { module = await import('../render/install-tools.mjs'); }
  catch (error) { throw new Error('The preview tool kit (v1/lib/render/install-tools.mjs, module G) is not available: ' + error.message); }
  if (typeof module.installTools !== 'function') throw new Error('v1/lib/render/install-tools.mjs does not export installTools');
  return module.installTools;
}

export function scorerModulePath(deps = {}) {
  return deps.scorerModule ?? join(REPO_ROOT, 'v1', 'lib', 'score', 'index.mjs');
}

async function checkScorer(deps) {
  const path = scorerModulePath(deps);
  let module;
  try { module = await import(pathToFileURL(path).href); }
  catch (error) { throw new Error('The scorer (' + path + ', module D) is not available: ' + error.message); }
  if (typeof module.scoreSubmission !== 'function') throw new Error(path + ' does not export scoreSubmission');
  return path;
}

const attemptDir = (batchDir, taskId, n) => join(batchDir, taskId, 'a' + n);

// ---------------------------------------------------------------- prepare

export async function prepare({ id, system, model, effort, tasks, attempts = 1, dataRoot = DEFAULT_DATA_ROOT, binary, repoRoot = REPO_ROOT, deps = {}, log = () => {} }) {
  if (!ID.test(id ?? '')) throw new Error('Invalid batch id ' + id);
  if (!Array.isArray(tasks) || !tasks.length || new Set(tasks).size !== tasks.length || !tasks.every(task => ID.test(task))) throw new Error('Tasks must be a non-empty list of unique task ids');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) throw new Error('attempts must be an integer from 1 to 20');
  const adapter = adapterFor(system);
  dataRoot = resolve(dataRoot);
  const paths = layout(dataRoot);
  const harness = await (deps.inspect ?? adapter.inspect)({ binary: binary ?? adapter.defaultBinary(), model, effort });
  const node = await nodeRuntime(deps.nodePath);
  node.sha256 = await sha256File(node.path);
  const installTools = await loadInstallTools(deps);
  const taskRecords = [];
  for (const taskId of tasks) {
    const taskBytes = await readFile(join(paths.task(taskId), 'task.json'));
    const task = validateTask(JSON.parse(taskBytes.toString('utf8')));
    if (task.id !== taskId) throw new Error('Task ' + taskId + ' has id ' + task.id);
    let truthSha = null;
    try { truthSha = sha256(await readFile(join(paths.truth(taskId), 'truth.json'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; throw new Error('Task ' + taskId + ' has no truth record; it could not be scored'); }
    taskRecords.push({ task, taskBytes, truthSha });
  }
  await mkdir(paths.runs, { recursive: true });
  const batchDir = join(paths.runs, id);
  try { await mkdir(batchDir); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Batch ' + id + ' already exists; a frozen batch is never rewritten, use a new id'); throw error; }
  log({ event: 'prepare', batch: batchDir, system, model: harness.model, effort: harness.effort });
  try { return await freezeBatch({ batchDir, id, system, attempts, dataRoot, paths, adapter, harness, node, installTools, taskRecords, repoRoot, log }); }
  catch (error) {
    // A half-built batch would block its id and could be mistaken for a real one.
    await rm(batchDir, { recursive: true, force: true });
    throw error;
  }
}

async function freezeBatch({ batchDir, id, system, attempts, dataRoot, paths, adapter, harness, node, installTools, taskRecords, repoRoot, log }) {
  const runtime = await buildRuntime({ repoRoot, runtimeDir: join(batchDir, 'runtime') });
  const toolsDir = join(batchDir, 'tools');
  const installed = await installTools(toolsDir);
  await makeReadOnly(toolsDir);
  const tools = { sha256: inventoryHash(await inventory(toolsDir)), files: installed?.files ?? null };
  const manifest = {
    schema: 'e3d-run-batch-v1', runner: RUNNER_VERSION, protocol: PROTOCOL, id, created_at: new Date().toISOString(),
    system, model: harness.model, effort: harness.effort, attempts, data_root: dataRoot,
    harness, node, runtime: { three_version: runtime.three_version, sha256: runtime.sha256, files: runtime.files }, tools,
    runner_source: await runnerHash(repoRoot), prompt_version: PROMPT_VERSION, repository: await repositoryState(repoRoot),
    rules: { evaluator_feedback_during_generation: false, retries: false, human_intervention: false, api_keys: false },
    tasks: [],
  };
  for (const { task, taskBytes, truthSha } of taskRecords) {
    const prompt = buildPrompt({ system, task, threeVersion: runtime.three_version });
    const record = { id: task.id, task_sha256: objectHash(task), task_file_sha256: sha256(taskBytes), truth_sha256: truthSha,
      budget: task.budget, prompt_sha256: sha256(prompt), attempts: [] };
    for (let n = 1; n <= attempts; n++) {
      const dir = attemptDir(batchDir, task.id, n), workspace = join(dir, 'workspace');
      const built = await buildWorkspace({ workspace, taskDir: paths.task(task.id), toolsDir, runtimeDir: join(batchDir, 'runtime') });
      if (built.hashes.tools !== tools.sha256 || built.hashes.runtime !== runtime.sha256) throw new Error('Workspace copy differs from the batch runtime or tools');
      record.input_sha256 ??= built.hashes.input;
      if (built.hashes.input !== record.input_sha256) throw new Error('Workspace input differs between attempts of ' + task.id);
      await writeFile(join(dir, 'prompt.txt'), prompt, { flag: 'wx' });
      const spec = adapter.invocation({ harness, model: harness.model, effort: harness.effort, workspace, attemptDir: dir, node });
      const files = {};
      for (const [path, content] of Object.entries(spec.files ?? {})) { await writeJSON(path, content); files[relative(dir, path)] = objectHash(content); }
      await mkdir(join(dir, 'harness', 'debug'), { recursive: true });
      const invocation = { command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env, stdin: 'prompt.txt', files,
        wall_seconds: task.budget.wall_seconds, workspace };
      await writeJSON(join(dir, 'invocation.json'), invocation, { exclusive: true });
      record.attempts.push({ n, dir: relative(batchDir, dir), invocation_sha256: objectHash(invocation) });
    }
    manifest.tasks.push(record);
  }
  await writeJSON(join(batchDir, 'manifest.json'), manifest, { exclusive: true });
  log({ event: 'prepared', batch: batchDir, attempts: manifest.tasks.reduce((sum, task) => sum + task.attempts.length, 0) });
  return { batchDir, manifest };
}

// ---------------------------------------------------------------- freeze checks

export const manifestHash = manifest => objectHash(manifest);

// Everything a batch froze, re-checked. Returns a list of problems.
export async function frozenProblems(batchDir, manifest, { repoRoot = REPO_ROOT, checkRunner = true } = {}) {
  const problems = [];
  if (checkRunner && (await runnerHash(repoRoot)).sha256 !== manifest.runner_source.sha256) problems.push('runner source changed since the batch was frozen');
  if (inventoryHash(await inventory(join(batchDir, 'runtime', 'node_modules'))) !== manifest.runtime.sha256) problems.push('runtime changed');
  if (inventoryHash(await inventory(join(batchDir, 'tools'))) !== manifest.tools.sha256) problems.push('preview tools changed');
  for (const [label, path, sha] of [['harness binary', manifest.harness.binary_realpath, manifest.harness.binary_sha256], ['node binary', manifest.node.path, manifest.node.sha256]]) {
    try { if (await sha256File(path) !== sha) problems.push(label + ' changed: ' + path); }
    catch { problems.push(label + ' is missing: ' + path); }
  }
  if (manifest.system === 'codex' && manifest.harness.codex_home) {
    const { loaded } = await codexGlobalInstructions(manifest.harness.codex_home);
    if (loaded.length) problems.push('global Codex instructions would be injected into every session: ' + loaded.join(', '));
  }
  for (const task of manifest.tasks) {
    const taskPath = join(layout(manifest.data_root).task(task.id), 'task.json');
    try { if (sha256(await readFile(taskPath)) !== task.task_file_sha256) problems.push('task ' + task.id + ' changed'); }
    catch { problems.push('task ' + task.id + ' is missing'); }
    for (const attempt of task.attempts) {
      const dir = join(batchDir, attempt.dir);
      try {
        const invocation = await readJSON(join(dir, 'invocation.json'));
        if (objectHash(invocation) !== attempt.invocation_sha256) problems.push(attempt.dir + ': invocation changed');
        if (sha256(await readFile(join(dir, 'prompt.txt'))) !== task.prompt_sha256) problems.push(attempt.dir + ': prompt changed');
        for (const [file, hash] of Object.entries(invocation.files ?? {})) {
          if (objectHash(await readJSON(join(dir, file))) !== hash) problems.push(attempt.dir + ': ' + file + ' changed');
        }
      } catch (error) { problems.push(attempt.dir + ': ' + error.message); }
    }
  }
  return problems;
}

// ---------------------------------------------------------------- preflight

export async function preflight({ batchDir, probeModel, probeEffort, repoRoot = REPO_ROOT, scratchDir, skipAgent = false, deps = {}, log = () => {} }) {
  batchDir = resolve(batchDir);
  const manifest = await readJSON(join(batchDir, 'manifest.json'));
  const problems = await frozenProblems(batchDir, manifest, { repoRoot });
  const adapter = deps.adapter ?? adapterFor(manifest.system);
  const effort = probeEffort ?? manifest.harness.effort_levels?.[0] ?? manifest.effort;
  let result;
  if (problems.length) result = { checks: problems.map(reason => ({ id: 'freeze', status: 'fail', reason })), sessions: {}, passed: false, failed: ['freeze'], not_evaluated: [] };
  else {
    result = await runPreflight({ batchDir, manifest, adapter, harness: manifest.harness, node: manifest.node, repoRoot,
      dataRoot: manifest.data_root, probeModel: probeModel ?? manifest.model, probeEffort: effort, scratchDir, skipAgent, internet: deps.internet, log });
  }
  const report = {
    schema: 'e3d-preflight-v1', created_at: new Date().toISOString(), batch: manifest.id, system: manifest.system,
    manifest_sha256: manifestHash(manifest), passed: result.passed, failed: result.failed, not_evaluated: result.not_evaluated,
    probe_session: result.sessions, directory: result.directory ? relative(batchDir, result.directory) : null, checks: result.checks,
  };
  await writeJSON(join(batchDir, 'preflight.json'), report);
  if (result.directory) await writeJSON(join(result.directory, 'report.json'), report);
  return report;
}

// ---------------------------------------------------------------- execute

function resultRecord(manifest, task, attempt, fields) {
  return {
    task_id: task.id, attempt: attempt.n, system: manifest.system, model: manifest.model, effort: manifest.effort,
    status: fields.status, wall_seconds: fields.wall_seconds ?? null, usage: fields.usage ?? null, cost_usd: fields.cost_usd ?? null,
    turns: fields.turns ?? null, commands: fields.commands ?? null, score: fields.score ?? 0, report: fields.report ?? null,
    ...fields.extra,
  };
}

async function scoreArtifact({ manifest, task, dir, artifact, deps }) {
  const scoreDir = join(dir, 'score');
  await mkdir(scoreDir, { recursive: true });
  const submission = join(scoreDir, 'submission.glb');
  await writeFile(submission, artifact.data);
  const paths = layout(manifest.data_root);
  if (sha256(await readFile(join(paths.truth(task.id), 'truth.json'))) !== task.truth_sha256) return { error: 'truth record changed since the batch was frozen' };
  const job = join(scoreDir, 'job.json');
  await writeJSON(job, { module: scorerModulePath(deps), glb: submission, taskDir: paths.task(task.id), truthDir: paths.truth(task.id),
    dataRoot: manifest.data_root, outDir: scoreDir });
  const run = await captureProcess(process.execPath, [join(HERE, 'score-worker.mjs'), job], { cwd: scoreDir, seconds: deps.scoreSeconds ?? 1800,
    env: childEnvironment(), stdoutPath: join(scoreDir, 'worker.stdout.log'), stderrPath: join(scoreDir, 'worker.stderr.log') });
  if (run.exit_code !== 0) return { error: 'scorer failed (exit ' + run.exit_code + (run.timed_out ? ', timed out' : '') + '): ' + run.stderr.trim().split('\n').slice(-3).join(' | ') };
  try { return { report: await readJSON(join(scoreDir, 'report.json')), path: join(scoreDir, 'report.json') }; }
  catch (error) { return { error: 'scorer wrote no report: ' + error.message }; }
}

// A report for an artifact the runner refused before scoring, in the scorer's
// own shape, so every scored attempt has a report.
function refusalReport(task, manifest, reason) {
  return { schema: 'e3d-report-v1', protocol: PROTOCOL, task_id: task.id, object: null, variant: null, valid: false, error: reason, score: 0,
    produced_by: RUNNER_VERSION + ' (refused before scoring)' };
}

async function workspaceProblems(workspace, task, manifest) {
  const after = await workspaceHashes(workspace), problems = [];
  if (after.input !== task.input_sha256) problems.push('input/ changed during generation');
  if (after.tools !== manifest.tools.sha256) problems.push('tools/ changed during generation');
  if (after.runtime !== manifest.runtime.sha256) problems.push('node_modules/ changed during generation');
  return problems;
}

async function runAttempt({ batchDir, manifest, task, attempt, adapter, deps, log }) {
  const dir = join(batchDir, attempt.dir), resultPath = join(dir, 'result.json');
  try { return { result: await readJSON(resultPath), skipped: true }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const workspace = join(dir, 'workspace'), invocation = await readJSON(join(dir, 'invocation.json'));
  const finish = async fields => {
    const result = resultRecord(manifest, task, attempt, fields);
    await writeJSON(resultPath, result, { exclusive: true });
    return { result, skipped: false };
  };
  let started = false;
  try { await access(join(dir, 'started.json')); started = true; } catch {}
  let run = null, summary = null, integrityProblems = [], recovered = null;
  if (started) {
    // The runner stopped during this attempt. It is never re-run: a second try
    // would be a retry, and could be used to discard bad runs.
    try { recovered = await readJSON(join(dir, 'process.json')); } catch {}
  }
  if (started && recovered) {
    // Generation had finished (process.json is written right after the CLI
    // exits); only scoring was cut short. Rebuild the record from the logs.
    run = recovered;
    summary = adapter.parse(readJSONLines(await readFile(join(dir, 'events.jsonl'), 'utf8').catch(() => '')));
    integrityProblems.push(...await workspaceProblems(workspace, task, manifest), ...toolSurfaceProblems(manifest.system, summary));
  } else if (started) {
    // Nothing enforced the wall clock after the runner died, so whatever the
    // contestant left is not scored. A process tree that outlived the runner
    // is stopped before output/ is read.
    integrityProblems = ['interrupted: the runner stopped before this attempt finished'];
    try {
      const { pid } = await readJSON(join(dir, 'child.json'));
      if ((commandOf(pid) ?? '').includes(invocation.command)) { killTree(pid, 'SIGKILL'); integrityProblems.push('a leftover harness process ' + pid + ' was killed'); }
    } catch {}
  } else {
    if (objectHash(invocation) !== attempt.invocation_sha256) throw new Error(attempt.dir + ': invocation changed after freeze');
    const prompt = await readFile(join(dir, 'prompt.txt'), 'utf8');
    if (sha256(prompt) !== task.prompt_sha256) throw new Error(attempt.dir + ': prompt changed after freeze');
    const hashes = await workspaceHashes(workspace);
    if (hashes.input !== task.input_sha256 || hashes.tools !== manifest.tools.sha256 || hashes.runtime !== manifest.runtime.sha256) throw new Error(attempt.dir + ': workspace changed after freeze');
    if ((await readdir(join(workspace, 'output'))).length) throw new Error(attempt.dir + ': output/ must start empty');
    await writeJSON(join(dir, 'started.json'), { at: new Date().toISOString(), pid: process.pid }, { exclusive: true });
    log({ event: 'started', task_id: task.id, attempt: attempt.n, wall_seconds: invocation.wall_seconds });
    const events = [];
    run = await captureProcess(invocation.command, invocation.args, {
      cwd: invocation.cwd, env: invocation.env, stdin: prompt, seconds: invocation.wall_seconds, graceSeconds: deps.graceSeconds ?? 5,
      stdoutPath: join(dir, 'events.jsonl'), stderrPath: join(dir, 'stderr.log'), onEvent: event => events.push(event),
      onSpawn: pid => writeJSON(join(dir, 'child.json'), { pid, command: invocation.command }),
    });
    summary = adapter.parse(events);
    integrityProblems.push(...await workspaceProblems(workspace, task, manifest), ...toolSurfaceProblems(manifest.system, summary));
    await writeJSON(join(dir, 'process.json'), { ...run, stdout: undefined, stderr: undefined });
  }
  const artifact = await readArtifact(workspace, 'output/model.glb', { maxBytes: task.budget.max_artifact_bytes });
  let report = null, reportPath = null, scoreError = null;
  if (artifact.present && artifact.problem) {
    report = refusalReport(task, manifest, artifact.problem);
    reportPath = join(dir, 'score', 'report.json');
    await writeJSON(reportPath, report);
  } else if (artifact.present) {
    const scored = await scoreArtifact({ manifest, task, dir, artifact, deps });
    if (scored.error) scoreError = scored.error; else { report = scored.report; reportPath = scored.path; }
  }
  const status = classifyStatus({ run, summary, integrityProblems, artifact, report, scoreError });
  // A broken boundary, or a run the runner could not supervise to the end,
  // voids the attempt whatever it produced; the report is kept for diagnosis.
  const score = integrityProblems.length ? 0 : scoreOf(report);
  const outcome = await finish({
    status, wall_seconds: run?.wall_seconds ?? null, usage: summary?.usage ?? null, cost_usd: summary?.cost_usd ?? null,
    turns: summary?.turns ?? null, commands: summary?.commands ?? null, score, report: reportPath ? relative(batchDir, reportPath) : null,
    extra: {
      started_at: run?.started_at ?? null, finished_at: run?.finished_at ?? null, exit_code: run?.exit_code ?? null, signal: run?.signal ?? null,
      timed_out: run?.timed_out ?? false, launch_error: run?.launch_error ?? null, wall_limit_seconds: invocation.wall_seconds,
      model_reported: summary?.model_reported ?? null, usage_detail: summary?.usage_detail ?? null, tools: summary?.tools ?? null,
      errors: (summary?.errors ?? []).slice(0, 10), integrity_problems: integrityProblems,
      artifact: artifact.present ? { bytes: artifact.bytes ?? null, sha256: artifact.sha256 ?? null, problem: artifact.problem } : null,
      report_valid: report ? report.valid !== false : null, score_error: scoreError,
      notes_present: await lstat(join(workspace, 'output', 'notes.md')).then(info => info.isFile(), () => false),
    },
  });
  log({ event: 'finished', task_id: task.id, attempt: attempt.n, status, score: outcome.result.score, wall_seconds: outcome.result.wall_seconds });
  return outcome;
}

export async function summarize(batchDir) {
  batchDir = resolve(batchDir);
  const manifest = await readJSON(join(batchDir, 'manifest.json')), attempts = [];
  for (const task of manifest.tasks) for (const attempt of task.attempts) {
    try { attempts.push(await readJSON(join(batchDir, attempt.dir, 'result.json'))); }
    catch { attempts.push({ task_id: task.id, attempt: attempt.n, status: 'pending' }); }
  }
  const counts = Object.fromEntries([...STATUSES, 'pending'].map(status => [status, attempts.filter(item => item.status === status).length]));
  const done = attempts.filter(item => item.status !== 'pending'), scores = done.map(item => item.score);
  const total = key => done.reduce((sum, item) => sum + (item.usage?.[key] ?? 0), 0);
  const costs = done.map(item => item.cost_usd).filter(Number.isFinite);
  const summary = {
    schema: 'e3d-run-summary-v1', batch: manifest.id, system: manifest.system, model: manifest.model, effort: manifest.effort,
    updated_at: new Date().toISOString(), complete: counts.pending === 0, counts,
    mean_score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    usage: done.some(item => item.usage) ? { input_tokens: total('input_tokens'), cached_input_tokens: total('cached_input_tokens'), output_tokens: total('output_tokens') } : null,
    cost_usd: costs.length ? costs.reduce((a, b) => a + b, 0) : null, cost_complete: costs.length === done.length,
    attempts: attempts.map(item => ({ task_id: item.task_id, attempt: item.attempt, status: item.status, score: item.score ?? null,
      wall_seconds: item.wall_seconds ?? null, cost_usd: item.cost_usd ?? null })),
  };
  await writeJSON(join(batchDir, 'summary.json'), summary);
  return summary;
}

export async function execute({ batchDir, concurrency = 1, repoRoot = REPO_ROOT, deps = {}, log = () => {} }) {
  batchDir = resolve(batchDir);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('concurrency must be 1..16');
  const manifest = await readJSON(join(batchDir, 'manifest.json'));
  let preflightReport;
  try { preflightReport = await readJSON(join(batchDir, 'preflight.json')); } catch { throw new Error('No preflight.json: run preflight first'); }
  if (!preflightReport.passed) throw new Error('Isolation preflight did not pass; nothing will run');
  if (preflightReport.manifest_sha256 !== manifestHash(manifest)) throw new Error('The manifest changed after preflight; run preflight again');
  const problems = await frozenProblems(batchDir, manifest, { repoRoot, checkRunner: !deps.skipRunnerCheck });
  if (problems.length) throw new Error('Frozen batch changed: ' + problems.join('; '));
  await checkScorer(deps);
  const adapter = deps.adapter ?? adapterFor(manifest.system);
  const queue = manifest.tasks.flatMap(task => task.attempts.map(attempt => ({ task, attempt })));
  const results = [];
  let summaryChain = Promise.resolve();
  const worker = async () => {
    while (queue.length) {
      const { task, attempt } = queue.shift();
      const outcome = await runAttempt({ batchDir, manifest, task, attempt, adapter, deps, log });
      if (outcome.skipped) log({ event: 'skipped', task_id: task.id, attempt: attempt.n, status: outcome.result.status });
      results.push(outcome.result);
      // Summary writes are serialized; attempts finish in any order.
      summaryChain = summaryChain.then(() => summarize(batchDir));
      await summaryChain;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
  return summarize(batchDir);
}

export { buildPrompt, PROMPT_VERSION } from './prompt.mjs';
export { parseCodexEvents, parseClaudeEvents, parseEvents } from './events.mjs';
export { captureProcess, childEnvironment, killTree } from './process.mjs';
export { classifyStatus, STATUSES } from './status.mjs';
export { ADAPTERS, adapterFor, nodeRuntime, codexConfig, claudeSettings } from './adapters.mjs';

// The names the brief uses for the v0 runner's entry points.
export { prepare as preparePilot, preflight as preflightPilot, execute as executePilot };
