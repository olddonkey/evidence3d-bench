import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ARCHETYPES, GENERATOR_VERSION, generateModel, decoyModel, applicableEdits, earlierState, CONTESTED_FRACTION } from '../lib/generator/index.mjs';
import { validateModel, modelToGLB } from '../lib/model.mjs';
import { soupFromModel, soupFromGLB } from '../lib/soup.mjs';
import { raycast, triangleNormal, cross, normalize } from '../lib/raster.mjs';
import {
  featureEdges, dimensionEdgeDistances, zFightReport, viewCamera, STANDARD_VIEWS, mirrorDifference, diagonal, groupRelief,
} from '../lib/generator/checks.mjs';

const SEEDS = Array.from({ length: 15 }, (_, i) => i);
// The five archetypes of generator 1.0 (dev set and pilot) and the three added in 1.1.
const ORIGINAL = ['house', 'retail', 'tower', 'hall', 'structure'];
const ADDED = ['warehouse', 'terrace', 'civic'];
const CATEGORIES = ['massing', 'roof', 'openings', 'entrance', 'attachments', 'structure', 'ornament'];
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

// Generation is deterministic, so one cache serves every test in this file.
const cache = new Map();
function get(archetype, seed) {
  const key = archetype + ':' + seed;
  if (!cache.has(key)) { const model = generateModel({ archetype, seed }); cache.set(key, { model, soup: soupFromModel(model) }); }
  return cache.get(key);
}
const each = fn => { for (const archetype of ARCHETYPES) for (const seed of SEEDS) fn(archetype, seed, get(archetype, seed)); };
const where = (model, what) => model.id + ': ' + what;

test('the eight archetypes are registered and bad requests are refused', () => {
  assert.deepEqual([...ARCHETYPES], [...ORIGINAL, ...ADDED]);
  assert.throws(() => generateModel({ archetype: 'castle', seed: 1 }), /unknown archetype/);
  assert.throws(() => generateModel({ archetype: 'house', seed: -1 }), /seed/);
  assert.throws(() => generateModel({ archetype: 'house', seed: 1.5 }), /seed/);
  assert.throws(() => decoyModel({ archetype: 'house' }, { seed: 0 }), /generateModel/);
});

test('every archetype x 15 seeds validates and carries the model-level contract', () => {
  each((archetype, seed, { model }) => {
    assert.equal(validateModel(model), model);
    assert.equal(model.id, archetype + '-' + String(seed).padStart(4, '0'));
    assert.equal(model.archetype, archetype);
    assert.equal(model.seed, seed);
    for (const key of ['title', 'scope_note']) assert.ok(typeof model[key] === 'string' && model[key].length > 10, where(model, key));
    assert.ok(!/\d/.test(model.title), where(model, 'title should be neutral, without numbers: ' + model.title));
    assert.match(model.frame.origin, /ground/i, where(model, 'origin sentence'));
    assert.match(model.frame.front, /\+Z/, where(model, 'front sentence'));
    assert.match(model.frame.front, /\+X is to the right/, where(model, 'front sentence'));
  });
});

test('groups: 6-14 per object, known categories, every part in exactly one declared group', () => {
  each((archetype, seed, { model }) => {
    assert.ok(model.groups.length >= 6 && model.groups.length <= 14, where(model, model.groups.length + ' groups'));
    const ids = new Set(model.groups.map(g => g.id));
    for (const g of model.groups) {
      assert.ok(CATEGORIES.includes(g.category), where(model, 'category ' + g.category));
      assert.ok(g.detail_size_m > 0 && g.detail_size_m <= 1, where(model, 'detail size of ' + g.id));
    }
    for (const part of model.parts) assert.ok(typeof part.group === 'string' && ids.has(part.group), where(model, 'part ' + part.id + ' has no declared group'));
  });
});

test('triangle budget: 2,000 to 60,000 per object', t => {
  const counts = {};
  each((archetype, seed, { model, soup }) => {
    assert.ok(soup.triangles >= 2000 && soup.triangles <= 60000, where(model, soup.triangles + ' triangles'));
    (counts[archetype] ??= []).push(soup.triangles);
  });
  for (const [archetype, list] of Object.entries(counts)) t.diagnostic(archetype + ' triangles ' + Math.min(...list) + '-' + Math.max(...list));
});

