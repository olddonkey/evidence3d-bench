# Evidence3D v1 — round 3 results

State on 2026-10-21. Everything here is scored by scorer 1.1.0 on the private
sets; nothing in the scorer or generator was changed after the first test
results (`docs/V1-TEST.md`). The runner changed four times for toolchain drift
(§8); none of those changes touches prompts, budgets or scoring.

What this round added, in order: the single-photo and photos-plus-drawings
variants (`t1`, `t3`) on the test set, so the evidence ladder is complete;
memory tasks (`m2`, `m3`); a real-building tier (`r2`, `r4`), two objects; a
blind human-agreement study kit (14 of 110 ratings so far); a uniform API
harness (mock-tested only); a Grok Build system; a re-test of Opus nine days
apart; and the same models at their top reasoning effort, which turned out to
matter as much as the gaps between models.

Added on 2026-11-10, after the round: Claude Code / claude-fable-5-2 / max on
the same test set (§10); nothing in §1–§9 was changed for it.

Reports: `.local/v1/reports/test-final` (test set, every batch),
`mr-final` (memory and real), and the per-pass reports named in the text
(`summary.md` and `index.html` in each). Decisions taken before the data they
could bias: `.local/v1/scratch/orchestrator/round3/DECISIONS.md`.

Every configuration is `client / model / effort`. The effort is the reasoning
level passed to the client; `high` is each client's default and is not the
same amount of thinking across vendors (Codex: low … max, ultra; Claude Code:
low … max; Grok: low … xhigh). Haiku ran with no effort flag.

## 1. Test set

Set `test-2026-10`: 24 objects, 5 variants. Headline = (shape + detail) / 2,
mean over objects, 95 % bootstrap interval over objects. Two headlines are
shown because not every configuration ran every variant: the three-variant
mean (t2/t4/c1, which every configuration ran) and the five-variant mean
(adds t1 and t3, the hardest and the easiest). Attempts per task: 3 on
t2/t4/c1 for every configuration above Luna, 1 for Luna, Haiku, gpt-6-sol and
the normal-mode Grok models; 1 on t1/t3 for everyone who ran them.

| # | Configuration | 3-variant | 5-variant | t1 one photo | t2 photos + aerial | t3 + drawings | t4 + notes | c1 stale drawings | Shape | Detail |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Codex / gpt-6-astra / **max** | **79.2** [77.5, 80.9] | — | — | 69.5 | — | 85.4 | 82.7 | 91.4 | 67.0 |
| 2 | Codex / gpt-6.1-sol / **max** | **77.2** [75.6, 78.8] | — | — | 69.0 | — | 82.9 | 79.6 | 90.9 | 63.4 |
| 3 | Codex / gpt-6-astra / high | **73.4** | 71.0 [69.2, 72.6] | 52.3 | 59.5 | 82.3 | 82.1 | 78.8 | 86.9 | 54.9 |
| 4 | Codex / gpt-6.1-sol / high | **72.4** [71.2, 73.7] | — | — | 61.1 | — | 81.4 | 74.8 | 87.5 | 57.4 |
| 5 | Claude Code / claude-opus-5-5 / **max** | **71.5** [69.4, 73.7] | — | — | 57.2 | — | 83.1 | 74.3 | 86.0 | 57.1 |
| 6 | Claude Code / claude-opus-5-5 / high | **66.5** | 65.0 [62.9, 66.9] | 46.7 | 51.1 | 78.5 | 78.7 | 69.9 | 81.4 | 48.4 |
| 7 | Codex / gpt-6-sol / high | **53.3** [50.4, 56.3] | — | — | 37.3 | — | 67.0 | 55.4 | 70.0 | 36.5 |
| 8 | Grok Build / grok-4.7-build-fast / high | **53.1** | 52.1 [49.5, 54.6] | 34.2 | 36.8 | 67.3 | 67.4 | 55.0 | 70.3 | 34.1 |
| 9 | Grok Build / grok-4.6 / high | **50.6** | 49.9 [46.7, 52.9] | 36.3 | 36.1 | 61.4 | 63.0 | 52.5 | 68.2 | 31.6 |
| 10 | Grok Build / grok-4.7 / high | **49.6** [44.6, 54.5] | 47.7 [43.5, 51.8] | 31.7 | 36.7 | 58.0 | 60.0 | 52.2 | 64.7 | 30.6 |
| 11 | Codex / gpt-5.6-luna / high | **40.1** | 39.2 [35.8, 42.5] | 31.2 | 31.2 | 44.5 | 48.6 | 40.5 | 57.4 | 20.9 |
| 12 | Claude Code / claude-haiku-4-5 | **24.0** | 23.8 [20.7, 26.9] | 23.1 | 22.8 | 23.8 | 29.2 | 20.0 | 35.5 | 12.0 |

