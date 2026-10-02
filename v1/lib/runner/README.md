# Generation runner (module E)

Runs a model-under-test on task packs inside an isolated workspace, records what
happened, and scores what it left behind. Two harnesses: `codex` (Codex CLI) and
`claude-code` (Claude Code CLI). Checked against codex-cli 0.159.2 and Claude Code
2.1.285 on macOS (Darwin 27); both boundaries are Seatbelt-based and macOS-only.

```sh
node v1/scripts/run.mjs prepare   --id <batch> --system codex|claude-code --model <id> [--effort <level>] --tasks a,b,c [--attempts 1] [--data <root>] [--binary <cli>]
node v1/scripts/run.mjs preflight --batch <dir> [--probe-model <id>] [--probe-effort <level>]
node v1/scripts/run.mjs run       --batch <dir> [--concurrency 1]
node v1/scripts/run.mjs summary   --batch <dir>
```

The same from code: `prepare`, `preflight`, `execute`, `summarize` in
`v1/lib/runner/index.mjs` (also exported as `preparePilot`, `preflightPilot`,
`executePilot`). Default data root `.local/v1`; default CLIs
`~/.local/bin/codex.opencodex-real` (not the `codex` shim) and `~/.local/bin/claude`,
overridable with `--binary` or `E3D_CODEX_BIN` / `E3D_CLAUDE_BIN`.

## Life of a batch

1. **prepare** freezes everything: harness binary (realpath, sha256, version), login
   kind, model and effort, Node binary, `three` runtime, preview kit (`installTools`
   from module G), runner source, each task's hash, truth hash, prompt and
   invocation. A batch id is never reused and a frozen batch is never rewritten.
2. **preflight** proves the isolation boundary (below) and binds its verdict to the
   manifest hash. A failed or stale preflight blocks `run`.
