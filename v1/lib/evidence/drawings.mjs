import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateModel } from '../model.mjs';
import { encodePNG } from '../png.mjs';
import { soupFromModel, soupBounds } from '../soup.mjs';
import { orthoCamera, orthoViewOfBounds, projectPoint, render, triangleNormal, dot } from '../raster.mjs';
import { validateEvidenceItem } from '../contract.mjs';
import { rng } from '../rng.mjs';
import { Canvas, INK, WHITE, coverDisc, layoutText, measureText, rotatePoint, scanlineCrossings } from './canvas.mjs';

// Scaled line drawings rendered from the hidden ground-truth model: a plan
// (horizontal section) and two elevations. They are bitmaps a contestant has to
// read the way one reads an architect's sheet - scale bar, dimension strings,
// title block, a slightly skewed scan - never vectors or embedded text.
//
// Geometry comes from the kernel rasterizer, not from the part list: the
// elevations are hidden-line drawings whose edges are where the rendered part,
// surface normal or depth changes, so the drawing shows exactly what the
// orthographic view of the truth shows.
export const SHEETS = ['plan', 'elevation-front', 'elevation-right'];
export const CUT_HEIGHT_M = 1.2;

const SHEET_SPECS = {
  plan: {
    kind: 'plan', view: 'top', dimensionView: 'plan', name: 'GROUND FLOOR PLAN', number: 1,
    note: 'SECTION CUT 1.20 m ABOVE GROUND, FRONT AT THE BOTTOM. DASHED: ROOF AND OVERHANGS ABOVE.',
    description: 'Scaled plan drawing: horizontal section 1.2 m above ground, roof outline dashed, front at the bottom',
  },
  'elevation-front': {
    kind: 'elevation', view: 'front', dimensionView: 'front', name: 'FRONT ELEVATION', number: 2,
    note: 'FRONT FACE VIEWED STRAIGHT ON. HIDDEN LINES OMITTED.',
    description: 'Scaled front elevation drawing',
  },
  'elevation-right': {
    kind: 'elevation', view: 'right', dimensionView: 'right', name: 'RIGHT SIDE ELEVATION', number: 3,
    note: 'RIGHT-HAND SIDE VIEWED STRAIGHT ON, FRONT AT THE LEFT. HIDDEN LINES OMITTED.',
    description: 'Scaled elevation drawing of the right-hand side (on your right as you face the front)',
  },
};

// Pixel sizes. Text is never below 18 px cap height so it survives a downscaled view.
const TEXT = { dimension: 25, title: 28, sheet: 32, label: 22, note: 20, scale: 21 };
const WEIGHT = { outline: 3, projection: 2.1, detail: 1.3, ground: 4.4, cut: 2.6, below: 1.1, dashed: 1.8,
  dimension: 1.2, extension: 1, tick: 2.6, border: 3, rule: 1.3 };
const POCHE = [118, 118, 122];
const MARGIN = 34, PAD = 44, FIRST_TIER = 50, TIER_STEP = 60, EXTENSION_GAP = 6, EXTENSION_OVERSHOOT = 10;
const MAX_DIMENSIONS = 4;

// Drawing density: one px/m for the whole set so the three sheets share a scale.
const PPM_CHOICES = [200, 160, 150, 125, 120, 100, 80, 75, 60, 50, 40, 30, 25, 20, 15, 12, 10];
const TARGET_LONG_SIDE = 2000, MAX_LONG_SIDE = 2400, HARD_LONG_SIDE = 2600, MIN_PPM = 60;
const DEFAULT_SUPERSAMPLE = 3;

const OUTLINE = 3, PROJECTION = 2, DETAIL = 1;
const DEG = Math.PI / 180;
const SMOOTH_TYPES = new Set(['cylinder', 'lathe', 'torus', 'beam']);
const COS_CREASE = Math.cos(20 * DEG), COS_CREASE_SMOOTH = Math.cos(60 * DEG), COS_COPLANAR = Math.cos(3 * DEG);

export async function renderDrawings({ model, outDir, seed, capturedAt, sourceModel = 'primary' }) {
  const context = drawingContext(model);
  await mkdir(join(outDir, 'drawings'), { recursive: true });
  const items = [];
  for (const id of SHEETS) {
    const sheet = renderSheet({ model, sheet: id, seed, capturedAt, context });
    const spec = SHEET_SPECS[id], file = 'drawings/' + id + '.png';
    await writeFile(join(outDir, file), sheet.png);
    items.push(validateEvidenceItem({
      id, kind: spec.kind, file, captured_at: capturedAt, description: spec.description, metric: true, source_model: sourceModel,
      camera: spec.kind === 'elevation' ? sheet.camera : null, occluders: [],
      sha256: createHash('sha256').update(sheet.png).digest('hex'), bytes: sheet.png.length,
    }));
  }
  return items;
}

// Everything the three sheets share: the truth soup and one drawing density.
export function drawingContext(model, { pixelsPerMetre } = {}) {
  validateModel(model);
  const soup = soupFromModel(model);
  return { model, soup, ppm: pixelsPerMetre ?? chooseDensity(model, soup) };
}

// Largest round px/m whose sheets stay within TARGET_LONG_SIDE. If that would drop
// below MIN_PPM the sheet may grow to MAX_LONG_SIDE, then to HARD_LONG_SIDE, and
// only then does the size cap win over MIN_PPM (very tall or long objects). The
// estimate lays every sheet out without rendering it; the rendered sheet may put a
// dimension string on the other side to avoid crossing ink, which SIDE_SLACK covers.
const SIDE_SLACK = 80;
export function chooseDensity(model, soup) {
  const estimate = ppm => Math.max(...SHEETS.map(id => {
    const spec = SHEET_SPECS[id], camera = viewCamera(soup.bounds, spec.view, ppm);
    const frame = frameSheet({ model, spec, camera, box: projectedBox(camera, soup.bounds), ppm, ink: null, capturedAt: '2000-01' });
    return Math.max(frame.width, frame.height) + SIDE_SLACK;
  }));
  // MIN_PPM is kept up to a slightly larger sheet before the size cap wins.
  const fits = limit => PPM_CHOICES.find(ppm => ppm >= MIN_PPM && estimate(ppm) <= limit);
  return fits(TARGET_LONG_SIDE) ?? fits(MAX_LONG_SIDE) ?? fits(HARD_LONG_SIDE) ??
    PPM_CHOICES.find(ppm => estimate(ppm) <= MAX_LONG_SIDE) ?? PPM_CHOICES.at(-1);
}

