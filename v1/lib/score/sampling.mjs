import { orthoCamera, render, normalize, cross } from '../raster.mjs';

const DEG = Math.PI / 180;

// Unit vectors from the object towards the viewer. DESIGN.md 9.2: 8 azimuths x
// elevations 0, 30 and 60 degrees, plus straight down. Azimuth 0 is the front (+Z).
export function towardsViewer(azimuthDeg, elevationDeg) {
  const a = azimuthDeg * DEG, e = elevationDeg * DEG;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}
export const SAMPLING_DIRECTIONS = [
  ...[0, 30, 60].flatMap(elevation => [0, 45, 90, 135, 180, 225, 270, 315].map(azimuth => towardsViewer(azimuth, elevation))),
  [0, 1, 0],
];

// right/up/forward for an orthographic view looking along -toViewer, with the
// image upright (world +Y up) whenever the view is not vertical.
export function viewBasis(toViewer) {
  const forward = normalize([-toViewer[0], -toViewer[1], -toViewer[2]]);
  if (Math.abs(forward[1]) > 0.9999) return { right: [1, 0, 0], up: forward[1] < 0 ? [0, 0, -1] : [0, 0, 1], forward };
  const right = normalize(cross(forward, [0, 1, 0]));
  return { right, up: cross(right, forward), forward };
}

// Orthographic camera looking along -toViewer, framed on an axis-aligned box plus
// `margin` metres, with square pixels of `pixel` metres unless that would need
// more than maxPixels on a side (then pixels grow and the caller is told).
export function frameBox(toViewer, box, { pixel, margin = 0, maxPixels = 2048 }) {
  const { right, up } = viewBasis(toViewer);
  const origin = [0, 1, 2].map(i => (box.min[i] + box.max[i]) / 2);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const p = [0, 1, 2].map(i => (corner >> i & 1 ? box.max[i] : box.min[i]) - origin[i]);
    const u = p[0] * right[0] + p[1] * right[1] + p[2] * right[2], v = p[0] * up[0] + p[1] * up[1] + p[2] * up[2];
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  u0 -= margin; u1 += margin; v0 -= margin; v1 += margin;
  const size = Math.max(pixel, (u1 - u0) / maxPixels, (v1 - v0) / maxPixels, 1e-9);
  const width = Math.max(1, Math.ceil((u1 - u0) / size - 1e-9)), height = Math.max(1, Math.ceil((v1 - v0) / size - 1e-9));
  // Grow the extent to whole pixels so pixels stay square and exactly `size` wide.
  const padU = (width * size - (u1 - u0)) / 2, padV = (height * size - (v1 - v0)) / 2;
  const camera = orthoCamera({ origin, right, up, extent: [u0 - padU, u1 + padU, v0 - padV, v1 + padV], width, height });
  return { camera, pixel: size };
}

// Per-triangle unit normals (winding order; zero for degenerate triangles).
const normalCache = new WeakMap();
export function triangleNormals(soup) {
  let normals = normalCache.get(soup.positions);
  if (normals) return normals;
  const p = soup.positions;
  normals = new Float32Array(soup.triangles * 3);
  for (let t = 0; t < soup.triangles; t++) {
    const i = 9 * t;
    const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
    const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, length = Math.hypot(nx, ny, nz);
    if (length > 0) { normals[3 * t] = nx / length; normals[3 * t + 1] = ny / length; normals[3 * t + 2] = nz / length; }
  }
  normalCache.set(soup.positions, normals);
  return normals;
}

// The triangles whose projection can touch an orthographic camera's frame. The
// kernel rasterizer visits every triangle for every view, so a 150k-triangle
// candidate rendered for a window-sized detail view would otherwise pay full price.
export function cropToCamera(soup, camera) {
  const p = soup.positions, { origin, right, up } = camera, [u0, u1, v0, v1] = camera.extent;
  const keep = new Int32Array(soup.triangles);
  let kept = 0;
  for (let t = 0; t < soup.triangles; t++) {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (let j = 0; j < 3; j++) {
      const i = 9 * t + 3 * j, x = p[i] - origin[0], y = p[i + 1] - origin[1], z = p[i + 2] - origin[2];
      const u = x * right[0] + y * right[1] + z * right[2], v = x * up[0] + y * up[1] + z * up[2];
      if (u < a) a = u; if (u > b) b = u; if (v < c) c = v; if (v > d) d = v;
    }
    if (b >= u0 && a <= u1 && d >= v0 && c <= v1) keep[kept++] = t;
  }
  if (kept === soup.triangles) return { soup, map: null };
  const positions = new Float64Array(kept * 9);
  for (let k = 0; k < kept; k++) positions.set(p.subarray(keep[k] * 9, keep[k] * 9 + 9), k * 9);
  return { soup: { positions, triangles: kept }, map: keep.subarray(0, kept) };
}

