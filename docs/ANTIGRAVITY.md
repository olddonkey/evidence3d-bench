# Running Evidence3D with Google Antigravity (`agy`) on another Mac

The runner has an `antigravity` system (Google Antigravity CLI, headless). It was
written from agy's documentation on a machine without agy, so **the first preflight
on the new machine is the real test of the adapter**: expect it to find something,
and do not run a batch before preflight passes. What the adapter assumes is listed in
[v1/lib/runner/README.md](../v1/lib/runner/README.md#antigravity).

## What the other machine needs

- macOS (the boundary is Seatbelt-based; the runner is macOS-only), plugged in, lid
  open: an attempt during which the machine slept is not a sample and is run again.
- Node.js 22.2 or later (the round-3 batches used 26.11/26.12), git.
- The Antigravity CLI and a Google account whose plan includes it:
  `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then `agy` once,
  interactively, to sign in. The runner never handles credentials.

## What to copy

1. **The repository.** It is private: `git clone git@github.com:olddonkey/evidence3d-bench.git`
   with an account that has access, or a bundle made here and copied with the data
   (`git bundle create e3d.bundle --all`, then `git clone e3d.bundle evidence3d-bench`
   there). Use branch `v1-hidden-truth` (or `main`, which is the same).
2. **The data root**, which is not in git and holds the hidden truth: from this Mac's
   `.local/v1`, the folders `sets`, `tasks`, `truth` and `objects` (about 1 GB; `runs`,
   `reports` and `scratch` are not needed).

   ```sh
   tar -C .local/v1 -czf e3d-data.tgz sets tasks truth objects
   ```

   Carry it by AirDrop, USB or an encrypted archive, never through GitHub or a shared
   cloud folder. On the other machine, unpack it into `<repo>/.local/v1/`.

## Setup there

```sh
cd evidence3d-bench
npm ci
node v1/cli.mjs verify                                   # the copied task packs are intact
node v1/scripts/run.mjs antigravity-settings             # what agy's settings must hold
node v1/scripts/run.mjs antigravity-settings --write     # merge it into ~/.gemini/antigravity-cli/settings.json
```

`antigravity-settings` refuses to call the configuration done while anything under
`~/.gemini` would join a session (global `AGENTS.md`/`GEMINI.md`, rules, hooks, MCP
servers, plugins, skills). Keep `useG1Credits` off: it is what stops paid credits from
being spent when the plan's quota runs out. Do not change the settings file while a
batch runs (the runner stops the batch if it does).

## Task lists

```sh
D=.local/v1
# the headline ladder: 24 objects x t2, t4, c1 (72 tasks); all five variants: 120
node -e 'console.log(require("./.local/v1/sets/test-2026-10.built.json").built.flatMap(o => o.tasks).filter(t => /-(t2|t4|c1)$/.test(t)).join(","))' > three.txt
node -e 'console.log(require("./.local/v1/sets/test-2026-10.built.json").built.flatMap(o => o.tasks).filter(t => /-(t1|t3)$/.test(t)).join(","))' > two.txt
node -e 'console.log(require("./.local/v1/sets/memory-2026-10.built.json").built.flatMap(o => o.tasks).join(","))' > memory.txt
echo real-0001-r2,real-0001-r4,real-0002-r2,real-0002-r4 > real.txt
```

## Running a configuration

Model ids are what `agy models` lists (they may be display names: quote them). Record
the effort level; every result table shows it.

```sh
node v1/scripts/run.mjs prepare --id ag1-<short-name> --system antigravity --model "<model>" --effort high \
  --attempts 1 --data $D --tasks $(cat three.txt)
node v1/scripts/run.mjs preflight --batch $D/runs/ag1-<short-name>
caffeinate -i node v1/scripts/run.mjs run --batch $D/runs/ag1-<short-name> --concurrency 2
node v1/scripts/run.mjs status --batch $D/runs/ag1-<short-name>
```

- **Preflight first, and stop if it fails.** Send back `$D/runs/<batch>/preflight.json`
  and the `preflight/` folder: they say which assumption was wrong. A fix changes the
  runner, so a failed batch is not continued; a new one is prepared after the fix.
- `run` waits out usage limits by itself and stops (exit 3) for a lost login, a
  model id agy does not know, or a changed binary or settings file. It can be
  stopped with Ctrl-C and started again with the same command.
- Time: each attempt has 30 minutes; at concurrency 2 the 72 headline tasks take
  roughly 15 hours.

## Bringing results back

Copy `$D/runs/<batch>` back into this Mac's `.local/v1/runs/` and build the report with
the other batches, or build it there with the same command:

```sh
node v1/cli.mjs report --batches <batch>[,<more>] --out .local/v1/reports/<name>
```
