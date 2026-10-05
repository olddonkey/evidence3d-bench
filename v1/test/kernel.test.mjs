import test from 'node:test';
import assert from 'node:assert/strict';
import { rng } from '../lib/rng.mjs';
import { encodePNG, decodePNG } from '../lib/png.mjs';
import { validateModel, modelToGLB } from '../lib/model.mjs';
import { soupFromModel, soupFromGLB, transformSoup, transformPoint, filterSoup, soupFromOccluders, mergeSoups } from '../lib/soup.mjs';
import { orthoCamera, perspectiveCamera, orthoViewOfBounds, projectPoint, unproject, render, raycast } from '../lib/raster.mjs';
import { validateTask, VARIANTS, STANDARD_ITEMS, EVIDENCE_KINDS } from '../lib/contract.mjs';
import { sampleModel } from '../fixtures/sample-model.mjs';

const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' is not within ' + tolerance + ' of ' + expected);
const cube = size => soupFromModel({ ...sampleModel(), groups: [], probes: [], dimensions: [],
  parts: [{ id: 'cube', type: 'box', size: [size, size, size], position: [0, 0, 0], material: 'render' }] });

test('seeded streams repeat and forks are independent of draw order', () => {
  const a = rng(42), b = rng(42);
  assert.deepEqual([a.next(), a.next(), a.int(1, 6)], [b.next(), b.next(), b.int(1, 6)]);
  assert.notEqual(rng(42).next(), rng(43).next());
  const first = rng('object-1'); first.next();
  assert.equal(first.fork('camera').next(), rng('object-1').fork('camera').next());
});

test('PNG encoding survives a decode round trip', () => {
  const pixels = Uint8Array.from({ length: 5 * 3 * 4 }, (_, i) => (i * 37) & 255);
  const decoded = decodePNG(encodePNG(5, 3, pixels, 4));
  assert.deepEqual([decoded.width, decoded.height, decoded.channels], [5, 3, 4]);
  assert.deepEqual([...decoded.pixels], [...pixels]);
});

test('the fixture model validates and its GLB carries the same geometry', async () => {
  const model = validateModel(sampleModel()), direct = soupFromModel(model);
  const loaded = await soupFromGLB(modelToGLB(model));
  assert.equal(loaded.triangles, direct.triangles);
  for (const key of ['min', 'max']) for (let i = 0; i < 3; i++) near(loaded.bounds[key][i], direct.bounds[key][i], 1e-4);
  near(direct.bounds.min[0], -4.9); near(direct.bounds.max[1], 8.8);
  // Solid base colours survive the GLB (linear values, so not equal to the hex bytes).
  const wall = loaded.colors.subarray(0, 3);
  assert.ok(wall[0] > 0.6 && wall[0] < 0.75, 'unexpected wall colour ' + [...wall]);
});

test('model validation rejects dangling references and bad geometry', () => {
  const broken = edit => { const model = sampleModel(); edit(model); return () => validateModel(model); };
  assert.throws(broken(m => { m.parts[0].material = 'missing'; }), /unknown material/);
  assert.throws(broken(m => { m.parts[0].group = 'missing'; }), /unknown group/);
  assert.throws(broken(m => { m.parts.push({ ...m.parts[1] }); }), /duplicate part/);
  assert.throws(broken(m => { m.parts[1].size = [1, -1, 1]; }), /positive size/);
  assert.throws(broken(m => { m.groups.push({ id: 'empty', title: 'x', category: 'x', detail_size_m: 1, facade: 'front' }); }), /has no parts/);
});

test('orthographic render covers exactly the projected square at the right depth', () => {
  const camera = orthoCamera({ origin: [0, 0, 0], right: [1, 0, 0], up: [0, 1, 0], extent: [-2, 2, -2, 2], width: 64, height: 64 });
  const image = render(cube(2), camera);
  let covered = 0;
  for (let i = 0; i < image.depth.length; i++) if (image.tri[i] >= 0) { covered++; near(image.depth[i], -1, 1e-6); }
  assert.equal(covered, 32 * 32);
  assert.equal(image.tri[0], -1);
});

test('perspective projection matches the pinhole model and round-trips', () => {
  const camera = perspectiveCamera({ position: [0, 0, 10], target: [0, 0, 0], fov_y_deg: 90, width: 64, height: 64 });
  for (let i = 0; i < 3; i++) near(camera.right[i], [1, 0, 0][i]);
  const [x, y, depth] = projectPoint(camera, [1, 1, 0]);
  near(x, 35.2); near(y, 28.8); near(depth, 10);
  const back = unproject(camera, x, y, depth);
  for (let i = 0; i < 3; i++) near(back[i], [1, 1, 0][i], 1e-9);
  const image = render(cube(2), camera);
  near(image.depth[32 * 64 + 32], 9, 1e-4);
  const ortho = orthoViewOfBounds({ min: [-1, 0, -3], max: [1, 2, 0] }, 'right', { width: 100 });
  const p = [0.4, 1.3, -2.2], q = unproject(ortho, ...projectPoint(ortho, p));
  for (let i = 0; i < 3; i++) near(q[i], p[i], 1e-9);
});

