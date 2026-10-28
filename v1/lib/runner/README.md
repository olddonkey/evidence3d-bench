# Generation runner (module E)

Runs a model-under-test on task packs inside an isolated workspace, records what
happened, and scores what it left behind. Six systems: four vendor CLIs, `codex` (Codex
CLI), `claude-code` (Claude Code CLI) and `grok` (Grok Build CLI), checked against
codex-cli 0.159.2, Claude Code 2.1.285 and grok 1.0.46, and `antigravity` (Google
Antigravity CLI, written from its documentation and not yet run: see *### antigravity*);
and two API systems,
`api-anthropic` (Claude Messages API) and `api-openai` (OpenAI Responses API), which run
one agent loop of our own with identical tools, prompts and budget, so that a result
compares models rather than "model + client" (see *The API systems*). All boundaries are
Seatbelt-based and macOS-only (Darwin 27).

```sh
node v1/scripts/run.mjs prepare   --id <batch> --system codex|claude-code|grok|antigravity|api-anthropic|api-openai --model <id> [--effort <level>] --tasks a,b,c [--attempts 1] [--data <root>]
                                  [--snapshot-seconds 300]                                               (score-over-time snapshots; 0: none)
                                  [--binary <cli>]                                                       (CLI systems)
                                  [--token-budget 2000000] [--tool-budget 200] [--max-output-tokens 32000]   (API systems)
node v1/scripts/run.mjs preflight --batch <dir> [--probe-model <id>] [--probe-effort <level>] [--no-wait]
node v1/scripts/run.mjs run       --batch <dir> [--concurrency 1] [--no-wait] [--resume-now] [--max-reruns 5] [--retry-stall-minutes 10]
node v1/scripts/run.mjs status    --batch <dir>[,<dir>...] [--json]   # what each batch is doing, and if waiting, why and until when
node v1/scripts/run.mjs summary   --batch <dir> [--json]              # --json: the whole summary.json
node v1/scripts/run.mjs antigravity-settings [--write]               # the agy settings an antigravity batch needs
```

Exit codes of `run` and `preflight`: 0 done (nothing left that may run), 1 error, 3 stopped
for a human (login or API key, billing, model id, a changed scorer/runner/CLI), 75 would have had to
wait (`--no-wait`; run again after the time printed; also a preflight that gave up after
6 probe sessions ended by infrastructure errors), 130 stopped by a signal. `run` and
`preflight` are stopped with Ctrl-C (or SIGTERM/SIGHUP) and continued with the same command.

The same from code: `prepare`, `preflight`, `execute`, `summarize` in
`v1/lib/runner/index.mjs` (also exported as `preparePilot`, `preflightPilot`,
`executePilot`). Default data root `.local/v1`; default CLIs
`~/.local/bin/codex.opencodex-real` (not the `codex` shim), `~/.local/bin/claude`,
`~/.grok/bin/grok` and `~/.local/bin/agy`, overridable with `--binary` or `E3D_CODEX_BIN` /
`E3D_CLAUDE_BIN` / `E3D_GROK_BIN` / `E3D_AGY_BIN`. The API systems read
their key from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in the environment of `preflight`
and `run` (never from a file; `prepare` records only whether it was set), and their base
URL from `E3D_ANTHROPIC_BASE_URL` / `E3D_OPENAI_BASE_URL` at `prepare` (default
`https://api.anthropic.com` / `https://api.openai.com`; frozen in the manifest).

## Life of a batch

1. **prepare** freezes everything: harness binary (realpath, sha256, version), login
   kind, model and effort, Node binary, `three` runtime, preview kit (`installTools`
   from module G), each task's hash, truth hash, prompt and invocation, and the
   source of the code that decides results (see *What is frozen*). A batch id is
   never reused and a frozen batch is never rewritten.
2. **preflight** proves the isolation boundary (below) and binds its verdict to the
   manifest hash. A failed or stale preflight blocks `run`; so does one that could not
   finish because of an infrastructure error (it says so, and is not a failed boundary).
3. **run** re-checks every frozen hash, then runs each attempt: hard wall clock
   from `task.budget.wall_seconds` (twice that for the API systems, where it is only a
   safety cap; SIGTERM to the whole process tree, SIGKILL 5 s
   later), events and stderr logged byte for byte, then integrity checks, then
   the host-sleep rule and the infrastructure-error check (below), then scoring in a separate process
   (module D's `scoreSubmission`) after the contestant's process tree is gone. While
   the CLI runs, the runner copies `output/model.glb` every 5 minutes, and scores the
   copies after the final file (see *Score-over-time snapshots*).
   A sample is run once and never overwritten. An attempt that ended in an
   infrastructure error is not a sample: it is archived and run again from a
   pristine workspace, inside the same `run`, after waiting out a limit if there is
   one (see *Re-runs, waiting and stopping*). Resumable at any point (see *Stopping
   and resuming*).

### What is frozen

`manifest.json` records, besides the harness, runtime and tasks:

- `runner_source`, `scorer_source`, `generator_source`: `{ sha256, files: [{ path,
  sha256 }] }` over every `.mjs`/`.js`/`.json` file under `v1/lib/runner` (+
  `v1/scripts/run.mjs`), `v1/lib/score` and `v1/lib/generator` respectively, plus every
  repository file they import by relative path, transitively (the kernel, `lib/io.mjs`,
  `lib/glb.mjs`), plus `node_modules/<package>/package.json` of each package they import.
  Imports built at run time are not followed. A changed runner or scorer refuses `run`
  at the start, and is checked again before every launch (with the two binaries) and
  before every scoring: a change mid-batch stops the batch (`stopped`, reason
  `frozen`, exit 3). An attempt whose generation finished but whose scoring was refused
  keeps its `process.json` and is scored, not generated again, by the next `run` once
  the code is back. The generator's source is recorded for provenance only: its output
  (tasks, truth, objects) is what is frozen.
- `snapshots`: `{ interval_seconds, source: 'output/model.glb' }`, or `null` when the
  batch was prepared with `--snapshot-seconds 0` (see *Score-over-time snapshots*).
- per task: `set` (from `truth.json`, `null` when absent), `object`, `variant`,
  `generator_version` (from the object's `model.json`), and `object_files`: the sha256 of
  the private files the scorer reads (`model.json`, `evidence/evidence.json`, each
  `alternates/<id>/model.json`; `null` when absent). A change refuses `run`, and is
  checked again before every scoring. `sets` lists the distinct sets of the batch;
  `summary` and `status` show them, so results from different sets are never pooled
  unawares.

The scorer's own identity stamp (`SCORER.sha256` in `v1/lib/score/version.mjs`, carried in
every report) is computed differently (only `.mjs` files, no package versions), so the two
hashes are not equal; each pins the code by its own definition.

```
<data>/runs/<batch>/
  manifest.json  preflight.json  summary.json
  progress.log                      one line per finished attempt, wait, resume, stop and cap (tail -f it)
  run.lock                          the live runner's (or preflight's) pid and start time
  runner-state.json                 what the runner is doing: phase, hold (until when, why), stop, backoff streak
  runtime/node_modules/three        read-only, hard-linked into every workspace
  tools/                            preview kit as installed by module G
  preflight/<time>/                 probe workspaces, canaries, probe sessions, report.json
  <task>/a<n>/
    workspace/ input/ (task.json + inputs/)  tools/  node_modules/three  output/  tmp/  package.json
    prompt.txt  invocation.json  harness/ (claude settings, debug log; grok: grok-shell.sb, bin/bash, grok-agent.md, home/;
                                           api-config.json for the API systems)
    rerun.json                      on a re-run: which try this is, and every earlier try
    started.json (with the sleep counter at launch)  child.json  process.json  events.jsonl  stderr.log  result.json
    score/ submission.glb  report.json  error-*.png  worker logs  worker.json
    score.interrupted-<k>/          a scoring cut short by a stopped runner, kept aside
    snapshots/ index.json  t0300.glb  t0900.glb ...   copies of output/model.glb taken while the CLI ran
               score/ t0300.json ...  worker logs     their reports (score.interrupted-<k>/, score.previous-<k>/ as for score/)
  <task>/a<n>.infra-<k>/            the k-th earlier try of a<n>, which ended in infra_error:
                                    kept exactly as it was, never deleted, never scored
  <task>/a<n>.fresh/                transient: the pristine copy being built for a re-run
```

`workspace/package.json` (`{"type":"module"}`) is load-bearing: without it Node walks
up into the unreadable repository looking for a package scope and fails to import.

`result.json`: `{ task_id, attempt, system, model, effort, status, wall_seconds,
usage: { input_tokens, cached_input_tokens, output_tokens } | null, cost_usd | null,
turns, commands, score, report }` plus diagnostics (`exit_code`, `signal`, `timed_out`, `log_error`,
`model_reported`, `model_turns`, `usage_detail`, `tools`, `errors`, `integrity_problems`,
`artifact`, `score_error`, `notes_present`, `infra`, `infra_ignored`, `watchdog`,
`service_retry_seconds`), the try history (`try`: 1 for the first try, k+1 after k
archived ones; `tries[]`: one record per earlier try with its directory, status, reason,
retry_after, times and message) and timing:
`attempt_started_at` (the runner took the attempt), `started_at` / `finished_at` (the
CLI process), `result_at` (the record was written), `wall_limit_seconds`,
`host_sleep_check` (see *The host-sleep rule*), and
`load_1m: { start, end, mean, max, samples, cpus }`, the machine's 1-minute load
average sampled every 30 s while the CLI ran, and, when the batch takes snapshots,
`snapshot_interval_seconds` and `snapshots[]` (see *Score-over-time snapshots*). `process.json` keeps `event_ms`, the
arrival time of every event, which the timeout rule below uses.
`service_retry_seconds` is the time the CLI spent in retry streaks it recovered from (a
diagnostic: such a session is still a sample).

- `input_tokens` counts all prompt tokens including cached ones for every harness
  (Claude's and Grok's cache reads and cache writes are added in; the raw split is in
  `usage_detail`). `output_tokens` includes reasoning tokens.
- `cost_usd`: Codex reports none (null). Claude reports `total_cost_usd`, which on a
  claude.ai subscription login is the CLI's list-price estimate, not a charge. Grok
  reports `total_cost_usd` too (also per model in `modelUsage`; on the grok.com login
  presumably an estimate as well); Grok's documentation says 0 means "not known", so 0
  is recorded as null.
- `turns`: Codex's completed turns (1 for one `exec` prompt); Claude's and Grok's
  `num_turns` (model round trips); the API systems' successful requests (model round
  trips). Not comparable across harnesses. `commands`: shell commands run (Codex
  `command_execution` items, Claude `Bash` calls, Grok `run_terminal_command` calls, the
  API systems' `shell` calls).
- `model_reported`: Grok's is the model it billed (the single key of `modelUsage`,
  `grok-4.6-build` for `-m grok-4.6`), else the model named in the stream.
- The API systems: `input_tokens` is all prompt tokens, cached ones included
  (Anthropic's cache reads and writes added in, as for Claude Code), `output_tokens`
  includes reasoning, `usage_detail` has the split and the request counts, `cost_usd`
  is null (no price list is frozen with a batch), `tools` counts the calls each tool
  ran, `model_reported` is the model the API named in its first response.
- The artifact is read by the runner outside the sandbox, so it must be a regular
  file with one link inside `output/`. A symlink or hard link to the hidden truth
  would otherwise be scored as the submission.

### Score-over-time snapshots

A 30-minute wall clock mixes speed, machine load and ability: one score per attempt
cannot tell "slow but good" from "fast but mediocre". So while an attempt runs, the
runner (`snapshots.mjs`) reads the contestant's `output/model.glb` at every multiple of
the interval (default 300 s, `prepare --snapshot-seconds`, frozen in the manifest)
counted from the CLI's spawn and strictly inside its wall clock (t300 … t1500 for 30
minutes; the final file is the point at the end), and copies it to
`<attempt>/snapshots/t0300.glb`, … . The copy is made outside the sandbox and outside
the workspace: the contestant can neither see nor change it, nothing in the workspace is
written, and nothing frozen changes. A copy whose content repeats an earlier one is not
stored again (its record names the earlier file, `same_as`).

The read is careful because the contestant is still running and could swap files and
directories under it. It happens in a short-lived process (`snapshot-read.mjs`) started
with `output/` as its working directory, which resolves nothing through the workspace
path again: it reads only if its working directory is the `output/` the attempt started
with (same device and inode, recorded before the launch; had `output/` been swapped for
a symlink, the process would be standing somewhere else), and a symlink swapped in and
out meanwhile cannot redirect it. Node has no `openat()`; the working directory is the
anchor it lacks. There `model.glb` is opened without following a symlink and without
blocking (a FIFO cannot hang the read), checked on the open handle (a regular file with
one link, within the artifact byte budget) and read from it; afterwards `model.glb`
must still be the file that was read. A file replaced meanwhile (the model's own atomic
rename, or a swap) or caught mid-write (a GLB whose header length is not what was read)
is read again, up to 4 times 0.75 s apart; a symlink, hard link, non-regular or
oversized file, or a replaced `output/`, is recorded as refused and scores 0, as the
final read would. A tick the runner reaches late is read late: each record keeps when
its copy was taken, and the report uses that time, not the tick.

After the final file is scored, the attempt's snapshots are scored in one worker process
(`score-worker.mjs` with a `snapshots` job: the task is loaded once, no error maps are
drawn), one per distinct content; a snapshot with the final file's content takes its
score. A snapshot the scorer fails on (it throws, or the worker crashes or times out
before reaching it) is scored again from the same stored file in a fresh worker, up to
2 times (`SNAPSHOT_SCORE_RETRIES`; nothing is generated again), the failed tries' reports
kept as `t0300.try-1.json`, … . **The attempt's score is still the final file's alone.** With concurrency 1 this
happens before the next attempt launches, so it never overlaps a contestant; it costs
about one scoring (25–100 s) per distinct snapshot, at most 5 for a 30-minute attempt
(the worker's time limit is the scoring limit per snapshot, for all of them).
Snapshots are scored only for a run supervised to its end with its boundary intact; for
an infrastructure error or a broken boundary they are kept, unscored, for diagnosis. A
runner stopped during snapshot scoring leaves the attempt unrecorded, and the next `run`
stops a snapshot worker it left running, then scores the final file and the snapshots
again (from `snapshots/index.json`, rewritten after every tick; an index that could not
be written is retried at the next tick and when the attempt ends, and costs no snapshot).
`v1/cli.mjs rescore` scores the snapshots again with the final file.

`result.json` carries `snapshot_interval_seconds` and `snapshots[]`, one per tick:
`{ t, name, at_seconds and read_seconds (when the read that was kept began and ended,
from the spawn), present, bytes, sha256, complete
(a whole GLB), file, same_as, status, score, valid, score_of, report, problem, error }`.
`status` is `absent` (no `model.glb` yet: score 0), `refused` (score 0, with `problem`),
`scored` (the scorer's score, 0 for an invalid model; `score_of` names the snapshot,
or `final`, whose scoring it shares), `score_error` (the scorer failed on it, and on its
retries: score null, `tries` in all), `lost` (read but not stored: score null) or
`not_scored`. The report counts a `score_error` or `lost` snapshot as missing, not as 0:
a scorer failure is not the model's performance. The report turns them
into a score-over-time curve and the median time to 95 % of the final score
(`v1/lib/report/README.md`).

### Statuses

First match wins. The score is computed independently of the status, from whatever
valid `output/model.glb` exists, so a timed-out run can carry a score.

| Status | When | Score | A sample? |
| --- | --- | --- | --- |
| `infra_error` | the harness could not run the model (next section); never given when the workspace boundary was broken | `null`, not scored | no: left out of every mean; archived and re-run automatically until a sample exists or the re-run cap is reached |
| `timeout` | the wall clock expired; the tree was killed | from the artifact left behind | yes |
| `budget_exhausted` | (API systems) the session used up its token or tool-call budget and was ended by the loop | from the artifact left behind | yes |
| `generation_failed` | launch error, non-zero exit, no completed turn, an error result after model turns that is not an infrastructure error, or broken workspace integrity | from the artifact; 0 on an integrity problem | yes |
| `missing_artifact` | the session finished, no `output/model.glb` | 0 | yes |
| `invalid_artifact` | symlink, hard link, over the byte budget, or the scorer says invalid | 0 | yes |
| `score_error` | the scorer failed on a valid-looking artifact | 0 in `result.json` | no: owed a re-score (`cli.mjs rescore`), left out of the means |
| `completed` | finished normally and scored | the score | yes |

An integrity problem (input, tools or runtime changed, a forbidden tool used) forces
the score to 0 and is never excused as an infrastructure error: the finding is kept
in `infra_ignored` for diagnosis. The report module leaves out `infra_error` (and, in
its current working copy, `score_error`) attempts; `summary` does the same for its means.

## Infrastructure errors

An attempt is `infra_error` when the session did not complete and the cause is the
harness, not the model. `result.json` then carries
`infra: { reason, action, during, model_turns, message, evidence[], retry_after,
retry_after_source, retry_after_text }`: `during` is `startup` (no model turn yet),
`session` (after model turns: still not a fair sample), `timeout`, or `unknown` (a
runner that died mid-attempt, found on restart); `evidence` keeps
the raw CLI text; `retry_after` is an ISO time when the CLI stated when a limit resets.

| reason | action | What it is |
| --- | --- | --- |
| `usage_limit` | wait | the subscription's usage limit (Codex "You've hit your usage limit…", Claude "You've hit your session/weekly limit…", Grok "You hit your weekly limit" / "…free Grok Build usage limit for now…") |
| `rate_limit` | wait | a 429 that is not the subscription limit |
| `overloaded` | retry | 529 / "high demand" / "at capacity" |
| `server_error` | retry | 5xx |
| `network` | retry | DNS, connection refused/reset, TLS, stream disconnected, Codex "waiting for network" |
| `auth` | stop | not logged in, token expired or revoked, 401/403 |
| `billing` | stop | quota, credits, spend cap, plan does not include the CLI |
| `model_unavailable` | stop | the model id is unknown or not on this plan |
| `cli_crash` | retry | the CLI could not start, or exited before any model turn with no recognised error |
| `cli_stalled` | retry | the whole wall clock passed without a model turn |
| `runner_interrupted` | retry | the runner was stopped or died while the CLI was generating |
| `host_suspended` | retry | the machine slept during the attempt, or the attempt ran more than 60 s past its wall limit (*The host-sleep rule*) |
| `request_rejected` | stop | (API systems) the API refused the frozen request before any model turn: a 400 or a 404 that is not about the model (an effort or a parameter the model does not take, a wrong base URL) |

`action` is what `run` does about it (next section): `wait` holds the batch until the
reset, `retry` holds it for a short backoff, `stop` stops the batch for a human. In every
case the attempt is archived and run again from a pristine workspace (for `stop`, by the
next `run`, after the human fixed the cause).

**The retry watchdog.** A CLI that has been retrying the service for
`--retry-stall-minutes` (default 10) with no sign of the model in between, and is still
retrying (its last retry event within 180 s plus the CLI's stated delay), is stopped at
once and recorded with the reason of its retries (`network` for Codex's "waiting for
network"), `watchdog: { kind: 'retrying', since_ms, last_ms, retries, stall_ms }`. A
streak is continuous only while its retry events are at most that far apart, so a
reconnect that recovered and a lone reconnect minutes later are not added up. A CLI that
prints nothing at all for the same time is stopped as `cli_stalled` (`kind: 'silent'`).
Without it, Codex facing an unreachable endpoint ("Reconnecting... waiting for network",
forever, observed live) would use the whole 30-minute wall clock of every attempt.
Stopping the CLI kills its whole process tree, as at the wall clock.

**What is not an infrastructure error.** A session that completed (whatever its exit
code afterwards); a failure after model turns whose message is not recognised; the
model filling its context ("ran out of room in the model's context window", "Prompt
is too long"), ending on max turns or max output tokens, or a policy/safety refusal;
transient reconnects the session recovered from (pilot astra had several and
completed); stderr noise such as Codex's "failed to refresh available models".
Unrecognised text is never guessed at: after model turns it stays the model's failure.

**Timeouts.** A timed-out session is an infrastructure error only if the CLI was
still retrying the service at the deadline: its last event is a retry/wait event
(Codex `error` "Reconnecting…"/"waiting for network", Claude `system/api_retry`),
nothing the model did came after it, and it arrived within 180 s (plus Claude's stated
`retry_delay_ms`) of the deadline. Codex waits for the network indefinitely (about
every 45 s it prints the same line), so an outage mid-session would otherwise be
scored as a model timeout. A timeout with no model turn at all is `cli_stalled`.
Time lost to a reconnect that recovered is measured (`service_retry_seconds`) but not
acted on: the session is a sample.

**How it is read.** Claude: the `result` event (`is_error`, `terminal_reason:
"api_error"`, `api_error_status`) and the synthetic assistant message that carries
the API error (`model: "<synthetic>"`, `is_api_error_message`, and Claude's own
category in `error`: `rate_limit`, `server_error`, `authentication_failed`,
`billing_error`, `model_not_found`, …), refined by the message text; a
`rate_limit_event` with `status: "rejected"` supplies `resetsAt`. Codex has no
structured error: the `turn.failed` message, else a final `error` event, is matched
against the patterns in `infra.mjs`. Grok: the `result` event with `is_error: true`
(`subtype: error_during_execution`) carries the CLI's message in `errors[]`, matched
against Grok's own texts in `infra.mjs`; with no result event, the stderr line
(`Error: …`). Model turns are Codex `item.*` (not `error`) and `turn.completed`; Claude's
and Grok's non-synthetic `assistant`, `user`, `tool_progress` and
`system/thinking_tokens`.

**Grok retries silently.** Grok's stream format has no retry or wait event (whatever
the CLI does while the service fails is not printed), and
the debug log is not written (see *grok*). So for `grok` the watchdog can only stop a
CLI that prints nothing at all (`cli_stalled`, `kind: 'silent'`; observed live: a
refused or unresolvable endpoint makes Grok wait without a word), and a service outage
that begins after model turns and lasts to the wall clock is scored as the model's
timeout. None of Grok's messages found states when a limit resets, so `retry_after` is
always null and holds use the backoff schedule.

**Observed or inferred** (codex-cli 0.159.2, Claude Code 2.1.285, 2026-10-01):

| Shape | Source |
| --- | --- |
| Codex usage limit: `turn.failed` "You’ve hit your usage limit. Upgrade to Pro (…) … or try again at 7:50 PM." (curly apostrophe; "Oct 3rd, 2026 7:50 PM" when not today) | live: real CLI against a local server answering 429 `usage_limit_reached`; the date form inferred from the binary's format string |
| Codex 429 `rate_limit_exceeded` → "exceeded retry limit, last status: 429 Too Many Requests" | live (local server) |
| Codex 500 → "We’re currently experiencing high demand…"; 503 → "unexpected status 503 Service Unavailable: …" (after "Reconnecting... 1/N (…)") | live (local server) |
| Codex 401 → "unexpected status 401 Unauthorized: …"; `insufficient_quota` → "Quota exceeded. Check your plan and billing details." | live (local server) |
| Codex not logged in → "Reconnecting... k/5 (unexpected status 401 Unauthorized: Missing bearer…)" over WebSocket, then over HTTPS, then `turn.failed` with the same (16 s) | live (real service, empty CODEX_HOME) |
| Codex unknown model → `turn.failed` `{"status":400,…"The 'X' model is not supported when using Codex with a ChatGPT account."}` | live (real service) |
| Codex with no network at all → repeated "Reconnecting... k/5 (workspace routing discovery failed)", then `turn.failed` "workspace routing discovery failed" (13 s) | live (real service, Seatbelt `deny network-outbound`) |
| Codex connection refused / DNS failure / bad TLS certificate on the model endpoint → "Reconnecting... waiting for network (Connection failed: error sending request)" forever | live (local server / `.invalid` host; stopped by hand after 78–613 s) |
| Codex mid-session drops → "Reconnecting... 2/5 (stream disconnected before completion: …)", item `error` "Falling back from WebSockets to HTTPS transport…" | live (pilot astra and luna logs) |
| Codex refresh-token, out-of-credits, spend-cap, "Selected model is at capacity", "usage limit for <model>" texts | inferred (binary strings) |
| Claude 529 → `api_retry` (`error: "overloaded"`, `error_status: 529`) per retry, then synthetic `error: "server_error"` "API Error: 529 Overloaded. …" and result `terminal_reason: "api_error"`, `api_error_status: 529` | live (local server) |
| Claude 500, 401 (`authentication_failed`, "Invalid API key"), 400 credit balance (`billing_error`), plain 429 (`rate_limit`, "API Error: Request rejected (429) · …", retried per `retry-after`) | live (local server, `--bare` with a dummy key) |
| Claude ECONNREFUSED, ENOTFOUND ("Can't reach the API server…"), self-signed TLS ("Unable to connect to API…", `api_error: "tls_untrusted_ca"`) | live (local server / `.invalid` host / real login under `deny network-outbound`) |
| Claude not logged in → synthetic `authentication_failed` "Not logged in · Please run /login" | live (real CLI, empty CLAUDE_CONFIG_DIR) |
| Claude unknown model → synthetic `model_not_found`, `api_error_status: 404` | live (real service) |
| Claude subscription usage limit → synthetic `rate_limit` "You've hit your session limit · resets 7:50pm (America/Los_Angeles)" (also weekly/Opus/Sonnet limit), `rate_limit_event` `status: "rejected"` with `resetsAt` | inferred: the message builder, the rate-limit headers it reads and the event schema are in the binary; only `status: "allowed"` events were seen live (pilot). A 429 with those headers on an API-key session is rendered as a plain rate limit (live) |
| Claude "Server is temporarily limiting requests (not your usage limit)", "OAuth session expired and could not be refreshed" | inferred (binary strings) |
| Grok unknown model → `system/init` then `result` `error_during_execution`, `num_turns: 0`, `errors: ["Couldn't set model 'X': Invalid params: \"unknown model id\". Run 'grok models' to see available models."]`, the same line on stderr, exit 1 (`model_unavailable`) | live (grok 1.0.46, 2026-10-05) |
| Grok cannot read its own files: "Failed to load config: Operation not permitted (os error 1)" (config.toml denied), "Couldn't start session: Managed policy could not be verified: the policy lock file under ~/.grok is not accessible…" (auth.json denied), "Couldn't create session: Permission denied" (sessions/ denied), "Custom sandbox profile 'X' not found … Refusing to start with its protections missing" (profile not in `<cwd>/.grok/sandbox.toml`); no result event, exit 1 (`cli_crash`) | live |
| Grok endpoint refused or unresolvable → no output at all until killed (`cli_stalled` by the silent watchdog) | live |
| Grok "You hit your weekly limit.", "You hit your free usage limit.", "…reached your free Grok Build usage limit for now…", `subscription:free-usage-exhausted` (`usage_limit`); "out of credits or over your spending limit", "Purchase credits…" (`billing`); "You've hit the rate limit for your plan…" (`rate_limit`); "Your team sign-in was rejected… Run `grok login`…", "Not logged in" (`auth`); "Grok is temporarily overloaded/unavailable…", "The service is busy…", "Authentication temporarily unavailable" (`overloaded`); "Something went wrong on the server/on our side", "The server returned an unexpected error (HTTP …)" (`server_error`); "Secure connection to Grok failed", "Connection to Grok timed out or was interrupted", "Check your network…", "The model stopped responding after …" (`network`); "The model hit its output limit", context-size errors, "Request too large" (the model's) | inferred (binary strings of 1.0.46) |

A real usage limit was not provoked. Patterns marked inferred are the CLI's own text,
not guesses, but their exact wording on the real service has not been seen. Claude Code
waits out 429/529 by itself only with `CLAUDE_CODE_RETRY_WATCHDOG`, which the runner
never sets (inferred from the retry code); without it a 429 whose `retry-after`
exceeds 60 s failed at once and one with `retry-after: 30` was retried (live).

## The host-sleep rule

The first test run was damaged twice by the laptop's lid being closed: no timer fires
while the machine sleeps, so attempts that were running were killed the moment it woke,
after a wall time they never had and with their network gone for an unknown part of it.
The rule was then applied after the fact (`v1/scripts/host-sleeps.py` and
`relabel-host-suspended.mjs`, which stay for the frozen batches); the runner now applies
it itself (`hostsleep.mjs`), the moment an attempt's CLI process has ended (any status,
also when a restarted runner rebuilds an attempt from its logs), before anything is
scored. It looks at time only, never at the score or the artifact:

- **overrun**: `wall_seconds > wall_limit_seconds + 60` (the runner kills the process at
  the limit, so only a suspended host lets it run longer);
- **asleep**: the power log (`pmset -g log`) shows the system asleep for 30 s or more
  between `started_at` and `finished_at`: every sleep of 30 s or more that overlaps the
  attempt counts with its overlap, and the overlaps are summed.

If either holds the attempt is `infra_error` with reason `host_suspended` (action
`retry`): archived, run again, not counted towards `--max-reruns`. It replaces a
retry-class finding of the classifier (the reconnects a wake produces are its symptom)
and no finding at all; a limit or a stop the classifier found is kept as the reason,
because it asks for a hold or a human, and the sleep is recorded beside it
(`infra.host_suspended`). A broken workspace boundary is never excused, here as
anywhere.

Parsing (ported from `host-sleeps.py`): the state changes are the lines whose domain is
`Sleep`, `Wake` or `DarkWake`; `Wake Requests` (logged two or three seconds after every
Sleep: the trap, which would end every sleep at once), `WakeDetails` and `WakeTime` are
not. A Sleep opens an interval, the next Wake or DarkWake closes it; a Sleep whose wake
is not logged yet lasts until the check. `pmset -g log` takes 15-30 s and 12-26 s of
CPU on this machine (27 MB of text; parsing it takes 0.1 s), so the runner records the system's sleep counter
(`pmset -g stats`, "Sleep Count", milliseconds) in `started.json` at launch and reads
the log only when the counter has moved by the end (streamed, low priority, keeping only
state lines). `result.json` records
`host_sleep_check: { checked: true, method: sleep-count | log, sleeps: [{ from, to, seconds }], asleep_seconds, sleep_count: { start, end } }`,
or `{ checked: false, reason }` when `pmset` is unavailable, prints nothing parsable, or
its log begins after the attempt started (it keeps a few days): then only the overrun
half of the rule applies. Tests inject the source (`deps.hostSleep`) with real lines
copied from `pmset -g log` (`runner-host-sleep.test.mjs`). Preflight probe sessions are
not checked.

## Re-runs, waiting and stopping

All of this happens inside one `run` invocation; nobody has to restart it.

**Re-runs.** An `infra_error` attempt is re-run from a pristine workspace: a new
`a<n>.fresh/` is built beside it (the frozen `prompt.txt`, `invocation.json` and harness
files copied, the workspace rebuilt by the same code as at `prepare` and checked against
the frozen hashes), `rerun.json` is written last, then `a<n>/` is renamed to
`a<n>.infra-<k>/` and `a<n>.fresh/` to `a<n>/`. A runner killed at any point leaves either
the old attempt or the new one, and the next `run` finishes or discards a half-done swap.
The archived try is never changed, deleted or scored. The new `result.json` carries `try`
and `tries[]`. Re-runs after a limit go to the front of the queue (they were next when the
limit hit), re-runs after a failing session to the back (an outage spreads its cost).

**The cap** (`--max-reruns`, default 5) counts only tries ended by the session's own
failure: `cli_crash`, `cli_stalled`, `network`, `overloaded`, `server_error`. An attempt
gets at most 1 + 5 such tries; after that it stays `infra_error`, is listed in `summary`
(`infra.capped`) and `status`, and a later `run` with the same cap leaves it alone (a
higher `--max-reruns` lets it run again). Not counted, because they say nothing about
whether this attempt can run: `usage_limit` and `rate_limit` (the account; handled by
waiting), `auth`, `billing`, `model_unavailable` (the batch stops for a human) and
`runner_interrupted` (an operator stopping the runner must not use up the cap) and
`host_suspended` (a closed lid says nothing about the attempt either). Every try
is archived and listed whatever its reason.

**Waiting.** An attempt that meets a limit or a failing service puts the batch on hold:
no new attempt is launched (one that was being prepared when the hold began goes back to
the queue unlaunched), attempts already running finish on their own (if they meet the
same limit they are `infra_error` too and join the hold without lengthening it), and
launching resumes when the hold ends:

| kind | reasons | hold |
| --- | --- | --- |
| limit | `usage_limit`, `rate_limit` | until the stated `retry_after`, plus 30-150 s; at least 1 min; a reset that did not hold the last time is not trusted alone. With no stated time: 2, 4, 8, 16, 30, 30, ... min, plus 30-150 s |
| retry | `overloaded`, `server_error`, `network`, `cli_crash`, `cli_stalled`, `host_suspended` | 1, 2, 4, 8, 16, 30, 30, ... min, plus up to 25 % |

The step grows while holds of a kind follow each other without a sample in between (only
an attempt launched after the last resume can lengthen it or reset it). After a hold,
launches are spaced 45 s apart, so one attempt finds out whether the limit is really gone
before every slot tries. One line goes to `progress.log` (and the log) when the batch
starts waiting (`WAIT <reason> until <time> (<local time>, retry_after|backoff) |
<attempt>: <message>`) and one when it resumes (`RESUME after <duration> (<reason>)`).
A runner restarted during a hold honours it: the hold is restored from
`runner-state.json`, or rebuilt from a future `retry_after` in the results on disk.
`--resume-now` drops a hold the operator knows is over. `--no-wait` exits instead of
waiting (exit 75), after the running attempts finish, saying until when.

**Several batches on one login.** Limits are per login, and the test run puts two batches
on each. Each runner waits only on the evidence of its own attempts (there is no shared
state between batches), and every hold draws its jitter from the batch id and the hold's
sequence number, so two batches told the same reset time resume at different moments
(30-150 s after it, seconds apart; deterministic for given ids, so reproducible but not
guaranteed apart: two draws land within 1 s of each other with probability about 1/60).
The first to resume finds out whether the limit is gone; the other follows a minute or
two later.

**Stopping.** `auth`, `billing` and `model_unavailable` are not waited on: the batch stops
launching, lets the running attempts finish, writes `STOP <reason>: <message> -> <what to
do>` to `progress.log`, saves the stop in `runner-state.json` and exits 3. So does a
changed runner, scorer, harness binary or object file (`frozen`). `status` shows the
stop until the next `run`, which re-runs the stopped attempt once the cause is fixed.

**`status`** answers "what is this batch doing, and if nothing, why and until when", for
one or several batches (`--batch a,b`), from `runner-state.json`, the lock and the
results. Example while a batch waits:

```
batch   pilot3-astra  codex gpt-6-astra/high  72 attempts  set test
state   WAITING: usage_limit until 2026-10-03T19:51:47.000Z (03/10/2026, 20:51:47 BST, in 2h 30m; reset time stated by the CLI); evidence house-0011-t2/a2: You’ve hit your usage limit. ...; runner pid 4242 (since 2026-10-03T09:00:00.000Z)
done    31/72: completed 27, timeout 2, infra_error 2; samples 29
owed    41 pending, 2 infra_error; 3 earlier tries archived
infra   usage_limit 2
mean    48.2 over samples, 50.1 over completed
last    2026-10-03T17:21:47Z  WAIT usage_limit until 2026-10-03T19:51:47.000Z (...)
```

Other states: `WAITING IN PREFLIGHT`, `EXITED INSTEAD OF WAITING (--no-wait)`, `STOPPED`,
`ERROR`, `WAS WAITING (runner gone)`, `RUNNING`, `FINISHED`, `INTERRUPTED`,
`PREFLIGHT_PASSED`, `PREFLIGHT_FAILED`, `PREFLIGHT GAVE UP`. The `summary` gives the same
state line (`runner`) in its JSON.

## Stopping and resuming

`run` is safe to stop and restart at any point; the same command continues.

- **Stop it** with Ctrl-C, SIGTERM or SIGHUP: no new attempt starts, a wait ends,
  running CLI trees and scorers get SIGTERM (SIGKILL after the grace period), each
  attempt that was generating is recorded as `infra_error` / `runner_interrupted` (and
  re-run, uncounted, by the next `run`), an attempt that was being scored records
  nothing (it is scored again next time), the lock is released, and the exit code is
  130. A second signal kills everything at once and exits. Use `nohup` or `tmux` for
  unattended runs, since closing the terminal sends SIGHUP. `preflight` stops the same
  way: it kills its probe session and writes no verdict (an earlier `preflight.json`
  stays as it was).
- **If it dies outright** (SIGKILL, power loss): the next `run` takes over the stale
  lock (pid and process start time no longer match), removes half-written temporaries,
  kills a CLI tree that outlived it (pid and start time from `child.json`), records an
  attempt that was generating as `runner_interrupted`, and rebuilds an attempt whose
  generation had finished from its logs and scores it, moving a partial `score/` aside
  to `score.interrupted-<k>/` after stopping a leftover scorer.
- **Two runners** on one batch are refused (`run.lock`; `preflight` takes the same lock,
  so a preflight and a run never overlap). Results are written once, atomically
  (temporary file + `link`), so no reader ever sees a torn `result.json`.
- **Following it**: `tail -f <batch>/progress.log` shows one line per finished attempt:
  time, done/total, attempt, status and score (or the infra reason and reset time),
  wall time, mean load, then samples / infra errors / pending. `summary` prints counts
  by status, samples, pending, started-but-unfinished, infrastructure errors by reason
  with the latest reset time, earlier infra tries found on disk, and the mean score
  per task over samples (every status but `pending`, `infra_error` and `score_error`,
  failures counting 0, as in the report) and over `completed` attempts only. `complete`
  is true only when nothing is pending and no `infra_error` or `score_error` is left,
  so a batch with capped re-runs is not complete. `status` (above) is the one-screen
  view of the same, with what the runner is doing.

## The boundary, harness by harness

The contestant may read its workspace plus a read-only runtime, write only
`output/`, `tmp/` and the workspace root, and reach no network. It may not read
the task's truth, `objects/`, other tasks or attempts, the repository, `~/.codex`,
`~/.claude`, `~/.grok`, the keychain, or anything else outside. Nested Seatbelt profiles
are refused by the kernel (`sandbox_apply: Operation not permitted`), so no CLI can
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
| `view_image`, `apply_patch` confined | Codex runs both through its "fs sandbox helper", which re-executes the codex binary under the same Seatbelt profile. It must be launched by its resolved path and its release directory must be readable, otherwise every image view and patch fails | `agent:view-*`, `agent:patch-*` (outside file, symlink, dangling symlink, symlinked directory); see *Image views in code mode* |
| Code mode | `functions.exec` runs model-written JS in a V8 isolate outside Seatbelt that, per its tool description, has no Node, fs, network or console, and reaches the world only through the nested tools above | `agent:code-mode-isolate` (model-reported `typeof require/process/fetch/...` and failed `node:` imports) |
| No user config, rules, project docs, skills, memories, plugins, apps, hooks | `--ignore-user-config` (config.toml, including its `shell_environment_policy.set`, which on this machine exports an API key), `--ignore-rules`, `project_doc_max_bytes=0`, `skills.include_instructions=false`, feature flags | checked offline with `codex debug prompt-input`. The model-visible input is the permission text, the collaboration-mode text and the environment context, nothing else |
| No global AGENTS.md | No setting stops `$CODEX_HOME/AGENTS.override.md` / `AGENTS.md` from being injected. `prepare` refuses, and `preflight`/`run` stop, while either is non-blank | `codexGlobalInstructions`; unit test |
| No sub-agents, web, browser, MCP | `agents.enabled=false` removes the `multi_agent_v1__*` tools that `features.multi_agent=false` alone leaves in place; others by feature flag. From codex-cli 0.162 the model is also offered `tools.list_mcp_resources`, `tools.list_mcp_resource_templates` and `tools.read_mcp_resource`; with user config ignored and no `mcp_servers` set they have no server to reach, and `agent:tool-list` accepts exactly those three names | `agent:tool-list` (model-reported); every run's events are scanned for non-allowed item types |
| No API keys | the login is ChatGPT (`codex login status`); child env scrubbed | `shell:env-names`, unit tests |

Codex's sandboxed shell is its bundled `zsh -c` (not `-lc`; `allow_login_shell=false`).
It still sets `HOME` to the real home, which the profile makes unreadable.

**Image views in code mode.** A code-mode model (gpt-6-astra, gpt-5.6-luna; catalog
`tool_mode: code_mode_only`) reaches `view_image` only as `tools.view_image` from its
JavaScript `exec` tool, and such a nested call leaves no event in the JSON stream,
whether it succeeds or fails. The only record is the tool router's stderr line
`ERROR codex_core::tools::router: error=<message>`. So `agent:view-canary` and
`agent:view-symlink` pass only on `view_image`'s own refusal for exactly that path,
`unable to locate|read image at \`<path>\`: Operation not permitted (os error 1)` (EACCES
accepted too); the path is compared after resolving it against the workspace, never as a
substring. Silence fails (a skipped call and a view that worked look the same); any other
`view_image` message for the path fails ("No such file", "failed to decode" mean it was
not refused, or its bytes were read); and a model that names the outside image's colour
fails, whatever the log says. The control image's colour is drawn per probe site from
red/green/blue/yellow (the outside images get two other colours), so the positive
control cannot be passed by guessing; a wrong colour fails, an ambiguous answer is
unanswered. A patch rejection that names no path ("patch rejected: writing outside of
the project") is credited to the `input/` patch only when every other refused patch has a
record of its own. Checked against the stored sessions: pilot2-astra and both luna
preflights pass on exactly those refusal lines; pilot1-astra (before the prompt was
reworded) made no view calls and fails `view-canary`/`view-symlink`.

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
| Built-in plugins | only those in `CLAUDE_BUILTIN_PLUGINS` (`events.mjs`), each reviewed as adding no tools: `agents-md`, `telemetry`, and from CLI 2.1.288 `plugin-authoring`; any other plugin fails `agent:tool-surface` and marks attempts as integrity problems | `agent:tool-surface` |
| No CLAUDE.md, auto-memory, skills, plugins, hooks, settings | `--safe-mode` (CLAUDE.md, skills, installed plugins, hooks, MCP, custom agents off), `--restricted` (user/project/local settings ignored), `--disable-slash-commands`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `--no-session-persistence` | `agent:instruction-files` (marked CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md, AGENTS.md planted beside the workspace never surface); `agent:shell-profile` (debug log: the shell snapshot found no `~/.bashrc`) |
| Existing login | `HOME` and the default config dir are kept. A separate `CLAUDE_CONFIG_DIR` changes the keychain service name and loses the login (`claude auth status` → logged out) | `claude auth status` in prepare (`authMethod: claude.ai`); `apiKeySource: none` in init |
| Keychain unreadable | `~/Library` is under `denyRead`, so `security find-generic-password` fails (44) inside the sandbox | `shell:keychain` |
| Inter-session socket | Claude opens a Unix socket inbox per session and exports `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN` to its shell; Unix sockets are blocked | `shell:unix-messaging` |

`--bare` would skip CLAUDE.md, hooks and keychain reads but accepts only API-key
auth, so it cannot use the existing login and is not used.

### grok

Grok Build 1.0.46 (`~/.grok/bin/grok` → `~/.grok/downloads/grok-1.0.46-macos-aarch64`),
headless, logged in with grok.com. Like the other CLIs and the API loop, **the CLI
process runs unsandboxed and only what the contestant runs is confined**: every shell
command under our Seatbelt profile (the API systems' generator), the in-process file
tools under Grok's own permission rules. (The first design, Grok's `--sandbox` profile
around the whole CLI, failed preflight on network, the read-only workspace parts and
`~/.grok`, because every child inherits the CLI's own profile and the CLI needs the
network and `~/.grok`; it is gone.)

```
grok --prompt-file <attempt>/prompt.txt --output-format streaming-messages-json -m <model> [--effort <e>]
  --cwd <ws> --agent <attempt>/harness/grok-agent.md --permission-mode bypassPermissions
  --tools run_terminal_command,read_file,search_replace,list_dir,grep,write
  --disallowed-tools todo_write,monitor,search_tool,use_tool,workflow,enter_plan_mode,exit_plan_mode,ask_user_question,
                     send_feedback,image_gen,image_edit,image_to_video,reference_to_video,spawn_subagent,
                     kill_command_or_subagent,get_command_or_subagent_output,scheduler_create,scheduler_delete,scheduler_list,Agent
  --no-subagents --no-plan --disable-web-search
  --deny 'Read(<p>)' ... --deny 'Edit(<p>)' ... --deny WebFetch --deny WebSearch --deny 'MCPTool(*)'      (about 1200 rules)
env: USER LOGNAME LANG PATH=<node bin>:/usr/bin:/bin:/usr/sbin:/sbin TMPDIR=<ws>/tmp
     HOME=<attempt>/harness/home (empty)  GROK_HOME=~/.grok  GROK_SHELL=<attempt>/harness/bin/bash
     GROK_{CLAUDE,CURSOR,CODEX}_{SKILLS,RULES,AGENTS,MCPS,HOOKS,SESSIONS}_ENABLED=0 GROK_MANAGED_MCPS_ENABLED=0
     GROK_MEMORY=0 GROK_SUBAGENTS=0 GROK_WEB_FETCH=0 GROK_BACKEND_SEARCH=0 GROK_SESSION_SEARCH=0 GROK_LSP_TOOLS=0
     GROK_TELEMETRY_ENABLED=0 GROK_TELEMETRY_TRACE_UPLOAD=0 GROK_DISABLE_AUTOUPDATER=1
     GROK_CONFIG={"toolset":{"bash":{"login_shell_capture":false}}}
```

`<ws>` is the workspace's real path (Grok's rules match it literally). Three harness
files are frozen with the attempt (text, hashed like the JSON ones):

- `harness/bin/bash`, the shell wrapper (made executable by the adapter's `stage` step
  just before launch, which also empties `harness/home`):
  ```sh
  #!/bin/sh
  exec /usr/bin/env HOME='<ws>/tmp' /usr/bin/sandbox-exec -f '<attempt>/harness/grok-shell.sb' /bin/bash "$@"
  ```
- `harness/grok-shell.sb`, the API systems' profile (`api/sandbox.mjs`, see *api-anthropic,
  api-openai*) for this workspace, with two additions: besides `input/`, `tools/`,
  `node_modules/`, also `.grok`, `.claude`, `.cursor`, `.agents`, `.codex` and `.mcp.json`
  stay unwritable (project configuration a CLI might load), and
  `(deny file-write-create (vnode-type SYMLINK))`: the shell cannot create symbolic links.
- `harness/grok-agent.md`, the agent definition: Grok Build's default prompt (`promptMode:
  extend` with an empty body), `discoverSkills: false`, `inheritSkills: false`, `skills: []`,
  `mcpInheritance: none`.

| Requirement | How | Evidence (live preflight of `probe-grok-2`, grok-4.6 low: **passed**) |
| --- | --- | --- |
| Shell confined (R1, R2, R3 for commands) | Grok starts every shell, its environment capture (`-lc …`) and each command (`-c …`), through `GROK_SHELL` (undocumented; the binary's shell-resolution code names `GROK_SHELL`, `SHELL` and `/bin/bash`; live: both calls arrived at the wrapper, and a command's `ls /Users` was refused). The wrapper `exec`s `sandbox-exec`, so the command starts inside the profile and no child can leave it | `shell:*` all pass: `tcp-loopback` `denied:EPERM` and no connection at the runner's listener, `unix-socket`, `tcp-internet`, `http-internet` (DNS fails); `input-write`/`-create`, `tools-write`, `runtime-write` `denied:EPERM` (chmod too); `grok-home`, `grok-sessions`, `grok-auth` `denied:EPERM`; canaries via file, symlink, directory symlink, hard link; repo, truth, objects, other attempt, home, `~/.codex`, `~/.claude`, `/tmp`. The same wrapper and profile under a fake CLI in the unit tests (`runner-grok.test.mjs`) |
| No links from the shell | the profile's `vnode-type SYMLINK` rule. Grok's file tools check a path and then open it in the CLI process, so a link swapped in between could lead them outside; without links nothing inside the workspace can point out of it (a hard link to an outside file was already refused) | `agent:shell-symlink`: `ln -s input .e3d-probe/shell-link` → "Operation not permitted", nothing on disk |
| File tools confined (R2, R3 for tools) | the deny rules: Grok applies `Read(...)` rules to read_file, list_dir, grep and the paths a shell command names, `Edit(...)` rules to write, search_replace and shell redirects, and checks deny rules against the resolved target of file and directory symlinks (dangling ones included) after collapsing `..`. The rules are a complement cover: for every directory on the way to an allowed root, patterns for every other name (`[!...]` classes on a character trie of the allowed names, every letter written `[aA]` because Grok matches path globs without regard to case: live, `/us[!r]*/**` matched `/Users/...`). Read roots: the workspace, `/usr`, `/bin`, `/sbin`, `/System`, `/etc`, `/private/etc`, `/dev/{null,zero,random,urandom,fd}` and the Node install (what the shell may read too); Edit roots: the workspace and `/dev/{null,zero,dtracehelper}`; plus `Edit` on the read-only names in any case. Checked against the paths outside a root both ways (unit test) | `agent:read-*` (absolute path, file symlink, directory symlink, dangling symlink, `..`), `agent:grep-*` (outside directory, workspace, linked directory), `agent:list-*` (outside, linked directory, `..`), `agent:write-*` (input, outside, symlink, dangling, linked directory), `agent:view-canary`, `agent:view-symlink` all refused ("Tool `…` was not executed: Denied by permission policy: deny rule on read matching …"); controls `agent:read-input`, `agent:write-output`, `agent:edit-output` |
| Permission mode | `bypassPermissions` plus the deny rules. `dontAsk` (the mode the Claude Code track uses) is not usable headless: a call no rule allows, and every shell command Grok cannot split into simple commands (`$(...)`, a subshell, a loop), becomes a permission prompt, and in `-p` mode a prompt cancels the whole session (live: "User cancelled the execution for tool …", result `error_during_execution`). With deny rules covering everything outside, nothing a deny rule does not refuse is outside the workspace | as above; compound commands ran (live) |
| Image viewing | `read_file` returns a PNG or JPEG as an image (`ImageContent`, `image/png` / `image/jpeg`; both live); the prompt says "Use read_file to look at the evidence and at your own previews" | `agent:view-control` (the control image's bytes came back and the model named its colour) |
| Tool surface, no skills | six tools (`--tools` alone does not narrow the set; `--disallowed-tools` does); the agent definition turns off skill discovery (no flag, environment variable or `GROK_CONFIG` key does; with the default agent the session lists Grok's bundled skills, among them `threejs-frame-conventions`) | `agent:tool-surface` from `system/init`: exactly the six tools, `mcp_servers: []`, `skills: []`, `apiKeySource: oauth` |
| No user plugins, hooks, MCP servers, instruction files, memory | `HOME` is an empty directory: with the real `HOME` Grok loads the user's Claude Code plugins (their hooks, their MCP servers, their skills) and `~/.agents/skills` (live); `GROK_HOME` stays `~/.grok`, where the login is. The compatibility, memory, MCP and other switches above | `agent:grok-config` (`grok inspect --json` with the session's own environment: no plugins, hooks or MCP servers; also checked at `prepare`, which refuses otherwise); `agent:grok-context` (Grok's record of the session: no AGENTS.md files, no personas, memory off); `agent:instruction-files` |
| No sub-agents, web, leader | `--no-subagents`, `--disable-web-search`, `GROK_WEB_FETCH=0`, `GROK_BACKEND_SEARCH=0`, deny `WebFetch`/`WebSearch`/`MCPTool(*)`. Leader mode is off by default and not configured (`grok leader list`: none); a leader would run the tools outside our wrapper, which the shell checks would catch | `agent:tool-surface`; `shell:*` |
| No credential-like environment | the CLI's environment is built from scratch; the shell's is what Grok passes on, minus the login shell | `shell:env-names` |
| Existing login | `GROK_HOME` is the user's `~/.grok`; `grok models` says "You are logged in with grok.com." and an API-key login is refused at `prepare` | `prepare`; `apiKeySource: oauth` in init |

The model's context besides the prompt (Grok's record of the probe session): Grok
Build's system prompt without its browser-verification section (that section comes with
the built-in agent; the system prompt is otherwise identical, live), a `<user_info>` block
(OS, shell, workspace path, date), one rule compiled into the binary that Grok presents as
a user rule (affirmative wording), and a system reminder naming Grok's one compiled-in
workflow, `deep-research` (the `workflow` tool is disallowed, so it cannot be run). No
`--debug-file`: it would land where the contestant can read it, and it can carry
configuration values such as provider keys. The prompt also goes to stdin, which headless
Grok ignores.

Effort levels (from Grok's model catalogue, `~/.grok/models_cache.json`): `grok-4.7` and
`grok-4.6` take `low`, `medium`, `high` (the default) and `xhigh`; a model the catalogue
does not describe gets the canonical list (`none` … `max`), and preflight's session
checks it. Context window 256k for both, auto-compaction at 80%.

### antigravity

**Unverified: written from the documentation on a machine without agy (2026-10-22).**
Google Antigravity CLI (`agy`, `~/.local/bin/agy`, `E3D_AGY_BIN`), headless, logged in
with a Google account (the token is in the macOS keychain). Every statement below
comes from antigravity.google/docs (CLI reference, headless, settings, permissions,
sandbox, rules, troubleshooting) and has to be proven by the first preflight on the
machine that runs a batch; where preflight disagrees, the adapter is wrong, not the
check. The tests (`v1/test/runner-antigravity.test.mjs`) pin what the runner does with
the documented shapes; none of their streams was captured from the real CLI.

```
/bin/sh <attempt>/harness/agy-run.sh --output-format stream-json --model <model> [--effort <e>]
        --sandbox --disable-slash-commands --print-timeout <wall + 600>s
agy-run.sh:  exec <agy realpath> -p "$(cat <attempt>/prompt.txt)" "$@" </dev/null
env: HOME (the user's), USER, LOGNAME, LANG, PATH=<node bin>:/usr/bin:/bin:/usr/sbin:/sbin,
     TMPDIR=<ws>/tmp, AGY_CLI_DISABLE_AUTO_UPDATE=true
```

agy takes the headless prompt as the argument of `-p`, so the frozen invocation is a
runner-owned script that reads `prompt.txt` and execs the frozen binary; the prompt
the runner pipes to stdin is not passed on. `--print-timeout` (agy's own wait for the
turn, default 5 min) is set 10 minutes above the wall clock, which decides.

Like the other CLIs, **the CLI process runs unsandboxed and only what the contestant
runs is confined**, here entirely by agy's own mechanisms, configured through the one
settings file agy reads (`~/.gemini/antigravity-cli/settings.json`; no flag or variable
points it elsewhere, and a separate HOME might lose the keychain login):

| Setting | Value | Why |
| --- | --- | --- |
| `toolPermission` | `proceed-in-sandbox` | sandboxed commands run without the prompt headless mode cannot show |
| `enableTerminalSandbox` | `true` (also `--sandbox`) | every command under agy's Seatbelt profile: the workspace read-write, system directories readable, nothing else mounted, no network |
| `allowNonWorkspaceAccess` | `false` | the file tools stay inside the workspace |
| `useG1Credits` | `false` | never spend paid AI credits when the plan's quota runs out |
| `artifactReviewPolicy` | `always-proceed` | a plan artifact must not wait for a review nobody gives |
| `agentMode` | `default` | not `auto`, which runs commands outside the sandbox when it judges them safe |
| `modelProvider` | `""` | the Google login, never `GEMINI_API_KEY` |
| `permissions.allow` | `read_file(<node install roots>)` only | node readable inside the sandbox; nothing else opened |
| `permissions.deny` | `read_url(*)`, `execute_url(*)`, `mcp(*)`, `unsandboxed(*)`, `write_file(input/ tools/ node_modules/ .agents/ .agent/ AGENTS.md GEMINI.md)` | no web, browser, MCP or unsandboxed command; protected names unwritable by the file tools |

`node v1/scripts/run.mjs antigravity-settings` prints these merged into the current
file; `--write` writes them (the previous file is kept beside it). Defaults are judged
as defaults (the CLI saves only non-default values). Nothing under `~/.gemini` may add
to a session: global rules and context files (`AGENTS.md`, `GEMINI.md`, `config/rules/`,
`antigravity-cli/rules/`), hooks, MCP servers, plugins, skills, subagents (the last two
locations are guesses). All of it is checked at prepare, before every launch (a change
stops the batch, reason `frozen`) and in preflight (`agent:agy-config`).

What preflight proves for agy: the probe script through `run_command` (the standard
shell probes: canaries, repository, truth, other attempts, home, `~/.gemini`, keychain,
loopback, Unix socket, internet); the file tools (`view_file` and whatever agy calls
its list, search, write and edit tools: matched by kind, see `AGY_KINDS`) on the same
routes as Grok's (absolute paths, `..`, file, directory and dangling symlinks,
`input/`, `.agents/`); `view_file` showing the control image and refusing the two
outside ones; the web tools (`search_web`, `read_url_content`) refused or absent; no
planted `AGENTS.md`/`GEMINI.md` obeyed; and the settings check. Use of a web, URL,
browser or MCP tool that was not refused makes an attempt an integrity failure.

Known gaps, to be settled live before results count:

- **Tool names.** agy's pages disagree (CLI: `write_to_file`, `replace_file_content`;
  SDK: `create_file`, `edit_file`, `list_directory`, `search_directory`). The contestant
  prompt names only `run_command` and `view_file`, on which both agree. Whether
  `view_file` shows images is not documented; the control-image check decides.
- **Subagents and image generation** (`start_subagent`, `generate_image`) cannot be
  switched off; their use is counted in `tools`, not refused. Whether a subagent
  inherits the sandbox and permissions is not documented.
- **The shell may create project configuration.** agy's sandbox mounts the whole
  workspace read-write, so a command could write `.agents/` or `GEMINI.md`; the deny
  rules cover only the file tools. Whether agy reads such files mid-session (and runs
  hooks from them outside the sandbox) is unknown; a workspace is never a trusted
  folder, which by the documentation is what project hooks and MCP servers need.
- **Workspace trust.** agy asks to trust a folder on first interactive use; what a
  headless run in an untrusted folder does is not documented.
- **Usage.** `input_tokens` is taken to include `cache_read_tokens` and
  `output_tokens` to include `thinking_tokens` (the documented example adds up that
  way); no cost is reported (`cost_usd` null). Quota messages other than "Individual
  quota reached" are guesses (`AGY_PATTERNS` in infra.mjs).
- **Model ids** may be display names (`--model "Gemini 3.7 Flash"`); prepare requires
  the id to appear in `agy models` when that command exists, and an unknown one ends
  the session with "invalid model selection" (model_unavailable, stop).

### api-anthropic, api-openai

The loop that talks to the API is ours and runs unconfined, like a CLI process (nested
Seatbelt profiles are refused); the model reaches the machine only through the five
tools.

```
shell:  /usr/bin/sandbox-exec -p <profile> /bin/bash -c <command>     cwd <ws>
        env PATH=<node bin>:/usr/bin:/bin:/usr/sbin:/sbin HOME=TMPDIR=<ws>/tmp LANG=en_US.UTF-8
profile (api/sandbox.mjs, frozen in api-config.json; paths resolved to real paths):
  (deny default)  (allow process-fork process-exec)  (allow signal / process-info* (target same-sandbox))  (allow sysctl-read)
  (allow file-read-data (literal "/"))  (allow file-read-metadata <every ancestor of the roots below, literally>)
  (allow file-read* /usr /bin /sbin /System /private/etc /private/var/db/timezone /private/var/select
                    /dev/{null,zero,random,urandom,fd} <node install, Homebrew Cellar/opt/openssl/ca-certificates> <ws>)
  (allow file-write-data /dev/null /dev/zero)
  (allow file-write* (require-all (subpath <ws>) (require-not <ws>/input) (require-not <ws>/tools) (require-not <ws>/node_modules)))
```

| Requirement | How | Evidence |
| --- | --- | --- |
| Shell confined | the profile above: everything not allowed is denied, so no network (TCP, UDP, DNS, Unix sockets), no Mach services (keychain, directory services), no other process; writes only in the writable parts of the workspace; the probe could not even create a hard link to an outside file | preflight `sandbox:*` (the probe script under the profile, no model) and `shell:*` (the same script through the `shell` tool) |
| File tools confined | in code (`api/tools.mjs`): a path must stay inside the workspace lexically (absolute paths elsewhere and `..` refused) and after resolving it one component at a time, following a symlink only when it resolves inside; a link that leads out or nowhere is refused with the same words either way (no oracle for what exists outside); files with several hard links are refused (except the runtime under `node_modules/`, hard-linked by the runner and read-only to the shell); writes never into `input/`, `tools/`, `node_modules/`, never through a symlink, never into a hard-linked file (`O_NOFOLLOW`) | preflight `agent:*`: `read_file`, `list_dir`, `view_image`, `write_file` on the outside file, a file symlink, a directory symlink, a dangling symlink, a runner-planted hard link and `..`, plus controls; judged by canary content and names in the results and by the files on disk |
| No credentials | the key reaches the loop on stdin only; the shell's environment is built from scratch; nothing of the runner's environment is passed | `shell:env-names`; key-search tests over whole batches |
| Fixed tool surface | the loop runs its five tools and nothing else; an unknown tool name gets an error result | `agent:tool-surface` (the frozen definitions are exactly the five); every run's events checked |
| No instructions from the machine | the loop reads only its frozen config and the prompt | (nothing to load; reported `not_applicable`) |

## The API systems

`api-anthropic` and `api-openai` run the same minimal agent loop of our own
(`api/loop.mjs`) against the Claude Messages API and the OpenAI Responses API: the same
five tools, the same prompts, the same budget, the same boundary. Only the wire format
differs (`api/anthropic.mjs`, `api/openai.mjs`).

**Live behaviour against the real APIs has not been exercised.** There were no API keys
on the development machine; the loop, the runner integration and preflight were built
and tested against local mock servers (`api/mock/`) that follow the documented
protocols (below). The first live batch is the first contact with the real services.

```sh
export ANTHROPIC_API_KEY=...          # in the shell that runs preflight and run; never written anywhere
node v1/scripts/run.mjs prepare   --id api1-opus --system api-anthropic --model claude-opus-5-5 --effort high --tasks a,b,c
node v1/scripts/run.mjs preflight --batch .local/v1/runs/api1-opus
node v1/scripts/run.mjs run       --batch .local/v1/runs/api1-opus

export OPENAI_API_KEY=...
node v1/scripts/run.mjs prepare   --id api1-sol --system api-openai --model <model id> --effort high --tasks a,b,c
node v1/scripts/run.mjs preflight --batch .local/v1/runs/api1-sol
node v1/scripts/run.mjs run       --batch .local/v1/runs/api1-sol
```

`--token-budget` (default 2 000 000), `--tool-budget` (default 200) and
`--max-output-tokens` (per request, thinking included; default 32 000) are frozen at
`prepare`, with the model, the effort and the base URL. `prepare` checks the effort
against the provider's documented levels (Anthropic `low medium high xhigh max`, OpenAI
`none minimal low medium high xhigh max`); whether this model takes it is shown by
preflight's live request (a refusal stops it as `request_rejected`). `preflight` and
`run` stop with exit 3 when the key variable is not set.

### The loop

One process per attempt, started by the runner exactly like a CLI (it is the system's
"harness binary": `node <repo>/v1/lib/runner/api/loop.mjs <attempt>/harness/api-config.json`,
its sha256 frozen and re-checked like a CLI's), under the same wall clock, kill, event
and stderr capture, watchdog, integrity checks, classification and scoring. Everything
a session depends on is frozen in `harness/api-config.json` (hashed into the
invocation): provider, model, effort, base URL, system prompt, tool definitions,
budget, output and retry limits, and the Seatbelt profile. The key is not: the runner
reads it from its own environment when the attempt launches and hands it to the loop on
stdin (`{ key, prompt }`), never through argv or the environment (both visible to other
processes) and never into a file. The loop holds it in memory, and everything it prints
passes through a redactor (the key itself, `x-api-key`/`authorization` values, `sk-…`
shapes become `[REDACTED]`); the runner redacts preflight's live request the same way.
Tests search every file of a batch for the key, including when the mock echoes it back
in an error.

The session: send the conversation; log the usage; run the tool calls in order, each
counted against the tool budget; send the results back; repeat until the model replies
without a tool call (status `completed`) or a budget is exhausted (`budget_exhausted`).
A reply cut off at the output limit is continued ("continue where you stopped; write
long files in parts"), and calls in it are not run (they may be incomplete). No
context compaction: a full context is the model's failure (`generation_failed`). The
history is append-only: every assistant turn is sent back exactly as it came (Claude's
thinking blocks, OpenAI's reasoning items with their encrypted content), as both APIs
require. Requests are non-streaming, over `node:https` (Node's `fetch` gives up on
headers after 300 s), with TCP keep-alive and a 20-minute idle timeout.

**Prompts.** The task prompt is the CLI systems' text (`prompt.mjs`, `buildPrompt`)
with two paragraphs adapted, the same for both API systems: the tool paragraph names
`shell`, `read_file`, `write_file`, `list_dir`, `view_image`, and the time-limit
condition names the budget instead ("There is a hard budget of N tokens (the input and
output of every request, summed) and M tool calls. When it runs out the session is
stopped, …"), because the wall clock is not the binding limit here. The system prompt
(`apiSystemPrompt`, identical for both providers) names the tools, the budget, the
one-time notice, the wall-clock safety limit, and that the session ends when the model
replies without a tool call. Both are frozen into the batch (`prompt.txt`, the config).

**Tools** (`api/tools.mjs`, one definition for both providers; OpenAI's are sent with
`strict: false`, because the Responses API's default strict mode needs every property
required):

| tool | arguments | result |
| --- | --- | --- |
| `shell` | `command`, optional `timeout_seconds` (default 120, at most 300) | `/bin/bash -c` in the workspace under the sandbox; stdout and stderr interleaved, cut to 20 000 characters (the first and last 10 000), then `[exit code N]`; the command's process group is killed when it ends or times out |
| `read_file` | `path` | the text (cut to 20 000 characters; at most 4 MB read); binary files are refused with a hint |
| `write_file` | `path`, `content` | writes the file, creating missing directories |
| `list_dir` | `path` | one entry per line: `name/`, `name (N bytes)`, `name@ (symbolic link)` |
| `view_image` | `path` | the PNG or JPEG itself, as an image block (Anthropic: `image` in the `tool_result`; OpenAI: `input_image` in the `function_call_output`). PNGs over 2000 px on a side are scaled down (Claude rejects larger images once a request holds more than 20, and every image stays in the history); larger JPEGs are refused; at most 5 MB |

A refused or failed call comes back to the model as an error result (Anthropic
`is_error`), never as a crash of the session.

**Budget** (`api/budget.mjs`): tokens are the sum over requests of input plus output
tokens as the API reports them, cached input counted in full (Anthropic: `input_tokens +
cache_creation_input_tokens + cache_read_input_tokens + output_tokens`; OpenAI:
`input_tokens + output_tokens`). The token budget is checked before each request (the
request that crosses it is the last, and its tool calls still run); the tool budget
before each call (at most M calls run; every call the model asks for counts, unknown
tools and unparsable arguments included, except calls in a reply cut off at the output
limit). Once, when either reaches 85 %, the next tool results carry "[harness] Budget
notice: about N tokens and M tool calls are left. Write output/model.glb now." The wall
clock is only a safety cap: 2 × the task's `wall_seconds`, enforced by the runner (a
session that reaches it is a `timeout`).

**Effort, thinking, caching.** Anthropic: `output_config: { effort }` and `thinking: {
type: "adaptive" }` (Claude Opus 5.5 always thinks and defaults to effort `medium`;
models that reject adaptive thinking fail preflight's live request), `cache_control` on
the system prompt block and the last tool, plus top-level automatic caching, which moves
the breakpoint to the end of each new request (3 of the 4 allowed breakpoints, no edits
to earlier turns), `anthropic-version: 2023-06-01`. OpenAI: `reasoning: { effort }`,
`store: false`, `include: ["reasoning.encrypted_content"]` (documented as legacy but
accepted), the whole output replayed as input each turn, automatic caching with a
per-attempt `prompt_cache_key`. Cached input is reported in `cached_input_tokens`.

**Failures.** The loop classifies every HTTP failure itself (`api/errors.mjs`) and
states its verdict in its `result` event; the runner takes it from there with its
existing wait, retry, stop and cap machinery.

| answer | reason | in the loop | then |
| --- | --- | --- | --- |
| 429 with `retry-after`, `anthropic-ratelimit-*-reset` or `x-ratelimit-reset-*` | `rate_limit` | waited out if one wait is at most 2 min and all waits of one request at most 8 min (below the 10-minute watchdog) | `infra_error`, `retry_after` from the header: the batch holds until then |
| 429 spend cap (`enforced_spend_limit_reached`), quota or credit codes; 402; 400 "credit balance" / "specified API usage limits" | `billing` | — | stop |
| 529, 503 | `overloaded` | 3 retries, 10 / 30 / 90 s apart | `infra_error`, retry hold |
| 500, 502, 504, 408, 409, a 200 that is not a response | `server_error` | the same | the same |
| DNS, refused, reset, TLS, dropped connection, timeout | `network` | the same | the same |
| 401, 403 | `auth` | — | stop |
| 404 naming the model; `model_not_found` | `model_unavailable` | — | stop |
| other 400 / 404 / 413 before any model turn | `request_rejected` | — | stop |
| context window error (400 "prompt is too long", `context_length_exceeded`) | — | — | `generation_failed` (the model's) |
| other 400 / 413 after model turns | — | — | `generation_failed` |
| the loop's own exception, or its end without a `result` event | `cli_crash` | — | `infra_error`, retry |

**Events** (`events.jsonl`, one JSON object per line, each with `t`, ms since the loop
started): `session` (provider, model, effort, base URL, budget, tools); `request` (`n`,
`ok`, HTTP status, ms, request id, model, `stop_reason`, `usage` normalised as above
plus `raw_usage`, `tokens_used`, `calls_used`; or, failed: `reason`, `action`,
`message`); `retry` (`reason`, `attempt`, `delay_ms`, `source`); `text` (model text);
`tool` (`call`, `name`, `args` summary (paths, the command, the byte count of a
write), `executed`, ms, `ok`, `refused`, exit code, timeout, output size, truncation, an
excerpt); `notice` (`budget` or `cut_off`); `result` (`status` completed /
budget_exhausted / error, `stop_reason`, `exhausted`, `error_kind`, `infra`, totals).
`api/events.mjs` reduces it to `turns`, `commands`, `tools`, `usage`; the model's notes
are whatever it wrote to `output/notes.md`.

**Wire formats, as documented** (read 2026-10-05; each module cites its pages):
platform.claude.com/docs/en/ `agents-and-tools/tool-use/overview.md`,
`agents-and-tools/tool-use/handle-tool-calls.md`, `build-with-claude/effort.md`,
`build-with-claude/prompt-caching.md`, `build-with-claude/vision.md`, `api/errors.md`,
`api/rate-limits.md`; developers.openai.com/api/docs/ (platform.openai.com/docs
redirects there) `guides/function-calling`, `guides/reasoning`,
`guides/conversation-state`, `guides/images-vision`, `guides/error-codes`,
`guides/rate-limits`, and `api/reference/resources/responses/methods/create`.

**Mocks** (`api/mock/server.mjs`): one local HTTP server per protocol, scripted one
step per request (text, tool calls, a reply cut off at the output limit, a refusal,
any HTTP error with `retry-after` or reset headers, a context-length error, a dropped
connection, an echoed key, usage numbers). Each request is checked against the
documented rules (headers, tool definitions, every `tool_use` answered by a
`tool_result` first in the next user message, no prefill, at most 4 cache breakpoints;
`store: false`, every `function_call` answered, reasoning replayed with its encrypted
content, strict-mode schemas) and a violation is answered 400 and recorded.
`api/mock/fixtures.mjs` holds the tests' data root, a preview kit whose tool draws a
real PNG, a fake scorer and a scripted session that uses every tool.

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
  Read/Grep/Glob/Write/Edit for Claude Code, view_image/apply_patch/code mode for
  Codex, and read_file (text and images)/grep/list_dir/write/search_replace for Grok,
  for which `..` and a search through a linked directory are added (its file tools run
  in the unsandboxed CLI under its own path rules), and a shell `ln -s` judged on disk.
  For Grok the shell probe's report is taken from the raw bytes of the tool result
  (`output`): the copy shown to the model (`output_for_prompt`) has its long lines
  wrapped at about 2000 characters and does not parse. `agent:grok-context` reads Grok's
  own record of the probe session (`~/.grok/sessions/<cwd>/<session id>/prompt_context.json`,
  after the session, by the runner): no instruction files, personas or memory.
  `agent:grok-config` runs `grok inspect --json` with the session's environment: no
  plugins, hooks or MCP servers.

Probe targets include input readable; input, tools and runtime not writable even
after `chmod`; output and tmp writable; the canary (directly, through
file/directory/dangling symlinks, through a hard link); writes outside;
repository scoring code and contract; the task's `truth.json`; `truth/`,
`objects/`, `tasks/`; another attempt; the batch manifest; the home directory;
`~/.codex/{auth.json,config.toml,memories}`; `~/.claude/{settings.json,projects}`;
`~/.claude.json`; `~/.grok`, `~/.grok/sessions` (listed) and `~/.grok/auth.json` (probe
kind `open`: opened for reading and closed, never read, so a credential file is tested
without its content passing through the probe); `~/.ssh`; `/private/tmp`; the keychain
entry; `three` importable;
the preview tool rendering a non-blank PNG of the fixture house; no credential-like
environment variable names; loopback TCP and a Unix socket (both runner-owned, so
an accepted connection is counted by the runner itself); the harness's own
messaging socket; TCP to 1.1.1.1:443; HTTPS through whatever proxy the harness sets.

Evaluation prefers ground truth: listener hit counts, files on disk, canary
content and names in tool results. Every check must pass, and one that could not
be evaluated fails preflight. A target missing on this machine is reported as
`not_applicable`. An agent session with no failed check but some unanswered ones
(the model did not follow the script) is run once more in a fresh site. A failed
check is never retried.

**The API systems** prove the boundary without a model (`api/preflight.mjs`), on two
fresh probe sites with the same canaries and planted routes: `sandbox:*` runs the probe
script under the frozen profile with `sandbox-exec`, `shell:*` runs it through the
`shell` tool as the model would, and `agent:*` aims the four file tools at the canaries
and escape routes (above). Deterministic, so a failed check is the boundary's.
`live:request` then sends one minimal request (the frozen model, effort, system prompt
and tools, a one-line user message, at most 2048 output tokens) when the key variable
is set: it proves the key, the model id and that the API accepts the request shape.
Without the key the boundary is still proven, the live check is reported as skipped,
and preflight ends with `infra: { reason: auth, action: stop }` (exit 3); a refused
live request ends the same way with its own reason (`auth`, `billing`,
`model_unavailable`, `request_rejected`), a failing service after two retries with
`overloaded`/`server_error`/`network` (exit 75). Measured on this machine against the
mocks: about 8 s per preflight.

**Infrastructure errors in preflight.** The probe session is classified like an
attempt. If it ended on an infrastructure error, the checks it failed only because
something expected never happened (a control that did not land, a refusal never logged)
become `not_evaluated`; a check failed on evidence of a leak stays failed. With no failed
check (and a sandbox stage that passed), preflight then waits exactly as `run` does
(`WAITING IN PREFLIGHT` in `status`) and probes again in a fresh site, up to 6 sessions;
`auth`/`billing`/`model_unavailable` stop it at once, and `--no-wait` exits (75). The
report then has `passed: false`, `failed: []` and `infra: { reason, retry_after, gave_up:
stop|no-wait|tries|aborted, hold: { until_at, ... }, session, tries }`, and `run` refuses
with "could not finish (infrastructure: ...); run preflight again", not "did not pass". Measured cost per preflight: Claude Haiku 4.5 about
25–30 s and US$0.04–0.07 (CLI estimate); gpt-5.6-luna low about 35–45 s and
about 95k input tokens (mostly cached), no cost reported; grok-4.6 low about 50–55 s,
21–25 turns, 194k–246k input tokens (84–92% cached), about 1k output tokens and
US$0.05 as Grok reports it.

## What is not enforced

- **The model service is remote.** Each CLI process talks to OpenAI, Anthropic or xAI
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
  preflight fail, but cannot make a leak pass silently: the image-view refusals are
  taken from Codex's own log, not from the model. The Claude instruction-file
  check proves only that the planted files were not obeyed. Its positive control
  (the same files reaching a session without `--safe-mode`) was not run.
- **Process escape after exit.** The tree is found by `ps` parent links plus the
  process group at kill time, and frozen (SIGSTOP, waiting until `ps` shows every
  member stopped) before it is signalled, so nothing can fork between the snapshot
  and the kill. A descendant that daemonizes (setsid + double fork) and is orphaned
  before the kill, or that outlives a CLI which exited normally, could survive.
  Verified with a detached grandchild (unit tests, also under 4x CPU oversubscription)
  and real sandboxed `node` children of both CLIs.
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
- **The API systems' file tools are policed by the loop, not the kernel**, like Claude
  Code's. A process the model left running could race their checks; the shell kills each
  command's process group when it returns, so only a process that daemonized itself
  (setsid) out of the group could. Preflight covers the known routes; new ones would need
  new probes.
- **What the API shell can read**: the system directories in the profile, the Node
  install and Homebrew's Cellar/opt, the metadata (not the contents) of the workspace's
  and those roots' ancestor directories, the root directory's listing. Python
  (`/usr/bin/python3`) needs the Xcode command-line tools, which are not readable, so it
  does not run there; Node does.
- **API sessions keep every image they viewed** in their history (no compaction, by
  design), and each request carries the whole history: the Claude API refuses requests
  over 32 MB, so a session that views very many large images ends `generation_failed`
  (`request_too_large`). Evidence images are at most about 3 MB.
- **Rate-limit waits in the loop** (at most 8 minutes per request) and slow responses
  lengthen an API session's wall time; its wall clock is a 2× safety cap, not a budget.
- **No cost for the API systems**: no price list is frozen with a batch; `usage` is
  exact and `cost_usd` is null.
- **grok's file tools are policed by Grok, not the kernel**, like Claude Code's: they
  run in the unsandboxed CLI and are confined by its deny rules. Preflight exercises the
  known routes (absolute paths, `..`, file and directory symlinks, dangling symlinks,
  grep and listings through links); the shell cannot create links, so none can be swapped
  in between Grok's check and its open. A detached process the contestant starts outlives
  its command and even the session (live; it stays inside the profile), as for the other
  shells. The rules are frozen per workspace path and depend on Grok matching globs as it
  did in 1.0.46; a CLI update changes the frozen binary hash and stops the batch.
- **grok's shell-level path checks also deny commands** that name a path outside the
  allowed roots (`ls ~`, `cat ../prompt.txt`), with "Denied by permission policy"; the
  profile would refuse them anyway. Grok refuses `&` (background execution is off).
- **grok leaves its sessions behind.** Every Grok session writes
  `~/.grok/sessions/<URI-encoded cwd>/` (`prompt_history.jsonl` and a directory per
  session with `chat_history.jsonl`, `events.jsonl`, `updates.jsonl`, `system_prompt.txt`,
  `tool_definitions.json`, `prompt_context.json`, `usage.json`, `summary.json`,
  `terminal/` with every shell command's output, about 250 KB for a probe session) and
  updates `~/.grok/sessions/session_search.sqlite` and `active_sessions.json`. Grok has no
  ephemeral mode; the runner deletes nothing under `~/.grok`. The contestant cannot read
  any of it.
- **grok's own context.** Besides the prompt the model gets Grok's system prompt, a rule
  built into the binary that Grok presents as a user rule, and a reminder naming a
  compiled-in workflow whose tool is disallowed (see *grok*). They are the product's, the
  same for every grok attempt, and not the user's.
- **grok reads `~/.grok`**: its login and configuration, as any CLI reads its own; what
  it would load from there (hooks, plugins, MCP servers) is checked at `prepare` and in
  preflight. Preflight also reads the probe session's `prompt_context.json` there (no
  credentials). The `~/.grok` targets are probed for every system.
- **The API systems were not run against the real services** (no keys were available
  while they were built): the request shapes follow the documentation and the mocks
  enforce it, but undocumented behaviour of the real APIs has not been seen.
