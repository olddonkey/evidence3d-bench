import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { modelToGLB } from '../lib/model.mjs';
import { sampleModel } from '../fixtures/sample-model.mjs';
import { prepare, execute, manifestHash, summarize } from '../lib/runner/index.mjs';
import { makeDataRoot, fakeInstallTools, fakeScorer } from '../lib/runner/api/mock/fixtures.mjs';
import { parseStateLine, sleepIntervals, sleepsDuring, hostSleepCheck, hostSuspension, textSource, parseSleepCount, OVERRUN_MARGIN } from '../lib/runner/hostsleep.mjs';

// The host-sleep rule (hostsleep.mjs). FIXTURE is copied verbatim from
// `pmset -g log` on this machine (2026-10-04, lid closed at about 20:27 BST
// while on battery, opened 21:21): Maintenance and Sleep Service sleeps, each
// followed two to three seconds later by a "Wake Requests" line (the trap: it
// is not a wake), ended by a DarkWake, the last one by the lid Wake.
const FIXTURE = [
  "PM ASL data store: /var/log/powermanagement",
  "",
  "Time stamp                Domain              \tMessage                                                                    \tDuration  \tDelay",
  "2026-10-04 20:27:24 +0100 com.apple.sleepservices.sessionStarted\tSleepService: window begins with cap time=180 secs",
  "2026-10-04 20:27:24 +0100 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to NUB.SPMI0.SW3 nub-spmi0.0x02 rtc/Maintenance Using BATT (Charge:79%) 7 secs",
  "2026-10-04 20:27:24 +0100 WakeDetails         \tDriverReason:NUB.SPMI0.SW3 - DriverDetails:",
  "2026-10-04 20:27:24 +0100 WakeTime            \tWakeTime: 0.192 sec",
  "2026-10-04 20:27:26 +0100 com.apple.sleepservices.sessionTerminated\tSleepService: window has terminated.",
  "2026-10-04 20:27:31 +0100 Sleep               \tEntering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active Using Batt (Charge:79%) 1007 secs",
  "2026-10-04 20:27:33 +0100 Wake Requests       \t[*process=dasd request=SleepService deltaSecs=1005 wakeAt=2026-10-04 12:44:18 info=\"com.apple.dasd:501:com.apple.GenerativeFunctions.PeriodicTasks.SystemAppInstall.PostBuddy\"] [process=mDNSResponder request=Maintenance deltaSecs=7198 wakeAt=2026-10-04 14:27:31 info=\"upkeep wake\"] [process=powerd request=TCPKATurnOff deltaSecs=283976 wakeAt=2026-10-07 19:20:29] [process=powerd request=CSPNEvaluation deltaSecs=3651 wakeAt=2026-10-04 13:28:24] [process=powerd request=UserWake deltaSecs=15954 wakeAt=2026-10-04 16:53:27 info=\"com.apple.alarm.user-invisible-com.apple.osanalytics.hardhighengagementtimer,540\"]",
  "2026-10-04 20:44:18 +0100 com.apple.sleepservices.sessionStarted\tSleepService: window begins with cap time=180 secs",
  "2026-10-04 20:44:18 +0100 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to NUB.SPMI0.SW3 nub-spmi0.0x02 rtc/SleepService Using BATT (Charge:79%) 2 secs",
  "2026-10-04 20:44:18 +0100 WakeDetails         \tDriverReason:NUB.SPMI0.SW3 - DriverDetails:",
  "2026-10-04 20:44:18 +0100 WakeTime            \tWakeTime: 0.201 sec",
  "2026-10-04 20:44:20 +0100 com.apple.sleepservices.sessionTerminated\tSleepService: window has terminated.",
  "2026-10-04 20:44:20 +0100 Sleep               \tEntering Sleep state due to 'Sleep Service Back to Sleep':TCPKeepAlive=active Using Batt (Charge:79%) 957 secs",
  "2026-10-04 20:44:23 +0100 Wake Requests       \t[*process=dasd request=SleepService deltaSecs=954 wakeAt=2026-10-04 13:00:17 info=\"com.apple.dasd:501:com.apple.GenerativeFunctions.PeriodicTasks.SystemAppInstall.PostBuddy\"] [process=mDNSResponder request=Maintenance deltaSecs=7200 wakeAt=2026-10-04 14:44:23 info=\"upkeep wake\"] [process=powerd request=TCPKATurnOff deltaSecs=282966 wakeAt=2026-10-07 19:20:29] [process=powerd request=CSPNEvaluation deltaSecs=2641 wakeAt=2026-10-04 13:28:24] [process=powerd request=UserWake deltaSecs=14944 wakeAt=2026-10-04 16:53:27 info=\"com.apple.alarm.user-invisible-com.apple.osanalytics.hardhighengagementtimer,540\"]",
  "2026-10-04 21:00:17 +0100 com.apple.sleepservices.sessionStarted\tSleepService: window begins with cap time=180 secs",
  "2026-10-04 21:00:17 +0100 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to NUB.SPMI0.SW3 nub-spmi0.0x02 rtc/SleepService Using BATT (Charge:79%) 2 secs",
  "2026-10-04 21:00:17 +0100 WakeDetails         \tDriverReason:NUB.SPMI0.SW3 - DriverDetails:",
  "2026-10-04 21:00:17 +0100 WakeTime            \tWakeTime: 0.198 sec",
  "2026-10-04 21:00:19 +0100 com.apple.sleepservices.sessionTerminated\tSleepService: window has terminated.",
  "2026-10-04 21:00:19 +0100 Sleep               \tEntering Sleep state due to 'Sleep Service Back to Sleep':TCPKeepAlive=active Using Batt (Charge:79%) 906 secs",
  "2026-10-04 21:00:22 +0100 Wake Requests       \t[*process=dasd request=SleepService deltaSecs=903 wakeAt=2026-10-04 13:15:25 info=\"com.apple.dasd:501:com.apple.GenerativeFunctions.PeriodicTasks.SystemAppInstall.PostBuddy\"] [process=mDNSResponder request=Maintenance deltaSecs=7200 wakeAt=2026-10-04 15:00:22 info=\"upkeep wake\"] [process=powerd request=TCPKATurnOff deltaSecs=282007 wakeAt=2026-10-07 19:20:29] [process=powerd request=CSPNEvaluation deltaSecs=1682 wakeAt=2026-10-04 13:28:24] [process=powerd request=UserWake deltaSecs=13985 wakeAt=2026-10-04 16:53:27 info=\"com.apple.alarm.user-invisible-com.apple.osanalytics.hardhighengagementtimer,540\"]",
  "2026-10-04 21:15:25 +0100 com.apple.sleepservices.sessionStarted\tSleepService: window begins with cap time=180 secs",
  "2026-10-04 21:15:25 +0100 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to NUB.SPMI0.SW3 nub-spmi0.0x02 rtc/SleepService Using BATT (Charge:79%) 2 secs",
  "2026-10-04 21:15:25 +0100 WakeDetails         \tDriverReason:NUB.SPMI0.SW3 - DriverDetails:",
  "2026-10-04 21:15:25 +0100 WakeTime            \tWakeTime: 0.206 sec",
  "2026-10-04 21:15:27 +0100 com.apple.sleepservices.sessionTerminated\tSleepService: window has terminated.",
  "2026-10-04 21:15:27 +0100 Sleep               \tEntering Sleep state due to 'Sleep Service Back to Sleep':TCPKeepAlive=active Using Batt (Charge:79%) 349 secs",
  "2026-10-04 21:15:30 +0100 Wake Requests       \t[process=dasd request=SleepService deltaSecs=933 wakeAt=2026-10-04 13:31:03 info=\"com.apple.dasd:501:com.apple.GenerativeFunctions.PeriodicTasks.SystemAppInstall.PostBuddy\"] [process=mDNSResponder request=Maintenance deltaSecs=7200 wakeAt=2026-10-04 15:15:30 info=\"upkeep wake\"] [process=powerd request=TCPKATurnOff deltaSecs=281099 wakeAt=2026-10-07 19:20:29] [*process=powerd request=CSPNEvaluation deltaSecs=774 wakeAt=2026-10-04 13:28:24] [process=powerd request=UserWake deltaSecs=13077 wakeAt=2026-10-04 16:53:27 info=\"com.apple.alarm.user-invisible-com.apple.osanalytics.hardhighengagementtimer,540\"]",
  "2026-10-04 21:21:16 +0100 Wake                \tWake from Deep Idle [CDNVA] : due to smc.sysState.Wake(0x70070000) lid SMC.OutboxNotEmpty RTP.multi-touch/HID Activity Using BATT (Charge:79%)",
  "2026-10-04 21:21:16 +0100 WakeDetails         \tDriverReason:smc.sysState.Wake(0x70070000) - DriverDetails:",
  "2026-10-04 21:21:16 +0100 WakeTime            \tWakeTime: 0.245 sec",
  "2026-10-04 21:21:16 +0100 Notification        \tDisplay is turned on",
  "2026-10-04 21:21:16 +0100 Assertions          \tPID 552(powerd) Created UserIsActive \"com.apple.powermanagement.lidopen\" 00:00:00  id:0x0x90000967d [System: PrevIdle DeclUser kDisp]",
];
const LOG = FIXTURE.join('\n') + '\n';
const at = text => Date.parse(text);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));