Claude Code / claude-fable-5-2 / max, run after the round, would sit between
rows 1 and 2 (78.9 [76.9, 81.0]); it is in §10.

The first-pass intervals of rows 3 and 6 are in `docs/V1-TEST.md`
(73.4 [72.0, 74.8] and 66.5 [64.3, 68.8]). Shape and detail are over the
variants each configuration ran.

Corrected on 2026-10-28: four three-variant values had been worked out from
the rounded variant columns; they are now the report's (rows 3, 6, 7 and 9:
73.5 → 73.4, 66.6 → 66.5, 53.2 → 53.3, 50.5 → 50.6, also in §5 and §6). The
Opus high − grok-4.7 fast row below had been copied from an interim report
(`test-grok`, 2026-10-12); it is now the final report's (`test-final`), and its
verdict is unchanged.

Pairwise, objects paired (bootstrap interval; "separated" = both intervals
exclude zero). The last column, added on 2026-10-28, is the same verdict after
Holm's correction over all 66 pairs of the 12 configurations (paired t
p-value, family-wise 5 %, rule in `v1/lib/report/README.md`); the adjusted p
is given where the verdict changes:

| A | B | A − B | Won / lost | Verdict | Holm, 66 pairs |
|---|---|---|---|---|---|
| Astra max | gpt-6.1-sol max | +2.0 [+0.7, +3.4] | 16 / 8 | separated, barely | not separated (0.088); separated on the top ladder (0.010) |
| Astra max | Astra high | +5.7 [+4.2, +7.1] | 23 / 1 | separated | separated |
| gpt-6.1-sol max | gpt-6.1-sol high | +4.7 [+3.2, +5.9] | 23 / 1 | separated | separated |
| gpt-6.1-sol max | Opus max | +5.6 [+3.7, +7.5] | 20 / 4 | separated | separated |
| Astra high | gpt-6.1-sol high | +1.0 [−0.2, +2.2] | 17 / 7 | not separated | not separated |
| gpt-6.1-sol high | Opus max | +0.9 [−0.7, +2.5] | 15 / 9 | not separated | not separated |
| Astra high | Opus max | +1.9 [+0.2, +3.6] | 14 / 10 | separated, barely | not separated (0.303) |
| Opus max | Opus high | +5.0 [+3.8, +6.2] | 23 / 1 | separated | separated |
| Astra high | Opus high | +6.0 [+4.6, +7.4] | 24 / 0 | separated | separated |
| Opus high | gpt-6-sol high | +13.3 [+10.6, +16.2] | 24 / 0 | separated | separated |
| Opus high | grok-4.7 fast high | +12.8 [+10.4, +15.4] | 23 / 1 | separated | separated |
| grok-4.7 fast | grok-4.6 | +2.3 [+0.5, +4.2] | 16 / 8 | separated, barely | not separated (0.243) |
| grok-4.7 fast | grok-4.7 | +4.4 [+1.7, +7.5] | 14 / 10 | separated | not separated (0.081) |
| grok-4.6 | grok-4.7 | +2.2 [−1.1, +5.9] | 10 / 14 | not separated | not separated |
| grok-4.7 | Luna high | +8.5 [+4.4, +12.3] | 20 / 4 | separated | separated |
| Opus high | Luna high | +25.8 [+22.5, +29.2] | 24 / 0 | separated | separated |
| Luna high | Haiku | +15.4 [+13.1, +17.9] | 24 / 0 | separated | separated |

