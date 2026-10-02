import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rng } from '../rng.mjs';
import { validateModel } from '../model.mjs';
import { soupFromModel, soupFromOccluders, filterSoup } from '../soup.mjs';
import { perspectiveCamera, projectPoint, render, normalize, cross, dot } from '../raster.mjs';
import { validateEvidenceItem } from '../contract.mjs';

// Photographic evidence (module B). The scene around the object (ground, sky,
// sun, trees, parked vehicles, poles) and every camera are planned here, in
// model space, as a pure function of the seed. Blender only executes the plan
// (v1/blender/render_photos.py), so camera JSON, occluder proxies and the
// occlusion budget are decided and checked by the same kernel rasterizer the
// scorer uses.
//
// Frame reminder: model space is +Y up with the front facing +Z. Blender is
// Z-up; its glTF importer maps model (x, y, z) to Blender (x, -z, y). The Python
// side does that conversion; nothing in this file is in Blender coordinates.

export const PHOTO_ITEMS = ['photo-front', 'photo-left', 'photo-right', 'photo-rear', 'aerial'];
export const PHOTO_SIZE = { width: 1600, height: 1200 };
export const AERIAL_SIZE = { width: 1200, height: 1200 };
export const EYE_HEIGHT_M = 1.6;
// Proxies (not the rendered foliage) are what this budget is measured on, and
// proxies are conservative, so the real share hidden is lower.
export const MAX_OCCLUDED_FRACTION = 0.15;
export const DEFAULT_BLENDER = '/Applications/Blender.app/Contents/MacOS/Blender';
export const BLENDER_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../blender/render_photos.py');

const SHOTS = {
  'photo-front': { kind: 'photo', file: 'photos/front.jpg', description: 'Street-level photograph of the front' },
  'photo-left': { kind: 'photo', file: 'photos/left.jpg', description: 'Street-level photograph from the front-left, showing the front and the left side' },
  'photo-right': { kind: 'photo', file: 'photos/right.jpg', description: 'Street-level photograph from the front-right, showing the front and the right side' },
  'photo-rear': { kind: 'photo', file: 'photos/rear.jpg', description: 'Photograph from behind, showing the rear' },
  aerial: { kind: 'aerial', file: 'photos/aerial.jpg', description: 'Near-vertical aerial image (map tile); image up is not necessarily the front' },
};
const deg = value => value * Math.PI / 180;

// ---------------------------------------------------------------------------
// Camera geometry

// 35 mm-equivalent focal length (full-frame diagonal 43.27 mm) to the vertical
// field of view of a 4:3 frame, which is how phone and compact cameras are sold.
export function fovYFromEquivalentFocal(focalMm, aspect = 4 / 3) {
  const halfDiagonal = 43.27 / 2, halfHeight = halfDiagonal / Math.hypot(aspect, 1);
  return 2 * Math.atan(halfHeight / focalMm) * 180 / Math.PI;
}

// Rodrigues rotation of v about unit axis k.
function rotateAbout(v, k, angle) {
  const c = Math.cos(angle), s = Math.sin(angle), kv = cross(k, v), d = dot(k, v);
  return [0, 1, 2].map(i => v[i] * c + kv[i] * s + k[i] * d * (1 - c));
}

// A street camera: heading is the horizontal unit view direction [x, z], pitch
// tilts up (radians), roll turns the image clockwise. Built with the kernel's
// perspectiveCamera so the JSON is exactly the kernel convention.
export function streetCamera({ position, heading, pitch = 0, roll = 0, fovY, width, height }) {
  const forward = [heading[0] * Math.cos(pitch), Math.sin(pitch), heading[1] * Math.cos(pitch)];
  const up = roll ? rotateAbout([0, 1, 0], normalize(forward), roll) : [0, 1, 0];
  return perspectiveCamera({ position, forward, up, fov_y_deg: fovY, width, height });
}

export function scaleCamera(camera, factor) {
  const width = Math.max(8, Math.round(camera.width * factor)), height = Math.max(8, Math.round(camera.height * factor));
  const fx = camera.fx * width / camera.width, fy = camera.fy * height / camera.height;
  return { ...camera, fx, fy, cx: camera.cx * width / camera.width, cy: camera.cy * height / camera.height, width, height };
}

// Pixel bounding box of a point set; null when any point is at or behind the near plane.
export function projectedBox(camera, points) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of points) {
    const [x, y, depth] = projectPoint(camera, p);
    if (!(depth > camera.near * 4)) return null;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, x1, y0, y1 };
}

const normalize2 = ([x, z]) => { const length = Math.hypot(x, z); return [x / length, z / length]; };

// Positive angle turns the view to the right (towards the camera's +right,
// which for a level camera with heading [x, z] is [-z, x]).
function rotateHeading(heading, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return normalize2([heading[0] * c - heading[1] * s, heading[0] * s + heading[1] * c]);
}

