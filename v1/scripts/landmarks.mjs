#!/usr/bin/env node
// Memory tasks: sets of named landmarks whose surveyed twin is the hidden truth
// (v1/lib/generator/landmarks). Builds them with the standard pipeline and
// checks that the contested probes tell evidence from memory.
//
//   node v1/scripts/landmarks.mjs new-set   --name NAME [--landmarks a,b] [--data DIR]
//   node v1/scripts/landmarks.mjs build-set --set FILE [--quality draft|final] [--variants m2,m3] [--only ID,..] [--blender PATH] [--data DIR]
//   node v1/scripts/landmarks.mjs check     --set FILE [--variants m2,m3] [--only ID,..] [--out FILE] [--data DIR]
//
// A set file holds the seeds, which are what keeps the twins private: it is
// written under the data root (git-ignored) and must never be committed.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import { readJSON, writeJSON } from '../../lib/io.mjs';
import { layout } from '../lib/contract.mjs';
import { modelToGLB } from '../lib/model.mjs';
import { buildObject, buildTask, truthGLB, TASK_PROMPT, setPromptVersion } from '../lib/pack.mjs';
import { LANDMARKS, LANDMARKS_VERSION, REMEMBERED, generateLandmark } from '../lib/generator/landmarks/index.mjs';

const MEMORY_VARIANTS = ['m2', 'm3'];
// What `check` accepts: the truth scores at least this, and the published model
// at least CLEARLY_LOWER points below the truth.
const TRUTH_MIN = 98, CLEARLY_LOWER = 10;

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const args = process.argv.slice(2), command = args.shift() || 'help', options = {};
while (args.length) {
  const key = args.shift();
  if (!key.startsWith('--') || !args.length) throw new Error('Options are --name value');
  options[key.slice(2)] = args.shift();
}
const dataRoot = resolve(options.data || join(root, '.local', 'v1'));
const need = name => { if (options[name] === undefined) throw new Error('Missing --' + name); return options[name]; };
const list = value => String(value).split(',').map(item => item.trim()).filter(Boolean);
const print = value => console.log(JSON.stringify(value, null, 2));
const exists = path => access(path).then(() => true, () => false);

async function readSet() {
  const set = await readJSON(resolve(need('set')));
  const only = options.only ? new Set(list(options.only)) : null;
  for (const entry of set.objects) if (!LANDMARKS.includes(entry.landmark)) throw new Error('Unknown landmark ' + entry.landmark + ' in the set file');
  return { set, objects: set.objects.filter(entry => !only || only.has(entry.id) || only.has(entry.landmark)) };
}

// Every contested probe of one alternate, by the side the scorer put it on.
const sides = report => {
  const contested = report.alternates?.find(alternate => alternate.id === REMEMBERED)?.contested ?? [];
  return { total: contested.length, primary: contested.filter(c => c.closer_to === 'primary').length, alternate: contested.filter(c => c.closer_to === 'alternate').length };
};
const pad = (value, width) => String(value).padEnd(width);

