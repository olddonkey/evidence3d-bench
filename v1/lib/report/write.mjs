import { readFile, writeFile, mkdir, copyFile, stat, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, dirname, basename, relative } from 'node:path';
import { writeJSON, contained, sha256 } from '../../../lib/io.mjs';
import { layout } from '../contract.mjs';
import { encodePNG } from '../png.mjs';
import { soupFromModel, soupFromGLB, transformSoup, transformPoint } from '../soup.mjs';
import { validateModel } from '../model.mjs';
import { shadeSoup, standardViews, unionBounds } from '../render/shade.mjs';
import { collectRuns, DEFAULT_EXCLUDED_STATUSES } from './collect.mjs';
import { buildLeaderboard, cellKey, reportName } from './aggregate.mjs';
import { esc, slug, STYLE } from './html.mjs';
import { indexPage } from './index-page.mjs';
import { taskPage, candidateLabel, attemptLabel } from './task-page.mjs';
import { summaryMarkdown } from './markdown.mjs';

// Static results site: index.html (per set: leaderboard, pairwise, variance,
// breakdowns, task index), summary.md (the same in Markdown), one page per task
// under tasks/, renders and copied evidence under assets/, and the full
// leaderboard as JSON. Opens from disk; no server, no external assets.
//
// Scale. Work is bounded per attempt: on a task page only each configuration's
// best, median and worst counted attempt (REPRESENTATIVES) is parsed, rendered
// and has its error maps copied; every other attempt costs one table row from
// the report already in memory. Objects are processed one at a time: the truth
// is loaded and rendered once per object (all its tasks share one frame), and
// candidates are parsed, rendered and released one by one, so memory holds one
// candidate soup at a time. Evidence files are stored once by content hash.
export const REPORT_VIEWS = ['iso', 'front', 'top', 'iso-rear'];
export const REPRESENTATIVES = ['best', 'median', 'worst'];

const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const HASH = /^[a-f0-9]{64}$/;
// The attempt directory name is unique within a batch and task; the attempt
// number inside result.json is only what the runner reported.
const attemptSlug = attempt => slug(attempt.batch) + '--' + slug(attempt.slot ?? 'a' + attempt.attempt);
const slotOrder = attempt => Number(String(attempt.slot ?? '').replace(/^a/, '')) || attempt.attempt || 0;

// A drawn candidate's soup. When result.json recorded the scored artifact's
// hash, the file must still match it (collect checks only that it is a plain
// file inside the attempt; the read and hash are paid here, for drawn attempts only).
// three's GLTFLoader warns once per accessor without min/max, which the
// kernel's neutral GLB leaves out; hundreds of such lines would bury the CLI's
// output. Only that message is dropped, and only while a candidate is parsed.
export class HashMismatch extends Error {}
async function parseCandidate(attempt) {
  const bytes = await readFile(attempt.model_path);
  if (attempt.model_sha256 && sha256(bytes) !== attempt.model_sha256) throw new HashMismatch(attempt.model_path + ' does not match the artifact hash in result.json; not drawn');
  const warn = console.warn;
  console.warn = (...args) => { if (!(typeof args[0] === 'string' && args[0].startsWith('THREE.GLTFLoader: Missing min/max'))) warn(...args); };
  try { return await soupFromGLB(bytes); } finally { console.warn = warn; }
}

async function readJSON(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}
async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}
// Copy-on-write clone where the file system supports it (APFS, btrfs), else a
// plain copy: error maps and photographs cost no disk on the same volume, and
// the report keeps its own bytes if the run directory is rescored later.
const cloneFile = (source, target) => copyFile(source, target, constants.COPYFILE_FICLONE);

