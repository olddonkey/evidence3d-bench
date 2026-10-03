// Geometry checks for generated ground truth. The generator uses probeCheck to
// keep only robust probes; the tests and the orchestrator use the rest to
// confirm that a model is what its JSON claims (dimensions on real edges, no
// z-fighting, not mirror-symmetric).
import { orthoCamera, render, raycast, triangleNormal, cross, dot, normalize } from '../raster.mjs';
import { filterSoup } from '../soup.mjs';

const angleBetween = (a, b) => Math.acos(Math.min(1, Math.abs(dot(a, b)))) * 180 / Math.PI;

function perpendicularBasis(direction) {
  const helper = Math.abs(direction[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = normalize(cross(direction, helper));
  return [e1, cross(direction, e1)];
}

// Casts the probe, then renders a small orthographic depth window looking along it
// (25 x 25 samples over a disc of `radius`, ~2.4 cm apart, so thin rods and rails
// cannot slip between samples). The probe is robust when every sample lands on
// the same part, on a surface within `normalTolDeg` of the centre normal, at a depth
// consistent with the surface slope: i.e. the hit is at least `radius` from any
// edge, so a candidate a few centimetres off still measures the same feature.
export function probeCheck(soup, probe, { radius = 0.3, samples = 25, maxIncidenceDeg = 60, normalTolDeg = 12 } = {}) {
  const centre = raycast(soup, probe.origin, probe.direction);
  if (!centre) return { ok: false, reason: 'miss' };
  const normal = triangleNormal(soup, centre.tri), part = soup.triPart[centre.tri];
  const incidence = angleBetween(normal, probe.direction);
  const result = { ok: true, reason: null, distance: centre.distance, point: centre.point, part: soup.parts[part], incidence };
  if (incidence > maxIncidenceDeg) return { ...result, ok: false, reason: 'grazing ' + incidence.toFixed(1) + ' deg' };
  // right x up ordering so that the camera looks along the probe (forward = up x right).
  const [right] = perpendicularBasis(probe.direction), up = cross(right, probe.direction);
  const camera = orthoCamera({ origin: probe.origin, right, up, extent: [-radius, radius, -radius, radius], width: samples, height: samples });
  const image = render(soup, camera), normals = new Map();
  for (let y = 0; y < samples; y++) for (let x = 0; x < samples; x++) {
    const du = ((x + 0.5) / samples * 2 - 1) * radius, dv = (1 - (y + 0.5) / samples * 2) * radius, r = Math.hypot(du, dv);
    if (r > radius) continue;
    const t = image.tri[y * samples + x];
    if (t < 0) return { ...result, ok: false, reason: 'window misses at ' + r.toFixed(2) + ' m' };
    if (soup.triPart[t] !== part) return { ...result, ok: false, reason: 'window hits ' + soup.parts[soup.triPart[t]] + ' at ' + r.toFixed(2) + ' m' };
    let n = normals.get(t);
    if (!n) normals.set(t, n = triangleNormal(soup, t));
    if (angleBetween(n, normal) > normalTolDeg) return { ...result, ok: false, reason: 'surface turns at ' + r.toFixed(2) + ' m' };
    const slope = Math.tan(Math.max(incidence, angleBetween(n, probe.direction)) * Math.PI / 180);
    if (Math.abs(image.depth[y * samples + x] - centre.distance) > r * slope + 0.02) return { ...result, ok: false, reason: 'surface steps at ' + r.toFixed(2) + ' m' };
  }
  return result;
}

// Crease and boundary edges of a soup: what a line drawing of the model shows.
export function featureEdges(soup, { angleDeg = 20 } = {}) {
  const key = (p, i) => Math.round(p[i] * 2000) + ',' + Math.round(p[i + 1] * 2000) + ',' + Math.round(p[i + 2] * 2000);
  const edges = new Map(), positions = soup.positions;
  for (let t = 0; t < soup.triangles; t++) {
    const n = triangleNormal(soup, t);
    if (!(Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]) > 0)) continue;
    for (let j = 0; j < 3; j++) {
      const a = t * 9 + j * 3, c = t * 9 + ((j + 1) % 3) * 3;
      const ka = key(positions, a), kc = key(positions, c), id = ka < kc ? ka + '|' + kc : kc + '|' + ka;
      let entry = edges.get(id);
      if (!entry) edges.set(id, entry = { a: [positions[a], positions[a + 1], positions[a + 2]], b: [positions[c], positions[c + 1], positions[c + 2]], normals: [] });
      entry.normals.push(n);
    }
  }
  const result = [], limit = Math.cos(angleDeg * Math.PI / 180);
  for (const entry of edges.values()) {
    const ns = entry.normals;
    let crease = ns.length === 1;
    for (let i = 0; i < ns.length && !crease; i++) for (let k = i + 1; k < ns.length && !crease; k++) if (dot(ns[i], ns[k]) < limit) crease = true;
    if (crease) result.push([entry.a, entry.b]);
  }
  return result;
}

