import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, isAbsolute, relative, sep, dirname } from 'node:path';
import { objectHash } from '../../../lib/io.mjs';
import { layout, VARIANTS, REPORT_SCHEMA } from '../contract.mjs';
import { finite } from './stats.mjs';
import { snapshotAt } from './curves.mjs';

// Reads run batches into one flat list of normalised attempts.
//
//   <data>/runs/<batch>/manifest.json                frozen batch provenance (runner)
//   <data>/runs/<batch>/preflight.json               isolation verdict (runner)
//   <data>/runs/<batch>/summary.json                 batch metadata (optional here)
//   <data>/runs/<batch>/<task-id>/a<n>/result.json   one generation attempt
//   <data>/runs/<batch>/<task-id>/a<n>/score/report.json   its e3d-report-v1
//   <data>/truth/<task-id>/truth.json                object, variant, scale evidence, set
//
// Nothing here throws for one bad attempt: unreadable or inconsistent files are
// recorded in `problems` and the attempt is kept (as a failure) or skipped
// (when it cannot be placed at all), so the leaderboard shows what happened.

// Statuses that mean the harness, the machine or the scorer failed, not the
// contestant. Such attempts are listed but are not samples: they are left out
// of every mean. Anything else without a valid report scores 0.
// `score_error` is here because the scorer's contract is to always return a
// report; when it does not, the fault is the scorer's (rescore it), and a 0
// would charge the contestant for it.
export const DEFAULT_EXCLUDED_STATUSES = ['infra_error', 'harness_error', 'preflight_failed', 'cancelled', 'skipped', 'score_error'];

// Tasks whose truth.json has no `set` belong to this set; tasks whose truth.json
// cannot be read at all to UNKNOWN_SET, so they are never pooled with either.
export const UNNAMED_SET = 'unnamed';
export const UNKNOWN_SET = 'unknown';

// score/submission.glb first: the runner writes it outside the contestant's
// workspace, and it is the exact file that was scored (and that rescore reads).
const MODEL_CANDIDATES = ['score/submission.glb', 'output/model.glb', 'workspace/output/model.glb', 'model.glb', 'submission/model.glb', 'score/candidate.glb'];
// The runner keeps a re-run attempt's earlier infra_error try as a<n>.infra-<k>/.
const ARCHIVED_TRY = /^a\d+\.infra-\d+$/;
export const UNKNOWN_ARCHETYPE = 'unknown';
const HASH = /^[a-f0-9]{64}$/;

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

const text = value => typeof value === 'string' && value ? value : null;
const hash = value => typeof value === 'string' && HASH.test(value) ? value : null;
const distinct = values => [...new Set(values.filter(value => value !== null && value !== undefined))].sort();

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

// Which scorer produced a report or was frozen into a manifest. No field for
// it is fixed by the contract yet, so the spellings a scorer or runner is
// likely to use are all accepted; absent means "not recorded", never a match.
export function scorerIdentity(record) {
  if (!record || typeof record !== 'object') return null;
  for (const key of ['scorer_source', 'scorer', 'score_source']) {
    const value = record[key];
    if (hash(value)) return value;
    if (value && typeof value === 'object' && hash(value.sha256)) return value.sha256;
  }
  return hash(record.scorer_sha256);
}

// The scorer's own version label next to its hash (`scorer: { version, sha256 }`).
export function scorerVersion(record) {
  if (!record || typeof record !== 'object') return null;
  for (const key of ['scorer', 'scorer_source', 'score_source']) {
    const value = record[key];
    if (value && typeof value === 'object' && text(value.version)) return value.version;
  }
  return text(record.scorer_version);
}

