import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { objectHash } from './io.mjs';
import { maskMetrics, overlaySVG } from './metrics.mjs';

export const DETAIL_PROTOCOL='evidence3d-detail-geometry-v0.1.0';
const ajv=new Ajv({allErrors:true,strict:true});
const schema=ajv.compile(JSON.parse(readFileSync(new URL('../schemas/detail-set.schema.json',import.meta.url))));
const dot=(a,b)=>a.reduce((s,n,i)=>s+n*b[i],0);
export const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];

export function validateDetailSet(set,task) {
  if(!schema(set))throw new Error('Detail card schema: '+ajv.errorsText(schema.errors));
  if(set.task_id!==task.id||set.task_sha256!==objectHash(task))throw new Error('Detail cards belong to a different task revision');
  if(task.status==='annotation_pending')throw new Error('Detail cards have not been independently admitted');
  if(task.split==='calibration') {
    if(set.status!=='calibration_only'||set.provenance.kind!=='analytic_fixture')throw new Error('Calibration details need an analytic reference');
  } else if(set.status!=='admitted'||set.provenance.kind!=='independent_review'||new Set(set.provenance.reviewers||[]).size<2) {
    throw new Error('Real detail cards require independent review');
  }
  const categories=new Set(set.categories.map(c=>c.id)),ids=new Set(),sources=new Set(task.inputs.map(i=>i.id));
  if(categories.size!==set.categories.length)throw new Error('Duplicate detail categories');
  for(const card of set.cards) {
    if(ids.has(card.id)||!categories.has(card.category))throw new Error('Duplicate card or unknown category');
    ids.add(card.id);
    if(card.scoreable&&(!card.views.length||!card.source_ids.length||!card.requirements.length))throw new Error('Scoreable details need sources, requirements and fixed views');
    if(!card.scoreable&&(!card.exclusion_reason||card.views.length))throw new Error('Excluded details need an explicit reason and no scoring views');
    if(card.source_ids.some(id=>!sources.has(id)))throw new Error('Unknown detail source id');
    if(new Set(card.views.map(v=>v.id)).size!==card.views.length)throw new Error('Duplicate local view id');
    for(const view of card.views) {
      if(Math.abs(dot(view.right,view.right)-1)>1e-6||Math.abs(dot(view.up,view.up)-1)>1e-6||Math.abs(dot(view.right,view.up))>1e-6)throw new Error('Local camera basis must be orthonormal');
      if(view.extent[0]>=view.extent[1]||view.extent[2]>=view.extent[3]||view.depth_range[0]>=view.depth_range[1])throw new Error('Invalid local camera range');
      for(const rect of view.ignore_rects||[])if(rect[0]>=rect[2]||rect[1]>=rect[3])throw new Error('Invalid fixed visibility mask');
    }
  }
  for(const category of categories)if(!set.cards.some(c=>c.category===category&&c.scoreable))throw new Error('Each weighted category needs a scoreable card');
  return set;
}

