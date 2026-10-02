// How an attempt ended. The status describes the generation and the artifact;
// the score is computed independently from whatever valid artifact exists, so a
// run that timed out after writing a good model.glb is "timeout" with a score.
//   timeout            the wall-clock limit expired and the process tree was killed
//   generation_failed  the CLI did not finish a session normally (launch error,
//                      non-zero exit, error result, interrupted runner) or the
//                      workspace boundary was found broken afterwards
//   missing_artifact   the session finished but output/model.glb does not exist
//   invalid_artifact   the artifact exists but is unusable (symlink, hard link,
//                      over budget) or the scorer judged it invalid
//   score_error        the scorer failed on a valid-looking artifact
//   completed          finished normally and scored
export const STATUSES = ['completed', 'timeout', 'generation_failed', 'missing_artifact', 'invalid_artifact', 'score_error'];

export function classifyStatus({ run, summary, integrityProblems = [], artifact, report, scoreError }) {
  if (run?.timed_out) return 'timeout';
  if (!run || run.launch_error || run.exit_code !== 0 || run.signal || !summary?.completed || integrityProblems.length) return 'generation_failed';
  if (!artifact?.present) return 'missing_artifact';
  if (artifact.problem) return 'invalid_artifact';
  if (scoreError || !report) return 'score_error';
  if (report.valid === false) return 'invalid_artifact';
  return 'completed';
}

export function scoreOf(report) {
  return report && report.valid !== false && Number.isFinite(report.score) ? report.score : 0;
}
