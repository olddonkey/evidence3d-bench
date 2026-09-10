import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {EXAMPLE_DEFINITIONS,exampleScene} from './example-scenes.mjs';
import {sceneToGLB,geometryFromBytes} from './glb.mjs';
import {taskDefaults} from './fixtures.mjs';
import {validateTask} from './contracts.mjs';
import {makeViews} from './metrics.mjs';
import {validateDetailSet,DETAIL_PROTOCOL,renderLocal,depthSVG,cross} from './details.mjs';
import {evaluate} from './evaluate.mjs';
import {objectHash,sha256,writeJSON} from './io.mjs';
import {optionalJSON,publishExample} from './detail-catalog.mjs';

const bases={
  front:{right:[1,0,0],up:[0,1,0]},
  oblique:{right:[Math.cos(Math.PI/6),0,-.5],up:[0,1,0]},
  rear:{right:[-1,0,0],up:[0,1,0]},
  'rear-oblique':{right:[-Math.cos(Math.PI/6),0,-.5],up:[0,1,0]},
  side:{right:[0,0,-1],up:[0,1,0]},
  left:{right:[0,0,1],up:[0,1,0]},
  top:{right:[1,0,0],up:[0,0,-1]}
};
const dot=(a,b)=>a.reduce((s,n,i)=>s+n*b[i],0);
export function exampleCards(definition,task,referenceHash) {
  const cards=definition.cards.map(c=>{
    const views=c.directions.map(id=>{
      const {right,up}=bases[id],forward=cross(right,up),depths=[];
      for(let n=0;n<8;n++)depths.push(dot([0,1,2].map(i=>definition.bounds[(n>>i)&1?'max':'min'][i]-c.center[i]),forward));
      return {id,right,up,origin:c.center,extent:[-c.width*.57,c.width*.57,-c.height*.57,c.height*.57],
        resolution:144,depth_range:[Math.min(...depths)-.2,Math.max(...depths)+.2]};
    });
    return {id:c.id,title:c.title,category:c.category,weight:1,scoreable:true,source_ids:['source-1','source-2'],
      requirements:c.requirements,anchors:[
        c.title+'缺失或完全错误',
        '只有粗略占位，卡片要求的主要形态或连接未还原',
        '主要构件存在，但至少一项数量、曲率、位置、孔洞或厚度要求明显不符',
        '卡片主要要求满足，仅有次要偏差',
        '满足卡片中所有有资料支持的形态、数量、布局和连接要求'
      ],views,thresholds:{iou_min:.98,depth_mean_m_max:.008,depth_p95_m_max:.04,normal_mean_deg_max:2.5,
        depth_pixel_tolerance_m:.02,depth_outlier_fraction_max:.015}};
  });
  return validateDetailSet({schema_version:1,id:definition.id+'-cards',task_id:task.id,task_sha256:objectHash(task),
    status:'calibration_only',reference_sha256:referenceHash,
    provenance:{kind:'analytic_fixture',evidence:['Input declares complete primitive parameters and placements; reference bounds are independently enumerated.']},
    categories:definition.categories,cards},task);
}
export async function buildAdditionalExample(dataRoot,definition) {
  const taskDir=join(dataRoot,'tasks',definition.id),privateDir=join(dataRoot,'private',definition.id);
  const indexPath=join(dataRoot,'detail-indices',definition.id+'.json');
  const referenceBytes=sceneToGLB(exampleScene(definition)),reference=await geometryFromBytes(referenceBytes);
  for(const key of ['min','max'])for(let i=0;i<3;i++)if(Math.abs(reference.bounds[key][i]-definition.bounds[key][i])>1e-5) {
    throw new Error(definition.id+' analytic bounds mismatch: '+JSON.stringify(reference.bounds));
  }
  const views=makeViews(definition.bounds);
  const front={...views[0],depth_range:[definition.bounds.min[2]-views[0].origin[2],definition.bounds.max[2]-views[0].origin[2]]};
  const source=Buffer.from(JSON.stringify({
    unit:'metre',frame:{x:'right',y:'up',z:'front',origin:[0,0,0]},description:definition.description,
    primitive_semantics:{
      box:'size XYZ; position is centre; Euler rotation in radians, XYZ order',
      cylinder:'axis Y before rotation; radius is upper radius; radius_bottom defaults to radius',
      torus:'major circle lies in XY before rotation; radius is major radius, tube is minor radius',
      lathe:'profile pairs are radius,Y; revolve around Y through a full circle',
      beam:'circular rod from start to end; radius and axial segment count are supplied',
      'arch-wall':'rectangular wall spans +/-width/2 and Y=0..height; openings pass entirely through; each opening is rectangular up to spring_y plus a semicircular top',
      'arch-ring':'upper semicircular annular band extruded from local Z=0 to depth',
      paraboloid:'local XY disc of radius r; front Z=curvature*(X*X+Y*Y); rear surface is thickness behind front; radial ring and angular counts are supplied'
    },parts:definition.parts
  },null,2)+'\n');
  const elevation=Buffer.from(depthSVG(renderLocal(reference.coordinates,front),front.depth_range));
  const task=validateTask({...taskDefaults(),id:definition.id,title:definition.title,split:'calibration',status:'calibration_only',
    prompt:'Reconstruct the analytic object from the complete primitive data in dimensions.json and the front reference image. Preserve actual openings, curved profiles and all declared supports. Use the specified metric glTF frame. This is a public calibration example, not an unseen real-world benchmark.',
    inputs:[['dimensions.json',source],['elevation.svg',elevation]].map(([name,bytes],i)=>({id:'source-'+(i+1),path:'inputs/'+name,
      sha256:sha256(bytes),bytes:bytes.length,role:'synthetic_reference',source:'Analytic example parameters v1',captured_at:null,rights:'generated_calibration'})),
    rights:'generated_calibration'});
  const set=exampleCards(definition,task,sha256(referenceBytes)),cardBytes=Buffer.from(JSON.stringify(set,null,2)+'\n');
  const previous=await optionalJSON(indexPath),registered=previous?.entries.filter(e=>e.source==='submitted')||[];
  let human=false;
  try{human=(await readFile(join(dataRoot,'detail-reviews','ratings.jsonl'),'utf8')).split('\n').filter(Boolean).some(line=>{const r=JSON.parse(line);return r.mode==='human'&&r.task_id===task.id;});}
  catch(e){if(e.code!=='ENOENT')throw e;}
  if((registered.length||human)&&(previous?.task_sha256!==objectHash(task)||previous?.card_set_sha256!==objectHash(set)))throw new Error('Example has registered submissions or human ratings; use a new version');
  await mkdir(join(taskDir,'inputs'),{recursive:true});await mkdir(privateDir,{recursive:true});
  await writeFile(join(taskDir,'inputs','dimensions.json'),source);await writeFile(join(taskDir,'inputs','elevation.svg'),elevation);
  await writeJSON(join(taskDir,'task.json'),task);await writeFile(join(privateDir,'reference.glb'),referenceBytes);
  await writeFile(join(privateDir,'detail-cards.json'),cardBytes);
  const truth={schema_version:1,task_id:task.id,task_sha256:objectHash(task),
    provenance:{kind:'analytic_fixture',source:'Complete primitive input and independently specified envelope.'},
    reference:{path:'reference.glb',sha256:sha256(referenceBytes)},bounds:definition.bounds,
    dimension_tolerance_m:.01,center_tolerance_m:.01,silhouette_pass_iou:.985,views,
    detail_cards:{path:'detail-cards.json',sha256:sha256(cardBytes)}};
  await writeJSON(join(privateDir,'truth.json'),truth);
  const entries=[],reports={};
  for(const variant of definition.variants) {
    const id=task.id+'--'+variant.id,folder=join(dataRoot,'submissions',id),bytes=sceneToGLB(exampleScene(definition,variant.id));
    await mkdir(folder,{recursive:true});await writeFile(join(folder,'model.glb'),bytes);
    await writeJSON(join(folder,'submission.json'),{schema_version:1,id,task_id:task.id,task_sha256:objectHash(task),
      artifact:{path:'model.glb',sha256:sha256(bytes)},system:{name:'Analytic example / '+variant.id,model_version:'not-an-AI-run',harness_version:'analytic-examples-v1'},
      run:{seed:0,wall_seconds:0,cost_usd:0,human_intervention:false,resource_accounting:'fixture'}});
    const report=await evaluate({taskPath:join(taskDir,'task.json'),submissionPath:join(folder,'submission.json'),
      truthPath:join(privateDir,'truth.json'),outputDir:join(dataRoot,'reports',id)});
    if(report.error)throw new Error(task.id+' / '+variant.id+': '+report.error);
    reports[variant.id]=report;entries.push({...variant,submission_id:id,task_id:task.id,artifact_sha256:sha256(bytes)});
  }
  const checks=[],add=(id,passed,description,evidence={})=>checks.push({id,passed,description,evidence});
  const base=reports.reference.detail_geometry;
  add('reference',base.auto_passed_cards===set.cards.length,'完整参考通过全部局部检查');
  for(const variant of definition.variants.filter(v=>v.kind==='invariance'))add(variant.id,
    JSON.stringify(reports[variant.id].detail_geometry)===JSON.stringify(base),'颜色、名称或等价表示不改变几何结果',{condition:variant.id});
  for(const variant of definition.variants.filter(v=>v.kind==='defect'||v.kind==='acceptable')){
    const card=reports[variant.id].detail_geometry.cards.find(c=>c.id===variant.target);
    add(variant.id,variant.kind==='defect'?!card.auto_checks_pass:card.auto_checks_pass,
      variant.kind==='defect'?'已知缺陷被对应卡片检出':'合理的曲面加密仍通过几何容差',
      {card_id:variant.target,views:card.views.map(v=>({id:v.id,iou:v.iou,outlier_fraction:v.depth_outlier_fraction,normal_mean_deg:v.normal_mean_deg}))});
  }
  const unchanged=definition.variants.filter(v=>v.kind==='defect').every(v=>['min','max'].every(key=>reports[v.id].technical.bounds[key].every((n,i)=>Math.abs(n-reports.reference.technical.bounds[key][i])<1e-5)));
  add('envelope',unchanged,'细节缺陷保持外部包围盒不变');
  if(definition.id==='calibration-reflector-v1'){
    const frontCard=reports['missing-rear-rib'].detail_geometry.cards.find(c=>c.id==='dish');
    add('front-occlusion',frontCard.views.find(v=>v.id==='front').pass,'正面无法检出被遮挡的背部缺陷；背面卡片负责检出');
  }
  const calibration={schema_version:1,protocol:DETAIL_PROTOCOL,task_id:task.id,passed:checks.every(c=>c.passed),checks,
    submissions:entries.length,scoreable_cards:set.cards.length,excluded_cards:0,scope:'Analytic known-defect example; not an AI generation result or human preference study.'};
  await writeJSON(indexPath,{schema_version:1,protocol:DETAIL_PROTOCOL,task_id:task.id,task_sha256:objectHash(task),
    card_set_sha256:objectHash(set),truth_sha256:objectHash(truth),entries:[...entries,...registered]});
  await writeJSON(join(dataRoot,'detail-calibrations',task.id+'.json'),calibration);
  await publishExample(dataRoot,{task_id:task.id,title:task.title,description:definition.description,focus:definition.focus,
    index_path:'detail-indices/'+task.id+'.json',calibration_path:'detail-calibrations/'+task.id+'.json'});
  return calibration;
}
export async function buildAdditionalExamples(dataRoot,onProgress=()=>{}) {
  const results=[];
  for(const definition of EXAMPLE_DEFINITIONS){const result=await buildAdditionalExample(dataRoot,definition);results.push(result);onProgress(result);}
  return results;
}