const VIEW_DROP = { front: 2, rear: 2, left: 0, right: 0, plan: 1, top: 1 };

// Distance, in the dimension's drawing plane, from each endpoint to the nearest
// projected feature edge. Both near zero means a draughtsman could put the
// dimension on lines the elevation or plan actually shows.
export function dimensionEdgeDistances(edges, dimension) {
  const drop = VIEW_DROP[dimension.view], keep = [0, 1, 2].filter(i => i !== drop);
  const flat = p => [p[keep[0]], p[keep[1]]];
  const distance = point => {
    const [px, py] = flat(point);
    let best = Infinity;
    for (const [a, b] of edges) {
      const [ax, ay] = flat(a), [bx, by] = flat(b), dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
      const t = length > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d < best) best = d;
    }
    return best;
  };
  return { a: distance(dimension.a), b: distance(dimension.b), offAxis: Math.abs(dimension.b[drop] - dimension.a[drop]) };
}

// Orthographic camera looking at the bounds from azimuth (0 = from the front, +Z;
// 90 = from the right, +X) and elevation above the horizon, in degrees.
export function viewCamera(bounds, azimuthDeg, elevationDeg, { width = 640, margin = 0.04 } = {}) {
  const az = azimuthDeg * Math.PI / 180, el = elevationDeg * Math.PI / 180;
  const forward = [-Math.sin(az) * Math.cos(el), -Math.sin(el), -Math.cos(az) * Math.cos(el)];
  const right = elevationDeg >= 89.9 ? [Math.cos(az), 0, -Math.sin(az)] : normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const origin = bounds.min.map((v, i) => (v + bounds.max[i]) / 2);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const p = [0, 1, 2].map(i => (corner >> i & 1 ? bounds.max[i] : bounds.min[i]) - origin[i]);
    const u = dot(p, right), v = dot(p, up);
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const pad = Math.max(u1 - u0, v1 - v0) * margin;
  u0 -= pad; u1 += pad; v0 -= pad; v1 += pad;
  const height = Math.max(1, Math.round(width * (v1 - v0) / (u1 - u0)));
  return orthoCamera({ origin, right, up, extent: [u0, u1, v0, v1], width, height });
}

// The views a photograph or drawing of a building is normally taken from.
export const STANDARD_VIEWS = [
  ['front', 0, 0], ['right', 90, 0], ['rear', 180, 0], ['left', 270, 0], ['top', 0, 90],
  ['front-right', 45, 30], ['rear-right', 135, 30], ['rear-left', 225, 30], ['front-left', 315, 30],
];

