import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureProcess, summarizeEvents, hostEnvironment } from '../lib/codex-pilot.mjs';

test('pilot collects completion usage; missing completion remains unknown', () => {
  assert.equal(summarizeEvents([{ type: 'turn.failed', error: { message: 'unavailable' } }]).usage, null);
  const result = summarizeEvents([
    { type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 7 } },
    { type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 4 } },
    { type: 'item.completed', item: { type: 'command_execution' } },
    { type: 'error', message: 'recorded error' },
  ]);
  assert.deepEqual(result.usage, { input_tokens: 17, cached_input_tokens: 5, output_tokens: 11 });
  assert.equal(result.commands, 1); assert.deepEqual(result.errors, ['recorded error']);
});

test('pilot does not forward API keys or unrelated service credentials to child environment', () => {
  const before = process.env.OPENAI_API_KEY, other = process.env.OPENCODEX_API_AUTH_TOKEN;
  try {
    process.env.OPENAI_API_KEY = 'test-placeholder'; process.env.OPENCODEX_API_AUTH_TOKEN = 'test-placeholder';
    assert.equal(hostEnvironment().OPENAI_API_KEY, undefined);
    assert.equal(hostEnvironment().OPENCODEX_API_AUTH_TOKEN, undefined);
  } finally {
    if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before;
    if (other === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN; else process.env.OPENCODEX_API_AUTH_TOKEN = other;
  }
});

test('pilot captures split JSON events and exact raw log with measured duration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'e3d-runner-test-'));
  try {
    const events = [];
    const result = await captureProcess(process.execPath, ['-e',
      'process.stdout.write("{\\\"type\\\":"); setTimeout(()=>process.stdout.write("\\\"turn.completed\\\"}\\n"),30)'],
    { cwd: dir, logPrefix: join(dir, 'events'), seconds: 3, onEvent: e => events.push(e) });
    assert.equal(result.exit_code, 0); assert.equal(result.timed_out, false);
    assert.ok(result.wall_seconds > 0); assert.deepEqual(events, [{ type: 'turn.completed' }]);
    assert.equal(await readFile(join(dir, 'events.jsonl'), 'utf8'), '{"type":"turn.completed"}\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pilot timeout ends a worker instead of treating partial output as completion', async () => {
  const result = await captureProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { seconds: 0.08 });
  assert.equal(result.timed_out, true); assert.notEqual(result.exit_code, 0);
  assert.ok(result.wall_seconds < 3);
});