// Aims a camera standing at `position` so that the object's projected box sits
// at the requested place in the frame, by a few fixed-point corrections of
// heading and pitch (exact enough: residuals are below a pixel).
function aimAt({ position, points, centre, fovY, width, height, roll, offset = [0, 0] }) {
  let heading = normalize2([centre[0] - position[0], centre[2] - position[2]]), pitch = 0;
  // First pitch guess from elevation angles, so the box is in front of the camera.
  let lowest = Infinity, highest = -Infinity;
  for (const p of points) {
    const dx = p[0] - position[0], dz = p[2] - position[2], along = dx * heading[0] + dz * heading[1];
    if (along <= 0.3) return null;
    const elevation = Math.atan2(p[1] - position[1], along);
    lowest = Math.min(lowest, elevation); highest = Math.max(highest, elevation);
  }
  pitch = (lowest + highest) / 2;
  let camera = null;
  for (let iteration = 0; iteration < 6; iteration++) {
    camera = streetCamera({ position, heading, pitch, roll, fovY, width, height });
    const box = projectedBox(camera, points);
    if (!box) return null;
    const dx = (box.x0 + box.x1) / 2 - (camera.cx + offset[0] * width);
    const dy = (box.y0 + box.y1) / 2 - (camera.cy + offset[1] * height);
    if (Math.abs(dx) < 0.25 && Math.abs(dy) < 0.25) break;
    heading = rotateHeading(heading, Math.atan(dx / camera.fx));
    pitch -= Math.atan(dy / camera.fy);
  }
  return { camera, pitch, heading, box: projectedBox(camera, points) };
}

// Smallest distance along `azimuth` (from +Z towards +X, measured from the
// object's centre) at which the whole object fits inside the frame with the
// given margins, plus any extra distance the view needs (`minDistance`).
export function fitStreetCamera({ points, centre, azimuth, eyeHeight = EYE_HEIGHT_M, fovY, width, height,
  margin = [0.1, 0.1], offset = [0, 0], roll = 0, maxPitch = deg(28), minDistance = 0 }) {
  const direction = [Math.sin(azimuth), Math.cos(azimuth)];
  const at = distance => [centre[0] + direction[0] * distance, eyeHeight, centre[2] + direction[1] * distance];
  const attempt = distance => {
    const aimed = aimAt({ position: at(distance), points, centre, fovY, width, height, roll, offset });
    if (!aimed || !aimed.box || Math.abs(aimed.pitch) > maxPitch) return null;
    const { box } = aimed;
    const fits = box.x0 >= margin[0] * width && box.x1 <= (1 - margin[0]) * width &&
      box.y0 >= margin[1] * height && box.y1 <= (1 - margin[1]) * height;
    return fits ? aimed : null;
  };
  let high = Math.max(minDistance, 10);
  while (!attempt(high)) { high *= 1.6; if (high > 1e5) throw new Error('No camera distance frames the object'); }
  let low = minDistance;
  for (let iteration = 0; iteration < 40 && high - low > 0.005; iteration++) {
    const middle = (low + high) / 2;
    if (attempt(middle)) high = middle; else low = middle;
  }
  return { ...attempt(high), distance: high };
}

// Near-vertical camera over the object: `north` is the model-space horizontal
// direction that points to the top of the image; `tilt` leans the view off
// nadir, the camera moving towards `tiltDirection`.
export function fitAerialCamera({ points, centre, fovY, width, height, fill, north, tilt = 0, tiltDirection = [1, 0] }) {
  const target = [centre[0], 0, centre[2]];
  const at = altitude => perspectiveCamera({
    position: [target[0] + tiltDirection[0] * altitude * Math.tan(tilt), altitude, target[2] + tiltDirection[1] * altitude * Math.tan(tilt)],
    target, up: [north[0], 0, north[1]], fov_y_deg: fovY, width, height });
  const margin = (1 - fill) / 2;
  const fits = altitude => {
    const box = projectedBox(at(altitude), points);
    return box && box.x0 >= margin * width && box.x1 <= (1 - margin) * width && box.y0 >= margin * height && box.y1 <= (1 - margin) * height;
  };
  let high = 50;
  while (!fits(high)) high *= 1.5;
  let low = 1;
  for (let iteration = 0; iteration < 40 && high - low > 0.01; iteration++) {
    const middle = (low + high) / 2;
    if (fits(middle)) high = middle; else low = middle;
  }
  return { camera: at(high), altitude: high };
}

// ---------------------------------------------------------------------------
// Scene plan

function weighted(random, options) {
  const total = options.reduce((sum, [, weight]) => sum + weight, 0);
  let draw = random.next() * total;
  for (const [value, weight] of options) { draw -= weight; if (draw < 0) return value; }
  return options[options.length - 1][0];
}

// Unique vertices of a soup. Projected extremes of a solid are always attained
// at vertices, so fitting cameras on these is exact.
export function uniquePoints(soup) {
  const seen = new Set(), points = [], p = soup.positions;
  for (let i = 0; i < p.length; i += 3) {
    const key = Math.round(p[i] * 1000) + ',' + Math.round(p[i + 1] * 1000) + ',' + Math.round(p[i + 2] * 1000);
    if (!seen.has(key)) { seen.add(key); points.push([p[i], p[i + 1], p[i + 2]]); }
  }
  return points;
}

// Where the entrance is, so a path can lead to it; falls back to the middle of the front.
function entranceX(model, soup) {
  const ids = new Set(model.parts.filter(part => model.groups?.find(g => g.id === part.group && g.category === 'entrance')).map(part => part.id));
  if (!ids.size) return (soup.bounds.min[0] + soup.bounds.max[0]) / 2;
  const entrance = filterSoup(soup, id => ids.has(id));
  return (entrance.bounds.min[0] + entrance.bounds.max[0]) / 2;
}

