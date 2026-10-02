// Reads a binary glTF (.glb) straight from its accessors, with no three.js and
// no DOM, and turns it into a world-space triangle soup for previewing.
//
// The container and "static track" checks mirror the benchmark's submission
// contract (one embedded buffer, uncompressed FLOAT positions, triangle lists,
// no animation, skins, morph targets or external files), so a file rejected
// here would be rejected when it is submitted. Passing here is a good sign, not
// a guarantee: the task budget (triangles, bytes) is checked only when given.
const JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942, MAGIC = 0x46546c67;
const ALLOWED_EXTENSIONS = new Set(['KHR_lights_punctual', 'KHR_materials_unlit', 'KHR_materials_clearcoat',
  'KHR_materials_ior', 'KHR_materials_specular', 'KHR_materials_transmission', 'KHR_materials_volume',
  'KHR_materials_sheen', 'KHR_materials_iridescence', 'KHR_materials_anisotropy', 'KHR_materials_emissive_strength',
  'KHR_materials_dispersion', 'KHR_texture_transform']);
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

export class GLBError extends Error {}
const fail = message => { throw new GLBError(message); };

export function parseContainer(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('Expected the bytes of a .glb file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 28 || view.getUint32(0, true) !== MAGIC) fail('Not a binary glTF file (missing "glTF" magic). Export .glb, not .gltf');
  if (view.getUint32(4, true) !== 2) fail('Only glTF 2.0 is supported');
  if (view.getUint32(8, true) !== bytes.length) fail('Header length ' + view.getUint32(8, true) + ' does not match the file size ' + bytes.length + ' (truncated file?)');
  let offset = 12, json, binary;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail('Truncated GLB chunk');
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    if (length % 4 || offset + 8 + length > bytes.length) fail('Invalid GLB chunk bounds');
    if (offset === 12 && type !== JSON_CHUNK) fail('First GLB chunk must be JSON');
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === JSON_CHUNK) {
      if (json) fail('Duplicate JSON chunk');
      try { json = JSON.parse(new TextDecoder().decode(chunk)); } catch (error) { fail('JSON chunk does not parse: ' + error.message); }
    } else if (type === BIN_CHUNK) {
      if (binary) fail('Duplicate binary chunk');
      binary = chunk;
    } else fail('Unsupported GLB chunk type 0x' + type.toString(16));
    offset += 8 + length;
  }
  if (!json || json.asset?.version !== '2.0') fail('GLB JSON must declare asset.version "2.0"');
  if (!binary) fail('GLB has no binary chunk: geometry must be embedded in the .glb');
  return { json, binary };
}

// The static submission contract. Messages say what to change.
export function checkStatic(json, binary, maxTriangles = 3000000) {
  if (json.buffers?.length !== 1 || json.buffers[0].uri !== undefined) fail('Exactly one embedded buffer is allowed; external .bin files or data: URIs are not');
  const declared = json.buffers[0].byteLength;
  if (!Number.isInteger(declared) || declared < 1 || declared > binary.length || binary.length - declared > 3) fail('Buffer byteLength does not match the binary chunk');
  if (json.animations?.length || json.skins?.length) fail('Animations and skins are not allowed: submit a static model');
  for (const extension of [...(json.extensionsUsed || []), ...(json.extensionsRequired || [])]) {
    if (!ALLOWED_EXTENSIONS.has(extension)) fail('Extension not allowed: ' + extension + ' (no Draco/meshopt compression, no GPU instancing)');
  }
  for (const image of json.images || []) {
    if (image.uri !== undefined && !/^data:image\/(png|jpeg);base64,/.test(image.uri)) fail('External image URIs are not allowed');
    if (image.bufferView !== undefined && !json.bufferViews?.[image.bufferView]) fail('Image references a missing buffer view');
  }
  for (const view of json.bufferViews || []) {
    const start = view.byteOffset ?? 0;
    if (view.buffer !== 0 || !Number.isInteger(start) || start < 0 || !Number.isInteger(view.byteLength) || view.byteLength < 1 ||
        start + view.byteLength > declared || view.extensions) fail('Invalid or compressed buffer view');
  }
  for (const accessor of json.accessors || []) {
    if (!Number.isInteger(accessor.count) || accessor.count < 1) fail('Invalid accessor count ' + accessor.count);
    if (accessor.count > maxTriangles * 3) fail('An accessor has ' + accessor.count + ' elements, more than 3 x the triangle limit of ' + maxTriangles);
    if (accessor.sparse) fail('Sparse accessors are not allowed');
  }
  for (const mesh of json.meshes || []) {
    if (mesh.weights?.length) fail('Morph target weights are not allowed');
    for (const primitive of mesh.primitives || []) {
      if ((primitive.mode ?? 4) !== 4 || primitive.targets || primitive.extensions) fail('Only plain triangle-list primitives are allowed (mode 4, no morph targets, no compression)');
      const position = json.accessors?.[primitive.attributes?.POSITION];
      if (!position || position.type !== 'VEC3' || position.componentType !== 5126 || position.normalized) fail('POSITION must be an unquantized FLOAT VEC3 accessor');
      const count = primitive.indices === undefined ? position.count : json.accessors?.[primitive.indices]?.count;
      if (!count || count % 3) fail('A triangle primitive has a vertex/index count that is not a multiple of 3');
      if (primitive.indices !== undefined) {
        const indices = json.accessors[primitive.indices];
        if (indices.type !== 'SCALAR' || ![5121, 5123, 5125].includes(indices.componentType) || indices.normalized) fail('Invalid index accessor');
      }
    }
  }
  const nodes = json.nodes || [];
  if (nodes.length > 50000) fail('More than 50000 nodes');
  const parents = new Set();
  for (const node of nodes) {
    if (node.skin !== undefined || node.weights || (node.extensions && Object.keys(node.extensions).some(key => key !== 'KHR_lights_punctual'))) fail('Node deformation or instancing is not allowed');
    for (const [key, length] of [['matrix', 16], ['translation', 3], ['rotation', 4], ['scale', 3]]) {
      if (node[key] && (!Array.isArray(node[key]) || node[key].length !== length || !node[key].every(Number.isFinite))) fail('Invalid node transform');
    }
    if (node.matrix && (node.translation || node.rotation || node.scale)) fail('A node mixes matrix and translation/rotation/scale');
    for (const child of node.children || []) {
      if (!Number.isInteger(child) || child < 0 || child >= nodes.length || parents.has(child)) fail('Invalid or multiply parented node');
      parents.add(child);
    }
  }
  const visiting = new Set(), visited = new Set();
  const visit = (index, depth = 0) => {
    if (depth > 200 || visiting.has(index)) fail('Cyclic or too deep node graph');
    if (visited.has(index)) return;
    visiting.add(index);
    for (const child of nodes[index].children || []) visit(child, depth + 1);
    visiting.delete(index); visited.add(index);
  };
  nodes.forEach((_, i) => visit(i));
  if (!Array.isArray(json.scenes) || json.scenes.length !== 1 || (json.scene !== undefined && json.scene !== 0)) fail('Submit exactly one scene');
  const roots = new Set();
  for (const index of json.scenes[0].nodes || []) {
    if (!Number.isInteger(index) || !nodes[index] || parents.has(index) || roots.has(index)) fail('Invalid or duplicate scene root node');
    roots.add(index);
  }
}

