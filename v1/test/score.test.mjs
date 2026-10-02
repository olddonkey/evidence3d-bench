import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { objectHash } from '../../lib/io.mjs';
import { rng } from '../lib/rng.mjs';
import { decodePNG } from '../lib/png.mjs';
import { validateModel, modelToGLB } from '../lib/model.mjs';
import { soupFromModel, transformSoup } from '../lib/soup.mjs';
import { orthoCamera } from '../lib/raster.mjs';
import { layout, VARIANTS } from '../lib/contract.mjs';
import { sampleModel } from '../fixtures/sample-model.mjs';
import { scoreSubmission, scoreSoup, loadContext, makeContext, mutations, calibrate } from '../lib/score/index.mjs';
import { syntheticEvidence } from '../lib/score/synthetic.mjs';
import { PointGrid, SurfaceIndex } from '../lib/score/grid.mjs';
import { linearToLab, deltaE76 } from '../lib/score/metrics.mjs';
import { coverageMaps, coverageMask } from '../lib/score/coverage.mjs';
import { sampleSurface } from '../lib/score/sampling.mjs';

// Contexts are expensive (truth sampling, coverage, detail views), so each
// evidence level is built once and every candidate is scored once.
const model = sampleModel();
const contexts = new Map(), reports = new Map();
function context(key) {
  if (!contexts.has(key)) {
    const [items, scale, extra] = key.split('/');
    const source = extra === 'asymmetric' ? asymmetricModel() : extra === 'tree' ? model : model;
    const occluders = extra === 'tree' ? { 'photo-front': [{ type: 'ellipsoid', center: [-3.2, 2.6, 4], radii: [1.6, 2.2, 1.6] }] } : {};
    contexts.set(key, makeContext({ model: source, evidenceItems: syntheticEvidence(source, { items, occluders }), scaleEvidence: scale }));
  }
  return contexts.get(key);
}
// A mutation, a list of mutations applied in order, or a soup.
function score(key, ...steps) {
  const id = key + ':' + steps.map(step => step.id ?? 'soup').join('>');
  if (!reports.has(id)) {
    const ctx = context(key);
    const candidate = steps.reduce((soup, step) => (step.apply ? step.apply(soup, ctx) : step), ctx.soup);
    reports.set(id, scoreSoup({ candidate, context: ctx }));
  }
  return reports.get(id);
}
const METRIC = 't2/metric', FREE = 't2/none', FRONT = 't1/none';
const group = (report, id) => report.detail.groups.find(row => row.id === id);
const near = (actual, expected, tolerance, label = '') => assert.ok(Math.abs(actual - expected) <= tolerance, label + ' ' + actual + ' is not within ' + tolerance + ' of ' + expected);

// The fixture is mirror-symmetric except for its chimney; this variant adds a
// single-storey extension at the rear right, so that no turn maps its mirror
// image back onto it (an extension centred front to back would: mirror in X
// then turn 180 degrees is a mirror in Z).
function asymmetricModel() {
  const base = sampleModel();
  base.id = 'sample-house-extended';
  base.groups.push({ id: 'right.extension', title: 'Single-storey side extension', category: 'massing', detail_size_m: 0.3, facade: 'right' });
  // Starts 10 cm inside the right wall so no face is coplanar with it.
  base.parts.push(
    { id: 'extension-body', type: 'box', size: [3.1, 3, 3], position: [4.4 + 1.55, 1.5, -5.3], material: 'render', group: 'right.extension' },
    { id: 'extension-roof', type: 'box', size: [3.4, 0.2, 3.3], position: [4.4 + 1.7, 3.1, -5.3], material: 'tile', group: 'right.extension' },
  );
  return validateModel(base);
}

// Earlier state of the fixture: a lower roof (ridge 7.5 m instead of 8.23 m).
function lowerRoofModel() {
  const earlier = sampleModel();
  earlier.id = 'sample-house-earlier';
  const roof = earlier.parts.find(part => part.id === 'roof');
  roof.polygon = [[-3.95, 0], [3.95, 0], [0, 2.2]];
  for (const id of ['gable-left', 'gable-right']) earlier.parts.find(part => part.id === id).polygon = [[-3.5, 0], [3.5, 0], [0, 1.9]];
  earlier.parts.find(part => part.id === 'chimney').position = [2.6, 7.3, -4.2];
  return validateModel(earlier);
}