// Ground layout in model space. A street runs along X in front of the object
// (the front faces +Z); everything is axis-aligned rectangles [x0, x1, z0, z1].
function planSite(random, model, soup) {
  const { min, max } = soup.bounds;
  const style = weighted(random, [['suburban', 0.55], ['urban', 0.25], ['rural', 0.2]]);
  const setback = style === 'urban' ? random.range(2.5, 5) : random.range(4, 9);
  const sidewalk = style === 'rural' ? 0 : random.range(1.6, 2.6);
  const roadWidth = style === 'rural' ? random.range(5, 6.5) : random.range(6.5, 8.5);
  const nearEdge = max[2] + setback;
  const road = { z0: nearEdge + sidewalk, z1: nearEdge + sidewalk + roadWidth, centreLine: style !== 'rural' || random.chance(0.4) };
  const sidewalks = sidewalk ? [[nearEdge, road.z0], [road.z1, road.z1 + sidewalk]] : [];
  const patches = [];
  const door = entranceX(model, soup);
  if (style === 'urban') {
    // A paved plaza around the object up to the road, parkland beyond it.
    const reach = Math.max(25, 1.5 * Math.max(max[0] - min[0], max[2] - min[2]));
    patches.push({ material: 'paving', rect: [min[0] - reach, max[0] + reach, min[2] - reach, nearEdge + 0.02], plaza: true });
  }
  if (style !== 'urban') {
    const half = random.range(0.6, 0.85);
    patches.push({ material: style === 'rural' ? 'gravel' : 'pavers', rect: [door - half, door + half, max[2] - 0.5, nearEdge + 0.02] });
  }
  let driveway = null;
  if (style !== 'urban' && random.chance(0.65)) {
    const side = random.chance(0.5) ? 1 : -1, width = random.range(2.8, 3.6), gap = random.range(0.6, 1.5);
    const x0 = side > 0 ? max[0] + gap : min[0] - gap - width;
    driveway = { side, rect: [x0, x0 + width, min[2] + (max[2] - min[2]) * random.range(0.1, 0.5), nearEdge + 0.02] };
    patches.push({ material: style === 'rural' ? 'gravel' : weighted(random, [['asphalt', 0.5], ['pavers', 0.3], ['gravel', 0.2]]), rect: driveway.rect });
  }
  if (style === 'suburban' && random.chance(0.5)) {
    patches.push({ material: 'gravel', rect: [min[0] - 0.45, max[0] + 0.45, min[2] - 0.45, max[2] + 0.45], apron: true });
  }
  return {
    style, ground: 'grass', road, sidewalks, patches, driveway,
    // Kerb height of the raised sidewalks.
    kerb: sidewalk ? random.range(0.1, 0.15) : 0,
  };
}

function planLight(random, capturedAt) {
  const weather = weighted(random, [['clear', 0.6], ['hazy', 0.25], ['overcast', 0.15]]);
  const month = Number(capturedAt.slice(5, 7)) || 9;
  return {
    weather,
    // Azimuth of the direction towards the sun, from +Z (the front) towards +X.
    // Kept off the rear so the front is usually, not always, in light.
    sun_azimuth_deg: random.range(-115, 115),
    sun_elevation_deg: weather === 'overcast' ? random.range(25, 50) : random.range(22, 58),
    // Direct normal irradiance over horizontal sky irradiance; the renderer
    // normalises the sky, so this alone sets the contrast of light and shade.
    sun_to_sky: weather === 'clear' ? random.range(5.5, 8.5) : weather === 'hazy' ? random.range(2.5, 4.5) : random.range(0.05, 0.3),
    sun_angle_deg: weather === 'clear' ? 0.55 : weather === 'hazy' ? random.range(1.5, 4) : random.range(15, 30),
    cloud_cover: weather === 'clear' ? random.range(0, 0.35) : weather === 'hazy' ? random.range(0.25, 0.6) : random.range(0.85, 1),
    aerosol: weather === 'clear' ? random.range(0.6, 1.6) : random.range(2.5, 5),
    cloud_seed: random.range(0, 1000),
    // Late-season foliage turns; the month comes from the capture date.
    foliage_autumn: month >= 9 && month <= 11 ? (month - 8) * 0.06 * random.range(0.5, 1.2) : 0,
  };
}

function planPost(random, kind) {
  const aerial = kind === 'aerial';
  return {
    exposure_ev: random.range(-0.3, 0.25),
    white_balance: [random.range(0.95, 1.05), 1, random.range(0.95, 1.05)],
    vignette: aerial ? random.range(0.02, 0.08) : random.range(0.08, 0.22),
    noise: aerial ? random.range(0.004, 0.008) : random.range(0.006, 0.014),
    chroma_noise: random.range(0.3, 0.6),
    sharpen: aerial ? random.range(0.1, 0.3) : random.range(0.15, 0.45),
    contrast: random.range(-0.04, 0.08),
    saturation: aerial ? random.range(0.85, 1.0) : random.range(0.95, 1.12),
    jpeg_quality: aerial ? random.int(68, 80) : random.int(82, 92),
    downsample: aerial ? random.range(2, 3) : 1,
    haze: aerial ? random.range(0.03, 0.1) : 0,
    seed: random.int(1, 2147483646),
  };
}

const FOCALS = [[24, 0.15], [26, 0.35], [28, 0.2], [35, 0.2], [50, 0.1]];

