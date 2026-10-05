import { captureProcess, childEnvironment } from './process.mjs';

// What Grok would load from configuration it reads regardless of HOME
// (~/.grok: hooks, plugins, MCP servers), from `grok inspect --json` run with
// the contestant session's environment. Names only. (A module of its own:
// adapters.mjs and preflight.mjs both use it, and preflight.mjs is loaded by
// the API systems, which adapters.mjs loads.)
export async function grokDiscovered({ binary, env, cwd }) {
  const report = await captureProcess(binary, ['inspect', '--json'], { seconds: 60, env: env ?? childEnvironment(), cwd });
  let data = null;
  try { data = JSON.parse(report.stdout); } catch {}
  if (report.exit_code !== 0 || !data) return { ok: false, error: 'grok inspect --json failed: ' + (report.stderr || report.stdout).slice(0, 300) };
  const names = list => (Array.isArray(list) ? list : []).map(item => String(item?.name ?? item?.id ?? item?.target ?? item?.event ?? 'unnamed'));
  return { ok: true, plugins: names(data.plugins), hooks: names(data.hooks), mcp_servers: names(data.mcpServers) };
}
