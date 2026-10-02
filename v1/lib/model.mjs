import {
  Group, Mesh, Color, BoxGeometry, CylinderGeometry, TorusGeometry, LatheGeometry, ExtrudeGeometry,
  BufferGeometry, Float32BufferAttribute, MeshStandardMaterial, Shape, Path, Vector2, Vector3,
} from 'three';
import { sceneToGLB } from '../../lib/glb.mjs';

// The ground-truth description language ("e3d-model-v1"). A model is a flat list
// of parametric parts in one metric, +Y-up frame. It is private to the benchmark:
// contestants never see it, only evidence rendered from it.
export const MODEL_SCHEMA = 'e3d-model-v1';
export const FACADES = ['front', 'left', 'right', 'rear', 'roof', 'all'];
export const MATERIAL_KINDS = ['wall', 'roof', 'glass', 'frame', 'metal', 'stone', 'wood', 'sign', 'concrete'];
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;

const isVector = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
const positive = value => Number.isFinite(value) && value > 0;

function fail(message) { throw new Error('Model: ' + message); }

const PRIMITIVES = {
  // size XYZ, centred on position.
  box(part) {
    if (!isVector(part.size, 3) || !part.size.every(positive)) fail(part.id + ' box needs a positive size');
    return new BoxGeometry(...part.size);
  },
  // Axis along local Y. radius is the top radius; radius_bottom defaults to it (0 makes a cone).
  cylinder(part) {
    if (!Number.isFinite(part.radius) || part.radius < 0 || !positive(part.height)) fail(part.id + ' cylinder needs radius and height');
    return new CylinderGeometry(part.radius, part.radius_bottom ?? part.radius, part.height, part.segments ?? 32);
  },
  // Major circle in local XY; radius is the major radius, tube the minor radius.
  torus(part) {
    if (!positive(part.radius) || !positive(part.tube)) fail(part.id + ' torus needs radius and tube');
    return new TorusGeometry(part.radius, part.tube, part.radial_segments ?? 8, part.tubular_segments ?? 48);
  },
  // profile is [radius, y] pairs revolved a full turn around local Y.
  lathe(part) {
    if (!Array.isArray(part.profile) || part.profile.length < 2 || !part.profile.every(p => isVector(p, 2))) fail(part.id + ' lathe needs a profile');
    return new LatheGeometry(part.profile.map(p => new Vector2(...p)), part.segments ?? 48);
  },
  // Round rod from start to end in model coordinates; position/rotation are not used.
  beam(part) {
    if (!isVector(part.start, 3) || !isVector(part.end, 3) || !positive(part.radius)) fail(part.id + ' beam needs start, end and radius');
    const length = new Vector3(...part.start).distanceTo(new Vector3(...part.end));
    if (!positive(length)) fail(part.id + ' beam has zero length');
    return new CylinderGeometry(part.radius, part.radius, length, part.segments ?? 12);
  },
  // polygon (and optional holes) in local XY, extruded from local Z = 0 to Z = depth.
  // Note the solid is NOT centred in Z: position places its back face.
  extrude(part) {
    const ring = points => Array.isArray(points) && points.length >= 3 && points.every(p => isVector(p, 2));
    if (!ring(part.polygon) || !positive(part.depth) || !(part.holes ?? []).every(ring)) fail(part.id + ' extrude needs a polygon and depth');
    const shape = new Shape(part.polygon.map(p => new Vector2(...p)));
    for (const hole of part.holes ?? []) shape.holes.push(new Path(hole.map(p => new Vector2(...p))));
    return new ExtrudeGeometry(shape, { depth: part.depth, bevelEnabled: false, curveSegments: 1 });
  },
  // Explicit triangles for shapes the other primitives cannot express (hip roofs, etc.).
  mesh(part) {
    if (!Array.isArray(part.vertices) || !part.vertices.every(v => isVector(v, 3)) ||
        !Array.isArray(part.triangles) || !part.triangles.length ||
        !part.triangles.every(t => isVector(t, 3) && t.every(i => Number.isInteger(i) && i >= 0 && i < part.vertices.length))) {
      fail(part.id + ' mesh needs vertices and index triples');
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(part.triangles.flatMap(t => t.flatMap(i => part.vertices[i])), 3));
    return geometry;
  },
};
export const PRIMITIVE_TYPES = Object.keys(PRIMITIVES);

