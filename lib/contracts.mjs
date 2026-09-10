import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { objectHash, contained } from './io.mjs';

const ajv = new Ajv({ allErrors: true, strict: true });
const taskValidator = ajv.compile(JSON.parse(readFileSync(new URL('../schemas/task.schema.json', import.meta.url))));
const submissionValidator = ajv.compile(JSON.parse(readFileSync(new URL('../schemas/submission.schema.json', import.meta.url))));
function checked(validator, value) {
  if (!validator(value)) throw new Error(ajv.errorsText(validator.errors));
  return value;
}
export function validateTask(value) {
  checked(taskValidator, value);
  const ids = new Set(), paths = new Set();
  for (const input of value.inputs) {
    contained('/task', input.path);
    if (ids.has(input.id) || paths.has(input.path)) throw new Error('Duplicate task input');
    ids.add(input.id); paths.add(input.path);
  }
  if (value.split === 'calibration' && value.status !== 'calibration_only') throw new Error('Calibration cannot be admitted as a test task');
  return value;
}
export function validateSubmission(value, task) {
  checked(submissionValidator, value);
  contained('/submission', value.artifact.path);
  if (value.task_id !== task.id || value.task_sha256 !== objectHash(task)) throw new Error('Submission belongs to a different task or task revision');
  return value;
}
export function validateTruth(truth, task) {
  if (truth.schema_version !== 1 || truth.task_id !== task.id || truth.task_sha256 !== objectHash(task)) throw new Error('Ground truth task revision mismatch');
  if (task.status === 'annotation_pending') throw new Error('Ground truth has not been independently admitted');
  if (task.split === 'calibration') {
    if (truth.provenance?.kind !== 'analytic_fixture') throw new Error('Calibration needs an analytic reference');
  } else {
    if (truth.provenance?.kind !== 'independent_review' || !Array.isArray(truth.provenance.reviewers) || new Set(truth.provenance.reviewers).size < 2 ||
        !truth.provenance.evidence?.length) throw new Error('Real tasks require two named independent reviewers and evidence');
  }
  if (truth.mode === 'measurement_only') {
    if (truth.reference) throw new Error('Measurement-only truth cannot silently include a mesh reference');
    if (!Array.isArray(truth.measurements) || !truth.measurements.length ||
        new Set(truth.measurements.map(m => m.id)).size !== truth.measurements.length) throw new Error('Independent measurements are required');
    const sourceIds = new Set(task.inputs.map(input => input.id));
    for (const item of truth.measurements) {
      if (!/^[a-z][a-z0-9-]{0,59}$/.test(item.id) || item.kind !== 'bbox_dimension' || !['x','y','z'].includes(item.axis) ||
          !Array.isArray(item.accepted_interval_m) || item.accepted_interval_m.length !== 2 ||
          !item.accepted_interval_m.every(Number.isFinite) || item.accepted_interval_m[0] <= 0 ||
          item.accepted_interval_m[1] < item.accepted_interval_m[0] ||
          !Number.isFinite(item.tolerance_m) || item.tolerance_m <= 0) throw new Error('Invalid independently measured interval');
      if (!Array.isArray(item.source_ids) || !item.source_ids.length || item.source_ids.some(id => !sourceIds.has(id))) throw new Error('Measurement must cite supplied source ids');
    }
    return truth;
  }
  if (truth.mode && truth.mode !== 'mesh_reference') throw new Error('Unsupported ground-truth mode');
  if (!truth.reference?.path || !/^[a-f0-9]{64}$/.test(truth.reference.sha256)) throw new Error('Ground truth reference must be hash locked');
  contained('/truth', truth.reference.path);
  if (!Array.isArray(truth.bounds?.min) || !Array.isArray(truth.bounds?.max) || truth.bounds.min.length !== 3 || truth.bounds.max.length !== 3) throw new Error('Invalid reference bounds');
  for (let i = 0; i < 3; i++) if (!Number.isFinite(truth.bounds.min[i]) || !Number.isFinite(truth.bounds.max[i]) || truth.bounds.max[i] <= truth.bounds.min[i]) throw new Error('Invalid reference bounds');
  if (!Number.isFinite(truth.dimension_tolerance_m) || truth.dimension_tolerance_m <= 0 ||
      !Number.isFinite(truth.center_tolerance_m) || truth.center_tolerance_m <= 0 ||
      !Number.isFinite(truth.silhouette_pass_iou) || truth.silhouette_pass_iou <= 0 || truth.silhouette_pass_iou > 1) throw new Error('Invalid evaluation tolerances');
  if (!Array.isArray(truth.views) || !truth.views.length || new Set(truth.views.map(v => v.id)).size !== truth.views.length) throw new Error('Invalid evaluation views');
  for (const view of truth.views) {
    if (typeof view.id !== 'string' || !/^[a-z][a-z-]{0,39}$/.test(view.id)) throw new Error('Invalid view id');
    for (const key of ['right', 'up', 'origin']) if (!Array.isArray(view[key]) || view[key].length !== 3 || !view[key].every(Number.isFinite)) throw new Error('Invalid view basis');
    const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
    if (Math.abs(dot(view.right, view.right) - 1) > 1e-6 || Math.abs(dot(view.up, view.up) - 1) > 1e-6 || Math.abs(dot(view.right, view.up)) > 1e-6) throw new Error('View basis must be orthonormal');
    if (!Array.isArray(view.extent) || view.extent.length !== 4 || !view.extent.every(Number.isFinite) ||
        view.extent[1] <= view.extent[0] || view.extent[3] <= view.extent[2] || !Number.isInteger(view.resolution) || view.resolution < 32 || view.resolution > 512) throw new Error('Invalid view extent');
  }
  return truth;
}
