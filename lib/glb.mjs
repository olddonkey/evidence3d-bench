import { readFile, stat } from 'node:fs/promises';
import { Box3, Vector3, Matrix4 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { sha256 } from './io.mjs';

const JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;
const visualExtensions = new Set(['KHR_lights_punctual', 'KHR_materials_unlit', 'KHR_materials_clearcoat',
  'KHR_materials_ior', 'KHR_materials_specular', 'KHR_materials_transmission', 'KHR_materials_volume',
  'KHR_materials_sheen', 'KHR_materials_iridescence', 'KHR_materials_anisotropy', 'KHR_materials_emissive_strength',
  'KHR_materials_dispersion', 'KHR_texture_transform']);

export function parseGLB(bytes) {
  if (bytes.length < 28 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error('Invalid GLB 2.0 header or declared length');
  let offset = 12, json, binary;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('Truncated GLB chunk');
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    if (length % 4 || offset + 8 + length > bytes.length) throw new Error('Invalid GLB chunk bounds');
    if (offset === 12 && type !== JSON_CHUNK) throw new Error('First GLB chunk must be JSON');
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === JSON_CHUNK) {
      if (json) throw new Error('Duplicate JSON chunk');
      json = JSON.parse(chunk.toString('utf8'));
    } else if (type === BIN_CHUNK) {
      if (binary) throw new Error('Duplicate binary chunk');
      binary = chunk;
    } else throw new Error('Unsupported GLB chunk type');
    offset += 8 + length;
  }
  if (!json || !binary || json.asset?.version !== '2.0') throw new Error('GLB must contain JSON and binary geometry');
  return { json, binary };
}

export function encodeGLB(json, binary) {
  const data = Buffer.from(JSON.stringify(json)), jsonPad = (4 - data.length % 4) % 4, binPad = (4 - binary.length % 4) % 4;
  const result = Buffer.alloc(12 + 8 + data.length + jsonPad + 8 + binary.length + binPad);
  result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(data.length + jsonPad, 12); result.writeUInt32LE(JSON_CHUNK, 16);
  data.copy(result, 20); result.fill(32, 20 + data.length, 20 + data.length + jsonPad);
  const pos = 20 + data.length + jsonPad;
  result.writeUInt32LE(binary.length + binPad, pos); result.writeUInt32LE(BIN_CHUNK, pos + 4);
  binary.copy(result, pos + 8);
  return result;
}

