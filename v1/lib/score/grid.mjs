// Uniform-grid nearest-neighbour index over a fixed point set (Float64Array of
// xyz triples). The scorer never rebuilds an index while it fits a transform:
// queries are mapped into the space the index was built in instead, so one
// index per point set serves every iteration of every alignment start.
export class PointGrid {
  constructor(points, cellSize, { maxCells = 1 << 21 } = {}) {
    const count = points.length / 3;
    this.count = count;
    this.distance = Infinity;
    if (!count) { this.empty = true; return; }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < points.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const value = points[i + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
    // A degenerate or absurd cell size would make the dense cell array explode;
    // coarsen until it fits instead of failing on a strange submission.
    let cell = cellSize > 0 && Number.isFinite(cellSize) ? cellSize : Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-6);
    let nx, ny, nz;
    for (;;) {
      nx = Math.floor((max[0] - min[0]) / cell) + 1;
      ny = Math.floor((max[1] - min[1]) / cell) + 1;
      nz = Math.floor((max[2] - min[2]) / cell) + 1;
      if (nx * ny * nz <= maxCells) break;
      cell *= 1.26;
    }
    const cells = nx * ny * nz, inverse = 1 / cell;
    const cellOf = new Int32Array(count), start = new Int32Array(cells + 1);
    for (let i = 0; i < count; i++) {
      const ix = Math.min(nx - 1, Math.floor((points[3 * i] - min[0]) * inverse));
      const iy = Math.min(ny - 1, Math.floor((points[3 * i + 1] - min[1]) * inverse));
      const iz = Math.min(nz - 1, Math.floor((points[3 * i + 2] - min[2]) * inverse));
      const c = (ix * ny + iy) * nz + iz;
      cellOf[i] = c; start[c + 1]++;
    }
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];
    const fill = start.slice(0, cells), order = new Int32Array(count), xyz = new Float64Array(3 * count);
    for (let i = 0; i < count; i++) {
      const at = fill[cellOf[i]]++;
      order[at] = i;
      xyz[3 * at] = points[3 * i]; xyz[3 * at + 1] = points[3 * i + 1]; xyz[3 * at + 2] = points[3 * i + 2];
    }
    Object.assign(this, { cell, inverse, min, max, nx, ny, nz, start, order, xyz });
  }

  // Index (into the original point order) of the nearest point no further than
  // maxRadius, or -1. Its distance is left in this.distance.
  nearest(x, y, z, maxRadius = Infinity) {
    this.distance = Infinity;
    if (this.empty) return -1;
    const { inverse, nx, ny, nz, start, xyz, cell, min } = this;
    const gx = (x - min[0]) * inverse, gy = (y - min[1]) * inverse, gz = (z - min[2]) * inverse;
    const cx = Math.floor(gx), cy = Math.floor(gy), cz = Math.floor(gz);
    if (!Number.isFinite(cx + cy + cz)) return -1;
    const edge = Math.min(gx - cx, 1 - gx + cx, gy - cy, 1 - gy + cy, gz - cz, 1 - gz + cz);
    // Rings closer than kStart hold no cells of the grid; past kEnd there are none left.
    const kStart = Math.max(0, -cx, cx - nx + 1, -cy, cy - ny + 1, -cz, cz - nz + 1);
    const kEnd = Math.max(cx, nx - 1 - cx, cy, ny - 1 - cy, cz, nz - 1 - cz);
    let best = maxRadius === Infinity ? Infinity : maxRadius * maxRadius, bestAt = -1;
    for (let k = kStart; k <= kEnd; k++) {
      // Every point in ring k is at least this far away along one axis.
      if (k > 0) {
        const lower = (k - 1 + edge) * cell;
        if (lower > 0 && lower * lower > best) break;
      }
      const i0 = Math.max(cx - k, 0), i1 = Math.min(cx + k, nx - 1);
      const j0 = Math.max(cy - k, 0), j1 = Math.min(cy + k, ny - 1);
      const l0 = Math.max(cz - k, 0), l1 = Math.min(cz + k, nz - 1);
      for (let i = i0; i <= i1; i++) {
        const iOnRing = i === cx - k || i === cx + k;
        for (let j = j0; j <= j1; j++) {
          const row = (i * ny + j) * nz;
          if (iOnRing || j === cy - k || j === cy + k) {
            for (let l = l0; l <= l1; l++) {
              for (let p = start[row + l], end = start[row + l + 1]; p < end; p++) {
                const dx = xyz[3 * p] - x, dy = xyz[3 * p + 1] - y, dz = xyz[3 * p + 2] - z, d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < best) { best = d2; bestAt = p; }
              }
            }
          } else {
            // Inside the ring's i/j span only the two z caps belong to ring k (k > 0 here:
            // at k = 0 the single cell is on the ring through i).
            for (let cap = 0, l = cz - k; cap < 2; cap++, l = cz + k) {
              if (l < 0 || l >= nz) continue;
              for (let p = start[row + l], end = start[row + l + 1]; p < end; p++) {
                const dx = xyz[3 * p] - x, dy = xyz[3 * p + 1] - y, dz = xyz[3 * p + 2] - z, d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < best) { best = d2; bestAt = p; }
              }
            }
          }
        }
      }
    }
    if (bestAt < 0) return -1;
    this.distance = Math.sqrt(best);
    return this.order[bestAt];
  }

  // True when some point within `radius` passes accept(index); cells are not
  // visited in distance order, so this answers existence, not "nearest".
  anyWithin(x, y, z, radius, accept) {
    if (this.empty) return false;
    const { inverse, nx, ny, nz, start, xyz, min, order } = this, r2 = radius * radius;
    const i0 = Math.max(0, Math.floor((x - radius - min[0]) * inverse)), i1 = Math.min(nx - 1, Math.floor((x + radius - min[0]) * inverse));
    const j0 = Math.max(0, Math.floor((y - radius - min[1]) * inverse)), j1 = Math.min(ny - 1, Math.floor((y + radius - min[1]) * inverse));
    const l0 = Math.max(0, Math.floor((z - radius - min[2]) * inverse)), l1 = Math.min(nz - 1, Math.floor((z + radius - min[2]) * inverse));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const row = (i * ny + j) * nz;
      for (let p = start[row + l0], end = start[row + l1 + 1]; p < end; p++) {
        const dx = xyz[3 * p] - x, dy = xyz[3 * p + 1] - y, dz = xyz[3 * p + 2] - z;
        if (dx * dx + dy * dy + dz * dz <= r2 && accept(order[p])) return true;
      }
    }
    return false;
  }

  // True when some point within `radius` has a unit normal (from `normals`,
  // indexed like the original points) within acos(minCos) of +-(nx, ny, nz).
  anyFacing(x, y, z, radius, normals, nx, ny, nz, minCos) {
    if (this.empty) return false;
    const { inverse, ny: cy, nz: cz, start, xyz, min, order } = this, r2 = radius * radius;
    const i0 = Math.max(0, Math.floor((x - radius - min[0]) * inverse)), i1 = Math.min(this.nx - 1, Math.floor((x + radius - min[0]) * inverse));
    const j0 = Math.max(0, Math.floor((y - radius - min[1]) * inverse)), j1 = Math.min(cy - 1, Math.floor((y + radius - min[1]) * inverse));
    const l0 = Math.max(0, Math.floor((z - radius - min[2]) * inverse)), l1 = Math.min(cz - 1, Math.floor((z + radius - min[2]) * inverse));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const row = (i * cy + j) * cz;
      for (let p = start[row + l0], end = start[row + l1 + 1]; p < end; p++) {
        const dx = xyz[3 * p] - x, dy = xyz[3 * p + 1] - y, dz = xyz[3 * p + 2] - z;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        const m = 3 * order[p];
        if (Math.abs(normals[m] * nx + normals[m + 1] * ny + normals[m + 2] * nz) >= minCos) return true;
      }
    }
    return false;
  }

  // Index of the nearest point within `radius` whose normal agrees as in
  // anyFacing (or, when `signed`, points the same way: dot >= minCos), or -1.
  // Its distance is left in this.distance.
  nearestFacing(x, y, z, radius, normals, nx, ny, nz, minCos, signed = false) {
    this.distance = Infinity;
    if (this.empty) return -1;
    const { inverse, ny: cy, nz: cz, start, xyz, min, order } = this;
    const i0 = Math.max(0, Math.floor((x - radius - min[0]) * inverse)), i1 = Math.min(this.nx - 1, Math.floor((x + radius - min[0]) * inverse));
    const j0 = Math.max(0, Math.floor((y - radius - min[1]) * inverse)), j1 = Math.min(cy - 1, Math.floor((y + radius - min[1]) * inverse));
    const l0 = Math.max(0, Math.floor((z - radius - min[2]) * inverse)), l1 = Math.min(cz - 1, Math.floor((z + radius - min[2]) * inverse));
    let best = radius * radius, bestAt = -1;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const row = (i * cy + j) * cz;
      for (let p = start[row + l0], end = start[row + l1 + 1]; p < end; p++) {
        const dx = xyz[3 * p] - x, dy = xyz[3 * p + 1] - y, dz = xyz[3 * p + 2] - z, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > best) continue;
        const m = 3 * order[p], cos = normals[m] * nx + normals[m + 1] * ny + normals[m + 2] * nz;
        if ((signed ? cos : Math.abs(cos)) < minCos) continue;
        best = d2; bestAt = p;
      }
    }
    if (bestAt < 0) return -1;
    this.distance = Math.sqrt(best);
    return order[bestAt];
  }
}