// Software z-buffer in a curator-fixed orthographic camera. All scene triangles
// participate; no candidate names or candidate-chosen crops select geometry.
export function renderLocal(coordinates,view) {
  const n=view.resolution,count=n*n,mask=new Uint8Array(count),depth=new Float64Array(count).fill(-Infinity);
  const normals=new Float32Array(count*3),valid=new Uint8Array(count).fill(1),forward=cross(view.right,view.up);
  const u=new Float64Array(3),v=new Float64Array(3),z=new Float64Array(3);
  const [minU,maxU,minV,maxV]=view.extent;
  for(const rect of view.ignore_rects||[])for(let y=0;y<n;y++)for(let x=0;x<n;x++) {
    if((x+.5)/n>=rect[0]&&(x+.5)/n<=rect[2]&&(y+.5)/n>=rect[1]&&(y+.5)/n<=rect[3])valid[y*n+x]=0;
  }
  for(let at=0;at<coordinates.length;at+=9) {
    for(let j=0;j<3;j++) {
      const p=at+j*3,x=coordinates[p]-view.origin[0],y=coordinates[p+1]-view.origin[1],w=coordinates[p+2]-view.origin[2];
      u[j]=((x*view.right[0]+y*view.right[1]+w*view.right[2])-minU)/(maxU-minU)*n;
      v[j]=(maxV-(x*view.up[0]+y*view.up[1]+w*view.up[2]))/(maxV-minV)*n;
      z[j]=x*forward[0]+y*forward[1]+w*forward[2];
    }
    const den=(v[1]-v[2])*(u[0]-u[2])+(u[2]-u[1])*(v[0]-v[2]);
    if(Math.abs(den)<1e-12)continue;
    const ab=[0,1,2].map(i=>coordinates[at+3+i]-coordinates[at+i]),ac=[0,1,2].map(i=>coordinates[at+6+i]-coordinates[at+i]);
    const normal=cross(ab,ac),length=Math.hypot(...normal);
    if(length<1e-12)continue;
    const sign=dot(normal,forward)<0?-1:1;
    for(let k=0;k<3;k++)normal[k]=normal[k]/length*sign;
    const x0=Math.max(0,Math.ceil(Math.min(...u)-.5)),x1=Math.min(n-1,Math.floor(Math.max(...u)-.5));
    const y0=Math.max(0,Math.ceil(Math.min(...v)-.5)),y1=Math.min(n-1,Math.floor(Math.max(...v)-.5));
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++) {
      const index=y*n+x;if(!valid[index])continue;
      const a=((v[1]-v[2])*(x+.5-u[2])+(u[2]-u[1])*(y+.5-v[2]))/den;
      const b=((v[2]-v[0])*(x+.5-u[2])+(u[0]-u[2])*(y+.5-v[2]))/den;
      if(a< -1e-9||b< -1e-9||a+b>1+1e-9)continue;
      const d=a*z[0]+b*z[1]+(1-a-b)*z[2];
      if(d>depth[index]+1e-10){mask[index]=1;depth[index]=d;normals.set(normal,index*3);}
    }
  }
  return {mask,depth,normals,valid,resolution:n};
}
export function localMetrics(candidate,reference,pixelTolerance=.015) {
  const silhouette=maskMetrics(candidate.mask,reference.mask),errors=[],normalErrors=[];
  let missing=0;
  for(let i=0;i<reference.mask.length;i++) {
    if(reference.mask[i]&&!candidate.mask[i])missing++;
    if(!reference.mask[i]||!candidate.mask[i])continue;
    errors.push(Math.abs(candidate.depth[i]-reference.depth[i]));
    let cosine=0,cn=0,rn=0;
    for(let k=0;k<3;k++){cosine+=candidate.normals[i*3+k]*reference.normals[i*3+k];cn+=candidate.normals[i*3+k]**2;rn+=reference.normals[i*3+k]**2;}
    cosine/=Math.sqrt(cn*rn);
    normalErrors.push(Math.acos(Math.max(-1,Math.min(1,cosine)))*180/Math.PI);
  }
  errors.sort((a,b)=>a-b);
  return {...silhouette,compared_pixels:errors.length,missing_reference_pixels:missing,
    depth_mean_m:errors.length?errors.reduce((a,b)=>a+b,0)/errors.length:null,
    depth_p95_m:errors.length?errors[Math.max(0,Math.ceil(errors.length*.95)-1)]:null,
    depth_outlier_fraction:errors.length?errors.filter(e=>e>pixelTolerance).length/errors.length:null,
    normal_mean_deg:normalErrors.length?normalErrors.reduce((a,b)=>a+b,0)/normalErrors.length:null};
}
function paletteSVG(colors,n) {
  const paths=[];
  for(let y=0;y<n;y++)for(let x=0;x<n;) {
    const color=colors[y*n+x];let end=x+1;
    while(end<n&&colors[y*n+end]===color)end++;
    if(color)paths.push('<path fill="'+color+'" d="M'+x+' '+y+'h'+(end-x)+'v1H'+x+'z"/>');
    x=end;
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+n+' '+n+'" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#101c2b"/>'+paths.join('')+'</svg>';
}
const hex=n=>Math.round(n).toString(16).padStart(2,'0');
export function depthSVG(render,range) {
  return paletteSVG(Array.from(render.mask,(filled,i)=>{
    if(!filled)return null;
    const t=Math.round(Math.max(0,Math.min(1,(render.depth[i]-range[0])/(range[1]-range[0])))*31)/31;
    const shade=45+t*195;return '#'+hex(shade*.72)+hex(shade*.9)+hex(shade);
  }),render.resolution);
}
export function normalSVG(render) {
  return paletteSVG(Array.from(render.mask,(filled,i)=>filled?'#'+[0,1,2].map(k=>hex(Math.round((render.normals[i*3+k]+1)*.5*15)*17)).join(''):null),render.resolution);
}
export function depthDifferenceSVG(candidate,reference,scale) {
  return paletteSVG(Array.from(reference.mask,(_,i)=>{
    if(!reference.mask[i]&&!candidate.mask[i])return null;
    if(reference.mask[i]!==candidate.mask[i])return '#d28cdb';
    const t=Math.round(Math.max(0,Math.min(1,Math.abs(candidate.depth[i]-reference.depth[i])/scale))*15)/15;
    return '#'+hex(24+215*t)+hex(47+104*t)+hex(65+40*t);
  }),reference.resolution);
}
export async function evaluateDetails(candidate,reference,set,task,outputDir) {
  validateDetailSet(set,task);
  if(set.reference_sha256!==reference.artifact_sha256)throw new Error('Detail reference hash mismatch');
  const cards=[];
  if(outputDir)await mkdir(outputDir,{recursive:true});
  for(const card of set.cards) {
    if(!card.scoreable){cards.push({id:card.id,title:card.title,category:card.category,scoreable:false,reason:card.exclusion_reason,views:[]});continue;}
    const views=[];
    for(const view of card.views) {
      const expected=renderLocal(reference.coordinates,view),actual=renderLocal(candidate.coordinates,view),m=localMetrics(actual,expected,card.thresholds.depth_pixel_tolerance_m);
      const t=card.thresholds,pass=m.iou>=t.iou_min&&m.depth_mean_m!==null&&m.depth_mean_m<=t.depth_mean_m_max&&
        m.depth_p95_m<=t.depth_p95_m_max&&m.normal_mean_deg<=t.normal_mean_deg_max&&m.depth_outlier_fraction<=t.depth_outlier_fraction_max;
      const prefix='detail-'+card.id+'-'+view.id,diffScale=t.depth_p95_m_max*4;
      const artifacts=outputDir?{
        reference_depth:prefix+'-reference.svg',candidate_depth:prefix+'-candidate.svg',
        depth_difference:prefix+'-difference.svg',reference_normal:prefix+'-reference-normal.svg',
        candidate_normal:prefix+'-candidate-normal.svg',coverage:prefix+'-coverage.svg'
      }:null;
      if(outputDir) {
        const values=[depthSVG(expected,view.depth_range),depthSVG(actual,view.depth_range),depthDifferenceSVG(actual,expected,diffScale),
          normalSVG(expected),normalSVG(actual),overlaySVG(actual.mask,expected.mask,view.resolution)];
        for(const [i,file] of Object.values(artifacts).entries())await writeFile(join(outputDir,file),values[i]);
      }
      views.push({id:view.id,...m,pass,depth_difference_scale_m:diffScale,artifacts});
    }
    cards.push({id:card.id,title:card.title,category:card.category,scoreable:true,auto_checks_pass:views.every(v=>v.pass),views});
  }
  return {protocol:DETAIL_PROTOCOL,card_set_sha256:objectHash(set),manual_detail_score:null,
    model_judge_used:false,scoreable_cards:cards.filter(c=>c.scoreable).length,
    auto_passed_cards:cards.filter(c=>c.scoreable&&c.auto_checks_pass).length,cards,
    limitations:['Local first-visible surfaces only; hidden and internal geometry remain unmeasured.',
      'Geometric normals face the camera; this is not a winding or watertightness test.',
      'Automatic checks are diagnostics, not the human 0–4 rubric score.']};
}

// No missing-rating reweighting. A category retains its predefined contribution.
export function aggregateDetailScores(set,scores) {
  const eligible=set.cards.filter(c=>c.scoreable),categories=[];
  const missing=eligible.filter(c=>!Number.isFinite(scores[c.id])||scores[c.id]<0||scores[c.id]>4).map(c=>c.id);
  for(const category of set.categories) {
    const cards=eligible.filter(c=>c.category===category.id),weight=cards.reduce((sum,c)=>sum+c.weight,0);
    const complete=cards.every(c=>!missing.includes(c.id));
    categories.push({id:category.id,title:category.title,weight:category.weight,complete,
      score:complete?100*cards.reduce((sum,c)=>sum+c.weight*scores[c.id]/4,0)/weight:null});
  }
  return {score:missing.length?null:categories.reduce((sum,c)=>sum+c.weight*c.score,0)/categories.reduce((s,c)=>s+c.weight,0),
    coverage:eligible.length?(eligible.length-missing.length)/eligible.length:0,missing_card_ids:missing,categories};
}