// Kernel view of the bounds at exactly `ppm` pixels per metre (the kernel rounds the
// pixel count, so the extent is nudged by under half a pixel to make the scale exact).
export function viewCamera(bounds, view, ppm, supersample = 1) {
  const base = orthoViewOfBounds(bounds, view, { pixelsPerMetre: ppm });
  const [u0, u1, v0, v1] = base.extent, cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const halfU = base.width / ppm / 2, halfV = base.height / ppm / 2;
  return orthoCamera({ origin: base.origin, right: base.right, up: base.up, extent: [cu - halfU, cu + halfU, cv - halfV, cv + halfV],
    width: base.width * supersample, height: base.height * supersample });
}

function projectedBox(camera, bounds) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const [x, y] = projectPoint(camera, [0, 1, 2].map(i => (corner >> i & 1 ? bounds.max : bounds.min)[i]));
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

// Places the dimension strings (witness lines avoid `ink`, a coverage mask in camera
// pixels, when given) and sizes the sheet around them and the title block, whichever
// of its two arrangements gives the smaller sheet. Coordinates are camera pixels
// until shifted by (ox, oy).
function frameSheet({ model, spec, camera, box, ppm, ink, capturedAt }) {
  const dimensions = placeDimensions(model, spec, camera, box, ppm, ink);
  const content = { ...box };
  const grow = (x, y) => { content.x0 = Math.min(content.x0, x); content.x1 = Math.max(content.x1, x); content.y0 = Math.min(content.y0, y); content.y1 = Math.max(content.y1, y); };
  for (const d of dimensions.placed) {
    for (const [p, q] of [d.line, ...d.extensions, ...d.ticks]) { grow(...p); grow(...q); }
    grow(d.textBox.x0, d.textBox.y0); grow(d.textBox.x1, d.textBox.y1);
  }
  let ground = null;
  if (spec.kind === 'elevation') {
    // The ground line runs past the building and under every dimension column.
    const y = projectPoint(camera, [camera.origin[0], 0, camera.origin[2]])[1], reach = 0.6 * ppm;
    ground = { y, x0: Math.min(box.x0 - reach, content.x0 - 12), x1: Math.max(box.x1 + reach, content.x1 + 12) };
    grow(ground.x0, y); grow(ground.x1, y);
  }
  let front = null;
  if (spec.kind === 'plan') {
    front = { x: (box.x0 + box.x1) / 2, y: content.y1 + 46 };
    grow(front.x, front.y + TEXT.label * 1.3 + 6); grow(front.x - 60, front.y - 28); grow(front.x + 60, front.y);
  }
  const contentWidth = content.x1 - content.x0, contentHeight = content.y1 - content.y0;
  const block = titleBlock({ model, spec, capturedAt, ppm });
  // Title band along the bottom, the content centred above it.
  const bandWidth = Math.ceil(Math.max(contentWidth + 2 * (MARGIN + PAD), block.minWidth + 2 * MARGIN)), band = block.band(bandWidth - 2 * MARGIN);
  const bandHeight = Math.ceil(contentHeight + 2 * PAD + band.height + 2 * MARGIN);
  const banded = { width: bandWidth, height: bandHeight,
    ox: Math.round(MARGIN + PAD + (bandWidth - 2 * (MARGIN + PAD) - contentWidth) / 2 - content.x0), oy: Math.round(MARGIN + PAD - content.y0),
    drawBlock: canvas => band.draw(canvas, MARGIN, bandHeight - MARGIN - band.height) };
  // Title strip down the right-hand side, the content centred beside it: tall drawings stay larger.
  const strip = block.strip(), stripWidth = Math.ceil(contentWidth + 2 * (MARGIN + PAD) + block.stripWidth);
  const stripHeight = Math.ceil(Math.max(contentHeight + 2 * PAD, strip.height) + 2 * MARGIN);
  const stripped = { width: stripWidth, height: stripHeight,
    ox: Math.round(MARGIN + PAD - content.x0), oy: Math.round(MARGIN + (stripHeight - 2 * MARGIN - contentHeight) / 2 - content.y0),
    drawBlock: canvas => strip.draw(canvas, stripWidth - MARGIN - block.stripWidth, MARGIN, stripHeight - MARGIN) };
  const long = frame => Math.max(frame.width, frame.height);
  const frame = long(stripped) + 40 < long(banded) ? stripped : banded;
  return { dimensions, ground, front, ...frame };
}

