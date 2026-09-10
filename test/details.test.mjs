import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildCalibration} from '../lib/fixtures.mjs';
import {buildDetailCalibration,DETAIL_TASK,facadeScene} from '../lib/detail-fixtures.mjs';
import {validateDetailSet,renderLocal,localMetrics,aggregateDetailScores} from '../lib/details.mjs';
import {loadDetailContext,createDetailSession,nextDetailCard,saveDetailRating,readDetailRatings,summarizeDetailRatings} from '../lib/detail-reviews.mjs';
import {startServer} from '../lib/server.mjs';
import {readJSON,writeJSON,objectHash} from '../lib/io.mjs';
import {sceneToGLB,parseGLB,neutralGLB,loadGeometry} from '../lib/glb.mjs';
import {prepareDetailDrafts} from '../lib/detail-drafts.mjs';
import {registerDetailSubmission} from '../lib/detail-registration.mjs';

let root,calibration,context,server,url;
before(async()=>{
  root=await mkdtemp(join(tmpdir(),'evidence3d-details-'));await buildCalibration(root);
  calibration=await buildDetailCalibration(root);context=await loadDetailContext(root);
  ({server,url}=await startServer({dataRoot:root,port:0}));
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
const report=id=>readJSON(join(root,'reports',DETAIL_TASK+'--'+id,'report.json'));
const front={id:'front',right:[1,0,0],up:[0,1,0],origin:[0,0,0],extent:[-1,1,-1,1],resolution:32,depth_range:[-1,2]};
const plane=(depth=0,slope=0)=>new Float64Array([-1,-1,depth-slope,1,-1,depth+slope,1,1,depth+slope,
  -1,-1,depth-slope,1,1,depth+slope,-1,1,depth-slope]);
const post=(path,payload)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});

