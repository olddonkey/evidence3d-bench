import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VARIANTS } from '../contract.mjs';

// Which configurations a round ranks, and on which ladder. A configuration is
// a system ladder entry: client + model + effort. Effort moves a model about as
// much as the gap between models (docs/V1-ROUND3.md section 5), so one table
// that mixes effort levels is no model ladder; the report gives two:
//   default  every client at the effort it uses when none is asked for;
//   top      every client at the highest effort the round asked it for.
// The round's roster file (decided before the data, like DECISIONS.md) names
// the formal configurations and their ladders; any other configuration in the
// batches is a reference row: shown, never ranked, in no corrected family.
// Without a roster every configuration is formal and the ladders are inferred
// from the effort recorded per attempt.
//
// Completeness (docs/V1-ROUND4-PLAN.md section 2) is the roster's to record,
// not the report's to infer: when a round's window closes, each formal
// configuration's permanently missing tasks are listed (`missing_tasks`, each
// with its reason), and one missing more than MISSING_SHARE_LIMIT of a main
// set's tasks is marked `demoted` (with the reason): no rank, but it stays in
// every corrected family. `required_variants` names the variants whose tasks
// every formal configuration must complete (default: every task of the set in
// the batches read).

export const ROSTER_SCHEMA = 'e3d-roster-v1';
// Share of a main set's tasks a formal configuration may miss and stay ranked.
export const MISSING_SHARE_LIMIT = 0.05;
export const LADDERS = [
  { id: 'default', label: 'Each client’s default effort' },
  { id: 'top', label: 'Each client’s top effort' },
];
const LADDER_IDS = LADDERS.map(ladder => ladder.id);

// Effort names in increasing order across the clients the runner drives:
// codex (low ... max, ultra), claude-code and antigravity (low ... max), grok
// (none ... max). Each client's own list is a subsequence of this one.
export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
// The effort a client uses when none is passed, where it is documented
// (docs/V1-ROUND3.md: high for all three). An attempt recorded with effort
// null ran without an effort flag, so at its client's default.
export const CLIENT_DEFAULT_EFFORT = { codex: 'high', 'claude-code': 'high', grok: 'high' };

const keyOf = ({ system, model, effort }) => [system, model, effort ?? '-'].join(' / ');
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;

// -> { schema, round, decided_at, decisions, note, required_variants, configurations: [{ key, system, model, effort, ladders,
// missing_tasks: [{ task, reason }], demoted }], keys: Map }. Every problem is reported at once; a roster with any problem is refused.
export function parseRoster(data, { file = null, sha256 = null } = {}) {
  const problems = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('roster' + (file ? ' ' + file : '') + ': not a JSON object');
  if (data.schema !== ROSTER_SCHEMA) problems.push('schema must be "' + ROSTER_SCHEMA + '"');
  if (!Array.isArray(data.configurations) || !data.configurations.length) problems.push('configurations must be a non-empty list');
  let requiredVariants = null;
  if (data.required_variants !== undefined && data.required_variants !== null) {
    const list = Array.isArray(data.required_variants) ? data.required_variants : [];
    if (!list.length) problems.push('required_variants must be a non-empty list of variants, or absent');
    const known = variant => typeof variant === 'string' && Object.hasOwn(VARIANTS, variant);
    for (const variant of list) if (!known(variant)) problems.push('required_variants: unknown variant ' + JSON.stringify(variant));
    if (new Set(list).size < list.length) problems.push('required_variants lists a variant twice');
    requiredVariants = [...new Set(list.filter(known))];
  }
  const configurations = [], keys = new Map(), onLadder = new Map();
  for (const [index, item] of (Array.isArray(data.configurations) ? data.configurations : []).entries()) {
    const where = 'configurations[' + index + ']';
    if (!item || typeof item !== 'object') { problems.push(where + ' is not an object'); continue; }
    const system = text(item.system), model = text(item.model);
    if (!system) problems.push(where + ': system is required');
    if (!model) problems.push(where + ': model is required');
    if (item.effort !== null && item.effort !== undefined && !text(item.effort)) problems.push(where + ': effort must be a name or null (no effort flag)');
    const effort = text(item.effort);
    const raw = item.ladder === undefined || item.ladder === null ? [] : Array.isArray(item.ladder) ? item.ladder : [item.ladder];
    const ladders = LADDER_IDS.filter(id => raw.includes(id));
    for (const value of raw) if (!LADDER_IDS.includes(value)) problems.push(where + ': unknown ladder ' + JSON.stringify(value) + ' (expected ' + LADDER_IDS.join(' or ') + ')');
    if (!system || !model) continue;
    const key = keyOf({ system, model, effort });
    if (keys.has(key)) { problems.push(where + ': ' + key + ' is listed twice'); continue; }
    // One entry per client and model on a ladder: two efforts of one model on
    // the same ladder would be the mixed table the ladders exist to avoid.
    for (const ladder of ladders) {
      const slot = ladder + '|' + system + ' / ' + model;
      if (onLadder.has(slot)) problems.push(where + ': ' + system + ' / ' + model + ' is on the ' + ladder + ' ladder twice (' + onLadder.get(slot) + ', ' + key + ')');
      else onLadder.set(slot, key);
    }
    const missing = [];
    if (item.missing_tasks !== undefined && item.missing_tasks !== null) {
      if (!Array.isArray(item.missing_tasks)) problems.push(where + ': missing_tasks must be a list of { task, reason }');
      for (const [n, gap] of (Array.isArray(item.missing_tasks) ? item.missing_tasks : []).entries()) {
        const task = text(gap?.task), reason = text(gap?.reason);
        if (!task || !reason) { problems.push(where + '.missing_tasks[' + n + ']: needs a task id and a reason'); continue; }
        if (missing.some(other => other.task === task)) { problems.push(where + ': missing task ' + task + ' is listed twice'); continue; }
        missing.push({ task, reason });
      }
    }
    if (item.demoted !== undefined && item.demoted !== null && !text(item.demoted)) problems.push(where + ': demoted must be the reason, or absent');
    const entry = { key, system, model, effort, ladders, missing_tasks: missing, demoted: text(item.demoted) };
    configurations.push(entry);
    keys.set(key, entry);
  }
  if (problems.length) throw new Error('roster' + (file ? ' ' + file : '') + ' refused:\n  ' + problems.join('\n  '));
  return { schema: ROSTER_SCHEMA, round: text(data.round), decided_at: text(data.decided_at), decisions: text(data.decisions), note: text(data.note),
    required_variants: requiredVariants, file, sha256, configurations, keys };
}

