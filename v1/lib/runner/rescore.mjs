import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { readJSON, writeJSON } from './workspace.mjs';
import { rescoreSnapshots } from './snapshots.mjs';
import { recordedGeneration, rescoredStatus, scoreAgain, scoreOf, SCORE_RETRIES } from './status.mjs';

// `v1/cli.mjs rescore` for one attempt: its stored final file
// (score/submission.glb) and its snapshots are scored again, in process, by
// `score` (glb bytes, { outDir }) -> report, by the runner's rules (README,
// Statuses): a file the scorer fails on is scored again from the same bytes
// SCORE_RETRIES times, and if it still fails the attempt is a score_error
// with no score, whatever the generation did, never a 0; a broken boundary
// keeps the attempt at 0. Generation is never repeated. Kept beside the new
// files: score/report.previous.json, score/report.try-<k>.json (the failed
// tries), result.previous.json (when result.json changes).
// `ready` is awaited before the final file is scored (the command loads the
// task there): a throw stops the rescore, as broken benchmark data should,
// instead of making every attempt of the task a score_error.
// Returns a row for the command's output, or null when the attempt has
// nothing to score again.
export async function rescoreAttempt({ batchDir, attemptDir, score, ready = async () => {} }) {
  const scoreDir = join(attemptDir, 'score'), resultPath = join(attemptDir, 'result.json'), reportPath = join(scoreDir, 'report.json');
  // The score-over-time snapshots are scored again by the same scorer.
  const snapshotsOf = (result, report) => rescoreSnapshots({ attemptDir, batchDir, result, finalReport: report, score: bytes => score(bytes, {}) });
  let glb;
  try { glb = await readFile(join(scoreDir, 'submission.glb')); }
  catch {
    // No stored submission (none was written, or it was refused): only the
    // snapshots, if there are any, have something to rescore.
    const result = await readJSON(resultPath).catch(() => null);
    const snapshots = result ? await snapshotsOf(result, null) : null;
    if (!snapshots) return null;
    if (JSON.stringify(snapshots) !== JSON.stringify(result.snapshots)) {
      await writeJSON(join(attemptDir, 'result.previous.json'), result);
      await writeJSON(resultPath, { ...result, snapshots, snapshots_rescored: { at: new Date().toISOString() } });
    }
    return { snapshots_only: true, snapshots: snapshots.map(item => item.score) };
  }
  await ready();
  let previous = null;
  try { previous = await readJSON(reportPath); await writeJSON(join(scoreDir, 'report.previous.json'), previous); } catch { /* first report */ }
  const result = await readJSON(resultPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  // A broken boundary scores 0 whatever the scorer says: one try, for diagnosis.
  const integrity = Boolean(result?.integrity_problems?.length);
  const { report, failed, failure, tries } = await scoreAgain(() => score(glb, { outDir: scoreDir }),
    { keep: (tries, failedReport) => writeJSON(join(scoreDir, 'report.try-' + tries + '.json'), failedReport), retries: integrity ? 0 : SCORE_RETRIES });
  await writeJSON(reportPath, report ?? { scorer_failed: true, error: failure });
  // Keep result.json in step: its score, and its status by the rules above.
  // An infrastructure error was never scored and stays as it is.
  let status = result?.status ?? null;
  if (result && result.status !== 'infra_error') {
    status = rescoredStatus(result, { report, failed });
    const scoreValue = integrity ? 0 : status === 'score_error' ? null : scoreOf(report);
    // Only a report the scorer wrote is one; a throw leaves none.
    const next = { ...result, status, score: scoreValue, report: report ? relative(batchDir, reportPath) : null,
      report_valid: report && !failed ? report.valid !== false : null, score_error: failed ? failure : null,
      score_tries: tries > 1 ? tries : undefined, generation_status: status === 'score_error' ? recordedGeneration(result) : undefined };
    const snapshots = await snapshotsOf(next, report);
    if (snapshots) next.snapshots = snapshots;
    if (['status', 'score', 'report', 'score_error', 'score_tries', 'generation_status', 'snapshots'].some(key => JSON.stringify(next[key]) !== JSON.stringify(result[key]))) {
      await writeJSON(join(attemptDir, 'result.previous.json'), result);
      await writeJSON(resultPath, { ...next, rescored: { at: new Date().toISOString(), scorer: report?.scorer ?? null, from_status: result.status, from_score: result.score } });
    }
  }
  return { before: previous?.score ?? null, score: failed ? null : report.score, shape: report?.shape_score ?? null, detail: report?.detail?.score ?? null, status,
    ...(failed ? { score_error: failure, tries } : {}) };
}
