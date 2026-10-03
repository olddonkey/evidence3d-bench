# Ground-truth generator (module A)

Seeded parametric families that produce hidden ground-truth models
(`e3d-model-v1`, DESIGN.md section 5). Everything is a pure function of
`(archetype, seed)`; randomness only comes from `v1/lib/rng.mjs`.

```js
import { ARCHETYPES, generateModel, decoyModel } from './index.mjs';
const model = generateModel({ archetype: 'hall', seed: 7 });      // id 'hall-0007', validated
const { model: earlier, change } = decoyModel(model, { seed: 0 }); // an earlier state of the same building
// change = { note: 'In this earlier state ...', contested_probes: ['east-end', ...] }
```

Extra exports: `GENERATOR_VERSION`, `applicableEdits(model)` and
`earlierState(model, editIds)` (one specific earlier state, plus the groups it is
allowed to change), and the geometry checks in `checks.mjs` (`probeCheck`,
`featureEdges`, `dimensionEdgeDistances`, `zFightReport`, `mirrorDifference`,
`viewCamera`, `groupRelief`, `facadeDirections`).
Each model also carries `generator: { version, params, structure }`; `params`
regenerates it exactly, `structure` summarises what was actually built.

## Archetypes

| id | what varies by seed (structure, not just size) |
| --- | --- |
| `house` | 1 or 2 storeys, attic storey with 1-3 dormers, gable or hipped roof, ridge/rear/external gable chimney (with or without aerial), porch type (hood, gabled, lean-to, none), box bay, side garage (flat, gable or lean-to roof), rear extension (flat or lean-to), 2-4 window bays, palette with quoins or window heads |
| `retail` | 4-8 structural bays, entrance tower position and width, blank end bay, awnings / continuous canopy on rods or posts / none, 2-5 rooftop plant units, service side, dock canopy |
| `tower` | 1-3 podium storeys and 3-6 bays, 8-24 shaft floors, curtain wall / ribbon / punched facade, crown (setback floors, plant screen, extended fins with ring beam), core side, podium extension, mast, plant |
| `hall` | 4-8 nave bays, round or pointed arches, tower at the west front centre / front corner / beside the nave, parapet / helm roof / spire, second tower, apse, transept (one or both arms), side porch |
| `structure` | sub-type: elevated water tank (4 or 6 legs, 3-5 bracing panels, cone or dome bottom, valve house, roof mast), gasholder guide frame (8-12 columns, 2-4 tiers, bell height, stair tower, governor house), or dish antenna on a pedestal (dish size, azimuth/elevation, hut side) |
| `warehouse` | long-span shed, 5-9 frame bays (27-68 m long, 16-30 m wide): low-pitched gable, raised monitor with clerestory glazing, or 3-5 sawtooth bays with north lights facing left or right; frame lines as cover strips over a masonry dado; 1-3 roller shutters and a personnel door (with or without hood) and gable louvre in the front; raised loading dock with 2-3 sheltered doors on one long side, with or without canopy; one- or two-storey office block (flat roof with parapets, or lean-to) on the other side; high-level windows or none; rooflights and ridge vents; a straight external stair to a mezzanine door on the rear gable; sprinkler tank or none |
| `terrace` | row of 3-5 houses with party walls: doors paired across party walls, bays and dormers per house, a step part way along (taller storeys) or none, party-wall parapets or none, ridge stacks on the party walls, back-to-back rear outshots in pairs or none; the house at one end is a corner shop, a wider double-fronted house with a gable stack, or a house entered from its gable |
| `civic` | two-storey building on an L, T (offset) or U (unequal wings) plan; hipped roofs, or gabled behind parapeted gable walls, intersecting in valleys; plinth and string course; 7-11 window bays; portico with 2/4/6 columns and a pediment or flat top; cupola (square or octagonal, dome or pyramid, clock or louvres) or none; chimney stacks or none; dog-leg escape stair against one end wall |

