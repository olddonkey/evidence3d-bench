import { mkdir, readFile, writeFile, readdir, lstat, access, rm, rename, appendFile, copyFile } from 'node:fs/promises';
import { join, dirname, resolve, relative, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadavg, cpus, hostname } from 'node:os';
import { performance } from 'node:perf_hooks';
import { layout, PROTOCOL, validateTask, validateTruth } from '../contract.mjs';
import { adapterFor, nodeRuntime, codexGlobalInstructions } from './adapters.mjs';
import { agyConfigProblems } from './antigravity-config.mjs';
import { captureProcess, childEnvironment, commandOf, killTree, startTimeOf } from './process.mjs';
import { toolSurfaceProblems, readJSONLines } from './events.mjs';
import { buildPrompt, PROMPT_VERSION } from './prompt.mjs';
import { runPreflight } from './preflight.mjs';
import { classifyStatus, scoreOf, STATUSES, NOT_SAMPLES } from './status.mjs';
import { detectInfra, modelTurns, retryWatch, INFRA_REASONS } from './infra.mjs';
import { createGate, holdUntil, HOLD_KIND, SCHEDULE } from './schedule.mjs';
import { hostSleepCheck, hostSuspension, PMSET } from './hostsleep.mjs';
import {
  sha256, sha256File, objectHash, readJSON, writeJSON, inventory, inventoryHash, makeReadOnly,
  buildRuntime, buildWorkspace, workspaceHashes, readArtifact, STALE_TEMPORARY, writeJSONSync, writeHarnessFile, readHarnessFile,
} from './workspace.mjs';

// The generation runner: freezes a batch (prepare), proves the isolation
// boundary (preflight), then runs every attempt under a hard wall clock and
// scores what it left in output/ (execute). An attempt that ended in an
// infrastructure error is not a sample: it is archived and run again from a
// pristine workspace. Layout under <data>/runs/<id>/:
//   manifest.json  preflight.json  summary.json  progress.log  run.lock  runner-state.json  runtime/  tools/  preflight/<time>/
//   <task>/a<n>/ workspace/ prompt.txt invocation.json harness/ events.jsonl stderr.log rerun.json
//                started.json child.json process.json result.json score/{submission.glb, report.json, ...}
//   <task>/a<n>.infra-<k>/   an earlier try of a<n> that ended in an infrastructure error (kept, never deleted)
export const RUNNER_VERSION = 'e3d-runner-v1';
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../..');
export const DEFAULT_DATA_ROOT = join(REPO_ROOT, '.local', 'v1');
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;

// Re-runs of one attempt allowed for failures of the session itself. Tries
// ended by a usage or rate limit (the account), by an operator stopping the
// runner, or by a login/billing/model problem (the batch stops for a human)
// are archived like any other but do not use this up: they say nothing about
// whether this attempt can run.
export const DEFAULT_MAX_RERUNS = 5;
export const RERUN_COUNTED = ['cli_crash', 'cli_stalled', 'network', 'overloaded', 'server_error'];
// A CLI retrying the service this long with no sign of the model is stopped.
export const DEFAULT_RETRY_STALL_SECONDS = 600;

// ---------------------------------------------------------------- frozen sources

