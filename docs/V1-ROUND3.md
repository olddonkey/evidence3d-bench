# Evidence3D v1 — round 3 results (without Grok)

State on 2026-10-07. Everything in this document is scored by scorer 1.1.0 on
the private sets; nothing in the scorer, generator or runner was changed after
the first test results (`docs/V1-TEST.md`). The Grok Build configurations are
still running (their account's usage balance ran out on 2026-10-06; the batches
resume when it is restored) and are reported separately at the end as partial.

What this round added, in order: the single-photo and photos-plus-drawings
variants (`t1`, `t3`) on the test set, so the evidence ladder is complete;
memory tasks (`m2`, `m3`: named landmarks whose surveyed proportions differ
from their published figures); a real-building tier (`r2`, `r4`: real
photographs, truth authored from the building's own measured drawings), now
two objects; a blind human-agreement study kit (ratings not yet collected); a
uniform API harness (mock-tested only, no keys); and a Grok Build system.
Freezes: v1.2 = `bc8490d`, v1.2.1 = `61e22c3`, second real object `8795bbb`.

Reports: `.local/v1/reports/round3-test`, `round3-mr`, `round3-grok-partial`
(`summary.md` and `index.html` in each).

## 1. Test set, the full evidence ladder

Set `test-2026-10`: 24 objects × 5 variants = 120 tasks, 768 attempts
(Astra and Opus 3 attempts on t2/t4/c1 and 1 on t1/t3; Luna and Haiku 1 on
every task). Headline = (shape + detail) / 2, mean over objects, 95 % bootstrap
interval over objects.

| # | Configuration | Score | t1 one photo | t2 photos + aerial | t3 + drawings | t4 + notes | c1 stale drawings | Shape | Detail |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Codex / gpt-6-astra / high | **71.0** [69.2, 72.6] | 52.3 | 59.5 | 82.3 | 82.1 | 78.8 | 86.9 | 54.9 |
| 2 | Claude Code / claude-opus-5-5 / high | **65.0** [62.9, 66.9] | 46.7 | 51.1 | 78.5 | 78.7 | 69.9 | 81.4 | 48.4 |
| 3 | Codex / gpt-5.6-luna / high | **39.2** [35.8, 42.5] | 31.2 | 31.2 | 44.5 | 48.6 | 40.5 | 57.4 | 20.9 |
| 4 | Claude Code / claude-haiku-4-5 | **23.8** [20.7, 26.9] | 23.1 | 22.8 | 23.8 | 29.2 | 20.0 | 35.5 | 12.0 |

All six pairs are separated (both intervals exclude zero, every object won):
Astra − Opus +6.0 [+4.6, +7.4] (24/24 objects), Opus − Luna +25.8,
Luna − Haiku +15.4. The 5-variant headline differs from the 3-variant one in
`V1-TEST.md` (73.4 / 66.5 / 40.1 / 24.0) only because t1 and t3 are now in
the mean.

Noise. Between attempts on one task SD 4.7 (288 df); between objects SD 6.5;
paired per-object difference Astra − Opus SD 3.5, so a true difference of
2.1 points would be detected with 80 % power on these 24 objects, and attempt
noise is 42 % of that pair's variance (it was 19 % with t2/t4/c1 only: the
single-attempt t1/t3 tasks add noise).

What the evidence buys (paired by object, t-intervals exclude zero unless noted):

| Configuration | second photo set + aerial (t2 − t1) | scaled drawings (t3 − t2) | survey notes on top (t4 − t3) | stale drawings (c1 − t3) |
|---|---|---|---|---|
| Astra | +7.2 | **+22.8** | −0.2 (none) | −3.5 |
| Opus | +4.4 (not separated) | **+27.4** | +0.2 (none) | −8.6 |
| Luna | 0.0 (none) | +13.4 | +4.1 | −4.1 |
| Haiku | −0.3 (none) | +1.0 (none) | +5.4 (not separated) | −3.8 (not separated) |

The scaled drawings carry almost the whole gain for the two strong models;
the notes add nothing on top of them. Luna still gains from the notes
(reads numbers better than drawings); Haiku gains little from either.

By archetype (3 objects each): Astra 67.5–74.3, Opus 59.4–70.4 (lowest on
towers and civic), Luna 29.5–50.6, Haiku 14.7–34.8. Conflict tasks: the share
of contested probes closer to the photographed state is Astra 93 %, Opus 77 %,
Luna 33 %, Haiku 17 %. Frame offset 2.2 / 2.3 / 5.9 / 12.2 % of the diagonal;
metric scale error 0.3 / 0.6 / 2.0 / 7.7 %.

## 2. Memory tasks