// Renders one sheet. Returns the PNG, the object-view camera at sheet density and a
// layout record (where the scale bar and dimension lines landed) for checks.
// `paper` overrides the seeded scan simulation: { rotationDeg, noise }.
export function renderSheet({ model, sheet, seed, capturedAt, context, supersample = DEFAULT_SUPERSAMPLE, paper = {} }) {
  const spec = SHEET_SPECS[sheet];
  if (!spec) throw new Error('Unknown sheet ' + sheet);
  if (!/^\d{4}-\d{2}$/.test(capturedAt ?? '')) throw new Error('capturedAt must be YYYY-MM');
  context ??= drawingContext(model);
  const { soup, ppm } = context;
  model = context.model;
  const random = rng(seed ?? 0).fork('drawings/' + sheet + '/' + capturedAt);
  const camera = viewCamera(soup.bounds, spec.view, ppm), superCamera = viewCamera(soup.bounds, spec.view, ppm, supersample);
  const box = projectedBox(camera, soup.bounds);

  // 1. Geometry as coverage masks in camera pixels.
  const geometry = spec.kind === 'plan'
    ? planGeometry(model, soup, camera, superCamera, supersample, ppm)
    : elevationGeometry(model, soup, camera, superCamera, supersample, ppm);

  // 2. Dimension strings around the drawing and the sheet frame around both.
  const { dimensions, ground, front, width, height, ox, oy, drawBlock } = frameSheet({ model, spec, camera, box, ppm, ink: geometry.ink, capturedAt });
  const shift = ([x, y]) => [x + ox, y + oy];

  // 3. Ink on white; paper tint, skew and grain come last.
  const canvas = new Canvas(width, height);
  for (const layer of geometry.layers) {
    if (layer.mask) canvas.blend({ ...layer.mask, x0: layer.mask.x0 + ox, y0: layer.mask.y0 + oy }, layer.color ?? INK, layer.opacity ?? 1);
    if (layer.polylines) canvas.stroke(layer.polylines.map(line => line.map(shift)), { width: layer.width, dash: layer.dash, color: layer.color ?? INK });
  }
  if (ground) canvas.line(ground.x0 + ox, ground.y + oy, ground.x1 + ox, ground.y + oy, { width: WEIGHT.ground });
  for (const d of dimensions.placed) {
    canvas.stroke(d.extensions.map(line => line.map(shift)), { width: WEIGHT.extension });
    canvas.stroke([d.line.map(shift)], { width: WEIGHT.dimension });
    canvas.stroke(d.ticks.map(line => line.map(shift)), { width: WEIGHT.tick });
  }
  for (const d of dimensions.placed) {
    const b = d.textBox;
    canvas.rect(b.x0 + ox - 3, b.y0 + oy - 3, b.x1 + ox + 3, b.y1 + oy + 3, { color: WHITE });
    canvas.text(d.text, d.textAnchor[0] + ox, d.textAnchor[1] + oy, { size: TEXT.dimension, angleDeg: d.textAngle, align: d.textAlign, baseline: d.textBaseline });
  }
  if (front) {
    const [fx, fy] = shift([front.x, front.y]);
    canvas.fill([[[fx, fy - 26], [fx - 9, fy - 8], [fx + 9, fy - 8]]]);
    canvas.text('FRONT', fx, fy + 4, { size: TEXT.label, align: 'center', baseline: 'top' });
  }
  canvas.stroke([[[MARGIN, MARGIN], [width - MARGIN, MARGIN], [width - MARGIN, height - MARGIN], [MARGIN, height - MARGIN], [MARGIN, MARGIN]]], { width: WEIGHT.border });
  const scaleBar = drawBlock(canvas);

  const finish = finishPaper(canvas, random, paper);
  const center = [width / 2, height / 2], rotate = point => rotatePoint(point, finish.rotationDeg, ...center);
  const layout = {
    sheet, ppm, supersample, width, height, offset: [ox, oy], rotationDeg: finish.rotationDeg, center,
    drawingBox: { x0: box.x0 + ox, y0: box.y0 + oy, x1: box.x1 + ox, y1: box.y1 + oy },
    groundY: ground ? ground.y + oy : null,
    scaleBar,
    dimensions: dimensions.placed.map(d => ({ id: d.id, value_m: d.value_m, text: d.text, side: d.side, orientation: d.orientation,
      a: shift(d.a), b: shift(d.b), ends: d.ends.map(shift), textBox: { x0: d.textBox.x0 + ox, y0: d.textBox.y0 + oy, x1: d.textBox.x1 + ox, y1: d.textBox.y1 + oy } })),
    skippedDimensions: dimensions.skipped,
    minTextPx: Math.min(...Object.values(TEXT)),
    // Object point -> pixel on the delivered (skewed) sheet, and sheet pixel before skew -> after.
    toSheet: point => rotate(shift(projectPoint(camera, point))),
    rotate,
  };
  return { id: sheet, width, height, rgb: finish.rgb, png: finish.png, camera, layout };
}

// ---------------------------------------------------------------------------
// Edges from the depth / triangle-id buffer
// ---------------------------------------------------------------------------
function triangleFacts(model, soup, camera) {
  const count = soup.triangles, normal = new Float32Array(count * 3), slope = new Float32Array(count * 2);
  for (let t = 0; t < count; t++) {
    let n = triangleNormal(soup, t);
    if (dot(n, camera.forward) > 0) n = n.map(value => -value);
    normal[t * 3] = n[0]; normal[t * 3 + 1] = n[1]; normal[t * 3 + 2] = n[2];
    // Depth change per metre along right and up on the triangle's own plane. Faces
    // seen almost edge-on get a capped slope: their sampled depth is unreliable anyway.
    const facing = Math.min(dot(n, camera.forward), -0.15);
    slope[t * 2] = -dot(n, camera.right) / facing;
    slope[t * 2 + 1] = -dot(n, camera.up) / facing;
  }
  const materials = new Map(), partMaterial = new Int32Array(model.parts.length), partSmooth = new Uint8Array(model.parts.length);
  for (const [index, part] of model.parts.entries()) {
    if (!materials.has(part.material)) materials.set(part.material, materials.size);
    partMaterial[index] = materials.get(part.material);
    partSmooth[index] = SMOOTH_TYPES.has(part.type) ? 1 : 0;
  }
  return { normal, slope, partMaterial, partSmooth };
}

// Boundary points (super-sampled pixel coordinates, flat [x, y, x, y, ...]) per edge class:
//   OUTLINE     object against empty background
//   PROJECTION  one surface well in front of another (canopy over a wall)
//   DETAIL      a smaller depth step, another part or material, or a crease
// Two parts of one material meeting in one plane draw no line: that is a
// construction joint of the model, not something a surveyor would draw.
function rasterEdges(image, soup, facts, pixelMetres, blocked = null) {
  const { width, height, tri, depth } = image, { normal, slope, partMaterial, partSmooth } = facts, triPart = soup.triPart;
  const tolerance = 0.02 + 2 * pixelMetres, points = [[], [], [], []];
  const classify = (i, j, du, dv) => {
    const a = tri[i], b = tri[j];
    if (a < 0 || b < 0) return OUTLINE;
    const change = depth[j] - depth[i];
    const gap = Math.min(Math.abs(change - slope[a * 2] * du - slope[a * 2 + 1] * dv), Math.abs(change - slope[b * 2] * du - slope[b * 2 + 1] * dv));
    if (gap > tolerance) return gap > 0.25 ? PROJECTION : DETAIL;
    const cos = normal[a * 3] * normal[b * 3] + normal[a * 3 + 1] * normal[b * 3 + 1] + normal[a * 3 + 2] * normal[b * 3 + 2];
    const partA = triPart[a], partB = triPart[b];
    if (partA !== partB) return partMaterial[partA] === partMaterial[partB] && cos > COS_COPLANAR ? 0 : DETAIL;
    return cos < (partSmooth[partA] ? COS_CREASE_SMOOTH : COS_CREASE) ? DETAIL : 0;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x + 1 < width && tri[i] !== tri[i + 1] && !(blocked && (blocked[i] || blocked[i + 1]))) {
        const kind = classify(i, i + 1, pixelMetres, 0);
        if (kind) points[kind].push(x + 1, y + 0.5);
      }
      if (y + 1 < height && tri[i] !== tri[i + width] && !(blocked && (blocked[i] || blocked[i + width]))) {
        const kind = classify(i, i + width, 0, -pixelMetres);
        if (kind) points[kind].push(x + 0.5, y + 1);
      }
    }
  }
  return points;
}

