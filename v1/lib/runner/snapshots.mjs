import { open, lstat, mkdir, writeFile, readFile, rename, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { sha256, readJSON, writeJSON } from './workspace.mjs';
import { scoreOf } from './status.mjs';

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
// taken from that directory.
export async function outputIdentity(workspace) {
  const info = await lstat(join(workspace, 'output'));
  return { dev: info.dev, ino: info.ino };
}

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

// Reads output/model.glb while the contestant is still running. Unlike the
// final read (readArtifact, after the process tree is gone) the contestant can
// swap files under the runner while it reads, and the runner reads outside the
// sandbox, so: the file is opened without following a symlink and without
// blocking (a FIFO would hang an ordinary open), checked on the open handle
// (a regular file, one link, within the byte budget) and read from it; then
// output/ must still be the directory the attempt started with and
// output/model.glb still the file that was read. A file replaced meanwhile
// (an atomic rename by the model, or a swap) is read again (`retry`).
export async function readSnapshot(workspace, { maxBytes, output }) {
  const dir = join(workspace, 'output'), path = join(dir, 'model.glb');
  let handle;
  try { handle = await open(path, OPEN_FLAGS); }
  catch (error) {
    if (error.code === 'ENOENT') return { present: false, problem: null };
    if (error.code === 'ELOOP' || error.code === 'EMLINK') return { present: true, problem: 'artifact is a symlink' };
    return { present: false, problem: 'output/model.glb could not be opened (' + (error.code ?? error.message) + ')' };
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) return { present: true, problem: 'artifact is not a regular file' };
    if (before.nlink !== 1) return { present: true, problem: 'artifact has ' + before.nlink + ' hard links' };
    if (before.size > maxBytes) return { present: true, bytes: before.size, problem: 'artifact is ' + before.size + ' bytes, over the ' + maxBytes + ' byte budget' };
    const data = Buffer.alloc(before.size);
    let read = 0;
    while (read < data.length) {
      const { bytesRead } = await handle.read(data, read, data.length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    const after = await handle.stat();
    const [dirInfo, pathInfo] = await Promise.all([lstat(dir).catch(() => null), lstat(path).catch(() => null)]);
    if (!dirInfo || !dirInfo.isDirectory() || dirInfo.dev !== output.dev || dirInfo.ino !== output.ino) {
      return { present: true, problem: 'output/ is not the directory the attempt started with', retry: true };
    }
    if (after.nlink !== 1) return { present: true, problem: 'artifact has ' + after.nlink + ' hard links' };
    if (!pathInfo || pathInfo.dev !== after.dev || pathInfo.ino !== after.ino) return { present: true, problem: 'output/model.glb was replaced while it was read', retry: true };
    const stable = read === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs;
    const bytes = data.subarray(0, read);
    return { present: true, bytes: bytes.length, sha256: sha256(bytes), data: bytes, stable, problem: null };
  } finally { await handle.close().catch(() => {}); }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

// The snapshot clock of one attempt. prepare() before the launch (it records
// output/'s identity), begin(spawnClock) when the CLI has been spawned (a
// performance.now() value), stop() once it has ended: it waits for a snapshot
// in progress and returns every record. Never throws into the attempt: a
// snapshot that cannot be read or written is recorded as such.
export function snapshotClock({ attemptDir, workspace, intervalSeconds, wallSeconds, maxBytes, settle = SETTLE, log = () => {} }) {
  const ticks = snapshotTicks(intervalSeconds, wallSeconds), records = [], dir = join(attemptDir, 'snapshots');
  let output = null, clock = null, timer = null, current = Promise.resolve(), stopped = false;
  const write = () => writeJSON(join(dir, 'index.json'), { schema: SNAPSHOT_SCHEMA, interval_seconds: intervalSeconds, wall_seconds: wallSeconds, ticks, snapshots: records });

  async function take(t) {
    const name = snapshotName(t), at = (performance.now() - clock) / 1000;
    let found, tries = 0;
    for (;;) {
      found = await readSnapshot(workspace, { maxBytes, output }).catch(error => ({ present: false, problem: 'output/model.glb could not be read: ' + error.message }));
      const settled = !found.present || (found.problem && !found.retry) || (!found.problem && found.stable && glbComplete(found.data));
      if (settled || ++tries >= settle.tries) break;
      await sleep(settle.ms);
    }
    const record = { t, name, at_seconds: round(at), read_seconds: round((performance.now() - clock) / 1000), present: found.present };
    if (found.problem) record.problem = found.problem;
    else if (found.present) {
      Object.assign(record, { bytes: found.bytes, sha256: found.sha256, complete: glbComplete(found.data), stable: found.stable });
      const earlier = records.find(item => item.sha256 === found.sha256 && item.file);
      if (earlier) { record.file = earlier.file; record.same_as = earlier.name; }
      else {
        try {
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, name + '.glb'), found.data, { flag: 'wx' });
          record.file = 'snapshots/' + name + '.glb';
        } catch (error) { record.error = 'snapshot not written: ' + error.message; }
      }
    }
    records.push(record);
    try { await mkdir(dir, { recursive: true }); await write(); } catch (error) { record.error ??= 'index not written: ' + error.message; }
    log({ event: 'snapshot', t, at_seconds: record.at_seconds, present: record.present, bytes: record.bytes ?? null, same_as: record.same_as ?? null, problem: record.problem ?? null });
  }

  function schedule(i) {
    if (stopped || i >= ticks.length) return;
    timer = setTimeout(() => {
      timer = null;
      current = take(ticks[i]).catch(error => log({ event: 'snapshot_error', t: ticks[i], message: error.message })).then(() => schedule(i + 1));
    }, Math.max(0, clock + ticks[i] * 1000 - performance.now()));
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
      return records;
    },
  };
}