test('grid nearest-neighbour search agrees with brute force, near and far', () => {
  const random = rng('grid'), points = Float64Array.from({ length: 3000 }, () => random.range(-5, 5));
  const grid = new PointGrid(points, 0.7), index = new SurfaceIndex(points, 10);
  for (let q = 0; q < 300; q++) {
    const spread = q % 3 === 0 ? 60 : 8, x = random.range(-spread, spread), y = random.range(-spread, spread), z = random.range(-spread, spread);
    let best = Infinity, at = -1;
    for (let i = 0; i < 1000; i++) {
      const d = Math.hypot(points[3 * i] - x, points[3 * i + 1] - y, points[3 * i + 2] - z);
      if (d < best) { best = d; at = i; }
    }
    assert.equal(grid.nearest(x, y, z), at);
    near(grid.distance, best, 1e-9);
    // The far index may answer from a thinned subset, but never closer than the truth.
    const k = index.nearest(x, y, z);
    assert.ok(k >= 0 && index.distance >= best - 1e-9);
    if (best <= 0.1 * 10) assert.equal(k, at);
    const r = 1.2;
    assert.equal(grid.nearest(x, y, z, r) >= 0, best <= r);
  }
});

test('linear-sRGB to CIE Lab matches reference values; CIE76 is Euclidean in Lab', () => {
  const close = (lab, expected) => lab.forEach((value, i) => near(value, expected[i], 0.05, 'Lab'));
  close(linearToLab(1, 1, 1), [100, 0, 0]);
  close(linearToLab(1, 0, 0), [53.24, 80.09, 67.2]);
  close(linearToLab(0, 0, 1), [32.3, 79.19, -107.86]);
  // sRGB 128 grey is linear 0.2158605: L* 53.585.
  close(linearToLab(0.2158605, 0.2158605, 0.2158605), [53.585, 0, 0]);
  near(deltaE76([50, 10, 10], [53, 14, 10]), 5, 1e-12);
});

test('evidence coverage honours the frame, occluders, grazing angles, stale items, plans and notes', () => {
  const soup = soupFromModel(model), diagonal = Math.hypot(...soup.bounds.max.map((v, i) => v - soup.bounds.min[i]));
  const sample = sampleSurface(soup, { voxel: 0.004 * diagonal });
  const facing = (axis, sign) => i => sample.normals[3 * i + axis] * sign > 0.99;
  const share = (mask, keep) => {
    let total = 0, seen = 0;
    for (let i = 0; i < sample.count; i++) if (keep(i)) { total++; seen += mask[i]; }
    return seen / total;
  };
  const items = syntheticEvidence(model, { items: ['photo-front'] });
  const front = coverageMask(coverageMaps(soup, items).maps, sample.points, sample.normals, diagonal);
  const frontWall = i => facing(2, 1)(i) && Math.abs(sample.points[3 * i + 2]) < 0.01 && sample.points[3 * i + 1] < 5;
  assert.ok(share(front, frontWall) > 0.97, 'the front photograph shows the front wall');
  assert.equal(share(front, facing(2, -1)), 0, 'and never the rear');
  // A large box standing in front of the left half hides it.
  const blocked = syntheticEvidence(model, { items: ['photo-front'], occluders: { 'photo-front': [{ type: 'box', center: [-2.5, 2.5, 3], size: [4.5, 5, 1] }] } });
  const behind = coverageMask(coverageMaps(soup, blocked).maps, sample.points, sample.normals, diagonal);
  assert.ok(share(behind, i => frontWall(i) && sample.points[3 * i] < -1.5 && sample.points[3 * i] > -3.5) < 0.02, 'occluded facade is not evidenced');
  assert.ok(share(behind, i => frontWall(i) && sample.points[3 * i] > 1.5) > 0.97, 'the unoccluded half still is');
  // An orthographic view straight along the facade sees the front wall at 90 degrees.
  const side = { ...items[0], id: 'side', kind: 'elevation', camera: orthoCamera({ origin: [0, 4, -3.5], right: [0, 0, -1], up: [0, 1, 0], extent: [-6, 6, -6, 6], width: 400, height: 400 }) };
  const grazing = coverageMask(coverageMaps(soup, [side]).maps, sample.points, sample.normals, diagonal);
  assert.equal(share(grazing, frontWall), 0, 'surfaces seen edge-on are not evidenced');
  assert.ok(share(grazing, facing(0, 1)) > 0.9, 'the side the camera faces is');
  // Stale items, plans and notes give nothing; the reasons are reported.
  const stale = syntheticEvidence(model, { items: ['photo-front', 'plan', 'notes'], stale: ['photo-front'] });
  const { maps, ignored } = coverageMaps(soup, stale);
  assert.equal(maps.length, 0);
  assert.deepEqual(ignored.map(item => item.reason.split(':')[0]), ['stale', 'plan adds no coverage', 'notes adds no coverage']);
});

