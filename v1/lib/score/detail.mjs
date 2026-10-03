import { PointGrid } from './grid.mjs';
import { frameBox, renderSurface, VoxelSet, towardsViewer, expandBox } from './sampling.mjs';
import { coverageMask } from './coverage.mjs';
import { round } from './metrics.mjs';

// DESIGN.md 9.6. Each model group is looked at from its facade, framed on its
// own box at a third of its detail size per pixel, so a window frame or a post
// is sampled finely even when the headline sample is far too coarse to see it.
export const DETAIL_TAU_FACTOR = 0.6;
export const LOCAL_OFFSET_FRACTION = 0.02;
export const MIN_EVIDENCED_FRACTION = 0.5;
// A detail match needs a surface within tau_g that also faces the same way
// (normals within 45 degrees). Without this, whatever touches a missing
// element — the roof around a chimney's foot, the reveal around a window
// frame — would "recall" a strip of it as wide as tau_g.
export const NORMAL_AGREEMENT_DEG = 45;
const MIN_COS = Math.cos(NORMAL_AGREEMENT_DEG * Math.PI / 180);
const MAX_DETAIL_PIXELS = 1024;

export const FACADE_NORMALS = { front: [0, 0, 1], rear: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0] };
const HEADINGS = { front: 0, right: 90, rear: 180, left: 270 };

// Viewer directions per facade: straight on, two obliques, one from above.
// A roof is looked at from above and from the four sides at 45 degrees; a
// group that wraps the whole object ("all") from the eight headings and above.
export function facadeViews(facade) {
  if (facade in HEADINGS) {
    const heading = HEADINGS[facade];
    return [towardsViewer(heading, 0), towardsViewer(heading - 35, 10), towardsViewer(heading + 35, 10), towardsViewer(heading, 50)];
  }
  if (facade === 'roof') return [[0, 1, 0], ...[0, 90, 180, 270].map(heading => towardsViewer(heading, 45))];
  return [...[0, 90, 180, 270].map(heading => towardsViewer(heading, 0)), ...[45, 135, 225, 315].map(heading => towardsViewer(heading, 30)), [0, 1, 0]];
}

const inside = (box, x, y, z) => x >= box.min[0] && x <= box.max[0] && y >= box.min[1] && y <= box.max[1] && z >= box.min[2] && z <= box.max[2];

// Truth surfaces inside `box`, hidden faces included, on an in-plane lattice
// of `spacing` plus samples along each edge (so thin triangles are not
// skipped). Returns points, unit normals and part indices.
function sampleSurfaces(soup, box, spacing, keepPart) {
  const points = [], normals = [], parts = [], p = soup.positions;
  const add = (x, y, z, n, part) => { if (inside(box, x, y, z)) { points.push(x, y, z); normals.push(...n); parts.push(part); } };
  for (let t = 0; t < soup.triangles; t++) {
    if (!keepPart(soup.triPart[t])) continue;
    const a = [p[9 * t], p[9 * t + 1], p[9 * t + 2]], b = [p[9 * t + 3], p[9 * t + 4], p[9 * t + 5]], c = [p[9 * t + 6], p[9 * t + 7], p[9 * t + 8]];
    if ([0, 1, 2].some(i => Math.max(a[i], b[i], c[i]) < box.min[i] || Math.min(a[i], b[i], c[i]) > box.max[i])) continue;
    const e1 = [0, 1, 2].map(i => b[i] - a[i]), e2 = [0, 1, 2].map(i => c[i] - a[i]);
    const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const area2 = Math.hypot(...cross), length = Math.hypot(...e1);
    if (!(area2 > 0) || !(length > 0)) continue;
    const n = cross.map(v => v / area2), u = e1.map(v => v / length), v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const cu = e2[0] * u[0] + e2[1] * u[1] + e2[2] * u[2], cv = e2[0] * v[0] + e2[1] * v[1] + e2[2] * v[2], part = soup.triPart[t];
    for (let y = spacing / 2; y < cv; y += spacing) {
      const left = cu * y / cv, right = length + (cu - length) * y / cv;
      for (let x = Math.ceil(left / spacing - 0.5) * spacing + spacing / 2; x < right; x += spacing) {
        add(a[0] + x * u[0] + y * v[0], a[1] + x * u[1] + y * v[1], a[2] + x * u[2] + y * v[2], n, part);
      }
    }
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) / spacing));
      for (let k = 0; k < steps; k++) {
        const w = (k + 0.5) / steps;
        add(from[0] + w * (to[0] - from[0]), from[1] + w * (to[1] - from[1]), from[2] + w * (to[2] - from[2]), n, part);
      }
    }
  }
  return { points: Float64Array.from(points), normals: Float32Array.from(normals), parts: Int32Array.from(parts) };
}

