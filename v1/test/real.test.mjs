import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodePNG } from '../lib/png.mjs';
import { layout } from '../lib/contract.mjs';
import { verifyTasks, truthGLB } from '../lib/pack.mjs';
import { soupFromModel } from '../lib/soup.mjs';
import { projectPoint, render } from '../lib/raster.mjs';
import { scaleCameraTo } from '../lib/score/coverage.mjs';
import { scoreSubmission, loadContext } from '../lib/score/index.mjs';
import { probeCheck, zFightReport, viewCamera, STANDARD_VIEWS } from '../lib/generator/checks.mjs';
import { buildRealObject, loadAuthoring, checkNotes, forbiddenHits, coverageSummary, cropImage, cloneMask } from '../lib/real/build.mjs';
import { solveRegistration, verifySheet, toSheet, findLine } from '../lib/real/verify.mjs';
import { cameraFromPose, resect } from '../lib/real/resect.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureUrl = pathToFileURL(join(here, '..', 'fixtures', 'sample-model.mjs')).href;
const near = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' is not within ' + tolerance + ' of ' + expected);
const exists = path => access(path).then(() => true, () => false);

// A tiny authoring directory: the fixture house under a private id that names
// "the operator", two street photographs and an aerial (blank PNGs at their
// cameras' size: their pixels are never read, only their cameras), and notes.
async function fixtureAuthoring(dir, { description = 'Street-level photograph of the front', notes, photoWidth = 320 } = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'model.mjs'), `import { sampleModel } from ${JSON.stringify(fixtureUrl)};
export default () => ({ ...sampleModel(), id: 'acme-burger-elm-street', archetype: 'real', meta: { truth_uncertainty_m: 0.1 } });
`);
  await writeFile(join(dir, 'evidence.mjs'), `
export const OBJECT_ID = 'real-test';
export const NOTES_CAPTURED_AT = '2026-07';
export const FORBIDDEN = ['acme', 'elm street'];
export const PHOTOS = [
  { id: 'photo-1', kind: 'photo', file: 'photo-1.png', captured_at: '2022-06', description: ${JSON.stringify(description)},
    camera: { position: [1.5, 1.6, 16], heading_deg: 0, pitch_deg: 8, roll_deg: 0, fov_y_deg: 45, width: ${photoWidth}, height: 240 }, occluders: [] },
  { id: 'photo-2', kind: 'photo', file: 'photo-2.png', captured_at: '2026-07', description: 'Street-level photograph from the front-right',
    camera: { position: [14, 1.6, 9], heading_deg: 312, pitch_deg: 8, roll_deg: 0, fov_y_deg: 50, width: 320, height: 240 },
    occluders: [{ type: 'box', center: [9, 0.75, 6], size: [4.5, 1.5, 1.8] }] },
  { id: 'aerial', kind: 'aerial', file: 'aerial.png', captured_at: '2026-07', description: 'Near-vertical aerial image',
    camera: { type: 'ortho', origin: [0, 60, -3.5], right: [1, 0, 0], up: [0, 0, -1], forward: [0, -1, 0], extent: [-8, 8, -8, 8], width: 256, height: 256 }, occluders: [] },
];
`);
  await writeFile(join(dir, 'notes.md'), notes ?? '# Site survey notes\n\n| Measurement | Value |\n| --- | --- |\n| Overall width | 9.00 m |\n| Overall depth | 7.00 m |\n\n' +
    'Values in metres are rounded to the nearest 10 mm.\n\nEaves height measured 5400 mm.\n');
  const sources = join(dir, 'sources');
  await mkdir(sources, { recursive: true });
  const blank = (w, h) => encodePNG(w, h, new Uint8Array(w * h * 3).fill(128), 3);
  await writeFile(join(sources, 'photo-1.png'), blank(320, 240));
  await writeFile(join(sources, 'photo-2.png'), blank(320, 240));
  await writeFile(join(sources, 'aerial.png'), blank(256, 256));
  return { source: dir, sourcesRoot: sources };
}

