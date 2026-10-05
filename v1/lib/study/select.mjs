import { readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { rng } from '../rng.mjs';
import { layout } from '../contract.mjs';
import { collectRuns } from '../report/collect.mjs';

// Pair selection for the blind paired-comparison study. A pair is two valid,
// scored submissions for the same task; the rater says which is closer to the
// reference, and the analysis asks how often the score agrees.
//
// Two files come out of a selection. pairs.json is public: the page reads it,
// and it holds nothing that tells a submission's score, batch, model, attempt
// or object, or the stratum of a pair. key.json is private: everything needed
// to join the votes with the scores afterwards.

// Strata of the headline-score gap |Δ| (points). The study wants the same number
// of pairs in each, so it can tell at what gap a human sees the difference.
export const STRATA = [
  { id: '0-3', min: 0, max: 3 },
  { id: '3-8', min: 3, max: 8 },
  { id: '8-15', min: 8, max: 15 },
  { id: '15-100', min: 15, max: 100 },
];
export const DEFAULT_PAIRS = 100;
export const DEFAULT_REPEAT_SHARE = 0.1;
export const PER_TASK = 2;
// t1 tasks are scored on the front alone, so the other views would show the
// rater surfaces the score never looked at.
export const SKIPPED_VARIANTS = ['t1'];
export const PAIRS_SCHEMA = 'e3d-study-pairs-v1';
export const KEY_SCHEMA = 'e3d-study-key-v1';
// Two scores closer than this have no higher side.
const EQUAL = 1e-9;

const finite = value => typeof value === 'number' && Number.isFinite(value);
const configOf = attempt => [attempt.system, attempt.model, attempt.effort ?? '-'].join(' / ');

// The stratum index of a gap; the last stratum is closed at 100.
export function stratumOf(gap, strata = STRATA) {
  if (!finite(gap) || gap < 0) return -1;
  const index = strata.findIndex(stratum => gap >= stratum.min && gap < stratum.max);
  if (index >= 0) return index;
  return gap <= strata.at(-1).max ? strata.length - 1 : -1;
}

// Which side of a pair is higher on a measure: 'a', 'b', or null (equal or unknown).
export function higherSide(a, b) {
  if (!finite(a) || !finite(b) || Math.abs(a - b) <= EQUAL) return null;
  return a > b ? 'a' : 'b';
}

// Every submission that can be shown: a counted attempt with a valid report,
// a finite score and a model file, on a task whose views all count.
export async function collectSubmissions({ dataRoot, batches }) {
  const root = resolve(dataRoot), paths = layout(root);
  const collected = await collectRuns({ dataRoot: root, batches });
  const titles = new Map();
  const titleOf = async (taskId, object) => {
    if (!titles.has(taskId)) {
      let title = null;
      try { title = JSON.parse(await readFile(join(paths.task(taskId), 'task.json'), 'utf8')).title ?? null; } catch { title = null; }
      titles.set(taskId, typeof title === 'string' && title ? title : collected.objects.get(object)?.title ?? 'Untitled task');
    }
    return titles.get(taskId);
  };
  const inRoot = path => relative(root, path).split(sep).join('/');
  const skipped = { variant: 0, excluded: 0, invalid: 0, no_model: 0 };
  const submissions = [];
  for (const attempt of collected.attempts) {
    if (SKIPPED_VARIANTS.includes(attempt.variant)) { skipped.variant++; continue; }
    if (attempt.excluded) { skipped.excluded++; continue; }
    const report = attempt.report;
    if (!attempt.valid || report?.valid !== true || !finite(report.score)) { skipped.invalid++; continue; }
    if (!attempt.model_path) { skipped.no_model++; continue; }
    const alignment = report.alignment ?? null;
    const diagonal = finite(report.global?.diagonal_m) ? report.global.diagonal_m : null;
    submissions.push({
      key: attempt.batch + '/' + attempt.task_id + '/' + attempt.slot,
      batch: attempt.batch, task_id: attempt.task_id, slot: attempt.slot,
      dir: inRoot(attempt.dir), model_path: inRoot(attempt.model_path), model_sha256: attempt.model_sha256 ?? null,
      system: attempt.system, model: attempt.model, effort: attempt.effort, config: configOf(attempt),
      object: attempt.object, variant: attempt.variant, archetype: attempt.archetype, set: attempt.set,
      title: await titleOf(attempt.task_id, attempt.object),
      score: report.score,
      shape_score: finite(report.shape_score) ? report.shape_score : null,
      detail_score: finite(report.detail?.score) ? report.detail.score : null,
      alignment: alignment ? { yaw_deg: alignment.yaw_deg ?? 0, scale: alignment.scale ?? 1, translation_m: alignment.translation_m ?? [0, 0, 0] } : null,
      // How far the scorer's refined shape pose moved from the searched pose that is drawn (fraction of D).
      shape_pose_moved: finite(alignment?.shape_pose?.moved_m) && diagonal ? alignment.shape_pose.moved_m / diagonal : null,
      diagonal_m: diagonal,
      bounds: report.technical?.bounds ?? null,
    });
  }
  return { submissions, skipped, problems: collected.problems };
}

// Lexicographic comparison of two equal-length number arrays.
const lexical = (p, q) => { for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i] - q[i]; return 0; };

