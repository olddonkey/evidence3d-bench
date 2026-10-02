import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePNG } from '../lib/png.mjs';
import { modelToGLB, validateModel } from '../lib/model.mjs';
import { soupFromModel, soupFromOccluders } from '../lib/soup.mjs';
import { projectPoint, render, dot, cross } from '../lib/raster.mjs';
import { validateEvidenceItem } from '../lib/contract.mjs';
import { sampleModel } from '../fixtures/sample-model.mjs';
import {
  PHOTO_ITEMS, PHOTO_SIZE, AERIAL_SIZE, MAX_OCCLUDED_FRACTION, planPhotos, renderPhotos, renderPhotosDetailed,
  fovYFromEquivalentFocal, streetCamera, fitStreetCamera, uniquePoints, projectedBox, occluderProxies, proxyInFrame,
  jpegInfo, stripJpegMetadata, findBlender,
} from '../lib/evidence/photos.mjs';

const near = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' is not within ' + tolerance + ' of ' + expected);
const angleDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / Math.hypot(...a) / Math.hypot(...b)))) * 180 / Math.PI;
const withTemp = async run => { const dir = await mkdtemp(join(tmpdir(), 'e3d-photos-test-')); try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); } };

// A tall, thin object: the photographer has to step back and tilt up.
function towerModel() {
  return { ...sampleModel(), id: 'tower', groups: [], probes: [], dimensions: [],
    parts: [{ id: 'shaft', type: 'box', size: [6, 40, 6], position: [0, 20, -3], material: 'render' }] };
}

// Minimal JPEG byte stream: SOI, APP0, APP1, COM, SOF0 with a size, SOS, EOI.
function fakeJpeg(width, height) {
  const segment = (marker, body) => { const head = Buffer.from([0xff, marker, 0, 0]); head.writeUInt16BE(body.length + 2, 2); return Buffer.concat([head, body]); };
  const sof = Buffer.alloc(15); sof[0] = 8; sof.writeUInt16BE(height, 1); sof.writeUInt16BE(width, 3); sof[5] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    segment(0xe1, Buffer.from('NeoGeo\0\0\0T', 'latin1')), segment(0xfe, Buffer.from('rendered somewhere')), segment(0xc0, sof),
    segment(0xda, Buffer.alloc(10)), Buffer.from([1, 2, 3, 0xff, 0xd9])]);
}

test('equivalent focal lengths give phone-like fields of view', () => {
  near(fovYFromEquivalentFocal(26), 53.1, 0.2);
  near(fovYFromEquivalentFocal(50), 29.2, 0.2);
  assert.ok(fovYFromEquivalentFocal(24) > fovYFromEquivalentFocal(35));
});

test('street cameras follow the kernel convention, including roll', () => {
  for (const roll of [0, 0.02]) {
    const camera = streetCamera({ position: [3, 1.6, 20], heading: [-0.6, -0.8], pitch: 0.15, roll, fovY: 50, ...PHOTO_SIZE });
    assert.equal(camera.type, 'perspective');
    for (const key of ['right', 'up', 'forward']) near(Math.hypot(...camera[key]), 1, 1e-9);
    near(dot(camera.right, camera.up), 0, 1e-9);
    const upCrossRight = cross(camera.up, camera.right);
    for (let i = 0; i < 3; i++) near(upCrossRight[i], camera.forward[i], 1e-9);
    near(Math.asin(camera.forward[1]), 0.15, 1e-9);
    // Level horizon without roll; a tilted one with it.
    if (roll === 0) near(camera.right[1], 0, 1e-12); else assert.ok(Math.abs(camera.right[1]) > 0.01);
    assert.deepEqual([camera.cx, camera.cy, camera.width, camera.height], [800, 600, 1600, 1200]);
    near(camera.fx, camera.fy, 0);
  }
});

test('the fitted street camera frames the whole object with its margin, at the closest such distance', () => {
  const points = uniquePoints(soupFromModel(sampleModel()));
  const centre = [0, 4.4, -3];
  const options = { points, centre, azimuth: 0.7, fovY: 50, ...PHOTO_SIZE, margin: [0.1, 0.12], roll: 0.01 };
  const fitted = fitStreetCamera(options);
  const box = projectedBox(fitted.camera, points);
  assert.ok(box.x0 >= 160 - 0.5 && box.x1 <= 1440 + 0.5 && box.y0 >= 144 - 0.5 && box.y1 <= 1056 + 0.5, JSON.stringify(box));
  // Tight in at least one dimension: the margin is what the seed asked for.
  assert.ok(Math.min(box.x0 - 160, 1440 - box.x1, box.y0 - 144, 1056 - box.y1) < 3);
  near(fitted.camera.position[1], 1.6, 1e-9);
  // A tall object makes the camera step back and look up, within the pitch limit.
  const tower = uniquePoints(soupFromModel(towerModel()));
  const far = fitStreetCamera({ ...options, points: tower, centre: [0, 20, -3], azimuth: 0 });
  assert.ok(far.distance > 40 && far.pitch > 0.2 && far.pitch <= 28 * Math.PI / 180 + 1e-9, far.distance + ' m, pitch ' + far.pitch);
  assert.ok(projectedBox(far.camera, tower).y0 >= 144 - 0.5);
});