// Azimuth ranges per photo, measured from +Z (front) towards +X (right side).
function streetShots(random, { points, bounds }) {
  const { min, max } = bounds;
  const centre = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const width = max[0] - min[0], height = max[1] - min[1];
  const rearSide = random.chance(0.5) ? 1 : -1;
  const plans = {
    'photo-front': { azimuth: deg(random.range(-7, 7)), clear: [null, 1] },
    'photo-left': { azimuth: -deg(random.range(35, 55)), clear: [-1, 1] },
    'photo-right': { azimuth: deg(random.range(35, 55)), clear: [1, 1] },
    'photo-rear': { azimuth: Math.PI + rearSide * deg(random.range(30, 55)), clear: [-rearSide, -1], side: rearSide > 0 ? 'left' : 'right' },
  };
  const shots = [];
  for (const [id, plan] of Object.entries(plans)) {
    const r = random.fork(id);
    // Tall objects get the wider lenses: a photographer steps back and tilts up.
    const focal = height > 1.4 * width ? r.pick([24, 26, 28]) : weighted(r, FOCALS);
    const fovY = fovYFromEquivalentFocal(focal);
    const margin = [r.range(0.07, 0.16), r.range(0.07, 0.15)];
    // The camera must stand beyond the faces it is meant to show, by a metre.
    const direction = [Math.sin(plan.azimuth), Math.cos(plan.azimuth)];
    let minDistance = 0;
    const [sx, sz] = plan.clear;
    if (sx) minDistance = Math.max(minDistance, ((sx > 0 ? max[0] : -min[0]) + 1 - sx * centre[0]) / Math.abs(direction[0]));
    if (sz) minDistance = Math.max(minDistance, ((sz > 0 ? max[2] : -min[2]) + 1 - sz * centre[2]) / Math.abs(direction[1]));
    const fitted = fitStreetCamera({
      points, centre, azimuth: plan.azimuth, eyeHeight: EYE_HEIGHT_M + r.range(-0.12, 0.12), fovY,
      ...PHOTO_SIZE, margin, offset: [r.range(-0.03, 0.03), r.range(-0.02, 0.04)], roll: deg(r.range(-1.2, 1.2)), minDistance,
    });
    shots.push({ id, kind: 'photo', camera: fitted.camera, focal_mm_35: focal, distance_m: fitted.distance,
      azimuth_deg: plan.azimuth * 180 / Math.PI, side: plan.side ?? null });
  }
  return { shots, centre };
}

function aerialShot(random, { points, bounds }) {
  const { min, max } = bounds;
  const centre = [(min[0] + max[0]) / 2 + random.range(-0.05, 0.05) * (max[0] - min[0]), 0, (min[2] + max[2]) / 2 + random.range(-0.05, 0.05) * (max[2] - min[2])];
  const northAngle = random.range(0, 2 * Math.PI), tiltAngle = random.range(0, 2 * Math.PI);
  const fitted = fitAerialCamera({ points, centre, fovY: random.range(9, 14), ...AERIAL_SIZE, fill: random.range(0.4, 0.6),
    north: [Math.sin(northAngle), Math.cos(northAngle)], tilt: deg(random.range(0, 7)), tiltDirection: [Math.sin(tiltAngle), Math.cos(tiltAngle)] });
  return { id: 'aerial', kind: 'aerial', camera: fitted.camera, altitude_m: fitted.altitude };
}

// ---------------------------------------------------------------------------
// Occluders. Each one is a parameter set the Blender side builds geometry from,
// plus proxies (contract.mjs occluderScene types) that contain that geometry.
// The renderer keeps every vertex inside a shrunken copy of the proxy, because
// the kernel tessellates ellipsoids and cylinders slightly inside the true
// surface (24x16 and 20 segments: up to ~1.5 % of the radius).

const yawAxis = yaw => [Math.cos(yaw), -Math.sin(yaw)];   // local +X in model [x, z] after a yaw (DESIGN section 3)

export function occluderProxies(occluder) {
  const [x, , z] = occluder.position, p = occluder.params;
  if (occluder.kind === 'tree' && p.form === 'broadleaf') {
    return [
      { type: 'cylinder', base: [x, 0, z], radius: p.trunk_radius * 1.6 + 0.06, height: p.crown_centre_y },
      { type: 'ellipsoid', center: [x + p.crown_offset[0], p.crown_centre_y, z + p.crown_offset[1]], radii: [...p.crown_radii] },
    ];
  }
  if (occluder.kind === 'tree') {
    return [
      { type: 'cylinder', base: [x, 0, z], radius: p.trunk_radius * 1.6 + 0.06, height: p.crown_base_y + 0.3 },
      { type: 'cylinder', base: [x, p.crown_base_y, z], radius: p.crown_radius, height: p.height - p.crown_base_y },
    ];
  }
  if (occluder.kind === 'vehicle') {
    return [{ type: 'box', center: [x, (p.height + 0.04) / 2, z], size: [p.length + 0.12, p.height + 0.04, p.width + 0.34], yaw: occluder.yaw }];
  }
  // Poles: the shaft plus a box around the arm or cross-arm at the top.
  const [ax, az] = yawAxis(occluder.yaw);
  const shaft = { type: 'cylinder', base: [x, 0, z], radius: 0.26, height: p.height + 0.15 };
  if (p.form === 'lamp') {
    const reach = p.arm_length + 0.45;
    return [shaft, { type: 'box', center: [x + ax * reach / 2, p.height - 0.1, z + az * reach / 2], size: [reach + 0.2, 0.75, 0.6], yaw: occluder.yaw }];
  }
  return [shaft, { type: 'box', center: [x, p.height - 0.45, z], size: [0.45, 0.8, p.arm_length + 0.3], yaw: occluder.yaw }];
}

function proxyBox(proxy) {
  if (proxy.type === 'ellipsoid') return { min: proxy.center.map((c, i) => c - proxy.radii[i]), max: proxy.center.map((c, i) => c + proxy.radii[i]) };
  if (proxy.type === 'cylinder') {
    return { min: [proxy.base[0] - proxy.radius, proxy.base[1], proxy.base[2] - proxy.radius],
      max: [proxy.base[0] + proxy.radius, proxy.base[1] + proxy.height, proxy.base[2] + proxy.radius] };
  }
  const c = Math.abs(Math.cos(proxy.yaw ?? 0)), s = Math.abs(Math.sin(proxy.yaw ?? 0));
  const half = [(proxy.size[0] * c + proxy.size[2] * s) / 2, proxy.size[1] / 2, (proxy.size[0] * s + proxy.size[2] * c) / 2];
  return { min: proxy.center.map((v, i) => v - half[i]), max: proxy.center.map((v, i) => v + half[i]) };
}

