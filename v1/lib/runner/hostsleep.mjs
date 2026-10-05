import { spawn } from 'node:child_process';
import { setPriority } from 'node:os';

// The host-sleep rule. A Mac whose lid is closed sleeps; timers do not fire
// while it sleeps, so an attempt that was running is killed the moment the
// machine wakes, after a wall time it never had, with its network gone for an
// unknown part of it. Such an attempt was not run under the stated conditions:
// it is an infrastructure error (`host_suspended`), archived and run again.
// The rule looks at time only, never at the score or the artifact:
//   overrun  the CLI ran longer than its wall limit plus OVERRUN_MARGIN seconds
//            (the runner kills it at the limit, so only a suspended host lets
//            it run longer), or
//   asleep   the power log (`pmset -g log`) shows the system asleep for
//            ASLEEP_MIN seconds or more between started_at and finished_at.
// Ported from v1/scripts/host-sleeps.py and relabel-host-suspended.mjs, which
// applied the same rule to the first test run after the fact.
export const OVERRUN_MARGIN = 60;
export const ASLEEP_MIN = 30;

// One state change in the power log:
//   2026-10-04 20:27:31 +0100 Sleep               \tEntering Sleep state due to 'Maintenance Sleep':...
//   2026-10-04 20:44:18 +0100 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to ...
//   2026-10-04 21:21:16 +0100 Wake                \tWake from Deep Idle [CDNVA] : due to ... lid ...
// "Wake Requests" (scheduled wakes, logged right after every Sleep),
// "WakeDetails" and "WakeTime" are bookkeeping, not state changes: taking the
// first of them for a wake would end every sleep two seconds after it began.
const STATE_LINE = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) ([+-])(\d\d)(\d\d)\s+(Sleep|Wake|DarkWake)(?=\s)(?!\s+Requests\b)/;
const STAMP = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) ([+-])(\d\d)(\d\d) /;

const epochOf = ([, y, mo, d, h, mi, s, sign, oh, om]) => Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om)) * 60000;

// The time of any timestamped line, or null.
export function stampOf(line) {
  const match = STAMP.exec(line);
  return match ? epochOf(match) : null;
}

export function parseStateLine(line) {
  const match = STATE_LINE.exec(line);
  return match ? { at: epochOf(match), kind: match[10] } : null;
}

// Accumulates a log line by line: its state changes, how many lines carried a
// timestamp, and the earliest timestamp (the log keeps a few days only).
function collector() {
  const read = { ok: true, states: [], stamped: 0, first: null };
  return {
    read,
    line(line) {
      const at = stampOf(line);
      if (at === null) return;
      read.stamped++;
      if (read.first === null || at < read.first) read.first = at;
      const state = parseStateLine(line);
      if (state) read.states.push(state);
    },
  };
}

// Sleep intervals from the state changes: a Sleep opens one (a second Sleep
// before any wake does not move its start), the next Wake or DarkWake closes
// it. A Sleep still open at the end of the log (the wake not written yet when
// the log was read) lasts until `now`: the runner is running, so the machine
// is awake.
export function sleepIntervals(states, { now = Date.now() } = {}) {
  const sorted = [...states].sort((a, b) => a.at - b.at), intervals = [];
  let start = null;
  for (const { at, kind } of sorted) {
    if (kind === 'Sleep') { if (start === null) start = at; }
    else if (start !== null) { intervals.push({ from: start, to: at, open: false }); start = null; }
  }
  if (start !== null && now > start) intervals.push({ from: start, to: now, open: true });
  return intervals;
}

// Every sleep of ASLEEP_MIN seconds or more that overlaps [from, to], and the
// seconds of the attempt spent asleep in them (as host-sleeps.py filters by
// length first and relabel-host-suspended.mjs then sums the overlaps).
export function sleepsDuring(intervals, from, to) {
  const sleeps = intervals.filter(sleep => (sleep.to - sleep.from) / 1000 >= ASLEEP_MIN && sleep.to > from && sleep.from < to);
  const asleep = sleeps.reduce((sum, sleep) => sum + Math.max(0, Math.min(to, sleep.to) - Math.max(from, sleep.from)), 0) / 1000;
  return {
    sleeps: sleeps.map(sleep => ({ from: new Date(sleep.from).toISOString(), to: new Date(sleep.to).toISOString(),
      seconds: Math.round((sleep.to - sleep.from) / 100) / 10, ...(sleep.open ? { open: true } : {}) })),
    asleep_seconds: Math.round(asleep * 10) / 10,
  };
}

// ---------------------------------------------------------------- reading pmset

// `pmset -g stats` prints "Sleep Count:<n>", a counter of system sleeps since
// boot, in a few milliseconds. `pmset -g log` takes 15-30 s and 12-26 s of CPU
// on this machine (27 MB of text), so it is read only when the counter moved
// during the attempt (or could not be read at its start).
export function parseSleepCount(text) {
  const match = /^Sleep Count:\s*(\d+)\s*$/m.exec(String(text ?? ''));
  return match ? Number(match[1]) : null;
}

