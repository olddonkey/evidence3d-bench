import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LANDMARKS, REMEMBERED, CHANGE_RANGE, MIN_COUNT_CHANGE, MIN_CHANGED, MIN_SOURCED_CHANGED, CONTESTED_FRACTION, MIN_CONTESTED, UNIFORM_SCALE_LIMIT,
  generateLandmark, publishedModel, landmarkInfo, uniformScaleMismatch,
} from '../lib/generator/landmarks/index.mjs';
import { validateModel } from '../lib/model.mjs';
import { soupFromModel } from '../lib/soup.mjs';
import { raycast } from '../lib/raster.mjs';
import { probeCheck, featureEdges, dimensionEdgeDistances, zFightReport, viewCamera, STANDARD_VIEWS, groupRelief, diagonal } from '../lib/generator/checks.mjs';
import { VARIANTS, CONFLICT_VARIANTS, layout, validateTruth } from '../lib/contract.mjs';
import { buildObject, buildTask, verifyTasks } from '../lib/pack.mjs';

const near = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' is not within ' + tolerance + ' of ' + expected);
const FT = 0.3048, IN = 0.0254;
const CATEGORIES = ['massing', 'roof', 'openings', 'entrance', 'attachments', 'structure', 'ornament'];

// Generation is deterministic: one cache for the file.
const cache = new Map();
const twin = (landmark, seed) => {
  const key = landmark + ':' + seed;
  if (!cache.has(key)) cache.set(key, generateLandmark({ landmark, seed }));
  return cache.get(key);
};
const dimension = (model, id) => model.dimensions.find(d => d.id === id)?.value_m;

test('four landmarks are registered and bad requests are refused', () => {
  assert.deepEqual([...LANDMARKS], ['elizabeth-tower', 'arc-de-triomphe', 'washington-monument', 'lincoln-memorial']);
  assert.throws(() => generateLandmark({ landmark: 'eiffel-tower', seed: 1 }), /unknown landmark/);
  assert.throws(() => generateLandmark({ landmark: 'arc-de-triomphe', seed: -1 }), /seed/);
  assert.throws(() => generateLandmark({ landmark: 'arc-de-triomphe', seed: 1.5 }), /seed/);
  // The memory variants are conflict variants, and the pack's alternate id is the one the generator writes.
  assert.ok(VARIANTS.m2.memory && VARIANTS.m3.memory && CONFLICT_VARIANTS.includes('m2') && CONFLICT_VARIANTS.includes('m3'));
  assert.equal(twin('arc-de-triomphe', 1).alternate.id, REMEMBERED);
});

test('the published models reproduce the published figures', () => {
  const arc = publishedModel('arc-de-triomphe');
  near(dimension(arc, 'overall-height'), 49.54, 1e-3);
  near(dimension(arc, 'overall-width'), 44.82, 1e-3);
  near(dimension(arc, 'depth'), 22.21, 1e-3);
  near(dimension(arc, 'arch-width'), 14.62, 1e-3);
  near(dimension(arc, 'arch-springing') + 14.62 / 2, 29.19, 1e-3);
  near(dimension(arc, 'vault-width'), 8.44, 1e-3);
  near(dimension(arc, 'vault-springing') + 8.44 / 2, 18.68, 1e-3);
  assert.equal(arc.parts.filter(part => part.group === 'shields').length, 30);

  const monument = publishedModel('washington-monument');
  near(dimension(monument, 'overall-height'), 555 * FT + 5.125 * IN, 1e-3);
  near(dimension(monument, 'shaft-height'), 500 * FT, 1e-3);
  near(dimension(monument, 'base-width'), 55 * FT + 1.5 * IN, 1e-3);
  near(dimension(monument, 'top-width'), 34 * FT + 5.5 * IN, 1e-3);
  near(dimension(monument, 'colour-change'), 150 * FT, 1e-3);
  assert.equal(monument.parts.filter(part => part.group === 'windows' && part.id.endsWith('-glass')).length, 8);

  const tower = publishedModel('elizabeth-tower');
  near(dimension(tower, 'overall-height'), 96, 1e-3);
  near(dimension(tower, 'shaft-width'), 12, 1e-3);
  near(dimension(tower, 'dial-diameter'), 7, 1e-3);
  near(dimension(tower, 'dial-bottom') + 3.5, 55, 1e-3);
  near(dimension(tower, 'stone-top'), 61, 1e-3);

  const memorial = publishedModel('lincoln-memorial');
  near(dimension(memorial, 'overall-height'), 99 * FT, 1e-3);
  near(dimension(memorial, 'terrace-width'), 257 * FT, 1e-3);
  near(dimension(memorial, 'terrace-depth'), 187 * FT, 1e-3);
  near(dimension(memorial, 'terrace-height'), 14 * FT, 1e-3);
  near(dimension(memorial, 'column-height'), 44 * FT, 1e-3);
  assert.equal(memorial.parts.filter(part => part.group === 'colonnade' && /^column-(front|rear|left|right)-\d+$/.test(part.id)).length, 36);
  assert.equal(memorial.parts.filter(part => part.group === 'entrance' && /^column-antis-(left|right)$/.test(part.id)).length, 2);
});