// What the data root says about named sets: the set file written by `new-set`
// or kept in v1/sets (name, private flag, creation date, note) and the record
// `build-set` leaves (<name>.built.json: which objects and tasks were built).
// Only facts are read; nothing here decides what a set means.
async function readSetFiles(root, problems) {
  const dir = join(root, 'sets'), sets = new Map();
  let names = [];
  try { names = (await readdir(dir)).filter(name => name.endsWith('.json')).sort(); } catch { return sets; }
  for (const name of names) {
    const data = await readJSONIfPresent(join(dir, name), problems);
    if (!data || typeof data !== 'object') continue;
    const built = name.endsWith('.built.json');
    const id = text(data.name) ?? name.replace(/(\.built)?\.json$/, '');
    if (!sets.has(id)) sets.set(id, { id, file: null, private: null, created_at: null, note: null, objects: null, built_at: null, built_tasks: [] });
    const entry = sets.get(id);
    if (built) {
      entry.built_at = text(data.built_at);
      entry.built_tasks = (Array.isArray(data.built) ? data.built : []).flatMap(item => Array.isArray(item?.tasks) ? item.tasks.filter(task => typeof task === 'string') : []);
    } else {
      entry.file = 'sets/' + name;
      entry.private = typeof data.private === 'boolean' ? data.private : null;
      entry.created_at = text(data.created_at);
      entry.note = text(data.note);
      entry.objects = Array.isArray(data.objects) ? data.objects.length : null;
    }
  }
  return sets;
}

// What a batch's manifest froze, reduced to the facts a reader needs to judge
// whether two batches may be compared. Unknown or missing fields stay null.
export function manifestProvenance(manifest) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const harness = m.harness && typeof m.harness === 'object' ? m.harness : {};
  const tasks = Array.isArray(m.tasks) ? m.tasks : [];
  return {
    schema: text(m.schema),
    runner: text(m.runner),
    protocol: text(m.protocol),
    created_at: text(m.created_at),
    system: text(m.system) ?? text(harness.system),
    model: text(m.model) ?? text(harness.model),
    effort: text(m.effort) ?? text(harness.effort),
    attempts_per_task: finite(m.attempts) ? m.attempts : null,
    cli_version: text(harness.version),
    cli_sha256: hash(harness.binary_sha256),
    login: text(harness.login),
    node_version: text(m.node?.version),
    runtime: text(m.runtime?.three_version) ? 'three ' + m.runtime.three_version : null,
    runtime_sha256: hash(m.runtime?.sha256),
    tools_sha256: hash(m.tools?.sha256),
    runner_sha256: hash(m.runner_source?.sha256),
    // The runner's hash of the scorer's source at prepare time. It is NOT the
    // same scheme as the stamp the scorer writes into each report
    // (report.scorer.sha256), so the two are shown side by side and never
    // compared with each other.
    scorer_sha256: scorerIdentity(m),
    scorer_version: scorerVersion(m),
    // If the runner also freezes the scorer's own stamp (scorer: { version,
    // sha256 } from v1/lib/score/version.mjs), every report can be checked
    // against it: a report computed by another scorer (a rescore) shows up.
    scorer_stamp_sha256: hash(m.scorer?.sha256),
    generator_sha256: hash(m.generator_source?.sha256),
    prompt_version: text(m.prompt_version),
    prompt_sha256: distinct(tasks.map(task => hash(task?.prompt_sha256))),
    repository_commit: text(m.repository?.commit),
    repository_dirty: typeof m.repository?.dirty === 'boolean' ? m.repository.dirty : null,
    tasks: tasks.length,
  };
}

async function loadReport(result, attemptDir, batchDir, problems) {
  if (result.report && typeof result.report === 'object') return { report: result.report, path: null };
  const candidates = [];
  // The runner records the report path relative to the batch directory;
  // other writers relative to the attempt. Absolute paths are taken as given.
  if (typeof result.report === 'string' && result.report) {
    if (isAbsolute(result.report)) candidates.push(result.report);
    else candidates.push(join(attemptDir, result.report), join(batchDir, result.report));
  }
  candidates.push(join(attemptDir, 'score', 'report.json'));
  for (const path of candidates) {
    const report = await readJSONIfPresent(path, problems);
    if (report) return { report, path };
  }
  return { report: null, path: null };
}

