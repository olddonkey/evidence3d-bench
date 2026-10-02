import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rng } from '../lib/rng.mjs';
import { decodePNG } from '../lib/png.mjs';
import { modelToGLB } from '../lib/model.mjs';
import { soupFromModel, soupFromGLB } from '../lib/soup.mjs';
import { render, projectPoint } from '../lib/raster.mjs';
import { encodeGLB } from '../../lib/glb.mjs';
import { sampleModel } from '../fixtures/sample-model.mjs';
import { shadeSoup, standardViews, customCamera, unionBounds } from '../lib/render/shade.mjs';
import { installTools, checkSelfContained, importSpecifiers } from '../lib/render/install-tools.mjs';
import { readGLB, GLBError } from '../tools/glb.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BACKGROUND = [243, 242, 238];   // DEFAULT_SHADING.background '#f3f2ee'
const fixture = soupFromModel(sampleModel());
const pixelAt = (image, x, y) => { const i = (Math.floor(y) * image.width + Math.floor(x)) * 3; return [...image.pixels.subarray(i, i + 3)]; };
const isBackground = (image, at) => image.pixels[at * 3] === BACKGROUND[0] && image.pixels[at * 3 + 1] === BACKGROUND[1] && image.pixels[at * 3 + 2] === BACKGROUND[2];
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

test('shading is deterministic', () => {
  const views = standardViews(fixture.bounds, 160);
  for (const name of ['front', 'iso']) {
    const options = { supersample: 2, grid: true, ground: true };
    const a = shadeSoup(fixture, views[name], options), b = shadeSoup(fixture, views[name], options);
    assert.deepEqual([a.width, a.height], [b.width, b.height]);
    assert.ok(Buffer.from(a.pixels).equals(Buffer.from(b.pixels)), name + ' differs between runs');
  }
});

test('shaded pixels cover exactly what the rasterizer hits, in the right colours', () => {
  const camera = standardViews(fixture.bounds, 256).front, image = shadeSoup(fixture, camera);
  const frame = render(fixture, camera);
  assert.equal(image.pixels.length, camera.width * camera.height * 3);
  let hits = 0, mismatched = 0;
  for (let at = 0; at < frame.tri.length; at++) {
    if (frame.tri[at] >= 0) hits++;
    if ((frame.tri[at] >= 0) === isBackground(image, at)) mismatched++;
  }
  assert.equal(mismatched, 0);
  assert.equal(image.covered, hits);
  assert.ok(hits > 0.4 * frame.tri.length, 'the house should fill much of its front view');
  // Door (#7a2e2a) is red, the rendered wall (#d8cfc0) light and warm, the roof (#6b4a3f) dark brown.
  const door = pixelAt(image, ...projectPoint(camera, [0, 1.2, -0.17]));
  const wall = pixelAt(image, ...projectPoint(camera, [-3.8, 1.5, 0]));
  const roof = pixelAt(image, ...projectPoint(camera, [-2, 6.6, -1.5]));
  assert.ok(door[0] > door[1] + 40 && door[0] > door[2] + 40, 'door pixel ' + door);
  assert.ok(luminance(wall) > 150 && wall[0] >= wall[2], 'wall pixel ' + wall);
  assert.ok(luminance(roof) < 110 && roof[0] > roof[2], 'roof pixel ' + roof);
});

test('faces turned different ways get different light, and edges darken silhouettes', () => {
  const camera = standardViews(fixture.bounds, 320).iso, image = shadeSoup(fixture, camera, { clay: true });
  const front = pixelAt(image, ...projectPoint(camera, [-3.5, 1.5, 0]));
  const side = pixelAt(image, ...projectPoint(camera, [4.5, 1.5, -5]));
  assert.ok(Math.abs(luminance(front) - luminance(side)) > 10, 'front ' + front + ' side ' + side);
  const plain = shadeSoup(fixture, camera, { clay: true, edges: false });
  let darker = 0, changed = 0;
  for (let i = 0; i < image.pixels.length; i += 3) {
    if (image.pixels[i] !== plain.pixels[i]) { changed++; if (image.pixels[i] < plain.pixels[i]) darker++; }
  }
  assert.ok(changed > 100 && darker === changed, 'edges should only darken pixels (' + darker + '/' + changed + ')');
});

