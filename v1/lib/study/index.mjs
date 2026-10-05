import { readFile, stat, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJSON } from '../../../lib/io.mjs';
import { collectSubmissions, selectPairs, publicPairs, privateKey, DEFAULT_PAIRS, DEFAULT_REPEAT_SHARE, PER_TASK } from './select.mjs';
import { renderStudyImages, STUDY_VIEWS, STUDY_SIZE } from './render.mjs';

// The blind paired-comparison study: prepare (select pairs, render them, write
// pairs.json and key.json), then serve.mjs for the rating and analyze.mjs for
// the agreement. Everything of one study lives in <data>/study/<name>/.

export const DEFAULT_DATA_ROOT = fileURLToPath(new URL('../../../.local/v1', import.meta.url));
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function studyDir(dataRoot, name) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('study name must match ' + NAME + ': ' + JSON.stringify(name));
  return join(resolve(dataRoot), 'study', name);
}

async function fileSize(path) {
  try { return (await stat(path)).size; } catch { return null; }
}

// What a rater could be misled by, over the distinct submissions shown: drawn
// off the frame, placed away from the truth, a very different size, or a
// scorer shape pose that differs from the drawn pose.
export function renderConcerns(keyPairs) {
  const seen = new Map();
  for (const pair of keyPairs) {
    for (const role of ['a', 'b']) {
      const side = pair[role];
      if (seen.has(side.model_path)) continue;
      seen.set(side.model_path, { clipped: pair.render?.clipped?.[role] ?? [], placement: pair.render?.placement?.[role] ?? null, moved: side.shape_pose_moved_fraction });
    }
  }
  const list = [...seen.values()];
  const count = test => list.filter(test).length;
  return {
    submissions: list.length,
    clipped_any_view: count(item => item.clipped.length > 0),
    clipped_views: list.reduce((sum, item) => sum + item.clipped.length, 0),
    reference_clipped_pairs: keyPairs.filter(pair => pair.render?.clipped?.r?.length).length,
    centre_offset_over_5pct: count(item => item.placement && item.placement.centre_offset_fraction > 0.05),
    centre_offset_over_10pct: count(item => item.placement && item.placement.centre_offset_fraction > 0.10),
    size_ratio_outside_0_8_to_1_25: count(item => item.placement && (item.placement.size_ratio < 0.8 || item.placement.size_ratio > 1.25)),
    shape_pose_moved_over_1pct: count(item => typeof item.moved === 'number' && item.moved > 0.01),
    shape_pose_moved_over_3pct: count(item => typeof item.moved === 'number' && item.moved > 0.03),
  };
}

export async function prepareStudy({ dataRoot = DEFAULT_DATA_ROOT, name, batches, pairs = DEFAULT_PAIRS, seed, repeatShare = DEFAULT_REPEAT_SHARE, perTask = PER_TASK,
  views = STUDY_VIEWS, size = STUDY_SIZE, force = false, log = () => {}, now = () => new Date() }) {
  if (!Array.isArray(batches) || !batches.length) throw new Error('prepare needs at least one batch');
  if (seed === undefined || seed === null || seed === '') throw new Error('prepare needs a seed');
  const root = resolve(dataRoot), dir = studyDir(root, name);
  // Ratings are never overwritten: a study with votes is finished material.
  if (await fileSize(join(dir, 'votes.jsonl'))) throw new Error(join(dir, 'votes.jsonl') + ' holds votes; a study with votes is never prepared again (choose another name)');
  if (await fileSize(join(dir, 'pairs.json')) !== null && !force) throw new Error(dir + ' already holds a study; pass --force to prepare it again');
  await rm(join(dir, 'images'), { recursive: true, force: true });
  await rm(join(dir, 'pairs.json'), { force: true });
  await mkdir(dir, { recursive: true });

  const { submissions, skipped, problems } = await collectSubmissions({ dataRoot: root, batches });
  log({ event: 'collected', submissions: submissions.length, skipped, problems: problems.length });
  const selection = selectPairs(submissions, { pairs, seed, repeatShare, perTask });
  log({ event: 'selected', pairs: selection.pairs.length, strata: selection.strata.map(item => ({ id: item.id, target: item.target, selected: item.selected, shortfall: item.shortfall })) });
  const viewSpecs = views.map(view => ({ ...view }));
  const key = privateKey(selection, { name, batches, views: viewSpecs, createdAt: now().toISOString(), skipped, problems });
  const render = await renderStudyImages({ dataRoot: root, studyDir: dir, pairs: key.pairs, views, size, log });
  key.render = { ...render, concerns: renderConcerns(key.pairs) };
  // key.json first and pairs.json last: a study is ready only when pairs.json exists.
  await writeJSON(join(dir, 'key.json'), key);
  await writeJSON(join(dir, 'pairs.json'), publicPairs(selection, { name, views }));
  return {
    dir, pairs: key.pairs.length, originals: key.pairs.filter(pair => !pair.repeat_of).length, repeats: key.pairs.filter(pair => pair.repeat_of).length,
    tasks_used: key.tasks_used,
    strata: key.strata.map(item => ({ id: item.id, target: item.target, selected: item.selected, shortfall: item.shortfall, candidates: item.candidates,
      cross_configuration: item.cross_configuration, repeats: item.repeats, variants: item.variants })),
    images: render.images, timing: render.timing, concerns: key.render.concerns,
  };
}

export async function readStudy(dir) {
  const read = async file => JSON.parse(await readFile(join(dir, file), 'utf8'));
  return { pairs: await read('pairs.json'), key: await read('key.json') };
}