function unionBox(boxes) {
  return { min: [0, 1, 2].map(i => Math.min(...boxes.map(b => b.min[i]))), max: [0, 1, 2].map(i => Math.max(...boxes.map(b => b.max[i]))) };
}

const boxesOverlap = (a, b, gap = 0) => [0, 1, 2].every(i => a.min[i] - gap < b.max[i] && b.min[i] - gap < a.max[i]);

// Conservative frame test: true when any part of the proxy's box may be on screen.
export function proxyInFrame(camera, proxy) {
  const box = proxyBox(proxy), corners = [];
  for (let c = 0; c < 8; c++) corners.push([0, 1, 2].map(i => (c >> i & 1 ? box.max[i] : box.min[i])));
  const projected = corners.map(p => projectPoint(camera, p));
  if (projected.every(([, , depth]) => depth <= camera.near)) return false;
  if (projected.some(([, , depth]) => depth <= camera.near)) return true;
  const xs = projected.map(p => p[0]), ys = projected.map(p => p[1]);
  return Math.max(...xs) >= 0 && Math.min(...xs) <= camera.width && Math.max(...ys) >= 0 && Math.min(...ys) <= camera.height;
}

function sampleParams(kind, random) {
  if (kind === 'tree') {
    if (random.chance(0.78)) {
      const spread = random.range(1.5, 3.0), tall = random.range(1.6, 3.2), clearance = random.range(1.7, 2.8);
      return { form: 'broadleaf', trunk_radius: random.range(0.11, 0.22), crown_radii: [spread * random.range(0.9, 1.1), tall, spread * random.range(0.9, 1.1)],
        crown_centre_y: clearance + tall, crown_offset: [random.range(-0.25, 0.25), random.range(-0.25, 0.25)], seed: random.int(1, 1e6) };
    }
    const height = random.range(5, 9);
    return { form: 'conifer', trunk_radius: random.range(0.1, 0.17), crown_base_y: random.range(0.6, 1.6), height, crown_radius: random.range(1.2, 2.1), seed: random.int(1, 1e6) };
  }
  if (kind === 'vehicle') {
    const form = weighted(random, [['sedan', 0.4], ['hatchback', 0.3], ['suv', 0.2], ['van', 0.1]]);
    const size = { sedan: [4.5, 1.8, 1.45], hatchback: [4.0, 1.75, 1.48], suv: [4.6, 1.88, 1.7], van: [5.1, 2.0, 2.05] }[form];
    const colours = [['#d9dbdc', 0.25], ['#8e9295', 0.2], ['#1c1d20', 0.2], ['#3f4448', 0.12], ['#23324f', 0.08], ['#7d1d1d', 0.07], ['#e8e6df', 0.05], ['#2f4a3a', 0.03]];
    return { form, length: size[0] * random.range(0.95, 1.05), width: size[1] * random.range(0.97, 1.03), height: size[2] * random.range(0.97, 1.03),
      paint: weighted(random, colours), metallic: random.chance(0.55), seed: random.int(1, 1e6) };
  }
  return random.chance(0.6)
    ? { form: 'lamp', height: random.range(5.5, 8), arm_length: random.range(1.0, 1.8), seed: random.int(1, 1e6) }
    : { form: 'utility', height: random.range(7.5, 10), arm_length: random.range(1.6, 2.4), seed: random.int(1, 1e6) };
}

// A ground position on the line from a street camera towards the object, then
// moved to where that kind of thing stands (vehicles on the road or driveway,
// poles on the sidewalk, trees off the carriageway).
function sampleOccluder(kind, random, { bounds, site, shots }) {
  const { min, max } = bounds;
  const shot = random.pick(shots.filter(s => s.kind === 'photo'));
  const camera = shot.camera.position, target = [random.range(min[0], max[0]), random.range(min[2], max[2])];
  const t = random.range(0.25, 0.75), across = normalize2([-(target[1] - camera[2]), target[0] - camera[0]]), lateral = random.range(-2.5, 2.5);
  let x = camera[0] + (target[0] - camera[0]) * t + across[0] * lateral;
  let z = camera[2] + (target[1] - camera[2]) * t + across[1] * lateral;
  const params = sampleParams(kind, random);
  let yaw = random.range(0, 2 * Math.PI);
  const { road, sidewalks, driveway } = site;
  if (kind === 'vehicle') {
    // Driveways are often the only kerb-free spot between a close camera and
    // the object, so they are preferred when the site has one.
    if (driveway && random.chance(0.6)) {
      const [x0, x1, z0, z1] = driveway.rect;
      if (z1 - z0 < params.length + 0.6) return null;
      x = (x0 + x1) / 2; z = random.range(z0 + params.length / 2 + 0.3, z1 - params.length / 2 - 0.3);
      yaw = random.chance(0.5) ? Math.PI / 2 : -Math.PI / 2;
    } else {
      // Parallel-parked against one kerb, nose either way along the street.
      const nearSide = z < (road.z0 + road.z1) / 2;
      z = nearSide ? road.z0 + params.width / 2 + random.range(0.25, 0.45) : road.z1 - params.width / 2 - random.range(0.25, 0.45);
      yaw = (random.chance(0.5) ? 0 : Math.PI) + random.range(-0.03, 0.03);
    }
  } else if (kind === 'pole') {
    const strips = sidewalks.length ? sidewalks : [[road.z0 - 1.6, road.z0 - 0.6], [road.z1 + 0.6, road.z1 + 1.6]];
    const strip = strips.reduce((best, s) => Math.abs((s[0] + s[1]) / 2 - z) < Math.abs((best[0] + best[1]) / 2 - z) ? s : best);
    const nearKerb = strip[0] >= road.z1 ? strip[0] + 0.45 : strip[1] - 0.45;
    z = nearKerb;
    // Lamp arms reach over the road; cross-arms run along the street.
    yaw = params.form === 'lamp' ? (z < road.z0 ? -Math.PI / 2 : Math.PI / 2) : 0;
  } else if (z > road.z0 - 0.5 && z < road.z1 + 0.5) {
    const strips = sidewalks.length ? sidewalks : [[road.z0 - 2, road.z0 - 1], [road.z1 + 1, road.z1 + 2]];
    const strip = random.pick(strips);
    z = (strip[0] + strip[1]) / 2;
  }
  const occluder = { kind, position: [x, 0, z], yaw, params };
  occluder.proxies = occluderProxies(occluder);
  return occluder;
}

