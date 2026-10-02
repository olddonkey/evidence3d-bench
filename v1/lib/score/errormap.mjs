import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePNG } from '../png.mjs';
import { orthoViewOfBounds, render } from '../raster.mjs';
import { cropToCamera, triangleNormals } from './sampling.mjs';
import { coverageMask } from './coverage.mjs';

// Error maps: per view, the ground truth coloured by its distance to the
// aligned candidate (what the model misses: recall) next to the aligned
// candidate coloured by its distance to the ground truth (what the model adds
// or misplaces: precision). Grey hatching marks surfaces that do not count:
// truth the evidence never showed, candidate surface nearest such truth (unless
// the evidence shows its place to be empty).
export const ERROR_VIEWS = ['front', 'right', 'rear', 'top'];
const PANEL = 440, GAP = 16, HEADER = 34, FOOTER = 58;
const BACKGROUND = [250, 250, 248], INK = [40, 40, 44], MUTED = [196, 196, 200];

// 5x7 glyphs, rows top to bottom, bit 4 = leftmost column.
const GLYPHS = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31], M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17], Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14], 2: [14, 17, 1, 2, 4, 8, 31], 3: [30, 1, 1, 14, 1, 1, 30],
  4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 30, 1, 1, 17, 14], 6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8],
  8: [14, 17, 17, 14, 17, 17, 14], 9: [14, 17, 17, 15, 1, 2, 12], '%': [24, 25, 2, 4, 8, 19, 3], ':': [0, 12, 12, 0, 12, 12, 0],
  '.': [0, 0, 0, 0, 0, 12, 12], '-': [0, 0, 0, 31, 0, 0, 0], '=': [0, 0, 31, 0, 31, 0, 0], '@': [14, 17, 23, 21, 23, 16, 14], ' ': [0, 0, 0, 0, 0, 0, 0],
};

function text(image, x, y, string, { size = 2, color = INK } = {}) {
  for (const character of String(string).toUpperCase()) {
    const glyph = GLYPHS[character] ?? GLYPHS[' '];
    for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) {
      if (!(glyph[row] >> (4 - col) & 1)) continue;
      for (let a = 0; a < size; a++) for (let b = 0; b < size; b++) put(image, x + col * size + b, y + row * size + a, color);
    }
    x += 6 * size;
  }
  return x;
}

function put(image, x, y, color) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const at = 3 * (y * image.width + x);
  image.pixels[at] = color[0]; image.pixels[at + 1] = color[1]; image.pixels[at + 2] = color[2];
}

// Distance (as a fraction of the diagonal) -> colour. Green is inside the 1 %
// threshold, yellow at the 2 % headline threshold, red at 5 % and beyond.
const STOPS = [[0, [26, 120, 60]], [0.01, [140, 205, 120]], [0.02, [250, 220, 110]], [0.05, [214, 50, 40]], [0.08, [120, 0, 30]]];
export function errorColour(fraction) {
  if (!(fraction < STOPS[STOPS.length - 1][0])) return STOPS[STOPS.length - 1][1];
  for (let k = 1; k < STOPS.length; k++) {
    const [f1, c1] = STOPS[k];
    if (fraction > f1) continue;
    const [f0, c0] = STOPS[k - 1], w = (fraction - f0) / (f1 - f0);
    return c0.map((value, i) => Math.round(value + w * (c1[i] - value)));
  }
  return STOPS[0][1];
}

// Renders one panel: for each covered pixel, colour(point, normal) -> rgb or null for hatching.
function panel(soup, camera, classify) {
  const source = cropToCamera(soup, camera), image = render(source.soup, camera), normals = triangleNormals(soup);
  const { width, height, origin, right, up, forward } = camera, [u0, u1, v0, v1] = camera.extent;
  const light = [-forward[0] + 0.5 * up[0] - 0.35 * right[0], -forward[1] + 0.5 * up[1] - 0.35 * right[1], -forward[2] + 0.5 * up[2] - 0.35 * right[2]];
  const lightLength = Math.hypot(...light);
  const hits = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * width + x, local = image.tri[at];
    if (local < 0) continue;
    const t = source.map ? source.map[local] : local, u = u0 + (x + 0.5) / width * (u1 - u0), v = v1 - (y + 0.5) / height * (v1 - v0), d = image.depth[at];
    let n = [normals[3 * t], normals[3 * t + 1], normals[3 * t + 2]];
    if (n[0] * forward[0] + n[1] * forward[1] + n[2] * forward[2] > 0) n = n.map(value => -value);
    hits.push({ at, x, y, t, n, p: [0, 1, 2].map(i => origin[i] + u * right[i] + v * up[i] + d * forward[i]) });
  }
  const colours = classify(hits), out = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) out.set(BACKGROUND, 3 * i);
  for (const [k, hit] of hits.entries()) {
    const shade = 0.55 + 0.45 * Math.max(0, (hit.n[0] * light[0] + hit.n[1] * light[1] + hit.n[2] * light[2]) / lightLength);
    let colour = colours[k];
    if (!colour) colour = (hit.x + hit.y) % 7 < 2 ? [150, 150, 156] : MUTED;
    out.set(colour.map(value => Math.round(value * shade)), 3 * hit.at);
  }
  return { width, height, pixels: out };
}

