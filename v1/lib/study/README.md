# Human-agreement study (blind paired comparison)

The headline score has to be checked against human judgement. This module
prepares a blind paired-comparison study: a rater sees the reference (the
hidden truth) and two submissions for the same task, says which one is closer
to the reference, and the analysis tells how often the score agrees with the
rater, and at what score gap a human starts to see the difference.

```sh
node v1/scripts/study.mjs prepare --name NAME --batches A,B,C --seed SEED [--pairs 100] [--repeat-share 0.1] [--data .local/v1] [--force]
node v1/scripts/study.mjs serve   --name NAME [--port 4173] [--data .local/v1]
node v1/scripts/study.mjs analyze --name NAME [--data .local/v1]
```

`serve` prints the URL (`http://127.0.0.1:4173/`); open it in a Chromium-based
browser, rate, stop the server with Ctrl-C, run `analyze`. Rating can stop and
resume at any time: the page asks the server for the votes so far and shows
the first unrated pair.

Everything of one study is in `<data>/study/<name>/` (git-ignored, like all
data derived from the hidden truth):

| file | who reads it | what |
|---|---|---|
| `pairs.json` | the page (public) | per pair: opaque id, task title, variant, image file names |
| `images/<pair>-<r\|a\|b>-<view>.png` | the page | reference, A, B per view |
| `key.json` | analysis only (private) | everything else: attempt directories, configurations, scores, gap, stratum, sides, repeats, render facts |
| `votes.jsonl` | the server appends, the analysis reads | one line per vote |
| `analysis.md`, `analysis.json` | people | the agreement analysis |

`prepare` refuses to touch a study that has votes, and a prepared study without
`--force`.

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

- Text in Chinese. Instruction: 「同一道题的参考模型和两份提交。哪一份的几何更接近参考？忽略颜色和材质。」
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
  images that pairs.json names. `GET /votes` returns `{ votes, malformed }`;
  `POST /vote` takes `{ pair, choice: a|b|tie, ms, hidden_ms }` and appends
  `{ pair, choice, ms, hidden_ms, at }` (`ms`: from showing the pair to the
  vote; `hidden_ms`: the part of it the page was hidden, e.g. another tab;
  `at`: the server's ISO time). Appends are serialised.

## Analysis (`analyze.mjs`)

Joins votes.jsonl with key.json; writes analysis.md and analysis.json.

- The last vote per pair counts. Malformed lines and votes for unknown pairs are
  counted and skipped.
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

Statistics are counts, proportions and Wilson intervals, nothing else. Pairs
share tasks and sometimes submissions, so they are not fully independent; the
intervals do not account for that.

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
(127.0.0.1, routes, key.json unreachable, votes appended and resumed, bad votes,
cross-origin and foreign Host refused), the page logic, and the analysis on a
hand-computed example (Wilson intervals, last vote wins, strata, ties,
self-consistency, disagreements).