test('the same seed regenerates deep-equal JSON; different seeds differ', () => {
  for (const archetype of ARCHETYPES) for (const seed of [0, 7, 13]) {
    const again = generateModel({ archetype, seed });
    assert.equal(JSON.stringify(again), JSON.stringify(get(archetype, seed).model), archetype + ' ' + seed);
  }
  for (const archetype of ARCHETYPES) assert.notEqual(JSON.stringify(get(archetype, 1).model.parts), JSON.stringify(get(archetype, 2).model.parts));
});

test('seeds change structure, not only proportions', () => {
  for (const archetype of ARCHETYPES) {
    const models = SEEDS.map(seed => get(archetype, seed).model);
    const structures = new Set(models.map(m => JSON.stringify(m.generator.structure)));
    const groupSets = new Set(models.map(m => m.groups.map(g => g.id).sort().join(',')));
    const partCounts = new Set(models.map(m => m.parts.length));
    assert.ok(structures.size >= 10, archetype + ': only ' + structures.size + ' distinct structures in 15 seeds');
    assert.ok(groupSets.size >= 3, archetype + ': only ' + groupSets.size + ' distinct group sets');
    assert.ok(partCounts.size >= 10, archetype + ': only ' + partCounts.size + ' distinct part counts');
    // At least three structural features take more than one value across the seeds.
    const keys = Object.keys(models[0].generator.structure);
    const varying = keys.filter(k => new Set(models.map(m => JSON.stringify(m.generator.structure[k]))).size > 1);
    assert.ok(varying.length >= 3, archetype + ': structure varies only in ' + varying.join(','));
  }
  const kinds = new Set(SEEDS.map(seed => get('structure', seed).model.generator.structure.kind));
  assert.ok(kinds.size >= 2, 'structure sub-types seen: ' + [...kinds].join(','));
  // Optional house elements appear and are absent across the seeds.
  const houses = SEEDS.map(seed => get('house', seed).model.generator.structure);
  for (const key of ['garage', 'extension', 'porch', 'roof', 'floors']) assert.ok(new Set(houses.map(s => JSON.stringify(s[key]))).size > 1, 'house ' + key + ' never varies');
});

// Unit vectors perpendicular to a ray direction.
function lateral(direction) {
  const helper = Math.abs(direction[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = normalize(cross(direction, helper));
  return [e1, cross(direction, e1)];
}

test('probes: 6-12, every one hits, is not grazing, and survives a 5 cm lateral jitter', () => {
  each((archetype, seed, { model, soup }) => {
    assert.ok(model.probes.length >= 6 && model.probes.length <= 12, where(model, model.probes.length + ' probes'));
    for (const probe of model.probes) {
      assert.ok(near(Math.hypot(...probe.direction), 1, 1e-9));
      const hit = raycast(soup, probe.origin, probe.direction);
      assert.ok(hit, where(model, probe.id + ' misses'));
      const part = soup.triPart[hit.tri], n = triangleNormal(soup, hit.tri);
      const cosine = Math.abs(n[0] * probe.direction[0] + n[1] * probe.direction[1] + n[2] * probe.direction[2]);
      assert.ok(cosine >= 0.5, where(model, probe.id + ' grazes the surface at ' + (Math.acos(cosine) * 180 / Math.PI).toFixed(1) + ' deg'));
      const tolerance = 0.05 * Math.tan(Math.acos(cosine)) + 0.005;
      const [e1, e2] = lateral(probe.direction);
      for (let k = 0; k < 8; k++) {
        const a = k / 8 * Math.PI * 2, offset = [0, 1, 2].map(i => 0.05 * (Math.cos(a) * e1[i] + Math.sin(a) * e2[i]));
        const moved = raycast(soup, probe.origin.map((v, i) => v + offset[i]), probe.direction);
        assert.ok(moved, where(model, probe.id + ' misses when moved 5 cm'));
        assert.equal(soup.parts[soup.triPart[moved.tri]], soup.parts[part], where(model, probe.id + ' lands on another part when moved 5 cm'));
        assert.ok(Math.abs(moved.distance - hit.distance) <= tolerance + 0.01, where(model, probe.id + ' distance jumps by ' + Math.abs(moved.distance - hit.distance).toFixed(3) + ' m'));
      }
    }
  });
});

test('dimensions: 6-12, value equals |b - a|, true length in their view, endpoints on drawn edges', () => {
  each((archetype, seed, { model, soup }) => {
    assert.ok(model.dimensions.length >= 6 && model.dimensions.length <= 12, where(model, model.dimensions.length + ' dimensions'));
    const ids = new Set();
    const edges = featureEdges(soup);
    for (const d of model.dimensions) {
      assert.ok(!ids.has(d.id), where(model, 'duplicate dimension ' + d.id)); ids.add(d.id);
      assert.ok(['front', 'right', 'plan'].includes(d.view), where(model, d.id + ' view ' + d.view));
      assert.ok(near(d.value_m, Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1], d.b[2] - d.a[2]), 1e-4), where(model, d.id + ' value'));
      const check = dimensionEdgeDistances(edges, d);
      assert.ok(check.offAxis < 1e-3, where(model, d.id + ' is not parallel to its ' + d.view + ' view'));
      assert.ok(check.a <= 0.01 && check.b <= 0.01, where(model, d.id + ' endpoints are ' + check.a.toFixed(3) + ' / ' + check.b.toFixed(3) + ' m from any edge in the ' + d.view + ' view'));
    }
  });
});