// Open-addressing hash set of voxel cells; the first point to reach a cell keeps it.
export class VoxelSet {
  constructor(voxel, origin) {
    this.inverse = 1 / voxel; this.origin = origin;
    this.capacity = 1 << 15; this.keys = new Int32Array(this.capacity * 3); this.slots = new Int32Array(this.capacity).fill(-1);
    this.count = 0; this.points = new Float64Array(3 * 4096); this.normals = new Float32Array(3 * 4096); this.tri = new Int32Array(4096);
  }

  static hash(ix, iy, iz) { return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0; }

  // Returns the new point's index, or -1 when its voxel is already taken.
  add(x, y, z, tri, nx, ny, nz) {
    const index = this.place(x, y, z, tri, nx, ny, nz);
    return this.added ? index : -1;
  }

  // Index of the point that holds this voxel: a new one (this.added true) or
  // the one that reached it first.
  place(x, y, z, tri, nx, ny, nz) {
    const ix = Math.floor((x - this.origin[0]) * this.inverse), iy = Math.floor((y - this.origin[1]) * this.inverse), iz = Math.floor((z - this.origin[2]) * this.inverse);
    let mask = this.capacity - 1, slot = VoxelSet.hash(ix, iy, iz) & mask;
    this.added = false;
    for (;;) {
      const at = this.slots[slot];
      if (at < 0) break;
      if (this.keys[3 * slot] === ix && this.keys[3 * slot + 1] === iy && this.keys[3 * slot + 2] === iz) return at;
      slot = (slot + 1) & mask;
    }
    this.added = true;
    const index = this.count++;
    this.slots[slot] = index; this.keys[3 * slot] = ix; this.keys[3 * slot + 1] = iy; this.keys[3 * slot + 2] = iz;
    if (index >= this.tri.length) {
      const grow = (array, size) => { const next = new array.constructor(size); next.set(array); return next; };
      this.points = grow(this.points, this.points.length * 2); this.normals = grow(this.normals, this.normals.length * 2); this.tri = grow(this.tri, this.tri.length * 2);
    }
    this.points[3 * index] = x; this.points[3 * index + 1] = y; this.points[3 * index + 2] = z;
    this.normals[3 * index] = nx; this.normals[3 * index + 1] = ny; this.normals[3 * index + 2] = nz;
    this.tri[index] = tri;
    if (this.count * 2 > this.capacity) this.rehash();
    return index;
  }

  rehash() {
    const capacity = this.capacity * 2, keys = new Int32Array(capacity * 3), slots = new Int32Array(capacity).fill(-1), mask = capacity - 1;
    for (let old = 0; old < this.capacity; old++) {
      const at = this.slots[old];
      if (at < 0) continue;
      const ix = this.keys[3 * old], iy = this.keys[3 * old + 1], iz = this.keys[3 * old + 2];
      let slot = VoxelSet.hash(ix, iy, iz) & mask;
      while (slots[slot] >= 0) slot = (slot + 1) & mask;
      slots[slot] = at; keys[3 * slot] = ix; keys[3 * slot + 1] = iy; keys[3 * slot + 2] = iz;
    }
    Object.assign(this, { capacity, keys, slots });
  }

  finish() {
    return { count: this.count, points: this.points.slice(0, 3 * this.count), normals: this.normals.slice(0, 3 * this.count), tri: this.tri.slice(0, this.count) };
  }
}

// Every triangle seen inside each voxel, not only the one whose point keeps it:
// a post narrower than a voxel keeps a point on its front face only, and the
// point-to-surface distance (surface.mjs) must still know its sides are there.
// Collected as (voxel, triangle) pairs, returned as per-voxel lists (CSR:
// voxel k's triangles are tris[start[k] .. start[k + 1]), sorted, distinct).
class VoxelTriangles {
  constructor() { this.voxel = new Int32Array(1 << 16); this.tri = new Int32Array(1 << 16); this.n = 0; this.last = new Int32Array(1 << 14).fill(-1); }

