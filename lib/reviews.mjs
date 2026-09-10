import { randomUUID } from 'node:crypto';
import { readFile, readdir, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJSON, writeJSON, sha256, objectHash } from './io.mjs';

export const CHOICES = ['a','b','tie','both_bad','insufficient_evidence'];
const PAIR_VARIANTS = [
  ['reference','width-10'], ['reference','material-change'], ['missing-feature','width-10'],
  ['mirrored','front-only'], ['reference','missing-feature']
];
const SESSION_ID = /^[0-9a-f-]{36}$/;

export async function readVotes(dataRoot) {
  let text;
  try { text = await readFile(join(dataRoot,'reviews','votes.jsonl'),'utf8'); }
  catch(error) { if(error.code === 'ENOENT') return []; throw error; }
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export async function createReviewSession(dataRoot, {reviewer, mode = 'practice'}) {
  if (typeof reviewer !== 'string' || reviewer.trim().length < 2 || reviewer.trim().length > 64) throw new Error('请填写 2–64 个字符的评审昵称');
  if (!['practice','human'].includes(mode)) throw new Error('Invalid review mode');
  const folder = join(dataRoot,'reviews','sessions');
  await mkdir(folder,{recursive:true});
  const reviewerHash = sha256(reviewer.trim().normalize('NFKC'));
  const index = await readJSON(join(dataRoot,'run-index.json'));
  const experimentHash = objectHash(index);
  for (const file of await readdir(folder)) {
    if (!file.endsWith('.json')) continue;
    const existing = await readJSON(join(folder,file));
    if (existing.reviewer_hash === reviewerHash && existing.mode === mode && existing.experiment_sha256 === experimentHash) return existing;
  }
  const session = { schema_version:1, id:randomUUID(), reviewer_hash:reviewerHash, mode,
    experiment_sha256:experimentHash, created_at:new Date().toISOString(), ballots:[], assets:{} };
  for (const task of index.tasks) {
    const truth = await readJSON(join(dataRoot,'private',task.id,'truth.json'));
    const taskDocument = await readJSON(join(dataRoot,'tasks',task.id,'task.json'));
    function asset(submissionId) {
      const id = randomUUID();
      if (submissionId) {
        const submission = index.entries.find(e => e.id === submissionId);
        if (!submission) throw new Error('Pair references absent submission');
        session.assets[id] = { path: join('submissions',submissionId,'model.glb'),
          sha256: null };
      } else session.assets[id] = { path:join('private',task.id,truth.reference.path), sha256:truth.reference.sha256 };
      return id;
    }
    for (const names of PAIR_VARIANTS) {
      const ids = names.map(n => task.id + '--' + n);
      const submissions = await Promise.all(ids.map(id => readJSON(join(dataRoot,'submissions',id,'submission.json'))));
      const keys = submissions.map(s => s.artifact.sha256);
      // Canonical left/right are geometry artifact identities, never presentation position.
      const order = [0,1].sort((a,b) => keys[a].localeCompare(keys[b]));
      const canonicalIds = order.map(i => ids[i]), canonicalHashes = order.map(i => keys[i]);
      const pairId = sha256(task.id + ':' + canonicalHashes.join(':')).slice(0,24);
      const swapped = parseInt(sha256(session.id + ':' + pairId).slice(0,2),16)%2 === 1;
      const a = asset(canonicalIds[swapped ? 1 : 0]), b = asset(canonicalIds[swapped ? 0 : 1]), reference = asset(null);
      session.assets[a].sha256 = canonicalHashes[swapped ? 1 : 0];
      session.assets[b].sha256 = canonicalHashes[swapped ? 0 : 1];
      session.ballots.push({ id:randomUUID(), pair_id:pairId, task_id:task.id, title:task.title,
        task_sha256:objectHash(taskDocument), canonical_ids:canonicalIds, canonical_hashes:canonicalHashes,
        swapped, assets:{a,b,reference}, frame:{min:truth.bounds.min,max:truth.bounds.max}, is_probe:false });
    }
  }
  // Balance sequence per reviewer, then repeat one pair with reversed presentation.
  session.ballots.sort((a,b)=>sha256(session.id+a.id).localeCompare(sha256(session.id+b.id)));
  const first = session.ballots[0];
  session.ballots.push({...first, id:randomUUID(), swapped:!first.swapped,
    assets:{...first.assets,a:first.assets.b,b:first.assets.a}, is_probe:true});
  await writeJSON(join(folder,session.id+'.json'),session);
  return session;
}

export async function loadSession(dataRoot,id) {
  if(!SESSION_ID.test(id)) throw new Error('Invalid session id');
  return readJSON(join(dataRoot,'reviews','sessions',id+'.json'));
}
export async function nextBallot(dataRoot,id) {
  const session = await loadSession(dataRoot,id), votes = await readVotes(dataRoot);
  const done = new Set(votes.filter(v=>v.session_id===id).map(v=>v.ballot_id));
  const ballot = session.ballots.find(b=>!done.has(b.id));
  const progress = {done:done.size,total:session.ballots.length};
  if(!ballot) return {session_id:id,mode:session.mode,complete:true,progress};
  const url = asset => '/api/reviews/'+id+'/assets/'+asset;
  return {
    session_id:id,mode:session.mode,complete:false,progress,ballot_id:ballot.id,title:ballot.title,
    a:url(ballot.assets.a),b:url(ballot.assets.b),reference:url(ballot.assets.reference),frame:ballot.frame,
    question:'只看几何与空间结构，哪个模型更忠实于参考？忽略颜色和渲染风格。'
  };
}
let writeQueue = Promise.resolve();
export function saveVote(dataRoot,sessionId,payload) {
  const operation = writeQueue.then(async()=>{
    if(!CHOICES.includes(payload.choice)) throw new Error('Invalid vote choice');
    if(typeof payload.notes !== 'string' || payload.notes.length>1600) throw new Error('Notes must be at most 1600 characters');
    const session = await loadSession(dataRoot,sessionId), next = await nextBallot(dataRoot,sessionId);
    if(next.complete || next.ballot_id !== payload.ballot_id) throw new Error('Ballot already voted or is not current');
    const ballot = session.ballots.find(b=>b.id===payload.ballot_id);
    for(const assetId of Object.values(ballot.assets)) {
      const asset = session.assets[assetId];
      if(sha256(await readFile(join(dataRoot,asset.path)))!==asset.sha256) throw new Error('Review asset changed after session creation');
    }
    const canonical = payload.choice === 'a' ? (ballot.swapped?'right':'left') :
      payload.choice === 'b' ? (ballot.swapped?'left':'right') : payload.choice;
    const vote = {
      schema_version:1,session_id:sessionId,ballot_id:ballot.id,reviewer_hash:session.reviewer_hash,
      mode:session.mode,experiment_sha256:session.experiment_sha256,task_id:ballot.task_id,
      task_sha256:ballot.task_sha256,pair_id:ballot.pair_id,artifact_hashes:ballot.canonical_hashes,
      candidate_ids:ballot.canonical_ids,choice:canonical,presentation_choice:payload.choice,
      swapped:ballot.swapped,is_probe:ballot.is_probe,notes:payload.notes,submitted_at:new Date().toISOString()
    };
    await mkdir(join(dataRoot,'reviews'),{recursive:true});
    await appendFile(join(dataRoot,'reviews','votes.jsonl'),JSON.stringify(vote)+'\n');
    return {saved:true,next:await nextBallot(dataRoot,sessionId)};
  });
  writeQueue = operation.catch(()=>{});
  return operation;
}

export function wilson(wins,n) {
  if(!n) return null;
  const z=1.959963984540054,p=wins/n,den=1+z*z/n;
  const center=(p+z*z/(2*n))/den,half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den;
  return [Math.max(0,center-half),Math.min(1,center+half)];
}
export function summarizeVotes(votes) {
  const real = votes.filter(v=>v.mode==='human');
  const groups = new Map(), seen = new Set();
  for(const vote of real.filter(v=>!v.is_probe)) {
    const key = vote.experiment_sha256+':'+vote.pair_id;
    const unique = key+':'+vote.reviewer_hash;
    if(seen.has(unique)) continue;
    seen.add(unique);
    if(!groups.has(key)) groups.set(key,{pair_id:vote.pair_id,task_id:vote.task_id,experiment_sha256:vote.experiment_sha256,
      candidate_ids:vote.candidate_ids,left:0,right:0,tie:0,both_bad:0,insufficient_evidence:0,reviewers:0});
    const group = groups.get(key); group[vote.choice]++; group.reviewers++;
  }
  const pairs = [...groups.values()].map(group=>{
    const n=group.left+group.right;
    return {...group,decisive_votes:n,left_win_rate:n?group.left/n:null,
      decisive_wilson95:wilson(group.left,n),status:group.reviewers>=3?'provisional':'insufficient_reviewers'};
  });
  const probes = real.filter(v=>v.is_probe).map(probe=>{
    const original=real.find(v=>!v.is_probe&&v.session_id===probe.session_id&&v.pair_id===probe.pair_id);
    return original?{same:original.choice===probe.choice}:null;
  }).filter(Boolean);
  return {
    human_ballots:seen.size,independent_reviewers:new Set(real.filter(v=>!v.is_probe).map(v=>v.reviewer_hash)).size,
    practice_ballots:votes.filter(v=>v.mode==='practice').length,pairs,
    order_probe:{count:probes.length,agreement:probes.length?probes.filter(p=>p.same).length/probes.length:null},
    model_judge_status:'shadow_only_not_used',overall_ranking:null,
    note:'Pairwise intervals describe decisive votes only. Ties, both-bad and insufficient-evidence votes are reported separately. Calibration cases are not unseen test data.'
  };
}
