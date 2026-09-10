import {Group,Mesh,BoxGeometry,CylinderGeometry,TorusGeometry,LatheGeometry,Vector2,Vector3,Shape,Path,ExtrudeGeometry,BufferGeometry,Float32BufferAttribute,MeshStandardMaterial} from 'three';

const box=(id,size,position,color='#cdbda1')=>({id,type:'box',size,position,color});
const cylinder=(id,radius,height,position,color='#c7d1dc',rotation=[0,0,0])=>({id,type:'cylinder',radius,height,position,color,segments:32,rotation});
const torus=(id,radius,tube,position,color='#e2cf9e',rotation=[0,0,0])=>({id,type:'torus',radius,tube,position,color,radial_segments:8,tubular_segments:48,rotation});
const beam=(id,start,end,radius=.07,color='#72889b')=>({id,type:'beam',start,end,radius,segments:12,color});
const card=(id,title,category,center,width,height,requirements,directions=['front','oblique'])=>({id,title,category,center,width,height,requirements,directions});
const invariantVariants=[
  {id:'reference',label:'完整参考',kind:'control'},
  {id:'material-change',label:'仅改变颜色',kind:'invariance'},
  {id:'renamed',label:'仅改变名称',kind:'invariance'},
  {id:'nonindexed',label:'等价顶点表示',kind:'invariance'}
];

