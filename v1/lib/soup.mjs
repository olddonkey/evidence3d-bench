import { Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { parseGLB, validateStatic, neutralGLB } from '../../lib/glb.mjs';
import { buildScene } from './model.mjs';
import { occluderScene } from './contract.mjs';

// A "soup" is the one geometry representation every v1 module shares:
//   positions  Float64Array(9 * T)  world-space triangle corners, metres, +Y up
//   triPart    Int32Array(T)        index into `parts` for each triangle
//   colors     Float32Array(3 * T)  linear-sRGB base colour per triangle
//   parts      string[]             part ids (ground truth) or mesh labels (submissions)
//   bounds     { min:[3], max:[3] }
//   triangles  T
export function soupFromScene(scene, partOf = (mesh, index) => index) {
  const meshes = [];
  scene.updateMatrixWorld(true);
  scene.traverse(node => { if (node.isMesh) meshes.push(node); });
  let triangles = 0;
  for (const mesh of meshes) triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
  if (!Number.isInteger(triangles) || !triangles) throw new Error('Geometry has no complete triangles');
  const positions = new Float64Array(triangles * 9), triPart = new Int32Array(triangles), colors = new Float32Array(triangles * 3);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], point = new Vector3();
  let at = 0, tri = 0;
  for (const [meshIndex, mesh] of meshes.entries()) {
    const attribute = mesh.geometry.attributes.position, index = mesh.geometry.index, count = index?.count ?? attribute.count;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const color = material?.color ? material.color.toArray() : [1, 1, 1];
    for (let i = 0; i < count; i++) {
      const vertex = index ? index.getX(i) : i;
      if (!Number.isInteger(vertex) || vertex < 0 || vertex >= attribute.count) throw new Error('Index outside position accessor');
      point.fromBufferAttribute(attribute, vertex).applyMatrix4(mesh.matrixWorld);
      for (const [axis, value] of [point.x, point.y, point.z].entries()) {
        if (!Number.isFinite(value) || Math.abs(value) > 1e6) throw new Error('Non-finite or out-of-range vertex');
        positions[at++] = value;
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
      if (i % 3 === 2) { triPart[tri] = partOf(mesh, meshIndex); colors.set(color, tri * 3); tri++; }
    }
  }
  return { positions, triPart, colors, bounds: { min, max }, triangles };
}

export function soupFromModel(model) {
  const scene = buildScene(model);
  const soup = soupFromScene(scene, mesh => mesh.userData.partIndex);
  scene.traverse(node => { if (node.isMesh) node.geometry.dispose(); });
  return { ...soup, parts: model.parts.map(part => part.id) };
}

// Reads a submitted (or reference) GLB. The static-track contract is enforced
// first; names, extras and textures are dropped, solid base colours are kept.
// No submitted code runs and nothing external is fetched.
export async function soupFromGLB(bytes, limits = {}) {
  if (bytes.length > (limits.max_artifact_bytes ?? 268435456)) throw new Error('Artifact byte limit exceeded');
  const { json, binary } = parseGLB(bytes);
  validateStatic(json, binary, limits.max_triangles);
  const neutral = neutralGLB(bytes, { preserveMaterials: true });
  const gltf = await new GLTFLoader().parseAsync(neutral.buffer.slice(neutral.byteOffset, neutral.byteOffset + neutral.byteLength), '');
  const soup = soupFromScene(gltf.scene, (mesh, index) => index);
  if (soup.triangles > (limits.max_triangles ?? 3000000)) throw new Error('Triangle limit exceeded');
  let meshes = 0;
  gltf.scene.traverse(node => {
    if (!node.isMesh) return;
    meshes++; node.geometry.dispose();
    for (const material of [].concat(node.material)) material.dispose();
  });
  return { ...soup, parts: Array.from({ length: meshes }, (_, i) => 'mesh-' + i) };
}

// Occluders (see contract.mjs) as a soup; empty lists give a zero-triangle soup.
export function soupFromOccluders(occluders) {
  if (!occluders.length) {
    return { positions: new Float64Array(0), triPart: new Int32Array(0), colors: new Float32Array(0), parts: [], triangles: 0,
      bounds: { min: [0, 0, 0], max: [0, 0, 0] } };
  }
  const scene = occluderScene(occluders), soup = soupFromScene(scene);
  scene.traverse(node => { if (node.isMesh) node.geometry.dispose(); });
  return { ...soup, parts: occluders.map((item, i) => 'occluder-' + i) };
}

// Concatenates soups for a single render. triSource[t] is the index of the soup
// a merged triangle came from and triLocal[t] its triangle index within it.
export function mergeSoups(soups) {
  const triangles = soups.reduce((sum, soup) => sum + soup.triangles, 0);
  const positions = new Float64Array(triangles * 9), triSource = new Int32Array(triangles), triLocal = new Int32Array(triangles);
  let at = 0;
  for (const [index, soup] of soups.entries()) {
    positions.set(soup.positions, at * 9);
    for (let t = 0; t < soup.triangles; t++) { triSource[at + t] = index; triLocal[at + t] = t; }
    at += soup.triangles;
  }
  return { positions, triangles, triSource, triLocal, bounds: triangles ? soupBounds(positions) : { min: [0, 0, 0], max: [0, 0, 0] } };
}

export function soupBounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const axis = i % 3, value = positions[i];
    if (value < min[axis]) min[axis] = value;
    if (value > max[axis]) max[axis] = value;
  }
  return { min, max };
}

// p' = scale * Ry(yaw) * p + translation. Yaw is a right-handed rotation about +Y
// in radians. These four degrees of freedom are the only ones the scorer may fit.
export function transformPoint(p, { scale = 1, yaw = 0, translation = [0, 0, 0] } = {}) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [
    scale * (c * p[0] + s * p[2]) + translation[0],
    scale * p[1] + translation[1],
    scale * (-s * p[0] + c * p[2]) + translation[2],
  ];
}

export function transformSoup(soup, transform) {
  const { scale = 1, yaw = 0, translation = [0, 0, 0] } = transform ?? {};
  const c = Math.cos(yaw), s = Math.sin(yaw), source = soup.positions, positions = new Float64Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    positions[i] = scale * (c * source[i] + s * source[i + 2]) + translation[0];
    positions[i + 1] = scale * source[i + 1] + translation[1];
    positions[i + 2] = scale * (-s * source[i] + c * source[i + 2]) + translation[2];
  }
  return { ...soup, positions, bounds: soupBounds(positions) };
}

// Keeps only the triangles whose part passes `keep(partId, partIndex)`.
export function filterSoup(soup, keep) {
  const kept = [];
  for (let t = 0; t < soup.triangles; t++) if (keep(soup.parts[soup.triPart[t]], soup.triPart[t])) kept.push(t);
  const positions = new Float64Array(kept.length * 9), triPart = new Int32Array(kept.length), colors = new Float32Array(kept.length * 3);
  for (const [i, t] of kept.entries()) {
    positions.set(soup.positions.subarray(t * 9, t * 9 + 9), i * 9);
    colors.set(soup.colors.subarray(t * 3, t * 3 + 3), i * 3);
    triPart[i] = soup.triPart[t];
  }
  return { ...soup, positions, triPart, colors, triangles: kept.length, bounds: kept.length ? soupBounds(positions) : soup.bounds };
}