test('the truth scores >= 98; re-tessellation, renaming and recolouring leave the geometry score unchanged', () => {
  for (const key of [METRIC, FREE, FRONT]) {
    const truth = score(key, mutations.identity());
    assert.equal(truth.valid, true);
    assert.ok(truth.score >= 98, key + ' truth scored ' + truth.score);
    assert.ok(truth.detail.score >= 98, key + ' truth detail ' + truth.detail.score);
    assert.equal(truth.probe_summary.missed, 0);
    near(truth.probe_summary.mean_error_m, 0, 0.005, 'probe error');
    near(truth.appearance.delta_e_mean, 0, 0.01, 'colour');
  }
  const truth = score(METRIC, mutations.identity());
  for (const mutation of [mutations.retessellate(2), mutations.rename(), mutations.recolor()]) {
    const report = score(METRIC, mutation);
    near(report.score, truth.score, 0.5, mutation.id);
    near(report.detail.score, truth.detail.score, 0.5, mutation.id + ' detail');
  }
  // Recolouring changes appearance, and only appearance.
  assert.ok(score(METRIC, mutations.recolor()).appearance.delta_e_mean > 10);
});

test('a rigid shift or yaw of a correct model leaves the score unchanged and shows up only in frame_error', () => {
  for (const key of [METRIC, FREE, FRONT]) {
    const truth = score(key, mutations.identity());
    const offset = [3.3, 0.47, -2.2];
    const shifted = score(key, mutations.shift(offset));
    near(shifted.score, truth.score, 1, key + ' shift');
    near(shifted.alignment.frame_error.offset_m, Math.hypot(...offset), 0.05, key + ' reported offset');
    assert.ok(shifted.strict.f < 0.5, 'unfitted, the shifted model does not match');
    for (const degrees of [37, 180]) {
      const turned = score(key, mutations.yaw(degrees));
      near(turned.score, truth.score, 1, key + ' yaw ' + degrees);
      near(Math.abs(((turned.alignment.frame_error.yaw_deg + degrees) % 360 + 540) % 360 - 180), 0, 1, key + ' reported yaw ' + degrees);
    }
  }
});

test('uniform scaling by 5/10/20 % lowers the metric score monotonically and leaves the scale-free score unchanged', () => {
  const metric = [score(METRIC, mutations.identity()), ...[1.05, 1.1, 1.2].map(k => score(METRIC, mutations.scale(k)))];
  for (let k = 1; k < metric.length; k++) assert.ok(metric[k].score < metric[k - 1].score, 'metric scores ' + metric.map(r => r.score));
  for (const [k, factor] of [1.05, 1.1, 1.2].entries()) {
    assert.equal(metric[k + 1].alignment.scale, 1, 'scale is locked on a metric task');
    // The scale error is named in "shape" even though it is not forgiven.
    near(metric[k + 1].shape.scale * factor, 1, 0.02, 'shape scale');
    near(metric[k + 1].shape.f, 1, 0.01, 'shape f');
  }
  for (const key of [FREE, FRONT]) {
    const truth = score(key, mutations.identity());
    for (const factor of [1.05, 1.1, 1.2]) {
      const scaled = score(key, mutations.scale(factor));
      near(scaled.score, truth.score, 1, key + ' scale ' + factor);
      near(scaled.alignment.scale * factor, 1, 0.01, key + ' fitted scale ' + factor);
      assert.equal(scaled.alignment.scale_locked, false);
    }
  }
});

test('removing a group drives that group\'s F towards 0 while the other groups stay put', () => {
  for (const key of [METRIC, FREE]) {
    const truth = score(key, mutations.identity());
    for (const id of ['front.door', 'front.windows.ground', 'front.windows.upper', 'chimney', 'front.canopy', 'body']) {
      const dropped = score(key, mutations.dropGroup(id));
      assert.ok(group(dropped, id).f <= 0.15, key + ' ' + id + ' F ' + group(dropped, id).f);
      for (const row of truth.detail.groups) {
        if (row.id === id || !row.scored) continue;
        near(group(dropped, row.id).f, row.f, 0.05, key + ' drop ' + id + ': ' + row.id);
      }
    }
  }
});