test('no z-fighting: near-coincident parallel faces of different parts stay under 0.05% of pixels in every standard view', t => {
  const worst = {};
  each((archetype, seed, { model, soup }) => {
    for (const [name, az, el] of STANDARD_VIEWS) {
      const report = zFightReport(soup, viewCamera(soup.bounds, az, el, { width: 420 }));
      assert.ok(report.fraction < 5e-4, where(model, name + ' view z-fights on ' + (report.fraction * 100).toFixed(3) + '% of pixels: ' + JSON.stringify(report.pairs)));
      worst[archetype] = Math.max(worst[archetype] ?? 0, report.fraction);
    }
  });
  t.diagnostic('worst z-fight fraction ' + JSON.stringify(worst));
});

test('a mirrored copy is detectably different (left/right), and so is a front/rear flip', t => {
  const least = {};
  each((archetype, seed, { model, soup }) => {
    // Front and top views, mirrored across X, best shift along X applied first.
    const x = mirrorDifference(soup, 0, { width: 220, steps: 24 });
    assert.ok(x.difference >= 0.05, where(model, 'mirror image differs on only ' + (x.difference * 100).toFixed(1) + '% of pixels'));
    const z = mirrorDifference(soup, 2, { width: 220, steps: 24 });
    assert.ok(z.difference >= 0.03, where(model, 'front/rear flip differs on only ' + (z.difference * 100).toFixed(1) + '% of pixels'));
    const l = least[archetype] ??= { x: 1, z: 1 };
    l.x = Math.min(l.x, Math.round(x.difference * 1000) / 1000); l.z = Math.min(l.z, Math.round(z.difference * 1000) / 1000);
  });
  t.diagnostic('smallest mirror / flip difference ' + JSON.stringify(least));
});

test('the model survives the GLB round trip with the same geometry', async () => {
  for (const archetype of ARCHETYPES) {
    const { model, soup } = get(archetype, 3);
    const loaded = await soupFromGLB(modelToGLB(model));
    assert.equal(loaded.triangles, soup.triangles, archetype);
    for (const key of ['min', 'max']) for (let i = 0; i < 3; i++) assert.ok(near(loaded.bounds[key][i], soup.bounds[key][i], 1e-3), archetype + ' bounds');
  }
});

