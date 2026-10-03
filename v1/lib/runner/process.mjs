import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { performance } from 'node:perf_hooks';

// Child processes of the runner. A contestant CLI is started as the leader of
// its own process group and killed as a whole tree when it overruns its wall
// clock, so nothing it spawned (shells, node, a stray server) outlives it.

// Environment variables a harness may receive from the operator's shell. All
// else is dropped: the operator's API keys, cloud credentials, proxy settings,
// NODE_OPTIONS and editor hooks never reach a contestant process.
export const PASSED_ENV = ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
export const BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

// Names that look like credentials. A harness environment that contains one is
// refused outright rather than filtered, because it means a code path above
// added it on purpose.
export const CREDENTIAL_NAME = /(API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION_?KEY|PRIVATE_?KEY|AUTH)/i;

export function childEnvironment(extra = {}, source = process.env) {
  const env = {};
  for (const key of PASSED_ENV) if (typeof source[key] === 'string' && source[key]) env[key] = source[key];
  env.PATH = BASE_PATH;
  for (const [key, value] of Object.entries(extra)) if (value !== undefined && value !== null) env[key] = String(value);
  assertCleanEnvironment(env);
  return env;
}

export function assertCleanEnvironment(env) {
  const leaked = Object.keys(env).filter(key => CREDENTIAL_NAME.test(key));
  if (leaked.length) throw new Error('Refusing to start a harness with credential-like environment variables: ' + leaked.join(', '));
  return env;
}

// Every process descended from the given roots (inclusive), found by walking
// ppid links in one `ps` snapshot. Process-group kills miss children that
// called setsid().
export function descendants(roots) {
  roots = [].concat(roots);
  let table;
  try { table = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }); } catch { return roots; }
  const children = new Map();
  for (const line of table.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const found = new Set(roots), queue = [...roots];
  while (queue.length) for (const child of children.get(queue.shift()) ?? []) if (!found.has(child)) { found.add(child); queue.push(child); }
  return [...found];
}

function signal(pid, name) {
  try { process.kill(pid, name); } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; }
}

