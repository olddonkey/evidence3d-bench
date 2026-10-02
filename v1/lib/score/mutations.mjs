import { transformSoup, soupBounds } from '../soup.mjs';
import { render } from '../raster.mjs';
import { rng } from '../rng.mjs';
import { frameBox, towardsViewer, boxDiagonal, boxCentre, triangleNormals, SAMPLING_DIRECTIONS } from './sampling.mjs';
import { FACADE_NORMALS } from './detail.mjs';

// Soup-level defect injectors for calibration and tests. Each factory returns
// { id, apply(soup, context) -> soup }; `soup` is normally the ground-truth soup
// (part ids = model part ids) and `context` the scoring context, which the
// group-aware mutations use to look up groups and facades.
function makeSoup(positions, triPart, colors, parts) {
  const triangles = triPart.length;
  return { positions, triPart, colors, parts, triangles, bounds: triangles ? soupBounds(positions) : { min: [0, 0, 0], max: [0, 0, 0] } };
}

function concat(a, b) {
  const positions = new Float64Array(a.positions.length + b.positions.length);
  positions.set(a.positions); positions.set(b.positions, a.positions.length);
  const colors = new Float32Array(a.colors.length + b.colors.length);
  colors.set(a.colors); colors.set(b.colors, a.colors.length);
  const triPart = new Int32Array(a.triangles + b.triangles);
  triPart.set(a.triPart); for (let t = 0; t < b.triangles; t++) triPart[a.triangles + t] = b.triPart[t] + a.parts.length;
  return makeSoup(positions, triPart, colors, [...a.parts, ...b.parts]);
}

function keepTriangles(soup, keep) {
  const kept = [];
  for (let t = 0; t < soup.triangles; t++) if (keep(t)) kept.push(t);
  const positions = new Float64Array(kept.length * 9), triPart = new Int32Array(kept.length), colors = new Float32Array(kept.length * 3);
  for (const [i, t] of kept.entries()) {
    positions.set(soup.positions.subarray(9 * t, 9 * t + 9), 9 * i);
    colors.set(soup.colors.subarray(3 * t, 3 * t + 3), 3 * i);
    triPart[i] = soup.triPart[t];
  }
  return makeSoup(positions, triPart, colors, soup.parts);
}

// Each triangle -> four, through its edge midpoints; same surface, 4^levels as many triangles.
export function subdivide(soup, levels = 1) {
  let current = soup;
  for (let level = 0; level < levels; level++) {
    const p = current.positions, T = current.triangles;
    const positions = new Float64Array(T * 36), triPart = new Int32Array(T * 4), colors = new Float32Array(T * 12);
    for (let t = 0; t < T; t++) {
      const a = [p[9 * t], p[9 * t + 1], p[9 * t + 2]], b = [p[9 * t + 3], p[9 * t + 4], p[9 * t + 5]], c = [p[9 * t + 6], p[9 * t + 7], p[9 * t + 8]];
      const mid = (u, v) => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2, (u[2] + v[2]) / 2];
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]].forEach((tri, k) => {
        positions.set([...tri[0], ...tri[1], ...tri[2]], 9 * (4 * t + k));
        triPart[4 * t + k] = current.triPart[t];
        colors.set(current.colors.subarray(3 * t, 3 * t + 3), 3 * (4 * t + k));
      });
    }
    current = makeSoup(positions, triPart, colors, current.parts);
  }
  return current;
}

// Longest-edge bisection until no edge exceeds maxEdge (same surface).
export function refineEdges(soup, maxEdge) {
  const positions = [], triPart = [], colors = [], p = soup.positions;
  for (let t = 0; t < soup.triangles; t++) {
    const stack = [[[p[9 * t], p[9 * t + 1], p[9 * t + 2]], [p[9 * t + 3], p[9 * t + 4], p[9 * t + 5]], [p[9 * t + 6], p[9 * t + 7], p[9 * t + 8]]]];
    while (stack.length) {
      const tri = stack.pop(), lengths = [0, 1, 2].map(k => Math.hypot(...[0, 1, 2].map(i => tri[(k + 1) % 3][i] - tri[k][i])));
      const longest = lengths.indexOf(Math.max(...lengths));
      if (lengths[longest] <= maxEdge) {
        positions.push(...tri[0], ...tri[1], ...tri[2]); triPart.push(soup.triPart[t]); colors.push(soup.colors[3 * t], soup.colors[3 * t + 1], soup.colors[3 * t + 2]);
        continue;
      }
      const a = tri[longest], b = tri[(longest + 1) % 3], c = tri[(longest + 2) % 3], m = a.map((value, i) => (value + b[i]) / 2);
      stack.push([a, m, c], [m, b, c]);
    }
  }
  return makeSoup(Float64Array.from(positions), Int32Array.from(triPart), Float32Array.from(colors), soup.parts);
}

