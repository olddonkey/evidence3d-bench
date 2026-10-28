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
node v1/scripts/study.mjs analyze --name NAME [--data .local/v1] [--legacy-rater ID] [--raters A,B,C]
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
| `key.json` | analysis only (private) | everything else: attempt directories, configurations, scores, gap, stratum, sides, repeats, render facts |
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
(schema `e3d-study-analysis-v2`: `votes`, `raters[]`, `between_raters`). With
`--raters a,b,c` only those raters are analysed.

Per rater (each rater on their own, as below), side by side in a table of
raters and a table of P(higher) per stratum with the majority next to them:

- The rater's last vote per pair counts. Malformed lines and votes for unknown
  pairs are counted and skipped.
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

Statistics are counts, proportions, Wilson intervals and kappas, nothing else.
Pairs share tasks and sometimes submissions, so they are not fully independent;
the intervals do not account for that, and the kappas are point estimates.

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

`node --test v1/test/study.test.mjs`: stratification, the per-task cap, t1
skipped, cross-configuration preference, shortfall reporting, repeats
side-swapped and spaced, half the pairs higher on A, seeded and
order-independent selection, pairs.json and the page source free of scores,
batches, models and private files, renders non-blank with one camera set per
object (a part-model draws only on the reference's silhouette), the server
(127.0.0.1, routes, key.json unreachable, votes appended with their rater and
resumed per rater, legacy votes, bad votes and raters, cross-origin and
foreign Host refused), the page logic and rater ids, merging the votes files,
the export, and the analysis on hand-computed examples (Wilson intervals, last
vote wins, strata, ties, self-consistency, disagreements; Cohen's and Fleiss'
κ on textbook values; three raters: κ per two raters, Fleiss' κ, majority vote).
