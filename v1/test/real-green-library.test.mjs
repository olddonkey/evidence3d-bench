// The second real-building object (public id real-0002): its authored truth,
// its evidence list and cameras, a build of its r2 / r4 packs with stand-in
// photographs, and - when the owner's reference pack is on the machine - the
// overlays of the truth on the survey sheets. See v1/real/green-library/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePNG } from '../lib/png.mjs';
import { layout } from '../lib/contract.mjs';
import { verifyTasks } from '../lib/pack.mjs';
import { soupFromModel } from '../lib/soup.mjs';
import { render, projectPoint } from '../lib/raster.mjs';
import { scaleCameraTo } from '../lib/score/coverage.mjs';
import { loadContext } from '../lib/score/index.mjs';
import { probeCheck, zFightReport, viewCamera, STANDARD_VIEWS } from '../lib/generator/checks.mjs';
import { buildRealObject, loadAuthoring, checkNotes, forbiddenHits, coverageSummary } from '../lib/real/build.mjs';
import { cameraFromPose } from '../lib/real/resect.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, '..', 'real', 'green-library');
const FT = 0.3048;
const near = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' is not within ' + tolerance + ' of ' + expected);
const cameraOf = photo => photo.camera.type ? photo.camera : cameraFromPose(photo.camera);

test('the authored truth is valid, framed as stated, robustly probed and z-fight-free', async () => {
  const { model } = await loadAuthoring(SOURCE), soup = soupFromModel(model);
  assert.equal(model.id, 'green-library');
  assert.equal(model.meta.truth_uncertainty_m, 0.2);
  // Ground at y = 0; the front (steps, buttresses, eaves) towards +Z; symmetric about x = 0.
  near(soup.bounds.min[1], 0, 1e-6);
  near(soup.bounds.max[1], 83.9 * FT, 0.01);                   // central block ridge
  near(soup.bounds.max[2], 12.6 * FT, 0.01);                   // foot of the entrance steps
  near(soup.bounds.min[2], -235.6 * FT, 0.01);                 // rear eave of the corner blocks
  near(soup.bounds.min[0], -soup.bounds.max[0], 1e-3);           // symmetric (part positions are kept to 0.1 mm)
  near(soup.bounds.max[0], 95.1 * FT, 0.01);                   // colonnade end walls
  // The printed overall dimensions (182'-0" + 30'-0" + 19'-0" = 231'-0", 45'-0" + 92'-0" + 45'-0" = 182'-0").
  const dims = Object.fromEntries(model.dimensions.map(d => [d.id, d.value_m]));
  near(dims['overall-length'], 231 * FT, 1e-4);
  near(dims['overall-width'], 182 * FT, 1e-4);
  near(dims['central-block-width'], 92 * FT, 1e-4);
  near(dims['central-block-projection'], 19 * FT, 1e-4);
  for (const probe of model.probes) {
    const check = probeCheck(soup, probe, { radius: 0.12 });
    assert.ok(check.ok, probe.id + ': ' + check.reason);
  }
  for (const [name, az, el] of STANDARD_VIEWS) {
    const report = zFightReport(soup, viewCamera(soup.bounds, az, el, { width: 480 }));
    assert.ok(report.fraction < 0.0005, name + ' z-fights on ' + (report.fraction * 100).toFixed(3) + '% ' + JSON.stringify(report.pairs));
  }
});

test('the great arches and their windows are round-headed, as the photographs show', async () => {
  const { model } = await loadAuthoring(SOURCE), soup = soupFromModel(model);
  // Look straight at the middle bay: the arch opening is open (the window wall is
  // 8.2 ft back) just under its crown and at half its rise beside the springing.
  const crown = 51.5 * FT, half = 23.36 / 2 * FT, spring = crown - half;
  const depthAt = (x, y) => {
    const camera = { type: 'ortho', origin: [x, y, 30], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1], extent: [-0.01, 0.01, -0.01, 0.01], width: 1, height: 1 };
    return 30 - render(soup, camera).depth[0];
  };
  near(depthAt(0, crown - 0.2), -8.2 * FT, 0.05);              // inside the arch: the window wall
  near(depthAt(0, crown + 0.2), 0, 0.05);                      // above it: the front face
  // A round arch is still nearly full width a third of the radius above the springing,
  // and closed near its jamb a little higher, where a flatter (segmental) arch through
  // the same crown would still be open.
  near(depthAt(half * 0.9, spring + half / 3), -8.2 * FT, 0.05);
  near(depthAt(half * 0.95, spring + 4.8 * FT), 0, 0.05);
});