// The file is recorded relative to the repository root, or by its name alone
// when it lies outside, whatever the working directory: no absolute or
// machine-specific path enters the leaderboard (the sha256 identifies it).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export function rosterPath(file) {
  const inRepo = relative(REPO_ROOT, resolve(file));
  return inRepo && !inRepo.startsWith('..') && !isAbsolute(inRepo) ? inRepo.split(sep).join('/') : basename(file);
}

export async function readRoster(file) {
  const bytes = await readFile(file), shown = rosterPath(file);
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); } catch (error) { throw new Error('roster ' + shown + ': ' + error.message); }
  return parseRoster(data, { file: shown, sha256: createHash('sha256').update(bytes).digest('hex') });
}

// What the leaderboard records about the roster it was given.
export const rosterProvenance = roster => roster ? { file: roster.file, sha256: roster.sha256, round: roster.round, decided_at: roster.decided_at,
  decisions: roster.decisions, required_variants: roster.required_variants,
  configurations: roster.configurations.map(({ key, system, model, effort, ladders, missing_tasks, demoted }) => ({ key, system, model, effort, ladders, missing_tasks, demoted })) } : null;

const effortRank = effort => EFFORT_ORDER.indexOf(effort);

// Ladders of the configurations of one set when no roster is given.
//   default: effort null, or the client's documented default;
//   top:     per client and model, the highest effort above that default.
// -> { ladders: Map(key -> [ladder ids]), notes: [text] }. A configuration the
// rule cannot place is on no ladder, with a note saying why.
export function inferLadders(configurations) {
  const ladders = new Map(configurations.map(item => [item.key, []])), notes = [];
  const groups = new Map();
  for (const item of configurations) {
    const group = item.system + ' / ' + item.model;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  for (const [group, items] of groups) {
    const system = items[0].system, fallback = CLIENT_DEFAULT_EFFORT[system] ?? null;
    const defaults = items.filter(item => item.effort === null || item.effort === fallback);
    if (defaults.length > 1) notes.push(group + ': ' + defaults.map(item => item.key).join(' and ') + ' both count as the client’s default; neither is placed (give a roster)');
    else if (defaults.length === 1) ladders.get(defaults[0].key).push('default');
    const above = fallback === null ? [] : items.filter(item => item.effort !== null && effortRank(item.effort) > effortRank(fallback));
    const unordered = items.filter(item => item.effort !== null && effortRank(item.effort) < 0);
    if (unordered.length) notes.push(unordered.map(item => item.key).join(', ') + ': effort not in the known order (' + EFFORT_ORDER.join(' < ') + '); on no ladder (give a roster)');
    if (fallback === null && items.some(item => item.effort !== null)) {
      notes.push(group + ': the report does not know ' + system + '’s default effort, so only a run without an effort flag is placed (give a roster)');
    }
    if (above.length) {
      const top = above.filter(item => effortRank(item.effort) >= 0).sort((a, b) => effortRank(b.effort) - effortRank(a.effort))[0];
      if (top) ladders.get(top.key).push('top');
    }
    for (const item of items) {
      if (ladders.get(item.key).length || unordered.includes(item) || (defaults.length > 1 && defaults.includes(item))) continue;
      if (fallback !== null && item.effort !== null) notes.push(item.key + ': ' + (effortRank(item.effort) < effortRank(fallback) ? 'below the client’s default' : 'between the default and the top effort run') + '; on no ladder');
    }
  }
  return { ladders, notes };
}

export const LADDER_RULE = {
  roster: 'ladders as the roster assigns them; configurations not in the roster are reference rows: listed, not ranked, in no corrected family',
  inferred: 'no roster given, so every configuration is formal and the ladders are inferred from the recorded effort: default = no effort flag or the client’s ' +
    'documented default (' + Object.entries(CLIENT_DEFAULT_EFFORT).map(([system, effort]) => system + ' ' + effort).join(', ') + '); top = per client and model, ' +
    'the highest effort above that default that the set ran (' + EFFORT_ORDER.join(' < ') + ')',
};
