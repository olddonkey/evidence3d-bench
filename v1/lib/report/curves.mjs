import { finite, median, quantile } from './stats.mjs';

// Score over time, from the snapshots the runner takes while an attempt runs
// (v1/lib/runner/snapshots.mjs): copies of output/model.glb every interval
// seconds after the CLI started, scored after the attempt.
//
// An attempt's score at time T:
//   - its final score (failures 0, as on the leaderboard) once it has ended
//     (wall_seconds <= T) or T has reached its wall-clock limit;
//   - before that, the score of its last snapshot taken at or before T (taken:
//     at its tick when the runner had read it within ON_TIME_SECONDS of it,
//     else when the read ended, so a late one counts from the next tick on;
//     see snapshotAt; last: the latest read, see currentSnapshot): 0 when
//     there was no output/model.glb yet, or one the runner refused, or one
//     the scorer judged invalid;
//   - missing (null) when that snapshot has no score through no fault of the
//     model: the scorer failed on it, also on the runner's retries
//     (score_error), or the runner could not store it (lost). The attempt is
//     left out of that tick's mean, and the tick reports it in `missing`; a
//     scorer failure is not the model's performance, as on the leaderboard,
//     where a final file's score_error is left out and re-scored;
//   - 0 before its first snapshot (output/ starts empty).
// At each tick the attempts are averaged exactly as the leaderboard score is
// (attempts within a task, tasks within an object, then objects), so the
// point at the wall-clock limit is the leaderboard score.
//
// Time to 95 %: per attempt whose final score is at least T95_MIN_FINAL, when
// its first snapshot with a score of at least T95_SHARE of the final score
// counts from (snapshotAt), or its end (wall_seconds) when no snapshot got there, the final file
// being the snapshot at the end; the median over those attempts (not weighted
// by object). Attempts below T95_MIN_FINAL are counted, not used: 95 % of almost
// nothing says nothing about speed.
export const T95_SHARE = 0.95;
export const T95_MIN_FINAL = 10;

// A snapshot read within this many seconds after its tick (the read itself,
// and the wait for a model caught mid-write) belongs to that tick. One read
// later, on a busy runner, is the attempt's state when the read ended, not
// at its tick: it counts from the next tick after that, and is counted as
// late (docs/V1-ROUND4-PLAN.md, section 7).
export const ON_TIME_SECONDS = 10;

// When a snapshot counts from: its tick `t`, or `read` (seconds after the
// spawn at which its read ended) when that is more than ON_TIME_SECONDS
// later. collect.mjs stores it as the point's `at`, with `late`.
export const snapshotAt = (t, read) => finite(read) && read - t > ON_TIME_SECONDS ? read : t;

// When a snapshot was taken (collect.mjs: `at`; the tick for older data).
const takenAt = point => finite(point.at) ? point.at : point.t;
const ended = (attempt, t) => (finite(attempt.wall_limit_seconds) && t >= attempt.wall_limit_seconds) || (finite(attempt.wall_seconds) && attempt.wall_seconds <= t);

const MISSING = new Set(['score_error', 'lost']);

// The attempt's snapshot at time T: of those that count from T or earlier,
// the one read last, which is the one of the highest tick (the runner reads
// the ticks in order). A late read that counts from after a newer, on-time
// one never replaces it. null before the first.
function currentSnapshot(attempt, T) {
  let current = null;
  for (const point of attempt.snapshots.points) if (takenAt(point) <= T && (!current || point.t > current.t)) current = point;
  return current;
}

export function scoreAt(attempt, t) {
  if (ended(attempt, t) || !attempt.snapshots) return attempt.score;
  const point = currentSnapshot(attempt, t);
  return !point ? 0 : finite(point.score) ? point.score : MISSING.has(point.status) ? null : 0;
}

// Seconds after the start at which the attempt first reached T95_SHARE of its
// final score: the first time a snapshot at that share became its current one
// (currentSnapshot), else its end; null when its final score is below T95_MIN_FINAL.
export function timeToShare(attempt, { share = T95_SHARE, minFinal = T95_MIN_FINAL } = {}) {
  if (!finite(attempt.score) || attempt.score < minFinal) return null;
  const end = finite(attempt.wall_seconds) ? attempt.wall_seconds : attempt.wall_limit_seconds ?? null;
  const times = [...new Set((attempt.snapshots?.points ?? []).map(takenAt))].filter(time => end === null || time < end).sort((a, b) => a - b);
  const hit = times.find(time => {
    const point = currentSnapshot(attempt, time);
    return finite(point?.score) && point.score >= share * attempt.score;
  });
  return hit ?? end;
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
    finished: attempts.filter(attempt => ended(attempt, t)).length / attempts.length, missing: attempts.filter(attempt => scoreAt(attempt, t) === null).length }));
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
    late: snapshots.filter(point => point.late).length, on_time_seconds: ON_TIME_SECONDS,
  };
}
