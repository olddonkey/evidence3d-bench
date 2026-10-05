// Real-building tier (DESIGN.md: real variants r2 / r4). A real object is
// authored by hand in a directory:
//
//   model.mjs     default export () -> e3d-model-v1 truth (from the drawings)
//   evidence.mjs  PHOTOS: the photographs, their estimated cameras and occluders;
//                 OBJECT_ID: the public object id (neutral), NOTES_CAPTURED_AT
//   notes.md      survey notes for the metric variant (optional)
//   sheets.mjs    SHEETS: drawing registrations for verify.mjs (optional)
//   PROVENANCE.md where every number came from
//
// buildRealObject copies the prepared photographs from a sources root (outside
// git: real photographs never enter the repository), writes the object with the
// kernel's writeProvidedObject and builds its tasks with buildTask.
import { readFile, writeFile, mkdir, copyFile, rm, readdir, mkdtemp, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, extname, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { layout, VARIANTS, validateEvidenceItem } from '../contract.mjs';
import { writeProvidedObject, buildTask } from '../pack.mjs';
import { validateModel } from '../model.mjs';
import { jpegInfo, stripJpegMetadata } from '../evidence/photos.mjs';
import { decodePNG, encodePNG } from '../png.mjs';
import { cameraFromPose } from './resect.mjs';
import { coverageCounts } from '../score/coverage.mjs';

const run = promisify(execFile);
export const REAL_VARIANTS = Object.keys(VARIANTS).filter(id => VARIANTS[id].real);
export const NOTES_FILE = 'notes/survey-notes.md';
const exists = path => access(path).then(() => true, () => false);

// Words that must never reach a contestant from a real object's own text (the
// operator's brand, the street address) are declared per object, as FORBIDDEN in
// evidence.mjs; an authoring directory without the declaration is refused, so a
// forgotten list cannot pass for an empty one. Public text is checked before the
// build and the built packs after it (ids, titles, descriptions, notes, prompts).

export async function loadAuthoring(source) {
  const load = async name => (await exists(join(source, name))) ? import(pathToFileURL(join(source, name)).href) : null;
  const modelModule = await load('model.mjs');
  if (!modelModule) throw new Error(source + ' has no model.mjs');
  const make = modelModule.default ?? modelModule.model;
  const model = validateModel(typeof make === 'function' ? make() : make);
  const evidence = await load('evidence.mjs'), sheets = await load('sheets.mjs');
  const notesPath = join(source, 'notes.md');
  if (evidence && !Array.isArray(evidence.FORBIDDEN)) throw new Error(source + '/evidence.mjs must export FORBIDDEN, the words public text may not contain');
  return { model, objectId: evidence?.OBJECT_ID ?? null, photos: evidence?.PHOTOS ?? [], forbidden: evidence?.FORBIDDEN ?? [], sheets: sheets?.SHEETS ?? null,
    notes: (await exists(notesPath)) ? await readFile(notesPath, 'utf8') : null, notesCapturedAt: evidence?.NOTES_CAPTURED_AT ?? null };
}

// Every number in the notes must be one of the model's named dimensions, in
// metres to 10 mm or millimetres, so the notes cannot contradict the truth.
// The rounding remark ("rounded to the nearest 10 mm") is not a measurement.
export function checkNotes(text, model) {
  text = text.split('\n').filter(line => !/rounded to the nearest/i.test(line)).join('\n');
  const values = (model.dimensions ?? []).map(d => d.value_m);
  const problems = [];
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(m|mm)\b/g)) {
    const metres = match[2] === 'mm' ? Number(match[1]) / 1000 : Number(match[1]);
    const tolerance = match[2] === 'mm' ? 0.0005 : 0.005;
    if (!values.some(value => Math.abs(value - metres) <= tolerance + 1e-9)) problems.push(match[0] + ' matches no named dimension');
  }
  const stated = values.filter(value => [...text.matchAll(/(\d+(?:\.\d+)?)\s*(m|mm)\b/g)]
    .some(m => Math.abs((m[2] === 'mm' ? Number(m[1]) / 1000 : Number(m[1])) - value) <= (m[2] === 'mm' ? 0.0005 : 0.005) + 1e-9));
  if (!stated.length) problems.push('the notes state no named dimension');
  return problems;
}

// Public text must not carry the brand or the address.
export function forbiddenHits(text, forbidden) {
  const lower = String(text).toLowerCase();
  return forbidden.filter(word => lower.includes(word.toLowerCase()));
}

function evidenceItems(photos, model) {
  return photos.map(photo => {
    const camera = photo.camera?.type ? photo.camera : cameraFromPose(photo.camera);
    return validateEvidenceItem({
      id: photo.id, kind: photo.kind, file: 'photos/' + photo.file, captured_at: photo.captured_at, description: photo.description,
      metric: false, source_model: 'primary', camera, occluders: photo.occluders ?? [],
    });
  });
}

