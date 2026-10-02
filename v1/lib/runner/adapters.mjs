import { realpath, stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { captureProcess, childEnvironment, BASE_PATH } from './process.mjs';
import { parseCodexEvents, parseClaudeEvents, CLAUDE_TOOLS } from './events.mjs';
import { sha256File } from './workspace.mjs';

// Harness adapters. Each one knows how to inspect its CLI (version, login,
// model), how to start one contestant session confined to a workspace, and how
// to read the session's event stream. The boundary each configuration enforces
// is documented in README.md and proven by preflight, not assumed.

async function existing(paths) {
  const found = [];
  for (const path of paths) { try { await stat(path); found.push(path); } catch {} }
  return found;
}

// Directories a sandboxed `node` must be able to read: its own install prefix
// and, for Homebrew, the kegs its dylibs live in plus the OpenSSL config it
// opens at start-up (Node aborts at start without it).
export async function nodeRuntime(nodePath = process.execPath) {
  const path = await realpath(nodePath), roots = [dirname(dirname(path))];
  for (const brew of ['/opt/homebrew', '/usr/local']) {
    if (path.startsWith(brew + '/')) roots.push(...await existing([brew + '/Cellar', brew + '/opt', brew + '/etc/openssl@3', brew + '/etc/ca-certificates']));
  }
  return { path, bin: dirname(path), version: process.version, read_roots: [...new Set(roots)] };
}

const run = (binary, args, options = {}) => captureProcess(binary, args, { seconds: 60, env: childEnvironment(), ...options });

// ---------------------------------------------------------------- codex
//
// `codex exec` with the user's config.toml, rules, project docs, skills,
// memories, plugins, apps, hooks, web search, browser/computer use, image
// generation and sub-agents switched off, and a named permission profile that
// Seatbelt enforces for shell commands and for the fs helper that apply_patch
// and view_image go through. CODEX_HOME stays the user's (~/.codex) because the
// ChatGPT login lives there; --ignore-user-config still skips its config.toml.
const CODEX_PROFILE = 'evidence3d';
const CODEX_FEATURES_OFF = ['apps', 'plugins', 'memories', 'hooks', 'shell_snapshot', 'multi_agent', 'multi_agent_v2', 'browser_use',
  'browser_use_external', 'computer_use', 'in_app_browser', 'image_generation', 'workspace_dependencies', 'skill_mcp_dependency_install',
  'remote_plugin', 'recommended_plugins', 'goals', 'tool_suggest', 'skill_search', 'realtime_conversation', 'standalone_web_search', 'fast_mode'];

// TOML inline values for `-c key=value`. Values go to argv, never to a shell.
export function toml(value) {
  if (Array.isArray(value)) return '[' + value.map(toml).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).map(([key, item]) => JSON.stringify(key) + '=' + toml(item)).join(',') + '}';
  return JSON.stringify(value);
}

export function codexConfig({ workspace, effort, harness, node }) {
  const filesystem = { ':minimal': 'read', ':tmpdir': 'deny', ':slash_tmp': 'deny', [workspace]: 'write' };
  for (const sub of ['input', 'tools', 'node_modules']) filesystem[join(workspace, sub)] = 'read';
  for (const root of node.read_roots) filesystem[root] = 'read';
  // The fs helper re-executes the codex binary under Seatbelt; without read
  // access to its own release directory every view_image and apply_patch fails.
  filesystem[harness.release_root] = 'read';
  const values = {
    model_reasoning_effort: effort, approval_policy: 'never', web_search: 'disabled', project_doc_max_bytes: 0,
    'skills.include_instructions': false, allow_login_shell: false, 'agents.enabled': false,
    default_permissions: CODEX_PROFILE,
    [`permissions.${CODEX_PROFILE}.filesystem`]: filesystem,
    [`permissions.${CODEX_PROFILE}.network.enabled`]: false,
    'shell_environment_policy.inherit': 'none',
    'shell_environment_policy.set': { PATH: node.bin + ':' + BASE_PATH, TMPDIR: join(workspace, 'tmp'), LANG: 'en_US.UTF-8' },
  };
  for (const feature of CODEX_FEATURES_OFF) values['features.' + feature] = false;
  return Object.entries(values).flatMap(([key, value]) => ['-c', key + '=' + toml(value)]);
}

