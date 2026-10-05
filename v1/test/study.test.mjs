import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG } from '../lib/png.mjs';
import { soupFromModel } from '../lib/soup.mjs';
import { writeSampleRuns } from '../lib/report/sample-runs.mjs';
import { sampleModel } from '../fixtures/sample-model.mjs';
import { STRATA, stratumOf, higherSide, selectPairs, collectSubmissions, publicPairs, privateKey, imageName } from '../lib/study/select.mjs';
import { STUDY_VIEWS, studyCameras, renderViews } from '../lib/study/render.mjs';
import { prepareStudy, studyDir } from '../lib/study/index.mjs';
import { startStudyServer, parseVotes } from '../lib/study/server.mjs';
import { analyzeStudy, wilson, writeAnalysis } from '../lib/study/analyze.mjs';
import { KEY_CHOICES, latestChoices, votedTrail, nextUnrated, afterCurrent, progress, elapsed } from '../lib/study/page/state.js';

const PAGE = fileURLToPath(new URL('../lib/study/page/', import.meta.url));
const near = (actual, expected, tolerance = 5e-4) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' is not within ' + tolerance + ' of ' + expected);

async function withTemp(run) {
  const root = await mkdtemp(join(tmpdir(), 'e3d-study-'));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

// ------------------------------------------------------------ synthetic submissions

// One task per (object, variant): configuration X with three attempts, Y and Z
// with one each. Scores 50, 51, 66 (X), 56 (Y), 85 (Z) give gaps in every
// stratum: [0, 3) only X1-X2 (same configuration); [3, 8) X1-Y, X2-Y; [8, 15)
// X3-Y; [15, 100] X1-X3, X2-X3 (same configuration) and every pair with Z.
const CONFIGS = { X: { system: 'codex', model: 'secret-model-x', effort: 'high', batch: 'secret-batch-x' },
  Y: { system: 'claude-code', model: 'secret-model-y', effort: 'high', batch: 'secret-batch-y' },
  Z: { system: 'codex', model: 'secret-model-z', effort: 'low', batch: 'secret-batch-z' } };
function submission(object, variant, archetype, config, slot, score, offset = 0) {
  const c = CONFIGS[config], taskId = object + '-' + variant;
  return { key: c.batch + '/' + taskId + '/' + slot, batch: c.batch, task_id: taskId, slot, dir: 'runs/' + c.batch + '/' + taskId + '/' + slot,
    model_path: 'runs/' + c.batch + '/' + taskId + '/' + slot + '/score/submission.glb', model_sha256: null,
    system: c.system, model: c.model, effort: c.effort, config: [c.system, c.model, c.effort].join(' / '),
    object, variant, archetype, set: 'secret-set', title: 'Synthetic ' + archetype, score: score + offset,
    shape_score: score + offset + 10, detail_score: score + offset - 10, alignment: { yaw_deg: 0, scale: 1, translation_m: [0, 0, 0] },
    shape_pose_moved: 0, diagonal_m: 10, bounds: null };
}
function design(objects, variants = ['t2', 't4']) {
  const list = [];
  objects.forEach(([object, archetype], index) => {
    for (const [v, variant] of variants.entries()) {
      const offset = (index * 2 + v) * 0.01;
      list.push(submission(object, variant, archetype, 'X', 'a1', 50, offset), submission(object, variant, archetype, 'X', 'a2', 51, offset),
        submission(object, variant, archetype, 'X', 'a3', 66, offset), submission(object, variant, archetype, 'Y', 'a1', 56, offset),
        submission(object, variant, archetype, 'Z', 'a1', 85, offset));
    }
  });
  return list;
}
const OBJECTS_3 = [['secret-obj-1', 'house'], ['secret-obj-2', 'tower'], ['secret-obj-3', 'hall']];
const OBJECTS_6 = [...OBJECTS_3, ['secret-obj-4', 'house'], ['secret-obj-5', 'tower'], ['secret-obj-6', 'hall']];

test('strata cover [0, 3), [3, 8), [8, 15), [15, 100]', () => {
  assert.deepEqual([0, 2.999, 3, 7.99, 8, 14.99, 15, 99, 100].map(gap => stratumOf(gap)), [0, 0, 1, 1, 2, 2, 3, 3, 3]);
  assert.equal(stratumOf(100.5), -1);
  assert.equal(stratumOf(-1), -1);
  assert.equal(stratumOf(Number.NaN), -1);
  assert.equal(higherSide(60, 50), 'a');
  assert.equal(higherSide(50, 60), 'b');
  assert.equal(higherSide(50, 50), null);
  assert.equal(higherSide(50, null), null);
});

test('selection is stratified, capped at two pairs per task, skips t1 and prefers cross-configuration pairs', () => {
  const submissions = [...design(OBJECTS_3), ...design([['secret-obj-9', 'house']], ['t1'])];
  const selection = selectPairs(submissions, { pairs: 8, seed: 'unit', repeatShare: 0 });
  assert.deepEqual(selection.strata.map(item => item.selected), [2, 2, 2, 2]);
  assert.deepEqual(selection.strata.map(item => item.shortfall), [0, 0, 0, 0]);
  assert.equal(selection.pairs.length, 8);
  const perTask = new Map();
  for (const pair of selection.pairs) {
    perTask.set(pair.task_id, (perTask.get(pair.task_id) ?? 0) + 1);
    assert.notEqual(pair.variant, 't1');
    assert.equal(pair.a.task_id, pair.task_id);
    assert.equal(pair.b.task_id, pair.task_id);
    assert.notEqual(pair.a.key, pair.b.key);
    assert.equal(STRATA[pair.stratum].id, STRATA[stratumOf(Math.abs(pair.a.score - pair.b.score))].id);
  }
  assert.ok([...perTask.values()].every(count => count <= 2), JSON.stringify([...perTask]));
  // Gaps under 3 exist only within configuration X here; every other stratum has cross-configuration material and uses it.
  assert.deepEqual(selection.strata.map(item => item.cross_configuration), [0, 2, 2, 2]);
  // Variants balanced within each stratum: one t2 and one t4.
  for (const stratum of selection.strata) assert.deepEqual(stratum.variants, { t2: 1, t4: 1 }, stratum.id);
  // Archetypes balanced within a stratum as far as two pairs allow: two different ones.
  for (const stratum of selection.strata) assert.equal(Object.keys(stratum.archetypes).length, 2, stratum.id);
});

test('cross-configuration pairs are preferred where same-configuration pairs are the majority', () => {
  // Per task: six attempts of X (15 same-configuration pairs) and one of Y (6 cross pairs), all in one stratum.
  const submissions = [];
  for (const [object, archetype] of OBJECTS_6) {
    for (const [n, value] of [10, 20, 30, 40, 50, 60].entries()) submissions.push(submission(object, 't2', archetype, 'X', 'a' + (n + 1), value));
    submissions.push(submission(object, 't2', archetype, 'Y', 'a1', 35));
  }
  const selection = selectPairs(submissions, { pairs: 6, seed: 'cross', repeatShare: 0, strata: [{ id: 'all', min: 0, max: 100 }] });
  assert.equal(selection.pairs.length, 6);
  assert.ok(selection.pairs.every(pair => pair.cross), selection.pairs.map(pair => pair.a.config + ' vs ' + pair.b.config).join('; '));
  // With no cross pair left in a task, same-configuration pairs are still allowed.
  const sameOnly = selectPairs(submissions.filter(item => item.batch !== 'secret-batch-y'), { pairs: 4, seed: 'cross', repeatShare: 0, strata: [{ id: 'all', min: 0, max: 100 }] });
  assert.equal(sameOnly.pairs.length, 4);
});

test('a short stratum is reported, never filled past the per-task cap', () => {
  const selection = selectPairs(design(OBJECTS_3), { pairs: 40, seed: 'unit', repeatShare: 0 });
  // 6 tasks x 2 pairs = 12 slots for 40 requested pairs.
  assert.equal(selection.pairs.length, 12);
  assert.deepEqual(selection.strata.map(item => item.target), [10, 10, 10, 10]);
  assert.equal(selection.strata.reduce((sum, item) => sum + item.shortfall, 0), 28);
  const perTask = new Map();
  for (const pair of selection.pairs) perTask.set(pair.task_id, (perTask.get(pair.task_id) ?? 0) + 1);
  assert.ok([...perTask.values()].every(count => count === 2));
  // Strata took turns: none was starved by the others using up the tasks.
  assert.ok(selection.strata.every(item => item.selected >= 2), JSON.stringify(selection.strata.map(item => item.selected)));
  // A per-task cap of 1 halves it.
  assert.equal(selectPairs(design(OBJECTS_3), { pairs: 40, seed: 'unit', repeatShare: 0, perTask: 1 }).pairs.length, 6);
});

test('repeats show the same two submissions with the sides swapped, far from their original', () => {
  const selection = selectPairs(design(OBJECTS_6), { pairs: 20, seed: 'repeat', repeatShare: 0.1 });
  const originals = selection.pairs.filter(pair => !pair.repeat_of), repeats = selection.pairs.filter(pair => pair.repeat_of);
  assert.equal(originals.length, 20);
  assert.equal(repeats.length, 2);
  const byId = new Map(selection.pairs.map(pair => [pair.id, pair]));
  for (const repeat of repeats) {
    const original = byId.get(repeat.repeat_of);
    assert.ok(original && !original.repeat_of);
    assert.equal(repeat.a.key, original.b.key);
    assert.equal(repeat.b.key, original.a.key);
    assert.equal(repeat.stratum, original.stratum);
    assert.ok(Math.abs(repeat.position - original.position) >= 5, 'repeat ' + repeat.position + ' vs original ' + original.position);
  }
  // Repeats are spread over the strata.
  assert.equal(new Set(repeats.map(pair => pair.stratum)).size, 2);
  // Half the pairs of each stratum have the higher-scored submission on A.
  for (const [index] of STRATA.entries()) {
    const inStratum = originals.filter(pair => pair.stratum === index);
    const onA = inStratum.filter(pair => pair.a.score > pair.b.score).length;
    assert.ok(Math.abs(2 * onA - inStratum.length) <= 1, 'stratum ' + index + ': ' + onA + ' of ' + inStratum.length);
  }
  // Ids are unique; positions are 0..n-1.
  assert.equal(new Set(selection.pairs.map(pair => pair.id)).size, selection.pairs.length);
  assert.deepEqual(selection.pairs.map(pair => pair.position), selection.pairs.map((_, i) => i));
});

test('selection is seeded: same seed and any input order give the same study, another seed another order', () => {
  const submissions = design(OBJECTS_6);
  const ids = selection => selection.pairs.map(pair => [pair.id, pair.a.key, pair.b.key]);
  const first = selectPairs(submissions, { pairs: 16, seed: 's1' });
  assert.deepEqual(ids(selectPairs(submissions.slice().reverse(), { pairs: 16, seed: 's1' })), ids(first));
  assert.notDeepEqual(ids(selectPairs(submissions, { pairs: 16, seed: 's2' })), ids(first));
  // The presentation order is not the order of the gap.
  const gaps = first.pairs.map(pair => pair.gap);
  const sortedUp = gaps.every((gap, i) => i === 0 || gaps[i - 1] <= gap), sortedDown = gaps.every((gap, i) => i === 0 || gaps[i - 1] >= gap);
  assert.ok(!sortedUp && !sortedDown);
  const byId = first.pairs.slice().sort((p, q) => p.id.localeCompare(q.id)).map(pair => pair.gap);
  assert.ok(!byId.every((gap, i) => i === 0 || byId[i - 1] <= gap) && !byId.every((gap, i) => i === 0 || byId[i - 1] >= gap));
});

// Strings that must never reach the rater.
function forbiddenIn(text, extra = []) {
  const words = ['score', 'batch', 'secret', 'codex', 'claude', 'astra', 'opus', 'luna', 'haiku', 'gpt-', 'test1-', 'test2-', 'runs/', 'stratum', 'key.json', ...extra];
  return words.filter(word => text.toLowerCase().includes(word.toLowerCase()));
}

test('pairs.json carries only id, title, variant and image names; key.json carries the rest', () => {
  const selection = selectPairs(design(OBJECTS_6), { pairs: 12, seed: 'leak' });
  const views = STUDY_VIEWS.map(view => ({ ...view }));
  const pairs = publicPairs(selection, { name: 'unit', views });
  assert.deepEqual(Object.keys(pairs).sort(), ['name', 'pairs', 'schema', 'views']);
  for (const pair of pairs.pairs) {
    assert.deepEqual(Object.keys(pair).sort(), ['id', 'images', 'title', 'variant']);
    assert.match(pair.id, /^[0-9a-f]{8}$/);
    for (const view of STUDY_VIEWS) for (const role of ['r', 'a', 'b']) assert.equal(pair.images[view.id][role], imageName(pair.id, role, view.id));
  }
  for (const view of pairs.views) assert.deepEqual(Object.keys(view).sort(), ['id', 'label']);
  const text = JSON.stringify(pairs);
  assert.deepEqual(forbiddenIn(text, ['secret-obj', 'a1/', '/a2', 'gap', 'repeat', 'higher', 'synthetic-']), []);
  // The scan itself works: the private key is full of these strings.
  const key = privateKey(selection, { name: 'unit', batches: ['secret-batch-x'], views });
  assert.ok(forbiddenIn(JSON.stringify(key)).length >= 5);
  for (const pair of key.pairs) {
    assert.ok(pair.a.batch && pair.a.dir && Number.isFinite(pair.a.score) && Number.isFinite(pair.gap) && pair.stratum && pair.archetype);
    assert.ok(['a', 'b'].includes(pair.higher));
  }
  assert.equal(key.pairs.filter(pair => pair.repeat_of).length, 1);
});

test('the page source names no score, batch, model, system or private file', async () => {
  const files = (await readdir(PAGE)).sort();
  assert.deepEqual(files, ['app.js', 'index.html', 'state.js', 'style.css']);
  for (const file of files) {
    const text = await readFile(join(PAGE, file), 'utf8');
    assert.deepEqual(forbiddenIn(text), [], file);
    // Offline: nothing is fetched from another host.
    assert.doesNotMatch(text, /https?:\/\//, file);
    assert.doesNotMatch(text, /\/\/[a-z0-9.-]+\.[a-z]{2,}\//i, file);
  }
  const html = await readFile(join(PAGE, 'index.html'), 'utf8');
  assert.match(html, /同一道题的参考模型和两份提交。哪一份的几何更接近参考？忽略颜色和材质。/);
  for (const label of ['A 更接近', '分不出', 'B 更接近', '上一对']) assert.ok(html.includes(label), label);
});

test('page logic: keys, last vote per pair, resume at the first unrated pair, trail for "上一对"', () => {
  assert.deepEqual([KEY_CHOICES.ArrowLeft, KEY_CHOICES['1'], KEY_CHOICES.ArrowDown, KEY_CHOICES['0'], KEY_CHOICES.ArrowRight, KEY_CHOICES['2']],
    ['a', 'a', 'tie', 'tie', 'b', 'b']);
  const pairs = ['p0', 'p1', 'p2', 'p3', 'p4'].map(id => ({ id }));
  const votes = [{ pair: 'p0', choice: 'a' }, { pair: 'p1', choice: 'tie' }, { pair: 'p0', choice: 'b' }, { pair: 'p4', choice: 'a' }];
  const latest = latestChoices(votes);
  assert.equal(latest.get('p0'), 'b');
  assert.equal(nextUnrated(pairs, latest), 2);
  assert.equal(nextUnrated(pairs, latest, 2), 3);
  assert.equal(nextUnrated(pairs, latest, 3), 2);
  assert.deepEqual(progress(pairs, latest), { rated: 3, total: 5 });
  assert.deepEqual(votedTrail(pairs, votes), [1, 0, 4]);
  const all = latestChoices(pairs.map(pair => ({ pair: pair.id, choice: 'a' })));
  assert.equal(nextUnrated(pairs, all), -1);
  // After "上一对" twice from pair 3 (ahead holds 3, then 2), done with pair 1 goes to 2, then to 3, then on.
  const ahead = [3, 2];
  assert.equal(afterCurrent(pairs, latest, 1, ahead), 2);
  assert.equal(afterCurrent(pairs, latest, 2, ahead), 3);
  assert.equal(afterCurrent(pairs, latest, 3, ahead), 2);
  assert.deepEqual(ahead, []);
  // Back from the closing screen (-1): done with the pair goes to the next unrated, or closes again.
  assert.equal(afterCurrent(pairs, all, 4, [-1]), -1);
  assert.equal(afterCurrent(pairs, latest, 0, [-1]), 2);
  assert.deepEqual(elapsed(1000, 6000.4, 1500.2), { ms: 5000, hidden_ms: 1500 });
  assert.deepEqual(elapsed(1000, 900, 0), { ms: 0, hidden_ms: 0 });
  assert.deepEqual(elapsed(0, 100, 250), { ms: 100, hidden_ms: 100 });
});

// ------------------------------------------------------------ rendering

const BACKGROUND = [243, 242, 238];
const drawnMask = image => Uint8Array.from({ length: image.width * image.height },
  (_, i) => image.pixels[i * 3] !== BACKGROUND[0] || image.pixels[i * 3 + 1] !== BACKGROUND[1] || image.pixels[i * 3 + 2] !== BACKGROUND[2] ? 1 : 0);
const drawnPixels = image => drawnMask(image).reduce((sum, value) => sum + value, 0);

test('study cameras depend on the truth bounds only and frame the whole truth', () => {
  const truth = soupFromModel(sampleModel());
  const cameras = studyCameras(truth.bounds, { width: 96, height: 72 });
  assert.deepEqual(Object.keys(cameras), STUDY_VIEWS.map(view => view.id));
  assert.deepEqual(studyCameras(structuredClone(truth.bounds), { width: 96, height: 72 }), cameras);
  const shots = renderViews(truth, cameras, { clay: true, supersample: 1 });
  for (const view of STUDY_VIEWS) {
    const image = decodePNG(shots[view.id].png);
    assert.deepEqual([image.width, image.height], [96, 72]);
    assert.ok(shots[view.id].covered > 0.15 * 96 * 72, view.id + ' covers ' + shots[view.id].covered);
    assert.equal(shots[view.id].clipped, false, view.id);
  }
  // The views differ (front-left is not front-right).
  assert.notDeepEqual(shots.fl.png, shots.fr.png);
});

// Synthetic runs: two objects (house archetypes), configurations codex/gpt-demo
// and claude-code/opus-demo, t1/t2/t4. Scores give pairs in every stratum.
const RUN_SPECS = [];
for (const [object, archetype] of [['demo-house-a', 'house'], ['demo-house-b', 'hall']]) {
  for (const variant of ['t2', 't4']) {
    RUN_SPECS.push(
      { system: 'codex', model: 'gpt-demo', effort: 'high', batch: 'demo-codex', object, variant, archetype, attempt: 1, score: 70 },
      { system: 'codex', model: 'gpt-demo', effort: 'high', batch: 'demo-codex', object, variant, archetype, attempt: 2, score: 71, dropGroups: ['chimney'] },
      { system: 'claude-code', model: 'opus-demo', effort: 'max', batch: 'demo-claude', object, variant, archetype, attempt: 1, score: 65, dropGroups: ['front.canopy'] },
      { system: 'claude-code', model: 'opus-demo', effort: 'max', batch: 'demo-claude', object, variant, archetype, attempt: 2, score: 59, dropGroups: ['roof'] },
      { system: 'claude-code', model: 'opus-demo', effort: 'max', batch: 'demo-claude', object, variant, archetype, attempt: 3, score: 40, dropGroups: ['roof', 'chimney', 'front.canopy'] });
  }
  RUN_SPECS.push({ system: 'codex', model: 'gpt-demo', effort: 'high', batch: 'demo-codex', object, variant: 't1', archetype, attempt: 1, score: 30 });
}
RUN_SPECS.push({ system: 'codex', model: 'gpt-demo', effort: 'high', batch: 'demo-codex', object: 'demo-house-a', variant: 't2', archetype: 'house', attempt: 3, score: null, status: 'ok', invalid: 'Triangle limit exceeded' });
RUN_SPECS.push({ system: 'codex', model: 'gpt-demo', effort: 'high', batch: 'demo-codex', object: 'demo-house-b', variant: 't2', archetype: 'hall', attempt: 3, score: null, status: 'infra_error' });

async function withRuns(run) {
  return withTemp(async root => {
    const dataRoot = join(root, 'data');
    await writeSampleRuns(dataRoot, { attempts: RUN_SPECS, withInputs: false });
    return run(dataRoot, root);
  });
}

test('prepare: real files, identical cameras for the three models, non-blank renders, no leak', async () => {
  await withRuns(async dataRoot => {
    const collected = await collectSubmissions({ dataRoot, batches: ['demo-codex', 'demo-claude'] });
    assert.equal(collected.submissions.length, 20);
    assert.deepEqual(collected.skipped, { variant: 2, excluded: 1, invalid: 1, no_model: 0 });
    const summary = await prepareStudy({ dataRoot, name: 'unit', batches: ['demo-codex', 'demo-claude'], pairs: 8, seed: 'prep', size: { width: 96, height: 72 } });
    assert.equal(summary.originals, 8);
    assert.equal(summary.repeats, 1);
    assert.deepEqual(summary.strata.map(item => item.selected), [2, 2, 2, 2]);
    const dir = studyDir(dataRoot, 'unit');
    const pairs = JSON.parse(await readFile(join(dir, 'pairs.json'), 'utf8'));
    const key = JSON.parse(await readFile(join(dir, 'key.json'), 'utf8'));
    assert.deepEqual(forbiddenIn(await readFile(join(dir, 'pairs.json'), 'utf8'), ['demo-', 'gpt', 'opus', '-t2', '-t4', 'output/', 'gap', 'repeat', 'higher', 'house-']), []);
    assert.deepEqual(pairs.pairs.map(pair => pair.id), key.pairs.map(pair => pair.id));
    assert.equal(summary.images, 9 * 3 * STUDY_VIEWS.length);
    const files = await readdir(join(dir, 'images'));
    assert.equal(files.length, summary.images);
    for (const name of files) assert.match(name, /^[0-9a-f]{8}-[rab]-(fl|fr|rear|high)\.png$/);
    const load = async name => decodePNG(await readFile(join(dir, 'images', name)));
    for (const pair of key.pairs) {
      for (const view of STUDY_VIEWS) for (const role of ['r', 'a', 'b']) {
        const image = await load(pair.images[view.id][role]);
        assert.deepEqual([image.width, image.height], [96, 72]);
        assert.ok(drawnPixels(image) > 300, pair.id + ' ' + role + ' ' + view.id + ' is blank');
      }
    }
    // Same cameras, framed on the truth, and the submission placed by its
    // alignment: every synthetic submission is the truth minus some groups, so
    // whatever it draws must lie on the reference's silhouette in every view.
    for (const pair of key.pairs) {
      for (const view of STUDY_VIEWS) {
        const reference = drawnMask(await load(pair.images[view.id].r));
        for (const role of ['a', 'b']) {
          const drawn = drawnMask(await load(pair.images[view.id][role]));
          let inside = 0, total = 0;
          for (let i = 0; i < drawn.length; i++) if (drawn[i]) { total++; if (reference[i]) inside++; }
          assert.ok(inside / total > 0.99, pair.id + ' ' + role + ' ' + view.id + ': ' + inside + ' of ' + total + ' drawn pixels on the reference');
        }
      }
    }
    // Same truth, same cameras: every pair of an object shows byte-identical references.
    const references = new Map();
    for (const pair of key.pairs) {
      const bytes = await readFile(join(dir, 'images', pair.images.fl.r));
      if (references.has(pair.object)) assert.ok(references.get(pair.object).equals(bytes), pair.object);
      else references.set(pair.object, bytes);
    }
    // A submission that is the complete model, placed by its alignment, is drawn
    // like the reference: same camera, same shading, only geometry could differ.
    const complete = key.pairs.find(pair => ['a', 'b'].some(role => pair[role].score === 70));
    assert.ok(complete, 'a pair shows the complete model');
    const role = complete.a.score === 70 ? 'a' : 'b', other = role === 'a' ? 'b' : 'a';
    let viewsThatDiffer = 0;
    for (const view of STUDY_VIEWS) {
      const reference = await load(complete.images[view.id].r), drawn = await load(complete.images[view.id][role]), changed = await load(complete.images[view.id][other]);
      let same = 0, differs = 0;
      for (let i = 0; i < reference.pixels.length; i++) { if (reference.pixels[i] === drawn.pixels[i]) same++; if (reference.pixels[i] !== changed.pixels[i]) differs++; }
      assert.ok(same / reference.pixels.length > 0.995, view.id + ': ' + same + ' of ' + reference.pixels.length);
      if (differs) viewsThatDiffer++;
    }
    assert.ok(viewsThatDiffer > 0, 'a model with a part missing looks different');
    assert.ok(key.render.timing.total_s >= 0 && key.render.timing.mean_pair_ms >= 0);
    assert.equal(key.render.concerns.submissions, new Set(key.pairs.flatMap(pair => [pair.a.model_path, pair.b.model_path])).size);
    // A study is not prepared over itself without --force, and never over votes.
    await assert.rejects(prepareStudy({ dataRoot, name: 'unit', batches: ['demo-codex'], pairs: 4, seed: 'prep' }), /--force/);
    await writeFile(join(dir, 'votes.jsonl'), JSON.stringify({ pair: key.pairs[0].id, choice: 'a', ms: 1, at: 'x' }) + '\n');
    await assert.rejects(prepareStudy({ dataRoot, name: 'unit', batches: ['demo-codex'], pairs: 4, seed: 'prep', force: true }), /holds votes/);
  });
});

// ------------------------------------------------------------ server

function call(url, { method = 'GET', body, headers = {} } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: target.hostname, port: target.port, path: target.pathname, method, headers: { Host: target.host, ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function handMadeStudy(dir) {
  const views = STUDY_VIEWS.map(view => ({ id: view.id, label: view.label }));
  const ids = ['0000aaaa', '0000bbbb'];
  const pairs = { schema: 'e3d-study-pairs-v1', name: 'srv', views,
    pairs: ids.map(id => ({ id, title: 'T', variant: 't2', images: Object.fromEntries(views.map(view => [view.id, { r: imageName(id, 'r', view.id), a: imageName(id, 'a', view.id), b: imageName(id, 'b', view.id) }])) })) };
  await mkdir(join(dir, 'images'), { recursive: true });
  await writeFile(join(dir, 'pairs.json'), JSON.stringify(pairs));
  await writeFile(join(dir, 'key.json'), JSON.stringify({ secret: true }));
  await writeFile(join(dir, 'images', imageName(ids[0], 'r', 'fl')), encodePNG(2, 2, new Uint8Array(12).fill(200), 3));
  // On disk but not named in pairs.json: never served.
  await writeFile(join(dir, 'images', 'stray.png'), encodePNG(2, 2, new Uint8Array(12).fill(10), 3));
  return { ids, pairs };
}

test('server: 127.0.0.1 only, serves the page, pairs and named images, never key.json; appends votes and resumes', async () => {
  await withTemp(async dir => {
    const { ids } = await handMadeStudy(dir);
    let tick = 0;
    const { url, address, close } = await startStudyServer({ studyDir: dir, port: 0, now: () => new Date(Date.UTC(2026, 9, 5, 12, 0, tick++)) });
    try {
      assert.equal(address.address, '127.0.0.1');
      const page = await call(url);
      assert.equal(page.status, 200);
      assert.match(page.headers['content-type'], /text\/html/);
      assert.match(page.body.toString(), /几何更接近参考/);
      assert.match(page.headers['content-security-policy'], /default-src 'self'/);
      for (const file of ['app.js', 'state.js', 'style.css']) assert.equal((await call(url + file)).status, 200, file);
      assert.deepEqual(JSON.parse((await call(url + 'pairs.json')).body).pairs.map(pair => pair.id), ids);
      const image = await call(url + 'images/' + imageName(ids[0], 'r', 'fl'));
      assert.equal(image.status, 200);
      assert.equal(image.headers['content-type'], 'image/png');
      assert.equal((await call(url + 'images/' + imageName(ids[0], 'a', 'fl'))).status, 404, 'named but missing on disk');
      for (const path of ['key.json', 'images/stray.png', 'images/key.json', 'images/..%2Fkey.json', 'images/../key.json', '..%2Fkey.json', 'votes.jsonl']) {
        const response = await call(url + path);
        assert.equal(response.status, 404, path);
        assert.doesNotMatch(response.body.toString(), /secret/, path);
      }
      // No votes yet.
      assert.deepEqual(JSON.parse((await call(url + 'votes')).body).votes, []);
      const post = (payload, headers = {}) => call(url + 'vote', { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json', ...headers } });
      assert.equal((await post({ pair: ids[0], choice: 'a', ms: 4200.4, hidden_ms: 1000.2 })).status, 200);
      assert.equal((await post({ pair: ids[1], choice: 'tie', ms: 900 })).status, 200);
      assert.equal((await post({ pair: ids[0], choice: 'b', ms: 1500 })).status, 200);
      // Rejected: unknown pair, bad choice, bad time, not JSON, cross-origin, another Host.
      assert.equal((await post({ pair: 'ffffffff', choice: 'a', ms: 1 })).status, 400);
      assert.equal((await post({ pair: ids[0], choice: 'left', ms: 1 })).status, 400);
      assert.equal((await post({ pair: ids[0], choice: 'a', ms: -5 })).status, 400);
      assert.equal((await post({ pair: ids[0], choice: 'a', ms: 5, hidden_ms: 6 })).status, 400);
      assert.equal((await call(url + 'vote', { method: 'POST', body: 'pair=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 400);
      assert.equal((await post({ pair: ids[0], choice: 'a', ms: 1 }, { Origin: 'http://evil.example' })).status, 403);
      assert.equal((await call(url, { headers: { Host: 'evil.example:' + address.port } })).status, 403);
      const lines = (await readFile(join(dir, 'votes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(lines, [
        { pair: ids[0], choice: 'a', ms: 4200, hidden_ms: 1000, at: '2026-10-05T12:00:00.000Z' },
        { pair: ids[1], choice: 'tie', ms: 900, hidden_ms: null, at: '2026-10-05T12:00:01.000Z' },
        { pair: ids[0], choice: 'b', ms: 1500, hidden_ms: null, at: '2026-10-05T12:00:02.000Z' },
      ]);
      // GET /votes gives the page what it needs to resume: both pairs rated, the revision last.
      const { votes } = JSON.parse((await call(url + 'votes')).body);
      assert.deepEqual(votes, lines);
      const latest = latestChoices(votes);
      assert.equal(latest.get(ids[0]), 'b');
      assert.equal(nextUnrated([{ id: ids[0] }, { id: ids[1] }], latest), -1);
    } finally { await close(); }
    // A second server on the same directory resumes from the same file.
    const again = await startStudyServer({ studyDir: dir, port: 0 });
    try { assert.equal(JSON.parse((await call(again.url + 'votes')).body).votes.length, 3); } finally { await again.close(); }
  });
});

test('parseVotes skips torn and invalid lines and counts them', () => {
  const text = '{"pair":"p1","choice":"a","ms":5,"at":"t"}\n{"pair":"p2","choi\n{"pair":"p3","choice":"maybe"}\n\n{"pair":"p2","choice":"tie","ms":7}\n';
  const { votes, malformed } = parseVotes(text);
  assert.equal(malformed, 2);
  assert.deepEqual(votes.map(vote => [vote.pair, vote.choice]), [['p1', 'a'], ['p2', 'tie']]);
});

// ------------------------------------------------------------ analysis

test('Wilson intervals match hand-computed values', () => {
  const check = (k, n, low, high) => { const stat = wilson(k, n); near(stat.low, low); near(stat.high, high); assert.equal(stat.p, k / n); };
  check(3, 4, 0.3006, 0.9544);
  check(3, 5, 0.2307, 0.8824);
  check(2, 2, 0.3424, 1);
  check(1, 2, 0.0945, 0.9055);
  check(0, 1, 0, 0.7934);
  check(5, 10, 0.2366, 0.7634);
  check(0, 10, 0, 0.2775);
  assert.deepEqual(wilson(0, 0), { k: 0, n: 0, p: null, low: null, high: null });
});

// A hand-made key: six rated originals, one unrated, two repeats.
function handKey() {
  const side = (score, shape, detail) => ({ score, shape_score: shape, detail_score: detail, dir: 'runs/x/' + score });
  const pair = (id, stratum, a, b, extra = {}) => ({ id, stratum, gap: Math.abs(a.score - b.score), a, b, repeat_of: null, task_id: 'task-' + id, title: 'T', variant: 't2',
    higher: higherSide(a.score, b.score), higher_shape: higherSide(a.shape_score, b.shape_score), higher_detail: higherSide(a.detail_score, b.detail_score),
    images: { fl: { r: id + '-r-fl.png', a: id + '-a-fl.png', b: id + '-b-fl.png' } }, ...extra });
  const pairs = [
    pair('P1', '15-100', side(80, 90, 60), side(50, 60, 70)),          // higher a, shape a, detail b
    pair('P2', '15-100', side(40, 50, 30), side(60, 70, 50)),          // higher b, shape b, detail b
    pair('P3', '8-15', side(70, 60, 80), side(60, 70, 50)),            // higher a, shape b, detail a
    pair('P4', '8-15', side(50, 50, 60), side(59, 70, 40)),            // higher b, shape b, detail a
    pair('P5', '3-8', side(55, 60, 50), side(50, 55, 45)),             // higher a; rated tie
    pair('P6', '0-3', side(50, 60, 40), side(51, 50, 40)),             // higher b, shape a, detail equal
    pair('P7', '0-3', side(50, 50, 50), side(52, 52, 52)),             // never rated
  ];
  const swap = (original, id) => ({ ...original, id, a: original.b, b: original.a, repeat_of: original.id,
    higher: higherSide(original.b.score, original.a.score), higher_shape: higherSide(original.b.shape_score, original.a.shape_score),
    higher_detail: higherSide(original.b.detail_score, original.a.detail_score) });
  pairs.push(swap(pairs[0], 'R1'), swap(pairs[2], 'R3'));
  return { name: 'hand', created_at: '2026-10-05T00:00:00.000Z',
    strata: STRATA.map(item => ({ ...item })), pairs };
}

test('analysis on a hand-computed example: last vote wins, agreement, Wilson, strata, ties, self-consistency, disagreements', () => {
  const key = handKey();
  const votes = [
    { pair: 'P1', choice: 'a', ms: 1000, hidden_ms: 1000 }, { pair: 'P2', choice: 'b', ms: 2000 },
    { pair: 'P3', choice: 'b', ms: 3000 }, { pair: 'P3', choice: 'a', ms: 500 },     // revision: a counts
    { pair: 'P4', choice: 'a', ms: 4000 }, { pair: 'P5', choice: 'tie', ms: 5000 }, { pair: 'P6', choice: 'a', ms: 6000 },
    { pair: 'R1', choice: 'b', ms: 7000 }, { pair: 'R3', choice: 'tie', ms: 8000 }, { pair: 'zzz', choice: 'a', ms: 9000 },
  ];
  const analysis = analyzeStudy({ key, votes, malformed: 1 });
  assert.deepEqual(analysis.votes, { lines: 11, valid_lines: 10, malformed_lines: 1, unknown_pair_lines: 1, revisions: 1, pairs_total: 9, pairs_rated: 8,
    pairs_unrated: 1, originals_total: 7, originals_rated: 6, ties: 1, median_ms: 4500, median_visible_ms: 4500 });
  // Visible time: P1 drops to 0, which is still below the median pair.
  assert.equal(analyzeStudy({ key, votes: votes.map(vote => vote.pair === 'P6' ? { ...vote, hidden_ms: 6000 } : vote) }).votes.median_visible_ms, 3000);
  const [headline, shape, detail] = analysis.agreement;
  // Decided originals: P1 agree, P2 agree, P3 agree (after the revision), P4 disagree, P6 disagree.
  assert.deepEqual([headline.overall.k, headline.overall.n, headline.overall.no_higher_side], [3, 5, 0]);
  near(headline.overall.low, 0.2307); near(headline.overall.high, 0.8824);
  assert.deepEqual(headline.strata.map(row => [row.stratum, row.k, row.n]), [['0-3', 0, 1], ['3-8', 0, 0], ['8-15', 1, 2], ['15-100', 2, 2]]);
  near(headline.strata[3].low, 0.3424); near(headline.strata[2].low, 0.0945); near(headline.strata[0].high, 0.7934);
  // shape_score: P1 a=a, P2 b=b, P3 b vs a, P4 b vs a, P6 a=a.
  assert.deepEqual([shape.overall.k, shape.overall.n], [3, 5]);
  // detail.score: P1 b vs a, P2 b=b, P3 a=a, P4 a=a; P6 equal (no higher side).
  assert.deepEqual([detail.overall.k, detail.overall.n, detail.overall.no_higher_side], [3, 4, 1]);
  near(detail.overall.low, 0.3006); near(detail.overall.high, 0.9544);
  // The curve and tie rates.
  assert.deepEqual(analysis.curve.map(row => [row.stratum, row.pairs, row.rated, row.ties, row.agreement.k, row.agreement.n]),
    [['0-3', 2, 1, 0, 0, 1], ['3-8', 1, 1, 1, 0, 0], ['8-15', 2, 2, 0, 1, 2], ['15-100', 2, 2, 0, 2, 2]]);
  assert.equal(analysis.curve[1].tie_rate.p, 1);
  assert.equal(analysis.curve[3].mean_gap, 25);
  // Side habit: A chosen in P1, P3, P4, P6 of five decided originals.
  assert.deepEqual([analysis.side_preference_a.k, analysis.side_preference_a.n], [4, 5]);
  // Self-consistency: P1 a then R1 b (swapped) is the same choice; P3 a then R3 tie is one tie.
  const c = analysis.self_consistency;
  assert.deepEqual([c.repeats, c.both_rated, c.same, c.opposite, c.both_tie, c.one_tie], [2, 2, 1, 0, 0, 1]);
  assert.deepEqual([c.same_share_of_decided.k, c.same_share_of_decided.n, c.exact_share.k, c.exact_share.n], [1, 1, 1, 2]);
  // Largest disagreements: P4 (gap 9) before P6 (gap 1).
  assert.deepEqual(analysis.largest_disagreements.map(row => [row.pair, row.gap, row.delta_a_minus_b, row.choice]), [['P4', 9, -9, 'a'], ['P6', 1, -1, 'a']]);
  assert.deepEqual(analysis.largest_disagreements[0].images, key.pairs[3].images);
  // Before the revision P3 was a disagreement: the first vote does not count.
  const firstOnly = analyzeStudy({ key, votes: votes.filter((_, i) => i !== 3) });
  assert.deepEqual([firstOnly.agreement[0].overall.k, firstOnly.agreement[0].overall.n], [2, 5]);
});

test('analyze writes analysis.md and analysis.json from votes.jsonl and key.json', async () => {
  await withTemp(async dir => {
    await writeFile(join(dir, 'key.json'), JSON.stringify(handKey()));
    await writeFile(join(dir, 'votes.jsonl'), ['P1 a', 'P2 b', 'P4 a'].map(text => JSON.stringify({ pair: text.split(' ')[0], choice: text.split(' ')[1], ms: 10, at: 't' })).join('\n') + '\nnot json\n');
    const { analysis, files } = await writeAnalysis(dir);
    assert.equal(analysis.votes.malformed_lines, 1);
    assert.deepEqual([analysis.agreement[0].overall.k, analysis.agreement[0].overall.n], [2, 3]);
    const saved = JSON.parse(await readFile(join(dir, 'analysis.json'), 'utf8'));
    assert.deepEqual(saved.agreement[0].overall, analysis.agreement[0].overall);
    const markdown = await readFile(files[0], 'utf8');
    assert.match(markdown, /\| headline score \| 2 \/ 3 \| 66\.7% \[/);
    assert.match(markdown, /P\(rater picks the higher-scored\) against \|Δ\|/);
    assert.match(markdown, /\| P4 \| -9\.00 \| 50\.00 \| 59\.00 \| A \|/);
  });
});