test('the same seed gives the same twin; seeds give different twins', () => {
  for (const landmark of LANDMARKS) {
    const a = generateLandmark({ landmark, seed: 7 }), b = generateLandmark({ landmark, seed: 7 });
    assert.equal(JSON.stringify(a), JSON.stringify(b), landmark);
    assert.equal(JSON.stringify(a), JSON.stringify(twin(landmark, 7)), landmark + ' (cached)');
    const params = new Set([1, 2, 3, 4, 5, 6].map(seed => JSON.stringify(twin(landmark, seed).model.generator.params)));
    assert.ok(params.size >= 5, landmark + ': only ' + params.size + ' distinct twins in 6 seeds');
  }
});

test('each twin changes at least three named quantities by 12-30 % or counts by at least two, two of them sourced', () => {
  for (const landmark of LANDMARKS) {
    const info = landmarkInfo(landmark);
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { model, alternate } = twin(landmark, seed), deltas = alternate.change.deltas, params = model.generator.params;
      const label = landmark + ' seed ' + seed;
      assert.ok(deltas.length >= MIN_CHANGED, label + ': ' + deltas.length + ' changes');
      assert.ok(deltas.filter(d => d.sourced).length >= MIN_SOURCED_CHANGED, label + ': too few sourced quantities changed');
      for (const delta of deltas) {
        const q = info.quantities.find(item => item.key === delta.quantity);
        assert.ok(q, label + ': unknown quantity ' + delta.quantity);
        assert.equal(delta.published, info.published[delta.quantity]);
        assert.equal(params[delta.quantity], delta.surveyed, label + ': ' + delta.quantity + ' recorded but not built');
        if (q.kind === 'count') assert.ok(Math.abs(delta.surveyed - delta.published) >= MIN_COUNT_CHANGE, label + ': ' + delta.quantity);
        else {
          const share = Math.abs(delta.surveyed / delta.published - 1);
          assert.ok(share >= CHANGE_RANGE[0] - 1e-9 && share <= CHANGE_RANGE[1] + 1e-9, label + ': ' + delta.quantity + ' changed by ' + share);
        }
      }
      // Everything not recorded as changed is as published.
      for (const [key, value] of Object.entries(params)) if (!deltas.some(d => d.quantity === key)) assert.equal(value, info.published[key], label + ': ' + key + ' changed silently');
      assert.equal(alternate.model.generator.state, 'published');
      assert.deepEqual(alternate.model.generator.params, info.published);
    }
  }
});

test('contested probes measure both states, differ decisively, and no uniform scale maps one state onto the other', () => {
  for (const landmark of LANDMARKS) for (const seed of [1, 2, 3, 4, 5, 6]) {
    const { model, alternate } = twin(landmark, seed), label = landmark + ' seed ' + seed;
    const soupT = soupFromModel(model), soupP = soupFromModel(alternate.model);
    const limit = CONTESTED_FRACTION * Math.max(diagonal(soupT.bounds), diagonal(soupP.bounds));
    // Every probe of the twin is robust on it; the published model carries a subset, verbatim.
    assert.ok(model.probes.length >= 6 && model.probes.length <= 12, label + ': ' + model.probes.length + ' probes');
    for (const probe of model.probes) assert.ok(probeCheck(soupT, probe).ok, label + ': ' + probe.id + ' is not robust on the twin');
    const byId = new Map(model.probes.map(probe => [probe.id, probe]));
    for (const probe of alternate.model.probes) assert.deepEqual(probe, byId.get(probe.id), label + ': ' + probe.id + ' differs from the twin\'s');
    const contested = alternate.change.contested_probes;
    assert.ok(contested.length >= MIN_CONTESTED, label + ': ' + contested.length + ' contested probes');
    const rows = contested.map(id => {
      const probe = byId.get(id), a = raycast(soupT, probe.origin, probe.direction), c = raycast(soupP, probe.origin, probe.direction);
      assert.ok(a && c, label + ': contested ' + id + ' misses a state');
      assert.ok(alternate.model.probes.some(item => item.id === id), label + ': contested ' + id + ' is not a probe of the published model');
      assert.ok(Math.abs(a.distance - c.distance) >= limit, label + ': contested ' + id + ' differs by only ' + Math.abs(a.distance - c.distance).toFixed(3) + ' m');
      return { probe, twin: a, published: c };
    });
    // Recomputed here, independently of what the change record says.
    const mismatch = uniformScaleMismatch(rows);
    assert.ok(mismatch >= UNIFORM_SCALE_LIMIT, label + ': a uniform scale maps the contested probes within ' + (100 * mismatch).toFixed(1) + ' %');
    near(alternate.change.uniform_scale_mismatch, Math.round(mismatch * 1e4) / 1e4, 1e-4);
  }
  // The mismatch itself: one scale fits proportional states, not distorted ones.
  const row = (direction, twinPoint, publishedPoint) => ({ probe: { direction }, twin: { point: twinPoint }, published: { point: publishedPoint } });
  near(uniformScaleMismatch([row([0, -1, 0], [0, 20, 0], [0, 10, 0]), row([-1, 0, 0], [8, 1, 0], [4, 1, 0])]), 0, 1e-12);
  near(uniformScaleMismatch([row([0, -1, 0], [0, 20, 0], [0, 10, 0]), row([-1, 0, 0], [6, 1, 0], [4, 1, 0])]), (2 - 1.5) / (2 + 1.5), 1e-12);
  assert.equal(uniformScaleMismatch([row([0, -1, 0], [0, 20, 0], [0, 10, 0]), row([-1, 0, 0], [-3, 1, 0], [4, 1, 0])]), Infinity);
});