// Column-major 4x4 helpers (glTF order).
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
    out[column * 4 + row] = sum;
  }
  return out;
}
function localMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0], [x, y, z, w] = node.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function accessorReader(json, binary, index) {
  const accessor = json.accessors[index], size = TYPE_SIZE[accessor.type], bytes = COMPONENT_BYTES[accessor.componentType];
  if (!size || !bytes) fail('Accessor ' + index + ' has an unknown type');
  if (accessor.bufferView === undefined) return () => 0;
  const view = json.bufferViews[accessor.bufferView];
  if (!view) fail('Accessor ' + index + ' references a missing buffer view');
  const stride = view.byteStride ?? size * bytes, start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  if ((accessor.byteOffset ?? 0) + stride * (accessor.count - 1) + size * bytes > view.byteLength) fail('Accessor ' + index + ' runs past its buffer view');
  const data = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const read = {
    5120: at => data.getInt8(at), 5121: at => data.getUint8(at), 5122: at => data.getInt16(at, true),
    5123: at => data.getUint16(at, true), 5125: at => data.getUint32(at, true), 5126: at => data.getFloat32(at, true),
  }[accessor.componentType];
  return (element, component = 0) => read(start + element * stride + component * bytes);
}

// -> { positions, colors (linear RGB per triangle), triangles, bounds, stats }
export function readGLB(bytes, { maxTriangles = 3000000, maxBytes = 268435456 } = {}) {
  if (bytes.length > maxBytes) fail('File is ' + bytes.length + ' bytes, over the ' + maxBytes + ' byte limit');
  const { json, binary } = parseContainer(bytes);
  checkStatic(json, binary, maxTriangles);
  const nodes = json.nodes || [], items = [];
  const walk = (index, parent) => {
    const node = nodes[index], world = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = json.meshes?.[node.mesh];
      if (!mesh) fail('Node ' + index + ' references a missing mesh');
      for (const primitive of mesh.primitives || []) items.push({ primitive, world });
    }
    for (const child of node.children || []) walk(child, world);
  };
  for (const root of json.scenes[0].nodes || []) walk(root, IDENTITY);
  let triangles = 0;
  for (const { primitive } of items) {
    triangles += (primitive.indices === undefined ? json.accessors[primitive.attributes.POSITION].count : json.accessors[primitive.indices].count) / 3;
  }
  if (!triangles) fail('The model has no triangles (no mesh is reachable from the scene)');
  if (triangles > maxTriangles) fail('The model has ' + triangles + ' triangles, over the limit of ' + maxTriangles);
  const positions = new Float64Array(triangles * 9), colors = new Float32Array(triangles * 3);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let at = 0, tri = 0;
  for (const { primitive, world: m } of items) {
    const positionIndex = primitive.attributes.POSITION, vertexCount = json.accessors[positionIndex].count;
    const position = accessorReader(json, binary, positionIndex);
    const indexOf = primitive.indices === undefined ? i => i : accessorReader(json, binary, primitive.indices);
    const count = primitive.indices === undefined ? vertexCount : json.accessors[primitive.indices].count;
    const factor = json.materials?.[primitive.material]?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
    for (let i = 0; i < count; i++) {
      const vertex = indexOf(i);
      if (!Number.isInteger(vertex) || vertex < 0 || vertex >= vertexCount) fail('An index points outside the POSITION accessor');
      const x = position(vertex, 0), y = position(vertex, 1), z = position(vertex, 2);
      const world = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
      for (let axis = 0; axis < 3; axis++) {
        const value = world[axis];
        if (!Number.isFinite(value) || Math.abs(value) > 1e6) fail('A vertex is not finite or lies more than 1e6 m from the origin');
        positions[at++] = value;
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
      if (i % 3 === 2) { colors.set(factor.slice(0, 3), tri * 3); tri++; }
    }
  }
  const stats = { bytes: bytes.length, nodes: nodes.length, meshes: json.meshes?.length ?? 0, primitives: items.length,
    materials: json.materials?.length ?? 0, textures: json.textures?.length ?? 0, generator: json.asset?.generator ?? null };
  return { positions, colors, triangles, bounds: { min, max }, stats };
}
