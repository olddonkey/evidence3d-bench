import { writeFile, readFile, link, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { layout } from '../../contract.mjs';
import { CREDENTIAL_NAME } from '../process.mjs';
import { probePlan, extractProbeOutput, evaluateProbes, verdict } from '../probes.mjs';
import { buildProbeSite, denyTargets, keychainEntry, startListeners, snapshot, writeGround, previewGround, groundTruth, fileState } from '../preflight.mjs';
import { writeJSON } from '../workspace.mjs';
import { INFRA_REASONS } from '../infra.mjs';
import { runSandboxed } from './sandbox.mjs';
import { createTools, API_TOOL_NAMES, TOOL_SPECS } from './tools.mjs';
import { postJSON, redactor } from './http.mjs';

// Preflight of an API system, without a model. The boundary is the loop's own
// code (the file tools) plus the Seatbelt profile around the shell, so it is
// proven directly and deterministically, on probe workspaces built by the same
// code as attempts, with the same canaries and planted escape routes as the
// CLI tracks:
//   sandbox:*  the probe script run under the frozen profile by sandbox-exec
//   shell:*    the same script run through the shell tool, as the model would
//   agent:*    read_file, list_dir, view_image and write_file aimed at the
//              outside file, a file symlink, a directory symlink, a dangling
//              symlink, a hard link planted by the runner and `..`, plus
//              controls that must work; judged by what came back (canary
//              content or names) and by the files on disk
//   live:request  one minimal request with the frozen model, effort, system
//              prompt and tools, when the key variable is set: proves the key,
//              the model id and that the API accepts the request shape.
// Without the key the boundary is still proven, the live check is reported
// as skipped, and preflight stops for a human (infra auth, exit 3).

const LEAKED_NAMES = /canary\.(txt|png)|outside\.txt|linked\.png/;

const AGENT_STEPS = site => [
  ['read-canary', 'read_file', { path: join(site.secret, 'canary.txt') }, 'deny'],
  ['read-symlink', 'read_file', { path: '.e3d-probe/link-file' }, 'deny'],
  ['read-dir-symlink', 'read_file', { path: '.e3d-probe/link-dir/canary.txt' }, 'deny'],
  ['read-dangling', 'read_file', { path: '.e3d-probe/dangling-agent' }, 'deny'],
  ['read-hardlink', 'read_file', { path: '.e3d-probe/hardlink-canary' }, 'deny'],
  ['read-dotdot', 'read_file', { path: '../secret/canary.txt' }, 'deny'],
  ['read-input', 'read_file', { path: 'input/task.json' }, 'allow'],
  ['list-secret', 'list_dir', { path: site.secret }, 'deny'],
  ['list-dir-symlink', 'list_dir', { path: '.e3d-probe/link-dir' }, 'deny'],
  ['list-dotdot', 'list_dir', { path: '..' }, 'deny'],
  ['list-workspace', 'list_dir', { path: '.' }, 'allow'],
  ['view-canary', 'view_image', { path: join(site.secret, 'canary.png') }, 'deny'],
  ['view-symlink', 'view_image', { path: '.e3d-probe/link-image.png' }, 'deny'],
  ['view-hardlink', 'view_image', { path: '.e3d-probe/hardlink-image.png' }, 'deny'],
  ['view-dotdot', 'view_image', { path: '../secret/canary.png' }, 'deny'],
  ['view-control', 'view_image', { path: '.e3d-probe/control.png' }, 'allow'],
  ['write-output', 'write_file', { path: 'output/.agent-write.txt', content: 'ok' }, 'allow'],
  ['write-input', 'write_file', { path: 'input/.agent-write.txt', content: 'x' }, 'deny'],
  ['write-tools', 'write_file', { path: 'tools/.agent-write.txt', content: 'x' }, 'deny'],
  ['write-runtime', 'write_file', { path: 'node_modules/three/.agent-write.txt', content: 'x' }, 'deny'],
  ['write-outside', 'write_file', { path: join(site.secret, 'agent-written.txt'), content: 'x' }, 'deny'],
  ['write-symlink', 'write_file', { path: '.e3d-probe/link-out', content: 'PATCHED' }, 'deny'],
  ['write-dangling', 'write_file', { path: '.e3d-probe/dangling-agent', content: 'x' }, 'deny'],
  ['write-dir-symlink', 'write_file', { path: '.e3d-probe/link-dir/agent-new.txt', content: 'x' }, 'deny'],
  ['write-dotdot', 'write_file', { path: '../secret/agent-dotdot.txt', content: 'x' }, 'deny'],
  ['write-hardlink', 'write_file', { path: '.e3d-probe/hardlink-canary', content: 'PATCHED' }, 'deny'],
];

const exists = path => lstat(path).then(() => true, () => false);

// What must hold on disk after each write step (true: the boundary held).
async function writeHeld(id, site, before) {
  const ws = site.workspace, secret = site.secret;
  switch (id) {
    case 'write-output': return (await readFile(join(ws, 'output', '.agent-write.txt'), 'utf8').catch(() => null)) === 'ok';
    case 'write-input': return !await exists(join(ws, 'input', '.agent-write.txt'));
    case 'write-tools': return !await exists(join(ws, 'tools', '.agent-write.txt'));
    case 'write-runtime': return !await exists(join(ws, 'node_modules', 'three', '.agent-write.txt'));
    case 'write-outside': return !await exists(join(secret, 'agent-written.txt'));
    case 'write-symlink': return (await fileState(join(secret, 'outside.txt'))) === before.outside;
    case 'write-dangling': return !await exists(join(secret, 'dangling-agent-written.txt'));
    case 'write-dir-symlink': return !await exists(join(secret, 'agent-new.txt'));
    case 'write-dotdot': return !await exists(join(secret, 'agent-dotdot.txt'));
    case 'write-hardlink': return (await fileState(join(secret, 'canary.txt'))) === before.canary;
    default: return null;
  }
}

export async function evaluateFileTools(site, tools) {
  // Hard links to the outside files, planted by the runner (the shell cannot
  // make one: sandbox:canary-hardlink).
  await link(join(site.secret, 'canary.txt'), join(site.probe, 'hardlink-canary')).catch(() => {});
  await link(join(site.secret, 'canary.png'), join(site.probe, 'hardlink-image.png')).catch(() => {});
  const before = { outside: await fileState(join(site.secret, 'outside.txt')), canary: await fileState(join(site.secret, 'canary.txt')) };
  const control = await readFile(join(site.probe, 'control.png'));
  const checks = [];
  for (const [id, tool, args, expect] of AGENT_STEPS(site)) {
    const result = await tools.run(tool, args);
    const check = { id: 'agent:' + id, expect, note: tool + ' ' + (args.path ?? ''), status: 'pass', reason: null,
      observed: { ok: result.ok, excerpt: String(result.text ?? '').slice(0, 240), image: result.image ? { media_type: result.image.media_type, width: result.image.width } : null } };
    checks.push(check);
    const fail = reason => { check.status = 'fail'; check.reason = reason; };
    const text = String(result.text ?? '');
    if (text.includes(site.canary) || (tool === 'list_dir' && expect === 'deny' && LEAKED_NAMES.test(text))) { fail('canary content or names came back'); continue; }
    if (tool === 'write_file') {
      const held = await writeHeld(id, site, before);
      if (expect === 'allow') { if (!result.ok || !held) fail('the control write did not land'); }
      else if (!held) fail('the write reached a file it must not');
      else if (result.ok) fail('the tool reported success for a write it must refuse');
      continue;
    }
    if (expect === 'deny') {
      if (result.ok || result.image) fail('the call succeeded' + (result.image ? ' and returned an image' : ''));
      continue;
    }
    if (id === 'read-input' && !(result.ok && text.includes('"schema"'))) fail('the control read did not return the task');
    if (id === 'list-workspace' && !(result.ok && text.includes('input/'))) fail('the control listing did not show input/');
    if (id === 'view-control' && !(result.ok && result.image && Buffer.from(result.image.data, 'base64').equals(control))) fail('view_image did not return the control image unchanged');
  }
  return checks;
}

// ---------------------------------------------------------------- live check

const LIVE_PROMPT = 'This is a connection check of the harness, not a task. Reply with the single word OK and do not call a tool.';

export async function liveCheck({ provider, config, key, log = () => {}, retries = 2, delayMs = 5000 }) {
  const redact = redactor(key);
  const state = provider.start(LIVE_PROMPT);
  const body = provider.body(config, state, { maxTokens: Math.min(config.max_output_tokens, 2048) });
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    let response = null, failure = null;
    try { response = await postJSON(provider.url(config.base_url), { headers: provider.headers(key), body, timeoutMs: 120000 }); }
    catch (error) { failure = { action: 'retry', reason: 'network', message: redact((error.code ? error.code + ': ' : '') + error.message), status: null }; }
    if (response?.status === 200) {
      const parsed = provider.parse(response.json);
      if (parsed && !parsed.failed) {
        return { ok: true, status: 200, ms: Date.now() - started, model_reported: parsed.model, stop_reason: parsed.stop, usage: parsed.usage,
          request_id: provider.requestId(response.headers, response.json) };
      }
      failure = { action: 'retry', reason: 'server_error', message: 'HTTP 200 without a usable response', status: 200 };
    } else if (response) {
      failure = provider.failure({ status: response.status, headers: response.headers, json: response.json ?? { error: { message: response.text.slice(0, 500) } }, turns: 0, now: Date.now() });
      failure.message = redact(failure.message);
    }
    last = failure;
    log({ event: 'preflight_live', attempt: attempt + 1, status: failure.status ?? null, reason: failure.reason });
    if (failure.action === 'retry' && attempt < retries) { await sleep(delayMs); continue; }
    if (failure.action === 'wait' && attempt < retries && (failure.wait_ms ?? 0) <= 60000) { await sleep(failure.wait_ms ?? delayMs); continue; }
    break;
  }
  return { ok: false, ...last, message: redact(last.message), tries: retries + 1 };
}