export function validateStatic(json, binary, maxTriangles = 3000000) {
  if (json.buffers?.length !== 1 || json.buffers[0].uri !== undefined) throw new Error('Only one embedded GLB buffer is allowed; external buffers are forbidden');
  const declared = json.buffers[0].byteLength;
  if (!Number.isInteger(declared) || declared < 1 || declared > binary.length || binary.length - declared > 3) throw new Error('Invalid binary buffer length');
  if (json.animations?.length || json.skins?.length) throw new Error('Static track does not support animations or skins');
  for (const extension of [...(json.extensionsUsed || []), ...(json.extensionsRequired || [])]) {
    if (!visualExtensions.has(extension)) throw new Error('Unsupported extension in static track: ' + extension);
  }
  for (const image of json.images || []) {
    if (image.uri !== undefined && !/^data:image\/(png|jpeg);base64,/.test(image.uri)) throw new Error('External image URI forbidden');
    if (image.bufferView !== undefined && !json.bufferViews?.[image.bufferView]) throw new Error('Image references missing buffer view');
  }
  for (const view of json.bufferViews || []) {
    const start = view.byteOffset ?? 0;
    if (view.buffer !== 0 || !Number.isInteger(start) || start < 0 || !Number.isInteger(view.byteLength) || view.byteLength < 1 ||
        start + view.byteLength > declared || view.extensions) throw new Error('Invalid or compressed buffer view');
  }
  for (const accessor of json.accessors || []) {
    if (!Number.isInteger(accessor.count) || accessor.count < 1 || accessor.count > maxTriangles * 3) throw new Error('Invalid accessor count');
    if (accessor.sparse) throw new Error('Sparse accessors are outside the v0 static contract');
  }
  for (const mesh of json.meshes || []) {
    if (mesh.weights?.length) throw new Error('Morph weights are outside the static track');
    for (const primitive of mesh.primitives || []) {
      if ((primitive.mode ?? 4) !== 4 || primitive.targets || primitive.extensions) throw new Error('Only uncompressed triangle primitives are supported');
      const position = json.accessors?.[primitive.attributes?.POSITION];
      if (!position || position.type !== 'VEC3' || position.componentType !== 5126 || position.normalized) throw new Error('POSITION must be an unquantized FLOAT VEC3 accessor');
      const count = primitive.indices === undefined ? position.count : json.accessors?.[primitive.indices]?.count;
      if (!count || count % 3) throw new Error('Triangle primitive has an invalid index count');
      if (primitive.indices !== undefined) {
        const idx = json.accessors[primitive.indices];
        if (idx.type !== 'SCALAR' || ![5121, 5123, 5125].includes(idx.componentType) || idx.normalized) throw new Error('Invalid index accessor');
      }
    }
  }
  const nodes = json.nodes || [];
  if (nodes.length > 50000) throw new Error('Node limit exceeded');
  const parents = new Set();
  for (const node of nodes) {
    if (node.skin !== undefined || node.weights || (node.extensions && Object.keys(node.extensions).some(k => k !== 'KHR_lights_punctual'))) throw new Error('Unsupported node deformation or instancing');
    for (const [key, length] of [['matrix', 16], ['translation', 3], ['rotation', 4], ['scale', 3]]) {
      if (node[key] && (!Array.isArray(node[key]) || node[key].length !== length || !node[key].every(Number.isFinite))) throw new Error('Invalid node transform');
    }
    if (node.matrix && (node.translation || node.rotation || node.scale)) throw new Error('Node mixes matrix and TRS');
    for (const child of node.children || []) {
      if (!Number.isInteger(child) || child < 0 || child >= nodes.length || parents.has(child)) throw new Error('Invalid or multiply parented scene node');
      parents.add(child);
    }
  }
  const visiting = new Set(), visited = new Set();
  function visit(index, depth = 0) {
    if (depth > 200 || visiting.has(index)) throw new Error('Cyclic or too-deep node graph');
    if (visited.has(index)) return;
    visiting.add(index);
    for (const child of nodes[index].children || []) visit(child, depth + 1);
    visiting.delete(index); visited.add(index);
  }
  nodes.forEach((_, i) => visit(i));
  const scenes = json.scenes;
  if (!Array.isArray(scenes) || scenes.length !== 1 || (json.scene !== undefined && json.scene !== 0)) throw new Error('Submit exactly one scene');
  const sceneRoots = new Set();
  for (const index of scenes[0].nodes || []) {
    if (!Number.isInteger(index) || !nodes[index] || parents.has(index) || sceneRoots.has(index)) throw new Error('Invalid or duplicate scene root');
    sceneRoots.add(index);
  }
}

// A geometry-only copy is used for evaluation and blind viewing. No submitted code
// runs, no external resource is fetched, and names/extras cannot influence a judge.
export function neutralGLB(bytes, { preserveMaterials=false }={}) {
  const { json, binary } = parseGLB(bytes);
  validateStatic(json, binary);
  const stripped = structuredClone(json);
  function clean(value) {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value)) { delete value.name; delete value.extras; delete value.extensions; }
    for (const item of Object.values(value)) clean(item);
  }
  clean(stripped);
  delete stripped.images; delete stripped.textures; delete stripped.samplers;
  delete stripped.cameras; delete stripped.extensionsUsed; delete stripped.extensionsRequired;
  stripped.asset = { version: '2.0' };
  // The pilot material view preserves only solid-color PBR parameters. Embedded
  // textures are not part of this appearance track and are never fetched here.
  stripped.materials = preserveMaterials ? (json.materials||[]).map(m=>({
    pbrMetallicRoughness:{baseColorFactor:m.pbrMetallicRoughness?.baseColorFactor||[1,1,1,1],
      metallicFactor:m.pbrMetallicRoughness?.metallicFactor??1,roughnessFactor:m.pbrMetallicRoughness?.roughnessFactor??1},
    doubleSided:m.doubleSided||false,alphaMode:m.alphaMode||'OPAQUE'
  })) : [{ pbrMetallicRoughness: { baseColorFactor: [0.63, 0.68, 0.73, 1], metallicFactor: 0, roughnessFactor: 0.85 }, doubleSided: false }];
  for (const node of stripped.nodes || []) delete node.camera;
  for (const mesh of stripped.meshes || []) for (const primitive of mesh.primitives) {
    if(!preserveMaterials)primitive.material = 0;
    delete primitive.attributes.COLOR_0;
  }
  return encodeGLB(stripped, binary);
}

export async function loadGeometry(path, limits = {}) {
  const size = (await stat(path)).size;
  if (size > (limits.max_artifact_bytes ?? 268435456)) throw new Error('Artifact byte limit exceeded');
  return geometryFromBytes(await readFile(path), limits);
}

