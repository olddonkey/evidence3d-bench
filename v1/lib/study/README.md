# Human-agreement study (blind paired comparison)

The headline score has to be checked against human judgement. This module
prepares a blind paired-comparison study: a rater sees the reference (the
hidden truth) and two submissions for the same task, says which one is closer
to the reference, and the analysis tells how often the score agrees with each
rater, at what score gap a human starts to see the difference, and how well
the raters agree with each other (so a disagreement with the score can be told
apart from one person's taste).

```sh
node v1/scripts/study.mjs prepare --name NAME --batches A,B,C --seed SEED [--pairs 100] [--repeat-share 0.1] [--data .local/v1] [--force]
node v1/scripts/study.mjs serve   --name NAME [--port 4173] [--data .local/v1] [--legacy-rater ID]
node v1/scripts/study.mjs add-catch --name NAME --objects ID,ID,... --seed SEED [--count 6] [--data .local/v1] [--legacy-rater ID]
node v1/scripts/study.mjs qualify --name NAME [--data .local/v1] [--legacy-rater ID] [--raters A,B,C]
node v1/scripts/study.mjs analyze --name NAME [--data .local/v1] [--legacy-rater ID] [--raters A,B,C] [--g1-seed SEED]
node v1/scripts/study.mjs export  --name NAME --out NEW_DIR [--data .local/v1]
```

`serve` prints the URL (`http://127.0.0.1:4173/`); open it in a Chromium-based
browser, give your name (once per browser), rate, stop the server with Ctrl-C,
run `analyze`. Rating can stop and resume at any time: the page asks the server
for your votes so far and shows the first pair you have not rated.

Everything of one study is in `<data>/study/<name>/` (git-ignored, like all
data derived from the hidden truth):

| file | who reads it | what |
|---|---|---|
| `pairs.json` | the page (public) | per pair: opaque id, task title, variant, image file names |
| `images/<pair>-<r\|a\|b>-<view>.png` | the page | reference, A, B per view |
| `key.json` | analysis only (private) | everything else: attempt directories, configurations, scores, gap, stratum, sides, repeats, catch pairs (`catch`), render facts |
| `votes.jsonl` | the server appends, the analysis reads | one line per vote, naming its rater |
| `votes-<rater>.jsonl` | the analysis (and the server, to resume) reads | the votes.jsonl a rater rated elsewhere and sent back |
| `analysis.md`, `analysis.json` | people | the agreement analysis |

`prepare` refuses to touch a study that has votes (in any of the votes files),
and a prepared study without `--force`.

## Several raters

Every rater rates the same pairs on their own, in their own copy of the study,
and is named by an id of lower-case letters and digits (1 to 32; `r0` is
reserved, see below) that the page asks for.

1. `export --name NAME --out NEW_DIR` copies what a rater needs, and nothing
   else, to `NEW_DIR/study/NAME/` (pairs.json and the images it names; no
   key.json, no votes, no analysis) with a `README.txt` in Chinese for the
   rater. `NEW_DIR` must be new, and outside the repository (or under
   `.local/`): the renders show the hidden truth.
2. The rater, with Node 22 and a checkout of this repository, runs
   `serve --name NAME --data NEW_DIR`, gives their id on the page, rates, and
   sends back `NEW_DIR/study/NAME/votes.jsonl`.
3. Save it in the study directory as `votes-<rater>.jsonl` (any id works as the
   file name: every line names its rater). `analyze` reads `votes.jsonl` and
   every `votes-<id>.jsonl`; other `votes*.jsonl` names are listed as not read.

Raters can also take turns on one machine: 更换 next to the name switches the
rater, and each sees only their own votes.

Votes recorded before raters had names (lines without `rater`) belong to `r0`
in `votes.jsonl`, and to `<id>` in `votes-<id>.jsonl`. If the ones in
`votes.jsonl` are yours, pass `--legacy-rater <your id>` to `serve` (the page
then resumes after them when you give that id) and to `analyze`; the file is
not rewritten. `serve` says so when it finds such votes.

## Round 4: catch pairs, qualification and gate G1

The Round 4 plan (`docs/V1-ROUND4-PLAN.md`, sections 5.1 and 5.2) uses this
study to decide whether scorer 1.1.0's 50/50 weighting of shape and detail
stays. In order:

1. `add-catch` (once, before the study is exported to any rater; the owner's
   study, already rated in part, included; with `--legacy-rater <the owner's
   id>` if the owner has voted under a name): six catch pairs. Write the
   objects, the seed and the groups it prints into the private record.
2. `export` for each outside rater; they rate and send back their votes.
3. `qualify` at the deadline: who qualifies, from the votes, the repeats and
   the catch pairs only. Replace who does not (plan section 5.1).
4. Once the panel is settled, `analyze --raters <the raters> --g1-seed <seed
   from the private record>`, once. The owner's votes recorded before raters
   had names need `--legacy-rater <the owner's id>`, or they count as `r0`,
   a separate rater who has not rated everything.

### Catch pairs (`catch.mjs`)

- A catch pair shows a development-set object (`v1/sets/dev.json`, generated
  from its public seeds): on one side its truth, on the other the truth without
  one group of category `massing` or `roof` (calibrate's `dropGroup` defect,
  `v1/lib/score/mutations.mjs`), drawn exactly like every other
  pair (cameras on the truth's bounds, the study's views, size and shading;
  the truth side is the same picture as the reference). The group must be plain
  to see: its absence changes at least 15 % of the truth's drawn pixels over
  the four views (a chimney changes about 2 %, a house's roof about 34 %).
  Their answer is fixed by construction, not by the scorer.
- `--objects` are used in turn, each giving one of its eligible groups (in a
  seeded order) until there are `--count` (6) pairs; with too few eligible
  groups it stops and says so. The truth is on side A in exactly half of them
  (the odd one by a coin). Title: the object's; variant: one of the study's,
  at random.
- Places: only after the last pair the owner has rated (so the pairs the
  owner rated and their order stay as they were); the remaining gaps are split
  into six runs with one catch pair at a random gap of each. Votes files are
  not touched. Every pair's `position` in key.json follows the new order.
- Voting stops while it runs: from reading the study to writing it,
  `add-catch` holds the study's lock, `voting.lock` in the study directory
  (created only if absent, with its process id). Everything else that touches
  the study takes the same lock: `prepare` for the whole of it, `serve` for
  each vote (check and save) and while it reads the study at start, `export`,
  `qualify` and `analyze` while they check and read it. So a vote is refused
  while `add-catch` or `prepare` holds it, none is half-saved when `add-catch`
  reads the votes, no reader sees the study half changed, and two `add-catch`
  runs (or one and `prepare --force`) cannot overlap. Votes and reads are
  waited for (up to 10 s); a step that changes the study is not. A lock left by a process
  that ended is never taken over: the command says so, and the file is
  deleted by hand. A `serve` started before `add-catch` refuses every vote
  afterwards (pairs.json changed), so it has to be restarted and the page
  reloaded. If a vote still came in while the pictures were drawn (written by
  something other than `serve`), `add-catch` stops without writing anything.
  A lock file that could not be written is removed again.
- key.json and pairs.json change together or not at all: both are written
  beside them first, key.json as it was is kept as
  `key.json.before-add-catch`, and if pairs.json cannot be put in place the
  old key.json goes back. Should even that fail (or the process stop between
  the two), the backup stays, and while it is there `serve` neither starts
  nor takes a vote and `export`, `qualify` and `analyze` refuse. Running
  `add-catch` again puts the study right first: the backup goes back to
  key.json when pairs.json is still the old one, and is dropped when key.json
  and pairs.json already list the same pairs (and then it stops with "already
  has catch pairs"). If the backup cannot be removed after both are in place,
  add-catch says so instead of reporting success. New images are written first;
  until pairs.json names them nothing shows them.
- key.json marks each with `catch: { correct, object, set, archetype, seed,
  group, category, changed_share }` and gets a `catch_pairs` block (time,
  seed, objects, generator version, threshold, `after_position`); pairs.json
  entries look like every other (id, title, variant, images). The command
  prints the objects and groups, never which pairs are catch pairs.
- Refused when the study already has catch pairs; when any rater other than
  the owner has voted, in a `votes-<id>.jsonl` (a copy went out without them)
  or in `votes.jsonl` (raters taking turns on this machine); and for an object
  that is not in the development set or already in the study.

### Qualification and the panel (`panel.mjs`)

- Originals are the pairs that are neither repeats nor catch pairs; only they
  count in any agreement, in G1 and in the human curve.
- A rater qualifies with every pair of the study rated, the same choice on at
  least 7 of 10 repeats (the same shares for another number; "cannot tell"
  both times is the same choice) and at least 5 of 6 catch pairs right
  ("cannot tell" is wrong). `qualify` prints these counts per rater and the
  resulting panel, and nothing that names a pair or a score.
- The panel's choice on a pair (section 5.1): among the qualified raters, the
  option with the most votes (A, B, cannot tell); a tie for the most is
  "cannot tell", so two raters decide only when they agree. Fewer than two
  qualified raters: no G1 (1.1.0 stays) and no human curve.
- Shared with the human curve: `TIE_GAP` (0.05 points), `scoreGap` (|a − b|
  without floating-point noise), `weightedScore` (a submission's headline under
  other weights, rounded to two decimals as the scorer does; shape alone where
  detail is not scored), `rescorePair`, and the bootstrap over objects.

### Gate G1 (`g1.mjs`, the G1 section of analysis.md)

- Candidates: shape / detail 50/50 (scorer 1.1.0), 65/35, 35/65, all from the
  shape and detail scores in key.json (50/50 must give back the stored score,
  else G1 refuses).
- Evaluation set, fixed for all candidates: the originals on which the
  panel's choice is A or B. Under weights w a pair scores 1 when the panel
  chose the side w ranks higher, 0 for the other side, ½ when w puts the two
  within 0.05 points; A(w) is the mean.
- A(w) − A(50/50) = Σ d_o / Σ n_o over objects, with a 95 % percentile
  bootstrap over objects (10 000 resamples, `--g1-seed`; every statistic on
  the same resamples). w replaces 50/50 (scorer 1.2.0) when the lower bound is
  above 0 and at least 10 objects have d_o ≠ 0; of two such candidates the
  larger difference, equal ones keep 1.1.0.
- Intervals follow the plan's section 4: no interval for a proportion
  observed at exactly 0 or 1, or when every resample gives the same value; an
  unavailable interval meets no threshold.
- The 70 % target on A(50/50): reached (lower bound ≥ 70 %), below (upper
  bound < 70 %) or not confirmed. With 1.2.0, analysis.json `g1.rescored`
  holds every original pair's scores, gap, higher side and stratum under the
  new weights (choices and votes unchanged); the new weights' agreement is
  marked as chosen after seeing the data.
- Also per panel rater (agreement with 1.1.0 on the pairs they decided) and
  per two panel raters (same choice, Cohen's κ), Fleiss' κ for three or more,
  with the same bootstrap.
- Without `--raters` (the panel as the private record lists it, after the
  deadlines and replacements) or without `--g1-seed`, or with fewer than two
  qualified raters, the section says why G1 was not computed; only the last
  case decides (1.1.0 stays). So does an empty evaluation set (the panel chose
  A or B on no original): 1.1.0 stays and the 70 % target is not confirmed.
- Resamples within 10⁻¹² of each other count as the same value (section 4: no
  interval); differences are computed from whole half points, so a difference
  that is the same on every resample is exactly the same number.

## Pair selection (`select.mjs`)

- Submissions: attempts read with the report module's `collectRuns`; counted
  (not an excluded status), `report.valid === true`, finite score, model file
  present. `t1` tasks are skipped: only the front is scored there, and the study
  shows all sides.
- A pair is two such submissions of one task: different configurations, or two
  attempts of one configuration.
- Strata of the headline gap |Δ|: [0, 3), [3, 8), [8, 15), [15, 100]. Equal
  targets per stratum (`--pairs` / 4). Strata take turns choosing, the one with
  the fewest eligible candidates first, so the cap below is not used up by a
  stratum that has plenty. Within a stratum the next pair is the eligible one
  that least repeats the stratum's variants, then its archetypes, then is
  cross-configuration, then comes from a task with fewer pairs so far, then
  shares no submission with a chosen pair; a seeded random order breaks ties.
- At most 2 pairs per task. A stratum that runs out of eligible pairs is
  reported as short (`shortfall` in key.json and in the `prepare` output); its
  share is not given to the others.
- Sides: within each stratum, exactly half of the pairs (the odd one by a coin)
  have the higher-scored submission on side A, at random. A rater's habit of
  preferring one side therefore cannot pass for agreement with the score; the
  analysis reports the habit separately.
- Repeats: `--repeat-share` (10 %) of the pairs are shown a second time with the
  sides swapped, taken from the strata in turn. Only key.json marks them.
- Presentation order: seeded shuffle, retried until every repeat is at least
  min(10, n/4) positions from its original.
- Ids are 8 random hex digits. pairs.json holds, per pair, `id`, `title` (the
  public task title), `variant` and `images`, nothing else: no score, batch,
  model, system, attempt, object or task id, and no order by gap. The test file
  scans pairs.json and the page source for such strings.

## Renders (`render.mjs`)

- Four perspective views (35° vertical field of view), azimuth from the front
  towards the viewer's right / elevation: front-left (−40°, 16°), front-right
  (40°, 16°), rear oblique from the left (215°, 18°), high oblique from the rear
  right (135°, 58°, the roof). Every facade and the roof is seen at least once.
- Cameras are derived from the truth's bounds only (its projected box fills
  90 % of the frame) and are identical for the reference and both submissions
  of a pair, and for every pair of an object. A submission that is too large or
  misplaced therefore shows as such, and may run off the frame; it never
  shrinks the reference.
- Submissions are placed in the truth frame with `report.alignment` (the
  scorer's searched pose: yaw, translation, and scale where the evidence has
  none), exactly as the results report draws them. The scorer may have
  measured the headline shape score at a refined pose
  (`alignment.shape_pose`); how far that pose is from the drawn one is kept in
  key.json (`shape_pose_moved_fraction`, a fraction of the truth diagonal).
- Shading is the report's flat shader (`v1/lib/render/shade.mjs`) in clay mode:
  one neutral colour for all three models, camera-relative light, edges and
  creases drawn, 2× supersampled, 560 × 420 PNG. Colour and materials are not
  shown at all.
- Each submission is parsed and drawn once (a repeat or a second pair reuses
  it); the truth once per object. key.json records per pair which views each
  model runs off the frame (`render.clipped`), where each aligned submission's
  box sits relative to the truth's (`render.placement`: centre offset as a
  fraction of the truth diagonal, ratio of diagonals), and `render.concerns`
  counts these over the distinct submissions. Timing is in `render.timing`.

## The page (`page/`) and the server (`server.mjs`)

- Text in Chinese. On the first visit the page asks 「请输入你的名字」 (letters and
  digits, kept in the browser's localStorage; asked on every visit where
  storage is unavailable); the name and 更换 (switch rater) are shown next to
  the progress. While the name form is open no key votes.
- Instruction: 「同一道题的参考模型和两份提交。哪一份的几何更接近参考？忽略颜色和材质。」
  Buttons A 更接近 / 分不出 / B 更接近 with keys ← ↓ → (and 1 0 2); 上一对 goes
  back to revise (a revision is a new line in votes.jsonl), 下一对 leaves a
  revisited pair unchanged. Progress 已评 n / N. Clicking an image enlarges it
  (up to 1.5× the render); in the enlarged view ↑ ↓ switch between A, 参考 and
  B of the same view and ← → between views, Esc closes; votes are not taken
  while it is open. A picture stays blank until it has loaded (the previous
  pair's pictures never show under a new pair), and a vote waits until all
  twelve are there; the next pair's pictures are preloaded.
- Layout: one column per view, rows A / 参考 / B, the whole pair on one screen
  (image width = the smaller of a quarter of the window width and what three
  rows leave of its height: about 280 px at 1400 × 820, about 318 px at
  1400 wide on a taller window). Why: the same view of the three models is
  stacked, so a comparison is one image height of eye movement; the reference
  is in the middle row so A
  and B are equally far from it (with the reference on top, A would be
  compared at a glance and B across a row, an advantage for A); and four
  columns keep every picture large enough to see openings without scrolling,
  where rows of A | reference | B per view would need four rows and a scroll
  for every pair.
- Plain DOM and ES modules, no external resources, no inline script or style
  (the server sends a `default-src 'self'` content security policy).
  `page/state.js` holds the logic without the DOM (keys, last vote per pair,
  where to resume, the 上一对 trail) and is tested directly.
- The server binds 127.0.0.1 only and answers only requests addressed to
  `127.0.0.1:<port>` or `localhost:<port>` (no DNS rebinding); POSTs from
  another origin are refused. It serves the page, `pairs.json`, and only the
  images that pairs.json names. `GET /votes?rater=<id>` returns
  `{ votes, malformed }` with only that rater's votes, from every votes file of
  the study; `POST /vote` takes `{ rater, pair, choice: a|b|tie, ms, hidden_ms }`
  and appends `{ rater, pair, choice, ms, hidden_ms, at }` to votes.jsonl
  (`rater`: the id given on the page, required; `ms`: from showing the pair to
  the vote; `hidden_ms`: the part of it the page was hidden, e.g. another tab;
  `at`: the server's ISO time). Appends are serialised.

## Votes (`votes.mjs`)

- Files: `votes.jsonl`, then `votes-<id>.jsonl` by name. A line without a rater
  is `r0`'s (or `--legacy-rater`'s) in votes.jsonl and `<id>`'s in
  votes-<id>.jsonl; a line with a rater that is not an id is malformed.
- The votes of all files in the order cast (the server's `at`, file and line
  order breaking ties); the same vote in two files counts once.

## Analysis (`analyze.mjs`)

Joins every votes file with key.json; writes analysis.md and analysis.json
(schema `e3d-study-analysis-v3`: `votes`, `raters[]`, `between_raters`,
`qualification`, `g1`; see "Round 4" above for the last two). With
`--raters a,b,c` only those raters are analysed. Catch pairs and repeats are
not originals: everything below is on originals.

Per rater (each rater on their own, as below), side by side in a table of
raters and a table of P(higher) per stratum with the majority next to them:

- The rater's last vote per pair counts. Malformed lines and votes for unknown
  pairs are counted and skipped; a rater whose votes are all for unknown pairs
  (another study's file, say) is listed but neither analysed nor compared.
- Agreement: among decided (non-tie) votes on original pairs, the share in which
  the rater chose the submission with the higher headline score, with a Wilson
  95 % interval; the same per stratum; the same for `shape_score` alone and
  `detail.score` alone. Repeats are left out (each pair counts once); a pair
  whose two values are equal on a measure has no higher side there and is
  counted as such.
- The curve: P(rater picks the higher-scored) per stratum of |Δ|, with pairs,
  rated, mean gap, ties and tie rate.
- Side habit: share of decided votes for A.
- Self-consistency on repeats: same choice after the side swap, opposite, both
  "cannot tell", one "cannot tell"; same / decided and exact agreement with
  Wilson intervals.
- The ten largest disagreements (the rater chose the lower-scored side, largest
  |Δ| first): pair id, Δ = score A − score B, both scores with their shape and
  detail halves, task, variant, attempt directories and image names.
- Median time per pair, with and without page-hidden time.

Between raters, on original pairs (every rater sees the same sides of a pair,
so the choices are compared as shown: A closer, cannot tell, B closer):

- Every two raters, on the pairs both rated: share of the same choice (Wilson),
  Cohen's κ = (observed − chance) / (1 − chance) with chance from each rater's
  own shares of the three choices, and the share of the same side among pairs
  both decided.
- Three raters or more: Fleiss' κ over all of them, on the pairs every one of
  them rated (observed: the mean share of agreeing rater pairs per pair;
  chance: the sum of the squared overall shares of the three choices).
- Majority vote: on pairs rated by two raters or more, the choice of more than
  half of those who rated it; a majority for 分不出 is a tie, no majority
  (e.g. A, B, 分不出) is counted and left out. Its agreement with the headline
  score, shape_score and detail.score, overall and per stratum, as for a rater.

Outside the G1 section, statistics are counts, proportions, Wilson intervals
and kappas, nothing else. Pairs share tasks and sometimes submissions, so they
are not fully independent; these intervals do not account for that, and the
kappas are point estimates. The G1 section's intervals do: they resample
objects.

## What could bias a rater

- The renders are the scorer's view of a submission: rotated, shifted and (on
  scale-free tasks) scaled by the stored alignment. A submission the alignment
  turned by 90° or more looks turned; that is the pose the scorer measured.
- Coplanar or overlapping faces in a submission draw as speckle or stray edge
  marks (the truth has none by construction). That is a property of the
  submission, but it may read as "worse" beyond geometry.
- Every model is drawn in one clay colour, so a submission whose parts are told
  apart only by colour looks flatter than it is.
- The rater judges everything visible from four views, the scorer only surfaces
  covered by the task's evidence; on t2/t4/c1 the evidence covers all sides, but
  not every surface.

## Tests

`node --test v1/test/study-g1.test.mjs`: tie gap and weighted scores, the
panel's majority, qualification thresholds, the intervals' edge cases and the
seeded bootstrap, G1 on hand-computed panels (a candidate that wins, one with
too few changed objects, a difference that is the same on every resample, the
70 % target reached, missed and not confirmed, an empty evaluation set through
the command line, no seed, panel not named, one qualified rater, unqualified
raters left out, legacy votes with `--legacy-rater`), and add-catch on a
prepared study (places after the last rated pair, votes untouched, renders,
nothing in pairs.json, refusals for other raters' votes in either file, the
voting lock, a vote being saved as it starts, a vote that arrives while it
draws, two runs at once, a failed write of either document and every reader
refusing until add-catch puts the study right, readers, prepare and add-catch
never overlapping, the repair of an unfinished add-catch from every point it
can stop at, seeded).

`node --test v1/test/study.test.mjs`: stratification, the per-task cap, t1
skipped, cross-configuration preference, shortfall reporting, repeats
side-swapped and spaced, half the pairs higher on A, seeded and
order-independent selection, pairs.json and the page source free of scores,
batches, models and private files, renders non-blank with one camera set per
object (a part-model draws only on the reference's silhouette), the server
(127.0.0.1, routes, key.json unreachable, votes appended with their rater and
resumed per rater, legacy votes, bad votes and raters, cross-origin and
foreign Host refused, each vote saved under the study lock, none while
add-catch holds it or once pairs.json changed under it), the study lock (one
of many callers gets it, waits only for a vote being saved or a read, never
taken from anyone, given back only by its holder, removed when it cannot be
written),
the page logic and rater ids, merging the votes files,
the export, and the analysis on hand-computed examples (Wilson intervals, last
vote wins, strata, ties, self-consistency, disagreements; Cohen's and Fleiss'
κ on textbook values; three raters: κ per two raters, Fleiss' κ, majority vote).
