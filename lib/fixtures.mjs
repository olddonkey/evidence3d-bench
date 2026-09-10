import { Group, Mesh, BoxGeometry, BufferGeometry, Float32BufferAttribute, MeshStandardMaterial } from 'three';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sceneToGLB, parseGLB, encodeGLB, geometryFromBytes } from './glb.mjs';
import { objectHash, sha256, writeJSON, readJSON } from './io.mjs';
import { makeViews, rasterize, overlaySVG } from './metrics.mjs';
import { evaluate, PROTOCOL } from './evaluate.mjs';
import { validateTask } from './contracts.mjs';

export const fixtureDefinitions = [
  {
    id: 'calibration-chapel', title: '双塔礼堂 · 校准样例',
    bounds: { min: [-10,0,-15], max: [16,24,15.5] }, feature: 'east-tower',
    boxes: [
      { id: 'nave', size: [20,12,30], center: [0,6,0] },
      { id: 'west-tower', size: [4,24,5], center: [-7,12,13] },
      { id: 'east-tower', size: [4,24,5], center: [7,12,13] },
      { id: 'east-annex', size: [6,6,8], center: [13,3,-4] }
    ],
    roofs: [{ id: 'main-roof', width: 20, length: 30, rise: 5, base: [0,12,0] }]
  },
  {
    id: 'calibration-house', title: '非对称住宅 · 校准样例',
    bounds: { min: [-12,0,-5], max: [7,11,8] }, feature: 'west-annex',
    boxes: [
      { id: 'body', size: [14,7,10], center: [0,3.5,0] },
      { id: 'west-annex', size: [5,4,6], center: [-9.5,2,-2] },
      { id: 'porch', size: [5,3,3], center: [2,1.5,6.5] },
      { id: 'chimney', size: [1.2,4,1.2], center: [-3,9,0] }
    ],
    roofs: [{ id: 'main-roof', width: 14, length: 10, rise: 3, base: [0,7,0] }]
  }
];
export const variants = [
  { id: 'reference', label: '正确参考', kind: 'control' },
  { id: 'material-change', label: '仅改变材质', kind: 'invariance' },
  { id: 'renamed', label: '仅改名称与层级', kind: 'invariance' },
  { id: 'nonindexed', label: '等价顶点表示', kind: 'invariance' },
  { id: 'width-05', label: '宽度增加 5%', kind: 'defect' },
  { id: 'width-10', label: '宽度增加 10%', kind: 'defect' },
  { id: 'width-20', label: '宽度增加 20%', kind: 'defect' },
  { id: 'missing-feature', label: '缺失关键构件', kind: 'defect' },
  { id: 'front-only', label: '压成正面薄片', kind: 'defect' },
  { id: 'mirrored', label: '左右镜像', kind: 'defect' },
  { id: 'floating', label: '整体悬空 2 米', kind: 'defect' },
  { id: 'external-buffer', label: '外部依赖', kind: 'invalid' },
  { id: 'empty', label: '空模型', kind: 'invalid' }
];
function roofGeometry(width, length, rise) {
  const w = width/2, d = length/2, geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([-w,0,-d,w,0,-d,0,rise,-d,-w,0,d,w,0,d,0,rise,d],3));
  geometry.setIndex([0,2,1,3,4,5,0,1,4,0,4,3,1,2,5,1,5,4,0,3,5,0,5,2]);
  return geometry;
}
export function fixtureScene(definition, variant = 'reference') {
  const scene = new Group();
  scene.name = 'fixture-' + variant;
  const material = new MeshStandardMaterial({ color: variant === 'material-change' ? '#e76832' : '#93a8bb', roughness: variant === 'material-change' ? 0.1 : 0.8 });
  material.name = variant;
  if (variant === 'empty') return scene;
  for (const box of definition.boxes) {
    if (variant === 'missing-feature' && box.id === definition.feature) continue;
    const mesh = new Mesh(new BoxGeometry(...box.size), material);
    mesh.position.set(...box.center); mesh.name = box.id; scene.add(mesh);
  }
  for (const roof of definition.roofs) {
    const mesh = new Mesh(roofGeometry(roof.width, roof.length, roof.rise), material);
    mesh.position.set(...roof.base); mesh.name = roof.id; scene.add(mesh);
  }
  if (variant.startsWith('width-')) scene.scale.x = 1 + Number(variant.slice(6))/100;
  if (variant === 'front-only') scene.scale.z = 0.015;
  if (variant === 'mirrored') scene.scale.x = -1;
  if (variant === 'floating') scene.position.y = 2;
  if (variant === 'renamed') {
    const children = [...scene.children], wrapper = new Group();
    scene.clear(); scene.add(wrapper);
    for (const child of children) { child.name = 'anonymous'; wrapper.add(child); }
  }
  if (variant === 'nonindexed') scene.traverse(node => { if (node.isMesh && node.geometry.index) node.geometry = node.geometry.toNonIndexed(); });
  return scene;
}