// `cli rescore` keeps the report it replaces as report.previous.json next to
// the new one, so its presence says the score was recomputed after the run.
async function wasRescored(reportPath) {
  if (!reportPath) return false;
  try { await lstat(join(dirname(reportPath), 'report.previous.json')); return true; } catch { return false; }
}

// The candidate GLB to draw. The contestant wrote into the workspace, so a
// planted symlink or hard link could make the report draw a file the
// contestant could not read (the hidden truth model). Only regular, singly
// linked files that resolve inside the attempt directory are used. When
// result.json records the scored artifact's hash, it is returned with the path
// and checked by the writer just before the file is drawn: hashing every GLB
// here would cost a full read of each of ~580 submissions, most never drawn.
async function findModel(result, attemptDir, problems) {
  const named = [result.model_path, result.glb, result.output_model, result.output?.model, result.artifact?.path]
    .filter(value => typeof value === 'string' && value && !isAbsolute(value));
  const expected = [result.artifact?.sha256, result.artifact_sha256, result.output_sha256].find(value => typeof value === 'string' && HASH.test(value)) ?? null;
  let base;
  try { base = await realpath(attemptDir); } catch { return { path: null, sha256: null }; }
  for (const path of [...named, ...MODEL_CANDIDATES]) {
    const full = join(attemptDir, path);
    let info, real;
    try { info = await lstat(full); real = await realpath(full); } catch { continue; }
    const inside = relative(base, real);
    if (!info.isFile() || info.nlink !== 1 || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) {
      problems.push(full + ' is a link or resolves outside its attempt directory; not drawn');
      return { path: null, sha256: null };
    }
    return { path: full, sha256: expected };
  }
  return { path: null, sha256: null };
}

// The score-over-time snapshots the runner recorded (runner/snapshots.mjs),
// reduced to tick, when the copy counts from (`at`: its tick, or the end of
// its read when that came more than ON_TIME_SECONDS after the tick, then
// marked `late`; curves.mjs, snapshotAt), score and status, in tick order
// (the order they were read in); null when the batch took none. With
// integrity problems every point is 0.
function snapshotSeries(result, { integrity = false } = {}) {
  if (!Array.isArray(result.snapshots) || !finite(result.snapshot_interval_seconds) || result.snapshot_interval_seconds <= 0) return null;
  const scoreOf = item => integrity ? 0 : finite(item.score) ? item.score : null;
  const point = item => {
    const at = snapshotAt(item.t, [item.read_seconds, item.at_seconds].find(finite));
    return { t: item.t, at, score: scoreOf(item), status: text(item.status), ...(at !== item.t ? { late: true } : {}) };
  };
  return { interval_seconds: result.snapshot_interval_seconds,
    points: result.snapshots.filter(item => finite(item?.t)).map(point).sort((a, b) => a.t - b.t) };
}

function setOf(truth, taskId, problems) {
  if (!truth) return UNKNOWN_SET;
  if (truth.set === undefined || truth.set === null) return UNNAMED_SET;
  if (typeof truth.set === 'string' && truth.set) return truth.set;
  problems.push('truth.json of ' + taskId + ' has a set that is not a string (' + JSON.stringify(truth.set) + '); its attempts are grouped under "' + UNKNOWN_SET + '"');
  return UNKNOWN_SET;
}

