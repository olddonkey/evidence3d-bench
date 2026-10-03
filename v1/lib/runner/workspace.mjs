import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, lstat, readlink, copyFile, link, chmod, rename, realpath, open, unlink } from 'node:fs/promises';
import { writeFileSync, renameSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { canonical } from '../../../lib/io.mjs';
import { validateTask } from '../contract.mjs';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const objectHash = value => sha256(canonical(value));

// Hashes are cached per inode and change times: the runtime is hard-linked
// into every workspace, and any write to a file moves its mtime/ctime, so a
// modified file is always re-read.
const hashCache = new Map();
export async function sha256File(path) {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat(), key = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
    if (hashCache.has(key)) return hashCache.get(key);
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const digest = hash.digest('hex');
    if (hashCache.size > 200000) hashCache.clear();
    hashCache.set(key, digest);
    return digest;
  } finally { await handle.close().catch(() => {}); }
}

export async function readJSON(path) { return JSON.parse(await readFile(path, 'utf8')); }

// Atomic JSON write: a reader (or a restarted runner) sees the old file or the
// whole new one, never a torn one. The temporary name is unique per call, so
// concurrent attempts writing the batch summary never share a temporary file.
// `exclusive` publishes with link(), which fails if the target exists, so a
// result is written once and whole even if the runner is killed mid-write.
let writeCounter = 0;
export async function writeJSON(path, value, { exclusive = false } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const text = JSON.stringify(value, null, 2) + '\n';
  const temporary = path + '.' + process.pid + '.' + (++writeCounter) + '.tmp';
  await writeFile(temporary, text, { flag: 'wx' });
  try {
    if (!exclusive) await rename(temporary, path);
    else {
      try { await link(temporary, path); }
      catch (error) {
        // A filesystem without hard links still gets an exclusive (if not atomic) write.
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) throw error;
        await writeFile(path, text, { flag: 'wx' });
      }
    }
  } finally { if (exclusive) await unlink(temporary).catch(() => {}); }
}

// The same, synchronously: for records that must be on disk before anything
// else can happen (the pid of a process just spawned, so a restarted runner
// can always find and stop it).
export function writeJSONSync(path, value) {
  const temporary = path + '.' + process.pid + '.' + (++writeCounter) + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  renameSync(temporary, path);
}

// Temporary files of writeJSON left by a process that is gone.
export const STALE_TEMPORARY = /\.json\.(\d+)\.\d+\.tmp$/;

export function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

// Every entry under root, sorted, without following symlinks. A symlink is
// recorded with its target, so a link planted by a contestant shows up as a
// change instead of silently pulling in whatever it points at.
export async function inventory(root, prefix = '') {
  const entries = [];
  let names;
  try { names = (await readdir(join(root, prefix))).sort(); } catch (error) { if (error.code === 'ENOENT' && !prefix) return []; throw error; }
  for (const name of names) {
    const path = prefix ? prefix + '/' + name : name, full = join(root, path), info = await lstat(full);
    if (info.isSymbolicLink()) entries.push({ path, type: 'symlink', target: await readlink(full) });
    else if (info.isDirectory()) entries.push(...await inventory(root, path));
    else if (info.isFile()) entries.push({ path, type: 'file', bytes: info.size, sha256: await sha256File(full) });
    else entries.push({ path, type: 'other' });
  }
  return entries;
}

export const inventoryHash = entries => objectHash(entries);

// Files are left read-only on disk as a second layer behind the sandbox
// policy; directories stay writable for the operator so a batch can be deleted.
export async function makeReadOnly(root) {
  for (const entry of await inventory(root)) if (entry.type === 'file') await chmod(join(root, entry.path), 0o444);
}

async function copyTree(source, destination, { hardlink = false } = {}) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      // Packages are copied dereferenced; a link that leaves the tree is refused.
      const target = await realpath(from);
      if (!inside(source, target)) throw new Error('Refusing to copy a symlink that leaves ' + source + ': ' + from);
      const info = await lstat(target);
      if (info.isDirectory()) await copyTree(target, to, { hardlink });
      else await copyFile(target, to);
    } else if (entry.isDirectory()) await copyTree(from, to, { hardlink });
    else if (entry.isFile()) {
      if (hardlink) {
        try { await link(from, to); continue; } catch (error) { if (!['EXDEV', 'EPERM', 'EMLINK'].includes(error.code)) throw error; }
      }
      await copyFile(from, to);
    }
  }
}