// Exact point-to-surface distance against a soup's triangles, for queries that
// only care about distances up to `reach` (anything further reports Infinity).
export class TriangleGrid {
  constructor(soup, reach) {
    const p = soup.positions, T = soup.triangles, box = soup.bounds;
    this.positions = p; this.reach = reach;
    let cell = Math.max(4 * reach, Math.hypot(...box.max.map((v, i) => v - box.min[i])) / 64, 1e-6);
    const dims = () => box.max.map((v, i) => Math.floor((v - box.min[i] + 2 * reach) / cell) + 1);
    while (dims().reduce((a, b) => a * b, 1) > 1 << 20) cell *= 1.5;
    const [nx, ny, nz] = dims(), origin = box.min.map(v => v - reach), lists = new Map();
    for (let t = 0; t < T; t++) {
      const lo = [0, 1, 2].map(a => Math.min(p[9 * t + a], p[9 * t + 3 + a], p[9 * t + 6 + a]) - reach), hi = [0, 1, 2].map(a => Math.max(p[9 * t + a], p[9 * t + 3 + a], p[9 * t + 6 + a]) + reach);
      const [i0, j0, k0] = lo.map((v, a) => Math.max(0, Math.floor((v - origin[a]) / cell))), [i1, j1, k1] = hi.map((v, a) => Math.min([nx, ny, nz][a] - 1, Math.floor((v - origin[a]) / cell)));
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
        const key = (i * ny + j) * nz + k;
        let list = lists.get(key);
        if (!list) lists.set(key, list = []);
        list.push(t);
      }
    }
    Object.assign(this, { cell, origin, nx, ny, nz, lists });
  }

  distance(x, y, z) {
    const { cell, origin, nx, ny, nz } = this;
    const i = Math.floor((x - origin[0]) / cell), j = Math.floor((y - origin[1]) / cell), k = Math.floor((z - origin[2]) / cell);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return Infinity;
    const list = this.lists.get((i * ny + j) * nz + k);
    let best = this.reach * this.reach, found = false;
    for (const t of list ?? []) {
      const d2 = pointTriangleDistance2(this.positions, t, x, y, z);
      if (d2 <= best) { best = d2; found = true; }
    }
    return found ? Math.sqrt(best) : Infinity;
  }
}

