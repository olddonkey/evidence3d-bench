import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Group } from 'three';
import { sha256, writeJSON, objectHash } from '../../../lib/io.mjs';
import { sceneToGLB } from '../../../lib/glb.mjs';
import { buildScene } from '../model.mjs';
import { soupFromModel } from '../soup.mjs';
import { raycast } from '../raster.mjs';
import { layout, VARIANTS, TASK_SCHEMA, TRUTH_SCHEMA, REPORT_SCHEMA, PROTOCOL, DEFAULT_BUDGET } from '../contract.mjs';
import { encodePNG } from '../png.mjs';
import { shadeSoup, standardViews } from '../render/shade.mjs';
import { sampleModel } from '../../fixtures/sample-model.mjs';

// Writes a small, fully synthetic data root in the documented shapes (task
// packs, truth, run batches with result.json + score/report.json + GLBs) so the
// report can be developed and tested before real runs exist. Every number here
// is made up and labelled as such in the batch summary; never mix this data
// root with real results.

const OBJECTS = ['demo-house-a', 'demo-house-b', 'demo-house-c'];

function objectModel(id) {
  const model = sampleModel();
  model.id = id;
  if (id.endsWith('-b')) model.materials.tile.color = '#3f4b55';
  if (id.endsWith('-c')) model.materials.render.color = '#c9b79a';
  return model;
}

// A GLB of `model` (optionally without some groups) placed so that the scorer's
// alignment p' = s * Ry(yaw) * p + t maps it back onto the truth.
function candidateGLB(model, { dropGroups = [], alignment }) {
  const kept = { ...model, parts: model.parts.filter(part => !dropGroups.includes(part.group)) };
  const outer = new Group(), inner = new Group();
  const s = alignment.scale ?? 1, yaw = (alignment.yaw_deg ?? 0) * Math.PI / 180, t = alignment.translation_m ?? [0, 0, 0];
  // Inverse of the alignment: p = Ry(-yaw) * (p' - t) / s.
  outer.rotation.y = -yaw;
  outer.scale.setScalar(1 / s);
  inner.position.set(-t[0], -t[1], -t[2]);
  inner.add(buildScene(kept));
  outer.add(inner);
  outer.updateMatrixWorld(true);
  return sceneToGLB(outer);
}

function report({ taskId, object, variant, model, score, alignment, detailF = 0.5, probeError = 0.1, contested = null, missingGroups = [] }) {
  const soup = soupFromModel(model);
  const diagonal = Math.hypot(...soup.bounds.max.map((value, i) => value - soup.bounds.min[i]));
  const f = score / 100;
  const groups = model.groups.map((group, i) => {
    const missing = missingGroups.includes(group.id), scored = group.facade !== 'rear';
    const value = missing ? 0 : Math.min(1, detailF + 0.05 * (i % 3));
    return { id: group.id, title: group.title, category: group.category, scored, reason: scored ? null : 'under 50 % evidenced',
      evidenced_fraction: scored ? 0.9 : 0.2, tau_m: 0.6 * group.detail_size_m, precision: value, recall: value, f: value, local_offset_m: 0.03 };
  });
  const categories = [...new Set(groups.filter(group => group.scored).map(group => group.category))]
    .map(id => ({ id, f: groups.filter(group => group.scored && group.category === id).reduce((sum, group, _, list) => sum + group.f / list.length, 0) }));
  const probes = model.probes.map((probe, i) => {
    const hit = raycast(soup, probe.origin, probe.direction);
    const truth = hit ? hit.distance : null, miss = missingGroups.length && i === model.probes.length - 1;
    return { id: probe.id, label: probe.label, truth_m: truth, measured_m: miss ? null : truth + probeError * (i % 2 ? 1 : -1),
      error_m: miss ? null : probeError, evidenced: true };
  });
  const evaluated = probes.filter(probe => probe.measured_m !== null);
  return {
    schema: REPORT_SCHEMA, protocol: PROTOCOL, task_id: taskId, object, variant, valid: true, error: null, score,
    global: { diagonal_m: diagonal, normal_consistency: 0.9,
      thresholds: [0.01, 0.02, 0.05].map(fraction => ({ fraction, tau_m: fraction * diagonal, precision: Math.min(1, f * (fraction / 0.02) ** 0.3),
        recall: Math.min(1, f * (fraction / 0.02) ** 0.3), f: Math.min(1, f * (fraction / 0.02) ** 0.3) })),
      points: { truth: 20000, truth_evidenced: 15000, candidate: 18000, candidate_counted: 16000 } },
    alignment: { ...alignment, scale_locked: VARIANTS[variant].scale === 'metric',
      frame_error: { yaw_deg: alignment.yaw_deg, offset_m: Math.hypot(...alignment.translation_m), offset_fraction: Math.hypot(...alignment.translation_m) / diagonal,
        scale_log: Math.log(alignment.scale) } },
    strict: { f: f * 0.4 }, shape: { f: Math.min(1, f * 1.05), scale: VARIANTS[variant].scale === 'metric' ? 1.04 : alignment.scale },
    detail: { score: 100 * categories.reduce((sum, category) => sum + category.f, 0) / Math.max(1, categories.length), categories, groups },
    probes,
    probe_summary: { evaluated: evaluated.length, missed: probes.length - evaluated.length, mean_error_m: probeError, mean_error_fraction: probeError / diagonal },
    alternates: contested ? [{ id: 'before-canopy', f: f * 0.8, closer_to_primary_fraction: contested.filter(side => side === 'primary').length / contested.length,
      contested: contested.map((side, i) => ({ probe: model.probes[i % model.probes.length].id, primary_m: 2.6, alternate_m: 3.4,
        measured_m: side === 'primary' ? 2.65 : side === 'alternate' ? 3.35 : 3.0, closer_to: side })) }] : [],
    appearance: { delta_e_mean: 9.5, match_fraction: 0.7, compared_points: 12000 },
    technical: { triangles: 700, bytes: 56840, mesh_count: 44, bounds: soup.bounds },
    artifacts: [], timing_ms: 1234,
  };
}

