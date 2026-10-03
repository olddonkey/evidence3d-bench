import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Group } from 'three';
import { sha256, writeJSON, objectHash } from '../../../lib/io.mjs';
import { sceneToGLB } from '../../../lib/glb.mjs';
import { buildScene } from '../model.mjs';
import { soupFromModel, transformPoint } from '../soup.mjs';
import { raycast } from '../raster.mjs';
import { rng } from '../rng.mjs';
import { layout, VARIANTS, TASK_SCHEMA, TRUTH_SCHEMA, REPORT_SCHEMA, PROTOCOL, DEFAULT_BUDGET } from '../contract.mjs';
import { encodePNG } from '../png.mjs';
import { shadeSoup, standardViews } from '../render/shade.mjs';
import { sampleModel } from '../../fixtures/sample-model.mjs';

// Writes a small, fully SYNTHETIC data root in the documented shapes (task
// packs, truth, run batches with manifest.json + result.json +
// score/report.json + GLBs) so the report can be developed and tested before
// real runs exist. Every number here is made up and labelled as such in the
// batch summary and manifest; never mix this data root with real results.

const OBJECTS = ['demo-house-a', 'demo-house-b', 'demo-house-c'];
const SYNTHETIC_START = Date.UTC(2026, 8, 1, 9, 0, 0);

