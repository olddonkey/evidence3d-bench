import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, link, rename, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { encodePNG } from '../lib/png.mjs';
import { DEFAULT_BUDGET } from '../lib/contract.mjs';
import { objectHash } from '../../lib/io.mjs';
import { prepare, execute, manifestHash } from '../lib/runner/index.mjs';
import { startTimeOf } from '../lib/runner/process.mjs';
import { readHere } from '../lib/runner/snapshot-read.mjs';
import { snapshotTicks, snapshotName, glbComplete, readSnapshot, outputIdentity, snapshotClock, snapshotJobs, scoredSnapshots, rescoreSnapshots,
  DEFAULT_SNAPSHOT_SECONDS } from '../lib/runner/snapshots.mjs';

// Score-over-time snapshots (v1/lib/runner/snapshots.mjs), with a fake harness:
// a /bin/sh script that writes successive models into output/ on a timetable.

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = path => access(path).then(() => true, () => false);
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'e3d-snapshots-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// A minimal but well-formed GLB whose JSON chunk carries a marker the fake
// scorer reads: { "e3d": "<marker>" }.
function fakeGLB(marker) {
  let json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, e3d: marker }));
  if (json.length % 4) json = Buffer.concat([json, Buffer.alloc(4 - json.length % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + json.length, 8);
  header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, json]);
}
const markerOf = bytes => { try { return JSON.parse(bytes.subarray(20).toString('utf8').trim()).e3d; } catch { return null; } };

const SCORES = { A: 30, B: 60, C: 90, FLAKY: 40 };

// A scorer that scores by marker, logs every call (and every context load),
// throws on THROW (always) and FLAKY (its first time only), takes its whole
// process down on CRASH, reports its own failure on OWN (an internal error it
// caught), judges BAD invalid.
const fakeScorer = log => `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const marker = glb => { try { return JSON.parse(glb.subarray(20).toString('utf8').trim()).e3d; } catch { return null; } };
export async function loadContext() { appendFileSync(${JSON.stringify(log)}, 'context\\n'); return { loaded: true }; }
export async function scoreSubmission({ glb, outDir, context }) {
  const m = marker(glb);
  appendFileSync(${JSON.stringify(log)}, 'score ' + m + (context?.loaded ? ' with-context' : '') + (outDir ? ' maps' : '') + '\\n');
  if (m === 'THROW') throw new Error('scorer exploded');
  if (m === 'CRASH') process.exit(3);
  if (m === 'FLAKY' && !existsSync(${JSON.stringify(log)} + '.flaky')) { writeFileSync(${JSON.stringify(log)} + '.flaky', ''); throw new Error('scorer hiccup'); }
  if (m === 'OWN') return { schema: 'e3d-report-v1', valid: false, scorer_failed: true, error: 'Scorer error: internal', score: 0 };
  if (m === 'BAD' || m === null) return { schema: 'e3d-report-v1', valid: false, error: 'Invalid GLB', score: 0 };
  return { schema: 'e3d-report-v1', valid: true, error: null, score: ${JSON.stringify(SCORES)}[m] ?? 50 };
}
`;

const CODEX_EVENTS = [
  { type: 'thread.started', thread_id: 't-1' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'node build.mjs', aggregated_output: 'ok', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Built the house.' } },
  { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
];

// The fake CLI: steps [{ after: seconds, write: marker | 'TORN' | 'tamper' }],
// then the events, then `exit`. Written in sh so its timetable starts at once.
async function fakeShellCLI(dir, steps, { exit = 0, sleep = 0.2 } = {}) {
  const path = join(dir, 'fake-codex'), quote = text => "'" + String(text).replaceAll("'", "'\\''") + "'";
  const lines = ['#!/bin/sh', 'ws=$PWD', 'while [ $# -gt 0 ]; do if [ "$1" = "-C" ]; then ws=$2; fi; shift; done', 'cat > /dev/null'];
  for (const step of steps) {
    lines.push('sleep ' + step.after);
    if (step.write === 'tamper') lines.push('chmod 644 "$ws/input/task.json"; printf " " >> "$ws/input/task.json"');
    else lines.push('cp ' + quote(join(dir, 'models', step.write + '.glb')) + ' "$ws/output/model.tmp" && mv "$ws/output/model.tmp" "$ws/output/model.glb"');
  }
  for (const event of CODEX_EVENTS) lines.push('printf "%s\\n" ' + quote(JSON.stringify(event)));
  lines.push('sleep ' + sleep, 'exit ' + exit);
  await writeFile(path, lines.join('\n') + '\n');
  await chmod(path, 0o755);
  return path;
}

async function makeDataRoot(root, id) {
  const png = encodePNG(16, 12, new Uint8Array(16 * 12 * 3).map((_, i) => (i * 13) & 255), 3);
  const task = { schema: 'e3d-task-v1', id, title: 'Two-storey gabled house', prompt: 'Rebuild the house.', variant: 't1',
    target_state: 'As photographed in 2025-09.', frame: { unit: 'metre', up: '+Y', origin: 'Front wall midpoint.', front: 'Front faces +Z.' },
    scale_evidence: 'none', inputs: [{ id: 'source-1', path: 'inputs/01-photo-front.png', kind: 'photo', captured_at: '2025-09',
      description: 'Front photograph', sha256: sha(png), bytes: png.length }],
    output: { model: 'output/model.glb', notes: 'output/notes.md', rules: ['GLB 2.0'] }, budget: { ...DEFAULT_BUDGET } };
  await mkdir(join(root, 'tasks', id, 'inputs'), { recursive: true });
  await writeFile(join(root, 'tasks', id, 'inputs', '01-photo-front.png'), png);
  await writeFile(join(root, 'tasks', id, 'task.json'), JSON.stringify(task, null, 2));
  await mkdir(join(root, 'truth', id), { recursive: true });
  await writeFile(join(root, 'truth', id, 'truth.json'), JSON.stringify({ schema: 'e3d-truth-v1', task_id: id, task_sha256: objectHash(task),
    object: 'fixture', variant: 't1', scale_evidence: 'none', evidence: ['photo-front'], alternates: [] }));
}

const fakeInstallTools = async destination => {
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'preview.mjs'), 'console.log("preview");\n');
  return { files: ['preview.mjs'] };
};

