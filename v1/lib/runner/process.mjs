import { spawn, execFileSync } from 'node:child_process';
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

// Every process descended from `pid` (inclusive), found by walking ppid links
// in one `ps` snapshot. Process-group kills miss children that called setsid().
export function descendants(pid) {
  let table;
  try { table = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }); } catch { return [pid]; }
  const children = new Map();
  for (const line of table.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const found = [pid], queue = [pid];
  while (queue.length) for (const child of children.get(queue.shift()) ?? []) if (!found.includes(child)) { found.push(child); queue.push(child); }
  return found;
}

function signal(pid, name) {
  try { process.kill(pid, name); } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; }
}

// The command line of a live process, or null.
export function commandOf(pid) {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

export function killTree(pid, name = 'SIGKILL') {
  const tree = descendants(pid);
  signal(-pid, name);
  for (const member of tree) signal(member, name);
  return tree.length;
}

// Runs a command to completion (or to its wall-clock limit).
//   stdout/stderr go to the given files byte for byte, and complete JSON lines
//   on stdout are handed to onEvent as they arrive (a line split across reads
//   is reassembled first).
// Never throws for a failing child: the outcome is in the returned record.
export async function captureProcess(command, args, {
  cwd, env = childEnvironment(), stdin = '', seconds = 60, graceSeconds = 5,
  stdoutPath, stderrPath, onEvent, onSpawn, keepStdout = 4000000, keepStderr = 200000,
} = {}) {
  const startedAt = new Date().toISOString(), clock = performance.now();
  const outFile = stdoutPath ? createWriteStream(stdoutPath, { flags: 'wx' }) : null;
  const errFile = stderrPath ? createWriteStream(stderrPath, { flags: 'wx' }) : null;
  let stdout = '', stderr = '', pending = '', timedOut = false, launchError = null, killTimer = null;
  const events = { parsed: 0, unparsed: 0 };
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  // Listened for before anything is awaited, so a child that exits at once is not missed.
  const ended = new Promise(resolve => {
    child.on('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    child.on('error', error => { launchError = error.message; resolve({ code: null, signal: null }); });
  });
  if (child.pid && onSpawn) Promise.resolve().then(() => onSpawn(child.pid)).catch(() => {});
  const handleLine = line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { events.unparsed++; return; }
    events.parsed++;
    try { onEvent?.(event); } catch {}
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
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) killTree(child.pid, 'SIGTERM');
    killTimer = setTimeout(() => { if (child.pid) killTree(child.pid, 'SIGKILL'); }, graceSeconds * 1000);
  }, seconds * 1000);
  const { code, signal: endSignal } = await ended;
  clearTimeout(timer); clearTimeout(killTimer);
  // Whatever the leader left behind in its group goes too.
  if (child.pid) killTree(child.pid, 'SIGKILL');
  if (pending) handleLine(pending);
  await Promise.all([outFile, errFile].filter(Boolean).map(stream => new Promise((resolve, reject) => { stream.on('error', reject); stream.end(resolve); })));
  return {
    started_at: startedAt, finished_at: new Date().toISOString(), wall_seconds: (performance.now() - clock) / 1000,
    exit_code: code, signal: endSignal, timed_out: timedOut, launch_error: launchError,
    events_parsed: events.parsed, lines_unparsed: events.unparsed, stdout, stderr,
  };
}