function runPmset(args, { seconds = 120, onLine = null } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn('/usr/bin/pmset', args, { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (error) { resolve({ ok: false, error: error.message }); return; }
    // A low priority: the power log is read while other attempts are running.
    try { if (onLine && child.pid) setPriority(child.pid, 10); } catch {}
    let text = '', pending = '', settled = false;
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, error: 'pmset ' + args.join(' ') + ' did not finish within ' + seconds + ' s' }); }, seconds * 1000);
    child.stdout.on('data', bytes => {
      if (!onLine) { text += bytes.toString('utf8'); return; }
      pending += bytes.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) onLine(line);
    });
    child.on('error', error => finish({ ok: false, error: error.message }));
    child.on('close', code => {
      if (onLine && pending) onLine(pending);
      finish(code === 0 ? { ok: true, text } : { ok: false, error: 'pmset ' + args.join(' ') + ' exited ' + code });
    });
  });
}

// The real power log. Only state-change lines are kept while it streams, so
// the 27 MB of text is never held in memory.
export const PMSET = {
  async sleepCount() {
    const run = await runPmset(['-g', 'stats'], { seconds: 20 });
    return run.ok ? parseSleepCount(run.text) : null;
  },
  async states() {
    const log = collector();
    const run = await runPmset(['-g', 'log'], { onLine: log.line });
    return run.ok ? log.read : { ok: false, reason: run.error };
  },
};

// A source built from a text, for tests (a fixture copied from `pmset -g log`)
// and for anything that has the log already.
export function textSource(logText, { sleepCount = null } = {}) {
  return {
    sleepCount: async () => typeof sleepCount === 'function' ? sleepCount() : sleepCount,
    async states() {
      const log = collector();
      for (const line of String(logText ?? '').split('\n')) log.line(line);
      return log.read;
    },
  };
}

// ---------------------------------------------------------------- the check

// What `result.json` records as host_sleep_check:
//   { checked: true, method, sleeps: [{ from, to, seconds }], asleep_seconds, sleep_count }
//   { checked: false, reason }   pmset unavailable or unparsable: the sleep half
//                                of the rule is skipped (the overrun half still applies)
// method: 'sleep-count' (the counter did not move: no sleep at all, the log was
// not read) or 'log'.
export async function hostSleepCheck({ startedAt, finishedAt, sleepCountAtStart = null, source = PMSET, now = Date.now() }) {
  const from = Date.parse(startedAt ?? ''), to = Date.parse(finishedAt ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { checked: false, reason: 'the attempt has no start or end time' };
  let countNow = null;
  try { countNow = await source.sleepCount(); } catch {}
  const sleepCount = { start: sleepCountAtStart ?? null, end: countNow };
  if (Number.isInteger(sleepCountAtStart) && Number.isInteger(countNow) && countNow === sleepCountAtStart) {
    return { checked: true, method: 'sleep-count', sleeps: [], asleep_seconds: 0, sleep_count: sleepCount };
  }
  let read;
  try { read = await source.states(); } catch (error) { read = { ok: false, reason: error.message }; }
  if (!read?.ok) return { checked: false, reason: 'pmset -g log unavailable: ' + (read?.reason ?? 'no output'), sleep_count: sleepCount };
  if (!read.stamped) return { checked: false, reason: 'pmset -g log printed no timestamped line (unparsable)', sleep_count: sleepCount };
  if (read.first !== null && read.first > from) {
    return { checked: false, reason: 'the power log begins at ' + new Date(read.first).toISOString() + ', after the attempt started', sleep_count: sleepCount };
  }
  return { checked: true, method: 'log', ...sleepsDuring(sleepIntervals(read.states, { now }), from, to), sleep_count: sleepCount };
}

// The verdict for one finished CLI process: an infra record, or null.
// run: { wall_seconds, started_at, finished_at }; check: hostSleepCheck().
export function hostSuspension({ run, wallLimitSeconds, check, modelTurns = null }) {
  const overrun = Number.isFinite(run?.wall_seconds) && Number.isFinite(wallLimitSeconds) && run.wall_seconds > wallLimitSeconds + OVERRUN_MARGIN;
  const asleep = Boolean(check?.checked && check.asleep_seconds >= ASLEEP_MIN);
  if (!overrun && !asleep) return null;
  const wall = Math.round(run.wall_seconds ?? 0), slept = check?.checked ? Math.round(check.asleep_seconds) : null;
  const parts = [];
  if (asleep) parts.push('the machine was asleep for ' + slept + ' s of this attempt (power log)');
  if (overrun) parts.push('it ran ' + wall + ' s against a wall limit of ' + wallLimitSeconds + ' s (more than ' + OVERRUN_MARGIN + ' s over)');
  return {
    reason: 'host_suspended', action: 'retry', during: 'session', model_turns: modelTurns,
    message: 'host suspended: ' + parts.join('; '),
    evidence: [
      ...(check?.checked ? (check.sleeps ?? []).map(sleep => 'asleep ' + sleep.from + ' -> ' + sleep.to + ' (' + sleep.seconds + ' s)' + (sleep.open ? ', wake not yet logged' : '')) : ['power log not checked: ' + (check?.reason ?? 'no check')]),
      'started_at ' + run.started_at + ', finished_at ' + run.finished_at,
      'wall_seconds ' + run.wall_seconds + ', wall_limit_seconds ' + wallLimitSeconds,
    ],
    retry_after: null, retry_after_source: null, retry_after_text: null,
    host: { overrun, asleep, asleep_seconds: slept },
  };
}