test('decoys: an earlier state with 1-3 measurable differences at shared probes, everything else identical', () => {
  for (const archetype of ARCHETYPES) for (const seed of SEEDS.slice(0, 10)) for (const decoySeed of [0, 1]) {
    const { model, soup } = get(archetype, seed);
    const { model: earlier, change } = decoyModel(model, { seed: decoySeed });
    const label = model.id + ' decoy ' + decoySeed;
    assert.equal(validateModel(earlier), earlier);
    assert.notEqual(earlier.id, model.id);
    assert.ok(earlier.generator.edits.length >= 1 && earlier.generator.edits.length <= 3, label + ' edits ' + earlier.generator.edits);
    assert.match(change.note, /^In this earlier state .+\.$/, label);
    assert.ok(Array.isArray(change.contested_probes) && change.contested_probes.length >= 1, label + ' has no contested probe');
    for (const key of ['title', 'frame', 'scope_note', 'materials', 'archetype', 'seed']) assert.deepEqual(earlier[key], model[key], label + ' ' + key);
    // Every probe of the earlier state is a probe of the primary, verbatim.
    const primaryProbes = new Map(model.probes.map(q => [q.id, q]));
    for (const q of earlier.probes) assert.deepEqual(q, primaryProbes.get(q.id), label + ' probe ' + q.id);
    const earlierSoup = soupFromModel(earlier);
    const limit = CONTESTED_FRACTION * Math.max(diagonal(soup.bounds), diagonal(earlierSoup.bounds));
    for (const id of change.contested_probes) {
      const p = primaryProbes.get(id), q = earlier.probes.find(r => r.id === id);
      assert.ok(p && q, label + ' contested ' + id + ' missing');
      const a = raycast(soup, p.origin, p.direction), c = raycast(earlierSoup, q.origin, q.direction);
      assert.ok(a && c, label + ' contested ' + id + ' misses');
      assert.ok(Math.abs(a.distance - c.distance) >= limit, label + ' contested ' + id + ' differs by only ' + Math.abs(a.distance - c.distance).toFixed(2) + ' m');
    }
    assert.ok(!sameShapes(shapes(model.parts), shapes(earlier.parts)), label + ' is identical to the primary');
    // Deterministic.
    assert.equal(JSON.stringify(decoyModel(model, { seed: decoySeed })), JSON.stringify({ model: earlier, change }), label + ' not deterministic');
  }
});

// Parts as an id-less multiset of their JSON (geometry, material and group).
function shapes(parts) {
  const pool = new Map();
  for (const part of parts) { const { id, ...rest } = part; void id; const k = JSON.stringify(rest); pool.set(k, (pool.get(k) ?? 0) + 1); }
  return pool;
}
const sameShapes = (a, b) => a.size === b.size && [...a].every(([k, n]) => b.get(k) === n);

test('each later addition taken away alone changes only its declared groups', t => {
  const changed = {};
  for (const archetype of ARCHETYPES) for (const seed of SEEDS.slice(0, 10)) {
    const { model } = get(archetype, seed);
    const edits = applicableEdits(model);
    assert.ok(edits.length >= 1, model.id + ' has no possible earlier state');
    for (const edit of edits) {
      const { model: earlier, scope } = earlierState(model, [edit]);
      assert.ok(scope.length >= 1, edit + ' declares no scope');
      const outside = parts => parts.filter(part => !scope.includes(part.group));
      assert.ok(sameShapes(shapes(outside(model.parts)), shapes(outside(earlier.parts))), model.id + ' ' + edit + ' changes parts outside ' + scope.join(','));
      const inside = parts => parts.filter(part => scope.includes(part.group));
      assert.ok(!sameShapes(shapes(inside(model.parts)), shapes(inside(earlier.parts))), model.id + ' ' + edit + ' changed nothing');
      const share = 1 - outside(model.parts).length / model.parts.length;
      changed[archetype + ' ' + edit] = Math.max(changed[archetype + ' ' + edit] ?? 0, Math.round(share * 100) / 100);
    }
  }
  t.diagnostic('largest share of parts inside an edit scope ' + JSON.stringify(changed));
});