// Truth side, computed once per context.
export function prepareGroups({ model, soup, diagonal, maps }) {
  const partIndex = new Map(soup.parts.map((id, i) => [id, i]));
  const maxOffset = LOCAL_OFFSET_FRACTION * diagonal;
  return (model.groups ?? []).map(group => {
    const parts = new Uint8Array(soup.parts.length);
    for (const part of model.parts) if (part.group === group.id && partIndex.has(part.id)) parts[partIndex.get(part.id)] = 1;
    const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let t = 0; t < soup.triangles; t++) {
      if (!parts[soup.triPart[t]]) continue;
      for (let k = 0; k < 9; k++) {
        const axis = k % 3, value = soup.positions[9 * t + k];
        if (value < box.min[axis]) box.min[axis] = value;
        if (value > box.max[axis]) box.max[axis] = value;
      }
    }
    const tau = DETAIL_TAU_FACTOR * group.detail_size_m;
    // The local fit may slide a group along its facade freely (up to maxOffset)
    // but towards or away from it only a little (see limitOffset): depth
    // relief is the detail being scored, and a flat facade slid back onto a
    // recessed door plane is not a door.
    const reliefNormal = FACADE_NORMALS[group.facade] ?? (group.facade === 'roof' ? [0, 1, 0] : null);
    const base = { id: group.id, title: group.title, category: group.category, facade: group.facade, detail_size_m: group.detail_size_m, tau, maxOffset, parts, reliefNormal };
    if (!Number.isFinite(box.min[0])) return { ...base, scored: false, reason: 'group has no geometry' };
    const scoreBox = expandBox(box, 2 * tau), gatherBox = expandBox(box, 2 * tau + maxOffset);
    const directions = facadeViews(group.facade);
    const framed = directions.map(direction => frameBox(direction, gatherBox, { pixel: group.detail_size_m / 3, maxPixels: MAX_DETAIL_PIXELS }));
    const cameras = framed.map(item => item.camera), pixel = Math.max(...framed.map(item => item.pixel));
    // The truth set: what these views show of the group's own parts.
    const seen = new VoxelSet(pixel, gatherBox.min);
    renderSurface(soup, cameras, (x, y, z, t, nx, ny, nz) => { if (parts[soup.triPart[t]] && inside(gatherBox, x, y, z)) seen.add(x, y, z, t, nx, ny, nz); });
    const visible = seen.finish();
    const evidenced = coverageMask(maps, visible.points, visible.normals, diagonal);
    const evidencedCount = evidenced.reduce((sum, value) => sum + value, 0);
    const evidencedFraction = visible.count ? evidencedCount / visible.count : 0;
    // Every truth surface near the group, hidden faces included: a candidate
    // element is attributed to the part whose real surface it lies on, so the
    // candidate's gable top is gable even where the truth hides it under a
    // roof the candidate lacks. Where two parts' surfaces coincide (a frame's
    // outer side against its wall reveal, a buttress against its wall) the
    // normal's direction decides: lattice normals follow the truth's outward
    // winding and a candidate's visible surface faces its viewer, so an
    // exposed wall patch matches the wall's outward face, not the face of the
    // missing buttress that was glued to it. The group's own lattice is the
    // precision target.
    const lattice = sampleSurfaces(soup, gatherBox, pixel, () => true);
    const pick = (indices, array) => { const out = new array.constructor(indices.length * 3); indices.forEach((i, k) => out.set(array.subarray(3 * i, 3 * i + 3), 3 * k)); return out; };
    const ownIndices = [];
    for (let i = 0; i < lattice.parts.length; i++) if (parts[lattice.parts[i]]) ownIndices.push(i);
    const prepared = {
      ...base, box, scoreBox, gatherBox, cameras, pixel, directions, evidencedFraction,
      truth: { points: visible.points, normals: visible.normals, evidenced, count: visible.count, evidencedCount, grid: new PointGrid(visible.points, 2 * tau) },
      surfaces: { isGroup: Uint8Array.from(lattice.parts, part => parts[part]), normals: lattice.normals, points: lattice.points, grid: new PointGrid(lattice.points, 2 * tau),
        lookup(j) { return this.points.subarray(3 * j, 3 * j + 3); } },
      own: { normals: pick(ownIndices, lattice.normals), grid: new PointGrid(pick(ownIndices, lattice.points), 2 * tau) },
    };
    if (!visible.count) return { ...prepared, scored: false, reason: 'group is hidden in its own views' };
    if (evidencedFraction < MIN_EVIDENCED_FRACTION) return { ...prepared, scored: false, reason: 'only ' + Math.round(100 * evidencedFraction) + ' % of the group is shown by the evidence' };
    return { ...prepared, scored: true, reason: null };
  });
}