function depthStats(objectImage, occluderDepth) {
  let object = 0, hidden = 0, covered = 0;
  for (let i = 0; i < objectImage.depth.length; i++) {
    if (occluderDepth[i] < Infinity) covered++;
    if (objectImage.tri[i] < 0) continue;
    object++;
    if (occluderDepth[i] < objectImage.depth[i]) hidden++;
  }
  return { hidden: object ? hidden / object : 0, coverage: covered / objectImage.depth.length };
}

// Places 1-4 trees, 0-2 vehicles and 0-2 poles. Every accepted occluder hides
// part of the object in at least one street photo; together they hide at most
// MAX_OCCLUDED_FRACTION of the object in every image, measured on the proxies
// with the kernel rasterizer at a reduced resolution.
function placeOccluders(random, { soup, bounds, site, shots }) {
  const counts = { tree: random.int(1, 4), vehicle: random.int(0, 2), pole: random.int(0, 2) };
  const rest = [...Array(counts.tree - 1).fill('tree'), ...Array(counts.vehicle).fill('vehicle'), ...Array(counts.pole).fill('pole')];
  for (let i = rest.length - 1; i > 0; i--) { const j = random.int(0, i); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  const order = ['tree', ...rest];
  const views = shots.map(shot => {
    const camera = scaleCamera(shot.camera, shot.kind === 'aerial' ? 0.2 : 0.15), image = render(soup, camera);
    return { shot, camera, image, combined: new Float32Array(image.depth.length).fill(Infinity) };
  });
  const objectBox = { min: bounds.min.map(v => v - 0.5), max: bounds.max.map(v => v + 0.5) };
  const placed = [], skipped = [];
  for (const kind of order) {
    let accepted = null;
    for (let attempt = 0; attempt < 160 && !accepted; attempt++) {
      const candidate = sampleOccluder(kind, random, { bounds, site, shots });
      if (!candidate) continue;
      const box = unionBox(candidate.proxies.map(proxyBox));
      if (boxesOverlap(box, objectBox)) continue;
      if (placed.some(other => boxesOverlap(box, other.box, 0.4))) continue;
      // Nothing within reach of a photographer, and no crown overhead: seen
      // from underneath against the sky, leaf cards stop looking like leaves.
      const clearance = kind === 'tree' ? 3.5 : 2.5;
      const tooClose = shots.some(shot => shot.kind === 'photo' &&
        Math.hypot(Math.max(box.min[0] - shot.camera.position[0], 0, shot.camera.position[0] - box.max[0]),
          Math.max(box.min[2] - shot.camera.position[2], 0, shot.camera.position[2] - box.max[2])) < clearance);
      if (tooClose) continue;
      const proxySoup = soupFromOccluders(candidate.proxies);
      const own = [], merged = [];
      let ok = true;
      for (const view of views) {
        const depth = render(proxySoup, view.camera).depth;
        const alone = depthStats(view.image, depth);
        const together = new Float32Array(depth.length);
        for (let i = 0; i < depth.length; i++) together[i] = Math.min(depth[i], view.combined[i]);
        const joint = depthStats(view.image, together);
        if (joint.hidden > MAX_OCCLUDED_FRACTION * 0.95 || (view.shot.kind === 'photo' && alone.coverage > 0.25)) { ok = false; break; }
        own.push(alone.hidden); merged.push(together);
      }
      if (!ok) continue;
      // "Between the camera and the object": it must hide something somewhere.
      // Late attempts accept a smaller share so a crowded scene still fills up.
      const needed = attempt < 100 ? 0.006 : 0.001;
      if (!views.some((view, i) => view.shot.kind === 'photo' && own[i] >= needed)) continue;
      views.forEach((view, i) => { view.combined = merged[i]; });
      accepted = { ...candidate, id: kind + '-' + placed.filter(o => o.kind === kind).length, box,
        hides: Object.fromEntries(views.map((view, i) => [view.shot.id, Number(own[i].toFixed(4))])) };
    }
    if (accepted) placed.push(accepted); else skipped.push(kind);
  }
  const occluded = Object.fromEntries(views.map(view => [view.shot.id, Number(depthStats(view.image, view.combined).hidden.toFixed(4))]));
  return { occluders: placed.map(({ box, ...occluder }) => occluder), skipped, occluded };
}

// Distant trees and shrubs, all farther from the object than any street camera
// (plus a crown), so they never stand between a camera and the object. They
// close the horizon the way neighbouring gardens and parks do.
function planBackdrop(random, { centre, shots, site }) {
  const reach = Math.max(...shots.filter(s => s.kind === 'photo').map(s => Math.hypot(s.camera.position[0] - centre[0], s.camera.position[2] - centre[2])));
  const inner = reach + 12, trees = [];
  const keepOffRoad = z => z > site.road.z0 - 3 && z < site.road.z1 + 3;
  // A broken ring of tree clusters, then scattered trees and shrubs farther out.
  for (let ring = 0; ring < 2; ring++) {
    const radius = inner + ring * random.range(18, 30), count = Math.round(2 * Math.PI * radius / random.range(5.5, 8));
    for (let i = 0; i < count; i++) {
      // Gaps and depth jitter, so the line does not read as a planted ring.
      if (random.chance(0.3)) continue;
      const angle = (i + random.range(-0.45, 0.45)) / count * 2 * Math.PI, r = radius + random.range(0, 10) + (random.chance(0.3) ? random.range(10, 30) : 0);
      const x = centre[0] + Math.sin(angle) * r, z = centre[2] + Math.cos(angle) * r;
      if (keepOffRoad(z)) continue;
      trees.push({ position: [x, 0, z], scale: random.range(0.85, 1.5), variant: random.int(0, 2), yaw: random.range(0, 2 * Math.PI), shrub: false });
      if (random.chance(0.35)) {
        const a = angle + random.range(-0.03, 0.03), rs = r - random.range(3, 6);
        trees.push({ position: [centre[0] + Math.sin(a) * rs, 0, centre[2] + Math.cos(a) * rs], scale: random.range(0.8, 1.3), variant: 3, yaw: random.range(0, 2 * Math.PI), shrub: true });
      }
    }
  }
  for (let i = 0; i < 40; i++) {
    const angle = random.range(0, 2 * Math.PI), r = inner + random.range(60, 220);
    const x = centre[0] + Math.sin(angle) * r, z = centre[2] + Math.cos(angle) * r;
    if (!keepOffRoad(z)) trees.push({ position: [x, 0, z], scale: random.range(1, 1.8), variant: random.int(0, 2), yaw: random.range(0, 2 * Math.PI), shrub: false });
  }
  return { inner_radius: inner, trees: trees.filter(t => Math.hypot(t.position[0] - centre[0], t.position[2] - centre[2]) >= inner - 6) };
}

// The whole photographic setup for one object, as data. Pure and fast; no Blender.
export function planPhotos({ model, seed, capturedAt = '2025-09' }) {
  validateModel(model);
  const soup = soupFromModel(model), points = uniquePoints(soup), bounds = soup.bounds;
  const random = rng(seed).fork('photos/' + model.id);
  const site = planSite(random.fork('site'), model, soup);
  const light = planLight(random.fork('light'), capturedAt);
  const { shots, centre } = streetShots(random.fork('cameras'), { points, bounds });
  shots.push(aerialShot(random.fork('aerial'), { points, bounds }));
  const placement = placeOccluders(random.fork('occluders'), { soup, bounds, site, shots });
  const postRandom = random.fork('post');
  for (const shot of shots) {
    shot.post = planPost(postRandom.fork(shot.id), shot.kind);
    shot.occluders = placement.occluders.filter(o => o.proxies.some(proxy => proxyInFrame(shot.camera, proxy))).map(o => o.id);
    shot.occluded_fraction = placement.occluded[shot.id];
  }
  return {
    schema: 'e3d-photo-plan-v1', object: model.id, seed, captured_at: capturedAt, bounds, centre,
    site, light, shots, occluders: placement.occluders, skipped_occluders: placement.skipped,
    backdrop: planBackdrop(random.fork('backdrop'), { centre, shots, site }),
    render_seed: random.fork('render').int(1, 2147483646),
  };
}

// ---------------------------------------------------------------------------
// Running Blender

// Explicit path, then $E3D_BLENDER / $BLENDER, then the macOS default. null if
// none exists. E3D_BLENDER=none hides an installed Blender (CI, skip checks).
export function findBlender(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  if (process.env.E3D_BLENDER === 'none') return null;
  const candidates = [process.env.E3D_BLENDER, process.env.BLENDER, DEFAULT_BLENDER].filter(Boolean);
  return candidates.find(path => existsSync(path)) ?? null;
}

// Width and height from a baseline or progressive JPEG frame header.
export function jpegInfo(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG file');
  const markers = [];
  let offset = 2, size = null;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('Corrupt JPEG marker at ' + offset);
    const marker = bytes[offset + 1];
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0xd9 || marker === 0xda) { markers.push(marker); break; }
    const length = bytes.readUInt16BE(offset + 2);
    markers.push(marker);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      size = { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  if (!size) throw new Error('JPEG has no frame header');
  return { ...size, markers };
}

// Drops every APPn segment except JFIF (APP0) and every comment, without
// touching the compressed data. Blender's writer adds an APP1 "NeoGeo" block,
// a renderer fingerprint that has no place in a photograph.
export function stripJpegMetadata(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG file');
  const kept = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    const marker = bytes[offset + 1];
    if (marker === 0xda) { kept.push(bytes.subarray(offset)); return Buffer.concat(kept); }
    const length = bytes.readUInt16BE(offset + 2);
    const metadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!metadata) kept.push(bytes.subarray(offset, offset + 2 + length));
    offset += 2 + length;
  }
  throw new Error('JPEG has no scan data');
}

