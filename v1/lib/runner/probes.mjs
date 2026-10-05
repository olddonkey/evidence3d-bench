// Isolation probes. A probe plan lists paths and endpoints together with what
// the boundary must do to them (allow or deny). The probe script runs inside a
// contestant workspace through the harness's own sandbox and reports what it
// observed; evaluation then prefers ground truth the contestant cannot fake:
// listener hit counts, files on disk, canary tokens appearing in tool output.
// Anything that could not be evaluated fails the preflight.

// Runs inside the sandbox with only Node built-ins. It never prints file
// contents or environment values: reads report whether they succeeded and
// whether the canary token was in what came back.
export const PROBE_SCRIPT = String.raw`import fs from 'node:fs';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const plan = JSON.parse(fs.readFileSync(new URL('./plan.json', import.meta.url), 'utf8'));
const results = {};
const error = e => 'denied:' + (e && e.code ? e.code : String(e && e.message || e).slice(0, 60));
// A short hash of whatever was read, so the runner can recognise the canary
// without the canary text ever being written into the workspace.
const digest = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
for (const probe of plan.probes) {
  try {
    if (probe.kind === 'read') {
      const bytes = fs.readFileSync(probe.path);
      results[probe.id] = { outcome: 'allowed', sha256_16: digest(bytes), bytes: bytes.length };
    } else if (probe.kind === 'list') {
      results[probe.id] = { outcome: 'allowed', entries: fs.readdirSync(probe.path).length };
    } else if (probe.kind === 'open') {
      // Credential files: opened for reading and closed, never read.
      fs.closeSync(fs.openSync(probe.path, 'r'));
      results[probe.id] = { outcome: 'allowed' };
    } else if (probe.kind === 'write') {
      // An existing file is made writable first, as a contestant would: the
      // read-only file mode is not the boundary, the sandbox is.
      let chmod = null;
      if (probe.same) { try { fs.chmodSync(probe.path, 0o644); chmod = 'allowed'; } catch (e) { chmod = error(e); } }
      results[probe.id] = { outcome: 'pending', chmod };
      fs.writeFileSync(probe.path, probe.same ? fs.readFileSync(probe.path) : 'e3d-probe\n');
      results[probe.id] = { outcome: 'allowed', chmod };
    } else if (probe.kind === 'hardlink') {
      fs.linkSync(probe.from, probe.to);
      let sha256_16 = null;
      try { sha256_16 = digest(fs.readFileSync(probe.to)); } catch {}
      results[probe.id] = { outcome: 'allowed', sha256_16 };
    } else if (probe.kind === 'exec') {
      const run = spawnSync(probe.command, probe.args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, encoding: 'latin1' });
      results[probe.id] = { outcome: run.error ? error(run.error) : 'ran', status: run.status,
        stdout: probe.echo ? run.stdout.slice(0, 400) : undefined, stderr: probe.echo ? run.stderr.slice(0, 400) : undefined };
    } else if (probe.kind === 'import') {
      const module = await import(probe.specifier);
      results[probe.id] = { outcome: 'allowed', value: String(module[probe.export] ?? '') };
    } else if (probe.kind === 'env') {
      results[probe.id] = { outcome: 'ran', names: Object.keys(process.env).sort() };
    }
  } catch (e) { results[probe.id] = { ...results[probe.id], outcome: error(e) }; }
}
const connect = probe => new Promise(resolve => {
  const socket = probe.kind === 'unix' ? net.connect({ path: probe.path ?? process.env[probe.env] ?? '/nonexistent/e3d.sock' }) : net.connect({ host: probe.host, port: probe.port });
  const finish = value => { socket.destroy(); resolve(value); };
  socket.setTimeout(probe.timeout_ms ?? 5000, () => finish({ outcome: 'timeout' }));
  socket.on('connect', () => finish({ outcome: 'connected' }));
  socket.on('error', e => finish({ outcome: error(e) }));
});
for (const probe of plan.probes) if (probe.kind === 'tcp' || probe.kind === 'unix') {
  if (probe.kind === 'unix' && probe.env && !process.env[probe.env]) { results[probe.id] = { outcome: 'absent' }; continue; }
  results[probe.id] = await connect(probe);
}
console.log('E3D-PROBE ' + JSON.stringify({ version: plan.version, results }));
`;

export const PROBE_VERSION = 'e3d-probe-v1';
export const INTERNET = { host: '1.1.1.1', port: 443, url: 'https://example.com/' };
export const CANARY_PREFIX = 'E3D-CANARY-';

