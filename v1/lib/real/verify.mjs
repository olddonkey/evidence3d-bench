// Verifies a hand-authored truth model against the drawing sheets it was read
// from: renders the truth orthographically in each sheet's own view, registers
// the render on the sheet, draws the truth's edges over the sheet, and measures
// how far the main lines of the truth lie from the lines drawn on the sheet.
//
// Registration. A drawing is axis-aligned and uniformly scaled, so the map from
// the view's model coordinates (u to the sheet's right, v up the sheet, metres)
// to sheet pixels is px = a + s·u, py = b - s·v. The three unknowns come from
// anchors read off the sheet: a row anchor says "model height v is drawn at
// sheet row py" (an elevation datum such as T/SLAB or +20'-6"), a column anchor
// says "model position u is at sheet column px" (a building end), and a scale
// anchor says "d metres span Δ pixels" (a scale bar, a printed dimension, or the
// printed drawing scale at the render's resolution). Two known dimensions fix
// s; one end fixes the offset; a weighted least-squares fit uses all the anchors
// given and reports how well they agree with each other. An anchor marked
// `exact` (weight 1e6) is held: a printed scale is better than the fit of a few
// datum leaders drawn to the nearest pixel, which over a 50 m facade moves the
// far end by 0.2 m for a 0.5 % scale error.
//
// Residuals. For each named line the truth's edge is found in its render and the
// sheet's ink line in the sheet, both by the same 1-D search around the expected
// position over a span of the line, so neither number is typed in by hand.
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, extname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { orthoCamera, render, cross } from '../raster.mjs';
import { decodePNG, encodePNG } from '../png.mjs';
import { soupFromModel } from '../soup.mjs';

const run = promisify(execFile);

// View bases: `right` is the sheet's +x direction in model space, `up` its -y.
// The elevations follow raster.mjs's named views; plans are drawn with north
// (-Z) to the left and east (+X) up the sheet unless a sheet says otherwise.
export const VIEWS = {
  front: { right: [1, 0, 0], up: [0, 1, 0] },
  rear: { right: [-1, 0, 0], up: [0, 1, 0] },
  right: { right: [0, 0, -1], up: [0, 1, 0] },
  left: { right: [0, 0, 1], up: [0, 1, 0] },
  'plan-north-left': { right: [0, 0, 1], up: [1, 0, 0] },
  'plan-north-up': { right: [1, 0, 0], up: [0, 0, -1] },
};

// anchors: [{ type: 'row', v, py } | { type: 'col', u, px } | { type: 'scale', metres, pixels }]
// -> { s, a, b, anchors: [...with residual_px] }. Needs a scale (two rows, or a
// scale anchor), a row and a column.
export function solveRegistration(anchors) {
  const rows = [], rhs = [];
  for (const anchor of anchors) {
    if (anchor.type === 'col') { rows.push([1, 0, anchor.u]); rhs.push(anchor.px); }
    else if (anchor.type === 'row') { rows.push([0, 1, -anchor.v]); rhs.push(anchor.py); }
    else if (anchor.type === 'scale') { rows.push([0, 0, anchor.metres]); rhs.push(anchor.pixels); }
    else throw new Error('Unknown anchor type ' + anchor.type);
  }
  if (!anchors.some(x => x.type === 'col') || !anchors.some(x => x.type === 'row')) throw new Error('Registration needs a row and a column anchor');
  if (anchors.filter(x => x.type === 'row').length < 2 && !anchors.some(x => x.type === 'scale') && anchors.filter(x => x.type === 'col').length < 2) {
    throw new Error('Registration needs two known dimensions to fix the scale');
  }
  // Normal equations of the 3x3 least-squares problem.
  const ata = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], atb = [0, 0, 0];
  const weights = anchors.map(anchor => anchor.exact ? 1e6 : anchor.weight ?? 1);
  rows.forEach((r, k) => { for (let i = 0; i < 3; i++) { atb[i] += weights[k] * r[i] * rhs[k]; for (let j = 0; j < 3; j++) ata[i][j] += weights[k] * r[i] * r[j]; } });
  const [a, b, s] = solve3(ata, atb);
  if (!(s > 0)) throw new Error('Registration gives a non-positive scale');
  return { s, a, b, anchors: anchors.map((anchor, k) => ({ ...anchor, residual_px: rows[k][0] * a + rows[k][1] * b + rows[k][2] * s - rhs[k] })) };
}