test('the public note names what changed but no value, and carries no digit at all', () => {
  for (const landmark of LANDMARKS) for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const { alternate } = twin(landmark, seed), { note, deltas } = alternate.change;
    assert.ok(!/\d/.test(note), landmark + ' seed ' + seed + ': ' + note);
    for (const delta of deltas) assert.ok(note.toLowerCase().includes(delta.label.toLowerCase()), landmark + ': note does not name ' + delta.label);
  }
});

test('models validate and pass the generator\'s geometric checks (groups, dimensions on edges, z-fighting, relief)', t => {
  const worst = {};
  for (const landmark of LANDMARKS) {
    const { model } = twin(landmark, 3);
    for (const [state, m] of [['surveyed', model], ['published', publishedModel(landmark)]]) {
      const label = landmark + ' ' + state, soup = soupFromModel(m);
      assert.equal(validateModel(m), m);
      // No digit (generator rule); no closing full stop (the task prompt adds one after the title).
      assert.ok(!/\d/.test(m.title) && !/\.$/.test(m.title) && m.title.length > 10, label + ' title: ' + m.title);
      assert.match(m.frame.origin, /ground/i);
      assert.match(m.frame.front, /\+Z/);
      assert.match(m.frame.front, /\+X is to the right/);
      assert.ok(m.groups.length >= 5 && m.groups.length <= 14, label + ': ' + m.groups.length + ' groups');
      for (const group of m.groups) assert.ok(CATEGORIES.includes(group.category), label + ': category ' + group.category);
      for (const part of m.parts) assert.ok(m.groups.some(group => group.id === part.group), label + ': part ' + part.id + ' has no group');
      assert.ok(soup.triangles <= 60000, label + ': ' + soup.triangles + ' triangles');
      assert.ok(m.dimensions.length >= 6 && m.dimensions.length <= 12, label + ': ' + m.dimensions.length + ' dimensions');
      const edges = featureEdges(soup);
      for (const d of m.dimensions) {
        near(d.value_m, Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1], d.b[2] - d.a[2]), 1e-4);
        const check = dimensionEdgeDistances(edges, d);
        assert.ok(check.offAxis < 1e-3, label + ': ' + d.id + ' is not parallel to its view');
        assert.ok(check.a <= 0.01 && check.b <= 0.01, label + ': ' + d.id + ' endpoints ' + check.a.toFixed(3) + ' / ' + check.b.toFixed(3) + ' m from an edge');
      }
      for (const [name, az, el] of STANDARD_VIEWS) {
        const report = zFightReport(soup, viewCamera(soup.bounds, az, el, { width: 420 }));
        assert.ok(report.fraction < 5e-4, label + ': ' + name + ' view z-fights on ' + (report.fraction * 100).toFixed(3) + '% ' + JSON.stringify(report.pairs));
        worst[landmark] = Math.max(worst[landmark] ?? 0, report.fraction);
      }
      for (const r of groupRelief(m, soup)) {
        assert.ok(r.samples > 50, label + ': ' + r.id + ' barely sampled');
        assert.ok(r.relief_m + 1e-3 >= r.detail_size_m, label + ': ' + r.id + ' stands out by only ' + r.relief_m.toFixed(3) + ' m, detail size ' + r.detail_size_m);
      }
    }
  }
  t.diagnostic('worst z-fight fraction ' + JSON.stringify(worst));
});