function arcade() {
  const parts=[box('base',[14.6,.5,2.2],[0,.25,0]),box('deck',[14.6,.4,2.2],[0,5.6,0])];
  parts.push({id:'arch-wall',type:'arch-wall',width:14,height:5.4,depth:.8,position:[0,0,-.4],color:'#baa888',
    openings:[-4.5,0,4.5].map(x=>({center_x:x,base_y:.75,spring_y:3,radius:1.6})),arc_segments:40});
  for(const [i,x] of [-4.5,0,4.5].entries()) {
    parts.push({id:'arch-trim-'+i,type:'arch-ring',outer:1.78,inner:1.6,depth:.22,position:[x,3,.4],color:'#e1d3b2',arc_segments:40});
    parts.push(box('keystone-'+i,[.34,.48,.3],[x,4.65,.56],'#e8d6ad'));
  }
  for(const z of [-.85,.85]) {
    const side=z>0?'front':'rear';
    parts.push(box(side+'-rail',[14,.12,.15],[0,6.75,z],'#627f8a'));
    for(let i=0;i<9;i++)parts.push(box(side+'-post-'+i,[.14,.9,.14],[-6.8+i*1.7,6.25,z],'#627f8a'));
  }
  return {
    id:'calibration-arcade-v1',title:'三拱廊 · 孔洞与重复构件',focus:['真实拱洞','前后栏杆','重复构件数量'],
    description:'检查外形不变时孔洞被填实、栏杆缺失和拱券被压平的情况。',
    bounds:{min:[-7.3,0,-1.1],max:[7.3,6.81,1.1]},parts,
    categories:[{id:'openings',title:'孔洞',weight:1},{id:'structure',title:'支撑与栏杆',weight:1},{id:'ornament',title:'拱券细节',weight:1}],
    cards:[
      ...[-4.5,0,4.5].map((x,i)=>card('opening-'+i,['左侧拱洞','中间拱洞','右侧拱洞'][i],'openings',[x,2.8,0],4.05,5.4,
        ['开口应贯穿墙体，不能仅用凹痕或颜色模拟','圆拱顶与直立两侧连接，开口底边和拱起线按输入尺寸','保留孔洞周边的实体墙与拱券'])),
      card('front-post','前栏杆中央立杆','structure',[0,6.28,.85],2.1,1.25,['前后各九根立杆，中央前杆不能省略','前后杆即使投影重叠也应各自存在']),
      card('arch-trim','左侧拱券厚度','ornament',[-4.5,3.8,.4],4.0,2.5,['拱券内外轮廓完整','拱券有 0.22 米凸出厚度，不得压成平面']),
      card('keystone','中央拱顶石','ornament',[0,4.65,.56],1.5,1.25,['拱顶石位于中央拱洞正上方','位置、尺寸与凸出关系按输入部件表'])
    ],
    variants:[...invariantVariants,
      {id:'filled-opening',label:'左拱洞被填实',kind:'defect',target:'opening-0'},
      {id:'missing-post',label:'缺少中央前栏杆',kind:'defect',target:'front-post'},
      {id:'extra-post',label:'多造一根栏杆',kind:'defect',target:'front-post'},
      {id:'flat-trim',label:'拱券压平',kind:'defect',target:'arch-trim'},
      {id:'shifted-keystone',label:'拱顶石错位',kind:'defect',target:'keystone'}
    ],
    mutate(parts,variant){
      if(variant==='filled-opening')parts.find(p=>p.id==='arch-wall').openings.shift();
      if(variant==='missing-post')parts.splice(parts.findIndex(p=>p.id==='front-post-4'),1);
      if(variant==='extra-post')parts.push(box('extra-front-post',[.14,.9,.14],[.65,6.25,.85],'#627f8a'));
      if(variant==='flat-trim')parts.find(p=>p.id==='arch-trim-0').depth=.01;
      if(variant==='shifted-keystone')parts.find(p=>p.id==='keystone-1').position[0]+=.6;
    }
  };
}
function rotunda() {
  const parts=[cylinder('foundation',3.5,.3,[0,.15,0],'#9caaa7')];
  const profile=[];
  for(let i=0;i<=24;i++){const a=i/24*Math.PI/2;profile.push([3*Math.cos(a),4+3*Math.sin(a)]);}
  for(let i=24;i>=0;i--){const a=i/24*Math.PI/2;profile.push([2.85*Math.cos(a),4+2.85*Math.sin(a)]);}
  profile.push([3,4]);
  parts.push({id:'dome',type:'lathe',profile,segments:48,position:[0,0,0],color:'#70a3a1'});
  parts.push(torus('eaves-ring',3,.12,[0,4,0],'#ead7ae',[Math.PI/2,0,0]));
  for(let i=0;i<8;i++){
    const a=i*Math.PI/4,x=2.6*Math.cos(a),z=2.6*Math.sin(a);
    parts.push(cylinder('column-'+i,.16,3.44,[x,2.2,z],'#ded4b8'));
    parts.push(cylinder('plinth-'+i,.27,.18,[x,.39,z],'#b4b9a4'));
    parts.push(cylinder('capital-'+i,.28,.18,[x,3.95,z],'#ded4b8'));
  }
  parts.push(cylinder('finial-stem',.055,.28,[0,7.06,0],'#e5bd5a'));
  parts.push({id:'finial',type:'cylinder',radius:0,radius_bottom:.14,height:.5,segments:24,position:[0,7.3,0],color:'#e5bd5a'});
  return {
    id:'calibration-rotunda-v1',title:'圆顶亭 · 曲面与环形支撑',focus:['穹顶曲率','环形立柱','可接受的加密细分'],
    description:'区分正确曲面、粗糙分面与被压平的屋顶，并检验前后重叠的立柱。',
    bounds:{min:[-3.5,0,-3.5],max:[3.5,7.55,3.5]},parts,
    categories:[{id:'roof',title:'曲面屋顶',weight:1},{id:'supports',title:'支撑',weight:1},{id:'joints',title:'连接细部',weight:1}],
    cards:[
      card('dome','穹顶轮廓与曲率','roof',[0,5.5,0],6.8,3.7,['穹顶应按给定旋转剖面建造','内外层与檐口相连','合理增加周向细分不应当作质量缺陷']),
      card('eaves','圆形檐口','roof',[0,4,0],6.8,1.2,['檐口形成连续圆环','与穹顶底部相接，保持规定半径和厚度']),
      card('front-column','正面中央立柱','supports',[0,2.2,2.6],1.2,4.0,['前柱与后柱都应存在','柱身连接柱础和柱头，不能用后柱投影冒充前柱']),
      card('column-rhythm','环形立柱数量','supports',[0,2.2,0],6.5,4.2,['八根立柱按 45 度间隔排列','不得补入第九根立柱']),
      card('front-capital','正面柱头','joints',[0,3.95,2.6],1.3,.85,['柱头应具有明确的外扩轮廓与厚度','柱身与檐口通过柱头连接']),
      card('finial','顶部尖饰与连接','joints',[0,7.22,0],1.1,1.0,['尖饰位置与连接杆按部件表','不可仅保留孤立的尖端'])
    ],
    variants:[...invariantVariants,
      {id:'dense-dome',label:'穹顶加密细分',kind:'acceptable',target:'dome'},
      {id:'flat-dome',label:'穹顶被压平',kind:'defect',target:'dome'},
      {id:'coarse-dome',label:'穹顶仅八个分面',kind:'defect',target:'dome'},
      {id:'missing-column',label:'缺少正面立柱',kind:'defect',target:'front-column'},
      {id:'extra-column',label:'增加第九根立柱',kind:'defect',target:'column-rhythm'}
    ],
    mutate(parts,variant){
      const dome=parts.find(p=>p.id==='dome');
      if(variant==='dense-dome')dome.segments=96;
      if(variant==='coarse-dome')dome.segments=8;
      if(variant==='flat-dome')dome.profile=dome.profile.map(([r,y])=>[r,4+(y-4)*.06]);
      if(variant==='missing-column')parts.splice(parts.findIndex(p=>p.id==='column-2'),1);
      if(variant==='extra-column')parts.push(cylinder('extra-column',.16,3.44,[2.6*Math.cos(Math.PI/8),2.2,2.6*Math.sin(Math.PI/8)],'#ded4b8'));
    }
  };
}
function reflector() {
  const parts=[box('foundation',[4.4,.4,3.4],[0,.2,0],'#9daaad')];
  parts.push({id:'dish',type:'paraboloid',radius:3,curvature:.1,thickness:.12,rings:12,segments:48,position:[0,4.5,0],color:'#d9e1e3'});
  parts.push(torus('rim',3,.12,[0,4.5,.9],'#8aabb9'));
  parts.push(cylinder('receiver',.18,.36,[0,4.5,1.65],'#d1a65e',[Math.PI/2,0,0]));
  for(let i=0;i<3;i++){
    const a=i*Math.PI*2/3;
    parts.push(beam('feed-arm-'+i,[2.8*Math.cos(a),4.5+2.8*Math.sin(a),.84],[0,4.5,1.6],.05));
  }
  for(let i=0;i<8;i++){
    const a=i*Math.PI/4;
    parts.push(beam('rear-rib-'+i,[0,4.5,-.5],[2.75*Math.cos(a),4.5+2.75*Math.sin(a),.47625],.055));
  }
  parts.push(box('rear-hub',[.8,.8,.5],[0,4.5,-.75],'#647d8b'));
  parts.push(box('counterweight',[1.2,1,.3],[0,3.8,-1.4],'#89939c'));
  for(const x of [-1.7,1.7]){
    parts.push(beam('stand-'+(x<0?'left':'right'),[x,.4,-1.0],[x*.4,3.6,-.75],.095));
    parts.push(beam('brace-'+(x<0?'left':'right'),[x,.4,.7],[0,3.6,-.75],.065));
  }
  return {
    id:'calibration-reflector-v1',title:'曲面天线 · 凹面与背部遮挡',focus:['凹面深度','正反面证据','细支撑杆'],
    description:'比较凹面、压平和反向曲率；验证正面看不到的背部支撑需要背面视角。',
    bounds:{min:[-3.12,0,-1.7],max:[3.12,7.62,1.83]},parts,
    categories:[{id:'reflector',title:'反射面',weight:1},{id:'feed',title:'馈源结构',weight:1},{id:'supports',title:'背部与底座',weight:1}],
    cards:[
      card('dish','反射面的凹度','reflector',[0,4.5,0],6.65,6.65,['反射面符合 z=0.1×(x²+y²) 的局部剖面','开口朝向正 Z；不能压平或改为凸面']),
      card('rim','外缘环形框','reflector',[0,7.45,.9],2.2,.7,['外缘环与反射面连接','保持规定半径和管截面']),
      card('feed','前部馈源与支架','feed',[.9,4.5,1.2],4.1,2.1,['三根馈源支架与接收器连接','支架位于反射面前方']),
      card('rear-ribs','背部径向支撑','supports',[0,4.5,0],6.4,6.4,['八根径向支撑位于反射面背部','需要背面视角核验，不能由正面外观推断完整'],['rear','rear-oblique']),
      card('upper-rib','背部上方支撑杆','supports',[0,6,0],1.3,3.0,['上方径向支撑不能省略','支撑杆连接中心与边缘附近'],['rear','rear-oblique']),
      card('stand','左侧底座斜撑与连接','supports',[-.85,1.9,-.025],2.5,3.7,['左侧斜撑连接前部基座与背部支座','正面可能被反射面遮挡，使用背面与左侧视角','不得出现斜撑缺失或悬空'],['rear','left'])
    ],
    variants:[...invariantVariants,
      {id:'flat-dish',label:'凹面压平',kind:'defect',target:'dish'},
      {id:'convex-dish',label:'凹面方向反转',kind:'defect',target:'dish'},
      {id:'missing-feed-arm',label:'缺少馈源支架',kind:'defect',target:'feed'},
      {id:'missing-rear-rib',label:'缺少背部上方支撑',kind:'defect',target:'upper-rib'},
      {id:'missing-stand-brace',label:'缺少底座斜撑',kind:'defect',target:'stand'}
    ],
    mutate(parts,variant){
      if(variant==='flat-dish')parts.find(p=>p.id==='dish').curvature=0;
      if(variant==='convex-dish')parts.find(p=>p.id==='dish').curvature=-.1;
      const remove={'missing-feed-arm':'feed-arm-0','missing-rear-rib':'rear-rib-2','missing-stand-brace':'brace-left'}[variant];
      if(remove)parts.splice(parts.findIndex(p=>p.id===remove),1);
    }
  };
}
export const EXAMPLE_DEFINITIONS=[arcade(),rotunda(),reflector()];