try {
  if (command === 'new-set') {
    const name = need('name'), file = join(dataRoot, 'sets', name + '.json');
    const landmarks = options.landmarks ? list(options.landmarks) : [...LANDMARKS];
    for (const landmark of landmarks) if (!LANDMARKS.includes(landmark)) throw new Error('Unknown landmark ' + landmark + ' (known: ' + LANDMARKS.join(', ') + ')');
    const objects = [], ids = new Set();
    for (const landmark of landmarks) {
      let id;
      do id = 'obj-' + randomBytes(4).toString('hex'); while (ids.has(id));
      ids.add(id);
      objects.push({ id, landmark, seed: randomInt(100000, 2 ** 31 - 1) });
    }
    // Shuffled, so order says nothing about which twin was drawn first.
    for (let i = objects.length - 1; i > 0; i--) { const j = randomInt(0, i + 1); [objects[i], objects[j]] = [objects[j], objects[i]]; }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ name, private: true, kind: 'memory', created_at: new Date().toISOString(), generator: LANDMARKS_VERSION,
      task_prompt: TASK_PROMPT, variants: MEMORY_VARIANTS, objects }, null, 2) + '\n', { flag: 'wx' });
    print({ set: name, file, objects: objects.length, note: 'private: keep this file out of version control' });
  } else if (command === 'build-set') {
    const { set, objects } = await readSet(), variants = options.variants ? list(options.variants) : set.variants ?? MEMORY_VARIANTS;
    // The set file decides the prompt's wording (pack.mjs; a file without task_prompt: 1).
    const paths = layout(dataRoot), built = [], promptVersion = setPromptVersion(set);
    for (const entry of objects) {
      // Resumable: buildObject removes a half-built object, so a directory with evidence.json is complete.
      let triangles = null, seconds = null;
      if (await exists(join(paths.object(entry.id), 'evidence', 'evidence.json'))) console.error('· ' + entry.id + ': already built');
      else {
        const started = Date.now(), { model, alternate } = generateLandmark({ landmark: entry.landmark, seed: entry.seed });
        const object = await buildObject({ dataRoot, model, alternate, id: entry.id, blender: options.blender, quality: options.quality,
          log: message => console.error('· ' + entry.id + ': ' + message) });
        triangles = object.triangles; seconds = Math.round((Date.now() - started) / 100) / 10;
      }
      const tasks = [];
      for (const variant of variants) {
        if (!(await exists(join(paths.task(entry.id + '-' + variant), 'task.json')))) await buildTask({ dataRoot, objectId: entry.id, variant, set: set.name, promptVersion });
        tasks.push(entry.id + '-' + variant);
      }
      built.push({ object: entry.id, triangles, build_seconds: seconds, tasks });
      console.error('✓ ' + entry.id + ' (' + tasks.length + ' tasks' + (seconds === null ? '' : ', ' + seconds + ' s') + ')');
    }
    await writeJSON(join(dataRoot, 'sets', (set.name ?? 'set') + '.built.json'), { name: set.name, built_at: new Date().toISOString(), task_prompt: promptVersion, built });
    print(built);
  } else if (command === 'check') {
    // For every object and variant: the truth as a submission (about 100, every
    // contested probe closer to the primary), the published model (clearly lower,
    // every contested probe closer to the alternate), and the twin regenerated
    // from the set's seed (it must be the truth, byte for byte).
    const { scoreSubmission, loadContext } = await import('../lib/score/index.mjs');
    const { set, objects } = await readSet(), variants = options.variants ? list(options.variants) : set.variants ?? MEMORY_VARIANTS;
    const paths = layout(dataRoot), rows = [];
    for (const entry of objects) {
      const objectDir = paths.object(entry.id);
      const published = modelToGLB(await readJSON(join(objectDir, 'alternates', REMEMBERED, 'model.json')));
      const twin = modelToGLB(generateLandmark({ landmark: entry.landmark, seed: entry.seed }).model);
      const truthBytes = await readFile(join(objectDir, 'model.glb'));
      const regenerated = Buffer.compare(twin, truthBytes) === 0;
      for (const variant of variants) {
        const task = entry.id + '-' + variant, taskDir = paths.task(task), truthDir = paths.truth(task);
        const context = await loadContext({ taskDir, truthDir, dataRoot });
        const score = async glb => { const started = Date.now(); const report = await scoreSubmission({ glb, taskDir, truthDir, dataRoot, context }); return { report, seconds: (Date.now() - started) / 1000 }; };
        const truth = await score(await truthGLB(dataRoot, task)), remembered = await score(published);
        const t = sides(truth.report), p = sides(remembered.report);
        const problems = [];
        if (!(truth.report.score >= TRUTH_MIN)) problems.push('truth scores ' + truth.report.score);
        if (t.primary !== t.total || !t.total) problems.push('truth: ' + t.primary + '/' + t.total + ' contested probes closer to primary');
        if (!(remembered.report.score <= truth.report.score - CLEARLY_LOWER)) problems.push('published model scores ' + remembered.report.score);
        if (p.alternate !== p.total || !p.total) problems.push('published: ' + p.alternate + '/' + p.total + ' contested probes closer to alternate');
        if (!regenerated) problems.push('the twin regenerated from the seed is not the truth');
        rows.push({ object: entry.id, landmark: entry.landmark, variant, truth_score: truth.report.score, truth_primary: t.primary, contested: t.total,
          published_score: remembered.report.score, published_shape: remembered.report.shape_score, published_detail: remembered.report.detail?.score ?? null,
          published_alternate: p.alternate, published_scale: remembered.report.alignment?.scale ?? null, twin_regenerated: regenerated,
          seconds: { truth: truth.seconds, published: remembered.seconds }, ok: !problems.length, problems });
        console.error('· ' + task + ': ' + (problems.length ? problems.join('; ') : 'ok'));
      }
    }
    const head = [pad('object', 13), pad('landmark', 20), pad('var', 4), pad('truth', 7), pad('primary', 8), pad('published', 10), pad('alternate', 10), pad('twin', 5), 'ok'].join(' ');
    console.log(head + '\n' + rows.map(row => [pad(row.object, 13), pad(row.landmark, 20), pad(row.variant, 4), pad(row.truth_score, 7), pad(row.truth_primary + '/' + row.contested, 8),
      pad(row.published_score, 10), pad(row.published_alternate + '/' + row.contested, 10), pad(row.twin_regenerated ? 'same' : 'DIFF', 5), row.ok ? 'ok' : 'FAIL'].join(' ')).join('\n'));
    if (options.out) { await mkdir(dirname(resolve(options.out)), { recursive: true }); await writeJSON(resolve(options.out), rows); }
    if (rows.some(row => !row.ok)) process.exitCode = 1;
  } else {
    console.log([
      'Evidence3D v1 — memory tasks (named landmarks with surveyed twins)', '',
      '  node v1/scripts/landmarks.mjs new-set   --name NAME [--landmarks ' + LANDMARKS.join(',') + ']',
      '  node v1/scripts/landmarks.mjs build-set --set FILE [--quality draft|final] [--variants m2,m3] [--only ID,...] [--blender PATH]',
      '  node v1/scripts/landmarks.mjs check     --set FILE [--variants m2,m3] [--only ID,...] [--out FILE]', '',
      'All commands accept --data DIR (default .local/v1). The set file holds private seeds: never commit it.',
    ].join('\n'));
  }
} catch (error) { console.error(options.debug ? error.stack : error.message); process.exitCode = 1; }