function shuffle(list, random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random.next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

// Chooses the pairs. Pure: the same submissions, count and seed give the same
// selection whatever order the submissions come in.
//
// Equal targets per stratum. Strata take turns, the one with the fewest
// eligible candidates first, so the per-task cap is not used up by a stratum
// that has plenty. Within a stratum the next pair is the eligible one that
// least repeats the stratum's variants, then its archetypes, then is
// cross-configuration, then comes from a task with fewer pairs so far, then
// shares no submission with a chosen pair; seeded random order breaks ties.
export function selectPairs(submissions, { pairs = DEFAULT_PAIRS, seed = 'e3d-study', repeatShare = DEFAULT_REPEAT_SHARE, perTask = PER_TASK, strata = STRATA } = {}) {
  if (!Number.isInteger(pairs) || pairs < 1) throw new Error('pairs must be a positive integer');
  if (!(repeatShare >= 0 && repeatShare <= 1)) throw new Error('repeat share must be between 0 and 1');
  const random = rng(seed);
  const sorted = submissions.filter(item => !SKIPPED_VARIANTS.includes(item.variant) && finite(item.score))
    .slice().sort((p, q) => p.key.localeCompare(q.key));
  const byTask = new Map();
  for (const item of sorted) {
    if (!byTask.has(item.task_id)) byTask.set(item.task_id, []);
    byTask.get(item.task_id).push(item);
  }
  const order = random.fork('candidates');
  const candidates = [];
  for (const taskId of [...byTask.keys()].sort()) {
    const list = byTask.get(taskId);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const gap = Math.abs(list[i].score - list[j].score), stratum = stratumOf(gap, strata);
      if (stratum < 0) continue;
      candidates.push({ task_id: taskId, first: list[i], second: list[j], gap, stratum, cross: list[i].config !== list[j].config,
        variant: list[i].variant, archetype: list[i].archetype, tiebreak: order.next() });
    }
  }

  const targets = strata.map((_, index) => Math.floor(pairs / strata.length) + (index < pairs % strata.length ? 1 : 0));
  const tally = strata.map(() => ({ variants: new Map(), archetypes: new Map(), chosen: [] }));
  const perTaskCount = new Map(), usedSubmissions = new Set(), taken = new Set();
  const eligible = candidate => !taken.has(candidate) && (perTaskCount.get(candidate.task_id) ?? 0) < perTask;
  const pool = strata.map((_, index) => candidates.filter(candidate => candidate.stratum === index));
  for (;;) {
    const open = strata.map((_, index) => index).filter(index => tally[index].chosen.length < targets[index] && pool[index].some(eligible));
    if (!open.length) break;
    open.sort((p, q) => pool[p].filter(eligible).length - pool[q].filter(eligible).length || p - q);
    for (const index of open) {
      const choices = pool[index].filter(eligible);
      if (!choices.length || tally[index].chosen.length >= targets[index]) continue;
      const rank = candidate => [
        tally[index].variants.get(candidate.variant) ?? 0,
        tally[index].archetypes.get(candidate.archetype) ?? 0,
        candidate.cross ? 0 : 1,
        perTaskCount.get(candidate.task_id) ?? 0,
        usedSubmissions.has(candidate.first.key) || usedSubmissions.has(candidate.second.key) ? 1 : 0,
        candidate.tiebreak,
      ];
      let best = choices[0], bestRank = rank(best);
      for (const candidate of choices.slice(1)) {
        const r = rank(candidate);
        if (lexical(r, bestRank) < 0) { best = candidate; bestRank = r; }
      }
      taken.add(best);
      tally[index].chosen.push(best);
      tally[index].variants.set(best.variant, (tally[index].variants.get(best.variant) ?? 0) + 1);
      tally[index].archetypes.set(best.archetype, (tally[index].archetypes.get(best.archetype) ?? 0) + 1);
      perTaskCount.set(best.task_id, (perTaskCount.get(best.task_id) ?? 0) + 1);
      usedSubmissions.add(best.first.key); usedSubmissions.add(best.second.key);
    }
  }

  // Sides. Within each stratum exactly half the pairs (the odd one by a coin)
  // put the higher-scored submission on side A, chosen at random, so a rater's
  // habit of picking one side cannot pass for agreement with the score.
  const sides = random.fork('sides');
  const originals = [];
  for (const [index, entry] of tally.entries()) {
    const shuffled = shuffle(entry.chosen, sides);
    const half = Math.floor(shuffled.length / 2) + (shuffled.length % 2 && sides.chance(0.5) ? 1 : 0);
    for (const [k, candidate] of shuffled.entries()) {
      const firstHigher = candidate.first.score >= candidate.second.score;
      const higherOnA = k < half;
      const [a, b] = firstHigher === higherOnA ? [candidate.first, candidate.second] : [candidate.second, candidate.first];
      originals.push({ stratum: index, gap: candidate.gap, task_id: candidate.task_id, variant: candidate.variant, archetype: candidate.archetype,
        cross: candidate.cross, a, b, repeat_of: null });
    }
  }

  // Repeats: the same two submissions with the sides swapped, spread over the
  // strata in turn. Only key.json says which entries are repeats.
  const repeatCount = Math.round(originals.length * repeatShare);
  const queues = strata.map((_, index) => shuffle(originals.filter(item => item.stratum === index), random.fork('repeats-' + index)));
  const repeatList = [];
  for (let turn = 0; repeatList.length < repeatCount && queues.some(queue => queue.length); turn++) {
    const queue = queues[turn % queues.length];
    if (!queue.length) continue;
    const original = queue.shift();
    repeatList.push({ ...original, a: original.b, b: original.a, repeat_of: original });
  }

  // Opaque ids, then a seeded presentation order in which a repeat is never
  // close to its original.
  const ids = random.fork('ids'), seen = new Set();
  const all = [...originals, ...repeatList];
  for (const item of all) {
    let id;
    do { id = Math.floor(ids.next() * 0x100000000).toString(16).padStart(8, '0'); } while (seen.has(id));
    seen.add(id);
    item.id = id;
  }
  const spacing = Math.min(10, Math.floor(all.length / 4));
  const shuffler = random.fork('order');
  let presented = shuffle(all, shuffler);
  for (let attempt = 0; attempt < 1000; attempt++) {
    const position = new Map(presented.map((item, index) => [item, index]));
    if (repeatList.every(item => Math.abs(position.get(item) - position.get(item.repeat_of)) >= spacing)) break;
    presented = shuffle(all, shuffler);
  }

  const available = strata.map((_, index) => pool[index].length);
  return {
    seed: String(seed), requested: { pairs, repeat_share: repeatShare, per_task: perTask },
    strata: strata.map((stratum, index) => ({
      ...stratum, target: targets[index], selected: tally[index].chosen.length, candidates: available[index],
      shortfall: Math.max(0, targets[index] - tally[index].chosen.length),
      cross_configuration: tally[index].chosen.filter(item => item.cross).length,
      variants: Object.fromEntries([...tally[index].variants].sort()), archetypes: Object.fromEntries([...tally[index].archetypes].sort()),
      repeats: repeatList.filter(item => item.stratum === index).length,
    })),
    tasks_used: perTaskCount.size,
    pairs: presented.map((item, position) => ({ ...item, position, repeat_of: item.repeat_of ? item.repeat_of.id : null })),
  };
}

