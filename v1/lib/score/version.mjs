import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Which scorer wrote a report. A report re-scored later must be told apart
// from one written at run time, and two reports compared only when the same
// code produced them: `version` names the scoring definition (bump it whenever
// a number in the report can change), `sha256` pins the exact code.
// 1.0.0 (2cef4f9, reports without this stamp): shape 1 / 2 / 5 % of the
// diagonal, point to point. 1.1.0: shape 0.25 / 0.5 / 1 %, point to visible
// surface, fine pose stage (README "Choosing the tolerances").
export const SCORER_VERSION = '1.1.0';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../../..');

// Every .mjs in this directory and, transitively, every repository file they
// import by relative path (the kernel and the v0 helpers it uses). Packages
// (three) are pinned by package-lock.json and not hashed here.
function sourceFiles() {
  const seen = new Set(), queue = readdirSync(here).filter(name => name.endsWith('.mjs')).map(name => join(here, name));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)['"](\.{1,2}\/[^'"]+)['"]/gm)) queue.push(resolve(dirname(file), match[1]));
  }
  return [...seen].map(file => relative(root, file).split('\\').join('/')).sort();
}

// sha256 over, per file in path order: the repository-relative path, a NUL,
// the byte length, a NUL, the bytes. Computed once, when the scorer is loaded.
function sourceHash(files) {
  const hash = createHash('sha256');
  for (const file of files) {
    const bytes = readFileSync(join(root, file));
    hash.update(file + '\0' + bytes.length + '\0');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export const SCORER_FILES = Object.freeze(sourceFiles());
export const SCORER = Object.freeze({ version: SCORER_VERSION, sha256: sourceHash(SCORER_FILES) });
