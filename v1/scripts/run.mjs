#!/usr/bin/env node
// Evidence3D v1 generation runner.
//   node v1/scripts/run.mjs prepare   --id <batch> --system codex|claude-code|grok|antigravity|api-anthropic|api-openai --model <id> [--effort <level>]
//                                     --tasks a,b,c [--attempts 1] [--data <root>] [--binary <cli path>] [--snapshot-seconds 300]
//                                     [--token-budget 2000000] [--tool-budget 200] [--max-output-tokens 32000]   (API systems)
//   node v1/scripts/run.mjs preflight --batch <dir> [--probe-model <id>] [--probe-effort <level>] [--no-wait]
//   node v1/scripts/run.mjs run       --batch <dir> [--concurrency 1] [--no-wait] [--resume-now] [--max-reruns 5] [--retry-stall-minutes 10]
//   node v1/scripts/run.mjs status    --batch <dir>[,<dir>...] [--json]
//   node v1/scripts/run.mjs summary   --batch <dir> [--json]
//   node v1/scripts/run.mjs antigravity-settings [--write]   the agy settings a batch needs (antigravity-config.mjs)
// Progress is printed as one JSON object per line; `run` also appends one
// compact text line per finished attempt (and per wait, resume and stop) to
// <batch>/progress.log. `run` can be stopped with Ctrl-C (or SIGTERM/SIGHUP)
// and started again with the same command: it continues where it stopped,
// re-running attempts that ended in an infrastructure error. On a usage or
// rate limit it waits inside the same invocation (--no-wait: it exits).
// The API systems read ANTHROPIC_API_KEY / OPENAI_API_KEY from the environment
// (E3D_ANTHROPIC_BASE_URL / E3D_OPENAI_BASE_URL point them elsewhere, frozen
// at prepare); preflight and run stop with exit 3 when the key is not set.
// The CLI binaries default to E3D_CODEX_BIN, E3D_CLAUDE_BIN, E3D_GROK_BIN and E3D_AGY_BIN
// (else ~/.local/bin/codex.opencodex-real, ~/.local/bin/claude, ~/.grok/bin/grok, ~/.local/bin/agy).
// Exit codes: 0 nothing left to run, 1 error, 3 stopped for a human (login,
// key, billing, model id, a changed scorer/runner/CLI), 75 would have had to wait
// (--no-wait; run again after the time printed), 130 stopped by a signal.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { prepare, preflight, execute, summarize, batchStatus, describeState, DEFAULT_DATA_ROOT, DEFAULT_MAX_RERUNS, DEFAULT_RETRY_STALL_SECONDS } from '../lib/runner/index.mjs';
import { nodeRuntime } from '../lib/runner/adapters.mjs';
import { DEFAULT_SNAPSHOT_SECONDS } from '../lib/runner/snapshots.mjs';
import { agySettingsPath, readAgySettings, agyMergedSettings, agyConfigProblems } from '../lib/runner/antigravity-config.mjs';

const USAGE = `Usage:
  node v1/scripts/run.mjs prepare   --id <batch> --system codex|claude-code|grok|antigravity|api-anthropic|api-openai --model <id> [--effort <level>] --tasks a,b,c [--attempts 1] [--data <root>]
                                    [--snapshot-seconds ${DEFAULT_SNAPSHOT_SECONDS}] (score-over-time snapshots; 0: none)
                                    [--binary <path>] (CLI systems) [--token-budget 2000000] [--tool-budget 200] [--max-output-tokens 32000] (API systems)
  node v1/scripts/run.mjs preflight --batch <dir> [--probe-model <id>] [--probe-effort <level>] [--no-wait]
  node v1/scripts/run.mjs run       --batch <dir> [--concurrency 1] [--no-wait] [--resume-now] [--max-reruns ${DEFAULT_MAX_RERUNS}] [--retry-stall-minutes ${DEFAULT_RETRY_STALL_SECONDS / 60}]
  node v1/scripts/run.mjs status    --batch <dir>[,<dir>...] [--json]
  node v1/scripts/run.mjs summary   --batch <dir> [--json]
  node v1/scripts/run.mjs antigravity-settings [--write]   print (or merge into the agy settings file) what an antigravity batch needs
Exit codes: 0 done, 1 error, 3 stopped for a human, 75 would have waited (--no-wait), 130 interrupted.`;

const EXIT = { done: 0, error: 1, stopped: 3, wait: 75, interrupted: 130 };

