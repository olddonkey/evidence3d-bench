import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { buildCalibration } from '../lib/fixtures.mjs';
import { startServer } from '../lib/server.mjs';
import { createReviewSession, nextBallot, saveVote, loadSession, readVotes, summarizeVotes, wilson } from '../lib/reviews.mjs';
import { parseGLB } from '../lib/glb.mjs';

let root,server,url;
before(async()=>{root=await mkdtemp(join(tmpdir(),'evidence3d-reviews-'));await buildCalibration(root);({server,url}=await startServer({dataRoot:root,port:0}));});
after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
const post=(path,payload,headers={})=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(payload)});
test('local application starts and publishes real calibration results',async()=>{
  const html=await (await fetch(url)).text();assert.match(html,/Evidence3D/);
  const overview=await (await fetch(url+'/api/overview')).json();assert.equal(overview.calibration.passed,true);assert.equal(overview.human.human_ballots,0);
});
test('private labels, truth files and arbitrary source files are never mounted',async()=>{
  for(const path of ['/private/calibration-chapel/truth.json','/.local/private/calibration-chapel/reference.glb','/lib/reviews.mjs','/api/reviews/sessions','/.git/config'])
    assert.equal((await fetch(url+path)).status,404,path);
});
test('cross-origin writes and foreign Host headers are rejected',async()=>{
  assert.equal((await post('/api/reviews/start',{reviewer:'attacker',mode:'practice'},{Origin:'https://example.invalid'})).status,403);
  const status=await new Promise((resolve,reject)=>{
    const req=request(url+'/api/overview',{headers:{Host:'example.invalid'}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(status,403);
});
test('a ballot hides conditions, system identities and side mappings',async()=>{
  const response=await post('/api/reviews/start',{reviewer:'test-blind',mode:'practice'}),data=await response.json();
  assert.equal(response.status,200);assert.equal(data.progress.total,11);
  const text=JSON.stringify(data);
  for(const forbidden of ['canonical_ids','width-10','swapped','reference.glb','missing-feature','artifact_sha256'])assert.equal(text.includes(forbidden),false);
  const bytes=Buffer.from(await (await fetch(url+data.a)).arrayBuffer()),parsed=parseGLB(bytes);
  assert.equal(parsed.json.nodes.some(n=>n.name||n.extras),false);
});
test('same reviewer and experiment resume the same session',async()=>{
  const a=await createReviewSession(root,{reviewer:'resume-reviewer',mode:'practice'});
  const b=await createReviewSession(root,{reviewer:'resume-reviewer',mode:'practice'});assert.equal(a.id,b.id);
});
test('practice votes persist, advance and never count as human judgment',async()=>{
  const session=await createReviewSession(root,{reviewer:'practice-roundtrip',mode:'practice'});
  const ballot=await nextBallot(root,session.id);
  await saveVote(root,session.id,{ballot_id:ballot.ballot_id,choice:'tie',notes:'automated test; not human evidence'});
  const next=await nextBallot(root,session.id);assert.equal(next.progress.done,1);assert.notEqual(next.ballot_id,ballot.ballot_id);
  const summary=summarizeVotes(await readVotes(root));assert.equal(summary.human_ballots,0);assert.ok(summary.practice_ballots>=1);
  await assert.rejects(()=>saveVote(root,session.id,{ballot_id:ballot.ballot_id,choice:'a',notes:''}),/already voted/);
});
test('concurrent duplicate votes cannot create two observations',async()=>{
  const session=await createReviewSession(root,{reviewer:'concurrent-reviewer',mode:'practice'});
  const ballot=await nextBallot(root,session.id),payload={ballot_id:ballot.ballot_id,choice:'a',notes:''};
  const results=await Promise.allSettled([saveVote(root,session.id,payload),saveVote(root,session.id,payload)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await readVotes(root)).filter(v=>v.ballot_id===ballot.ballot_id).length,1);
});
test('a complete practice session contains a reversed presentation probe',async()=>{
  const session=await createReviewSession(root,{reviewer:'complete-reviewer',mode:'practice'});
  assert.equal(session.ballots.at(-1).is_probe,true);
  const original=session.ballots[0],probe=session.ballots.at(-1);
  assert.equal(probe.pair_id,original.pair_id);assert.notEqual(probe.swapped,original.swapped);
  assert.equal(probe.assets.a,original.assets.b);
  for(let i=0;i<session.ballots.length;i++){
    const next=await nextBallot(root,session.id);
    await saveVote(root,session.id,{ballot_id:next.ballot_id,choice:'insufficient_evidence',notes:'automated test'});
  }
  const complete=await nextBallot(root,session.id);assert.equal(complete.complete,true);assert.equal(complete.progress.done,11);
  assert.equal(summarizeVotes(await readVotes(root)).human_ballots,0);
});
test('artifact changes after assignment block serving and voting',async()=>{
  const session=await createReviewSession(root,{reviewer:'tamper-reviewer',mode:'practice'}),next=await nextBallot(root,session.id);
  const asset=session.assets[session.ballots[0].assets.a],path=join(root,asset.path),old=await readFile(path);
  try {
    await writeFile(path,Buffer.from('altered'));
    assert.equal((await fetch(url+next.a)).status,400);
    await assert.rejects(()=>saveVote(root,session.id,{ballot_id:next.ballot_id,choice:'a',notes:''}),/asset changed/);
  } finally {await writeFile(path,old);}
});
test('human summary keeps nondecisive categories separate and deduplicates reviewers',()=>{
  const base={mode:'human',experiment_sha256:'experiment',task_id:'task',pair_id:'pair',candidate_ids:['left-model','right-model'],session_id:'session',is_probe:false};
  const votes=[
    {...base,reviewer_hash:'one',choice:'left'},
    {...base,reviewer_hash:'one',choice:'left'},
    {...base,reviewer_hash:'two',choice:'tie'},
    {...base,reviewer_hash:'three',choice:'both_bad'},
    {...base,reviewer_hash:'four',choice:'insufficient_evidence'},
    {...base,reviewer_hash:'practice',choice:'left',mode:'practice'}
  ];
  const summary=summarizeVotes(votes),pair=summary.pairs[0];
  assert.equal(summary.human_ballots,4);
  assert.equal(pair.reviewers,4);assert.equal(pair.decisive_votes,1);assert.equal(pair.left_win_rate,1);
  assert.equal(pair.tie,1);assert.equal(pair.both_bad,1);assert.equal(pair.insufficient_evidence,1);
  assert.ok(pair.decisive_wilson95[0]<0.3);assert.equal(summary.overall_ranking,null);
});
test('order probes are excluded from preference estimates and report disagreement',()=>{
  const base={mode:'human',experiment_sha256:'experiment',task_id:'task',pair_id:'pair',candidate_ids:['l','r'],session_id:'s',reviewer_hash:'one'};
  const summary=summarizeVotes([{...base,is_probe:false,choice:'left'},{...base,is_probe:true,choice:'right'}]);
  assert.equal(summary.pairs[0].reviewers,1);assert.equal(summary.order_probe.agreement,0);assert.equal(summary.pairs[0].status,'insufficient_reviewers');
});
test('Wilson intervals handle no votes and bound small samples',()=>{
  assert.equal(wilson(0,0),null);assert.ok(wilson(1,1)[0]<.21);assert.equal(wilson(1,1)[1],1);
});