const emptyMask = camera => ({ x0: 0, y0: 0, width: camera.width, height: camera.height, a: new Float32Array(camera.width * camera.height) });

// Boundary points drawn as round dots at sheet resolution: their union is an
// anti-aliased stroke of the given width along the raster boundary.
function stampPoints(mask, points, supersample, width, strength = 1) {
  const radius = width / 2;
  for (let k = 0; k < points.length; k += 2) coverDisc(mask, points[k] / supersample, points[k + 1] / supersample, radius, strength);
}

function maxMasks(target, ...masks) {
  for (const mask of masks) for (let i = 0; i < target.a.length; i++) if (mask.a[i] > target.a[i]) target.a[i] = mask.a[i];
  return target;
}

function elevationGeometry(model, soup, camera, superCamera, supersample, ppm) {
  const image = render(soup, superCamera);
  const points = rasterEdges(image, soup, triangleFacts(model, soup, superCamera), 1 / (ppm * supersample));
  const mask = emptyMask(camera);
  stampPoints(mask, points[DETAIL], supersample, WEIGHT.detail);
  stampPoints(mask, points[PROJECTION], supersample, WEIGHT.projection);
  stampPoints(mask, points[OUTLINE], supersample, WEIGHT.outline);
  return { layers: [{ mask }], ink: mask };
}

// ---------------------------------------------------------------------------
// Plan: section at CUT_HEIGHT_M, what lies below it in projection, and the
// outline of everything above it dashed.
// ---------------------------------------------------------------------------
function planGeometry(model, soup, camera, superCamera, supersample, ppm) {
  // A hair above the nominal height so faces lying exactly at the cut fall on one side.
  const cut = CUT_HEIGHT_M + 1e-6, W = superCamera.width, H = superCamera.height;
  const facts = triangleFacts(model, soup, superCamera);

  // Section regions, labelled by part, at super-sampled resolution.
  const labels = new Int32Array(W * H).fill(-1), openCuts = [];
  for (const [part, segments] of sectionSegments(soup, cut)) {
    const edges = segments.map(([x0, z0, x1, z1]) => [...projectPoint(superCamera, [x0, cut, z0]).slice(0, 2), ...projectPoint(superCamera, [x1, cut, z1]).slice(0, 2)]);
    if (isClosed(segments)) fillLabels(labels, W, H, edges, part);
    else openCuts.push(...edges.map(([x0, y0, x1, y1]) => [[x0 / supersample, y0 / supersample], [x1 / supersample, y1 / supersample]]));
  }
  const blocked = new Uint8Array(W * H), poche = emptyMask(camera), cutPoints = [];
  const material = i => labels[i] < 0 ? -1 : facts.partMaterial[labels[i]];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (labels[i] >= 0) {
        blocked[i] = 1;
        poche.a[Math.floor(y / supersample) * camera.width + Math.floor(x / supersample)] += 1 / (supersample * supersample);
      }
      if (x + 1 < W && material(i) !== material(i + 1)) cutPoints.push(x + 1, y + 0.5);
      if (y + 1 < H && material(i) !== material(i + W)) cutPoints.push(x + 0.5, y + 1);
    }
  }

  // Below the cut: visible edges in projection, thin, and never inside the section.
  const below = clipSoup(soup, cut, 'below'), belowMask = emptyMask(camera);
  if (below.triangles) {
    const points = rasterEdges(render(below, superCamera), below, triangleFacts(model, below, superCamera), 1 / (ppm * supersample), blocked);
    for (const kind of [DETAIL, PROJECTION]) stampPoints(belowMask, points[kind], supersample, WEIGHT.below, 0.9);
    stampPoints(belowMask, points[OUTLINE], supersample, WEIGHT.below * 1.3, 0.95);
  }

  // Above the cut: the top-view silhouette (roof, overhangs, canopies) as a dashed outline.
  const above = clipSoup(soup, cut, 'above');
  let dashed = [];
  if (above.triangles) {
    const image = render(above, superCamera), inside = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) inside[i] = image.tri[i] >= 0 ? 1 : 0;
    dashed = maskContours(inside, W, H).map(line => line.map(([x, y]) => [x / supersample, y / supersample]));
  }

  const cutMask = emptyMask(camera);
  stampPoints(cutMask, cutPoints, supersample, WEIGHT.cut);
  const ink = maxMasks(emptyMask(camera), belowMask, poche, cutMask);
  // Dashes count as ink for placing dimension witness lines, but only roughly.
  for (const line of dashed) for (const [x, y] of line) {
    const at = Math.floor(y) * camera.width + Math.floor(x);
    if (at >= 0 && at < ink.a.length) ink.a[at] = Math.max(ink.a[at], 0.5);
  }
  for (let i = 0; i < poche.a.length; i++) poche.a[i] = Math.min(1, poche.a[i]);
  return {
    layers: [
      { mask: belowMask },
      { polylines: dashed, width: WEIGHT.dashed, dash: [13, 8] },
      { mask: poche, color: POCHE },
      { mask: cutMask },
      { polylines: openCuts, width: WEIGHT.cut },
    ],
    ink,
  };
}