test('photo plans are deterministic and put each camera where its name says', () => {
  const model = sampleModel();
  const a = planPhotos({ model, seed: 'object-7' }), b = planPhotos({ model, seed: 'object-7' }), c = planPhotos({ model, seed: 'object-8' });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.notEqual(JSON.stringify(a), JSON.stringify(c));
  const { min, max } = soupFromModel(model).bounds;
  for (const seed of [1, 2, 3, 4, 5, 6, 'x/7', 'x/8']) {
    const plan = planPhotos({ model, seed });
    assert.deepEqual(plan.shots.map(s => s.id), PHOTO_ITEMS);
    const shot = id => plan.shots.find(s => s.id === id).camera;
    for (const id of PHOTO_ITEMS.slice(0, 4)) {
      const camera = shot(id);
      assert.deepEqual([camera.width, camera.height], [PHOTO_SIZE.width, PHOTO_SIZE.height]);
      near(camera.position[1], 1.6, 0.15);
    }
    assert.ok(angleDeg([shot('photo-front').forward[0], 0, shot('photo-front').forward[2]], [0, 0, -1]) <= 10, 'front within 10 degrees of straight on');
    assert.ok(shot('photo-front').position[2] > max[2]);
    assert.ok(shot('photo-left').position[0] < min[0] && shot('photo-left').position[2] > max[2], 'left camera sees the front and the left (-X) side');
    assert.ok(shot('photo-right').position[0] > max[0] && shot('photo-right').position[2] > max[2], 'right camera sees the front and the right (+X) side');
    const rear = shot('photo-rear'), side = plan.shots.find(s => s.id === 'photo-rear').side;
    assert.ok(rear.position[2] < min[2] && (side === 'left' ? rear.position[0] < min[0] : rear.position[0] > max[0]), 'rear camera sees the rear and the ' + side + ' side');
    const aerial = shot('aerial');
    assert.deepEqual([aerial.width, aerial.height], [AERIAL_SIZE.width, AERIAL_SIZE.height]);
    assert.ok(angleDeg(aerial.forward, [0, -1, 0]) < 12, 'aerial is near nadir');
    assert.ok(aerial.position[1] > 40);
  }
});

test('every photo frames the whole object, and occluders stay inside the hiding budget', () => {
  for (const [model, seeds] of [[sampleModel(), [1, 2, 3, 4, 5, 6, 7, 8, 'a/9', 'b/10']], [towerModel(), [1, 2]]]) {
    const soup = soupFromModel(model), points = uniquePoints(soup), { min, max } = soup.bounds;
    for (const seed of seeds) {
      const plan = planPhotos({ model, seed });
      const kinds = plan.occluders.map(o => o.kind);
      const count = kind => kinds.filter(k => k === kind).length;
      assert.ok(count('tree') >= 1 && count('tree') <= 4 && count('vehicle') <= 2 && count('pole') <= 2, kinds.join());
      for (const shot of plan.shots) {
        const box = projectedBox(shot.camera, points);
        assert.ok(box && box.x0 > 0 && box.y0 > 0 && box.x1 < shot.camera.width && box.y1 < shot.camera.height, shot.id + ' frames the object');
        // Independent re-measurement at another resolution than the planner used.
        const camera = { ...shot.camera, width: shot.camera.width / 4, height: shot.camera.height / 4, fx: shot.camera.fx / 4, fy: shot.camera.fy / 4, cx: shot.camera.cx / 4, cy: shot.camera.cy / 4 };
        const object = render(soup, camera), occluders = plan.occluders.filter(o => shot.occluders.includes(o.id));
        const hide = render(soupFromOccluders(occluders.flatMap(o => o.proxies)), camera);
        let total = 0, hidden = 0;
        for (let i = 0; i < object.depth.length; i++) if (object.tri[i] >= 0) { total++; if (hide.depth[i] < object.depth[i]) hidden++; }
        assert.ok(hidden / total <= MAX_OCCLUDED_FRACTION + 0.01, shot.id + ' hides ' + (hidden / total).toFixed(3));
        // Occluders outside the item's list must not reach the frame at all.
        for (const o of plan.occluders.filter(o => !shot.occluders.includes(o.id))) assert.ok(o.proxies.every(p => !proxyInFrame(shot.camera, p)));
      }
      for (const o of plan.occluders) {
        assert.ok(Object.entries(o.hides).some(([id, share]) => id !== 'aerial' && share > 0), o.id + ' stands between a camera and the object');
        for (const proxy of o.proxies) assert.ok(['box', 'ellipsoid', 'cylinder'].includes(proxy.type));
        assert.deepEqual(o.proxies, occluderProxies(o));
      }
    }
  }
});

