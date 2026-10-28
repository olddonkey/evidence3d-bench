// Scores one submission in its own process, after the contestant's process
// tree is gone. A separate process keeps a CPU-heavy scorer from stalling the
// runner's event loop, where the wall-clock timers of other running attempts
// live, and keeps a scorer crash from taking the batch down with it.
//   node score-worker.mjs <job.json>
// job: { module, glb, taskDir, truthDir, dataRoot, outDir }
// or, for an attempt's snapshots (snapshots.mjs), scored one after another
// against one loaded task, without error maps:
// job: { module, taskDir, truthDir, dataRoot, snapshots: [{ name, glb, out }] }
// Each snapshot's report (or { scorer_failed: true, error } when the scorer
// threw on it) is written to its `out`; one failing snapshot does not stop
// the others.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(await readFile(process.argv[2], 'utf8'));
const scorer = await import(pathToFileURL(job.module).href);
const { scoreSubmission } = scorer;
if (typeof scoreSubmission !== 'function') throw new Error(job.module + ' does not export scoreSubmission');
if (Array.isArray(job.snapshots)) {
  let context;
  if (typeof scorer.loadContext === 'function') context = await scorer.loadContext({ taskDir: job.taskDir, truthDir: job.truthDir, dataRoot: job.dataRoot });
  for (const snapshot of job.snapshots) {
    let written;
    try {
      const report = await scoreSubmission({ glb: await readFile(snapshot.glb), taskDir: job.taskDir, truthDir: job.truthDir, dataRoot: job.dataRoot, context });
      if (!report || typeof report !== 'object') throw new Error('scoreSubmission returned no report');
      written = report;
    } catch (error) { written = { scorer_failed: true, error: error?.message ?? String(error) }; }
    await mkdir(dirname(snapshot.out), { recursive: true });
    await writeFile(snapshot.out, JSON.stringify(written, null, 2) + '\n');
    console.log(JSON.stringify({ snapshot: snapshot.name, valid: written.valid ?? null, score: written.score ?? null, error: written.error ?? null }));
  }
} else {
  const glb = await readFile(job.glb);
  const report = await scoreSubmission({ glb, taskDir: job.taskDir, truthDir: job.truthDir, dataRoot: job.dataRoot, outDir: job.outDir });
  if (!report || typeof report !== 'object') throw new Error('scoreSubmission returned no report');
  await mkdir(job.outDir, { recursive: true });
  await writeFile(join(job.outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ valid: report.valid, score: report.score, error: report.error ?? null }));
}