test('clay mode ignores colours', () => {
  const random = rng('clay-colours'), recoloured = { ...fixture, colors: Float32Array.from(fixture.colors, () => random.next()) };
  const camera = standardViews(fixture.bounds, 200).iso;
  const a = shadeSoup(fixture, camera, { clay: true }), b = shadeSoup(recoloured, camera, { clay: true });
  assert.ok(Buffer.from(a.pixels).equals(Buffer.from(b.pixels)));
  const colourA = shadeSoup(fixture, camera), colourB = shadeSoup(recoloured, camera);
  assert.ok(!Buffer.from(colourA.pixels).equals(Buffer.from(colourB.pixels)));
  // Clay works even on a soup that carries no colours at all.
  const bare = { positions: fixture.positions, triangles: fixture.triangles };
  assert.ok(Buffer.from(shadeSoup(bare, camera, { clay: true }).pixels).equals(Buffer.from(a.pixels)));
  assert.throws(() => shadeSoup(bare, camera), /colors/);
});

test('the grid sits behind the model and never paints over it', () => {
  for (const name of ['front', 'iso']) {
    const camera = standardViews(fixture.bounds, 240)[name], frame = render(fixture, camera);
    const plain = shadeSoup(fixture, camera), gridded = shadeSoup(fixture, camera, { grid: true, ground: true });
    assert.ok(gridded.grid && gridded.grid.minor_m > 0, name + ' reports its grid spacing');
    let backgroundChanged = 0;
    for (let at = 0; at < frame.tri.length; at++) {
      const same = [0, 1, 2].every(c => plain.pixels[at * 3 + c] === gridded.pixels[at * 3 + c]);
      if (frame.tri[at] >= 0) assert.ok(same, name + ' grid changed a model pixel');
      else if (!same) backgroundChanged++;
    }
    assert.ok(backgroundChanged > 100, name + ' grid should be visible');
  }
});

test('standard views are named, framed on the box and looking the right way', () => {
  const views = standardViews(fixture.bounds, 300);
  assert.deepEqual(Object.keys(views).sort(), ['front', 'iso', 'iso-rear', 'left', 'rear', 'right', 'top']);
  const corners = Array.from({ length: 8 }, (_, c) => [0, 1, 2].map(i => c >> i & 1 ? fixture.bounds.max[i] : fixture.bounds.min[i]));
  for (const [name, camera] of Object.entries(views)) {
    assert.ok(Math.max(camera.width, camera.height) <= 300, name + ' size');
    for (const corner of corners) {
      const [x, y] = projectPoint(camera, corner);
      assert.ok(x >= 0 && x <= camera.width && y >= 0 && y <= camera.height, name + ' cuts off ' + corner);
    }
  }
  const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  assert.ok(close(views.front.forward, [0, 0, -1]) && close(views.rear.forward, [0, 0, 1]));
  assert.ok(close(views.left.forward, [1, 0, 0]) && close(views.right.forward, [-1, 0, 0]) && close(views.top.forward, [0, -1, 0]));
  const [iso, rear] = [views.iso.position, views['iso-rear'].position];
  assert.ok(iso[0] > fixture.bounds.max[0] && iso[2] > fixture.bounds.max[2] && iso[1] > fixture.bounds.max[1], 'iso from front-right above');
  assert.ok(rear[0] < fixture.bounds.min[0] && rear[2] < fixture.bounds.min[2], 'iso-rear from rear-left');
  // A tall object keeps its longest side at the requested size.
  const tower = standardViews({ min: [-1, 0, -1], max: [1, 30, 1] }, 200);
  assert.equal(tower.front.height, 200);
  assert.ok(tower.front.width < 60);
  // Looking straight down still has a defined basis.
  const down = customCamera({ position: [0, 30, 0], target: [0, 0, 0], width: 64, height: 48 });
  assert.ok(Math.abs(down.forward[1] + 1) < 1e-9);
  assert.deepEqual(unionBounds({ min: [0, 0, 0], max: [1, 1, 1] }, { min: [-1, 2, 0], max: [0, 3, 4] }), { min: [-1, 0, 0], max: [1, 3, 4] });
});