// Triangle / plane intersections grouped by part: Map(part -> [[x0, z0, x1, z1], ...]).
function sectionSegments(soup, height) {
  const byPart = new Map(), p = soup.positions;
  for (let t = 0; t < soup.triangles; t++) {
    const base = t * 9, side = [0, 1, 2].map(k => p[base + k * 3 + 1] - height > 0);
    if (side[0] === side[1] && side[1] === side[2]) continue;
    const hits = [];
    for (let k = 0; k < 3; k++) {
      const m = (k + 1) % 3;
      if (side[k] === side[m]) continue;
      const a = base + k * 3, b = base + m * 3, s = (height - p[a + 1]) / (p[b + 1] - p[a + 1]);
      hits.push(p[a] + s * (p[b] - p[a]), p[a + 2] + s * (p[b + 2] - p[a + 2]));
    }
    const part = soup.triPart[t];
    if (!byPart.has(part)) byPart.set(part, []);
    byPart.get(part).push(hits);
  }
  return byPart;
}

// A closed solid cuts into closed loops: every segment end is shared by exactly
// two segments. Open shells (a roof made of loose faces) are drawn as lines instead.
function isClosed(segments) {
  const ends = new Map();
  const key = (x, z) => Math.round(x * 1e4) + ',' + Math.round(z * 1e4);
  for (const [x0, z0, x1, z1] of segments) for (const k of [key(x0, z0), key(x1, z1)]) ends.set(k, (ends.get(k) ?? 0) + 1);
  for (const count of ends.values()) if (count % 2) return false;
  return true;
}

function fillLabels(labels, width, height, edges, value) {
  let top = Infinity, bottom = -Infinity;
  for (const [, y0, , y1] of edges) { top = Math.min(top, y0, y1); bottom = Math.max(bottom, y0, y1); }
  for (let y = Math.max(0, Math.floor(top)); y <= Math.min(height - 1, Math.ceil(bottom)); y++) {
    const xs = scanlineCrossings(edges, y + 0.5);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5)), to = Math.min(width - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      for (let x = from; x <= to; x++) labels[y * width + x] = value;
    }
  }
}

// Keeps the part of every triangle below (or above) the plane y = height.
function clipSoup(soup, height, keep) {
  const sign = keep === 'below' ? -1 : 1, p = soup.positions, positions = [], triPart = [];
  for (let t = 0; t < soup.triangles; t++) {
    const corners = [0, 1, 2].map(k => [p[t * 9 + k * 3], p[t * 9 + k * 3 + 1], p[t * 9 + k * 3 + 2]]);
    const inside = corners.map(c => sign * (c[1] - height) >= 0);
    if (!inside.some(Boolean)) continue;
    let polygon = corners;
    if (!inside.every(Boolean)) {
      polygon = [];
      for (let k = 0; k < 3; k++) {
        const a = corners[k], b = corners[(k + 1) % 3], inA = inside[k], inB = inside[(k + 1) % 3];
        if (inA) polygon.push(a);
        if (inA !== inB) { const s = (height - a[1]) / (b[1] - a[1]); polygon.push([a[0] + s * (b[0] - a[0]), height, a[2] + s * (b[2] - a[2])]); }
      }
    }
    for (let k = 1; k + 1 < polygon.length; k++) { positions.push(...polygon[0], ...polygon[k], ...polygon[k + 1]); triPart.push(soup.triPart[t]); }
  }
  const array = Float64Array.from(positions);
  return { positions: array, triPart: Int32Array.from(triPart), colors: new Float32Array(triPart.length * 3), parts: soup.parts,
    triangles: triPart.length, bounds: triPart.length ? soupBounds(array) : soup.bounds };
}

// Marching squares over pixel centres, chained into closed polylines and simplified.
// Outside the image counts as empty, so every contour closes.
function maskContours(inside, width, height) {
  const at = (x, y) => x >= 0 && y >= 0 && x < width && y < height && inside[y * width + x] === 1;
  const stride = width + 2, links = new Map();
  const hId = (x, y) => ((y + 1) * stride + x + 1) * 2, vId = (x, y) => hId(x, y) + 1;
  const link = (a, b) => {
    if (!links.has(a)) links.set(a, []);
    if (!links.has(b)) links.set(b, []);
    links.get(a).push(b); links.get(b).push(a);
  };
  for (let y = -1; y < height; y++) {
    for (let x = -1; x < width; x++) {
      const a = at(x, y), b = at(x + 1, y), c = at(x + 1, y + 1), d = at(x, y + 1);
      if (a === b && b === c && c === d) continue;
      const crossed = [];
      if (a !== b) crossed.push(hId(x, y));
      if (b !== c) crossed.push(vId(x + 1, y));
      if (d !== c) crossed.push(hId(x, y + 1));
      if (a !== d) crossed.push(vId(x, y));
      if (crossed.length === 2) link(crossed[0], crossed[1]);
      else if (a) { link(crossed[0], crossed[3]); link(crossed[2], crossed[1]); }
      else { link(crossed[0], crossed[1]); link(crossed[2], crossed[3]); }
    }
  }
  const point = id => {
    const cell = id >> 1, x = cell % stride - 1, y = Math.floor(cell / stride) - 1;
    return id & 1 ? [x + 0.5, y + 1] : [x + 1, y + 0.5];
  };
  const seen = new Set(), loops = [];
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let previous = -1, current = start;
    while (!seen.has(current)) {
      seen.add(current); loop.push(point(current));
      const next = links.get(current).find(id => id !== previous && !seen.has(id));
      if (next === undefined) break;
      previous = current; current = next;
    }
    if (loop.length > 2) loops.push(simplifyLoop(loop, 0.7));
  }
  return loops;
}