// Candidate points the group's views see near the group, in the truth frame.
function candidateNear(group, candidate) {
  const set = new VoxelSet(group.pixel, group.gatherBox.min);
  renderSurface(candidate, group.cameras, (x, y, z, t, nx, ny, nz) => { if (inside(group.gatherBox, x, y, z)) set.add(x, y, z, t, nx, ny, nz); });
  const sample = set.finish();
  return { points: sample.points, normals: sample.normals, count: sample.count, grid: new PointGrid(sample.points, 2 * group.tau) };
}

// Which truth part a candidate surface element stands for: the nearest truth
// surface (within 2 tau) pointing the same way, else facing the same way up to
// sign, else simply the nearest. A roof element beside a chimney's foot is
// roof even where a chimney face is a hair closer. Returns whether that part is in the group; the distance to it
// is left in `attributed.distance`.
const attributed = { distance: Infinity };
function belongs(group, x, y, z, nx, ny, nz) {
  const surfaces = group.surfaces, reach = 2 * group.tau;
  let j = surfaces.grid.nearestFacing(x, y, z, reach, surfaces.normals, nx, ny, nz, MIN_COS, true);
  if (j < 0) j = surfaces.grid.nearestFacing(x, y, z, reach, surfaces.normals, nx, ny, nz, MIN_COS);
  // A wrong model's elements can lie metres from every truth surface: nearestFar.
  if (j < 0) j = surfaces.grid.nearestFar(x, y, z);
  attributed.distance = j < 0 ? Infinity : surfaces.grid.distance;
  return j >= 0 && surfaces.isGroup[j] === 1;
}

// Attribution of every candidate element at zero offset.
function attributeAll(group, candidate) {
  const member = new Uint8Array(candidate.count), distance = new Float64Array(candidate.count), cn = candidate.normals, p = candidate.points;
  for (let i = 0; i < candidate.count; i++) {
    member[i] = belongs(group, p[3 * i], p[3 * i + 1], p[3 * i + 2], cn[3 * i], cn[3 * i + 1], cn[3 * i + 2]) ? 1 : 0;
    distance[i] = attributed.distance;
  }
  return { member, distance };
}

// Precision, recall and F of the group with its candidate geometry shifted by
// delta. The group's candidate geometry is what is attributed to the group at
// zero offset, plus elements the shift explains clearly better than their
// unshifted reading did (a window slid off its opening, now overlapping wall);
// never elements that already lie on another part's real surface (a gable top
// under a missing roof). Precision: those elements inside the group box
// (+2 tau) whose nearest visible group point is evidenced, matched when the
// group's surface lies within tau with an agreeing normal. Recall: evidenced
// visible group points with an agreeing element within tau.
function groupScore(group, candidate, delta, zero) {
  const { truth, own, tau, scoreBox } = group, [dx, dy, dz] = delta, cn = candidate.normals, tn = truth.normals, shifted = dx || dy || dz;
  const members = [];
  let counted = 0, precise = 0, recalled = 0;
  for (let i = 0; i < candidate.count; i++) {
    const x = candidate.points[3 * i] + dx, y = candidate.points[3 * i + 1] + dy, z = candidate.points[3 * i + 2] + dz;
    if (!zero.member[i] && !(shifted && belongs(group, x, y, z, cn[3 * i], cn[3 * i + 1], cn[3 * i + 2]) && attributed.distance + 0.25 * tau < zero.distance[i])) continue;
    members.push(i);
    if (!inside(scoreBox, x, y, z)) continue;
    const k = truth.grid.nearestFar(x, y, z);
    if (k < 0 || !truth.evidenced[k]) continue;
    counted++;
    if (own.grid.anyFacing(x, y, z, tau, own.normals, cn[3 * i], cn[3 * i + 1], cn[3 * i + 2], MIN_COS)) precise++;
  }
  const points = new Float64Array(members.length * 3), normals = new Float32Array(members.length * 3);
  members.forEach((i, k) => { points.set(candidate.points.subarray(3 * i, 3 * i + 3), 3 * k); normals.set(cn.subarray(3 * i, 3 * i + 3), 3 * k); });
  const grid = new PointGrid(points, 2 * tau);
  for (let k = 0; k < truth.count; k++) {
    if (!truth.evidenced[k]) continue;
    if (grid.anyFacing(truth.points[3 * k] - dx, truth.points[3 * k + 1] - dy, truth.points[3 * k + 2] - dz, tau, normals, tn[3 * k], tn[3 * k + 1], tn[3 * k + 2], MIN_COS)) recalled++;
  }
  const precision = counted ? precise / counted : 0, recall = truth.evidencedCount ? recalled / truth.evidencedCount : 0;
  return { precision, recall, f: precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0 };
}