export async function geometryFromBytes(bytes, limits = {}) {
  const { json, binary } = parseGLB(bytes);
  validateStatic(json, binary, limits.max_triangles);
  const neutral = neutralGLB(bytes);
  const result = await new GLTFLoader().parseAsync(neutral.buffer.slice(neutral.byteOffset, neutral.byteOffset + neutral.byteLength), '');
  result.scene.updateMatrixWorld(true);
  const meshes = [];
  result.scene.traverse(node => { if (node.isMesh) meshes.push(node); });
  let triangles = 0;
  for (const mesh of meshes) triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
  if (triangles > (limits.max_triangles ?? 3000000)) throw new Error('Triangle limit exceeded');
  if (!triangles) throw new Error('Empty geometry');
  const coordinates = new Float64Array(triangles * 9);
  const bounds = new Box3(), point = new Vector3();
  let offset = 0, degenerates = 0, area = 0;
  for (const mesh of meshes) {
    const attribute = mesh.geometry.attributes.position, index = mesh.geometry.index, count = index?.count ?? attribute.count;
    for (let i = 0; i < count; i++) {
      const at = index ? index.getX(i) : i;
      if (!Number.isInteger(at) || at < 0 || at >= attribute.count) throw new Error('Index outside position accessor');
      point.fromBufferAttribute(attribute, at).applyMatrix4(mesh.matrixWorld);
      if (![point.x, point.y, point.z].every(Number.isFinite) || Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z)) > 1000000) throw new Error('Non-finite or out-of-range vertex');
      coordinates[offset++] = point.x; coordinates[offset++] = point.y; coordinates[offset++] = point.z;
      bounds.expandByPoint(point);
    }
  }
  for (let i = 0; i < coordinates.length; i += 9) {
    const ax = coordinates[i+3]-coordinates[i], ay = coordinates[i+4]-coordinates[i+1], az = coordinates[i+5]-coordinates[i+2];
    const bx = coordinates[i+6]-coordinates[i], by = coordinates[i+7]-coordinates[i+1], bz = coordinates[i+8]-coordinates[i+2];
    const a = Math.hypot(ay*bz-az*by, az*bx-ax*bz, ax*by-ay*bx) / 2;
    if (a <= 1e-12) degenerates++; else area += a;
  }
  if (degenerates === triangles) throw new Error('All triangles are degenerate');
  for (const mesh of meshes) { mesh.geometry.dispose(); if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose()); else mesh.material.dispose(); }
  return { coordinates, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
    triangles, mesh_count: meshes.length, degenerate_triangles: degenerates, surface_area_m2: area,
    artifact_sha256: sha256(bytes), bytes: bytes.length };
}

// Small fixture exporter. This is never used to generate reference measurements
// from a contestant's claimed dimensions or part labels.
export function sceneToGLB(scene) {
  const chunks = [], bufferViews = [], accessors = [], meshes = [], nodes = [], materials = [];
  let byteLength = 0;
  function accessor(array, type, componentType, bounds) {
    const source = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    const padding = (4 - source.length % 4) % 4;
    const view = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: source.length });
    chunks.push(source, Buffer.alloc(padding)); byteLength += source.length + padding;
    const size = type === 'VEC3' ? 3 : 1;
    const id = accessors.length;
    accessors.push({ bufferView: view, componentType, count: array.length / size, type, ...bounds });
    return id;
  }
  function add(object) {
    object.updateMatrix();
    const id = nodes.length, node = { name: object.name, matrix: object.matrix.toArray() };
    nodes.push(node);
    if (object.isMesh) {
      const source = object.geometry.attributes.position;
      const positions = Float32Array.from({ length: source.count * 3 }, (_, n) => source.array[n]);
      const box = new Box3().setFromBufferAttribute(source);
      const pos = accessor(positions, 'VEC3', 5126, { min: box.min.toArray(), max: box.max.toArray() });
      const primitive = { attributes: { POSITION: pos }, mode: 4, material: materials.length };
      if (object.geometry.index) primitive.indices = accessor(Uint32Array.from(object.geometry.index.array), 'SCALAR', 5125);
      const color = object.material.color?.toArray() || [0.7, 0.7, 0.7];
      materials.push({ name: object.material.name, pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: object.material.metalness || 0, roughnessFactor: object.material.roughness ?? 0.8 } });
      node.mesh = meshes.length; meshes.push({ name: object.name, primitives: [primitive] });
    }
    if (object.children.length) node.children = object.children.map(add);
    return id;
  }
  const root = add(scene), binary = Buffer.concat(chunks);
  return encodeGLB({ asset: { version: '2.0', generator: 'Evidence3D calibration fixture' }, scene: 0, scenes: [{ nodes: [root] }],
    nodes, meshes, materials, accessors, bufferViews, buffers: [{ byteLength: binary.length }] }, binary);
}
