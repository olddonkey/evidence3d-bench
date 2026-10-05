import { realpathSync, accessSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvironment } from '../process.mjs';
import { sha256File, sha256 } from '../workspace.mjs';
import { apiSystemPrompt, API_PROMPT_VERSION } from '../prompt.mjs';
import { sandboxProfile, sandboxEnvironment, SANDBOX_EXEC } from './sandbox.mjs';
import { TOOL_SPECS, OUTPUT_LIMIT, SHELL_TIMEOUT, IMAGE_MAX_SIDE, IMAGE_MAX_BYTES } from './tools.mjs';
import { DEFAULT_BUDGET } from './budget.mjs';
import { parseApiEvents } from './events.mjs';
import { apiPreflight } from './preflight.mjs';
import { ANTHROPIC } from './anthropic.mjs';
import { OPENAI } from './openai.mjs';

// The adapters of the two API systems. Their "harness binary" is the loop
// (loop.mjs), run by the batch's frozen Node. Everything a session depends on
// is frozen at prepare into <attempt>/harness/api-config.json (hashed into
// the invocation): provider, model, effort, base URL, the system prompt, the
// tool definitions, the budget, the output and retry limits and the Seatbelt
// profile. The key is not: it is read from the environment when an attempt
// launches and handed to the loop on stdin.
const HERE = dirname(fileURLToPath(import.meta.url));
export const LOOP_PATH = join(HERE, 'loop.mjs');
export const API_LOOP_VERSION = 'e3d-api-loop-v1';
// The wall clock is a safety cap of WALL_FACTOR times the task's wall budget.
export const WALL_FACTOR = 2;
// Output tokens per request (thinking included). Non-streaming: large enough
// for a long file in one call, small enough that a request finishes well
// within the 10 minutes the Claude docs give as the limit for non-streaming
// requests.
export const DEFAULT_MAX_OUTPUT_TOKENS = 32000;
// In-loop retries: backoff before each retry of a 5xx/529/network failure
// (then infra_error); a rate limit is waited out in the loop if one wait is at
// most rate_wait_max_ms and all waits of one request at most
// rate_wait_total_ms (below the runner's 10-minute retry watchdog), else the
// session ends with rate_limit and the runner holds the batch.
export const DEFAULT_RETRY = { backoff_ms: [10000, 30000, 90000], rate_wait_max_ms: 120000, rate_wait_total_ms: 480000, rate_default_ms: 30000 };
export const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

const MODEL_ID = /^[A-Za-z0-9._:\/\[\]@-]{1,200}$/;