// Translation-only local fit, at most LOCAL_OFFSET_FRACTION of the diagonal:
// a right window a few centimetres out of place is a placement error, not a
// missing window. Only candidate geometry attributed to the group at zero
// offset may move it; otherwise a missing roof is "found" by lifting the gable
// tops, which run parallel to it, onto the slope. Returns the offsets worth
// scoring: a point-to-plane fit from zero, and one from the best point of a
// coarse lattice search (a window slid within its wall plane is pinned only
// by edges and faces the evidence may not show, which no gradient step sees).
function localOffsets(group, candidate, zero) {
  const { truth, tau, maxOffset } = group, cn = candidate.normals;
  const members = [];
  for (let i = 0; i < candidate.count; i++) if (zero.member[i]) members.push(i);
  if (!members.length) return [];
  const points = new Float64Array(members.length * 3), normals = new Float32Array(members.length * 3);
  members.forEach((i, k) => { points.set(candidate.points.subarray(3 * i, 3 * i + 3), 3 * k); normals.set(cn.subarray(3 * i, 3 * i + 3), 3 * k); });
  const set = { points, normals, count: members.length, grid: new PointGrid(points, 2 * tau), depth: facadeDepthOffset(group, candidate, zero) };
  const fitted = planeFit(group, set, [0, 0, 0]);
  // Lattice over the facade plane (all three axes for roofs and wrap-around
  // groups), scored by how many evidenced truth points find an agreeing member.
  const normal = group.reliefNormal, step = Math.max(tau, maxOffset / 7), reach = Math.floor(maxOffset / step);
  const axes = normal ? [0, 1, 2].filter(axis => normal[axis] === 0) : [0, 1, 2];
  const probe = [], tn = truth.normals;
  for (let k = 0, stride = Math.max(1, Math.floor(truth.evidencedCount / 600)), seen = 0; k < truth.count; k++) if (truth.evidenced[k] && seen++ % stride === 0) probe.push(k);
  const agreeing = delta => {
    let hits = 0;
    for (const k of probe) {
      if (set.grid.anyFacing(truth.points[3 * k] - delta[0], truth.points[3 * k + 1] - delta[1], truth.points[3 * k + 2] - delta[2], tau, normals, tn[3 * k], tn[3 * k + 1], tn[3 * k + 2], MIN_COS)) hits++;
    }
    return hits;
  };
  let best = null;
  const lattice = [];
  for (let a = -reach; a <= reach; a++) for (let b = -reach; b <= reach; b++) for (let c = axes.length === 3 ? -reach : 0; c <= (axes.length === 3 ? reach : 0); c++) {
    const delta = [...fitted], steps = [a, b, c];
    axes.forEach((axis, i) => { delta[axis] = (normal ? fitted[axis] : 0) + steps[i] * step; });
    if (Math.hypot(...delta) <= maxOffset) lattice.push(delta);
  }
  for (const delta of lattice) {
    const hits = agreeing(delta);
    if (!best || hits > best.hits) best = { delta, hits };
  }
  const searched = best ? planeFit(group, set, best.delta) : null;
  return searched ? [fitted, searched] : [fitted];
}