// Codex always injects $CODEX_HOME/AGENTS.override.md (else AGENTS.md) as user
// instructions; no setting turns that off (checked against 0.159.2 with
// `codex debug prompt-input`), and CODEX_HOME cannot move without moving the
// login. A batch is therefore only frozen, preflighted or run while both files
// are absent or blank. The child never receives CODEX_HOME (the environment is
// scrubbed), so the directory it uses is always ~/.codex.
export const codexHome = () => join(homedir(), '.codex');
export async function codexGlobalInstructions(home = codexHome()) {
  const files = {};
  for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
    try { const text = await readFile(join(home, name), 'utf8'); files[name] = { bytes: text.length, blank: !text.trim() }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; files[name] = null; }
  }
  const loaded = Object.entries(files).filter(([, file]) => file && !file.blank).map(([name]) => join(home, name));
  return { home, files, loaded };
}

export const codex = {
  id: 'codex',
  defaultBinary: () => process.env.E3D_CODEX_BIN || join(homedir(), '.local/bin/codex.opencodex-real'),
  async inspect({ binary, model, effort }) {
    const path = await realpath(binary);
    const version = await run(path, ['--version']);
    if (version.exit_code !== 0) throw new Error('codex --version failed: ' + version.stderr.slice(0, 300));
    const login = await run(path, ['login', 'status']);
    if (login.exit_code !== 0 || !/Logged in using ChatGPT/.test(login.stdout + login.stderr)) {
      throw new Error('codex needs an existing ChatGPT login (codex login status); the runner never configures API keys');
    }
    const catalogRun = await run(path, ['debug', 'models', '--bundled']);
    if (catalogRun.exit_code !== 0) throw new Error('codex debug models --bundled failed');
    const catalog = JSON.parse(catalogRun.stdout), models = Array.isArray(catalog) ? catalog : catalog.models;
    const entry = models.find(item => item.slug === model);
    if (!entry) throw new Error('Model ' + model + ' is not in the codex catalog');
    const instructions = await codexGlobalInstructions();
    if (instructions.loaded.length) throw new Error('Codex would inject the user\'s global instructions into every contestant session: ' + instructions.loaded.join(', ') + ' (empty or remove it for the duration of the batch)');
    const levels = (entry.supported_reasoning_levels ?? []).map(level => level.effort);
    const chosen = effort ?? entry.default_reasoning_level;
    if (!levels.includes(chosen)) throw new Error('Model ' + model + ' does not support effort ' + chosen + ' (' + levels.join(', ') + ')');
    return {
      system: 'codex', binary, binary_realpath: path, binary_sha256: await sha256File(path), version: version.stdout.trim(),
      release_root: dirname(dirname(path)), login: 'chatgpt', model, effort: chosen, effort_levels: levels,
      codex_home: instructions.home, global_instructions: instructions.files,
      catalog: { input_modalities: entry.input_modalities ?? null, tool_mode: entry.tool_mode ?? null,
        multi_agent_version: entry.multi_agent_version ?? null, context_window: entry.context_window ?? null },
    };
  },
  invocation({ harness, model, effort, workspace, node }) {
    const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--color', 'never', '--json',
      '-C', workspace, '-m', model, ...codexConfig({ workspace, effort, harness, node }), '-'];
    return { command: harness.binary_realpath, args, cwd: workspace, env: childEnvironment(), files: {}, stdin: 'prompt' };
  },
  // The same Seatbelt policy applied to an arbitrary command, without a model.
  // CODEX_HOME points at an empty directory so the user's config.toml (whose
  // shell_environment_policy may export credentials) is never read.
  sandboxCommand({ harness, effort, workspace, node, emptyHome, command }) {
    const config = codexConfig({ workspace, effort, harness, node });
    return { command: harness.binary_realpath, args: ['sandbox', '-P', CODEX_PROFILE, '-C', workspace, ...config, ...command],
      cwd: workspace, env: childEnvironment({ CODEX_HOME: emptyHome }) };
  },
  parse: parseCodexEvents,
};