test('the generator draws randomness only through the seeded kernel rng', async () => {
  const dir = new URL('../lib/generator/', import.meta.url).pathname;
  const files = [...(await readdir(dir)).filter(f => f.endsWith('.mjs')).map(f => join(dir, f)),
    ...(await readdir(join(dir, 'archetypes'))).map(f => join(dir, 'archetypes', f))];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.ok(!/Math\.random|Date\.now|new Date|performance\.now/.test(source), file + ' uses an unseeded or clock-dependent value');
  }
});

test('the added archetypes vary in plan, roof and attachments across 15 seeds', () => {
  const seen = archetype => {
    const values = {};
    for (const seed of SEEDS) for (const [key, value] of Object.entries(get(archetype, seed).model.generator.structure)) (values[key] ??= new Set()).add(JSON.stringify(value));
    return values;
  };
  const has = (values, key, wanted) => wanted.every(v => values[key]?.has(JSON.stringify(v)));
  const shed = seen('warehouse');
  assert.ok(has(shed, 'roof', ['gable', 'monitor', 'sawtooth']), 'warehouse roof forms: ' + [...shed.roof]);
  for (const key of ['officeSide', 'dockCanopy', 'tank', 'shutters']) assert.ok(shed[key].size > 1, 'warehouse ' + key + ' never varies');
  const row = seen('terrace');
  assert.ok(has(row, 'end', ['shop', 'wide', 'side']), 'terrace end houses: ' + [...row.end]);
  assert.ok(has(row, 'houses', [3, 4, 5]), 'terrace lengths: ' + [...row.houses]);
  for (const key of ['step', 'parapets', 'outshots', 'dormers', 'endSide']) assert.ok(row[key].size > 1, 'terrace ' + key + ' never varies');
  const hall = seen('civic');
  assert.ok(has(hall, 'plan', ['L', 'T', 'U']) && has(hall, 'roof', ['hip', 'gable']), 'civic plans ' + [...hall.plan] + ', roofs ' + [...hall.roof]);
  for (const key of ['portico', 'cupola', 'stair', 'columns']) assert.ok(hall[key].size > 1, 'civic ' + key + ' never varies');
});

// A stepped row has two eaves heights. 'eaves-height' gives the left end's; the step
// dimension must give the other one, not repeat it (an early 1.1 draft named the
// taller houses even when the left end was among them: terrace-0008 read 7.00 m twice).
test('terrace: the step dimension gives the eaves height the left-end dimension does not', () => {
  let stepped = 0;
  for (const seed of SEEDS) {
    const { model } = get('terrace', seed), eaves = model.dimensions.find(d => d.id === 'eaves-height');
    const step = model.dimensions.find(d => d.id === 'step-eaves-height');
    assert.ok(eaves, where(model, 'no eaves height'));
    if (!step) { assert.ok(!model.generator.structure.step, where(model, 'stepped row without a step dimension')); continue; }
    stepped++;
    assert.ok(Math.abs(step.value_m - eaves.value_m) >= 0.2, where(model, 'step eaves ' + step.value_m + ' m repeats the left-end eaves ' + eaves.value_m + ' m'));
    assert.match(step.label, step.value_m > eaves.value_m ? /taller/ : /lower/, where(model, step.label));
  }
  assert.ok(stepped >= 5, 'only ' + stepped + ' stepped rows in 15 seeds');
});

test('the added archetypes give valid models and decoys for large seeds (test sets draw seeds up to 2^31)', () => {
  for (const archetype of ADDED) {
    for (const seed of [100003, 7654321, 2147483646]) {
      const model = generateModel({ archetype, seed });
      assert.equal(validateModel(model), model);
      assert.ok(model.probes.length >= 6 && model.dimensions.length >= 6, model.id);
      assert.doesNotThrow(() => decoyModel(model, { seed }), model.id);
    }
  }
});