export function taskDefaults() {
  return {
    schema_version: 1,
    frame: { unit: 'metre', up: 'Y', alignment: 'fixed_no_fitting',
      description: 'Right-handed glTF frame. Y is up. Use the source origin and axes; evaluation does not resize, center, rotate, or fit a submission.' },
    output_contract: { format: 'GLB 2.0', geometry: 'static_uncompressed_triangles',
      scope: 'Target exterior only, excluding ground planes, lights, cameras, neighbouring objects and decorative scenery.',
      prohibited: ['external resources', 'animations and skins', 'compressed or quantized geometry', 'access to evaluator reference assets', 'reuse of old target models'] },
    budget: { wall_seconds: 1800, max_artifact_bytes: 268435456, max_triangles: 3000000 }
  };
}

export async function buildCalibration(dataRoot) {
  const entries = [], tasks = [];
  for (const definition of fixtureDefinitions) {
    const taskDir = join(dataRoot, 'tasks', definition.id), truthDir = join(dataRoot, 'private', definition.id);
    await mkdir(join(taskDir, 'inputs'), { recursive: true }); await mkdir(truthDir, { recursive: true });
    const dimensions = Buffer.from(JSON.stringify({ unit: 'metre', axes: { x: 'right', y: 'up', z: 'front' },
      boxes: definition.boxes, gable_roofs: definition.roofs }, null, 2) + '\n');
    await writeFile(join(taskDir, 'inputs', 'dimensions.json'), dimensions);
    const referenceBytes = sceneToGLB(fixtureScene(definition)), reference = await geometryFromBytes(referenceBytes);
    // Independent analytic extent check catches exporter, transform and extraction errors.
    for (const key of ['min','max']) for (let i=0;i<3;i++) {
      if (Math.abs(reference.bounds[key][i]-definition.bounds[key][i]) > 1e-6) throw new Error('Fixture disagrees with analytic bounds: ' + definition.id);
    }
    const views = makeViews(definition.bounds);
    const planMask = rasterize(reference.coordinates, views.find(v => v.id === 'top')).pixels;
    const plan = Buffer.from(overlaySVG(planMask, planMask, 192));
    await writeFile(join(taskDir, 'inputs', 'plan.svg'), plan);
    const task = validateTask({
      ...taskDefaults(), id: definition.id, title: definition.title, split: 'calibration', status: 'calibration_only',
      prompt: 'Reconstruct the synthetic building described in dimensions.json. Renderable surfaces must match the listed solids and gable roofs in the stated metric frame. plan.svg is an auxiliary top-view silhouette. Use no scenery. This public synthetic task tests the evaluator and is not an unseen real-world benchmark.',
      inputs: [['dimensions.json', dimensions], ['plan.svg',plan]].map(([name,bytes],i) => ({
        id: 'source-' + (i+1), path: 'inputs/' + name, sha256: sha256(bytes), bytes: bytes.length,
        role: 'synthetic_reference', source: 'Analytic calibration fixture v1', captured_at: null, rights: 'generated_calibration'
      })), rights: 'generated_calibration'
    });
    await writeJSON(join(taskDir, 'task.json'), task);
    await writeFile(join(truthDir, 'reference.glb'), referenceBytes);
    const truth = {
      schema_version: 1, task_id: task.id, task_sha256: objectHash(task),
      provenance: { kind: 'analytic_fixture', source: 'Explicit box extents and gable roof measurements in fixtureDefinitions. Bounds are independently enumerated.' },
      reference: { path: 'reference.glb', sha256: sha256(referenceBytes) }, bounds: definition.bounds,
      dimension_tolerance_m: 0.01, center_tolerance_m: 0.01, silhouette_pass_iou: 0.985, views
    };
    await writeJSON(join(truthDir, 'truth.json'), truth);
    tasks.push({ id: task.id, title: task.title, status: task.status, split: task.split, task_sha256: objectHash(task), truth_sha256: objectHash(truth) });
    for (const variant of variants) {
      const id = task.id + '--' + variant.id, submissionDir = join(dataRoot, 'submissions', id);
      await mkdir(submissionDir, { recursive: true });
      let bytes = sceneToGLB(fixtureScene(definition, variant.id));
      if (variant.id === 'external-buffer') {
        const parsed = parseGLB(bytes); parsed.json.buffers[0].uri = 'https://example.invalid/forbidden.bin';
        bytes = encodeGLB(parsed.json, parsed.binary);
      }
      await writeFile(join(submissionDir, 'model.glb'), bytes);
      const submission = {
        schema_version: 1, id, task_id: task.id, task_sha256: objectHash(task),
        artifact: { path: 'model.glb', sha256: sha256(bytes) },
        system: { name: 'Analytic fixture / ' + variant.id, model_version: 'not-an-AI-run', harness_version: 'fixture-v1' },
        run: { seed: 0, wall_seconds: 0, cost_usd: 0, human_intervention: false, resource_accounting: 'fixture' }
      };
      await writeJSON(join(submissionDir, 'submission.json'), submission);
      const report = await evaluate({
        taskPath: join(taskDir, 'task.json'), submissionPath: join(submissionDir, 'submission.json'),
        truthPath: join(truthDir, 'truth.json'), outputDir: join(dataRoot, 'reports', id)
      });
      entries.push({ id, task_id: task.id, variant: variant.id, label: variant.label, kind: variant.kind, artifact_sha256: sha256(bytes), report });
    }
  }
  const checks = [];
  const add = (id, passed, description, evidence) => checks.push({ id, passed, description, evidence });
  for (const task of tasks) {
    const rows = Object.fromEntries(entries.filter(e => e.task_id === task.id).map(e => [e.variant,e.report]));
    const base = rows.reference;
    add(task.id + ':identity', base.geometry_checks_pass && base.metrics.min_silhouette_iou === 1, '相同几何得到完整重合', { min_iou: base.metrics?.min_silhouette_iou });
    for (const name of ['material-change','renamed','nonindexed']) {
      add(task.id + ':' + name, JSON.stringify(rows[name].metrics) === JSON.stringify(base.metrics),
        '几何结果不受材质、命名或等价顶点表示影响', { condition: name });
    }
    const widths = ['width-05','width-10','width-20'].map(id => rows[id].metrics.dimensions[0].relative_error);
    add(task.id + ':monotonic-scale', widths.every((value,i) => Math.abs(value-[0.05,0.1,0.2][i]) < 1e-6) && widths[0]<widths[1] && widths[1]<widths[2],
      '宽度误差随 5% / 10% / 20% 扰动单调增加', { measured: widths });
    for (const name of ['missing-feature','front-only','mirrored']) {
      add(task.id + ':' + name, rows[name].technical.valid && !rows[name].geometry_checks_pass && rows[name].metrics.min_silhouette_iou < 0.985,
        '结构扰动被固定视角几何检查检出', { min_iou: rows[name].metrics?.min_silhouette_iou });
    }
    add(task.id + ':translation', Math.abs(rows.floating.metrics.dimensions[1].center_error_m-2)<1e-6 && !rows.floating.geometry_checks_pass,
      '固定坐标系检出悬空，不自动对齐抹去误差', { center_error_m: rows.floating.metrics.dimensions[1].center_error_m });
    for (const name of ['external-buffer','empty']) add(task.id + ':' + name,
      !rows[name].technical.valid && rows[name].eligibility === 'invalid_submission', '无效提交保留在结果中', { error: rows[name].error });
  }
  const calibration = {
    schema_version: 1, protocol: PROTOCOL, generated_at: new Date().toISOString(),
    passed: checks.every(c => c.passed), checks, task_count: tasks.length, submission_count: entries.length,
    scope: 'Evaluator calibration using synthetic known defects. No AI generation or human preference experiment has been run.',
    known_blind_spots: [
      'Projected silhouettes cannot establish hidden surfaces, internal structure, watertightness, or full mesh topology.',
      'Duplicate coincident surfaces may preserve all silhouette and dimension metrics.',
      'No real building has independently admitted geometry truth in this release.',
      'This calibration does not establish correlation with independent human judgments.'
    ]
  };
  await writeJSON(join(dataRoot, 'calibration.json'), calibration);
  await writeJSON(join(dataRoot, 'run-index.json'), { schema_version: 1, protocol: PROTOCOL, tasks, entries: entries.map(({ report, ...entry }) => entry) });
  return calibration;
}