// The fixture moved in time so that its first Sleep falls at `start` (the
// lines are kept as they are apart from the timestamp).
function shifted(start) {
  const first = parseStateLine(FIXTURE.find(line => / Sleep +\t/.test(line))).at, delta = start - first;
  return FIXTURE.map(line => line.replace(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) ([+-]\d{4})/, (match, stamp, zone) => {
    const sign = zone[0] === '-' ? -1 : 1, offset = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3))) * 60000;
    const local = new Date(Date.parse(stamp.replace(' ', 'T') + 'Z') + delta);
    return local.toISOString().slice(0, 19).replace('T', ' ') + ' ' + zone;
  })).join('\n');
}

test('the power log parser takes Sleep, Wake and DarkWake as state changes and nothing else', async () => {
  const states = FIXTURE.map(parseStateLine).filter(Boolean);
  assert.deepEqual(states.map(state => state.kind), ['DarkWake', 'Sleep', 'DarkWake', 'Sleep', 'DarkWake', 'Sleep', 'DarkWake', 'Sleep', 'Wake']);
  // The trap: "Wake Requests" comes right after every Sleep and is not a wake.
  assert.equal(parseStateLine(FIXTURE.find(line => line.includes('Wake Requests'))), null);
  for (const kind of ['WakeDetails', 'WakeTime', 'Assertions', 'Notification']) assert.equal(parseStateLine(FIXTURE.find(line => line.includes(' ' + kind))), null, kind);
  assert.equal(states[1].at, at('2026-10-04T19:27:31Z'), 'the +0100 offset is applied');
  const intervals = sleepIntervals(states);
  assert.deepEqual(intervals.map(sleep => [new Date(sleep.from).toISOString(), (sleep.to - sleep.from) / 1000]),
    [['2026-10-04T19:27:31.000Z', 1007], ['2026-10-04T19:44:20.000Z', 957], ['2026-10-04T20:00:19.000Z', 906], ['2026-10-04T20:15:27.000Z', 349]]);
  // Had "Wake Requests" been taken for a wake, every sleep would have lasted two or three seconds.
  const naive = FIXTURE.map(line => /^(\S+ \S+ [+-]\d{4})\s+(Sleep|Wake|DarkWake)\b/.exec(line)).filter(Boolean)
    .map(match => ({ at: Date.parse(match[1].replace(' ', 'T').replace(/ ([+-]\d\d)(\d\d)$/, '$1:$2')), kind: match[2] }));
  assert.ok(sleepIntervals(naive).every(sleep => sleep.to - sleep.from <= 3000), 'the trap is real');
  // An attempt from 20:30 to 21:00 BST slept through all of it but the 2-second windows.
  const during = sleepsDuring(intervals, at('2026-10-04T19:30:00Z'), at('2026-10-04T20:00:00Z'));
  assert.deepEqual(during.sleeps.map(sleep => sleep.from), ['2026-10-04T19:27:31.000Z', '2026-10-04T19:44:20.000Z']);
  assert.equal(during.asleep_seconds, 1800 - 2);
  // A Sleep whose wake is not logged yet lasts until now; a short sleep does not count.
  const open = sleepIntervals([{ at: 1000, kind: 'Sleep' }], { now: 61000 });
  assert.deepEqual(open, [{ from: 1000, to: 61000, open: true }]);
  assert.deepEqual(sleepsDuring([{ from: 0, to: 29000 }], 0, 100000), { sleeps: [], asleep_seconds: 0 });
  assert.equal(parseSleepCount('Sleep Count:1705\nDark Wake Count:1653\nUser Wake Count:65\n'), 1705);
});

