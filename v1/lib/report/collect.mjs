import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, isAbsolute, relative, sep } from 'node:path';
import { sha256 } from '../../../lib/io.mjs';
import { layout, VARIANTS, REPORT_SCHEMA } from '../contract.mjs';
import { finite } from './stats.mjs';

// Reads run batches into one flat list of normalised attempts.
//
//   <data>/runs/<batch>/summary.json                 batch metadata (optional here)
//   <data>/runs/<batch>/<task-id>/a<n>/result.json   one generation attempt
//   <data>/runs/<batch>/<task-id>/a<n>/score/report.json   its e3d-report-v1
//   <data>/truth/<task-id>/truth.json                object, variant, scale evidence
//
// Nothing here throws for one bad attempt: unreadable or inconsistent files are
// recorded in `problems` and the attempt is kept (as a failure) or skipped
// (when it cannot be placed at all), so the leaderboard shows what happened.

// Statuses that mean the harness, not the contestant, failed. Such attempts are
// listed but left out of every mean; anything else without a valid report
// scores 0.
export const DEFAULT_EXCLUDED_STATUSES = ['infra_error', 'harness_error', 'preflight_failed', 'cancelled', 'skipped'];

const MODEL_CANDIDATES = ['output/model.glb', 'workspace/output/model.glb', 'model.glb', 'submission/model.glb', 'score/candidate.glb'];

async function readJSONIfPresent(path, problems) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    problems.push('cannot read ' + path + ': ' + error.message);
    return null;
  }
  try { return JSON.parse(text); } catch (error) {
    problems.push('invalid JSON in ' + path + ': ' + error.message);
    return null;
  }
}

async function directories(path) {
  try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(); } catch { return []; }
}

// The runner records { input_tokens (all prompt tokens, cached reads included),
// cached_input_tokens, output_tokens } for both harnesses; raw Anthropic field
// names are accepted too. `total` = input + output unless total_tokens is given.
export function normaliseUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const pick = (...keys) => { for (const key of keys) if (finite(usage[key])) return usage[key]; return null; };
  const input = pick('input_tokens', 'prompt_tokens'), output = pick('output_tokens', 'completion_tokens');
  const total = pick('total_tokens') ?? (input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null);
  return {
    input, output, total,
    cached_input: pick('cached_input_tokens', 'cache_read_input_tokens'),
    cache_write: pick('cache_creation_input_tokens'),
    reasoning: pick('reasoning_output_tokens', 'reasoning_tokens'),
  };
}

async function loadReport(result, attemptDir, problems) {
  if (result.report && typeof result.report === 'object') return { report: result.report, path: null };
  const candidates = [];
  if (typeof result.report === 'string' && result.report) candidates.push(isAbsolute(result.report) ? result.report : join(attemptDir, result.report));
  candidates.push(join(attemptDir, 'score', 'report.json'));
  for (const path of candidates) {
    const report = await readJSONIfPresent(path, problems);
    if (report) return { report, path };
  }
  return { report: null, path: null };
}

