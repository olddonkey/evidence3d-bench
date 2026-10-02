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

Extra exports: `applicableEdits(model)` and `earlierState(model, editIds)` (one
specific earlier state, plus the groups it is allowed to change), and the
geometry checks in `checks.mjs` (`probeCheck`, `featureEdges`,
`dimensionEdgeDistances`, `zFightReport`, `mirrorDifference`, `viewCamera`).
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

All use metres, +Y up, front facing +Z, with the origin and front stated in
`model.frame`. Buildings put the origin on the ground at the midpoint of the main
front wall (z = 0); structures put it on the ground at the centre of the base.

## What every model guarantees (tested in `v1/test/generator.test.mjs`)

- 2,000-60,000 triangles; 6-14 groups, every part in one group; categories from
  DESIGN.md; 6-12 probes; 6-12 dimensions in the front, right or plan view.
- Openings are real holes: recessed glass, frame rings, glazing bars and sills are
  separate parts. No two parts have parallel faces closer than 2 cm (the z-fight
  detector stays under 0.05 % of pixels in nine standard views).
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
2. Register it in `FAMILIES` in `index.mjs` and add it to the archetype list the
   tests expect.
3. Render a few seeds and look at them (a throw-away shaded renderer over
   `render()` from `v1/lib/raster.mjs` is enough), then run
   `node --test v1/test/generator.test.mjs`.