// Credential-like names a harness itself puts into its sandboxed shell and
// what makes them harmless (each is verified by another probe):
//   CLAUDE_CODE_MESSAGING_TOKEN  the session's own inbox token; Unix sockets are blocked (unix-messaging probe)
//   CLOUDSDK_PROXY_PASSWORD/USERNAME  credentials for the sandbox's own filtering proxy, which allows no domain (http-internet probe)
export const HARNESS_ENV_ALLOWED = new Set(['CLAUDE_CODE_MESSAGING_TOKEN', 'CLOUDSDK_PROXY_PASSWORD', 'CLOUDSDK_PROXY_USERNAME']);

// Builds the plan. `paths` holds absolute paths the runner prepared and checked
// from outside the sandbox; `exists` says which deny targets really exist (a
// probe of a missing path proves nothing and is reported as not evaluated).
// `internet` can point the two internet probes elsewhere (tests use a closed
// local port so they never touch the network).
export function probePlan({ paths, network, keychain, credentialName, internet = INTERNET }) {
  const probes = [];
  const add = (probe, expect, note) => probes.push({ ...probe, expect, note });
  add({ id: 'input-read', kind: 'read', path: 'input/task.json' }, 'allow', 'task pack is readable');
  add({ id: 'input-write', kind: 'write', path: 'input/task.json', same: true }, 'deny', 'task pack cannot be modified');
  add({ id: 'input-create', kind: 'write', path: 'input/.e3d-probe-write' }, 'deny', 'nothing can be added to the task pack');
  add({ id: 'tools-write', kind: 'write', path: paths.toolsFile, same: true }, 'deny', 'preview kit cannot be modified');
  add({ id: 'runtime-write', kind: 'write', path: 'node_modules/three/package.json', same: true }, 'deny', 'three runtime cannot be modified');
  add({ id: 'output-write', kind: 'write', path: 'output/.e3d-probe-write' }, 'allow', 'output/ is writable');
  add({ id: 'tmp-write', kind: 'write', path: 'tmp/.e3d-probe-write' }, 'allow', 'tmp/ is writable');
  add({ id: 'canary-direct', kind: 'read', path: paths.canaryFile }, 'deny', 'file outside the workspace');
  add({ id: 'canary-symlink', kind: 'read', path: '.e3d-probe/link-file' }, 'deny', 'outside file through a symlink planted in the workspace');
  add({ id: 'canary-dir-symlink', kind: 'read', path: '.e3d-probe/link-dir/canary.txt' }, 'deny', 'outside directory through a symlink planted in the workspace');
  add({ id: 'canary-hardlink', kind: 'hardlink', from: paths.canaryFile, to: '.e3d-probe/hardlink' }, 'deny', 'hard link to an outside file');
  add({ id: 'outside-write', kind: 'write', path: paths.outsideWrite }, 'deny', 'file outside the workspace cannot be created');
  add({ id: 'outside-symlink-write', kind: 'write', path: '.e3d-probe/link-out' }, 'deny', 'outside file cannot be written through a symlink');
  add({ id: 'outside-dangling-write', kind: 'write', path: '.e3d-probe/dangling-shell' }, 'deny', 'no file can be created outside through a dangling symlink');
  add({ id: 'outside-dir-symlink-write', kind: 'write', path: '.e3d-probe/link-dir/shell-new.txt' }, 'deny', 'no file can be created inside a symlinked outside directory');
  for (const [id, path, kind, note] of paths.denied) add({ id, kind, path }, 'deny', note);
  add({ id: 'three-import', kind: 'import', specifier: 'three', export: 'REVISION' }, 'allow', 'three is importable');
  add({ id: 'preview-tool', kind: 'exec', command: paths.node, args: ['tools/preview.mjs', '.e3d-probe/sample.glb', '--out', '.e3d-probe/preview',
    '--views', 'front', '--size', '192', '--aa', '1'], echo: true }, 'allow', 'preview tool runs and writes a PNG');
  add({ id: 'env-names', kind: 'env' }, 'clean', 'no credential-like environment variables');
  if (keychain) add({ id: 'keychain', kind: 'exec', command: '/usr/bin/security', args: ['find-generic-password', '-s', keychain] }, 'deny', 'login keychain entry is unreadable');
  add({ id: 'tcp-loopback', kind: 'tcp', host: '127.0.0.1', port: network.loopbackPort }, 'deny', 'loopback TCP to a runner-owned listener');
  add({ id: 'unix-socket', kind: 'unix', path: network.unixSocket }, 'deny', 'Unix socket owned by the runner');
  add({ id: 'unix-messaging', kind: 'unix', env: 'CLAUDE_CODE_MESSAGING_SOCKET' }, 'deny', "the harness's own inter-session socket");
  add({ id: 'tcp-internet', kind: 'tcp', host: internet.host, port: internet.port }, 'deny', 'direct internet TCP');
  add({ id: 'http-internet', kind: 'exec', command: '/usr/bin/curl', args: ['-sS', '-m', '8', '-o', '/dev/null', '-w', '%{http_code}', internet.url], echo: true },
    'deny', 'HTTPS through whatever proxy the harness sets');
  return { version: PROBE_VERSION, credential_name: credentialName.source, probes };
}