test('the kit GLB reader matches the kernel loader', async () => {
  const bytes = modelToGLB(sampleModel()), kernel = await soupFromGLB(bytes), kit = readGLB(bytes);
  assert.equal(kit.triangles, kernel.triangles);
  let worst = 0;
  for (let i = 0; i < kernel.positions.length; i++) worst = Math.max(worst, Math.abs(kit.positions[i] - kernel.positions[i]));
  assert.ok(worst < 1e-5, 'positions differ by ' + worst);
  for (let i = 0; i < kernel.colors.length; i++) assert.ok(Math.abs(kit.colors[i] - kernel.colors[i]) < 1e-6);

  // A hand-built file with a TRS parent, a matrix child, a strided position
  // buffer, 16-bit indices and no material.
  const positions = new Float32Array([0, 0, 0, 9, 9, 9, 1, 0, 0, 9, 9, 9, 0, 1, 0, 9, 9, 9, 0, 0, 1, 9, 9, 9]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const binary = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const half = Math.SQRT1_2;
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [
      { translation: [5, 1, -2], rotation: [0, half, 0, half], scale: [2, 2, 2], children: [1] },
      { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1], mesh: 0 },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 96, byteStride: 24 }, { buffer: 0, byteOffset: 96, byteLength: 12 }],
    buffers: [{ byteLength: binary.length }] };
  const handmade = encodeGLB(json, binary), viaKernel = await soupFromGLB(handmade), viaKit = readGLB(handmade);
  assert.equal(viaKit.triangles, 2);
  for (let i = 0; i < 18; i++) assert.ok(Math.abs(viaKit.positions[i] - viaKernel.positions[i]) < 1e-5, 'vertex component ' + i);
  assert.deepEqual([...viaKit.colors.subarray(0, 3)], [1, 1, 1]);
});

test('the kit GLB reader rejects files outside the submission contract, as the kernel does', async () => {
  const good = modelToGLB(sampleModel()), rejected = [];
  const reject = (bytes, pattern) => {
    assert.throws(() => readGLB(bytes), error => error instanceof GLBError && pattern.test(error.message), String(pattern));
    rejected.push(bytes);
  };
  reject(Buffer.from('{"asset":{"version":"2.0"}}'), /magic/);
  reject(good.subarray(0, good.length - 8), /length|Truncated/);
  const edit = change => {
    const view = new DataView(good.buffer, good.byteOffset), length = view.getUint32(12, true);
    const json = JSON.parse(good.subarray(20, 20 + length).toString('utf8')), binary = good.subarray(20 + length + 8);
    change(json);
    return encodeGLB(json, Buffer.from(binary));
  };
  reject(edit(json => { json.extensionsUsed = ['KHR_draco_mesh_compression']; }), /Draco/);
  reject(edit(json => { json.buffers[0].uri = 'model.bin'; }), /embedded buffer/);
  reject(edit(json => { json.meshes[0].primitives[0].mode = 1; }), /triangle-list/);
  reject(edit(json => { json.animations = [{ channels: [], samplers: [] }]; }), /static/);
  assert.throws(() => readGLB(good, { maxTriangles: 100 }), /triangle limit/);
  // The preview's promise "fails here, fails at submission" holds for each case.
  for (const bytes of rejected) await assert.rejects(soupFromGLB(bytes));
  await assert.rejects(soupFromGLB(good, { max_triangles: 100 }));
});

