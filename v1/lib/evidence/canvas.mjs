import { encodePNG } from '../png.mjs';

// A small RGB raster canvas for the scaled drawings: anti-aliased strokes of any
// width (solid or dashed), filled polygons, and a single-stroke vector font, all
// pure JavaScript and deterministic. Coordinates are pixels, (0, 0) is the
// top-left corner and pixel centres are at +0.5, like the kernel rasterizer.
//
// Every drawing call builds a coverage mask and blends it once. Strokes inside
// one call are unioned with max, so the joints of a polyline or the crossings of
// a glyph are not darkened twice.
export const INK = [24, 24, 28];
export const WHITE = [255, 255, 255];

const clamp01 = value => value < 0 ? 0 : value > 1 ? 1 : value;
const DEG = Math.PI / 180;

export class Canvas {
  constructor(width, height, background = WHITE) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('Canvas size must be positive integers');
    this.width = width; this.height = height;
    this.rgb = new Float32Array(width * height * 3);
    const [r, g, b] = background;
    for (let i = 0; i < this.rgb.length; i += 3) { this.rgb[i] = r; this.rgb[i + 1] = g; this.rgb[i + 2] = b; }
  }

  // Coverage mask over the pixel box that contains [x0, x1] x [y0, y1], clipped to the canvas.
  mask(x0, y0, x1, y1) {
    const left = Math.max(0, Math.floor(x0)), top = Math.max(0, Math.floor(y0));
    const right = Math.min(this.width, Math.ceil(x1)), bottom = Math.min(this.height, Math.ceil(y1));
    const width = Math.max(0, right - left), height = Math.max(0, bottom - top);
    return { x0: left, y0: top, width, height, a: new Float32Array(width * height) };
  }

  // Blends a mask (which may hang over the canvas edges) in one colour.
  blend(mask, color = INK, opacity = 1) {
    const { rgb } = this;
    const fromY = Math.max(0, -mask.y0), toY = Math.min(mask.height, this.height - mask.y0);
    const fromX = Math.max(0, -mask.x0), toX = Math.min(mask.width, this.width - mask.x0);
    for (let y = fromY; y < toY; y++) {
      for (let x = fromX; x < toX; x++) {
        const alpha = mask.a[y * mask.width + x] * opacity;
        if (!(alpha > 0)) continue;
        const at = ((mask.y0 + y) * this.width + mask.x0 + x) * 3;
        rgb[at] += (color[0] - rgb[at]) * alpha;
        rgb[at + 1] += (color[1] - rgb[at + 1]) * alpha;
        rgb[at + 2] += (color[2] - rgb[at + 2]) * alpha;
      }
    }
  }

  // polylines: [[[x, y], ...], ...]. dash: [on, off] in pixels, continued along each polyline.
  stroke(polylines, { width = 1, color = INK, opacity = 1, dash = null, dashOffset = 0 } = {}) {
    let segments = [];
    for (const line of polylines) {
      if (line.length < 2) {
        if (line.length === 1) segments.push([line[0][0], line[0][1], line[0][0], line[0][1]]);
        continue;
      }
      const pieces = [];
      for (let i = 0; i + 1 < line.length; i++) pieces.push([line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]]);
      // Round caps add half the width at each end of a dash; shorten the dash by
      // that much so the visible dash and gap lengths are the ones asked for.
      const visible = dash && [Math.max(dash[0] - width, 0.01), dash[1] + Math.min(dash[0], width)];
      segments = segments.concat(dash ? dashSegments(pieces, visible, dashOffset - Math.min(dash[0], width) / 2) : pieces);
    }
    if (!segments.length) return;
    const pad = width / 2 + 2;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [ax, ay, bx, by] of segments) {
      x0 = Math.min(x0, ax, bx); x1 = Math.max(x1, ax, bx); y0 = Math.min(y0, ay, by); y1 = Math.max(y1, ay, by);
    }
    const mask = this.mask(x0 - pad, y0 - pad, x1 + pad, y1 + pad);
    if (!mask.width || !mask.height) return;
    for (const segment of segments) coverSegment(mask, ...segment, width);
    this.blend(mask, color, opacity);
  }

  line(x0, y0, x1, y1, options) { this.stroke([[[x0, y0], [x1, y1]]], options); }

  // rings: [[[x, y], ...], ...], filled with the even-odd rule (so a ring inside another is a hole).
  fill(rings, { color = INK, opacity = 1 } = {}) {
    const edges = [];
    for (const ring of rings) for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      edges.push([a[0], a[1], b[0], b[1]]);
    }
    this.fillEdges(edges, { color, opacity });
  }

  // Closed outlines given as loose edges [x0, y0, x1, y1]; their order does not matter.
  fillEdges(edges, { color = INK, opacity = 1 } = {}) {
    if (!edges.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [ax, ay, bx, by] of edges) {
      x0 = Math.min(x0, ax, bx); x1 = Math.max(x1, ax, bx); y0 = Math.min(y0, ay, by); y1 = Math.max(y1, ay, by);
    }
    const mask = this.mask(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
    if (!mask.width || !mask.height) return;
    coverPolygon(mask, edges);
    this.blend(mask, color, opacity);
  }

  rect(x0, y0, x1, y1, options) { this.fill([[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]], options); }

  // Writes text and returns its bounding box { x0, y0, x1, y1 } in canvas pixels.
  text(string, x, y, { size = 20, color = INK, weight = 1, ...layout } = {}) {
    const laid = layoutText(string, { x, y, size, ...layout });
    this.stroke(laid.strokes, { width: strokeWidthFor(size) * weight, color });
    return laid.box;
  }

  toRGB8() {
    const out = new Uint8Array(this.rgb.length);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(this.rgb[i])));
    return out;
  }

  toPNG() { return encodePNG(this.width, this.height, this.toRGB8(), 3); }

  // Returns a new canvas rotated by angleDeg about (cx, cy), resampled bilinearly.
  // Positive angles turn the picture counter-clockwise as seen on screen; use
  // rotatePoint with the same arguments to follow a point through the turn.
  rotated(angleDeg, { cx = this.width / 2, cy = this.height / 2, background = WHITE } = {}) {
    const out = new Canvas(this.width, this.height, background);
    if (!angleDeg) { out.rgb.set(this.rgb); return out; }
    const c = Math.cos(angleDeg * DEG), s = Math.sin(angleDeg * DEG), { width, height, rgb } = this;
    const corner = [0, 0, 0, 0];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Inverse rotation of the output pixel centre, back into index space.
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const sx = cx + c * dx - s * dy - 0.5, sy = cy + s * dx + c * dy - 0.5;
        const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy, at = (y * width + x) * 3;
        const inside = ix >= 0 && iy >= 0 && ix + 1 < width && iy + 1 < height;
        for (let channel = 0; channel < 3; channel++) {
          if (inside) {
            const base = (iy * width + ix) * 3 + channel, below = base + width * 3;
            corner[0] = rgb[base]; corner[1] = rgb[base + 3]; corner[2] = rgb[below]; corner[3] = rgb[below + 3];
          } else {
            for (let k = 0; k < 4; k++) {
              const px = ix + (k & 1), py = iy + (k >> 1);
              corner[k] = px < 0 || py < 0 || px >= width || py >= height ? background[channel] : rgb[(py * width + px) * 3 + channel];
            }
          }
          out.rgb[at + channel] = (corner[0] * (1 - fx) + corner[1] * fx) * (1 - fy) + (corner[2] * (1 - fx) + corner[3] * fx) * fy;
        }
      }
    }
    return out;
  }
}

