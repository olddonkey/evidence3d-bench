import { Group,Mesh,BoxGeometry,Shape,ExtrudeGeometry,TorusGeometry,CylinderGeometry,MeshStandardMaterial } from 'three';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { objectHash,sha256,writeJSON,readJSON } from './io.mjs';
import { sceneToGLB,geometryFromBytes } from './glb.mjs';
import { taskDefaults } from './fixtures.mjs';
import { validateTask } from './contracts.mjs';
import { makeViews } from './metrics.mjs';
import { validateDetailSet,renderLocal,depthSVG,DETAIL_PROTOCOL } from './details.mjs';
import { evaluate } from './evaluate.mjs';

export const DETAIL_TASK='calibration-facade-v1';
export const FACADE_BOUNDS={min:[-9,0,-2],max:[9,12,3]};
export const DETAIL_VARIANTS=[
  {id:'reference',label:'完整细节',kind:'control'},
  {id:'material-change',label:'仅改变颜色',kind:'invariance'},
  {id:'renamed',label:'仅改名称',kind:'invariance'},
  {id:'nonindexed',label:'等价顶点表示',kind:'invariance'},
  {id:'missing-mullion',label:'缺少一根窗棂',kind:'defect'},
  {id:'missing-window',label:'缺少一扇窗',kind:'defect'},
  {id:'extra-window',label:'多造一扇窗',kind:'defect'},
  {id:'flat-window',label:'窗框与窗棂压平',kind:'defect'},
  {id:'shifted-window',label:'窗户错位 0.5 米',kind:'defect'},
  {id:'missing-tracery',label:'玫瑰窗缺内部框架',kind:'defect'},
  {id:'flat-arch',label:'拱门压平',kind:'defect'},
  {id:'floating-buttress',label:'扶壁悬空',kind:'defect'}
];
const WINDOWS=[[-4.5,4],[4.5,4],[-4.5,8.5],[4.5,8.5]];
const FRONT=2;
function material(color){return new MeshStandardMaterial({color,roughness:.75,metalness:0});}
function box(parent,id,size,position,mat){
  const mesh=new Mesh(new BoxGeometry(...size),mat);mesh.name=id;mesh.position.set(...position);parent.add(mesh);return mesh;
}
function archGeometry(outer,inner,depth){
  const shape=new Shape();shape.moveTo(outer,0);
  for(let i=1;i<=40;i++){const a=i/40*Math.PI;shape.lineTo(Math.cos(a)*outer,Math.sin(a)*outer);}
  for(let i=40;i>=0;i--){const a=i/40*Math.PI;shape.lineTo(Math.cos(a)*inner,Math.sin(a)*inner);}
  shape.closePath();return new ExtrudeGeometry(shape,{depth,bevelEnabled:false,curveSegments:40});
}
export function facadeScene(variant='reference') {
  const scene=new Group(),stone=material('#cfbea0'),trim=material('#eddfc7'),glass=material('#264a64'),wood=material('#754932');
  scene.name=variant;
  box(scene,'body',[18,12,4],[0,6,0],stone);
  function windowAt(x,y,index){
    const group=new Group();group.name='window-'+index;group.position.set(x,y,FRONT);scene.add(group);
    box(group,'pane',[2.5,2.5,.045],[0,0,.035],glass);
    box(group,'frame-left',[.18,2.8,.32],[-1.31,0,.18],trim);
    box(group,'frame-right',[.18,2.8,.32],[1.31,0,.18],trim);
    box(group,'frame-top',[2.8,.18,.32],[0,1.31,.18],trim);
    box(group,'frame-bottom',[2.8,.18,.32],[0,-1.31,.18],trim);
    box(group,'mullion-vertical',[.14,2.44,.22],[0,0,.16],trim);
    box(group,'mullion-horizontal',[2.44,.14,.22],[0,0,.16],trim);
    return group;
  }
  const windowGroups=WINDOWS.map(([x,y],i)=>windowAt(x,y,i));
  const door=new Group();door.name='door';scene.add(door);
  box(door,'door-panel',[2.55,4.2,.07],[0,2.1,2.06],wood);
  box(door,'door-left',[.22,4.3,.45],[-1.43,2.15,2.22],trim);
  box(door,'door-right',[.22,4.3,.45],[1.43,2.15,2.22],trim);
  box(door,'door-center',[.065,4.2,.12],[0,2.1,2.12],trim);
  const arch=new Group();arch.name='arch';arch.position.set(0,4.3,2);scene.add(arch);
  const ring=new Mesh(archGeometry(1.55,1.29,.36),trim);ring.name='arch-ring';arch.add(ring);
  const keystone=box(arch,'keystone',[.28,.5,.42],[0,1.45,.22],trim);
  box(scene,'cornice',[18,.28,.55],[0,11.25,2.25],trim);
  for(let i=0;i<12;i++)box(scene,'dentil-'+i,[.3,.32,.44],[-3.3+i*.6,10.94,2.23],trim);
  const buttresses=[];
  for(const x of [-8.1,8.1]) {
    const group=new Group();group.name='buttress';group.position.x=x;scene.add(group);buttresses.push(group);
    box(group,'lower-step',[1.4,4,1],[0,2,2.5],trim);
    box(group,'middle-step',[1.1,3,.8],[0,5.5,2.4],trim);
    box(group,'upper-step',[.8,3,.6],[0,8.5,2.3],trim);
  }
  const rose=new Group();rose.name='rose';rose.position.set(0,9.05,2);scene.add(rose);
  const disc=new Mesh(new CylinderGeometry(.98,.98,.045,48),glass);disc.rotation.x=Math.PI/2;disc.position.z=.06;rose.add(disc);
  const outer=new Mesh(new TorusGeometry(1,.12,8,48),trim);outer.position.z=.23;outer.name='outer-ring';rose.add(outer);
  for(let i=0;i<4;i++){
    const spoke=box(rose,'tracery-'+i,[1.82,.085,.17],[0,0,.17],trim);spoke.rotation.z=i*Math.PI/4;
  }
  const inner=new Mesh(new TorusGeometry(.29,.045,6,32),trim);inner.name='inner-ring';inner.position.z=.26;rose.add(inner);
  if(variant==='missing-mullion')windowGroups[0].remove(windowGroups[0].getObjectByName('mullion-vertical'));
  if(variant==='missing-window')scene.remove(windowGroups[0]);
  if(variant==='extra-window')windowAt(0,6.9,4);
  if(variant==='flat-window')windowGroups[0].scale.z=.03;
  if(variant==='shifted-window')windowGroups[0].position.x+=.5;
  if(variant==='missing-tracery')for(const node of [...rose.children])if(node.name.startsWith('tracery')||node.name==='inner-ring')rose.remove(node);
  if(variant==='flat-arch')arch.scale.z=.03;
  if(variant==='floating-buttress')buttresses[0].position.y+=.8;
  if(variant==='material-change'){stone.color.set('#465587');trim.color.set('#e85836');glass.color.set('#829538');}
  if(variant==='renamed')scene.traverse(node=>{node.name='anonymous';});
  if(variant==='nonindexed')scene.traverse(node=>{if(node.isMesh&&node.geometry.index)node.geometry=node.geometry.toNonIndexed();});
  return scene;
}

