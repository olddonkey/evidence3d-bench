import { join } from 'node:path';
import { readJSON,writeJSON,objectHash } from './io.mjs';
export async function prepareDetailDrafts(dataRoot,catalogPath) {
  const catalog=await readJSON(catalogPath),prepared=[];
  for(const item of catalog.cases) {
    let task;try{task=await readJSON(join(dataRoot,'tasks',item.task_id,'task.json'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
    const source=task.inputs.find(i=>i.id===item.source_id);if(!source)throw new Error('Unknown draft source');
    const path=join(dataRoot,'annotations','details-'+item.task_id+'.json');
    let previous;try{previous=await readJSON(path);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(previous) {
      if(previous.task_sha256!==objectHash(task))throw new Error('Draft task revision changed; keep independent edits in a versioned worksheet');
      prepared.push({task_id:item.task_id,count:previous.cards.length,preserved:true});continue;
    }
    const worksheet={schema_version:1,kind:'detail_annotation_draft',task_id:task.id,task_sha256:objectHash(task),
      status:'pending_independent_review',created_by:'assistant_from_visually_inspected_source',reviewers:[],
      source_limit:item.source_limit,weights_status:'draft_not_scoring',cards:item.cards.map(([id,title,category,rect,question])=>({
        id,title,category,source_regions:[{source_id:item.source_id,source_sha256:source.sha256,rect}],
        proposed_check:question,status:'pending_review',scoreable:false,world_camera:null,thresholds:null,
        approved_requirements:[],approved_anchors:[],notes:'裁切区域为草案；需独立确认可见性、证据、容差和评分锚点。'
      }))};
    await writeJSON(path,worksheet);prepared.push({task_id:item.task_id,count:worksheet.cards.length,preserved:false});
  }
  return prepared;
}
