// Flat-shaded CPU renderer for triangle soups. It is shared by the contestant
// preview tool (which runs inside a sandbox next to a copy of the kernel
// rasterizer) and by the benchmark's own report, so a contestant previewing its
// model sees exactly the picture the report will later show.
//
// It takes the rasterizer module as an argument instead of importing it: in the
// repository the kernel lives at v1/lib/raster.mjs, in an installed kit at
// ./kernel/raster.mjs, and this file must work in both places unchanged.
//
// A soup here needs only { positions: Float64Array(9T), triangles: T } and,
// unless clay mode is on, colors: Float32Array(3T) in linear sRGB.

const VIEW_NAMES = ['front', 'rear', 'left', 'right', 'top', 'iso', 'iso-rear'];
// Three-quarter views: azimuth measured from the front (+Z) towards the right
// (+X), elevation above the horizon. iso sees front + right, iso-rear rear + left.
const PERSPECTIVE_VIEWS = { iso: { azimuth: 35, elevation: 26 }, 'iso-rear': { azimuth: 215, elevation: 26 } };
const PERSPECTIVE_FOV_DEG = 35;

export const DEFAULT_SHADING = Object.freeze({
  clay: false,
  background: '#f3f2ee',
  clayColor: '#c8c3ba',
  ambient: 0.34,
  diffuse: 0.58,
  fill: 0.14,
  edges: true,
  edgeColor: '#2a2d31',
  edgeStrength: 0.5,
  creaseDeg: 28,
  ground: false,
  groundY: 0,
  grid: false,
  supersample: 1,
});

// sRGB <-> linear for colour components in [0, 1].
export const srgbToLinear = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
export const linearToSrgb = c => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