function groupParts(soup, context, group) {
  const parts = new Set(context.model.parts.filter(part => part.group === group).map(part => part.id));
  if (!parts.size) throw new Error('Unknown or empty group ' + group);
  return Uint8Array.from(soup.parts, id => parts.has(id) ? 1 : 0);
}

function box(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];
  return Float64Array.from(faces.flatMap(face => face.flatMap(i => v[i])));
}

function meanColour(soup) {
  const sum = [0, 0, 0];
  for (let t = 0; t < soup.triangles; t++) for (let i = 0; i < 3; i++) sum[i] += soup.colors[3 * t + i];
  return sum.map(value => value / Math.max(1, soup.triangles));
}

const solid = (positions, colour, part) => makeSoup(positions, new Int32Array(positions.length / 9), Float32Array.from({ length: positions.length / 3 }, (_, i) => colour[i % 3]), [part]);

export const mutations = {
  identity: () => ({ id: 'identity', apply: soup => soup }),

  retessellate: (levels = 1) => ({ id: 'retessellate(' + levels + ')', apply: soup => subdivide(soup, levels) }),

  // Part names carry no meaning for the scorer; shuffle them.
  rename: (seed = 3) => ({ id: 'rename', apply: soup => {
    const random = rng(seed), names = soup.parts.map((_, i) => 'mesh-' + i);
    for (let i = names.length - 1; i > 0; i--) { const j = random.int(0, i); [names[i], names[j]] = [names[j], names[i]]; }
    return { ...soup, parts: names };
  } }),

  // Every part gets an unrelated random base colour.
  recolor: (seed = 5) => ({ id: 'recolor', apply: soup => {
    const random = rng(seed), palette = soup.parts.map(() => [random.next(), random.next(), random.next()]);
    const colors = new Float32Array(soup.triangles * 3);
    for (let t = 0; t < soup.triangles; t++) colors.set(palette[soup.triPart[t]], 3 * t);
    return { ...soup, colors };
  } }),

  // Rigid moves of the whole model; defaults are proportional to its size.
  shift: offset => ({ id: 'shift', apply: soup => {
    const d = boxDiagonal(soup.bounds);
    return transformSoup(soup, { translation: offset ?? [0.21 * d, 0.03 * d, -0.14 * d] });
  } }),
  yaw: (degrees = 37) => ({ id: 'yaw(' + degrees + ')', apply: soup => transformSoup(soup, { yaw: degrees * Math.PI / 180 }) }),
  scale: factor => ({ id: 'scale(' + factor + ')', apply: soup => transformSoup(soup, { scale: factor }) }),

  mirrorX: () => ({ id: 'mirrorX', apply: soup => {
    const positions = Float64Array.from(soup.positions, (value, i) => i % 3 === 0 ? -value : value);
    return makeSoup(positions, soup.triPart, soup.colors, soup.parts);
  } }),

  dropGroup: group => ({ id: 'dropGroup(' + group + ')', apply: (soup, context) => {
    const parts = groupParts(soup, context, group);
    return keepTriangles(soup, t => !parts[soup.triPart[t]]);
  } }),

  // Collapses the group's relief along its facade normal onto one plane: by
  // default the facade surface it sits on (the most common depth of other
  // visible truth surfaces behind the group's footprint), i.e. the group is
  // painted onto the wall instead of modelled.
  flattenGroup: (group, { plane } = {}) => ({ id: 'flattenGroup(' + group + ')', apply: (soup, context) => {
    const spec = context.model.groups.find(item => item.id === group);
    const normal = FACADE_NORMALS[spec?.facade] ?? (spec?.facade === 'roof' ? [0, 1, 0] : null);
    if (!normal) throw new Error('flattenGroup needs a group on a facade or roof, not ' + spec?.facade);
    const axis = normal.findIndex(value => value !== 0), parts = groupParts(soup, context, group);
    const level = plane ?? facadePlane(context, group, axis);
    const positions = Float64Array.from(soup.positions);
    for (let t = 0; t < soup.triangles; t++) if (parts[soup.triPart[t]]) for (let j = 0; j < 3; j++) positions[9 * t + 3 * j + axis] = level;
    return makeSoup(positions, soup.triPart, soup.colors, soup.parts);
  } }),

  // The bounding box only.
  massingBox: () => ({ id: 'massingBox', apply: soup => solid(box(soup.bounds.min, soup.bounds.max), meanColour(soup), 'box') }),

  // What a contestant with only a front photograph can build: surfaces seen
  // from the front (headings within 30 degrees, elevations 0 to 30) that face
  // the front (normal within `facing` degrees of +Z). Side walls, the rear and
  // the back roof slope are left out. Triangles are first split to 2 % of the
  // size so the shell follows the visible edge instead of whole wall panels.
  frontShell: ({ heading = 30, elevation = 30, facing = 80 } = {}) => ({ id: 'frontShell', apply: soup => {
    const d = boxDiagonal(soup.bounds), fine = refineEdges(soup, 0.02 * d), seen = new Uint8Array(fine.triangles);
    const normals = triangleNormals(fine), minZ = Math.cos(facing * Math.PI / 180);
    for (const a of [-heading, -heading / 2, 0, heading / 2, heading]) for (const e of [0, elevation / 2, elevation]) {
      const toViewer = towardsViewer(a, e), { camera } = frameBox(toViewer, fine.bounds, { pixel: 0.0025 * d, margin: 0.01 * d });
      const image = render(fine, camera);
      for (const t of image.tri) {
        if (t < 0 || seen[t]) continue;
        const towards = normals[3 * t] * toViewer[0] + normals[3 * t + 1] * toViewer[1] + normals[3 * t + 2] * toViewer[2] >= 0 ? 1 : -1;
        if (towards * normals[3 * t + 2] >= minZ) seen[t] = 1;
      }
    }
    return keepTriangles(fine, t => seen[t]);
  } }),

  // A square ground plane under the model, `size` times its larger footprint side.
  addGroundPlane: ({ size = 3 } = {}) => ({ id: 'addGroundPlane', apply: soup => {
    const { min, max } = soup.bounds, centre = boxCentre(soup.bounds), half = size * Math.max(max[0] - min[0], max[2] - min[2]) / 2, y = min[1];
    const corners = [[centre[0] - half, y, centre[2] - half], [centre[0] + half, y, centre[2] - half], [centre[0] + half, y, centre[2] + half], [centre[0] - half, y, centre[2] + half]];
    const positions = Float64Array.from([corners[0], corners[2], corners[1], corners[0], corners[3], corners[2]].flat());
    return concat(soup, solid(positions, [0.18, 0.24, 0.12], 'ground'));
  } }),

  // A shrunken copy of the model inside it: hidden geometry, neither rewarded
  // nor punished. On a non-convex object part of the copy pokes out, so the
  // copy is split finely and whatever any sampling view can see is removed:
  // what remains is hidden by construction.
  addInterior: ({ factor = 0.35 } = {}) => ({ id: 'addInterior', apply: soup => {
    const centre = boxCentre(soup.bounds), d = boxDiagonal(soup.bounds);
    const copy = refineEdges(transformSoup(soup, { scale: factor, translation: centre.map(value => value * (1 - factor)) }), 0.02 * d);
    // Removing the copy's visible faces can expose faces of the copy behind
    // them (through a window, say), so repeat until nothing of it shows.
    let merged = concat(soup, { ...copy, parts: soup.parts.map(id => 'interior-' + id) });
    for (let round = 0; round < 12; round++) {
      const seen = new Uint8Array(merged.triangles);
      let exposed = 0;
      for (const direction of SAMPLING_DIRECTIONS) {
        const { camera } = frameBox(direction, soup.bounds, { pixel: 0.0015 * d, margin: 0.01 * d });
        for (const t of render(merged, camera).tri) if (t >= soup.triangles && !seen[t]) { seen[t] = 1; exposed++; }
      }
      if (!exposed) break;
      merged = keepTriangles(merged, t => t < soup.triangles || !seen[t]);
    }
    return merged;
  } }),

  // Junk away from the model: a copy of it beside itself.
  addDuplicate: ({ offset } = {}) => ({ id: 'addDuplicate', apply: soup => {
    const width = soup.bounds.max[0] - soup.bounds.min[0];
    const copy = transformSoup(soup, { translation: offset ?? [1.5 * width, 0, 0] });
    return concat(soup, { ...copy, parts: soup.parts.map(id => 'copy-' + id) });
  } }),
};

// Depth (along `axis`) of the surface a facade group sits on: the most common
// depth of non-group truth samples that lie behind the group's footprint.
function facadePlane(context, group, axis) {
  const prepared = context.groups.find(item => item.id === group), surface = context.surface;
  const groupBox = prepared.box, lateral = [0, 1, 2].filter(i => i !== axis), bin = 0.01, counts = new Map();
  for (let i = 0; i < surface.count; i++) {
    const part = context.soup.triPart[surface.tri[i]];
    if (prepared.parts[part]) continue;
    const p = [surface.points[3 * i], surface.points[3 * i + 1], surface.points[3 * i + 2]];
    if (lateral.some(k => p[k] < groupBox.min[k] - 0.25 || p[k] > groupBox.max[k] + 0.25)) continue;
    if (p[axis] < groupBox.min[axis] - 1 || p[axis] > groupBox.max[axis] + 1) continue;
    const key = Math.round(p[axis] / bin);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (!counts.size) return groupBox.max[axis];
  const [key] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return key * bin;
}