test('hostSleepCheck reads the log only when the sleep counter moved, and says when it could not check', async () => {
  const unused = { sleepCount: async () => 7, states: async () => { throw new Error('the log must not be read'); } };
  assert.deepEqual(await hostSleepCheck({ startedAt: '2026-10-04T19:30:00Z', finishedAt: '2026-10-04T20:00:00Z', sleepCountAtStart: 7, source: unused }),
    { checked: true, method: 'sleep-count', sleeps: [], asleep_seconds: 0, sleep_count: { start: 7, end: 7 } });
  const moved = await hostSleepCheck({ startedAt: '2026-10-04T19:30:00Z', finishedAt: '2026-10-04T20:00:00Z', sleepCountAtStart: 7, source: textSource(LOG, { sleepCount: 9 }) });
  assert.deepEqual([moved.checked, moved.method, moved.asleep_seconds, moved.sleeps.length], [true, 'log', 1798, 2]);
  // No count at the start: the log decides.
  const awake = await hostSleepCheck({ startedAt: '2026-10-04T20:21:20Z', finishedAt: '2026-10-04T20:50:00Z', source: textSource(LOG) });
  assert.deepEqual([awake.checked, awake.asleep_seconds], [true, 0]);
  const failing = { sleepCount: async () => null, states: async () => ({ ok: false, reason: 'spawn /usr/bin/pmset ENOENT' }) };
  assert.match((await hostSleepCheck({ startedAt: '2026-10-04T19:30:00Z', finishedAt: '2026-10-04T20:00:00Z', source: failing })).reason, /^pmset -g log unavailable: spawn/);
  const garbage = await hostSleepCheck({ startedAt: '2026-10-04T19:30:00Z', finishedAt: '2026-10-04T20:00:00Z', source: textSource('nothing\nuseful\n') });
  assert.deepEqual([garbage.checked, /unparsable/.test(garbage.reason)], [false, true]);
  const early = await hostSleepCheck({ startedAt: '2026-10-04T18:00:00Z', finishedAt: '2026-10-04T20:00:00Z', source: textSource(LOG) });
  assert.deepEqual([early.checked, /begins at 2026-10-04T19:27:24.000Z, after the attempt started/.test(early.reason)], [false, true]);
});

