#!/usr/bin/env node
// Real-building tier: build an object and its r2 / r4 tasks from an authoring
// directory, prepare the photographs, and verify the truth against the drawings.
// Docs: v1/lib/real/README.md
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const args = process.argv.slice(2), command = args.shift() || 'help', options = {};
while (args.length) {
  const key = args.shift();
  if (!key.startsWith('--') || !args.length) throw new Error('Options are --name value');
  options[key.slice(2)] = args.shift();
}
const need = name => { if (options[name] === undefined) throw new Error('Missing --' + name); return options[name]; };
const dataRoot = resolve(options.data || join(root, '.local', 'v1'));
const print = value => console.log(JSON.stringify(value, null, 2));
const log = message => console.error('· ' + message);

try {
  if (command === 'build') {
    const { buildRealObject } = await import('../lib/real/build.mjs');
    print(await buildRealObject({ source: resolve(need('source')), sourcesRoot: resolve(need('sources-root')), dataRoot,
      set: options.set, id: options.id, variants: options.variants ? options.variants.split(',') : undefined,
      promptVersion: options['task-prompt'] === undefined ? undefined : Number(options['task-prompt']), log }));
  } else if (command === 'prepare') {
    const { preparePhotographs } = await import('../lib/real/build.mjs');
    print(await preparePhotographs({ source: resolve(need('source')), pack: resolve(need('pack')), sourcesRoot: resolve(need('sources-root')), log }));
  } else if (command === 'verify') {
    const { loadAuthoring } = await import('../lib/real/build.mjs');
    const { verifySheets } = await import('../lib/real/verify.mjs');
    const source = resolve(need('source')), authoring = await loadAuthoring(source);
    if (!authoring.sheets) throw new Error(source + ' has no sheets.mjs');
    const outDir = resolve(options.out || join(dataRoot, 'real', authoring.model.id, 'verify'));
    const result = await verifySheets({ model: authoring.model, sheets: authoring.sheets, sheetsRoot: resolve(need('sheets')), outDir, log });
    for (const sheet of result.sheets) {
      console.log(sheet.id + '  (' + sheet.registration.s_px_per_ft + ' px/ft, anchor residuals ' + sheet.registration.anchors.map(a => a.residual_px.toFixed(1)).join(' ') + ' px)');
      for (const r of sheet.residuals) {
        console.log('  ' + r.id.padEnd(26) + (r.residual_m === null ? '   not found (' + (r.found.truth ? '' : 'truth ') + (r.found.sheet ? '' : 'sheet') + ')'
          : (r.residual_m >= 0 ? '  +' : '  ') + r.residual_m.toFixed(3) + ' m'));
      }
    }
    console.log('overlays and residuals.json in ' + outDir);
    print(result.summary);
  } else if (command === 'coverage') {
    const { coverageSummary } = await import('../lib/real/build.mjs');
    const { loadContext } = await import('../lib/score/index.mjs');
    const { layout } = await import('../lib/contract.mjs');
    const paths = layout(dataRoot), task = need('task');
    print({ task, ...coverageSummary(await loadContext({ taskDir: paths.task(task), truthDir: paths.truth(task), dataRoot })) });
  } else {
    console.log([
      'Evidence3D v1 — real-building tier', '',
      '  node v1/scripts/real.mjs prepare --source DIR --pack REFERENCE_PACK --sources-root DIR   (crop and clean the photographs)',
      '  node v1/scripts/real.mjs build   --source DIR --sources-root DIR [--set NAME] [--id ID] [--variants r2,r4] [--task-prompt N] [--data DIR]',
      '  node v1/scripts/real.mjs verify  --source DIR --sheets SHEET_DIR [--out DIR] [--data DIR]',
      '  node v1/scripts/real.mjs coverage --task ID [--data DIR]      (share of the truth surface the evidence shows, by facing and item)',
    ].join('\n'));
  }
} catch (error) { console.error(options.debug ? error.stack : error.message); process.exitCode = 1; }