function solve3(m, y) {
  const a = m.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) throw new Error('Registration anchors do not determine the transform');
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < 3; r++) if (r !== c) { const f = a[r][c] / a[c][c]; for (let k = c; k < 4; k++) a[r][k] -= f * a[c][k]; }
  }
  return [0, 1, 2].map(i => a[i][3] / a[i][i]);
}

export const toSheet = (reg, u, v) => [reg.a + reg.s * u, reg.b - reg.s * v];
export const toModel = (reg, px, py) => [(px - reg.a) / reg.s, (reg.b - py) / reg.s];

// Orthographic camera whose pixel grid is exactly the sheet crop's pixel grid.
export function sheetCamera(view, reg, crop, depthOrigin = 60) {
  const basis = VIEWS[view];
  if (!basis) throw new Error('Unknown view ' + view);
  const forward = cross(basis.up, basis.right), origin = forward.map(f => -f * depthOrigin);
  const [u0, v1] = toModel(reg, crop.x, crop.y), [u1, v0] = toModel(reg, crop.x + crop.width, crop.y + crop.height);
  return orthoCamera({ origin, right: basis.right, up: basis.up, extent: [u0, u1, v0, v1], width: crop.width, height: crop.height });
}

// Edge pixels of a render: a change of part, a step in depth or a jump between
// object and background. The mark goes on the pixel before the boundary, so a
// boundary between pixels k and k+1 lies at continuous coordinate k + 1.
// Two parts of one material meeting in one plane (a wall stacked on a wall) are
// not an edge: the drawing has no line there.
export function edgeMasks(image, soup, depthStep = 0.04) {
  const { width, height, depth, tri } = image;
  const part = t => t < 0 ? -1 : soup.triPart[t];
  const sameColour = (s, t) => [0, 1, 2].every(k => Math.abs(soup.colors[3 * s + k] - soup.colors[3 * t + k]) < 1e-6);
  const differs = (i, j) => {
    const pi = part(tri[i]), pj = part(tri[j]);
    if (pi < 0 || pj < 0) return pi !== pj;
    if (Math.abs(depth[i] - depth[j]) > depthStep) return true;
    if (pi === pj) return false;
    return !(Math.abs(depth[i] - depth[j]) < 0.005 && sameColour(tri[i], tri[j]));
  };
  const rows = new Uint8Array(width * height), cols = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (y + 1 < height && differs(i, i + width)) rows[i] = 1;
    if (x + 1 < width && differs(i, i + 1)) cols[i] = 1;
  }
  return { rows, cols, width, height };
}

// Strongest line near an expected position. axis 'h' looks for a row (a
// horizontal line), 'v' for a column. `weight(x, y)` is 1 for ink / edge.
// Returns the continuous coordinate of the line and the share of the span it
// covers, or null when nothing covers at least `minFraction` of it.
export function findLine(weight, { axis, at, span, search, minFraction = 0.5, edge = false }) {
  const [s0, s1] = [Math.round(Math.min(...span)), Math.round(Math.max(...span))];
  const lo = Math.floor(at - search), hi = Math.ceil(at + search);
  let best = -1;
  const fractions = new Map();
  for (let k = lo; k <= hi; k++) {
    let n = 0;
    for (let t = s0; t < s1; t++) n += axis === 'h' ? weight(t, k) : weight(k, t);
    const f = n / Math.max(1, s1 - s0);
    fractions.set(k, f);
    if (f > best) best = f;
  }
  if (best < minFraction) return null;
  // Lines are drawn 1-4 px thick: take the centroid of the run around the best
  // row whose coverage stays near the best, nearest to the expected position.
  const strong = [...fractions].filter(([, f]) => f >= 0.8 * best).map(([k]) => k);
  const runs = [];
  for (const k of strong) { const last = runs.at(-1); if (last && k === last.at(-1) + 1) last.push(k); else runs.push([k]); }
  const centre = run => run.reduce((sum, k) => sum + k, 0) / run.length + (edge ? 1 : 0.5);
  const chosen = runs.sort((p, q) => Math.abs(centre(p) - at) - Math.abs(centre(q) - at))[0];
  return { position: centre(chosen), fraction: Math.max(...chosen.map(k => fractions.get(k))) };
}

