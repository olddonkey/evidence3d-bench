#!/usr/bin/env node
// Evidence3D v1 generation runner.
//   node v1/scripts/run.mjs prepare   --id <batch> --system codex|claude-code --model <id> [--effort <level>]
//                                     --tasks a,b,c [--attempts 1] [--data <root>] [--binary <cli path>]
//   node v1/scripts/run.mjs preflight --batch <dir> [--probe-model <id>] [--probe-effort <level>]
//   node v1/scripts/run.mjs run       --batch <dir> [--concurrency 1]
//   node v1/scripts/run.mjs summary   --batch <dir>
// Progress is printed as one JSON object per line.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { prepare, preflight, execute, summarize, DEFAULT_DATA_ROOT } from '../lib/runner/index.mjs';

const USAGE = `Usage:
  node v1/scripts/run.mjs prepare   --id <batch> --system codex|claude-code --model <id> [--effort <level>] --tasks a,b,c [--attempts 1] [--data <root>] [--binary <path>]
  node v1/scripts/run.mjs preflight --batch <dir> [--probe-model <id>] [--probe-effort <level>]
  node v1/scripts/run.mjs run       --batch <dir> [--concurrency 1]
  node v1/scripts/run.mjs summary   --batch <dir>`;

const OPTIONS = {
  id: { type: 'string' }, system: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, tasks: { type: 'string' },
  attempts: { type: 'string' }, data: { type: 'string' }, binary: { type: 'string' }, batch: { type: 'string' },
  concurrency: { type: 'string' }, 'probe-model': { type: 'string' }, 'probe-effort': { type: 'string' }, help: { type: 'boolean', short: 'h' },
};

const print = value => console.log(JSON.stringify(value));
const integer = (text, name, fallback) => {
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isInteger(value)) throw new Error('--' + name + ' must be an integer');
  return value;
};

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [command] = positionals;
  if (values.help || !command) { console.log(USAGE); return 0; }
  const need = key => { if (!values[key]) throw new Error('--' + key + ' is required for ' + command); return values[key]; };
  if (command === 'prepare') {
    const { batchDir, manifest } = await prepare({
      id: need('id'), system: need('system'), model: need('model'), effort: values.effort, tasks: need('tasks').split(',').map(s => s.trim()).filter(Boolean),
      attempts: integer(values.attempts, 'attempts', 1), dataRoot: resolve(values.data ?? DEFAULT_DATA_ROOT), binary: values.binary, log: print,
    });
    print({ event: 'ready', batch: batchDir, system: manifest.system, model: manifest.model, effort: manifest.effort, next: 'node v1/scripts/run.mjs preflight --batch ' + batchDir });
    return 0;
  }
  if (command === 'preflight') {
    const report = await preflight({ batchDir: resolve(need('batch')), probeModel: values['probe-model'], probeEffort: values['probe-effort'], log: print });
    for (const check of report.checks) if (check.status !== 'pass') print({ check: check.id, status: check.status, reason: check.reason });
    print({ event: 'preflight', passed: report.passed, failed: report.failed, not_evaluated: report.not_evaluated, report: resolve(need('batch'), 'preflight.json') });
    return report.passed ? 0 : 1;
  }
  if (command === 'run') {
    const summary = await execute({ batchDir: resolve(need('batch')), concurrency: integer(values.concurrency, 'concurrency', 1), log: print });
    print({ event: 'summary', complete: summary.complete, counts: summary.counts, mean_score: summary.mean_score });
    return 0;
  }
  if (command === 'summary') { print(await summarize(resolve(need('batch')))); return 0; }
  throw new Error('Unknown command ' + command + '\n' + USAGE);
}

try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