function archRing(part) {
  const s=new Shape();s.moveTo(part.outer,0);
  for(let i=1;i<=part.arc_segments;i++){const a=i/part.arc_segments*Math.PI;s.lineTo(Math.cos(a)*part.outer,Math.sin(a)*part.outer);}
  for(let i=part.arc_segments;i>=0;i--){const a=i/part.arc_segments*Math.PI;s.lineTo(Math.cos(a)*part.inner,Math.sin(a)*part.inner);}
  s.closePath();return new ExtrudeGeometry(s,{depth:part.depth,bevelEnabled:false});
}
function wallGeometry(part) {
  const s=new Shape();s.moveTo(-part.width/2,0);s.lineTo(part.width/2,0);s.lineTo(part.width/2,part.height);s.lineTo(-part.width/2,part.height);s.closePath();
  for(const o of part.openings){
    const h=new Path();h.moveTo(o.center_x-o.radius,o.base_y);h.lineTo(o.center_x-o.radius,o.spring_y);
    for(let i=1;i<=part.arc_segments;i++){const a=Math.PI-i/part.arc_segments*Math.PI;h.lineTo(o.center_x+o.radius*Math.cos(a),o.spring_y+o.radius*Math.sin(a));}
    h.lineTo(o.center_x+o.radius,o.base_y);h.closePath();s.holes.push(h);
  }
  return new ExtrudeGeometry(s,{depth:part.depth,bevelEnabled:false});
}
function paraboloid(part) {
  const p=(r,a,offset=0)=>[r*Math.cos(a),r*Math.sin(a),part.curvature*r*r+offset],v=[];
  const tri=(a,b,c,reverse=false)=>v.push(...a,...(reverse?c:b),...(reverse?b:c));
  for(let i=0;i<part.rings;i++)for(let j=0;j<part.segments;j++){
    const r0=part.radius*i/part.rings,r1=part.radius*(i+1)/part.rings,a=2*Math.PI*j/part.segments,b=2*Math.PI*(j+1)/part.segments;
    for(const offset of [0,-part.thickness]){
      const reverse=offset<0;
      tri(p(r0,a,offset),p(r1,a,offset),p(r1,b,offset),reverse);
      if(i)tri(p(r0,a,offset),p(r1,b,offset),p(r0,b,offset),reverse);
    }
    if(i===part.rings-1){tri(p(r1,a),p(r1,a,-part.thickness),p(r1,b,-part.thickness));tri(p(r1,a),p(r1,b,-part.thickness),p(r1,b));}
  }
  const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute(v,3));return geometry;
}
export function sceneFromParts(parts) {
  const group=new Group();
  for(const part of parts){
    let geometry;
    if(part.type==='box')geometry=new BoxGeometry(...part.size);
    else if(part.type==='cylinder')geometry=new CylinderGeometry(part.radius,part.radius_bottom??part.radius,part.height,part.segments);
    else if(part.type==='torus')geometry=new TorusGeometry(part.radius,part.tube,part.radial_segments,part.tubular_segments);
    else if(part.type==='lathe')geometry=new LatheGeometry(part.profile.map(p=>new Vector2(...p)),part.segments);
    else if(part.type==='arch-ring')geometry=archRing(part);
    else if(part.type==='arch-wall')geometry=wallGeometry(part);
    else if(part.type==='paraboloid')geometry=paraboloid(part);
    else if(part.type==='beam')geometry=new CylinderGeometry(part.radius,part.radius,new Vector3(...part.start).distanceTo(new Vector3(...part.end)),part.segments);
    else throw new Error('Unknown example primitive');
    const mesh=new Mesh(geometry,new MeshStandardMaterial({color:part.color,metalness:.1,roughness:.72}));
    mesh.name=part.id;
    if(part.type==='beam') {
      const start=new Vector3(...part.start),end=new Vector3(...part.end);
      mesh.position.copy(start).add(end).multiplyScalar(.5);mesh.quaternion.setFromUnitVectors(new Vector3(0,1,0),end.sub(start).normalize());
    } else mesh.position.set(...part.position);
    if(part.rotation)mesh.rotation.set(...part.rotation);
    group.add(mesh);
  }
  return group;
}
export function exampleScene(definition,variant='reference') {
  const parts=structuredClone(definition.parts);definition.mutate(parts,variant);
  if(variant==='material-change')for(const part of parts)part.color='#b76189';
  const scene=sceneFromParts(parts);
  if(variant==='renamed')scene.traverse(n=>{n.name='anonymous';});
  if(variant==='nonindexed')scene.traverse(n=>{if(n.isMesh&&n.geometry.index)n.geometry=n.geometry.toNonIndexed();});
  return scene;
}
