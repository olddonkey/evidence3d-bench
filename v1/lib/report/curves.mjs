import { finite, median, quantile } from './stats.mjs';

// Score over time, from the snapshots the runner takes while an attempt runs
// (v1/lib/runner/snapshots.mjs): copies of output/model.glb every interval
// seconds after the CLI started, scored after the attempt.
//
// An attempt's score at time T:
//   - its final score (failures 0, as on the leaderboard) once it has ended
//     (wall_seconds <= T) or T has reached its wall-clock limit;
//   - before that, the score of its last snapshot taken at or before T (taken:
//     when the runner had read it, which can be after the tick it was due at
//     on a busy runner): 0 when there was no output/model.glb yet, or one the
//     runner refused, or one the scorer judged invalid; a snapshot the scorer
//     failed on also counts 0 (and is counted in score_errors);
//   - 0 before its first snapshot (output/ starts empty).
// At each tick the attempts are averaged exactly as the leaderboard score is
// (attempts within a task, tasks within an object, then objects), so the
// point at the wall-clock limit is the leaderboard score.
//
// Time to 95 %: per attempt whose final score is at least T95_MIN_FINAL, when
// its first snapshot with a score of at least T95_SHARE of the final score was
// taken, or its end (wall_seconds) when no snapshot got there, the final file
// being the snapshot at the end; the median over those attempts (not weighted
// by object). Attempts below T95_MIN_FINAL are counted, not used: 95 % of almost
// nothing says nothing about speed.
export const T95_SHARE = 0.95;
export const T95_MIN_FINAL = 10;

// When a snapshot was taken (collect.mjs: `at`; the tick for older data).
const takenAt = point => finite(point.at) ? point.at : point.t;
const ended = (attempt, t) => (finite(attempt.wall_limit_seconds) && t >= attempt.wall_limit_seconds) || (finite(attempt.wall_seconds) && attempt.wall_seconds <= t);

export function scoreAt(attempt, t) {
  if (ended(attempt, t) || !attempt.snapshots) return attempt.score;
  let value = 0;
  for (const point of attempt.snapshots.points) if (takenAt(point) <= t) value = finite(point.score) ? point.score : 0;
  return value;
}

// Seconds after the start at which the attempt first reached T95_SHARE of its
// final score; null when its final score is below T95_MIN_FINAL.
export function timeToShare(attempt, { share = T95_SHARE, minFinal = T95_MIN_FINAL } = {}) {
  if (!finite(attempt.score) || attempt.score < minFinal) return null;
  const end = finite(attempt.wall_seconds) ? attempt.wall_seconds : attempt.wall_limit_seconds ?? null;
  const hit = (attempt.snapshots?.points ?? []).find(point => finite(point.score) && point.score >= share * attempt.score && (end === null || takenAt(point) < end));
  return hit ? takenAt(hit) : end;
}

// The ticks of a set of attempts: every multiple of each interval up to the
// longest wall-clock limit, and that limit.
export function curveTicks(attempts) {
  const limit = Math.max(...attempts.map(attempt => attempt.wall_limit_seconds).filter(finite), 0);
  const ticks = new Set(limit ? [limit] : []);
  for (const interval of new Set(attempts.map(attempt => attempt.snapshots?.interval_seconds).filter(value => finite(value) && value > 0))) {
    for (let t = interval; t < limit; t += interval) ticks.add(t);
  }
  return [...ticks].sort((a, b) => a - b);
}

// One configuration's curve. `metric(name, valueOf, basis)` summarises a
// per-attempt value the way the leaderboard does (aggregate.mjs, cellEntry).
// null when no attempt has snapshots; { available: false } when only some do
// (a curve over a subset would not end at the leaderboard score).
export function timeCurve(attempts, metric) {
  const covered = attempts.filter(attempt => attempt.snapshots);
  if (!covered.length) return null;
  if (covered.length < attempts.length) {
    return { available: false, reason: (attempts.length - covered.length) + ' of ' + attempts.length + ' counted attempts have no snapshots (prepared with --snapshot-seconds 0 or by an older runner)',
      attempts_with_snapshots: covered.length, attempts: attempts.length };
  }
  const ticks = curveTicks(attempts);
  const points = ticks.map(t => ({ t, ...metric('time/' + t, attempt => scoreAt(attempt, t), 'score at ' + t + ' s: the last snapshot before the attempt ended, its final score after; same averaging as the score'),
    finished: attempts.filter(attempt => ended(attempt, t)).length / attempts.length }));
  const times = attempts.map(attempt => timeToShare(attempt)).filter(finite).sort((a, b) => a - b);
  const intervals = [...new Set(attempts.map(attempt => attempt.snapshots.interval_seconds))].sort((a, b) => a - b);
  const snapshots = attempts.flatMap(attempt => attempt.snapshots.points);
  return {
    available: true,
    interval_seconds: intervals.length === 1 ? intervals[0] : intervals,
    wall_limit_seconds: ticks.at(-1) ?? null,
    points,
    t95: {
      share: T95_SHARE, min_final: T95_MIN_FINAL,
      median_seconds: median(times), q1_seconds: quantile(times, 0.25), q3_seconds: quantile(times, 0.75),
      attempts: times.length, low_final: attempts.length - times.length,
      basis: 'per attempt with a final score of at least ' + T95_MIN_FINAL + ': the first snapshot at ' + T95_SHARE * 100 + '% of its final score, else its end; median over attempts',
    },
    snapshots: snapshots.length,
    score_errors: snapshots.filter(point => point.status === 'score_error' || point.status === 'lost').length,
    not_scored: snapshots.filter(point => point.status === 'not_scored').length,
  };
}