test('large seeds (sets draw them up to 2^31) and a sweep of small ones all give a twin', () => {
  for (const landmark of LANDMARKS) {
    for (const seed of [100003, 7654321, 2147483646]) assert.ok(generateLandmark({ landmark, seed }).alternate.change.contested_probes.length >= MIN_CONTESTED);
    for (let seed = 0; seed < 25; seed++) assert.doesNotThrow(() => twin(landmark, seed), landmark + ' seed ' + seed);
  }
});

test('the landmark generator draws randomness only through the seeded kernel rng', async () => {
  const dir = new URL('../lib/generator/landmarks/', import.meta.url).pathname;
  for (const file of (await readdir(dir)).filter(name => name.endsWith('.mjs'))) {
    const source = await readFile(join(dir, file), 'utf8');
    assert.ok(!/Math\.random|Date\.now|new Date|performance\.now/.test(source), file + ' uses an unseeded or clock-dependent value');
  }
});

// ---------------------------------------------------------------- pack

// Minimal JPEG (as in photos.test.mjs) and a stand-in for Blender that writes
// one at each requested size, so buildObject runs without rendering anything.
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

test('a landmark builds through the standard pipeline: published model stored as "remembered", m2 / m3 tasks with the memory rule', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'e3d-landmarks-test-'));
  try {
    const blender = join(dir, 'fake-blender.cjs');
    await writeFile(blender, FAKE_BLENDER);
    await chmod(blender, 0o755);
    process.env.E3D_FAKE_JPEG = fakeJpeg(16, 16).toString('base64');
    const dataRoot = join(dir, 'data'), seed = 1234567, objectId = 'obj-0a1b2c3d';
    const { model, alternate } = generateLandmark({ landmark: 'arc-de-triomphe', seed });
    const built = await buildObject({ dataRoot, model, alternate, id: objectId, blender, quality: 'draft' });
    assert.equal(built.alternate, REMEMBERED);
    assert.deepEqual(built.contested.map(row => row.probe), alternate.change.contested_probes);
    const objectDir = layout(dataRoot).object(objectId);
    const change = JSON.parse(await readFile(join(objectDir, 'alternates', REMEMBERED, 'change.json'), 'utf8'));
    assert.deepEqual(change.deltas, alternate.change.deltas, 'the private deltas are kept with the object');
    for (const row of change.contested) assert.ok(Math.abs(row.primary_m - row.alternate_m) > 0, row.probe);
    assert.deepEqual(JSON.parse(await readFile(join(objectDir, 'alternates', REMEMBERED, 'model.json'), 'utf8')), alternate.model);
    // The memory alternate has no evidence of its own: no stale drawings.
    const evidence = JSON.parse(await readFile(join(objectDir, 'evidence', 'evidence.json'), 'utf8'));
    assert.ok(!evidence.items.some(item => item.id.includes('@')), 'no stale evidence for a remembered alternate');
    for (const variant of ['m2', 'm3']) {
      await buildTask({ dataRoot, objectId, variant, set: 'memory-test' });
      const taskId = objectId + '-' + variant;
      const task = JSON.parse(await readFile(join(layout(dataRoot).task(taskId), 'task.json'), 'utf8'));
      const truth = validateTruth(JSON.parse(await readFile(join(layout(dataRoot).truth(taskId), 'truth.json'), 'utf8')));
      assert.equal(task.title, 'Arc de Triomphe, Place Charles de Gaulle, Paris');
      assert.equal(task.scale_evidence, VARIANTS[variant].scale);
      assert.match(task.prompt, /Use only this evidence, even where it disagrees with what you know or remember about this structure/);
      assert.deepEqual(truth.alternates, [{ id: REMEMBERED, contested_probes: alternate.change.contested_probes, note: alternate.change.note }]);
      assert.deepEqual(truth.evidence, VARIANTS[variant].items);
      // Neither the seed nor the twin's internal id reaches the contestant.
      assert.ok(!JSON.stringify(task).includes(String(seed)) && !JSON.stringify(task).includes(model.id));
    }
    const verified = await verifyTasks(dataRoot);
    assert.deepEqual(verified.map(row => row.task), [objectId + '-m2', objectId + '-m3']);
  } finally {
    delete process.env.E3D_FAKE_JPEG;
    await rm(dir, { recursive: true, force: true });
  }
});
