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
//   budget_exhausted   (API systems) the session used up its token or tool-call
//                      budget; like timeout, scored from whatever artifact exists
//   generation_failed  the CLI did not finish a session normally for a reason
//                      that is the model's or unknown (launch error, non-zero
//                      exit, error result after model turns), or the workspace
//                      boundary was found broken afterwards
//   missing_artifact   the session finished but output/model.glb does not exist
//   invalid_artifact   the artifact exists but is unusable (symlink, hard link,
//                      over budget) or the scorer judged it invalid
//   score_error        the scorer failed on a valid-looking artifact (it threw,
//                      crashed or timed out, or reported its own failure, see
//                      scorerFailed), also when it was scored again from the
//                      same stored file SCORE_RETRIES times. Whatever the
//                      generation did: comes right after infra_error, so a run
//                      that timed out is a score_error too (its own status is
//                      kept in generation_status). Not given to an attempt
//                      whose workspace boundary was broken: that is 0
//   completed          finished normally and scored
// Precedence, first match wins: infra_error, score_error, timeout,
// budget_exhausted, generation_failed, missing_artifact, invalid_artifact,
// completed.
export const STATUSES = ['completed', 'timeout', 'budget_exhausted', 'generation_failed', 'missing_artifact', 'invalid_artifact', 'score_error', 'infra_error'];

// Statuses that are not samples of the model: an infrastructure error is owed
// a re-run, a score error (the scorer failed, not the model) a re-score. The
// report module leaves both out of its means as well.
export const NOT_SAMPLES = ['infra_error', 'score_error'];

// A report that records the scorer's failure rather than judging the file:
// v1/lib/score marks an internal error it caught `scorer_failed: true` (an
// error starting SCORER_ERROR_PREFIX, valid: false and score 0 come with it),
// and score-worker.mjs writes { scorer_failed: true, error } for a snapshot
// the scorer threw on. A report with valid: false and such an error but no
// flag (written before v1/lib/score set it) counts too. valid: false otherwise
// means an invalid model, scored 0.
export const SCORER_ERROR_PREFIX = 'Scorer error: ';
export const scorerFailed = report => report?.scorer_failed === true ||
  (report?.valid === false && typeof report.error === 'string' && report.error.startsWith(SCORER_ERROR_PREFIX));

// A file the scorer fails on is scored again from the same stored file this
// many times before it is a score_error (the final file, each snapshot and
// `cli rescore` alike); nothing is generated again.
export const SCORE_RETRIES = 2;

// What the generation alone says, before the artifact and the scorer have a
// say: timeout, budget_exhausted or generation_failed, or null for a session
// that finished normally.
export const GENERATION_STATUSES = ['timeout', 'budget_exhausted', 'generation_failed'];
export function generationStatus({ run, summary, integrityProblems = [] }) {
  if (run?.timed_out) return 'timeout';
  if (summary?.budget_exhausted && run && !run.launch_error && run.exit_code === 0 && !run.signal && !integrityProblems.length) return 'budget_exhausted';
  if (!run || run.launch_error || run.exit_code !== 0 || run.signal || !summary?.completed || integrityProblems.length) return 'generation_failed';
  return null;
}

export function classifyStatus({ run, summary, integrityProblems = [], infra = null, artifact, report, scoreError }) {
  if (infra && !integrityProblems.length) return 'infra_error';
  // A broken boundary is 0 whatever the scorer did. Otherwise a file the
  // scorer did not judge is no sample, whatever the generation did.
  if (!integrityProblems.length && artifact?.present && !artifact.problem && (scoreError || !report || scorerFailed(report))) return 'score_error';
  const generation = generationStatus({ run, summary, integrityProblems });
  if (generation) return generation;
  if (!artifact?.present) return 'missing_artifact';
  if (artifact.problem || report?.valid === false) return 'invalid_artifact';
  return 'completed';
}

// What the generation alone said of a recorded attempt (its result.json), as
// generationStatus: kept in generation_status beside a score_error (an older
// runner left it out, but gave score_error only to a session that finished
// normally), else the status itself when it is the generation's.
export function recordedGeneration(result) {
  if (result.status === 'score_error') return GENERATION_STATUSES.includes(result.generation_status) ? result.generation_status : null;
  return GENERATION_STATUSES.includes(result.status) ? result.status : null;
}

// The status of a recorded attempt once `cli rescore` has scored its stored
// final file again, by the rules of classifyStatus: a broken boundary keeps
// its status (and its 0); the scorer failing on every try makes a
// score_error; otherwise the generation's own status stands, and a session
// that finished normally is completed or invalid_artifact by the new report.
export function rescoredStatus(result, { report, failed }) {
  if (result.status === 'infra_error' || result.integrity_problems?.length) return result.status;
  if (failed) return 'score_error';
  return recordedGeneration(result) ?? (report?.valid === false ? 'invalid_artifact' : 'completed');
}

// Scores one stored file in process (`score`: () => report, as `cli rescore`
// does) until the scorer does not fail on it, 1 + `retries` times at most.
// Each failed try but the last goes to keep(tries, report) before the next
// (the scorer's report, or { scorer_failed: true, error } when it threw or
// returned none). Returns the last try: { report (null when there was none),
// failed, failure (why), tries }.
export async function scoreAgain(score, { keep = async () => {}, retries = SCORE_RETRIES } = {}) {
  for (let tries = 1; ; tries++) {
    // Whether the scorer failed, apart from what it said (a message may be empty).
    let report = null, failure = null;
    try {
      report = await score();
      if (!report || typeof report !== 'object') { report = null; failure = 'the scorer returned no report'; }
      else if (scorerFailed(report)) failure = report.error || 'the scorer reported that it failed';
    } catch (error) { failure = error?.message || String(error) || 'the scorer threw'; }
    if (failure === null) return { report, failed: false, failure, tries };
    if (tries > retries) return { report, failed: true, failure, tries };
    await keep(tries, report ?? { scorer_failed: true, error: failure });
  }
}

export function scoreOf(report) {
  return report && report.valid !== false && Number.isFinite(report.score) ? report.score : 0;
}