export function validateModel(model) {
  if (model?.schema !== MODEL_SCHEMA) fail('schema must be ' + MODEL_SCHEMA);
  if (!ID.test(model.id ?? '')) fail('invalid id');
  for (const key of ['title', 'archetype']) if (typeof model[key] !== 'string' || !model[key]) fail('missing ' + key);
  if (typeof model.frame?.origin !== 'string' || typeof model.frame?.front !== 'string') fail('frame needs origin and front sentences');
  const materials = model.materials ?? {};
  for (const [name, material] of Object.entries(materials)) {
    if (!/^#[0-9a-f]{6}$/i.test(material.color ?? '')) fail('material ' + name + ' needs a #rrggbb colour');
    if (!MATERIAL_KINDS.includes(material.kind)) fail('material ' + name + ' has an unknown kind');
  }
  const groups = new Map();
  for (const group of model.groups ?? []) {
    if (!ID.test(group.id ?? '') || groups.has(group.id)) fail('invalid or duplicate group ' + group.id);
    if (typeof group.title !== 'string' || typeof group.category !== 'string') fail('group ' + group.id + ' needs title and category');
    if (!positive(group.detail_size_m)) fail('group ' + group.id + ' needs detail_size_m');
    if (!FACADES.includes(group.facade)) fail('group ' + group.id + ' has an unknown facade');
    groups.set(group.id, 0);
  }
  if (!Array.isArray(model.parts) || !model.parts.length) fail('no parts');
  const ids = new Set();
  for (const part of model.parts) {
    if (!ID.test(part.id ?? '') || ids.has(part.id)) fail('invalid or duplicate part id ' + part.id);
    ids.add(part.id);
    if (!PRIMITIVES[part.type]) fail(part.id + ' has unknown type ' + part.type);
    if (!materials[part.material]) fail(part.id + ' references unknown material ' + part.material);
    if (part.group !== undefined) {
      if (!groups.has(part.group)) fail(part.id + ' references unknown group ' + part.group);
      groups.set(part.group, groups.get(part.group) + 1);
    }
    for (const key of ['position', 'rotation']) if (part[key] !== undefined && !isVector(part[key], 3)) fail(part.id + ' has an invalid ' + key);
    PRIMITIVES[part.type](part).dispose();
  }
  for (const [id, count] of groups) if (!count) fail('group ' + id + ' has no parts');
  const probes = new Set();
  for (const probe of model.probes ?? []) {
    if (!ID.test(probe.id ?? '') || probes.has(probe.id)) fail('invalid or duplicate probe ' + probe.id);
    probes.add(probe.id);
    if (typeof probe.label !== 'string' || !isVector(probe.origin, 3) || !isVector(probe.direction, 3)) fail('probe ' + probe.id + ' needs label, origin and direction');
    if (Math.abs(Math.hypot(...probe.direction) - 1) > 1e-6) fail('probe ' + probe.id + ' direction must be unit length');
  }
  for (const dimension of model.dimensions ?? []) {
    if (!ID.test(dimension.id ?? '') || typeof dimension.label !== 'string' || !positive(dimension.value_m) ||
        !isVector(dimension.a, 3) || !isVector(dimension.b, 3)) fail('invalid dimension ' + dimension.id);
    if (!['front', 'left', 'right', 'rear', 'plan'].includes(dimension.view)) fail('dimension ' + dimension.id + ' has an unknown view');
  }
  return model;
}

// One mesh per part, named by part id, in part order. userData.partIndex links a
// mesh back to model.parts.
export function buildScene(model) {
  const scene = new Group(), cache = new Map();
  for (const [index, part] of model.parts.entries()) {
    const spec = model.materials[part.material];
    if (!cache.has(part.material)) {
      const material = new MeshStandardMaterial({ color: new Color(spec.color), roughness: spec.roughness ?? 0.8, metalness: spec.metalness ?? 0 });
      material.name = part.material;
      cache.set(part.material, material);
    }
    const mesh = new Mesh(PRIMITIVES[part.type](part), cache.get(part.material));
    mesh.name = part.id; mesh.userData.partIndex = index;
    if (part.type === 'beam') {
      const start = new Vector3(...part.start), end = new Vector3(...part.end);
      mesh.position.copy(start).add(end).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), end.sub(start).normalize());
    } else {
      mesh.position.set(...(part.position ?? [0, 0, 0]));
      mesh.rotation.set(...(part.rotation ?? [0, 0, 0]));
    }
    scene.add(mesh);
  }
  scene.updateMatrixWorld(true);
  return scene;
}

export function modelToGLB(model) {
  return sceneToGLB(buildScene(validateModel(model)));
}