// The read-only runtime shared by all attempts of a batch: node_modules/three
// copied from the repository's installed package.
export async function buildRuntime({ repoRoot, runtimeDir }) {
  const source = join(repoRoot, 'node_modules', 'three');
  const pkg = await readJSON(join(source, 'package.json'));
  await copyTree(source, join(runtimeDir, 'node_modules', 'three'));
  await makeReadOnly(runtimeDir);
  // Hashed relative to node_modules/, exactly as a workspace's copy is hashed.
  const files = await inventory(join(runtimeDir, 'node_modules'));
  return { three_version: pkg.version, sha256: inventoryHash(files), files: files.length };
}

// Copies the public task pack (task.json plus exactly the inputs it lists) and
// checks every input against its hash lock. Nothing else in the task directory
// is copied, so a stray file there cannot reach a contestant.
export async function copyTaskPack(taskDir, destination) {
  const taskBytes = await readFile(join(taskDir, 'task.json'));
  const task = validateTask(JSON.parse(taskBytes.toString('utf8')));
  await mkdir(join(destination, 'inputs'), { recursive: true });
  await writeFile(join(destination, 'task.json'), taskBytes);
  for (const item of task.inputs) {
    const from = join(taskDir, item.path), info = await lstat(from);
    if (!info.isFile()) throw new Error('Task input is not a regular file: ' + item.path);
    const bytes = await readFile(from);
    if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error('Task input does not match its lock: ' + task.id + ' ' + item.path);
    await writeFile(join(destination, item.path), bytes);
  }
  return task;
}

export const WORKSPACE_PACKAGE = { private: true, type: 'module' };

// Builds one contestant workspace:
//   input/ (task pack) tools/ (preview kit) node_modules/three (runtime) output/ tmp/ package.json
// The package.json stops Node's package-scope lookup at the workspace: without
// it Node walks up into the (unreadable) repository and fails to load modules.
export async function buildWorkspace({ workspace, taskDir, toolsDir, runtimeDir }) {
  await mkdir(workspace, { recursive: true });
  const task = await copyTaskPack(taskDir, join(workspace, 'input'));
  await copyTree(toolsDir, join(workspace, 'tools'));
  await copyTree(join(runtimeDir, 'node_modules'), join(workspace, 'node_modules'), { hardlink: true });
  await mkdir(join(workspace, 'output'));
  await mkdir(join(workspace, 'tmp'));
  await writeFile(join(workspace, 'package.json'), JSON.stringify(WORKSPACE_PACKAGE) + '\n');
  await makeReadOnly(join(workspace, 'input'));
  await makeReadOnly(join(workspace, 'tools'));
  return { task, hashes: await workspaceHashes(workspace) };
}

// The parts of a workspace the contestant must not be able to change.
export async function workspaceHashes(workspace) {
  return {
    input: inventoryHash(await inventory(join(workspace, 'input'))),
    tools: inventoryHash(await inventory(join(workspace, 'tools'))),
    runtime: inventoryHash(await inventory(join(workspace, 'node_modules'))),
  };
}

// Reads output/model.glb the way a careful evaluator must: the runner reads it
// outside the sandbox, so a symlink or a hard link planted by the contestant
// could otherwise make the runner score a file the contestant cannot read
// itself (the hidden truth model, for example).
export async function readArtifact(workspace, relativePath, { maxBytes }) {
  const output = join(workspace, 'output'), path = join(workspace, relativePath);
  if (!inside(output, path)) return { present: false, problem: 'artifact path is outside output/' };
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return { present: false, problem: null }; throw error; }
  if (info.isSymbolicLink()) return { present: true, problem: 'artifact is a symlink' };
  if (!info.isFile()) return { present: true, problem: 'artifact is not a regular file' };
  if (info.nlink !== 1) return { present: true, problem: 'artifact has ' + info.nlink + ' hard links' };
  for (let dir = dirname(path); inside(output, dir) && dir !== output; dir = dirname(dir)) {
    if ((await lstat(dir)).isSymbolicLink()) return { present: true, problem: 'artifact path runs through a symlink' };
  }
  if ((await lstat(output)).isSymbolicLink()) return { present: true, problem: 'output/ is a symlink' };
  if (info.size > maxBytes) return { present: true, bytes: info.size, problem: 'artifact is ' + info.size + ' bytes, over the ' + maxBytes + ' byte budget' };
  const bytes = await readFile(path);
  return { present: true, bytes: bytes.length, sha256: sha256(bytes), data: bytes, problem: null };
}
