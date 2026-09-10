import { mkdir,readFile,writeFile,stat } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { readJSON,writeJSON,objectHash,sha256,existingContained } from './io.mjs';
import { validateSubmission } from './contracts.mjs';
import { geometryFromBytes } from './glb.mjs';
import { loadDetailContext } from './detail-reviews.mjs';
import { evaluate } from './evaluate.mjs';

export async function registerDetailSubmission(dataRoot,submissionPath,label) {
  const context=await loadDetailContext(dataRoot),submission=validateSubmission(await readJSON(submissionPath),context.task);
  if(context.index.entries.some(e=>e.submission_id===submission.id))throw new Error('Submission id already registered; use a new run id');
  if(submission.id.startsWith(context.task.id+'--'))throw new Error('Calibration fixture ids are reserved');
  const folder=join(dataRoot,'submissions',submission.id);
  try {await stat(folder);throw new Error('Destination submission directory already exists');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const source=await existingContained(dirname(submissionPath),submission.artifact.path);
  if((await stat(source)).size>context.task.budget.max_artifact_bytes)throw new Error('Artifact byte limit exceeded');
  const bytes=await readFile(source);
  if(sha256(bytes)!==submission.artifact.sha256)throw new Error('Submission artifact hash mismatch');
  await geometryFromBytes(bytes,context.task.budget);
  const normalized={...submission,artifact:{...submission.artifact,path:'model.glb'}};
  await mkdir(folder,{recursive:true});await writeFile(join(folder,'model.glb'),bytes);
  await writeJSON(join(folder,'submission.json'),normalized);
  const report=await evaluate({taskPath:join(dataRoot,'tasks',context.task.id,'task.json'),submissionPath:join(folder,'submission.json'),
    truthPath:join(dataRoot,'private',context.task.id,'truth.json'),outputDir:join(dataRoot,'reports',submission.id)});
  if(!report.detail_geometry)throw new Error('Submission not registered for review: '+(report.error||report.eligibility)+'. Its evaluation report was retained.');
  const index=await readJSON(join(dataRoot,'detail-index.json'));
  if(objectHash(index)!==context.registry_sha256)throw new Error('Experiment changed during registration; evaluation retained, registry not modified');
  index.entries.push({id:submission.id,submission_id:submission.id,task_id:context.task.id,label:label||submission.system.name,
    kind:'submission',source:'submitted',artifact_sha256:sha256(bytes)});
  await writeJSON(join(dataRoot,'detail-index.json'),index);
  await writeJSON(join(dataRoot,'registrations',submission.id+'.json'),{source_submission_sha256:objectHash(submission),
    normalized_submission_sha256:objectHash(normalized),artifact_sha256:sha256(bytes),registered_at:new Date().toISOString()});
  return {submission_id:submission.id,auto_passed_cards:report.detail_geometry.auto_passed_cards,
    scoreable_cards:report.detail_geometry.scoreable_cards,manual_detail_score:null,registered:true};
}
