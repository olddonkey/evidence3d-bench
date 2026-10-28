import { lstat, mkdir, readFile, rename, access, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readJSON, writeJSON } from './workspace.mjs';
import { scoreOf } from './status.mjs';

const execFileAsync = promisify(execFile);

// Score-over-time snapshots. While an attempt generates, the runner copies the
// contestant's output/model.glb every `interval` seconds (counted from the
// CLI's spawn) to <attempt>/snapshots/t0300.glb, t0600.glb, ... outside the
// workspace, so the contestant can neither see nor change them. Nothing in the
// workspace is written and nothing frozen changes. After the attempt the
// snapshots are scored one by one (score-worker.mjs); the attempt's score is
// still the final file's alone. Layout under the attempt directory:
//   snapshots/index.json        every tick: when it was read, what was there
//   snapshots/t<seconds>.glb    one file per distinct content (a repeat names the earlier file)
//   snapshots/score/<tick>.json the scorer's report for each snapshot it scored
export const DEFAULT_SNAPSHOT_SECONDS = 300;
export const SNAPSHOT_SCHEMA = 'e3d-snapshots-v1';

// A file that is being written when the clock strikes is read again a moment
// later, a few times, before it is taken as it is.
export const SETTLE = { tries: 4, ms: 750 };

// A snapshot the scorer fails on (it throws, crashes or times out, or reports
// its own failure, see scorerFailed) is scored again from the same stored file
// this many times before it is a score_error.
export const SNAPSHOT_SCORE_RETRIES = 2;

// A report that records the scorer's failure rather than judging the file:
// score-worker.mjs writes { scorer_failed: true, error } when the scorer
// threw, and a scorer that catches its own internal error marks its report
// the same way. The scorer in v1/lib/score does not mark it yet (that changes
// its source hash; round-4 plan, section 11): its scoreSoup reports a caught
// internal error as valid: false with an error starting SCORER_ERROR_PREFIX,
// which counts too. valid: false otherwise means an invalid model, scored 0.
export const SCORER_ERROR_PREFIX = 'Scorer error: ';
export const scorerFailed = report => report?.scorer_failed === true ||
  (report?.valid === false && typeof report.error === 'string' && report.error.startsWith(SCORER_ERROR_PREFIX));

export const snapshotName = t => 't' + String(t).padStart(4, '0');

// The ticks of one attempt: every multiple of the interval strictly inside
// the wall clock. The final file is the point at the end; a tick at the limit
// itself would race the kill.
export function snapshotTicks(intervalSeconds, wallSeconds) {
  const ticks = [];
  if (!(intervalSeconds > 0) || !(wallSeconds > 0)) return ticks;
  for (let t = intervalSeconds; t < wallSeconds; t += intervalSeconds) ticks.push(t);
  return ticks;
}

// Whether bytes are a whole GLB: the magic, and a header length that matches
// what was read. A file caught mid-write has a header promising more bytes.
export function glbComplete(bytes) {
  return Boolean(bytes) && bytes.length >= 12 && bytes.readUInt32LE(0) === 0x46546c67 && bytes.readUInt32LE(8) === bytes.length;
}