// The attempts written by default. `score: null` is a failed attempt; `status`
// mirrors what a runner would record.
export const SAMPLE_ATTEMPTS = [
  // system codex / gpt-demo / high: three objects, a failure, an excluded attempt, a c1 task
  { system: 'codex', model: 'gpt-demo', effort: 'high', batch: 'demo-codex', object: 'demo-house-a', variant: 't1', attempt: 1, score: 40, dropGroups: ['chimney', 'front.canopy'] },
  { system: 'codex', model: 'gpt-demo', effort: 'high', batch: 'demo-codex', object: 'demo-house-a', variant: 't1', attempt: 2, score: null, status: 'timeout' },
  { system: 'codex', model: 'gpt-demo', effort: 'high', batch: 'demo-codex', object: 'demo-house-a', variant: 't2', attempt: 1, score: 60, dropGroups: ['chimney'] },
  { system: 'codex', model: 'gpt-demo', effort: 'high', batch: 'demo-codex', object: 'demo-house-b', variant: 't1', attempt: 1, score: 30, dropGroups: ['front.windows.upper', 'front.windows.ground'] },
  { system: 'codex', model: 'gpt-demo', effort: 'high', batch: 'demo-codex', object: 'demo-house-b', variant: 't1', attempt: 2, score: null, status: 'infra_error' },
  { system: 'codex', model: 'gpt-demo', effort: 'high', batch: 'demo-codex', object: 'demo-house-b', variant: 't2', attempt: 1, score: null, status: 'ok', invalid: 'Triangle limit exceeded' },
  { system: 'codex', model: 'gpt-demo', effort: 'high', batch: 'demo-codex', object: 'demo-house-c', variant: 't2', attempt: 1, score: 90 },
  { system: 'codex', model: 'gpt-demo', effort: 'high', batch: 'demo-codex', object: 'demo-house-a', variant: 'c1', attempt: 1, score: 50, contested: ['primary', 'primary', 'alternate'] },
  // system claude-code / opus-demo / max: two objects only (low evidence)
  { system: 'claude-code', model: 'opus-demo', effort: 'max', batch: 'demo-claude', object: 'demo-house-a', variant: 't1', attempt: 1, score: 70 },
  { system: 'claude-code', model: 'opus-demo', effort: 'max', batch: 'demo-claude', object: 'demo-house-b', variant: 't1', attempt: 1, score: 50, dropGroups: ['front.canopy'] },
];

export const taskIdFor = (object, variant) => object + '-' + variant;

