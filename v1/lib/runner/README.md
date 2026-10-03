# Generation runner (module E)

Runs a model-under-test on task packs inside an isolated workspace, records what
happened, and scores what it left behind. Two harnesses: `codex` (Codex CLI) and
`claude-code` (Claude Code CLI). Checked against codex-cli 0.159.2 and Claude Code
2.1.285 on macOS (Darwin 27); both boundaries are Seatbelt-based and macOS-only.

```sh
node v1/scripts/run.mjs prepare   --id <batch> --system codex|claude-code --model <id> [--effort <level>] --tasks a,b,c [--attempts 1] [--data <root>] [--binary <cli>]
node v1/scripts/run.mjs preflight --batch <dir> [--probe-model <id>] [--probe-effort <level>] [--no-wait]
node v1/scripts/run.mjs run       --batch <dir> [--concurrency 1] [--no-wait] [--resume-now] [--max-reruns 5] [--retry-stall-minutes 10]
node v1/scripts/run.mjs status    --batch <dir>[,<dir>...] [--json]   # what each batch is doing, and if waiting, why and until when
node v1/scripts/run.mjs summary   --batch <dir> [--json]              # --json: the whole summary.json
```

Exit codes of `run` and `preflight`: 0 done (nothing left that may run), 1 error, 3 stopped
for a human (login, billing, model id, a changed scorer/runner/CLI), 75 would have had to
wait (`--no-wait`; run again after the time printed; also a preflight that gave up after
6 probe sessions ended by infrastructure errors), 130 stopped by a signal. `run` and
`preflight` are stopped with Ctrl-C (or SIGTERM/SIGHUP) and continued with the same command.

The same from code: `prepare`, `preflight`, `execute`, `summarize` in
`v1/lib/runner/index.mjs` (also exported as `preparePilot`, `preflightPilot`,
`executePilot`). Default data root `.local/v1`; default CLIs
`~/.local/bin/codex.opencodex-real` (not the `codex` shim) and `~/.local/bin/claude`,
overridable with `--binary` or `E3D_CODEX_BIN` / `E3D_CLAUDE_BIN`.

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
   from `task.budget.wall_seconds` (SIGTERM to the whole process tree, SIGKILL 5 s
   later), events and stderr logged byte for byte, then integrity checks, then
   the infrastructure-error check (below), then scoring in a separate process
   (module D's `scoreSubmission`) after the contestant's process tree is gone.
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
    prompt.txt  invocation.json  harness/ (claude settings, debug log)
    rerun.json                      on a re-run: which try this is, and every earlier try
    started.json  child.json  process.json  events.jsonl  stderr.log  result.json
    score/ submission.glb  report.json  error-*.png  worker logs  worker.json
    score.interrupted-<k>/          a scoring cut short by a stopped runner, kept aside
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
CLI process), `result_at` (the record was written), `wall_limit_seconds`, and
`load_1m: { start, end, mean, max, samples, cpus }`, the machine's 1-minute load
average sampled every 30 s while the CLI ran. `process.json` keeps `event_ms`, the
arrival time of every event, which the timeout rule below uses.
`service_retry_seconds` is the time the CLI spent in retry streaks it recovered from (a
diagnostic: such a session is still a sample).

- `input_tokens` counts all prompt tokens including cached ones for both harnesses
  (Claude's cache reads and cache writes are added in; the raw split is in
  `usage_detail`). `output_tokens` includes reasoning tokens.
- `cost_usd`: Codex reports none (null). Claude reports `total_cost_usd`, which on a
  claude.ai subscription login is the CLI's list-price estimate, not a charge.
- `turns`: Codex's completed turns (1 for one `exec` prompt); Claude's `num_turns`
  (model round trips). Not comparable across harnesses. `commands`: shell
  commands run (Codex `command_execution` items, Claude `Bash` calls).