const TASK = 'house-a-t1';

// A prepared batch with a passed preflight, the fake CLI and the fake scorer.
async function snapshotBatch(t, { steps, snapshotSeconds = 2, exit, sleep } = {}) {
  const dir = await scratch(t), dataRoot = join(dir, 'data');
  await makeDataRoot(dataRoot, TASK);
  await mkdir(join(dir, 'models'));
  for (const marker of ['A', 'B', 'C', 'THROW', 'BAD', 'FLAKY', 'CRASH', 'OWN']) await writeFile(join(dir, 'models', marker + '.glb'), fakeGLB(marker));
  const binary = await fakeShellCLI(dir, steps, { exit, sleep });
  const scorer = join(dir, 'fake-scorer.mjs'), log = join(dir, 'scorer.log');
  await writeFile(scorer, fakeScorer(log));
  const inspect = async ({ model, effort }) => ({ system: 'codex', binary, binary_realpath: binary, binary_sha256: sha(await readFile(binary)),
    version: 'fake 1.0', release_root: dir, login: 'test', model, effort: effort ?? 'low', effort_levels: ['low', 'high'] });
  const { batchDir, manifest } = await prepare({ id: 'batch-1', system: 'codex', model: 'test-model', effort: 'low', tasks: [TASK], dataRoot, snapshotSeconds,
    deps: { inspect, installTools: fakeInstallTools } });
  await writeFile(join(batchDir, 'preflight.json'), JSON.stringify({ schema: 'e3d-preflight-v1', passed: true, manifest_sha256: manifestHash(manifest), checks: [] }));
  const events = [];
  const deps = { scorerModule: scorer, graceSeconds: 1, snapshotSettle: { tries: 3, ms: 100 } };
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return { dir, dataRoot, batchDir, manifest, deps, events, log: event => events.push(event), calls, attemptDir: join(batchDir, TASK, 'a1') };
}

// ---------------------------------------------------------------- units

test('ticks fall strictly inside the wall clock and are named by their second', () => {
  assert.deepEqual(snapshotTicks(300, 1800), [300, 600, 900, 1200, 1500]);
  assert.deepEqual(snapshotTicks(300, 1801), [300, 600, 900, 1200, 1500, 1800]);
  assert.deepEqual(snapshotTicks(0, 1800), []);
  assert.deepEqual(snapshotTicks(400, 300), []);
  assert.equal(snapshotName(300), 't0300'); assert.equal(snapshotName(5), 't0005'); assert.equal(snapshotName(12000), 't12000');
  assert.equal(DEFAULT_SNAPSHOT_SECONDS, 300);
});

test('a GLB is complete only when its header length matches the bytes read', () => {
  const whole = fakeGLB('A');
  assert.equal(glbComplete(whole), true);
  assert.equal(glbComplete(whole.subarray(0, whole.length - 4)), false, 'cut short');
  assert.equal(glbComplete(Buffer.from('not a glb at all')), false);
  assert.equal(glbComplete(Buffer.alloc(0)), false);
});