test('a real object builds into r2 and r4 packs that verify, score the truth at 100 and leak nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e3d-real-'));
  try {
    const { source, sourcesRoot } = await fixtureAuthoring(join(root, 'authoring'));
    const dataRoot = join(root, 'data'), paths = layout(dataRoot);
    const built = await buildRealObject({ source, sourcesRoot, dataRoot, set: 'real-test-set' });
    assert.equal(built.object, 'real-test');
    assert.deepEqual(built.tasks.map(t => t.task), ['real-test-r2', 'real-test-r4']);
    assert.deepEqual(built.items, ['photo-1', 'photo-2', 'aerial', 'notes']);

    // node v1/cli.mjs verify: hashes, and the private model id is not in any pack.
    const verified = await verifyTasks(dataRoot);
    assert.deepEqual(verified.map(v => [v.task, v.inputs, v.set]), [['real-test-r2', 3, 'real-test-set'], ['real-test-r4', 4, 'real-test-set']]);

    const r2 = JSON.parse(await readFile(join(paths.task('real-test-r2'), 'task.json'), 'utf8'));
    const r4 = JSON.parse(await readFile(join(paths.task('real-test-r4'), 'task.json'), 'utf8'));
    assert.equal(r2.scale_evidence, 'none');
    assert.equal(r4.scale_evidence, 'metric');
    assert.ok(!r2.inputs.some(i => i.kind === 'notes'));
    assert.deepEqual(r4.inputs.filter(i => i.kind === 'notes').map(i => i.path), ['inputs/04-notes.md']);
    assert.match(r2.prompt, /photographs are real/);
    assert.match(r2.prompt, /2026-07/);            // target state: the newest photograph
    assert.match(r2.prompt, /up to one uniform scale factor/);
    assert.match(r4.prompt, /fixes absolute size/);

    // Nothing a contestant receives names the operator, the street or the private id.
    for (const id of ['real-test-r2', 'real-test-r4']) {
      const texts = [await readFile(join(paths.task(id), 'task.json'), 'utf8')];
      for (const name of await readdir(join(paths.task(id), 'inputs'))) if (name.endsWith('.md')) texts.push(await readFile(join(paths.task(id), 'inputs', name), 'utf8'));
      const all = texts.join('\n');
      assert.deepEqual(forbiddenHits(all, ['acme', 'elm street', 'acme-burger-elm-street']), []);
    }
    const truth = JSON.parse(await readFile(join(paths.truth('real-test-r4'), 'truth.json'), 'utf8'));
    assert.deepEqual(truth.evidence, ['photo-1', 'photo-2', 'aerial', 'notes']);
    const model = JSON.parse(await readFile(join(paths.object('real-test'), 'model.json'), 'utf8'));
    assert.equal(model.id, 'acme-burger-elm-street');   // private files keep it

    // The truth scores ~100 on both variants.
    const glb = await truthGLB(dataRoot, 'real-test-r2');
    for (const id of ['real-test-r2', 'real-test-r4']) {
      const report = await scoreSubmission({ glb, taskDir: paths.task(id), truthDir: paths.truth(id), dataRoot });
      assert.equal(report.valid, true, report.error);
      assert.ok(report.score >= 99, id + ' truth scored ' + report.score);
      assert.equal(report.alignment.scale_locked, id.endsWith('r4'));
    }

    // Coverage: both photographs are from the front, so the rear is unseen; the aerial covers the roof.
    // (Not exactly zero: the scorer's coverage test takes |cos| and a depth tolerance,
    // so a back-facing strip a pixel wide along the silhouette corners counts.)
    const coverage = coverageSummary(await loadContext({ taskDir: paths.task('real-test-r2'), truthDir: paths.truth('real-test-r2'), dataRoot }));
    assert.ok(coverage.by_elevation.rear.fraction < 0.05, 'rear coverage ' + coverage.by_elevation.rear.fraction);
    assert.ok(coverage.by_facing.roof.fraction > 0.9, 'roof coverage ' + coverage.by_facing.roof.fraction);
    assert.ok(coverage.by_elevation.front.fraction > 0.5, 'front coverage ' + coverage.by_elevation.front.fraction);
    assert.deepEqual(coverage.by_item.map(i => i.id), ['photo-1', 'photo-2', 'aerial']);

    // Objects are immutable: a second build is refused and leaves the first intact.
    await assert.rejects(buildRealObject({ source, sourcesRoot, dataRoot }), /already exists/);
    assert.ok(await exists(join(paths.object('real-test'), 'model.glb')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a build refuses public text that names the building, notes that contradict the truth, and photographs of the wrong size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e3d-real-'));
  try {
    const dataRoot = join(root, 'data');
    const named = await fixtureAuthoring(join(root, 'a'), { description: 'Photograph of the ACME restaurant' });
    await assert.rejects(buildRealObject({ ...named, dataRoot }), /names acme/);
    const wrongNotes = await fixtureAuthoring(join(root, 'b'), { notes: '| Overall width | 9.40 m |\n' });
    await assert.rejects(buildRealObject({ ...wrongNotes, dataRoot }), /9\.40 m matches no named dimension/);
    const wrongSize = await fixtureAuthoring(join(root, 'c'), { photoWidth: 640 });
    await assert.rejects(buildRealObject({ ...wrongSize, dataRoot }), /photo-1 is 320x240 but its camera is 640x240/);
    // A failed build leaves nothing behind that could pass for an object or a task.
    assert.equal(await exists(join(dataRoot, 'objects', 'real-test')), false);
    assert.equal(await exists(join(dataRoot, 'tasks', 'real-test-r2')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an authoring directory must declare its forbidden words', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e3d-real-'));
  try {
    const { source } = await fixtureAuthoring(join(root, 'a'));
    const text = await readFile(join(source, 'evidence.mjs'), 'utf8');
    await writeFile(join(source, 'evidence.mjs'), text.replace("export const FORBIDDEN = ['acme', 'elm street'];", ''));
    await assert.rejects(loadAuthoring(source), /must export FORBIDDEN/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('notes are checked against the named dimensions and public text against forbidden words', () => {
  const model = { dimensions: [{ value_m: 49.5173 }, { value_m: 2.7432 }] };
  assert.deepEqual(checkNotes('| Overall length | 49.52 m |\nCanopy underside measured 2743 mm.\nRounded to the nearest 10 mm.', model), []);
  assert.deepEqual(checkNotes('| Overall length | 49.60 m |', model), ['49.60 m matches no named dimension', 'the notes state no named dimension']);
  assert.deepEqual(checkNotes('Nothing measured.', model), ['the notes state no named dimension']);
  assert.deepEqual(forbiddenHits('A drive-through on Elm Street', ['acme', 'elm street']), ['elm street']);
  assert.deepEqual(forbiddenHits('Single-storey restaurant with a taller glazed front block', ['acme', 'elm street']), []);
});

test('photograph preparation crops and paints labels over with a nearby patch', () => {
  const w = 6, h = 4, pixels = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) pixels.set([i, 100, 200, 255], i * 4);
  const cropped = cropImage({ width: w, height: h, channels: 4, pixels }, { x: 1, y: 1, width: 4, height: 2 });
  assert.deepEqual([cropped.width, cropped.height, cropped.channels], [4, 2, 3]);
  assert.deepEqual([...cropped.pixels.subarray(0, 3)], [7, 100, 200]);
  // A 20 x 20 image of value 50 with a "label" of value 200 in rows 2-9, columns 2-17.
  const image = { width: 20, height: 20, channels: 3, pixels: new Uint8Array(1200).fill(50) };
  for (let y = 2; y < 10; y++) for (let x = 2; x < 18; x++) image.pixels.fill(200, (y * 20 + x) * 3, (y * 20 + x) * 3 + 3);
  cloneMask(image, { x: 2, y: 2, width: 16, height: 8, from: [2, 11] });
  const at = (x, y) => image.pixels[(y * 20 + x) * 3];
  assert.equal(at(10, 5), 50);                         // inside: the patch
  assert.equal(at(2, 2), Math.round(200 * 0.75 + 50 * 0.25)); // corner: feathered
  assert.equal(at(1, 1), 50);                          // outside: untouched
});

test('registration recovers scale and offsets from datum and end anchors, and holds an exact scale', () => {
  const s = 18.75 / 0.3048, a = 571.5, b = 1598;
  const rowAt = v => b - s * v, colAt = u => a + s * u;
  const anchors = [{ type: 'row', v: 0, py: rowAt(0) }, { type: 'row', v: 6.2484, py: rowAt(6.2484) }, { type: 'col', u: 0, px: colAt(0) }];
  const reg = solveRegistration(anchors);
  near(reg.s, s, 1e-6); near(reg.a, a, 1e-6); near(reg.b, b, 1e-6);
  assert.deepEqual(toSheet(reg, 10, 2).map(v => Math.round(v * 1000) / 1000), [Math.round(colAt(10) * 1000) / 1000, Math.round(rowAt(2) * 1000) / 1000]);
  // Datum leaders drawn a pixel off pull a free fit; an exact printed scale is held.
  const noisy = [{ type: 'row', v: 0, py: rowAt(0) + 1 }, { type: 'row', v: 6.2484, py: rowAt(6.2484) - 1 }, { type: 'col', u: 0, px: colAt(0) }];
  assert.ok(Math.abs(solveRegistration(noisy).s - s) > 0.1);
  const held = solveRegistration([...noisy, { type: 'scale', metres: 0.3048, pixels: 18.75, exact: true }]);
  near(held.s, s, 1e-4);
  near(held.anchors[0].residual_px, -1, 0.01);
  assert.throws(() => solveRegistration([{ type: 'row', v: 0, py: 10 }, { type: 'col', u: 0, px: 5 }]), /two known dimensions/);
  assert.throws(() => solveRegistration([{ type: 'row', v: 0, py: 10 }, { type: 'row', v: 1, py: 0 }]), /row and a column/);
});

// A synthetic elevation sheet of a 10 m x 4 m box drawn at 20 px/m, with its
// right end drawn 0.25 m too far right: verify must report ~0 on the lines that
// agree and -0.25 m on the one that does not.
test('sheet verification measures the truth lines against the drawn lines', () => {
  const model = { schema: 'e3d-model-v1', id: 'box', archetype: 'real', title: 'Box', frame: { origin: 'o', front: 'f' },
    materials: { m: { color: '#888888', kind: 'wall' } }, groups: [], probes: [], dimensions: [],
    parts: [{ id: 'box', type: 'box', size: [10, 4, 6], position: [0, 2, -3], material: 'm' }] };
  const soup = soupFromModel(model), s = 20, a = 150, b = 300, W = 320, H = 340;
  const pixels = new Uint8Array(W * H * 3).fill(255);
  const ink = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) pixels.fill(0, (y * W + x) * 3, (y * W + x) * 3 + 3); };
  // Lines two pixels wide, straddling the drawn position.
  const hline = (v, u0, u1) => { const y = b - s * v; for (let x = a + s * u0; x <= a + s * u1; x++) { ink(x, y - 1); ink(x, y); } };
  const vline = (u, v0, v1) => { const x = a + s * u; for (let y = b - s * v1; y <= b - s * v0; y++) { ink(x - 1, y); ink(x, y); } };
  hline(0, -5, 5.25); hline(4, -5, 5.25); vline(-5, 0, 4); vline(5.25, 0, 4);
  const sheet = { width: W, height: H, channels: 3, pixels };
  const spec = { id: 'synthetic', view: 'front', crop: { x: 20, y: 200, width: 280, height: 120 },
    anchors: [{ type: 'row', v: 0, py: b }, { type: 'row', v: 4, py: b - 80 }, { type: 'col', u: -5, px: a - 100 }],
    lines: [
      { id: 'ground', axis: 'h', at: 0, span: [-4, 4] }, { id: 'top', axis: 'h', at: 4, span: [-4, 4] },
      { id: 'left', axis: 'v', at: -5, span: [0.5, 3.5] }, { id: 'right', axis: 'v', at: 5, span: [0.5, 3.5], search_m: 0.5 },
    ] };
  const result = verifySheet({ sheet, spec, soup });
  near(result.registration.s_px_per_m, 20, 1e-9);
  const byId = Object.fromEntries(result.residuals.map(r => [r.id, r]));
  for (const id of ['ground', 'top', 'left']) near(byId[id].residual_m, 0, 0.026);
  near(byId.right.residual_m, -0.25, 0.026);
  assert.ok(result.overlay.length > 100);
  // A line that is not drawn is reported as not found, never as a pass.
  const missing = verifySheet({ sheet, spec: { ...spec, lines: [{ id: 'mid', axis: 'h', at: 2, span: [-4, 4], search_m: 0.3 }] }, soup });
  assert.equal(missing.residuals[0].residual_m, null);
  assert.equal(missing.residuals[0].found.sheet, false);
  // findLine picks the line nearest the expected position among equals.
  const weight = (x, y) => (y === 10 || y === 20) ? 1 : 0;
  near(findLine(weight, { axis: 'h', at: 18, span: [0, 50], search: 12 }).position, 20.5, 1e-9);
});

test('resection recovers a camera from projected building points', () => {
  const truePose = { position: [15.5, 2.3, -20.4], heading_deg: 268.9, pitch_deg: -1.1, roll_deg: 0.3, fov_y_deg: 49.6, width: 1940, height: 962 };
  const camera = cameraFromPose(truePose);
  // heading 270 looks along -X (west), at the right side of the building.
  assert.ok(camera.forward[0] < -0.99);
  const model = [[3.4, 6.25, -21.6], [3.4, 6.25, -26.1], [3.4, 0, -21.6], [3.4, 0, -26.1], [3.3, 2.4, -16.1], [3.3, 2.4, -19.0], [3.3, 0.3, -16.1], [3.4, 0, -13.1]];
  const points = model.map((p, i) => ({ name: 'p' + i, model: p, image: projectPoint(camera, p).slice(0, 2) }));
  const fit = resect({ points, width: 1940, height: 962, start: { position: [20, 1.6, -18], heading_deg: 255, pitch_deg: 0, roll_deg: 0, fov_y_deg: 40 } });
  assert.ok(fit.rms_px < 0.5, 'rms ' + fit.rms_px);
  for (let i = 0; i < 3; i++) near(fit.pose.position[i], truePose.position[i], 0.05);
  near(fit.pose.heading_deg, truePose.heading_deg, 0.1);
  near(fit.pose.fov_y_deg, truePose.fov_y_deg, 0.1);
  // With the lens held, the field of view stays put.
  const held = resect({ points, width: 1940, height: 962, fixed: ['fov_y_deg'], start: { position: [20, 1.6, -18], heading_deg: 255, fov_y_deg: 49.6 } });
  assert.equal(held.pose.fov_y_deg, 49.6);
  assert.throws(() => resect({ points: points.slice(0, 3), width: 10, height: 10, start: truePose }), /four points/);
});

// The authored object itself (no reference pack needed).
test('the authored truth is a valid, robustly probed, z-fight-free model whose public text is neutral', async () => {
  const source = join(here, '..', 'real', 'mcd-homestead');
  const authoring = await loadAuthoring(source), model = authoring.model, soup = soupFromModel(model);
  assert.equal(model.meta.truth_uncertainty_m, 0.15);
  // Frame: front wall at z = 0 centred on x = 0, ground at y = 0, building towards -Z.
  near(soup.bounds.min[1], 0, 1e-6);
  near(soup.bounds.max[1], 6.2484, 1e-3);                     // +20'-6"
  near(soup.bounds.min[2], -49.517 - 0.031, 0.01);            // rear fins stand 30 mm behind the 162'-5 1/2" wall
  for (const probe of model.probes) {
    const check = probeCheck(soup, probe, { radius: 0.12 });
    assert.ok(check.ok, probe.id + ': ' + check.reason);
  }
  const dims = Object.fromEntries(model.dimensions.map(d => [d.id, d.value_m]));
  near(dims['main-parapet-height'], 18 * 0.3048 + 10 * 0.0254, 1e-4);
  near(dims['front-block-height'], 20 * 0.3048 + 6 * 0.0254, 1e-4);
  for (const [name, az, el] of STANDARD_VIEWS) {
    const report = zFightReport(soup, viewCamera(soup.bounds, az, el, { width: 480 }));
    assert.ok(report.fraction < 0.0005, name + ' z-fights on ' + (report.fraction * 100).toFixed(3) + '% ' + JSON.stringify(report.pairs));
  }
  assert.deepEqual(checkNotes(authoring.notes, model), []);
  for (const word of ['homestead', 'playplace', '3509']) assert.ok(authoring.forbidden.includes(word), word + ' is not forbidden');
  const publicText = [model.title, model.scope_note, model.frame.origin, model.frame.front, authoring.objectId, ...authoring.photos.flatMap(p => [p.id, p.description, p.file]), authoring.notes].join('\n');
  assert.deepEqual(forbiddenHits(publicText, authoring.forbidden), []);
  // Excluded things are absent from the truth.
  for (const word of ['sign', 'pylon', 'menu', 'bollard', 'rtu', 'hvac', 'letter', 'logo']) assert.ok(!model.parts.some(p => p.id.includes(word) && !p.id.includes('design')), 'part named ' + word);
  // Every photograph has a camera that sees some of the building.
  for (const photo of authoring.photos) {
    const camera = scaleCameraTo(photo.camera.type ? photo.camera : cameraFromPose(photo.camera), 160);
    const image = render(soup, camera), hits = image.tri.reduce((n, t) => n + (t >= 0), 0);
    assert.ok(hits > 0.05 * camera.width * camera.height, photo.id + ' shows the building on ' + hits + ' pixels only');
  }
});

// The real overlays need the owner's reference pack (outside the repository).
const PACK = '/Users/olddonkey/Documents/img2threejs/forge-artifacts/reference/mcdonalds-3509-homestead-santa-clara-2026-07-30/planning-and-dimensions/key-sheets';
test('the authored truth agrees with the drawing sheets', { skip: !existsSync(PACK) && 'reference pack not on this machine' }, async () => {
  const { verifySheets } = await import('../lib/real/verify.mjs');
  const authoring = await loadAuthoring(join(here, '..', 'real', 'mcd-homestead'));
  const out = await mkdtemp(join(tmpdir(), 'e3d-real-verify-'));
  try {
    const result = await verifySheets({ model: authoring.model, sheets: authoring.sheets, sheetsRoot: PACK, outDir: out });
    assert.deepEqual(result.summary.not_found, []);
    // Lines where the truth follows another sheet on purpose (see PROVENANCE.md).
    const declared = new Set(['a2-0-rear/booth-top', 'a1-0b-plan/canopy-right-block-end']);
    for (const sheet of result.sheets) {
      for (const anchor of sheet.registration.anchors) assert.ok(Math.abs(anchor.residual_px) <= 3.5, sheet.id + ' anchor ' + anchor.note + ' ' + anchor.residual_px);
      for (const r of sheet.residuals) if (!declared.has(sheet.id + '/' + r.id)) assert.ok(Math.abs(r.residual_m) <= 0.2, sheet.id + '/' + r.id + ' ' + r.residual_m);
    }
  } finally { await rm(out, { recursive: true, force: true }); }
});
