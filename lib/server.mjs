import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, existingContained, sha256 } from './io.mjs';
import { neutralGLB } from './glb.mjs';
import { createReviewSession, loadSession, nextBallot, saveVote, readVotes, summarizeVotes } from './reviews.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const THREE = dirname(fileURLToPath(import.meta.resolve('three')));
const TYPES = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.glb':'model/gltf-binary'};
const VALID_ID = /^[a-z0-9][a-z0-9-]{1,119}$/;
const json = (response,status,value)=>{response.writeHead(status,{'Content-Type':TYPES['.json'],'Cache-Control':'no-store'});response.end(JSON.stringify(value));};
async function body(request) {
  if(!request.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json');
  let bytes=0,result='';
  for await (const chunk of request) {bytes+=chunk.length;if(bytes>8192) throw new Error('Request body too large');result+=chunk;}
  return JSON.parse(result);
}
async function optionalJSON(path,fallback) {
  try {return await readJSON(path);} catch(e) {if(e.code==='ENOENT')return fallback;throw e;}
}
export async function overview(dataRoot) {
  const calibration = await optionalJSON(join(dataRoot,'calibration.json'),null);
  const index = await optionalJSON(join(dataRoot,'run-index.json'),{tasks:[],entries:[]});
  const real = await optionalJSON(join(dataRoot,'prepared-tasks.json'),{tasks:[]});
  const reports=[];
  for(const entry of index.entries) reports.push({...entry,report:await readJSON(join(dataRoot,'reports',entry.id,'report.json'))});
  const taskIds=[...index.tasks,...real.tasks];
  const tasks=[];
  for(const item of taskIds) {
    const task=await readJSON(join(dataRoot,'tasks',item.id,'task.json'));
    tasks.push({...task,inputs:task.inputs.map(input=>({...input,url:'/api/tasks/'+task.id+'/inputs/'+input.id}))});
  }
  return {calibration,reports,tasks,human:summarizeVotes(await readVotes(dataRoot))};
}
export async function startServer({dataRoot,port=5198,host='127.0.0.1'}) {
  if(!['127.0.0.1','localhost'].includes(host)) throw new Error('This prototype is local-only');
  const server=createServer(async(request,response)=>{
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; object-src 'none'");
    try {
      const expectedHost=server.address()?.address==='127.0.0.1'?'127.0.0.1':'localhost';
      const acceptedHosts=new Set(['127.0.0.1:'+server.address().port,'localhost:'+server.address().port]);
      if(!acceptedHosts.has(request.headers.host)) return json(response,403,{error:'Local host required'});
      const url=new URL(request.url,'http://'+request.headers.host),path=url.pathname;
      if(request.method==='POST') {
        const origin=request.headers.origin;
        if(origin&&origin!=='http://'+request.headers.host) return json(response,403,{error:'Cross-origin writes are not allowed'});
        const payload=await body(request);
        if(path==='/api/reviews/start') {
          const session=await createReviewSession(dataRoot,payload);
          return json(response,200,await nextBallot(dataRoot,session.id));
        }
        const voteMatch=path.match(/^\/api\/reviews\/([0-9a-f-]{36})\/vote$/);
        if(voteMatch) return json(response,200,await saveVote(dataRoot,voteMatch[1],payload));
        return json(response,404,{error:'Not found'});
      }
      if(request.method!=='GET') return json(response,405,{error:'Method not allowed'});
      if(path==='/api/overview') return json(response,200,await overview(dataRoot));
      if(path==='/api/human-summary') return json(response,200,summarizeVotes(await readVotes(dataRoot)));
      const next=path.match(/^\/api\/reviews\/([0-9a-f-]{36})\/next$/);
      if(next) return json(response,200,await nextBallot(dataRoot,next[1]));
      let bytes,type;
      const asset=path.match(/^\/api\/reviews\/([0-9a-f-]{36})\/assets\/([0-9a-f-]{36})$/);
      const input=path.match(/^\/api\/tasks\/([a-z0-9-]+)\/inputs\/([a-z0-9-]+)$/);
      const overlay=path.match(/^\/api\/overlays\/([a-z0-9-]+)\/([a-z0-9-]+\.svg)$/);
      if(asset) {
        const session=await loadSession(dataRoot,asset[1]),item=session.assets[asset[2]];
        if(!item) return json(response,404,{error:'Unknown review asset'});
        const original=await readFile(await existingContained(dataRoot,item.path));
        if(sha256(original)!==item.sha256) throw new Error('Review asset hash changed');
        bytes=neutralGLB(original);type=TYPES['.glb'];
      } else if(input) {
        const task=await readJSON(join(dataRoot,'tasks',input[1],'task.json')),item=task.inputs.find(i=>i.id===input[2]);
        if(!item) return json(response,404,{error:'Unknown input'});
        bytes=await readFile(await existingContained(join(dataRoot,'tasks',task.id),item.path));
        if(sha256(bytes)!==item.sha256) throw new Error('Source hash changed');
        type=TYPES[extname(item.path)]||'application/octet-stream';
      } else if(overlay) {
        if(!VALID_ID.test(overlay[1])||!/^overlay-[a-z-]+\.svg$/.test(overlay[2])) return json(response,404,{error:'Not found'});
        bytes=await readFile(await existingContained(join(dataRoot,'reports'),overlay[1]+'/'+overlay[2]));type=TYPES['.svg'];
      } else if(path==='/vendor/three.module.js'||path==='/vendor/three.core.js') {
        bytes=await readFile(join(THREE,path.split('/').at(-1)));type=TYPES['.js'];
      } else if(path.startsWith('/vendor/addons/')&&path.endsWith('.js')) {
        bytes=await readFile(await existingContained(join(THREE,'..','examples','jsm'),path.slice('/vendor/addons/'.length)));type=TYPES['.js'];
      } else {
        const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/viewer.js':'viewer.js'};
        if(!files[path]) return json(response,404,{error:'Not found'});
        bytes=await readFile(join(REPO,'site',files[path]));type=TYPES[extname(files[path])];
      }
      response.writeHead(200,{'Content-Type':type,'Content-Length':bytes.length,'Cache-Control':'no-store'});response.end(bytes);
    } catch(error) {json(response,error.code==='ENOENT'?404:400,{error:error.message});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  return {server,url:'http://127.0.0.1:'+server.address().port};
}
