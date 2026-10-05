import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { encodePNG, decodePNG } from '../lib/png.mjs';
import { createTools, prepareImage, clip, IMAGE_MAX_SIDE, TOOL_SPECS } from '../lib/runner/api/tools.mjs';
import { sandboxProfile, sandboxEnvironment, runSandboxed } from '../lib/runner/api/sandbox.mjs';
import { evaluateFileTools } from '../lib/runner/api/preflight.mjs';
import { startListeners } from '../lib/runner/preflight.mjs';
import { probePlan, evaluateProbes, extractProbeOutput, verdict, PROBE_SCRIPT } from '../lib/runner/probes.mjs';
import { nodeRuntime } from '../lib/runner/adapters.mjs';
import { CREDENTIAL_NAME } from '../lib/runner/process.mjs';
import { fakeInstallTools } from '../lib/runner/api/mock/fixtures.mjs';
import { ANTHROPIC } from '../lib/runner/api/anthropic.mjs';
import { OPENAI } from '../lib/runner/api/openai.mjs';

// The boundary of the API systems: the file tools confine themselves in code
// (they run in the loop, outside the sandbox) and the shell runs under the
// generated Seatbelt profile. Both are exercised on a probe site laid out as
// preflight lays it out: canaries outside the workspace, and planted escape
// routes inside it (file and directory symlinks, a dangling symlink, a hard
// link, `..`).
const solid = (r, g, b, size = 48) => encodePNG(size, size, new Uint8Array(size * size * 3).map((_, i) => [r, g, b][i % 3]), 3);

