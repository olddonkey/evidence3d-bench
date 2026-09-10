import { randomUUID } from 'node:crypto';
import { readFile,readdir,mkdir,appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJSON,writeJSON,objectHash,sha256,existingContained,verifySources } from './io.mjs';
import { validateDetailSet,aggregateDetailScores } from './details.mjs';
import { detailPaths } from './detail-catalog.mjs';

export async function loadDetailContext(dataRoot,taskId) {
  const paths=await detailPaths(dataRoot,taskId);
  const index=await readJSON(paths.indexPath);
  if(index.task_id!==paths.task_id)throw new Error('Detail index belongs to a different example');
  const task=await readJSON(join(dataRoot,'tasks',index.task_id,'task.json'));
  await verifySources(task,join(dataRoot,'tasks',index.task_id));
  const truth=await readJSON(join(dataRoot,'private',index.task_id,'truth.json'));
  if(objectHash(task)!==index.task_sha256||objectHash(truth)!==index.truth_sha256)throw new Error('Detail experiment task or truth revision changed');
  const path=await existingContained(join(dataRoot,'private',index.task_id),truth.detail_cards.path),bytes=await readFile(path);
  if(sha256(bytes)!==truth.detail_cards.sha256)throw new Error('Detail card file hash changed');
  const set=validateDetailSet(JSON.parse(bytes),task);
  if(objectHash(set)!==index.card_set_sha256)throw new Error('Detail card-set revision changed');
  const experiment_sha256=objectHash({protocol:index.protocol,task_sha256:index.task_sha256,
    truth_sha256:index.truth_sha256,card_set_sha256:index.card_set_sha256,review_protocol:'detail-rating-v1'});
  return {index,task,truth,set,experiment_sha256,registry_sha256:objectHash(index),...paths};
}
export async function readDetailRatings(dataRoot) {
  try{return (await readFile(join(dataRoot,'detail-reviews','ratings.jsonl'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
}
export async function createDetailSession(dataRoot,{reviewer,mode='practice',submission_id,new_round=false,task_id}) {
  if(typeof reviewer!=='string'||reviewer.trim().length<2||reviewer.trim().length>64)throw new Error('请填写 2–64 个字符的评审昵称');
  if(!['practice','human'].includes(mode))throw new Error('Invalid detail review mode');
  if(submission_id&&mode!=='practice')throw new Error('Independent reviewers cannot select an identified candidate');
  const context=await loadDetailContext(dataRoot,task_id),{index,set,task,truth,experiment_sha256}=context;
  const reviewerHash=sha256(reviewer.trim().normalize('NFKC')),folder=join(dataRoot,'detail-reviews','sessions');
  await mkdir(folder,{recursive:true});
  const ratings=await readDetailRatings(dataRoot),completed=new Set(),previous=[];
  for(const file of await readdir(folder)) {
    if(!file.endsWith('.json'))continue;
    const session=await readJSON(join(folder,file));
    if(session.reviewer_hash===reviewerHash&&session.mode===mode&&session.experiment_sha256===experiment_sha256) {
      const done=new Set(ratings.filter(r=>r.session_id===session.id).map(r=>r.item_id));
      if(done.size<session.cards.length&&(!submission_id||session.submission_id===submission_id))return session;
      if(done.size===session.cards.length){completed.add(session.submission_id);previous.push(session);}
    }
  }
  previous.sort((a,b)=>b.created_at.localeCompare(a.created_at));
  const prior=submission_id?previous.find(s=>s.submission_id===submission_id):previous[0];
  if(submission_id&&prior)return prior;
  if(prior&&!new_round)return prior;
  const pool=index.entries.filter(e=>!completed.has(e.submission_id));
  if(!pool.length&&previous.length)return previous[0];
  const entry=submission_id?index.entries.find(e=>e.submission_id===submission_id):
    pool[parseInt(sha256(reviewerHash+experiment_sha256+completed.size).slice(0,8),16)%pool.length];
  if(!entry)throw new Error('No eligible detail candidate');
  const artifact=await readJSON(join(dataRoot,'submissions',entry.submission_id,'submission.json'));
  if(artifact.artifact.sha256!==entry.artifact_sha256)throw new Error('Indexed detail artifact changed');
  const candidateId=randomUUID(),referenceId=randomUUID();
  const session={
    schema_version:1,id:randomUUID(),reviewer_hash:reviewerHash,mode,experiment_sha256,
    task_id:task.id,task_sha256:objectHash(task),card_set_sha256:objectHash(set),submission_id:entry.submission_id,
    artifact_sha256:entry.artifact_sha256,created_at:new Date().toISOString(),
    title:task.title,frame:truth.bounds,card_set:set,task_inputs:task.inputs,
    assets:{
      [candidateId]:{path:join('submissions',entry.submission_id,artifact.artifact.path),sha256:entry.artifact_sha256},
      [referenceId]:{path:join('private',task.id,truth.reference.path),sha256:truth.reference.sha256}
    },candidate_asset:candidateId,reference_asset:referenceId,
    cards:set.cards.filter(c=>c.scoreable).map(c=>({id:randomUUID(),card_id:c.id}))
  };
  await writeJSON(join(folder,session.id+'.json'),session);return session;
}
export async function loadDetailSession(dataRoot,id) {
  if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('Invalid detail session id');
  return readJSON(join(dataRoot,'detail-reviews','sessions',id+'.json'));
}
export async function nextDetailCard(dataRoot,id) {
  const session=await loadDetailSession(dataRoot,id),ratings=await readDetailRatings(dataRoot);
  const done=new Set(ratings.filter(r=>r.session_id===id).map(r=>r.item_id)),item=session.cards.find(c=>!done.has(c.id));
  const base={session_id:id,mode:session.mode,task_id:session.task_id,title:session.title,progress:{done:done.size,total:session.cards.length},complete:!item};
  if(!item) {
    const scores=Object.fromEntries(ratings.filter(r=>r.session_id===id&&!r.insufficient_evidence).map(r=>[r.card_id,r.score]));
    const context=await loadDetailContext(dataRoot,session.task_id),count=session.cards.length;
    const candidates=new Map();
    for(const r of ratings.filter(r=>r.reviewer_hash===session.reviewer_hash&&r.mode===session.mode&&r.experiment_sha256===session.experiment_sha256)){
      if(!candidates.has(r.submission_id))candidates.set(r.submission_id,new Set());candidates.get(r.submission_id).add(r.card_id);
    }
    const completed=[...candidates.values()].filter(ids=>ids.size===count).length;
    return {...base,individual_detail:aggregateDetailScores(session.card_set,scores),
      remaining_candidates:Math.max(0,context.index.entries.length-completed)};
  }
  const card=session.card_set.cards.find(c=>c.id===item.card_id),url=asset=>'/api/detail-reviews/'+id+'/assets/'+asset+'?style=material';
  // No condition labels, candidate identifiers, measured errors or auto-pass flags.
  return {...base,item_id:item.id,card:{id:card.id,title:card.title,category:card.category,requirements:card.requirements,anchors:card.anchors,views:card.views},
    frame:session.frame,candidate:url(session.candidate_asset),reference:url(session.reference_asset),
    evidence:card.source_ids.map(sourceId=>{const source=session.task_inputs.find(i=>i.id===sourceId);return {id:sourceId,role:source.role,
      url:'/api/tasks/'+session.task_id+'/inputs/'+sourceId};}),
    question:'依据参考资料，给这张卡片的几何细节还原打 0–4 分。颜色与审美不计入此分。'};
}
let queue=Promise.resolve();
export function saveDetailRating(dataRoot,sessionId,payload) {
  const operation=queue.then(async()=>{
    const unknown=payload.insufficient_evidence===true;
    if(unknown?payload.score!==null:!Number.isInteger(payload.score)||payload.score<0||payload.score>4)throw new Error('Choose an integer 0–4 or explicitly flag insufficient evidence');
    if(typeof payload.notes!=='string'||payload.notes.length>1600||(unknown&&!payload.notes.trim()))throw new Error('资料不足时请说明原因；记录最多 1600 字符');
    const session=await loadDetailSession(dataRoot,sessionId),next=await nextDetailCard(dataRoot,sessionId);
    if(next.complete||next.item_id!==payload.item_id)throw new Error('Detail card already rated or is not current');
    const context=await loadDetailContext(dataRoot,session.task_id);
    if(context.experiment_sha256!==session.experiment_sha256)throw new Error('Detail experiment changed; start a new session');
    for(const asset of Object.values(session.assets)) {
      if(sha256(await readFile(await existingContained(dataRoot,asset.path)))!==asset.sha256)throw new Error('Detail review asset changed');
    }
    const existing=await readDetailRatings(dataRoot);
    if(existing.some(r=>r.experiment_sha256===session.experiment_sha256&&r.reviewer_hash===session.reviewer_hash&&r.mode===session.mode&&
      r.submission_id===session.submission_id&&r.card_id===next.card.id))throw new Error('Reviewer already rated this detail');
    const rating={schema_version:1,session_id:sessionId,item_id:next.item_id,mode:session.mode,reviewer_hash:session.reviewer_hash,
      experiment_sha256:session.experiment_sha256,task_id:session.task_id,task_sha256:session.task_sha256,
      card_set_sha256:session.card_set_sha256,submission_id:session.submission_id,artifact_sha256:session.artifact_sha256,
      card_id:next.card.id,score:payload.score,insufficient_evidence:unknown,notes:payload.notes,submitted_at:new Date().toISOString()};
    await mkdir(join(dataRoot,'detail-reviews'),{recursive:true});
    await appendFile(join(dataRoot,'detail-reviews','ratings.jsonl'),JSON.stringify(rating)+'\n');
    return {saved:true,next:await nextDetailCard(dataRoot,sessionId)};
  });
  queue=operation.catch(()=>{});return operation;
}
export function summarizeDetailRatings(ratings,set,experimentHash,minReviewers=3) {
  const current=ratings.filter(r=>r.experiment_sha256===experimentHash);
  const human=current.filter(r=>r.mode==='human'&&r.card_set_sha256===objectHash(set)&&set.cards.some(c=>c.id===r.card_id&&c.scoreable)),
    seen=new Set(),candidates=new Map();
  for(const rating of human) {
    if(rating.card_set_sha256!==objectHash(set)||!set.cards.some(c=>c.id===rating.card_id&&c.scoreable))continue;
    const key=rating.submission_id+':'+rating.card_id+':'+rating.reviewer_hash;
    if(seen.has(key))continue;seen.add(key);
    if(!candidates.has(rating.submission_id))candidates.set(rating.submission_id,[]);
    candidates.get(rating.submission_id).push(rating);
  }
  const results=[];
  for(const [submissionId,items] of candidates) {
    const scores={},cards=[];
    for(const card of set.cards.filter(c=>c.scoreable)) {
      const rows=items.filter(r=>r.card_id===card.id),values=rows.filter(r=>Number.isInteger(r.score)&&!r.insufficient_evidence).map(r=>r.score);
      const insufficient=rows.filter(r=>r.insufficient_evidence).length;
      const mean=values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
      const disagreement=values.length?Math.max(...values)-Math.min(...values):null;
      const adjudicate=insufficient>0||disagreement>=2;
      const ready=values.length>=minReviewers&&!adjudicate;
      if(ready)scores[card.id]=mean;
      cards.push({id:card.id,title:card.title,reviewers:rows.length,mean,min:values.length?Math.min(...values):null,
        max:values.length?Math.max(...values):null,insufficient_evidence:insufficient,
        status:adjudicate?'needs_adjudication':ready?'provisional':'insufficient_reviewers'});
    }
    results.push({submission_id:submissionId,cards,...aggregateDetailScores(set,scores),status:'provisional_human_detail'});
  }
  return {human_ratings:seen.size,independent_reviewers:new Set(human.map(r=>r.reviewer_hash)).size,
    practice_ratings:current.filter(r=>r.mode==='practice').length,min_reviewers:minReviewers,results,model_judge_used:false,
    note:'Only fully covered, non-disputed cards with enough independent reviewers enter a provisional detail total. No model-wide ranking is produced.'};
}
export async function detailSummary(dataRoot,taskId) {
  const {set,experiment_sha256,task}=await loadDetailContext(dataRoot,taskId);
  return {task_id:task.id,task_title:task.title,...summarizeDetailRatings(await readDetailRatings(dataRoot),set,experiment_sha256)};
}