// Relief: a group whose surface lies within its own scoring tolerance of what is left
// without it is scored as present when it is missing (the generator 1.0 retail
// plinth: 3 cm proud, detail size 5 cm, F 0.76 when removed). checks.groupRelief
// measures, from the views the scorer uses for the group's facade, how far the
// group's visible surface lies from the remaining surface that faces the same way;
// its median must reach the group's detail size (1 mm sampling allowance: the retail
// piers stand exactly their 15 cm detail size proud).
test('every group stands out from its absence by at least its detail size', t => {
  const worst = {};
  // About 1-2 s of CPU per model: the added archetypes on 8 seeds, the original ones
  // on 3 (their 60-seed sweep is in the README).
  const runs = [...ADDED.flatMap(a => SEEDS.slice(0, 8).map(s => [a, s])), ...ORIGINAL.flatMap(a => [0, 1, 2].map(s => [a, s]))];
  for (const [archetype, seed] of runs) {
    const { model, soup } = get(archetype, seed);
    for (const r of groupRelief(model, soup)) {
      assert.ok(r.samples > 50, where(model, r.id + ' was barely sampled (' + r.samples + ')'));
      assert.ok(r.relief_m + 1e-3 >= r.detail_size_m, where(model, r.id + ' stands out by only ' + r.relief_m.toFixed(3) + ' m, detail size ' + r.detail_size_m + ' m'));
      const ratio = r.relief_m / r.detail_size_m;
      if (!(worst[archetype]?.ratio <= ratio)) worst[archetype] = { group: r.id, seed, ratio };
    }
  }
  const shown = Object.fromEntries(Object.entries(worst).map(([a, w]) => [a, w.group + '@' + w.seed + ' ' + (Number.isFinite(w.ratio) ? w.ratio.toFixed(2) : 'far')]));
  t.diagnostic('smallest relief / detail size ' + JSON.stringify(shown));
});

test('the generator 1.0 defect cases now stand out: retail base band, tower spandrels, hall parapet tops', () => {
  const relief = (archetype, seed, id) => groupRelief(get(archetype, seed).model, get(archetype, seed).soup).find(r => r.id === id);
  for (const seed of [0, 12]) {
    const model = get('retail', seed).model;
    const front = model.parts.find(part => part.id.startsWith('base-front'));
    assert.ok(near(front.position[2] + front.size[2] / 2, 0.06, 1e-4), 'retail base band projection');
    assert.ok(relief('retail', seed, 'base').absent_recall_tau < 0.1, 'retail base still recalled when absent');
  }
  const tower = get('tower', 0).model;
  assert.equal(tower.generator.structure.facade, 'curtain');
  assert.ok(relief('tower', 0, 'facade.grid').relief_m >= 0.12);
  // Parapet tops (seed 9 plain, seed 0 with pinnacles) are judged at 12 cm; a spire (seed 1) still at 20 cm.
  for (const [seed, top, detail] of [[9, 'parapet', 0.12], [0, 'parapet', 0.12], [1, 'spire', 0.2]]) {
    const hall = get('hall', seed).model;
    assert.equal(hall.generator.params.tower.top, top);
    assert.equal(hall.groups.find(g => g.id === 'tower.top').detail_size_m, detail, 'hall ' + seed);
  }
});

// About 1 % of hall seeds (four-bay halls with a spire and no porch) and of structure
// seeds (two-tier guide frames with the governor house in front of the stair) had no
// earlier state a probe could tell apart: generator 1.0 threw, so build-object would
// fail on such a seed in a private set. Generator 1.1 tries the archetype's fallback
// edits after every regular choice has failed.
test('seeds whose generator 1.0 decoy failed get one from a fallback edit', () => {
  const cases = [['hall', 2072130444, 'no-transept'], ['hall', 981359938, 'fewer-bays-short'], ['hall', 321332946, 'no-transept'], ['hall', 1586491203, 'no-transept'],
    ['structure', 1145207690, 'one-tier-fewer-short'], ['structure', 732622129, 'one-tier-fewer-short']];
  for (const [archetype, seed, edit] of cases) {
    const model = generateModel({ archetype, seed }), soup = soupFromModel(model);
    assert.ok(!applicableEdits(model).includes(edit), 'fallback edits are not offered as regular edits');
    const { model: earlier, change } = decoyModel(model, { seed });
    assert.deepEqual(earlier.generator.edits, [edit], model.id);
    const earlierSoup = soupFromModel(earlier), limit = CONTESTED_FRACTION * Math.max(diagonal(soup.bounds), diagonal(earlierSoup.bounds));
    assert.ok(change.contested_probes.length >= 1, model.id);
    for (const id of change.contested_probes) {
      const q = model.probes.find(probe => probe.id === id), a = raycast(soup, q.origin, q.direction), c = raycast(earlierSoup, q.origin, q.direction);
      assert.ok(a && c && Math.abs(a.distance - c.distance) >= limit, model.id + ' ' + id);
    }
    const { scope } = earlierState(model, [edit]), outside = parts => parts.filter(part => !scope.includes(part.group));
    assert.ok(sameShapes(shapes(outside(model.parts)), shapes(outside(earlier.parts))), model.id + ' ' + edit + ' changes parts outside its scope');
  }
});