export function rotatePoint([x, y], angleDeg, cx, cy) {
  const c = Math.cos(angleDeg * DEG), s = Math.sin(angleDeg * DEG), dx = x - cx, dy = y - cy;
  return [cx + c * dx + s * dy, cy - s * dx + c * dy];
}

// Anti-aliased capsule: coverage falls off over one pixel at the stroke edge.
// Strokes thinner than a pixel are drawn one pixel wide and proportionally lighter.
export function coverSegment(mask, ax, ay, bx, by, width) {
  const half = Math.max(width, 1) / 2, strength = Math.min(width, 1), reach = half + 1;
  const left = Math.max(mask.x0, Math.floor(Math.min(ax, bx) - reach)), right = Math.min(mask.x0 + mask.width, Math.ceil(Math.max(ax, bx) + reach));
  const top = Math.max(mask.y0, Math.floor(Math.min(ay, by) - reach)), bottom = Math.min(mask.y0 + mask.height, Math.ceil(Math.max(ay, by) + reach));
  const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const px = x + 0.5 - ax, py = y + 0.5 - ay;
      const t = length2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / length2)) : 0;
      const ex = px - t * dx, ey = py - t * dy;
      const coverage = clamp01(half + 0.5 - Math.sqrt(ex * ex + ey * ey)) * strength;
      const at = (y - mask.y0) * mask.width + x - mask.x0;
      if (coverage > mask.a[at]) mask.a[at] = coverage;
    }
  }
}