All use metres, +Y up, front facing +Z, with the origin and front stated in
`model.frame`. Buildings put the origin on the ground at the midpoint of the main
front wall (z = 0) - for the shed that is the front gable, for the terrace the
front wall of the whole row as generated (a shorter earlier row keeps that
frame); structures put it on the ground at the centre of the base.

## What every model guarantees (tested in `v1/test/generator.test.mjs`)

- 2,000-60,000 triangles; 6-14 groups, every part in one group; categories from
  DESIGN.md; 6-12 probes; 6-12 dimensions in the front, right or plan view.
  One known exception, inherited from generator 1.0 and kept for byte identity:
  a house with every optional element (two storeys, attic with dormers, porch,
  bay, garage, extension, gable window) has 15 groups, e.g. seed 319372107
  (1 of 1,000 large seeds).
- Openings are real holes: recessed glass, frame rings, glazing bars and sills are
  separate parts. No two parts have parallel faces closer than 2 cm (the z-fight
  detector stays under 0.05 % of pixels in nine standard views).
- Every group stands out from its absence by at least its detail size
  (`groupRelief`): seen from the views the scorer uses for the group's facade, the
  median distance from the group's visible surface to the nearest remaining
  surface facing the same way (45 degrees) is >= `detail_size_m` (1 mm sampling
  allowance). The scorer matches a group at 0.6 x its detail size, so a group
  that fails this is scored as present when it is missing.
- Probes: kept only if a 25 x 25 depth window over a 0.3 m disc round the hit lands
  on one surface of one part, at most 60 degrees off its normal (`probeCheck`).
- Dimensions: `value_m = |b - a|`, parallel to their view, and both endpoints lie
  within 1 cm of a crease or boundary edge projected into that view.
- A mirror image (left/right) and a front/rear flip differ on at least 5 % / 3 %
  of front+top (or side+top) pixels after the best shift is applied.
- Decoys: 1-3 later additions removed by re-running the generator with edited
  parameters in the same frame; probes copied verbatim; contested probes move by
  at least 4 % of the bounding-box diagonal; parts outside the edit's declared
  groups (`scope`) are unchanged.

## Known limits of the added archetypes

Checked through the real pipeline (draft photographs, drawings, notes, `score
--glb truth`, 14 objects, every truth score 99.95-100): some groups are shown by
less than half of their surface in the standard evidence, so the scorer leaves
them unscored on those tasks. The sawtooth north lights (`roof.glazing`, 4 %:
vertical, facing the side, each hidden by the next tooth), the loading `dock` on
a long side (41-48 % on t2), the office windows (49 %), the side and rear windows
of a long civic range behind a wing (`windows`, 40-45 %) and a terrace's `rear`
seen past a tree (37 %). The geometry is right; the cameras do not see it.

## Adding an archetype

1. Create `archetypes/<id>.mjs` exporting `default { id, sample, build, edits }`:
   - `sample(r)` draws a JSON-serialisable parameter object from the kernel rng
     `r`. Use `r.fork('<name>')` per element so adding a draw in one place does not
     shift the others. Decide anything an earlier state must keep (positions,
     which side, zones a removable wing occupies) here, independent of whether the
     optional element is built.
   - `build(p)` fills a `ModelBuilder` (`kit.mjs`) and returns
     `{ builder, title, frame, scope_note, structure, probeOrder? }`. Use
     `wallFrame` + `wall` + `glazedOpening` / `doorOpening` for walls with openings,
     and the roof, band, railing and ladder helpers. Embed attachments 2-5 cm into
     their host instead of laying them flush. Register several probe candidates
     per id in order of preference; assembly keeps the first robust one.
   - `edits`: `[{ id, scope: [group ids], applies(params, structure), apply(params) → params, phrase }]`.
     Each edit removes or lowers something that was added later and must keep the
     frame fixed (move `left`-style anchors rather than re-centring).
   - optional `fallbackEdits` (same shape): tried by `decoyModel`, one at a time,
     only after the seeded choice and every single regular edit failed to move a
     probe measurably. `applicableEdits` does not list them, so adding one never
     changes a model or decoy that already worked.