export async function writeSampleRuns(dataRoot, { attempts = SAMPLE_ATTEMPTS, withModels = true } = {}) {
  const paths = layout(dataRoot), models = new Map();
  for (const id of OBJECTS) {
    const model = objectModel(id);
    models.set(id, model);
    await writeJSON(join(paths.object(id), 'model.json'), model);
  }
  const tasks = new Set(attempts.map(attempt => taskIdFor(attempt.object, attempt.variant)));
  for (const taskId of tasks) {
    const { object, variant } = attempts.find(attempt => taskIdFor(attempt.object, attempt.variant) === taskId);
    const model = models.get(object), soup = soupFromModel(model), inputDir = join(paths.task(taskId), 'inputs');
    await mkdir(inputDir, { recursive: true });
    const inputs = [];
    const add = async (id, file, kind, description, bytes) => {
      await writeFile(join(inputDir, file), bytes);
      inputs.push({ id, path: 'inputs/' + file, kind, captured_at: '2025-09', description, sha256: sha256(bytes), bytes: bytes.length });
    };
    const views = standardViews(soup.bounds, 240);
    // Stand-ins for photographs: shaded renders, not Blender photographs.
    for (const [index, view] of ['front', ...(variant === 't1' ? [] : ['iso', 'iso-rear'])].entries()) {
      const image = shadeSoup(soup, views[view], {});
      await add('source-' + (index + 1), String(index + 1).padStart(2, '0') + '-photo-' + view + '.png', 'photo', 'Synthetic stand-in photograph (' + view + ')',
        encodePNG(image.width, image.height, image.pixels, 3));
    }
    if (variant === 't4') await add('source-9', '09-notes.md', 'notes', 'Survey notes', Buffer.from('# Survey notes\n\n- Overall width 9.0 m\n- Eaves height 5.4 m\n'));
    const task = { schema: TASK_SCHEMA, id: taskId, title: model.title, prompt: 'Rebuild the object shown in the evidence as a GLB (synthetic demo task).',
      variant, target_state: 'As photographed in 2025-09', frame: { unit: 'metre', up: '+Y', origin: model.frame.origin, front: model.frame.front },
      scale_evidence: VARIANTS[variant].scale, inputs, output: { model: 'output/model.glb', notes: 'output/notes.md', rules: [] }, budget: DEFAULT_BUDGET };
    await writeJSON(join(paths.task(taskId), 'task.json'), task);
    await writeJSON(join(paths.truth(taskId), 'truth.json'), { schema: TRUTH_SCHEMA, task_id: taskId, task_sha256: objectHash(task), object, variant,
      scale_evidence: VARIANTS[variant].scale, evidence: VARIANTS[variant].items,
      alternates: variant === 'c1' ? [{ id: 'before-canopy', contested_probes: ['canopy-top'], note: 'The drawings predate the entrance canopy.' }] : [] });
  }
  for (const batch of new Set(attempts.map(attempt => attempt.batch))) {
    const mine = attempts.filter(attempt => attempt.batch === batch);
    await writeJSON(join(paths.runs, batch, 'summary.json'), { batch, synthetic: true, note: 'Made-up demonstration data, not real results', attempts: mine.length });
    for (const [index, spec] of mine.entries()) {
      const taskId = taskIdFor(spec.object, spec.variant), dir = join(paths.runs, batch, taskId, 'a' + spec.attempt), model = models.get(spec.object);
      const alignment = { yaw_deg: 4 + index, scale: VARIANTS[spec.variant].scale === 'metric' ? 1 : 0.8 + 0.1 * (index % 3), translation_m: [0.4 * index, 0, -0.3] };
      let scoreReport = null;
      if (spec.score !== null) {
        scoreReport = report({ taskId, object: spec.object, variant: spec.variant, model, score: spec.score, alignment, detailF: spec.score / 120,
          contested: spec.contested ?? null, missingGroups: spec.dropGroups ?? [] });
      } else if (spec.invalid) {
        scoreReport = { schema: REPORT_SCHEMA, protocol: PROTOCOL, task_id: taskId, object: spec.object, variant: spec.variant, valid: false, error: spec.invalid, score: 0 };
      }
      if (scoreReport) await writeJSON(join(dir, 'score', 'report.json'), scoreReport);
      if (withModels && (spec.score !== null || spec.invalid)) {
        await mkdir(join(dir, 'output'), { recursive: true });
        await writeFile(join(dir, 'output', 'model.glb'), candidateGLB(model, { dropGroups: spec.dropGroups ?? [], alignment }));
      }
      await writeJSON(join(dir, 'result.json'), { task_id: taskId, attempt: spec.attempt, system: spec.system, model: spec.model, effort: spec.effort,
        status: spec.status ?? 'ok', wall_seconds: 300 + 60 * index,
        usage: spec.status === 'infra_error' ? null : { input_tokens: 100000 + 1000 * index, cached_input_tokens: 50000, output_tokens: 20000 + 500 * index },
        cost_usd: null, score: scoreReport ? scoreReport.score : null, report: scoreReport ? 'score/report.json' : null });
    }
  }
  return { objects: OBJECTS, tasks: [...tasks], batches: [...new Set(attempts.map(attempt => attempt.batch))] };
}
