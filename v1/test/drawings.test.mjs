import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decodePNG } from '../lib/png.mjs';
import { projectPoint } from '../lib/raster.mjs';
import { validateEvidenceItem } from '../lib/contract.mjs';
import { sampleModel } from '../fixtures/sample-model.mjs';
import { Canvas, measureText, layoutText, GLYPH_CHARACTERS } from '../lib/evidence/canvas.mjs';
import { renderDrawings, renderSheet, drawingContext, SHEETS } from '../lib/evidence/drawings.mjs';
import { writeNotes, surveyNotes } from '../lib/evidence/notes.mjs';

const near = (actual, expected, tolerance, what = '') => assert.ok(Math.abs(actual - expected) <= tolerance, what + ' ' + actual + ' is not within ' + tolerance + ' of ' + expected);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function scratch(run) {
  const directory = await mkdtemp(join(tmpdir(), 'e3d-drawings-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

const model = sampleModel(), context = drawingContext(model);
// Sheets without skew or grain, so pixels can be measured exactly; rendered once and shared.
const clean = {};
const cleanSheet = id => (clean[id] ??= renderSheet({ model, sheet: id, seed: 7, capturedAt: '2025-02', context, paper: { rotationDeg: 0, noise: 0 } }));

// Ink density in [0, 1] at a pixel: 0 on bare paper, 1 on solid ink.
function inkReader(sheet) {
  const { width, height, rgb } = sheet, light = (x, y) => (rgb[(y * width + x) * 3] + rgb[(y * width + x) * 3 + 1] + rgb[(y * width + x) * 3 + 2]) / 3;
  const paper = light(4, 4);
  return (x, y) => {
    x = Math.round(x - 0.5); y = Math.round(y - 0.5);
    if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    return Math.max(0, Math.min(1, (paper - light(x, y)) / (paper - 26)));
  };
}

// Ink-weighted centre of a short scan centred on `at`, along unit vector `u`.
function inkCentroid(ink, at, u, reach = 7) {
  let sum = 0, weight = 0;
  for (let k = -reach; k <= reach; k += 0.25) {
    const value = ink(at[0] + u[0] * k, at[1] + u[1] * k);
    sum += value * k; weight += value;
  }
  assert.ok(weight > 0.5, 'no ink near ' + at.map(v => v.toFixed(1)));
  return sum / weight;
}

test('stroke font: every digit renders as a distinct glyph, and every glyph has ink', () => {
  const bitmap = character => {
    const canvas = new Canvas(48, 48);
    canvas.text(character, 12, 36, { size: 24 });
    return Array.from({ length: 48 * 48 }, (_, i) => canvas.rgb[i * 3] < 128 ? 1 : 0);
  };
  const characters = GLYPH_CHARACTERS.filter(c => c !== ' '), maps = new Map(characters.map(c => [c, bitmap(c)]));
  for (const [character, map] of maps) assert.ok(map.reduce((s, v) => s + v, 0) >= 8, 'glyph ' + character + ' has no ink');
  const digits = '0123456789'.split('');
  for (const a of digits) for (const b of digits) {
    if (a >= b) continue;
    const p = maps.get(a), q = maps.get(b);
    let differ = 0, union = 0;
    for (let i = 0; i < p.length; i++) { if (p[i] !== q[i]) differ++; if (p[i] || q[i]) union++; }
    assert.ok(differ / union > 0.2, 'digits ' + a + ' and ' + b + ' look alike (' + (differ / union).toFixed(2) + ')');
  }
  // Text placement: width is additive, 90 degrees reads bottom-to-top.
  assert.ok(measureText('9.00 m', 25) > measureText('9.0 m', 25));
  const upright = layoutText('8.23 m', { x: 100, y: 100, size: 25 }), turned = layoutText('8.23 m', { x: 100, y: 100, size: 25, angleDeg: 90 });
  assert.ok(upright.box.x1 - upright.box.x0 > upright.box.y1 - upright.box.y0);
  assert.ok(turned.box.y1 - turned.box.y0 > turned.box.x1 - turned.box.x0);
  assert.ok(turned.strokes[0][0][1] > turned.strokes.at(-1).at(-1)[1], 'rotated text should run upwards');
});

test('canvas strokes, dashes and fills cover the pixels they should', () => {
  const canvas = new Canvas(100, 60), column = x => { let sum = 0; for (let y = 0; y < 60; y++) sum += 1 - canvas.rgb[(y * 100 + x) * 3 + 1] / 255; return sum; };
  canvas.line(10, 20.5, 90, 20.5, { width: 3, color: [0, 0, 0] });
  near(column(50), 3, 0.05, 'stroke cross-section');
  const dashed = new Canvas(200, 10);
  dashed.line(0, 5, 200, 5, { width: 2, dash: [10, 10], color: [0, 0, 0] });
  let on = 0;
  for (let x = 0; x < 200; x++) if (dashed.rgb[(5 * 200 + x) * 3] < 128) on++;
  near(on / 200, 0.5, 0.06, 'dash duty cycle');
  const filled = new Canvas(60, 60);
  filled.rect(10.3, 12.6, 30.3, 32.6, { color: [0, 0, 0] });
  let area = 0;
  for (let i = 0; i < 60 * 60; i++) area += 1 - filled.rgb[i * 3] / 255;
  near(area, 400, 1, 'filled area');
});

test('scale bar length in pixels equals metres x pixels-per-metre on every sheet', () => {
  for (const id of SHEETS) {
    const sheet = cleanSheet(id), { scaleBar, ppm } = sheet.layout, ink = inkReader(sheet);
    // Sheet density is exactly the camera's (the object view the drawing is made from).
    near(sheet.camera.width / (sheet.camera.extent[1] - sheet.camera.extent[0]), ppm, 1e-9, id + ' camera density');
    assert.ok(ppm >= 60, id + ' is drawn at ' + ppm + ' px/m');
    // Dark extent of the bar along its middle row, with half-pixel edges interpolated.
    const y = scaleBar.y, edge = (from, step) => {
      for (let x = from; Math.abs(x - from) < 60; x += step) {
        const here = ink(x + 0.5, y), next = ink(x + step + 0.5, y);
        if (here < 0.5 && next >= 0.5) return x + 0.5 + step * (0.5 - here) / (next - here);
      }
      throw new Error('scale bar edge not found');
    };
    const left = edge(Math.floor(scaleBar.x0) - 12, 1), right = edge(Math.ceil(scaleBar.x1) + 10, -1);
    near(right - left, scaleBar.metres * ppm, 1, id + ' scale bar length');
  }
});

test('dimension witness lines and ends sit where the kernel projects a and b', () => {
  const sheet = cleanSheet('elevation-front'), ink = inkReader(sheet), [ox, oy] = sheet.layout.offset;
  const ids = sheet.layout.dimensions.map(d => d.id).sort();
  assert.deepEqual(ids, ['door-width', 'eave-height', 'overall-width', 'ridge-height']);
  for (const d of sheet.layout.dimensions) {
    const truth = model.dimensions.find(item => item.id === d.id);
    for (const [key, point] of [['a', truth.a], ['b', truth.b]]) {
      const [x, y] = projectPoint(sheet.camera, point);
      const expected = [x + ox, y + oy], found = d[key];
      const flip = Math.hypot(found[0] - expected[0], found[1] - expected[1]) > 1e-6;
      // Strings are drawn left-to-right / bottom-to-top, so a and b may be swapped.
      const other = projectPoint(sheet.camera, key === 'a' ? truth.b : truth.a);
      const match = flip ? [other[0] + ox, other[1] + oy] : expected;
      near(found[0], match[0], 1e-9, d.id + ' ' + key + '.x'); near(found[1], match[1], 1e-9, d.id + ' ' + key + '.y');
    }
    // In the image: each witness line crosses the scan just inside the dimension line
    // at the along-line coordinate of its point, and the dimension line lies on the ends.
    const [e0, e1] = d.ends, length = Math.hypot(e1[0] - e0[0], e1[1] - e0[1]), u = [(e1[0] - e0[0]) / length, (e1[1] - e0[1]) / length];
    near(length, d.value_m * sheet.layout.ppm, 0.01, d.id + ' drawn length');
    for (const [end, point] of [[e0, d.a], [e1, d.b]]) {
      const inward = [point[0] - end[0], point[1] - end[1]], reach = Math.hypot(...inward), n = inward.map(v => v / reach);
      const probe = [end[0] + n[0] * 16, end[1] + n[1] * 16];
      near(inkCentroid(ink, probe, u), 0, 0.6, d.id + ' witness line offset');
      const mid = [(e0[0] + e1[0]) / 2, (e0[1] + e1[1]) / 2];
      assert.ok(ink(end[0], end[1]) > 0.6, d.id + ' has no tick at its end');
      near(inkCentroid(ink, [(end[0] * 3 + mid[0]) / 4, (end[1] * 3 + mid[1]) / 4], n), 0, 0.6, d.id + ' dimension line offset');
    }
  }
});

test('elevation edges outline every window and leave blank wall blank', () => {
  const sheet = cleanSheet('elevation-front'), ink = inkReader(sheet), at = (x, y) => sheet.layout.toSheet([x, y, 0]);
  const windows = [...[-2.7, 2.7].map(x => ({ x, y0: 0.9, y1: 2.3, w: 1.4 })), ...[-2.7, 0, 2.7].map(x => ({ x, y0: 3.2, y1: 4.5, w: 1.2 }))];
  for (const w of windows) {
    // Wall | frame | glass | mullion | glass | frame | wall: at least six separate lines.
    const [x0, y] = at(w.x - w.w / 2 - 0.12, (w.y0 + w.y1) / 2), [x1] = at(w.x + w.w / 2 + 0.12, 0);
    let runs = 0, inside = false;
    for (let x = x0; x <= x1; x += 0.5) {
      const value = ink(x, y);
      if (!inside && value > 0.5) { runs++; inside = true; } else if (inside && value < 0.25) inside = false;
    }
    assert.ok(runs >= 6, 'window at x=' + w.x + ', y=' + w.y0 + ' shows only ' + runs + ' lines');
  }
  for (const [ax, ay, bx, by] of [[-1.8, 0.6, -1.15, 2.0], [-2.0, 3.35, -0.7, 4.35], [1.15, 0.6, 1.8, 2.0], [-4.3, 0.4, -3.5, 4.9]]) {
    const [x0, y0] = at(ax, by), [x1, y1] = at(bx, ay);
    let worst = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) worst = Math.max(worst, ink(x, y));
    assert.ok(worst < 0.1, 'blank wall [' + [ax, ay, bx, by] + '] carries ink ' + worst.toFixed(2));
  }
  // The right elevation is not mirrored: the canopy post (front) is left of the rear wall.
  const right = cleanSheet('elevation-right'), rightInk = inkReader(right);
  const post = right.layout.toSheet([0.85, 1.5, 0.9]), rear = right.layout.toSheet([4.5, 1.5, -7]);
  assert.ok(post[0] < rear[0]);
  assert.ok(rightInk(rear[0], rear[1]) > 0.5, 'rear wall outline missing on the right elevation');
});

test('plan section: dark pixels follow the fixture wall footprint at 1.2 m', () => {
  const sheet = cleanSheet('plan'), ink = inkReader(sheet), toSheet = (x, z) => sheet.layout.toSheet([x, 1.2, z]);
  // The cut through the fixture: four walls, interrupted in front by two windows and the door.
  const walls = [[-4.5, -0.3, 4.5, 0], [-4.5, -7, -4.2, 0], [4.2, -7, 4.5, 0], [-4.5, -7, 4.5, -6.7]];
  const openings = [[-3.4, -0.3, -2.0, 0], [2.0, -0.3, 3.4, 0], [-0.55, -0.3, 0.55, 0]];
  const inBox = (x, z, [x0, z0, x1, z1], pad = 0) => x >= x0 - pad && x <= x1 + pad && z >= z0 - pad && z <= z1 + pad;
  const isWall = (x, z, pad = 0) => walls.some(box => inBox(x, z, box, pad)) && !openings.some(box => inBox(x, z, box, -pad));
  const ppm = sheet.layout.ppm, [left, top] = toSheet(-4.6, -7.1), [right, bottom] = toSheet(4.6, 0.1);
  let both = 0, either = 0, solidMiss = 0, solid = 0;
  for (let y = Math.floor(top); y <= bottom; y++) {
    for (let x = Math.floor(left); x <= right; x++) {
      const mx = -4.6 + (x + 0.5 - left) / ppm, mz = -7.1 + (y + 0.5 - top) / ppm, dark = ink(x + 0.5, y + 0.5) > 0.3;
      const wall = isWall(mx, mz);
      if (wall && dark) both++;
      if (wall || dark) either++;
      if (isWall(mx, mz, -3 / ppm)) { solid++; if (!dark) solidMiss++; }
    }
  }
  assert.ok(solidMiss / solid < 0.002, 'section misses ' + solidMiss + ' of ' + solid + ' wall pixels');
  assert.ok(both / either > 0.85, 'section / footprint IoU ' + (both / either).toFixed(3));
  // The room inside is bare paper: nothing below the cut there, nothing cut.
  const [rx0, ry0] = toSheet(-4.0, -6.5), [rx1, ry1] = toSheet(4.0, -0.5);
  let worst = 0;
  for (let y = ry0; y <= ry1; y += 2) for (let x = rx0; x <= rx1; x += 2) worst = Math.max(worst, ink(x, y));
  assert.ok(worst < 0.1, 'room interior carries ink ' + worst.toFixed(2));
  // The roof oversails the walls by 0.4 m: its dashed outline lies outside them, front at the bottom.
  const dashedHits = [];
  for (let z = -6.8; z <= -0.4; z += 0.02) dashedHits.push(ink(...toSheet(-4.9, z)));
  assert.ok(dashedHits.filter(v => v > 0.4).length / dashedHits.length > 0.35, 'roof outline is not dashed along x = -4.9');
  assert.ok(dashedHits.filter(v => v < 0.1).length / dashedHits.length > 0.2, 'roof outline is solid, not dashed');
  assert.ok(toSheet(0, 0.5)[1] > toSheet(0, -6)[1], 'front must be at the bottom of the plan');
});

test('text is at least 18 px tall, and dimension numbers are drawn that size', () => {
  const sheet = cleanSheet('elevation-front'), ink = inkReader(sheet);
  assert.ok(sheet.layout.minTextPx >= 18);
  const label = sheet.layout.dimensions.find(d => d.id === 'overall-width'), box = label.textBox;
  let top = Infinity, bottom = -Infinity;
  for (let y = Math.floor(box.y0); y <= box.y1; y++) for (let x = Math.floor(box.x0); x <= box.x1; x++) if (ink(x + 0.5, y + 0.5) > 0.5) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
  assert.ok(bottom - top + 1 >= 18, 'dimension digits are ' + (bottom - top + 1) + ' px tall');
});

test('renderDrawings: items validate, files match their hashes, same seed gives the same bytes', async () => {
  await scratch(async directory => {
    const first = await renderDrawings({ model, outDir: join(directory, 'a'), seed: 'house/7', capturedAt: '2025-02' });
    const again = await renderDrawings({ model, outDir: join(directory, 'b'), seed: 'house/7', capturedAt: '2025-02' });
    const other = await renderDrawings({ model, outDir: join(directory, 'c'), seed: 'house/8', capturedAt: '2017-04', sourceModel: 'earlier' });
    assert.deepEqual(first.map(item => item.id), ['plan', 'elevation-front', 'elevation-right']);
    for (const [index, item] of first.entries()) {
      validateEvidenceItem(item);
      const bytes = await readFile(join(directory, 'a', item.file));
      assert.equal(sha(bytes), item.sha256); assert.equal(bytes.length, item.bytes);
      assert.equal(item.sha256, again[index].sha256, item.id + ' is not deterministic');
      assert.notEqual(item.sha256, other[index].sha256);
      assert.equal(item.file, 'drawings/' + item.id + '.png');
      assert.equal(item.metric, true); assert.deepEqual(item.occluders, []); assert.equal(item.source_model, 'primary');
      assert.equal(item.captured_at, '2025-02');
      const png = decodePNG(bytes);
      assert.ok(Math.max(png.width, png.height) <= 2400, item.id + ' is ' + png.width + 'x' + png.height);
      assert.equal(png.channels, 3);
      if (item.kind === 'elevation') {
        assert.equal(item.camera.type, 'ortho');
        // A camera JSON round trip is all a consumer gets; it must still project.
        const camera = JSON.parse(JSON.stringify(item.camera)), [x, y] = projectPoint(camera, [-4.5, 2.7, 0]);
        assert.ok(x > 0 && x < camera.width && y > 0 && y < camera.height);
      } else assert.equal(item.camera, null);
    }
    assert.equal(first[1].kind, 'elevation'); assert.equal(first[0].kind, 'plan');
    near(first[1].camera.forward[2], -1, 1e-12, 'front elevation looks along -Z');
    near(first[2].camera.forward[0], -1, 1e-12, 'right elevation looks along -X');
    assert.ok(other.every(item => item.source_model === 'earlier' && item.captured_at === '2017-04'));
  });
});

test('the seeded scan skew is small and layout.toSheet follows it onto the ink', () => {
  // Skew stays within 0.4 degrees for every seed and is not degenerate (checked cheaply on a coarse sheet).
  const coarse = drawingContext(model, { pixelsPerMetre: 20 }), turns = [];
  for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    turns.push(renderSheet({ model, sheet: 'plan', seed, capturedAt: '2025-02', context: coarse, supersample: 1 }).layout.rotationDeg);
  }
  assert.ok(turns.every(turn => Math.abs(turn) <= 0.4), 'turns ' + turns);
  assert.ok(Math.max(...turns.map(Math.abs)) > 0.1 && new Set(turns).size === turns.length, 'turns ' + turns);
  // The mapping is checked at the largest allowed skew, with scan grain on, where a
  // wrong direction would miss the ink by several pixels.
  const sheet = renderSheet({ model, sheet: 'elevation-front', seed: 'skew-check', capturedAt: '2025-02', context, paper: { rotationDeg: 0.4 } });
  const ink = inkReader(sheet);
  assert.equal(sheet.layout.rotationDeg, 0.4);
  // Left wall outline (x = -4.5) at mid height is ink; blank wall just inside is not.
  for (const y of [0.5, 2.7, 4.9]) {
    const edge = sheet.layout.toSheet([-4.5, y, 0]), blank = sheet.layout.toSheet([-1.5, y < 3 ? 1.3 : 3.8, 0]);
    let best = 0;
    for (let k = -1; k <= 1; k++) best = Math.max(best, ink(edge[0] + k, edge[1]));
    assert.ok(best > 0.5, 'wall outline not found at y=' + y);
    assert.ok(ink(blank[0], blank[1]) < 0.15, 'unexpected ink on blank wall at y=' + y);
  }
  // The scale bar's first block (filled) and second block (open) after the skew.
  const { x0, y, segment, ppm } = sheet.layout.scaleBar;
  assert.ok(ink(...sheet.layout.rotate([x0 + 0.5 * segment * ppm, y])) > 0.6);
  assert.ok(ink(...sheet.layout.rotate([x0 + 1.5 * segment * ppm, y])) < 0.25);
});

test('survey notes state every dimension, carry the date, and name no parts or coordinates', async () => {
  const notes = surveyNotes({ model, seed: 'house/7', capturedAt: '2025-06' });
  assert.equal(notes.text, surveyNotes({ model, seed: 'house/7', capturedAt: '2025-06' }).text);
  assert.match(notes.text, /June 2025/);
  assert.equal(notes.millimetres.length, 2);
  for (const d of model.dimensions) {
    const metres = d.value_m.toFixed(2) + ' m', millimetres = Math.round(d.value_m * 1000) + ' mm';
    assert.ok(notes.text.includes(notes.millimetres.includes(d.id) ? millimetres : metres), d.id + ' is missing from the notes');
    assert.ok(notes.text.includes(d.label), d.label);
    assert.ok(!notes.text.includes(d.id), 'dimension id ' + d.id + ' leaked');
  }
  for (const part of model.parts) if (/[.-]/.test(part.id)) assert.ok(!notes.text.includes(part.id), 'part id ' + part.id + ' leaked');
  assert.doesNotMatch(notes.text, /-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*,\s*-?\d+/, 'looks like a coordinate triple');
  assert.doesNotMatch(notes.text, /\b[xyz]\s*=/i);
  // Every number in the notes is a dimension value, part of the date, or a stated rounding.
  const allowed = new Set([...model.dimensions.flatMap(d => [d.value_m.toFixed(2), String(Math.round(d.value_m * 1000))]), '10', '2025', notes.date.split(' ')[0]]);
  for (const number of notes.text.match(/\d+(\.\d+)?/g)) assert.ok(allowed.has(number), 'unexpected number ' + number);
  const remarks = notes.text.split('## Remarks')[1].trim().split('\n').filter(line => line.startsWith('- '));
  assert.ok(remarks.length >= 2 && remarks.length <= 3);
  await scratch(async directory => {
    const [item] = await writeNotes({ model, outDir: directory, seed: 'house/7', capturedAt: '2025-06' });
    validateEvidenceItem(item);
    const bytes = await readFile(join(directory, item.file));
    assert.equal(item.id, 'notes'); assert.equal(item.kind, 'notes'); assert.equal(item.file, 'notes/survey-notes.md');
    assert.equal(item.camera, null); assert.equal(item.metric, true); assert.deepEqual(item.occluders, []);
    assert.equal(sha(bytes), item.sha256); assert.equal(bytes.toString('utf8'), notes.text);
  });
});