// Sheet image (decoded PNG) -> ink test.
export function inkTest(image, threshold = 128) {
  const { width, channels, pixels } = image;
  return (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= image.height) return 0;
    const i = (y * width + x) * channels;
    const grey = channels >= 3 ? (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3 : pixels[i];
    return grey < threshold ? 1 : 0;
  };
}

// One sheet: registration, render, overlay and line residuals.
// spec = { id, file, view, anchors, crop: { x, y, width, height },
//   lines: [{ id, label, axis, at (m), span: [m, m], search_m, sheet_at, min_ink, min_truth }] }
export function verifySheet({ sheet, spec, soup }) {
  const reg = solveRegistration(spec.anchors);
  const crop = spec.crop, camera = sheetCamera(spec.view, reg, crop);
  const image = render(soup, camera), edges = edgeMasks(image, soup);
  const ink = inkTest(sheet);
  const sheetWeight = (x, y) => ink(x + crop.x, y + crop.y);
  const edgeWeight = axis => (x, y) => x >= 0 && y >= 0 && x < edges.width && y < edges.height ? (axis === 'h' ? edges.rows : edges.cols)[y * edges.width + x] : 0;
  const residuals = [];
  for (const line of spec.lines) {
    const horizontal = line.axis === 'h';
    // Expected position and span in crop pixels.
    // Where the truth deliberately departs from this sheet, `sheet_at` centres the
    // search for the sheet's line on where the sheet draws it.
    const toCrop = m => horizontal ? reg.b - reg.s * m - crop.y : reg.a + reg.s * m - crop.x;
    const at = toCrop(line.at), sheetAt = toCrop(line.sheet_at ?? line.at);
    const span = line.span.map(m => horizontal ? reg.a + reg.s * m - crop.x : reg.b - reg.s * m - crop.y);
    const search = reg.s * (line.search_m ?? 0.3);
    const truth = findLine(edgeWeight(line.axis), { axis: line.axis, at, span, search, minFraction: line.min_truth ?? 0.5, edge: true });
    const drawn = findLine(sheetWeight, { axis: line.axis, at: sheetAt, span, search, minFraction: line.min_ink ?? 0.4 });
    const metres = p => p === null ? null : horizontal ? (reg.b - (p + crop.y)) / reg.s : (p + crop.x - reg.a) / reg.s;
    const truthM = truth ? metres(truth.position) : null, sheetM = drawn ? metres(drawn.position) : null;
    residuals.push({
      id: line.id, label: line.label, axis: line.axis,
      truth_m: round(truthM), sheet_m: round(sheetM),
      residual_m: truthM !== null && sheetM !== null ? round(truthM - sheetM) : null,
      found: { truth: !!truth, sheet: !!drawn }, ink_fraction: drawn ? round(drawn.fraction) : null,
      truth_px: truth ? round(truth.position + (horizontal ? crop.y : crop.x)) : null,
      sheet_px: drawn ? round(drawn.position + (horizontal ? crop.y : crop.x)) : null,
    });
  }
  return { id: spec.id, view: spec.view, registration: { s_px_per_m: round(reg.s, 3), s_px_per_ft: round(reg.s * 0.3048, 3), a: round(reg.a, 2), b: round(reg.b, 2),
    anchors: reg.anchors.map(anchor => ({ ...anchor, residual_px: round(anchor.residual_px, 2) })) }, residuals, overlay: overlayImage(sheet, crop, edges, residuals, reg, spec) };
}

const round = (value, digits = 3) => value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits;

