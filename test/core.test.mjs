import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, rm, mkdir, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCalibration, fixtureDefinitions, fixtureScene } from '../lib/fixtures.mjs';
import { geometryFromBytes, sceneToGLB, parseGLB, encodeGLB, neutralGLB } from '../lib/glb.mjs';
import { rasterize, maskMetrics, dimensionMetrics } from '../lib/metrics.mjs';
import { validateTask, validateSubmission, validateTruth } from '../lib/contracts.mjs';
import { readJSON, writeJSON, objectHash, sha256, existingContained, verifySources } from '../lib/io.mjs';
import { exportTask, prepareRealTasks } from '../lib/prepare.mjs';
import { evaluate } from '../lib/evaluate.mjs';

let root,calibration,task,submission,truth,bytes;
before(async()=>{
  root=await mkdtemp(join(tmpdir(),'evidence3d-core-'));
  calibration=await buildCalibration(root);
  task=await readJSON(join(root,'tasks','calibration-chapel','task.json'));
  submission=await readJSON(join(root,'submissions','calibration-chapel--reference','submission.json'));
  truth=await readJSON(join(root,'private','calibration-chapel','truth.json'));
  bytes=await readFile(join(root,'submissions','calibration-chapel--reference','model.glb'));
});
after(async()=>{await rm(root,{recursive:true,force:true});});
function mutated(change){
  const parsed=parseGLB(bytes);change(parsed.json,parsed.binary);return encodeGLB(parsed.json,parsed.binary);
}
async function cloneCase(name) {
  const base=join(root,'case-'+name);await mkdir(base,{recursive:true});
  await cp(join(root,'tasks','calibration-chapel'),join(base,'task'),{recursive:true});
  await cp(join(root,'submissions','calibration-chapel--reference'),join(base,'submission'),{recursive:true});
  await cp(join(root,'private','calibration-chapel'),join(base,'truth'),{recursive:true});
  return {taskPath:join(base,'task','task.json'),submissionPath:join(base,'submission','submission.json'),
    truthPath:join(base,'truth','truth.json'),outputDir:join(base,'report')};
}
test('all analytic controls and defects pass their declared calibration checks',()=>{
  assert.equal(calibration.passed,true);assert.equal(calibration.checks.length,22);
  assert.equal(calibration.submission_count,26);
});
test('world transforms are measured without fitting, centering or scale normalization',async()=>{
  const scene=fixtureScene(fixtureDefinitions[0]);scene.scale.x=2;scene.position.y=4;
  const result=await geometryFromBytes(sceneToGLB(scene));
  assert.deepEqual(result.bounds,{min:[-20,4,-15],max:[32,28,15.5]});
  const metrics=dimensionMetrics(result.bounds,fixtureDefinitions[0].bounds,.01,.01);
  assert.equal(metrics[0].relative_error,1);assert.equal(metrics[1].center_error_m,4);
});
test('rotation changes world bounds in the independently expected axes',async()=>{
  const scene=fixtureScene(fixtureDefinitions[0]);scene.rotation.y=Math.PI/2;
  const {bounds}=await geometryFromBytes(sceneToGLB(scene));
  assert.ok(Math.abs(bounds.min[0]+15)<1e-6);assert.ok(Math.abs(bounds.max[0]-15.5)<1e-6);
  assert.ok(Math.abs(bounds.min[2]+16)<1e-6);assert.ok(Math.abs(bounds.max[2]-10)<1e-6);
});
test('mask rasterizer agrees with a separately specified complete square',()=>{
  const coordinates=new Float64Array([-1,-1,0,1,-1,0,1,1,0,-1,-1,0,1,1,0,-1,1,0]);
  const view={right:[1,0,0],up:[0,1,0],origin:[0,0,0],extent:[-1,1,-1,1],resolution:32};
  const mask=rasterize(coordinates,view);
  assert.equal(mask.pixels.reduce((a,b)=>a+b,0),1024);
  assert.equal(mask.outside_vertices,0);
  assert.equal(maskMetrics(mask.pixels,new Uint8Array(1024).fill(1)).iou,1);
});
test('empty prediction gets zero while empty reference is a configuration error',()=>{
  assert.equal(maskMetrics(new Uint8Array(4),new Uint8Array([1,1,0,0])).iou,0);
  assert.throws(()=>maskMetrics(new Uint8Array(4),new Uint8Array(4)),/Empty reference/);
});
test('missing tower is detected even though all three overall dimensions are unchanged',async()=>{
  const report=await readJSON(join(root,'reports','calibration-chapel--missing-feature','report.json'));
  assert.equal(report.metrics.max_dimension_error,0);
  assert.ok(report.metrics.min_silhouette_iou<.91);assert.equal(report.geometry_checks_pass,false);
});
test('invalid submissions are retained with no fabricated accuracy scores',async()=>{
  const report=await readJSON(join(root,'reports','calibration-chapel--empty','report.json'));
  assert.equal(report.technical.valid,false);assert.equal(report.metrics,null);assert.equal(report.composite_score,null);
  assert.match(report.scorer_sha256,/^[a-f0-9]{64}$/);assert.equal(report.evaluation_runtime.three,'0.180.0');
});
test('wrong GLB byte count is rejected',async()=>{
  const broken=Buffer.from(bytes);broken.writeUInt32LE(bytes.length-4,8);
  await assert.rejects(()=>geometryFromBytes(broken),/header|length/);
});
test('external binary buffers are rejected before loader execution',async()=>{
  await assert.rejects(()=>geometryFromBytes(mutated(json=>json.buffers[0].uri='https://example.invalid/asset')),/external buffers/);
});
test('external images are rejected even when evaluation uses gray materials',async()=>{
  await assert.rejects(()=>geometryFromBytes(mutated(json=>json.images=[{uri:'file:///private/anything'}])),/External image/);
});
test('animation and compressed mesh contracts fail explicitly',async()=>{
  await assert.rejects(()=>geometryFromBytes(mutated(json=>json.animations=[{}])),/animations/);
  await assert.rejects(()=>geometryFromBytes(mutated(json=>json.extensionsUsed=['KHR_draco_mesh_compression'])),/Unsupported extension/);
});
test('multiple scenes cannot hide an alternative evaluated model',async()=>{
  await assert.rejects(()=>geometryFromBytes(mutated(json=>json.scenes.push({nodes:[]}))),/exactly one scene/);
});
test('node cycles and duplicate parents fail before recursive loading',async()=>{
  await assert.rejects(()=>geometryFromBytes(mutated(json=>json.nodes[1].children=[0])),/Cyclic/);
  await assert.rejects(()=>geometryFromBytes(mutated(json=>json.nodes[1].children=[2])),/multiply parented/);
});
test('conflicting matrix and TRS is rejected',async()=>{
  await assert.rejects(()=>geometryFromBytes(mutated(json=>json.nodes[0].scale=[1,1,1])),/mixes matrix/);
});
test('invalid position index is rejected',async()=>{
  const parsed=parseGLB(bytes),idx=parsed.json.accessors[parsed.json.meshes[0].primitives[0].indices];
  const view=parsed.json.bufferViews[idx.bufferView],binary=Buffer.from(parsed.binary);
  binary.writeUInt32LE(999999,view.byteOffset+(idx.byteOffset||0));
  await assert.rejects(()=>geometryFromBytes(encodeGLB(parsed.json,binary)),/Index outside/);
});
test('nonfinite positions and excessive triangle budgets fail',async()=>{
  const parsed=parseGLB(bytes),pos=parsed.json.accessors[parsed.json.meshes[0].primitives[0].attributes.POSITION];
  const view=parsed.json.bufferViews[pos.bufferView],binary=Buffer.from(parsed.binary);binary.writeFloatLE(NaN,view.byteOffset);
  await assert.rejects(()=>geometryFromBytes(encodeGLB(parsed.json,binary)),/Non-finite/);
  await assert.rejects(()=>geometryFromBytes(bytes,{max_triangles:1}),/count|limit/);
});
test('neutral review assets remove identifiers, custom metadata and colors',()=>{
  const custom=mutated(json=>{json.extras={winner:'secret-system'};json.nodes[0].extras={score:100};});
  const neutral=parseGLB(neutralGLB(custom));
  assert.equal(JSON.stringify(neutral.json).includes('secret-system'),false);
  assert.equal(neutral.json.asset.generator,undefined);
  assert.equal(neutral.json.nodes.some(n=>n.name||n.extras),false);
  assert.equal(neutral.json.materials.length,1);
});
test('task schemas reject duplicate and escaping source paths',()=>{
  const duplicate=structuredClone(task);duplicate.inputs.push({...duplicate.inputs[0]});
  assert.throws(()=>validateTask(duplicate),/Duplicate/);
  const escaping=structuredClone(task);escaping.inputs[0].path='inputs/../../outside';
  assert.throws(()=>validateTask(escaping),/escapes/);
});
test('task hash locks revisions, not just task names',()=>{
  const changed=structuredClone(task);changed.prompt+=' revision';
  assert.throws(()=>validateSubmission(submission,changed),/revision/);
});
test('unadmitted and underspecified ground truth is rejected',()=>{
  const pending=structuredClone(task);pending.split='development';pending.status='annotation_pending';
  const ref={...truth,task_sha256:objectHash(pending)};
  assert.throws(()=>validateTruth(ref,pending),/independently admitted/);
  pending.status='admitted';ref.task_sha256=objectHash(pending);
  assert.throws(()=>validateTruth(ref,pending),/two named independent reviewers/);
});
test('view ids cannot escape overlay output and bases must be orthonormal',()=>{
  const ref=structuredClone(truth);ref.views[0].id='../../outside';
  assert.throws(()=>validateTruth(ref,task),/view id/);
  ref.views[0].id='front';ref.views[0].right=[2,0,0];
  assert.throws(()=>validateTruth(ref,task),/orthonormal/);
});
test('raw input hash drift refuses an evaluation',async()=>{
  const files=await cloneCase('source-drift');
  await writeFile(join(files.taskPath,'..','inputs','dimensions.json'),'changed');
  await assert.rejects(()=>evaluate(files),/Input lock mismatch/);
});
test('reference errors are not mislabeled as contestant invalidity',async()=>{
  const files=await cloneCase('bad-reference'),ref=await readJSON(files.truthPath);ref.reference.sha256='0'.repeat(64);
  await writeJSON(files.truthPath,ref);
  const result=await evaluate(files);assert.equal(result.technical.valid,true);assert.equal(result.eligibility,'evaluation_error');
  assert.equal(result.metrics,null);
});
test('real development tasks without admitted truth remain deliberately unscored',async()=>{
  const files=await cloneCase('pending'),newTask=await readJSON(files.taskPath);
  newTask.split='development';newTask.status='annotation_pending';await writeJSON(files.taskPath,newTask);
  const sub=await readJSON(files.submissionPath);sub.task_sha256=objectHash(newTask);await writeJSON(files.submissionPath,sub);
  const result=await evaluate({...files,truthPath:undefined});
  assert.equal(result.technical.valid,true);assert.equal(result.metrics,null);assert.equal(result.eligibility,'annotation_pending');
});
test('claiming runner_measured in a submission cannot qualify it for an official leaderboard',async()=>{
  const files=await cloneCase('claimed-runner'),t=await readJSON(files.taskPath);
  t.split='development';t.status='admitted';await writeJSON(files.taskPath,t);
  const sub=await readJSON(files.submissionPath);sub.task_sha256=objectHash(t);sub.run.resource_accounting='runner_measured';await writeJSON(files.submissionPath,sub);
  const ref=await readJSON(files.truthPath);ref.task_sha256=objectHash(t);ref.provenance={kind:'independent_review',reviewers:['test-a','test-b'],evidence:['test-fixture-only']};await writeJSON(files.truthPath,ref);
  const result=await evaluate(files);
  assert.equal(result.eligibility,'geometry_only_unverified_run');assert.equal(result.composite_score,null);
});
test('artifact hash drift and declared over-budget submissions are rejected',async()=>{
  const files=await cloneCase('artifact-drift'),sub=await readJSON(files.submissionPath);sub.artifact.sha256='0'.repeat(64);await writeJSON(files.submissionPath,sub);
  assert.equal((await evaluate(files)).eligibility,'invalid_submission');
  sub.artifact.sha256=submission.artifact.sha256;sub.run.wall_seconds=99999;await writeJSON(files.submissionPath,sub);
  assert.match((await evaluate(files)).error,/budget exceeded/);
});
test('task export contains only allow-listed inputs, never private truth or extra files',async()=>{
  const files=await cloneCase('pack');
  await writeFile(join(files.taskPath,'..','secret-model.glb'),'not allowed');
  const out=join(root,'exported');await exportTask(files.taskPath,out);
  assert.deepEqual((await readdir(out)).sort(),['input-lock.json','inputs','task.json']);
  assert.equal((await verifySources(task,out)).length,2);
  const lock=await readJSON(join(out,'input-lock.json')),exported=await readJSON(join(out,'task.json'));
  assert.equal(lock.task_file_sha256,sha256(await readFile(join(out,'task.json'))));
  assert.match(lock.task_sha256_method,/not the hash of the pretty-printed/);
  await writeFile(join(out,'task.json'),JSON.stringify(exported));
  assert.equal(lock.task_sha256,objectHash(await readJSON(join(out,'task.json'))));
  assert.notEqual(lock.task_file_sha256,sha256(await readFile(join(out,'task.json'))));
  await assert.rejects(()=>exportTask(files.taskPath,out),/must be empty/);
});
test('symlink inputs cannot leave their source root',async()=>{
  const inside=join(root,'links');await mkdir(inside);
  await symlink(join(root,'calibration.json'),join(inside,'escape'));
  await assert.rejects(()=>existingContained(inside,'escape'),/Symlink escapes/);
});
test('partial independent measurements work without a complete reference mesh',async()=>{
  const files=await cloneCase('partial-truth'),t=await readJSON(files.taskPath);
  t.split='development';t.status='admitted';await writeJSON(files.taskPath,t);
  const sub=await readJSON(files.submissionPath);sub.task_sha256=objectHash(t);await writeJSON(files.submissionPath,sub);
  const ref={schema_version:1,task_id:t.id,task_sha256:objectHash(t),mode:'measurement_only',
    provenance:{kind:'independent_review',reviewers:['test-reviewer-a','test-reviewer-b'],evidence:['unit-test analytic dimensions']},
    measurements:[{id:'height',kind:'bbox_dimension',axis:'y',accepted_interval_m:[23.9,24.1],tolerance_m:.05,source_ids:['source-1']}]};
  await writeJSON(files.truthPath,ref);
  const result=await evaluate(files);
  assert.equal(result.geometry_checks_pass,true);assert.equal(result.metrics.mode,'measurement_only');
  assert.equal(result.metrics.measurements[0].measured_m,24);
  assert.equal(result.metrics.mean_silhouette_iou,null);assert.equal(result.metrics.silhouettes.length,0);
  assert.ok(result.coverage.unmeasured.includes('semantic completeness'));
  ref.measurements[0].accepted_interval_m=[30,31];await writeJSON(files.truthPath,ref);
  const wrong=await evaluate(files);assert.equal(wrong.geometry_checks_pass,false);assert.equal(wrong.metrics.measurements[0].distance_to_interval_m,6);
});
test('partial measurements reject unknown evidence and invalid uncertainty ranges',()=>{
  const ref={schema_version:1,task_id:task.id,task_sha256:objectHash(task),mode:'measurement_only',
    provenance:{kind:'analytic_fixture'},measurements:[{id:'height',kind:'bbox_dimension',axis:'y',accepted_interval_m:[24,23],
      tolerance_m:.05,source_ids:['source-1']}]};
  assert.throws(()=>validateTruth(ref,task),/interval/);
  ref.measurements[0].accepted_interval_m=[23,24];ref.measurements[0].source_ids=['nonexistent'];
  assert.throws(()=>validateTruth(ref,task),/source ids/);
});
test('preparing raw packs preserves annotations and refuses silent source revisions',async()=>{
  const base=join(root,'prepare-test'),source=join(base,'source'),data=join(base,'data'),catalog=join(base,'catalog.json');
  await mkdir(join(source,'refs','building'),{recursive:true});
  await writeFile(join(source,'refs','building','reference.png'),'opaque raw input fixture');
  await writeJSON(catalog,{source_pack_root:'refs',cases:[{id:'test-building',title:'Test building',root:'building',
    scope:'Exterior only',frame_review:'Pending frame review',annotation_questions:['height'],files:[['reference.png','photo']]}]});
  await prepareRealTasks(data,source,catalog);
  const annotations=join(data,'annotations','test-building.json'),original=await readJSON(annotations);
  original.reviewers=['independent-review-in-progress'];await writeJSON(annotations,original);
  await prepareRealTasks(data,source,catalog);
  assert.deepEqual((await readJSON(annotations)).reviewers,['independent-review-in-progress']);
  const input=join(data,'tasks','test-building','inputs','01-reference.png'),locked=await readFile(input);
  await writeFile(join(source,'refs','building','reference.png'),'revised source');
  await assert.rejects(()=>prepareRealTasks(data,source,catalog),/Locked task revision changed/);
  assert.deepEqual(await readFile(input),locked);
});
