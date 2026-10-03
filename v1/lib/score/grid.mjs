// Uniform-grid nearest-neighbour index over a fixed point set (Float64Array of
// xyz triples). The scorer never rebuilds an index while it fits a transform:
// queries are mapped into the space the index was built in instead, so one
// index per point set serves every iteration of every alignment start.
const FAR_CELLS = 2;
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

  // nearest(), for queries that may lie far from every point: within
  // FAR_CELLS cells the grid answers (exactly as nearest() does); beyond, a
  // k-d tree over the same points, built on first use, instead of a walk over
  // every empty ring of cells in between. Same answer up to ties at exactly
  // equal distance.
  nearestFar(x, y, z, maxRadius = Infinity) {
    if (this.empty) { this.distance = Infinity; return -1; }
    const near = Math.min(maxRadius, FAR_CELLS * this.cell), i = this.nearest(x, y, z, near);
    if (i >= 0 || near >= maxRadius) return i;
    this.tree ??= new KdTree(this.xyz);
    const p = this.tree.nearest(x, y, z, maxRadius);
    this.distance = this.tree.distance;
    return p < 0 ? -1 : this.order[p];
  }

  // Calls visit(index) for every point within `radius`, in no particular order.
  forEachWithin(x, y, z, radius, visit) {
    if (this.empty) return;
    const { inverse, nx, ny, nz, start, xyz, min, order } = this, r2 = radius * radius;
    const i0 = Math.max(0, Math.floor((x - radius - min[0]) * inverse)), i1 = Math.min(nx - 1, Math.floor((x + radius - min[0]) * inverse));
    const j0 = Math.max(0, Math.floor((y - radius - min[1]) * inverse)), j1 = Math.min(ny - 1, Math.floor((y + radius - min[1]) * inverse));
    const l0 = Math.max(0, Math.floor((z - radius - min[2]) * inverse)), l1 = Math.min(nz - 1, Math.floor((z + radius - min[2]) * inverse));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const row = (i * ny + j) * nz;
      for (let p = start[row + l0], end = start[row + l1 + 1]; p < end; p++) {
        const dx = xyz[3 * p] - x, dy = xyz[3 * p + 1] - y, dz = xyz[3 * p + 2] - z;
        if (dx * dx + dy * dy + dz * dz <= r2) visit(order[p]);
      }
    }
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