// Z-fighting detector. A pixel z-fights when, besides its nearest surface, a
// surface of a *different part* lies within `eps` of the same depth and is
// (anti)parallel to it: a GPU depth buffer cannot order the two. Returns the
// flagged share of covered pixels and the worst part pairs.
export function zFightReport(soup, camera, { eps = 0.015, parallelDeg = 10 } = {}) {
  const image = render(soup, camera), { width, height } = camera, [u0, u1, v0, v1] = camera.extent;
  const normals = new Float64Array(soup.triangles * 3);
  for (let t = 0; t < soup.triangles; t++) normals.set(triangleNormal(soup, t), t * 3);
  const flagged = new Uint8Array(width * height), pairs = new Map(), limit = Math.cos(parallelDeg * Math.PI / 180);
  const { right, up, forward, origin } = camera, p = soup.positions, s = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let t = 0; t < soup.triangles; t++) {
    for (let j = 0; j < 3; j++) {
      const at = t * 9 + j * 3, x = p[at] - origin[0], y = p[at + 1] - origin[1], z = p[at + 2] - origin[2];
      s[j][0] = (x * right[0] + y * right[1] + z * right[2] - u0) / (u1 - u0) * width;
      s[j][1] = (v1 - (x * up[0] + y * up[1] + z * up[2])) / (v1 - v0) * height;
      s[j][2] = x * forward[0] + y * forward[1] + z * forward[2];
    }
    const [[ax, ay, aw], [bx, by, bw], [cx, cy, cw]] = s;
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-12) continue;
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5)), x1 = Math.min(width - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5)), y1 = Math.min(height - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    const part = soup.triPart[t];
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
      const qx = px + 0.5, qy = py + 0.5;
      const l0 = ((by - cy) * (qx - cx) + (cx - bx) * (qy - cy)) / den, l1 = ((cy - ay) * (qx - cx) + (ax - cx) * (qy - cy)) / den, l2 = 1 - l0 - l1;
      if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
      const at = py * width + px, nearest = image.tri[at];
      if (nearest < 0 || soup.triPart[nearest] === part) continue;
      const depth = l0 * aw + l1 * bw + l2 * cw;
      if (Math.abs(depth - image.depth[at]) >= eps) continue;
      const n = nearest * 3, c = Math.abs(normals[n] * normals[t * 3] + normals[n + 1] * normals[t * 3 + 1] + normals[n + 2] * normals[t * 3 + 2]);
      if (c < limit) continue;
      if (!flagged[at]) {
        flagged[at] = 1;
        const names = [soup.parts[soup.triPart[nearest]], soup.parts[part]].sort().join(' | ');
        pairs.set(names, (pairs.get(names) ?? 0) + 1);
      }
    }
  }
  let covered = 0, count = 0;
  for (let i = 0; i < flagged.length; i++) { if (image.tri[i] >= 0) covered++; count += flagged[i]; }
  return { covered, flagged: count, fraction: covered ? count / covered : 0,
    pairs: [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8) };
}

// Share of pixels (among those either soup covers) where two renders disagree on
// coverage or on depth by more than `depthTol` metres.
export function depthDifference(soupA, soupB, camera, { depthTol = 0.25 } = {}) {
  const a = render(soupA, camera), b = render(soupB, camera);
  let union = 0, differ = 0;
  for (let i = 0; i < a.tri.length; i++) {
    const ha = a.tri[i] >= 0, hb = b.tri[i] >= 0;
    if (!ha && !hb) continue;
    union++;
    if (ha !== hb || Math.abs(a.depth[i] - b.depth[i]) > depthTol) differ++;
  }
  return union ? differ / union : 0;
}

