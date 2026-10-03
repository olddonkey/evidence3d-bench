// How an attempt ended. The status describes the generation and the artifact;
// the score is computed independently from whatever valid artifact exists, so a
// run that timed out after writing a good model.glb is "timeout" with a score.
//   infra_error        the harness could not run the model: usage or rate limit,
//                      login, network, overloaded or failing service, a CLI that
//                      died or stalled before any model turn, an interrupted
//                      runner (see infra.mjs). Not a sample: no score, left out
//                      of every mean, and the attempt is to be run again. Never
//                      given to an attempt whose workspace boundary was broken:
//                      that is not excused as an infrastructure error
//   timeout            the wall-clock limit expired and the process tree was killed
//   generation_failed  the CLI did not finish a session normally for a reason
//                      that is the model's or unknown (launch error, non-zero
//                      exit, error result after model turns), or the workspace
//                      boundary was found broken afterwards
//   missing_artifact   the session finished but output/model.glb does not exist
//   invalid_artifact   the artifact exists but is unusable (symlink, hard link,
//                      over budget) or the scorer judged it invalid
//   score_error        the scorer failed on a valid-looking artifact
//   completed          finished normally and scored
export const STATUSES = ['completed', 'timeout', 'generation_failed', 'missing_artifact', 'invalid_artifact', 'score_error', 'infra_error'];

// Statuses that are not samples of the model: an infrastructure error is owed
// a re-run, a score error (the scorer failed, not the model) a re-score. The
// report module leaves both out of its means as well.
export const NOT_SAMPLES = ['infra_error', 'score_error'];

export function classifyStatus({ run, summary, integrityProblems = [], infra = null, artifact, report, scoreError }) {
  if (infra && !integrityProblems.length) return 'infra_error';
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