Of the 66 pairs, 61 are separated uncorrected and 56 after Holm. The five
that drop out are the three rows marked "barely" above, grok-4.7 fast vs
grok-4.7 (+4.4, adjusted 0.081), and gpt-6-sol high vs grok-4.6 high (+2.7,
adjusted 0.303), which the table does not list. On the ladders of §5,
corrected over each ladder's own pairs: the default ladder (9
configurations, 36 pairs) keeps 29 of 32 separations, losing gpt-6-sol vs
grok-4.6 and grok-4.7 fast vs grok-4.6 and vs grok-4.7; the top ladder (3
pairs) and the effort pairs (3) keep all of theirs. The re-report uses
`v1/rounds/round3.roster.json`, written after the data (not a
pre-registered decision), and changes no uncorrected number.

Noise: between attempts on one task SD 4.6–5.1 for the three-attempt
configurations; between objects SD 3.7–5.7; the paired per-object difference
between two strong configurations SD 3.5–4.4, so a true difference of about
2–2.5 points is detectable with 80 % power on these 24 objects, and the
differences inside the top five are at that limit.

What the evidence buys (Astra high / Opus high, paired by object): the
scaled drawings +22.8 / +27.4; the second photo set and aerial +7.2 / +4.4;
the survey notes on top of drawings −0.2 / +0.2 (nothing); stale drawings
−3.5 / −8.6 against current ones. Luna still gains +4.1 from the notes;
Haiku gains little from anything. Effort buys most where the evidence is
thinnest: on t2 (photos only) Astra goes 59.5 → 69.5 and gpt-6.1-sol
61.1 → 69.0 between high and max; on t4 the gains are 3 and 1.5.

Conflict tasks (share of contested probes closer to the photographed state):
Astra max 95 %, gpt-6.1-sol max 93 %, Astra high 93 %, gpt-6.1-sol high 84 %,
Opus max 83 %, Opus high 77 %, grok-4.6 44 %, gpt-6-sol 38 %, grok-4.7 38 %,
grok-4.7 fast 36 %, Luna 33 %, Haiku 17 %. Frame offset 1.7–2.3 % of the
diagonal for the top six, 12 % for Haiku; metric scale error 0.2–0.6 % for the
top six, 7.7 % for Haiku.

## 2. Memory tasks

Set `memory-2026-10`: four named landmarks (triumphal arch, clock tower,
memorial with colonnade, obelisk), each a seeded twin of the real building
with proportions changed; `m2` = photographs + aerial, `m3` = + scaled
drawings. Astra and Opus 3 attempts; Luna, Haiku, grok-4.6 and grok-4.7 1;
grok-4.7 fast ran 16 of its 36 attempts (partial, not continued: §4).

| Configuration | Score | m2 | m3 | contested probes closer to the evidence than to the published building |
|---|---|---|---|---|
| Astra high | **88.1** [85.2, 91.0] | 81.7 | 94.5 | 96 % |
| Opus high | **76.5** [73.9, 79.1] | 60.3 | 92.7 | 82 % |
| grok-4.7 high | **71.8** [69.7, 74.1] | 51.5 | 92.0 | 79 % |
| grok-4.7 fast high (partial) | 68.7 | 51.6 | 85.8 | 72 % |
| grok-4.6 high | **65.0** [60.7, 69.2] | 49.6 | 80.3 | 64 % |
| Luna high | **52.9** [42.8, 65.1] | 43.3 | 62.4 | 49 % |
| Haiku | **36.1** [27.0, 46.9] | 35.6 | 36.6 | 8 % |

Astra − Opus +11.6 [+6.9, +15.3], 4/4 objects; the gap is almost entirely in
`m2` (21 points) and closes to 2 once drawings are given. Opus − grok-4.7
+4.8 [+3.7, +6.1], 4/4. Haiku built the remembered building 92 % of the time.
grok-4.7 is the best Grok configuration here and the weakest on the test set;
its lead over grok-4.6 (+6.8, 3 of 4 objects) is unsettled. Four objects
only, one attempt for the Grok models.

## 3. Real buildings

Set `real-2026-10`: a fast-food restaurant (truth from its planning
application, photographs from one side) and a 1919 library's historic wing
(truth from the 16 sheets of a 1995 measured survey, photographs of the front
and a current aerial). `r2` = photographs (+ aerial), `r4` = + survey notes.