// Exact nearest-point queries at any distance (static k-d tree, median splits
// on the widest axis, every node pruned by the distance to its bounding box).
// A PointGrid answers a query near its points from a few cells, but one far
// from every point walks every empty ring of cells in between, at a cost that
// grows with the cube of the distance in cells: a detail group's local fit and
// attribution ask exactly that for every truth point a wrong model lacks.
// Pruning by box distance, not by the splitting plane alone, matters: the
// points are surfaces, and a query a metre off a wall lies within a metre of
// every split plane across a disc of the wall a metre wide, but within that
// distance of only the boxes under its foot (plane-only pruning made detail
// 2-3x slower than the grid it was meant to replace: 93 s against 41 s on one
// tower group). Same answers as PointGrid.nearest (ties at exactly equal
// distance aside).
const KD_LEAF = 8;
export class KdTree {
  constructor(points) {
    const count = points.length / 3;
    this.count = count;
    this.distance = Infinity;
    if (!count) { this.empty = true; return; }
    const order = new Int32Array(count);
    for (let i = 0; i < count; i++) order[i] = i;
    const axisAt = new Int8Array(count), coordinate = (i, axis) => points[3 * order[i] + axis];
    const build = (lo, hi) => {
      if (hi - lo <= KD_LEAF) return;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = lo; i < hi; i++) for (let axis = 0; axis < 3; axis++) {
        const value = coordinate(i, axis);
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
      const spans = [0, 1, 2].map(axis => max[axis] - min[axis]), axis = spans.indexOf(Math.max(...spans)), mid = (lo + hi) >> 1;
      // Quickselect: order[mid] gets the median along `axis`, smaller to its left.
      for (let left = lo, right = hi - 1; left < right;) {
        const pivot = coordinate((left + right) >> 1, axis);
        let i = left, j = right;
        while (i <= j) {
          while (coordinate(i, axis) < pivot) i++;
          while (coordinate(j, axis) > pivot) j--;
          if (i <= j) { const swap = order[i]; order[i] = order[j]; order[j] = swap; i++; j--; }
        }
        if (mid <= j) right = j;
        else if (mid >= i) left = i;
        else break;
      }
      axisAt[mid] = axis;
      build(lo, mid);
      build(mid + 1, hi);
    };
    build(0, count);
    const xyz = new Float64Array(3 * count);
    for (let i = 0; i < count; i++) { xyz[3 * i] = points[3 * order[i]]; xyz[3 * i + 1] = points[3 * order[i] + 1]; xyz[3 * i + 2] = points[3 * order[i] + 2]; }
    // Bounding box of every node's range [lo, hi), stored at its key (lo + hi) >> 1
    // (unique: an inner node's key is its splitting point, a leaf's lies inside it).
    const boxes = new Float64Array(6 * count);
    const bound = (lo, hi) => {
      const key = 6 * ((lo + hi) >> 1);
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      const take = (a, b) => {
        for (let p = a; p < b; p++) {
          const x = xyz[3 * p], y = xyz[3 * p + 1], z = xyz[3 * p + 2];
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
      };
      const merge = at => {
        if (boxes[at] < x0) x0 = boxes[at]; if (boxes[at + 1] < y0) y0 = boxes[at + 1]; if (boxes[at + 2] < z0) z0 = boxes[at + 2];
        if (boxes[at + 3] > x1) x1 = boxes[at + 3]; if (boxes[at + 4] > y1) y1 = boxes[at + 4]; if (boxes[at + 5] > z1) z1 = boxes[at + 5];
      };
      if (hi - lo <= KD_LEAF) take(lo, hi);
      else {
        const mid = (lo + hi) >> 1;
        take(mid, mid + 1);
        if (mid > lo) merge(bound(lo, mid));
        if (hi > mid + 1) merge(bound(mid + 1, hi));
      }
      boxes[key] = x0; boxes[key + 1] = y0; boxes[key + 2] = z0; boxes[key + 3] = x1; boxes[key + 4] = y1; boxes[key + 5] = z1;
      return key;
    };
    bound(0, count);
    // Depth-first traversal stack: at most two entries per level.
    const depth = 2 * (Math.ceil(Math.log2(count + 1)) + 2);
    Object.assign(this, { order, axisAt, xyz, boxes, stackLo: new Int32Array(depth), stackHi: new Int32Array(depth) });
  }

  // As PointGrid.nearest: index (original order) of the nearest point no
  // further than maxRadius, or -1; its distance is left in this.distance.
  nearest(x, y, z, maxRadius = Infinity) {
    this.distance = Infinity;
    if (this.empty) return -1;
    const { axisAt, xyz, boxes, stackLo, stackHi } = this;
    let best = maxRadius === Infinity ? Infinity : maxRadius * maxRadius, bestAt = -1, top = 0;
    stackLo[0] = 0; stackHi[0] = this.count; top = 1;
    while (top > 0) {
      top--;
      const lo = stackLo[top], hi = stackHi[top], mid = (lo + hi) >> 1, at = 6 * mid;
      // Squared distance from the query to the node's box: nothing inside is nearer.
      const bx = x < boxes[at] ? boxes[at] - x : x > boxes[at + 3] ? x - boxes[at + 3] : 0;
      const by = y < boxes[at + 1] ? boxes[at + 1] - y : y > boxes[at + 4] ? y - boxes[at + 4] : 0;
      const bz = z < boxes[at + 2] ? boxes[at + 2] - z : z > boxes[at + 5] ? z - boxes[at + 5] : 0;
      if (bx * bx + by * by + bz * bz >= best) continue;
      if (hi - lo <= KD_LEAF) {
        for (let p = lo; p < hi; p++) {
          const dx = xyz[3 * p] - x, dy = xyz[3 * p + 1] - y, dz = xyz[3 * p + 2] - z, d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < best) { best = d2; bestAt = p; }
        }
        continue;
      }
      const dx = xyz[3 * mid] - x, dy = xyz[3 * mid + 1] - y, dz = xyz[3 * mid + 2] - z, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) { best = d2; bestAt = mid; }
      const axis = axisAt[mid], diff = (axis === 0 ? x : axis === 1 ? y : z) - xyz[3 * mid + axis];
      // The near side is pushed last, so it is searched first.
      if (diff < 0) {
        if (hi > mid + 1) { stackLo[top] = mid + 1; stackHi[top++] = hi; }
        if (mid > lo) { stackLo[top] = lo; stackHi[top++] = mid; }
      } else {
        if (mid > lo) { stackLo[top] = lo; stackHi[top++] = mid; }
        if (hi > mid + 1) { stackLo[top] = mid + 1; stackHi[top++] = hi; }
      }
    }
    if (bestAt < 0) return -1;
    this.distance = Math.sqrt(best);
    return this.order[bestAt];
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

// Closest point of triangle t to (x, y, z), written to `out`; returns the
// squared distance (closest-point regions, after Ericson, Real-Time Collision
// Detection 5.1.5).
export function closestPointOnTriangle(p, t, x, y, z, out) {
  const i = 9 * t, ax = p[i], ay = p[i + 1], az = p[i + 2];
  const abx = p[i + 3] - ax, aby = p[i + 4] - ay, abz = p[i + 5] - az, acx = p[i + 6] - ax, acy = p[i + 7] - ay, acz = p[i + 8] - az;
  const apx = x - ax, apy = y - ay, apz = z - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const at = (qx, qy, qz) => { out[0] = qx; out[1] = qy; out[2] = qz; return (x - qx) ** 2 + (y - qy) ** 2 + (z - qz) ** 2; };
  if (d1 <= 0 && d2 <= 0) return at(ax, ay, az);
  const bpx = x - p[i + 3], bpy = y - p[i + 4], bpz = z - p[i + 5];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return at(p[i + 3], p[i + 4], p[i + 5]);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return at(ax + v * abx, ay + v * aby, az + v * abz); }
  const cpx = x - p[i + 6], cpy = y - p[i + 7], cpz = z - p[i + 8];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return at(p[i + 6], p[i + 7], p[i + 8]);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return at(ax + w * acx, ay + w * acy, az + w * acz); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + d5 - d6);
    return at(p[i + 3] + w * (p[i + 6] - p[i + 3]), p[i + 4] + w * (p[i + 7] - p[i + 4]), p[i + 5] + w * (p[i + 8] - p[i + 5]));
  }
  const denominator = 1 / (va + vb + vc), v = vb * denominator, w = vc * denominator;
  return at(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

const scratchPoint = [0, 0, 0];
function pointTriangleDistance2(p, t, x, y, z) { return closestPointOnTriangle(p, t, x, y, z, scratchPoint); }

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