function blit(image, source, left, top) {
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const at = 3 * (y * source.width + x);
    put(image, left + x, top + y, [source.pixels[at], source.pixels[at + 1], source.pixels[at + 2]]);
  }
}

// context: scoring context; aligned: candidate soup in the truth frame;
// final: candidate visible-surface sample + grid in the truth frame.
export function writeErrorMaps({ context, aligned, final, outDir, headlineF, views = ERROR_VIEWS }) {
  mkdirSync(outDir, { recursive: true });
  const { soup, diagonal, surface, maps } = context;
  // Frame on the truth plus whatever of the candidate lies near it; far-away
  // junk is reported by the numbers, not allowed to shrink the picture.
  const limit = 0.5 * diagonal, frame = { min: [0, 1, 2].map(i => Math.max(soup.bounds.min[i] - limit, Math.min(soup.bounds.min[i], aligned.bounds.min[i]))),
    max: [0, 1, 2].map(i => Math.min(soup.bounds.max[i] + limit, Math.max(soup.bounds.max[i], aligned.bounds.max[i]))) };
  const artifacts = [];
  for (const view of views) {
    const camera = orthoViewOfBounds(frame, view, { width: PANEL });
    const truthPanel = panel(soup, camera, hits => {
      const points = Float64Array.from(hits.flatMap(hit => hit.p)), normals = Float32Array.from(hits.flatMap(hit => hit.n));
      const evidenced = coverageMask(maps, points, normals, diagonal);
      return hits.map((hit, k) => {
        if (!evidenced[k]) return null;
        final.grid.nearest(hit.p[0], hit.p[1], hit.p[2], 0.1 * diagonal);
        return errorColour(final.grid.distance / diagonal);
      });
    });
    const candidatePanel = panel(aligned, camera, hits => hits.map(hit => {
      const j = surface.grid.nearest(hit.p[0], hit.p[1], hit.p[2]);
      if (j < 0 || (!surface.evidenced[j] && !surface.empty?.(hit.p[0], hit.p[1], hit.p[2]))) return null;
      return errorColour(surface.grid.distance / diagonal);
    }));
    const width = 2 * camera.width + 3 * GAP, height = HEADER + camera.height + FOOTER;
    const image = { width, height, pixels: new Uint8Array(width * height * 3) };
    for (let i = 0; i < width * height; i++) image.pixels.set(BACKGROUND, 3 * i);
    text(image, GAP, 10, view + ' view' + (headlineF !== undefined ? '   F@2% ' + (100 * headlineF).toFixed(1) : ''));
    blit(image, truthPanel, GAP, HEADER);
    blit(image, candidatePanel, 2 * GAP + camera.width, HEADER);
    const labelY = HEADER + camera.height + 6;
    text(image, GAP, labelY, 'truth: distance to model', { size: 1 });
    text(image, 2 * GAP + camera.width, labelY, 'model: distance to truth', { size: 1 });
    // Legend: 0 .. 8 % of the diagonal, ticks at 1, 2 and 5 %.
    const barLeft = GAP, barTop = labelY + 14, barWidth = Math.min(360, width - 220), barHeight = 12;
    for (let x = 0; x < barWidth; x++) {
      const colour = errorColour(0.08 * x / barWidth);
      for (let y = 0; y < barHeight; y++) put(image, barLeft + x, barTop + y, colour);
    }
    for (const tick of [0.01, 0.02, 0.05]) {
      const x = barLeft + Math.round(tick / 0.08 * barWidth);
      for (let y = -3; y < barHeight + 3; y++) put(image, x, barTop + y, INK);
      text(image, x - 6, barTop + barHeight + 5, Math.round(tick * 100) + '%', { size: 1 });
    }
    text(image, barLeft + barWidth + 8, barTop + 2, 'of diag', { size: 1 });
    const swatch = barLeft + barWidth + 70;
    for (let y = 0; y < barHeight; y++) for (let x = 0; x < 18; x++) put(image, swatch + x, barTop + y, (x + y) % 7 < 2 ? [150, 150, 156] : MUTED);
    text(image, swatch + 24, barTop + 2, 'not evidenced', { size: 1 });
    const name = 'error-' + view + '.png';
    writeFileSync(join(outDir, name), encodePNG(width, height, image.pixels, 3));
    artifacts.push(name);
  }
  return artifacts;
}
