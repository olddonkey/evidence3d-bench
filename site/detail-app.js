import {createViewers,overviewCamera} from './viewer.js';
const $=id=>document.getElementById(id);
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
let data,preview,previewGeneration=0,currentEntry,currentCard,currentView;
let ratingView,rating,ratingCamera,selectedScore,unknown=false,ratingGeneration=0;
async function api(path,payload){
  const res=await fetch(path,payload===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const value=await res.json();if(!res.ok)throw new Error(value.error||'请求失败');return value;
}
function error(e){$('error').textContent=e.message||String(e);$('error').hidden=false;}
function badge(text,good){return el('span','badge '+(good?'good':'pending'),text);}
function fillViews(target,views,onSelect){
  target.replaceChildren();
  for(const view of [...views,{id:'overview'}]){
    const button=el('button','secondary',view.id==='overview'?'全貌':view.id==='front'?'固定正面':'固定斜视');
    button.type='button';button.dataset.view=view.id;
    button.addEventListener('click',()=>{
      for(const other of target.children)other.classList.toggle('selected',other===button);
      onSelect(view.id==='overview'?overviewCamera(data.frame):view);
    });target.append(button);
  }
  target.firstElementChild?.classList.add('selected');
}
function drawMetrics(viewId){
  $('detail-measurements').hidden=viewId==='overview'||!currentCard.scoreable;
  if($('detail-measurements').hidden)return;
  const card=currentEntry.report.detail_geometry.cards.find(c=>c.id===currentCard.id),view=card.views.find(v=>v.id===viewId);
  const numbers=[
    ['平均深度差',view.depth_mean_m===null?'—':(view.depth_mean_m*1000).toFixed(2)+' mm'],
    ['95% 深度差',view.depth_p95_m===null?'—':(view.depth_p95_m*1000).toFixed(2)+' mm'],
    ['异常深度像素',view.depth_outlier_fraction===null?'—':(view.depth_outlier_fraction*100).toFixed(2)+'%'],
    ['平均法线角差',view.normal_mean_deg===null?'—':view.normal_mean_deg.toFixed(2)+'°']
  ];
  $('detail-metric-readout').replaceChildren(...numbers.map(([title,value])=>{const node=el('div');node.append(el('span','',title),el('strong','',value));return node;}));
  const names={reference_depth:'参考深度',candidate_depth:'候选深度',depth_difference:'深度差异',reference_normal:'参考法线',candidate_normal:'候选法线',coverage:'轮廓覆盖'};
  $('detail-image-grid').replaceChildren(...Object.entries(view.artifacts).map(([key,file])=>{
    const fig=el('figure'),img=el('img');img.src='/api/overlays/'+currentEntry.submission_id+'/'+file;img.alt=names[key]+' · '+currentCard.title;
    fig.append(img,el('figcaption','',names[key]+(key==='depth_difference'?' · 亮端 ≥ '+view.depth_difference_scale_m.toFixed(2)+' m':'')));return fig;
  }));
}
async function showPreview(){
  const generation=++previewGeneration;preview?.dispose();preview=null;
  currentEntry=data.entries.find(e=>e.submission_id===$('detail-variant').value);
  currentCard=data.cards.find(c=>c.id===$('detail-card').value);
  $('detail-card-title').textContent=currentCard.title;$('detail-candidate-label').textContent=currentEntry.label;
  $('detail-requirements').replaceChildren(...currentCard.requirements.map(text=>el('li','',text)));
  $('detail-anchors').replaceChildren(...currentCard.anchors.map(text=>el('li','',text)));
  const result=currentEntry.report.detail_geometry.cards.find(c=>c.id===currentCard.id);
  $('detail-card-status').replaceChildren(badge(currentCard.scoreable?(result.auto_checks_pass?'局部几何检查通过':'检出局部几何差异'):'预先排除',currentCard.scoreable&&result.auto_checks_pass));
  $('detail-viewer-status').textContent=currentCard.scoreable?'正在加载固定视角…':currentCard.exclusion_reason;
  currentView=currentCard.views[0]||overviewCamera(data.frame);
  fillViews($('detail-view-buttons'),currentCard.views,view=>{currentView=view;preview?.setView(view);drawMetrics(view.id);});
  drawMetrics(currentCard.scoreable?currentView.id:'overview');
  try{
    const loaded=await createViewers([
      {element:'detail-reference',url:'/api/detail-preview/'+currentEntry.submission_id+'/reference?style=material',label:'局部参考'},
      {element:'detail-candidate',url:'/api/detail-preview/'+currentEntry.submission_id+'/model?style=material',label:'局部候选'}
    ],data.frame,{view:currentView,style:$('detail-style').value});
    if(generation!==previewGeneration){loaded.dispose();return;}preview=loaded;
    preview.setView(currentView);preview.setStyle($('detail-style').value);
    $('detail-viewer-status').textContent=currentCard.scoreable?'已加载。正面、斜视和全貌使用参考预设；拖动或缩放会同步两个视窗。':currentCard.exclusion_reason;
  }catch(e){if(generation===previewGeneration)error(e);}
}
function drawHuman(summary){
  const target=$('detail-human-summary');target.replaceChildren(el('h3','','人工细节评分'));
  const row=el('div','human-counts');
  for(const [value,label] of [[summary.independent_reviewers,'独立评审者'],[summary.human_ratings,'人工卡片评分'],[summary.practice_ratings,'练习卡片评分']]){
    const item=el('span');item.append(el('strong','',String(value)),document.createTextNode(label));row.append(item);
  }
  target.append(row,el('p','','每张卡片至少 '+summary.min_reviewers+' 位独立评审。分歧达到 2 分或出现资料争议时保留待核验；所有要求覆盖后才形成初步细节总分。'));
  if(!summary.results.length)target.append(el('p','muted','尚无独立人工细节分；自动深度检查没有被转换成人工分数。'));
  for(const result of summary.results){
    const text=result.score===null?'细节总分待核验；可汇总卡片覆盖 '+(result.coverage*100).toFixed(0)+'%':'初步细节分 '+result.score.toFixed(1)+' / 100';
    target.append(el('p','',text));
  }
}
async function showRating(next){
  const generation=++ratingGeneration;ratingView?.dispose();ratingView=null;rating=next;selectedScore=undefined;unknown=false;
  $('detail-review-start').hidden=true;$('detail-review-mode-pill').textContent=next.mode==='practice'?'练习 · 不计入人工结果':'独立人工细节评审';
  $('detail-rating-item').hidden=next.complete;$('detail-rating-complete').hidden=!next.complete;
  if(next.complete){
    $('detail-next-round').disabled=next.remaining_candidates===0;
    $('individual-detail-feedback').textContent=next.individual_detail?.score!==null&&next.individual_detail?.score!==undefined?
      '本轮个人'+(next.mode==='practice'?'练习':'')+'分：'+next.individual_detail.score.toFixed(1)+' / 100。此数值不是多人一致性结论。':
      '本轮存在未确定的卡片，个人总分暂不计算。';
    drawHuman(await api('/api/detail-summary'));return;
  }
  $('rating-title').textContent=next.card.title;$('rating-progress').textContent=(next.progress.done+1)+' / '+next.progress.total;
  $('rating-question').textContent=next.question;$('rating-requirements').replaceChildren(...next.card.requirements.map(t=>el('li','',t)));
  $('rating-notes').value='';$('rating-style').value='gray';$('save-rating').disabled=true;$('rating-unknown').disabled=true;$('rating-unknown').setAttribute('aria-pressed','false');
  $('rating-save-hint').textContent='请先检查参考和局部视角，再选择分数。';
  $('rating-options').replaceChildren(...next.card.anchors.map((text,score)=>{
    const button=el('button','rating-option');button.type='button';button.disabled=true;button.dataset.score=String(score);button.setAttribute('aria-pressed','false');
    button.append(el('strong','',String(score)),el('span','',text));
    button.addEventListener('click',()=>{
      unknown=false;selectedScore=score;$('rating-unknown').setAttribute('aria-pressed','false');
      for(const b of $('rating-options').children)b.setAttribute('aria-pressed',String(b===button));
      $('save-rating').disabled=false;$('rating-save-hint').textContent='已选择 '+score+' 分；保存前可补充观察。';
    });return button;
  }));
  ratingCamera=next.card.views[0];
  fillViews($('rating-views'),next.card.views,view=>{ratingCamera=view;ratingView?.setView(view);});
  $('rating-evidence').replaceChildren(...next.evidence.map(source=>{
    const link=el('a','secondary',source.id+' · 原始依据');link.href=source.url;link.target='_blank';link.rel='noopener';return link;
  }));
  $('rating-load-status').textContent='正在加载参考和匿名候选，评分暂不可提交…';
  try{
    const loaded=await createViewers([
      {element:'rating-reference',url:next.reference,label:'评分参考'},{element:'rating-candidate',url:next.candidate,label:'匿名细节候选'}
    ],next.frame,{view:next.card.views[0],style:'gray'});
    if(generation!==ratingGeneration){loaded.dispose();return;}ratingView=loaded;
    ratingView.setView(ratingCamera);ratingView.setStyle($('rating-style').value);
    $('rating-load-status').textContent='两个模型均已加载；请结合正面与斜视检查，颜色不计入几何细节分。';
    for(const button of $('rating-options').children)button.disabled=false;$('rating-unknown').disabled=false;
  }catch(e){if(generation===ratingGeneration)error(e);}
}
$('detail-variant').addEventListener('change',()=>showPreview().catch(error));
$('detail-card').addEventListener('change',()=>showPreview().catch(error));
$('detail-style').addEventListener('change',()=>preview?.setStyle($('detail-style').value));
$('rating-style').addEventListener('change',()=>ratingView?.setStyle($('rating-style').value));
$('detail-review-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;$('error').hidden=true;
  try{await showRating(await api('/api/detail-reviews/start',{reviewer:$('detail-reviewer').value,mode:$('detail-review-mode').value}));}
  catch(e){error(e);}finally{button.disabled=false;}
});
$('rating-unknown').addEventListener('click',()=>{
  unknown=true;selectedScore=null;$('rating-unknown').setAttribute('aria-pressed','true');
  for(const b of $('rating-options').children)b.setAttribute('aria-pressed','false');
  $('save-rating').disabled=false;$('rating-save-hint').textContent='请在观察记录中说明资料不足的原因；此卡片会保留待核验。';
});
$('save-rating').addEventListener('click',async()=>{
  $('save-rating').disabled=true;$('error').hidden=true;
  for(const b of $('rating-options').children)b.disabled=true;$('rating-unknown').disabled=true;
  try{
    const result=await api('/api/detail-reviews/'+rating.session_id+'/rating',{item_id:rating.item_id,score:selectedScore,
      insufficient_evidence:unknown,notes:$('rating-notes').value});
    await showRating(result.next);drawHuman(await api('/api/detail-summary'));
  }catch(e){error(e);$('save-rating').disabled=false;for(const b of $('rating-options').children)b.disabled=false;$('rating-unknown').disabled=false;}
});
$('detail-new-reviewer').addEventListener('click',()=>{$('detail-rating-complete').hidden=true;$('detail-review-start').hidden=false;});
$('detail-next-round').addEventListener('click',async()=>{
  $('detail-next-round').disabled=true;
  try{await showRating(await api('/api/detail-reviews/start',{reviewer:$('detail-reviewer').value,mode:$('detail-review-mode').value,new_round:true}));}
  catch(e){error(e);$('detail-next-round').disabled=false;}
});
try{
  data=await api('/api/detail-overview');
  if(!data.available){$('detail-unavailable').hidden=false;$('detail-calibration-status').textContent='未生成';}
  else{
    $('detail-workspace').hidden=false;$('detail-calibration-status').textContent=data.calibration.checks.filter(c=>c.passed).length+' / '+data.calibration.checks.length+' 项校准通过';
    $('detail-statistics').replaceChildren(...[
      ['可评分细节卡片',data.calibration.scoreable_cards,'另有 1 张资料不足卡片已预先排除'],
      ['对照样例',data.entries.length,'颜色不变性与八种局部缺陷'],
      ['局部测量视角',data.cards.reduce((n,c)=>n+c.views.length,0),'参考固定取景，逐卡片对照'],
      ['人工卡片评分数',data.human.human_ratings,'未评分时不生成总分']
    ].map(([title,value,note])=>{const node=el('div','stat');node.append(el('div','stat-label',title),el('div','stat-value',String(value)),el('div','stat-note',note));return node;}));
    $('detail-variant').replaceChildren(...data.entries.map(entry=>{const option=el('option','',entry.label);option.value=entry.submission_id;return option;}));
    $('detail-card').replaceChildren(...data.cards.map(card=>{const option=el('option','',card.title+(card.scoreable?'':' · 不评分'));option.value=card.id;return option;}));
    $('detail-check-total').textContent=data.calibration.checks.length+' CHECKS';
    $('detail-checks').replaceChildren(...data.calibration.checks.map(c=>{const row=el('div','check');row.append(el('span','',c.passed?'✓':'×'),document.createTextNode(c.description));return row;}));
    drawHuman(data.human);await showPreview();
  }
}catch(e){error(e);}
