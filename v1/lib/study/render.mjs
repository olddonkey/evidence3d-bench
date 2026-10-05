import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256 } from '../../../lib/io.mjs';
import * as raster from '../raster.mjs';
import { encodePNG } from '../png.mjs';
import { soupFromModel, soupFromGLB, transformSoup } from '../soup.mjs';
import { validateModel } from '../model.mjs';
import { layout } from '../contract.mjs';
import { shadeSoup, DEFAULT_SHADING } from '../render/shade.mjs';
import { parseColor, linearToSrgb } from '../../tools/shading.mjs';
import { imageName } from './select.mjs';

// Neutral renders for the study: the reference (truth) and both submissions of
// a pair, each from the same four perspective cameras, in the same clay shading,
// so the only thing that differs between the three pictures of a view is the
// geometry.
//
// Cameras are framed on the truth's bounds alone, never on a submission, so a
// submission that is too large, misplaced or carries a stray part shows as
// exactly that (and runs off the frame) instead of shrinking the reference.
// Submissions are placed in the truth frame with the alignment the scorer
// stored (report.alignment, the searched pose), as the results report does.

// Azimuth from the front (+Z) towards the viewer's right (+X); elevation above
// the horizon. Front-left and front-right obliques, a rear oblique from the
// left and a high oblique from the rear right, so every facade and the roof is
// seen at least once.
export const STUDY_VIEWS = [
  { id: 'fl', label: '左前方', azimuth: -40, elevation: 16 },
  { id: 'fr', label: '右前方', azimuth: 40, elevation: 16 },
  { id: 'rear', label: '左后方', azimuth: 215, elevation: 18 },
  { id: 'high', label: '右后上方', azimuth: 135, elevation: 58 },
];
export const STUDY_SIZE = Object.freeze({ width: 560, height: 420 });
export const FIELD_OF_VIEW_DEG = 35;
// The truth's projected box fills this share of the frame; the rest is room
// for submissions somewhat larger than the truth.
export const FRAME_FILL = 0.9;
// Clay: one colour for everything (colour is not what the study is about).
export const STUDY_SHADING = Object.freeze({ clay: true, edges: true, supersample: 2 });

const BACKGROUND = parseColor(DEFAULT_SHADING.background).map(value => Math.round(linearToSrgb(value) * 255));
const corners = bounds => Array.from({ length: 8 }, (_, corner) => [0, 1, 2].map(i => corner >> i & 1 ? bounds.max[i] : bounds.min[i]));
const diagonal = bounds => Math.hypot(...bounds.max.map((value, i) => value - bounds.min[i]));

