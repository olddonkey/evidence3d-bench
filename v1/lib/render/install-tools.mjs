import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

// Installs the contestant preview kit: everything in v1/tools/ plus copies of
// the kernel rasterizer and PNG encoder under kernel/. The kit is checked for
// self-containment before anything is written: it may import only Node
// built-ins, three, and its own files, so no scoring code, truth or repository
// path can reach the contestant's sandbox through it.
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = resolve(HERE, '../../tools');
const KERNEL_DIR = resolve(HERE, '..');
const KERNEL_FILES = ['raster.mjs', 'png.mjs'];
const REPO_ROOT = resolve(HERE, '../../..');

// Import specifiers in an ES module: static imports/exports and dynamic import().
export function importSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.add(match[1]);
  // A dynamic import of a computed string cannot be checked, so it is refused.
  if (/\bimport\s*\(\s*[^'"\s)]/.test(source)) found.add('<computed dynamic import>');
  return [...found];
}

// files: Map of kit-relative path -> source text.
export function checkSelfContained(files) {
  const problems = [];
  for (const [path, source] of files) {
    if (source.includes(REPO_ROOT)) problems.push(path + ' contains the repository path');
    if (!path.endsWith('.mjs') && !path.endsWith('.js')) continue;
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith('node:') || specifier === 'three' || specifier.startsWith('three/')) continue;
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const target = posix.normalize(posix.join(posix.dirname(path), specifier));
        if (!target.startsWith('../') && files.has(target)) continue;
      }
      problems.push(path + ' imports ' + specifier);
    }
  }
  if (problems.length) throw new Error('Preview kit is not self-contained: ' + problems.join('; '));
}

export async function installTools(destination) {
  if (typeof destination !== 'string' || !destination) throw new Error('installTools needs a destination directory');
  const files = new Map();
  for (const entry of await readdir(TOOLS_DIR, { withFileTypes: true })) {
    // The kit is flat; hidden files (editor droppings) are not part of it.
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    files.set(entry.name, await readFile(join(TOOLS_DIR, entry.name), 'utf8'));
  }
  for (const name of KERNEL_FILES) files.set('kernel/' + name, await readFile(join(KERNEL_DIR, name), 'utf8'));
  if (!files.has('preview.mjs') || !files.has('README.md')) throw new Error('v1/tools is missing preview.mjs or README.md');
  checkSelfContained(files);
  const target = resolve(destination);
  await mkdir(join(target, 'kernel'), { recursive: true });
  for (const [path, source] of files) await writeFile(join(target, path), source);
  return { destination: target, files: [...files.keys()].sort() };
}