// Round dot of the given radius, unioned into the mask (used to stamp raster edges as strokes).
export function coverDisc(mask, cx, cy, radius, strength = 1) {
  const reach = radius + 1;
  const left = Math.max(mask.x0, Math.floor(cx - reach)), right = Math.min(mask.x0 + mask.width, Math.ceil(cx + reach));
  const top = Math.max(mask.y0, Math.floor(cy - reach)), bottom = Math.min(mask.y0 + mask.height, Math.ceil(cy + reach));
  for (let y = top; y < bottom; y++) {
    const dy = y + 0.5 - cy;
    for (let x = left; x < right; x++) {
      const dx = x + 0.5 - cx, coverage = clamp01(radius + 0.5 - Math.sqrt(dx * dx + dy * dy)) * strength;
      const at = (y - mask.y0) * mask.width + x - mask.x0;
      if (coverage > mask.a[at]) mask.a[at] = coverage;
    }
  }
}

// Splits segments into the "on" parts of a dash pattern measured along the path.
// Dash k covers path distance [k * period - offset, k * period - offset + on]; working
// from absolute dash indices (not by stepping) cannot stall on rounding error.
export function dashSegments(segments, [on, off], offset = 0) {
  const out = [], period = on + off;
  if (!(on > 0) || !(period > 0)) return segments;
  let start = 0;
  for (const [ax, ay, bx, by] of segments) {
    const length = Math.hypot(bx - ax, by - ay), end = start + length;
    if (length > 0) {
      for (let k = Math.floor((start + offset) / period); k * period - offset < end; k++) {
        const from = Math.max(start, k * period - offset), to = Math.min(end, k * period - offset + on);
        if (to <= from) continue;
        const t0 = (from - start) / length, t1 = (to - start) / length;
        out.push([ax + (bx - ax) * t0, ay + (by - ay) * t0, ax + (bx - ax) * t1, ay + (by - ay) * t1]);
      }
    }
    start = end;
  }
  return out;
}

const SUBROWS = 5;
// Even-odd fill with exact horizontal coverage and SUBROWS samples per pixel row.
export function coverPolygon(mask, edges) {
  const row = new Float32Array(mask.width + 1);
  for (let y = 0; y < mask.height; y++) {
    row.fill(0);
    for (let sub = 0; sub < SUBROWS; sub++) {
      const sy = mask.y0 + y + (sub + 0.5) / SUBROWS;
      const crossings = scanlineCrossings(edges, sy);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const xa = Math.max(crossings[k] - mask.x0, 0), xb = Math.min(crossings[k + 1] - mask.x0, mask.width);
        if (!(xb > xa)) continue;
        const ia = Math.floor(xa), ib = Math.floor(xb);
        if (ia === ib) { row[ia] += (xb - xa) / SUBROWS; continue; }
        row[ia] += (ia + 1 - xa) / SUBROWS;
        for (let x = ia + 1; x < ib; x++) row[x] += 1 / SUBROWS;
        if (ib < mask.width) row[ib] += (xb - ib) / SUBROWS;
      }
    }
    for (let x = 0; x < mask.width; x++) {
      const at = y * mask.width + x, coverage = Math.min(1, row[x]);
      if (coverage > mask.a[at]) mask.a[at] = coverage;
    }
  }
}

// Sorted x positions where the edges cross the horizontal line at y (half-open in y,
// so a vertex shared by two edges is counted once).
export function scanlineCrossings(edges, y) {
  const xs = [];
  for (const [ax, ay, bx, by] of edges) {
    if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + (y - ay) * (bx - ax) / (by - ay));
  }
  return xs.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Single-stroke font. Glyphs are polylines in units of the cap height (baseline
// y = 0, cap line y = 1, x-height 0.68, descender -0.3), y pointing up. The
// letterforms follow hand lettering on architectural sheets: plain strokes, open
// counters, a flagged and footed 1, so digits stay distinct at small sizes.
// ---------------------------------------------------------------------------
function arc(cx, cy, rx, ry, from, to) {
  const steps = Math.max(4, Math.ceil(Math.abs(to - from) / 9));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const angle = (from + (to - from) * i / steps) * DEG;
    return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
  });
}
// Concatenates points and point lists into one polyline.
const path = (...pieces) => pieces.flatMap(piece => typeof piece[0] === 'number' ? [piece] : piece);
// A filled-looking dot: a tiny closed diamond, thicker than a stroke end.
const dot = (x, y, r = 0.05) => [[x - r, y], [x, y + r], [x + r, y], [x, y - r], [x - r, y], [x + r, y]];

