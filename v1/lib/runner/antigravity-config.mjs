import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Antigravity CLI (`agy`) configuration the runner depends on. Nothing here was
// checked against a live CLI: names, paths and defaults are taken from the
// Antigravity documentation (antigravity.google/docs: settings, permissions,
// sandbox, rules, headless; read 2026-10-22) and are proven, or disproven, by
// preflight on the machine that runs the batch.
//
// agy reads one user settings file and has no flag or variable that points it
// elsewhere, and its login lives in the system keychain, which a separate HOME
// might not find. So the runner does not substitute its own settings: it
// requires the operator's ~/.gemini/antigravity-cli/settings.json to hold the
// values below, checks them at prepare, before every launch and in preflight,
// and refuses to run while they do not hold. `run.mjs antigravity-settings`
// prints them (and with --write merges them into the file).

export const agyHome = (home = homedir()) => join(home, '.gemini');
export const agySettingsPath = (home = homedir()) => join(agyHome(home), 'antigravity-cli', 'settings.json');

// Defaults of the keys checked (the CLI saves only non-default values, so an
// absent key means its default).
export const AGY_DEFAULTS = { toolPermission: 'request-review', enableTerminalSandbox: false, allowNonWorkspaceAccess: false, useG1Credits: false,
  artifactReviewPolicy: 'asks-for-review', agentMode: '', modelProvider: '' };

// Paths, relative to the workspace, the file tools may not write. The shell is
// confined by agy's own sandbox, which mounts the whole workspace read-write;
// the runner's integrity check after the session catches a changed input/,
// tools/ or runtime either way.
export const AGY_WRITE_DENY = ['input/', 'tools/', 'node_modules/', '.agents/', '.agent/', 'AGENTS.md', 'GEMINI.md'];

// The values a batch needs:
//   toolPermission proceed-in-sandbox  sandboxed commands run without a prompt (headless has none)
//   enableTerminalSandbox              every command in agy's Seatbelt profile (also forced by --sandbox)
//   allowNonWorkspaceAccess false      the file tools stay inside the workspace
//   useG1Credits false                 never spend paid AI credits when the plan quota runs out
//   artifactReviewPolicy always-proceed a plan artifact must not wait for a review nobody gives
//   agentMode default                  not `auto`, which runs commands outside the sandbox
//   modelProvider ''                   the Google login, never GEMINI_API_KEY
//   permissions                        no web, browser, MCP or unsandboxed commands; the node
//                                      install readable inside the sandbox; protected names unwritable
export function agyRequiredSettings({ node }) {
  return {
    toolPermission: 'proceed-in-sandbox', enableTerminalSandbox: true, allowNonWorkspaceAccess: false, useG1Credits: false,
    artifactReviewPolicy: 'always-proceed', agentMode: 'default', modelProvider: '',
    permissions: {
      allow: node.read_roots.map(path => 'read_file(' + path + ')'),
      deny: ['read_url(*)', 'execute_url(*)', 'mcp(*)', 'unsandboxed(*)', ...AGY_WRITE_DENY.map(path => 'write_file(' + path + ')')],
    },
  };
}

const effective = (settings, key) => settings?.[key] ?? AGY_DEFAULTS[key];

// What is wrong with a settings object for a batch, as sentences (empty: fine).
export function agySettingsProblems(settings, { node }) {
  const required = agyRequiredSettings({ node }), problems = [];
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return ['no settings object'];
  for (const key of ['toolPermission', 'enableTerminalSandbox', 'allowNonWorkspaceAccess', 'useG1Credits', 'artifactReviewPolicy', 'modelProvider']) {
    if (effective(settings, key) !== required[key]) problems.push(key + ' is ' + JSON.stringify(effective(settings, key)) + ', needs ' + JSON.stringify(required[key]));
  }
  if (!['', 'default'].includes(effective(settings, 'agentMode'))) problems.push('agentMode is ' + JSON.stringify(settings.agentMode) + ', needs "default"');
  for (const key of ['customModelsConfig', 'sandboxProxy']) if (settings[key] !== undefined) problems.push(key + ' is set; remove it');
  const permissions = settings.permissions ?? {}, list = name => Array.isArray(permissions[name]) ? permissions[name].map(String) : [];
  const missingDeny = required.permissions.deny.filter(rule => !list('deny').includes(rule));
  if (missingDeny.length) problems.push('permissions.deny lacks ' + missingDeny.join(', '));
  // Any other allow rule could open a route the boundary closes.
  const extraAllow = list('allow').filter(rule => !required.permissions.allow.includes(rule));
  if (extraAllow.length) problems.push('permissions.allow has rules the runner does not set: ' + extraAllow.join(', '));
  const missingAllow = required.permissions.allow.filter(rule => !list('allow').includes(rule));
  if (missingAllow.length) problems.push('permissions.allow lacks ' + missingAllow.join(', ') + ' (the node install, for the sandboxed shell)');
  return problems;
}

