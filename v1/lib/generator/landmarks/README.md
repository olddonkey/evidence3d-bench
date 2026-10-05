# Landmark twins: the memory tasks (m2, m3)

The generated objects of v1 are anonymous, so memory has nothing to offer a
contestant. The memory tasks make it bite: the object is a well-known
structure, named in the task, but the surveyed object differs from the
published one in proportions, counts and dimensions. The evidence (photographs
and an aerial view on `m2`; also scaled drawings on `m3`) shows the surveyed
object. The task prompt says: use only this evidence, even where it disagrees
with what you know about this structure. The scorer then reports, per contested
probe, whether the submission is closer to the surveyed state (the evidence) or
to the published one (memory).

```js
import { LANDMARKS, generateLandmark, publishedModel, landmarkInfo } from './index.mjs';
const { model, alternate } = generateLandmark({ landmark: 'arc-de-triomphe', seed: 1234567 });
// model:     the surveyed twin, the hidden truth (validated e3d-model-v1)
// alternate: { id: 'remembered', model: <the structure as published>, stale: false,
//              change: { note, contested_probes, deltas, uniform_scale_mismatch, attempt } }
await buildObject({ dataRoot, model, alternate, id: 'obj-…' });   // pack.mjs, unchanged
```

`change.note` is public (it names what differs, never a value, and has no
digit); `change.deltas` (quantity, published and surveyed value, change) is
private and stays in the object's `alternates/remembered/change.json`.
`buildTask` copies only `contested_probes` and `note` into `truth.json`.

Build and check a set with `v1/scripts/landmarks.mjs` (see the end of this file).

## The four landmarks and their published figures

Every published figure is cited in a comment next to the number in the
landmark's file. Figures marked *estimated* have no published source that could
be found; they are proportions read off photographs and elevations.