function runBlender(executable, args, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = chunk => { output = (output + chunk).slice(-20000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Blender timed out after ' + timeoutMs + ' ms\n' + output.slice(-3000))); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolvePromise({ code, output }); });
  });
}

// Cycles samples per image. Draft exists for tests: same plan, cameras and
// occluder geometry envelopes, far fewer samples and leaves.
export const SAMPLES = { final: { photo: 64, aerial: 32 }, draft: { photo: 10, aerial: 8 } };
// Scene-linear log-average luminance the meter aims the object at.
const EXPOSURE_KEY = 0.15;

function description(shot) {
  if (shot.id === 'photo-rear') return 'Photograph from behind, showing the rear and the ' + shot.side + ' side';
  return SHOTS[shot.id].description;
}

// Renders the five photographic evidence items. Returns { items, plan, report };
// renderPhotos() below returns just the items (the module contract).
export async function renderPhotosDetailed({ model, glbPath, outDir, seed, blender, quality = 'final', capturedAt = '2025-09',
  sourceModel = 'primary', maskDir = null, engine = 'cycles', keepWork = false, timeoutMs = 30 * 60 * 1000 }) {
  if (!['final', 'draft'].includes(quality)) throw new Error('quality must be final or draft');
  if (!/^\d{4}-\d{2}$/.test(capturedAt)) throw new Error('capturedAt must be YYYY-MM');
  if (!['cycles', 'cycles-cpu', 'eevee'].includes(engine)) throw new Error('engine must be cycles, cycles-cpu or eevee');
  const executable = findBlender(blender);
  if (!executable) throw new Error('Blender not found (pass blender, or set E3D_BLENDER); looked for ' + (blender ?? DEFAULT_BLENDER));
  if (!existsSync(glbPath)) throw new Error('GLB not found: ' + glbPath);
  const plan = planPhotos({ model, seed, capturedAt });
  const work = await mkdtemp(join(tmpdir(), 'e3d-photos-'));
  const points = uniquePoints(soupFromModel(model));
  try {
    await mkdir(join(outDir, 'photos'), { recursive: true });
    if (maskDir) await mkdir(maskDir, { recursive: true });
    const shots = plan.shots.map(shot => {
      const box = shot.kind === 'photo' ? projectedBox(shot.camera, points) : null;
      return {
        id: shot.id, kind: shot.kind, file: resolve(outDir, SHOTS[shot.id].file), width: shot.camera.width, height: shot.camera.height,
        camera: shot.camera, post: shot.post, samples: SAMPLES[quality][shot.kind],
        meter_box: box && [box.x0 / shot.camera.width, box.y0 / shot.camera.height, box.x1 / shot.camera.width, box.y1 / shot.camera.height],
      };
    });
    const spec = {
      glb: resolve(glbPath), quality, engine: engine === 'eevee' ? 'eevee' : 'cycles', force_cpu: engine === 'cycles-cpu',
      work_dir: work, result: join(work, 'result.json'),
      masks: maskDir ? { dir: resolve(maskDir) } : null, render_seed: plan.render_seed, exposure_key: EXPOSURE_KEY,
      parts: model.parts.map(part => ({ id: part.id, material: part.material })), materials: model.materials, centre: plan.centre,
      site: plan.site, light: plan.light, occluders: plan.occluders, backdrop: plan.backdrop, shots,
    };
    await writeFile(join(work, 'spec.json'), JSON.stringify(spec));
    const started = Date.now();
    const { code, output } = await runBlender(executable,
      ['--background', '--factory-startup', '--python-exit-code', '1', '--python', BLENDER_SCRIPT, '--', join(work, 'spec.json')], timeoutMs);
    if (code !== 0 || !existsSync(spec.result)) throw new Error('Blender photo render failed (exit ' + code + '):\n' + output.slice(-4000));
    const result = JSON.parse(await readFile(spec.result, 'utf8'));
    const items = [];
    for (const shot of plan.shots) {
      const file = SHOTS[shot.id].file, bytes = stripJpegMetadata(await readFile(join(outDir, file))), info = jpegInfo(bytes);
      await writeFile(join(outDir, file), bytes);
      if (info.width !== shot.camera.width || info.height !== shot.camera.height) {
        throw new Error(shot.id + ' was rendered at ' + info.width + 'x' + info.height + ', expected ' + shot.camera.width + 'x' + shot.camera.height);
      }
      const occluders = plan.occluders.filter(o => shot.occluders.includes(o.id))
        .flatMap(o => o.proxies.map(proxy => ({ ...proxy, source: o.id })));
      items.push(validateEvidenceItem({
        id: shot.id, kind: SHOTS[shot.id].kind, file, captured_at: capturedAt, description: description(shot),
        metric: false, source_model: sourceModel, camera: shot.camera, occluders,
        sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      }));
    }
    const report = {
      engine: result.engine, blender: result.blender, quality, wall_seconds: (Date.now() - started) / 1000,
      setup_seconds: result.setup_seconds, sky_irradiance: result.sky_irradiance,
      shots: result.shots.map(s => ({ ...s, occluded_fraction: plan.shots.find(p => p.id === s.id).occluded_fraction })),
      occluders: plan.occluders.map(o => ({ id: o.id, form: o.params.form, hides: o.hides })), skipped_occluders: plan.skipped_occluders,
      site: plan.site.style, weather: plan.light.weather, work_dir: keepWork ? work : null,
    };
    return { items, plan, report };
  } finally {
    if (!keepWork) await rm(work, { recursive: true, force: true });
  }
}

export async function renderPhotos(options) {
  return (await renderPhotosDetailed(options)).items;
}