  push(index, t) {
    if (index >= this.last.length) {
      const last = new Int32Array(Math.max(2 * this.last.length, index + 1)).fill(-1);
      last.set(this.last); this.last = last;
    }
    // Neighbouring pixels mostly see the same triangle: skip the repeats cheaply.
    if (this.last[index] === t) return;
    this.last[index] = t;
    if (this.n === this.voxel.length) {
      const grow = array => { const next = new Int32Array(2 * array.length); next.set(array); return next; };
      this.voxel = grow(this.voxel); this.tri = grow(this.tri);
    }
    this.voxel[this.n] = index; this.tri[this.n++] = t;
  }

  finish(count) {
    const start = new Int32Array(count + 1);
    for (let k = 0; k < this.n; k++) start[this.voxel[k] + 1]++;
    for (let v = 0; v < count; v++) start[v + 1] += start[v];
    const fill = start.slice(0, count), tris = new Int32Array(this.n);
    for (let k = 0; k < this.n; k++) tris[fill[this.voxel[k]]++] = this.tri[k];
    const compact = new Int32Array(count + 1);
    let out = 0;
    for (let v = 0; v < count; v++) {
      compact[v] = out;
      const segment = tris.subarray(start[v], start[v + 1]).sort();
      for (let k = 0; k < segment.length; k++) if (k === 0 || segment[k] !== segment[k - 1]) tris[out++] = segment[k];
    }
    compact[count] = out;
    return { start: compact, tris: tris.slice(0, out) };
  }
}

// Renders `soup` from each direction and calls visit(x, y, z, tri, nx, ny, nz,
// facing) for every covered pixel, with the normal turned towards the viewer
// (facing = |cos| between normal and view direction), and onView(camera,
// image) once per view that shows anything.
export function renderSurface(soup, cameras, visit, onView) {
  const normals = triangleNormals(soup);
  for (const camera of cameras) {
    const source = cropToCamera(soup, camera);
    if (!source.soup.triangles) continue;
    const image = render(source.soup, camera), { width, height, origin, right, up, forward } = camera;
    onView?.(camera, image);
    const [u0, u1, v0, v1] = camera.extent, du = (u1 - u0) / width, dv = (v1 - v0) / height;
    for (let y = 0; y < height; y++) {
      const v = v1 - (y + 0.5) * dv;
      const bx = origin[0] + v * up[0], by = origin[1] + v * up[1], bz = origin[2] + v * up[2];
      for (let x = 0; x < width; x++) {
        const at = y * width + x, local = image.tri[at];
        if (local < 0) continue;
        const u = u0 + (x + 0.5) * du, d = image.depth[at];
        const px = bx + u * right[0] + d * forward[0], py = by + u * right[1] + d * forward[1], pz = bz + u * right[2] + d * forward[2];
        const t = source.map ? source.map[local] : local;
        let nx = normals[3 * t], ny = normals[3 * t + 1], nz = normals[3 * t + 2];
        const cos = nx * forward[0] + ny * forward[1] + nz * forward[2];
        if (cos > 0) { nx = -nx; ny = -ny; nz = -nz; }
        visit(px, py, pz, t, nx, ny, nz, Math.abs(cos));
      }
    }
  }
}

const EDGE_ON_COS = 1e-6;