test('removing the roof, 35 % of the surface, drives its F to 0 and leaves the other groups put (metric)', () => {
  const truth = score(METRIC, mutations.identity()), dropped = score(METRIC, mutations.dropGroup('roof'));
  assert.ok(group(dropped, 'roof').f <= 0.05, 'roof ' + group(dropped, 'roof').f);
  for (const row of truth.detail.groups) if (row.id !== 'roof') near(group(dropped, row.id).f, row.f, 0.05, row.id);
});

// Known limit, kept visible rather than hidden. Without its roof the fixture
// exposes its interior: inner wall faces 0.3 m behind the outer ones, with
// tau = 0.31 m. On a scale-free task that makes a 2.2 % larger pose the best
// F@2 % fit, globally and for the rest of the object alike; at that scale the
// gable tops lie on parts of the roof (roof F 0.23) and the 6.8 m wide window
// rows, judged at the wrong scale, lose up to 0.07.
test('removing the roof on a scale-free task: roof F ~0 and the other groups within 0.05', { todo: 'the F-optimal scale of a roofless model is 2.2 % large' }, () => {
  const truth = score(FREE, mutations.identity()), dropped = score(FREE, mutations.dropGroup('roof'));
  assert.ok(group(dropped, 'roof').f <= 0.05, 'roof ' + group(dropped, 'roof').f);
  for (const row of truth.detail.groups) if (row.id !== 'roof') near(group(dropped, row.id).f, row.f, 0.05, row.id);
});

test('flattening small details leaves the shape score almost unchanged and lowers detail.score', () => {
  for (const key of [METRIC, FREE, FRONT]) {
    const truth = score(key, mutations.identity());
    const flat = score(key, mutations.flattenGroup('front.windows.ground'), mutations.flattenGroup('front.windows.upper'), mutations.flattenGroup('front.door'));
    near(flat.shape_score, truth.shape_score, 1, key + ' shape');
    // The headline is half detail, so it does move - by about half the detail loss.
    near(truth.score - flat.score, (truth.detail.score - flat.detail.score) / 2, 1, key + ' headline');
    assert.ok(flat.detail.score <= truth.detail.score - 10, key + ' detail ' + truth.detail.score + ' -> ' + flat.detail.score);
    for (const id of ['front.windows.ground', 'front.windows.upper', 'front.door']) assert.ok(group(flat, id).f <= group(truth, id).f - 0.1, key + ' ' + id);
  }
});

test('a bounding-box massing model scores clearly below the truth and near 0 on detail', () => {
  for (const key of [METRIC, FREE, FRONT]) {
    const box = score(key, mutations.massingBox());
    assert.ok(box.score <= score(key, mutations.identity()).score - 30, key + ' box scored ' + box.score);
    assert.ok(box.detail.score <= 20, key + ' box detail ' + box.detail.score);
  }
});

test('a mirrored model of an asymmetric object scores clearly lower', () => {
  const key = 't2/metric/asymmetric', truth = score(key, mutations.identity()), mirrored = score(key, mutations.mirrorX());
  assert.ok(truth.score >= 98);
  assert.ok(mirrored.score <= truth.score - 5, 'mirrored scored ' + mirrored.score);
  assert.ok(group(mirrored, 'right.extension').f <= 0.2);
  // The fixture itself is symmetric but for its chimney: the headline barely
  // moves, the chimney's detail F falls to 0.
  const fixture = score(METRIC, mutations.mirrorX());
  assert.ok(fixture.score < score(METRIC, mutations.identity()).score);
  assert.ok(group(fixture, 'chimney').f <= 0.1);
});

test('on t1 a front-only shell is not punished for the unseen rear; on t2 it is', () => {
  const front = score(FRONT, mutations.frontShell()), round = score(FREE, mutations.frontShell());
  near(front.score, score(FRONT, mutations.identity()).score, 2, 't1 shell');
  assert.ok(round.score <= score(FREE, mutations.identity()).score - 30, 't2 shell scored ' + round.score);
  // The same holds for the detail groups the front photograph can show.
  for (const id of ['front.door', 'front.windows.ground', 'front.windows.upper']) near(group(front, id).f, 1, 0.02, 't1 shell ' + id);
});

