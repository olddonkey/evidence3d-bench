import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildDetailCalibration} from '../lib/detail-fixtures.mjs';
import {buildAdditionalExamples,buildAdditionalExample} from '../lib/additional-examples.mjs';
import {EXAMPLE_DEFINITIONS} from '../lib/example-scenes.mjs';
import {listDetailExamples} from '../lib/detail-catalog.mjs';
import {loadDetailContext,createDetailSession,nextDetailCard,saveDetailRating,detailSummary} from '../lib/detail-reviews.mjs';
import {registerDetailSubmission} from '../lib/detail-registration.mjs';
import {loadGeometry} from '../lib/glb.mjs';
import {renderLocal} from '../lib/details.mjs';
import {readJSON,writeJSON} from '../lib/io.mjs';
import {startServer} from '../lib/server.mjs';
import {exportTask} from '../lib/prepare.mjs';

let root,results,legacyBytes,server,url;
const arcade='calibration-arcade-v1',rotunda='calibration-rotunda-v1',reflector='calibration-reflector-v1';
const report=(task,variant)=>readJSON(join(root,'reports',task+'--'+variant,'report.json'));
before(async()=>{
  root=await mkdtemp(join(tmpdir(),'evidence3d-examples-'));
  await buildDetailCalibration(root);legacyBytes=await readFile(join(root,'detail-index.json'));
  results=await buildAdditionalExamples(root);
  ({server,url}=await startServer({dataRoot:root,port:0}));
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
test('three new examples have independently successful defect controls',()=>{
  assert.equal(results.length,3);assert.equal(results.reduce((n,r)=>n+r.submissions,0),27);
  assert.ok(results.every(r=>r.passed));
  assert.equal(results.reduce((n,r)=>n+r.scoreable_cards,0),18);
});
test('new examples preserve the original facade index and default context',async()=>{
  assert.deepEqual(await readFile(join(root,'detail-index.json')),legacyBytes);
  assert.equal((await loadDetailContext(root)).task.id,'calibration-facade-v1');
  const ids=(await listDetailExamples(root)).map(e=>e.task_id);
  assert.deepEqual(ids,['calibration-facade-v1',arcade,rotunda,reflector]);
});
test('arch openings are actual through-holes rather than colored panels',async()=>{
  const reference=await loadGeometry(join(root,'submissions',arcade+'--reference','model.glb'));
  const filled=await loadGeometry(join(root,'submissions',arcade+'--filled-opening','model.glb'));
  const view={origin:[-4.5,2,0],right:[1,0,0],up:[0,1,0],extent:[-.05,.05,-.05,.05],resolution:32,depth_range:[-1,1]};
  assert.equal(renderLocal(reference.coordinates,view).mask.reduce((n,v)=>n+v,0),0);
  assert.equal(renderLocal(filled.coordinates,view).mask.reduce((n,v)=>n+v,0),1024);
  assert.equal((await report(arcade,'filled-opening')).detail_geometry.cards.find(c=>c.id==='opening-0').auto_checks_pass,false);
});
test('column loss is detected despite overlapping front and rear projections',async()=>{
  const result=await report(rotunda,'missing-column'),view=result.detail_geometry.cards.find(c=>c.id==='front-column').views[0];
  assert.equal(view.iou,1);assert.ok(view.depth_outlier_fraction>.4);assert.equal(view.pass,false);
});
test('a denser dome is accepted while a coarse eight-sided dome fails',async()=>{
  const dense=(await report(rotunda,'dense-dome')).detail_geometry.cards.find(c=>c.id==='dome');
  const coarse=(await report(rotunda,'coarse-dome')).detail_geometry.cards.find(c=>c.id==='dome');
  assert.equal(dense.auto_checks_pass,true);assert.equal(coarse.auto_checks_pass,false);
  assert.ok(coarse.views[0].normal_mean_deg>dense.views[0].normal_mean_deg);
});
test('rear-only defects are invisible in front but visible in the declared rear camera',async()=>{
  const result=await report(reflector,'missing-rear-rib');
  const front=result.detail_geometry.cards.find(c=>c.id==='dish').views.find(v=>v.id==='front');
  const rear=result.detail_geometry.cards.find(c=>c.id==='upper-rib').views.find(v=>v.id==='rear');
  assert.equal(front.pass,true);assert.equal(front.depth_mean_m,0);
  assert.equal(rear.pass,false);assert.ok(rear.depth_outlier_fraction>.04);
});
test('all added known defects retain the reference envelope',async()=>{
  for(const definition of EXAMPLE_DEFINITIONS){
    const base=await report(definition.id,'reference');
    for(const variant of definition.variants.filter(v=>v.kind==='defect')){
      const result=await report(definition.id,variant.id);
      for(const key of ['min','max'])for(let i=0;i<3;i++)assert.ok(Math.abs(result.technical.bounds[key][i]-base.technical.bounds[key][i])<1e-5);
    }
  }
});
test('task-specific HTTP overview and previews never fall back to the facade',async()=>{
  const response=await fetch(url+'/api/detail-overview?task='+reflector),body=await response.json();
  assert.equal(response.status,200);assert.equal(body.task.id,reflector);assert.equal(body.cards.filter(c=>c.scoreable).length,6);
  const preview=await fetch(url+'/api/detail-preview/'+reflector+'--reference/model?task='+reflector);
  assert.equal(preview.status,200);
  assert.equal((await fetch(url+'/api/detail-preview/'+reflector+'--reference/model?task='+arcade)).status,404);
  assert.equal((await fetch(url+'/api/detail-overview?task=unknown-task')).status,400);
});
test('one reviewer has independent resumable sessions for different example tasks',async()=>{
  const a=await createDetailSession(root,{reviewer:'multi-example-test',mode:'practice',task_id:arcade});
  const b=await createDetailSession(root,{reviewer:'multi-example-test',mode:'practice',task_id:reflector});
  assert.notEqual(a.id,b.id);assert.equal(a.reviewer_hash,b.reviewer_hash);
  const next=await nextDetailCard(root,a.id);
  await saveDetailRating(root,a.id,{item_id:next.item_id,score:2,notes:'unit test only'});
  assert.equal((await createDetailSession(root,{reviewer:'multi-example-test',mode:'practice',task_id:arcade})).id,a.id);
  assert.equal((await nextDetailCard(root,a.id)).progress.done,1);
  assert.equal((await nextDetailCard(root,b.id)).progress.done,0);
  assert.equal((await nextDetailCard(root,b.id)).frame.max[1],7.62);
  assert.equal((await detailSummary(root,arcade)).practice_ratings,1);
  assert.equal((await detailSummary(root,reflector)).practice_ratings,0);
  assert.equal((await detailSummary(root)).practice_ratings,0);
});
test('blind detail payloads expose the selected task and no candidate condition',async()=>{
  const session=await createDetailSession(root,{reviewer:'blind-reflector-test',mode:'practice',task_id:reflector});
  const next=await nextDetailCard(root,session.id);
  assert.equal(next.task_id,reflector);assert.equal(next.progress.total,6);
  for(const field of ['missing-rear-rib','convex-dish','auto_checks_pass','submission_id'])assert.equal(JSON.stringify(next).includes(field),false);
});
test('public example packs contain complete parameters and no reference mesh',async()=>{
  const destination=join(root,'exported-arcade');
  await exportTask(join(root,'tasks',arcade,'task.json'),destination);
  const data=await readJSON(join(destination,'inputs','dimensions.json'));
  assert.equal(data.parts.find(p=>p.id==='arch-wall').openings.length,3);
  assert.equal(data.parts.filter(p=>p.id.startsWith('front-post-')).length,9);
  await assert.rejects(()=>readFile(join(destination,'reference.glb')),/ENOENT/);
});
test('registering a new example submission updates only that task registry',async()=>{
  const incoming=join(root,'incoming');await mkdir(incoming);
  const original=await readJSON(join(root,'submissions',arcade+'--reference','submission.json'));
  await writeFile(join(incoming,'model.glb'),await readFile(join(root,'submissions',arcade+'--reference','model.glb')));
  await writeJSON(join(incoming,'submission.json'),{...original,id:'arcade-external-test'});
  const facadeHash=(await loadDetailContext(root)).registry_sha256,arcadeContext=await loadDetailContext(root,arcade);
  await registerDetailSubmission(root,join(incoming,'submission.json'),'unit-test external');
  assert.equal((await loadDetailContext(root)).registry_sha256,facadeHash);
  assert.equal((await loadDetailContext(root,arcade)).experiment_sha256,arcadeContext.experiment_sha256);
  assert.equal((await loadDetailContext(root,arcade)).index.entries.length,10);
  await buildAdditionalExample(root,EXAMPLE_DEFINITIONS.find(d=>d.id===arcade));
  assert.ok((await loadDetailContext(root,arcade)).index.entries.some(e=>e.submission_id==='arcade-external-test'));
});
test('catalogue traversal or duplicate task ids are rejected',async()=>{
  const path=join(root,'detail-examples.json'),original=await readFile(path),catalog=JSON.parse(original);
  try {
    catalog.examples[0].index_path='../outside.json';await writeJSON(path,catalog);
    await assert.rejects(()=>listDetailExamples(root),/Invalid detail example/);
  }finally{await writeFile(path,original);}
});