test('the evidence list: neutral public text, cameras that see the building, an aerial looking straight down', async () => {
  const authoring = await loadAuthoring(SOURCE), { model, photos } = authoring, soup = soupFromModel(model);
  assert.equal(authoring.objectId, 'real-0002');
  assert.deepEqual(photos.map(p => p.id), ['photo-1', 'photo-2', 'photo-3', 'photo-4', 'aerial']);
  assert.deepEqual(photos.map(p => p.captured_at), ['2013-01', '2025-04', '2025-04', '2025-04', '2026-08']);
  // One epoch: nothing from the 1995 survey is evidence.
  for (const photo of photos) assert.ok(!/habs|official-docs/i.test(photo.prepared_from.file), photo.id + ' comes from ' + photo.prepared_from.file);
  for (const word of ['stanford', 'bing', 'cecil', 'habs', 'bakewell', 'hoover', 'library', 'lasuen']) assert.ok(authoring.forbidden.includes(word), word + ' is not forbidden');
  const publicText = [model.title, model.scope_note, model.frame.origin, model.frame.front, authoring.objectId, ...photos.flatMap(p => [p.id, p.description, p.file]), authoring.notes].join('\n');
  assert.deepEqual(forbiddenHits(publicText, authoring.forbidden), []);
  assert.deepEqual(checkNotes(authoring.notes, model), []);
  // The aerial's pixels are not square and its description says so.
  assert.match(photos.at(-1).description, /not square/);
  for (const photo of photos) {
    const camera = cameraOf(photo);
    if (camera.type === 'perspective') assert.ok(camera.cx > 0 && camera.cx < camera.width && camera.cy > 0 && camera.cy < camera.height, photo.id + ' principal point outside the image');
    const small = scaleCameraTo(camera, 200), image = render(soup, small), hits = image.tri.reduce((n, t) => n + (t >= 0), 0);
    assert.ok(hits > 0.05 * small.width * small.height, photo.id + ' shows the building on ' + hits + ' pixels only');
    if (photo.kind === 'photo') {
      // Taken from the plaza in front: the camera stands in front of the front face, at eye height.
      assert.ok(camera.position[2] > 9 && camera.position[1] > 1 && camera.position[1] < 2, photo.id + ' camera at ' + camera.position);
      // The front's centre (the middle arch) projects into the frame.
      const [x, y, depth] = projectPoint(camera, [0, 10, 0]);
      if (photo.id !== 'photo-4') assert.ok(depth > 0 && x > 0 && x < camera.width && y > 0 && y < camera.height, photo.id + ' misses the middle arch');
    } else {
      assert.ok(camera.forward[1] < -0.999, 'the aerial looks straight down');
    }
  }
  // The shifted-lens photograph: a level camera with its principal point below the centre.
  const shifted = cameraOf(photos[0]);
  near(shifted.forward[1], 0, 1e-9);
  near(shifted.cy, 600, 0.5);
  // Excluded things are absent from the truth.
  for (const word of ['fountain', 'tree', 'lamp', 'bench', 'plant', 'figure', 'sculpture', 'mechanical']) assert.ok(!model.parts.some(p => p.id.includes(word)), 'part named ' + word);
});