2. Register it in `FAMILIES` in `index.mjs` and add it to the archetype list the
   tests expect.
3. Render a few seeds and look at them (a throw-away shaded renderer over
   `render()` from `v1/lib/raster.mjs` is enough), then run
   `node --test v1/test/generator.test.mjs`.

## Versions

`model.generator.version` names the generator that made a model.

- `e3d-generator-1.0` (git 2cef4f9): five archetypes; built the dev set and the
  first pilot.
- `e3d-generator-1.1`: adds `warehouse`, `terrace` and `civic`, the relief check,
  and fixes the three groups it found in the original archetypes, each the
  smallest change that clears it (measured on seeds 0-59; house and structure
  passed and are byte-identical apart from the version string):
  - `retail` `base` (every seed): the masonry base band stood 3 cm proud with a
    5 cm detail size (relief 0.037 m; a model without it kept F 0.76). It now
    stands 6 cm proud (`BASE_PROUD`; relief >= 0.063 m). Only the `base-*`
    parts change.
  - `tower` `facade.grid`, curtain and ribbon facades (12 of the first 15
    seeds): spandrels stood 7 cm proud of the glass with a 12 cm detail size
    (relief 0.082-0.114 m). They now stand 14 cm proud, and the top spandrel
    rises 6 cm into the roof slab (its top would otherwise sit level with the
    fin tops where it passes the slab's 10 cm overhang). The `*-spandrel-*`
    parts change; punched facades are unchanged. In 4 of seeds 0-999 (66, 123,
    300, 912) and 4 of 600 large seeds (about 0.5 %: setback crowns with a
    narrow terrace) the `setback-terrace` probe
    is also dropped, because its 0.3 m robustness window now touches the deeper
    upper spandrels; their decoys lose it from `contested_probes`.
  - `hall` `tower.top` with a parapet top (with or without pinnacles): the
    coping, which is most of such a top, stands 14 cm above the wall, below the
    20 cm detail size (relief 0.142-0.179 m). The detail size of parapet tops
    is now 0.12 m; geometry is unchanged.
  Nothing else changes: compared with generator 1.0 (git 2cef4f9), models and
  the decoy `pack.mjs` builds (decoy seed = model seed), seeds 0-999 of
  `retail`, `tower` and `hall` and 0-299 of `house` and `structure`: retail
  1000/1000 differ only in `base` parts; tower 267 identical (punched), 729
  only in spandrel parts, 4 as above; hall 686 identical, 314 only in the
  `tower.top` detail size; house and structure identical apart from the version
  string. The test file guards 15 models and 5 decoys by hash.
- Also in 1.1, for seeds where 1.0 could not build a decoy at all
  (`decoyModel` threw "no earlier state ... differs measurably", so
  `build-object` failed): 7 of `hall` seeds 0-999 (halls with a spire and no
  porch, whose tower edits move no robust probe) and 2 of `structure` seeds
  0-299 (two-tier guide frames whose governor house stands in front of the
  stair tower), about 0.7 % of each. Their `fallbackEdits` (`no-transept` or
  `fewer-bays-short` for the hall, `one-tier-fewer-short` for the structure)
  now give a measurable earlier state. No seed whose decoy 1.0 could build is
  affected; 1,000 large seeds (100,000 to 2^31) per archetype now all build a
  model and a decoy.

Dev-set objects built with 1.0 (`house-0011`, `retail-0012`, `tower-0013`,
`hall-0014`, `structure-0015`): regenerating `retail-0012` and `hall-0014` from
their seeds now gives the 1.1 models; `house-0011`, `tower-0013` (punched facade)
and `structure-0015` regenerate identically apart from the version string.
