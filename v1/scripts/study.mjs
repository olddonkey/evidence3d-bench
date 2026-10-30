#!/usr/bin/env node
// Evidence3D v1 human-agreement study (blind paired comparison).
//   node v1/scripts/study.mjs prepare --name <name> --batches a,b,c --seed <seed> [--pairs 100] [--repeat-share 0.1] [--data <root>] [--force]
//   node v1/scripts/study.mjs serve   --name <name> [--port 4173] [--data <root>] [--legacy-rater <id>]
//   node v1/scripts/study.mjs add-catch --name <name> --objects a,b,c --seed <seed> [--count 6] [--data <root>] [--legacy-rater <id>]
//   node v1/scripts/study.mjs qualify --name <name> [--data <root>] [--legacy-rater <id>] [--raters a,b,c]
//   node v1/scripts/study.mjs analyze --name <name> [--data <root>] [--legacy-rater <id>] [--raters a,b,c] [--g1-seed <seed>]
//   node v1/scripts/study.mjs export  --name <name> --out <new directory> [--data <root>]
// The study lives in <data>/study/<name>/: pairs.json (public), key.json
// (private), images/, votes.jsonl and the votes-<rater>.jsonl other raters
// sent back, analysis.md and analysis.json. Progress is printed as one JSON
// object per line. Details: v1/lib/study/README.md.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { prepareStudy, exportStudy, studyDir, DEFAULT_DATA_ROOT } from '../lib/study/index.mjs';
import { startStudyServer, DEFAULT_PORT } from '../lib/study/server.mjs';
import { writeAnalysis } from '../lib/study/analyze.mjs';
import { qualifyStudy } from '../lib/study/panel.mjs';
import { addCatchPairs, CATCH_PAIRS } from '../lib/study/catch.mjs';
import { readVoteFiles } from '../lib/study/votes.mjs';
import { DEFAULT_PAIRS, DEFAULT_REPEAT_SHARE } from '../lib/study/select.mjs';
import { isRater, LEGACY_RATER } from '../lib/study/page/state.js';

const USAGE = `Usage:
  node v1/scripts/study.mjs prepare --name <name> --batches a,b,c --seed <seed> [--pairs ${DEFAULT_PAIRS}] [--repeat-share ${DEFAULT_REPEAT_SHARE}] [--data <root>] [--force]
  node v1/scripts/study.mjs serve   --name <name> [--port ${DEFAULT_PORT}] [--data <root>] [--legacy-rater <id>]
  node v1/scripts/study.mjs add-catch --name <name> --objects a,b,c --seed <seed> [--count ${CATCH_PAIRS}] [--data <root>] [--legacy-rater <id>]
  node v1/scripts/study.mjs qualify --name <name> [--data <root>] [--legacy-rater <id>] [--raters a,b,c]
  node v1/scripts/study.mjs analyze --name <name> [--data <root>] [--legacy-rater <id>] [--raters a,b,c] [--g1-seed <seed>]
  node v1/scripts/study.mjs export  --name <name> --out <new directory> [--data <root>]
--legacy-rater <id>: the rater whose votes in votes.jsonl carry no rater (recorded before raters had names); default ${LEGACY_RATER}.
--objects: development-set object ids (v1/sets/dev.json) for the catch pairs; --g1-seed: gate G1's bootstrap seed from the private record.`;

