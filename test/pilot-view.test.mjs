import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as THREE from 'three';
import { sceneToGLB, geometryFromBytes } from '../lib/glb.mjs';
import { writeJSON, sha256 } from '../lib/io.mjs';
import { listPilots, pilotOverview, pilotModel } from '../lib/pilot-view.mjs';
import { startServer } from '../lib/server.mjs';

test('pilot preview lists started runs, hides preparations, and preserves unscored real geometry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e3d-pilot-view-'));
  let server;
  try {
    assert.deepEqual(await listPilots(root), []);
    const dir = join(root, 'pilots', 'example-run'), job = join(dir, 'real-example');
    await mkdir(join(job, 'workspace', 'output'), { recursive: true });
    await mkdir(join(root, 'pilots', 'prepared-only'), { recursive: true });
    const manifest={model_requested:'test-model',tasks:[{id:'real-example'}],created_at:'2026-01-01',tools:{}};
    await writeJSON(join(dir,'manifest.json'),manifest);
    await writeJSON(join(root, 'tasks', 'real-example', 'task.json'), { id: 'real-example', title: 'Example', split: 'development', inputs: [] });
    assert.equal((await listPilots(root)).length,0);
    await writeJSON(join(job,'started.json'),{at:'2026-01-01'});
    assert.equal((await listPilots(root))[0].completed,0);
    assert.equal((await pilotOverview(root,'example-run')).tasks[0].status,'running');
    const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), new THREE.MeshStandardMaterial()));
    const bytes = sceneToGLB(scene), artifact = join(job, 'workspace', 'output', 'model.glb');
    await writeFile(artifact, bytes);
    const geometry = geometryFromBytes(bytes);
    await writeJSON(join(job, 'evaluation', 'report.json'), {
      technical: { valid: true, artifact_sha256: sha256(bytes), bounds: geometry.bounds }, eligibility: 'annotation_pending', metrics: null });
    await writeJSON(join(root, 'tasks', 'real-example', 'task.json'), { id: 'real-example', title: 'Example', split: 'development', inputs: [] });
    await writeJSON(join(dir, 'summary.json'), {
      manifest: { model_requested: 'test-model', tasks: [{ id: 'real-example' }], created_at: '2026-01-01',
        tools: { codex_version: 'test', node_version: 'test', three_version: 'test' } }, complete: true,
      results: [{ task_id: 'real-example', technical_valid: true, status: 'completed', wall_seconds: 12,
        report: '/host/private/location', artifact: '/host/private/ignored.glb', prompt: 'PRIVATE-PROMPT', raw_log: 'PRIVATE-LOG' }],
    });
    assert.equal((await listPilots(root)).length, 1);
    const data = await pilotOverview(root, 'example-run');
    assert.equal(data.tasks[0].metrics, null); assert.equal(data.tasks[0].human_visual_score, null);
    assert.equal(data.tasks[0].frame_purpose, 'artifact_navigation_only');
    assert.equal(data.official_leaderboard_eligible, false);
    assert.ok(!JSON.stringify(data).includes('PRIVATE')); assert.ok(!JSON.stringify(data).includes('/host/private'));
    assert.ok((await pilotModel(root, 'example-run', 'real-example')).length);
    const started = await startServer({ dataRoot: root, port: 0 }); server = started.server;
    assert.equal((await fetch(started.url + '/pilots')).status, 200);
    assert.equal((await fetch(started.url + '/api/pilots/example-run/real-example/model')).status, 200);
    assert.equal((await fetch(started.url + '/api/pilots/example-run/events.jsonl')).status, 404);
    await writeFile(artifact, Buffer.from('tampered'));
    assert.equal((await fetch(started.url + '/api/pilots/example-run/real-example/model')).status, 400);
    await assert.rejects(() => pilotOverview(root, '../private'), /Invalid/);
    await assert.rejects(() => pilotModel(root, 'example-run', 'other-task'), /Unknown/);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
