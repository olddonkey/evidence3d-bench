import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { objectHash, sha256 } from '../lib/runner/workspace.mjs';
import { buildPrompt } from '../lib/runner/prompt.mjs';
import { ADAPTERS } from '../lib/runner/adapters.mjs';
import { attemptInvocation } from '../lib/runner/index.mjs';
import { PASSED_ENV } from '../lib/runner/process.mjs';
import { readJSONLines } from '../lib/runner/events.mjs';

// The codex and claude-code systems must behave exactly as they did for the
// first test run. Every attempt of the frozen batches test1-astra (codex) and
// test1-opus (claude-code) is rebuilt with today's code: its prompt, byte for
// byte, and its invocation (command, arguments, environment, the harness
// files and their hashes) as prepare would freeze it now, which must hash to
// what the manifest recorded. Their event streams must still reduce to the
// usage, turns, commands and tools their result.json recorded. Read-only;
// skipped where the batches are not on disk.
const RUNS = join(fileURLToPath(new URL('../..', import.meta.url)), '.local', 'v1', 'runs');
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));

// The adapters read the operator's environment (HOME, USER, LANG, ...) and
// os.homedir(); they are given exactly what the frozen invocation recorded.
async function withEnvironment(recorded, fn) {
  const saved = Object.fromEntries(PASSED_ENV.map(key => [key, process.env[key]]));
  try {
    for (const key of PASSED_ENV) { if (recorded[key] === undefined) delete process.env[key]; else process.env[key] = recorded[key]; }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

for (const [batch, system] of [['test1-astra', 'codex'], ['test1-opus', 'claude-code']]) {
  const dir = join(RUNS, batch);
  test(`${system}: prompts and invocations of ${batch} are rebuilt exactly by today's code`, { skip: !existsSync(join(dir, 'manifest.json')) && batch + ' is not on this machine' }, async () => {
    const manifest = await readJSON(join(dir, 'manifest.json'));
    assert.equal(manifest.system, system);
    const adapter = ADAPTERS[system];
    let checked = 0;
    for (const task of manifest.tasks) {
      for (const attempt of task.attempts) {
        const attemptDir = join(dir, attempt.dir), recorded = await readJSON(join(attemptDir, 'invocation.json'));
        const taskRecord = await readJSON(join(recorded.workspace, 'input', 'task.json'));
        const prompt = buildPrompt({ system, task: taskRecord, threeVersion: manifest.runtime.three_version });
        assert.equal(prompt, await readFile(join(attemptDir, 'prompt.txt'), 'utf8'), attempt.dir + ': prompt text');
        assert.equal(sha256(prompt), task.prompt_sha256, attempt.dir + ': prompt hash');
        // The paths prepare used: the attempt directory is the workspace's parent.
        const { invocation, files } = await withEnvironment(recorded.env, () => attemptInvocation({ adapter, harness: manifest.harness, task: taskRecord,
          workspace: recorded.workspace, attemptDir: dirname(recorded.workspace), node: manifest.node }));
        assert.deepEqual(invocation, recorded, attempt.dir + ': invocation');
        assert.equal(objectHash(invocation), attempt.invocation_sha256, attempt.dir + ': invocation hash');
        for (const [path, content] of Object.entries(files)) assert.deepEqual(content, await readJSON(join(attemptDir, path.slice(dirname(recorded.workspace).length + 1))), path);
        checked++;
      }
    }
    assert.equal(checked, manifest.tasks.reduce((sum, task) => sum + task.attempts.length, 0));
  });

  test(`${system}: the event streams of ${batch} still reduce to the usage, turns and commands recorded`, { skip: !existsSync(join(dir, 'manifest.json')) && batch + ' is not on this machine' }, async () => {
    const manifest = await readJSON(join(dir, 'manifest.json'));
    const adapter = ADAPTERS[system];
    let checked = 0;
    // The first attempt of the first twelve tasks, and every earlier try kept beside them.
    for (const task of manifest.tasks.slice(0, 12)) {
      const parent = join(dir, task.id);
      for (const name of (await readdir(parent)).filter(name => /^a1(\.infra-\d+)?$/.test(name))) {
        const result = await readJSON(join(parent, name, 'result.json')).catch(() => null);
        if (!result) continue;
        const summary = adapter.parse(readJSONLines(await readFile(join(parent, name, 'events.jsonl'), 'utf8').catch(() => '')));
        for (const key of ['usage', 'turns', 'commands', 'cost_usd', 'tools', 'model_reported', 'usage_detail']) {
          assert.deepEqual(summary[key] ?? null, result[key] ?? null, task.id + '/' + name + ': ' + key);
        }
        checked++;
      }
    }
    assert.ok(checked >= 12, 'attempts compared: ' + checked);
  });
}