const OPTIONS = {
  name: { type: 'string' }, batches: { type: 'string' }, seed: { type: 'string' }, pairs: { type: 'string' }, 'repeat-share': { type: 'string' },
  data: { type: 'string' }, port: { type: 'string' }, force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  'legacy-rater': { type: 'string' }, raters: { type: 'string' }, out: { type: 'string' },
  objects: { type: 'string' }, count: { type: 'string' }, 'g1-seed': { type: 'string' },
};
const listOf = value => value.split(',').map(item => item.trim()).filter(Boolean);
const print = value => console.log(JSON.stringify(value));

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [command] = positionals;
  if (values.help || !command) { console.log(USAGE); return 0; }
  const need = key => { if (!values[key]) throw new Error('--' + key + ' is required for ' + command); return values[key]; };
  const dataRoot = resolve(values.data ?? DEFAULT_DATA_ROOT);
  const legacyRater = values['legacy-rater'] ?? LEGACY_RATER;
  if (legacyRater !== LEGACY_RATER && !isRater(legacyRater)) throw new Error('--legacy-rater must be 1 to 32 lower-case letters and digits (not ' + LEGACY_RATER + ')');
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
    const { url, close } = await startStudyServer({ studyDir: dir, port, legacyRater });
    const read = await readVoteFiles(dir, { legacyRater });
    const unnamed = read.files.find(file => file.file === 'votes.jsonl')?.unnamed_lines ?? 0;
    print({ event: 'serving', url, study: dir, votes: resolve(dir, 'votes.jsonl'), stop: 'Ctrl-C',
      ...(unnamed ? { votes_without_rater: unnamed, counted_as: legacyRater,
        hint: legacyRater === LEGACY_RATER ? 'votes.jsonl holds votes recorded before raters had names; if they are yours, stop and serve again with --legacy-rater <the id you give on the page>' : undefined } : {}) });
    await new Promise(done => {
      const stop = () => { close().then(done); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    print({ event: 'stopped' });
    return 0;
  }
  const raters = values.raters === undefined ? null : listOf(values.raters);
  if (raters && !raters.length) throw new Error('--raters needs at least one rater id');
  if (command === 'add-catch') {
    const count = Number(values.count ?? CATCH_PAIRS);
    if (!Number.isInteger(count) || count < 1) throw new Error('--count must be a positive integer');
    const summary = await addCatchPairs({ dataRoot, name: need('name'), objects: listOf(need('objects')), seed: need('seed'), count, legacyRater });
    // The places of the catch pairs are in key.json only: printing them would tell a rater which pairs they are.
    print({ event: 'catch-pairs-added', ...summary,
      next: 'write the objects, groups and seed into the private record, restart serve if it runs, then export the study for the raters' });
    return 0;
  }
  if (command === 'qualify') {
    // The votes, the repeats and the catch pairs only: no score, no agreement.
    const result = await qualifyStudy(studyDir(dataRoot, need('name')), { legacyRater, raters });
    print({ event: 'qualified', ...result });
    return 0;
  }
  if (command === 'analyze') {
    const g1Seed = values['g1-seed'] ?? null;
    if (g1Seed === '') throw new Error('--g1-seed needs a value');
    const { analysis, files } = await writeAnalysis(studyDir(dataRoot, need('name')), { legacyRater, raters, g1Seed });
    const share = stat => stat.n ? { agree: stat.k, decided: stat.n, share: stat.p, ci95: [stat.low, stat.high] } : null;
    const between = analysis.between_raters;
    print({ event: 'analyzed', files, ignored_files: analysis.votes.ignored_files, malformed_lines: analysis.votes.malformed_lines,
      ...(analysis.votes.raters_only_unknown_pairs.length ? { raters_only_unknown_pairs: analysis.votes.raters_only_unknown_pairs } : {}),
      raters: analysis.raters.map(item => ({ rater: item.rater, pairs_rated: item.votes.pairs_rated, pairs_unrated: item.votes.pairs_unrated, ties: item.votes.ties,
        agreement: share(item.agreement.find(measure => measure.measure === 'score').overall) })),
      between_raters: between.raters.length < 2 ? null : {
        pairwise: between.pairwise.map(row => ({ raters: row.raters, both_rated: row.both_rated, same_choice: row.same_choice.p, cohen_kappa: row.cohen_kappa })),
        fleiss_kappa: between.fleiss && { pairs: between.fleiss.pairs, kappa: between.fleiss.kappa },
        majority_agreement: share(between.majority.agreement.find(measure => measure.measure === 'score').overall),
      },
      qualified: analysis.qualification.filter(item => item.qualified).map(item => item.rater),
      g1: analysis.g1.run ? { panel: analysis.g1.panel, decision: analysis.g1.decision, target: analysis.g1.target.verdict,
        agreement: analysis.g1.candidates.map(item => ({ weights: item.weights, agreement: item.agreement?.estimate ?? null, ci95: [item.agreement?.low ?? null, item.agreement?.high ?? null] })) }
        : { not_computed: analysis.g1.reason, decision: analysis.g1.decision, ...(analysis.g1.target ? { target: analysis.g1.target.verdict } : {}) } });
    return 0;
  }
  if (command === 'export') {
    const summary = await exportStudy({ dataRoot, name: need('name'), out: need('out') });
    print({ event: 'exported', ...summary,
      next: 'send ' + summary.out + ' to the rater; they run serve --name ' + values.name + ' --data <that folder> and send back study/' + values.name + '/votes.jsonl, saved here as votes-<rater>.jsonl' });
    return 0;
  }
  throw new Error('Unknown command ' + command + '\n' + USAGE);
}

try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