test('detail fixtures detect all eight defects while keeping overall bounds unchanged',()=>{
  assert.equal(calibration.passed,true);assert.equal(calibration.checks.length,15);
  assert.equal(calibration.submissions,12);assert.equal(calibration.scoreable_cards,10);assert.equal(calibration.excluded_cards,1);
});
test('one missing mullion defeats whole-object silhouettes but is detected locally',async()=>{
  const result=await report('missing-mullion'),card=result.detail_geometry.cards.find(c=>c.id==='window-0');
  assert.ok(result.metrics.max_dimension_error<1e-6);assert.equal(result.metrics.min_silhouette_iou,1);
  assert.deepEqual(result.technical.bounds,(await report('reference')).technical.bounds);
  assert.equal(card.auto_checks_pass,false);
  // Independently count pixels in the removed vertical bar, excluding the
  // surviving horizontal crossbar. This is not a triangle-rasterizer oracle.
  const view=context.set.cards.find(c=>c.id==='window-0').views[0],n=view.resolution;
  let expectedPixels=0;
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const u=view.extent[0]+(x+.5)/n*(view.extent[1]-view.extent[0]);
    const v=view.extent[3]-(y+.5)/n*(view.extent[3]-view.extent[2]);
    if(Math.abs(u)<.07&&Math.abs(v)>.07&&Math.abs(v)<1.22)expectedPixels++;
  }
  assert.ok(expectedPixels>0);
  assert.ok(Math.abs(card.views[0].depth_outlier_fraction-expectedPixels/(n*n))<1e-9);
  assert.equal(card.views[0].iou,1);
  assert.equal(result.detail_geometry.cards.find(c=>c.id==='window-1').auto_checks_pass,true);
});
test('missing complete window produces larger local deviation than one missing mullion',async()=>{
  const get=async id=>(await report(id)).detail_geometry.cards.find(c=>c.id==='window-0').views[0].depth_outlier_fraction;
  assert.ok(await get('missing-window')>await get('missing-mullion'));
});
test('local depth measures physical distance independent of masks',()=>{
  const a=renderLocal(plane(1),front),b=renderLocal(plane(0),front),m=localMetrics(a,b,.015);
  assert.equal(m.iou,1);assert.equal(m.depth_mean_m,1);assert.equal(m.depth_p95_m,1);
  assert.equal(m.depth_outlier_fraction,1);assert.equal(m.normal_mean_deg,0);
});
test('published input specifies the fine depths measured by the evaluator',async()=>{
  const source=await readJSON(join(root,'tasks',DETAIL_TASK,'inputs','dimensions.json'));
  const geometry=await loadGeometry(join(root,'private',DETAIL_TASK,'reference.glb'));
  const w=source.windows[0],pane=w.pane,bar=w.mullions.parts[0],tooth=source.cornice;
  const probes=[
    {point:[w.center[0]+.6,w.center[1]+.6],depth:w.center[2]+pane.center_offset[2]+pane.size[2]/2},
    {point:[w.center[0],w.center[1]+.6],depth:w.center[2]+bar.center_offset[2]+bar.size[2]/2},
    {point:tooth.first_dentil_center.slice(0,2),depth:tooth.first_dentil_center[2]+tooth.dentil_size[2]/2}
  ];
  for(const probe of probes) {
    const view={...front,origin:[...probe.point,0],extent:[-.002,.002,-.002,.002]};
    const sampled=renderLocal(geometry.coordinates,view);
    assert.ok(sampled.depth.every(depth=>Math.abs(depth-probe.depth)<1e-5));
  }
  assert.equal(source.rose.bars.angles_deg.length,4);assert.equal(source.arch.angular_segments,40);
});
test('z-buffer selects the closest surface, not triangle traversal order',()=>{
  const a=renderLocal(new Float64Array([...plane(1),...plane(0)]),front);
  const b=renderLocal(new Float64Array([...plane(0),...plane(1)]),front);
  assert.deepEqual(a.depth,b.depth);assert.ok(a.depth.every(d=>d===1));
});
test('geometric normals measure independently known plane tilt',()=>{
  const metrics=localMetrics(renderLocal(plane(0,.5),front),renderLocal(plane(0),front));
  assert.ok(Math.abs(metrics.normal_mean_deg-Math.atan(.5)*180/Math.PI)<1e-4);
});
test('curator visibility masks exclude only predetermined regions',()=>{
  const view={...front,ignore_rects:[[0,0,.5,1]]},a=renderLocal(plane(0),view);
  assert.equal(a.mask.reduce((n,v)=>n+v,0),512);
  assert.throws(()=>localMetrics(renderLocal(plane(),{...front,ignore_rects:[[0,0,1,1]]}),renderLocal(plane(),{...front,ignore_rects:[[0,0,1,1]]})),/Empty reference/);
});
test('color, label and equivalent indexing do not change any automatic detail values',async()=>{
  const base=(await report('reference')).detail_geometry;
  for(const id of ['material-change','renamed','nonindexed'])assert.deepEqual((await report(id)).detail_geometry,base);
});
test('color-preserving review assets retain PBR colors without identity metadata',()=>{
  const reference=sceneToGLB(facadeScene()),changed=sceneToGLB(facadeScene('material-change'));
  const a=parseGLB(neutralGLB(reference,{preserveMaterials:true})).json;
  const b=parseGLB(neutralGLB(changed,{preserveMaterials:true})).json;
  assert.notDeepEqual(a.materials[0].pbrMetallicRoughness.baseColorFactor,b.materials[0].pbrMetallicRoughness.baseColorFactor);
  assert.equal(a.nodes.some(n=>n.name||n.extras),false);assert.equal(a.asset.generator,undefined);
  assert.deepEqual(parseGLB(neutralGLB(reference)).json.materials,parseGLB(neutralGLB(changed)).json.materials);
});
test('detail cards reject source drift, unreviewed real truth, bad crops and invalid exclusions',()=>{
  const set=structuredClone(context.set);set.cards[0].source_ids=['unknown'];
  assert.throws(()=>validateDetailSet(set,context.task),/Unknown detail source/);
  set.cards[0].source_ids=['source-1'];set.cards[0].views[0].extent=[1,-1,-1,1];
  assert.throws(()=>validateDetailSet(set,context.task),/range/);
  set.cards[0].views[0]=context.set.cards[0].views[0];set.cards.at(-1).exclusion_reason='';
  assert.throws(()=>validateDetailSet(set,context.task),/Excluded details/);
  const task={...context.task,split:'development',status:'annotation_pending'};
  set.task_sha256=objectHash(task);
  assert.throws(()=>validateDetailSet(set,task),/independently admitted/);
});
test('category weights prevent many easy windows from overwhelming an ornamental failure',()=>{
  const scores=Object.fromEntries(context.set.cards.filter(c=>c.scoreable).map(c=>[c.id,c.id==='rose'?0:4]));
  assert.equal(aggregateDetailScores(context.set,scores).score,75);
  const more=structuredClone(context.set);
  for(let i=0;i<30;i++){const id='extra-window-'+i;more.cards.push({...more.cards[0],id});scores[id]=4;}
  assert.equal(aggregateDetailScores(more,scores).score,75);
});
test('unrated required cards cannot receive reallocated weight, while zero is a valid rating',()=>{
  const scores=Object.fromEntries(context.set.cards.filter(c=>c.scoreable).map(c=>[c.id,0]));
  assert.equal(aggregateDetailScores(context.set,scores).score,0);
  delete scores.rose;
  const result=aggregateDetailScores(context.set,scores);
  assert.equal(result.score,null);assert.equal(result.coverage,.9);assert.deepEqual(result.missing_card_ids,['rose']);
});
function humanRows(values=[3,3,3]){
  const rows=[];
  for(const card of context.set.cards.filter(c=>c.scoreable))values.forEach((score,i)=>rows.push({
    mode:'human',experiment_sha256:context.experiment_sha256,card_set_sha256:objectHash(context.set),
    submission_id:'candidate-unit-test',artifact_sha256:'test-only',reviewer_hash:'reviewer-'+i,card_id:card.id,
    score,insufficient_evidence:false
  }));
  return rows;
}
test('three independent consistent raters form a category-balanced provisional total',()=>{
  const summary=summarizeDetailRatings(humanRows([2,3,3]),context.set,context.experiment_sha256);
  assert.equal(summary.human_ratings,30);assert.equal(summary.independent_reviewers,3);
  assert.ok(Math.abs(summary.results[0].score-100*2/3)<1e-8);
});
test('major disagreement and evidence disputes block a detail total',()=>{
  const rows=humanRows();rows.find(r=>r.card_id==='rose').score=0;
  let result=summarizeDetailRatings(rows,context.set,context.experiment_sha256).results[0];
  assert.equal(result.score,null);assert.equal(result.cards.find(c=>c.id==='rose').status,'needs_adjudication');
  const unknown=humanRows();unknown[0].score=null;unknown[0].insufficient_evidence=true;
  result=summarizeDetailRatings(unknown,context.set,context.experiment_sha256).results[0];assert.equal(result.score,null);
});
test('practice, old card revisions and duplicate reviewers do not manufacture consensus',()=>{
  const rows=humanRows([4,4]);
  rows.push({...rows[0]});rows.push({...rows[0],reviewer_hash:'practice',mode:'practice'});
  rows.push({...rows[0],reviewer_hash:'stale',card_set_sha256:'wrong'});
  const result=summarizeDetailRatings(rows,context.set,context.experiment_sha256);
  assert.equal(result.human_ratings,20);assert.equal(result.independent_reviewers,2);
  assert.equal(result.results[0].score,null);assert.equal(result.practice_ratings,1);
});
test('blind detail API exposes rubric and cameras, not candidate labels or automatic scores',async()=>{
  const response=await post('/api/detail-reviews/start',{reviewer:'api-blind-practice',mode:'practice'});
  const next=await response.json();assert.equal(response.status,200);assert.equal(next.progress.total,10);
  for(const secret of ['missing-mullion','submission_id','auto_checks_pass','depth_mean_m','artifact_sha256'])assert.equal(JSON.stringify(next).includes(secret),false);
  const glb=Buffer.from(await (await fetch(url+next.candidate)).arrayBuffer());
  assert.equal(parseGLB(glb).json.nodes.some(n=>n.name||n.extras),false);
});
test('practice detail rating persists zero, resumes, and rejects a duplicate',async()=>{
  const session=await createDetailSession(root,{reviewer:'zero-practice',mode:'practice'});
  const next=await nextDetailCard(root,session.id);
  await saveDetailRating(root,session.id,{item_id:next.item_id,score:0,insufficient_evidence:false,notes:'automated test, not human evidence'});
  assert.equal((await nextDetailCard(root,session.id)).progress.done,1);
  assert.equal((await createDetailSession(root,{reviewer:'zero-practice',mode:'practice'})).id,session.id);
  await assert.rejects(()=>saveDetailRating(root,session.id,{item_id:next.item_id,score:0,notes:''}),/already rated/);
  assert.equal(summarizeDetailRatings(await readDetailRatings(root),context.set,context.experiment_sha256).human_ratings,0);
});
test('rating input rejects arbitrary floats, score strings and unexplained uncertainty',async()=>{
  const session=await createDetailSession(root,{reviewer:'validation-practice',mode:'practice'}),next=await nextDetailCard(root,session.id);
  for(const score of ['4',4.1,-1,5,null])await assert.rejects(()=>saveDetailRating(root,session.id,{item_id:next.item_id,score,notes:''}),/Choose an integer/);
  await assert.rejects(()=>saveDetailRating(root,session.id,{item_id:next.item_id,score:null,insufficient_evidence:true,notes:''}),/资料不足/);
});
test('concurrent ratings cannot double-count a detail card',async()=>{
  const session=await createDetailSession(root,{reviewer:'concurrent-detail',mode:'practice'}),next=await nextDetailCard(root,session.id);
  const payload={item_id:next.item_id,score:2,notes:'automated test'};
  const results=await Promise.allSettled([saveDetailRating(root,session.id,payload),saveDetailRating(root,session.id,payload)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('a completed reviewer can move to another candidate without inventing another identity',async()=>{
  const session=await createDetailSession(root,{reviewer:'full-detail-practice',mode:'practice'});
  for(let i=0;i<10;i++){
    const next=await nextDetailCard(root,session.id);
    await saveDetailRating(root,session.id,{item_id:next.item_id,score:3,notes:'test-only practice'});
  }
  const complete=await nextDetailCard(root,session.id);assert.equal(complete.complete,true);assert.equal(complete.individual_detail.score,75);
  const another=await createDetailSession(root,{reviewer:'full-detail-practice',mode:'practice',new_round:true});
  assert.notEqual(another.submission_id,session.submission_id);assert.equal(another.reviewer_hash,session.reviewer_hash);
});
test('real-world detail drafts preserve reviewer edits and do not become scoring truth',async()=>{
  const task={...context.task,id:'draft-building',split:'development',status:'annotation_pending'},dir=join(root,'tasks',task.id);
  await mkdir(dir,{recursive:true});await writeJSON(join(dir,'task.json'),task);
  const catalog=join(root,'draft-catalog.json');
  await writeJSON(catalog,{cases:[{task_id:task.id,source_id:'source-1',source_limit:'occluded photo',
    cards:[['window','Window','windows',[.1,.2,.4,.6],'Verify visible frame only']]}]});
  await prepareDetailDrafts(root,catalog);
  const path=join(root,'annotations','details-'+task.id+'.json'),draft=await readJSON(path);
  assert.equal(draft.cards[0].scoreable,false);assert.equal(draft.cards[0].world_camera,null);assert.deepEqual(draft.reviewers,[]);
  draft.cards[0].notes='independent reviewer work in progress';await writeJSON(path,draft);
  await prepareDetailDrafts(root,catalog);
  assert.equal((await readJSON(path)).cards[0].notes,'independent reviewer work in progress');
});
test('source and artifact tampering block detail ratings',async()=>{
  const session=await createDetailSession(root,{reviewer:'drift-detail',mode:'practice'}),next=await nextDetailCard(root,session.id);
  const path=join(root,'tasks',DETAIL_TASK,'inputs','dimensions.json'),old=await readFile(path);
  try{
    await writeFile(path,'tampered');
    await assert.rejects(()=>saveDetailRating(root,session.id,{item_id:next.item_id,score:4,notes:''}),/Input lock/);
  }finally{await writeFile(path,old);}
  const asset=session.assets[session.candidate_asset],file=join(root,asset.path),before=await readFile(file);
  try{
    await writeFile(file,'broken');
    assert.equal((await fetch(url+next.candidate)).status,400);
    await assert.rejects(()=>saveDetailRating(root,session.id,{item_id:next.item_id,score:4,notes:''}),/asset changed/);
  }finally{await writeFile(file,before);}
});
test('visual fidelity and aesthetic preference create separate experiments',async()=>{
  const a=await (await post('/api/reviews/start',{reviewer:'criterion-practice',mode:'practice',criterion:'appearance_fidelity'})).json();
  const b=await (await post('/api/reviews/start',{reviewer:'criterion-practice',mode:'practice',criterion:'aesthetic_preference'})).json();
  assert.notEqual(a.session_id,b.session_id);assert.match(a.question,/忠实/);assert.match(b.question,/审美/);
  assert.match(a.a,/style=material/);
});
test('new detail submissions enter review without losing existing reviewer context',async()=>{
  const source=join(root,'incoming');await mkdir(source);
  const original=await readJSON(join(root,'submissions',DETAIL_TASK+'--reference','submission.json'));
  const bytes=await readFile(join(root,'submissions',DETAIL_TASK+'--reference','model.glb'));
  await writeFile(join(source,'candidate.glb'),bytes);
  const submission={...original,id:'external-candidate-unit-test',artifact:{...original.artifact,path:'candidate.glb'},
    system:{name:'External unit test',model_version:'not-real-model',harness_version:'test'}};
  const path=join(source,'submission.json');await writeJSON(path,submission);
  const priorHash=(await loadDetailContext(root)).experiment_sha256;
  const result=await registerDetailSubmission(root,path,'External unit test');
  assert.equal(result.registered,true);assert.equal(result.auto_passed_cards,10);assert.equal(result.manual_detail_score,null);
  assert.equal((await loadDetailContext(root)).experiment_sha256,priorHash);
  await assert.rejects(()=>registerDetailSubmission(root,path),/already registered/);
  await buildDetailCalibration(root);
  assert.ok((await readJSON(join(root,'detail-index.json'))).entries.some(e=>e.submission_id===submission.id));
});