const OPTIONS = {
  id: { type: 'string' }, system: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, tasks: { type: 'string' },
  attempts: { type: 'string' }, data: { type: 'string' }, binary: { type: 'string' }, batch: { type: 'string' },
  'token-budget': { type: 'string' }, 'tool-budget': { type: 'string' }, 'max-output-tokens': { type: 'string' }, 'snapshot-seconds': { type: 'string' },
  concurrency: { type: 'string' }, 'probe-model': { type: 'string' }, 'probe-effort': { type: 'string' }, json: { type: 'boolean' },
  'no-wait': { type: 'boolean' }, 'resume-now': { type: 'boolean' }, write: { type: 'boolean' }, 'max-reruns': { type: 'string' }, 'retry-stall-minutes': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const print = value => console.log(JSON.stringify(value));
const integer = (text, name, fallback) => {
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isInteger(value)) throw new Error('--' + name + ' must be an integer');
  return value;
};
const positive = (text, name, fallback) => {
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!(value > 0)) throw new Error('--' + name + ' must be a positive number');
  return value;
};

const round = value => value === null || value === undefined ? null : Math.round(value * 10) / 10;

// The batch at a glance: counts, what is owed, what the runner is doing, and the mean per task.
function briefSummary(summary) {
  return {
    event: 'summary', batch: summary.batch, complete: summary.complete, counts: summary.counts, samples: summary.samples,
    pending: summary.pending, started_unfinished: summary.started_unfinished, infra: summary.infra, state: describeState(summary.runner),
    mean_score: round(summary.mean_score), mean_score_completed: round(summary.mean_score_completed),
    tasks: Object.fromEntries(summary.tasks.map(task => [task.id, { samples: task.samples, pending: task.pending, infra_error: task.infra_error,
      score_error: task.score_error, infra_reruns: task.infra_reruns, mean_score: round(task.mean_score), mean_score_completed: round(task.mean_score_completed) }])),
  };
}

