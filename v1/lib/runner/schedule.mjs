import { rng } from '../rng.mjs';

// When a batch may launch its next attempt. A usage or rate limit, or a
// service that keeps failing, puts the whole batch on hold: nothing new is
// launched (running attempts finish on their own), and after the hold the
// batch resumes with launches spaced out, so one probe meets a limit that is
// still in force instead of every slot at once.
//
//   limit  usage_limit, rate_limit: until the stated reset time, else an
//          exponential backoff from 2 to 30 minutes
//   retry  overloaded, server_error, network, cli_crash, cli_stalled: an
//          exponential backoff from 1 to 30 minutes, so an outage costs a few
//          tries per hour instead of one per attempt
//
// Several runners share a login (two batches per account), so each one waits
// on the evidence its own attempts produced, and every hold gets jitter drawn
// from the batch id: two batches that hit the same limit do not restart in
// the same second.

const MINUTE = 60000;
export const SCHEDULE = {
  limitStepsMs: [2, 4, 8, 16, 30].map(minutes => minutes * MINUTE),
  retryStepsMs: [1, 2, 4, 8, 16, 30].map(minutes => minutes * MINUTE),
  // A stated reset time is waited out with this much margin on top, drawn
  // per hold: the reset is never exact to the second, and two batches on one
  // login should not knock at the same moment.
  resetJitterMs: [30000, 150000],
  // Backoff holds get up to this fraction of their step on top.
  backoffJitter: 0.25,
  // A stated reset time closer than this is waited out for this long anyway.
  minimumWaitMs: 60000,
  // After a hold, launches are spaced out by this much (the first goes at once).
  resumeSpacingMs: 45000,
};

export const HOLD_KIND = { wait: 'limit', retry: 'retry' };

const step = (steps, index) => steps[Math.min(Math.max(index, 0), steps.length - 1)];