// Per configuration: its best, median and worst counted attempt by score (ties
// broken by batch and attempt directory), with their role; with one or two
// attempts, those. Every other attempt, excluded ones included, is collapsed.
// `order` lists configuration keys in leaderboard order; others follow by name.
export function pickRepresentatives(attempts, order = []) {
  const cells = new Map();
  for (const attempt of attempts) {
    const key = cellKey(attempt);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(attempt);
  }
  const rank = key => { const index = order.indexOf(key); return index < 0 ? Infinity : index; };
  const shown = [], collapsed = [];
  for (const key of [...cells.keys()].sort((p, q) => rank(p) - rank(q) || p.localeCompare(q))) {
    const list = cells.get(key);
    const counted = list.filter(attempt => !attempt.excluded)
      .sort((a, b) => b.score - a.score || a.batch.localeCompare(b.batch) || slotOrder(a) - slotOrder(b));
    const n = counted.length;
    const picks = n === 0 ? [] : n === 1 ? [[0, null]] : n === 2 ? [[0, 'best'], [1, 'worst']] : [[0, 'best'], [Math.floor((n - 1) / 2), 'median'], [n - 1, 'worst']];
    const chosen = new Set(picks.map(([index]) => index));
    for (const [index, role] of picks) shown.push({ attempt: counted[index], role, of: n });
    collapsed.push(...counted.filter((_, index) => !chosen.has(index)), ...list.filter(attempt => attempt.excluded));
  }
  return { shown, collapsed };
}

const diagonal = box => Math.hypot(...box.max.map((value, i) => value - box.min[i]));

// The candidate's box in the truth frame, from the scorer's record of its
// bounds and the alignment, without parsing the GLB: the eight corners of the
// recorded box, transformed. A rotated box's own box is a little larger than
// the rotated geometry's, which only loosens the frame.
const isBox = box => Array.isArray(box?.min) && Array.isArray(box?.max) && box.min.length === 3 && box.max.length === 3 && [...box.min, ...box.max].every(isNumber);
function alignedBounds(report) {
  const bounds = report?.technical?.bounds;
  if (!isBox(bounds)) return null;
  const transform = alignmentOf(report);
  const corners = [];
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) corners.push(transformPoint([x, y, z], transform));
  return { min: [0, 1, 2].map(i => Math.min(...corners.map(corner => corner[i]))), max: [0, 1, 2].map(i => Math.max(...corners.map(corner => corner[i]))) };
}

// The scorer reports p' = s * Ry(yaw) * p + t from candidate to truth.
function alignmentOf(report) {
  const alignment = report?.alignment ?? {};
  return { scale: isNumber(alignment.scale) ? alignment.scale : 1, yaw: isNumber(alignment.yaw_deg) ? alignment.yaw_deg * Math.PI / 180 : 0,
    translation: Array.isArray(alignment.translation_m) && alignment.translation_m.length === 3 && alignment.translation_m.every(isNumber) ? alignment.translation_m : [0, 0, 0] };
}

// One frame for every task of an object: the truth's box, grown to take in the
// drawn candidates whose union with the truth stays within FRAME_LIMIT times
// its diagonal. With three tasks, four configurations and three attempts, one
// object has some 36 drawn candidates; a single one far larger than the truth
// (a unit mistake, a stray triangle) would shrink the truth on every page of the
// object, so such a candidate is left out of the frame and drawn clipped, and
// its row says so. If the accepted candidates together still exceed the
// limit, the frame is the truth's box grown to the limit.
export const FRAME_LIMIT = 1.5;
export function objectFrame(truthBounds, candidateBounds) {
  const boxes = candidateBounds.filter(Boolean);
  if (!truthBounds) return { bounds: boxes.length ? unionBounds(...boxes) : null, fallback: false };
  const limit = FRAME_LIMIT * diagonal(truthBounds);
  const accepted = boxes.filter(box => diagonal(unionBounds(truthBounds, box)) <= limit);
  const union = unionBounds(truthBounds, ...accepted);
  if (diagonal(union) <= limit) return { bounds: union, fallback: false, left_out: boxes.length - accepted.length };
  const centre = truthBounds.min.map((value, i) => (value + truthBounds.max[i]) / 2);
  const half = truthBounds.max.map((value, i) => (value - truthBounds.min[i]) * FRAME_LIMIT / 2);
  return { bounds: { min: centre.map((c, i) => c - half[i]), max: centre.map((c, i) => c + half[i]) }, fallback: true, left_out: boxes.length - accepted.length };
}