| Configuration | Score (2 objects) | restaurant | library |
|---|---|---|---|
| Astra high | 50.9 | 70.3 | 31.5 |
| Opus high | 47.7 | 64.3 | 31.1 |
| grok-4.6 high | 42.7 | 61.7 | 23.8 |
| grok-4.7 high | 39.5 | 51.4 | 27.7 |
| Luna high | 30.4 | 40.9 | 20.0 |
| Haiku | 27.0 | 41.8 | 12.1 |

Same order as the synthetic set; with two objects no pair is settled. A third
candidate (a house with planning drawings) was dropped because no sheet of
its application draws the face the street photographs show
(`.local/v1/real-sources/kingsfold-8/NOTES.md`). grok-4.6 and grok-4.7 ran
one attempt per task; the fast model was not run on this tier.

## 4. Grok Build

Grok runs under the same prompt, wall-clock budget and a boundary that passes
the unchanged isolation preflight (`v1/lib/runner/README.md`, `### grok`).
The owner asked for the fast model; only grok-4.7 has one
(`grok-4.7-build-fast`, "2× the price"). The account's usage balance ran out
twice (2026-10-06 and 2026-10-12). After it returned, grok-4.6 and grok-4.7
were completed on 2026-10-19/20 in new batches of the same configurations
(node 26.12, Grok CLI 1.0.60; the report flags the difference), so both have
one attempt on every test, memory and real task. At the owner's decision the
fast model was not continued: three attempts on t2/t4/c1 except two of the
144 extra attempts, t1/t3 complete, 16 of its 36 memory-and-real attempts
(all memory, no real building). One stop on 2026-10-20: right after a sleep on battery every new
grok-4.7 attempt failed with "unknown model id"; a fresh preflight with the
same id passed and the same batches continued (DECISIONS.md).

All three Grok configurations sit between Opus high and Luna on every tier.
On the test set the fast model is ahead of both normal models (+2.3
[+0.5, +4.2] over grok-4.6, +4.4 [+1.7, +7.5] over grok-4.7); grok-4.6 and
grok-4.7 are not separated. The 30-minute limit explains much of the order: a
timed-out attempt is scored on what it had written, and the share of test
attempts that hit the limit is 41 % for grok-4.7, 20 % for grok-4.6 and 11 %
for the fast model. On memory the order flips (grok-4.7 71.8, fast 68.7
partial, grok-4.6 65.0), on four objects and one attempt.

