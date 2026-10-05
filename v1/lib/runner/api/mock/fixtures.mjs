import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { encodePNG } from '../../../png.mjs';
import { DEFAULT_BUDGET, layout } from '../../../contract.mjs';
import { objectHash } from '../../../../../lib/io.mjs';

// Test fixtures for the API systems' tests (v1/test/runner-*.test.mjs): a data
// root with task packs and truth records, a preview kit whose preview tool
// draws a real PNG (preflight checks that it is not blank) with Node
// built-ins only, since it runs inside the sandbox, and a fake scorer.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function makeDataRoot(root, taskIds, { wall = DEFAULT_BUDGET.wall_seconds, sets = {} } = {}) {
  const png = encodePNG(16, 12, new Uint8Array(16 * 12 * 3).map((_, i) => (i * 13) & 255), 3);
  for (const id of taskIds) {
    const task = { schema: 'e3d-task-v1', id, title: 'Two-storey gabled house', prompt: 'Rebuild the house.', variant: 't1',
      target_state: 'As photographed in 2025-09.', frame: { unit: 'metre', up: '+Y', origin: 'Front wall midpoint.', front: 'Front faces +Z.' },
      scale_evidence: 'none', inputs: [{ id: 'source-1', path: 'inputs/01-photo-front.png', kind: 'photo', captured_at: '2025-09',
        description: 'Front photograph', sha256: sha(png), bytes: png.length }],
      output: { model: 'output/model.glb', notes: 'output/notes.md', rules: ['GLB 2.0'] }, budget: { ...DEFAULT_BUDGET, wall_seconds: wall } };
    const paths = layout(root);
    await mkdir(join(paths.task(id), 'inputs'), { recursive: true });
    await writeFile(join(paths.task(id), 'inputs', '01-photo-front.png'), png);
    await writeFile(join(paths.task(id), 'task.json'), JSON.stringify(task, null, 2));
    await mkdir(paths.truth(id), { recursive: true });
    await writeFile(join(paths.truth(id), 'truth.json'), JSON.stringify({ schema: 'e3d-truth-v1', task_id: id, task_sha256: objectHash(task),
      object: 'fixture', variant: 't1', scale_evidence: 'none', evidence: ['photo-front'], alternates: [], ...(sets[id] ? { set: sets[id] } : {}) }));
  }
}

// node tools/preview.mjs <glb> --out <dir> [--views front] [--size N]: writes
// <dir>/<view>.png, a square with a drawn block in the middle.
const PREVIEW = String.raw`import fs from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
const args = process.argv.slice(2), at = name => args[args.indexOf(name) + 1];
const out = at('--out') ?? 'output/preview', size = Number(at('--size') ?? 64), views = (args.includes('--views') ? at('--views') : 'front').split(',');
if (!fs.existsSync(args[0])) { console.error('no such model ' + args[0]); process.exit(2); }
const chunk = (type, data) => { const head = Buffer.alloc(8), tail = Buffer.alloc(4); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0); return Buffer.concat([head, data, tail]); };
const raw = Buffer.alloc((size * 3 + 1) * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const inside = x > size / 4 && x < size * 3 / 4 && y > size / 4 && y < size * 3 / 4;
  raw.fill(inside ? 40 : 230, y * (size * 3 + 1) + 1 + x * 3, y * (size * 3 + 1) + 1 + x * 3 + 3); }
const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
fs.mkdirSync(out, { recursive: true });
for (const view of views) fs.writeFileSync(out + '/' + view + '.png', png);
console.log('wrote ' + views.length + ' view(s) to ' + out);
`;

export async function fakeInstallTools(destination) {
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'README.md'), '# Preview tool\n\nnode tools/preview.mjs output/model.glb --out output/preview\n');
  await writeFile(join(destination, 'preview.mjs'), PREVIEW);
  return { files: ['README.md', 'preview.mjs'] };
}

// A scorer that gives every GLB 71.5, refuses 'INVALID' and fails on 'THROW'.
export const fakeScorer = callLog => `import { appendFileSync } from 'node:fs';
export async function scoreSubmission({ glb, taskDir, truthDir, outDir }) {
  appendFileSync(${JSON.stringify(callLog)}, 'x');
  const text = glb.subarray(0, 7).toString('latin1');
  if (text === 'THROW') throw new Error('scorer exploded');
  if (text === 'INVALID') return { schema: 'e3d-report-v1', valid: false, error: 'Invalid GLB 2.0 header', score: 0 };
  return { schema: 'e3d-report-v1', protocol: 'evidence3d-v1.0.0', task_id: taskDir.split('/').pop(), valid: true, error: null, score: 71.5, bytes: glb.length };
}
`;

// The tool calls of a scripted model that builds output/model.glb (copied
// from base64 by a script it writes, then runs in the shell), writes its
// notes, previews and looks at the preview: every tool, as a session would.
export function buildSteps(glbBase64) {
  return [
    { text: 'Reading the task.', tools: [{ name: 'list_dir', args: { path: '.' } }, { name: 'read_file', args: { path: 'input/task.json' } }] },
    { tools: [{ name: 'view_image', args: { path: 'input/inputs/01-photo-front.png' } }] },
    { tools: [{ name: 'write_file', args: { path: 'tmp/build.mjs', content: "import fs from 'node:fs';\nfs.writeFileSync('output/model.glb', Buffer.from('" + glbBase64 + "', 'base64'));\nconsole.log('model written');\n" } }] },
    { tools: [{ name: 'shell', args: { command: 'node tmp/build.mjs && node tools/preview.mjs output/model.glb --out output/preview' } }] },
    { tools: [{ name: 'view_image', args: { path: 'output/preview/front.png' } }, { name: 'write_file', args: { path: 'output/notes.md', content: '# Notes\n\nA box.\n' } }] },
    { text: 'Built a two-storey house as a box.' },
  ];
}