const inside = (box, frame) => {
  const tolerance = 1e-6 * diagonal(frame);
  return box.min.every((value, i) => value >= frame.min[i] - tolerance) && box.max.every((value, i) => value <= frame.max[i] + tolerance);
};

// ------------------------------------------------------------------ writer

export async function writeReport({ dataRoot, batches, outDir, views = REPORT_VIEWS, size = 360, seed, now, excludeStatuses = DEFAULT_EXCLUDED_STATUSES, plannedObjects,
  roster } = {}) {
  if (typeof dataRoot !== 'string' || !dataRoot) throw new Error('writeReport needs dataRoot');
  const clock = performance.now(), timing = { collect_s: 0, aggregate_s: 0, parse_s: 0, render_s: 0, pages_s: 0, total_s: 0 };
  const lap = (key, since) => { timing[key] += (performance.now() - since) / 1000; };
  const root = resolve(dataRoot), paths = layout(root);
  const target = resolve(outDir ?? join(paths.reports, reportName(batches)));
  let since = performance.now();
  const collected = await collectRuns({ dataRoot: root, batches, excludeStatuses });
  lap('collect_s', since);
  since = performance.now();
  const board = buildLeaderboard(collected, { seed, now, excludeStatuses, plannedObjects, roster });
  lap('aggregate_s', since);
  // Renders and pages of an earlier report in the same directory would be
  // stale and unlinked. They are removed only when the directory holds a
  // report (its leaderboard.json), never in a directory the report does not own.
  const previous = await readJSON(join(target, 'leaderboard.json'));
  if (typeof previous?.schema === 'string' && previous.schema.startsWith('e3d-leaderboard-')) {
    for (const sub of ['tasks', 'assets']) await rm(join(target, sub), { recursive: true, force: true });
  }
  await mkdir(join(target, 'assets', 'inputs'), { recursive: true });
  await mkdir(join(target, 'tasks'), { recursive: true });
  await writeFile(join(target, 'assets', 'style.css'), STYLE);
  const notes = [];
  let images = 0, drawn = 0;

  const writeShaded = async (soup, camera, file) => {
    const start = performance.now();
    const image = shadeSoup(soup, camera, { supersample: 2 });
    await writeFile(file, encodePNG(image.width, image.height, image.pixels, 3));
    lap('render_s', start);
    images++;
  };

  // Evidence files, stored once by content: the t2, t4 and c1 packs of one
  // object share their photographs.
  const copiedInputs = new Map();
  const copyInput = async (source, input) => {
    const digest = HASH.test(input.sha256 ?? '') ? input.sha256 : sha256(await readFile(source));
    const file = join(target, 'assets', 'inputs', digest.slice(0, 16) + '-' + slug(basename(input.path)));
    if (!copiedInputs.has(file)) { await cloneFile(source, file); copiedInputs.set(file, true); }
    return file;
  };

  const attemptsByTask = new Map();
  for (const attempt of collected.attempts) {
    if (!attemptsByTask.has(attempt.task_id)) attemptsByTask.set(attempt.task_id, []);
    attemptsByTask.get(attempt.task_id).push(attempt);
  }
  const objects = [...new Set(board.tasks.map(task => task.object))];
  for (const object of objects) {
    const objectTasks = board.tasks.filter(task => task.object === object);
    let truthSoup = null, truthModel = null, truthNote = null;
    try {
      truthModel = validateModel(JSON.parse(await readFile(join(paths.object(object), 'model.json'), 'utf8')));
      truthSoup = soupFromModel(truthModel);
    } catch (error) { truthNote = 'ground truth not rendered: ' + error.message; }

    // Which attempts each task draws; the frame comes from their recorded
    // bounds, so no candidate has to be parsed before the frame is known.
    const plans = objectTasks.map(taskInfo => {
      const attempts = (attemptsByTask.get(taskInfo.task_id) ?? []).slice()
        .sort((a, b) => cellKey(a).localeCompare(cellKey(b)) || a.batch.localeCompare(b.batch) || slotOrder(a) - slotOrder(b));
      const order = board.entries.filter(entry => entry.set === taskInfo.set).map(entry => entry.key);
      return { taskInfo, attempts, ...pickRepresentatives(attempts, order) };
    });
    const drawable = item => item.attempt.valid && item.attempt.model_path;
    const boxes = [];
    for (const item of plans.flatMap(plan => plan.shown.filter(drawable))) {
      let box = alignedBounds(item.attempt.report);
      // A report without recorded bounds: parse once for them (rare).
      if (!box) {
        const start = performance.now();
        try { box = transformSoup(await parseCandidate(item.attempt), alignmentOf(item.attempt.report)).bounds; } catch { box = null; }
        lap('parse_s', start);
      }
      boxes.push(box);
    }
    const frame = objectFrame(truthSoup?.bounds ?? null, boxes);
    const cameras = frame.bounds ? standardViews(frame.bounds, size) : null;
    const frameNote = frame.fallback ? 'The candidates together extend far beyond the ground truth, so the views are framed on the ground truth grown by half.'
      : frame.left_out ? 'Candidates that would stretch the frame beyond ' + FRAME_LIMIT + ' times the ground truth\'s diagonal are left out of it and drawn clipped.' : '';

    let truthImages = null;
    if (truthSoup && cameras) {
      const truthDir = join(target, 'assets', 'renders', 'objects', slug(object));
      await mkdir(truthDir, { recursive: true });
      truthImages = {};
      for (const view of views) {
        const file = join(truthDir, 'truth-' + view + '.png');
        await writeShaded(truthSoup, cameras[view], file);
        truthImages[view] = file;
      }
    }

    for (const plan of plans) {
      const pageStart = performance.now();
      const { taskInfo, attempts, shown, collapsed } = plan;
      const taskId = taskInfo.task_id, taskSlug = slug(taskId);
      const renderDir = join(target, 'assets', 'renders', taskSlug);
      await mkdir(renderDir, { recursive: true });
      const href = file => relative(join(target, 'tasks'), file).split('\\').join('/');

      // Evidence actually given to the contestant: the task pack's inputs.
      const task = await readJSON(join(paths.task(taskId), 'task.json'));
      const inputs = [];
      for (const input of task?.inputs ?? []) {
        const entry = { ...input };
        try {
          const source = contained(paths.task(taskId), input.path);
          if (await exists(source)) {
            entry.href = href(await copyInput(source, input));
            if (/\.(md|txt)$/i.test(input.path)) entry.text = await readFile(source, 'utf8');
          }
        } catch (error) { notes.push(taskId + ': input ' + input.path + ' not copied: ' + error.message); }
        inputs.push(entry);
      }

      const renderRows = [{ label: '<strong>Ground truth</strong><small>' + esc(truthModel?.title ?? taskInfo.object) + '</small>', alt: 'ground truth',
        images: truthImages ? Object.fromEntries(Object.entries(truthImages).map(([view, file]) => [view, href(file)])) : null, placeholder: truthNote ?? 'not rendered' }];
      const maps = [];
      let previousCell = null;
      for (const item of shown) {
        const { attempt } = item;
        const group = cellKey(attempt) !== previousCell ? '<strong>' + esc(cellKey(attempt)) + '</strong>' + (item.of > 1 ? ' · ' + item.of + ' counted attempts' : '') : null;
        previousCell = cellKey(attempt);
        const row = { group, alt: attemptLabel(attempt), images: null, placeholder: null };
        let flags = {};
        if (!attempt.model_path) row.placeholder = attempt.valid ? 'model file not found' : 'no model: ' + attempt.failure;
        else if (!attempt.valid) row.placeholder = 'not scored: ' + attempt.failure;
        else if (cameras) {
          try {
            const start = performance.now();
            const soup = transformSoup(await parseCandidate(attempt), alignmentOf(attempt.report));
            lap('parse_s', start);
            flags = { unaligned: !attempt.report.alignment, clipped: !inside(soup.bounds, frame.bounds) };
            row.images = {};
            for (const view of views) {
              const file = join(renderDir, attemptSlug(attempt) + '-' + view + '.png');
              await writeShaded(soup, cameras[view], file);
              row.images[view] = href(file);
            }
            drawn++;
          } catch (error) {
            if (error instanceof HashMismatch) { row.placeholder = 'model file does not match its recorded hash; not drawn'; notes.push(error.message); }
            else row.placeholder = 'model could not be read: ' + error.message;
          }
        }
        row.label = candidateLabel(item, { ...flags, withKey: false });
        renderRows.push(row);

        // Scorer artifacts (error maps) of the drawn attempts only.
        if (attempt.valid && Array.isArray(attempt.report.artifacts)) {
          const scoreDir = attempt.report_path ? dirname(attempt.report_path) : join(attempt.dir, 'score');
          const files = [];
          for (const name of attempt.report.artifacts) {
            if (typeof name !== 'string' || !/\.(png|jpe?g)$/i.test(name)) continue;
            try {
              const source = contained(scoreDir, name);
              if (!(await exists(source))) continue;
              const copy = join(renderDir, attemptSlug(attempt) + '--' + slug(basename(name)));
              await cloneFile(source, copy);
              files.push({ name: basename(name).replace(/\.(png|jpe?g)$/i, ''), href: href(copy) });
            } catch (error) { notes.push(taskId + ': artifact ' + name + ' not copied: ' + error.message); }
          }
          if (files.length) maps.push({ label: candidateLabel(item), alt: attemptLabel(attempt), files });
        }
      }

      const html = taskPage({ taskInfo, task, inputs, truthModel, truthInfo: collected.truths.get(taskId) ?? await readJSON(join(paths.truth(taskId), 'truth.json')),
        setInfo: board.sets.find(set => set.id === taskInfo.set)?.description ?? null,
        views, renderRows: cameras ? renderRows : [], maps, shown, collapsed, counts: { attempts: attempts.length }, frameNote });
      await writeFile(join(target, 'tasks', taskSlug + '.html'), html);
      lap('pages_s', pageStart);
    }
  }
  if (notes.length) board.problems.push(...notes);
  await writeJSON(join(target, 'leaderboard.json'), board);
  await writeFile(join(target, 'index.html'), indexPage(board, { summaryFile: 'summary.md' }));
  await writeFile(join(target, 'summary.md'), summaryMarkdown(board));
  timing.total_s = (performance.now() - clock) / 1000;
  // pages_s includes the parse and render time spent inside it.
  for (const key of Object.keys(timing)) timing[key] = Math.round(timing[key] * 100) / 100;
  // Compact on purpose: the CLI prints it. The full leaderboard is in leaderboard.json.
  return {
    outDir: target, index: join(target, 'index.html'), summary: join(target, 'summary.md'), leaderboard: join(target, 'leaderboard.json'),
    tasks: board.tasks.length, attempts: collected.attempts.length, attempts_drawn: drawn, images, problems: board.problems.length,
    sets: board.sets.map(set => ({
      id: set.id, kind: set.description?.kind ?? null, development: set.description?.development ?? false, objects: set.objects, tasks: set.tasks, counted: set.counted,
      ranking: board.entries.filter(entry => entry.set === set.id).map(entry => ({ rank: entry.rank, key: entry.key, score: round(entry.score.mean), ci95: entry.score.ci95?.map(round) ?? null,
        ...(entry.reference ? { reference: true } : {}) })),
      ladders: set.ladders.map(ladder => ({ id: ladder.id, ranking: ladder.entries.map(item => ({ rank: item.rank, key: item.key })),
        separated: ladder.pairwise.correction.separated + ' of ' + ladder.pairwise.correction.comparisons + ' pairs after Holm' })),
      pairs: set.pairwise.pairs.map(pair => ({ a: pair.a, b: pair.b, difference: round(pair.mean_difference), ci95: pair.ci95?.map(round) ?? null,
        t_ci95: pair.t_ci95?.map(round) ?? null, verdict: pair.verdict, holm: pair.holm?.verdict ?? null })),
    })),
    timing,
  };
}

const round = value => isNumber(value) ? Math.round(value * 100) / 100 : null;
