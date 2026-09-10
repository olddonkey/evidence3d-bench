#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { buildCalibration } from './lib/fixtures.mjs';
import { buildDetailCalibration } from './lib/detail-fixtures.mjs';
import { prepareDetailDrafts } from './lib/detail-drafts.mjs';
import { detailSummary } from './lib/detail-reviews.mjs';
import { registerDetailSubmission } from './lib/detail-registration.mjs';
import { prepareRealTasks, exportTask } from './lib/prepare.mjs';
import { evaluate } from './lib/evaluate.mjs';
import { startServer } from './lib/server.mjs';
import { readJSON, writeJSON, objectHash, sha256, existingContained, verifySources } from './lib/io.mjs';
import { validateTask, validateSubmission } from './lib/contracts.mjs';
import { readVotes, summarizeVotes } from './lib/reviews.mjs';

const root=dirname(fileURLToPath(import.meta.url)), args=process.argv.slice(2), command=args.shift()||'help';
const options={};
while(args.length) {
  const key=args.shift();
  if(!key.startsWith('--')||!args.length) throw new Error('Options need --name value');
  options[key.slice(2)]=args.shift();
}
const dataRoot=resolve(options.data||join(root,'.local'));
const sourceRoot=resolve(options.source||join(root,'..','img2threejs'));
async function required(name) {if(!options[name])throw new Error('Missing --'+name);return resolve(options[name]);}
try {
  if(command==='demo') {
    const calibration=await buildCalibration(dataRoot);
    console.log('Calibration: '+calibration.checks.filter(c=>c.passed).length+'/'+calibration.checks.length+
      ' checks; '+calibration.submission_count+' submissions; '+(calibration.passed?'PASS':'FAIL'));
    if(!calibration.passed) process.exitCode=1;
    const details=await buildDetailCalibration(dataRoot);
    console.log('Detail calibration: '+details.checks.filter(c=>c.passed).length+'/'+details.checks.length+' checks; '+details.submissions+' submissions; '+(details.passed?'PASS':'FAIL'));
    if(!details.passed)process.exitCode=1;
  } else if(command==='demo-details') {
    const result=await buildDetailCalibration(dataRoot);
    console.log(JSON.stringify(result,null,2));
    if(!result.passed)process.exitCode=1;
  } else if(command==='prepare') {
    const cases=await prepareRealTasks(dataRoot,sourceRoot,join(root,'tasks','catalog.json'));
    const drafts=await prepareDetailDrafts(dataRoot,join(root,'tasks','detail-drafts.json'));
    console.log(JSON.stringify({prepared:cases,detail_drafts:drafts,ground_truth:'pending_independent_review'},null,2));
  } else if(command==='pack') {
    console.log(JSON.stringify(await exportTask(await required('task'),await required('out')),null,2));
  } else if(command==='submit') {
    const task=validateTask(await readJSON(await required('task')));
    const artifact=await required('artifact'), folder=dirname(artifact), bytes=await readFile(artifact);
    if(!options.id) throw new Error('Missing --id');
    const submission={
      schema_version:1,id:options.id,task_id:task.id,task_sha256:objectHash(task),
      artifact:{path:artifact.slice(folder.length+1),sha256:sha256(bytes)},
      system:{name:options.system||'local-submission',model_version:options.model||'unspecified',harness_version:options.harness||'unspecified'},
      run:{seed:options.seed===undefined?null:Number(options.seed),wall_seconds:Number(options.seconds||0),
        cost_usd:options.cost===undefined?null:Number(options.cost),human_intervention:options.human!=='false',resource_accounting:'self_reported'}
    };
    validateSubmission(submission,task);
    const path=join(folder,'submission.json');await writeJSON(path,submission);console.log(path);
  } else if(command==='evaluate') {
    const report=await evaluate({taskPath:await required('task'),submissionPath:await required('submission'),
      truthPath:options.truth?resolve(options.truth):undefined,outputDir:await required('out')});
    console.log(JSON.stringify({technical:report.technical.valid,eligibility:report.eligibility,geometry_checks_pass:report.geometry_checks_pass,
      max_dimension_error:report.metrics?.max_dimension_error,min_silhouette_iou:report.metrics?.min_silhouette_iou,error:report.error},null,2));
    if(['invalid_submission','evaluation_error'].includes(report.eligibility))process.exitCode=1;
  } else if(command==='verify') {
    let inputs=0,tasks=0;
    for(const id of await readdir(join(dataRoot,'tasks'))) {
      const task=validateTask(await readJSON(join(dataRoot,'tasks',id,'task.json')));
      inputs+=(await verifySources(task,join(dataRoot,'tasks',id))).length;tasks++;
    }
    console.log('Verified '+inputs+' locked input files across '+tasks+' tasks');
  } else if(command==='review-summary') {
    console.log(JSON.stringify(summarizeVotes(await readVotes(dataRoot)),null,2));
  } else if(command==='detail-summary') {
    console.log(JSON.stringify(await detailSummary(dataRoot),null,2));
  } else if(command==='register-detail') {
    console.log(JSON.stringify(await registerDetailSubmission(dataRoot,await required('submission'),options.label),null,2));
  } else if(command==='serve') {
    const {server,url}=await startServer({dataRoot,port:Number(options.port||5198)});
    console.log('Evidence3D Bench: '+url+'\nLocal-only. Press Ctrl-C to stop.');
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
  } else {
    console.log('Evidence3D Bench v0.2\n\n'+
      '  npm run demo                         Build fixtures and check the evaluator\n'+
      '  npm run demo:details                 Rebuild local detail calibration\n'+
      '  npm run prepare:local                Copy hash-locked local reference packs\n'+
      '  npm start                            Open the local review application\n'+
      '  npm test                             Run contract, geometry and review tests\n'+
      '  node cli.mjs pack --task FILE --out DIR\n'+
      '  node cli.mjs submit --task FILE --artifact FILE --id NAME --seconds N\n'+
      '  node cli.mjs evaluate --task FILE --submission FILE --truth FILE --out DIR\n'+
      '  node cli.mjs verify\n'+
      '  node cli.mjs review-summary\n\n'+
      '  node cli.mjs detail-summary\n'+
      '  node cli.mjs register-detail --submission FILE --label NAME\n\n'+
      'All commands accept --data DIR. prepare accepts --source /path/to/img2threejs.\n'+
      'No model API calls, remote repository, uploads, or synthetic human votes are created.');
  }
} catch(error) {console.error(error.message);process.exitCode=1;}
