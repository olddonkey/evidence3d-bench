import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ARCHETYPES, generateModel, decoyModel, applicableEdits, earlierState, CONTESTED_FRACTION } from '../lib/generator/index.mjs';
import { validateModel, modelToGLB } from '../lib/model.mjs';
import { soupFromModel, soupFromGLB } from '../lib/soup.mjs';
import { raycast, triangleNormal, cross, normalize } from '../lib/raster.mjs';
import {
  featureEdges, dimensionEdgeDistances, zFightReport, viewCamera, STANDARD_VIEWS, mirrorDifference, diagonal,
} from '../lib/generator/checks.mjs';

const SEEDS = Array.from({ length: 15 }, (_, i) => i);
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

test('the five archetypes are registered and bad requests are refused', () => {
  assert.deepEqual([...ARCHETYPES], ['house', 'retail', 'tower', 'hall', 'structure']);
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

test('a mirrored copy is detectably different (left/right), and so is a front/rear flip', () => {
  each((archetype, seed, { model, soup }) => {
    // Front and top views, mirrored across X, best shift along X applied first.
    const x = mirrorDifference(soup, 0, { width: 220, steps: 24 });
    assert.ok(x.difference >= 0.05, where(model, 'mirror image differs on only ' + (x.difference * 100).toFixed(1) + '% of pixels'));
    const z = mirrorDifference(soup, 2, { width: 220, steps: 24 });
    assert.ok(z.difference >= 0.03, where(model, 'front/rear flip differs on only ' + (z.difference * 100).toFixed(1) + '% of pixels'));
  });
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