// The probe script's JSON line, found in any text (a tool result or stdout).
export function extractProbeOutput(text) {
  const at = String(text).lastIndexOf('E3D-PROBE ');
  if (at < 0) return null;
  const line = String(text).slice(at + 'E3D-PROBE '.length).split('\n')[0];
  try { return JSON.parse(line); } catch { return null; }
}

const denied = outcome => typeof outcome === 'string' && (outcome.startsWith('denied:') || outcome === 'timeout' || outcome === 'absent');

// Judges every probe of the plan. `observed` is the probe script output (or
// null), `ground` holds the runner's own observations.
export function evaluateProbes(plan, observed, ground) {
  const checks = [];
  for (const probe of plan.probes) {
    const seen = observed?.results?.[probe.id];
    const check = { id: probe.id, expect: probe.expect, note: probe.note, observed: seen ?? null, status: 'not_evaluated', reason: null };
    checks.push(check);
    if (ground.missing?.has(probe.id)) { check.status = 'not_evaluated'; check.reason = 'target does not exist on this machine'; continue; }
    if (!seen) { check.reason = 'the probe did not report this check'; continue; }
    const fail = reason => { check.status = 'fail'; check.reason = reason; };
    const pass = () => { check.status = 'pass'; };
    const canary = seen.sha256_16 && seen.sha256_16 === ground.canarySha16 ? ' and the canary came back' : '';
    if (probe.kind === 'read' || probe.kind === 'list' || probe.kind === 'open') {
      if (probe.expect === 'allow') seen.outcome === 'allowed' ? pass() : fail('expected readable, got ' + seen.outcome);
      else if (seen.outcome === 'allowed') fail('readable' + canary);
      else denied(seen.outcome) ? pass() : fail('unexpected outcome ' + seen.outcome);
    } else if (probe.kind === 'write') {
      const onDisk = ground.writes?.[probe.id];
      if (probe.expect === 'allow') (seen.outcome === 'allowed' && onDisk !== false) ? pass() : fail('expected writable, got ' + seen.outcome);
      else if (seen.outcome === 'allowed' || onDisk === true) fail('write succeeded');
      else if (seen.chmod === 'allowed') fail('the file mode could be changed, so only its read-only mode stopped the write');
      else denied(seen.outcome) ? pass() : fail('unexpected outcome ' + seen.outcome);
    } else if (probe.kind === 'hardlink') {
      if (seen.outcome === 'allowed') fail('hard link created' + canary);
      else pass();
    } else if (probe.kind === 'import') {
      seen.outcome === 'allowed' && seen.value === ground.threeRevision ? pass() : fail('three did not import: ' + JSON.stringify(seen));
    } else if (probe.kind === 'env') {
      const bad = (seen.names ?? []).filter(name => new RegExp(plan.credential_name, 'i').test(name) && !HARNESS_ENV_ALLOWED.has(name));
      bad.length ? fail('credential-like variables: ' + bad.join(', ')) : pass();
    } else if (probe.id === 'preview-tool') {
      seen.outcome === 'ran' && seen.status === 0 && ground.previewImage?.ok ? pass()
        : fail('preview tool failed: status ' + seen.status + ', image ' + JSON.stringify(ground.previewImage ?? null) + ', stderr ' + (seen.stderr ?? ''));
    } else if (probe.id === 'keychain') {
      if (seen.outcome !== 'ran') denied(seen.outcome) ? pass() : fail('unexpected outcome ' + seen.outcome);
      else seen.status === 0 ? fail('keychain entry readable') : pass();
    } else if (probe.id === 'http-internet') {
      const code = Number(String(seen.stdout ?? '').trim());
      if (seen.outcome === 'ran' && code >= 200 && code < 400) fail('HTTP ' + code + ' from the internet');
      else pass();
    } else if (probe.kind === 'tcp' || probe.kind === 'unix') {
      const hits = ground.hits?.[probe.id];
      if (seen.outcome === 'connected' || (hits ?? 0) > 0) fail('connection succeeded' + (hits ? ' (' + hits + ' accepted by the runner)' : ''));
      else if (seen.outcome === 'absent' && probe.env) { check.status = 'not_applicable'; check.reason = probe.env + ' is not set by this harness'; }
      else denied(seen.outcome) ? pass() : fail('unexpected outcome ' + seen.outcome);
    }
  }
  return checks;
}

export function verdict(checks) {
  const failed = checks.filter(check => check.status === 'fail'), open = checks.filter(check => check.status === 'not_evaluated');
  return { passed: failed.length === 0 && open.length === 0, failed: failed.map(check => check.id), not_evaluated: open.map(check => check.id) };
}