async function site(t) {
  const root = await mkdtemp(join(tmpdir(), 'e3d-api-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = join(root, 'secret'), workspace = join(root, 'workspace'), probe = join(workspace, '.e3d-probe');
  for (const dir of [secret, join(workspace, 'input'), join(workspace, 'output'), join(workspace, 'tmp'), join(workspace, 'node_modules', 'three'), probe]) await mkdir(dir, { recursive: true });
  await fakeInstallTools(join(workspace, 'tools'));
  await writeFile(join(workspace, 'input', 'task.json'), '{"schema":"e3d-task-v1","id":"t"}\n');
  await writeFile(join(workspace, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(workspace, 'node_modules', 'three', 'package.json'), '{"name":"three","type":"module","exports":"./index.js"}\n');
  await writeFile(join(workspace, 'node_modules', 'three', 'index.js'), "export const REVISION = '180';\n");
  const canary = 'E3D-CANARY-' + Math.random().toString(16).slice(2);
  await writeFile(join(secret, 'canary.txt'), canary + '\n');
  await writeFile(join(secret, 'outside.txt'), 'OUTSIDE-ORIGINAL\n');
  await writeFile(join(secret, 'canary.png'), solid(255, 0, 255));
  await writeFile(join(secret, 'linked.png'), solid(255, 140, 0));
  await writeFile(join(probe, 'control.png'), solid(30, 80, 255));
  await writeFile(join(probe, 'sample.glb'), 'glTF');
  await symlink(join(secret, 'canary.txt'), join(probe, 'link-file'));
  await symlink(secret, join(probe, 'link-dir'));
  await symlink(join(secret, 'outside.txt'), join(probe, 'link-out'));
  await symlink(join(secret, 'linked.png'), join(probe, 'link-image.png'));
  for (const name of ['dangling-shell', 'dangling-agent']) await symlink(join(secret, name + '-written.txt'), join(probe, name));
  const node = await nodeRuntime();
  const sandbox = { profile: sandboxProfile({ workspace, readRoots: node.read_roots }), env: sandboxEnvironment({ workspace, nodeBin: node.bin }) };
  return { root, secret, workspace, probe, canary, node, sandbox };
}

test('the file tools refuse every escape route and keep the controls working', async t => {
  const s = await site(t);
  const tools = createTools({ workspace: s.workspace, sandbox: s.sandbox });
  const checks = await evaluateFileTools(s, tools);
  const failed = checks.filter(check => check.status !== 'pass');
  assert.deepEqual(failed, [], JSON.stringify(failed, null, 1));
  assert.ok(checks.length >= 26, 'every route was tried: ' + checks.length);
  for (const id of ['read-canary', 'read-symlink', 'read-dir-symlink', 'read-dangling', 'read-hardlink', 'read-dotdot', 'list-secret', 'list-dir-symlink', 'list-dotdot',
    'view-canary', 'view-symlink', 'view-hardlink', 'view-dotdot', 'write-input', 'write-tools', 'write-runtime', 'write-outside', 'write-symlink', 'write-dangling',
    'write-dir-symlink', 'write-dotdot', 'write-hardlink']) assert.ok(checks.find(check => check.id === 'agent:' + id), id);
  // Nothing outside changed, and nothing was created there.
  assert.deepEqual((await readdir(s.secret)).sort(), ['canary.png', 'canary.txt', 'linked.png', 'outside.txt']);
  assert.equal(await readFile(join(s.secret, 'outside.txt'), 'utf8'), 'OUTSIDE-ORIGINAL\n');
  assert.equal(await readFile(join(s.secret, 'canary.txt'), 'utf8'), s.canary + '\n');
  // A symlink that stays inside the workspace is followed; one that leads out
  // is refused with the same words whether or not its target exists, so a
  // planted link cannot tell what exists outside.
  await symlink(join(s.workspace, 'input'), join(s.workspace, 'in'));
  assert.match((await tools.run('read_file', { path: 'in/task.json' })).text, /e3d-task-v1/);
  const there = await tools.run('read_file', { path: '.e3d-probe/link-dir/canary.txt' }), absent = await tools.run('read_file', { path: '.e3d-probe/link-dir/none.txt' });
  assert.equal(there.text, absent.text);
  // The runtime under node_modules/ is hard-linked by the runner and stays readable.
  await link(join(s.workspace, 'node_modules', 'three', 'index.js'), join(s.root, 'runtime-copy.js'));
  assert.equal((await tools.run('read_file', { path: 'node_modules/three/index.js' })).ok, true);
});

test('preflight\'s file-tool evaluation fails on a leak (the check is not vacuous)', async t => {
  const s = await site(t);
  // An unconfined stand-in: reads anything, writes anything.
  const leaky = { async run(name, args) {
    const path = args.path.startsWith('/') ? args.path : join(s.workspace, args.path);
    if (name === 'write_file') { try { await writeFile(path, args.content); return { ok: true, text: 'wrote' }; } catch (error) { return { ok: false, text: error.message }; } }
    if (name === 'list_dir') { try { return { ok: true, text: (await readdir(path)).join('\n') }; } catch (error) { return { ok: false, text: error.message }; } }
    try { const bytes = await readFile(path); return name === 'view_image' ? { ok: true, text: 'image', image: { media_type: 'image/png', data: bytes.toString('base64') } } : { ok: true, text: bytes.toString('utf8') }; }
    catch (error) { return { ok: false, text: error.message }; }
  } };
  const checks = Object.fromEntries((await evaluateFileTools(s, leaky)).map(check => [check.id.slice(6), check.status]));
  for (const id of ['read-canary', 'read-symlink', 'read-dir-symlink', 'read-hardlink', 'read-dotdot', 'list-secret', 'list-dir-symlink', 'view-canary', 'view-symlink',
    'write-outside', 'write-symlink', 'write-dir-symlink', 'write-dotdot', 'write-hardlink', 'write-input']) assert.equal(checks[id], 'fail', id);
  assert.equal(checks['read-input'], 'pass'); assert.equal(checks['view-control'], 'pass');
});

test('the shell runs under the sandbox: the probe script finds no way out, no network, and input/ is read-only', async t => {
  const s = await site(t);
  const listeners = await startListeners();
  t.after(() => listeners.close());
  const plan = probePlan({ credentialName: CREDENTIAL_NAME, keychain: null, internet: { host: '127.0.0.1', port: 1, url: 'http://127.0.0.1:1/' },
    network: { loopbackPort: listeners.loopbackPort, unixSocket: listeners.unixSocket },
    paths: { node: s.node.path, toolsFile: 'tools/preview.mjs', canaryFile: join(s.secret, 'canary.txt'), outsideWrite: join(s.secret, 'written.txt'),
      denied: [['outside-dir', s.secret, 'list', 'a directory beside the workspace'], ['slash-tmp', '/private/tmp', 'list', 'shared /tmp']] } });
  await writeFile(join(s.probe, 'plan.json'), JSON.stringify(plan));
  await writeFile(join(s.probe, 'probe.mjs'), PROBE_SCRIPT);
  const tools = createTools({ workspace: s.workspace, sandbox: s.sandbox });
  const result = await tools.run('shell', { command: 'node .e3d-probe/probe.mjs' });
  const observed = extractProbeOutput(result.text);
  assert.ok(observed, result.text);
  const writes = { 'input-write': null, 'input-create': await readFile(join(s.workspace, 'input', '.e3d-probe-write')).then(() => true, () => false),
    'output-write': await readFile(join(s.workspace, 'output', '.e3d-probe-write')).then(() => true, () => false),
    'tmp-write': await readFile(join(s.workspace, 'tmp', '.e3d-probe-write')).then(() => true, () => false),
    'outside-write': await readFile(join(s.secret, 'written.txt')).then(() => true, () => false) };
  const decoded = decodePNG(await readFile(join(s.probe, 'preview', 'front.png')));
  const checks = evaluateProbes(plan, observed, { hits: { ...listeners.hits }, writes, previewImage: { ok: decoded.width === 192 }, threeRevision: '180',
    canarySha16: 'unused' });
  const bad = checks.filter(check => check.status !== 'pass' && check.status !== 'not_applicable');
  assert.deepEqual(bad, [], JSON.stringify(bad, null, 1));
  for (const id of ['tcp-loopback', 'unix-socket', 'tcp-internet', 'http-internet', 'input-write', 'input-create', 'tools-write', 'runtime-write', 'canary-direct',
    'canary-symlink', 'canary-dir-symlink', 'canary-hardlink', 'outside-write', 'outside-symlink-write', 'outside-dangling-write', 'outside-dir-symlink-write', 'env-names']) {
    assert.equal(checks.find(check => check.id === id).status, 'pass', id);
  }
  assert.deepEqual(listeners.hits, { 'tcp-loopback': 0, 'unix-socket': 0 }, 'no connection reached the runner\'s listeners');
  // The same probe without the sandbox would have got out (the profile is what stops it).
  const open = execFileSync(s.node.path, ['.e3d-probe/probe.mjs'], { cwd: s.workspace, encoding: 'utf8' });
  assert.equal(extractProbeOutput(open).results['canary-direct'].outcome, 'allowed');
});

test('shell output is cut to 20,000 characters keeping both ends, a timeout kills the command, and nothing it started survives', async t => {
  const s = await site(t);
  const tools = createTools({ workspace: s.workspace, sandbox: s.sandbox });
  const long = await tools.run('shell', { command: "node -e \"process.stdout.write('A'.repeat(30000) + 'END')\"" });
  assert.equal(long.meta.truncated, true); assert.equal(long.meta.output_chars, 30003);
  assert.match(long.text, /^A{10000}\n\[\.\.\. 10003 characters left out \.\.\.\]\nA{9997}END\n\[exit code 0\]$/);
  const slow = await tools.run('shell', { command: 'sleep 20', timeout_seconds: 1 });
  assert.equal(slow.meta.timed_out, true); assert.match(slow.text, /timed out after 1 s/);
  const marker = 'e3d-orphan-' + Math.random().toString(16).slice(2);
  await tools.run('shell', { command: `(exec -a ${marker} sleep 30) > /dev/null 2>&1 & echo started` });
  await new Promise(resolve => setTimeout(resolve, 200));
  const left = execFileSync('/bin/ps', ['-A', '-o', 'args='], { encoding: 'utf8' }).split('\n').filter(line => line.includes(marker));
  assert.deepEqual(left, [], 'a background process outlived its shell call');
  assert.equal((await tools.run('shell', { command: 'exit 3' })).meta.exit_code, 3);
  assert.match((await tools.run('shell', { command: 'x', timeout_seconds: -1 })).text, /^refused: timeout_seconds/);
  assert.equal(clip('abc').truncated, false);
});

test('view_image scales large PNGs down to 2000 px, refuses large JPEGs and non-images, and both providers carry the image', async t => {
  const s = await site(t);
  const wide = encodePNG(2400, 30, new Uint8Array(2400 * 30 * 3).fill(200), 3);
  const small = prepareImage(solid(10, 20, 30));
  assert.equal(small.scaled_from, null); assert.equal(small.width, 48);
  const scaled = prepareImage(wide);
  assert.deepEqual([scaled.width, scaled.height, scaled.scaled_from.width], [IMAGE_MAX_SIDE, 25, 2400]);
  assert.equal(decodePNG(scaled.bytes).pixels[0], 200);
  // A JPEG header (SOI, APP0, SOF0 with its size); its pixels are never decoded.
  const jpeg = (width, height) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08]),
    Buffer.from([height >> 8, height & 255, width >> 8, width & 255]), Buffer.from([0x01, 0x01, 0x11, 0x00, 0xff, 0xd9])]);
  assert.equal(prepareImage(jpeg(1600, 1200)).media_type, 'image/jpeg');
  assert.throws(() => prepareImage(jpeg(2400, 1200)), /larger than 2000/);
  assert.throws(() => prepareImage(Buffer.from('GIF89a......')), /not a PNG or JPEG/);
  await writeFile(join(s.workspace, 'output', 'wide.png'), wide);
  const tools = createTools({ workspace: s.workspace, sandbox: s.sandbox });
  const view = await tools.run('view_image', { path: 'output/wide.png' });
  assert.match(view.text, /2000x25, shown scaled down from 2400x30/);
  const result = { id: 'call-1', ok: true, text: view.text, image: view.image };
  const anthropic = { messages: [] }, openai = { input: [] };
  ANTHROPIC.respond(anthropic, [result], 'notice');
  assert.deepEqual(anthropic.messages[0].content[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: view.image.data } });
  assert.deepEqual(anthropic.messages[0].content[1], { type: 'text', text: 'notice' }, 'text after the tool results');
  OPENAI.respond(openai, [result], null);
  assert.deepEqual(openai.input[0].output[1], { type: 'input_image', image_url: 'data:image/png;base64,' + view.image.data, detail: 'auto' });
  // One definition of the tools for both providers.
  assert.deepEqual(ANTHROPIC.tools(TOOL_SPECS).map(tool => [tool.name, tool.input_schema]), OPENAI.tools(TOOL_SPECS).map(tool => [tool.name, tool.parameters]));
  assert.ok(OPENAI.tools(TOOL_SPECS).every(tool => tool.strict === false));
  assert.deepEqual(ANTHROPIC.tools(TOOL_SPECS).map(tool => Boolean(tool.cache_control)), [false, false, false, false, true]);
});