3. **run** re-checks every frozen hash, then runs each attempt once: hard wall clock
   from `task.budget.wall_seconds` (SIGTERM to the whole process tree, SIGKILL 5 s
   later), events and stderr logged byte for byte, then integrity checks, then
   scoring in a separate process (module D's `scoreSubmission`) after the
   contestant's process tree is gone. Resumable: an attempt with `result.json` is
   skipped and never overwritten. An attempt whose runner died is never re-run: if
   generation had finished (`process.json` exists) it is rebuilt from its logs and
   scored; otherwise it is `generation_failed` with score 0, because nothing
   enforced the wall clock after the runner died.

```
<data>/runs/<batch>/
  manifest.json  preflight.json  summary.json
  runtime/node_modules/three        read-only, hard-linked into every workspace
  tools/                            preview kit as installed by module G
  preflight/<time>/                 probe workspaces, canaries, probe sessions, report.json
  <task>/a<n>/
    workspace/ input/ (task.json + inputs/)  tools/  node_modules/three  output/  tmp/  package.json
    prompt.txt  invocation.json  harness/ (claude settings, debug log)
    started.json  child.json  process.json  events.jsonl  stderr.log  result.json
    score/ submission.glb  report.json  error-*.png  worker logs
```

`workspace/package.json` (`{"type":"module"}`) is load-bearing: without it Node walks
up into the unreadable repository looking for a package scope and fails to import.

`result.json`: `{ task_id, attempt, system, model, effort, status, wall_seconds,
usage: { input_tokens, cached_input_tokens, output_tokens } | null, cost_usd | null,
turns, commands, score, report }` plus diagnostics (`exit_code`, `timed_out`,
`model_reported`, `usage_detail`, `tools`, `errors`, `integrity_problems`,
`artifact`, `score_error`, `notes_present`).

- `input_tokens` counts all prompt tokens including cached ones for both harnesses
  (Claude's cache reads and cache writes are added in; the raw split is in
  `usage_detail`). `output_tokens` includes reasoning tokens.
- `cost_usd`: Codex reports none (null). Claude reports `total_cost_usd`, which on a
  claude.ai subscription login is the CLI's list-price estimate, not a charge.
- `turns`: Codex's completed turns (1 for one `exec` prompt); Claude's `num_turns`
  (model round trips). Not comparable across harnesses. `commands`: shell
  commands run (Codex `command_execution` items, Claude `Bash` calls).
- Status: `timeout` > `generation_failed` (launch error, non-zero exit, no
  completed turn, interrupted runner, or broken workspace integrity) >
  `missing_artifact` > `invalid_artifact` (symlink, hard link, over the byte
  budget, or scorer says invalid) > `score_error` > `completed`. The score is
  computed independently of the status, from whatever valid `output/model.glb`
  exists, so a timed-out run can carry a score. An integrity problem (input,
  tools or runtime changed, a forbidden tool used, interrupted run) forces it to 0.
- The artifact is read by the runner outside the sandbox, so it must be a regular
  file with one link inside `output/`. A symlink or hard link to the hidden truth
  would otherwise be scored as the submission.

## The boundary, harness by harness

The contestant may read its workspace plus a read-only runtime, write only
`output/`, `tmp/` and the workspace root, and reach no network. It may not read
the task's truth, `objects/`, other tasks or attempts, the repository, `~/.codex`,
`~/.claude`, the keychain, or anything else outside. Nested Seatbelt profiles are
refused by the kernel (`sandbox_apply: Operation not permitted`), so neither CLI can
be wrapped in an outer sandbox without disabling its own. Each harness's own
mechanism is therefore configured and then proven.

### codex

```
codex exec --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --color never --json -C <ws> -m <model>
  -c model_reasoning_effort=<e> -c approval_policy="never" -c web_search="disabled" -c project_doc_max_bytes=0
  -c skills.include_instructions=false -c allow_login_shell=false -c agents.enabled=false
  -c default_permissions="evidence3d"
  -c permissions.evidence3d.filesystem={":minimal"="read", ":tmpdir"="deny", ":slash_tmp"="deny", "<ws>"="write",
       "<ws>/input"="read", "<ws>/tools"="read", "<ws>/node_modules"="read", <node install + Homebrew kegs/opt/openssl>="read",
       "<codex release dir>"="read"}
  -c permissions.evidence3d.network.enabled=false
  -c shell_environment_policy.inherit="none" -c shell_environment_policy.set={PATH=<node bin>:/usr/bin:/bin:/usr/sbin:/sbin, TMPDIR=<ws>/tmp, LANG}
  -c features.{apps,plugins,memories,hooks,shell_snapshot,multi_agent,multi_agent_v2,browser_use,browser_use_external,computer_use,
       in_app_browser,image_generation,workspace_dependencies,skill_mcp_dependency_install,remote_plugin,recommended_plugins,goals,
       tool_suggest,skill_search,realtime_conversation,standalone_web_search,fast_mode}=false
  -          (prompt on stdin)
```

Environment: `HOME USER LOGNAME LANG` (+ `LC_*`, `SSL_CERT_*` if set) and a minimal
`PATH`. `CODEX_HOME` stays `~/.codex` because the ChatGPT login lives there.

| Requirement | How | Evidence |
| --- | --- | --- |
| Shell confined | Seatbelt permission profile `evidence3d` (allow-list reads, writes only in `<ws>`, input/tools/runtime read-only, network off incl. loopback and Unix sockets) | preflight `sandbox:*` (model-free `codex sandbox -P` with the same `-c` values) and `shell:*` (probe run by the model's shell tool) |
| `view_image`, `apply_patch` confined | Codex runs both through its "fs sandbox helper", which re-executes the codex binary under the same Seatbelt profile. It must be launched by its resolved path and its release directory must be readable, otherwise every image view and patch fails | `agent:view-*`, `agent:patch-*` (outside file, symlink, dangling symlink, symlinked directory) |
| Code mode | `functions.exec` runs model-written JS in a V8 isolate outside Seatbelt that, per its tool description, has no Node, fs, network or console, and reaches the world only through the nested tools above | `agent:code-mode-isolate` (model-reported `typeof require/process/fetch/...` and failed `node:` imports) |
| No user config, rules, project docs, skills, memories, plugins, apps, hooks | `--ignore-user-config` (config.toml, including its `shell_environment_policy.set`, which on this machine exports an API key), `--ignore-rules`, `project_doc_max_bytes=0`, `skills.include_instructions=false`, feature flags | checked offline with `codex debug prompt-input`. The model-visible input is the permission text, the collaboration-mode text and the environment context, nothing else |
| No global AGENTS.md | No setting stops `$CODEX_HOME/AGENTS.override.md` / `AGENTS.md` from being injected. `prepare` refuses, and `preflight`/`run` stop, while either is non-blank | `codexGlobalInstructions`; unit test |
| No sub-agents, web, browser, MCP | `agents.enabled=false` removes the `multi_agent_v1__*` tools that `features.multi_agent=false` alone leaves in place; others by feature flag | `agent:tool-list` (model-reported); every run's events are scanned for non-allowed item types |
| No API keys | the login is ChatGPT (`codex login status`); child env scrubbed | `shell:env-names`, unit tests |

Codex's sandboxed shell is its bundled `zsh -c` (not `-lc`; `allow_login_shell=false`).
It still sets `HOME` to the real home, which the profile makes unreadable.

### claude-code

```
claude -p --output-format stream-json --verbose --model <model> [--effort <e>]
  --safe-mode --restricted --strict-mcp-config --tools Bash,Read,Glob,Grep,Edit,Write --no-chrome
  --no-session-persistence --disable-slash-commands --permission-mode dontAsk
  --settings <attempt>/harness/claude-settings.json --debug-file <attempt>/harness/debug/claude-debug.log
  (prompt on stdin)
env: HOME USER LOGNAME LANG PATH=<node bin>:/usr/bin:/bin:/usr/sbin:/sbin TMPDIR=CLAUDE_CODE_TMPDIR=<ws>/tmp
     CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_SHELL=/bin/bash
```

Settings (`claudeSettings` in `adapters.mjs`): `permissions` `defaultMode: dontAsk`,
`blockReadsOutsideWorkingDirectories: true`, `disableBypassPermissionsMode`,
allow `Bash Read Glob Grep Edit(//<ws>/**)`, deny `Edit` on `input/ tools/
node_modules/` and `WebFetch WebSearch Agent Task NotebookEdit`; `sandbox`
`enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`, network
`allowedDomains: []` with `strictAllowlist`, no Unix sockets, no local binding;
filesystem `denyRead` (home, `/Users`, `/Volumes`, `/private/tmp`,
`/private/var/{folders,tmp,root,log,db}`, `/opt/homebrew/var`, `/usr/local/var`,
`/Library/{Application Support,Preferences,Keychains,Logs}`), `allowRead [<ws>]`,
`allowWrite [<ws>]`, `denyWrite` on `input/ tools/ node_modules/`;
`disableAllHooks`.

| Requirement | How | Evidence |
| --- | --- | --- |
| Shell confined | Claude Code's Seatbelt sandbox for every Bash command; `allowUnsandboxedCommands: false` ignores `dangerouslyDisableSandbox`; `failIfUnavailable` refuses to start without it | `shell:*` |
| File tools confined | `--restricted` confines Read/Glob/Grep/Edit/Write to the working directory after resolving symlinks, including dangling links and links to directories; `Edit` deny rules keep `input/` etc. read-only. This is Claude Code's in-process permission check, not the kernel | `agent:read-*`, `agent:grep-*`, `agent:glob-*`, `agent:write-*` (canary content and file names must not come back; files on disk checked) |
| No network tools, MCP, sub-agents, browser | `--tools` (exactly six tools), `--strict-mcp-config` with no config, `--no-chrome`, `Agent`/`Task` denied | `agent:tool-surface` from the `system/init` event: tools, `mcp_servers: []`, plugins limited to the built-ins `cc-plugin-agents-md` / `cc-plugin-telemetry` |
| No CLAUDE.md, auto-memory, skills, plugins, hooks, settings | `--safe-mode` (CLAUDE.md, skills, installed plugins, hooks, MCP, custom agents off), `--restricted` (user/project/local settings ignored), `--disable-slash-commands`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `--no-session-persistence` | `agent:instruction-files` (marked CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md, AGENTS.md planted beside the workspace never surface); `agent:shell-profile` (debug log: the shell snapshot found no `~/.bashrc`) |
| Existing login | `HOME` and the default config dir are kept. A separate `CLAUDE_CONFIG_DIR` changes the keychain service name and loses the login (`claude auth status` → logged out) | `claude auth status` in prepare (`authMethod: claude.ai`); `apiKeySource: none` in init |
| Keychain unreadable | `~/Library` is under `denyRead`, so `security find-generic-password` fails (44) inside the sandbox | `shell:keychain` |
| Inter-session socket | Claude opens a Unix socket inbox per session and exports `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN` to its shell; Unix sockets are blocked | `shell:unix-messaging` |

`--bare` would skip CLAUDE.md, hooks and keychain reads but accepts only API-key
auth, so it cannot use the existing login and is not used.

## Preflight

Per batch, on fresh probe workspaces built by the same code as attempts (task pack
of the first task, same tools and runtime), with a canary directory beside each
workspace and planted escape routes (file and directory symlinks, dangling
symlinks, a hard-link attempt):

- `sandbox:*` (codex only): the probe script under `codex sandbox -P evidence3d`
  with the frozen `-c` values and an empty `CODEX_HOME` (so the user's config.toml
  is never read). No model.
- `shell:*`: the same probe script run by the model through its own shell tool in
  one real session that uses the batch model at its lowest effort.
- `agent:*`: in that session, the model aims its file tools at the canaries. It uses
  Read/Grep/Glob/Write/Edit for Claude Code, and view_image/apply_patch/code mode for
  Codex.

Probe targets include input readable; input, tools and runtime not writable even
after `chmod`; output and tmp writable; the canary (directly, through
file/directory/dangling symlinks, through a hard link); writes outside;
repository scoring code and contract; the task's `truth.json`; `truth/`,
`objects/`, `tasks/`; another attempt; the batch manifest; the home directory;
`~/.codex/{auth.json,config.toml,memories}`; `~/.claude/{settings.json,projects}`;
`~/.claude.json`; `~/.ssh`; `/private/tmp`; the keychain entry; `three` importable;
the preview tool rendering a non-blank PNG of the fixture house; no credential-like
environment variable names; loopback TCP and a Unix socket (both runner-owned, so
an accepted connection is counted by the runner itself); the harness's own
messaging socket; TCP to 1.1.1.1:443; HTTPS through whatever proxy the harness sets.

Evaluation prefers ground truth: listener hit counts, files on disk, canary
content and names in tool results. Every check must pass, and one that could not
be evaluated fails preflight. A target missing on this machine is reported as
`not_applicable`. An agent session with no failed check but some unanswered ones
(the model did not follow the script) is run once more in a fresh site. A failed
check is never retried. Measured cost per preflight: Claude Haiku 4.5 about
25–30 s and US$0.04–0.07 (CLI estimate); gpt-5.6-luna low about 35–45 s and
about 95k input tokens (mostly cached), no cost reported.

## What is not enforced

- **The model service is remote.** Each CLI process talks to OpenAI or Anthropic
  with the user's login. Only the contestant's commands and tools are confined,
  not the CLI itself.
- **Readable system areas.** Codex's `:minimal` set, the Node install and all of
  `/opt/homebrew/Cellar` + `/opt/homebrew/opt` are readable. Claude Code's read
  policy is allow-all-except, so `/System`, `/usr`, `/Applications`, `/Library`
  outside the denied subtrees, `/private/etc` and `/opt/homebrew` (except `var/`)
  stay readable. None of these holds benchmark data. The data root is required to
  live under `/Users` (or another denied region) for the Claude boundary to hide
  it; a data root elsewhere is not hidden (the preflight `truth`/`objects-root`
  probes would catch it).
- **Claude's file tools are policed by Claude Code, not the kernel.** They run in
  the CLI process, so a bug in its path checks would not be caught by Seatbelt.
  Preflight exercises the known escape routes (absolute paths, file and directory
  symlinks, dangling symlinks, Glob/Grep through links); new routes in later CLI
  versions would need new probes.
- **Self-reported checks.** The Codex tool list, the code-mode isolate report and
  the control-image colour are model-reported. A model that misreports makes
  preflight fail, but cannot make a leak pass silently. The Claude instruction-file
  check proves only that the planted files were not obeyed. Its positive control
  (the same files reaching a session without `--safe-mode`) was not run.
- **Process escape after exit.** The tree is found by `ps` parent links plus the
  process group at kill time. A descendant that daemonizes (setsid + double fork)
  and is orphaned before the kill could survive. Verified only with a detached
  grandchild (unit test) and real sandboxed `node` children of both CLIs.
- **No CPU, memory or disk quotas.** A contestant can fill the disk or saturate the
  CPU. With `--concurrency > 1` attempts share the machine, so their wall times are
  not independent.
- **Per-batch, not per-attempt, preflight.** Attempt workspaces are built by the
  same code and their invocations differ only in paths; their hashes are frozen,
  but each attempt is not probed individually.
- **Claude model ids are not validated offline** (there is no catalogue command);
  the id is frozen as given and `model_reported` records what each session
  resolved. Aliases (`haiku`, `sonnet`, `opus`, `fable`) resolve to whatever is
  current.
- **Harness-internal credentials inside Claude's sandbox.** `CLAUDE_CODE_MESSAGING_TOKEN`
  (own inbox; sockets blocked) and `CLOUDSDK_PROXY_PASSWORD/USERNAME` (the sandbox's
  own filtering proxy, which allows no domain) are visible to contestant commands
  and allow-listed by the env check for those reasons.
- **Side effects outside the batch.** Claude Code updates its own `~/.claude.json`
  and writes and deletes a shell snapshot in `~/.claude/shell-snapshots` on every
  start. Codex writes under `~/.codex/tmp`. `--ephemeral` and
  `--no-session-persistence` keep transcripts out of both homes.
- **Blender is not provided** and nothing is configured for it.
