#!/usr/bin/env node
// Contestant preview tool: renders a .glb from standard and custom viewpoints
// so you can look at your own model before you submit it.
//
//   node tools/preview.mjs output/model.glb --out output/preview
//        [--views front,left,right,rear,top,iso,iso-rear] [--size 1024] [--clay]
//        [--camera x,y,z --target x,y,z --fov 50 --name custom] [--no-grid] [--aa 2]
//
// Self-contained: it imports only Node built-ins and files next to it.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as raster from './kernel/raster.mjs';
import { encodePNG } from './kernel/png.mjs';
import { createShader, VIEW_NAMES } from './shading.mjs';
import { readGLB, GLBError } from './glb.mjs';

const USAGE = `Usage: node tools/preview.mjs <model.glb> --out <directory> [options]

Options:
  --views <list>       comma-separated views (default: all of ${VIEW_NAMES.join(', ')})
  --size <pixels>      longest image side, 64-4096 (default 1024)
  --clay               ignore material colours, render everything in neutral clay
  --camera x,y,z       extra perspective camera position in model metres
  --target x,y,z       point the extra camera looks at (required with --camera)
  --fov <degrees>      vertical field of view of the extra camera (default 50)
  --name <name>        file name of the extra view (default custom)
  --no-grid            no metric grid behind the model
  --aa <1-4>           supersampling factor (default 2, or 1 above 1600 px)
  --max-triangles <n>  also check the triangle budget from your task.json
  -h, --help           this text`;

class UsageError extends Error {}

function vector(text, flag) {
  const values = String(text).split(',').map(Number);
  if (values.length !== 3 || !values.every(Number.isFinite)) throw new UsageError(flag + ' needs three comma-separated numbers, e.g. ' + flag + ' 12,8,15');
  return values;
}

const OPTIONS = {
  out: { type: 'string' }, views: { type: 'string' }, size: { type: 'string' }, clay: { type: 'boolean' },
  camera: { type: 'string' }, target: { type: 'string' }, fov: { type: 'string' }, name: { type: 'string' },
  'no-grid': { type: 'boolean' }, aa: { type: 'string' }, 'max-triangles': { type: 'string' }, help: { type: 'boolean', short: 'h' },
};

function parse(argv) {
  // "--camera -15,1.6,20" is the natural way to write a negative coordinate, but
  // parseArgs reads the value as another option; glue such values to their flag.
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i].startsWith('--') ? argv[i].slice(2) : null;
    if (OPTIONS[flag]?.type === 'string' && /^-[\d.]/.test(argv[i + 1] ?? '')) { args.push(argv[i] + '=' + argv[i + 1]); i++; }
    else args.push(argv[i]);
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: OPTIONS });
  if (values.help) return { help: true };
  if (positionals.length !== 1) throw new UsageError('Give exactly one .glb file');
  if (!values.out) throw new UsageError('--out <directory> is required');
  const size = values.size === undefined ? 1024 : Number(values.size);
  if (!Number.isInteger(size) || size < 64 || size > 4096) throw new UsageError('--size must be an integer between 64 and 4096');
  const aa = values.aa === undefined ? (size > 1600 ? 1 : 2) : Number(values.aa);
  if (!Number.isInteger(aa) || aa < 1 || aa > 4) throw new UsageError('--aa must be 1, 2, 3 or 4');
  let custom = null;
  if (values.camera !== undefined || values.target !== undefined) {
    if (values.camera === undefined || values.target === undefined) throw new UsageError('--camera and --target must be given together');
    const fov = values.fov === undefined ? 50 : Number(values.fov);
    if (!Number.isFinite(fov) || fov <= 1 || fov >= 170) throw new UsageError('--fov must be between 1 and 170 degrees');
    const name = values.name ?? 'custom';
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new UsageError('--name may contain only letters, digits, dot, dash and underscore');
    if (VIEW_NAMES.includes(name)) throw new UsageError('--name ' + name + ' clashes with a standard view name');
    custom = { position: vector(values.camera, '--camera'), target: vector(values.target, '--target'), fov, name };
  } else if (values.fov !== undefined || values.name !== undefined) throw new UsageError('--fov and --name need --camera and --target');
  // With only a custom camera, render only that view unless --views asks for more.
  let views = values.views === undefined ? (custom ? [] : [...VIEW_NAMES]) : values.views.split(',').map(view => view.trim()).filter(Boolean);
  const unknown = views.filter(view => !VIEW_NAMES.includes(view));
  if (unknown.length) throw new UsageError('Unknown view ' + unknown.join(', ') + '. Views: ' + VIEW_NAMES.join(', '));
  views = [...new Set(views)];
  if (!views.length && !custom) throw new UsageError('No views selected');
  let maxTriangles;
  if (values['max-triangles'] !== undefined) {
    maxTriangles = Number(values['max-triangles']);
    if (!Number.isInteger(maxTriangles) || maxTriangles < 1) throw new UsageError('--max-triangles must be a positive integer');
  }
  return { file: positionals[0], out: values.out, views, size, aa, clay: Boolean(values.clay), grid: !values['no-grid'], custom, maxTriangles };
}

const fixed = (value, digits = 3) => (Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value).toFixed(digits);
const triple = (values, digits) => '[' + values.map(value => fixed(value, digits)).join(', ') + ']';

function describeCamera(camera, grid) {
  if (camera.type === 'ortho') {
    const metresPerPixel = (camera.extent[1] - camera.extent[0]) / camera.width;
    return 'orthographic, ' + fixed(metresPerPixel, 4) + ' m per pixel' + (grid ? ', grid ' + grid.minor_m + ' m (bold every ' + grid.major_m + ' m)' : '');
  }
  const fov = 2 * Math.atan(camera.height / 2 / camera.fy) * 180 / Math.PI;
  return 'perspective from ' + triple(camera.position, 2) + ' looking along ' + triple(camera.forward, 3) + ', fov ' + fixed(fov, 1) + ' deg' +
    (grid ? ', ground grid ' + grid.minor_m + ' m' : '');
}