// Interruptible sleep: resolves early (false) when the signal aborts.
export function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(false); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(true); }, Math.max(0, ms));
    const onAbort = () => { clearTimeout(timer); resolve(false); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// The end of a hold for one infrastructure error. `streak` counts the holds of
// this kind already served since the batch last produced a sample, so a limit
// that is still in force after its stated reset (or an outage that goes on)
// is waited out for longer each time. `draw` is the hold's sequence number in
// this batch, the source of its jitter.
export function holdUntil({ kind, retryAfter = null, streak = 0, now = Date.now(), seed = '', draw = 0, schedule = SCHEDULE }) {
  const random = rng(String(seed) + '/hold/' + draw);
  if (kind === 'limit') {
    const stated = retryAfter ? Date.parse(retryAfter) : NaN;
    let base = Number.isFinite(stated) ? Math.max(stated, now + schedule.minimumWaitMs) : now + step(schedule.limitStepsMs, streak);
    // A stated reset that did not hold the last time is not trusted alone.
    if (Number.isFinite(stated) && streak > 0) base = Math.max(base, now + step(schedule.limitStepsMs, streak - 1));
    const [low, high] = schedule.resetJitterMs;
    return { until: Math.round(base + random.range(low, high)), basis: Number.isFinite(stated) ? 'retry_after' : 'backoff' };
  }
  const length = step(schedule.retryStepsMs, streak);
  return { until: Math.round(now + length + random.range(0, schedule.backoffJitter * length)), basis: 'backoff' };
}

// The launch gate of one runner. All decisions are in memory; the runner
// persists `snapshot()` so that `status` and a restarted runner can see them.
export function createGate({ seed, wait = true, concurrency = 1, schedule = SCHEDULE, onEvent = () => {}, initial = null }) {
  const state = {
    hold: null,          // { kind, reason, until, since, basis, retry_after, attempt, evidence, streak }
    streak: { limit: 0, retry: 0 },
    draws: 0,
    resumedAt: null,
    spacingLeft: 0,
    lastLaunch: 0,
    blocked: null,       // the hold a --no-wait runner refused to wait out
  };
  if (initial?.hold && Date.parse(initial.hold.until_at ?? '') > Date.now()) {
    state.hold = { ...initial.hold, since: Date.parse(initial.hold.since ?? '') || Date.now(), until: Date.parse(initial.hold.until_at), restored: true };
  }
  if (initial?.streak) state.streak = { limit: initial.streak.limit ?? 0, retry: initial.streak.retry ?? 0 };
  if (Number.isInteger(initial?.draws)) state.draws = initial.draws;

  const describe = hold => hold && {
    kind: hold.kind, reason: hold.reason, since: new Date(hold.since).toISOString(), until_at: new Date(hold.until).toISOString(),
    basis: hold.basis, retry_after: hold.retry_after ?? null, attempt: hold.attempt ?? null, evidence: hold.evidence ?? null, streak: hold.streak,
  };

  return {
    get hold() { return state.hold; },
    get blocked() { return state.blocked; },
    // Whether a hold is in force right now (a launch must not start).
    holding: (now = Date.now()) => Boolean(state.hold && now < state.hold.until),
    snapshot: () => ({ hold: describe(state.hold), streak: { ...state.streak }, draws: state.draws }),
    describe,

    // An infrastructure error that calls for a hold. Returns the hold now in force.
    holdFor({ kind, reason, retryAfter = null, attempt = null, evidence = null, launchedAt = null, now = Date.now() }) {
      const active = state.hold && state.hold.until > now;
      // Attempts that were already running when a hold began fail on the same
      // condition; they do not make the backoff longer. One launched after the
      // last resume that meets the same condition again does.
      const fresh = !active && !(launchedAt !== null && state.resumedAt !== null && launchedAt < state.resumedAt);
      const streak = state.streak[kind] ?? 0;
      const next = holdUntil({ kind, retryAfter, streak, now, seed, draw: ++state.draws, schedule });
      if (fresh) state.streak[kind] = streak + 1;
      if (active) {
        // Already holding: a later reset or a stronger kind extends it.
        const extended = next.until > state.hold.until;
        if (extended) Object.assign(state.hold, { until: next.until, basis: next.basis, retry_after: retryAfter ?? state.hold.retry_after, reason, kind: kind === 'limit' ? 'limit' : state.hold.kind, attempt, evidence });
        onEvent({ event: extended ? 'wait_extended' : 'wait_joined', ...describe(state.hold), joined_by: attempt, joined_reason: reason });
        return state.hold;
      }
      state.hold = { kind, reason, since: now, until: next.until, basis: next.basis, retry_after: retryAfter, attempt, evidence, streak: streak + (fresh ? 1 : 0) };
      onEvent({ event: 'waiting', ...describe(state.hold), wait: wait ? 'in-process' : 'exit (--no-wait)' });
      return state.hold;
    },

    // A sample from an attempt launched after the last hold ended: the service
    // works again, so the next hold starts from the shortest step.
    success({ launchedAt = null } = {}) {
      if (state.resumedAt === null || launchedAt === null || launchedAt >= state.resumedAt) state.streak = { limit: 0, retry: 0 };
    },

    // Waits until a launch is allowed. Returns false when the runner must stop
    // launching: aborted, or holding with waiting disabled.
    async pass(signal, { stopped = () => false } = {}) {
      for (;;) {
        if (signal?.aborted || stopped()) return false;
        const now = Date.now();
        if (state.hold) {
          if (now < state.hold.until) {
            if (!wait) { state.blocked = describe(state.hold); return false; }
            await sleep(Math.min(state.hold.until - now, MINUTE), signal);
            continue;
          }
          const served = state.hold;
          state.hold = null;
          state.resumedAt = now;
          state.spacingLeft = Math.max(0, concurrency - 1);
          state.lastLaunch = now;
          onEvent({ event: 'resumed', kind: served.kind, reason: served.reason, waited_seconds: Math.round((now - served.since) / 1000),
            since: new Date(served.since).toISOString(), until_at: new Date(served.until).toISOString() });
          return true;
        }
        if (state.spacingLeft > 0) {
          const at = state.lastLaunch + schedule.resumeSpacingMs;
          if (now < at) { await sleep(at - now, signal); continue; }
          state.spacingLeft--;
        }
        state.lastLaunch = now;
        return true;
      }
    },
  };
}