test('a snapshot read refuses symlinks, hard links, FIFOs, oversized files and a swapped output directory', async t => {
  const dir = await scratch(t), ws = join(dir, 'ws'), out = join(ws, 'output'), secret = join(dir, 'truth.glb');
  await mkdir(out, { recursive: true });
  await writeFile(secret, fakeGLB('C'));
  const output = await outputIdentity(ws), copy = join(dir, 'copy.glb');
  const read = async (known = []) => { await rm(copy, { force: true }); return readSnapshot(ws, { maxBytes: 1000, output, dest: copy, known }); };
  assert.deepEqual(await read(), { present: false, problem: null });
  await writeFile(join(out, 'model.glb'), fakeGLB('A'));
  const ok = await read();
  assert.equal(ok.problem, null); assert.equal(ok.stable, true); assert.equal(ok.complete, true); assert.equal(ok.sha256, sha(fakeGLB('A')));
  assert.equal(ok.written, true); assert.equal(markerOf(await readFile(copy)), 'A');
  const repeat = await read([ok.sha256]);
  assert.equal(repeat.sha256, ok.sha256); assert.equal(repeat.written, undefined); assert.equal(await exists(copy), false, 'content the runner has is not copied again');
  await rm(join(out, 'model.glb'));
  await symlink(secret, join(out, 'model.glb'));
  assert.match((await read()).problem, /symlink/);
  await rm(join(out, 'model.glb'));
  await link(secret, join(out, 'model.glb'));
  assert.match((await read()).problem, /hard links/);
  await rm(join(out, 'model.glb'));
  execFileSync('mkfifo', [join(out, 'model.glb')]);
  const started = Date.now();
  assert.match((await read()).problem, /not a regular file/, 'a FIFO is refused without blocking');
  assert.ok(Date.now() - started < 2000);
  await rm(join(out, 'model.glb'));
  await writeFile(join(out, 'model.glb'), Buffer.alloc(2000));
  assert.match((await read()).problem, /over the 1000 byte budget/);
  // output/ itself replaced by a symlink to a directory holding another model.
  await mkdir(join(dir, 'elsewhere'));
  await writeFile(join(dir, 'elsewhere', 'model.glb'), fakeGLB('C'));
  await rename(out, join(ws, 'output.real'));
  await symlink(join(dir, 'elsewhere'), out);
  const swapped = await read();
  assert.match(swapped.problem, /not the directory the attempt started with/); assert.equal(await exists(copy), false);
  await rm(out);
  assert.deepEqual(await read(), { present: false, problem: null }, 'no output/ at all: nothing there');
});

test('a model renamed over the file being read is read again, not refused as a hard link', async t => {
  // The old file of an atomic rename keeps no link: nlink 0 on the open handle.
  const dir = await scratch(t), out = join(dir, 'ws', 'output');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'model.glb'), fakeGLB('A'));
  const output = await outputIdentity(join(dir, 'ws')), home = process.cwd();
  process.chdir(out);
  try {
    const replace = async () => { await writeFile(join(out, 'model.tmp'), fakeGLB('B')); await rename(join(out, 'model.tmp'), join(out, 'model.glb')); };
    const found = await readHere({ ...output, maxBytes: 1000 }, { afterRead: replace });
    assert.deepEqual(found, { present: true, problem: 'output/model.glb was replaced while it was read', retry: true });
    const again = await readHere({ ...output, maxBytes: 1000, dest: join(dir, 'copy.glb') });
    assert.equal(again.problem, null); assert.equal(markerOf(await readFile(join(dir, 'copy.glb'))), 'B');
  } finally { process.chdir(home); }
});

test('a contestant flipping output/ between itself and a symlink to another directory never gets that directory read', async t => {
  // The reader stands in output/ (its working directory) and resolves nothing
  // through the workspace path again, so no interleaving of the flips with
  // its checks can make it read the other directory's model.glb.
  const dir = await scratch(t), ws = join(dir, 'ws'), out = join(ws, 'output'), aside = join(ws, 'output.aside'), secret = join(dir, 'private');
  await mkdir(out, { recursive: true }); await mkdir(secret);
  await writeFile(join(out, 'model.glb'), fakeGLB('A'));
  await writeFile(join(secret, 'model.glb'), fakeGLB('C'));
  const output = await outputIdentity(ws), copy = join(dir, 'copy.glb'), hidden = sha(fakeGLB('C'));
  let flipping = true, flips = 0;
  const flipper = (async () => {
    while (flipping) {
      await rename(out, aside); await symlink(secret, out);
      await new Promise(resolve => setImmediate(resolve));
      await rm(out); await rename(aside, out);
      await new Promise(resolve => setImmediate(resolve));
      flips++;
    }
  })();
  const seen = [];
  for (const deadline = Date.now() + 2500; Date.now() < deadline;) {
    await rm(copy, { force: true });
    const found = await readSnapshot(ws, { maxBytes: 1000, output, dest: copy });
    seen.push(found);
    assert.notEqual(found.sha256, hidden, 'the other directory\'s model was read');
    if (await exists(copy)) assert.equal(markerOf(await readFile(copy)), 'A');
  }
  flipping = false;
  await flipper;
  assert.ok(flips > 10, flips + ' flips');
  assert.ok(seen.some(found => found.sha256 === sha(fakeGLB('A'))), 'the real output/ was still read between flips');
});