const IMPORT = /\b(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"]([^'"\n]+)['"]|\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g;

async function listFiles(dir) {
  const found = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return found; throw error; }
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await listFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

// The repository files a module tree consists of: every code or data file under
// the given directories, every repository file they import from outside them
// (transitively; kernel files, lib/io.mjs), and the package.json of each npm
// package they import. Imports built at run time are not followed.
export async function moduleClosure(repoRoot, roots) {
  const queue = [], files = new Set(), packages = new Set();
  for (const root of roots) {
    const full = join(repoRoot, root);
    const info = await lstat(full).catch(() => null);
    if (info?.isFile()) queue.push(root);
    else for (const path of await listFiles(full)) if (/\.(mjs|js|json)$/.test(path)) queue.push(relative(repoRoot, path));
  }
  while (queue.length) {
    const path = queue.shift();
    if (files.has(path)) continue;
    let text;
    try { text = await readFile(join(repoRoot, path), 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    files.add(path);
    if (!/\.m?js$/.test(path)) continue;
    for (const match of text.matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) {
        const target = relative(repoRoot, resolve(repoRoot, dirname(path), specifier));
        if (!target.startsWith('..')) queue.push(target);
      } else packages.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
    }
  }
  for (const name of packages) files.add(join('node_modules', name, 'package.json'));
  return [...files].sort();
}

async function sourceHash(repoRoot, roots) {
  const files = [];
  for (const path of await moduleClosure(repoRoot, roots)) {
    try { files.push({ path, sha256: sha256(await readFile(join(repoRoot, path))) }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { sha256: objectHash(files), files };
}

// Source whose change invalidates a frozen batch: the runner (it decides what
// runs and how it is classified) and the scorer (it decides every score).
// The generator's source is recorded for provenance only: its output, the
// tasks, truth records and objects, is frozen by hash.
export const SOURCES = {
  runner: ['v1/lib/runner', 'v1/scripts/run.mjs', 'v1/lib/contract.mjs', 'v1/lib/png.mjs', 'lib/io.mjs'],
  scorer: ['v1/lib/score'],
  generator: ['v1/lib/generator'],
};
const runnerHash = (repoRoot = REPO_ROOT) => sourceHash(repoRoot, SOURCES.runner);
export const scorerHash = (repoRoot = REPO_ROOT) => sourceHash(repoRoot, SOURCES.scorer);
const generatorHash = (repoRoot = REPO_ROOT) => sourceHash(repoRoot, SOURCES.generator);

// The private files of a task's object that the scorer reads (the truth model,
// the evidence index and any earlier state). Missing files are recorded as
// null, so "absent then and now" is no change.
async function objectFiles(dataRoot, truth) {
  const dir = layout(dataRoot).object(truth.object), files = {};
  const names = ['model.json', 'evidence/evidence.json', ...(truth.alternates ?? []).map(alternate => 'alternates/' + alternate.id + '/model.json')];
  for (const name of names) {
    try { files[name] = sha256(await readFile(join(dir, name))); } catch (error) { if (error.code !== 'ENOENT') throw error; files[name] = null; }
  }
  return files;
}

async function objectProblems(dataRoot, task) {
  if (!task.object_files) return [];
  const truth = { object: task.object, alternates: Object.keys(task.object_files).filter(name => name.startsWith('alternates/')).map(name => ({ id: name.split('/')[1] })) };
  const now = await objectFiles(dataRoot, truth), problems = [];
  for (const [name, sha] of Object.entries(task.object_files)) if (now[name] !== sha) problems.push('object ' + task.object + ' ' + name + ' changed (task ' + task.id + ')');
  return problems;
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

// tokenBudget, toolBudget, maxOutputTokens: API systems only (frozen into the
// harness record; see api/adapter.mjs). deps.env: where an API system looks up
// its key and base URL (default process.env); only whether the key is set is
// recorded.
export async function prepare({ id, system, model, effort, tasks, attempts = 1, dataRoot = DEFAULT_DATA_ROOT, binary, tokenBudget, toolBudget, maxOutputTokens,
  repoRoot = REPO_ROOT, deps = {}, log = () => {} }) {
  if (!ID.test(id ?? '')) throw new Error('Invalid batch id ' + id);
  if (!Array.isArray(tasks) || !tasks.length || new Set(tasks).size !== tasks.length || !tasks.every(task => ID.test(task))) throw new Error('Tasks must be a non-empty list of unique task ids');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) throw new Error('attempts must be an integer from 1 to 20');
  const adapter = adapterFor(system);
  if (!adapter.api && [tokenBudget, toolBudget, maxOutputTokens].some(value => value !== undefined)) {
    throw new Error('--token-budget, --tool-budget and --max-output-tokens apply to the API systems only');
  }
  dataRoot = resolve(dataRoot);
  const paths = layout(dataRoot);
  const harness = await (deps.inspect ?? adapter.inspect)({ binary: binary ?? adapter.defaultBinary(), model, effort,
    ...(adapter.api ? { budget: { tokens: tokenBudget, tool_calls: toolBudget }, maxOutputTokens, retry: deps.apiRetry, env: deps.env ?? process.env } : {}) });
  const node = await nodeRuntime(deps.nodePath);
  node.sha256 = await sha256File(node.path);
  const installTools = await loadInstallTools(deps);
  const taskRecords = [];
  for (const taskId of tasks) {
    const taskBytes = await readFile(join(paths.task(taskId), 'task.json'));
    const task = validateTask(JSON.parse(taskBytes.toString('utf8')));
    if (task.id !== taskId) throw new Error('Task ' + taskId + ' has id ' + task.id);
    let truthBytes;
    try { truthBytes = await readFile(join(paths.truth(taskId), 'truth.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; throw new Error('Task ' + taskId + ' has no truth record; it could not be scored'); }
    const truth = validateTruth(JSON.parse(truthBytes.toString('utf8')));
    // Which set, object and generator a task came from: results from different
    // sets or generator versions must never be pooled silently.
    let generatorVersion = null;
    try { generatorVersion = (await readJSON(join(paths.object(truth.object), 'model.json'))).generator?.version ?? null; } catch {}
    taskRecords.push({ task, taskBytes, truthSha: sha256(truthBytes), identity: { set: typeof truth.set === 'string' ? truth.set : null,
      object: truth.object, variant: truth.variant, generator_version: generatorVersion, object_files: await objectFiles(dataRoot, truth) } });
  }
  await mkdir(paths.runs, { recursive: true });
  const batchDir = join(paths.runs, id);
  try { await mkdir(batchDir); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A prepare killed before it could clean up leaves a directory without a
    // manifest; it was never a batch, but it is not deleted automatically.
    if (!await access(join(batchDir, 'manifest.json')).then(() => true, () => false)) {
      throw new Error('Batch ' + id + ' exists without a manifest (an interrupted prepare); delete ' + batchDir + ' and prepare again');
    }
    throw new Error('Batch ' + id + ' already exists; a frozen batch is never rewritten, use a new id');
  }
  log({ event: 'prepare', batch: batchDir, system, model: harness.model, effort: harness.effort });
  try { return await freezeBatch({ batchDir, id, system, attempts, dataRoot, paths, adapter, harness, node, installTools, taskRecords, repoRoot, log }); }
  catch (error) {
    // A half-built batch would block its id and could be mistaken for a real one.
    await rm(batchDir, { recursive: true, force: true });
    throw error;
  }
}

// The invocation record of one attempt as prepare freezes it (invocation.json,
// whose hash the manifest keeps), and the harness files it names (path ->
// content). The API systems' wall clock is only a safety cap (a multiple of
// the task's).
export function attemptInvocation({ adapter, harness, task, workspace, attemptDir, node }) {
  const spec = adapter.invocation({ harness, model: harness.model, effort: harness.effort, workspace, attemptDir, node, wallSeconds: task.budget.wall_seconds });
  const files = {}, hashes = {};
  for (const [path, content] of Object.entries(spec.files ?? {})) { files[path] = content; hashes[relative(attemptDir, path)] = objectHash(content); }
  const invocation = { command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env, stdin: 'prompt.txt', files: hashes,
    wall_seconds: adapter.wallSeconds ? adapter.wallSeconds(task) : task.budget.wall_seconds, workspace };
  return { invocation, files };
}

async function freezeBatch({ batchDir, id, system, attempts, dataRoot, paths, adapter, harness, node, installTools, taskRecords, repoRoot, log }) {
  const runtime = await buildRuntime({ repoRoot, runtimeDir: join(batchDir, 'runtime') });
  const toolsDir = join(batchDir, 'tools');
  const installed = await installTools(toolsDir);
  await makeReadOnly(toolsDir);
  const tools = { sha256: inventoryHash(await inventory(toolsDir)), files: installed?.files ?? null };
  // The scorer's own stamp, the one it writes into every report, so a report
  // can later be checked against the scorer this batch was frozen with.
  // scorer_source below hashes the same code by the runner's scheme and is
  // what the runner enforces; the two hashes are not comparable to each other.
  const scorerStamp = await import(pathToFileURL(join(repoRoot, 'v1', 'lib', 'score', 'version.mjs')).href).then(module => module.SCORER ?? null, () => null);
  const manifest = {
    schema: 'e3d-run-batch-v1', runner: RUNNER_VERSION, protocol: PROTOCOL, id, created_at: new Date().toISOString(),
    system, model: harness.model, effort: harness.effort, attempts, data_root: dataRoot,
    harness, node, runtime: { three_version: runtime.three_version, sha256: runtime.sha256, files: runtime.files }, tools,
    runner_source: await runnerHash(repoRoot), scorer_source: await scorerHash(repoRoot), generator_source: await generatorHash(repoRoot),
    scorer: scorerStamp,
    sets: [...new Set(taskRecords.map(record => record.identity.set))],
    prompt_version: PROMPT_VERSION, repository: await repositoryState(repoRoot),
    // retries: an attempt is never run again once it is a sample; one that the
    // harness could not run (an infrastructure error) is archived and re-run.
    rules: { evaluator_feedback_during_generation: false, retries: false, infra_reruns: true, human_intervention: false, api_keys: Boolean(adapter.usesApiKey) },
    tasks: [],
  };
  for (const { task, taskBytes, truthSha, identity } of taskRecords) {
    const prompt = buildPrompt({ system, task, threeVersion: runtime.three_version, budget: harness.budget ?? null });
    const record = { id: task.id, ...identity, task_sha256: objectHash(task), task_file_sha256: sha256(taskBytes), truth_sha256: truthSha,
      budget: task.budget, prompt_sha256: sha256(prompt), attempts: [] };
    for (let n = 1; n <= attempts; n++) {
      const dir = attemptDir(batchDir, task.id, n), workspace = join(dir, 'workspace');
      const built = await buildWorkspace({ workspace, taskDir: paths.task(task.id), toolsDir, runtimeDir: join(batchDir, 'runtime') });
      if (built.hashes.tools !== tools.sha256 || built.hashes.runtime !== runtime.sha256) throw new Error('Workspace copy differs from the batch runtime or tools');
      record.input_sha256 ??= built.hashes.input;
      if (built.hashes.input !== record.input_sha256) throw new Error('Workspace input differs between attempts of ' + task.id);
      await writeFile(join(dir, 'prompt.txt'), prompt, { flag: 'wx' });
      const { invocation, files } = attemptInvocation({ adapter, harness, task, workspace, attemptDir: dir, node });
      for (const [path, content] of Object.entries(files)) await writeHarnessFile(path, content);
      await mkdir(join(dir, 'harness', 'debug'), { recursive: true });
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

// What can change under a running batch without touching it: source code and
// binaries. Checked when a run starts and again before every launch, so an
// edited scorer or an auto-updated CLI stops the batch instead of silently
// mixing two versions in one result set. Nothing is cached: a check reads
// about 45 small source files and hashes the two binaries (measured 0.3-0.4 s
// for a 230 MB CLI), negligible next to a 30-minute attempt.
export async function liveProblems(manifest, { repoRoot = REPO_ROOT, checkRunner = true, checkScorer = true } = {}) {
  const problems = [];
  if (checkRunner && (await runnerHash(repoRoot)).sha256 !== manifest.runner_source.sha256) problems.push('runner source changed since the batch was frozen');
  if (checkScorer && manifest.scorer_source && (await scorerHash(repoRoot)).sha256 !== manifest.scorer_source.sha256) problems.push('scorer source changed since the batch was frozen');
  for (const [label, path, sha] of [['harness binary', manifest.harness.binary_realpath, manifest.harness.binary_sha256], ['node binary', manifest.node.path, manifest.node.sha256]]) {
    try { if (await sha256File(path) !== sha) problems.push(label + ' changed: ' + path); }
    catch { problems.push(label + ' is missing: ' + path); }
  }
  if (manifest.system === 'codex' && manifest.harness.codex_home) {
    const { loaded } = await codexGlobalInstructions(manifest.harness.codex_home);
    if (loaded.length) problems.push('global Codex instructions would be injected into every session: ' + loaded.join(', '));
  }
  // agy reads the operator's own settings file; the boundary depends on it.
  if (manifest.system === 'antigravity') problems.push(...await agyConfigProblems({ node: manifest.node }));
  return problems;
}

// Everything a batch froze, re-checked. Returns a list of problems.
export async function frozenProblems(batchDir, manifest, { repoRoot = REPO_ROOT, checkRunner = true, checkScorer = true } = {}) {
  const problems = await liveProblems(manifest, { repoRoot, checkRunner, checkScorer });
  if (!manifest.scorer_source) problems.push('the manifest has no scorer_source (prepared by an older runner); prepare a new batch');
  if (inventoryHash(await inventory(join(batchDir, 'runtime', 'node_modules'))) !== manifest.runtime.sha256) problems.push('runtime changed');
  if (inventoryHash(await inventory(join(batchDir, 'tools'))) !== manifest.tools.sha256) problems.push('preview tools changed');
  for (const task of manifest.tasks) {
    const paths = layout(manifest.data_root), taskPath = join(paths.task(task.id), 'task.json');
    try { if (sha256(await readFile(taskPath)) !== task.task_file_sha256) problems.push('task ' + task.id + ' changed'); }
    catch { problems.push('task ' + task.id + ' is missing'); }
    try { if (sha256(await readFile(join(paths.truth(task.id), 'truth.json'))) !== task.truth_sha256) problems.push('truth record of ' + task.id + ' changed'); }
    catch { problems.push('truth record of ' + task.id + ' is missing'); }
    problems.push(...await objectProblems(manifest.data_root, task));
    for (const attempt of task.attempts) {
      const dir = join(batchDir, attempt.dir);
      try {
        const invocation = await readJSON(join(dir, 'invocation.json'));
        if (objectHash(invocation) !== attempt.invocation_sha256) problems.push(attempt.dir + ': invocation changed');
        if (sha256(await readFile(join(dir, 'prompt.txt'))) !== task.prompt_sha256) problems.push(attempt.dir + ': prompt changed');
        for (const [file, hash] of Object.entries(invocation.files ?? {})) {
          if (objectHash(await readHarnessFile(join(dir, file))) !== hash) problems.push(attempt.dir + ': ' + file + ' changed');
        }
      } catch (error) { problems.push(attempt.dir + ': ' + error.message); }
    }
  }
  return problems;
}

// ---------------------------------------------------------------- stopping

// How a runner (run or preflight) is stopped cleanly: an external AbortSignal
// or, with handleSignals, SIGINT/SIGTERM/SIGHUP abort `signal`, and the
// runner winds down; a second signal calls `hard` (kill what is running, no
// grace period) and exits with 130.
function interruption({ signal, handleSignals = false, onAbort = () => {}, hard = () => {} }) {
  const controller = new AbortController(), handlers = {};
  const abort = reason => { if (!controller.signal.aborted) { onAbort(reason); controller.abort(reason); } };
  const onExternal = () => abort(String(signal.reason ?? 'abort'));
  if (signal?.aborted) onExternal(); else signal?.addEventListener('abort', onExternal, { once: true });
  if (handleSignals) {
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      handlers[name] = () => {
        if (!controller.signal.aborted) { abort(name); return; }
        hard();
        process.exit(130);
      };
      process.on(name, handlers[name]);
    }
  }
  return {
    signal: controller.signal, abort,
    dispose() { signal?.removeEventListener('abort', onExternal); for (const [name, handler] of Object.entries(handlers)) process.off(name, handler); },
  };
}

// What the batch's runner is doing, for `status` (see runnerState).
async function writeState(batchDir, fields) {
  await writeJSON(join(batchDir, 'runner-state.json'), { schema: 'e3d-runner-state-v1', pid: process.pid, updated_at: new Date().toISOString(),
    hold: null, stop: null, ...fields });
}

// ---------------------------------------------------------------- preflight

// A probe session that meets a usage limit or an outage is an infrastructure
// problem, not a boundary verdict: preflight waits it out the way `run` does
// (or, with wait: false, stops and says until when) and probes again in a
// fresh site; a login, billing or model problem stops it at once. The report
// then carries `infra` and does not pass, and nothing it could not show is
// counted as a failed check. Preflight holds the batch lock like `run` (the
// two never overlap) and keeps runner-state.json current, so `status` shows a
// preflight that is waiting on a limit, and until when. Stopped by `signal`
// (or, with handleSignals, a signal), it kills its probe session, writes no
// report (an earlier preflight.json stays as it was) and throws
// E3D_INTERRUPTED.
export async function preflight({ batchDir, probeModel, probeEffort, repoRoot = REPO_ROOT, scratchDir, skipAgent = false, wait = true, signal, handleSignals = false,
  deps = {}, log = () => {} }) {
  batchDir = resolve(batchDir);
  const manifest = await readJSON(join(batchDir, 'manifest.json'));
  const release = await acquireLock(batchDir);
  const pids = new Set();
  const stopper = interruption({ signal, handleSignals, onAbort: reason => log({ event: 'interrupt', reason, phase: 'preflight' }),
    hard: () => { for (const pid of pids) killTree(pid, 'SIGKILL'); } });
  const state = (phase, extra = {}) => writeState(batchDir, { phase, wait, ...extra }).catch(() => {});
  try {
    await state('preflight');
    const problems = await frozenProblems(batchDir, manifest, { repoRoot });
    const adapter = deps.adapter ?? adapterFor(manifest.system);
    const effort = probeEffort ?? manifest.harness.effort_levels?.[0] ?? manifest.effort;
    let result;
    if (problems.length) result = { checks: problems.map(reason => ({ id: 'freeze', status: 'fail', reason })), sessions: {}, passed: false, failed: ['freeze'], not_evaluated: [] };
    else {
      // The API systems prove their boundary without a model (api/preflight.mjs).
      result = await (adapter.preflight ?? runPreflight)({ batchDir, manifest, adapter, harness: manifest.harness, node: manifest.node, repoRoot, deps,
        dataRoot: manifest.data_root, probeModel: probeModel ?? manifest.model, probeEffort: effort, scratchDir, skipAgent, internet: deps.internet, log,
        signal: stopper.signal, pids,
        infra: { wait, schedule: deps.schedule ?? SCHEDULE, seed: manifest.id + '/preflight', maxTries: deps.preflightInfraTries ?? 6,
          onHold: hold => state('preflight_waiting', { hold }), onResume: () => state('preflight') } });
    }
    if (result.interrupted || stopper.signal.aborted) {
      await state('interrupted');
      const error = new Error('Preflight interrupted (' + stopper.signal.reason + '); no verdict was written. Run preflight again.');
      error.code = 'E3D_INTERRUPTED';
      throw error;
    }
    const report = {
      schema: 'e3d-preflight-v1', created_at: new Date().toISOString(), batch: manifest.id, system: manifest.system,
      manifest_sha256: manifestHash(manifest), passed: result.passed, failed: result.failed, not_evaluated: result.not_evaluated,
      infra: result.infra ?? null, probe_session: result.sessions, directory: result.directory ? relative(batchDir, result.directory) : null, checks: result.checks,
    };
    await writeJSON(join(batchDir, 'preflight.json'), report);
    if (result.directory) await writeJSON(join(result.directory, 'report.json'), report);
    const infra = report.infra;
    if (report.passed) await state('preflight_passed');
    else if (!infra) await state('preflight_failed');
    else if (infra.action === 'stop') {
      await state('stopped', { stop: { reason: infra.reason, message: infra.message, attempt: 'preflight/' + infra.session, advice: stopAdvice(infra.reason, manifest) ?? 'see the preflight report', at: new Date().toISOString() } });
    } else await state(infra.gave_up === 'no-wait' ? 'would_wait' : 'preflight_gave_up', { hold: infra.hold ?? null, gave_up: infra.gave_up });
    return report;
  } finally {
    stopper.dispose();
    await release();
  }
}

// ---------------------------------------------------------------- execute

function resultRecord(manifest, task, attempt, fields) {
  return {
    task_id: task.id, attempt: attempt.n, system: manifest.system, model: manifest.model, effort: manifest.effort,
    status: fields.status, wall_seconds: fields.wall_seconds ?? null, usage: fields.usage ?? null, cost_usd: fields.cost_usd ?? null,
    turns: fields.turns ?? null, commands: fields.commands ?? null,
    // An infrastructure error is not a sample: its score is null, not 0.
    score: 'score' in fields ? fields.score : 0, report: fields.report ?? null,
    ...fields.extra,
  };
}

// The 1-minute load average, sampled through an attempt: with several
// attempts on one machine their wall times are not independent, and this is
// the record of how busy the machine was.
const LOAD_SAMPLE_MS = 30000;
function sampleLoad() {
  const samples = [loadavg()[0]];
  const timer = setInterval(() => samples.push(loadavg()[0]), LOAD_SAMPLE_MS);
  timer.unref();
  const round = value => Math.round(value * 100) / 100;
  return () => {
    clearInterval(timer);
    samples.push(loadavg()[0]);
    return { start: round(samples[0]), end: round(samples.at(-1)), mean: round(samples.reduce((a, b) => a + b, 0) / samples.length),
      max: round(Math.max(...samples)), samples: samples.length, cpus: cpus().length };
  };
}

// A process recorded by an earlier runner, if it is still that process (the
// start time guards against pid reuse; older records fall back to the command).
function leftover(record, command) {
  if (!record?.pid) return false;
  if (record.started) return startTimeOf(record.pid) === record.started;
  return (commandOf(record.pid) ?? '').includes(command);
}

async function scoreArtifact({ manifest, task, dir, artifact, deps, control, repoRoot }) {
  // The scorer and what it reads must be what the batch froze; if not, this
  // attempt is left unscored (it is scored by a later run once they are back)
  // and the batch stops.
  const paths = layout(manifest.data_root), drift = [];
  try { if (sha256(await readFile(join(paths.truth(task.id), 'truth.json'))) !== task.truth_sha256) drift.push('truth record of ' + task.id + ' changed since the batch was frozen'); }
  catch { drift.push('truth record of ' + task.id + ' is missing'); }
  drift.push(...await objectProblems(manifest.data_root, task));
  if (manifest.scorer_source && !deps.skipScorerCheck && (await scorerHash(repoRoot)).sha256 !== manifest.scorer_source.sha256) drift.push('scorer source changed since the batch was frozen');
  if (drift.length) return { frozen: drift };
  const scoreDir = join(dir, 'score');
  // A scorer interrupted by a dying runner may have left a worker and partial
  // files behind: the worker is stopped and the directory kept aside, so the
  // new scoring starts clean and the old one stays readable.
  try {
    const worker = await readJSON(join(scoreDir, 'worker.json'));
    if (leftover(worker, 'score-worker.mjs')) killTree(worker.pid, 'SIGKILL');
  } catch {}
  if (await exists(scoreDir)) {
    let n = 1;
    while (await exists(scoreDir + '.interrupted-' + n)) n++;
    await rename(scoreDir, scoreDir + '.interrupted-' + n);
  }
  await mkdir(scoreDir, { recursive: true });
  const submission = join(scoreDir, 'submission.glb');
  await writeFile(submission, artifact.data);
  const job = join(scoreDir, 'job.json');
  await writeJSON(job, { module: scorerModulePath(deps), glb: submission, taskDir: paths.task(task.id), truthDir: paths.truth(task.id),
    dataRoot: manifest.data_root, outDir: scoreDir });
  const run = await captureProcess(process.execPath, [join(HERE, 'score-worker.mjs'), job], { cwd: scoreDir, seconds: deps.scoreSeconds ?? 1800,
    env: childEnvironment(), stdoutPath: join(scoreDir, 'worker.stdout.log'), stderrPath: join(scoreDir, 'worker.stderr.log'), signal: control.signal,
    onSpawn: pid => { control.pids.set(scoreDir, pid); writeJSONSync(join(scoreDir, 'worker.json'), { pid, started: startTimeOf(pid) }); } });
  control.pids.delete(scoreDir);
  if (run.aborted) return { aborted: true };
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

const exists = path => access(path).then(() => true, () => false);

// ---------------------------------------------------------------- re-runs

// Earlier tries of an attempt kept beside it as a<n>.infra-<k>/ (never deleted).
const ARCHIVED_TRY = /^a(\d+)\.infra-(\d+)$/;

async function archivedTries(batchDir, attempt) {
  const dir = join(batchDir, attempt.dir), parent = dirname(dir), own = basename(dir), tries = [];
  for (const name of await readdir(parent).catch(() => [])) {
    const match = ARCHIVED_TRY.exec(name);
    if (!match || 'a' + match[1] !== own) continue;
    tries.push({ name, k: Number(match[2]), result: await readJSON(join(parent, name, 'result.json')).catch(() => null) });
  }
  return tries.sort((a, b) => a.k - b.k);
}

// Whether an infra_error attempt may be run again: only the re-runs caused by
// the session's own failures count against the cap (see RERUN_COUNTED).
async function rerunBudget(batchDir, attempt, result, maxReruns) {
  const tries = await archivedTries(batchDir, attempt);
  const counted = tries.filter(item => RERUN_COUNTED.includes(item.result?.infra?.reason)).length + (RERUN_COUNTED.includes(result?.infra?.reason) ? 1 : 0);
  return { tries, counted, allowed: counted <= maxReruns };
}

const tryRecord = (result, archived) => ({
  dir: archived, status: result.status, reason: result.infra?.reason ?? null, action: result.infra?.action ?? null, during: result.infra?.during ?? null,
  retry_after: result.infra?.retry_after ?? null, model_turns: result.infra?.model_turns ?? result.model_turns ?? null,
  attempt_started_at: result.attempt_started_at ?? null, finished_at: result.finished_at ?? null, result_at: result.result_at ?? null,
  wall_seconds: result.wall_seconds ?? null, message: (result.infra?.message ?? '').slice(0, 300) || null,
});

const freshDir = dir => dir + '.fresh';

// Turns an attempt that ended in an infrastructure error back into a pristine,
// never-run attempt, keeping the failed try as a<n>.infra-<k>/. The new
// directory is built beside the old one (the frozen prompt, invocation and
// harness files copied, the workspace rebuilt by the same code as at prepare
// and checked against the frozen hashes) and only then swapped in, so a
// runner killed at any point leaves either the old attempt or the new one,
// never neither (recoverReruns finishes a swap that was cut short).
export async function resetAttempt({ batchDir, manifest, task, attempt, previous }) {
  const dir = join(batchDir, attempt.dir), fresh = freshDir(dir), paths = layout(manifest.data_root);
  await rm(fresh, { recursive: true, force: true });
  const invocation = await readJSON(join(dir, 'invocation.json'));
  const tries = await archivedTries(batchDir, attempt);
  const k = (tries.at(-1)?.k ?? 0) + 1, archived = basename(dir) + '.infra-' + k;
  for (const file of ['prompt.txt', 'invocation.json', ...Object.keys(invocation.files ?? {})]) {
    await mkdir(dirname(join(fresh, file)), { recursive: true });
    await copyFile(join(dir, file), join(fresh, file));
  }
  await mkdir(join(fresh, 'harness', 'debug'), { recursive: true });
  const built = await buildWorkspace({ workspace: join(fresh, 'workspace'), taskDir: paths.task(task.id), toolsDir: join(batchDir, 'tools'),
    runtimeDir: join(batchDir, 'runtime') });
  if (built.hashes.input !== task.input_sha256 || built.hashes.tools !== manifest.tools.sha256 || built.hashes.runtime !== manifest.runtime.sha256) {
    throw new Error(attempt.dir + ': a rebuilt workspace differs from the frozen one');
  }
  const history = [...(previous.tries ?? []), tryRecord(previous, archived)];
  // Written last: its presence marks the new directory as complete.
  await writeJSON(join(fresh, 'rerun.json'), { try: history.length + 1, tries: history, archived, at: new Date().toISOString() }, { exclusive: true });
  await rename(dir, join(dirname(dir), archived));
  await rename(fresh, dir);
  return { archived, try: history.length + 1 };
}

// Finishes or discards a swap interrupted by a killed runner.
export async function recoverReruns(batchDir, manifest, log) {
  for (const task of manifest.tasks) for (const attempt of task.attempts) {
    const dir = join(batchDir, attempt.dir), fresh = freshDir(dir);
    if (!await exists(fresh)) continue;
    if (await exists(dir)) { await rm(fresh, { recursive: true, force: true }); continue; }
    if (!await exists(join(fresh, 'rerun.json'))) throw new Error(attempt.dir + ' is missing and ' + fresh + ' is incomplete; restore ' + attempt.dir + ' from its newest .infra-<k> copy');
    await rename(fresh, dir);
    log({ event: 'rerun_recovered', task_id: task.id, attempt: attempt.n });
  }
}

// ---------------------------------------------------------------- one attempt

async function runAttempt({ batchDir, manifest, task, attempt, adapter, deps, log, control, rerun, repoRoot, retryStallSeconds, mayLaunch = null }) {
  const dir = join(batchDir, attempt.dir), resultPath = join(dir, 'result.json');
  let previous = null;
  try { previous = await readJSON(resultPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && !(rerun && previous.status === 'infra_error')) return { result: previous, skipped: true };
  if (previous) {
    if (control.signal.aborted) return { result: null, skipped: false, interrupted: true };
    const reset = await resetAttempt({ batchDir, manifest, task, attempt, previous });
    log({ event: 'rerun', task_id: task.id, attempt: attempt.n, try: reset.try, archived: reset.archived, previous_reason: previous.infra?.reason ?? null });
  }
  const workspace = join(dir, 'workspace'), invocation = await readJSON(join(dir, 'invocation.json'));
  const rerunRecord = await readJSON(join(dir, 'rerun.json')).catch(() => null);
  const history = rerunRecord ? { try: rerunRecord.try, tries: rerunRecord.tries } : { try: 1, tries: [] };
  const attemptStarted = new Date().toISOString();
  const finish = async fields => {
    const result = resultRecord(manifest, task, attempt, { ...fields, extra: { ...fields.extra, ...history } });
    result.result_at = new Date().toISOString();
    await writeJSON(resultPath, result, { exclusive: true });
    return { result, skipped: false };
  };
  const started = await exists(join(dir, 'started.json'));
  let run = null, summary = null, events = [], integrityProblems = [], recovered = null, load = null, retryLost = null;
  if (started) {
    // The runner stopped during this attempt and is now restarted.
    try { recovered = await readJSON(join(dir, 'process.json')); } catch {}
  }
  if (started && !recovered) {
    // The generation was never supervised to its end, so whatever it left is
    // not a fair sample: it is an infrastructure error, not scored, and not
    // counted against the model. A CLI tree that outlived the runner is
    // stopped first.
    const evidence = [];
    try {
      const startedRecord = await readJSON(join(dir, 'started.json'));
      evidence.push('started at ' + (startedRecord.at ?? '?') + ' by runner pid ' + (startedRecord.pid ?? '?') + '; generation never recorded an end');
    } catch { evidence.push('started.json present, no process.json'); }
    try {
      const child = await readJSON(join(dir, 'child.json'));
      if (leftover(child, invocation.command)) { killTree(child.pid, 'SIGKILL'); evidence.push('a leftover harness process tree (pid ' + child.pid + ') was killed'); }
    } catch {}
    const infra = { reason: 'runner_interrupted', action: INFRA_REASONS.runner_interrupted, during: 'unknown', model_turns: null,
      message: 'the runner stopped while this attempt was generating', evidence, retry_after: null, retry_after_source: null, retry_after_text: null };
    const outcome = await finish({ status: 'infra_error', score: null, extra: { attempt_started_at: attemptStarted, wall_limit_seconds: invocation.wall_seconds, infra, integrity_problems: [] } });
    log({ event: 'finished', task_id: task.id, attempt: attempt.n, status: 'infra_error', reason: infra.reason, score: null });
    return outcome;
  }
  if (recovered) {
    // Generation had finished (process.json is written right after the CLI
    // exits); only scoring was cut short. Rebuild the record from the logs.
    run = { ...recovered, stderr: await readFile(join(dir, 'stderr.log'), 'utf8').catch(() => '') };
    events = readJSONLines(await readFile(join(dir, 'events.jsonl'), 'utf8').catch(() => ''));
    summary = adapter.parse(events);
    retryLost = recovered.service_retry_seconds ?? null;
    integrityProblems.push(...await workspaceProblems(workspace, task, manifest), ...toolSurfaceProblems(manifest.system, summary));
  } else {
    if (control.signal.aborted) return { result: null, skipped: false, interrupted: true };
    if (objectHash(invocation) !== attempt.invocation_sha256) throw new Error(attempt.dir + ': invocation changed after freeze');
    const prompt = await readFile(join(dir, 'prompt.txt'), 'utf8');
    if (sha256(prompt) !== task.prompt_sha256) throw new Error(attempt.dir + ': prompt changed after freeze');
    const hashes = await workspaceHashes(workspace);
    if (hashes.input !== task.input_sha256 || hashes.tools !== manifest.tools.sha256 || hashes.runtime !== manifest.runtime.sha256) throw new Error(attempt.dir + ': workspace changed after freeze');
    if ((await readdir(join(workspace, 'output'))).length) throw new Error(attempt.dir + ': output/ must start empty');
    // A harness that needs something set up from its frozen files right
    // before launch gets it now (grok: an empty HOME, its shell wrapper made
    // executable; harness files are copied for a re-run without their modes).
    if (adapter.stage) await adapter.stage({ attemptDir: dir, workspace, invocation });
    // The checks above take a moment (a workspace is hashed); a hold that
    // began meanwhile (another attempt met a limit) means this one must not
    // launch into it. Nothing has been recorded yet, so it simply goes back.
    if (mayLaunch && !mayLaunch()) return { result: null, skipped: false, deferred: true };
    // The host-sleep rule compares the machine's sleep counter at launch with
    // the one at the end (hostsleep.mjs). Read before the launch is decided:
    // the hold check below must stay in the same tick as the launch.
    const sleepCount = await hostSource(deps).sleepCount().catch(() => null);
    if (mayLaunch && !mayLaunch()) return { result: null, skipped: false, deferred: true };
    // In the same tick as that check: from here on the attempt is launched.
    control.running.add(attempt.dir);
    log({ event: 'started', task_id: task.id, attempt: attempt.n, try: history.try, wall_seconds: invocation.wall_seconds, running: control.running.size });
    try {
      await writeJSON(join(dir, 'started.json'), { at: new Date().toISOString(), pid: process.pid, runner_started: startTimeOf(process.pid),
        load_1m: loadavg()[0], running: control.running.size, try: history.try, sleep_count: sleepCount }, { exclusive: true });
    } catch (error) { control.running.delete(attempt.dir); throw error; }
    const stopLoad = sampleLoad();
    // The retry watchdog stops a CLI that keeps retrying an unreachable
    // service, through an abort of its own (the batch's abort means the
    // operator stopped the runner, which is recorded differently).
    const stallMs = Math.round(retryStallSeconds * 1000), watch = retryWatch(manifest.system, { stallMs });
    const own = new AbortController();
    let spawnClock = null, dog = null;
    const tick = setInterval(() => {
      if (dog || spawnClock === null) return;
      const found = watch.check(performance.now() - spawnClock);
      if (found) { dog = { ...found, stall_ms: stallMs }; log({ event: 'watchdog', task_id: task.id, attempt: attempt.n, reason: found.reason, kind: found.kind }); own.abort('watchdog'); }
    }, Math.max(100, Math.min(15000, Math.round(stallMs / 4))));
    tick.unref();
    try {
      // An API system's loop also gets its key on stdin, read from the
      // environment now; it is never written anywhere.
      run = await captureProcess(invocation.command, invocation.args, {
        cwd: invocation.cwd, env: invocation.env, stdin: adapter.stdin ? adapter.stdin(prompt, deps.env ?? process.env) : prompt, seconds: invocation.wall_seconds, graceSeconds: deps.graceSeconds ?? 5,
        stdoutPath: join(dir, 'events.jsonl'), stderrPath: join(dir, 'stderr.log'), signal: AbortSignal.any([control.signal, own.signal]),
        onEvent: (event, ms) => { events.push(event); watch.onEvent(event, ms); },
        onSpawn: pid => { spawnClock = performance.now(); control.pids.set(attempt.dir, pid); writeJSONSync(join(dir, 'child.json'), { pid, command: invocation.command, started: startTimeOf(pid) }); },
      });
    } finally { clearInterval(tick); control.running.delete(attempt.dir); control.pids.delete(attempt.dir); load = stopLoad(); }
    if (dog && !control.signal.aborted) { run.watchdog = dog; run.aborted = false; }
    retryLost = Math.round(watch.lostMs() / 100) / 10;
    summary = adapter.parse(events);
    integrityProblems.push(...await workspaceProblems(workspace, task, manifest), ...toolSurfaceProblems(manifest.system, summary));
    await writeJSON(join(dir, 'process.json'), { ...run, stdout: undefined, stderr: undefined, load_1m: load, service_retry_seconds: retryLost });
  }
  const artifact = await readArtifact(workspace, 'output/model.glb', { maxBytes: task.budget.max_artifact_bytes });
  const common = {
    wall_seconds: run.wall_seconds ?? null, usage: summary?.usage ?? null, cost_usd: summary?.cost_usd ?? null,
    turns: summary?.turns ?? null, commands: summary?.commands ?? null,
  };
  const diagnostics = {
    attempt_started_at: attemptStarted, started_at: run.started_at ?? null, finished_at: run.finished_at ?? null, load_1m: load ?? run.load_1m ?? null,
    exit_code: run.exit_code ?? null, signal: run.signal ?? null, timed_out: run.timed_out ?? false, launch_error: run.launch_error ?? null,
    log_error: run.log_error ?? null, wall_limit_seconds: invocation.wall_seconds, model_reported: summary?.model_reported ?? null, model_turns: modelTurns(manifest.system, events),
    // Seconds the CLI spent retrying the service before the model carried on.
    service_retry_seconds: retryLost, watchdog: run.watchdog ?? null,
    usage_detail: summary?.usage_detail ?? null, tools: summary?.tools ?? null, errors: (summary?.errors ?? []).slice(0, 10),
    integrity_problems: integrityProblems,
    artifact: artifact.present ? { bytes: artifact.bytes ?? null, sha256: artifact.sha256 ?? null, problem: artifact.problem } : null,
    notes_present: await lstat(join(workspace, 'output', 'notes.md')).then(info => info.isFile(), () => false),
  };
  if (run.aborted) {
    // The operator stopped the runner while the CLI was working; the CLI tree
    // has been killed. Like any unsupervised end, this is not a sample.
    const infra = { reason: 'runner_interrupted', action: INFRA_REASONS.runner_interrupted, during: 'session', model_turns: diagnostics.model_turns,
      message: 'the runner was stopped (' + (control.signal.reason ?? 'abort') + ') while this attempt was generating', evidence: ['CLI tree killed by the runner on ' + (control.signal.reason ?? 'abort')],
      retry_after: null, retry_after_source: null, retry_after_text: null };
    const outcome = await finish({ status: 'infra_error', score: null, ...common, extra: { ...diagnostics, infra } });
    log({ event: 'finished', task_id: task.id, attempt: attempt.n, status: 'infra_error', reason: infra.reason, score: null });
    return outcome;
  }
  // The host-sleep rule, applied to every CLI process that ended (whatever
  // its status, never looking at the score or the artifact): a machine that
  // slept during the attempt, or a run longer than its wall clock allows,
  // makes it an infrastructure error. It overrides a retry-class finding (the
  // network errors a wake produces are its symptom) and no finding at all;
  // a limit or a stop found by the classifier is kept, because it asks for a
  // hold or a human, with the sleep recorded beside it.
  const startedRecord = await readJSON(join(dir, 'started.json')).catch(() => null);
  diagnostics.host_sleep_check = await hostSleepCheck({ startedAt: run.started_at, finishedAt: run.finished_at,
    sleepCountAtStart: startedRecord?.sleep_count ?? null, source: hostSource(deps) });
  const suspended = hostSuspension({ run, wallLimitSeconds: invocation.wall_seconds, check: diagnostics.host_sleep_check, modelTurns: diagnostics.model_turns });
  const classified = detectInfra({ system: manifest.system, events, eventMs: run.event_ms ?? null, run, summary,
    wallLimitSeconds: invocation.wall_seconds, now: Date.parse(run.finished_at ?? '') || Date.now() });
  let infraFound = classified;
  if (suspended && (!classified || INFRA_REASONS[classified.reason] === 'retry')) {
    infraFound = classified ? { ...suspended, evidence: [...suspended.evidence, 'the classifier also found ' + classified.reason + ': ' + String(classified.message ?? '').slice(0, 300)] } : suspended;
  } else if (suspended) infraFound = { ...classified, host_suspended: suspended.host, evidence: [...(classified.evidence ?? []), suspended.message] };
  // A broken boundary is never excused: the infrastructure finding is kept
  // for diagnosis, but the attempt stays a failure.
  const infra = integrityProblems.length ? null : infraFound;
  let report = null, reportPath = null, scoreError = null;
  if (!infra) {
    if (artifact.present && artifact.problem) {
      report = refusalReport(task, manifest, artifact.problem);
      reportPath = join(dir, 'score', 'report.json');
      await writeJSON(reportPath, report);
    } else if (artifact.present) {
      log({ event: 'scoring', task_id: task.id, attempt: attempt.n, recovered: Boolean(recovered) });
      const scored = await scoreArtifact({ manifest, task, dir, artifact, deps, control, repoRoot });
      // Scoring cut short by the operator, or refused because the scorer or
      // the truth changed: process.json is on disk, so a later run scores
      // this attempt; nothing is recorded now.
      if (scored.aborted) return { result: null, skipped: false, interrupted: true };
      if (scored.frozen) return { result: null, skipped: false, interrupted: true, frozen: scored.frozen };
      if (scored.error) scoreError = scored.error; else { report = scored.report; reportPath = scored.path; }
    }
  }
  const status = classifyStatus({ run, summary, integrityProblems, infra, artifact, report, scoreError });
  // A broken boundary, or a run the runner could not supervise to the end,
  // voids the attempt whatever it produced; the report is kept for diagnosis.
  const score = infra ? null : integrityProblems.length ? 0 : scoreOf(report);
  const outcome = await finish({
    status, ...common, score, report: reportPath ? relative(batchDir, reportPath) : null,
    extra: { ...diagnostics, infra, infra_ignored: infraFound && !infra ? infraFound : undefined,
      report_valid: report ? report.valid !== false : null, score_error: scoreError },
  });
  log({ event: 'finished', task_id: task.id, attempt: attempt.n, status, reason: infra?.reason, score: outcome.result.score, wall_seconds: outcome.result.wall_seconds });
  return outcome;
}

// ---------------------------------------------------------------- batch state

const mean = rows => {
  const scores = rows.map(row => row.score).filter(Number.isFinite);
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
};

// What the runner of a batch is doing, as it last wrote it, and whether that
// runner is still alive (a state written by a dead runner is history).
export async function runnerState(batchDir) {
  const saved = await readJSON(join(batchDir, 'runner-state.json')).catch(() => null);
  const lock = await readJSON(join(batchDir, 'run.lock')).catch(() => null);
  const alive = Boolean(lock?.pid && lock.started && startTimeOf(lock.pid) === lock.started);
  return { alive, pid: alive ? lock.pid : null, since: alive ? lock.at : null, ...(saved ?? { phase: null }) };
}

export async function summarize(batchDir, { write = true } = {}) {
  batchDir = resolve(batchDir);
  const manifest = await readJSON(join(batchDir, 'manifest.json')), attempts = [];
  const state = await runnerState(batchDir);
  const maxReruns = state.max_reruns ?? DEFAULT_MAX_RERUNS;
  let reruns = 0;
  const tasks = [];
  for (const task of manifest.tasks) {
    const rows = [];
    let taskReruns = 0;
    for (const attempt of task.attempts) {
      const tries = await archivedTries(batchDir, attempt);
      taskReruns += tries.length;
      let row;
      try { row = await readJSON(join(batchDir, attempt.dir, 'result.json')); }
      catch { row = { task_id: task.id, attempt: attempt.n, status: 'pending', started: await exists(join(batchDir, attempt.dir, 'started.json')) }; }
      row.tries_archived = tries.length;
      if (row.status === 'infra_error') {
        const counted = tries.filter(item => RERUN_COUNTED.includes(item.result?.infra?.reason)).length + (RERUN_COUNTED.includes(row.infra?.reason) ? 1 : 0);
        row.rerun_capped = counted > maxReruns;
      }
      rows.push(row);
    }
    reruns += taskReruns;
    const samples = rows.filter(row => row.status !== 'pending' && !NOT_SAMPLES.includes(row.status));
    tasks.push({ id: task.id, set: task.set ?? null, attempts: rows.length, samples: samples.length, pending: rows.filter(row => row.status === 'pending').length,
      infra_error: rows.filter(row => row.status === 'infra_error').length, score_error: rows.filter(row => row.status === 'score_error').length,
      infra_reruns: taskReruns, mean_score: mean(samples), mean_score_completed: mean(rows.filter(row => row.status === 'completed')) });
    attempts.push(...rows);
  }
  const counts = Object.fromEntries([...STATUSES, 'pending'].map(status => [status, attempts.filter(item => item.status === status).length]));
  const done = attempts.filter(item => item.status !== 'pending');
  const samples = done.filter(item => !NOT_SAMPLES.includes(item.status));
  const total = key => done.reduce((sum, item) => sum + (item.usage?.[key] ?? 0), 0);
  const costs = done.map(item => item.cost_usd).filter(Number.isFinite);
  const infraRows = done.filter(item => item.status === 'infra_error');
  const byReason = {};
  for (const item of infraRows) { const reason = item.infra?.reason ?? 'unknown'; byReason[reason] = (byReason[reason] ?? 0) + 1; }
  const summary = {
    schema: 'e3d-run-summary-v1', batch: manifest.id, system: manifest.system, model: manifest.model, effort: manifest.effort,
    sets: manifest.sets ?? null, updated_at: new Date().toISOString(),
    // Complete means every attempt has a sample: an infrastructure error is
    // still owed a run, a score error a re-score.
    complete: counts.pending === 0 && counts.infra_error === 0 && counts.score_error === 0, counts,
    attempts_total: attempts.length, samples: samples.length, pending: counts.pending,
    // Pending attempts that a runner started; with no runner alive they are
    // interrupted and become infrastructure errors on the next run.
    started_unfinished: attempts.filter(item => item.status === 'pending' && item.started).length,
    infra: { errors: infraRows.length, by_reason: byReason, reruns, max_reruns: maxReruns,
      // infra_error attempts a run will not try again (the cap was reached); every other one is owed a run.
      capped: infraRows.filter(item => item.rerun_capped).map(item => item.task_id + '/a' + item.attempt),
      retry_after: infraRows.map(item => item.infra?.retry_after).filter(Boolean).sort().at(-1) ?? null },
    // The runner: alive or not, and what it is doing (running, waiting on a
    // limit and until when, stopped and why).
    runner: state,
    // Over samples only (every status but pending, infra_error and
    // score_error), failures counting 0 as in the report; and over the
    // attempts that completed normally.
    mean_score: mean(samples), mean_score_completed: mean(done.filter(item => item.status === 'completed')),
    tasks,
    usage: done.some(item => item.usage) ? { input_tokens: total('input_tokens'), cached_input_tokens: total('cached_input_tokens'), output_tokens: total('output_tokens') } : null,
    cost_usd: costs.length ? costs.reduce((a, b) => a + b, 0) : null, cost_complete: costs.length === done.length,
    attempts: attempts.map(item => ({ task_id: item.task_id, attempt: item.attempt, status: item.status, score: item.score ?? null,
      reason: item.infra?.reason ?? null, try: item.try ?? (item.status === 'pending' ? item.tries_archived + 1 : null), tries_archived: item.tries_archived,
      rerun_capped: item.rerun_capped ?? false, retry_after: item.infra?.retry_after ?? null, wall_seconds: item.wall_seconds ?? null, cost_usd: item.cost_usd ?? null,
      started_at: item.started_at ?? null, finished_at: item.finished_at ?? null, load_1m_mean: item.load_1m?.mean ?? null })),
  };
  if (write) await writeJSON(join(batchDir, 'summary.json'), summary);
  return summary;
}

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// One line per finished attempt, appended to <batch>/progress.log, so an
// unattended run can be followed with `tail -f` and read back afterwards.
export function progressLine(result, summary) {
  const done = summary.attempts_total - summary.pending;
  const what = result.status === 'infra_error'
    ? 'infra_error ' + (result.infra?.reason ?? '?') + (result.infra?.retry_after ? ' until ' + result.infra.retry_after : '')
    : result.status + ' ' + (Number.isFinite(result.score) ? result.score.toFixed(1) : '-');
  const wall = Number.isFinite(result.wall_seconds) ? Math.round(result.wall_seconds) + ' s' : '- s';
  const load = result.load_1m ? 'load ' + result.load_1m.mean.toFixed(1) : 'load -';
  return [stamp(), done + '/' + summary.attempts_total, result.task_id + '/a' + result.attempt + (result.try > 1 ? ' try ' + result.try : ''), what,
    wall, load, '| samples ' + summary.samples + ', infra ' + summary.infra.errors + ', pending ' + summary.pending].join('  ');
}

const localTime = iso => {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('en-GB', { hour12: false, timeZoneName: 'short' }) : String(iso);
};

const duration = seconds => {
  seconds = Math.max(0, Math.round(seconds));
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
  return h ? h + 'h ' + m + 'm' : m ? m + 'm ' + s + 's' : s + 's';
};

// The one-line answer to "why is nothing happening, and until when?".
export function describeState(state, now = Date.now()) {
  const who = state.alive ? 'runner pid ' + state.pid + ' (since ' + state.since + ')' : 'no runner alive';
  const until = hold => {
    const left = (Date.parse(hold.until_at) - now) / 1000;
    return hold.reason + ' until ' + hold.until_at + ' (' + localTime(hold.until_at) + (left > 0 ? ', in ' + duration(left) : ', due') + '; ' +
      (hold.basis === 'retry_after' ? 'reset time stated by the CLI' : 'backoff, no reset time stated') + ')' +
      (hold.attempt ? '; evidence ' + hold.attempt + (hold.evidence ? ': ' + hold.evidence : '') : '');
  };
  if ((state.phase === 'waiting' || state.phase === 'preflight_waiting') && state.hold) {
    const what = state.phase === 'preflight_waiting' ? 'WAITING IN PREFLIGHT' : 'WAITING';
    return (state.alive ? what : 'WAS ' + what + ' (runner gone)') + ': ' + until(state.hold) + '; ' + who;
  }
  if ((state.phase === 'stopped' || state.phase === 'error') && state.stop) {
    return (state.phase === 'error' ? 'ERROR' : 'STOPPED') + ': ' + state.stop.reason + ' (' + (state.stop.attempt ?? '-') + '): ' + state.stop.message + ' -> ' + state.stop.advice + '; ' + who;
  }
  if (state.phase === 'would_wait' && state.hold) return 'EXITED INSTEAD OF WAITING (--no-wait): ' + until(state.hold) + '; run again after that; ' + who;
  if (state.phase === 'preflight_gave_up') return 'PREFLIGHT GAVE UP (' + (state.gave_up ?? '?') + ')' + (state.hold ? ': last ' + until(state.hold) : '') + '; run preflight again; ' + who;
  if (state.phase) return state.phase.toUpperCase() + (state.updated_at ? ' (as of ' + state.updated_at + ')' : '') + '; ' + who;
  return 'never run; ' + who;
}

// One runner per batch. The lock names the holder by pid and process start
// time, so a lock left by a killed runner (or a pid reused after a reboot) is
// recognised as stale and taken over, and a live runner is never doubled.
async function acquireLock(batchDir) {
  const path = join(batchDir, 'run.lock');
  const mine = { pid: process.pid, started: startTimeOf(process.pid), host: hostname(), at: new Date().toISOString() };
  for (let tries = 0; tries < 3; tries++) {
    try {
      await writeJSON(path, mine, { exclusive: true });
      return async () => { try { const held = await readJSON(path); if (held.pid === mine.pid && held.at === mine.at) await rm(path, { force: true }); } catch {} };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    let holder = null;
    try { holder = await readJSON(path); } catch {}
    // The host is recorded, not compared: a Mac's hostname changes with the
    // network, and a lock must not outlive its runner for that reason.
    if (holder?.pid && holder.started && startTimeOf(holder.pid) === holder.started) {
      throw new Error('Batch is already being run by pid ' + holder.pid + ' (since ' + holder.at + '); stop that runner first (lock ' + path + ')');
    }
    await rm(path, { force: true });
  }
  throw new Error('Could not take the batch lock ' + path);
}

// writeJSON temporaries left by a runner that was killed mid-write.
async function removeStaleTemporaries(dirs) {
  for (const dir of dirs) {
    for (const name of await readdir(dir).catch(() => [])) {
      const match = STALE_TEMPORARY.exec(name);
      if (match && Number(match[1]) !== process.pid && !commandOf(Number(match[1]))) await rm(join(dir, name), { force: true });
    }
  }
}

// What a human has to do about a stop-class infrastructure error.
const STOP_ADVICE = {
  auth: 'log in again with the harness CLI (codex login / claude / grok login / an interactive agy session), then run again',
  billing: 'check the plan, credits or spend cap of the login, then run again',
  model_unavailable: 'the model id is unknown or not on this plan; a batch cannot change its model, so prepare a new batch with a valid one',
  request_rejected: 'the API refused the frozen request (model, effort or another parameter); prepare a new batch with settings it accepts',
  frozen: 'restore what changed (or prepare a new batch), then run again',
};

// The API systems authenticate with a key from the environment, not a login.
function stopAdvice(reason, manifest) {
  if (manifest?.harness?.key_variable && reason === 'auth') return 'set ' + manifest.harness.key_variable + ' to a valid key in the environment of the runner, then run again';
  if (manifest?.harness?.key_variable && reason === 'billing') return 'check the credits or spend limits of the API account, then run again';
  return STOP_ADVICE[reason];
}

// Where the host-sleep rule reads the machine's power state (tests inject a fixture).
const hostSource = deps => deps.hostSleep ?? PMSET;

// A hold restored from a dead runner's state, or derived from the results on
// disk: a restarted runner must not walk straight back into a known limit.
async function startingHold(batchDir, manifest, saved, schedule) {
  if (saved?.hold && Date.parse(saved.hold.until_at ?? '') > Date.now()) return saved;
  let latest = null;
  for (const task of manifest.tasks) for (const attempt of task.attempts) {
    const result = await readJSON(join(batchDir, attempt.dir, 'result.json')).catch(() => null);
    const at = Date.parse(result?.infra?.retry_after ?? '');
    if (result?.status === 'infra_error' && INFRA_REASONS[result.infra.reason] === 'wait' && at > Date.now() && (!latest || at > latest.at)) {
      latest = { at, result, dir: attempt.dir };
    }
  }
  if (!latest) return saved;
  // The same jitter as any hold: batches restarted together after a crash
  // must not all knock at the stated reset second.
  const hold = holdUntil({ kind: 'limit', retryAfter: latest.result.infra.retry_after, seed: manifest.id, draw: 'restored', schedule });
  return { ...saved, hold: { kind: 'limit', reason: latest.result.infra.reason, since: latest.result.result_at ?? new Date().toISOString(),
    until_at: new Date(hold.until).toISOString(), basis: 'retry_after', retry_after: latest.result.infra.retry_after, attempt: latest.dir,
    evidence: String(latest.result.infra.message ?? '').slice(0, 200), streak: 1 } };
}

// Runs every attempt of a frozen batch that has no result yet, and runs again
// (from a pristine workspace, keeping the failed try) every attempt whose
// result is an infrastructure error, up to `maxReruns` re-runs caused by the
// session's own failures. Inside one invocation:
//   - a usage or rate limit holds the batch: nothing new is launched, running
//     attempts finish, and launching resumes after the stated reset time (or
//     a backoff); with wait: false the run ends instead (code E3D_WAIT);
//   - a service that keeps failing holds it for a shorter, growing backoff;
//   - a login, billing or model problem, or a changed scorer, runner or CLI,
//     stops it (code E3D_STOPPED) once the running attempts have finished;
//   - a CLI that retries the service for `retryStallSeconds` is stopped and
//     its attempt recorded as an infrastructure error.
// Safe to kill and restart at any point: results are written once and
// atomically, a restarted runner rebuilds an attempt whose generation
// finished and re-scores it, an attempt whose generation was cut off is an
// infrastructure error, a hold in force is honoured, and only one runner can
// hold a batch. `signal` (an AbortSignal) or, with handleSignals,
// SIGINT/SIGTERM/SIGHUP stop it cleanly (code E3D_INTERRUPTED); a second
// signal exits at once.
export async function execute({ batchDir, concurrency = 1, repoRoot = REPO_ROOT, deps = {}, log = () => {}, signal, handleSignals = false,
  wait = true, resumeNow = false, maxReruns = DEFAULT_MAX_RERUNS, retryStallSeconds = DEFAULT_RETRY_STALL_SECONDS }) {
  batchDir = resolve(batchDir);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('concurrency must be 1..16');
  if (!Number.isInteger(maxReruns) || maxReruns < 0 || maxReruns > 100) throw new Error('maxReruns must be 0..100');
  if (!(retryStallSeconds > 0)) throw new Error('retryStallSeconds must be positive');
  const manifest = await readJSON(join(batchDir, 'manifest.json'));
  // An API system without its key cannot run anything: stop for a human
  // before anything else is checked (exit 3, not a preflight problem).
  const missingKey = (deps.adapter ?? adapterFor(manifest.system)).keyProblem?.(deps.env ?? process.env);
  if (missingKey) {
    const error = new Error('Stopped: auth: ' + missingKey + '\n' + stopAdvice('auth', manifest));
    error.code = 'E3D_STOPPED'; error.stop = { reason: 'auth', message: missingKey, attempt: null, advice: stopAdvice('auth', manifest), at: new Date().toISOString() };
    throw error;
  }
  let preflightReport;
  try { preflightReport = await readJSON(join(batchDir, 'preflight.json')); } catch { throw new Error('No preflight.json: run preflight first'); }
  if (!preflightReport.passed) {
    throw new Error(preflightReport.infra
      ? 'The isolation preflight could not finish (infrastructure: ' + preflightReport.infra.reason + (preflightReport.infra.retry_after ? ' until ' + preflightReport.infra.retry_after : '') + '); run preflight again'
      : 'Isolation preflight did not pass; nothing will run');
  }
  if (preflightReport.manifest_sha256 !== manifestHash(manifest)) throw new Error('The manifest changed after preflight; run preflight again');
  const checks = { repoRoot, checkRunner: !deps.skipRunnerCheck, checkScorer: !deps.skipScorerCheck };
  const release = await acquireLock(batchDir);
  // running: attempts generating now; pids: every live CLI leader and scorer.
  const control = { signal: null, running: new Set(), pids: new Map() };
  const stopper = interruption({ signal, handleSignals, onAbort: reason => log({ event: 'interrupt', reason, running: [...control.running] }),
    // A second signal: no grace period, nothing left running.
    hard: () => { for (const pid of control.pids.values()) killTree(pid, 'SIGKILL'); } });
  const controller = { signal: stopper.signal }, abort = stopper.abort;
  control.signal = stopper.signal;
  const progressPath = join(batchDir, 'progress.log');
  const statePath = join(batchDir, 'runner-state.json');
  let phase = 'running', stop = null, gate = null;
  const saveState = async () => {
    const snapshot = gate?.snapshot() ?? {};
    await writeState(batchDir, { phase, concurrency, max_reruns: maxReruns, retry_stall_seconds: retryStallSeconds, wait,
      hold: snapshot.hold ?? null, streak: snapshot.streak ?? null, draws: snapshot.draws ?? 0, stop });
  };
  let stateChain = Promise.resolve();
  const persist = () => { stateChain = stateChain.then(saveState, saveState); return stateChain; };
  const note = async line => { await appendFile(progressPath, stamp() + '  ' + line + '\n'); };
  try {
    await recoverReruns(batchDir, manifest, log);
    const problems = await frozenProblems(batchDir, manifest, checks);
    if (problems.length) throw new Error('Frozen batch changed: ' + problems.join('; '));
    await checkScorer(deps);
    const adapter = deps.adapter ?? adapterFor(manifest.system);
    // resumeNow: the operator knows the limit is gone (a new plan, a reset
    // that came early); the backoff streak is kept.
    const previousState = await readJSON(statePath).catch(() => null);
    const saved = resumeNow ? { ...previousState, hold: null } : await startingHold(batchDir, manifest, previousState, deps.schedule ?? SCHEDULE);
    gate = createGate({ seed: manifest.id, wait, concurrency, schedule: deps.schedule ?? SCHEDULE, initial: saved, onEvent: event => {
      log(event);
      if (event.event === 'waiting') {
        phase = wait ? 'waiting' : 'would_wait';
        persist();
        note('WAIT ' + event.reason + ' until ' + event.until_at + ' (' + localTime(event.until_at) + ', ' + event.basis + ')' + (event.attempt ? ' | ' + event.attempt + ': ' + (event.evidence ?? '') : '') +
          (wait ? '' : ' | --no-wait: exiting instead')).catch(() => {});
      } else if (event.event === 'wait_extended') {
        persist();
        note('WAIT extended: ' + event.reason + ' until ' + event.until_at + ' (' + localTime(event.until_at) + ')' + (event.attempt ? ' | ' + event.attempt : '')).catch(() => {});
      } else if (event.event === 'resumed') {
        phase = 'running';
        persist();
        note('RESUME after ' + duration(event.waited_seconds) + ' (' + event.reason + ')').catch(() => {});
      }
    } });
    await removeStaleTemporaries([batchDir, ...manifest.tasks.flatMap(task => task.attempts.flatMap(attempt => [join(batchDir, attempt.dir), join(batchDir, attempt.dir, 'score')]))]);

    // The queue: every attempt without a result, and every infra_error that
    // may still be re-run. Re-runs after a limit go to the front (they were
    // next when the limit hit); re-runs after a failing session go to the
    // back, so an outage spreads its cost instead of exhausting one attempt.
    const queue = [];
    for (const task of manifest.tasks) for (const attempt of task.attempts) {
      const result = await readJSON(join(batchDir, attempt.dir, 'result.json')).catch(() => null);
      if (!result) queue.push({ task, attempt, rerun: false });
      else if (result.status === 'infra_error') {
        const budget = await rerunBudget(batchDir, attempt, result, maxReruns);
        if (budget.allowed) queue.push({ task, attempt, rerun: true });
        else log({ event: 'rerun_capped', task_id: task.id, attempt: attempt.n, counted: budget.counted, max_reruns: maxReruns });
      }
    }
    const total = queue.length;
    // A hold still in force from before the restart is honoured (and said
    // so), unless nothing is owed.
    if (gate.hold && total) {
      const held = gate.describe(gate.hold);
      log({ event: 'waiting', ...held, restored: true, wait: wait ? 'in-process' : 'exit (--no-wait)' });
      phase = wait ? 'waiting' : 'would_wait';
      await note('WAIT (restored) ' + held.reason + ' until ' + held.until_at + ' (' + localTime(held.until_at) + ', ' + held.basis + ')' +
        (held.attempt ? ' | ' + held.attempt + ': ' + (held.evidence ?? '') : '') + (wait ? '' : ' | --no-wait: exiting instead'));
    }
    await persist();
    let summaryChain = Promise.resolve();
    const stopBatch = async ({ reason, message, attempt = null }) => {
      if (stop) return;
      const advice = stopAdvice(reason, manifest) ?? 'see the evidence in ' + (attempt ?? 'the log') + ', then run again';
      stop = { reason, message, attempt, advice, at: new Date().toISOString() };
      phase = 'stopped';
      log({ event: 'stopping', ...stop, running: [...control.running] });
      await persist();
      await note('STOP ' + reason + ': ' + message + (attempt ? ' (' + attempt + ')' : '') + ' -> ' + advice);
    };

    const worker = async () => {
      for (;;) {
        // Nothing owed: a hold (restored, or set by the last attempt of
        // another worker that then re-queued nothing) is not waited out.
        if (!queue.length) return;
        if (!await gate.pass(controller.signal, { stopped: () => Boolean(stop) })) return;
        const job = queue.shift();
        if (!job) return;
        // Nothing launches against a changed scorer, runner or CLI.
        const drift = await liveProblems(manifest, checks);
        if (drift.length) { queue.unshift(job); await stopBatch({ reason: 'frozen', message: drift.join('; ') }); return; }
        const launchedAt = Date.now();
        const outcome = await runAttempt({ batchDir, manifest, task: job.task, attempt: job.attempt, adapter, deps, log, control, rerun: job.rerun,
          repoRoot, retryStallSeconds: deps.retryStallSeconds ?? retryStallSeconds,
          mayLaunch: () => !gate.holding() && !stop && !controller.signal.aborted });
        if (outcome.frozen) { await stopBatch({ reason: 'frozen', message: outcome.frozen.join('; '), attempt: job.attempt.dir }); return; }
        // A hold or a stop began while this attempt was being prepared: it
        // goes back to the front, unlaunched, and waits like the others.
        if (outcome.deferred) { queue.unshift(job); continue; }
        if (outcome.interrupted) continue;
        if (outcome.skipped) { log({ event: 'skipped', task_id: job.task.id, attempt: job.attempt.n, status: outcome.result.status }); continue; }
        const result = outcome.result;
        const reason = result.infra?.reason, action = INFRA_REASONS[reason] ?? 'retry', where = job.attempt.dir;
        const interrupted = reason === 'runner_interrupted';
        // The hold (or the stop) takes effect before anything else is
        // awaited, so no other worker launches into the same limit meanwhile.
        if (result.status === 'infra_error' && !interrupted) {
          if (action === 'stop') await stopBatch({ reason, message: result.infra?.message ?? reason, attempt: where });
          else gate.holdFor({ kind: HOLD_KIND[action] ?? 'retry', reason, retryAfter: result.infra?.retry_after ?? null, attempt: where,
            evidence: String(result.infra?.message ?? '').slice(0, 200), launchedAt });
        }
        // Summary writes are serialized; attempts finish in any order.
        summaryChain = summaryChain.then(async () => {
          const summary = await summarize(batchDir), line = progressLine(result, summary);
          await appendFile(progressPath, line + '\n');
          log({ event: 'progress', line });
        });
        await summaryChain;
        if (result.status !== 'infra_error') { gate.success({ launchedAt }); continue; }
        // A stopped runner records its interrupted attempts and stops; a
        // stop-class error is re-run by the next `run`, once a human fixed it.
        if ((interrupted && controller.signal.aborted) || action === 'stop') continue;
        const budget = await rerunBudget(batchDir, job.attempt, result, maxReruns);
        if (budget.allowed) (action === 'wait' ? queue.unshift : queue.push).call(queue, { task: job.task, attempt: job.attempt, rerun: true });
        else { log({ event: 'rerun_capped', task_id: job.task.id, attempt: job.attempt.n, counted: budget.counted, max_reruns: maxReruns }); await note('CAP ' + where + ': ' + budget.counted + ' tries ended by ' + RERUN_COUNTED.join('/') + ' (at most ' + maxReruns + ' re-runs); left as infra_error, last ' + reason); }
      }
    };
    // An attempt that throws (a workspace altered after freeze) stops the
    // batch like a signal would, but only once the other running attempts
    // have been stopped and recorded: the lock is never released under them.
    let failure = null;
    const guarded = async () => { try { await worker(); } catch (error) { failure ??= error; abort('error: ' + error.message); } };
    log({ event: 'run', batch: manifest.id, queued: total, concurrency, wait, max_reruns: maxReruns, retry_stall_seconds: retryStallSeconds });
    await Promise.all(Array.from({ length: Math.min(concurrency, total || 1) }, guarded));
    await summaryChain;
    // The final state is saved first, so the summary (and `status`) carry it.
    phase = failure ? 'error' : controller.signal.aborted ? 'interrupted' : stop ? 'stopped' : gate.blocked ? 'would_wait' : 'finished';
    if (failure) stop = { reason: 'error', message: failure.message, attempt: null, advice: 'fix the cause, then run again', at: new Date().toISOString() };
    await persist();
    if (failure) throw failure;
    const summary = await summarize(batchDir);
    if (controller.signal.aborted) {
      const error = new Error('Interrupted (' + controller.signal.reason + '); run again to continue. ' + summary.pending + ' attempts pending, ' + summary.infra.errors + ' infrastructure errors');
      error.code = 'E3D_INTERRUPTED'; error.summary = summary;
      throw error;
    }
    if (stop) {
      const error = new Error('Stopped: ' + stop.reason + ' (' + (stop.attempt ?? '-') + '): ' + stop.message + '\n' + stop.advice);
      error.code = 'E3D_STOPPED'; error.stop = stop; error.summary = summary;
      throw error;
    }
    if (gate.blocked) {
      const hold = gate.blocked;
      const error = new Error('Not waiting (--no-wait): ' + hold.reason + ' until ' + hold.until_at + ' (' + localTime(hold.until_at) + ')' +
        (hold.attempt ? ', evidence ' + hold.attempt : '') + '; run again after that');
      error.code = 'E3D_WAIT'; error.hold = hold; error.summary = summary;
      throw error;
    }
    return summary;
  } finally {
    stopper.dispose();
    await stateChain.catch(() => {});
    await release();
  }
}

// `status`: the batch at a glance, for an operator.
export async function batchStatus(batchDir) {
  batchDir = resolve(batchDir);
  const summary = await summarize(batchDir, { write: false });
  const lines = (await readFile(join(batchDir, 'progress.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return { summary, state: describeState(summary.runner), last: lines.slice(-3) };
}

export { buildPrompt, PROMPT_VERSION } from './prompt.mjs';
export { parseCodexEvents, parseClaudeEvents, parseEvents } from './events.mjs';
export { captureProcess, childEnvironment, killTree } from './process.mjs';
export { classifyStatus, STATUSES, NOT_SAMPLES } from './status.mjs';
export { detectInfra, retryWatch, INFRA_REASONS } from './infra.mjs';
export { createGate, holdUntil, SCHEDULE } from './schedule.mjs';
export { ADAPTERS, adapterFor, nodeRuntime, codexConfig, claudeSettings } from './adapters.mjs';

// The names the brief uses for the v0 runner's entry points.
export { prepare as preparePilot, preflight as preflightPilot, execute as executePilot };
