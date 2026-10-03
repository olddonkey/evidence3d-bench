import { join } from 'node:path';
import { Group, Mesh, BoxGeometry, SphereGeometry, CylinderGeometry, MeshBasicMaterial } from 'three';

// Shared names and shapes for the v1 ("hidden truth") protocol. docs: v1/DESIGN.md
export const PROTOCOL = 'evidence3d-v1.0.0';
export const TASK_SCHEMA = 'e3d-task-v1';
export const TRUTH_SCHEMA = 'e3d-truth-v1';
export const EVIDENCE_SCHEMA = 'e3d-evidence-v1';
export const REPORT_SCHEMA = 'e3d-report-v1';

export const EVIDENCE_KINDS = ['photo', 'aerial', 'elevation', 'plan', 'notes'];

// The standard evidence items rendered for every object. A task variant is a
// subset of these, so the same object can be posed at several evidence levels.
export const STANDARD_ITEMS = [
  'photo-front', 'photo-left', 'photo-right', 'photo-rear', 'aerial',
  'plan', 'elevation-front', 'elevation-right', 'notes',
];

// The evidence ladder and the conflict task. Each rung adds one kind of evidence
// to the previous rung, so score differences between rungs are attributable.
// `scale` says whether the evidence fixes absolute size: without metric evidence
// a submission is scored up to a uniform scale.
export const VARIANTS = {
  t1: { title: 'Single photograph', scale: 'none', items: ['photo-front'] },
  t2: { title: 'Photographs from all sides and an aerial view', scale: 'none',
    items: ['photo-front', 'photo-left', 'photo-right', 'photo-rear', 'aerial'] },
  t3: { title: 'Photographs plus scaled drawings', scale: 'metric',
    items: ['photo-front', 'photo-left', 'photo-right', 'photo-rear', 'aerial', 'plan', 'elevation-front', 'elevation-right'] },
  t4: { title: 'Photographs, scaled drawings and survey notes', scale: 'metric',
    items: ['photo-front', 'photo-left', 'photo-right', 'photo-rear', 'aerial', 'plan', 'elevation-front', 'elevation-right', 'notes'] },
  // Same as t3, but the drawings show an earlier state of the building. The
  // photographs are newer and the task asks for the building as photographed.
  c1: { title: 'Photographs plus out-of-date drawings', scale: 'metric', stale: ['plan', 'elevation-front', 'elevation-right'],
    items: ['photo-front', 'photo-left', 'photo-right', 'photo-rear', 'aerial', 'plan', 'elevation-front', 'elevation-right'] },
};

export const DEFAULT_BUDGET = { wall_seconds: 1800, max_artifact_bytes: 67108864, max_triangles: 1500000 };

// Where things live under a data root (default: <repo>/.local/v1).
export function layout(dataRoot) {
  return {
    root: dataRoot,
    object: id => join(dataRoot, 'objects', id),
    task: id => join(dataRoot, 'tasks', id),
    truth: id => join(dataRoot, 'truth', id),
    runs: join(dataRoot, 'runs'),
    reports: join(dataRoot, 'reports'),
  };
}

const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SHA = /^[a-f0-9]{64}$/;
function fail(what, message) { throw new Error(what + ': ' + message); }

// Evidence ids are a standard item name, optionally followed by "@<alternate>"
// for the version rendered from an earlier state of the object.
const EVIDENCE_ID = /^[a-z0-9][a-z0-9._-]{0,79}(@[a-z0-9][a-z0-9._-]{0,39})?$/;

export function validateEvidenceItem(item) {
  if (!EVIDENCE_ID.test(item?.id ?? '')) fail('Evidence', 'invalid id');
  if (!EVIDENCE_KINDS.includes(item.kind)) fail('Evidence', item.id + ' has unknown kind ' + item.kind);
  if (typeof item.file !== 'string' || item.file.startsWith('/') || item.file.includes('..')) fail('Evidence', item.id + ' needs a relative file');
  if (!/^\d{4}-\d{2}$/.test(item.captured_at ?? '')) fail('Evidence', item.id + ' needs captured_at as YYYY-MM');
  if (typeof item.description !== 'string' || !item.description) fail('Evidence', item.id + ' needs a public description');
  if (typeof item.metric !== 'boolean') fail('Evidence', item.id + ' must state whether it carries metric scale');
  if (typeof item.source_model !== 'string') fail('Evidence', item.id + ' needs source_model');
  if (['photo', 'aerial', 'elevation'].includes(item.kind) && !['ortho', 'perspective'].includes(item.camera?.type)) fail('Evidence', item.id + ' needs its camera');
  if (!Array.isArray(item.occluders)) fail('Evidence', item.id + ' needs an occluders array');
  return item;
}