export function localViews(center,width,height) {
  return [
    {id:'front',right:[1,0,0],up:[0,1,0],origin:center,extent:[-width*.57,width*.57,-height*.57,height*.57],resolution:144,depth_range:[-.35,.85]},
    {id:'oblique',right:[Math.cos(Math.PI/6),0,-.5],up:[0,1,0],origin:center,extent:[-width*.57,width*.57,-height*.57,height*.57],resolution:144,depth_range:[-width*.32-1,width*.32+1]}
  ];
}
function card(id,title,category,center,width,height,requirements,specificAnchors) {
  return {id,title,category,weight:1,scoreable:true,source_ids:['source-1','source-2'],requirements,
    anchors:specificAnchors||['目标构件缺失或错误','只有粗略占位，主要特征未还原','主体存在，但位置、轮廓或内部层次有明显问题','主要要求满足，只有次要偏差','满足卡片列出的形态、布局和立体层次要求'],
    views:localViews(center,width,height),
    thresholds:{iou_min:.98,depth_mean_m_max:.006,depth_p95_m_max:.035,normal_mean_deg_max:2,
      depth_pixel_tolerance_m:.015,depth_outlier_fraction_max:.008}};
}
export function facadeCards(task,referenceHash) {
  const cards=WINDOWS.map(([x,y],i)=>card('window-'+i,['左下窗','右下窗','左上窗','右上窗'][i],'windows',[x,y,2],3.05,3.05,
    ['外框约 2.8 × 2.8 米，四边齐全；位置以输入尺寸为准','一根竖窗棂和一根横窗棂；四个窗格','框架与窗棂有独立凸出厚度，不能仅用平面图案代替'],
    ['窗户缺失或完全错误','只有平面占位或外框，窗棂和立体层次缺失','主要形态存在，但缺窗棂、位置明显偏移或框架被压平','位置、四边框及十字窗棂正确，仅有小偏差','四边框、十字窗棂、位置比例及相对凸出厚度全部满足参考']));
  cards.push(card('window-rhythm','门窗布局与数量','windows',[0,6.2,2],13.4,9.5,
    ['四扇窗构成左右两列、上下两排','中部入口及其上方留白不能增加第五扇窗','对齐和间距应遵循尺寸资料']));
  cards.push(card('entrance','入口门框与门扇','entrance',[0,2.15,2],3.8,4.6,
    ['两侧竖门框和中部分缝存在','门框与门扇有深度层次','门扇和开口比例、位置与参考一致']));
  cards.push(card('arch','入口拱券与拱顶石','entrance',[0,5.05,2],3.8,2.1,
    ['半圆拱券有内外两条轮廓，不能用矩形替代','拱顶石存在','拱券具有凸出厚度，与门框连接']));
  cards.push(card('cornice','檐口与齿饰','structure',[0,11.12,2],17.8,1.1,
    ['连续檐口横向贯通','十二个齿饰按固定节奏排列','齿饰与墙面有凸出关系']));
  cards.push(card('buttress','左侧阶梯扶壁','structure',[-8.1,5,2],2.4,10.4,
    ['扶壁从地面起连续连接','三段宽度和凸出厚度逐级收窄','底部不得悬空']));
  cards.push(card('rose','玫瑰窗内部框架','ornament',[0,9.05,2],2.6,2.6,
    ['外圆环和内圆环均存在','四根相交构件形成八条辐射方向','框架与背后窗面有深度层次'],
    ['玫瑰窗缺失或错误','只有圆盘或外圆环，内部框架缺失','存在部分内部框架，但数量、布局或层次明显错误','圆环与辐射框架基本正确，仅有次要偏差','内外圆环、八条辐射方向与立体层次满足全部要求']));
  cards.push({id:'rear-unobserved',title:'后立面装饰',category:'structure',weight:1,scoreable:false,
    source_ids:[],requirements:[],anchors:['不适用','不适用','不适用','不适用','不适用'],views:[],
    thresholds:{...cards[0].thresholds},exclusion_reason:'输入没有提供后立面细节要求，预先排除，不由参赛者自行免考。'});
  return validateDetailSet({schema_version:1,id:'facade-detail-cards-v1',task_id:task.id,task_sha256:objectHash(task),
    status:'calibration_only',reference_sha256:referenceHash,provenance:{kind:'analytic_fixture',evidence:['显式尺寸、构件数量及独立固定相机；不依赖候选名称。']},
    categories:[{id:'windows',title:'门窗布局',weight:1},{id:'entrance',title:'入口',weight:1},{id:'structure',title:'构造',weight:1},{id:'ornament',title:'装饰',weight:1}],cards},task);
}
export async function buildDetailCalibration(dataRoot) {
  const taskDir=join(dataRoot,'tasks',DETAIL_TASK),privateDir=join(dataRoot,'private',DETAIL_TASK);
  await mkdir(join(taskDir,'inputs'),{recursive:true});await mkdir(privateDir,{recursive:true});
  const referenceBytes=sceneToGLB(facadeScene()),reference=await geometryFromBytes(referenceBytes);
  for(const key of ['min','max'])for(let i=0;i<3;i++)if(Math.abs(reference.bounds[key][i]-FACADE_BOUNDS[key][i])>1e-5)throw new Error('Facade analytic bounds mismatch');
  const observations={unit:'metre',frame:{x:'right',y:'up',z:'front',wall_front_z:2},
    body:{size:[18,12,4],center:[0,6,0]},windows:WINDOWS.map(([x,y])=>({center:[x,y,2],frame_outer_size:[2.8,2.8],
      frame_width:.18,frame_depth:.32,frame_center_z_offset:.18,
      pane:{size:[2.5,2.5,.045],center_offset:[0,0,.035]},
      frame_parts:[{size:[.18,2.8,.32],center_offset:[-1.31,0,.18]},{size:[.18,2.8,.32],center_offset:[1.31,0,.18]},
        {size:[2.8,.18,.32],center_offset:[0,1.31,.18]},{size:[2.8,.18,.32],center_offset:[0,-1.31,.18]}],
      mullions:{vertical:1,horizontal:1,width:.14,depth:.22,center_z_offset:.16,
        parts:[{size:[.14,2.44,.22],center_offset:[0,0,.16]},{size:[2.44,.14,.22],center_offset:[0,0,.16]}]}})),
    door:{outer_width:3.08,height:4.3,center:[0,2.15,2],frame_depth:.45,
      parts:[{role:'panel',size:[2.55,4.2,.07],center:[0,2.1,2.06]},{role:'left-frame',size:[.22,4.3,.45],center:[-1.43,2.15,2.22]},
        {role:'right-frame',size:[.22,4.3,.45],center:[1.43,2.15,2.22]},{role:'center-strip',size:[.065,4.2,.12],center:[0,2.1,2.12]}]},
    arch:{center:[0,4.3,2],outer_radius:1.55,inner_radius:1.29,depth:.36,profile:'upper semicircular annular strip; extrusion starts at local z=0',
      angular_segments:40,keystone:{size:[.28,.5,.42],center_offset:[0,1.45,.22]}},
    cornice:{center:[0,11.25,2.25],size:[18,.28,.55],dentil_count:12,dentil_step:.6,
      dentil_size:[.3,.32,.44],first_dentil_center:[-3.3,10.94,2.23]},
    buttresses:{centers_x:[-8.1,8.1],base_y:0,tiers:[
      {height:4,width:1.4,depth:1,center_y:2,center_z:2.5},{height:3,width:1.1,depth:.8,center_y:5.5,center_z:2.4},
      {height:3,width:.8,depth:.6,center_y:8.5,center_z:2.3}]},
    rose:{center:[0,9.05,2],radial_directions:8,relief:true,
      outer_ring:{major_radius:1,tube_radius:.12,center_z_offset:.23,radial_segments:8,tubular_segments:48},
      inner_ring:{major_radius:.29,tube_radius:.045,center_z_offset:.26,radial_segments:6,tubular_segments:32},
      disc:{radius:.98,depth:.045,center_z_offset:.06,radial_segments:48},
      bars:{count:4,angles_deg:[0,45,90,135],size:[1.82,.085,.17],center_offset:[0,0,.17]},
      orientation:'rings lie in local XY; positive Z points out of the wall'},
    palette:{stone:'#cfbea0',trim:'#eddfc7',glass:'#264a64',door:'#754932'},rear_detail:'not specified'};
  const source=Buffer.from(JSON.stringify(observations,null,2)+'\n');
  const overviewView={...localViews([0,6,2],19,13)[0],depth_range:[-.1,1.1]};
  const elevation=Buffer.from(depthSVG(renderLocal(reference.coordinates,overviewView),overviewView.depth_range));
  const task=validateTask({...taskDefaults(),id:DETAIL_TASK,title:'立面细节 · 校准样例',split:'calibration',status:'calibration_only',
    prompt:'Reconstruct the synthetic facade from dimensions.json and the fixed elevation. Preserve four framed windows with real mullions, the arch, cornice/dentils, stepped buttresses and rose-window tracery. Use metric glTF coordinates. Rear ornament is unspecified. This is an evaluator calibration task, not an unseen real-world model benchmark.',
    inputs:[['dimensions.json',source],['elevation.svg',elevation]].map(([name,bytes],i)=>({id:'source-'+(i+1),path:'inputs/'+name,
      sha256:sha256(bytes),bytes:bytes.length,role:'synthetic_reference',source:'Analytic detail fixture v1',captured_at:null,rights:'generated_calibration'})),
    rights:'generated_calibration'});
  const set=facadeCards(task,sha256(referenceBytes)),cardBytes=Buffer.from(JSON.stringify(set,null,2)+'\n');
  let previous;
  try{previous=await readJSON(join(dataRoot,'detail-index.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const registered=previous?.entries.filter(e=>e.source==='submitted')||[];
  let hasHumanRatings=false;
  try{hasHumanRatings=(await readFile(join(dataRoot,'detail-reviews','ratings.jsonl'),'utf8')).split('\n').filter(Boolean).some(line=>JSON.parse(line).mode==='human');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if((registered.length||hasHumanRatings)&&(previous?.task_sha256!==objectHash(task)||previous?.card_set_sha256!==objectHash(set))) {
    throw new Error('A registered or human-rated detail experiment is frozen; use a new versioned task or data directory');
  }
  await writeFile(join(taskDir,'inputs','dimensions.json'),source);await writeFile(join(taskDir,'inputs','elevation.svg'),elevation);
  await writeJSON(join(taskDir,'task.json'),task);await writeFile(join(privateDir,'reference.glb'),referenceBytes);
  await writeFile(join(privateDir,'detail-cards.json'),cardBytes);
  const truth={schema_version:1,task_id:task.id,task_sha256:objectHash(task),provenance:{kind:'analytic_fixture',source:'Independently enumerated facade dimensions.'},
    reference:{path:'reference.glb',sha256:sha256(referenceBytes)},bounds:FACADE_BOUNDS,
    dimension_tolerance_m:.01,center_tolerance_m:.01,silhouette_pass_iou:.985,views:makeViews(FACADE_BOUNDS),
    detail_cards:{path:'detail-cards.json',sha256:sha256(cardBytes)}};
  await writeJSON(join(privateDir,'truth.json'),truth);
  const entries=[],reports={};
  for(const variant of DETAIL_VARIANTS) {
    const id=DETAIL_TASK+'--'+variant.id,folder=join(dataRoot,'submissions',id),bytes=sceneToGLB(facadeScene(variant.id));
    await mkdir(folder,{recursive:true});await writeFile(join(folder,'model.glb'),bytes);
    await writeJSON(join(folder,'submission.json'),{schema_version:1,id,task_id:task.id,task_sha256:objectHash(task),
      artifact:{path:'model.glb',sha256:sha256(bytes)},system:{name:'Analytic detail fixture / '+variant.id,model_version:'not-an-AI-run',harness_version:'detail-fixture-v1'},
      run:{seed:0,wall_seconds:0,cost_usd:0,human_intervention:false,resource_accounting:'fixture'}});
    const report=await evaluate({taskPath:join(taskDir,'task.json'),submissionPath:join(folder,'submission.json'),
      truthPath:join(privateDir,'truth.json'),outputDir:join(dataRoot,'reports',id)});
    if(report.error)throw new Error(variant.id+': '+report.error);
    entries.push({id,task_id:task.id,...variant,submission_id:id,artifact_sha256:sha256(bytes)});
    // id in variant is a condition name; persist a distinct submission_id explicitly.
    reports[variant.id]=report;
  }
  const checks=[],add=(id,passed,description,evidence)=>checks.push({id,passed,description,evidence});
  const base=reports.reference.detail_geometry;
  add('identity',base.auto_passed_cards===10,'完整细节通过十张卡片的固定视角检查',{passed_cards:base.auto_passed_cards});
  for(const id of ['material-change','renamed','nonindexed']) {
    add(id,JSON.stringify(reports[id].detail_geometry)===JSON.stringify(base),'几何结果不受颜色、名称或等价顶点表示影响',{condition:id});
  }
  const targets={'missing-mullion':'window-0','missing-window':'window-0','extra-window':'window-rhythm',
    'flat-window':'window-0','shifted-window':'window-0','missing-tracery':'rose','flat-arch':'arch','floating-buttress':'buttress'};
  for(const [variant,cardId] of Object.entries(targets)) {
    const card=reports[variant].detail_geometry.cards.find(c=>c.id===cardId);
    add(variant,!card.auto_checks_pass,'指定局部缺陷被对应卡片检出',{card_id:cardId,depth_outlier_fraction:Math.max(...card.views.map(v=>v.depth_outlier_fraction))});
  }
  add('same-bounds',Object.keys(targets).every(id=>reports[id].metrics.max_dimension_error<1e-6),
    '细节扰动保持整体包围盒不变',{variants:Object.keys(targets)});
  add('locality',reports['missing-mullion'].detail_geometry.cards.find(c=>c.id==='window-1').auto_checks_pass,
    '左下窗缺陷不会误判未变化的右下窗',{});
  add('unknown',base.cards.find(c=>c.id==='rear-unobserved').scoreable===false&&base.manual_detail_score===null,
    '未提供资料的后立面排除，自动检查不冒充人工分',{});
  const calibration={schema_version:1,protocol:DETAIL_PROTOCOL,passed:checks.every(c=>c.passed),checks,
    task_id:task.id,submissions:entries.length,scoreable_cards:10,excluded_cards:1,
    scope:'Analytic local geometry calibration only; no human ratings or model-generation results.'};
  await writeJSON(join(dataRoot,'detail-calibration.json'),calibration);
  await writeJSON(join(dataRoot,'detail-index.json'),{schema_version:1,protocol:DETAIL_PROTOCOL,task_id:task.id,
    task_sha256:objectHash(task),card_set_sha256:objectHash(set),truth_sha256:objectHash(truth),entries:[...entries,...registered]});
  return calibration;
}