// Byte-identity guard. The dev set and the pilot were built with generator 1.0; its
// output for the five original archetypes must not move except for the documented
// relief fix (generator 1.1): retail base-band parts, tower spandrel parts, the hall
// tower-top detail size, and the version string. Hashes below were computed with
// generator 1.0 (git 2cef4f9) after masking exactly those fields.
const GENERATOR_1_0 = {
  models: {
    'house-0': '89dc151f5860b547', 'house-7': '47963f277aef7cae', 'house-11': 'e618aedd446d3417',
    'retail-0': '2dc37cdc8015ed8f', 'retail-7': '92f24e9798bd57f8', 'retail-12': 'e2ce82386d99c769',
    'tower-0': '7a6172843cabbd4c', 'tower-3': 'd935a8bbec5e27aa', 'tower-13': '1681441420bf7c36',
    'hall-0': '424cf1b35f5dc1b9', 'hall-9': 'ffa8025ef12fe87a', 'hall-14': 'eaa9f8b4b6d07efa',
    'structure-0': 'a2178c28eceba69c', 'structure-7': '6fb854c3fb8e5a48', 'structure-15': 'bae6c29f712246fd',
  },
  // decoyModel(model, { seed: model.seed }), as pack.mjs builds the dev objects.
  decoys: { 'house-11': 'abac3ee117ed5bcc', 'retail-12': '75bc567ab3071865', 'tower-13': 'cea87841cc3d05e2', 'hall-14': 'dd29d20743b3c979', 'structure-15': '248eb1e68b75ec12' },
};
function maskedFix(model) {
  const m = structuredClone(model);
  m.generator.version = 'e3d-generator-1.0';
  if (m.archetype === 'retail') m.parts = m.parts.filter(part => part.group !== 'base');
  if (m.archetype === 'tower') m.parts = m.parts.filter(part => !part.id.includes('-spandrel-'));
  if (m.archetype === 'hall') for (const g of m.groups) if (g.id === 'tower.top') g.detail_size_m = null;
  return m;
}
const shortHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

test('original archetypes: output identical to generator 1.0 apart from the documented fix', () => {
  assert.notEqual(GENERATOR_VERSION, 'e3d-generator-1.0');
  for (const [id, expected] of Object.entries(GENERATOR_1_0.models)) {
    const [archetype, seed] = id.split('-');
    const model = generateModel({ archetype, seed: Number(seed) });
    assert.equal(model.generator.version, GENERATOR_VERSION);
    assert.equal(shortHash(maskedFix(model)), expected, id + ' changed beyond the documented fix');
    if (GENERATOR_1_0.decoys[id]) {
      const { model: earlier, change } = decoyModel(model, { seed: Number(seed) });
      assert.equal(shortHash({ model: maskedFix(earlier), change }), GENERATOR_1_0.decoys[id], id + ' decoy changed beyond the documented fix');
    }
  }
  // House and structure were not touched at all.
  for (const id of ['house-7', 'structure-15']) {
    const [archetype, seed] = id.split('-'), model = generateModel({ archetype, seed: Number(seed) });
    const unmasked = { ...model, generator: { ...model.generator, version: 'e3d-generator-1.0' } };
    assert.equal(shortHash(unmasked), GENERATOR_1_0.models[id], id);
  }
});
