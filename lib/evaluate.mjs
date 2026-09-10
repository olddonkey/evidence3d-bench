import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateTask, validateSubmission, validateTruth } from './contracts.mjs';
import { loadGeometry } from './glb.mjs';
import { dimensionMetrics, intervalMeasurements, rasterize, maskMetrics, overlaySVG } from './metrics.mjs';
import { readJSON, writeJSON, objectHash, sha256, existingContained, verifySources } from './io.mjs';

export const PROTOCOL = 'evidence3d-geometry-v0.1.0';
const implementation = Promise.all(
  ['glb.mjs','metrics.mjs','contracts.mjs','evaluate.mjs','io.mjs',
    '../schemas/task.schema.json','../schemas/submission.schema.json'].map(async name =>
    ({ name, sha256:sha256(await readFile(new URL(name,import.meta.url))) }))
).then(objectHash);
export async function evaluate({ taskPath, submissionPath, truthPath, outputDir }) {
  const task = validateTask(await readJSON(taskPath));
  const submission = validateSubmission(await readJSON(submissionPath), task);
  await verifySources(task, dirname(taskPath));
  const report = {
    schema_version: 1, protocol: PROTOCOL, task_id: task.id, submission_id: submission.id,
    scorer_sha256: await implementation, evaluation_runtime: { node:process.versions.node, three:'0.180.0' },
    task_sha256: objectHash(task), submission_sha256: objectHash(submission),
    split: task.split, system: submission.system, run: submission.run,
    composite_score: null, model_judge_used: false, human_preference: null,
    generated_at: new Date().toISOString(), technical: { valid: false }, metrics: null,
    eligibility: task.split === 'calibration' ? 'calibration_only' : 'unverified',
    warnings: ['Silhouettes do not establish topology, internal geometry, material fidelity, or full 3D surface accuracy.']
  };
  try {
    if (submission.run.wall_seconds > task.budget.wall_seconds) throw new Error('Declared wall-clock budget exceeded');
    const path = await existingContained(dirname(submissionPath), submission.artifact.path);
    const geometry = await loadGeometry(path, task.budget);
    if (geometry.artifact_sha256 !== submission.artifact.sha256) throw new Error('Artifact hash differs from locked submission');
    report.technical = { valid: true, artifact_sha256: geometry.artifact_sha256, bytes: geometry.bytes,
      triangles: geometry.triangles, mesh_count: geometry.mesh_count,
      degenerate_triangles: geometry.degenerate_triangles, surface_area_m2: geometry.surface_area_m2,
      bounds: geometry.bounds };
    if (task.status === 'annotation_pending') {
      report.eligibility = 'annotation_pending';
      report.warnings.push('No independently admitted ground truth. Geometry accuracy is intentionally unscored.');
    } else {
      if (!truthPath) throw new Error('An admitted private ground-truth file is required');
      const truth = validateTruth(await readJSON(truthPath), task);
      report.truth_sha256 = objectHash(truth);
      if (truth.mode === 'measurement_only') {
        const measurements = intervalMeasurements(geometry.bounds, truth.measurements);
        report.metrics = { mode:'measurement_only',measurements,dimensions:[],silhouettes:[],
          max_dimension_error:null,min_silhouette_iou:null,mean_silhouette_iou:null };
        report.geometry_checks_pass = measurements.every(item => item.pass);
        report.eligibility = task.split === 'calibration' ? 'calibration_only' : 'geometry_only_unverified_run';
        report.coverage = { measured:measurements.map(item=>item.id),
          unmeasured:['full surface fidelity','semantic completeness','unannotated dimensions','appearance','hidden geometry'] };
        report.warnings.push('Pass applies only to the independently annotated measurements. Unmeasured geometry remains unknown.');
        if (outputDir) await writeJSON(join(outputDir,'report.json'),report);
        return report;
      }
      const referencePath = await existingContained(dirname(truthPath), truth.reference.path);
      const reference = await loadGeometry(referencePath, task.budget);
      if (reference.artifact_sha256 !== truth.reference.sha256) throw new Error('Reference hash mismatch');
      for (const key of ['min', 'max']) for (let i = 0; i < 3; i++) {
        if (Math.abs(reference.bounds[key][i] - truth.bounds[key][i]) > 1e-5) throw new Error('Reference disagrees with independent locked bounds');
      }
      const dimensions = dimensionMetrics(geometry.bounds, truth.bounds, truth.dimension_tolerance_m, truth.center_tolerance_m);
      const views = [];
      if (outputDir) await mkdir(outputDir, { recursive: true });
      for (const view of truth.views) {
        const predicted = rasterize(geometry.coordinates, view), expected = rasterize(reference.coordinates, view);
        if (expected.outside_vertices) throw new Error('Reference exceeds evaluation frame');
        const values = maskMetrics(predicted.pixels, expected.pixels);
        const overlay = 'overlay-' + view.id + '.svg';
        views.push({ id: view.id, ...values, outside_vertices: predicted.outside_vertices,
          pass: values.iou >= truth.silhouette_pass_iou && predicted.outside_vertices === 0,
          overlay: outputDir ? overlay : null });
        if (outputDir) await writeFile(join(outputDir, overlay), overlaySVG(predicted.pixels, expected.pixels, view.resolution));
      }
      report.metrics = { dimensions, silhouettes: views,
        max_dimension_error: Math.max(...dimensions.map(d => d.relative_error)),
        min_silhouette_iou: Math.min(...views.map(v => v.iou)),
        mean_silhouette_iou: views.reduce((s, v) => s+v.iou, 0)/views.length };
      report.geometry_checks_pass = dimensions.every(d => d.dimension_pass && d.position_pass) && views.every(v => v.pass);
      // A submitted run.json can never certify its own budget or lack of human
      // intervention. v0 has no trusted generation runner, hence no official rank.
      report.eligibility = task.split === 'calibration' ? 'calibration_only' : 'geometry_only_unverified_run';
    }
  } catch (error) {
    // Errors after geometry loading can be evaluator/reference failures; distinguish
    // them from failed submissions rather than penalizing a contestant for bad GT.
    report.error = String(error.message);
    report.eligibility = report.technical.valid ? 'evaluation_error' : 'invalid_submission';
    report.metrics = null; report.geometry_checks_pass = false;
  }
  if (outputDir) await writeJSON(join(outputDir, 'report.json'), report);
  return report;
}