test('triangles crossing the camera plane are clipped, not smeared', () => {
  const ground = { ...cube(1), triangles: 1, triPart: new Int32Array(1), colors: new Float32Array(3),
    positions: Float64Array.from([-50, 0, -50, 50, 0, -50, 0, 0, 50]) };
  const camera = perspectiveCamera({ position: [0, 1.6, 0], forward: [0, -0.2, -1], fov_y_deg: 60, width: 48, height: 48 });
  const image = render(ground, camera);
  let hits = 0;
  for (let i = 0; i < image.depth.length; i++) if (image.tri[i] >= 0) { hits++; assert.ok(image.depth[i] >= camera.near && Number.isFinite(image.depth[i])); }
  assert.ok(hits > 0 && hits < 48 * 48, 'ground should fill only the lower part of the frame');
  assert.equal(image.tri[0], -1);
});

test('named views put the viewer where their name says', () => {
  const soup = soupFromModel(sampleModel());
  // The chimney sits right of centre and behind the ridge; the door is in front.
  const front = orthoViewOfBounds(soup.bounds, 'front', { width: 200 }), top = orthoViewOfBounds(soup.bounds, 'top', { width: 200 });
  assert.ok(projectPoint(front, [2.6, 8, -4.2])[0] > front.width / 2, 'chimney should be right of centre in the front view');
  assert.ok(projectPoint(top, [0, 0, 0.5])[1] > projectPoint(top, [0, 0, -6])[1], 'front should be at the bottom of the plan');
  const right = orthoViewOfBounds(soup.bounds, 'right', { width: 200 });
  assert.ok(projectPoint(right, [4.5, 1, 0])[0] < projectPoint(right, [4.5, 1, -7])[0], 'front should be on the left of the right-side view');
});

test('ray casts measure the fixture where its probes expect', () => {
  const model = sampleModel(), soup = soupFromModel(model);
  const probe = id => { const p = model.probes.find(item => item.id === id); return raycast(soup, p.origin, p.direction); };
  near(40 - probe('ridge-height').distance, 8.23, 1e-3);
  near(probe('left-wall').distance, 40 - 4.5, 1e-6);
  near(probe('rear-wall').distance, 33, 1e-6);
  assert.equal(raycast(soup, [100, 100, 100], [0, 1, 0]), null);
  assert.equal(soup.parts[soup.triPart[probe('canopy-top').tri]], 'canopy');
});

test('the scorer transform rotates about +Y, then scales, then translates', () => {
  const moved = transformPoint([1, 2, 0], { yaw: Math.PI / 2, scale: 2, translation: [10, 0, 0] });
  near(moved[0], 10); near(moved[1], 4); near(moved[2], -2);
  const soup = cube(2), spun = transformSoup(soup, { yaw: Math.PI / 4, scale: 1.5, translation: [0, 3, 0] });
  near(spun.bounds.max[1], 4.5); near(spun.bounds.max[0], 1.5 * Math.SQRT2, 1e-9);
  assert.equal(spun.triangles, soup.triangles);
});

test('soups can be filtered by part and merged with occluders', () => {
  const soup = soupFromModel(sampleModel()), roof = filterSoup(soup, id => id === 'roof');
  assert.ok(roof.triangles > 0 && roof.triangles < soup.triangles);
  near(roof.bounds.max[1], 8.23, 1e-3);
  const trees = soupFromOccluders([{ type: 'ellipsoid', center: [0, 3, 6], radii: [1.5, 2, 1.5] }, { type: 'box', center: [3, 1, 5], size: [4, 2, 2] }]);
  const merged = mergeSoups([soup, trees]);
  assert.equal(merged.triangles, soup.triangles + trees.triangles);
  assert.equal(merged.triSource[soup.triangles], 1);
  assert.equal(soupFromOccluders([]).triangles, 0);
});

test('variants only reference standard evidence items; task contract is enforced', () => {
  for (const variant of Object.values(VARIANTS)) {
    // A variant names standard items, or (real objects) evidence kinds.
    assert.ok(Array.isArray(variant.items) !== Array.isArray(variant.kinds), variant.title);
    for (const item of [...(variant.items ?? []), ...(variant.stale ?? [])]) assert.ok(STANDARD_ITEMS.includes(item), item);
    for (const kind of variant.kinds ?? []) assert.ok(EVIDENCE_KINDS.includes(kind), kind);
  }
  const task = { schema: 'e3d-task-v1', id: 'obj-1-t1', title: 'House', prompt: 'Rebuild it', target_state: 'As photographed in 2025-09', variant: 't1',
    frame: { unit: 'metre', up: '+Y', origin: 'x', front: 'y' }, scale_evidence: 'none',
    inputs: [{ id: 'source-1', path: 'inputs/01-photo-front.jpg', sha256: 'a'.repeat(64), bytes: 10, kind: 'photo' }],
    budget: { wall_seconds: 1800, max_artifact_bytes: 1024, max_triangles: 10 } };
  assert.equal(validateTask(task), task);
  assert.throws(() => validateTask({ ...task, inputs: [{ ...task.inputs[0], path: '../truth/model.glb' }] }), /input path/);
});