function objectModel(id, archetype) {
  const model = sampleModel();
  model.id = id;
  if (archetype) model.archetype = archetype;
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

// The candidate's own bounds as the scorer records them (technical.bounds, in
// the GLB's frame): the kept parts' box carried through the inverse alignment.
function candidateBounds(model, dropGroups, alignment) {
  const kept = soupFromModel({ ...model, parts: model.parts.filter(part => !dropGroups.includes(part.group)) }).bounds;
  const s = alignment.scale ?? 1, yaw = (alignment.yaw_deg ?? 0) * Math.PI / 180, t = alignment.translation_m ?? [0, 0, 0];
  const corners = [];
  for (const x of [kept.min[0], kept.max[0]]) for (const y of [kept.min[1], kept.max[1]]) for (const z of [kept.min[2], kept.max[2]]) {
    corners.push(transformPoint([x - t[0], y - t[1], z - t[2]], { scale: 1 / s, yaw: -yaw }));
  }
  return { min: [0, 1, 2].map(i => Math.min(...corners.map(corner => corner[i]))), max: [0, 1, 2].map(i => Math.max(...corners.map(corner => corner[i]))) };
}

function report({ taskId, object, variant, model, soup, score, alignment, detailF = 0.5, probeError = 0.1, contested = null, missingGroups = [],
  thresholds = [0.01, 0.02, 0.05], shapeFractions = null, scorer = null }) {
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
  const rowF = fraction => Math.min(1, f * (fraction / 0.02) ** 0.3);
  return {
    schema: REPORT_SCHEMA, protocol: PROTOCOL, task_id: taskId, object, variant, valid: true, error: null, score,
    ...(scorer ? { scorer: { sha256: scorer } } : {}),
    global: { diagonal_m: diagonal, normal_consistency: 0.9,
      thresholds: thresholds.map(fraction => ({ fraction, tau_m: fraction * diagonal, precision: rowF(fraction), recall: rowF(fraction), f: rowF(fraction),
        ...(shapeFractions ? { in_shape_score: shapeFractions.includes(fraction) } : {}) })),
      points: { truth: 20000, truth_evidenced: 15000, candidate: 18000, candidate_counted: 16000 } },
    shape_score: 100 * Math.min(1, f * 1.05),
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
    technical: { triangles: 700, bytes: 56840, mesh_count: 44, bounds: candidateBounds(model, missingGroups, alignment) },
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

// A larger SYNTHETIC design shaped like the planned test run, for exercising
// multi-attempt logic before real data exists: objects in two named sets,
// variants t2 / t4 / c1, two strong configurations with three attempts per task
// (one of them split over two batch directories), one weak configuration with
// one attempt per task, an infra_error that must not count and a timeout that
// must. Scores are object effect + configuration effect + attempt noise, so the
// true difference between configurations is known: `effects`.
export function syntheticDesign({ seed = 'e3d-synthetic-design', objects = 6, sets = ['synth-dev', 'synth-test'], effects = { strong: 6, second: 0, weak: -25 },
  objectSD = 10, attemptSD = 4, base = 62 } = {}) {
  const random = rng(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - random.next())) * Math.cos(2 * Math.PI * random.next());
  const archetypes = ['house', 'tower', 'hall'];
  const configs = [
    { name: 'strong', system: 'codex', model: 'synthetic-strong', effort: 'high', attempts: 3, batches: ['synth-strong-1', 'synth-strong-1', 'synth-strong-2'] },
    { name: 'second', system: 'claude-code', model: 'synthetic-second', effort: 'high', attempts: 3, batches: ['synth-second', 'synth-second', 'synth-second'] },
    { name: 'weak', system: 'codex', model: 'synthetic-weak', effort: 'low', attempts: 1, batches: ['synth-weak'] },
  ];
  const variants = { t2: -8, t4: 8, c1: 2 };
  const specs = [];
  for (let o = 0; o < objects; o++) {
    const object = 'synth-obj-' + String(o + 1).padStart(2, '0') + (['-a', '-b', '-c'][o % 3]);
    const set = sets[o % sets.length], archetype = archetypes[o % archetypes.length], objectEffect = objectSD * normal();
    for (const [variant, variantEffect] of Object.entries(variants)) {
      for (const config of configs) {
        for (let n = 1; n <= config.attempts; n++) {
          const raw = base + objectEffect + variantEffect + effects[config.name] + attemptSD * normal();
          specs.push({ system: config.system, model: config.model, effort: config.effort, batch: config.batches[n - 1], object, variant, attempt: n, set, archetype,
            score: Math.round(100 * Math.min(100, Math.max(1, raw))) / 100, status: 'completed',
            ...(variant === 'c1' ? { contested: random.next() < 0.5 ? ['primary', 'primary'] : ['primary', 'alternate'] } : {}) });
        }
      }
    }
  }
  // One harness failure (not a sample) and one timeout without a model (a 0).
  const infra = specs.find(spec => spec.model === 'synthetic-weak' && spec.variant === 't4');
  Object.assign(infra, { score: null, status: 'infra_error' });
  const timeout = specs.find(spec => spec.model === 'synthetic-second' && spec.variant === 'c1' && spec.attempt === 2);
  Object.assign(timeout, { score: null, status: 'timeout' });
  return specs;
}

export const taskIdFor = (object, variant) => object + '-' + variant;

// batchMeta: { [batch]: { cli_version, prompt_sha256, tools_sha256, scorer_sha256 (manifest), report_scorer_sha256 (stamped
// into reports), thresholds, shapeFractions } } overrides the synthetic defaults, so provenance checks can be exercised.
export async function writeSampleRuns(dataRoot, { attempts = SAMPLE_ATTEMPTS, withModels = true, withInputs = true, batchMeta = {} } = {}) {
  const paths = layout(dataRoot), models = new Map(), soups = new Map();
  const objects = [...new Set([...OBJECTS, ...attempts.map(attempt => attempt.object)])];
  for (const id of objects) {
    const model = objectModel(id, attempts.find(attempt => attempt.object === id && attempt.archetype)?.archetype);
    models.set(id, model);
    soups.set(id, soupFromModel(model));
    await writeJSON(join(paths.object(id), 'model.json'), model);
  }
  const tasks = new Set(attempts.map(attempt => taskIdFor(attempt.object, attempt.variant)));
  for (const taskId of tasks) {
    const { object, variant, set } = attempts.find(attempt => taskIdFor(attempt.object, attempt.variant) === taskId);
    const model = models.get(object), soup = soups.get(object), inputDir = join(paths.task(taskId), 'inputs');
    await mkdir(inputDir, { recursive: true });
    const inputs = [];
    const add = async (id, file, kind, description, bytes) => {
      await writeFile(join(inputDir, file), bytes);
      inputs.push({ id, path: 'inputs/' + file, kind, captured_at: '2025-09', description, sha256: sha256(bytes), bytes: bytes.length });
    };
    if (withInputs) {
      const views = standardViews(soup.bounds, 240);
      // Stand-ins for photographs: shaded renders, not Blender photographs.
      for (const [index, view] of ['front', ...(variant === 't1' ? [] : ['iso', 'iso-rear'])].entries()) {
        const image = shadeSoup(soup, views[view], {});
        await add('source-' + (index + 1), String(index + 1).padStart(2, '0') + '-photo-' + view + '.png', 'photo', 'Synthetic stand-in photograph (' + view + ')',
          encodePNG(image.width, image.height, image.pixels, 3));
      }
    }
    if (variant === 't4') await add('source-9', '09-notes.md', 'notes', 'Survey notes', Buffer.from('# Survey notes\n\n- Overall width 9.0 m\n- Eaves height 5.4 m\n'));
    const task = { schema: TASK_SCHEMA, id: taskId, title: model.title, prompt: 'Rebuild the object shown in the evidence as a GLB (synthetic demo task).',
      variant, target_state: 'As photographed in 2025-09', frame: { unit: 'metre', up: '+Y', origin: model.frame.origin, front: model.frame.front },
      scale_evidence: VARIANTS[variant].scale, inputs, output: { model: 'output/model.glb', notes: 'output/notes.md', rules: [] }, budget: DEFAULT_BUDGET };
    await writeJSON(join(paths.task(taskId), 'task.json'), task);
    await writeJSON(join(paths.truth(taskId), 'truth.json'), { schema: TRUTH_SCHEMA, task_id: taskId, task_sha256: objectHash(task), object, variant,
      scale_evidence: VARIANTS[variant].scale, evidence: VARIANTS[variant].items, ...(set ? { set } : {}),
      alternates: variant === 'c1' ? [{ id: 'before-canopy', contested_probes: ['canopy-top'], note: 'The drawings predate the entrance canopy.' }] : [] });
  }
  let clock = 0;
  for (const batch of new Set(attempts.map(attempt => attempt.batch))) {
    const mine = attempts.filter(attempt => attempt.batch === batch), first = mine[0], meta = batchMeta[batch] ?? {};
    const cli = meta.cli_version ?? 'synthetic-' + first.system + ' 0.0.0';
    const manifest = {
      schema: 'e3d-run-batch-v1', runner: 'e3d-runner-v1', protocol: PROTOCOL, id: batch, synthetic: true,
      note: 'Made-up demonstration data, not real results',
      created_at: new Date(SYNTHETIC_START + 3600000 * clock).toISOString(),
      system: first.system, model: first.model, effort: first.effort ?? null, attempts: Math.max(...mine.map(spec => spec.attempt)),
      harness: { system: first.system, version: cli, binary_sha256: sha256('synthetic cli ' + cli), model: first.model, effort: first.effort ?? null },
      node: { version: 'v0.0.0-synthetic' },
      runtime: { three_version: '0.180.0', sha256: sha256('synthetic runtime') },
      tools: { sha256: meta.tools_sha256 ?? sha256('synthetic tools') },
      runner_source: { sha256: sha256('synthetic runner') },
      ...(meta.scorer_sha256 ? { scorer_source: { sha256: meta.scorer_sha256 } } : {}),
      prompt_version: 'e3d-runner-prompt-v1',
      repository: { commit: '0'.repeat(40), dirty: false },
      tasks: [...new Set(mine.map(spec => taskIdFor(spec.object, spec.variant)))].map(id => ({ id,
        prompt_sha256: meta.prompt_sha256 ?? sha256('synthetic prompt for ' + first.system),
        attempts: mine.filter(spec => taskIdFor(spec.object, spec.variant) === id).map(spec => ({ n: spec.attempt, dir: id + '/a' + spec.attempt })) })),
    };
    await writeJSON(join(paths.runs, batch, 'manifest.json'), manifest);
    await writeJSON(join(paths.runs, batch, 'preflight.json'), { schema: 'e3d-preflight-v1', synthetic: true, created_at: manifest.created_at, batch, system: first.system,
      manifest_sha256: objectHash(manifest), passed: true, failed: [], not_evaluated: [] });
    await writeJSON(join(paths.runs, batch, 'summary.json'), { batch, synthetic: true, note: 'Made-up demonstration data, not real results', attempts: mine.length });
    for (const [index, spec] of mine.entries()) {
      const taskId = taskIdFor(spec.object, spec.variant), dir = join(paths.runs, batch, taskId, 'a' + spec.attempt), model = models.get(spec.object);
      const alignment = { yaw_deg: 4 + index % 7, scale: VARIANTS[spec.variant].scale === 'metric' ? 1 : 0.8 + 0.1 * (index % 3), translation_m: [0.4 * (index % 5), 0, -0.3] };
      let scoreReport = null;
      if (spec.score !== null) {
        scoreReport = report({ taskId, object: spec.object, variant: spec.variant, model, soup: soups.get(spec.object), score: spec.score, alignment, detailF: spec.score / 120,
          contested: spec.contested ?? null, missingGroups: spec.dropGroups ?? [], thresholds: meta.thresholds, shapeFractions: meta.shapeFractions,
          scorer: meta.report_scorer_sha256 ?? null });
      } else if (spec.invalid) {
        scoreReport = { schema: REPORT_SCHEMA, protocol: PROTOCOL, task_id: taskId, object: spec.object, variant: spec.variant, valid: false, error: spec.invalid, score: 0 };
      }
      if (scoreReport) await writeJSON(join(dir, 'score', 'report.json'), scoreReport);
      if (withModels && (spec.score !== null || spec.invalid)) {
        await mkdir(join(dir, 'output'), { recursive: true });
        await writeFile(join(dir, 'output', 'model.glb'), candidateGLB(model, { dropGroups: spec.dropGroups ?? [], alignment }));
      }
      const wall = 300 + 60 * (index % 20), started = SYNTHETIC_START + 3600000 * clock + 600000 * index;
      await writeJSON(join(dir, 'result.json'), { task_id: taskId, attempt: spec.attempt, system: spec.system, model: spec.model, effort: spec.effort,
        status: spec.status ?? 'ok', wall_seconds: wall,
        started_at: new Date(started).toISOString(), finished_at: new Date(started + 1000 * wall).toISOString(),
        ...(spec.model_reported !== undefined ? { model_reported: spec.model_reported } : {}),
        ...(spec.status === 'infra_error' ? { infra: { reason: spec.infra_reason ?? 'rate_limit', synthetic: true } } : {}),
        usage: spec.status === 'infra_error' ? null : { input_tokens: 100000 + 1000 * index, cached_input_tokens: 50000, output_tokens: 20000 + 500 * index },
        cost_usd: null, score: scoreReport ? scoreReport.score : null, report: scoreReport ? 'score/report.json' : null });
    }
    clock += 24;
  }
  return { objects, tasks: [...tasks], batches: [...new Set(attempts.map(attempt => attempt.batch))] };
}