test('installed kit is self-contained and renders the fixture GLB from a bare directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e3d-kit-'));
  try {
    await mkdir(join(root, 'node_modules'));
    await symlink(join(REPO, 'node_modules/three'), join(root, 'node_modules/three'), 'dir');
    const installed = await installTools(join(root, 'tools'));
    assert.deepEqual(installed.files, ['README.md', 'glb.mjs', 'kernel/png.mjs', 'kernel/raster.mjs', 'preview.mjs', 'shading.mjs']);
    for (const file of installed.files) {
      const source = await readFile(join(root, 'tools', file), 'utf8');
      assert.ok(!source.includes(REPO), file + ' mentions the repository path');
      for (const specifier of importSpecifiers(source)) {
        assert.ok(specifier.startsWith('node:') || specifier.startsWith('./'), file + ' imports ' + specifier);
        assert.ok(!/score|truth|report|generator|evidence/.test(specifier), file + ' imports ' + specifier);
      }
    }
    await mkdir(join(root, 'output'));
    await writeFile(join(root, 'output/model.glb'), modelToGLB(sampleModel()));
    const run = (...args) => spawnSync(process.execPath, ['tools/preview.mjs', ...args], { cwd: root, encoding: 'utf8' });
    const result = run('output/model.glb', '--out', 'output/preview', '--size', '200', '--aa', '1');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Triangles: 700 /);
    assert.match(result.stdout, /Extent: +X 9\.800 m .*Y 8\.800 m .*Z 8\.450 m/);
    assert.match(result.stdout, /min \[-4\.900, 0\.000, -7\.450\]/);
    const written = (await readdir(join(root, 'output/preview'))).sort();
    assert.deepEqual(written, ['front.png', 'iso-rear.png', 'iso.png', 'left.png', 'preview.json', 'rear.png', 'right.png', 'top.png']);
    for (const name of written.filter(file => file.endsWith('.png'))) {
      const image = decodePNG(await readFile(join(root, 'output/preview', name)));
      let model = 0;
      for (let at = 0; at < image.width * image.height; at++) {
        // Background and grid are light and neutral; the house is darker or coloured.
        const [r, g, b] = image.pixels.subarray(at * 3, at * 3 + 3);
        if (luminance([r, g, b]) < 200 || Math.max(r, g, b) - Math.min(r, g, b) > 25) model++;
      }
      assert.ok(model > 0.1 * image.width * image.height, name + ' shows too little of the model (' + model + ' px)');
    }
    const summary = JSON.parse(await readFile(join(root, 'output/preview/preview.json'), 'utf8'));
    assert.equal(summary.triangles, 700);
    assert.equal(summary.views.length, 7);

    const custom = run('output/model.glb', '--out', 'output/custom', '--size', '120', '--clay', '--camera', '-15,1.6,20', '--target', '0,3,0', '--fov', '45', '--name', 'street');
    assert.equal(custom.status, 0, custom.stderr);
    assert.deepEqual((await readdir(join(root, 'output/custom'))).sort(), ['preview.json', 'street.png']);

    await writeFile(join(root, 'output/broken.glb'), Buffer.from('not a model'));
    const broken = run('output/broken.glb', '--out', 'output/broken');
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /invalid GLB .*magic/);
    const usage = run('output/model.glb', '--out', 'output/x', '--views', 'sky');
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Unknown view sky/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the self-containment check refuses scoring code and repository paths', () => {
  const kit = extra => new Map([['preview.mjs', "import { x } from './glb.mjs';\n" + extra], ['glb.mjs', 'export const x = 1;\n']]);
  checkSelfContained(kit("import fs from 'node:fs';\nimport { Vector3 } from 'three';\n"));
  assert.throws(() => checkSelfContained(kit("import { scoreSoup } from '../lib/score/index.mjs';\n")), /imports \.\.\/lib\/score/);
  assert.throws(() => checkSelfContained(kit("const m = await import('../../truth/x.json');\n")), /imports/);
  assert.throws(() => checkSelfContained(kit('const m = await import(somewhere);\n')), /computed/);
  assert.throws(() => checkSelfContained(kit("import ajv from 'ajv';\n")), /imports ajv/);
  assert.throws(() => checkSelfContained(kit('// ' + REPO + '\n')), /repository path/);
});
