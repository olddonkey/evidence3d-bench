#!/usr/bin/env node
// Evidence3D v1 human-agreement study (blind paired comparison).
//   node v1/scripts/study.mjs prepare --name <name> --batches a,b,c --seed <seed> [--pairs 100] [--repeat-share 0.1] [--data <root>] [--force]
//   node v1/scripts/study.mjs serve   --name <name> [--port 4173] [--data <root>]
//   node v1/scripts/study.mjs analyze --name <name> [--data <root>]
// The study lives in <data>/study/<name>/: pairs.json (public), key.json
// (private), images/, votes.jsonl, analysis.md and analysis.json. Progress is
// printed as one JSON object per line. Details: v1/lib/study/README.md.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { prepareStudy, studyDir, DEFAULT_DATA_ROOT } from '../lib/study/index.mjs';
import { startStudyServer, DEFAULT_PORT } from '../lib/study/server.mjs';
import { writeAnalysis } from '../lib/study/analyze.mjs';
import { DEFAULT_PAIRS, DEFAULT_REPEAT_SHARE } from '../lib/study/select.mjs';

const USAGE = `Usage:
  node v1/scripts/study.mjs prepare --name <name> --batches a,b,c --seed <seed> [--pairs ${DEFAULT_PAIRS}] [--repeat-share ${DEFAULT_REPEAT_SHARE}] [--data <root>] [--force]
  node v1/scripts/study.mjs serve   --name <name> [--port ${DEFAULT_PORT}] [--data <root>]
  node v1/scripts/study.mjs analyze --name <name> [--data <root>]`;

const OPTIONS = {
  name: { type: 'string' }, batches: { type: 'string' }, seed: { type: 'string' }, pairs: { type: 'string' }, 'repeat-share': { type: 'string' },
  data: { type: 'string' }, port: { type: 'string' }, force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
};
const print = value => console.log(JSON.stringify(value));

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [command] = positionals;
  if (values.help || !command) { console.log(USAGE); return 0; }
  const need = key => { if (!values[key]) throw new Error('--' + key + ' is required for ' + command); return values[key]; };
  const dataRoot = resolve(values.data ?? DEFAULT_DATA_ROOT);
  if (command === 'prepare') {
    const pairs = Number(values.pairs ?? DEFAULT_PAIRS), repeatShare = Number(values['repeat-share'] ?? DEFAULT_REPEAT_SHARE);
    if (!Number.isInteger(pairs) || pairs < 1) throw new Error('--pairs must be a positive integer');
    if (!(repeatShare >= 0 && repeatShare <= 1)) throw new Error('--repeat-share must be between 0 and 1');
    const summary = await prepareStudy({ dataRoot, name: need('name'), batches: need('batches').split(',').map(item => item.trim()).filter(Boolean),
      seed: need('seed'), pairs, repeatShare, force: Boolean(values.force),
      log: event => { if (event.event !== 'rendered' || event.done % 10 === 0 || event.done === event.of) print(event); } });
    print({ event: 'prepared', ...summary, next: 'node v1/scripts/study.mjs serve --name ' + values.name + (values.data ? ' --data ' + values.data : '') });
    return 0;
  }
  if (command === 'serve') {
    const port = Number(values.port ?? DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer between 0 and 65535');
    const dir = studyDir(dataRoot, need('name'));
    const { url, close } = await startStudyServer({ studyDir: dir, port });
    print({ event: 'serving', url, study: dir, votes: resolve(dir, 'votes.jsonl'), stop: 'Ctrl-C' });
    await new Promise(done => {
      const stop = () => { close().then(done); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    print({ event: 'stopped' });
    return 0;
  }
  if (command === 'analyze') {
    const { analysis, files } = await writeAnalysis(studyDir(dataRoot, need('name')));
    const headline = analysis.agreement.find(item => item.measure === 'score').overall;
    print({ event: 'analyzed', files, pairs_rated: analysis.votes.pairs_rated, pairs_unrated: analysis.votes.pairs_unrated, ties: analysis.votes.ties,
      agreement: headline.n ? { agree: headline.k, decided: headline.n, share: headline.p, ci95: [headline.low, headline.high] } : null });
    return 0;
  }
  throw new Error('Unknown command ' + command + '\n' + USAGE);
}

try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