Set `memory-2026-10`: four named landmarks (triumphal arch, clock tower,
memorial with colonnade, obelisk), each a seeded twin of the real building
with proportions changed; `m2` = photographs + aerial, `m3` = + scaled
drawings. Astra and Opus 3 attempts, Luna and Haiku 1.

| Configuration | Score | m2 | m3 | contested probes closer to the evidence than to the published building |
|---|---|---|---|---|
| Astra | **88.1** [85.2, 91.0] | 81.7 | 94.5 | 96 % |
| Opus | **76.5** [73.9, 79.1] | 60.3 | 92.7 | 82 % |
| Luna | **52.9** [42.8, 65.1] | 43.3 | 62.4 | 49 % |
| Haiku | **36.1** [27.0, 46.9] | 35.6 | 36.6 | 8 % |

Astra − Opus +11.6 [+6.9, +15.3], 4/4 objects, separated; the gap is almost
entirely in `m2` (21 points), and closes to 2 once drawings are given. Haiku
built the remembered building 92 % of the time. Four objects only; the
intervals are wide.

## 3. Real buildings

Set `real-2026-10`: a fast-food restaurant (truth from its planning
application, photographs from one side) and a 1919 library's historic wing
(truth from the 16 sheets of a 1995 measured survey, photographs of the front
and a current aerial). `r2` = photographs (+ aerial), `r4` = + survey notes.

| Configuration | Score (2 objects) | restaurant | library |
|---|---|---|---|
| Astra | 50.9 | 70.3 | 31.5 |
| Opus | 47.7 | 64.3 | 31.1 |
| Luna | 30.4 | 40.9 | 20.0 |
| Haiku | 27.0 | 41.8 | 12.1 |

Same order as the synthetic set; with two objects no pair is settled. The
library is much harder: only the front and roof are evidenced, the building
is large, symmetric and dense in detail. A third candidate (a house with
planning drawings) was dropped because no sheet of its application draws the
face the street photographs show (`.local/v1/real-sources/kingsfold-8/NOTES.md`).

## 4. Grok Build, partial

Grok runs under the same prompt, wall-clock budget and a boundary that passes
the unchanged isolation preflight (`v1/lib/runner/README.md`, `### grok`).
The owner asked for the fast model; only grok-4.7 has one
(`grok-4.7-build-fast`, "2× the price"). State when the balance ran out:
grok-4.7 normal 72/72 tasks (one pass, 30 of them at the 30-minute limit);
grok-4.6 69/72; grok-4.7 fast 62/72 first pass and 57/144 of its second and
third. Means below are over the objects each configuration has; the paired
columns use only objects both ran.

| Configuration | Score | objects | Astra − it | Opus − it | median wall | at limit | median cost (Grok's accounting) |
|---|---|---|---|---|---|---|---|
| grok-4.7-build-fast | 53.6 [50.1, 56.9] | 20 | +19.1 (20/20) | +12.5 (20/20) | 1105 s | 7 / 113 | $2.31 |
| grok-4.6 | 50.1 [45.9, 54.0] | 23 | +22.7 (23/23) | +15.5 (23/23) | 1600 s | 12 / 67 | $0.88 |
| grok-4.7 | 49.6 [44.6, 54.5] | 24 | +23.8 (24/24) | +16.9 (23/24) | 1757 s | 30 / 72 | $1.16 |

Both Grok models sit between Opus and Luna, well apart from both. Contested
probes closer to the photographed state: 38–48 %. The fast model shortens
attempts by about a third and halves the time-outs but, on the objects run so
far, scores about the same as normal mode; the paired comparison waits for the
complete pass. Still to run: the remaining first-pass tasks, the fast model's
two extra attempts, `t1`/`t3` and the memory and real tasks for grok-4.6 and
the fast model.

## 5. Not done

- Human agreement: the blind study (110 pairs, `v1/scripts/study.mjs`) has 6
  ratings. The headline's agreement with a human judge is still unverified.
- Model-only comparison: the API harness (`api-anthropic`, `api-openai`) is
  tested on mock servers only; without keys every row above is model + CLI.
- Real buildings: two objects give an order, not intervals.

## Files

- `docs/V1.md` (what v1 is), `docs/V1-PILOT.md`, `docs/V1-TEST.md` (first test
  results, 3 variants), this document.
- `v1/lib/generator/landmarks/`, `v1/real/mcd-homestead/`,
  `v1/real/green-library/` (truth authoring with PROVENANCE), `v1/lib/study/`,
  `v1/lib/runner/` (systems codex, claude-code, api-*, grok).
- Decisions taken before the data they could bias:
  `.local/v1/scratch/orchestrator/round3/DECISIONS.md`.