test('the rule: asleep 30 s or more, or over the wall limit by more than 60 s, and never anything else', () => {
  const run = { wall_seconds: 1700, started_at: '2026-10-04T19:30:00Z', finished_at: '2026-10-04T20:00:00Z' };
  const slept = { checked: true, method: 'log', sleeps: [{ from: 'a', to: 'b', seconds: 1007 }], asleep_seconds: 1798 };
  const verdict = hostSuspension({ run, wallLimitSeconds: 1800, check: slept, modelTurns: 12 });
  assert.deepEqual([verdict.reason, verdict.action, verdict.model_turns, verdict.host], ['host_suspended', 'retry', 12, { overrun: false, asleep: true, asleep_seconds: 1798 }]);
  assert.match(verdict.message, /^host suspended: the machine was asleep for 1798 s of this attempt \(power log\)$/);
  assert.equal(hostSuspension({ run, wallLimitSeconds: 1800, check: { ...slept, asleep_seconds: 29.9 } }), null, 'under 30 s asleep');
  // Over the limit with no power log: the overrun alone decides.
  const over = hostSuspension({ run: { ...run, wall_seconds: 1800 + OVERRUN_MARGIN + 1 }, wallLimitSeconds: 1800, check: { checked: false, reason: 'pmset missing' } });
  assert.deepEqual(over.host, { overrun: true, asleep: false, asleep_seconds: null });
  assert.ok(over.evidence.includes('power log not checked: pmset missing'));
  assert.equal(hostSuspension({ run: { ...run, wall_seconds: 1800 + OVERRUN_MARGIN }, wallLimitSeconds: 1800, check: { checked: false, reason: 'x' } }), null, 'exactly 60 s over is not over');
});

// A fake Codex CLI for the re-runs: writes the sample GLB and completes.
async function fakeCodex(dir) {
  const path = join(dir, 'fake-codex'), glb = join(dir, 'sample.glb');
  await writeFile(glb, modelToGLB(sampleModel()));
  const events = [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'node build.mjs', aggregated_output: 'ok', exit_code: 0, status: 'completed' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } }];
  await writeFile(path, `#!${process.execPath}
const fs = require('fs'), path = require('path'), args = process.argv.slice(2), ws = args[args.indexOf('-C') + 1];
fs.appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, path.basename(path.dirname(path.dirname(ws))) + '\\n');
fs.copyFileSync(${JSON.stringify(glb)}, path.join(ws, 'output', 'model.glb'));
for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event) + '\\n');
`);
  await chmod(path, 0o755);
  return path;
}