// Squared distance from a point to triangle t (closest-point regions, after
// Ericson, Real-Time Collision Detection 5.1.5).
function pointTriangleDistance2(p, t, x, y, z) {
  const i = 9 * t, ax = p[i], ay = p[i + 1], az = p[i + 2];
  const abx = p[i + 3] - ax, aby = p[i + 4] - ay, abz = p[i + 5] - az, acx = p[i + 6] - ax, acy = p[i + 7] - ay, acz = p[i + 8] - az;
  const apx = x - ax, apy = y - ay, apz = z - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const sq = (qx, qy, qz) => (x - qx) ** 2 + (y - qy) ** 2 + (z - qz) ** 2;
  if (d1 <= 0 && d2 <= 0) return sq(ax, ay, az);
  const bpx = x - p[i + 3], bpy = y - p[i + 4], bpz = z - p[i + 5];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return sq(p[i + 3], p[i + 4], p[i + 5]);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return sq(ax + v * abx, ay + v * aby, az + v * abz); }
  const cpx = x - p[i + 6], cpy = y - p[i + 7], cpz = z - p[i + 8];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return sq(p[i + 6], p[i + 7], p[i + 8]);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return sq(ax + w * acx, ay + w * acy, az + w * acz); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + d5 - d6);
    return sq(p[i + 3] + w * (p[i + 6] - p[i + 3]), p[i + 4] + w * (p[i + 7] - p[i + 4]), p[i + 5] + w * (p[i + 8] - p[i + 5]));
  }
  const denominator = 1 / (va + vb + vc), v = vb * denominator, w = vc * denominator;
  return sq(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

// Nearest-point index for a densely sampled surface that must also answer
// queries from far away (junk geometry metres from the object). A fine grid
// answers everything within `reach`; beyond it a coarse grid over an evenly
// thinned subset answers, which is exact enough there: such a point is a miss
// at every threshold, and only which truth region it is nearest still matters.
export class SurfaceIndex {
  constructor(points, diagonal, { cell = 0.02, reach = 0.1, farPoints = 2000 } = {}) {
    const count = points.length / 3;
    this.count = count;
    this.distance = Infinity;
    this.near = new PointGrid(points, cell * diagonal);
    this.reach = reach * diagonal;
    const kept = Math.min(count, farPoints), step = count / Math.max(1, kept);
    this.farIndex = Int32Array.from({ length: kept }, (_, i) => Math.floor(i * step));
    const far = new Float64Array(kept * 3);
    for (let i = 0; i < kept; i++) far.set(points.subarray(3 * this.farIndex[i], 3 * this.farIndex[i] + 3), 3 * i);
    this.far = new PointGrid(far, 0.15 * diagonal);
  }

  nearest(x, y, z, maxRadius = Infinity) {
    const i = this.near.nearest(x, y, z, Math.min(maxRadius, this.reach));
    if (i >= 0 || maxRadius <= this.reach) { this.distance = this.near.distance; return i; }
    const k = this.far.nearest(x, y, z, maxRadius);
    this.distance = this.far.distance;
    return k < 0 ? -1 : this.farIndex[k];
  }

  anyWithin(x, y, z, radius, accept) { return this.near.anyWithin(x, y, z, radius, accept); }
}