function pngSize(bytes) {
  if (bytes.readUInt32BE(12) !== 0x49484452) throw new Error('Not a PNG file');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// Builds the object and its real-variant tasks. Objects are immutable: an
// existing object directory is refused, and a half-built one is removed.
export async function buildRealObject({ source, sourcesRoot, dataRoot, set, id, variants = REAL_VARIANTS, log = () => {} }) {
  const authoring = await loadAuthoring(source), model = authoring.model;
  // The object id is public (it names the task packs), so it is neutral; the
  // model's own id, which may name the building, stays private (verifyTasks
  // fails a pack that contains it).
  const objectId = id ?? authoring.objectId ?? model.id, paths = layout(dataRoot), objectDir = paths.object(objectId);
  if (await exists(objectDir)) throw new Error('Object ' + objectId + ' already exists; objects are immutable once built');
  for (const variant of variants) if (!VARIANTS[variant]?.real) throw new Error(variant + ' is not a real-building variant');
  if (!authoring.photos.length) throw new Error(source + ' lists no photographs');
  // Public text is checked before anything is written.
  const publicText = [model.title, model.scope_note, model.frame.origin, model.frame.front, objectId,
    ...authoring.photos.flatMap(p => [p.id, p.description, p.file]), authoring.notes ?? ''].join('\n');
  const hits = forbiddenHits(publicText, authoring.forbidden);
  if (hits.length) throw new Error('Public text names ' + hits.join(', '));
  if (authoring.notes) {
    const problems = checkNotes(authoring.notes, model);
    if (problems.length) throw new Error('notes.md: ' + problems.join('; '));
  }
  const items = evidenceItems(authoring.photos, model);
  const evidenceDir = join(objectDir, 'evidence');
  try {
    await mkdir(join(evidenceDir, 'photos'), { recursive: true });
    for (const [k, photo] of authoring.photos.entries()) {
      const from = join(sourcesRoot, photo.file), to = join(evidenceDir, 'photos', photo.file);
      if (!(await exists(from))) throw new Error('Photograph ' + photo.file + ' is not in ' + sourcesRoot + ' (run prepare first)');
      let bytes = await readFile(from), size;
      const ext = extname(from).toLowerCase();
      if (ext === '.jpg' || ext === '.jpeg') { bytes = stripJpegMetadata(bytes); size = jpegInfo(bytes); }
      else if (ext === '.png') size = pngSize(bytes);
      else throw new Error(photo.id + ': photographs must be JPEG or PNG');
      // The camera's pixel grid is the image's: coverage projects into it.
      if (size.width !== items[k].camera.width || size.height !== items[k].camera.height) {
        throw new Error(photo.id + ' is ' + size.width + 'x' + size.height + ' but its camera is ' + items[k].camera.width + 'x' + items[k].camera.height);
      }
      await writeFile(to, bytes);
    }
    if (authoring.notes) {
      await mkdir(join(evidenceDir, 'notes'), { recursive: true });
      await writeFile(join(evidenceDir, NOTES_FILE), authoring.notes);
      items.push(validateEvidenceItem({ id: 'notes', kind: 'notes', file: NOTES_FILE, captured_at: authoring.notesCapturedAt ?? items.map(i => i.captured_at).sort().at(-1),
        description: 'Survey notes with measured dimensions', metric: true, source_model: 'primary', camera: null, occluders: [] }));
    }
    const object = await writeProvidedObject({ dataRoot, model, id: objectId, items });
    log('object ' + objectId + ': ' + object.items.length + ' evidence items, ' + object.triangles + ' triangles');
    const tasks = [];
    for (const variant of variants) {
      tasks.push(await buildTask({ dataRoot, objectId, variant, set }));
      log('task ' + tasks.at(-1).task + ': ' + tasks.at(-1).inputs + ' inputs');
    }
    // The packs as a contestant sees them must not name the brand or address.
    for (const task of tasks) {
      const json = await readFile(join(paths.task(task.task), 'task.json'), 'utf8');
      const texts = [json];
      for (const name of await readdir(join(paths.task(task.task), 'inputs'))) if (/\.(md|txt|json)$/.test(name)) texts.push(await readFile(join(paths.task(task.task), 'inputs', name), 'utf8'));
      const found = forbiddenHits(texts.join('\n'), authoring.forbidden);
      if (found.length) throw new Error('Task ' + task.task + ' names ' + found.join(', '));
    }
    return { object: objectId, directory: objectDir, items: object.items, triangles: object.triangles, tasks };
  } catch (error) {
    // A half-built object (or task) would later be mistaken for a complete one.
    await rm(objectDir, { recursive: true, force: true });
    for (const variant of variants) {
      await rm(paths.task(objectId + '-' + variant), { recursive: true, force: true });
      await rm(paths.truth(objectId + '-' + variant), { recursive: true, force: true });
    }
    throw error;
  }
}

// Prepares the photographs from a reference pack: crops away screenshot chrome,
// masks map labels drawn over the building, strips metadata, and writes JPEGs
// under the sources root. Needs macOS `sips` for JPEG decoding and encoding.
export async function preparePhotographs({ source, pack, sourcesRoot, log = () => {} }) {
  const { photos } = await loadAuthoring(source);
  await mkdir(sourcesRoot, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), 'e3d-real-'));
  const made = [];
  try {
    for (const photo of photos) {
      const from = photo.prepared_from;
      if (!from) throw new Error(photo.id + ' has no prepared_from');
      const png = join(work, photo.id + '.png');
      await run('sips', ['-s', 'format', 'png', join(pack, from.file), '--out', png]);
      const image = decodePNG(await readFile(png));
      const cropped = cropImage(image, from.crop);
      for (const mask of from.masks ?? []) cloneMask(cropped, mask);
      const out = join(work, photo.id + '-clean.png');
      await writeFile(out, encodePNG(cropped.width, cropped.height, cropped.pixels, 3));
      const jpg = join(work, photo.file);
      await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', out, '--out', jpg]);
      const bytes = stripJpegMetadata(await readFile(jpg)), info = jpegInfo(bytes);
      await writeFile(join(sourcesRoot, photo.file), bytes);
      made.push({ id: photo.id, file: photo.file, width: info.width, height: info.height, bytes: bytes.length });
      log(photo.id + ': ' + info.width + 'x' + info.height);
    }
  } finally { await rm(work, { recursive: true, force: true }); }
  return made;
}

