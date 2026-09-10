import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const objectHash = (data) => sha256(canonical(data));
export const readJSON = async (path) => JSON.parse(await readFile(path, 'utf8'));
export async function writeJSON(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + process.pid + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, path);
}
export function contained(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.includes('\0')) throw new Error('Expected a relative contained path');
  const full = resolve(root, path), rel = relative(resolve(root), full);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Path escapes its root');
  return full;
}
export async function existingContained(root, path) {
  const base = await realpath(root), full = await realpath(contained(base, path));
  const rel = relative(base, full);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Symlink escapes its root');
  return full;
}
export async function verifySources(task, root) {
  const results = [];
  for (const item of task.inputs) {
    const path = await existingContained(root, item.path);
    const bytes = await readFile(path);
    if (sha256(bytes) !== item.sha256 || bytes.length !== item.bytes) throw new Error('Input lock mismatch: ' + item.path);
    results.push({ path: item.path, sha256: item.sha256, bytes: bytes.length });
  }
  return results;
}