// ------------------------------------------------------------------ study files

// Image files are named by pair id, role (r reference, a, b) and view only.
export const ROLES = ['r', 'a', 'b'];
export const imageName = (pairId, role, view) => pairId + '-' + role + '-' + view + '.png';
const imagesOf = (pairId, views) => Object.fromEntries(views.map(view => [view.id, Object.fromEntries(ROLES.map(role => [role, imageName(pairId, role, view.id)]))]));

// pairs.json: per pair an opaque id, the public task title and variant, and the
// image file names. Nothing else: no score, batch, model, attempt, object or
// stratum, and the order is the seeded presentation order.
export function publicPairs(selection, { name, views }) {
  return {
    schema: PAIRS_SCHEMA, name,
    views: views.map(view => ({ id: view.id, label: view.label })),
    pairs: selection.pairs.map(pair => ({ id: pair.id, title: pair.a.title, variant: pair.variant, images: imagesOf(pair.id, views) })),
  };
}

const side = item => ({
  batch: item.batch, task_dir: item.task_id, slot: item.slot, dir: item.dir, model_path: item.model_path, model_sha256: item.model_sha256,
  configuration: item.config, system: item.system, model: item.model, effort: item.effort,
  score: item.score, shape_score: item.shape_score, detail_score: item.detail_score,
  alignment: item.alignment, shape_pose_moved_fraction: item.shape_pose_moved,
});

// key.json: everything the analysis joins the votes with.
export function privateKey(selection, { name, batches, views, createdAt = null, skipped = null, problems = [], render = null }) {
  return {
    schema: KEY_SCHEMA, name, created_at: createdAt, batches, seed: selection.seed, requested: selection.requested,
    strata: selection.strata, tasks_used: selection.tasks_used, skipped_submissions: skipped, collect_problems: problems,
    views, render,
    pairs: selection.pairs.map(pair => ({
      id: pair.id, position: pair.position, repeat_of: pair.repeat_of,
      task_id: pair.task_id, object: pair.a.object, title: pair.a.title, variant: pair.variant, archetype: pair.archetype, set: pair.a.set,
      stratum: selection.strata[pair.stratum].id, gap: pair.gap, cross_configuration: pair.cross,
      higher: higherSide(pair.a.score, pair.b.score),
      higher_shape: higherSide(pair.a.shape_score, pair.b.shape_score),
      higher_detail: higherSide(pair.a.detail_score, pair.b.detail_score),
      a: side(pair.a), b: side(pair.b),
      images: imagesOf(pair.id, views),
    })),
  };
}
