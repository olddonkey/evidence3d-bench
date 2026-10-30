#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import { readJSON, writeJSON } from '../lib/io.mjs';
import { layout, VARIANTS, GENERATED_VARIANTS } from './lib/contract.mjs';
import { buildObject, buildTask, verifyTasks, truthGLB } from './lib/pack.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
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

// The few numbers worth reading at a glance from a full report.
function brief(report) {
  return { task: report.task_id, valid: report.valid, error: report.error ?? undefined, score: report.score, shape: report.shape_score,
    detail: report.detail?.score, frame: report.alignment?.frame_error, shape_f: report.shape?.f, strict_f: report.strict?.f,
    probes: report.probe_summary, alternates: report.alternates?.map(a => ({ id: a.id, f: a.f, closer_to_primary: a.closer_to_primary_fraction })) };
}

try {
  if (command === 'build-object') {
    print(await buildObject({ dataRoot, archetype: need('archetype'), seed: Number(need('seed')), id: options.id,
      blender: options.blender, quality: options.quality, log: message => console.error('· ' + message) }));
  } else if (command === 'build-task') {
    print(await buildTask({ dataRoot, objectId: need('object'), variant: need('variant') }));
  } else if (command === 'new-set') {
    // A test set is private because its seeds are. They are drawn from the OS
    // random source, objects get opaque ids, and the file lives under the data
    // root, which git ignores. Never copy it into the repository.
    const { ARCHETYPES } = await import('./lib/generator/index.mjs');
    const name = need('name'), per = Number(options['per-archetype'] ?? 3), file = join(dataRoot, 'sets', name + '.json');
    const archetypes = options.archetypes ? list(options.archetypes) : ARCHETYPES;
    for (const archetype of archetypes) if (!ARCHETYPES.includes(archetype)) throw new Error('Unknown archetype ' + archetype);
    if (!Number.isInteger(per) || per < 1) throw new Error('--per-archetype must be a positive integer');
    const objects = [], ids = new Set();
    for (const archetype of archetypes) for (let i = 0; i < per; i++) {
      let id;
      do id = 'obj-' + randomBytes(4).toString('hex'); while (ids.has(id));
      ids.add(id);
      objects.push({ id, archetype, seed: randomInt(100000, 2 ** 31 - 1) });
    }
    // Shuffle so that ids and order say nothing about the archetype.
    for (let i = objects.length - 1; i > 0; i--) { const j = randomInt(0, i + 1); [objects[i], objects[j]] = [objects[j], objects[i]]; }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ name, private: true, created_at: new Date().toISOString(), variants: GENERATED_VARIANTS, objects }, null, 2) + '\n', { flag: 'wx' });
    print({ set: name, file, objects: objects.length, archetypes: archetypes.length, note: 'private: keep this file out of version control' });
  } else if (command === 'build-set') {
    // A set file lists objects by archetype and seed. Keep test-set files out of
    // version control: the seeds are what keeps a test set private.
    const set = await readJSON(resolve(need('set'))), variants = options.variants ? list(options.variants) : set.variants ?? GENERATED_VARIANTS;
    const built = [];
    // Resumable: a long build interrupted half way continues where it stopped.
    // buildObject removes a half-built object, so a directory with evidence.json is complete.
    const exists = async path => access(path).then(() => true, () => false), paths = layout(dataRoot);
    for (const entry of set.objects) {
      const label = entry.id ?? entry.archetype + '/' + entry.seed;
      let objectId = entry.id, triangles = null;
      if (objectId && await exists(join(paths.object(objectId), 'evidence', 'evidence.json'))) console.error('· ' + label + ': already built');
      else {
        const object = await buildObject({ dataRoot, archetype: entry.archetype, seed: entry.seed, id: entry.id,
          blender: options.blender, quality: options.quality, log: message => console.error('· ' + label + ': ' + message) });
        objectId = object.object; triangles = object.triangles;
      }
      const tasks = [];
      for (const variant of variants) {
        if (!(await exists(join(paths.task(objectId + '-' + variant), 'task.json')))) await buildTask({ dataRoot, objectId, variant, set: set.name });
        tasks.push(objectId + '-' + variant);
      }
      built.push({ object: objectId, triangles, tasks });
      console.error('✓ ' + objectId + ' (' + tasks.length + ' tasks)');
    }
    await writeJSON(join(dataRoot, 'sets', (set.name ?? 'set') + '.built.json'), { name: set.name, built_at: new Date().toISOString(), built });
    print(built);
  } else if (command === 'verify') {
    const tasks = await verifyTasks(dataRoot);
    console.log('Verified ' + tasks.reduce((sum, task) => sum + task.inputs, 0) + ' locked inputs across ' + tasks.length + ' tasks');
  } else if (command === 'score') {
    const { scoreSubmission } = await import('./lib/score/index.mjs');
    const paths = layout(dataRoot), task = need('task');
    const glb = options.glb === 'truth' ? await truthGLB(dataRoot, task) : await readFile(resolve(need('glb')));
    const report = await scoreSubmission({ glb, taskDir: paths.task(task), truthDir: paths.truth(task), dataRoot, outDir: options.out ? resolve(options.out) : undefined });
    print(options.full === 'true' ? report : brief(report));
  } else if (command === 'calibrate') {
    const { loadContext, calibrate } = await import('./lib/score/index.mjs');
    const paths = layout(dataRoot), task = need('task');
    const rows = await calibrate(await loadContext({ taskDir: paths.task(task), truthDir: paths.truth(task), dataRoot }));
    if (options.out) { await mkdir(dirname(resolve(options.out)), { recursive: true }); await writeFile(resolve(options.out), JSON.stringify(rows, null, 2)); }
    for (const row of rows) console.log((row.ok ? 'ok   ' : 'FAIL ') + String(row.id).padEnd(28) + ' score ' + String(row.score?.toFixed?.(1) ?? row.score).padStart(6) +
      '  shape ' + String(row.shape?.toFixed?.(1) ?? row.shape).padStart(6) + '  detail ' + String(row.detail?.toFixed?.(1) ?? row.detail).padStart(6) + '  ' + (row.expectation ?? ''));
    if (rows.some(row => !row.ok)) process.exitCode = 1;
  } else if (command === 'rescore') {
    // After the scoring definition changes, recompute reports from the frozen
    // submissions. Generation is never repeated; the previous report is kept.
    // A file the scorer fails on is scored again, then left a score_error
    // (v1/lib/runner/rescore.mjs, by the runner's rules).
    const { scoreSubmission, loadContext } = await import('./lib/score/index.mjs');
    const { rescoreAttempt } = await import('./lib/runner/rescore.mjs');
    const paths = layout(dataRoot), contexts = new Map(), rows = [];
    for (const batch of list(need('batches'))) {
      const batchDir = join(paths.runs, batch);
      for (const task of (await readdir(batchDir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) {
        let attempts = [];
        try { attempts = (await readdir(join(batchDir, task))).filter(name => /^a\d+$/.test(name)).sort(); } catch { continue; }
        const context = async () => {
          if (!contexts.has(task)) contexts.set(task, await loadContext({ taskDir: paths.task(task), truthDir: paths.truth(task), dataRoot }));
          return contexts.get(task);
        };
        const score = async (glb, { outDir } = {}) => scoreSubmission({ glb, taskDir: paths.task(task), truthDir: paths.truth(task), dataRoot, outDir, context: await context() });
        for (const attempt of attempts) {
          const row = await rescoreAttempt({ batchDir, attemptDir: join(batchDir, task, attempt), score, ready: context });
          if (!row) continue;
          rows.push({ batch, task, attempt, ...row });
          console.error('· ' + batch + '/' + task + '/' + attempt + ': ' + (row.snapshots_only ? 'snapshots only'
            : (row.before ?? '-') + ' -> ' + (row.score_error ? 'score_error (' + row.score_error + ')' : row.score)));
        }
      }
    }
    print(rows);
  } else if (command === 'report') {
    const { writeReport, readRoster, readHumanCurve } = await import('./lib/report/index.mjs');
    const roster = options.roster ? await readRoster(resolve(options.roster)) : null;
    const humanCurve = options['human-curve'] ? await readHumanCurve(resolve(options['human-curve'])) : null;
    print(await writeReport({ dataRoot, batches: list(need('batches')), outDir: resolve(options.out || join(dataRoot, 'reports', 'latest')), roster, humanCurve }));
  } else if (command === 'regression') {
    // Round 4 plan section 3: the regression systems' rows in two rounds, paired by object.
    const { regressionReport, parseSystems } = await import('./lib/report/index.mjs');
    print(await regressionReport({ dataRoot, baseline: list(need('baseline')), batches: list(need('batches')), outDir: resolve(options.out || join(dataRoot, 'reports', 'regression')),
      set: options.set, systems: options.systems ? parseSystems(options.systems) : undefined, seed: options.seed }));
  } else {
    console.log([
      'Evidence3D v1 — hidden-truth reconstruction benchmark', '',
      '  node v1/cli.mjs build-object --archetype NAME --seed N [--quality draft|final]',
      '  node v1/cli.mjs build-task   --object ID --variant ' + Object.keys(VARIANTS).join('|'),
      '  node v1/cli.mjs new-set      --name NAME [--per-archetype 3]      (private seeds, opaque ids, under the data root)',
      '  node v1/cli.mjs build-set    --set FILE [--variants t1,t2,...]',
      '  node v1/cli.mjs verify',
      '  node v1/cli.mjs score        --task ID --glb FILE|truth [--out DIR] [--full true]',
      '  node v1/cli.mjs calibrate    --task ID [--out FILE]',
      '  node v1/cli.mjs rescore      --batches A,B      (recompute reports from stored submissions)',
      '  node v1/cli.mjs report       --batches A,B [--out DIR] [--roster FILE] [--human-curve FILE]   (roster: formal configurations and ladders, e.g. v1/rounds/round3.roster.json;',
      '                               human curve: <data>/study/<name>/human-curve.json from study.mjs curve)',
      '  node v1/cli.mjs regression   --baseline A,B --batches C,D [--out DIR] [--set test-2026-10] [--systems codex/gpt-6-astra/high,...]',
      '                               (Round 4 plan section 3: the same systems in two rounds, paired by object; equivalent, drift or undecided)',
      '  node v1/scripts/run.mjs prepare|preflight|run …      (generation runner)',
      '  node v1/scripts/landmarks.mjs new-set|build-set|check (memory tasks: named landmark twins, variants m2 m3)',
      '  node v1/scripts/real.mjs prepare|build|verify|coverage (real buildings, variants r2 r4)',
      '  node v1/scripts/study.mjs prepare|serve|analyze|export (blind human-agreement study, several raters)', '',
      'All commands accept --data DIR (default .local/v1).',
    ].join('\n'));
  }
} catch (error) { console.error(options.debug ? error.stack : error.message); process.exitCode = 1; }
