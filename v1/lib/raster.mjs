// CPU depth rasterizer and ray caster shared by the scorer, the drawing renderer,
// the contestant preview tool and the evidence-visibility check. Deterministic,
// no GPU, no native dependencies.
//
// Camera convention (both kinds): `right` and `up` are unit vectors in model
// space, `forward = up x right` is the viewing direction, and depth grows along
// `forward`. Pixel (0, 0) is the top-left corner; pixel centres are at +0.5.
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const normalize = a => { const length = Math.hypot(...a); if (!(length > 0)) throw new Error('Zero-length vector'); return scale(a, 1 / length); };

// extent = [uMin, uMax, vMin, vMax] in metres along right / up, measured from origin.
export function orthoCamera({ origin, right, up, extent, width, height }) {
  right = normalize(right); up = normalize(up);
  if (Math.abs(dot(right, up)) > 1e-6) throw new Error('Camera right and up must be perpendicular');
  if (!(extent[1] > extent[0]) || !(extent[3] > extent[2])) throw new Error('Empty camera extent');
  return { type: 'ortho', origin: [...origin], right, up, forward: cross(up, right), extent: [...extent], width, height };
}

export function perspectiveCamera({ position, forward, target, up = [0, 1, 0], fov_y_deg, width, height, near = 0.05 }) {
  forward = normalize(forward ?? sub(target, position));
  // Looking straight up or down leaves no horizontal "right" for a +Y up hint.
  if (Math.hypot(...cross(forward, up)) < 1e-6) up = [0, 0, -1];
  const right = normalize(cross(forward, up));
  const focal = height / 2 / Math.tan(fov_y_deg * Math.PI / 360);
  return { type: 'perspective', position: [...position], right, up: cross(right, forward), forward,
    fx: focal, fy: focal, cx: width / 2, cy: height / 2, width, height, near };
}

// Named orthographic views. "left" and "right" are the viewer's left and right
// when facing the front facade, i.e. the -X and +X sides of the model.
const VIEW_BASIS = {
  front: { right: [1, 0, 0], up: [0, 1, 0] },
  rear: { right: [-1, 0, 0], up: [0, 1, 0] },
  right: { right: [0, 0, -1], up: [0, 1, 0] },
  left: { right: [0, 0, 1], up: [0, 1, 0] },
  top: { right: [1, 0, 0], up: [0, 0, -1] },
};
export const NAMED_VIEWS = Object.keys(VIEW_BASIS);

export function orthoViewOfBounds(bounds, view, { margin = 0.08, pixelsPerMetre, width } = {}) {
  const basis = VIEW_BASIS[view];
  if (!basis) throw new Error('Unknown view ' + view);
  const origin = bounds.min.map((value, i) => (value + bounds.max[i]) / 2);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const p = [0, 1, 2].map(i => (corner >> i & 1 ? bounds.max[i] : bounds.min[i]) - origin[i]);
    const u = dot(p, basis.right), v = dot(p, basis.up);
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const pad = Math.max(u1 - u0, v1 - v0) * margin;
  u0 -= pad; u1 += pad; v0 -= pad; v1 += pad;
  const density = pixelsPerMetre ?? (width ?? 512) / (u1 - u0);
  return orthoCamera({ origin, right: basis.right, up: basis.up, extent: [u0, u1, v0, v1],
    width: Math.max(1, Math.round((u1 - u0) * density)), height: Math.max(1, Math.round((v1 - v0) * density)) });
}

// Model point -> [pixelX, pixelY, depth]. For a perspective camera a depth at or
// behind `near` means the point is not in front of the camera.
export function projectPoint(camera, p) {
  if (camera.type === 'ortho') {
    const q = sub(p, camera.origin), [u0, u1, v0, v1] = camera.extent;
    return [(dot(q, camera.right) - u0) / (u1 - u0) * camera.width, (v1 - dot(q, camera.up)) / (v1 - v0) * camera.height, dot(q, camera.forward)];
  }
  const q = sub(p, camera.position), z = dot(q, camera.forward);
  return [camera.cx + camera.fx * dot(q, camera.right) / z, camera.cy - camera.fy * dot(q, camera.up) / z, z];
}

export function unproject(camera, x, y, depth) {
  if (camera.type === 'ortho') {
    const [u0, u1, v0, v1] = camera.extent;
    const u = u0 + x / camera.width * (u1 - u0), v = v1 - y / camera.height * (v1 - v0);
    return [0, 1, 2].map(i => camera.origin[i] + u * camera.right[i] + v * camera.up[i] + depth * camera.forward[i]);
  }
  const a = (x - camera.cx) / camera.fx * depth, b = -(y - camera.cy) / camera.fy * depth;
  return [0, 1, 2].map(i => camera.position[i] + a * camera.right[i] + b * camera.up[i] + depth * camera.forward[i]);
}