| Grok configuration | test attempts | at the time limit | median wall | median cost (Grok's accounting) |
|---|---|---|---|---|
| grok-4.6 / high | 120 | 20 % | 1587 s | $0.89 |
| grok-4.7 / high | 122 | 41 % | 1743 s | $1.12 |
| grok-4.7-build-fast / high | 262 | 11 % | 1300 s | $2.35 |

The completion on 2026-10-19/20 cost $77.7 as Grok accounts it (99 scored
attempts).

## 5. Effort: the same model at high and at max

| Model | high | max | max − high | won / lost |
|---|---|---|---|---|
| Codex / gpt-6-astra | 73.4 | 79.2 | +5.7 [+4.2, +7.1] | 23 / 1 |
| Codex / gpt-6.1-sol | 72.4 | 77.2 | +4.7 [+3.2, +5.9] | 23 / 1 |
| Claude Code / claude-opus-5-5 | 66.5 | 71.5 | +5.0 [+3.8, +6.2] | 23 / 1 |

Five points for every model, almost every object, and the gain is largest on
the photos-only variant. Five points is also the size of the gap between
Astra high and Opus high, so a ladder that mixes effort levels is not a model
ladder. Two ladders are therefore reported: at each client's default (`high`),
Astra > gpt-6.1-sol ≈ Opus max > Opus; at the top level each client was asked
for, Astra max > gpt-6.1-sol max > Opus max, with the first gap barely
separated and the second clear. After Holm's correction (2026-10-28) the
first gap stays separated on the top ladder (3 pairs, adjusted p 0.010) but
not among all 66 pairs (0.088): it holds as a ladder claim, not as one of the
whole table's. Codex's `ultra` level and Grok's `xhigh` were
not run.

## 6. gpt-6.1-sol and gpt-6-sol

gpt-6.1-sol at high is statistically tied with Astra high (−1.0, 7 won / 17
lost but the interval crosses zero) and ahead of Opus high by 5.9; it is the
best configuration on photos only (t2 61.1) and the weakest of the top four on
stale drawings (c1 74.8). gpt-6-sol at high scores 53.3, with the Grok models:
13 points behind Opus high on every object, 38 % on conflict probes. Both ran
on codex-cli 0.162.1, Astra and Luna on 0.159.2 (the report flags the
difference; §7 shows it does not matter for Opus and nothing suggests it
matters for Codex).

## 7. Opus re-test

The owner suspected the model behind the API had changed. Opus high was run
again on the 72 main tasks nine days after the first run (CLI 2.1.296 instead
of 2.1.285, one attempt against the original three): paired difference
new − old = −0.59 points, bootstrap 95 % over objects [−1.87, +0.66], 10 of 24
objects higher; by variant t2 +1.8, t4 −1.3, c1 −2.3; shape −0.4, detail
−0.8; median wall 232 s against 249 s. Within the between-attempt noise: no
evidence of a change. (`reports/retest-opus`, script in DECISIONS.md.)

## 8. Toolchain drift and the runner changes

Between runs the machine's tools moved under the benchmark five times. The
first four times a frozen check failed closed, as designed, with no way to accept a
reviewed change. That was a design gap and is now handled by small, visible
allowlists rather than refusals:

- v1.2.2 `1a2dcf3`: Claude Code 2.1.288+ ships a built-in `plugin-authoring`
  plugin (a skill description, no tools); `CLAUDE_BUILTIN_PLUGINS` lists
  reviewed built-ins. The pinned CLI 2.1.285 had been auto-removed.
- v1.2.3 `da2655d`: Homebrew replaced node 26.10 with 26.11, which links
  `openssl@4`; the sandbox profile now allows every installed
  `etc/openssl@*`. Grok 1.0.50 dropped `memory_enabled` from its context file;
  the check now requires every memory flag present to be false. Frozen Grok
  batches on the old node can never resume; their remaining slots ran as new
  batches, which the report merges and flags.
- v1.2.4 `03b0250` and `8cc44c7`: codex-cli 0.162 offers three MCP-resource
  tools even with MCP off; the tool-list check accepts exactly those names.
- 2026-10-19: Homebrew moved node to 26.12 and the Grok CLI updated itself
  to 1.0.60. No runner change was needed; the frozen Grok batches again could
  not resume, and their remaining slots ran as new batches from `8cc44c7`.

The report flags every configuration whose batches differ in CLI version or
binary, runtime or runner; the Opus re-test (§7) is the measurement of what
such a difference costs: nothing detectable. Lesson recorded: after any gap,
expect to re-freeze.

## 9. Not done

- Human agreement: 14 of 110 blind ratings. The headline's agreement with a
  human judge is still unverified.
- Model-only comparison: the API harness is tested on mock servers only;
  every row above is model + client.
- Real buildings: two objects give an order, not intervals.
- Grok fast: 20 of its 36 memory-and-real attempts (all four real-building
  tasks among them) and two extra test attempts not run, by the owner's
  decision.
- Effort: Codex `ultra` and Grok `xhigh` not run.

## 10. Added after the round: Claude Code / claude-fable-5-2 / max

Run 2026-11-09/10 at the owner's request, on the same 72 main tasks (24 objects
× t2/t4/c1), prompt, 30-minute limit and scorer 1.1.0 as every row above; the
decision entry was written before the first attempt
(`.local/v1/scratch/orchestrator/round3/DECISIONS.md`). Report:
`.local/v1/reports/test-fable52` (the 29 batches of `test-final` plus
`t3-fable52max-2` and `t4-fable52max`, with `v1/rounds/round3.roster.json`, where
it is a top-ladder configuration).

| Configuration | 3-variant | t2 photos + aerial | t4 + notes | c1 stale drawings | Shape | Detail | Conflict | Attempts |
|---|---|---|---|---|---|---|---|---|
| Claude Code / claude-fable-5-2 / **max** | **78.9** [76.9, 81.0] | 65.7 | 90.2 | 80.9 | 91.3 | 66.6 | 92 % [82, 100] | 102 |

