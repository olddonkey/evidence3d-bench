import { realpath, stat, readFile, mkdir, rm, chmod, mkdtemp, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { captureProcess, childEnvironment, BASE_PATH } from './process.mjs';
import { parseCodexEvents, parseClaudeEvents, parseGrokEvents, CLAUDE_TOOLS, GROK_TOOLS } from './events.mjs';
import { sha256File } from './workspace.mjs';
import { API_ADAPTERS } from './api/adapter.mjs';
import { grokDiscovered } from './grok-config.mjs';
import { sandboxProfile, SANDBOX_EXEC, READ_ONLY_PARTS } from './api/sandbox.mjs';

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
    // Node reads the OpenSSL configuration of whichever OpenSSL keg it links
    // (`openssl@3` until node 26.10, `openssl@4` from 26.11), so every
    // installed `etc/openssl@*` directory is readable, not one fixed version.
    if (path.startsWith(brew + '/')) {
      const opensslDirs = (await readdir(brew + '/etc').catch(() => [])).filter(name => /^openssl@\d+$/.test(name)).map(name => brew + '/etc/' + name);
      roots.push(...await existing([brew + '/Cellar', brew + '/opt', ...opensslDirs, brew + '/etc/ca-certificates']));
    }
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

// api-anthropic and api-openai: one agent loop of our own against the
// vendors' APIs (api/adapter.mjs).
// ---------------------------------------------------------------- grok
//
// `grok -p` (Grok Build, checked against 1.0.46). The CLI process itself runs
// unsandboxed, like the other two CLIs and the API loop; what the contestant
// runs is confined:
//   shell       GROK_SHELL points at a runner-owned wrapper outside the
//               workspace that execs `sandbox-exec -f <profile> /bin/bash`, so
//               every command Grok runs (and the environment capture it runs
//               first) starts inside our Seatbelt profile (api/sandbox.mjs: the
//               workspace readable, writable except input/ tools/
//               node_modules/ and project-configuration names, no symbolic
//               links created, no network, nothing else under /Users), and no
//               child can leave it.
//   file tools  read_file, list_dir, grep, write and search_replace run in the
//               CLI process and are policed by Grok's permission rules: deny
//               rules that cover every path outside the workspace (and a few
//               system roots the shell may read too), applied by Grok to the
//               resolved target of in-path symlinks, plus writes into the
//               read-only parts. `bypassPermissions` with those deny rules,
//               because `dontAsk` turns every command Grok cannot split
//               (`$(...)`, a subshell, a loop) into a prompt that cancels the
//               whole headless session (live).
//   context     HOME is an empty runner-owned directory and GROK_HOME the
//               user's ~/.grok (the login lives there), so the user's Claude
//               Code plugins, hooks and MCP servers and ~/.agents skills are
//               not discovered; a runner-owned agent definition (the default
//               prompt, `discoverSkills: false`) keeps Grok's bundled skills
//               out. Compatibility, memory, MCP, sub-agent, web and telemetry
//               switches stay off.
// Proven by preflight, not assumed: see README "### grok".
export const GROK_DISALLOWED_TOOLS = ['todo_write', 'monitor', 'search_tool', 'use_tool', 'workflow', 'enter_plan_mode', 'exit_plan_mode', 'ask_user_question',
  'send_feedback', 'image_gen', 'image_edit', 'image_to_video', 'reference_to_video', 'spawn_subagent', 'kill_command_or_subagent', 'get_command_or_subagent_output',
  'scheduler_create', 'scheduler_delete', 'scheduler_list', 'Agent'];
export const GROK_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const GROK_COMPAT_OFF = Object.fromEntries(['CLAUDE', 'CURSOR', 'CODEX'].flatMap(vendor => ['SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS', 'SESSIONS']
  .map(surface => ['GROK_' + vendor + '_' + surface + '_ENABLED', '0'])));
export const GROK_ENV = { ...GROK_COMPAT_OFF, GROK_MANAGED_MCPS_ENABLED: '0', GROK_MEMORY: '0', GROK_SUBAGENTS: '0', GROK_WEB_FETCH: '0', GROK_BACKEND_SEARCH: '0',
  GROK_SESSION_SEARCH: '0', GROK_LSP_TOOLS: '0', GROK_TELEMETRY_ENABLED: '0', GROK_TELEMETRY_TRACE_UPLOAD: '0', GROK_DISABLE_AUTOUPDATER: '1',
  // The shell inherits this environment instead of the user's login shell.
  GROK_CONFIG: JSON.stringify({ toolset: { bash: { login_shell_capture: false } } }) };
export const grokHome = () => join(homedir(), '.grok');

// Workspace names the contestant may not create or change, by any route:
// the read-only parts, and project configuration a CLI might load (Grok reads
// project MCP servers, plugins, hooks and permission rules from .grok/,
// .claude/, .cursor/, .mcp.json only in a trusted folder, which a workspace
// never is; they are closed anyway).
export const GROK_READ_ONLY = [...READ_ONLY_PARTS, '.grok', '.claude', '.cursor', '.agents', '.codex', '.mcp.json'];
// What the file tools may read outside the workspace: what the shell may read.
export const GROK_SYSTEM_READ = ['/usr', '/bin', '/sbin', '/System', '/etc', '/private/etc', '/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/fd'];
export const GROK_DEVICE_WRITE = ['/dev/null', '/dev/zero', '/dev/dtracehelper'];

// Grok matches path globs without regard to case (live: a deny rule
// "/us[!r]*/**" matched "/Users/..."), and APFS ignores case too, so names are
// compared in lower case and every letter is written as both cases: the cover
// is exact under either matching rule.
const GLOB_SAFE = /^[A-Za-z0-9._@+-]+$/;
const globLetter = c => /[a-z]/i.test(c) ? '[' + c.toLowerCase() + c.toUpperCase() + ']' : c;
const globWord = text => [...text].map(globLetter).join('');
function globNotIn(chars) {
  const list = [...new Set([...chars].flatMap(c => /[a-z]/i.test(c) ? [c.toLowerCase(), c.toUpperCase()] : [c]))];
  return '[!' + (list.includes('-') ? '-' : '') + list.filter(c => c !== '-').sort().join('') + ']';
}
// Patterns for one path component that match every name except `names`.
function namesCover(names) {
  const out = [], set = new Set(names.map(name => name.toLowerCase()));
  const walk = prefix => {
    const next = new Set();
    for (const name of set) if (name.length > prefix.length && name.startsWith(prefix)) next.add(name[prefix.length]);
    if (prefix && !set.has(prefix)) out.push(globWord(prefix));               // a proper prefix that is not itself allowed
    out.push(globWord(prefix) + (next.size ? globNotIn(next) : '?') + '*');    // continues with a character no allowed name has there
    for (const c of next) walk(prefix + c);
  };
  walk('');
  return out;
}
// Glob patterns (Grok's syntax: `*` within a component, `**` across) that
// match every absolute path not equal to or below one of `roots`, the roots'
// ancestors included (listing one would reveal its other names).
export function outsideCover(roots) {
  const tree = {};
  for (const root of roots) {
    let node = tree;
    for (const part of root.split('/').filter(Boolean)) {
      if (!GLOB_SAFE.test(part)) throw new Error('Cannot write a grok path rule for the path component ' + JSON.stringify(part));
      node = node.children?.[part.toLowerCase()] ?? ((node.children ??= {})[part.toLowerCase()] = { name: part });
    }
    node.root = true;
  }
  const patterns = [];
  const visit = (dir, node) => {
    if (node.root) return;
    patterns.push(dir || '/');
    const names = Object.keys(node.children ?? {});
    for (const name of namesCover(names)) patterns.push(dir + '/' + name, dir + '/' + name + '/**');
    for (const name of names) visit(dir + '/' + globWord(node.children[name].name), node.children[name]);
  };
  visit('', tree);
  return patterns;
}

// The permission rules of one workspace (a real path), as --deny arguments.
export function grokDenyRules({ workspace, node }) {
  const rules = [...outsideCover([workspace, ...GROK_SYSTEM_READ, ...node.read_roots]).map(pattern => 'Read(' + pattern + ')'),
    ...outsideCover([workspace, ...GROK_DEVICE_WRITE]).map(pattern => 'Edit(' + pattern + ')')];
  for (const part of GROK_READ_ONLY) rules.push('Edit(' + workspace + '/' + globWord(part) + ')', 'Edit(' + workspace + '/' + globWord(part) + '/**)');
  return [...rules, 'WebFetch', 'WebSearch', 'MCPTool(*)'];
}

// The shell Grok starts for every command: our profile around /bin/bash. HOME
// for the commands is the workspace's tmp/, as for the API systems' shell.
export function grokShellWrapper({ profilePath, workspace }) {
  return ['#!/bin/sh', '# Evidence3D: every shell grok starts runs inside the attempt\'s Seatbelt profile.',
    'exec /usr/bin/env HOME=' + shellQuote(join(workspace, 'tmp')) + ' ' + SANDBOX_EXEC + ' -f ' + shellQuote(profilePath) + ' /bin/bash "$@"', ''].join('\n');
}
const shellQuote = text => "'" + String(text).replaceAll("'", "'\\''") + "'";

// The agent: Grok Build's default prompt ("extend" with nothing), without
// skill discovery. It differs from the built-in agent only in that Grok then
// leaves out its browser-verification section (live: the system prompt and
// the first user message are otherwise identical).
export const GROK_AGENT_DEFINITION = ['---', 'name: e3d-contestant', 'description: Evidence3D contestant session (Grok Build\'s default prompt, without skills).',
  'promptMode: extend', 'discoverSkills: false', 'inheritSkills: false', 'skills: []', 'mcpInheritance: none', '---', ''].join('\n');

const realOr = path => { try { return realpathSync(path); } catch { return path; } };

export const grok = {
  id: 'grok',
  defaultBinary: () => process.env.E3D_GROK_BIN || join(homedir(), '.grok', 'bin', 'grok'),
  async inspect({ binary, model, effort }) {
    const path = await realpath(binary);
    const version = await run(path, ['--version']);
    if (version.exit_code !== 0) throw new Error('grok --version failed: ' + version.stderr.slice(0, 300));
    // `grok models` says how the CLI is logged in and lists the models it can
    // use, without reading any credential file here.
    const listing = await run(path, ['models'], { env: childEnvironment({ ...GROK_ENV, GROK_HOME: grokHome() }) });
    const login = /You are logged in with (.+?)\.?\s*$/m.exec(listing.stdout + listing.stderr)?.[1]?.trim() ?? null;
    if (listing.exit_code !== 0 || !login) throw new Error('grok needs an existing login (grok models says how it is logged in): ' + (listing.stdout + listing.stderr).slice(0, 300));
    if (/api.?key/i.test(login)) throw new Error('grok is logged in with an API key; the runner uses the grok.com login and never configures API keys');
    const models = [...listing.stdout.matchAll(/^\s*[*-]\s+(\S+)/gm)].map(match => match[1]);
    if (!models.includes(model)) throw new Error('Model ' + model + ' is not among the models grok offers (' + models.join(', ') + ')');
    // The effort levels a model advertises are in Grok's model catalogue
    // cache (configuration, no credentials); models outside it get the
    // canonical list and are checked by preflight's session.
    let levels = GROK_EFFORTS, chosen = effort ?? null;
    try {
      const entry = JSON.parse(await readFile(join(grokHome(), 'models_cache.json'), 'utf8')).models?.[model]?.info;
      // Lowest first, as for the other CLIs (preflight's probe session takes the first).
      if (Array.isArray(entry?.reasoning_efforts)) {
        levels = entry.reasoning_efforts.map(level => level.value ?? level.id).sort((a, b) => GROK_EFFORTS.indexOf(a) - GROK_EFFORTS.indexOf(b));
        chosen ??= entry.reasoning_effort ?? null;
      }
    } catch {}
    if (chosen !== null && !levels.includes(chosen)) throw new Error('Model ' + model + ' does not support effort ' + chosen + ' (' + levels.join(', ') + ')');
    // Nothing from ~/.grok may join a session: no hooks, plugins or MCP servers.
    const emptyHome = await mkdtemp(join(tmpdir(), 'e3d-grok-home-'));
    let discovered;
    try { discovered = await grokDiscovered({ binary: path, env: childEnvironment({ ...GROK_ENV, HOME: emptyHome, GROK_HOME: grokHome() }), cwd: emptyHome }); }
    finally { await rm(emptyHome, { recursive: true, force: true }); }
    if (!discovered.ok) throw new Error(discovered.error);
    const loaded = ['plugins', 'hooks', 'mcp_servers'].filter(key => discovered[key].length);
    if (loaded.length) throw new Error('grok would load ' + loaded.map(key => key + ' ' + discovered[key].join(', ')).join('; ') + ' from ' + grokHome() + ' into every contestant session; remove or disable them for the duration of the batch');
    return {
      system: 'grok', binary, binary_realpath: path, binary_sha256: await sha256File(path), version: version.stdout.trim(),
      release_root: dirname(path), login, model, effort: chosen, effort_levels: levels, grok_home: grokHome(), discovered,
    };
  },
  invocation({ harness, model, effort, workspace, attemptDir, node }) {
    const ws = realOr(workspace), dir = join(attemptDir, 'harness');
    const profilePath = join(dir, 'grok-shell.sb'), wrapperPath = join(dir, 'bin', 'bash'), agentPath = join(dir, 'grok-agent.md');
    const args = ['--prompt-file', join(attemptDir, 'prompt.txt'), '--output-format', 'streaming-messages-json', '-m', model];
    if (effort) args.push('--effort', effort);
    args.push('--cwd', ws, '--agent', agentPath, '--permission-mode', 'bypassPermissions',
      '--tools', GROK_TOOLS.join(','), '--disallowed-tools', GROK_DISALLOWED_TOOLS.join(','), '--no-subagents', '--no-plan', '--disable-web-search',
      ...grokDenyRules({ workspace: ws, node }).flatMap(rule => ['--deny', rule]));
    const env = childEnvironment({ PATH: node.bin + ':' + BASE_PATH, TMPDIR: join(ws, 'tmp'), ...GROK_ENV,
      HOME: join(dir, 'home'), GROK_HOME: harness.grok_home ?? grokHome(), GROK_SHELL: wrapperPath });
    return { command: harness.binary_realpath, args, cwd: ws, env, stdin: 'prompt',
      files: { [profilePath]: sandboxProfile({ workspace: ws, readRoots: node.read_roots, readOnly: GROK_READ_ONLY, noSymlinks: true }),
        [wrapperPath]: grokShellWrapper({ profilePath, workspace: ws }), [agentPath]: GROK_AGENT_DEFINITION } };
  },
  // Right before launch: the empty HOME, and the wrapper made executable
  // (harness files are written, and copied for a re-run, without modes).
  async stage({ attemptDir }) {
    const dir = join(attemptDir, 'harness');
    await rm(join(dir, 'home'), { recursive: true, force: true });
    await mkdir(join(dir, 'home'), { recursive: true });
    await chmod(join(dir, 'bin', 'bash'), 0o555);
  },
  sandboxCommand: null,
  parse: parseGrokEvents,
};

export { grokDiscovered };
export const ADAPTERS = { codex, 'claude-code': claudeCode, grok, ...API_ADAPTERS };

export function adapterFor(system) {
  const adapter = ADAPTERS[system];
  if (!adapter) throw new Error('Unknown system ' + system + ' (expected ' + Object.keys(ADAPTERS).join(', ') + ')');
  return adapter;
}