test('an attempt the host slept through is infra_error host_suspended, re-run without using up the cap; a limit found beside it is kept', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'e3d-host-sleep-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataRoot = join(dir, 'data'), tasks = ['house-a-t1', 'house-b-t1'];
  await makeDataRoot(dataRoot, tasks);
  const binary = await fakeCodex(dir), scorer = join(dir, 'scorer.mjs');
  await writeFile(scorer, fakeScorer(join(dir, 'scored.log')));
  const inspect = async ({ model, effort }) => ({ system: 'codex', binary, binary_realpath: binary, binary_sha256: sha(await readFile(binary)), version: 'fake', release_root: dir,
    login: 'test', model, effort: effort ?? 'low', effort_levels: ['low'] });
  const { batchDir, manifest } = await prepare({ id: 'sleepy', system: 'codex', model: 'm', effort: 'low', tasks, dataRoot, deps: { inspect, installTools: fakeInstallTools } });
  await writeFile(join(batchDir, 'preflight.json'), JSON.stringify({ passed: true, manifest_sha256: manifestHash(manifest), checks: [] }));
  // Both attempts ran from 40 to 5 minutes ago while the lid was closed, and
  // the runner died before it could record them; process.json is on disk, so
  // the next run rebuilds them from their logs (and applies the rule then).
  const started = Date.now() - 40 * 60000, finished = Date.now() - 5 * 60000;
  const work = [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' }, { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'working' } }];
  const limit = { type: 'turn.failed', error: { message: 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again later.' } };
  for (const [task, events, run] of [['house-a-t1', work, { exit_code: null, signal: 'SIGTERM', timed_out: true }], ['house-b-t1', [...work, limit], { exit_code: 1, signal: null, timed_out: false }]]) {
    const attempt = join(batchDir, task, 'a1');
    await writeFile(join(attempt, 'started.json'), JSON.stringify({ at: new Date(started).toISOString(), pid: 999999, sleep_count: 40 }));
    await writeFile(join(attempt, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
    await writeFile(join(attempt, 'stderr.log'), '');
    await writeFile(join(attempt, 'process.json'), JSON.stringify({ started_at: new Date(started).toISOString(), finished_at: new Date(finished).toISOString(),
      wall_seconds: 1805, launch_error: null, log_error: null, aborted: false, event_ms: events.map((_, i) => i * 1000), load_1m: null, service_retry_seconds: 0, ...run }));
  }
  // The counter moved during the attempts; the log has the fixture's sleeps,
  // the first beginning 30 s before they started (the log itself 37 s
  // before: a log that begins after an attempt began cannot judge it).
  // Every later attempt sees no sleep.
  let reads = 0;
  const source = { sleepCount: async () => 41, states: async () => { reads++; return textSource(shifted(started - 30000)).states(); } };
  const FAST = { limitStepsMs: [100, 200], retryStepsMs: [100, 200], resetJitterMs: [0, 20], backoffJitter: 0.1, minimumWaitMs: 0, resumeSpacingMs: 50 };
  const summary = await execute({ batchDir, deps: { scorerModule: scorer, graceSeconds: 1, schedule: FAST, hostSleep: source }, maxReruns: 0 });
  assert.equal(summary.complete, true); assert.equal(summary.counts.completed, 2);
  const a = await readJSON(join(batchDir, 'house-a-t1', 'a1.infra-1', 'result.json'));
  assert.deepEqual([a.status, a.score, a.infra.reason, a.infra.action, a.host_sleep_check.method], ['infra_error', null, 'host_suspended', 'retry', 'log']);
  assert.ok(a.host_sleep_check.asleep_seconds >= 30 * 60, 'asleep for most of the attempt: ' + a.host_sleep_check.asleep_seconds);
  assert.match(a.infra.message, /^host suspended: the machine was asleep for \d+ s of this attempt \(power log\)$/);
  assert.equal(a.timed_out, true, 'the rule overrode a timeout the model was charged with');
  // The usage limit stays the reason (it asks for a hold); the sleep is recorded beside it.
  const b = await readJSON(join(batchDir, 'house-b-t1', 'a1.infra-1', 'result.json'));
  assert.deepEqual([b.infra.reason, b.infra.host_suspended.asleep], ['usage_limit', true]);
  for (const task of tasks) {
    const result = await readJSON(join(batchDir, task, 'a1', 'result.json'));
    assert.deepEqual([result.status, result.try, result.score], ['completed', 2, 71.5], task);
    assert.equal(result.host_sleep_check.method, 'sleep-count');
  }
  assert.equal(reads, 2, 'the log was read for the two attempts whose counter moved, and only for them');
  assert.deepEqual((await readFile(join(dir, 'calls.log'), 'utf8')).trim().split('\n').sort(), tasks, 'each task was generated once more, never the slept-through try');
  assert.equal(summary.infra.reruns, 2); assert.deepEqual(summary.infra.capped, [], 'host_suspended does not use up --max-reruns 0');
});