// How different a soup is from its mirror image (axis 0: left/right, 2: front/rear)
// once the best shift along that axis is applied: the scorer fits translation, so
// a difference a shift can remove is not one it can detect. Pixels from the
// views are pooled; depth differences count beyond `depthTol` (default 1 % of
// the diagonal).
export function mirrorDifference(soup, axis, { views, width = 360, shiftFraction = 0.2, steps = 40, depthTol } = {}) {
  const mirrored = mirrorSoup(soup, axis), extent = soup.bounds.max[axis] - soup.bounds.min[axis];
  const tol = depthTol ?? 0.01 * diagonal(soup.bounds), reach = shiftFraction * extent;
  const grown = { min: [...soup.bounds.min], max: [...soup.bounds.max] };
  grown.min[axis] -= reach; grown.max[axis] += reach;
  const cameras = (views ?? (axis === 0 ? [[0, 0], [0, 90]] : [[90, 0], [0, 90]])).map(([az, el]) => viewCamera(grown, az, el, { width }));
  const originals = cameras.map(camera => render(soup, camera));
  const evaluate = shift => {
    const positions = Float64Array.from(mirrored.positions);
    for (let i = axis; i < positions.length; i += 3) positions[i] += shift;
    const moved = { ...mirrored, positions };
    let union = 0, differ = 0;
    cameras.forEach((camera, v) => {
      const a = originals[v], b = render(moved, camera);
      for (let i = 0; i < a.tri.length; i++) {
        const ha = a.tri[i] >= 0, hb = b.tri[i] >= 0;
        if (!ha && !hb) continue;
        union++;
        if (ha !== hb || Math.abs(a.depth[i] - b.depth[i]) > tol) differ++;
      }
    });
    return union ? differ / union : 0;
  };
  // Coarse search over the whole range, then a fine one round the best coarse shift.
  let best = Infinity, bestShift = 0;
  const step = 2 * reach / steps;
  const consider = shift => { const value = evaluate(shift); if (value < best) { best = value; bestShift = shift; } };
  for (let k = 0; k <= steps; k++) consider(-reach + k * step);
  const centre = bestShift;
  for (let k = -4; k <= 4; k++) if (k) consider(centre + k * step / 5);
  return { difference: best, shift: bestShift };
}

// Mirror image of a soup across the plane through its bounds centre normal to `axis`.
export function mirrorSoup(soup, axis) {
  const centre = (soup.bounds.min[axis] + soup.bounds.max[axis]) / 2, positions = Float64Array.from(soup.positions);
  for (let i = axis; i < positions.length; i += 3) positions[i] = 2 * centre - positions[i];
  return { ...soup, positions };
}

// Half-turn about the vertical axis through the bounds centre.
export function halfTurnSoup(soup) {
  const cx = (soup.bounds.min[0] + soup.bounds.max[0]) / 2, cz = (soup.bounds.min[2] + soup.bounds.max[2]) / 2, positions = Float64Array.from(soup.positions);
  for (let i = 0; i < positions.length; i += 3) { positions[i] = 2 * cx - positions[i]; positions[i + 2] = 2 * cz - positions[i + 2]; }
  return { ...soup, positions };
}

export const diagonal = bounds => Math.hypot(...bounds.max.map((v, i) => v - bounds.min[i]));

// ---------------------------------------------------------------------------
// Group relief: can a group be told from its absence at its own detail size?
//
// The scorer judges a group at tau_g = 0.6 x detail_size_m, matching surface
// points that lie within tau_g and face the same way (45 degrees). A group whose
// surface lies that close to what is behind or beside it (a plinth 3 cm proud of
// its wall, a spandrel 7 cm proud of the glass) is "recalled" by a model that
// leaves it out. This mirrors that test without depending on the scorer: the
// group's visible surface is sampled from the views the scorer uses for its
// facade, the model without the group is sampled from the same views, and each
// group point gets the distance to the nearest remaining point facing the same
// way. `relief_m` is the median of those distances: the depth by which at least
// half of the group's visible surface stands out from its absence.

const towardsViewer = (headingDeg, elevationDeg) => {
  const a = headingDeg * Math.PI / 180, e = elevationDeg * Math.PI / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
};
const FACADE_HEADINGS = { front: 0, right: 90, rear: 180, left: 270 };

// Viewer directions per facade, as the scorer looks at a group (DESIGN.md 9.6):
// straight on, two obliques and one from above; a roof from above and the four
// sides; a group on every side from eight headings and above.
export function facadeDirections(facade) {
  if (facade in FACADE_HEADINGS) {
    const h = FACADE_HEADINGS[facade];
    return [towardsViewer(h, 0), towardsViewer(h - 35, 10), towardsViewer(h + 35, 10), towardsViewer(h, 50)];
  }
  if (facade === 'roof') return [[0, 1, 0], ...[0, 90, 180, 270].map(h => towardsViewer(h, 45))];
  return [...[0, 90, 180, 270].map(h => towardsViewer(h, 0)), ...[45, 135, 225, 315].map(h => towardsViewer(h, 30)), [0, 1, 0]];
}