test('the snapshot clock waits for a file caught mid-write and stores repeated content once', async t => {
  const dir = await scratch(t), ws = join(dir, 'ws'), attemptDir = join(dir, 'a1');
  await mkdir(join(ws, 'output'), { recursive: true });
  const whole = fakeGLB('A');
  await writeFile(join(ws, 'output', 'model.glb'), whole.subarray(0, 24));
  const clock = snapshotClock({ attemptDir, workspace: ws, intervalSeconds: 1, wallSeconds: 3, maxBytes: 1000, settle: { tries: 20, ms: 50 } });
  assert.deepEqual(clock.ticks, [1, 2]);
  await clock.prepare();
  // The clock starts as if the CLI had been spawned 900 ms ago: the first tick is due in 100 ms.
  clock.begin(performance.now() - 900);
  setTimeout(() => writeFile(join(ws, 'output', 'model.glb'), whole), 400);
  await new Promise(resolve => setTimeout(resolve, 1600));
  const records = await clock.stop();
  assert.equal(records.length, 2);
  assert.equal(records[0].sha256, sha(whole), 'the torn file was read again until whole');
  assert.equal(records[0].complete, true); assert.ok(records[0].read_seconds >= records[0].at_seconds);
  assert.equal(records[1].same_as, 't0001'); assert.equal(records[1].file, 'snapshots/t0001.glb');
  assert.deepEqual((await readdir(join(attemptDir, 'snapshots'))).sort(), ['index.json', 't0001.glb']);
  assert.deepEqual((await readJSON(join(attemptDir, 'snapshots', 'index.json'))).snapshots, records);
  assert.deepEqual(await readdir(join(ws, 'output')), ['model.glb'], 'nothing was written into the workspace');
});

test('an index.json that cannot be written costs no snapshot', async t => {
  const dir = await scratch(t), ws = join(dir, 'ws'), attemptDir = join(dir, 'a1');
  await mkdir(join(ws, 'output'), { recursive: true });
  await writeFile(join(ws, 'output', 'model.glb'), fakeGLB('A'));
  // A directory where index.json should go: every write of the index fails, the snapshots do not.
  await mkdir(join(attemptDir, 'snapshots', 'index.json', 'blocked'), { recursive: true });
  const events = [];
  const clock = snapshotClock({ attemptDir, workspace: ws, intervalSeconds: 1, wallSeconds: 2, maxBytes: 1000, log: event => events.push(event) });
  await clock.prepare();
  clock.begin(performance.now() - 950);
  await new Promise(resolve => setTimeout(resolve, 600));
  const records = await clock.stop();
  assert.equal(records.length, 1);
  assert.equal(records[0].file, 'snapshots/t0001.glb'); assert.equal(records[0].error, undefined);
  assert.deepEqual(snapshotJobs(records).map(job => job.name), ['t0001']);
  assert.equal(scoredSnapshots(records, { scores: new Map([[records[0].sha256, { status: 'scored', score: 30, valid: true }]]) })[0].status, 'scored');
  assert.equal(events.filter(event => event.event === 'snapshot_index_error').length, 2, 'tried after the tick and again at stop');
});

test('a stopped clock takes no further snapshots', async t => {
  const dir = await scratch(t), ws = join(dir, 'ws');
  await mkdir(join(ws, 'output'), { recursive: true });
  const clock = snapshotClock({ attemptDir: join(dir, 'a1'), workspace: ws, intervalSeconds: 1, wallSeconds: 10, maxBytes: 1000 });
  await clock.prepare();
  clock.begin(performance.now());
  assert.deepEqual(await clock.stop(), []);
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.equal(await exists(join(dir, 'a1', 'snapshots')), false);
});