test('JPEG headers are read and metadata segments are stripped losslessly', () => {
  const jpeg = fakeJpeg(1600, 1200), info = jpegInfo(jpeg);
  assert.deepEqual([info.width, info.height], [1600, 1200]);
  assert.ok(info.markers.includes(0xe1) && info.markers.includes(0xfe));
  const clean = stripJpegMetadata(jpeg), cleaned = jpegInfo(clean);
  assert.deepEqual(cleaned.markers, [0xe0, 0xc0, 0xda]);
  assert.ok(!clean.toString('latin1').includes('NeoGeo') && !clean.toString('latin1').includes('rendered'));
  assert.deepEqual(clean.subarray(clean.length - 15), jpeg.subarray(jpeg.length - 15));
  assert.throws(() => jpegInfo(Buffer.from('not a jpeg')), /Not a JPEG/);
});

// A stand-in for Blender that honours the spec contract (writes every JPEG at
// its size, then result.json), so the Node glue is tested without Blender.
const FAKE_BLENDER = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const spec = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--') + 1], 'utf8'));
const jpeg = Buffer.from(process.env.E3D_FAKE_JPEG, 'base64');
for (const shot of spec.shots) {
  fs.mkdirSync(path.dirname(shot.file), { recursive: true });
  const bytes = Buffer.from(jpeg); bytes.writeUInt16BE(shot.height, bytes.indexOf(Buffer.from([0xff, 0xc0])) + 5); bytes.writeUInt16BE(shot.width, bytes.indexOf(Buffer.from([0xff, 0xc0])) + 7);
  fs.writeFileSync(shot.file, bytes);
}
if (process.env.E3D_FAKE_FAIL) { console.error('simulated failure'); process.exit(3); }
fs.writeFileSync(spec.result, JSON.stringify({ ok: true, engine: { engine: 'fake' }, blender: 'fake', setup_seconds: 0, sky_irradiance: 1,
  shots: spec.shots.map(s => ({ id: s.id, seconds: 0, render_seconds: 0 })) }));