function simplifyLoop(points, epsilon) {
  // Split the loop at its two mutually far points and simplify both halves.
  let far = 0, best = -1;
  for (let i = 1; i < points.length; i++) {
    const d = (points[i][0] - points[0][0]) ** 2 + (points[i][1] - points[0][1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const first = simplifyChain(points.slice(0, far + 1), epsilon), second = simplifyChain([...points.slice(far), points[0]], epsilon);
  return [...first, ...second.slice(1)];
}

// Ramer-Douglas-Peucker, iterative so long contours cannot overflow the stack.
function simplifyChain(points, epsilon) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length), stack = [[0, points.length - 1]];
  keep[0] = keep[points.length - 1] = 1;
  while (stack.length) {
    const [from, to] = stack.pop(), [ax, ay] = points[from], [bx, by] = points[to];
    const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
    let worst = -1, index = -1;
    for (let i = from + 1; i < to; i++) {
      const [px, py] = points[i];
      const d = length > 0 ? Math.abs(dy * (px - ax) - dx * (py - ay)) / length : Math.hypot(px - ax, py - ay);
      if (d > worst) { worst = d; index = i; }
    }
    if (worst > epsilon) { keep[index] = 1; stack.push([from, index], [index, to]); }
  }
  return points.filter((_, i) => keep[i]);
}

// ---------------------------------------------------------------------------
// Dimension strings
// ---------------------------------------------------------------------------
const isOverall = d => /overall|total/i.test(d.id + ' ' + d.label);

export function selectDimensions(model, view) {
  return (model.dimensions ?? []).filter(d => d.view === view)
    .map((d, order) => ({ d, order }))
    .sort((p, q) => (isOverall(q.d) - isOverall(p.d)) || (q.d.value_m - p.d.value_m) || (p.order - q.order))
    .slice(0, MAX_DIMENSIONS).map(entry => entry.d);
}

function inkAlong(mask, [x0, y0], [x1, y1]) {
  if (!mask) return 0;
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  let sum = 0;
  for (let k = 0; k <= steps; k++) {
    const x = Math.floor(x0 + (x1 - x0) * k / steps), y = Math.floor(y0 + (y1 - y0) * k / steps);
    if (x >= 0 && y >= 0 && x < mask.width && y < mask.height) sum += mask.a[y * mask.width + x];
  }
  return sum;
}

function placeDimensions(model, spec, camera, box, ppm, ink) {
  const placed = [], skipped = [], bySide = { top: [], bottom: [], left: [], right: [], aligned: [] };
  for (const d of selectDimensions(model, spec.dimensionView)) {
    let a = projectPoint(camera, d.a).slice(0, 2), b = projectPoint(camera, d.b).slice(0, 2);
    const span = Math.hypot(b[0] - a[0], b[1] - a[1]), drawn = span / ppm;
    // The string has to agree with the scale bar; a dimension not parallel to this sheet cannot.
    if (Math.abs(drawn - d.value_m) > Math.max(0.01, 0.005 * d.value_m)) {
      skipped.push({ id: d.id, reason: 'spans ' + drawn.toFixed(3) + ' m on this sheet, not ' + d.value_m + ' m' });
      continue;
    }
    const horizontal = Math.abs(b[1] - a[1]) <= 0.01 * span, vertical = Math.abs(b[0] - a[0]) <= 0.01 * span;
    if (horizontal && a[0] > b[0]) [a, b] = [b, a];
    if (vertical && a[1] < b[1]) [a, b] = [b, a];
    const cost = side => {
      const reach = { bottom: [0, box.y1 + 1], top: [0, box.y0 - 1], left: [box.x0 - 1, 0], right: [box.x1 + 1, 0] }[side];
      return [a, b].reduce((sum, p) => {
        const end = side === 'top' || side === 'bottom' ? [p[0], reach[1]] : [reach[0], p[1]];
        const direction = Math.sign((end[0] - p[0]) + (end[1] - p[1])), start = side === 'top' || side === 'bottom' ? [p[0], p[1] + direction * EXTENSION_GAP] : [p[0] + direction * EXTENSION_GAP, p[1]];
        return sum + inkAlong(ink, start, end) + 0.002 * Math.hypot(end[0] - p[0], end[1] - p[1]);
      }, 0);
    };
    // A small charge per string already on a side breaks ties towards a balanced sheet.
    const entry = { d, a, b, span }, charge = side => cost(side) + 3 * bySide[side].length;
    if (horizontal) bySide[charge('bottom') <= charge('top') ? 'bottom' : 'top'].push(entry);
    else if (vertical) bySide[charge('left') <= charge('right') ? 'left' : 'right'].push(entry);
    else bySide.aligned.push(entry);
  }
  for (const [side, entries] of Object.entries(bySide)) {
    // Shorter strings sit nearer the drawing, overall dimensions outermost.
    entries.sort((p, q) => p.span - q.span);
    let tier = 0;
    for (const entry of entries) {
      const graphics = dimensionGraphics(entry, side, tier, box);
      if (side === 'aligned' && ink && obliqueClutter(ink, graphics) > 2) {
        skipped.push({ id: entry.d.id, reason: 'oblique, and no clear space beside it' });
        continue;
      }
      placed.push(graphics); tier++;
    }
  }
  return { placed, skipped };
}

// Geometry ink an oblique string would sit on: its line, its witness lines beyond the
// gap, and the paper under its number.
function obliqueClutter(ink, graphics) {
  let sum = inkAlong(ink, ...graphics.line);
  for (const [p, q] of graphics.extensions) sum += inkAlong(ink, p, q);
  const box = graphics.textBox;
  for (let y = Math.floor(box.y0); y <= box.y1; y += 2) sum += inkAlong(ink, [box.x0, y], [box.x1, y]) * 2;
  return sum;
}

function dimensionGraphics({ d, a, b, span }, side, tier, box) {
  const text = d.value_m.toFixed(2) + ' m', textWidth = measureText(text, TEXT.dimension);
  let u, normal, offset;
  if (side === 'aligned') {
    u = [(b[0] - a[0]) / span, (b[1] - a[1]) / span];
    normal = [u[1], -u[0]];
    const middle = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], centre = [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2];
    if ((middle[0] - centre[0]) * normal[0] + (middle[1] - centre[1]) * normal[1] < 0) normal = [-normal[0], -normal[1]];
    // Oblique strings stay next to their own line; placeDimensions drops them when that space is not clear.
    offset = FIRST_TIER + tier * TIER_STEP;
  } else {
    const distance = FIRST_TIER + tier * TIER_STEP;
    u = { top: [1, 0], bottom: [1, 0], left: [0, -1], right: [0, -1] }[side];
    normal = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }[side];
    // Distance of the string from point a, measured along the outward normal.
    offset = { top: a[1] - (box.y0 - distance), bottom: box.y1 + distance - a[1], left: a[0] - (box.x0 - distance), right: box.x1 + distance - a[0] }[side];
  }
  const along = (p, k) => [p[0] + normal[0] * k, p[1] + normal[1] * k];
  // Both ends sit on one line parallel to a-b.
  const offsetB = offset + ((a[0] - b[0]) * normal[0] + (a[1] - b[1]) * normal[1]);
  const endA = along(a, offset), endB = along(b, offsetB);
  const extensions = [[along(a, EXTENSION_GAP), along(a, offset + EXTENSION_OVERSHOOT)], [along(b, EXTENSION_GAP), along(b, offsetB + EXTENSION_OVERSHOOT)]];
  if (offset < EXTENSION_GAP + 1) extensions[0] = [endA, along(a, offset + EXTENSION_OVERSHOOT)];
  if (offsetB < EXTENSION_GAP + 1) extensions[1] = [endB, along(b, offsetB + EXTENSION_OVERSHOOT)];
  const line = [[endA[0] - u[0] * 10, endA[1] - u[1] * 10], [endB[0] + u[0] * 10, endB[1] + u[1] * 10]];
  // Oblique ticks, 45 degrees to the dimension line.
  const slash = [(u[0] + u[1]) * Math.SQRT1_2 * 8, (u[1] - u[0]) * Math.SQRT1_2 * 8];
  const ticks = [endA, endB].map(p => [[p[0] - slash[0], p[1] - slash[1]], [p[0] + slash[0], p[1] + slash[1]]]);
  // Text reads along the line, on the side away from the drawing (horizontal: above).
  let angle = Math.atan2(-u[1], u[0]) / DEG;
  if (angle > 90.5) angle -= 180;
  if (angle <= -89.5) angle += 180;
  // Unit vectors along the text baseline and towards the top of its letters.
  const readable = [Math.cos(angle * DEG), -Math.sin(angle * DEG)], textUp = [-Math.sin(angle * DEG), -Math.cos(angle * DEG)];
  const middle = [(endA[0] + endB[0]) / 2, (endA[1] + endB[1]) / 2];
  let textAnchor, textAlign = 'center', textBaseline = 'alphabetic';
  if (textWidth + 28 <= span) textAnchor = [middle[0] + textUp[0] * 8, middle[1] + textUp[1] * 8];
  else {
    // Too short to hold its own number: write it past the far end.
    const far = readable[0] * (endB[0] - endA[0]) + readable[1] * (endB[1] - endA[1]) >= 0 ? endB : endA;
    textAnchor = [far[0] + readable[0] * 18, far[1] + readable[1] * 18];
    textAlign = 'left'; textBaseline = 'middle';
  }
  // Digits have no descenders: the cap-to-baseline box is what gets knocked out, so
  // the paper behind the number is cleared without cutting the dimension line.
  const textBox = layoutText(text, { x: textAnchor[0], y: textAnchor[1], size: TEXT.dimension, angleDeg: angle, align: textAlign, baseline: textBaseline }).capBox;
  return { id: d.id, value_m: d.value_m, text, side, orientation: side === 'aligned' ? 'aligned' : side === 'top' || side === 'bottom' ? 'horizontal' : 'vertical',
    a, b, ends: [endA, endB], line, extensions, ticks, textAnchor, textAngle: angle, textAlign, textBaseline, textBox };
}