// Orthographic camera looking against `toViewer`, framed on a box at about `pixel` metres per pixel.
function boxCamera(toViewer, box, pixel, maxPixels) {
  const forward = toViewer.map(v => -v);
  const right = Math.abs(forward[1]) > 0.999 ? [1, 0, 0] : normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward), origin = box.min.map((v, i) => (v + box.max[i]) / 2);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const p = [0, 1, 2].map(i => (corner >> i & 1 ? box.max[i] : box.min[i]) - origin[i]);
    const u = dot(p, right), v = dot(p, up);
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const step = Math.max(pixel, (u1 - u0) / maxPixels, (v1 - v0) / maxPixels);
  const width = Math.max(1, Math.ceil((u1 - u0) / step)), height = Math.max(1, Math.ceil((v1 - v0) / step));
  return orthoCamera({ origin, right, up, extent: [u0, u0 + width * step, v0, v0 + height * step], width, height });
}

// Visible surface points of a render inside `box` with their unit normals turned
// towards the viewer, appended to `out` as flat [x, y, z, nx, ny, nz] runs.
function visiblePoints(soup, normals, camera, keep, box, out) {
  const image = render(soup, camera), [u0, u1, v0, v1] = camera.extent, { width, height, origin, right, up, forward } = camera;
  const du = (u1 - u0) / width, dv = (v1 - v0) / height, [bx0, by0, bz0] = box.min, [bx1, by1, bz1] = box.max;
  for (let y = 0; y < height; y++) {
    const v = v1 - (y + 0.5) * dv;
    for (let x = 0; x < width; x++) {
      const at = y * width + x, t = image.tri[at];
      if (t < 0 || !keep[soup.triPart[t]]) continue;
      const u = u0 + (x + 0.5) * du, d = image.depth[at];
      const px = origin[0] + u * right[0] + v * up[0] + d * forward[0];
      const py = origin[1] + u * right[1] + v * up[1] + d * forward[1];
      const pz = origin[2] + u * right[2] + v * up[2] + d * forward[2];
      if (px < bx0 || px > bx1 || py < by0 || py > by1 || pz < bz0 || pz > bz1) continue;
      let nx = normals[3 * t], ny = normals[3 * t + 1], nz = normals[3 * t + 2];
      if (nx * forward[0] + ny * forward[1] + nz * forward[2] > 0) { nx = -nx; ny = -ny; nz = -nz; }
      out.push(px, py, pz, nx, ny, nz);
    }
  }
}

function soupNormals(soup) {
  const normals = new Float64Array(soup.triangles * 3);
  for (let t = 0; t < soup.triangles; t++) normals.set(triangleNormal(soup, t), 3 * t);
  return normals;
}

