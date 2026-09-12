#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparePilot, preflightPilot, executePilot, DEFAULT_PILOT_TASKS } from '../lib/codex-pilot.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url))), args = process.argv.slice(2), options = {};
while (args.length) {
  const key = args.shift();
  if (!key.startsWith('--') || !args.length) throw new Error('Use --name value');
  options[key.slice(2)] = args.shift();
}
try {
  const command = options.mode || 'prepare';
  if (command === 'prepare') {
    const prepared = await preparePilot({ root, id: options.id,
      taskIds: options.tasks ? options.tasks.split(',') : DEFAULT_PILOT_TASKS,
      model: options.model || 'gpt-6-astra',
      codex: options.codex || '/Users/olddonkey/.local/bin/codex.opencodex-real',
      blender: options.blender || '/Applications/Blender.app/Contents/MacOS/Blender' });
    console.log(JSON.stringify({ event: 'prepared', batch: prepared.batch, tasks: prepared.manifest.tasks.map(t => t.id) }));
  } else if (command === 'preflight') {
    console.log(JSON.stringify(await preflightPilot(resolve(options.batch), root), null, 2));
  } else if (command === 'run') {
    await executePilot({ root, batch: resolve(options.batch), onProgress: event => console.log(JSON.stringify(event)) });
  } else throw new Error('Mode must be prepare, preflight, or run');
} catch (error) { console.error(error.stack); process.exitCode = 1; }