// '#rrggbb' or [r, g, b] bytes (sRGB) -> linear floats.
export function parseColor(value) {
  let bytes = value;
  if (typeof value === 'string') {
    if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error('Colour must be #rrggbb: ' + value);
    bytes = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
  }
  if (!Array.isArray(bytes) || bytes.length !== 3 || !bytes.every(v => Number.isFinite(v) && v >= 0 && v <= 255)) {
    throw new Error('Colour must be #rrggbb or [r, g, b] bytes');
  }
  return bytes.map(v => srgbToLinear(v / 255));
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const combine = (...terms) => {
  const out = [0, 0, 0];
  for (const [vector, weight] of terms) for (let i = 0; i < 3; i++) out[i] += vector[i] * weight;
  const length = Math.hypot(...out);
  return out.map(v => v / length);
};

// Grid spacing on a 1-5-10 ladder so lines are at least `minPixels` apart.
function gridSpacing(metresPerPixel, minPixels) {
  for (let exponent = -3; exponent <= 6; exponent++) {
    for (const mantissa of [1, 5]) {
      const minor = mantissa * 10 ** exponent;
      if (minor / metresPerPixel >= minPixels) return { minor_m: minor, major_m: mantissa === 1 ? minor * 5 : minor * 2 };
    }
  }
  return { minor_m: 1e7, major_m: 1e7 };
}

// Coverage of a 1-pixel line at coordinate `value` with screen derivative `width`.
function lineCoverage(value, spacing, width) {
  const distance = Math.abs(value / spacing - Math.round(value / spacing)) * spacing;
  return Math.max(0, 1 - distance / Math.max(width, 1e-12));
}

export function createShader(raster) {
  if (typeof raster?.render !== 'function' || typeof raster?.orthoViewOfBounds !== 'function' || typeof raster?.perspectiveCamera !== 'function') {
    throw new Error('createShader needs the kernel rasterizer module');
  }

  // Camera with every pixel split into factor x factor sub-pixels.
  function scaleCamera(camera, factor) {
    if (camera.type === 'ortho') return { ...camera, width: camera.width * factor, height: camera.height * factor };
    return { ...camera, width: camera.width * factor, height: camera.height * factor,
      fx: camera.fx * factor, fy: camera.fy * factor, cx: camera.cx * factor, cy: camera.cy * factor };
  }

  function triangleNormals(soup) {
    const p = soup.positions, normals = new Float32Array(soup.triangles * 3);
    for (let t = 0; t < soup.triangles; t++) {
      const i = t * 9;
      const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
      const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, length = Math.hypot(nx, ny, nz);
      if (length > 0) { normals[t * 3] = nx / length; normals[t * 3 + 1] = ny / length; normals[t * 3 + 2] = nz / length; }
    }
    return normals;
  }

  // Shades one view. Lighting is camera-relative (a key light over the viewer's
  // left shoulder, a weak fill from the right and a sky-tinted ambient) so every
  // named view reads equally well; it is a preview look, not a physical one.
  // Returns { width, height, pixels: Uint8Array RGB, covered, grid }.
  function shadeSoup(soup, camera, options = {}) {
    // Explicitly undefined options fall back to the defaults instead of erasing them.
    const o = { ...DEFAULT_SHADING };
    for (const [name, value] of Object.entries(options ?? {})) if (value !== undefined) o[name] = value;
    const factor = Number.isFinite(o.supersample) ? Math.max(1, Math.min(4, Math.round(o.supersample))) : 1;
    const cam = factor === 1 ? camera : scaleCamera(camera, factor);
    const { width: W, height: H } = cam, count = W * H;
    const frame = raster.render(soup, cam);
    const { depth, tri } = frame;
    const ortho = cam.type === 'ortho', { right, up, forward } = cam;
    const normals = triangleNormals(soup);
    const colors = o.clay ? null : soup.colors;
    if (!o.clay && !(colors && colors.length >= soup.triangles * 3)) throw new Error('shadeSoup needs soup.colors or clay mode');
    const clay = parseColor(o.clayColor), background = parseColor(o.background), edgeColor = parseColor(o.edgeColor);
    const key = combine([forward, -1], [up, 0.55], [right, -0.45]);
    const fill = combine([forward, -0.5], [right, 0.8], [up, -0.1]);
    const [kx, ky, kz] = key, [fx, fy, fz] = fill;
    const metresPerPixel = ortho ? (cam.extent[1] - cam.extent[0]) / W : 0;

    // Per-pixel facing normal (towards the viewer), reused by the edge pass.
    const facing = new Float32Array(count * 3), linear = new Float32Array(count * 3);
    let covered = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const at = y * W + x, t = tri[at];
        if (t < 0) continue;
        covered++;
        let vx = forward[0], vy = forward[1], vz = forward[2];
        if (!ortho) {
          const a = (x + 0.5 - cam.cx) / cam.fx, b = -(y + 0.5 - cam.cy) / cam.fy;
          vx += a * right[0] + b * up[0]; vy += a * right[1] + b * up[1]; vz += a * right[2] + b * up[2];
        }
        let nx = normals[t * 3], ny = normals[t * 3 + 1], nz = normals[t * 3 + 2];
        if (nx * vx + ny * vy + nz * vz > 0) { nx = -nx; ny = -ny; nz = -nz; }
        facing[at * 3] = nx; facing[at * 3 + 1] = ny; facing[at * 3 + 2] = nz;
        const light = o.ambient * (0.82 + 0.18 * ny) + o.diffuse * Math.max(0, nx * kx + ny * ky + nz * kz) +
          o.fill * Math.max(0, nx * fx + ny * fy + nz * fz);
        for (let c = 0; c < 3; c++) linear[at * 3 + c] = (colors ? colors[t * 3 + c] : clay[c]) * light;
      }
    }

    if (o.edges && o.edgeStrength > 0) {
      // Edges are drawn on the nearer side of a depth step, at silhouettes, and
      // where the facing normal turns by more than creaseDeg between triangles.
      // `g` grows with depth and is linear on screen for planar surfaces (depth
      // for ortho, -1/depth for perspective), so its second difference is zero
      // on any plane however grazing, and large only across a real step.
      const cosCrease = Math.cos(o.creaseDeg * Math.PI / 180), stepPixels = 2 * factor;
      const g = at => ortho ? depth[at] : -1 / depth[at];
      const isStep = (at, before, after) => {
        const lap = g(before) - 2 * g(at) + g(after);
        return ortho ? lap > stepPixels * metresPerPixel : lap * depth[at] * cam.fx > stepPixels;
      };
      const mark = new Uint8Array(count);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const at = y * W + x, t = tri[at];
          if (t < 0) continue;
          let edge = false;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nxp = x + dx, nyp = y + dy;
            if (nxp < 0 || nyp < 0 || nxp >= W || nyp >= H) continue;
            const other = nyp * W + nxp;
            if (tri[other] < 0) { edge = true; break; }
            if (tri[other] !== t && (dx > 0 || dy > 0)) {
              const cosine = facing[at * 3] * facing[other * 3] + facing[at * 3 + 1] * facing[other * 3 + 1] + facing[at * 3 + 2] * facing[other * 3 + 2];
              if (cosine < cosCrease) { edge = true; break; }
            }
          }
          if (!edge && x > 0 && x < W - 1 && tri[at - 1] >= 0 && tri[at + 1] >= 0 && isStep(at, at - 1, at + 1)) edge = true;
          if (!edge && y > 0 && y < H - 1 && tri[at - W] >= 0 && tri[at + W] >= 0 && isStep(at, at - W, at + W)) edge = true;
          if (edge) mark[at] = 1;
        }
      }
      // Supersampled lines are widened to one output pixel, so line weight does
      // not depend on the supersampling factor.
      const paint = new Uint8Array(count);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (!mark[y * W + x]) continue;
          for (let j = 0; j < factor && y + j < H; j++) for (let i = 0; i < factor && x + i < W; i++) paint[(y + j) * W + x + i] = 1;
        }
      }
      for (let at = 0; at < count; at++) {
        if (!paint[at] || tri[at] < 0) continue;
        for (let c = 0; c < 3; c++) linear[at * 3 + c] += (edgeColor[c] - linear[at * 3 + c]) * o.edgeStrength;
      }
    }

    const grid = backdrop(cam, tri, linear, background, o, metresPerPixel, factor);
    return { ...downsample(linear, W, H, factor), covered: Math.round(covered / (factor * factor)), grid };
  }

  // Fills empty pixels: plain background, plus an optional metric grid (ortho:
  // in the view plane, aligned to model axes; perspective: on the ground plane)
  // and an optional shadow-free ground. The grid never covers the model.
  function backdrop(cam, tri, linear, background, o, metresPerPixel, factor) {
    const { width: W, height: H } = cam, ortho = cam.type === 'ortho', { right, up, forward } = cam;
    const ground = background.map(c => c * 0.86), minor = background.map(c => c * 0.78), major = background.map(c => c * 0.62);
    const axis = parseColor('#b0563f');
    let grid = null;
    if (o.grid && ortho) grid = gridSpacing(metresPerPixel * factor, 30);
    const position = cam.position;
    const drawGround = !ortho && (o.ground || o.grid) && position[1] > o.groundY;
    const blend = (at, colour, amount) => { for (let c = 0; c < 3; c++) linear[at * 3 + c] += (colour[c] - linear[at * 3 + c]) * amount; };
    // Ground hit of the ray through screen point (x, y) as [x, z, ray dy], or null.
    const groundPoint = (x, y) => {
      const a = (x - cam.cx) / cam.fx, b = -(y - cam.cy) / cam.fy;
      const dy = forward[1] + a * right[1] + b * up[1];
      if (dy >= -1e-9) return null;
      const s = (o.groundY - position[1]) / dy;
      return [position[0] + s * (forward[0] + a * right[0] + b * up[0]), position[2] + s * (forward[2] + a * right[2] + b * up[2]), dy];
    };
    if (o.grid && drawGround) {
      // Grid step from the ground footprint of one output pixel, measured down
      // the image centre line where the ground first appears (the camera may
      // look at or above the horizon).
      for (const row of [0.5, 0.7, 0.9, 0.99]) {
        const here = groundPoint(W / 2, row * H), next = groundPoint(W / 2, row * H + factor);
        if (here && next) { grid = gridSpacing(Math.hypot(here[0] - next[0], here[1] - next[1]), 12); break; }
      }
    }
    const originU = ortho ? dot(cam.origin, right) : 0, originV = ortho ? dot(cam.origin, up) : 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const at = y * W + x;
        if (tri[at] >= 0) continue;
        for (let c = 0; c < 3; c++) linear[at * 3 + c] = background[c];
        if (ortho) {
          if (!grid) continue;
          const u = originU + cam.extent[0] + (x + 0.5) / W * (cam.extent[1] - cam.extent[0]);
          const v = originV + cam.extent[3] - (y + 0.5) / H * (cam.extent[3] - cam.extent[2]);
          // One output pixel wide whatever the supersampling factor.
          const width = metresPerPixel * factor;
          blend(at, minor, 0.7 * Math.max(lineCoverage(u, grid.minor_m, width), lineCoverage(v, grid.minor_m, width)));
          blend(at, major, 0.8 * Math.max(lineCoverage(u, grid.major_m, width * 1.6), lineCoverage(v, grid.major_m, width * 1.6)));
          blend(at, axis, 0.85 * Math.max(lineCoverage(u, 1e9, width * 1.6), lineCoverage(v, 1e9, width * 1.6)));
          continue;
        }
        if (!drawGround) continue;
        const here = groundPoint(x + 0.5, y + 0.5);
        if (!here) continue;
        // Fade the ground out towards the horizon so it never reads as a wall.
        const fade = Math.min(1, -here[2] * 9);
        blend(at, ground, fade);
        if (!grid) continue;
        const across = groundPoint(x + 1.5, y + 0.5), below = groundPoint(x + 0.5, y + 1.5);
        if (!across || !below) continue;
        const wx = (Math.abs(across[0] - here[0]) + Math.abs(below[0] - here[0])) * factor;
        const wz = (Math.abs(across[1] - here[1]) + Math.abs(below[1] - here[1])) * factor;
        // Lines whose pixel footprint approaches their spacing would alias; fade them.
        const keepMinor = Math.max(0, 1 - Math.max(wx, wz) / (grid.minor_m * 0.25));
        const keepMajor = Math.max(0, 1 - Math.max(wx, wz) / (grid.major_m * 0.25));
        blend(at, minor, fade * keepMinor * 0.7 * Math.max(lineCoverage(here[0], grid.minor_m, wx), lineCoverage(here[1], grid.minor_m, wz)));
        blend(at, major, fade * keepMajor * 0.8 * Math.max(lineCoverage(here[0], grid.major_m, wx * 1.6), lineCoverage(here[1], grid.major_m, wz * 1.6)));
        blend(at, axis, fade * keepMajor * 0.85 * Math.max(lineCoverage(here[0], 1e9, wx * 1.6), lineCoverage(here[1], 1e9, wz * 1.6)));
      }
    }
    return grid;
  }

  // Box filter in linear light, then sRGB bytes.
  function downsample(linear, W, H, factor) {
    const width = W / factor, height = H / factor, pixels = new Uint8Array(width * height * 3), weight = 1 / (factor * factor);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let j = 0; j < factor; j++) for (let i = 0; i < factor; i++) sum += linear[(((y * factor + j) * W) + x * factor + i) * 3 + c];
          const value = linearToSrgb(Math.min(1, Math.max(0, sum * weight)));
          pixels[(y * width + x) * 3 + c] = Math.round(value * 255);
        }
      }
    }
    return { width, height, pixels };
  }

  // Ortho views get their longest side equal to `size`; perspective views are
  // size x 3/4 size and are pulled back until the whole bounding box fits.
  function orthoView(bounds, view, size) {
    const probe = raster.orthoViewOfBounds(bounds, view, { width: size });
    if (probe.height <= size) return probe;
    const [, , v0, v1] = probe.extent;
    return raster.orthoViewOfBounds(bounds, view, { pixelsPerMetre: size / (v1 - v0) });
  }

  function perspectiveView(bounds, { azimuth, elevation }, size) {
    const centre = bounds.min.map((value, i) => (value + bounds.max[i]) / 2);
    const radius = Math.max(1e-6, Math.hypot(...bounds.max.map((value, i) => value - bounds.min[i])) / 2);
    const az = azimuth * Math.PI / 180, el = elevation * Math.PI / 180;
    const direction = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
    const width = size, height = Math.max(1, Math.round(size * 0.75));
    const corners = Array.from({ length: 8 }, (_, corner) => [0, 1, 2].map(i => corner >> i & 1 ? bounds.max[i] : bounds.min[i]));
    let distance = radius / Math.sin(PERSPECTIVE_FOV_DEG * Math.PI / 360), target = [...centre], camera;
    // Pull back (or in) until the projected box fills ~92 % of the frame, and
    // slide the aim point so the projected box is centred rather than the box centre.
    for (let pass = 0; pass < 8; pass++) {
      const position = target.map((value, i) => value + direction[i] * distance);
      camera = raster.perspectiveCamera({ position, target, fov_y_deg: PERSPECTIVE_FOV_DEG, width, height, near: Math.max(1e-3, distance * 1e-3) });
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, behind = false;
      for (const corner of corners) {
        const [x, y, z] = raster.projectPoint(camera, corner);
        if (!(z > camera.near)) { behind = true; break; }
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      if (behind) { distance *= 1.6; continue; }
      const reach = Math.max((x1 - x0) / width, (y1 - y0) / height), fit = 0.92;
      const shiftX = ((x0 + x1) / 2 - camera.cx) * distance / camera.fx, shiftY = -((y0 + y1) / 2 - camera.cy) * distance / camera.fy;
      target = target.map((value, i) => value + shiftX * camera.right[i] + shiftY * camera.up[i]);
      if (Math.abs(reach - fit) < 0.005 && Math.hypot(shiftX, shiftY) < radius * 1e-3) break;
      distance *= Math.max(0.6, Math.min(1.6, reach / fit));
    }
    return camera;
  }

  // Named cameras for a bounding box: front, rear, left, right, top (ortho) and
  // iso, iso-rear (perspective three-quarter views from above).
  function standardViews(bounds, size = 512) {
    if (!(size >= 8)) throw new Error('standardViews needs size >= 8');
    if (![...bounds.min, ...bounds.max].every(Number.isFinite)) throw new Error('standardViews needs finite bounds');
    // A flat or point-like model has a zero-width box, which the kernel cannot
    // frame; give every axis a sliver of thickness relative to the largest one.
    const largest = Math.max(...bounds.max.map((value, i) => value - bounds.min[i]));
    const sliver = Math.max(1e-3, 0.01 * largest);
    bounds = {
      min: bounds.min.map((value, i) => bounds.max[i] - value < sliver ? (value + bounds.max[i]) / 2 - sliver / 2 : value),
      max: bounds.max.map((value, i) => value - bounds.min[i] < sliver ? (value + bounds.min[i]) / 2 + sliver / 2 : value),
    };
    const views = {};
    for (const name of ['front', 'rear', 'left', 'right', 'top']) views[name] = orthoView(bounds, name, size);
    for (const [name, spec] of Object.entries(PERSPECTIVE_VIEWS)) views[name] = perspectiveView(bounds, spec, size);
    return views;
  }

  // A free perspective camera; looking straight up or down switches the up hint
  // so the basis stays defined.
  function customCamera({ position, target, fov_y_deg = 50, width, height }) {
    const forward = [0, 1, 2].map(i => target[i] - position[i]);
    const length = Math.hypot(...forward);
    if (!(length > 0)) throw new Error('Camera position and target must differ');
    const vertical = Math.abs(forward[1] / length) > 0.999;
    return raster.perspectiveCamera({ position, target, fov_y_deg, width, height, up: vertical ? [0, 0, -1] : [0, 1, 0],
      near: Math.max(1e-3, length * 1e-3) });
  }

  return { shadeSoup, standardViews, customCamera, scaleCamera, VIEW_NAMES };
}

export { VIEW_NAMES };