const GLYPHS = {
  ' ': { w: 0.42, s: [] },
  '0': { w: 0.58, s: [arc(0.29, 0.5, 0.29, 0.5, 0, 360)] },
  '1': { w: 0.5, s: [[[0.06, 0.78], [0.27, 1], [0.27, 0]], [[0.04, 0], [0.5, 0]]] },
  '2': { w: 0.58, s: [path(arc(0.29, 0.71, 0.27, 0.29, 162, -38), [0, 0], [0.58, 0])] },
  '3': { w: 0.58, s: [path(arc(0.29, 0.765, 0.25, 0.235, 160, -90), arc(0.29, 0.265, 0.29, 0.265, 90, -160)), [[0.14, 0.53], [0.29, 0.53]]] },
  '4': { w: 0.6, s: [[[0.44, 0], [0.44, 1], [0, 0.32], [0.6, 0.32]]] },
  '5': { w: 0.58, s: [path([0.54, 1], [0.09, 1], [0.05, 0.53], arc(0.28, 0.32, 0.3, 0.32, 140, -145))] },
  '6': { w: 0.58, s: [arc(0.29, 0.3, 0.29, 0.3, 0, 360), arc(0.62, 0.3, 0.62, 0.72, 180, 104)] },
  '7': { w: 0.58, s: [[[0, 1], [0.58, 1], [0.17, 0]]] },
  '8': { w: 0.58, s: [arc(0.29, 0.765, 0.24, 0.235, 0, 360), arc(0.29, 0.265, 0.29, 0.265, 0, 360)] },
  '9': { w: 0.58, s: [arc(0.29, 0.7, 0.29, 0.3, 0, 360), arc(-0.04, 0.7, 0.62, 0.72, 0, -76)] },

  A: { w: 0.66, s: [[[0, 0], [0.33, 1], [0.66, 0]], [[0.12, 0.36], [0.54, 0.36]]] },
  B: { w: 0.62, s: [path([0, 0], [0, 1], [0.34, 1], arc(0.34, 0.765, 0.235, 0.235, 90, -90), [0, 0.53]),
    path([0.36, 0.53], arc(0.36, 0.265, 0.265, 0.265, 90, -90), [0, 0])] },
  C: { w: 0.68, s: [arc(0.36, 0.5, 0.36, 0.5, 42, 318)] },
  D: { w: 0.64, s: [path([0, 0], [0, 1], [0.26, 1], arc(0.26, 0.5, 0.38, 0.5, 90, -90), [0, 0])] },
  E: { w: 0.56, s: [[[0.56, 1], [0, 1], [0, 0], [0.56, 0]], [[0, 0.53], [0.44, 0.53]]] },
  F: { w: 0.54, s: [[[0.54, 1], [0, 1], [0, 0]], [[0, 0.53], [0.44, 0.53]]] },
  G: { w: 0.72, s: [path(arc(0.36, 0.5, 0.36, 0.5, 42, 360), [0.42, 0.5])] },
  H: { w: 0.6, s: [[[0, 0], [0, 1]], [[0.6, 0], [0.6, 1]], [[0, 0.53], [0.6, 0.53]]] },
  I: { w: 0.3, s: [[[0.15, 0], [0.15, 1]], [[0, 1], [0.3, 1]], [[0, 0], [0.3, 0]]] },
  J: { w: 0.46, s: [path([0.46, 1], [0.46, 0.25], arc(0.23, 0.25, 0.23, 0.25, 0, -180))] },
  K: { w: 0.58, s: [[[0, 0], [0, 1]], [[0.56, 1], [0, 0.38]], [[0.18, 0.58], [0.58, 0]]] },
  L: { w: 0.52, s: [[[0, 1], [0, 0], [0.52, 0]]] },
  M: { w: 0.74, s: [[[0, 0], [0, 1], [0.37, 0.28], [0.74, 1], [0.74, 0]]] },
  N: { w: 0.6, s: [[[0, 0], [0, 1], [0.6, 0], [0.6, 1]]] },
  O: { w: 0.76, s: [arc(0.38, 0.5, 0.38, 0.5, 0, 360)] },
  P: { w: 0.58, s: [path([0, 0], [0, 1], [0.32, 1], arc(0.32, 0.745, 0.255, 0.255, 90, -90), [0, 0.49])] },
  Q: { w: 0.78, s: [arc(0.38, 0.5, 0.38, 0.5, 0, 360), [[0.46, 0.24], [0.8, -0.06]]] },
  R: { w: 0.6, s: [path([0, 0], [0, 1], [0.32, 1], arc(0.32, 0.745, 0.255, 0.255, 90, -90), [0, 0.49]), [[0.3, 0.49], [0.6, 0]]] },
  S: { w: 0.6, s: [path(arc(0.3, 0.76, 0.26, 0.24, 22, 270), arc(0.3, 0.26, 0.3, 0.26, 90, -158))] },
  T: { w: 0.62, s: [[[0, 1], [0.62, 1]], [[0.31, 1], [0.31, 0]]] },
  U: { w: 0.6, s: [path([0, 1], [0, 0.3], arc(0.3, 0.3, 0.3, 0.3, 180, 360), [0.6, 1])] },
  V: { w: 0.64, s: [[[0, 1], [0.32, 0], [0.64, 1]]] },
  W: { w: 0.84, s: [[[0, 1], [0.2, 0], [0.42, 0.72], [0.64, 0], [0.84, 1]]] },
  X: { w: 0.6, s: [[[0, 1], [0.6, 0]], [[0.6, 1], [0, 0]]] },
  Y: { w: 0.64, s: [[[0, 1], [0.32, 0.48], [0.64, 1]], [[0.32, 0.48], [0.32, 0]]] },
  Z: { w: 0.6, s: [[[0.02, 1], [0.6, 1], [0, 0], [0.6, 0]]] },

  a: { w: 0.54, s: [arc(0.27, 0.34, 0.27, 0.34, 0, 360), [[0.54, 0.68], [0.54, 0]]] },
  b: { w: 0.54, s: [[[0, 1], [0, 0]], arc(0.27, 0.34, 0.27, 0.34, 0, 360)] },
  c: { w: 0.52, s: [arc(0.28, 0.34, 0.28, 0.34, 45, 315)] },
  d: { w: 0.54, s: [arc(0.27, 0.34, 0.27, 0.34, 0, 360), [[0.54, 1], [0.54, 0]]] },
  e: { w: 0.55, s: [path([0.02, 0.34], [0.55, 0.34], arc(0.285, 0.34, 0.265, 0.34, 0, 318))] },
  f: { w: 0.42, s: [path(arc(0.3, 0.8, 0.16, 0.2, 50, 180), [0.14, 0]), [[0, 0.66], [0.36, 0.66]]] },
  g: { w: 0.54, s: [arc(0.27, 0.34, 0.27, 0.34, 0, 360), path([0.54, 0.68], [0.54, -0.08], arc(0.28, -0.08, 0.26, 0.22, 0, -160))] },
  h: { w: 0.52, s: [[[0, 1], [0, 0]], path([0, 0.42], arc(0.26, 0.42, 0.26, 0.26, 180, 0), [0.52, 0])] },
  i: { w: 0.16, s: [[[0.08, 0.68], [0.08, 0]], dot(0.08, 0.9)] },
  j: { w: 0.34, s: [path([0.26, 0.68], [0.26, -0.12], arc(0.08, -0.12, 0.18, 0.18, 0, -150)), dot(0.26, 0.9)] },
  k: { w: 0.5, s: [[[0, 1], [0, 0]], [[0.46, 0.68], [0, 0.26]], [[0.17, 0.4], [0.5, 0]]] },
  l: { w: 0.26, s: [path([0.08, 1], [0.08, 0.12], arc(0.2, 0.12, 0.12, 0.12, 180, 270), [0.26, 0])] },
  m: { w: 0.8, s: [[[0, 0.68], [0, 0]], path([0, 0.44], arc(0.2, 0.46, 0.2, 0.22, 180, 0), [0.4, 0]),
    path([0.4, 0.44], arc(0.6, 0.46, 0.2, 0.22, 180, 0), [0.8, 0])] },
  n: { w: 0.52, s: [[[0, 0.68], [0, 0]], path([0, 0.42], arc(0.26, 0.42, 0.26, 0.26, 180, 0), [0.52, 0])] },
  o: { w: 0.56, s: [arc(0.28, 0.34, 0.28, 0.34, 0, 360)] },
  p: { w: 0.54, s: [[[0, 0.68], [0, -0.3]], arc(0.27, 0.34, 0.27, 0.34, 0, 360)] },
  q: { w: 0.54, s: [arc(0.27, 0.34, 0.27, 0.34, 0, 360), [[0.54, 0.68], [0.54, -0.3]]] },
  r: { w: 0.4, s: [[[0, 0.68], [0, 0]], path([0, 0.38], arc(0.26, 0.4, 0.26, 0.28, 180, 62))] },
  s: { w: 0.5, s: [path(arc(0.25, 0.515, 0.21, 0.165, 22, 270), arc(0.25, 0.175, 0.25, 0.175, 90, -158))] },
  t: { w: 0.36, s: [path([0.14, 0.92], [0.14, 0.12], arc(0.28, 0.12, 0.14, 0.12, 180, 270), [0.34, 0]), [[0, 0.66], [0.34, 0.66]]] },
  u: { w: 0.52, s: [path([0, 0.68], [0, 0.26], arc(0.26, 0.26, 0.26, 0.26, 180, 360)), [[0.52, 0.68], [0.52, 0]]] },
  v: { w: 0.54, s: [[[0, 0.68], [0.27, 0], [0.54, 0.68]]] },
  w: { w: 0.76, s: [[[0, 0.68], [0.18, 0], [0.38, 0.52], [0.58, 0], [0.76, 0.68]]] },
  x: { w: 0.52, s: [[[0, 0.68], [0.52, 0]], [[0.52, 0.68], [0, 0]]] },
  y: { w: 0.56, s: [[[0, 0.68], [0.28, 0]], [[0.56, 0.68], [0.18, -0.3], [0.06, -0.3]]] },
  z: { w: 0.5, s: [[[0, 0.68], [0.5, 0.68], [0, 0], [0.5, 0]]] },

  '.': { w: 0.16, s: [dot(0.08, 0.05)] },
  ',': { w: 0.16, s: [dot(0.08, 0.05), [[0.12, 0.04], [0.04, -0.16]]] },
  ':': { w: 0.16, s: [dot(0.08, 0.05), dot(0.08, 0.55)] },
  ';': { w: 0.16, s: [dot(0.08, 0.55), dot(0.08, 0.05), [[0.12, 0.04], [0.04, -0.16]]] },
  '-': { w: 0.44, s: [[[0.04, 0.44], [0.4, 0.44]]] },
  '_': { w: 0.6, s: [[[0, -0.12], [0.6, -0.12]]] },
  '/': { w: 0.44, s: [[[0, -0.06], [0.44, 1.06]]] },
  '(': { w: 0.3, s: [arc(0.42, 0.42, 0.36, 0.64, 116, 244)] },
  ')': { w: 0.3, s: [arc(-0.12, 0.42, 0.36, 0.64, 64, -64)] },
  '[': { w: 0.3, s: [[[0.28, 1.06], [0.04, 1.06], [0.04, -0.16], [0.28, -0.16]]] },
  ']': { w: 0.3, s: [[[0.02, 1.06], [0.26, 1.06], [0.26, -0.16], [0.02, -0.16]]] },
  "'": { w: 0.12, s: [[[0.06, 1], [0.06, 0.74]]] },
  '"': { w: 0.28, s: [[[0.06, 1], [0.06, 0.74]], [[0.22, 1], [0.22, 0.74]]] },
  '+': { w: 0.56, s: [[[0.28, 0.16], [0.28, 0.72]], [[0, 0.44], [0.56, 0.44]]] },
  '=': { w: 0.52, s: [[[0, 0.3], [0.52, 0.3]], [[0, 0.58], [0.52, 0.58]]] },
  '#': { w: 0.66, s: [[[0.22, 0], [0.3, 1]], [[0.44, 0], [0.52, 1]], [[0.04, 0.32], [0.64, 0.32]], [[0.06, 0.68], [0.66, 0.68]]] },
  '%': { w: 0.72, s: [arc(0.16, 0.8, 0.14, 0.18, 0, 360), arc(0.56, 0.2, 0.14, 0.18, 0, 360), [[0.06, 0], [0.66, 1]]] },
  '&': { w: 0.66, s: [path([0.66, 0], [0.16, 0.62], arc(0.28, 0.8, 0.14, 0.18, 215, -35), [0.12, 0.36],
    arc(0.27, 0.24, 0.24, 0.24, 140, 300), [0.62, 0.42])] },
  '°': { w: 0.3, s: [arc(0.14, 0.86, 0.12, 0.12, 0, 360)] },
  '?': { w: 0.52, s: [path(arc(0.26, 0.74, 0.25, 0.25, 160, -60), [0.26, 0.42], [0.26, 0.26]), dot(0.26, 0.05)] },
  '!': { w: 0.16, s: [[[0.08, 1], [0.08, 0.28]], dot(0.08, 0.05)] },
  '<': { w: 0.5, s: [[[0.5, 0.78], [0, 0.44], [0.5, 0.1]]] },
  '>': { w: 0.5, s: [[[0, 0.78], [0.5, 0.44], [0, 0.1]]] },
};