// The sheet crop washed out to light grey, the truth's edges in red, and for each
// residual line a short blue tick where the sheet's line was found.
export function overlayImage(sheet, crop, edges, residuals, reg, spec) {
  const { width, height } = crop, out = new Uint8Array(width * height * 3), ink = inkTest(sheet, 200);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 3, i = ((y + crop.y) * sheet.width + x + crop.x) * sheet.channels;
    const grey = sheet.channels >= 3 ? (sheet.pixels[i] + sheet.pixels[i + 1] + sheet.pixels[i + 2]) / 3 : sheet.pixels[i];
    const v = ink(x + crop.x, y + crop.y) ? 140 + grey * 0.3 : 235 + grey * 0.08;
    out[o] = out[o + 1] = out[o + 2] = Math.min(255, v);
  }
  const paint = (x, y, rgb) => { if (x >= 0 && y >= 0 && x < width && y < height) out.set(rgb, (y * width + x) * 3); };
  // Edges two pixels wide (both sides of the boundary) so they survive downscaling.
  for (let i = 0; i < width * height; i++) {
    const x = i % width, y = Math.floor(i / width);
    if (edges.rows[i]) { paint(x, y, [220, 30, 30]); paint(x, y + 1, [220, 30, 30]); }
    if (edges.cols[i]) { paint(x, y, [220, 30, 30]); paint(x + 1, y, [220, 30, 30]); }
  }
  for (const r of residuals) {
    if (r.sheet_px === null) continue;
    const line = spec.lines.find(l => l.id === r.id), horizontal = r.axis === 'h';
    const mid = line.span.reduce((sum, m) => sum + m, 0) / line.span.length;
    const c = horizontal ? reg.a + reg.s * mid - crop.x : reg.b - reg.s * mid - crop.y;
    for (let d = -14; d <= 14; d++) for (let w = -1; w <= 1; w++) {
      if (horizontal) paint(Math.round(c + d), Math.floor(r.sheet_px - crop.y) + w, [20, 90, 230]);
      else paint(Math.floor(r.sheet_px - crop.x) + w, Math.round(c + d), [20, 90, 230]);
    }
  }
  return encodePNG(width, height, out, 3);
}

// A sheet file as a decoded image. JPEG renders are converted with macOS `sips`
// (Node has no JPEG decoder and the repository takes no dependencies).
export async function loadSheet(file) {
  const ext = extname(file).toLowerCase();
  if (ext === '.png') return decodePNG(await readFile(file));
  if (ext !== '.jpg' && ext !== '.jpeg') throw new Error('Sheet must be PNG or JPEG: ' + file);
  const work = await mkdtemp(join(tmpdir(), 'e3d-sheet-'));
  try {
    const png = join(work, basename(file, extname(file)) + '.png');
    try { await run('sips', ['-s', 'format', 'png', file, '--out', png]); }
    catch (error) { throw new Error('Converting ' + file + ' needs macOS sips (or pass a PNG): ' + error.message); }
    return decodePNG(await readFile(png));
  } finally { await rm(work, { recursive: true, force: true }); }
}

// Every sheet of an authoring directory's sheets.mjs: overlays and residuals.
export async function verifySheets({ model, sheets, sheetsRoot, outDir, log = () => {} }) {
  const soup = soupFromModel(model);
  await mkdir(outDir, { recursive: true });
  const results = [];
  for (const spec of sheets) {
    log('verifying ' + spec.id);
    const sheet = await loadSheet(join(sheetsRoot, spec.file));
    const result = verifySheet({ sheet, spec, soup });
    await writeFile(join(outDir, spec.id + '.png'), result.overlay);
    const { overlay, ...rest } = result;
    results.push({ ...rest, file: spec.file, overlay: spec.id + '.png' });
  }
  const all = results.flatMap(r => r.residuals.filter(x => x.residual_m !== null).map(x => Math.abs(x.residual_m)));
  const summary = { sheets: results.length, lines: results.reduce((n, r) => n + r.residuals.length, 0), measured: all.length,
    not_found: results.flatMap(r => r.residuals.filter(x => x.residual_m === null).map(x => r.id + '/' + x.id)),
    max_abs_residual_m: all.length ? round(Math.max(...all)) : null, median_abs_residual_m: all.length ? round(all.sort((p, q) => p - q)[Math.floor(all.length / 2)]) : null };
  await writeFile(join(outDir, 'residuals.json'), JSON.stringify({ summary, sheets: results }, null, 2) + '\n');
  return { summary, sheets: results };
}
