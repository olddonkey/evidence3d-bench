import { join } from 'node:path';
import { readJSON,writeJSON } from './io.mjs';

export async function optionalJSON(path,fallback=null) {
  try{return await readJSON(path);}catch(error){if(error.code==='ENOENT')return fallback;throw error;}
}
export async function listDetailExamples(dataRoot) {
  const examples=[],legacy=await optionalJSON(join(dataRoot,'detail-index.json'));
  if(legacy) {
    const task=await readJSON(join(dataRoot,'tasks',legacy.task_id,'task.json'));
    examples.push({task_id:task.id,title:task.title,index_path:'detail-index.json',calibration_path:'detail-calibration.json',
      focus:['窗棂与装饰','局部深度','整体轮廓不变'],default:true});
  }
  const catalog=await optionalJSON(join(dataRoot,'detail-examples.json'),{examples:[]});
  const ids=new Set(examples.map(e=>e.task_id));
  for(const entry of catalog.examples) {
    if(!/^[a-z][a-z0-9-]{1,79}$/.test(entry.task_id)||ids.has(entry.task_id)||
      entry.index_path!=='detail-indices/'+entry.task_id+'.json'||
      entry.calibration_path!=='detail-calibrations/'+entry.task_id+'.json')throw new Error('Invalid detail example catalogue');
    ids.add(entry.task_id);examples.push(entry);
  }
  return examples;
}
export async function detailPaths(dataRoot,taskId) {
  const examples=await listDetailExamples(dataRoot);
  const example=taskId?examples.find(e=>e.task_id===taskId):examples[0];
  if(!example)throw new Error('Unknown detail example');
  return {...example,indexPath:join(dataRoot,example.index_path),calibrationPath:join(dataRoot,example.calibration_path)};
}
export async function publishExample(dataRoot,example) {
  const path=join(dataRoot,'detail-examples.json'),catalog=await optionalJSON(path,{schema_version:1,examples:[]});
  const found=catalog.examples.findIndex(e=>e.task_id===example.task_id);
  if(found<0)catalog.examples.push(example);else catalog.examples[found]=example;
  await writeJSON(path,{schema_version:1,examples:catalog.examples});
}