// A perspective camera looking at the box from (azimuth, elevation), pulled back
// until the box's projection fills `fill` of the frame and centred on it.
export function studyCamera(bounds, view, { width = STUDY_SIZE.width, height = STUDY_SIZE.height, fill = FRAME_FILL } = {}) {
  const centre = bounds.min.map((value, i) => (value + bounds.max[i]) / 2);
  const radius = Math.max(1e-6, diagonal(bounds) / 2);
  const az = view.azimuth * Math.PI / 180, el = view.elevation * Math.PI / 180;
  const direction = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
  const points = corners(bounds);
  let distance = radius / Math.sin(FIELD_OF_VIEW_DEG * Math.PI / 360), target = [...centre], camera;
  for (let pass = 0; pass < 12; pass++) {
    const position = target.map((value, i) => value + direction[i] * distance);
    camera = raster.perspectiveCamera({ position, target, fov_y_deg: FIELD_OF_VIEW_DEG, width, height, near: Math.max(1e-3, distance * 1e-3) });
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, behind = false;
    for (const point of points) {
      const [x, y, z] = raster.projectPoint(camera, point);
      if (!(z > camera.near)) { behind = true; break; }
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (behind) { distance *= 1.6; continue; }
    const reach = Math.max((x1 - x0) / width, (y1 - y0) / height);
    const shiftX = ((x0 + x1) / 2 - camera.cx) * distance / camera.fx, shiftY = -((y0 + y1) / 2 - camera.cy) * distance / camera.fy;
    target = target.map((value, i) => value + shiftX * camera.right[i] + shiftY * camera.up[i]);
    if (Math.abs(reach - fill) < 0.005 && Math.hypot(shiftX, shiftY) < radius * 1e-3) break;
    distance *= Math.max(0.6, Math.min(1.6, reach / fill));
  }
  return camera;
}

export function studyCameras(bounds, { views = STUDY_VIEWS, width, height, fill } = {}) {
  return Object.fromEntries(views.map(view => [view.id, studyCamera(bounds, view, { width, height, fill })]));
}

// The scorer's p' = s * Ry(yaw) * p + t from submission to truth.
export function alignmentTransform(alignment) {
  const a = alignment ?? {};
  const ok = value => typeof value === 'number' && Number.isFinite(value);
  return {
    scale: ok(a.scale) ? a.scale : 1,
    yaw: ok(a.yaw_deg) ? a.yaw_deg * Math.PI / 180 : 0,
    translation: Array.isArray(a.translation_m) && a.translation_m.length === 3 && a.translation_m.every(ok) ? a.translation_m : [0, 0, 0],
  };
}

// Does any drawn pixel lie on the image border (the model runs off the frame)?
function touchesBorder({ width, height, pixels }) {
  const differs = at => pixels[at * 3] !== BACKGROUND[0] || pixels[at * 3 + 1] !== BACKGROUND[1] || pixels[at * 3 + 2] !== BACKGROUND[2];
  for (let x = 0; x < width; x++) if (differs(x) || differs((height - 1) * width + x)) return true;
  for (let y = 0; y < height; y++) if (differs(y * width) || differs(y * width + width - 1)) return true;
  return false;
}

// One model through every camera: PNG bytes plus what the picture shows.
export function renderViews(soup, cameras, shading = STUDY_SHADING) {
  const out = {};
  for (const [view, camera] of Object.entries(cameras)) {
    const image = shadeSoup(soup, camera, shading);
    out[view] = { png: encodePNG(image.width, image.height, image.pixels, 3), covered: image.covered, clipped: touchesBorder(image) };
  }
  return out;
}

// three's GLTFLoader warns once per accessor without min/max, which the
// kernel's neutral GLB leaves out; only that message is dropped while parsing.
async function parseSubmission(path, expectedSha256) {
  const bytes = await readFile(path);
  if (expectedSha256 && sha256(bytes) !== expectedSha256) throw new Error(path + ' does not match the artifact hash recorded in result.json');
  const warn = console.warn;
  console.warn = (...args) => { if (!(typeof args[0] === 'string' && args[0].startsWith('THREE.GLTFLoader: Missing min/max'))) warn(...args); };
  try { return await soupFromGLB(bytes); } finally { console.warn = warn; }
}

// Where an aligned submission sits relative to the truth: offset of the box
// centres as a fraction of the truth diagonal, and the ratio of the diagonals.
function placement(bounds, truthBounds) {
  const centre = box => box.min.map((value, i) => (value + box.max[i]) / 2);
  const d = diagonal(truthBounds), a = centre(bounds), b = centre(truthBounds);
  return { centre_offset_fraction: Math.round(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / d * 1e4) / 1e4,
    size_ratio: Math.round(diagonal(bounds) / d * 1e4) / 1e4 };
}

// Renders every image named in key.pairs into <studyDir>/images. Objects are
// handled one at a time: the truth is rendered once per object, each
// submission once (a repeat or a second pair of the task reuses its pictures),
// and only PNG bytes are kept between pairs. Returns per-pair render facts and
// timing; key.pairs entries gain a `render` block.
export async function renderStudyImages({ dataRoot, studyDir, pairs, views = STUDY_VIEWS, size = STUDY_SIZE, shading = STUDY_SHADING, fill = FRAME_FILL, log = () => {} }) {
  const root = resolve(dataRoot), paths = layout(root), imageDir = join(studyDir, 'images');
  await mkdir(imageDir, { recursive: true });
  const started = performance.now();
  const timing = { truth_ms: 0, submissions_ms: 0, write_ms: 0, per_pair_ms: [] };
  const objects = [...new Set(pairs.map(pair => pair.object))].sort();
  let done = 0, images = 0;
  for (const object of objects) {
    let since = performance.now();
    const model = validateModel(JSON.parse(await readFile(join(paths.object(object), 'model.json'), 'utf8')));
    const truth = soupFromModel(model);
    const cameras = studyCameras(truth.bounds, { views, width: size.width, height: size.height, fill });
    const truthViews = renderViews(truth, cameras, shading);
    timing.truth_ms += performance.now() - since;
    const rendered = new Map();
    for (const pair of pairs.filter(item => item.object === object)) {
      const pairStart = performance.now();
      const facts = { clipped: {}, placement: {} };
      const sides = { r: truthViews };
      for (const role of ['a', 'b']) {
        const side = pair[role], key = side.model_path;
        if (!rendered.has(key)) {
          since = performance.now();
          const soup = transformSoup(await parseSubmission(join(root, side.model_path), side.model_sha256), alignmentTransform(side.alignment));
          rendered.set(key, { views: renderViews(soup, cameras, shading), placement: placement(soup.bounds, truth.bounds) });
          timing.submissions_ms += performance.now() - since;
        }
        sides[role] = rendered.get(key).views;
        facts.placement[role] = rendered.get(key).placement;
      }
      since = performance.now();
      for (const [role, byView] of Object.entries(sides)) {
        facts.clipped[role] = views.filter(view => byView[view.id].clipped).map(view => view.id);
        for (const view of views) {
          await writeFile(join(imageDir, imageName(pair.id, role, view.id)), byView[view.id].png);
          images++;
        }
      }
      facts.covered = Object.fromEntries(Object.entries(sides).map(([role, byView]) => [role, Object.fromEntries(views.map(view => [view.id, byView[view.id].covered]))]));
      timing.write_ms += performance.now() - since;
      pair.render = facts;
      const ms = performance.now() - pairStart;
      timing.per_pair_ms.push({ id: pair.id, ms: Math.round(ms), repeat: Boolean(pair.repeat_of) });
      done++;
      log({ event: 'rendered', done, of: pairs.length, ms: Math.round(ms) });
    }
  }
  const perPair = timing.per_pair_ms.map(item => item.ms);
  const firstShowings = timing.per_pair_ms.filter(item => !item.repeat).map(item => item.ms);
  const meanOf = list => list.length ? Math.round(list.reduce((sum, value) => sum + value, 0) / list.length) : null;
  return {
    images, objects: objects.length, size: { ...size }, shading: { ...shading }, fill, field_of_view_deg: FIELD_OF_VIEW_DEG,
    timing: {
      total_s: Math.round(performance.now() - started) / 1000,
      truth_s: Math.round(timing.truth_ms) / 1000, submissions_s: Math.round(timing.submissions_ms) / 1000, write_s: Math.round(timing.write_ms) / 1000,
      // Per pair, the truth's renders (shared by every pair of an object) not included.
      mean_pair_ms: meanOf(perPair), mean_original_pair_ms: meanOf(firstShowings), max_pair_ms: perPair.length ? Math.max(...perPair) : null,
    },
  };
}