- The artifact is read by the runner outside the sandbox, so it must be a regular
  file with one link inside `output/`. A symlink or hard link to the hidden truth
  would otherwise be scored as the submission.

### Statuses

First match wins. The score is computed independently of the status, from whatever
valid `output/model.glb` exists, so a timed-out run can carry a score.

| Status | When | Score | A sample? |
| --- | --- | --- | --- |
| `infra_error` | the harness could not run the model (next section); never given when the workspace boundary was broken | `null`, not scored | no: left out of every mean; archived and re-run automatically until a sample exists or the re-run cap is reached |
| `timeout` | the wall clock expired; the tree was killed | from the artifact left behind | yes |
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
| `usage_limit` | wait | the subscription's usage limit (Codex "You've hit your usage limit…", Claude "You've hit your session/weekly limit…") |
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
against the patterns in `infra.mjs`. Model turns are Codex `item.*` (not `error`)
and `turn.completed`; Claude non-synthetic `assistant`, `user`, `tool_progress` and
`system/thinking_tokens`.

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

A real usage limit was not provoked. Patterns marked inferred are the CLI's own text,
not guesses, but their exact wording on the real service has not been seen. Claude Code
waits out 429/529 by itself only with `CLAUDE_CODE_RETRY_WATCHDOG`, which the runner
never sets (inferred from the retry code); without it a 429 whose `retry-after`
exceeds 60 s failed at once and one with `retry-after: 30` was retried (live).

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
`runner_interrupted` (an operator stopping the runner must not use up the cap). Every try
is archived and listed whatever its reason.

**Waiting.** An attempt that meets a limit or a failing service puts the batch on hold:
no new attempt is launched (one that was being prepared when the hold began goes back to
the queue unlaunched), attempts already running finish on their own (if they meet the
same limit they are `infra_error` too and join the hold without lengthening it), and
launching resumes when the hold ends:

| kind | reasons | hold |
| --- | --- | --- |
| limit | `usage_limit`, `rate_limit` | until the stated `retry_after`, plus 30-150 s; at least 1 min; a reset that did not hold the last time is not trusted alone. With no stated time: 2, 4, 8, 16, 30, 30, ... min, plus 30-150 s |
| retry | `overloaded`, `server_error`, `network`, `cli_crash`, `cli_stalled` | 1, 2, 4, 8, 16, 30, 30, ... min, plus up to 25 % |

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
| `view_image`, `apply_patch` confined | Codex runs both through its "fs sandbox helper", which re-executes the codex binary under the same Seatbelt profile. It must be launched by its resolved path and its release directory must be readable, otherwise every image view and patch fails | `agent:view-*`, `agent:patch-*` (outside file, symlink, dangling symlink, symlinked directory); see *Image views in code mode* |
| Code mode | `functions.exec` runs model-written JS in a V8 isolate outside Seatbelt that, per its tool description, has no Node, fs, network or console, and reaches the world only through the nested tools above | `agent:code-mode-isolate` (model-reported `typeof require/process/fetch/...` and failed `node:` imports) |
| No user config, rules, project docs, skills, memories, plugins, apps, hooks | `--ignore-user-config` (config.toml, including its `shell_environment_policy.set`, which on this machine exports an API key), `--ignore-rules`, `project_doc_max_bytes=0`, `skills.include_instructions=false`, feature flags | checked offline with `codex debug prompt-input`. The model-visible input is the permission text, the collaboration-mode text and the environment context, nothing else |
| No global AGENTS.md | No setting stops `$CODEX_HOME/AGENTS.override.md` / `AGENTS.md` from being injected. `prepare` refuses, and `preflight`/`run` stop, while either is non-blank | `codexGlobalInstructions`; unit test |
| No sub-agents, web, browser, MCP | `agents.enabled=false` removes the `multi_agent_v1__*` tools that `features.multi_agent=false` alone leaves in place; others by feature flag | `agent:tool-list` (model-reported); every run's events are scanned for non-allowed item types |
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
check is never retried.

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
