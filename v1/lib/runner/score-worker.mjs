// Scores one submission in its own process, after the contestant's process
// tree is gone. A separate process keeps a CPU-heavy scorer from stalling the
// runner's event loop, where the wall-clock timers of other running attempts
// live, and keeps a scorer crash from taking the batch down with it.
//   node score-worker.mjs <job.json>
// job: { module, glb, taskDir, truthDir, dataRoot, outDir }
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { scoreSubmission } = await import(pathToFileURL(job.module).href);
if (typeof scoreSubmission !== 'function') throw new Error(job.module + ' does not export scoreSubmission');
const glb = await readFile(job.glb);
const report = await scoreSubmission({ glb, taskDir: job.taskDir, truthDir: job.truthDir, dataRoot: job.dataRoot, outDir: job.outDir });
if (!report || typeof report !== 'object') throw new Error('scoreSubmission returned no report');
await mkdir(job.outDir, { recursive: true });
await writeFile(join(job.outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ valid: report.valid, score: report.score, error: report.error ?? null }));