test('scoring jobs skip repeats and the final file; records carry a status and a score', () => {
  const records = [
    { t: 2, name: 't0002', present: false },
    { t: 4, name: 't0004', present: true, sha256: 'a', file: 'snapshots/t0004.glb', complete: true },
    { t: 6, name: 't0006', present: true, sha256: 'a', file: 'snapshots/t0004.glb', same_as: 't0004', complete: true },
    { t: 8, name: 't0008', present: true, problem: 'artifact is a symlink' },
    { t: 10, name: 't0010', present: true, sha256: 'b', file: 'snapshots/t0010.glb', complete: true },
    { t: 12, name: 't0012', present: true, sha256: 'f', file: 'snapshots/t0012.glb', complete: true },
    { t: 14, name: 't0014', present: true, sha256: 'c', complete: true, error: 'snapshot not written: ENOSPC' },
  ];
  assert.deepEqual(snapshotJobs(records, 'f').map(job => job.name), ['t0004', 't0010']);
  const scores = new Map([['a', { status: 'scored', score: 30, valid: true, report: 'r/a.json' }], ['b', { status: 'score_error', score: null, valid: null, error: 'boom' }]]);
  const out = scoredSnapshots(records, { scores, final: { sha256: 'f', score: 90, valid: true, report: 'final.json' } });
  assert.deepEqual(out.map(item => [item.name, item.status, item.score]), [['t0002', 'absent', 0], ['t0004', 'scored', 30], ['t0006', 'scored', 30],
    ['t0008', 'refused', 0], ['t0010', 'score_error', null], ['t0012', 'scored', 90], ['t0014', 'lost', null]]);
  assert.equal(out[2].score_of, 't0004'); assert.equal(out[1].score_of, undefined); assert.equal(out[5].score_of, 'final');
  assert.deepEqual(scoredSnapshots(records, { scored: false }).map(item => item.status), ['absent', 'not_scored', 'not_scored', 'refused', 'not_scored', 'not_scored', 'lost']);
});

// ---------------------------------------------------------------- the runner

test('snapshots are taken outside the sandbox while the CLI runs and scored after it; the score is still the final file\'s', async t => {
  // Ticks at 2, 4, 6 s: A is written at 1 s, B at 5 s, C (the final model) at 7 s.
  const batch = await snapshotBatch(t, { steps: [{ after: 1, write: 'A' }, { after: 4, write: 'B' }, { after: 2, write: 'C' }] });
  assert.deepEqual(batch.manifest.snapshots, { interval_seconds: 2, source: 'output/model.glb' });
  // A long scoring allowance: for the two snapshots together it is more than a timer can hold.
  await execute({ batchDir: batch.batchDir, deps: { ...batch.deps, scoreSeconds: 1_500_000 }, log: batch.log });
  const result = await readJSON(join(batch.attemptDir, 'result.json'));
  assert.equal(result.status, 'completed'); assert.equal(result.score, 90, 'the score is the final file\'s');
  assert.equal(result.snapshot_interval_seconds, 2);
  assert.deepEqual(result.snapshots.map(item => [item.t, item.status, item.score, item.same_as ?? null]), [[2, 'scored', 30, null], [4, 'scored', 30, 't0002'], [6, 'scored', 60, null]]);
  for (const item of result.snapshots) {
    assert.ok(item.at_seconds >= item.t && item.at_seconds < item.t + 3, item.name + ' read at ' + item.at_seconds);
    assert.ok(item.read_seconds >= item.at_seconds);
  }
  assert.equal(result.snapshots[0].report, TASK + '/a1/snapshots/score/t0002.json');
  assert.deepEqual((await readdir(join(batch.attemptDir, 'snapshots'))).sort(), ['index.json', 'score', 't0002.glb', 't0006.glb']);
  assert.equal(markerOf(await readFile(join(batch.attemptDir, 'snapshots', 't0006.glb'))), 'B');
  assert.deepEqual((await readdir(join(batch.attemptDir, 'workspace', 'output'))).sort(), ['model.glb'], 'the workspace holds only what the contestant wrote');
  // One scorer process for the final file (with error maps), one for the two distinct snapshots (one context, no maps).
  assert.deepEqual(await batch.calls(), ['score C maps', 'context', 'score A with-context', 'score B with-context']);
  assert.ok(batch.events.some(event => event.event === 'snapshot' && event.t === 4 && event.same_as === 't0002'));
  assert.ok(batch.events.some(event => event.event === 'scoring_snapshots'));
});

test('a snapshot identical to the final file reuses its score, and no snapshot scoring runs', async t => {
  const batch = await snapshotBatch(t, { steps: [{ after: 0.5, write: 'C' }], sleep: 3 });
  await execute({ batchDir: batch.batchDir, deps: batch.deps });
  const result = await readJSON(join(batch.attemptDir, 'result.json'));
  assert.deepEqual(result.snapshots.map(item => [item.t, item.status, item.score, item.score_of]), [[2, 'scored', 90, 'final']]);
  assert.equal(result.snapshots[0].report, result.report);
  assert.deepEqual(await batch.calls(), ['score C maps']);
});