| Landmark | Published figures used | Source |
| --- | --- | --- |
| Elizabeth Tower (Big Ben), London | 96 m tall; base 12 m (40 ft) square; dials 7 m in diameter, centred 55 m above ground; masonry to 61.0 m (200 ft), the rest a cast-iron spire (so 35 m) | UK Parliament facts and figures (via search results; parliament.uk refuses automated fetches); [Wikipedia, Big Ben](https://en.wikipedia.org/wiki/Big_Ben). Wikipedia gives the dials as 22.5 ft (6.9 m) at 180 ft (54.9 m): Parliament's figures are used. |
| Arc de Triomphe, Paris | 49.54 m high, 44.82 m wide, 22.21 m deep; main vault 29.19 m high, 14.62 m wide; transverse vaults 18.68 m high, 8.44 m wide; 30 shields on the attic | [Wikipedia, Arc de Triomphe](https://en.wikipedia.org/wiki/Arc_de_Triomphe). Guides round to 50 × 45 × 22 m. |
| Washington Monument, Washington, D.C. | 555 ft 5⅛ in (169.29 m) tall, of which the shaft 500 ft; shaft 55 ft 1½ in square at the base, 34 ft 5½ in at the 500 ft level; pyramidion 55 ft 5⅛ in; 8 observation windows 3 ft wide (six 1 ft 6 in high, the two on the east face 2 ft); change of marble at 150 ft | NPS National Register nomination 66000035 (quoted in search results); [Wikipedia](https://en.wikipedia.org/wiki/Washington_Monument); [washington.org](https://washington.org/dc-guide-to/washington-monument) for the 150 ft. The 2013–14 survey gave 554 ft 7 11⁄32 in (169.046 m); the long-quoted 555 ft 5⅛ in is what is remembered. ASCE says "just under 40 feet" at the top of the shaft; the NPS figure is used. |
| Lincoln Memorial, Washington, D.C. | 99 ft (30.18 m) above grade at the foot of the terrace walls; terrace retaining wall 14 ft high, 257 × 187 ft; building 201 ft 10 in × 132 ft at its widest; 36 Doric columns plus 2 at the entrance, 44 ft tall, 7 ft 5 in in diameter; 189.7 × 118.5 ft (taken as the attic) | [NPS building statistics](https://www.nps.gov/linc/learn/historyculture/lincoln-memorial-building-statistics.htm); [Wikipedia](https://en.wikipedia.org/wiki/Lincoln_Memorial). The arrangement 12 on the front and rear, 8 on each end is from photographs (12 + 12 + 8 + 8 − 4 corners = 36); no fetched source states it. |

Estimated (no published figure found): the Arc's plinth, entablature levels
(frieze 33.0 m, cornice top 37.5 m, so an attic of 12.04 m), sculpture groups
and reliefs; the Elizabeth Tower's plinth, string courses, clock-stage margins
(chosen so that 55 m + 3.5 m + 2.5 m reproduces the published 61 m), belfry
(9 m) and the split of the spire into roof, lantern and finial; the
Washington Monument's window positions and the entrance pavilion (9 × 6 ×
4.2 m); the Lincoln Memorial's stylobate height (8.7 m, from the 58 steps from
the plaza to the hall), entablature (3.69 m, so the attic is 4.37 m), hall,
entrance and steps (24 m wide).

## What a twin changes

`generateLandmark` draws, from `rng('landmark:<id>:<seed>')`, three or four of
the landmark's named quantities and changes each:

- a length by 12–30 % (`CHANGE_RANGE`), up or down as the quantity allows,
  rounded to 5 cm without leaving the range;
- a count by at least 2 (`MIN_COUNT_CHANGE`): shields ±4, windows ±4 (one per
  face), columns ±2 on a side.

At least two of the changed quantities have a sourced published value
(`MIN_SOURCED_CHANGED`): changing only estimated figures would test nothing a
contestant could remember. The draw is rejected (and the next one, still
seeded, is taken) when the structure would be implausible (each landmark's
`implausible` says why: vaults reaching the main springing, columns closer than
1.4 m, a shaft tapering to nothing, dials not fitting their stage …), when it
has fewer than three contested probes, or when one uniform scale maps its
contested probes onto the published ones within 5 %.

| Landmark | Quantities a twin may change | Datum (never changed) |
| --- | --- | --- |
| Elizabeth Tower | dial height (−20…+30 %), dial diameter, spire height above the masonry, belfry height (estimated) | plinth, shaft section, lower string courses |
| Arc de Triomphe | main vault width and height, transverse vault width and height, attic height (estimated), shield count | footprint, plinth, sculpture groups, front reliefs |
| Washington Monument | shaft height (the top width follows the taper), pyramidion height, window count, pavilion width and depth (estimated) | base width and taper of the shaft |
| Lincoln Memorial | columns on the front and rear, columns on the ends, column height, column diameter, attic height (estimated), width of the steps (estimated) | terrace, podium and stylobate, hall walls |

### Why every twin keeps a datum

The scorer reads contested probes in the frame fixed by the surface both states
share (`score/context.mjs`: primary sample points lying on the alternate's
triangles, at least 30 % of the evidenced surface). If the twin differed
everywhere, there would be no shared surface; on `m2` the scale-free global fit
would then meet a memorised model half way (for the Elizabeth Tower it fits
the published model at scale 0.88) and the probes would come out "neither".
With a datum, the shared surface fixes position, height and (on `m2`) scale,
and the changed parts are measured where they stand.

Measured with synthetic evidence cameras (`score/synthetic.mjs`, no Blender),
seed 3 of the Arc, the Elizabeth Tower and the Washington Monument and seed 2
of the Lincoln Memorial, both `m2` and `m3`: the shared frame exists; the
published model as a submission scores 19–79 and every contested probe comes
out `alternate`; the twin scores 100 and every contested probe comes out
`primary`. The draft build of the real set
repeats this through the whole pipeline (`check`, below).

### Contested probes

A probe is contested when the two states differ there by at least 0.5 % of the
bounding-box diagonal (`CONTESTED_FRACTION`): twice the finest shape tolerance
(0.25 %), so a submission that matches either state within that tolerance is
attributed to it (`closer_to` needs the measurement within half the gap).
The twin's probes are robust on it (`checks.probeCheck`); the published model
takes them verbatim, keeping those that hit it at most 60° off the surface
normal. Probe candidates about the changed quantities come first, so the cap of
12 never drops them.

Every probe ray starts outside the object: `probeCheck`'s window sees
everything on the ray's line, behind the origin too. The Arc's vault jambs and
transverse vault walls are reached by oblique rays entering through the vault
mouths (40° and 55° off the surface normal).

`uniformScaleMismatch(rows)` reads each contested hit as its coordinate along
the probe axis (a height for a probe from above, a face position for one from
the side) and returns the smallest relative error with which one scale about
the frame origin maps the twin's onto the published ones; every twin has at
least 5 % (`UNIFORM_SCALE_LIMIT`).

## Symmetry and the fitted yaw

The scorer fits yaw. A structure with symmetries gives an ambiguous yaw: harmless
for the score (the fitted pose is as good), but it shows in `frame_error`.

- **Elizabeth Tower**: four-fold symmetric; a correct model may be fitted a
  quarter or half turn off. The real tower has no asymmetric feature at this
  scale (it leans 0.26°; not modelled).
- **Arc de Triomphe**: mirror-symmetric front to rear and left to right; a half
  turn fits as well. The real sculpture groups differ in composition, not in
  massing.
- **Washington Monument**: four-fold symmetric shaft and pyramidion, but the
  entrance pavilion on the east face and the taller east windows fix the yaw.
- **Lincoln Memorial**: the entrance and the steps fix front and rear; left
  and right mirror each other, which a yaw fit cannot confuse.

So `frame_error.yaw_deg` of 90° or 180° on the tower and the Arc is not a
contestant error. `checks.mirrorDifference` (which the generated archetypes must
pass) does not apply to these landmarks.

## Checks the models pass (`v1/test/landmarks.test.mjs`)

- `validateModel`; titles name the landmark and carry no digit; frame
  sentences as the generator writes them.
- 5–14 groups with the DESIGN.md categories, every part in a group, at most
  60,000 triangles (the obelisk has under 1,000).
- 6–12 dimensions, each `|b − a|`, parallel to its view, endpoints within 1 cm
  of a drawn edge (`dimensionEdgeDistances`).
- z-fighting under 0.05 % of pixels in the nine standard views; every group
  stands out from its absence by its detail size (`groupRelief`).
- The published models reproduce the published figures (overall heights,
  widths, vault sizes, 30 shields, 8 windows, 36 + 2 columns, …).
- Same seed, same twin; changes within range; contested probes hit both states
  and differ by at least 0.5 % of the diagonal; the uniform-scale mismatch,
  recomputed from raycasts, is at least 5 %; the note carries no digit.
- Through `buildObject` (Blender stubbed by a fake executable) and `buildTask`:
  the published model is stored as `remembered` with the private deltas, no
  stale evidence is rendered, `m2` / `m3` packs carry the memory rule, their
  `truth.json` names the alternate, and `verifyTasks` finds no seed or internal
  id in the packs.

## Building a set

```sh
node v1/scripts/landmarks.mjs new-set   --name memory-2026-10                 # .local/v1/sets/memory-2026-10.json (private)
node v1/scripts/landmarks.mjs build-set --set .local/v1/sets/memory-2026-10.json --quality draft --data .local/v1/scratch/landmarks-draft
node v1/scripts/landmarks.mjs check     --set .local/v1/sets/memory-2026-10.json --data .local/v1/scratch/landmarks-draft
```

`new-set` draws one seed per landmark from the OS random source and gives each
object an opaque id; the file lives under the git-ignored data root and must
never be committed. `build-set` is resumable (an object with `evidence.json` is
complete) and writes `<data>/sets/<name>.built.json` with the build time per
object. `check` scores, for every object and variant, the truth (must reach 98
with every contested probe closer to the primary), the published model (must be
at least 10 points lower with every contested probe closer to the alternate),
and confirms that the twin regenerated from the seed is the stored truth byte
for byte; it prints a table and exits 1 on any failure.

### The first draft build (2026-10-05)

The private set `memory-2026-10` (one object per landmark) was built at draft
quality into a scratch data root: 56–82 s per object, Blender included, 4.5 min
in all. `check` passed every row: the truth scored 100 on `m2` and `m3` with
every contested probe (4–8 per object) closer to the primary; the published
model scored 50–67 on the Arc, the tower and the obelisk and 84–85 on the
Lincoln Memorial (whose twin changed the colonnade and the steps, a small part
of its surface), with every contested probe closer to the alternate; the twins
regenerated from the seeds were the stored truths byte for byte. Scoring took
12–30 s for the truth and 24–95 s for the published model per task (machine
shared with model runs). The two Washington titles were shortened afterwards
("Washington, D.C." became "Washington DC": the task prompt adds a full stop
after the title); geometry is unchanged.

## Known limits

- **Aerial view of very tall objects.** The aerial camera is fitted so the
  object fills 40–60 % of the frame; for the 169 m obelisk that puts it low
  relative to the object's height, so perspective magnifies the pyramidion and
  hides the base, where a real map tile (taken from far higher) would barely
  lean. The street photographs of the tall objects are framed correctly (the
  camera steps back to keep its tilt under 28°), but the object is then a
  narrow strip of the frame. Both are properties of `evidence/photos.mjs`,
  which this module does not change.

- The models are simplified: sculpture groups and reliefs are blocks, the
  Lincoln Memorial's columns have no flutes, entasis or inward tilt, the
  Elizabeth Tower has no lucarnes and does not lean. Every simplification is
  the same in the twin and the published model, so it never decides a
  contested probe.
- Several proportions are estimates (listed above). They are the same in both
  states unless the quantity is one a twin changes, and a twin must change at
  least two sourced quantities.
- The Lincoln Memorial's 189.7 × 118.5 ft is read as the attic; sources do not
  say what the figure measures.
