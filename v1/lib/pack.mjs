import { mkdir, readFile, writeFile, copyFile, rm, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { readJSON, writeJSON, sha256, objectHash } from '../../lib/io.mjs';
import { validateModel, modelToGLB } from './model.mjs';
import { soupFromModel } from './soup.mjs';
import { raycast } from './raster.mjs';
import {
  TASK_SCHEMA, TRUTH_SCHEMA, EVIDENCE_SCHEMA, VARIANTS, DEFAULT_BUDGET, layout,
  validateTask, validateTruth, validateEvidenceItem,
} from './contract.mjs';

// Dates are part of the evidence: the photographs are the newest record, the
// current drawings and notes slightly older, the stale drawings years older.
const DATES = { photos: '2025-09', drawings: '2025-02', notes: '2025-06', stale: '2017-04' };
const ALTERNATE = 'earlier';

async function writeModel(directory, model) {
  await mkdir(directory, { recursive: true });
  await writeJSON(join(directory, 'model.json'), model);
  await writeFile(join(directory, 'model.glb'), modelToGLB(model));
  return join(directory, 'model.glb');
}

async function lockItems(evidenceDir, items, prefix = '') {
  const locked = [];
  for (const item of items) {
    const file = prefix + item.file, bytes = await readFile(join(evidenceDir, file));
    locked.push(validateEvidenceItem({ ...item, file, sha256: sha256(bytes), bytes: bytes.length }));
  }
  return locked;
}

// Every probe must actually measure something on the model it belongs to.
function measureProbes(model) {
  const soup = soupFromModel(model);
  return Object.fromEntries((model.probes ?? []).map(probe => {
    const hit = raycast(soup, probe.origin, probe.direction);
    if (!hit) throw new Error('Probe ' + probe.id + ' misses ' + model.id);
    return [probe.id, hit.distance];
  }));
}

// The alternate state stored beside a truth model: its model, the change record
// (what differs, which probes are contested) and the measured contested probes.
async function writeAlternate(objectDir, { id, model: altModel, change }, truthProbes) {
  validateModel(altModel);
  await writeModel(join(objectDir, 'alternates', id), altModel);
  const altProbes = measureProbes(altModel);
  const contested = change.contested_probes.map(probe => {
    if (!(probe in truthProbes) || !(probe in altProbes)) throw new Error('Contested probe ' + probe + ' is missing from one model');
    return { probe, primary_m: truthProbes[probe], alternate_m: altProbes[probe] };
  });
  await writeJSON(join(objectDir, 'alternates', id, 'change.json'), { ...change, id, contested });
  return contested;
}

// Model -> private object directory: ground truth, the alternate state, and
// every standard evidence item rendered from them.
//
// The alternate is by default the generator's earlier state of the same object
// (`decoyModel`), whose drawings become the stale evidence of c1. A memory
// object passes its own: `{ id: 'remembered', model, change, stale: false }`,
// the structure as published, which gets no evidence of its own.
export async function buildObject({ dataRoot, archetype, seed, model, alternate, id, blender, quality = 'final', log = () => {} }) {
  const { generateModel, decoyModel } = await import('./generator/index.mjs');
  const { renderPhotos } = await import('./evidence/photos.mjs');
  const { renderDrawings } = await import('./evidence/drawings.mjs');
  const { writeNotes } = await import('./evidence/notes.mjs');
  model = validateModel(model ?? generateModel({ archetype, seed }));
  const objectId = id ?? model.id, objectDir = layout(dataRoot).object(objectId), evidenceDir = join(objectDir, 'evidence');
  try { await readdir(objectDir); throw new Error('Object ' + objectId + ' already exists; objects are immutable once built'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const itemSeed = String(model.seed ?? seed ?? 0) + '/' + objectId;
  try {
    const glbPath = await writeModel(objectDir, model);
    const truthProbes = measureProbes(model);
    const alt = alternate ?? { id: ALTERNATE, ...decoyModel(model, { seed: model.seed ?? seed ?? 0 }), stale: true };
    if (alt.id !== ALTERNATE && alt.stale) throw new Error('Stale drawings are only rendered for the "' + ALTERNATE + '" alternate');
    const contested = await writeAlternate(objectDir, alt, truthProbes);

    log('rendering photographs');
    const photos = await renderPhotos({ model, glbPath, outDir: evidenceDir, seed: itemSeed, blender, quality, capturedAt: DATES.photos });
    log('rendering drawings and notes');
    const drawings = await renderDrawings({ model, outDir: evidenceDir, seed: itemSeed, capturedAt: DATES.drawings });
    const notes = await writeNotes({ model, outDir: evidenceDir, seed: itemSeed, capturedAt: DATES.notes });
    const items = await lockItems(evidenceDir, [...photos, ...drawings, ...notes]);
    if (alt.stale) {
      const staleDir = 'stale-' + ALTERNATE;
      const stale = await renderDrawings({ model: alt.model, outDir: join(evidenceDir, staleDir), seed: itemSeed, capturedAt: DATES.stale, sourceModel: ALTERNATE });
      items.push(...await lockItems(evidenceDir, stale.map(item => ({ ...item, id: item.id + '@' + ALTERNATE, source_model: ALTERNATE })), staleDir + '/'));
    }
    await writeJSON(join(evidenceDir, 'evidence.json'), { schema: EVIDENCE_SCHEMA, object: objectId, items });
    return { object: objectId, directory: objectDir, items: items.map(item => item.id), triangles: soupFromModel(model).triangles, alternate: alt.id, contested };
  } catch (error) {
    // A half-built object would later be mistaken for a complete one.
    await rm(objectDir, { recursive: true, force: true });
    throw error;
  }
}

// Objects whose evidence is not rendered (real buildings: photographs taken on
// site, truth authored from withheld drawings) are written with this instead of
// buildObject. `items` are evidence records as validateEvidenceItem wants them,
// with `file` relative to `evidenceDir`, already copied there by the caller.
export async function writeProvidedObject({ dataRoot, model, id, items, alternate }) {
  model = validateModel(model);
  const objectId = id ?? model.id, objectDir = layout(dataRoot).object(objectId), evidenceDir = join(objectDir, 'evidence');
  await writeModel(objectDir, model);
  const contested = alternate ? await writeAlternate(objectDir, { ...alternate, stale: false }, measureProbes(model)) : [];
  const locked = await lockItems(evidenceDir, items);
  await writeJSON(join(evidenceDir, 'evidence.json'), { schema: EVIDENCE_SCHEMA, object: objectId, items: locked });
  return { object: objectId, directory: objectDir, items: locked.map(item => item.id), triangles: soupFromModel(model).triangles, contested };
}

// The date of the target state: that of the newest photograph among the inputs.
function targetDate(inputs) {
  const dates = inputs.filter(input => ['photo', 'aerial'].includes(input.kind)).map(input => input.captured_at).sort();
  return dates.at(-1) ?? DATES.photos;
}

export function taskPrompt(model, variant, inputs) {
  const spec = VARIANTS[variant], date = targetDate(inputs);
  const scale = spec.scale === 'metric'
    ? 'The evidence fixes absolute size, so your model is compared at the size you submit.'
    : 'None of the supplied evidence fixes absolute size, so your model is compared up to one uniform scale factor: proportions matter, absolute size does not.';
  // The evidence rule, worded for what the contestant may know about the object.
  const rule = spec.memory
    ? 'Use only this evidence, even where it disagrees with what you know or remember about this structure. The surveyed object is what is scored, not published figures.'
    : spec.real
      ? 'Use only this evidence. Do not rely on knowing this or a similar real building. The photographs are real: expect lens distortion, people, vehicles and signage.'
      : 'Use only this evidence. Do not rely on knowing a similar real building.';
  return [
    'Reconstruct the object shown in the supplied evidence as a 3D model: ' + model.title + '.',
    model.scope_note ?? '',
    'Target state: the object as it stood in ' + date + ', the date of the photographs. Evidence items carry dates; where they disagree, the target state decides.',
    'Frame: metres, right-handed, +Y up, ground at y = 0. ' + model.frame.front + ' ' + model.frame.origin,
    'Evidence (' + inputs.length + ' item' + (inputs.length === 1 ? '' : 's') + '): ' + inputs.map(i => i.path.replace('inputs/', '') + ' — ' + i.description + ' (' + i.captured_at + ')').join('; ') + '.',
    rule,
    'How it is scored: your GLB is compared with a hidden reference model. Overall shape counts most (surface agreement within a few percent of the object size); ' +
      'small features — openings, frames, canopies, structural members — are scored separately, as are named dimensions such as heights and wall positions. ' +
      'A small error in where you put the origin or which way the model faces is fitted out and reported, not punished. ' + scale + ' ' +
      'Surfaces that no supplied evidence shows are not scored: complete them plausibly. Anything that is not part of the object ' +
      '(ground, vegetation, vehicles, neighbouring buildings) counts against you. Solid base colours are compared as a secondary measure; textures are ignored.',
  ].filter(Boolean).join('\n\n');
}

// Object + variant -> public task pack and private truth record.
export async function buildTask({ dataRoot, objectId, variant, set }) {
  const spec = VARIANTS[variant];
  if (!spec) throw new Error('Unknown variant ' + variant);
  const paths = layout(dataRoot), objectDir = paths.object(objectId), evidenceDir = join(objectDir, 'evidence');
  const model = validateModel(await readJSON(join(objectDir, 'model.json')));
  const evidence = await readJSON(join(evidenceDir, 'evidence.json'));
  const byId = new Map(evidence.items.map(item => [item.id, item]));
  const taskId = objectId + '-' + variant, taskDir = paths.task(taskId);
  try { await readdir(taskDir); throw new Error('Task ' + taskId + ' already exists; build a new object or data root instead of rewriting a locked task'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // A variant names its evidence by standard item, or (real objects, which have
  // whatever photographs exist) by kind, in the order the object lists them.
  const used = spec.kinds
    ? evidence.items.filter(item => spec.kinds.includes(item.kind) && !item.id.includes('@'))
    : spec.items.map(id => {
      const key = spec.stale?.includes(id) ? id + '@' + ALTERNATE : id, item = byId.get(key);
      if (!item) throw new Error('Object ' + objectId + ' has no evidence item ' + key);
      return item;
    });
  if (!used.length) throw new Error('Object ' + objectId + ' has no evidence for variant ' + variant);
  for (const kind of spec.kinds ?? []) if (!used.some(item => item.kind === kind)) throw new Error('Object ' + objectId + ' has no ' + kind + ' evidence for variant ' + variant);
  await mkdir(join(taskDir, 'inputs'), { recursive: true });
  const inputs = [];
  for (const [index, item] of used.entries()) {
    // The public file name carries the kind and view, never whether it is stale.
    const name = String(index + 1).padStart(2, '0') + '-' + item.id.split('@')[0] + extname(item.file);
    await copyFile(join(evidenceDir, item.file), join(taskDir, 'inputs', name));
    inputs.push({ id: 'source-' + (index + 1), path: 'inputs/' + name, kind: item.kind, captured_at: item.captured_at,
      description: item.description, sha256: item.sha256, bytes: item.bytes });
  }
  const task = validateTask({
    schema: TASK_SCHEMA, id: taskId, title: model.title, variant, prompt: taskPrompt(model, variant, inputs),
    target_state: 'The object as it stood in ' + targetDate(inputs) + ', the date of the photographs.',
    frame: { unit: 'metre', up: '+Y', origin: model.frame.origin, front: model.frame.front },
    scale_evidence: spec.scale, inputs,
    output: { model: 'output/model.glb', notes: 'output/notes.md', rules: [
      'GLB 2.0, one scene, static uncompressed triangle meshes with FLOAT POSITION, no external resources, animations or skins.',
      'Metres, +Y up, in the frame stated above.',
      'The object only: no ground plane, scenery, lights or cameras.',
      'Solid-colour materials (baseColorFactor). Textures and vertex colours are ignored.',
      'notes.md: what you observed, what you inferred, what you could not resolve.',
    ] },
    budget: DEFAULT_BUDGET,
  });
  await writeJSON(join(taskDir, 'task.json'), task);
  const alternates = [];
  let alternateIds = [];
  try { alternateIds = (await readdir(join(objectDir, 'alternates'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const id of alternateIds) {
    const change = await readJSON(join(objectDir, 'alternates', id, 'change.json'));
    alternates.push({ id, contested_probes: change.contested_probes, note: change.note });
  }
  const truth = validateTruth({ schema: TRUTH_SCHEMA, task_id: taskId, task_sha256: objectHash(task), object: objectId, variant,
    scale_evidence: spec.scale, evidence: used.map(item => item.id), alternates, ...(set ? { set } : {}) });
  await writeJSON(join(paths.truth(taskId), 'truth.json'), truth);
  return { task: taskId, directory: taskDir, inputs: inputs.length, bytes: inputs.reduce((sum, input) => sum + input.bytes, 0) };
}

// Re-hashes every input of every task pack against its lock.
export async function verifyTasks(dataRoot) {
  const paths = layout(dataRoot), results = [];
  let ids = [];
  try { ids = (await readdir(join(dataRoot, 'tasks'))).sort(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const id of ids) {
    const task = validateTask(await readJSON(join(paths.task(id), 'task.json')));
    const truth = validateTruth(await readJSON(join(paths.truth(id), 'truth.json')));
    if (truth.task_sha256 !== objectHash(task)) throw new Error('Task ' + id + ' changed after its truth record was written');
    // What must never reach a contestant: the generator's own id for the object
    // (it names archetype and seed) and the seed itself. The pack is searched as
    // text; images cannot carry them, since sheets print only the public title.
    const model = await readJSON(join(paths.object(truth.object), 'model.json'));
    const secrets = [model.id !== truth.object ? model.id : null, String(model.seed ?? '').length >= 5 ? String(model.seed) : null].filter(Boolean);
    const leaked = (text, where) => { for (const secret of secrets) if (text.includes(secret)) throw new Error('Private identifier "' + secret + '" appears in ' + where); };
    leaked(JSON.stringify(task), id + '/task.json');
    for (const input of task.inputs) {
      const bytes = await readFile(join(paths.task(id), input.path));
      if (sha256(bytes) !== input.sha256 || bytes.length !== input.bytes) throw new Error('Input lock mismatch: ' + id + '/' + input.path);
      if (/\.(md|txt|json)$/.test(input.path)) leaked(bytes.toString('utf8'), id + '/' + input.path);
    }
    results.push({ task: id, inputs: task.inputs.length, set: truth.set ?? null });
  }
  return results;
}

// Convenience for calibration and sanity checks: the ground truth as if it were a submission.
export async function truthGLB(dataRoot, taskId) {
  const paths = layout(dataRoot), truth = await readJSON(join(paths.truth(taskId), 'truth.json'));
  return readFile(join(paths.object(truth.object), 'model.glb'));
}
