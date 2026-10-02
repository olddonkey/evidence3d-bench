#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { readJSON, writeJSON } from '../lib/io.mjs';
import { layout, VARIANTS } from './lib/contract.mjs';
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
  } else if (command === 'build-set') {
    // A set file lists objects by archetype and seed. Keep test-set files out of
    // version control: the seeds are what keeps a test set private.
    const set = await readJSON(resolve(need('set'))), variants = options.variants ? list(options.variants) : set.variants ?? Object.keys(VARIANTS);
    const built = [];
    for (const entry of set.objects) {
      const object = await buildObject({ dataRoot, archetype: entry.archetype, seed: entry.seed, id: entry.id,
        blender: options.blender, quality: options.quality, log: message => console.error('· ' + (entry.id ?? entry.archetype + '/' + entry.seed) + ': ' + message) });
      const tasks = [];
      for (const variant of variants) tasks.push((await buildTask({ dataRoot, objectId: object.object, variant })).task);
      built.push({ object: object.object, triangles: object.triangles, tasks });
      console.error('✓ ' + object.object + ' (' + tasks.length + ' tasks)');
    }
    await writeJSON(join(dataRoot, 'sets', (set.name ?? 'set') + '.built.json'), { name: set.name, built });
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
    const { scoreSubmission, loadContext } = await import('./lib/score/index.mjs');
    const paths = layout(dataRoot), contexts = new Map(), rows = [];
    for (const batch of list(need('batches'))) {
      const batchDir = join(paths.runs, batch);
      for (const task of (await readdir(batchDir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) {
        let attempts = [];
        try { attempts = (await readdir(join(batchDir, task))).filter(name => /^a\d+$/.test(name)).sort(); } catch { continue; }
        for (const attempt of attempts) {
          const scoreDir = join(batchDir, task, attempt, 'score');
          let glb;
          try { glb = await readFile(join(scoreDir, 'submission.glb')); } catch { continue; }
          if (!contexts.has(task)) contexts.set(task, await loadContext({ taskDir: paths.task(task), truthDir: paths.truth(task), dataRoot }));
          let previous = null;
          try { previous = await readJSON(join(scoreDir, 'report.json')); await writeJSON(join(scoreDir, 'report.previous.json'), previous); } catch { /* first report */ }
          const report = await scoreSubmission({ glb, taskDir: paths.task(task), truthDir: paths.truth(task), dataRoot, outDir: scoreDir, context: contexts.get(task) });
          await writeJSON(join(scoreDir, 'report.json'), report);
          rows.push({ batch, task, attempt, before: previous?.score ?? null, score: report.score, shape: report.shape_score, detail: report.detail?.score ?? null });
          console.error('· ' + batch + '/' + task + '/' + attempt + ': ' + (previous?.score ?? '-') + ' -> ' + report.score);
        }
      }
    }
    print(rows);
  } else if (command === 'report') {
    const { writeReport } = await import('./lib/report/index.mjs');
    print(await writeReport({ dataRoot, batches: list(need('batches')), outDir: resolve(options.out || join(dataRoot, 'reports', 'latest')) }));
  } else {
    console.log([
      'Evidence3D v1 — hidden-truth reconstruction benchmark', '',
      '  node v1/cli.mjs build-object --archetype NAME --seed N [--quality draft|final]',
      '  node v1/cli.mjs build-task   --object ID --variant ' + Object.keys(VARIANTS).join('|'),
      '  node v1/cli.mjs build-set    --set FILE [--variants t1,t2,...]',
      '  node v1/cli.mjs verify',
      '  node v1/cli.mjs score        --task ID --glb FILE|truth [--out DIR] [--full true]',
      '  node v1/cli.mjs calibrate    --task ID [--out FILE]',
      '  node v1/cli.mjs rescore      --batches A,B      (recompute reports from stored submissions)',
      '  node v1/cli.mjs report       --batches A,B [--out DIR]',
      '  node v1/scripts/run.mjs prepare|preflight|run …      (generation runner)', '',
      'All commands accept --data DIR (default .local/v1).',
    ].join('\n'));
  }
} catch (error) { console.error(options.debug ? error.stack : error.message); process.exitCode = 1; }