// Point-to-plane translation fit of the member points onto the evidenced truth
// sample, from `start`, both pairing directions, shrinking radius.
function planeFit(group, set, start) {
  const { truth, tau, maxOffset } = group, tn = truth.normals, tp = truth.points, points = set.points;
  let delta = [...start], sigma = maxOffset + 2 * tau;
  for (let iteration = 0; iteration < 30; iteration++) {
    // Per direction: normal matrix (6 unique terms), right-hand side, weight.
    const systems = [new Float64Array(10), new Float64Array(10)], c2 = (sigma / 2) ** 2;
    const add = (system, k, rx, ry, rz) => {
      const nx = tn[3 * k], ny = tn[3 * k + 1], nz = tn[3 * k + 2], w = 1 / (1 + (rx * rx + ry * ry + rz * rz) / c2), along = rx * nx + ry * ny + rz * nz;
      system[0] += w * nx * nx; system[1] += w * nx * ny; system[2] += w * nx * nz; system[3] += w * ny * ny; system[4] += w * ny * nz; system[5] += w * nz * nz;
      system[6] += w * nx * along; system[7] += w * ny * along; system[8] += w * nz * along; system[9] += w;
    };
    for (let k = 0; k < truth.count; k++) {
      if (!truth.evidenced[k]) continue;
      // sigma starts at the largest local offset: tens of cells (nearestFar).
      const i = set.grid.nearestFar(tp[3 * k] - delta[0], tp[3 * k + 1] - delta[1], tp[3 * k + 2] - delta[2], sigma);
      if (i >= 0) add(systems[0], k, tp[3 * k] - points[3 * i] - delta[0], tp[3 * k + 1] - points[3 * i + 1] - delta[1], tp[3 * k + 2] - points[3 * i + 2] - delta[2]);
    }
    for (let i = 0; i < set.count; i++) {
      const x = points[3 * i] + delta[0], y = points[3 * i + 1] + delta[1], z = points[3 * i + 2] + delta[2];
      const k = truth.grid.nearestFar(x, y, z, sigma);
      if (k >= 0 && truth.evidenced[k]) add(systems[1], k, tp[3 * k] - x, tp[3 * k + 1] - y, tp[3 * k + 2] - z);
    }
    const live = systems.filter(system => system[9] > 0);
    if (!live.length) break;
    const m = new Float64Array(9);
    for (const system of live) for (let k = 0; k < 9; k++) m[k] += system[k] / system[9];
    // A direction no surface constrains must not move: a small ridge term.
    const ridge = 1e-3 * (m[0] + m[3] + m[5]) + 1e-12;
    const step = solve3([[m[0] + ridge, m[1], m[2]], [m[1], m[3] + ridge, m[4]], [m[2], m[4], m[5] + ridge]], [m[6], m[7], m[8]]);
    const next = limitOffset(group, delta.map((value, axis) => value + step[axis]), set.depth);
    const change = Math.hypot(next[0] - delta[0], next[1] - delta[1], next[2] - delta[2]);
    delta = next;
    sigma = Math.max(2 * tau, sigma * 0.75);
    if (change < 1e-4 * tau && sigma <= 2 * tau) break;
  }
  return delta;
}

// How far the candidate's own facade around the group sits from the truth's,
// along the facade normal: the median over candidate surface that faces the
// same way as the facade and stands for another part (the wall around a
// window, the roof around a chimney). A frame or scale error moves facade and
// group together; only the group's depth relative to this is its relief.
// null when the candidate has no such surface around the group (a chimney on
// a missing roof): with nothing to stand out from, relief cannot be faked and
// the depth is left free.
function facadeDepthOffset(group, candidate, zero) {
  const normal = group.reliefNormal;
  if (!normal) return null;
  const { surfaces, maxOffset, tau } = group, cn = candidate.normals, p = candidate.points, depths = [];
  const others = [];
  for (let i = 0; i < candidate.count; i++) {
    if (zero.member[i]) continue;
    if (Math.abs(cn[3 * i] * normal[0] + cn[3 * i + 1] * normal[1] + cn[3 * i + 2] * normal[2]) >= MIN_COS) others.push(i);
  }
  const stride = Math.max(1, Math.floor(others.length / 1500));
  for (let k = 0; k < others.length; k += stride) {
    const i = others[k];
    const j = surfaces.grid.nearestFacing(p[3 * i], p[3 * i + 1], p[3 * i + 2], maxOffset + 2 * tau, surfaces.normals, cn[3 * i], cn[3 * i + 1], cn[3 * i + 2], MIN_COS);
    if (j < 0 || surfaces.isGroup[j]) continue;
    const at = surfaces.lookup(j);
    depths.push((at[0] - p[3 * i]) * normal[0] + (at[1] - p[3 * i + 1]) * normal[1] + (at[2] - p[3 * i + 2]) * normal[2]);
  }
  if (depths.length < 20) return null;
  depths.sort((a, b) => a - b);
  return Math.max(-maxOffset, Math.min(maxOffset, depths[depths.length >> 1]));
}