// The candidate GLB to draw. The contestant wrote into the workspace, so a
// planted symlink or hard link could make the report draw a file the
// contestant could not read (the hidden truth model). Only regular, singly
// linked files that resolve inside the attempt directory are used, and when
// result.json records the scored artifact's hash the file must match it.
async function findModel(result, attemptDir, problems) {
  const named = [result.model_path, result.glb, result.output_model, result.output?.model, result.artifact?.path]
    .filter(value => typeof value === 'string' && value && !isAbsolute(value));
  const expected = [result.artifact?.sha256, result.artifact_sha256, result.output_sha256].find(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
  let base;
  try { base = await realpath(attemptDir); } catch { return null; }
  for (const path of [...named, ...MODEL_CANDIDATES]) {
    const full = join(attemptDir, path);
    let info, real;
    try { info = await lstat(full); real = await realpath(full); } catch { continue; }
    const inside = relative(base, real);
    if (!info.isFile() || info.nlink !== 1 || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) {
      problems.push(full + ' is a link or resolves outside its attempt directory; not drawn');
      return null;
    }
    if (expected && sha256(await readFile(full)) !== expected) {
      problems.push(full + ' does not match the artifact hash in result.json; not drawn');
      return null;
    }
    return full;
  }
  return null;
}

export async function collectRuns({ dataRoot, batches, excludeStatuses = DEFAULT_EXCLUDED_STATUSES } = {}) {
  if (typeof dataRoot !== 'string' || !dataRoot) throw new Error('collectRuns needs dataRoot');
  const paths = layout(resolve(dataRoot)), problems = [], attempts = [], batchInfo = [];
  const batchIds = batches?.length ? [...batches] : await directories(paths.runs);
  const truthCache = new Map();
  const truthFor = async taskId => {
    if (!truthCache.has(taskId)) truthCache.set(taskId, await readJSONIfPresent(join(paths.truth(taskId), 'truth.json'), problems));
    return truthCache.get(taskId);
  };
  for (const batch of batchIds) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(batch)) { problems.push('invalid batch id ' + JSON.stringify(batch)); continue; }
    const batchDir = join(paths.runs, batch);
    if (!(await directories(paths.runs)).includes(batch)) { problems.push('batch ' + batch + ' not found under ' + paths.runs); continue; }
    const summary = await readJSONIfPresent(join(batchDir, 'summary.json'), problems);
    let count = 0;
    for (const taskDirName of await directories(batchDir)) {
      for (const attemptName of await directories(join(batchDir, taskDirName))) {
        if (!/^a\d+$/.test(attemptName)) continue;
        const attemptDir = join(batchDir, taskDirName, attemptName);
        const result = await readJSONIfPresent(join(attemptDir, 'result.json'), problems);
        if (!result) continue;
        count++;
        const taskId = typeof result.task_id === 'string' && result.task_id ? result.task_id : taskDirName;
        if (taskId !== taskDirName) problems.push(attemptDir + ': result.task_id ' + taskId + ' differs from its directory');
        const attempt = finite(result.attempt) ? result.attempt : Number(attemptName.slice(1));
        const { report, path: reportPath } = await loadReport(result, attemptDir, problems);
        if (report && report.schema !== REPORT_SCHEMA) problems.push(attemptDir + ': report schema is ' + report.schema);
        const truth = await truthFor(taskId);
        const object = truth?.object ?? report?.object ?? null, variant = truth?.variant ?? report?.variant ?? null;
        if (!truth) problems.push('no truth.json for task ' + taskId + (object ? '; object/variant taken from the score report' : ''));
        if (!object || !variant || !VARIANTS[variant]) {
          problems.push(attemptDir + ': cannot tell which object/variant this attempt belongs to; skipped');
          continue;
        }
        const status = typeof result.status === 'string' ? result.status : 'unknown';
        const valid = report?.valid === true && finite(report.score);
        if (valid && finite(result.score) && Math.abs(result.score - report.score) > 1e-6) {
          problems.push(attemptDir + ': result.score ' + result.score + ' differs from report.score ' + report.score + '; the report is used');
        }
        const excluded = excludeStatuses.includes(status);
        attempts.push({
          batch, task_id: taskId, attempt, slot: attemptName, dir: attemptDir,
          system: String(result.system ?? 'unknown'), model: String(result.model ?? 'unknown'),
          effort: result.effort === undefined || result.effort === null ? null : String(result.effort),
          status, excluded, valid,
          // Failures (no output, invalid GLB, timeout without a scored model ...) count as 0.
          score: valid ? report.score : 0,
          failure: valid ? null : (report?.error ?? (report ? 'invalid submission' : 'no score report (status ' + status + ')')),
          wall_seconds: finite(result.wall_seconds) ? result.wall_seconds : null,
          usage: normaliseUsage(result.usage),
          cost_usd: finite(result.cost_usd) ? result.cost_usd : null,
          object, variant,
          scale_evidence: truth?.scale_evidence ?? VARIANTS[variant].scale,
          report, report_path: reportPath,
          model_path: await findModel(result, attemptDir, problems),
        });
      }
    }
    batchInfo.push({ id: batch, attempts: count, summary });
  }
  return { attempts, batches: batchInfo, problems: [...new Set(problems)], truths: truthCache };
}