test('a snapshot the scorer fails on is scored again, twice at most, then a score_error of the snapshot only; one it judges invalid scores 0', async t => {
  const batch = await snapshotBatch(t, { steps: [{ after: 1, write: 'THROW' }, { after: 2, write: 'BAD' }, { after: 2, write: 'FLAKY' }, { after: 2, write: 'C' }] });
  await execute({ batchDir: batch.batchDir, deps: batch.deps });
  const result = await readJSON(join(batch.attemptDir, 'result.json'));
  assert.equal(result.status, 'completed'); assert.equal(result.score, 90);
  assert.deepEqual(result.snapshots.map(item => [item.t, item.status, item.score, item.valid, item.tries ?? null]),
    [[2, 'score_error', null, null, 3], [4, 'scored', 0, false, null], [6, 'scored', 40, true, 2]]);
  assert.match(result.snapshots[0].error, /scorer exploded/);
  assert.deepEqual(await batch.calls(), ['score C maps', 'context', 'score THROW with-context', 'score BAD with-context', 'score FLAKY with-context',
    'context', 'score THROW with-context', 'context', 'score FLAKY with-context', 'context', 'score THROW with-context'], 'only the failed ones again, each on its own, from the stored files');
  const scoreDir = join(batch.attemptDir, 'snapshots', 'score');
  assert.deepEqual((await readdir(scoreDir)).filter(name => name.startsWith('t0002')).sort(), ['t0002.json', 't0002.try-1.json', 't0002.try-2.json']);
  assert.equal((await readJSON(join(scoreDir, 't0006.json'))).score, 40);
});

test('a snapshot that crashes the scorer every time does not keep the ones after it from being scored', async t => {
  const batch = await snapshotBatch(t, { steps: [{ after: 1, write: 'CRASH' }, { after: 2, write: 'A' }, { after: 2, write: 'C' }] });
  await execute({ batchDir: batch.batchDir, deps: batch.deps });
  const result = await readJSON(join(batch.attemptDir, 'result.json'));
  assert.equal(result.status, 'completed'); assert.equal(result.score, 90);
  assert.deepEqual(result.snapshots.map(item => [item.t, item.status, item.score, item.tries ?? null]), [[2, 'score_error', null, 3], [4, 'scored', 30, 2]]);
  assert.match(result.snapshots[0].error, /exit 3/);
  assert.deepEqual(await batch.calls(), ['score C maps', 'context', 'score CRASH with-context', 'context', 'score CRASH with-context', 'context', 'score A with-context',
    'context', 'score CRASH with-context']);
});

test('a report in which the scorer records its own failure is retried like a throw, not scored 0 like an invalid model', async t => {
  const batch = await snapshotBatch(t, { steps: [{ after: 1, write: 'OWN' }, { after: 2, write: 'BAD' }, { after: 2, write: 'C' }] });
  await execute({ batchDir: batch.batchDir, deps: batch.deps });
  const result = await readJSON(join(batch.attemptDir, 'result.json'));
  assert.equal(result.score, 90);
  assert.deepEqual(result.snapshots.map(item => [item.t, item.status, item.score, item.valid, item.tries ?? null]), [[2, 'score_error', null, null, 3], [4, 'scored', 0, false, null]]);
  assert.match(result.snapshots[0].error, /Scorer error: internal/);
  assert.deepEqual(await batch.calls(), ['score C maps', 'context', 'score OWN with-context', 'score BAD with-context', 'context', 'score OWN with-context',
    'context', 'score OWN with-context']);
  // The failed tries keep the scorer's own report.
  assert.equal((await readJSON(join(batch.attemptDir, 'snapshots', 'score', 't0002.try-1.json'))).scorer_failed, true);
});

test('a snapshot identical to a final file the scorer failed on is scored itself, not given the final report', async t => {
  const batch = await snapshotBatch(t, { steps: [{ after: 0.5, write: 'OWN' }], sleep: 3 });
  await execute({ batchDir: batch.batchDir, deps: batch.deps });
  const result = await readJSON(join(batch.attemptDir, 'result.json'));
  assert.deepEqual(result.snapshots.map(item => [item.t, item.status, item.score, item.score_of ?? null, item.tries ?? null]), [[2, 'score_error', null, null, 3]]);
  assert.deepEqual(await batch.calls(), ['score OWN maps', 'context', 'score OWN with-context', 'context', 'score OWN with-context', 'context', 'score OWN with-context']);
});

test('with --snapshot-seconds 0 nothing is taken and result.json has no snapshots', async t => {
  const batch = await snapshotBatch(t, { snapshotSeconds: 0, steps: [{ after: 0.2, write: 'C' }], sleep: 2.5 });
  assert.equal(batch.manifest.snapshots, null);
  await execute({ batchDir: batch.batchDir, deps: batch.deps });
  const result = await readJSON(join(batch.attemptDir, 'result.json'));
  assert.equal(result.score, 90); assert.equal('snapshots' in result, false); assert.equal('snapshot_interval_seconds' in result, false);
  assert.equal(await exists(join(batch.attemptDir, 'snapshots')), false);
  await assert.rejects(snapshotBatch(t, { snapshotSeconds: -1, steps: [] }), /snapshotSeconds/);
  await assert.rejects(snapshotBatch(t, { snapshotSeconds: 1.5, steps: [] }), /snapshotSeconds/);
});