// At most maxOffset in all, and along the facade normal at most RELIEF_SLACK
// x tau from the depth offset of the surrounding facade (when there is one). Matching itself
// tolerates tau, so a flat facade reaches relief of (1 + slack) x tau = 0.75 x
// detail size: below the detail size, which is what the group's relief is
// supposed to be (with a full tau of slack, a bare wall "recalled" pilasters
// standing out exactly their detail size).
export const RELIEF_SLACK = 0.25;
function limitOffset(group, delta, depth = null) {
  const normal = group.reliefNormal;
  if (normal && depth !== null) {
    const slack = RELIEF_SLACK * group.tau, along = delta[0] * normal[0] + delta[1] * normal[1] + delta[2] * normal[2], capped = Math.max(depth - slack, Math.min(depth + slack, along));
    delta = delta.map((value, axis) => value + (capped - along) * normal[axis]);
  }
  const length = Math.hypot(...delta);
  return length > group.maxOffset ? delta.map(value => value * group.maxOffset / length) : delta;
}

function solve3(a, b) {
  const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(a);
  if (!(Math.abs(d) > 1e-18)) return [0, 0, 0];
  return [0, 1, 2].map(column => det(a.map((row, r) => row.map((value, c) => (c === column ? b[r] : value)))) / d);
}

// Candidate side. `candidateFor(group)` returns { soup, frameOffset }: the
// candidate in the truth frame the group is judged in, and how far that frame
// moves the group from the global pose; a plain soup means the global pose.
export function scoreGroups(groups, candidateFor) {
  const frameOf = typeof candidateFor === 'function' ? candidateFor : () => ({ soup: candidateFor, frameOffset: 0 });
  const rows = groups.map(group => {
    const row = { id: group.id, title: group.title, category: group.category, scored: group.scored, reason: group.reason,
      evidenced_fraction: group.evidencedFraction === undefined ? null : round(group.evidencedFraction), tau_m: round(group.tau),
      precision: null, recall: null, f: null, local_offset_m: null, frame_offset_m: null };
    if (!group.scored) return row;
    const { soup, frameOffset } = frameOf(group);
    row.frame_offset_m = round(frameOffset);
    const near = candidateNear(group, soup);
    if (!near.count) return { ...row, precision: 0, recall: 0, f: 0, local_offset_m: 0 };
    // The local fit is a courtesy, never a penalty: the best of zero and the fitted offsets.
    const zero = attributeAll(group, near);
    let best = groupScore(group, near, [0, 0, 0], zero), delta = [0, 0, 0];
    for (const offset of localOffsets(group, near, zero)) {
      const scored = groupScore(group, near, offset, zero);
      if (scored.f > best.f) { best = scored; delta = offset; }
    }
    return { ...row, precision: round(best.precision), recall: round(best.recall), f: round(best.f), local_offset_m: round(Math.hypot(...delta)),
      local_offset: delta.map(value => round(value)) };
  });
  const categories = [];
  for (const row of rows) {
    if (!row.scored) continue;
    let category = categories.find(item => item.id === row.category);
    if (!category) categories.push(category = { id: row.category, values: [] });
    category.values.push(row.f);
  }
  const categoryRows = categories.map(item => ({ id: item.id, f: round(item.values.reduce((a, b) => a + b, 0) / item.values.length), groups: item.values.length }));
  const score = categoryRows.length ? round(100 * categoryRows.reduce((sum, item) => sum + item.f, 0) / categoryRows.length, 2) : null;
  return { score, categories: categoryRows, groups: rows, ...(score === null ? { note: 'not evaluated: no group is sufficiently evidenced' } : {}) };
}
