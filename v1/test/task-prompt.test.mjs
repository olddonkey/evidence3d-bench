import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskPrompt, setPromptVersion, taskPromptVersion, buildTask, TASK_PROMPT, TASK_PROMPT_VERSIONS, TASK_PROMPT_SCORER } from '../lib/pack.mjs';
import { VARIANTS, layout } from '../lib/contract.mjs';
import { sampleModel } from '../fixtures/sample-model.mjs';
import { SCORER_VERSION } from '../lib/score/version.mjs';
import { SHAPE_FRACTIONS } from '../lib/score/metrics.mjs';
import { DETAIL_TAU_FACTOR, MIN_EVIDENCED_FRACTION, NORMAL_AGREEMENT_DEG } from '../lib/score/detail.mjs';
import { PointGrid } from '../lib/score/grid.mjs';
import { validateStatic } from '../../lib/glb.mjs';

const run = promisify(execFile);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const sha = text => createHash('sha256').update(text).digest('hex');

// One input list per variant, shaped as buildTask writes them: generated
// variants by standard item (stale drawings dated as c1's are), real variants
// by kind with dates of their own.
const DATES = { photo: '2025-09', aerial: '2025-09', plan: '2025-02', elevation: '2025-02', notes: '2025-06' };
const kindOf = id => id.startsWith('photo') ? 'photo' : id.startsWith('elevation') ? 'elevation' : id;
function inputsFor(variant) {
  const spec = VARIANTS[variant];
  if (spec.kinds) return [
    { path: 'inputs/01-photo-a.jpg', kind: 'photo', description: 'Photograph from the street', captured_at: '2026-06' },
    { path: 'inputs/02-photo-b.jpg', kind: 'photo', description: 'Photograph from the car park', captured_at: '2026-07' },
    { path: 'inputs/03-aerial.png', kind: 'aerial', description: 'Aerial view', captured_at: '2026-08' },
    ...(spec.kinds.includes('notes') ? [{ path: 'inputs/04-notes.md', kind: 'notes', description: 'Survey notes', captured_at: '2026-07' }] : []),
  ];
  return spec.items.map((id, k) => ({ path: 'inputs/' + String(k + 1).padStart(2, '0') + '-' + id + (id === 'notes' ? '.md' : '.png'), kind: kindOf(id),
    description: 'Standard item ' + id, captured_at: spec.stale?.includes(id) ? '2017-04' : DATES[kindOf(id)] }));
}

// Version 1 is the wording of every set built so far (dev, test-2026-10, the
// memory and real sets). The prompt is in task.json and so in the task hash:
// these must never change. Taken at 64be108; for t1–t4 and c1 the same text as
// at the freeze commit of test-2026-10 (74eae6b).
const V1_SHA256 = {
  t1: 'e2a57f230aaf8464d3cad95b1f52c8bbe7040a7d6bac09cdab11794ed3e739bf',
  t2: 'aef3166f3eca8e944b5040221231c83e7b573c1148e0809dc433a4f97f237c1a',
  t3: '654a4b07ad7737540329ce1f6882766385f54925af9359bc52c9b2f93b4a2736',
  t4: '4e74422f2e72e2e89076f1dc58694a384f3f4821e8c023d8e2c93576d805d0a7',
  c1: '7f5b5b8f0a5ee4c3bc8547c47163cb53fc226cdb1cb4c79cb15d1f81aed214e9',
  m2: 'd465d49d8b2f0e5a22f8e99728e88af322f927a3f884043bf3147b0e3de12947',
  m3: '2051e8bc6a418c8e2ff3d90d3f7b54ca47386f4704eeee02328e4511e3add11a',
  r2: '4d77903288b38405522dbab3d4a08cbf82438ac2efd4097a5333984bc846b9e4',
  r4: 'aecabe477bb14e93b685c7a4899ef86ba3089a52635b682fb003832c84903ccf',
};

// Version 2's scoring paragraph, scale-free and metric. Pinned for the same
// reason once a set has been built with it: a change of wording is a new version.
const V2_SCORING_SHA256 = {
  none: '1c399eb2f63f1f00fb52487e4e2609ab9825d75967c80f262bba1f4aa86235b0',
  metric: 'e669bcb643f3338a7dee657fbc7e729733fb4c857d9452fb4ccdd787547e37e6',
};

test('version 1 of the task prompt is byte for byte the wording of the existing sets', () => {
  const model = sampleModel();
  for (const variant of Object.keys(VARIANTS)) assert.equal(sha(taskPrompt(model, variant, inputsFor(variant), 1)), V1_SHA256[variant], variant);
});