// DESIGN.md 9.2: first-visible surface points from the 25 sampling directions,
// framed on `box`, thinned on a voxel grid of `voxel` metres. With
// `keepViews` the sample is also made ready to be a distance target
// (surface.mjs): `views` holds the depth maps ({ camera, depth, pixel } per
// view that shows anything), which say which part of a triangle is
// first-visible, and `voxelTriangles` every triangle seen in each point's voxel.
export function sampleSurface(soup, { voxel, pixel = voxel / 2, box = soup.bounds, directions = SAMPLING_DIRECTIONS, maxPixels = 2048, keep, keepViews = false } = {}) {
  const cameras = directions.map(direction => frameBox(direction, box, { pixel, margin: 2 * pixel, maxPixels }).camera);
  const set = new VoxelSet(voxel, box.min), views = [], seen = keepViews ? new VoxelTriangles() : null;
  renderSurface(soup, cameras, (x, y, z, t, nx, ny, nz, facing) => {
    // A triangle seen exactly edge-on covers no pixel; the kernel rasterizer
    // still reports hits along its line when that line falls on a pixel
    // centre (a wall plane at z = 0 in a side view), at interpolated depths
    // that can lie behind other surfaces. Those are not visible surface.
    if (facing < EDGE_ON_COS) return;
    if (keep && !keep(x, y, z)) return;
    const index = set.place(x, y, z, t, nx, ny, nz);
    if (seen) seen.push(index, t);
  }, keepViews ? (camera, image) => views.push({ camera, depth: image.depth, pixel: (camera.extent[1] - camera.extent[0]) / camera.width }) : undefined);
  return { ...set.finish(), voxel, pixel: cameras.length ? Math.max(pixel, ...cameras.map(c => (c.extent[1] - c.extent[0]) / c.width)) : pixel,
    ...(keepViews ? { views, voxelTriangles: seen.finish(set.count) } : {}) };
}

// Total triangle area and the box holding all but `trim` of it at each end of
// each axis. A submission is framed on this box rather than its raw bounds, so
// one speck of junk a kilometre away cannot shrink the real model to a few
// pixels in every sampling view (the speck itself, carrying no area, is lost).
export function areaBounds(soup, trim = 0.001) {
  const p = soup.positions, T = soup.triangles, areas = new Float64Array(T), centres = [new Float64Array(T), new Float64Array(T), new Float64Array(T)];
  let total = 0;
  for (let t = 0; t < T; t++) {
    const i = 9 * t;
    const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2], bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
    areas[t] = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2;
    total += areas[t];
    for (let axis = 0; axis < 3; axis++) centres[axis][t] = (p[i + axis] + p[i + 3 + axis] + p[i + 6 + axis]) / 3;
  }
  const box = { min: [...soup.bounds.min], max: [...soup.bounds.max] };
  if (!(total > 0)) return { area: 0, box };
  for (let axis = 0; axis < 3; axis++) {
    const order = Int32Array.from({ length: T }, (_, t) => t).sort((a, b) => centres[axis][a] - centres[axis][b]);
    // Extend each trimmed end by the largest triangle reach there, so the kept triangles stay whole.
    let below = 0, low = 0, high = T - 1;
    while (low < T - 1 && below + areas[order[low]] <= trim * total) below += areas[order[low++]];
    let above = 0;
    while (high > 0 && above + areas[order[high]] <= trim * total) above += areas[order[high--]];
    let min = Infinity, max = -Infinity;
    for (let k = low; k <= high; k++) {
      const t = order[k];
      for (let j = 0; j < 3; j++) { const v = p[9 * t + 3 * j + axis]; if (v < min) min = v; if (v > max) max = v; }
    }
    if (max >= min) { box.min[axis] = Math.max(box.min[axis], min); box.max[axis] = Math.min(box.max[axis], max); }
  }
  return { area: total, box };
}

// Every k-th point so that at most `limit` remain; deterministic and spread
// evenly over the view-ordered sample.
export function strideIndices(count, limit) {
  if (count <= limit) return Int32Array.from({ length: count }, (_, i) => i);
  const step = count / limit, out = new Int32Array(limit);
  for (let i = 0; i < limit; i++) out[i] = Math.floor(i * step);
  return out;
}

export function gather(points, indices) {
  const out = new points.constructor(indices.length * 3);
  for (let i = 0; i < indices.length; i++) { const j = indices[i]; out[3 * i] = points[3 * j]; out[3 * i + 1] = points[3 * j + 1]; out[3 * i + 2] = points[3 * j + 2]; }
  return out;
}

export function boxOf(points) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) for (let axis = 0; axis < 3; axis++) {
    const value = points[i + axis];
    if (value < min[axis]) min[axis] = value;
    if (value > max[axis]) max[axis] = value;
  }
  return { min, max };
}

export const expandBox = (box, by) => ({ min: box.min.map(v => v - by), max: box.max.map(v => v + by) });
export const boxCentre = box => box.min.map((v, i) => (v + box.max[i]) / 2);
export const boxDiagonal = box => Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