// ---------------------------------------------------------------------------
// Title block and scale bar
// ---------------------------------------------------------------------------
const SCALE_LENGTHS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200];
const scaleSegment = metres => metres <= 6 ? 1 : metres <= 12 ? 2 : metres <= 30 ? 5 : metres <= 60 ? 10 : metres <= 100 ? 20 : 50;
const NOTE_SCALE = 'DO NOT SCALE FROM PRINT - USE THE SCALE BAR';

function fitSize(text, size, maxWidth, minSize = 19) {
  while (size > minSize && measureText(text, size) > maxWidth) size -= 1;
  return size;
}

function wrapWords(text, size, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line ? line + ' ' + word : word;
    if (line && measureText(candidate, size) > maxWidth) { lines.push(line); line = word; } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

// The title block in two arrangements with the same content: a band along the
// bottom of the sheet, or a strip down its right-hand side for tall drawings.
const STRIP_WIDTH = 470;
function titleBlock({ model, spec, capturedAt, ppm }) {
  const title = model.title.toUpperCase(), date = 'DATE ' + capturedAt, number = 'SHEET ' + spec.number + ' OF ' + SHEETS.length;
  const inner = 22, gap = 60;
  const titleSize = fitSize(title, TEXT.title, 1100);
  const scaleMetres = room => [...SCALE_LENGTHS].reverse().find(m => m * ppm <= room && scaleSegment(m) * ppm >= 40) ?? SCALE_LENGTHS[0];
  const minScale = Math.min(...SCALE_LENGTHS.filter(m => m * ppm >= 260), 200) * ppm;
  const minWidth = 2 * inner + Math.max(
    measureText(title, titleSize) + gap + measureText(date, TEXT.label),
    measureText(spec.name, TEXT.sheet) + gap + measureText(number, TEXT.label),
    minScale + 60 + gap + measureText(NOTE_SCALE, TEXT.note), 900);
  const writeLines = (canvas, lines, x, y, size, step, weight = 1) => {
    for (const [k, line] of lines.entries()) canvas.text(line, x, y + step / 2 + k * step, { size, baseline: 'middle', weight });
  };
  return {
    minWidth, stripWidth: STRIP_WIDTH,
    band(width) {
      const noteLines = wrapWords(spec.note, TEXT.note, width - 2 * inner);
      const rows = [58, 60, 84, 16 + noteLines.length * 32];
      const metres = scaleMetres(Math.min(width - 2 * inner - gap - measureText(NOTE_SCALE, TEXT.note) - 60, 640));
      return {
        height: rows.reduce((sum, h) => sum + h, 0),
        draw(canvas, x0, y0) {
          const x1 = x0 + width;
          let y = y0;
          canvas.line(x0, y, x1, y, { width: WEIGHT.border * 0.8 });
          canvas.text(title, x0 + inner, y + rows[0] / 2, { size: titleSize, baseline: 'middle' });
          canvas.text(date, x1 - inner, y + rows[0] / 2, { size: TEXT.label, baseline: 'middle', align: 'right' });
          y += rows[0];
          canvas.line(x0, y, x1, y, { width: WEIGHT.rule });
          canvas.text(spec.name, x0 + inner, y + rows[1] / 2, { size: TEXT.sheet, baseline: 'middle', weight: 1.3 });
          canvas.text(number, x1 - inner, y + rows[1] / 2, { size: TEXT.label, baseline: 'middle', align: 'right' });
          y += rows[1];
          canvas.line(x0, y, x1, y, { width: WEIGHT.rule });
          const bar = drawScaleBar(canvas, x0 + inner + 4, y + rows[2] - 26, metres, ppm);
          canvas.text(NOTE_SCALE, x1 - inner, y + rows[2] / 2 + 2, { size: TEXT.note, baseline: 'middle', align: 'right' });
          y += rows[2];
          canvas.line(x0, y, x1, y, { width: WEIGHT.rule });
          writeLines(canvas, noteLines, x0 + inner, y + 10, TEXT.note, 32);
          return bar;
        },
      };
    },
    strip() {
      const textWidth = STRIP_WIDTH - 2 * inner;
      const titleLines = wrapWords(title, TEXT.title, textWidth), nameLines = wrapWords(spec.name, TEXT.sheet, textWidth);
      const scaleLines = wrapWords(NOTE_SCALE, TEXT.note, textWidth), noteLines = wrapWords(spec.note, TEXT.note, textWidth);
      const metres = scaleMetres(textWidth - 50);
      // Each row: height and how to fill it, stacked at the bottom of the strip.
      const rows = [
        [18 + titleLines.length * 36, (canvas, x, y) => writeLines(canvas, titleLines, x, y + 9, fitSize(title, TEXT.title, textWidth), 36)],
        [48, (canvas, x, y, h) => canvas.text(date, x, y + h / 2, { size: TEXT.label, baseline: 'middle' })],
        [18 + nameLines.length * 42, (canvas, x, y) => writeLines(canvas, nameLines, x, y + 9, TEXT.sheet, 42, 1.3)],
        [48, (canvas, x, y, h) => canvas.text(number, x, y + h / 2, { size: TEXT.label, baseline: 'middle' })],
        [84, (canvas, x, y, h) => drawScaleBar(canvas, x + 4, y + h - 26, metres, ppm)],
        [16 + scaleLines.length * 30, (canvas, x, y) => writeLines(canvas, scaleLines, x, y + 8, TEXT.note, 30)],
        [16 + noteLines.length * 30, (canvas, x, y) => writeLines(canvas, noteLines, x, y + 8, TEXT.note, 30)],
      ];
      const height = rows.reduce((sum, [h]) => sum + h, 0);
      return {
        height,
        draw(canvas, x0, y0, y1) {
          const x1 = x0 + STRIP_WIDTH;
          canvas.line(x0, y0, x0, y1, { width: WEIGHT.border * 0.8 });
          let y = y1 - height, bar = null;
          canvas.line(x0, y, x1, y, { width: WEIGHT.border * 0.8 });
          for (const [index, [h, fill]] of rows.entries()) {
            if (index) canvas.line(x0, y, x1, y, { width: WEIGHT.rule });
            bar = fill(canvas, x0 + inner, y, h) ?? bar;
            y += h;
          }
          return bar;
        },
      };
    },
  };
}

// Alternating blocks with numbered ticks; the bar spans exactly metres * ppm pixels
// (its outline is drawn inside that span so the dark extent is the true length).
function drawScaleBar(canvas, x0, yMiddle, metres, ppm) {
  const segment = scaleSegment(metres), count = Math.round(metres / segment), length = metres * ppm, half = 6;
  const x1 = x0 + length, top = yMiddle - half, bottom = yMiddle + half, inset = WEIGHT.rule / 2;
  for (let k = 0; k < count; k += 2) canvas.rect(x0 + k * segment * ppm, top, x0 + Math.min(k + 1, count) * segment * ppm, bottom);
  canvas.stroke([[[x0 + inset, top + inset], [x1 - inset, top + inset], [x1 - inset, bottom - inset], [x0 + inset, bottom - inset], [x0 + inset, top + inset]]], { width: WEIGHT.rule });
  const ticks = [];
  for (let k = 0; k <= count; k++) {
    const x = Math.min(x1 - inset, Math.max(x0 + inset, x0 + k * segment * ppm));
    ticks.push([[x, top - 7], [x, top]]);
    canvas.text(String(k * segment), x0 + k * segment * ppm, top - 12, { size: TEXT.scale, align: 'center' });
  }
  canvas.stroke(ticks, { width: WEIGHT.rule });
  canvas.text('m', x1 + 20, yMiddle, { size: TEXT.scale, baseline: 'middle' });
  return { x0, x1, y: yMiddle, metres, segment, ppm };
}

// ---------------------------------------------------------------------------
// Paper: a scanned print rather than a perfect render.
// ---------------------------------------------------------------------------
const PAPER_TINTS = [[248, 246, 238], [246, 244, 237], [250, 247, 239], [244, 243, 238], [247, 245, 241]];

function finishPaper(canvas, random, { rotationDeg, noise } = {}) {
  const tintBase = random.pick(PAPER_TINTS), tint = tintBase.map(v => Math.min(255, v + random.int(-2, 2)));
  const angle = rotationDeg ?? Math.round(random.range(-0.4, 0.4) * 1000) / 1000;
  const grain = noise ?? 2.6;
  const rotated = canvas.rotated(angle);
  const { width, height } = canvas, rgb = new Uint8Array(width * height * 3);
  // Low-frequency unevenness of the scan: a 4 x 4 grid of brightness offsets.
  const field = Array.from({ length: 16 }, () => grain ? random.range(-1.6, 1.6) : 0);
  const sampleField = (x, y) => {
    const gx = x / width * 3, gy = y / height * 3, ix = Math.min(2, Math.floor(gx)), iy = Math.min(2, Math.floor(gy)), fx = gx - ix, fy = gy - iy;
    const f = (i, j) => field[j * 4 + i];
    return (f(ix, iy) * (1 - fx) + f(ix + 1, iy) * fx) * (1 - fy) + (f(ix, iy + 1) * (1 - fx) + f(ix + 1, iy + 1) * fx) * fy;
  };
  const noiseStream = random.fork('grain');
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x, offset = sampleField(x, y) + (grain ? (noiseStream.next() + noiseStream.next() - 1) * grain : 0);
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.max(0, Math.min(255, Math.round(rotated.rgb[i * 3 + c] * tint[c] / 255 + offset)));
    }
  }
  return { rgb, rotationDeg: angle, png: encodePNG(width, height, rgb, 3) };
}