test('version 2 changes only the scoring paragraph, and that paragraph is pinned', () => {
  const model = sampleModel();
  assert.equal(TASK_PROMPT, 2);
  assert.deepEqual(TASK_PROMPT_VERSIONS, [1, 2]);
  for (const variant of Object.keys(VARIANTS)) {
    const inputs = inputsFor(variant), one = taskPrompt(model, variant, inputs, 1).split('\n\n'), two = taskPrompt(model, variant, inputs).split('\n\n');
    assert.equal(taskPrompt(model, variant, inputs), taskPrompt(model, variant, inputs, 2), variant + ': version 2 is the default');
    assert.deepEqual(two.slice(0, -1), one.slice(0, -1), variant + ': everything before the scoring paragraph is unchanged');
    const scoring = two.at(-1), metric = VARIANTS[variant].scale === 'metric';
    assert.ok(scoring.startsWith('How it is scored: '), variant);
    assert.equal(sha(scoring), V2_SCORING_SHA256[metric ? 'metric' : 'none'], variant);
    assert.equal(scoring.includes('scaled uniformly'), !metric, variant + ': only a scale-free task is fitted in scale');
  }
  assert.throws(() => taskPrompt(model, 't1', inputsFor('t1'), 3), /Unknown task prompt version 3/);
});

// What the latest wording says must be what the current scorer computes
// (v1/lib/score/README.md). When the scorer's definition changes this fails:
// add a version for the sets built after the change; never edit an old one.
test('the latest wording describes the current scorer', () => {
  assert.equal(TASK_PROMPT_SCORER[TASK_PROMPT], SCORER_VERSION);
  const text = taskPrompt(sampleModel(), 't2', inputsFor('t2')).split('\n\n').at(-1);
  const percent = SHAPE_FRACTIONS.map(fraction => Number((fraction * 100).toPrecision(6)) + ' %');
  assert.ok(text.includes(percent.slice(0, -1).join(', ') + ' and ' + percent.at(-1) + ' of the reference\'s bounding-box diagonal'), 'shape tolerances');
  assert.ok(text.includes('100 × the mean of the three F values') && SHAPE_FRACTIONS.length === 3, 'shape score');
  assert.ok(text.includes('the mean of a shape score and a detail score'), 'score = (shape + detail) / 2');
  assert.ok(text.includes(DETAIL_TAU_FACTOR + ' × its feature size'), 'detail tolerance');
  assert.ok(text.includes('within ' + NORMAL_AGREEMENT_DEG + '°; which side it faces does not matter'), 'detail normals');
  // ... because the detail match compares normals up to sign: a reversed face still matches.
  const grid = new PointGrid([0, 0, 0], 1), cos = Math.cos(NORMAL_AGREEMENT_DEG * Math.PI / 180);
  assert.ok(grid.anyFacing(0, 0, 0, 0.5, [0, 0, 1], 0, 0, -1, cos), 'antiparallel normals match');
  assert.ok(!grid.anyFacing(0, 0, 0, 0.5, [0, 0, 1], 1, 0, 0, cos), 'perpendicular normals do not');
  assert.ok(text.includes('less than half') && MIN_EVIDENCED_FRACTION === 0.5, 'unscored groups');
  assert.ok(text.includes('mean over categories of the mean F of their groups'), 'detail score');
  assert.ok(!/counts most|within a few percent/.test(text), 'none of the version 1 wording that 1.1.0 contradicts');
  // Zero is promised only for what the reader refuses: animations are, cameras are not
  // (they are stripped before scoring), so the text must not promise zero for every output rule.
  assert.ok(text.includes('animations, skins, morph targets, compressed geometry and external resources are refused') && !text.includes('output rules'));
  const glb = extra => ({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }], scenes: [{ nodes: [0] }], nodes: [{ camera: 0 }], cameras: [{ type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }], ...extra });
  assert.doesNotThrow(() => validateStatic(glb({}), Buffer.alloc(4)));
  assert.throws(() => validateStatic(glb({ animations: [{ channels: [], samplers: [] }] }), Buffer.alloc(4)), /animations/);
});

test('a set file names its wording; one without the field keeps version 1', async () => {
  assert.equal(setPromptVersion({ name: 'old' }), 1);
  assert.equal(setPromptVersion({ name: 'new', task_prompt: 2 }), 2);
  assert.throws(() => setPromptVersion({ name: 'odd', task_prompt: 7 }), /unknown task_prompt 7/);
  assert.throws(() => setPromptVersion({ name: 'odd', task_prompt: '2' }), /unknown task_prompt "2"/);
  // The public dev set was built before the field existed and must rebuild as it was.
  assert.equal(setPromptVersion(JSON.parse(await readFile(join(root, 'v1', 'sets', 'dev.json'), 'utf8'))), 1);
});