// For a person at a terminal: what the batch is doing and why.
function statusText({ summary, state, last }) {
  const counts = Object.entries(summary.counts).filter(([status, n]) => n && status !== 'pending').map(([status, n]) => status + ' ' + n).join(', ') || 'none';
  const owed = [summary.pending + ' pending' + (summary.started_unfinished ? ' (' + summary.started_unfinished + ' started)' : ''),
    summary.infra.errors + ' infra_error' + (summary.infra.capped.length ? ' (' + summary.infra.capped.length + ' at the re-run cap: ' + summary.infra.capped.join(', ') + ')' : '')];
  return [
    'batch   ' + summary.batch + '  ' + summary.system + ' ' + summary.model + (summary.effort ? '/' + summary.effort : '') + '  ' + summary.attempts_total + ' attempts' +
      (summary.sets?.length ? '  set ' + summary.sets.map(set => set ?? '(none)').join(',') : ''),
    'state   ' + state,
    'done    ' + (summary.attempts_total - summary.pending) + '/' + summary.attempts_total + ': ' + counts + '; samples ' + summary.samples,
    'owed    ' + owed.join(', ') + (summary.infra.reruns ? '; ' + summary.infra.reruns + ' earlier tries archived' : ''),
    'infra   ' + (Object.entries(summary.infra.by_reason).map(([reason, n]) => reason + ' ' + n).join(', ') || 'none'),
    'mean    ' + (round(summary.mean_score) ?? '-') + ' over samples, ' + (round(summary.mean_score_completed) ?? '-') + ' over completed',
    ...last.map(line => 'last    ' + line),
  ].join('\n');
}

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [command] = positionals;
  if (values.help || !command) { console.log(USAGE); return EXIT.done; }
  const need = key => { if (!values[key]) throw new Error('--' + key + ' is required for ' + command); return values[key]; };
  if (command === 'prepare') {
    const { batchDir, manifest } = await prepare({
      id: need('id'), system: need('system'), model: need('model'), effort: values.effort, tasks: need('tasks').split(',').map(s => s.trim()).filter(Boolean),
      attempts: integer(values.attempts, 'attempts', 1), dataRoot: resolve(values.data ?? DEFAULT_DATA_ROOT), binary: values.binary, log: print,
      tokenBudget: integer(values['token-budget'], 'token-budget', undefined), toolBudget: integer(values['tool-budget'], 'tool-budget', undefined),
      maxOutputTokens: integer(values['max-output-tokens'], 'max-output-tokens', undefined),
      snapshotSeconds: integer(values['snapshot-seconds'], 'snapshot-seconds', DEFAULT_SNAPSHOT_SECONDS),
    });
    print({ event: 'ready', batch: batchDir, system: manifest.system, model: manifest.model, effort: manifest.effort, snapshot_seconds: manifest.snapshots?.interval_seconds ?? 0,
      ...(manifest.harness.key_variable ? { key_variable: manifest.harness.key_variable, key_present: manifest.harness.key_present, base_url: manifest.harness.base_url, budget: manifest.harness.budget } : {}),
      next: 'node v1/scripts/run.mjs preflight --batch ' + batchDir });
    return EXIT.done;
  }
  if (command === 'preflight') {
    let report;
    try {
      report = await preflight({ batchDir: resolve(need('batch')), probeModel: values['probe-model'], probeEffort: values['probe-effort'],
        wait: !values['no-wait'], handleSignals: true, log: print });
    } catch (error) {
      if (error.code !== 'E3D_INTERRUPTED') throw error;
      console.error(error.message);
      return EXIT.interrupted;
    }
    for (const check of report.checks) if (check.status !== 'pass' && check.status !== 'not_applicable') print({ check: check.id, status: check.status, reason: check.reason });
    print({ event: 'preflight', passed: report.passed, failed: report.failed, not_evaluated: report.not_evaluated, infra: report.infra, report: resolve(need('batch'), 'preflight.json') });
    if (report.passed) return EXIT.done;
    if (report.infra) {
      // Not a boundary verdict: the probe session could not be run.
      console.error('Preflight could not finish: ' + report.infra.reason + (report.infra.retry_after ? ' until ' + report.infra.retry_after : '') + ': ' + report.infra.message);
      return report.infra.action === 'stop' ? EXIT.stopped : EXIT.wait;
    }
    return EXIT.error;
  }
  if (command === 'run') {
    try {
      const summary = await execute({ batchDir: resolve(need('batch')), concurrency: integer(values.concurrency, 'concurrency', 1), log: print, handleSignals: true,
        wait: !values['no-wait'], resumeNow: Boolean(values['resume-now']), maxReruns: integer(values['max-reruns'], 'max-reruns', DEFAULT_MAX_RERUNS),
        retryStallSeconds: positive(values['retry-stall-minutes'], 'retry-stall-minutes', DEFAULT_RETRY_STALL_SECONDS / 60) * 60 });
      print(briefSummary(summary));
      return EXIT.done;
    } catch (error) {
      const code = { E3D_INTERRUPTED: EXIT.interrupted, E3D_STOPPED: EXIT.stopped, E3D_WAIT: EXIT.wait }[error.code];
      if (!code) throw error;
      if (error.summary) print(briefSummary(error.summary));
      console.error(error.message);
      return code;
    }
  }
  if (command === 'status') {
    // Several batches at once (comma-separated), e.g. every batch on one login.
    const blocks = [];
    for (const dir of need('batch').split(',').map(text => text.trim()).filter(Boolean)) {
      const status = await batchStatus(resolve(dir));
      if (values.json) print({ event: 'status', state: status.state, last: status.last, ...briefSummary(status.summary), runner: status.summary.runner });
      else blocks.push(statusText(status));
    }
    if (!values.json) console.log(blocks.join('\n\n'));
    return EXIT.done;
  }
  if (command === 'summary') {
    const summary = await summarize(resolve(need('batch')));
    print(values.json ? summary : briefSummary(summary));
    return EXIT.done;
  }
  if (command === 'antigravity-settings') {
    // The operator's own file: printed by default, changed only on --write,
    // with the previous version kept beside it.
    const node = await nodeRuntime(), { path, settings, error } = await readAgySettings();
    if (error) throw new Error(path + ' is ' + error);
    const merged = agyMergedSettings(settings, { node });
    if (!values.write) { console.log(JSON.stringify(merged, null, 2)); console.error('(not written; --write merges this into ' + path + ')'); return EXIT.done; }
    await mkdir(dirname(path), { recursive: true });
    if (settings) await copyFile(path, path + '.before-e3d-' + new Date().toISOString().replace(/[:.]/g, '-'));
    await writeFile(path, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
    const problems = await agyConfigProblems({ node });
    print({ event: 'antigravity-settings', written: path, remaining_problems: problems });
    return problems.length ? EXIT.error : EXIT.done;
  }
  throw new Error('Unknown command ' + command + '\n' + USAGE);
}

try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = EXIT.error; }