Top ladder with it (4 configurations, Holm over the ladder's 6 pairs):

| A | B | A − B | Won / lost | Uncorrected | Holm, 6 pairs |
|---|---|---|---|---|---|
| Astra max | Fable 5.2 max | +0.3 [−1.6, +2.1] | 13 / 11 | not separated | not separated (0.797) |
| Fable 5.2 max | gpt-6.1-sol max | +1.8 [−0.1, +3.7] | 17 / 7 | not separated | not separated (0.181) |
| Fable 5.2 max | Opus max | +7.4 [+5.8, +8.9] | 24 / 0 | separated | separated (< 0.001) |
| Astra max | gpt-6.1-sol max | +2.0 [+0.7, +3.4] | 16 / 8 | separated | separated (0.029; it was 0.010 among 3 pairs) |

So Fable 5.2 max is tied with both Astra max and gpt-6.1-sol max, which are
still separated from each other, and is clearly ahead of Opus max (every
object). It is ahead of every default-effort configuration: Astra high +5.5
[+3.8, +7.3] (21 / 3), gpt-6.1-sol high +6.5 [+4.7, +8.4] (22 / 2), Opus high
+12.4 [+10.3, +14.4] (24 / 0). It has the highest t4 of any configuration
(90.2; Astra max 85.4) and a lower t2 than the two Codex max rows (65.7 against
69.5 and 69.0). Among all 78 pairs of the 13 configurations, 71 are separated
uncorrected and 66 after Holm: Fable's 10 uncorrected separations all hold, and
the five pairs §1 lists as dropping out still drop out (Astra max vs gpt-6.1-sol
max now at adjusted 0.108 instead of 0.088).

How it differs from the other max rows, all flagged by the report or recorded
here:

- **Attempts.** One attempt on every task, plus two more on the three tasks of
  5 of the 24 objects (102 attempts; pass 1 alone: 78.3). The rule used for the
  other strong configurations (an interval overlapping Astra high's or Opus
  high's, or a mean within 10 points: two more attempts) asked for three; the
  extra attempts were stopped at 30 at the owner's request to run less, after
  the first 100 attempts had used up the subscription's weekly Fable
  allowance. Fewer attempts do not bias the mean; they make the intervals a
  little wider than with three. The remaining extra attempts were never scored and are not reported.
- **Toolchain.** Claude Code 2.1.321 (2.1.316 does not know the model id; Opus
  max ran on 2.1.296), node 26.13, on a Mac Studio (M5 Max, 18 cores) instead of
  the MacBook Air. The CLI's new built-in `cc-plugin-privacy` plugin needed a
  runner allowlist entry (PR #15; a shell-command hook, no tools). Runner and
  scorer source differ from the Round 3 batches (that change, and the scorer's
  `scorer_failed` change of #13), so the report shows a third scorer stamp
  (`17916972…`); scorer 1.1.0's numbers are unchanged.
- **Concurrency.** 3, then 6 for pass 1, with the extra attempts at 4 alongside.
  The 1-minute load averaged over each attempt had a median of 1.9 and a
  maximum of 2.4 on 18 cores (single readings up to 7.7); Opus max on the Air
  had a median of 3.4 on 10 cores. Median
  wall 984 s (Opus max 607 s, Astra max 1138 s), no attempt at the time limit,
  no integrity problems. Score over time (snapshots of `output/model.glb`): mean
  47.2 at 10 minutes and 77.8 at 15 (final 78.9); the median attempt reaches
  95 % of its final score at 10 minutes.
- **Served model.** Every one of the 6,210 assistant messages of the 102
  attempts reports `claude-fable-5-2`.
- **Infrastructure tries** (archived, never scored): 3 attempts cut short when
  the runner was restarted at higher concurrency, 8 that hit the weekly Fable
  limit and 6 cut short when the extra attempts were paused. The pass-1 ones
  were re-run from fresh workspaces.

Not run: t1, t3, memory and real tasks, and the same model at `high`.

## Files

- `docs/V1.md`, `docs/V1-PILOT.md`, `docs/V1-TEST.md` (first test results),
  this document.
- `v1/lib/generator/landmarks/`, `v1/real/mcd-homestead/`,
  `v1/real/green-library/`, `v1/lib/study/`, `v1/lib/runner/`.
- `.local/v1/scratch/orchestrator/round3/DECISIONS.md`.
