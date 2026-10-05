import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { BASE_PATH, killTree } from '../process.mjs';

// The boundary of the API systems' shell tool: every command runs as
//   /usr/bin/sandbox-exec -p <profile> /bin/bash -c <command>
// in the workspace, with a minimal environment, under a Seatbelt profile
// generated here. The profile denies everything by default and allows:
//   read     the workspace, the system (/usr, /bin, /sbin, /System,
//            /private/etc, the time-zone data, /bin/sh's selector), the Node
//            install and Homebrew kegs it loads, a few device nodes, the root
//            directory itself (dyld lists it) and the metadata (not the
//            contents) of every ancestor of those roots (getcwd and realpath
//            walk them; Node aborts at start without it)
//   write    the workspace except input/, tools/ and node_modules/, and
//            /dev/null, /dev/zero
//   process  fork, exec, signals and process information within the sandbox
// Nothing else: no network of any kind (TCP, UDP, DNS, Unix sockets), no Mach
// services (so no keychain, no directory services), no IPC. The same boundary
// as the CLI tracks (README "The boundary"). The loop that calls the API runs
// outside it, because Seatbelt refuses nested profiles; it is never given to
// the model.
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const SHELL = '/bin/bash';

const SYSTEM_SUBPATHS = ['/usr', '/bin', '/sbin', '/System', '/private/etc', '/private/var/db/timezone', '/private/var/select'];
const SYSTEM_LITERALS = ['/etc', '/var', '/tmp', '/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/dtracehelper'];
const DEVICE_WRITES = ['/dev/null', '/dev/zero', '/dev/dtracehelper'];
export const READ_ONLY_PARTS = ['input', 'tools', 'node_modules'];

// SBPL string literal (the same escaping as JSON for quotes and backslashes).
const str = path => JSON.stringify(path);

const real = path => { try { return realpathSync(path); } catch { return null; } };

export function ancestors(path) {
  const found = [];
  for (let dir = dirname(path); dir !== '/' && dir !== '.'; dir = dirname(dir)) found.push(dir);
  return found;
}

// The profile for one workspace. Paths are resolved first: Seatbelt matches
// real paths (/private/var/..., not /var/...).
// A workspace that does not exist yet is taken as given.
export function sandboxProfile({ workspace, readRoots = [] }) {
  const ws = real(workspace) ?? resolve(workspace);
  const roots = [...new Set(readRoots.map(real).filter(Boolean))];
  const metadata = [...new Set([ws, ...roots, ...SYSTEM_SUBPATHS].flatMap(ancestors))].sort();
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow file-read-data (literal "/"))',
    '(allow file-read-metadata ' + metadata.map(path => '(literal ' + str(path) + ')').join(' ') + ')',
    '(allow file-read* ' + [...SYSTEM_SUBPATHS.map(path => '(subpath ' + str(path) + ')'), ...SYSTEM_LITERALS.map(path => '(literal ' + str(path) + ')'),
      '(subpath "/dev/fd")', ...roots.map(path => '(subpath ' + str(path) + ')'), '(subpath ' + str(ws) + ')'].join(' ') + ')',
    '(allow file-write-data ' + DEVICE_WRITES.map(path => '(literal ' + str(path) + ')').join(' ') + ')',
    '(allow file-write* (require-all (subpath ' + str(ws) + ') ' + READ_ONLY_PARTS.map(part => '(require-not (subpath ' + str(join(ws, part)) + '))').join(' ') + '))',
  ];
  return lines.join('\n') + '\n';
}

// The environment of a sandboxed command: nothing from the runner or the loop.
export function sandboxEnvironment({ workspace, nodeBin }) {
  const ws = real(workspace) ?? workspace, tmp = join(ws, 'tmp');
  return { PATH: nodeBin + ':' + BASE_PATH, HOME: tmp, TMPDIR: tmp, LANG: 'en_US.UTF-8' };
}

// Runs one command under the profile. stdout and stderr are interleaved in
// arrival order into one text; at most `keepChars` are kept from each end
// (the rest is counted). The command's whole process group is killed when it
// ends or times out, so nothing it started outlives the call.
export function runSandboxed({ profile, env, cwd, command, args = null, seconds = 120, keepChars = 20000, signal }) {
  return new Promise(resolve => {
    const started = Date.now();
    const argv = args ? [command, ...args] : [SHELL, '-c', command];
    let child;
    try { child = spawn(SANDBOX_EXEC, ['-p', profile, ...argv], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ exit_code: null, signal: null, timed_out: false, output: '', total_chars: 0, error: error.message, ms: 0 }); return; }
    let head = '', tail = '', total = 0, timedOut = false, settled = false, launchError = null;
    const take = bytes => {
      const text = bytes.toString('utf8');
      total += text.length;
      if (head.length < keepChars) { const room = keepChars - head.length; head += text.slice(0, room); if (text.length > room) tail = (tail + text.slice(room)).slice(-keepChars); }
      else tail = (tail + text).slice(-keepChars);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const stop = () => { if (child.pid) killTree(child.pid, 'SIGKILL'); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, seconds * 1000);
    const onAbort = () => stop();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', error => { launchError = error.message; });
    child.on('close', (code, endSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Whatever the command left running in its group goes too.
      if (child.pid) killTree(child.pid, 'SIGKILL');
      const kept = head.length + tail.length;
      resolve({ exit_code: code, signal: endSignal, timed_out: timedOut, head, tail, dropped: Math.max(0, total - kept), total_chars: total,
        error: launchError, ms: Date.now() - started });
    });
  });
}