export function validateTask(task) {
  if (task?.schema !== TASK_SCHEMA) fail('Task', 'schema must be ' + TASK_SCHEMA);
  if (!ID.test(task.id ?? '')) fail('Task', 'invalid id');
  for (const key of ['title', 'prompt', 'target_state']) if (typeof task[key] !== 'string' || !task[key]) fail('Task', 'missing ' + key);
  if (!VARIANTS[task.variant]) fail('Task', 'unknown variant');
  if (task.frame?.unit !== 'metre' || task.frame?.up !== '+Y' || !task.frame.origin || !task.frame.front) fail('Task', 'incomplete frame');
  if (!['none', 'metric'].includes(task.scale_evidence)) fail('Task', 'scale_evidence must be none or metric');
  if (!Array.isArray(task.inputs) || !task.inputs.length) fail('Task', 'no inputs');
  const seen = new Set();
  for (const input of task.inputs) {
    if (!ID.test(input.id ?? '') || seen.has(input.id)) fail('Task', 'invalid or duplicate input id');
    seen.add(input.id);
    if (!/^inputs\/[A-Za-z0-9._-]+$/.test(input.path ?? '')) fail('Task', 'input path must be inputs/<file>');
    if (!SHA.test(input.sha256 ?? '') || !Number.isInteger(input.bytes) || input.bytes < 1) fail('Task', 'input ' + input.id + ' is not hash locked');
    if (!EVIDENCE_KINDS.includes(input.kind)) fail('Task', 'input ' + input.id + ' has unknown kind');
  }
  const budget = task.budget ?? {};
  for (const key of ['wall_seconds', 'max_artifact_bytes', 'max_triangles']) if (!Number.isInteger(budget[key]) || budget[key] < 1) fail('Task', 'budget.' + key);
  return task;
}

export function validateTruth(truth) {
  if (truth?.schema !== TRUTH_SCHEMA) fail('Truth', 'schema must be ' + TRUTH_SCHEMA);
  if (!ID.test(truth.task_id ?? '') || !SHA.test(truth.task_sha256 ?? '')) fail('Truth', 'needs task_id and task_sha256');
  if (!ID.test(truth.object ?? '')) fail('Truth', 'needs object id');
  if (!VARIANTS[truth.variant] || !['none', 'metric'].includes(truth.scale_evidence)) fail('Truth', 'needs variant and scale_evidence');
  if (!Array.isArray(truth.evidence) || !truth.evidence.length) fail('Truth', 'needs the evidence item ids used by the task');
  // Which named task set this task belongs to. Results from different sets
  // (public dev, private test) must never be pooled silently.
  if (truth.set !== undefined && !ID.test(truth.set)) fail('Truth', 'set must be a short id');
  for (const alternate of truth.alternates ?? []) {
    if (!ID.test(alternate.id ?? '') || !Array.isArray(alternate.contested_probes)) fail('Truth', 'invalid alternate');
  }
  return truth;
}

// Things standing between a camera and the building in a photograph (trees,
// vehicles, poles). The scorer rasterizes them to decide which ground-truth
// surface a photograph actually shows.
//   { type: 'box', center: [x,y,z], size: [x,y,z], yaw?: radians }
//   { type: 'ellipsoid', center: [x,y,z], radii: [x,y,z] }
//   { type: 'cylinder', base: [x,y,z], radius, height }
export function occluderScene(occluders) {
  const scene = new Group(), material = new MeshBasicMaterial();
  for (const item of occluders) {
    let mesh;
    if (item.type === 'box') {
      mesh = new Mesh(new BoxGeometry(...item.size), material);
      mesh.position.set(...item.center); mesh.rotation.y = item.yaw ?? 0;
    } else if (item.type === 'ellipsoid') {
      mesh = new Mesh(new SphereGeometry(1, 24, 16), material);
      mesh.position.set(...item.center); mesh.scale.set(...item.radii);
    } else if (item.type === 'cylinder') {
      mesh = new Mesh(new CylinderGeometry(item.radius, item.radius, item.height, 20), material);
      mesh.position.set(item.base[0], item.base[1] + item.height / 2, item.base[2]);
    } else throw new Error('Unknown occluder type ' + item.type);
    scene.add(mesh);
  }
  scene.updateMatrixWorld(true);
  return scene;
}