// Builds the object with stand-in photographs (blank images at their cameras'
// sizes: pixels are never read, only cameras), so the pipeline is tested without
// the real photographs, which stay outside the repository.
test('real-0002 builds into r2 and r4 packs that verify, leak nothing and show the front and the roof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e3d-real2-'));
  try {
    const { photos } = await loadAuthoring(SOURCE), sources = join(root, 'sources');
    await mkdir(sources, { recursive: true });
    for (const photo of photos) {
      const { width, height } = cameraOf(photo);
      await writeFile(join(sources, photo.file.replace(/\.jpg$/, '.png')), encodePNG(width, height, new Uint8Array(width * height * 3).fill(128), 3));
    }
    // The authoring directory as is, but pointing at the stand-in PNGs.
    const source = join(root, 'authoring');
    await mkdir(source, { recursive: true });
    for (const name of ['model.mjs', 'sheets.mjs', 'notes.md']) await writeFile(join(source, name), (await readFile(join(SOURCE, name), 'utf8')).replaceAll("'../../lib/", "'" + join(here, '..', 'lib') + '/'));
    await writeFile(join(source, 'evidence.mjs'), (await readFile(join(SOURCE, 'evidence.mjs'), 'utf8')).replaceAll("'../../lib/", "'" + join(here, '..', 'lib') + '/').replace(/file: '(photo-\d|aerial)\.jpg'/g, "file: '$1.png'"));
    const dataRoot = join(root, 'data'), paths = layout(dataRoot);
    const built = await buildRealObject({ source, sourcesRoot: sources, dataRoot, set: 'real-2026-10' });
    assert.equal(built.object, 'real-0002');
    assert.deepEqual(built.tasks.map(t => t.task), ['real-0002-r2', 'real-0002-r4']);
    const verified = await verifyTasks(dataRoot);
    assert.deepEqual(verified.map(v => [v.task, v.inputs, v.set]), [['real-0002-r2', 5, 'real-2026-10'], ['real-0002-r4', 6, 'real-2026-10']]);
    const forbidden = [...(await loadAuthoring(SOURCE)).forbidden, 'green-library'];
    for (const id of ['real-0002-r2', 'real-0002-r4']) {
      const texts = [await readFile(join(paths.task(id), 'task.json'), 'utf8')];
      for (const name of await readdir(join(paths.task(id), 'inputs'))) if (name.endsWith('.md')) texts.push(await readFile(join(paths.task(id), 'inputs', name), 'utf8'));
      assert.deepEqual(forbiddenHits(texts.join('\n'), forbidden), [], id);
    }
    const r4 = JSON.parse(await readFile(join(paths.task('real-0002-r4'), 'task.json'), 'utf8'));
    assert.equal(r4.scale_evidence, 'metric');
    assert.match(r4.prompt, /2026-08/);                      // target state: the newest input (the aerial)
    // Coverage: the roof (aerial) and the front (photographs) are evidenced; the sides and the rear are not.
    const coverage = coverageSummary(await loadContext({ taskDir: paths.task('real-0002-r2'), truthDir: paths.truth('real-0002-r2'), dataRoot }));
    assert.ok(coverage.by_facing.roof.fraction > 0.85, 'roof ' + coverage.by_facing.roof.fraction);
    assert.ok(coverage.by_elevation.front.fraction > 0.7, 'front ' + coverage.by_elevation.front.fraction);
    for (const side of ['left', 'right', 'rear']) assert.ok(coverage.by_elevation[side].fraction < 0.05, side + ' ' + coverage.by_elevation[side].fraction);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// The overlays need the owner's reference pack (outside the repository).
const SHEETS = '/Users/olddonkey/Documents/img2threejs/forge-artifacts/reference/stanford-campus-landmarks-2026-08-31/06-green-library/official-docs/habs-sheets';
test('the authored truth agrees with the survey sheets', { skip: !existsSync(SHEETS) && 'reference pack not on this machine' }, async () => {
  const { verifySheets } = await import('../lib/real/verify.mjs');
  const authoring = await loadAuthoring(SOURCE);
  const out = await mkdtemp(join(tmpdir(), 'e3d-real2-verify-'));
  try {
    const result = await verifySheets({ model: authoring.model, sheets: authoring.sheets, sheetsRoot: SHEETS, outDir: out });
    assert.deepEqual(result.summary.not_found, []);
    assert.ok(result.summary.measured >= 40, 'measured ' + result.summary.measured);
    // A pixel is about 0.1 m on these renders: half the lines within one pixel, at most
    // six beyond two pixels (eaves the sheets disagree on, PROVENANCE.md), none beyond four.
    assert.ok(result.summary.median_abs_residual_m <= 0.08, 'median ' + result.summary.median_abs_residual_m);
    const lines = result.sheets.flatMap(sheet => sheet.residuals.map(r => ({ id: sheet.id + '/' + r.id, m: Math.abs(r.residual_m) })));
    assert.ok(lines.filter(line => line.m > 0.21).length <= 6, 'beyond two pixels: ' + lines.filter(line => line.m > 0.21).map(line => line.id).join(', '));
    for (const line of lines) assert.ok(line.m <= 0.4, line.id + ' ' + line.m);
    for (const sheet of result.sheets) {
      for (const anchor of sheet.registration.anchors) assert.ok(Math.abs(anchor.residual_px) <= 2, sheet.id + ' anchor ' + anchor.note + ' ' + anchor.residual_px);
    }
  } finally { await rm(out, { recursive: true, force: true }); }
});