function notesFor(soup) {
  const { min, max } = soup.bounds, extent = max.map((value, i) => value - min[i]), largest = Math.max(...extent), notes = [];
  if (min[1] < -0.05) notes.push('Part of the model is below the ground plane y = 0 (lowest point y = ' + fixed(min[1]) + ' m).');
  if (min[1] > 0.05) notes.push('The model floats above the ground plane y = 0 (lowest point y = ' + fixed(min[1]) + ' m).');
  if (largest > 1000) notes.push('The model is ' + fixed(largest, 0) + ' m across. Units are metres: was it exported in centimetres or millimetres?');
  if (largest < 0.1) notes.push('The model is only ' + fixed(largest) + ' m across. Units are metres: was it exported in another unit?');
  return notes;
}

async function main(argv) {
  let options;
  try { options = parse(argv); } catch (error) {
    if (error instanceof UsageError || error.code?.startsWith?.('ERR_PARSE_ARGS')) { process.stderr.write('preview: ' + error.message + '\nRun "node tools/preview.mjs --help" for all options.\n'); return 2; }
    throw error;
  }
  if (options.help) { process.stdout.write(USAGE + '\n'); return 0; }
  let bytes;
  try { bytes = await readFile(options.file); } catch (error) {
    process.stderr.write('preview: cannot read ' + options.file + ': ' + error.message + '\n');
    return 1;
  }
  let soup;
  try { soup = readGLB(bytes, options.maxTriangles ? { maxTriangles: options.maxTriangles } : {}); } catch (error) {
    if (!(error instanceof GLBError)) throw error;
    process.stderr.write('preview: invalid GLB ' + options.file + ': ' + error.message + '\n');
    return 1;
  }
  const shader = createShader(raster), started = Date.now();
  const { min, max } = soup.bounds, extent = max.map((value, i) => value - min[i]), centre = min.map((value, i) => (value + max[i]) / 2);
  const cameras = {}, standard = shader.standardViews(soup.bounds, options.size);
  for (const view of options.views) cameras[view] = standard[view];
  if (options.custom) {
    cameras[options.custom.name] = shader.customCamera({ position: options.custom.position, target: options.custom.target,
      fov_y_deg: options.custom.fov, width: options.size, height: Math.round(options.size * 0.75) });
  }
  const outDir = resolve(options.out);
  await mkdir(outDir, { recursive: true });
  const lines = [], views = [], notes = notesFor(soup);
  for (const [name, camera] of Object.entries(cameras)) {
    const image = shader.shadeSoup(soup, camera, { clay: options.clay, grid: options.grid, ground: true, supersample: options.aa });
    const file = join(outDir, name + '.png');
    await writeFile(file, encodePNG(image.width, image.height, image.pixels, 3));
    const coverage = image.covered / (image.width * image.height);
    if (!image.covered) notes.push('Nothing of the model is visible in the ' + name + ' view.');
    views.push({ name, file, width: image.width, height: image.height, coverage, grid: image.grid, camera });
    lines.push('  ' + name.padEnd(9) + ' ' + join(options.out, name + '.png') + '  ' + image.width + 'x' + image.height + '  ' + describeCamera(camera, image.grid));
  }
  const s = soup.stats;
  const summary = {
    file: resolve(options.file), bytes: s.bytes, generator: s.generator, triangles: soup.triangles,
    primitives: s.primitives, meshes: s.meshes, nodes: s.nodes, materials: s.materials, textures: s.textures,
    bounds: soup.bounds, extent_m: { x: extent[0], y: extent[1], z: extent[2] }, centre,
    frame: 'metres, +Y up, ground y = 0, front faces +Z, +X is the right of a viewer facing the front',
    clay: options.clay, views, notes,
  };
  await writeFile(join(outDir, 'preview.json'), JSON.stringify(summary, null, 2) + '\n');
  const out = [
    'Model:     ' + options.file + ' (' + s.bytes.toLocaleString('en-US') + ' bytes' + (s.generator ? ', generator "' + s.generator + '"' : '') + ')',
    'Triangles: ' + soup.triangles.toLocaleString('en-US') + ' in ' + s.primitives + ' primitive(s); ' + s.meshes + ' mesh(es), ' + s.nodes + ' node(s), ' + s.materials + ' material(s)' +
      (s.textures ? ', ' + s.textures + ' texture(s) (not rendered here)' : ''),
    'Bounds:    min ' + triple(min) + '  max ' + triple(max) + '  (metres)',
    'Extent:    X ' + fixed(extent[0]) + ' m (left-right)   Y ' + fixed(extent[1]) + ' m (height)   Z ' + fixed(extent[2]) + ' m (front-back)',
    'Centre:    ' + triple(centre),
    'Frame:     metres, +Y up, ground at y = 0, front faces +Z, +X is the right of a viewer facing the front.',
    'Views (' + (options.clay ? 'clay' : 'material colours') + '):',
    ...lines,
    ...(notes.length ? ['Notes:', ...notes.map(note => '  - ' + note)] : []),
    'Wrote ' + views.length + ' image(s) and preview.json to ' + outDir + ' in ' + ((Date.now() - started) / 1000).toFixed(1) + ' s.',
  ];
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  process.stderr.write('preview: unexpected failure: ' + (error?.stack ?? error) + '\n');
  process.exitCode = 3;
});
