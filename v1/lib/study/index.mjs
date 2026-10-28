import { readFile, stat, lstat, realpath, rm, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJSON } from '../../../lib/io.mjs';
import { collectSubmissions, selectPairs, publicPairs, privateKey, DEFAULT_PAIRS, DEFAULT_REPEAT_SHARE, PER_TASK } from './select.mjs';
import { renderStudyImages, STUDY_VIEWS, STUDY_SIZE } from './render.mjs';
import { voteFiles } from './votes.mjs';

// The blind paired-comparison study: prepare (select pairs, render them, write
// pairs.json and key.json), then serve.mjs for the rating and analyze.mjs for
// the agreement; exportStudy copies what a rater on another machine needs.
// Everything of one study lives in <data>/study/<name>/.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DEFAULT_DATA_ROOT = join(REPO_ROOT, '.local', 'v1');
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
  // Ratings are never overwritten: a study with votes (any rater's) is finished material.
  for (const { file } of (await voteFiles(dir)).files) {
    if (await fileSize(join(dir, file))) throw new Error(join(dir, file) + ' holds votes; a study with votes is never prepared again (choose another name)');
  }
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

// The real path of `path`, which need not exist yet: its nearest existing
// ancestor resolved through symlinks, then the rest as given. A symlink to a
// missing path on the way is refused: where it would lead cannot be checked.
async function realTarget(path) {
  let head = resolve(path);
  const rest = [];
  for (;;) {
    try { return join(await realpath(head), ...rest); } catch (error) {
      const parent = dirname(head);
      if (error.code !== 'ENOENT' || parent === head) throw error;
      if (await lstat(head).then(() => true, () => false)) throw new Error(head + ' is a symlink to a missing path');
      rest.unshift(basename(head));
      head = parent;
    }
  }
}

// What a rater on another machine needs, and nothing else: pairs.json and the
// images it names, copied to <out>/study/<name>/, with a README.txt (in
// Chinese, like the page) at <out>. No key.json, no votes, no analysis. `out`
// must not exist yet, and must not be inside the repository except under
// .local/ (the renders show the hidden truth; they never go into git).
export async function exportStudy({ dataRoot = DEFAULT_DATA_ROOT, name, out }) {
  if (typeof out !== 'string' || !out) throw new Error('export needs an output directory');
  const source = studyDir(dataRoot, name), target = resolve(out);
  // Compared as real paths, so a symlinked alias of the repository (e.g. macOS /tmp for /private/tmp) is caught.
  const inRepo = relative(await realpath(REPO_ROOT), await realTarget(target));
  const outside = inRepo === '..' || inRepo.startsWith('..' + sep) || isAbsolute(inRepo);
  if (!outside && !(inRepo === '.local' || inRepo.startsWith('.local' + sep))) {
    throw new Error(target + ' is inside the repository; export outside it (or under .local/), the renders show the hidden truth');
  }
  if (await lstat(target).then(() => true, () => false)) throw new Error(target + ' already exists; export into a new directory');
  const pairsBytes = await readFile(join(source, 'pairs.json'));
  const pairs = JSON.parse(pairsBytes.toString('utf8'));
  const images = [...new Set(pairs.pairs.flatMap(pair => Object.values(pair.images).flatMap(byRole => Object.values(byRole))))].sort();
  // Every image is there before anything is written, so a failed export leaves nothing behind.
  for (const image of images) if (await fileSize(join(source, 'images', image)) === null) throw new Error(join(source, 'images', image) + ' is named in pairs.json but missing; prepare the study again');
  const dir = studyDir(target, name);
  await mkdir(join(dir, 'images'), { recursive: true });
  for (const image of images) await copyFile(join(source, 'images', image), join(dir, 'images', image));
  await writeFile(join(dir, 'pairs.json'), pairsBytes);
  await writeFile(join(target, 'README.txt'), raterReadme(name));
  return { dir, out: target, pairs: pairs.pairs.length, images: images.length };
}

function raterReadme(name) {
  return [
    '几何盲评：给评审者的说明',
    '',
    '1. 需要 Node 22 和 evidence3d-bench 仓库的代码（git clone 后在仓库目录里 npm ci）。',
    '2. 在仓库目录里运行（把 <这个文件夹> 换成本说明所在文件夹的完整路径）：',
    '',
    '   node v1/scripts/study.mjs serve --name ' + name + ' --data <这个文件夹>',
    '',
    '3. 用 Chrome 或 Edge 打开它打印的地址（http://127.0.0.1:4173/）。第一次打开会问名字：',
    '   只用英文字母和数字，例如 zhangsan。之后每一票都记在这个名字下。',
    '4. 可以随时停下（Ctrl-C 关掉服务），再运行同一条命令就从没评过的一对接着评。',
    '5. 评完后把 study/' + name + '/votes.jsonl 发回给组织者。',
    '',
    '请不要和别人讨论具体的对，也不要看别人的选择。',
    '',
  ].join('\n');
}
