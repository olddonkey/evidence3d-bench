import { createViewers } from './viewer.js';
const $=id=>document.getElementById(id);
let data,selectedTask,selectedRow,ballot,choice,viewers;
const roles={photo:'实景照片',plan:'图纸',dimension_sheet:'尺寸资料',aerial_proxy:'航拍 / 三维地图参考',historical_photo:'历史照片',synthetic_reference:'合成参考'};
const viewNames={front:'正面',right:'侧面',top:'俯视','oblique-a':'斜视 A','oblique-b':'斜视 B'};
function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;}
function badge(text,kind){return el('span','badge '+kind,text);}
function showError(error){$('error').textContent=error.message||String(error);$('error').hidden=false;}
async function api(path,payload){
  const response=await fetch(path,payload===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'请求失败');return result;
}
function setTab(name){
  for(const node of document.querySelectorAll('.page'))node.hidden=node.id!==name;
  for(const node of document.querySelectorAll('[data-tab]')){node.classList.toggle('active',node.dataset.tab===name);if(node.dataset.tab===name)node.setAttribute('aria-current','page');else node.removeAttribute('aria-current');}
  history.replaceState(null,'','#'+name);
}
function drawStats(){
  const cal=data.calibration;
  const values=[
    ['评分器校准',cal?cal.checks.filter(c=>c.passed).length+' / '+cal.checks.length:'—','已知扰动测试通过','mint'],
    ['合成提交样例',cal?.submission_count??0,'包含错误与无效提交',''],
    ['真实对象资料包',data.tasks.filter(t=>t.split==='development').length,'标准答案待独立核验',''],
    ['独立人工评审',data.human.independent_reviewers,'练习投票不计入','']
  ];
  $('stats').replaceChildren(...values.map(([label,value,note,color])=>{
    const card=el('div','stat');card.append(el('div','stat-label',label),el('div','stat-value '+color,String(value)),el('div','stat-note',note));return card;
  }));
}
function renderRows(){
  const rows=data.reports.filter(row=>row.task_id===selectedTask);
  $('result-rows').replaceChildren(...rows.map(row=>{
    const tr=el('tr',row.id===selectedRow?'selected':'');tr.tabIndex=0;tr.setAttribute('aria-label','查看'+row.label);
    const r=row.report;tr.append(el('td','',row.label));
    const technical=el('td');technical.append(badge(r.technical.valid?'有效':'无效',r.technical.valid?'good':'bad'));tr.append(technical);
    tr.append(el('td','',r.metrics?(r.metrics.max_dimension_error*100).toFixed(1)+'%':'—'),el('td','',r.metrics?r.metrics.min_silhouette_iou.toFixed(3):'—'));
    const status=el('td');status.append(badge(r.metrics?(r.geometry_checks_pass?'通过':'检出差异'):'不计分',r.metrics?(r.geometry_checks_pass?'good':'bad'):'neutral'));tr.append(status);
    tr.addEventListener('click',()=>selectRow(row));
    tr.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectRow(row);}});
    return tr;
  }));
}
function selectRow(row){
  selectedRow=row.id;renderRows();
  const r=row.report;$('selected-label').textContent=row.label;
  $('selected-type').textContent={control:'REFERENCE CONTROL',invariance:'INVARIANCE TEST',defect:'KNOWN DEFECT',invalid:'INVALID SUBMISSION'}[row.kind];
  $('selected-description').textContent=row.kind==='control'?'相同几何的基准对照；校验尺寸提取和轮廓计算。':
    row.kind==='invariance'?'仅改变与几何无关的表示；几何结果应保持一致。':
    row.kind==='invalid'?'该提交未满足静态 GLB 交付约束，仍保留在结果记录中。':'对参考对象施加已知扰动，检查测量能否发现差异。';
  $('overlays').replaceChildren();$('dimension-readout').replaceChildren();
  if(!r.metrics){$('overlays').append(el('div','empty-overlays',r.error||'没有可评分的几何。'));return;}
  for(const view of r.metrics.silhouettes){
    const figure=el('figure','overlay'),img=el('img');img.src='/api/overlays/'+row.id+'/'+view.overlay;img.alt=viewNames[view.id]+'轮廓对照';
    const caption=el('figcaption','',viewNames[view.id]);caption.append(el('span','',view.iou.toFixed(3)));figure.append(img,caption);$('overlays').append(figure);
  }
  for(const d of r.metrics.dimensions){
    const line=el('div');line.append(el('span','',d.axis.toUpperCase()+' 尺寸 / 参考'),el('strong','',d.measured_m.toFixed(2)+' / '+d.reference_m.toFixed(2)+' m'));$('dimension-readout').append(line);
  }
  const pos=el('div');pos.append(el('span','','最大中心偏差'),el('strong','',Math.max(...r.metrics.dimensions.map(d=>d.center_error_m)).toFixed(2)+' m'));$('dimension-readout').append(pos);
}
function drawChecks(){
  const checks=data.calibration?.checks||[];$('check-total').textContent=checks.filter(c=>c.passed).length+' / '+checks.length+' PASS';
  $('checks').replaceChildren(...checks.map(check=>{
    const row=el('div','check');row.append(el('span','',check.passed?'✓':'×'),document.createTextNode((check.id.startsWith('calibration-chapel')?'礼堂 · ':'住宅 · ')+check.description));return row;
  }));
}
function drawTasks(){
  $('task-cards').replaceChildren(...data.tasks.filter(task=>task.split==='development').map(task=>{
    const card=el('button','task-card'),img=el('img');card.type='button';img.src=task.inputs[0].url;img.alt=task.title+'原始参考';img.loading='lazy';
    const content=el('div','task-card-content'),meta=el('div','meta');meta.append(el('span','',task.inputs.length+' 份原始资料'),badge('待核验','pending'));
    content.append(el('h3','',task.title),meta);card.append(img,content);
    card.addEventListener('click',()=>{
      document.querySelectorAll('.task-card').forEach(c=>c.classList.remove('selected'));card.classList.add('selected');
      const detail=$('source-detail');detail.hidden=false;detail.replaceChildren(el('h3','',task.title),el('p','','这些参考可用于开发；精确坐标、尺寸、目标年代和不可观测区域仍待独立标注。'));
      const grid=el('div','source-grid');
      for(const input of task.inputs){
        const figure=el('figure','source-item'),link=el('a');link.href=input.url;link.target='_blank';link.rel='noopener';
        const image=el('img');image.src=input.url;image.alt=roles[input.role]+' · '+task.title;image.loading='lazy';link.append(image);
        const caption=el('figcaption');caption.append(el('strong','',roles[input.role]),document.createTextNode(input.path.split('/').at(-1)));
        figure.append(link,caption);grid.append(figure);
      }
      detail.append(grid);
      if(task.detail_draft) {
        detail.append(el('h3','draft-heading','细节卡片草案 · '+task.detail_draft.cards.length+' 项'),el('p','',task.detail_draft.source_limit));
        const drafts=el('div','draft-grid');
        for(const card of task.detail_draft.cards) {
          const row=el('article','draft-card'),region=card.source_regions[0],source=task.inputs.find(i=>i.id===region.source_id);
          const crop=el('div','draft-crop'),img=el('img');img.src=source.url;img.alt=card.title+'参考区域草案';
          img.addEventListener('load',()=>{
            const [l,t,r,b]=region.rect,dx=r-l,dy=b-t;
            const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),image=document.createElementNS(ns,'image');
            const x=l*img.naturalWidth,y=t*img.naturalHeight,w=dx*img.naturalWidth,h=dy*img.naturalHeight;
            svg.setAttribute('viewBox',[x,y,w,h].join(' '));svg.setAttribute('preserveAspectRatio','xMidYMid meet');
            svg.setAttribute('role','img');svg.setAttribute('aria-label',img.alt);
            const defs=document.createElementNS(ns,'defs'),clip=document.createElementNS(ns,'clipPath'),rect=document.createElementNS(ns,'rect');
            const clipId='crop-'+task.id+'-'+card.id;clip.id=clipId;clip.setAttribute('clipPathUnits','userSpaceOnUse');
            for(const [key,value] of Object.entries({x,y,width:w,height:h}))rect.setAttribute(key,String(value));
            clip.append(rect);defs.append(clip);
            image.setAttribute('href',source.url);image.setAttribute('width',String(img.naturalWidth));image.setAttribute('height',String(img.naturalHeight));
            image.setAttribute('clip-path','url(#'+clipId+')');svg.append(defs,image);crop.replaceChildren(svg);
          });
          crop.append(img);row.append(crop,el('h4','',card.title),el('p','',card.proposed_check),badge('待独立核验','pending'));drafts.append(row);
        }
        detail.append(drafts);
      }
    });return card;
  }));
}
function drawHuman(summary){
  const target=$('human-summary');target.replaceChildren(el('h3','','人工评审记录'));
  const counts=el('div','human-counts');
  for(const [n,label] of [[summary.independent_reviewers,'独立评审者'],[summary.human_ballots,'有效人工投票'],[summary.practice_ballots,'练习投票']]){
    const item=el('span');item.append(el('strong','',String(n)),document.createTextNode(label));counts.append(item);
  }
  target.append(counts,el('p','',summary.human_ballots?'结果按每组对照分别记录，平局、两个都不好和资料不足单列；没有综合排名。':'尚未收集独立人工判断。当前自动校准结果不能替代人类一致性验证。'));
  if(summary.order_probe.count)target.append(el('p','muted','反向顺序复测：'+summary.order_probe.count+' 次；结论一致率 '+(summary.order_probe.agreement*100).toFixed(0)+'%。'));
}
async function showBallot(next){
  ballot=next;choice=null;viewers?.dispose();viewers=null;
  $('review-start').hidden=true;$('review-mode-pill').textContent=next.mode==='practice'?'练习 · 不计入人工统计':'独立人工评审';
  $('review-complete').hidden=!next.complete;$('ballot').hidden=next.complete;
  if(next.complete){drawHuman(await api('/api/human-summary'));return;}
  $('ballot-title').textContent=next.title;$('ballot-progress').textContent=(next.progress.done+1)+' / '+next.progress.total;
  $('ballot-question').textContent=next.question;$('vote-notes').value='';$('submit-vote').disabled=true;
  $('overall-vote-question').textContent=next.criterion==='aesthetic_preference'?'你更喜欢哪个整体视觉效果？':'哪个更忠实于参考？';
  for(const button of document.querySelectorAll('[data-choice]'))if(['a','b'].includes(button.dataset.choice)) {
    button.textContent=button.dataset.choice.toUpperCase()+(next.criterion==='aesthetic_preference'?' 更喜欢':' 更接近');
  }
  $('vote-help').textContent='请先选择一个判断。';$('viewer-status').textContent='正在加载三个模型…';
  for(const button of document.querySelectorAll('[data-choice]')){button.disabled=true;button.setAttribute('aria-pressed','false');}
  try{
    viewers=await createViewers([{element:'view-reference',url:next.reference,label:'参考对象'},{element:'view-a',url:next.a,label:'模型 A'},{element:'view-b',url:next.b,label:'模型 B'}],next.frame,
      {style:next.criterion&&next.criterion!=='geometry_fidelity'?'material':'gray'});
    $('review-render-policy').textContent=next.criterion&&next.criterion!=='geometry_fidelity'?'相同灯光 · 基础材质色块 · 不含贴图':'统一灰模 · 相同光照 · 相同坐标';
    $('viewer-status').textContent='三个模型均已加载。拖动任一视窗可同步观察，请检查正面、背面和屋顶。';
    for(const button of document.querySelectorAll('[data-choice]'))button.disabled=false;
  }catch(error){$('viewer-status').textContent='模型未完整加载，投票保持禁用。';showError(error);}
}
for(const button of document.querySelectorAll('[data-tab]'))button.addEventListener('click',()=>setTab(button.dataset.tab));
$('task-filter').addEventListener('change',()=>{selectedTask=$('task-filter').value;selectRow(data.reports.find(r=>r.task_id===selectedTask));});
$('review-form').addEventListener('submit',async event=>{
  event.preventDefault();$('error').hidden=true;
  const button=event.currentTarget.querySelector('button');button.disabled=true;
  try{const next=await api('/api/reviews/start',{reviewer:$('reviewer').value,mode:$('review-mode').value,criterion:$('review-criterion').value});await showBallot(next);}catch(error){showError(error);}finally{button.disabled=false;}
});
for(const button of document.querySelectorAll('[data-choice]'))button.addEventListener('click',()=>{
  choice=button.dataset.choice;
  for(const other of document.querySelectorAll('[data-choice]'))other.setAttribute('aria-pressed',String(other===button));
  $('submit-vote').disabled=false;$('vote-help').textContent=ballot.mode==='practice'?'本次判断将保存为练习记录。':'本次判断将保存为独立人工记录。';
});
$('submit-vote').addEventListener('click',async()=>{
  $('submit-vote').disabled=true;$('error').hidden=true;
  for(const button of document.querySelectorAll('[data-choice]'))button.disabled=true;
  try{
    const result=await api('/api/reviews/'+ballot.session_id+'/vote',{ballot_id:ballot.ballot_id,choice,notes:$('vote-notes').value});
    await showBallot(result.next);drawHuman(await api('/api/human-summary'));
  }catch(error){showError(error);$('submit-vote').disabled=false;for(const button of document.querySelectorAll('[data-choice]'))button.disabled=false;}
});
$('reset-views').addEventListener('click',()=>viewers?.reset());
$('another-reviewer').addEventListener('click',()=>{$('review-complete').hidden=true;$('review-start').hidden=false;$('review-mode-pill').textContent='尚未开始';});
try{
  data=await api('/api/overview');drawStats();drawChecks();drawTasks();drawHuman(data.human);
  const cases=data.tasks.filter(t=>t.split==='calibration');
  $('task-filter').replaceChildren(...cases.map(task=>{const option=el('option','',task.title);option.value=task.id;return option;}));
  if(cases.length){selectedTask=cases[0].id;selectRow(data.reports.find(r=>r.task_id===selectedTask));}
  $('loading').hidden=true;setTab(['calibration','details','tasks','review','detail-review'].includes(location.hash.slice(1))?location.hash.slice(1):'calibration');
}catch(error){$('loading').hidden=true;showError(error);}