// Characters with no glyph of their own are folded onto close relatives.
const ALIASES = { '–': '-', '—': '-', '−': '-', '×': 'x', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '.' };
export const GLYPH_CHARACTERS = Object.keys(GLYPHS);

function glyphFor(character) {
  if (GLYPHS[character]) return GLYPHS[character];
  if (ALIASES[character]) return GLYPHS[ALIASES[character]];
  const plain = character.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (GLYPHS[plain]) return GLYPHS[plain];
  return GLYPHS['?'];
}

const TRACKING = 0.2;
// Stroke weight that keeps lettering crisp from small notes to sheet titles.
export const strokeWidthFor = size => Math.max(1.4, size * 0.085);

// Advance width of a string in pixels (no trailing tracking).
export function measureText(string, size) {
  const glyphs = [...string].map(glyphFor);
  if (!glyphs.length) return 0;
  return (glyphs.reduce((sum, glyph) => sum + glyph.w, 0) + TRACKING * (glyphs.length - 1)) * size;
}

const BASELINE = { alphabetic: 0, bottom: 0, middle: 0.5, top: 1, descender: -0.3 };
const ALIGN = { left: 0, center: 0.5, right: 1 };

// Places a string. (x, y) is the anchor; `align` picks the anchor along the
// baseline, `baseline` picks it across: 'alphabetic' (baseline), 'middle' (half the
// cap height), 'top' (cap line), 'descender'. angleDeg turns the text about the
// anchor, counter-clockwise on screen: 90 reads bottom-to-top.
export function layoutText(string, { x = 0, y = 0, size = 20, angleDeg = 0, align = 'left', baseline = 'alphabetic' } = {}) {
  if (!(BASELINE[baseline] !== undefined)) throw new Error('Unknown baseline ' + baseline);
  if (!(ALIGN[align] !== undefined)) throw new Error('Unknown align ' + align);
  const width = measureText(string, size), shiftX = -width * ALIGN[align], shiftY = BASELINE[baseline];
  const c = Math.cos(angleDeg * DEG), s = Math.sin(angleDeg * DEG);
  const place = (lx, ly) => [x + c * lx + s * ly, y - s * lx + c * ly];
  const strokes = [];
  let pen = 0;
  for (const character of string) {
    const glyph = glyphFor(character);
    for (const stroke of glyph.s) strokes.push(stroke.map(([gx, gy]) => place(shiftX + (pen + gx) * size, -(gy - shiftY) * size)));
    pen += glyph.w + TRACKING;
  }
  // Canvas-space boxes of the line: `box` from cap line to descender, `capBox` from
  // cap line to baseline (what digits and capitals actually occupy).
  const boxOf = bottom => {
    const corners = [[shiftX, -(1 - shiftY) * size], [shiftX + width, -(1 - shiftY) * size], [shiftX, bottom], [shiftX + width, bottom]].map(([lx, ly]) => place(lx, ly));
    return { x0: Math.min(...corners.map(p => p[0])), y0: Math.min(...corners.map(p => p[1])), x1: Math.max(...corners.map(p => p[0])), y1: Math.max(...corners.map(p => p[1])) };
  };
  return { strokes, width, box: boxOf((0.3 + shiftY) * size), capBox: boxOf(shiftY * size) };
}