test('a broken boundary leaves the snapshots unscored', async t => {
  const batch = await snapshotBatch(t, { steps: [{ after: 1, write: 'A' }, { after: 2, write: 'tamper' }, { after: 0.1, write: 'C' }] });
  await execute({ batchDir: batch.batchDir, deps: batch.deps });
  const result = await readJSON(join(batch.attemptDir, 'result.json'));
  assert.equal(result.status, 'generation_failed'); assert.equal(result.score, 0);
  assert.deepEqual(result.snapshots.map(item => [item.t, item.status, item.score]), [[2, 'not_scored', null]]);
  assert.deepEqual(await batch.calls(), ['score C maps'], 'the final file is scored for diagnosis, the snapshots are not');
});

test('a broken boundary keeps the attempt at 0 even when the scorer fails on its file: no retries, no score_error', async t => {
  const batch = await snapshotBatch(t, { steps: [{ after: 1, write: 'OWN' }, { after: 2, write: 'tamper' }, { after: 0.1, write: 'THROW' }] });
  await execute({ batchDir: batch.batchDir, deps: batch.deps });
  const result = await readJSON(join(batch.attemptDir, 'result.json'));
  assert.equal(result.status, 'generation_failed'); assert.equal(result.score, 0);
  assert.deepEqual(result.snapshots.map(item => [item.t, item.status, item.score]), [[2, 'not_scored', null]]);
  assert.deepEqual(await batch.calls(), ['score THROW maps']);
  // rescore leaves them as they are.
  assert.equal(await rescoreSnapshots({ attemptDir: batch.attemptDir, batchDir: batch.batchDir, result, finalReport: null, score: async () => { throw new Error('not called'); } }), null);
});

test('a runner that died after generation scores the snapshots from their index, keeping the partial scoring aside', async t => {
  const batch = await snapshotBatch(t, { steps: [{ after: 1, write: 'A' }, { after: 2, write: 'C' }] });
  await execute({ batchDir: batch.batchDir, deps: batch.deps });
  const first = await readJSON(join(batch.attemptDir, 'result.json'));
  // As if the runner had been killed while scoring: no result yet, generation recorded.
  await rm(join(batch.attemptDir, 'result.json'));
  await execute({ batchDir: batch.batchDir, deps: batch.deps });
  const again = await readJSON(join(batch.attemptDir, 'result.json'));
  assert.deepEqual(again.snapshots, first.snapshots);
  assert.equal(again.score, 90);
  assert.ok(await exists(join(batch.attemptDir, 'snapshots', 'score.interrupted-1', 't0002.json')));
});

test('a restarted runner stops a snapshot scorer the dead one left running, even with no snapshot left to score', async t => {
  const batch = await snapshotBatch(t, { steps: [{ after: 0.5, write: 'C' }], sleep: 3 });
  await execute({ batchDir: batch.batchDir, deps: batch.deps });
  await rm(join(batch.attemptDir, 'result.json'));
  // A worker the dead runner started (its own process group, as captureProcess starts one).
  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'score-worker.mjs'], { detached: true, stdio: 'ignore' });
  const gone = new Promise(resolve => worker.once('exit', () => resolve(true)));
  t.after(() => { try { process.kill(worker.pid, 'SIGKILL'); } catch {} });
  await new Promise(resolve => setTimeout(resolve, 200));
  await mkdir(join(batch.attemptDir, 'snapshots', 'score'), { recursive: true });
  await writeFile(join(batch.attemptDir, 'snapshots', 'score', 'worker.json'), JSON.stringify({ pid: worker.pid, started: startTimeOf(worker.pid) }));
  await execute({ batchDir: batch.batchDir, deps: batch.deps });
  const result = await readJSON(join(batch.attemptDir, 'result.json'));
  assert.deepEqual(result.snapshots.map(item => [item.t, item.status, item.score_of]), [[2, 'scored', 'final']], 'no snapshot scoring ran');
  assert.equal(await Promise.race([gone, new Promise(resolve => setTimeout(() => resolve(false), 3000))]), true, 'the leftover worker was stopped');
});