// ---------------------------------------------------------------- claude-code
//
// `claude -p` in --safe-mode (no CLAUDE.md, skills, installed plugins, hooks,
// MCP, custom agents) and --restricted (user/project/local settings ignored,
// file tools confined to the working directory with symlinks resolved), with
// only Bash/Read/Glob/Grep/Edit/Write, no session persistence, and a --settings
// file that turns on Claude Code's Seatbelt sandbox for Bash with no fallback
// to unsandboxed execution, no allowed network domains and no Unix sockets.
// The login stays the user's keychain entry: a separate CLAUDE_CONFIG_DIR
// would change the keychain service name and lose it.
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function claudeSettings({ workspace, home, node }) {
  const ws = workspace, rule = path => '/' + path;
  // Regions a sandboxed command may not read. Everything else stays readable
  // (system libraries, /usr, /opt/homebrew/Cellar), because Claude Code's
  // macOS profile is allow-all-except for reads.
  const denyRead = [home, '/Users', '/Volumes', '/private/tmp', '/private/var/folders', '/private/var/tmp', '/private/var/root',
    '/private/var/log', '/private/var/db', '/opt/homebrew/var', '/usr/local/var', '/Library/Application Support', '/Library/Preferences',
    '/Library/Keychains', '/Library/Logs'];
  return {
    permissions: {
      defaultMode: 'dontAsk',
      blockReadsOutsideWorkingDirectories: true,
      disableBypassPermissionsMode: 'disable',
      allow: ['Bash', 'Read', 'Glob', 'Grep', 'Edit(' + rule(ws) + '/**)'],
      deny: ['Edit(' + rule(join(ws, 'input')) + '/**)', 'Edit(' + rule(join(ws, 'tools')) + '/**)', 'Edit(' + rule(join(ws, 'node_modules')) + '/**)',
        'WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit'],
    },
    sandbox: {
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
      network: { allowedDomains: [], strictAllowlist: true, allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false },
      filesystem: {
        denyRead: [...new Set(denyRead)],
        allowRead: [ws, ...node.read_roots.filter(root => denyRead.some(region => root === region || root.startsWith(region + '/')))],
        allowWrite: [ws],
        denyWrite: [join(ws, 'input'), join(ws, 'tools'), join(ws, 'node_modules')],
      },
    },
    disableAllHooks: true,
    enableAllProjectMcpServers: false,
  };
}

export const claudeCode = {
  id: 'claude-code',
  defaultBinary: () => process.env.E3D_CLAUDE_BIN || join(homedir(), '.local/bin/claude'),
  async inspect({ binary, model, effort }) {
    const path = await realpath(binary);
    const version = await run(path, ['--version']);
    if (version.exit_code !== 0) throw new Error('claude --version failed: ' + version.stderr.slice(0, 300));
    const status = await run(path, ['auth', 'status']);
    let auth = null;
    try { auth = JSON.parse(status.stdout); } catch {}
    if (!auth?.loggedIn || auth.apiProvider !== 'firstParty' || !['claude.ai', 'oauth_token'].includes(auth.authMethod)) {
      throw new Error('claude needs an existing claude.ai login (claude auth status); the runner never configures API keys');
    }
    if (typeof model !== 'string' || !/^[A-Za-z0-9._\[\]-]+$/.test(model)) throw new Error('Invalid claude model id ' + model);
    if (effort !== undefined && effort !== null && !CLAUDE_EFFORTS.includes(effort)) throw new Error('claude effort must be one of ' + CLAUDE_EFFORTS.join(', '));
    // Claude Code has no offline model catalogue; the model id is frozen as
    // given and each session's init event records the id it resolved to.
    return {
      system: 'claude-code', binary, binary_realpath: path, binary_sha256: await sha256File(path), version: version.stdout.trim(),
      login: auth.authMethod, subscription: auth.subscriptionType ?? null, model, effort: effort ?? null, effort_levels: CLAUDE_EFFORTS,
    };
  },
  invocation({ harness, model, effort, workspace, attemptDir, node, home = homedir(), debug = true }) {
    const settingsPath = join(attemptDir, 'harness', 'claude-settings.json');
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model];
    if (effort) args.push('--effort', effort);
    args.push('--safe-mode', '--restricted', '--strict-mcp-config', '--tools', CLAUDE_TOOLS.join(','), '--no-chrome',
      '--no-session-persistence', '--disable-slash-commands', '--permission-mode', 'dontAsk', '--settings', settingsPath);
    if (debug) args.push('--debug-file', join(attemptDir, 'harness', 'debug', 'claude-debug.log'));
    const tmp = join(workspace, 'tmp');
    const env = childEnvironment({
      PATH: node.bin + ':' + BASE_PATH, TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp,
      // Auto-memory off; no self-update mid-batch; no telemetry or other
      // non-essential traffic; bash, whose ~/.bashrc the snapshot step looks
      // for instead of the user's ~/.zshrc.
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_SHELL: '/bin/bash',
    });
    return { command: harness.binary_realpath, args, cwd: workspace, env, stdin: 'prompt',
      files: { [settingsPath]: claudeSettings({ workspace, home, node }) } };
  },
  sandboxCommand: null,
  parse: parseClaudeEvents,
};

export const ADAPTERS = { codex, 'claude-code': claudeCode };

export function adapterFor(system) {
  const adapter = ADAPTERS[system];
  if (!adapter) throw new Error('Unknown system ' + system + ' (expected ' + Object.keys(ADAPTERS).join(' or ') + ')');
  return adapter;
}