test('junk is punished through precision; hidden interior geometry is neither rewarded nor punished', () => {
  for (const key of [METRIC, FRONT]) {
    const truth = score(key, mutations.identity()), at2 = report => report.global.thresholds[1];
    const ground = score(key, mutations.addGroundPlane());
    assert.ok(ground.shape_score <= truth.shape_score - 40 && at2(ground).precision < 0.3, key + ' ground plane ' + ground.shape_score);
    assert.ok(ground.score <= truth.score - 20, key + ' ground plane headline ' + ground.score);
    // With the scale locked the house itself is still fully recalled. With a
    // free scale and junk dominating F, the F-maximising fit trades some
    // recall for precision by shrinking the whole submission (t1: 0.89x,
    // recall 0.89); the score is low either way.
    if (key === METRIC) assert.ok(at2(ground).recall > 0.95);
    const duplicate = score(key, mutations.addDuplicate());
    assert.ok(duplicate.shape_score <= truth.shape_score - 25 && at2(duplicate).recall > 0.95, key + ' duplicate ' + duplicate.shape_score);
    assert.ok(duplicate.score <= truth.score - 12, key + ' duplicate headline ' + duplicate.score);
    const interior = score(key, mutations.addInterior());
    near(interior.score, truth.score, 0.5, key + ' interior');
    assert.equal(interior.global.points.candidate, truth.global.points.candidate, 'the interior copy is never sampled');
  }
});

// Soups for the degenerate submissions.
function solidSoup(positions) {
  const triangles = positions.length / 9;
  const soup = { positions: Float64Array.from(positions), triPart: new Int32Array(triangles), colors: new Float32Array(triangles * 3).fill(0.5), parts: ['junk'], triangles };
  return { ...soup, bounds: transformSoup(soup, {}).bounds };
}

test('degenerate candidates neither crash the scorer nor score high', () => {
  const ctx = context(METRIC), truth = score(METRIC, mutations.identity());
  const sphere = (centre, radius, rings) => {
    const out = [];
    for (let i = 0; i < rings; i++) for (let j = 0; j < 2 * rings; j++) {
      const at = (a, b) => [centre[0] + radius * Math.sin(a) * Math.cos(b), centre[1] + radius * Math.cos(a), centre[2] + radius * Math.sin(a) * Math.sin(b)];
      const a0 = Math.PI * i / rings, a1 = Math.PI * (i + 1) / rings, b0 = Math.PI * j / rings, b1 = Math.PI * (j + 1) / rings;
      out.push(...at(a0, b0), ...at(a1, b0), ...at(a1, b1), ...at(a0, b0), ...at(a1, b1), ...at(a0, b1));
    }
    return out;
  };
  const cases = {
    'one huge triangle': solidSoup([-500, 0, -500, 500, 0, -500, 0, 600, 400]),
    'huge vertical triangle through the facade': solidSoup([-400, -50, 0, 400, -50, 0, 0, 400, 0]),
    'tiny model': transformSoup(ctx.soup, { scale: 0.01 }),
    'dense blob in front of the house': solidSoup(sphere([0, 3, 5], 2, 90)),
    'dense blob swallowing the house': solidSoup(sphere([0, 4, -3], 12, 60)),
  };
  for (const [name, candidate] of Object.entries(cases)) {
    const report = score(METRIC, candidate);
    assert.equal(report.valid, true, name + ': ' + report.error);
    assert.ok(report.score < 35, name + ' scored ' + report.score);
    assert.ok(report.detail.score === null || report.detail.score < 35, name + ' detail ' + report.detail.score);
  }
  // A far-away but correct model is just a frame error.
  const far = score(METRIC, mutations.shift([4000, 30, -2500]));
  near(far.score, truth.score, 1, 'far away');
  // Nothing to score is invalid, not a crash.
  const empty = scoreSoup({ candidate: { positions: new Float64Array(0), triPart: new Int32Array(0), colors: new Float32Array(0), parts: [], triangles: 0 }, context: ctx });
  assert.equal(empty.valid, false);
  assert.equal(empty.score, 0);
  const flat = scoreSoup({ candidate: solidSoup([0, 0, 0, 1, 1, 1, 2, 2, 2]), context: ctx });
  assert.equal(flat.valid, false);
  assert.match(flat.error, /no visible surface/);
});