// Renders the nearest surface per pixel. Returns
//   depth  Float32Array(width * height), Infinity where nothing was hit
//   tri    Int32Array(width * height), triangle index into the soup, -1 where empty
// Triangles are double-sided; winding is ignored.
export function render(soup, camera) {
  const { width, height } = camera, count = width * height;
  const depth = new Float32Array(count).fill(Infinity), tri = new Int32Array(count).fill(-1);
  const perspective = camera.type === 'perspective', positions = soup.positions;
  const [u0, u1, v0, v1] = perspective ? [0, 0, 0, 0] : camera.extent;
  const base = perspective ? camera.position : camera.origin, { right, up, forward } = camera;
  // Screen-space fill. w is depth for ortho and 1/depth for perspective, which
  // is what interpolates linearly on screen.
  function fill(ax, ay, aw, bx, by, bw, cx, cy, cw, index) {
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-12) return;
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5)), x1 = Math.min(width - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5)), y1 = Math.min(height - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const l0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
      const l1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
      const l2 = 1 - l0 - l1;
      if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
      const w = l0 * aw + l1 * bw + l2 * cw, d = perspective ? 1 / w : w, at = y * width + x;
      if (d < depth[at]) { depth[at] = d; tri[at] = index; }
    }
  }
  const cam = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let t = 0; t < soup.triangles; t++) {
    for (let j = 0; j < 3; j++) {
      const at = t * 9 + j * 3, x = positions[at] - base[0], y = positions[at + 1] - base[1], z = positions[at + 2] - base[2];
      cam[j][0] = x * right[0] + y * right[1] + z * right[2];
      cam[j][1] = x * up[0] + y * up[1] + z * up[2];
      cam[j][2] = x * forward[0] + y * forward[1] + z * forward[2];
    }
    if (!perspective) {
      const sx = j => (cam[j][0] - u0) / (u1 - u0) * width, sy = j => (v1 - cam[j][1]) / (v1 - v0) * height;
      fill(sx(0), sy(0), cam[0][2], sx(1), sy(1), cam[1][2], sx(2), sy(2), cam[2][2], t);
      continue;
    }
    // Clip against the near plane, then fan the resulting polygon.
    const near = camera.near, polygon = [];
    for (let j = 0; j < 3; j++) {
      const a = cam[j], b = cam[(j + 1) % 3], inA = a[2] >= near, inB = b[2] >= near;
      if (inA) polygon.push(a);
      if (inA !== inB) { const k = (near - a[2]) / (b[2] - a[2]); polygon.push([a[0] + k * (b[0] - a[0]), a[1] + k * (b[1] - a[1]), near]); }
    }
    if (polygon.length < 3) continue;
    const screen = polygon.map(p => [camera.cx + camera.fx * p[0] / p[2], camera.cy - camera.fy * p[1] / p[2], 1 / p[2]]);
    for (let j = 1; j + 1 < screen.length; j++) fill(...screen[0], ...screen[j], ...screen[j + 1], t);
  }
  return { width, height, depth, tri };
}

// Nearest intersection of a ray with the soup, or null. Double-sided.
export function raycast(soup, origin, direction, { maxDistance = Infinity } = {}) {
  const p = soup.positions, [ox, oy, oz] = origin, [dx, dy, dz] = direction;
  let best = maxDistance, hit = -1;
  for (let t = 0; t < soup.triangles; t++) {
    const i = t * 9;
    const e1x = p[i + 3] - p[i], e1y = p[i + 4] - p[i + 1], e1z = p[i + 5] - p[i + 2];
    const e2x = p[i + 6] - p[i], e2y = p[i + 7] - p[i + 1], e2z = p[i + 8] - p[i + 2];
    const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-14) continue;
    const sx = ox - p[i], sy = oy - p[i + 1], sz = oz - p[i + 2];
    const u = (sx * hx + sy * hy + sz * hz) / det;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) / det;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const distance = (e2x * qx + e2y * qy + e2z * qz) / det;
    if (distance > 1e-9 && distance < best) { best = distance; hit = t; }
  }
  return hit < 0 ? null : { distance: best, tri: hit, point: [ox + dx * best, oy + dy * best, oz + dz * best] };
}

// Geometric unit normal of a soup triangle (orientation follows winding).
export function triangleNormal(soup, t) {
  const p = soup.positions, i = t * 9;
  const n = cross([p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]], [p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]]);
  const length = Math.hypot(...n);
  return length > 0 ? scale(n, 1 / length) : [0, 0, 0];
}