// RGB crop of a decoded PNG (any channel count).
export function cropImage(image, { x, y, width, height }) {
  if (x < 0 || y < 0 || x + width > image.width || y + height > image.height) throw new Error('Crop outside the image');
  const pixels = new Uint8Array(width * height * 3), c = image.channels;
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const s = ((y + j) * image.width + x + i) * c, o = (j * width + i) * 3;
    pixels[o] = image.pixels[s]; pixels[o + 1] = image.pixels[s + (c > 2 ? 1 : 0)]; pixels[o + 2] = image.pixels[s + (c > 2 ? 2 : 0)];
  }
  return { width, height, channels: 3, pixels };
}

// Covers a rectangle (a map label) with the same-sized patch from `from`, an
// area of plain roof or ground chosen by hand next to it, feathering the seam.
export function cloneMask(image, { x, y, width, height, from }) {
  const [fx, fy] = from, feather = 3;
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const edge = Math.min(i, j, width - 1 - i, height - 1 - j), w = edge >= feather ? 1 : (edge + 1) / (feather + 1);
    const o = ((y + j) * image.width + x + i) * 3, s = ((fy + j) * image.width + fx + i) * 3;
    for (let k = 0; k < 3; k++) image.pixels[o + k] = Math.round(image.pixels[o + k] * (1 - w) + image.pixels[s + k] * w);
  }
}

// How much of the truth's visible surface the evidence shows, by the way the
// surface faces (front +Z, rear -Z, right +X, left -X, roof +Y; a point goes to
// its normal's dominant axis, turned towards the view that sampled it), by
// elevation (facing that way AND within `band` metres of the bounding box on
// that side: the rear elevation, not every rear-facing step of the roofline),
// and by evidence item. `context` is the scorer's (v1/lib/score loadContext);
// counts are of its surface samples, so fractions are shares of visible area.
export function coverageSummary(context, { band = 2.5 } = {}) {
  const { surface, maps, diagonal, soup } = context, count = surface.points.length / 3, { min, max } = soup.bounds;
  const facing = new Array(count), onElevation = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const nx = surface.normals[3 * i], ny = surface.normals[3 * i + 1], nz = surface.normals[3 * i + 2], ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    facing[i] = ay >= ax && ay >= az ? (ny > 0 ? 'roof' : 'underside') : az >= ax ? (nz > 0 ? 'front' : 'rear') : (nx > 0 ? 'right' : 'left');
    const x = surface.points[3 * i], z = surface.points[3 * i + 2];
    onElevation[i] = { front: z > max[2] - band, rear: z < min[2] + band, right: x > max[0] - band, left: x < min[0] + band, roof: true, underside: true }[facing[i]] ? 1 : 0;
  }
  const tally = keep => {
    const out = {};
    for (let i = 0; i < count; i++) {
      if (!keep(i)) continue;
      const entry = out[facing[i]] ??= { points: 0, evidenced: 0 };
      entry.points++; entry.evidenced += surface.evidenced[i];
    }
    for (const entry of Object.values(out)) entry.fraction = Math.round(entry.evidenced / entry.points * 1000) / 1000;
    return out;
  };
  const byFacing = tally(() => true), byElevation = tally(i => onElevation[i] && facing[i] !== 'roof' && facing[i] !== 'underside');
  const byItem = maps.map(map => {
    const shown = coverageCounts([map], surface.points, surface.normals, diagonal);
    return { id: map.id, fraction: Math.round(shown.reduce((sum, v) => sum + (v ? 1 : 0), 0) / count * 1000) / 1000 };
  });
  return { points: count, evidenced: surface.evidencedCount, fraction: Math.round(surface.evidencedCount / count * 1000) / 1000,
    by_facing: byFacing, by_elevation: byElevation, elevation_band_m: band, by_item: byItem };
}