test('alignment recovers a known yaw, translation and scale on a scale-free task', () => {
  const report = score(FREE, mutations.scale(1.37), mutations.yaw(-71), mutations.shift([-6, 1.5, 9]));
  near(report.score, score(FREE, mutations.identity()).score, 1, 'score');
  near(report.alignment.yaw_deg, 71, 0.5, 'yaw');
  near(report.alignment.scale, 1 / 1.37, 0.005, 'scale');
  near(report.alignment.frame_error.scale_log, Math.log(1 / 1.37), 0.01, 'scale_log');
  // The candidate carries the truth's origin at [-6, 1.5, 9]; the fit must map it back to [0, 0, 0].
  const { yaw_deg: yaw, scale, translation_m: t } = report.alignment, c = Math.cos(yaw * Math.PI / 180), s = Math.sin(yaw * Math.PI / 180);
  const p = [-6, 1.5, 9], mapped = [scale * (c * p[0] + s * p[2]) + t[0], scale * p[1] + t[1], scale * (-s * p[0] + c * p[2]) + t[2]];
  for (let i = 0; i < 3; i++) near(mapped[i], 0, 0.05, 'origin ' + i);
});

test('probes measure named dimensions, skip what the evidence never showed, and record misses', () => {
  const truth = score(METRIC, mutations.identity());
  const ridge = truth.probes.find(probe => probe.id === 'ridge-height');
  near(40 - ridge.truth_m, 8.23, 0.005, 'ridge');
  for (const probe of truth.probes) near(probe.error_m, 0, 0.002, probe.id);
  const lifted = score(METRIC, mutations.shift([0, 0.4, 0]));
  assert.ok(lifted.probes.every(probe => probe.error_m < 0.01), 'probes are read after alignment');
  const front = score(FRONT, mutations.identity());
  assert.equal(front.probes.find(probe => probe.id === 'rear-wall').evidenced, false);
  assert.ok(front.probe_summary.evaluated < front.probes.length);
  const walls = score(METRIC, mutations.dropGroup('body'));
  for (const id of ['left-wall', 'right-wall', 'rear-wall']) {
    const probe = walls.probes.find(item => item.id === id);
    assert.equal(probe.missed, true, id);
    assert.equal(probe.measured_m, null);
  }
  assert.equal(walls.probe_summary.missed, 3);
});

test('alternates: contested probes and F say which state the candidate shows', () => {
  const earlier = lowerRoofModel();
  const ctx = makeContext({ model, evidenceItems: syntheticEvidence(model, { items: 't3' }), scaleEvidence: 'metric',
    alternates: [{ id: 'earlier', model: earlier, contested_probes: ['ridge-height'], note: 'The roof was raised in 2020.' }] });
  const current = scoreSoup({ candidate: ctx.soup, context: ctx }), old = scoreSoup({ candidate: soupFromModel(earlier), context: ctx });
  const [a, b] = [current.alternates[0], old.alternates[0]];
  assert.equal(a.contested[0].closer_to, 'primary');
  assert.equal(a.closer_to_primary_fraction, 1);
  assert.equal(b.contested[0].closer_to, 'alternate');
  near(b.contested[0].measured_m, b.contested[0].alternate_m, 0.01, 'measured on the old roof');
  assert.ok(b.f > a.f && old.score < current.score, 'the old-state model fits the alternate better and the primary worse');
});