function baseUrl(provider, env) {
  const value = env[provider.baseVariable] || provider.defaultBase;
  let url;
  try { url = new URL(value); } catch { throw new Error(provider.baseVariable + ' is not a URL: ' + value); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(provider.baseVariable + ' must be an http(s) URL');
  if (url.username || url.password) throw new Error(provider.baseVariable + ' must not carry credentials');
  return value.replace(/\/+$/, '');
}

function apiAdapter(provider) {
  return {
    id: provider.system, provider, api: true, usesApiKey: true,
    defaultBinary: () => LOOP_PATH,
    // budget: { tokens, tool_calls }; env: where the key and base URL are
    // looked up (only whether the key is set is recorded).
    async inspect({ binary, model, effort, budget = {}, maxOutputTokens, retry, env = process.env }) {
      if (binary && realpathSync(binary) !== realpathSync(LOOP_PATH)) throw new Error(provider.system + ' runs its own loop; --binary does not apply');
      if (typeof model !== 'string' || !MODEL_ID.test(model)) throw new Error('Invalid model id ' + model);
      if (effort !== undefined && effort !== null && !provider.efforts.includes(effort)) {
        throw new Error(provider.system + ' effort must be one of ' + provider.efforts.join(', ') + ' (whether this model supports it is checked by preflight)');
      }
      const tokens = budget.tokens ?? DEFAULT_BUDGET.tokens, toolCalls = budget.tool_calls ?? DEFAULT_BUDGET.tool_calls;
      if (!Number.isInteger(tokens) || tokens < 10000) throw new Error('--token-budget must be an integer of at least 10000');
      if (!Number.isInteger(toolCalls) || toolCalls < 1) throw new Error('--tool-budget must be a positive integer');
      const maxOutput = maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
      if (!Number.isInteger(maxOutput) || maxOutput < 1024) throw new Error('--max-output-tokens must be an integer of at least 1024');
      try { accessSync(SANDBOX_EXEC, constants.X_OK); } catch { throw new Error(SANDBOX_EXEC + ' is not available; the API systems need macOS Seatbelt'); }
      const path = realpathSync(LOOP_PATH);
      return {
        system: provider.system, provider: provider.id, api: provider.api, binary: LOOP_PATH, binary_realpath: path, binary_sha256: await sha256File(path),
        version: API_LOOP_VERSION, login: 'api_key', key_variable: provider.keyVariable, key_present: Boolean(env[provider.keyVariable]),
        base_url: baseUrl(provider, env), base_url_default: provider.defaultBase,
        model, effort: effort ?? null, effort_levels: provider.efforts,
        budget: { tokens, tool_calls: toolCalls, notice: DEFAULT_BUDGET.notice, wall_factor: WALL_FACTOR },
        max_output_tokens: maxOutput, retry: { ...DEFAULT_RETRY, ...retry }, request_timeout_ms: REQUEST_TIMEOUT_MS,
        prompt_version: API_PROMPT_VERSION,
      };
    },
    wallSeconds: task => WALL_FACTOR * task.budget.wall_seconds,
    invocation({ harness, model, effort, workspace, attemptDir, node, wallSeconds }) {
      const configPath = join(attemptDir, 'harness', 'api-config.json');
      const wallCap = WALL_FACTOR * (wallSeconds ?? 1800);
      const budget = harness.budget ?? { ...DEFAULT_BUDGET, wall_factor: WALL_FACTOR };
      const config = {
        schema: 'e3d-api-config-v1', system: provider.system, provider: provider.id, api: provider.api, model, effort: effort ?? null,
        base_url: harness.base_url ?? provider.defaultBase, workspace,
        system_prompt: apiSystemPrompt({ budget, wallCapSeconds: wallCap, outputLimit: OUTPUT_LIMIT, noticeFraction: budget.notice }),
        tools: TOOL_SPECS,
        budget: { tokens: budget.tokens, tool_calls: budget.tool_calls, notice: budget.notice },
        wall_cap_seconds: wallCap, max_output_tokens: harness.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        limits: { output_chars: OUTPUT_LIMIT, shell_timeout: SHELL_TIMEOUT, image_max_side: IMAGE_MAX_SIDE, image_max_bytes: IMAGE_MAX_BYTES },
        retry: harness.retry ?? DEFAULT_RETRY, request_timeout_ms: harness.request_timeout_ms ?? REQUEST_TIMEOUT_MS,
        cache_key: 'e3d-' + sha256(attemptDir).slice(0, 24),
        sandbox: { exec: SANDBOX_EXEC, profile: sandboxProfile({ workspace, readRoots: node.read_roots }), env: sandboxEnvironment({ workspace, nodeBin: node.bin }) },
      };
      return { command: node.path, args: [LOOP_PATH, configPath], cwd: workspace, env: childEnvironment(), stdin: 'prompt', files: { [configPath]: config } };
    },
    // What the loop reads on stdin: the key (from the runner's environment
    // at launch, never stored) and the frozen prompt.
    stdin: (prompt, env = process.env) => JSON.stringify({ key: env[provider.keyVariable] ?? '', prompt }) + '\n',
    keyProblem: (env = process.env) => env[provider.keyVariable] ? null : provider.keyVariable + ' is not set in the environment; the ' + provider.system + ' system reads its API key from there when it runs',
    sandboxCommand: null,
    parse: parseApiEvents,
    preflight: apiPreflight,
  };
}

export const API_ADAPTERS = { 'api-anthropic': apiAdapter(ANTHROPIC), 'api-openai': apiAdapter(OPENAI) };