// The settings with the required values merged in (other keys kept).
export function agyMergedSettings(settings, { node }) {
  const required = agyRequiredSettings({ node }), base = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const merged = { ...base, ...required };
  delete merged.customModelsConfig; delete merged.sandboxProxy;
  merged.permissions = { ...(base.permissions ?? {}), allow: required.permissions.allow,
    deny: [...new Set([...(Array.isArray(base.permissions?.deny) ? base.permissions.deny : []), ...required.permissions.deny])] };
  return merged;
}

export async function readAgySettings(home = homedir()) {
  const path = agySettingsPath(home);
  try { return { path, settings: JSON.parse(await readFile(path, 'utf8')) }; }
  catch (error) {
    if (error.code === 'ENOENT') return { path, settings: null };
    return { path, settings: null, error: 'unreadable: ' + error.message };
  }
}

async function nonBlank(path) {
  try { const info = await stat(path); return info.isDirectory() ? (await readdir(path)).some(name => !name.startsWith('.')) : (await readFile(path, 'utf8')).trim() !== ''; }
  catch { return false; }
}

// User-level things agy would put into every session: global rules and
// context files, hooks, MCP servers, plugins, skills and custom subagents
// (documented paths; the skills and subagent locations are guesses that
// cover the likely names). Each must be absent or empty.
export function agyGlobalPaths(home = homedir()) {
  const g = agyHome(home);
  return {
    rules: [join(g, 'AGENTS.md'), join(g, 'GEMINI.md'), join(g, 'config', 'AGENTS.md'), join(g, 'config', 'GEMINI.md'), join(g, 'config', 'rules'),
      join(g, 'antigravity-cli', 'rules')],
    hooks: [join(g, 'config', 'hooks.json'), join(g, 'antigravity-cli', 'hooks.json')],
    mcp_servers: [join(g, 'config', 'mcp_config.json'), join(g, 'antigravity-cli', 'mcp_config.json')],
    plugins: [join(g, 'config', 'plugins'), join(g, 'antigravity-cli', 'plugins')],
    skills: [join(g, 'config', 'skills'), join(g, 'skills'), join(g, 'antigravity-cli', 'skills'), join(home, '.agents', 'skills')],
    subagents: [join(g, 'config', 'agents'), join(g, 'antigravity-cli', 'agents')],
  };
}

export async function agyDiscovered(home = homedir()) {
  const found = {};
  for (const [kind, paths] of Object.entries(agyGlobalPaths(home))) {
    found[kind] = [];
    for (const path of paths) {
      if (!await nonBlank(path)) continue;
      // An MCP file with no servers configures nothing.
      if (kind === 'mcp_servers') {
        try { const servers = JSON.parse(await readFile(path, 'utf8')).mcpServers; if (!servers || !Object.keys(servers).length) continue; } catch {}
      }
      found[kind].push(path);
    }
  }
  return found;
}

// Everything that must hold before a session starts, as sentences.
export async function agyConfigProblems({ node, home = homedir() }) {
  const { path, settings, error } = await readAgySettings(home), problems = [];
  if (error) problems.push(path + ' is ' + error);
  else if (!settings) problems.push(path + ' does not exist');
  else problems.push(...agySettingsProblems(settings, { node }).map(text => path + ': ' + text));
  const found = await agyDiscovered(home);
  for (const [kind, paths] of Object.entries(found)) if (paths.length) problems.push('agy would load ' + kind.replace('_', ' ') + ' from ' + paths.join(', '));
  return problems;
}