// The command line of a live process, or null.
export function commandOf(pid) {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

// The start time of a live process as ps prints it, or null; with the pid it
// identifies a process across pid reuse (a lock holder, a leftover CLI).
export function startTimeOf(pid) {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

// Waits (briefly, synchronously) until the given processes are really stopped
// or gone. A SIGSTOP takes effect when the process next leaves the kernel, so
// a fork already in progress completes first; once ps shows the process
// stopped, every child it will ever have is in the process table.
function waitStopped(pids, limitMs = 1000) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (const deadline = Date.now() + limitMs; Date.now() < deadline;) {
    // ps exits non-zero when any listed pid is gone, so its output is read regardless.
    const table = spawnSync('/bin/ps', ['-o', 'pid=,stat=', '-p', pids.join(',')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).stdout ?? '';
    const running = table.split('\n').map(line => line.trim().split(/\s+/)).filter(([pid, stat]) => pid && stat && !/^[TZ]/.test(stat));
    if (!running.length) return;
    Atomics.wait(pause, 0, 0, 5);
  }
}

// Signals a whole process tree. The tree is frozen first: a stopped process
// cannot fork, so once a snapshot finds nothing that is not already stopped,
// nothing can be spawned between the snapshot and the signal (a tree read
// while it is still forking can otherwise miss a child born a moment later,
// which then survives as an orphan). `also` adds roots seen earlier, so the
// children of members whose parent already died are still found.
// Returns every pid that was signalled.
export function killTree(pid, name = 'SIGKILL', { also = [] } = {}) {
  const frozen = new Set();
  for (let pass = 0; pass < 10; pass++) {
    const fresh = descendants([pid, ...also]).filter(member => !frozen.has(member) && member !== process.pid);
    if (!fresh.length) break;
    for (const member of fresh) { signal(member, 'SIGSTOP'); frozen.add(member); }
    waitStopped(fresh);
  }
  signal(-pid, name);
  for (const member of frozen) signal(member, name);
  // A stopped process holds a catchable signal until it is continued.
  if (name !== 'SIGKILL') { signal(-pid, 'SIGCONT'); for (const member of frozen) signal(member, 'SIGCONT'); }
  return [...frozen];
}

// Runs a command to completion (or to its wall-clock limit, or until `signal`
// aborts it).
//   stdout/stderr go to the given files byte for byte, and complete JSON lines
//   on stdout are handed to onEvent(event, ms) as they arrive (a line split
//   across reads is reassembled first); ms is the arrival time after spawn,
//   also returned per event in event_ms.
// Never throws for a failing child: the outcome is in the returned record.
export async function captureProcess(command, args, {
  cwd, env = childEnvironment(), stdin = '', seconds = 60, graceSeconds = 5,
  stdoutPath, stderrPath, onEvent, onSpawn, signal: abortSignal, keepStdout = 4000000, keepStderr = 200000,
} = {}) {
  const startedAt = new Date().toISOString(), clock = performance.now();
  // Opened before the child exists and listened on at once: a log file that
  // cannot be created (it already exists) must fail this call, not crash the
  // runner with an unhandled stream error.
  let logError = null;
  const open = path => new Promise((resolve, reject) => {
    const stream = createWriteStream(path, { flags: 'wx' });
    stream.once('error', reject);
    stream.once('open', () => { stream.off('error', reject); stream.on('error', error => { logError ??= path + ': ' + error.message; }); resolve(stream); });
  });
  const outFile = stdoutPath ? await open(stdoutPath) : null;
  let errFile = null;
  try { errFile = stderrPath ? await open(stderrPath) : null; } catch (error) { outFile?.destroy(); throw error; }
  let stdout = '', stderr = '', pending = '', timedOut = false, aborted = false, launchError = null, killTimer = null;
  const events = { parsed: 0, unparsed: 0 }, eventMs = [], seen = new Set();
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  // Listened for before anything is awaited, so a child that exits at once is not missed.
  const ended = new Promise(resolve => {
    child.on('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    child.on('error', error => { launchError = error.message; resolve({ code: null, signal: null }); });
  });
  // Called at once, before anything is awaited: a caller that records the pid
  // synchronously has it on disk before the child can be left orphaned.
  if (child.pid && onSpawn) { try { Promise.resolve(onSpawn(child.pid)).catch(() => {}); } catch {} }
  const handleLine = line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { events.unparsed++; return; }
    events.parsed++;
    const ms = Math.round(performance.now() - clock);
    eventMs.push(ms);
    try { onEvent?.(event, ms); } catch {}
  };
  child.stdout.on('data', bytes => {
    outFile?.write(bytes);
    if (stdout.length < keepStdout) stdout += bytes.toString('utf8');
    pending += bytes.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) handleLine(line);
  });
  child.stderr.on('data', bytes => { errFile?.write(bytes); if (stderr.length < keepStderr) stderr += bytes.toString('utf8'); });
  child.stdin.on('error', () => {});
  child.stdin.end(stdin);
  // SIGTERM to the frozen tree, SIGKILL after the grace period to everything
  // seen then (its leader may be gone by then, its children not).
  const stop = () => {
    if (!child.pid || killTimer) return;
    for (const member of killTree(child.pid, 'SIGTERM')) seen.add(member);
    killTimer = setTimeout(() => killTree(child.pid, 'SIGKILL', { also: [...seen] }), graceSeconds * 1000);
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, seconds * 1000);
  const onAbort = () => { if (!timedOut) aborted = true; stop(); };
  if (abortSignal?.aborted) onAbort(); else abortSignal?.addEventListener('abort', onAbort, { once: true });
  const { code, signal: endSignal } = await ended;
  clearTimeout(timer); clearTimeout(killTimer);
  abortSignal?.removeEventListener('abort', onAbort);
  // Whatever the leader left behind in its group goes too.
  if (child.pid) killTree(child.pid, 'SIGKILL', { also: [...seen] });
  if (pending) handleLine(pending);
  await Promise.all([outFile, errFile].filter(Boolean).map(stream => new Promise(resolve => stream.end(resolve))));
  return {
    started_at: startedAt, finished_at: new Date().toISOString(), wall_seconds: (performance.now() - clock) / 1000,
    exit_code: code, signal: endSignal, timed_out: timedOut, aborted, launch_error: launchError, log_error: logError,
    events_parsed: events.parsed, lines_unparsed: events.unparsed, event_ms: eventMs, stdout, stderr,
  };
}