`;

test('renderPhotos turns the renderer output into valid, hash-locked evidence items', () => withTemp(async dir => {
  const fake = join(dir, 'fake-blender.cjs');
  await writeFile(fake, FAKE_BLENDER);
  await chmod(fake, 0o755);
  const model = sampleModel(), glbPath = join(dir, 'model.glb'), outDir = join(dir, 'evidence');
  await writeFile(glbPath, modelToGLB(model));
  process.env.E3D_FAKE_JPEG = fakeJpeg(16, 16).toString('base64');
  try {
    const items = await renderPhotos({ model, glbPath, outDir, seed: 'fake/1', blender: fake, quality: 'draft' });
    const plan = planPhotos({ model, seed: 'fake/1', capturedAt: '2025-09' });
    assert.deepEqual(items.map(item => item.id), PHOTO_ITEMS);
    for (const item of items) {
      validateEvidenceItem(item);
      const bytes = await readFile(join(outDir, item.file));
      assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(item.bytes, bytes.length);
      assert.ok(!jpegInfo(bytes).markers.includes(0xe1), 'renderer metadata is stripped before hashing');
      assert.equal(item.captured_at, '2025-09');
      assert.equal(item.metric, false);
      assert.equal(item.source_model, 'primary');
      assert.equal(item.kind, item.id === 'aerial' ? 'aerial' : 'photo');
      assert.deepEqual(item.camera, plan.shots.find(s => s.id === item.id).camera);
      for (const occluder of item.occluders) assert.ok(['box', 'ellipsoid', 'cylinder'].includes(occluder.type) && typeof occluder.source === 'string');
    }
    assert.match(items.find(i => i.id === 'photo-rear').description, /rear and the (left|right) side/);
    // The seed is all that matters: a second run gives the same cameras and occluders.
    const again = await renderPhotos({ model, glbPath, outDir: join(dir, 'again'), seed: 'fake/1', blender: fake, quality: 'draft' });
    assert.deepEqual(again.map(i => [i.camera, i.occluders]), items.map(i => [i.camera, i.occluders]));
    process.env.E3D_FAKE_FAIL = '1';
    await assert.rejects(renderPhotos({ model, glbPath, outDir: join(dir, 'fail'), seed: 'fake/1', blender: fake }), /failed \(exit 3\)[\s\S]*simulated failure/);
  } finally {
    delete process.env.E3D_FAKE_JPEG; delete process.env.E3D_FAKE_FAIL;
  }
  await assert.rejects(renderPhotos({ model, glbPath, outDir, seed: 1, blender: fake, quality: 'best' }), /quality/);
  await assert.rejects(renderPhotos({ model, glbPath: join(dir, 'missing.glb'), outDir, seed: 1, blender: fake }), /GLB not found/);
}));

// ---------------------------------------------------------------------------
// Integration: the real renderer. The Blender masks share the evidence camera,
// so they must agree with the kernel's own silhouette of the model, and every
// rendered occluder pixel must be inside the proxies the scorer will use.

const BLENDER = findBlender();

// A seed whose plan has a tree, a vehicle and a pole, so every builder runs.
function seedWithEveryOccluder(model) {
  for (let k = 0; k < 60; k++) {
    const seed = 'it/' + k, kinds = new Set(planPhotos({ model, seed }).occluders.map(o => o.kind));
    if (kinds.size === 3) return seed;
  }
  throw new Error('no seed with every occluder kind');
}

function alphaMask(png) {
  const mask = new Uint8Array(png.width * png.height);
  for (let i = 0; i < mask.length; i++) mask[i] = png.pixels[i * png.channels + png.channels - 1] > 127 ? 1 : 0;
  return mask;
}

test('Blender photographs: object masks match the kernel silhouette and proxies cover every occluder', {
  skip: BLENDER ? false : 'Blender not found (set E3D_BLENDER or install it at /Applications/Blender.app); integration test not evaluated',
  timeout: 15 * 60 * 1000,
}, () => withTemp(async dir => {
  const model = validateModel(sampleModel()), soup = soupFromModel(model), glbPath = join(dir, 'model.glb');
  await writeFile(glbPath, modelToGLB(model));
  const seed = seedWithEveryOccluder(model);
  const { items, report } = await renderPhotosDetailed({ model, glbPath, outDir: join(dir, 'evidence'), seed, blender: BLENDER,
    quality: 'draft', maskDir: join(dir, 'masks') });
  const lines = [];
  for (const item of items) {
    const bytes = await readFile(join(dir, 'evidence', item.file)), info = jpegInfo(bytes);
    assert.deepEqual([info.width, info.height], [item.camera.width, item.camera.height]);
    assert.ok(info.markers.every(m => m === 0xe0 || m < 0xe0 || m > 0xef) && !info.markers.includes(0xfe), 'no metadata segments');
    assert.ok(bytes.length > 60000, item.id + ' is suspiciously small for a photograph (' + bytes.length + ' bytes)');
    const objectMask = alphaMask(decodePNG(await readFile(join(dir, 'masks', item.id + '.object.png'))));
    const kernel = render(soup, item.camera);
    let both = 0, either = 0;
    for (let i = 0; i < objectMask.length; i++) {
      const k = kernel.tri[i] >= 0;
      if (k && objectMask[i]) both++;
      if (k || objectMask[i]) either++;
    }
    const iou = both / either;
    const occluderMask = alphaMask(decodePNG(await readFile(join(dir, 'masks', item.id + '.occluders.png'))));
    const proxies = render(soupFromOccluders(item.occluders), item.camera);
    let rendered = 0, covered = 0;
    for (let i = 0; i < occluderMask.length; i++) if (occluderMask[i]) { rendered++; if (proxies.tri[i] >= 0) covered++; }
    const coverage = rendered ? covered / rendered : 1;
    const timing = report.shots.find(s => s.id === item.id);
    lines.push(item.id + ': IoU ' + iou.toFixed(4) + ', occluder pixels ' + rendered + ' covered ' + (100 * coverage).toFixed(2) + '%, ' + timing.seconds + ' s');
    assert.ok(either > 0.02 * objectMask.length, item.id + ' shows the object');
    assert.ok(iou >= 0.97, item.id + ' mask IoU ' + iou);
    assert.ok(coverage >= 0.95, item.id + ' proxy coverage ' + coverage);
  }
  assert.ok(items.some(item => item.occluders.length), 'some photo carries occluders');
  console.log('# ' + report.engine.engine + ' on ' + report.engine.device + ', draft, ' + report.wall_seconds.toFixed(1) + ' s wall\n# ' + lines.join('\n# '));
}));