// `alsoTasks`: task ids to place in their sets beside the batches' own (a
// roster's missing tasks). -> { attempts, batches, problems, truths, objects,
// setFiles, taskInfo: Map(task id -> { set, object, variant }) } where
// taskInfo covers every task an attempt ran, every task a batch's manifest
// planned (run or not), and `alsoTasks`.
export async function collectRuns({ dataRoot, batches, excludeStatuses = DEFAULT_EXCLUDED_STATUSES, alsoTasks = [] } = {}) {
  if (typeof dataRoot !== 'string' || !dataRoot) throw new Error('collectRuns needs dataRoot');
  const paths = layout(resolve(dataRoot)), problems = [], attempts = [], batchInfo = [];
  const requested = batches?.length ? [...batches] : await directories(paths.runs);
  // A batch named twice would count every attempt twice.
  const batchIds = [...new Set(requested)];
  if (batchIds.length < requested.length) problems.push('batches listed more than once were read once: ' + [...new Set(requested.filter((id, i) => requested.indexOf(id) !== i))].join(', '));
  const available = await directories(paths.runs);
  const truthCache = new Map(), objectCache = new Map();
  const truthFor = async taskId => {
    if (!truthCache.has(taskId)) truthCache.set(taskId, await readJSONIfPresent(join(paths.truth(taskId), 'truth.json'), problems));
    return truthCache.get(taskId);
  };
  // Archetype and public title of an object, from its ground-truth model.json.
  const objectFor = async objectId => {
    if (!objectCache.has(objectId)) {
      const model = await readJSONIfPresent(join(paths.object(objectId), 'model.json'), problems);
      if (!model) problems.push('no model.json for object ' + objectId + '; its archetype is "' + UNKNOWN_ARCHETYPE + '"');
      objectCache.set(objectId, { archetype: text(model?.archetype) ?? UNKNOWN_ARCHETYPE, title: text(model?.title) });
    }
    return objectCache.get(objectId);
  };
  const planned = new Map();
  for (const batch of batchIds) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(batch)) { problems.push('invalid batch id ' + JSON.stringify(batch)); continue; }
    const batchDir = join(paths.runs, batch);
    if (!available.includes(batch)) { problems.push('batch ' + batch + ' not found under ' + paths.runs); continue; }
    const summary = await readJSONIfPresent(join(batchDir, 'summary.json'), problems);
    const manifest = await readJSONIfPresent(join(batchDir, 'manifest.json'), problems);
    const preflight = await readJSONIfPresent(join(batchDir, 'preflight.json'), problems);
    // Every task the batch was prepared with, run or not: a task nobody has run
    // yet is still one the configuration owes.
    for (const task of Array.isArray(manifest?.tasks) ? manifest.tasks : []) if (typeof task?.id === 'string' && task.id && !planned.has(task.id)) planned.set(task.id, batch);
    const mine = [];
    let unfinished = 0, archivedTries = 0;
    for (const taskDirName of await directories(batchDir)) {
      for (const attemptName of await directories(join(batchDir, taskDirName))) {
        // An earlier try that ended in infra_error and was run again: kept by
        // the runner as evidence, never a sample, counted for the provenance.
        if (ARCHIVED_TRY.test(attemptName)) { archivedTries++; continue; }
        if (!/^a\d+$/.test(attemptName)) continue;
        const attemptDir = join(batchDir, taskDirName, attemptName);
        const result = await readJSONIfPresent(join(attemptDir, 'result.json'), problems);
        // No result.json: still running, never started, or the runner died
        // before writing it. Not a sample; counted so the page can say so.
        if (!result) { unfinished++; continue; }
        const taskId = typeof result.task_id === 'string' && result.task_id ? result.task_id : taskDirName;
        if (taskId !== taskDirName) problems.push(attemptDir + ': result.task_id ' + taskId + ' differs from its directory');
        const attempt = finite(result.attempt) ? result.attempt : Number(attemptName.slice(1));
        const { report, path: reportPath } = await loadReport(result, attemptDir, batchDir, problems);
        if (report && report.schema !== REPORT_SCHEMA) problems.push(attemptDir + ': report schema is ' + report.schema);
        const truth = await truthFor(taskId);
        const object = truth?.object ?? report?.object ?? null, variant = truth?.variant ?? report?.variant ?? null;
        if (!truth) problems.push('no truth.json for task ' + taskId + (object ? '; object/variant taken from the score report, set unknown' : ''));
        if (!object || !variant || !VARIANTS[variant]) {
          problems.push(attemptDir + ': cannot tell which object/variant this attempt belongs to; skipped');
          continue;
        }
        const status = typeof result.status === 'string' ? result.status : 'unknown';
        // A broken boundary voids the attempt whatever its file scored (the
        // runner scores it for diagnosis and records 0), at every tick too.
        const integrity = Array.isArray(result.integrity_problems) && result.integrity_problems.length > 0;
        const valid = !integrity && report?.valid === true && finite(report.score);
        if (valid && finite(result.score) && Math.abs(result.score - report.score) > 1e-6) {
          problems.push(attemptDir + ': result.score ' + result.score + ' differs from report.score ' + report.score + '; the report is used');
        }
        const model = String(result.model ?? 'unknown'), modelReported = text(result.model_reported);
        if (modelReported && modelReported !== model) {
          problems.push(attemptDir + ': requested model ' + model + ' but the harness reported ' + modelReported + '; ranked under the requested id');
        }
        const excluded = excludeStatuses.includes(status);
        const entry = {
          batch, task_id: taskId, attempt, slot: attemptName, dir: attemptDir,
          system: String(result.system ?? 'unknown'), model, model_reported: modelReported,
          effort: result.effort === undefined || result.effort === null ? null : String(result.effort),
          set: setOf(truth, taskId, problems),
          status, excluded, valid,
          // Why the harness failed, when the runner says (field name not fixed by the contract yet).
          status_reason: text(result.infra?.reason) ?? text(result.infra_error?.reason) ?? text(result.infra_reason) ?? null,
          // Failures (no output, invalid GLB, timeout without a scored model ...) count as 0.
          score: valid ? report.score : 0,
          failure: valid ? null : integrity ? 'integrity problems: ' + result.integrity_problems.map(String).join('; ')
            : (report?.error ?? (report ? 'invalid submission' : 'no score report (status ' + status + ')')),
          wall_seconds: finite(result.wall_seconds) ? result.wall_seconds : null,
          wall_limit_seconds: finite(result.wall_limit_seconds) ? result.wall_limit_seconds : null,
          snapshots: snapshotSeries(result, { integrity }),
          started_at: text(result.started_at), finished_at: text(result.finished_at),
          usage: normaliseUsage(result.usage),
          cost_usd: finite(result.cost_usd) ? result.cost_usd : null,
          object, variant, archetype: (await objectFor(object)).archetype,
          scale_evidence: truth?.scale_evidence ?? VARIANTS[variant].scale,
          report, report_path: reportPath, rescored: await wasRescored(reportPath),
          artifact_sha256: hash(result.artifact?.sha256) ?? hash(result.artifact_sha256),
          ...await findModel(result, attemptDir, problems).then(found => ({ model_path: found.path, model_sha256: found.sha256 })),
        };
        attempts.push(entry);
        mine.push(entry);
      }
    }
    batchInfo.push(batchProvenance({ id: batch, summary, manifest, preflight, attempts: mine, unfinished, archivedTries, problems }));
  }
  // Two models rarely write byte-identical files, so the same artifact twice for
  // one task usually means a batch was copied or listed under two names and
  // would be counted twice. Reported, not removed: deciding is a human's job.
  const seen = new Map();
  for (const attempt of attempts) {
    if (!attempt.artifact_sha256) continue;
    const key = attempt.task_id + '|' + attempt.artifact_sha256;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(attempt.batch + '/' + attempt.task_id + '/' + attempt.slot);
  }
  for (const dirs of seen.values()) if (dirs.length > 1) problems.push('byte-identical submissions in ' + dirs.join(', ') + ': a copied batch would be counted twice');
  const setFiles = await readSetFiles(paths.root, problems);
  const taskInfo = new Map(attempts.map(attempt => [attempt.task_id, { set: attempt.set, object: attempt.object, variant: attempt.variant }]));
  for (const taskId of [...planned.keys(), ...alsoTasks.filter(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))]) {
    if (taskInfo.has(taskId)) continue;
    const truth = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId) ? await truthFor(taskId) : null;
    if (truth?.object && typeof truth.variant === 'string' && Object.hasOwn(VARIANTS, truth.variant)) {
      taskInfo.set(taskId, { set: setOf(truth, taskId, problems), object: truth.object, variant: truth.variant });
    } else if (planned.has(taskId)) {
      // A task owed but impossible to place would silently shrink what every
      // configuration owes; say so. (A roster-listed one is reported by the leaderboard.)
      problems.push('batch ' + planned.get(taskId) + ' planned task ' + taskId + ', but it has no truth.json naming its object and variant: ' +
        'the report cannot place it in a set, so no configuration is checked against it');
    }
  }
  return { attempts, batches: batchInfo, problems: [...new Set(problems)], truths: truthCache, objects: objectCache, setFiles, taskInfo };
}