// ---------------------------------------------------------------- preflight

// The same interface and result as runPreflight (preflight.mjs).
export async function apiPreflight({ batchDir, manifest, adapter, harness, node, repoRoot, dataRoot, scratchDir, log = () => {}, signal, deps = {} }) {
  const firstTask = manifest.tasks[0], runDir = join(batchDir, 'preflight', new Date().toISOString().replace(/[:.]/g, '-'));
  const taskDir = layout(dataRoot).task(firstTask.id), toolsDir = join(batchDir, 'tools'), runtimeDir = join(batchDir, 'runtime');
  const home = deps.home ?? homedir(), otherAttempt = join(batchDir, manifest.tasks.at(-1).id, 'a' + manifest.attempts, 'prompt.txt');
  const targets = await denyTargets({ repoRoot, dataRoot, taskId: firstTask.id, batchDir, otherAttempt, home });
  const keychain = deps.keychain !== undefined ? deps.keychain : await keychainEntry('Claude Code-credentials') ? 'Claude Code-credentials' : null;
  const listeners = await startListeners();
  const checks = [], sessions = {};
  const env = deps.env ?? process.env;
  const planFor = site => probePlan({ credentialName: CREDENTIAL_NAME, keychain, internet: deps.internet,
    network: { loopbackPort: listeners.loopbackPort, unixSocket: listeners.unixSocket },
    paths: { node: node.path, toolsFile: 'tools/preview.mjs', canaryFile: join(site.secret, 'canary.txt'), outsideWrite: join(site.secret, 'written.txt'), denied: targets.denied } });
  // A site is a probe workspace with the invocation (and so the profile and
  // the config) an attempt in that place would get.
  const site = async label => {
    const built = await buildProbeSite({ root: join(runDir, label), taskDir, toolsDir, runtimeDir, label });
    const spec = adapter.invocation({ harness, model: manifest.model, effort: manifest.effort, workspace: built.workspace, attemptDir: built.root, node,
      wallSeconds: firstTask.budget?.wall_seconds ?? 1800 });
    for (const [path, content] of Object.entries(spec.files ?? {})) await writeJSON(path, content);
    const plan = planFor(built);
    await writeFile(join(built.probe, 'plan.json'), JSON.stringify(plan, null, 2));
    return { ...built, plan, config: Object.values(spec.files)[0] };
  };
  const probeChecks = async (target, prefix, observed, hitsBefore, before, label) => {
    const ground = await groundTruth(target, listeners, hitsBefore, await writeGround(target, before), await previewGround(target, scratchDir && join(scratchDir, label)), '180');
    for (const check of evaluateProbes(target.plan, observed, ground)) checks.push({ ...check, id: prefix + ':' + check.id });
  };
  let infra = null, live = null;
  try {
    // 1. The profile around the probe script, as sandbox-exec applies it.
    const box = await site('sandbox');
    let before = await snapshot(box), hits = { ...listeners.hits };
    const direct = await runSandboxed({ profile: box.config.sandbox.profile, env: box.config.sandbox.env, cwd: box.workspace, command: node.path,
      args: ['.e3d-probe/probe.mjs'], seconds: 120, keepChars: 200000, signal });
    await probeChecks(box, 'sandbox', extractProbeOutput(direct.head + direct.tail), hits, before, 'sandbox');
    sessions.sandbox = { exit_code: direct.exit_code, timed_out: direct.timed_out, ms: direct.ms };
    if (signal?.aborted) return { directory: runDir, checks, sessions, ...verdict(checks), infra: null, interrupted: true };
    // 2. The same script through the shell tool, then the file tools.
    const agent = await site('agent');
    const tools = createTools({ workspace: agent.workspace, sandbox: agent.config.sandbox, limits: agent.config.limits });
    before = await snapshot(agent); hits = { ...listeners.hits };
    const shell = await tools.run('shell', { command: 'node .e3d-probe/probe.mjs', timeout_seconds: 120 }, { signal });
    await probeChecks(agent, 'shell', extractProbeOutput(shell.text), hits, before, 'agent');
    sessions.shell = { ok: shell.ok, exit_code: shell.meta?.exit_code ?? null, truncated: shell.meta?.truncated ?? null };
    checks.push(...await evaluateFileTools(agent, tools));
    const names = (agent.config.tools ?? []).map(tool => tool.name);
    const same = JSON.stringify(agent.config.tools) === JSON.stringify(TOOL_SPECS);
    checks.push({ id: 'agent:tool-surface', status: same && names.join() === API_TOOL_NAMES.join() ? 'pass' : 'fail', observed: names,
      reason: same ? null : 'the frozen tool definitions differ from the loop\'s own five tools' });
    // 3. One live request, if the key is there.
    const key = env[adapter.provider.keyVariable];
    if (!key) {
      checks.push({ id: 'live:request', status: 'not_evaluated', reason: adapter.provider.keyVariable + ' is not set; the live check (key, model id, request shape) was skipped' });
      infra = { reason: 'auth', action: 'stop', during: 'startup', model_turns: 0, message: adapter.provider.keyVariable + ' is not set in the environment; the boundary was proven without a model but the live check was skipped',
        evidence: [], retry_after: null, retry_after_source: null, retry_after_text: null, session: 'live', tries: 0, gave_up: 'stop', hold: null };
    } else {
      live = await (deps.liveCheck ?? liveCheck)({ provider: adapter.provider, config: agent.config, key, log });
      sessions.live = { ok: live.ok, status: live.status ?? null, model_reported: live.model_reported ?? null, usage: live.usage ?? null, ms: live.ms ?? null,
        reason: live.reason ?? null, message: live.message ?? null };
      if (live.ok) checks.push({ id: 'live:request', status: 'pass', observed: { model_reported: live.model_reported, stop_reason: live.stop_reason } });
      else {
        checks.push({ id: 'live:request', status: 'not_evaluated', reason: 'the API answered ' + (live.status ?? 'nothing') + ' (' + live.reason + '): ' + live.message });
        const action = INFRA_REASONS[live.reason] ?? 'stop';
        infra = { reason: live.reason, action, during: 'startup', model_turns: 0, message: live.message, evidence: [JSON.stringify({ status: live.status ?? null, code: live.code ?? null, type: live.type ?? null })],
          retry_after: Number.isFinite(live.wait_ms) ? new Date(Date.now() + live.wait_ms).toISOString() : null, retry_after_source: live.retry_after_source ?? null, retry_after_text: null,
          session: 'live', tries: live.tries ?? 1, gave_up: action === 'stop' ? 'stop' : 'tries', hold: null };
      }
    }
  } finally { await listeners.close(); }
  for (const skip of targets.skipped) checks.push({ id: 'target:' + skip.id, status: 'not_applicable', reason: skip.reason + ' (' + skip.path + ')' });
  if (!keychain) checks.push({ id: 'target:keychain', status: 'not_applicable', reason: 'no Claude Code keychain entry on this machine' });
  checks.push({ id: 'agent:instruction-files', status: 'not_applicable', reason: 'the API loop reads no instruction files; its only inputs are the frozen system prompt and the task prompt' });
  const result = verdict(checks);
  return { directory: runDir, checks, sessions, ...result, infra: infra && !result.failed.length ? infra : null, live };
}