// Device and inode of output/ before the CLI starts: a snapshot is only ever
// taken from that directory. Strings, as the reader (snapshot-read.mjs) gets them.
export async function outputIdentity(workspace) {
  const info = await lstat(join(workspace, 'output'), { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
}

const READER = fileURLToPath(new URL('./snapshot-read.mjs', import.meta.url));
const READ_TIMEOUT_MS = 120_000;

// Reads output/model.glb while the contestant is still running. Unlike the
// final read (readArtifact, after the process tree is gone) the contestant can
// swap files and directories under the runner while it reads, and the runner
// reads outside the sandbox. So the read happens in a short-lived process
// started in output/ (snapshot-read.mjs, where the checks are): it resolves
// nothing through the workspace path again, and reads nothing unless its
// working directory is the output/ the attempt started with. The bytes go to
// `dest` (unless their sha256 is in `known`); what it found is returned.
export async function readSnapshot(workspace, { maxBytes, output, dest = null, known = [] }) {
  const job = JSON.stringify({ dev: output.dev, ino: output.ino, maxBytes, dest, known });
  try {
    const { stdout } = await execFileAsync(process.execPath, [READER, job], { cwd: join(workspace, 'output'), env: {}, timeout: READ_TIMEOUT_MS, maxBuffer: 1 << 20 });
    return JSON.parse(stdout.trim().split('\n').at(-1));
  } catch (error) {
    // output/ gone (or a dangling symlink): nothing to read, as an empty output/.
    if (error.code === 'ENOENT' && String(error.syscall).startsWith('spawn')) return { present: false, problem: null };
    if (error.code === 'ENOTDIR' && String(error.syscall).startsWith('spawn')) return { present: true, problem: 'output/ is not the directory the attempt started with' };
    return { present: false, problem: 'output/model.glb could not be read (' + (error.killed ? 'timed out' : error.code ?? error.message) + ')' };
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

// The snapshot clock of one attempt. prepare() before the launch (it records
// output/'s identity), begin(spawnClock) when the CLI has been spawned (a
// performance.now() value), stop() once it has ended: it waits for a snapshot
// in progress and returns every record. Never throws into the attempt: a
// snapshot that cannot be read or written is recorded as such.
// Each record has its tick `t` and when the copy was taken: at_seconds, when
// the read that was kept began, and read_seconds, when it ended (both after
// the CLI's spawn). A tick reached late (a busy runner, a file still being
// written) is read late; the report counts a snapshot at its tick when it was
// read within ON_TIME_SECONDS of it, else from read_seconds (report/curves.mjs).
export function snapshotClock({ attemptDir, workspace, intervalSeconds, wallSeconds, maxBytes, settle = SETTLE, log = () => {} }) {
  const ticks = snapshotTicks(intervalSeconds, wallSeconds), records = [], dir = join(attemptDir, 'snapshots');
  let output = null, clock = null, timer = null, current = Promise.resolve(), stopped = false, indexed = true;
  const seconds = () => round((performance.now() - clock) / 1000);
  // index.json is rewritten whole after every tick; one that could not be
  // written is retried at the next tick and at stop(). It is what a restarted
  // runner reads; the records in memory are what this runner scores.
  async function writeIndex() {
    try {
      await mkdir(dir, { recursive: true });
      await writeJSON(join(dir, 'index.json'), { schema: SNAPSHOT_SCHEMA, interval_seconds: intervalSeconds, wall_seconds: wallSeconds, ticks, snapshots: records });
      indexed = true;
    } catch (error) { indexed = false; log({ event: 'snapshot_index_error', message: error.message }); }
  }

  async function take(t) {
    const name = snapshotName(t), dest = join(dir, '.' + name + '.reading');
    const known = records.filter(item => item.file && !item.same_as).map(item => item.sha256);
    await mkdir(dir, { recursive: true }).catch(() => {});
    let found, tries = 0, at;
    for (;;) {
      await unlink(dest).catch(() => {});
      at = seconds();
      found = await readSnapshot(workspace, { maxBytes, output, dest, known }).catch(error => ({ present: false, problem: 'output/model.glb could not be read: ' + error.message }));
      const settled = !found.present || (found.problem && !found.retry) || (!found.problem && found.stable && found.complete);
      if (settled || ++tries >= settle.tries) break;
      await sleep(settle.ms);
    }
    const record = { t, name, at_seconds: at, read_seconds: seconds(), present: found.present };
    if (found.problem) record.problem = found.problem;
    else if (found.present) {
      Object.assign(record, { bytes: found.bytes, sha256: found.sha256, complete: found.complete, stable: found.stable });
      const earlier = records.find(item => item.sha256 === found.sha256 && item.file);
      if (earlier) { record.file = earlier.file; record.same_as = earlier.name; }
      else if (found.written) {
        try { await rename(dest, join(dir, name + '.glb')); record.file = 'snapshots/' + name + '.glb'; }
        catch (error) { record.error = 'snapshot not written: ' + error.message; }
      } else record.error = 'snapshot not written: ' + (found.write_error ?? 'the reader stored no copy');
    }
    await unlink(dest).catch(() => {});
    records.push(record);
    await writeIndex();
    log({ event: 'snapshot', t, at_seconds: record.at_seconds, present: record.present, bytes: record.bytes ?? null, same_as: record.same_as ?? null, problem: record.problem ?? null });
  }

  function schedule(i) {
    if (stopped || i >= ticks.length) return;
    const due = clock + ticks[i] * 1000;
    // A timer may fire a millisecond early by the performance clock; it waits out the rest.
    const fire = () => {
      timer = null;
      if (stopped) return;
      if (performance.now() < due) { timer = setTimeout(fire, Math.max(1, Math.ceil(due - performance.now()))); timer.unref?.(); return; }
      current = take(ticks[i]).catch(error => log({ event: 'snapshot_error', t: ticks[i], message: error.message })).then(() => schedule(i + 1));
    };
    timer = setTimeout(fire, Math.max(0, Math.ceil(due - performance.now())));
    timer.unref?.();
  }

  return {
    ticks,
    async prepare() { output = await outputIdentity(workspace); },
    begin(spawnClock) { if (clock === null && output && !stopped) { clock = spawnClock; schedule(0); } },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
      if (!indexed) await writeIndex();
      return records;
    },
  };
}

// What a restarted runner finds of an attempt's snapshots (the generation
// ended under the previous runner; only scoring is left): the records in
// snapshots/index.json, and a `lost` record for every tick due while the CLI
// ran (`ranSeconds` after its spawn) that the index does not have, because
// the index could not be written or cannot be read. Those ticks are the
// runner's loss, missing on the curve, not a model without output.
export async function readSnapshotIndex(attemptDir, { intervalSeconds, wallSeconds, ranSeconds } = {}) {
  let records = [], problem = null;
  try {
    const index = await readJSON(join(attemptDir, 'snapshots', 'index.json'));
    if (Array.isArray(index?.snapshots)) records = index.snapshots.filter(record => Number.isFinite(record?.t));
    else problem = 'snapshots/index.json has no snapshot list';
  } catch (error) { problem = 'snapshots/index.json could not be read (' + (error.code ?? error.message) + ')'; }
  const have = new Set(records.map(record => record.t));
  const ran = Number.isFinite(ranSeconds) ? ranSeconds : wallSeconds;
  for (const t of snapshotTicks(intervalSeconds, wallSeconds)) {
    if (t < ran && !have.has(t)) records.push({ t, name: snapshotName(t), present: null, error: 'snapshot record lost: ' + (problem ?? 'not in snapshots/index.json') });
  }
  return records.sort((a, b) => a.t - b.t);
}

// The files to score: one per distinct content, none for content the final
// artifact already scored.
export function snapshotJobs(records, finalSha = null) {
  const seen = new Set(), jobs = [];
  for (const record of records) {
    if (!record.present || record.problem || record.error || !record.file || record.sha256 === finalSha || seen.has(record.sha256)) continue;
    seen.add(record.sha256);
    jobs.push({ name: record.name, file: record.file, sha256: record.sha256 });
  }
  return jobs;
}

// The records as result.json carries them, each with a status and a score:
//   absent       no output/model.glb at that tick: score 0
//   refused      a file the runner would not take (symlink, hard link, over
//                budget, replaced while read): score 0, as the final read would
//   scored       scored (or the same bytes as a scored file, see score_of):
//                the scorer's score, 0 for an invalid model
//   score_error  the scorer failed on it, and on each retry (`tries` in all):
//                score null; the report leaves the attempt out of that tick
//   lost         read but not stored (a write error of the runner), or its
//                record lost with index.json (readSnapshotIndex): score
//                null, left out like a score_error
//   not_scored   the attempt's snapshots were not scored (an infrastructure
//                error or a broken boundary): score null
// scores: Map sha256 -> { status: 'scored' | 'score_error', score, valid, error, tries, report }
// final:  { sha256, score, valid, report } of the final artifact's report, or null
export function scoredSnapshots(records, { scores = new Map(), final = null, scored = true } = {}) {
  return records.map(record => {
    const base = { t: record.t, name: record.name, at_seconds: record.at_seconds, read_seconds: record.read_seconds, present: record.present, ...(record.bytes !== undefined ? { bytes: record.bytes } : {}),
      ...(record.sha256 ? { sha256: record.sha256, complete: record.complete } : {}), ...(record.file ? { file: record.file } : {}), ...(record.same_as ? { same_as: record.same_as } : {}) };
    // A storage error first: a record a restarted runner lost does not know whether a file was there.
    if (record.error) return { ...base, status: 'lost', score: null, valid: null, error: record.error };
    if (!record.present) return { ...base, status: 'absent', score: 0, valid: false, ...(record.problem ? { problem: record.problem } : {}) };
    if (record.problem) return { ...base, status: 'refused', score: 0, valid: false, problem: record.problem };
    if (!scored) return { ...base, status: 'not_scored', score: null, valid: null };
    if (final && record.sha256 === final.sha256) return { ...base, status: 'scored', score: final.score, valid: final.valid, score_of: 'final', report: final.report };
    const found = scores.get(record.sha256);
    if (!found) return { ...base, status: 'not_scored', score: null, valid: null };
    const own = snapshotJobs(records).find(job => job.sha256 === record.sha256)?.name;
    return { ...base, status: found.status, score: found.score, valid: found.valid, ...(found.error ? { error: found.error } : {}), ...(found.tries ? { tries: found.tries } : {}),
      ...(own && own !== record.name ? { score_of: own } : {}), report: found.report ?? null };
  });
}

// A snapshot record as the clock made it, from its entry in result.json
// (scoredSnapshots added the status and the score). `error` there is a
// storage error only for a lost snapshot; otherwise it is the scorer's.
function recordOf(item) {
  const record = { t: item.t, name: item.name, at_seconds: item.at_seconds, read_seconds: item.read_seconds, present: item.present };
  for (const key of ['bytes', 'sha256', 'complete', 'file', 'same_as', 'problem']) if (item[key] !== undefined) record[key] = item[key];
  if (item.status === 'lost') record.error = item.error ?? 'not stored';
  return record;
}

// `cli rescore` for one attempt's snapshots: every distinct snapshot is scored
// again by `score` (glb bytes -> report, in process; a throw is retried as in
// the runner), the earlier reports kept as snapshots/score.previous-<n>/. Returns the new records for result.json,
// or null when the attempt has no snapshots or they are not to be scored (an
// infrastructure error, a broken boundary).
export async function rescoreSnapshots({ attemptDir, batchDir, result, finalReport, score }) {
  if (!Array.isArray(result?.snapshots) || result.status === 'infra_error' || result.integrity_problems?.length) return null;
  // The records come from result.json, the attempt's completed record, not
  // from snapshots/index.json, which a write error may have left behind.
  const records = result.snapshots.map(recordOf);
  if (!records.length) return null;
  const finalSha = typeof result.artifact?.sha256 === 'string' ? result.artifact.sha256 : null;
  const final = finalReport && finalSha && !scorerFailed(finalReport) ? { sha256: finalSha, score: scoreOf(finalReport), valid: finalReport.valid !== false,
    report: typeof result.report === 'string' ? result.report : null } : null;
  const jobs = snapshotJobs(records, final?.sha256 ?? null), scores = new Map(), scoreDir = join(attemptDir, 'snapshots', 'score');
  if (jobs.length) {
    if (await access(scoreDir).then(() => true, () => false)) {
      let n = 1;
      while (await access(scoreDir + '.previous-' + n).then(() => true, () => false)) n++;
      await rename(scoreDir, scoreDir + '.previous-' + n);
    }
    await mkdir(scoreDir, { recursive: true });
  }
  for (const job of jobs) {
    const path = join(scoreDir, job.name + '.json');
    for (let tries = 1; ; tries++) {
      // Whether the scorer failed, apart from what it said (a message may be empty).
      let report = null, failed = false, failure = '';
      try {
        report = await score(await readFile(join(attemptDir, job.file)));
        if (!report || typeof report !== 'object') { failed = true; failure = 'the scorer returned no report'; report = null; }
        else if (scorerFailed(report)) { failed = true; failure = report.error || 'the scorer reported that it failed'; }
      } catch (error) { failed = true; failure = error?.message || String(error) || 'the scorer threw'; }
      if (!failed) {
        await writeJSON(path, report);
        scores.set(job.sha256, { status: 'scored', score: scoreOf(report), valid: report.valid !== false, ...(report.valid === false && report.error ? { error: report.error } : {}),
          ...(tries > 1 ? { tries } : {}), report: relative(batchDir, path) });
        break;
      }
      await writeJSON(tries > SNAPSHOT_SCORE_RETRIES ? path : join(scoreDir, job.name + '.try-' + tries + '.json'), report ?? { scorer_failed: true, error: failure });
      if (tries > SNAPSHOT_SCORE_RETRIES) { scores.set(job.sha256, { status: 'score_error', score: null, valid: null, tries, error: failure }); break; }
    }
  }
  return scoredSnapshots(records, { scores, final });
}