// One batch's provenance: what its manifest froze plus what its attempts show
// (date range, reported model, scorer behind the reports, sets, statuses).
function batchProvenance({ id, summary, manifest, preflight, attempts, unfinished, archivedTries = 0, problems }) {
  const frozen = manifestProvenance(manifest);
  if (!manifest) problems.push('batch ' + id + ' has no manifest.json; its provenance is unknown');
  const starts = attempts.map(attempt => attempt.started_at).filter(Boolean).sort();
  const ends = attempts.map(attempt => attempt.finished_at).filter(Boolean).sort();
  const statuses = {};
  for (const attempt of attempts) statuses[attempt.status] = (statuses[attempt.status] ?? 0) + 1;
  const configurations = distinct(attempts.map(attempt => [attempt.system, attempt.model, attempt.effort ?? '-'].join(' / ')));
  if (manifest && attempts.some(attempt => (frozen.system && attempt.system !== frozen.system) || (frozen.model && attempt.model !== frozen.model))) {
    problems.push('batch ' + id + ': some result.json files name a different system or model than manifest.json');
  }
  const offManifest = frozen.scorer_stamp_sha256
    ? attempts.filter(attempt => scorerIdentity(attempt.report) && scorerIdentity(attempt.report) !== frozen.scorer_stamp_sha256).length : null;
  if (offManifest) problems.push('batch ' + id + ': ' + offManifest + ' report' + (offManifest === 1 ? ' was' : 's were') + ' computed by a scorer other than the one frozen in manifest.json (' +
    frozen.scorer_stamp_sha256 + ')');
  return {
    id,
    manifest: manifest ? frozen : null,
    // The runner binds a preflight verdict to objectHash(manifest); a verdict
    // for another manifest says nothing about this batch's boundary.
    preflight: preflight && typeof preflight === 'object' ? { passed: preflight.passed === true, created_at: text(preflight.created_at),
      bound_to_manifest: manifest && hash(preflight.manifest_sha256) ? preflight.manifest_sha256 === objectHash(manifest) : null } : null,
    sets: distinct(attempts.map(attempt => attempt.set)),
    configurations,
    models_reported: distinct(attempts.map(attempt => attempt.model_reported)),
    scorer_sha256: distinct(attempts.map(attempt => scorerIdentity(attempt.report))),
    scorer_versions: distinct(attempts.map(attempt => scorerVersion(attempt.report))),
    // Reports with no scorer stamp, so a partly stamped batch is visible.
    reports_unstamped: attempts.filter(attempt => attempt.report && !scorerIdentity(attempt.report)).length,
    // Stamped reports whose scorer differs from the stamp frozen in the manifest (null: the manifest freezes none).
    reports_off_manifest: offManifest,
    rescored: attempts.filter(attempt => attempt.rescored).length,
    report_protocols: distinct(attempts.map(attempt => text(attempt.report?.protocol))),
    attempts: attempts.length,
    counted: attempts.filter(attempt => !attempt.excluded).length,
    excluded: attempts.filter(attempt => attempt.excluded).length,
    unfinished,
    infra_retries: archivedTries,
    status_counts: statuses,
    first_started_at: starts[0] ?? null,
    last_finished_at: ends.at(-1) ?? null,
    // The runner's summary repeats every attempt; the leaderboard already has
    // them, so only its scalar facts and counts are kept.
    summary: summary && typeof summary === 'object'
      ? Object.fromEntries(Object.entries(summary).filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value) ||
        (value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => item === null || ['string', 'number', 'boolean'].includes(typeof item)))))
      : null,
  };
}