// Minimal JPEG and a stand-in for Blender (as in landmarks.test.mjs), so the
// CLI builds an object without rendering anything.
function fakeJpeg(width, height) {
  const segment = (marker, body) => { const head = Buffer.from([0xff, marker, 0, 0]); head.writeUInt16BE(body.length + 2, 2); return Buffer.concat([head, body]); };
  const sof = Buffer.alloc(15); sof[0] = 8; sof.writeUInt16BE(height, 1); sof.writeUInt16BE(width, 3); sof[5] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')), segment(0xc0, sof),
    segment(0xda, Buffer.alloc(10)), Buffer.from([1, 2, 3, 0xff, 0xd9])]);
}
const FAKE_BLENDER = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const spec = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--') + 1], 'utf8'));
const jpeg = Buffer.from(process.env.E3D_FAKE_JPEG, 'base64');
for (const shot of spec.shots) {
  fs.mkdirSync(path.dirname(shot.file), { recursive: true });
  const bytes = Buffer.from(jpeg); bytes.writeUInt16BE(shot.height, bytes.indexOf(Buffer.from([0xff, 0xc0])) + 5); bytes.writeUInt16BE(shot.width, bytes.indexOf(Buffer.from([0xff, 0xc0])) + 7);
  fs.writeFileSync(shot.file, bytes);
}
fs.writeFileSync(spec.result, JSON.stringify({ ok: true, engine: { engine: 'fake' }, blender: 'fake', setup_seconds: 0, sky_irradiance: 1,
  shots: spec.shots.map(s => ({ id: s.id, seconds: 0, render_seconds: 0 })) }));
`;

test('new-set writes the current wording; build-set and buildTask keep each set to one wording', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'e3d-task-prompt-test-'));
  try {
    const blender = join(dir, 'fake-blender.cjs'), dataRoot = join(dir, 'data'), cli = join(root, 'v1', 'cli.mjs');
    await writeFile(blender, FAKE_BLENDER);
    await chmod(blender, 0o755);
    const env = { ...process.env, E3D_FAKE_JPEG: fakeJpeg(16, 16).toString('base64') };
    const cliRun = (...args) => run(process.execPath, [cli, ...args, '--data', dataRoot], { env, maxBuffer: 1 << 24 });

    await cliRun('new-set', '--name', 'fresh', '--per-archetype', '1', '--archetypes', 'house');
    const fresh = JSON.parse(await readFile(join(dataRoot, 'sets', 'fresh.json'), 'utf8'));
    assert.equal(fresh.task_prompt, TASK_PROMPT);

    // One object, two set files: one as written before the field existed, one
    // naming version 2. The second build finds the object already built.
    const object = { id: 'obj-0a1b2c3d', archetype: 'house', seed: 11 };
    const oldSet = join(dir, 'old.json'), newSet = join(dir, 'new.json');
    await writeFile(oldSet, JSON.stringify({ name: 'old', variants: ['t1'], objects: [object] }));
    await writeFile(newSet, JSON.stringify({ name: 'new', task_prompt: 2, variants: ['t3'], objects: [object] }));
    await cliRun('build-set', '--set', oldSet, '--blender', blender, '--quality', 'draft');
    await cliRun('build-set', '--set', newSet, '--blender', blender, '--quality', 'draft');

    const paths = layout(dataRoot), model = JSON.parse(await readFile(join(paths.object(object.id), 'model.json'), 'utf8'));
    const task = async variant => JSON.parse(await readFile(join(paths.task(object.id + '-' + variant), 'task.json'), 'utf8'));
    const t1 = await task('t1'), t3 = await task('t3');
    assert.equal(t1.prompt, taskPrompt(model, 't1', t1.inputs, 1));
    assert.equal(t3.prompt, taskPrompt(model, 't3', t3.inputs, 2));
    assert.match(t1.prompt, /Overall shape counts most/);
    assert.match(t3.prompt, /the two count equally/);
    assert.deepEqual([taskPromptVersion(t1), taskPromptVersion(t3), taskPromptVersion({ ...t1, prompt: t1.prompt + ' edited' })], [1, 2, null]);
    for (const [name, version] of [['old', 1], ['new', 2]]) {
      assert.equal(JSON.parse(await readFile(join(dataRoot, 'sets', name + '.built.json'), 'utf8')).task_prompt, version, name);
    }

    // A task of no set takes the latest. build-set then refuses to reuse it for
    // the old set rather than recording a set that mixes wordings.
    await cliRun('build-task', '--object', object.id, '--variant', 't2');
    assert.equal(taskPromptVersion(await task('t2')), TASK_PROMPT);
    await assert.rejects(cliRun('build-set', '--set', oldSet, '--variants', 't1,t2', '--blender', blender),
      error => /Task obj-0a1b2c3d-t2 exists with task prompt version 2, but this set is built with version 1/.test(error.stderr));

    // Adding to an existing set (as real.mjs build --set does, with no version
    // given) takes the set's wording; asking for another is refused.
    await buildTask({ dataRoot, objectId: object.id, variant: 't4', set: 'old' });
    assert.equal(taskPromptVersion(await task('t4')), 1);
    await assert.rejects(buildTask({ dataRoot, objectId: object.id, variant: 'c1', set: 'old', promptVersion: 2 }),
      /Set old was built with task prompt version 1; refusing a version 2 task/);

    const { stdout } = await cliRun('verify');
    assert.match(stdout, /across 4 tasks/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