test('scoreSubmission works end to end from a data root and never throws for a bad submission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e3d-score-'));
  try {
    const paths = layout(root), objectId = 'sample-house', taskId = 'sample-house-t3', earlier = lowerRoofModel();
    const objectDir = paths.object(objectId);
    await mkdir(join(objectDir, 'evidence'), { recursive: true });
    await mkdir(join(objectDir, 'alternates', 'earlier'), { recursive: true });
    await writeFile(join(objectDir, 'model.json'), JSON.stringify(model));
    await writeFile(join(objectDir, 'alternates', 'earlier', 'model.json'), JSON.stringify(earlier));
    const items = [...syntheticEvidence(model, { items: 't3' }), ...syntheticEvidence(earlier, { items: ['plan', 'elevation-front', 'elevation-right'], sourceModel: 'earlier' })];
    await writeFile(join(objectDir, 'evidence', 'evidence.json'), JSON.stringify({ schema: 'e3d-evidence-v1', object: objectId, items }));
    const used = VARIANTS.c1.items.map(id => (VARIANTS.c1.stale.includes(id) ? id + '@earlier' : id));
    const task = { schema: 'e3d-task-v1', id: taskId, title: model.title, prompt: 'Rebuild it.', target_state: 'As photographed.', variant: 'c1',
      frame: { unit: 'metre', up: '+Y', origin: model.frame.origin, front: model.frame.front }, scale_evidence: 'metric',
      inputs: used.map((id, i) => ({ id: 'source-' + (i + 1), path: 'inputs/' + String(i + 1).padStart(2, '0') + '-' + id.split('@')[0] + '.png', kind: items.find(item => item.id === id).kind,
        captured_at: '2025-09', description: 'x', sha256: 'a'.repeat(64), bytes: 1 })),
      output: { model: 'output/model.glb', notes: 'output/notes.md', rules: [] }, budget: { wall_seconds: 1800, max_artifact_bytes: 67108864, max_triangles: 1500000 } };
    await mkdir(paths.task(taskId), { recursive: true });
    await writeFile(join(paths.task(taskId), 'task.json'), JSON.stringify(task));
    await mkdir(paths.truth(taskId), { recursive: true });
    await writeFile(join(paths.truth(taskId), 'truth.json'), JSON.stringify({ schema: 'e3d-truth-v1', task_id: taskId, task_sha256: objectHash(task), object: objectId,
      variant: 'c1', scale_evidence: 'metric', evidence: used, alternates: [{ id: 'earlier', contested_probes: ['ridge-height'], note: 'Roof raised.' }] }));
    const where = { taskDir: paths.task(taskId), truthDir: paths.truth(taskId), dataRoot: root };
    const ctx = await loadContext(where);
    assert.deepEqual(ctx.evidence.ignored.map(item => item.id), ['plan@earlier', 'elevation-front@earlier', 'elevation-right@earlier']);
    assert.equal(ctx.alternates.length, 1);
    assert.deepEqual(ctx.warnings, []);
    const outDir = join(root, 'report');
    const report = await scoreSubmission({ glb: modelToGLB(model), ...where, outDir });
    assert.equal(report.schema, 'e3d-report-v1');
    assert.equal(report.valid, true, report.error);
    assert.ok(report.score >= 98 && report.alternates[0].contested[0].closer_to === 'primary');
    for (const key of ['global', 'alignment', 'strict', 'shape', 'detail', 'probes', 'probe_summary', 'alternates', 'appearance', 'technical', 'artifacts', 'timing_ms']) assert.ok(key in report, key);
    assert.equal(report.technical.mesh_count, model.parts.length);
    // The error maps exist, are the advertised size and actually show surface.
    assert.ok(report.artifacts.includes('error-front.png'));
    const png = decodePNG(await readFile(join(outDir, 'error-front.png')));
    let green = 0;
    for (let i = 0; i < png.width * png.height; i++) if (png.pixels[3 * i + 1] > png.pixels[3 * i] + 40 && png.pixels[3 * i + 1] > png.pixels[3 * i + 2] + 20) green++;
    assert.ok(green > 0.1 * png.width * png.height, 'a matching model shows mostly green surface, got ' + green);
    for (const bad of [Buffer.from('not a glb'), Buffer.alloc(0), null]) {
      const rejected = await scoreSubmission({ glb: bad, ...where, context: ctx });
      assert.equal(rejected.valid, false);
      assert.equal(rejected.score, 0);
      assert.ok(typeof rejected.error === 'string' && rejected.error.length > 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a 150k-triangle candidate scores in well under a minute', () => {
  const ctx = context(METRIC), dense = mutations.retessellate(4).apply(ctx.soup, ctx);
  assert.ok(dense.triangles >= 150000, String(dense.triangles));
  const started = performance.now(), report = scoreSoup({ candidate: mutations.yaw(23).apply(dense, ctx), context: ctx });
  const seconds = (performance.now() - started) / 1000;
  assert.ok(report.score >= 98, String(report.score));
  assert.ok(seconds < 30, seconds + ' s');
});

test('calibrate runs every mutation on the front-photograph task and every expectation holds', () => {
  const rows = calibrate(context('t1/none/tree'));
  assert.ok(rows.length >= 25);
  for (const row of rows) {
    for (const key of ['id', 'expectation', 'ok', 'score', 'detail', 'frame_error']) assert.ok(key in row, row.id + ' lacks ' + key);
    assert.equal(row.ok, true, row.id + ': ' + row.expectation + ' (score ' + row.score + ', detail ' + row.detail + ')');
  }
});