test('rescore scores every distinct snapshot again and keeps the earlier reports', async t => {
  const dir = await scratch(t), batchDir = join(dir, 'batch'), attemptDir = join(batchDir, TASK, 'a1');
  await mkdir(join(attemptDir, 'snapshots', 'score'), { recursive: true });
  await writeFile(join(attemptDir, 'snapshots', 't0300.glb'), fakeGLB('A'));
  await writeFile(join(attemptDir, 'snapshots', 'score', 't0300.json'), '{}');
  const records = [{ t: 300, name: 't0300', present: true, sha256: sha(fakeGLB('A')), file: 'snapshots/t0300.glb', complete: true },
    { t: 600, name: 't0600', present: true, sha256: sha(fakeGLB('A')), file: 'snapshots/t0300.glb', same_as: 't0300', complete: true },
    { t: 900, name: 't0900', present: true, sha256: sha(fakeGLB('C')), file: 'snapshots/t0900.glb', complete: true }];
  // An index.json left behind by a write error: only the first tick. The rescore goes by result.json.
  await writeFile(join(attemptDir, 'snapshots', 'index.json'), JSON.stringify({ snapshots: records.slice(0, 1) }));
  const scored = [];
  // The first call throws: the snapshot is scored again.
  const score = async bytes => { scored.push(markerOf(bytes)); if (scored.length === 1) throw new Error('hiccup'); return { schema: 'e3d-report-v1', valid: true, score: SCORES[markerOf(bytes)] + 1 }; };
  const stale = new Map([[sha(fakeGLB('A')), { status: 'scored', score: 30, valid: true, report: 'old.json' }]]);
  const result = { status: 'completed', snapshots: scoredSnapshots(records, { scores: stale, final: { sha256: sha(fakeGLB('C')), score: 90, valid: true, report: 'old-final.json' } }),
    artifact: { sha256: sha(fakeGLB('C')) }, report: TASK + '/a1/score/report.json', integrity_problems: [] };
  const out = await rescoreSnapshots({ attemptDir, batchDir, result, finalReport: { valid: true, score: 91 }, score });
  assert.deepEqual(scored, ['A', 'A'], 'one content, scored again after a throw; none for the final file');
  assert.deepEqual(out.map(item => [item.t, item.score, item.score_of ?? null]), [[300, 31, null], [600, 31, 't0300'], [900, 91, 'final']]);
  assert.equal(out[0].tries, 2); assert.ok(await exists(join(attemptDir, 'snapshots', 'score', 't0300.try-1.json')));
  assert.ok(await exists(join(attemptDir, 'snapshots', 'score.previous-1', 't0300.json')));
  assert.equal(await rescoreSnapshots({ attemptDir, batchDir, result: { ...result, status: 'infra_error' }, finalReport: null, score }), null);
  assert.equal(await rescoreSnapshots({ attemptDir, batchDir, result: { status: 'completed' }, finalReport: null, score }), null, 'no snapshots recorded');
  // A snapshot the runner could not store stays lost; one the scorer failed on is scored again.
  const failed = scoredSnapshots([{ ...records[0], t: 1200, name: 't1200', file: undefined, sha256: sha(fakeGLB('B')), error: 'snapshot not written: ENOSPC' },
    { ...records[0], t: 1500, name: 't1500', file: 'snapshots/t0300.glb', same_as: undefined }], { scores: new Map([[sha(fakeGLB('A')), { status: 'score_error', score: null, valid: null, error: 'boom' }]]) });
  assert.deepEqual(failed.map(item => [item.status, item.error]), [['lost', 'snapshot not written: ENOSPC'], ['score_error', 'boom']]);
  const again = await rescoreSnapshots({ attemptDir, batchDir, result: { ...result, snapshots: failed }, finalReport: { valid: true, score: 91 }, score });
  assert.deepEqual(again.map(item => [item.t, item.status, item.score]), [[1200, 'lost', null], [1500, 'scored', 31]]);
  // A report the scorer marks as its own failure is retried; still failing, a score_error, not 0.
  // A final report like that is not reused for the snapshot with its bytes.
  const own = async () => ({ schema: 'e3d-report-v1', valid: false, scorer_failed: true, error: 'Scorer error: internal', score: 0 });
  const ownOut = await rescoreSnapshots({ attemptDir, batchDir, result, finalReport: await own(), score: own });
  assert.deepEqual(ownOut.map(item => [item.t, item.status, item.score, item.tries ?? null]), [[300, 'score_error', null, 3], [600, 'score_error', null, 3], [900, 'score_error', null, 3]]);
  assert.match(ownOut[0].error, /Scorer error: internal/);
  // A failure with no message is still a failure: an empty Error, or a flagged report with an empty error.
  for (const failing of [async () => { throw new Error(); }, async () => ({ schema: 'e3d-report-v1', valid: false, scorer_failed: true, error: '', score: 0 })]) {
    const silent = await rescoreSnapshots({ attemptDir, batchDir, result, finalReport: { valid: true, score: 91 }, score: failing });
    assert.deepEqual(silent.map(item => [item.t, item.status, item.score, item.tries ?? null]), [[300, 'score_error', null, 3], [600, 'score_error', null, 3], [900, 'scored', 91, null]]);
    assert.ok(silent[0].error, 'a failure is described even without a message');
  }
});
