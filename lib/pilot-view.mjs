import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJSON, existingContained, sha256 } from './io.mjs';
import { neutralGLB } from './glb.mjs';

const ID = /^[a-z0-9][a-z0-9-]{1,119}$/;
async function optional(path, fallback) {
  try { return await readJSON(path); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export async function listPilots(dataRoot) {
  let names;
  try { names = await readdir(join(dataRoot, 'pilots')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const result = [];
  for (const id of names.filter(n => ID.test(n))) {
    const summary = await optional(join(dataRoot, 'pilots', id, 'summary.json'), null);
    if (summary) result.push({ id, model: summary.manifest.model_requested, tasks: summary.manifest.tasks.length,
      completed: summary.results.length, complete: summary.complete, created_at: summary.manifest.created_at });
  }
  return result.sort((a, b) => b.created_at.localeCompare(a.created_at));
}
export async function pilotOverview(dataRoot, id) {
  if (!ID.test(id)) throw new Error('Invalid pilot id');
  const batch = await existingContained(dataRoot, 'pilots/' + id), summary = await readJSON(join(batch, 'summary.json'));
  const findings = await optional(join(batch, 'environment-findings.json'), { notes: [] });
  const tasks = [];
  for (const entry of summary.manifest.tasks) {
    if (!ID.test(entry.id)) throw new Error('Invalid task id');
    const task = await readJSON(await existingContained(dataRoot, 'tasks/' + entry.id + '/task.json'));
    const result = summary.results.find(r => r.task_id === entry.id);
    const report = result?.report ? await readJSON(await existingContained(batch, entry.id + '/evaluation/report.json')) : null;
    const frame = report?.technical.valid ? report.technical.bounds : null;
    tasks.push({ id: task.id, title: task.title, status: result?.status || 'pending',
      wall_seconds: result?.wall_seconds ?? null, usage: result?.usage ?? null,
      technical: report?.technical ?? null, eligibility: report?.eligibility ?? null,
      geometry_checks_pass: report?.geometry_checks_pass ?? null, metrics: report?.metrics ?? null,
      detail_checks: report?.detail_geometry ? { passed: report.detail_geometry.auto_passed_cards, total: report.detail_geometry.scoreable_cards } : null,
      human_visual_score: null, frame, frame_purpose: 'artifact_navigation_only',
      model_url: frame ? '/api/pilots/' + id + '/' + task.id + '/model' : null,
      detail_url: task.split === 'calibration' && result?.registration?.registered ? '/?example=' + task.id + '#details' : null,
      inputs: task.inputs.map(i => ({ id: i.id, role: i.role, path: i.path, url: '/api/tasks/' + task.id + '/inputs/' + i.id })) });
  }
  return { id, model: summary.manifest.model_requested, reasoning_effort: summary.manifest.reasoning_effort,
    harness: summary.manifest.harness, tools: { codex: summary.manifest.tools.codex_version, node: summary.manifest.tools.node_version,
      three: summary.manifest.tools.three_version }, complete: summary.complete, attempts_per_task: 1,
    official_leaderboard_eligible: false, notes: findings.notes.map(n => n.public_note).filter(Boolean), tasks };
}
export async function pilotModel(dataRoot, id, taskId, material = false) {
  if (!ID.test(id) || !ID.test(taskId)) throw new Error('Invalid pilot or task id');
  const batch = await existingContained(dataRoot, 'pilots/' + id), summary = await readJSON(join(batch, 'summary.json'));
  if (!summary.manifest.tasks.some(t => t.id === taskId) || !summary.results.some(r => r.task_id === taskId && r.technical_valid))
    throw new Error('Unknown or invalid pilot artifact');
  const report = await readJSON(await existingContained(batch, taskId + '/evaluation/report.json'));
  const bytes = await readFile(await existingContained(batch, taskId + '/workspace/output/model.glb'));
  if (!report.technical.valid || sha256(bytes) !== report.technical.artifact_sha256) throw new Error('Pilot artifact hash changed');
  return neutralGLB(bytes, { preserveMaterials: material });
}