export function groupRelief(model, soup, { pixelsPerDetail = 3, maxPixels = 240, maxQueries = 6000, normalDeg = 45 } = {}) {
  const minCos = Math.cos(normalDeg * Math.PI / 180), partIndex = new Map(soup.parts.map((id, i) => [id, i]));
  const normals = soupNormals(soup);
  return model.groups.map(group => {
    const own = new Uint8Array(soup.parts.length);
    for (const part of model.parts) if (part.group === group.id) own[partIndex.get(part.id)] = 1;
    const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let t = 0; t < soup.triangles; t++) {
      if (!own[soup.triPart[t]]) continue;
      for (let k = 0; k < 9; k++) { const axis = k % 3, value = soup.positions[9 * t + k]; box.min[axis] = Math.min(box.min[axis], value); box.max[axis] = Math.max(box.max[axis], value); }
    }
    const reach = 2 * group.detail_size_m, grown = { min: box.min.map(v => v - reach - 0.05), max: box.max.map(v => v + reach + 0.05) };
    const rest = own.map(flag => 1 - flag), without = filterSoup(soup, (id, index) => !own[index]), withoutNormals = soupNormals(without);
    const groupPoints = [], restPoints = [];
    for (const direction of facadeDirections(group.facade)) {
      const camera = boxCamera(direction, grown, group.detail_size_m / pixelsPerDetail, maxPixels);
      visiblePoints(soup, normals, camera, own, grown, groupPoints);
      visiblePoints(without, withoutNormals, camera, rest, grown, restPoints);
    }
    // Uniform grid over the remaining surface (cell = detail size, searched 2 cells
    // out); distances beyond `reach` count as far. Keys pack three indices below
    // 2^15 in magnitude (coordinates within 500 m at the finest 1.7 cm voxel).
    const cell = group.detail_size_m, cells = new Map(), O = 1 << 15, key = (i, j, k) => ((i + O) * 2 * O + (j + O)) * 2 * O + (k + O);
    // The views overlap: keep one remaining point per small voxel and facing direction.
    const fine = cell / pixelsPerDetail, seen = new Set();
    for (let r = 0; r < restPoints.length; r += 6) {
      const ax = Math.abs(restPoints[r + 3]), ay = Math.abs(restPoints[r + 4]), az = Math.abs(restPoints[r + 5]);
      const facing = ax >= ay && ax >= az ? (restPoints[r + 3] > 0 ? 0 : 1) : ay >= az ? (restPoints[r + 4] > 0 ? 2 : 3) : (restPoints[r + 5] > 0 ? 4 : 5);
      const voxel = key(Math.floor(restPoints[r] / fine), Math.floor(restPoints[r + 1] / fine), Math.floor(restPoints[r + 2] / fine)) * 8 + facing;
      if (seen.has(voxel)) continue;
      seen.add(voxel);
      const id = key(Math.floor(restPoints[r] / cell), Math.floor(restPoints[r + 1] / cell), Math.floor(restPoints[r + 2] / cell));
      let list = cells.get(id);
      if (!list) cells.set(id, list = []);
      list.push(r);
    }
    const count = groupPoints.length / 6, stride = Math.max(1, Math.ceil(count / maxQueries)), distances = [];
    for (let g = 0; g < count; g += stride) {
      const at = 6 * g, px = groupPoints[at], py = groupPoints[at + 1], pz = groupPoints[at + 2], nx = groupPoints[at + 3], ny = groupPoints[at + 4], nz = groupPoints[at + 5];
      const ci = Math.floor(px / cell), cj = Math.floor(py / cell), ck = Math.floor(pz / cell);
      let best = Infinity;
      for (let i = ci - 2; i <= ci + 2; i++) for (let j = cj - 2; j <= cj + 2; j++) for (let k = ck - 2; k <= ck + 2; k++) {
        const list = cells.get(key(i, j, k));
        if (!list) continue;
        for (const r of list) {
          if (nx * restPoints[r + 3] + ny * restPoints[r + 4] + nz * restPoints[r + 5] < minCos) continue;
          const dx = px - restPoints[r], dy = py - restPoints[r + 1], dz = pz - restPoints[r + 2], d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < best) best = d2;
        }
      }
      best = Math.sqrt(best);
      distances.push(best <= reach ? best : Infinity);
    }
    distances.sort((a, b) => a - b);
    const share = limit => distances.length ? distances.filter(d => d <= limit).length / distances.length : 0;
    const median = distances.length ? distances[Math.floor((distances.length - 1) / 2)] : 0;
    return {
      id: group.id, detail_size_m: group.detail_size_m, samples: distances.length,
      relief_m: median,
      // Share of the group's visible surface a model without it would still "recall".
      absent_recall_tau: share(0.6 * group.detail_size_m), absent_recall_detail: share(group.detail_size_m),
    };
  });
}
