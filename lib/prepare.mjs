import { readFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { join, dirname, basename, extname } from 'node:path';
import { readJSON, writeJSON, sha256, objectHash, existingContained, contained, verifySources } from './io.mjs';
import { validateTask } from './contracts.mjs';
import { taskDefaults } from './fixtures.mjs';

export async function prepareRealTasks(dataRoot, sourceRoot, catalogPath) {
  const catalog = await readJSON(catalogPath), prepared = [];
  for (const entry of catalog.cases) {
    const taskDir = join(dataRoot, 'tasks', entry.id);
    const inputs = [], copies = [];
    for (let i = 0; i < entry.files.length; i++) {
      const [relative, role] = entry.files[i];
      const source = await existingContained(sourceRoot, join(catalog.source_pack_root, entry.root, relative));
      // Explicit raw-image allow-list. No old model, derived measurement, brief,
      // build script or former generated specification enters a task package.
      if (!['.jpg','.jpeg','.png'].includes(extname(source).toLowerCase())) throw new Error('Real-task allow-list must contain raw reference images only');
      const bytes = await readFile(source), name = String(i+1).padStart(2,'0') + '-' + basename(relative);
      copies.push({ source, name });
      inputs.push({ id: 'source-' + (i+1), path: 'inputs/' + name, sha256: sha256(bytes), bytes: bytes.length,
        role, source: entry.root + '/' + relative, captured_at: null, rights: 'local_review_only' });
    }
    const task = validateTask({
      ...taskDefaults(), id: entry.id, title: entry.title, split: 'development', status: 'annotation_pending',
      prompt: 'Reconstruct ' + entry.title + ' from the supplied reference images. ' + entry.scope +
        ' Record observed, inferred and unresolved features separately. This development task is not yet scored: ' + entry.frame_review,
      inputs, rights: 'local_review_only'
    });
    task.output_contract.scope = entry.scope;
    task.frame.description = entry.frame_review + ' Do not use this draft for fixed-frame accuracy comparisons until admission.';
    try {
      const previous = await readJSON(join(taskDir, 'task.json'));
      if (objectHash(previous) !== objectHash(task)) throw new Error('Locked task revision changed: ' + task.id + '. Use a new data directory or an explicit versioned task id.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(join(taskDir, 'inputs'), { recursive: true });
    for (const item of copies) await copyFile(item.source, join(taskDir, 'inputs', item.name));
    await writeJSON(join(taskDir, 'task.json'), task);
    const annotationPath = join(dataRoot, 'annotations', entry.id + '.json');
    let annotationExists = false;
    try { await readJSON(annotationPath); annotationExists = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!annotationExists) await writeJSON(annotationPath, {
      schema_version: 1, task_id: entry.id, task_sha256: objectHash(task), status: 'pending_independent_review',
      reviewers: [], evidence: [], coordinate_frame: null, target_epoch: null, measurements: [],
      camera_calibrations: [], visibility_masks: [], required_features: [], unresolved_regions: [],
      rights_review: 'pending', questions: entry.annotation_questions,
      policy: 'This file is an annotation worksheet, not an admitted scoring reference. Existing generated models must not be promoted to ground truth.'
    });
    await verifySources(task, taskDir);
    prepared.push({ id: task.id, title: task.title, status: task.status, input_count: inputs.length, bytes: inputs.reduce((n,i)=>n+i.bytes,0) });
  }
  await writeJSON(join(dataRoot, 'prepared-tasks.json'), { schema_version: 1, tasks: prepared });
  return prepared;
}

export async function exportTask(taskPath, destination) {
  const task = validateTask(await readJSON(taskPath));
  await verifySources(task, dirname(taskPath));
  // A nonempty destination might contain an earlier solution; never mix it in.
  try {
    if ((await readdir(destination)).length) throw new Error('Export destination must be empty');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(join(destination, 'inputs'), { recursive: true });
  for (const input of task.inputs) {
    const source = await existingContained(dirname(taskPath), input.path), target = contained(destination, input.path);
    await mkdir(dirname(target), { recursive: true }); await copyFile(source, target);
  }
  await writeJSON(join(destination, 'task.json'), task);
  await writeJSON(join(destination, 'input-lock.json'), {
    schema_version: 1, task_sha256: objectHash(task),
    task_sha256_method: 'SHA-256 of UTF-8 canonical JSON: recursively sort object keys, preserve array order, serialize values with JavaScript JSON.stringify, and omit whitespace. This is the semantic task revision, not the hash of the pretty-printed task.json file.',
    task_file_sha256: sha256(await readFile(join(destination, 'task.json'))),
    inputs: task.inputs.map(({path,sha256,bytes})=>({path,sha256,bytes})) });
  return { destination, task_id: task.id, task_sha256: objectHash(task), input_count: task.inputs.length, rights: task.rights };
}