// What a restarted runner finds of an attempt's snapshots (the generation
// ended under the previous runner; only scoring is left).
export async function readSnapshotIndex(attemptDir) {
  try { return (await readJSON(join(attemptDir, 'snapshots', 'index.json'))).snapshots ?? []; } catch { return []; }
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
//   score_error  the scorer failed on it: score null
//   lost         read but not stored (a write error of the runner): score null
//   not_scored   the attempt's snapshots were not scored (an infrastructure
//                error or a broken boundary): score null
// scores: Map sha256 -> { status: 'scored' | 'score_error', score, valid, error, report }
// final:  { sha256, score, valid, report } of the final artifact's report, or null
export function scoredSnapshots(records, { scores = new Map(), final = null, scored = true } = {}) {
  return records.map(record => {
    const base = { t: record.t, name: record.name, at_seconds: record.at_seconds, present: record.present, ...(record.bytes !== undefined ? { bytes: record.bytes } : {}),
      ...(record.sha256 ? { sha256: record.sha256, complete: record.complete } : {}), ...(record.file ? { file: record.file } : {}), ...(record.same_as ? { same_as: record.same_as } : {}) };
    if (!record.present) return { ...base, status: 'absent', score: 0, valid: false, ...(record.problem ? { problem: record.problem } : {}) };
    if (record.problem) return { ...base, status: 'refused', score: 0, valid: false, problem: record.problem };
    if (record.error) return { ...base, status: 'lost', score: null, valid: null, error: record.error };
    if (!scored) return { ...base, status: 'not_scored', score: null, valid: null };
    if (final && record.sha256 === final.sha256) return { ...base, status: 'scored', score: final.score, valid: final.valid, score_of: 'final', report: final.report };
    const found = scores.get(record.sha256);
    if (!found) return { ...base, status: 'not_scored', score: null, valid: null };
    const own = snapshotJobs(records).find(job => job.sha256 === record.sha256)?.name;
    return { ...base, status: found.status, score: found.score, valid: found.valid, ...(found.error ? { error: found.error } : {}),
      ...(own && own !== record.name ? { score_of: own } : {}), report: found.report ?? null };
  });
}

// `cli rescore` for one attempt's snapshots: every distinct snapshot is scored
// again by `score` (glb bytes -> report, in process), the earlier reports kept
// as snapshots/score.previous-<n>/. Returns the new records for result.json,
// or null when the attempt has no snapshots or they are not to be scored (an
// infrastructure error, a broken boundary).
export async function rescoreSnapshots({ attemptDir, batchDir, result, finalReport, score }) {
  if (!Array.isArray(result?.snapshots) || result.status === 'infra_error' || result.integrity_problems?.length) return null;
  const records = await readSnapshotIndex(attemptDir);
  if (!records.length) return null;
  const finalSha = typeof result.artifact?.sha256 === 'string' ? result.artifact.sha256 : null;
  const final = finalReport && finalSha ? { sha256: finalSha, score: scoreOf(finalReport), valid: finalReport.valid !== false,
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
    try {
      const report = await score(await readFile(join(attemptDir, job.file)));
      await writeJSON(path, report);
      scores.set(job.sha256, { status: 'scored', score: scoreOf(report), valid: report.valid !== false, ...(report.valid === false && report.error ? { error: report.error } : {}),
        report: relative(batchDir, path) });
    } catch (error) {
      await writeJSON(path, { scorer_failed: true, error: error?.message ?? String(error) });
      scores.set(job.sha256, { status: 'score_error', score: null, valid: null, error: error?.message ?? String(error) });
    }
  }
  return scoredSnapshots(records, { scores, final });
}
