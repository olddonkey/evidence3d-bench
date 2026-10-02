import { render } from '../raster.mjs';
import { soupFromOccluders, mergeSoups } from '../soup.mjs';

// DESIGN.md 9.3. A ground-truth point is "evidenced" when at least one supplied,
// non-stale item with a camera shows it: it projects inside the image, it is the
// nearest surface there once the item's occluders are drawn, and that surface is
// not seen more than 80 degrees off its normal. Plans and notes add nothing.
export const GRAZING_LIMIT_DEG = 80;
const COS_LIMIT = Math.cos(GRAZING_LIMIT_DEG * Math.PI / 180), TAN_LIMIT = Math.tan(GRAZING_LIMIT_DEG * Math.PI / 180);
// Visibility is decided at the scorer's own resolution, not the delivered one:
// a 1600 px photograph and a 1280 px depth map agree on what is in view.
export const COVERAGE_MAX_PIXELS = 1280;

export function scaleCameraTo(camera, maxPixels) {
  const factor = maxPixels / Math.max(camera.width, camera.height);
  if (factor >= 1) return camera;
  const width = Math.max(1, Math.round(camera.width * factor)), height = Math.max(1, Math.round(camera.height * factor));
  if (camera.type === 'ortho') return { ...camera, width, height };
  const sx = width / camera.width, sy = height / camera.height;
  return { ...camera, fx: camera.fx * sx, fy: camera.fy * sy, cx: camera.cx * sx, cy: camera.cy * sy, width, height };
}

// Which supplied items can give coverage, and why the others cannot.
export function coverageItems(items) {
  const used = [], ignored = [];
  for (const item of items) {
    if ((item.source_model ?? 'primary') !== 'primary') ignored.push({ id: item.id, reason: 'stale: rendered from ' + item.source_model });
    else if (item.kind === 'plan' || item.kind === 'notes') ignored.push({ id: item.id, reason: item.kind + ' adds no coverage' });
    else if (!item.camera || !['ortho', 'perspective'].includes(item.camera.type)) ignored.push({ id: item.id, reason: 'no camera' });
    else used.push(item);
  }
  return { used, ignored };
}

// One depth map per usable item: the given geometry plus that item's occluders.
export function coverageMaps(soup, items, { maxPixels = COVERAGE_MAX_PIXELS } = {}) {
  const { used, ignored } = coverageItems(items);
  const maps = used.map(item => {
    const camera = scaleCameraTo(item.camera, maxPixels);
    const occluders = soupFromOccluders(item.occluders ?? []);
    const scene = occluders.triangles ? mergeSoups([soup, occluders]) : soup;
    return { id: item.id, kind: item.kind, camera, depth: render(scene, camera).depth };
  });
  return { maps, ignored };
}

// For each point (xyz triples, unit normals) the number of maps that show it,
// capped at 255. `diagonal` sets the depth tolerance floor (0.2 % of it).
export function coverageCounts(maps, points, normals, diagonal) {
  const count = points.length / 3, out = new Uint8Array(count), floor = 0.002 * diagonal;
  for (const { camera, depth } of maps) {
    const perspective = camera.type === 'perspective', { width, height, right, up, forward } = camera;
    const base = perspective ? camera.position : camera.origin;
    const [u0, u1, v0, v1] = perspective ? [0, 1, 0, 1] : camera.extent;
    const orthoFoot = (u1 - u0) / width;
    for (let i = 0; i < count; i++) {
      const qx = points[3 * i] - base[0], qy = points[3 * i + 1] - base[1], qz = points[3 * i + 2] - base[2];
      const z = qx * forward[0] + qy * forward[1] + qz * forward[2];
      const u = qx * right[0] + qy * right[1] + qz * right[2], v = qx * up[0] + qy * up[1] + qz * up[2];
      let px, py, foot, cos;
      const nx = normals[3 * i], ny = normals[3 * i + 1], nz = normals[3 * i + 2];
      if (perspective) {
        if (!(z > camera.near)) continue;
        px = camera.cx + camera.fx * u / z; py = camera.cy - camera.fy * v / z;
        foot = z / camera.fx;
        const length = Math.hypot(qx, qy, qz);
        cos = Math.abs(qx * nx + qy * ny + qz * nz) / length;
      } else {
        px = (u - u0) / (u1 - u0) * width; py = (v1 - v) / (v1 - v0) * height;
        foot = orthoFoot;
        cos = Math.abs(forward[0] * nx + forward[1] * ny + forward[2] * nz);
      }
      if (!(px >= 0 && px < width && py >= 0 && py < height)) continue;
      if (cos < COS_LIMIT) continue;
      // The depth map holds the surface at the pixel centre; a sample anywhere in
      // the pixel on a slanted surface differs from it by up to a pixel's slope.
      const tan = Math.min(TAN_LIMIT, Math.sqrt(Math.max(0, 1 - cos * cos)) / Math.max(cos, 1e-9));
      const surface = depth[Math.floor(py) * width + Math.floor(px)];
      if (z <= surface + foot * (1 + tan) + floor && out[i] < 255) out[i]++;
    }
  }
  return out;
}

// Returns test(x, y, z) -> true when some item's camera looks through that
// point at something farther away (or at nothing): the evidence shows the
// place to be empty. Used to count candidate surface in precision even when
// its nearest ground-truth surface was never shown — a copy of the house
// standing beside it in the front photograph is junk the photograph shows.
// `margin` keeps surfaces lying on the truth (or within a pixel of it) out.
export function emptySpaceTest(maps, margin) {
  const prepared = maps.map(({ camera, depth }) => {
    const perspective = camera.type === 'perspective';
    return { camera, depth, perspective, base: perspective ? camera.position : camera.origin, extent: perspective ? null : camera.extent };
  });
  return (x, y, z) => {
    for (const { camera, depth, perspective, base, extent } of prepared) {
      const { width, height, right, up, forward } = camera;
      const qx = x - base[0], qy = y - base[1], qz = z - base[2];
      const d = qx * forward[0] + qy * forward[1] + qz * forward[2];
      const u = qx * right[0] + qy * right[1] + qz * right[2], v = qx * up[0] + qy * up[1] + qz * up[2];
      let px, py, foot;
      if (perspective) {
        if (!(d > camera.near)) continue;
        px = camera.cx + camera.fx * u / d; py = camera.cy - camera.fy * v / d; foot = d / camera.fx;
      } else {
        px = (u - extent[0]) / (extent[1] - extent[0]) * width; py = (extent[3] - v) / (extent[3] - extent[2]) * height; foot = (extent[1] - extent[0]) / width;
      }
      if (!(px >= 0 && px < width && py >= 0 && py < height)) continue;
      if (d < depth[Math.floor(py) * width + Math.floor(px)] - margin - 2 * foot) return true;
    }
    return false;
  };
}

export function coverageMask(maps, points, normals, diagonal) {
  const counts = coverageCounts(maps, points, normals, diagonal);
  for (let i = 0; i < counts.length; i++) counts[i] = counts[i] ? 1 : 0;
  return counts;
}
