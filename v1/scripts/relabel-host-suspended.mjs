// An attempt whose measured wall time exceeds its wall limit by more than
// MARGIN seconds was not run under the stated conditions: the runner kills the
// CLI at the limit, so only a suspended host (lid closed, sleep) lets an attempt
// run longer. The model lost its network for an unknown part of that time and
// was killed the moment the machine woke. That is an infrastructure error, the
// same as the ones the runner detects itself, and the attempt is re-run.
// The rule looks only at wall time and limit, never at the score.
//
//   python3 v1/scripts/host-sleeps.py --since 2026-10-03T11:21:00Z --out sleeps.json
//   node v1/scripts/relabel-host-suspended.mjs <batchDir>... --sleeps=sleeps.json [--apply]
//
// Without --apply it only lists what it would change. Never run it on a batch
// whose runner is still alive. After --apply, start `run` again: the runner
// archives each relabelled attempt as a<n>.infra-<k>/ and runs it afresh.
import { readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

// Second, stronger evidence: the machine's own power log. sleeps.json holds the
// [start, end] of every system sleep (from `pmset -g log`); an attempt whose run
// overlapped one by OVERLAP seconds or more is relabelled whatever its status,
// because a completed attempt that slept through part of its budget was not
// run under the stated conditions either.
const MARGIN = 60, OVERLAP = 30;
const args = process.argv.slice(2), apply = args.includes('--apply');
const sleepsFile = args.find(arg => arg.startsWith('--sleeps='))?.slice(9);
const sleeps = sleepsFile ? JSON.parse(await readFile(sleepsFile, 'utf8')).map(pair => pair.map(Date.parse)) : [];
const asleep = (from, to) => sleeps.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(to, b) - Math.max(from, a)), 0) / 1000;
for (const batchDir of args.filter(arg => !arg.startsWith('--'))) {
  for (const task of (await readdir(batchDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()) {
    for (const attempt of (await readdir(join(batchDir, task)).catch(() => [])).filter(name => /^a\d+$/.test(name)).sort()) {
      const path = join(batchDir, task, attempt, 'result.json');
      let result;
      try { result = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
      const limit = result.wall_limit_seconds, wall = result.wall_seconds;
      const slept = result.started_at && result.finished_at ? asleep(Date.parse(result.started_at), Date.parse(result.finished_at)) : 0;
      if (result.status === 'infra_error' || !(limit > 0) || !(wall > limit + MARGIN || slept >= OVERLAP)) continue;
      console.log((apply ? 'RELABEL ' : 'would relabel ') + batchDir.split('/').pop() + ' ' + task + '/' + attempt + ': ' + result.status + ' score ' + result.score +
        ', wall ' + Math.round(wall) + ' s against a limit of ' + limit + ' s, host asleep for ' + Math.round(slept) + ' s of it, finished ' + result.finished_at);
      if (!apply) continue;
      await copyFile(path, join(batchDir, task, attempt, 'result.host-suspended.json'));
      const message = 'host suspended: the machine was asleep for ' + Math.round(slept) + ' s of this attempt (power log); it ran ' + Math.round(wall) + ' s against a wall limit of ' + limit + ' s';
      await writeFile(path, JSON.stringify({ ...result, status: 'infra_error', score: null, report: null, report_valid: null,
        infra: { reason: 'runner_interrupted', action: 'retry', during: 'session', model_turns: result.model_turns ?? null, message,
          evidence: ['host asleep ' + Math.round(slept) + ' s between started_at and finished_at (pmset -g log)', 'wall_seconds ' + wall + ', wall_limit_seconds ' + limit, 'original status ' + result.status + ', score ' + result.score + ' (kept in result.host-suspended.json)'],
          retry_after: null, retry_after_source: null, retry_after_text: null },
        relabelled: { at: new Date().toISOString(), rule: 'host asleep >= ' + OVERLAP + ' s during the attempt, or wall_seconds > wall_limit_seconds + ' + MARGIN, asleep_seconds: slept, from_status: result.status, from_score: result.score } }, null, 2) + '\n');
    }
  }
}
