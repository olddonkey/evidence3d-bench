# Real object `green-library` (public id `real-0002`)

The second object of the real-building tier (`v1/lib/real/README.md` describes
the tier, the authoring directory and the commands). A monumental masonry
building: a five-storey central block with three great arches on the front,
lower wings with gable-roofed colonnades, four hipped ranges round a central
block with a lantern. Truth from the 1995 measured survey drawings (16 sheets);
evidence: four photographs of the front (2013-01, 2025-04) and a current
aerial map tile. Only the front and the roof are evidenced; PROVENANCE.md says
why (the epoch decision), where every number comes from and what was believed
where the sheets disagree.

| File | What it holds |
| --- | --- |
| `model.mjs` | the truth (frame: +Z = the front, +X = right; z = 0 the central block's front face, y = 0 the paving at the foot of the steps); every number carries its sheet reading |
| `sheets.mjs` | registration of five sheets (roof plan, four elevations) on their printed numbers, and the 45 lines verify measures |
| `evidence.mjs` | the photographs, their crops, resected cameras and occluders; `FORBIDDEN`; `OBJECT_ID` |
| `notes.md` | survey notes for `r4` (seven named dimensions) |
| `PROVENANCE.md` | sources, epoch, dimensions, conflicts, uncertainty, cameras, coverage |

## Commands

    PACK=.../stanford-campus-landmarks-2026-08-31/06-green-library
    node v1/scripts/real.mjs prepare --source v1/real/green-library --pack $PACK \
      --sources-root .local/v1/real-sources/green-library
    node v1/scripts/real.mjs build --source v1/real/green-library \
      --sources-root .local/v1/real-sources/green-library --set real-2026-10 [--data DIR]
    node v1/scripts/real.mjs verify --source v1/real/green-library --sheets $PACK/official-docs/habs-sheets [--out DIR]
    node v1/scripts/real.mjs coverage --task real-0002-r2 [--data DIR]
    node --test v1/test/real-green-library.test.mjs

## Limits worth knowing

- The sheet renders are 1024 px wide (0.1 m per pixel) and disagree with each
  other by up to 0.4 m on roof heights: truth uncertainty 0.2 m, 0.35 m on the
  ring ridges, 0.6 m on the central roofs (only the aerial sees those).
- verify.mjs marks a depth step of 4 cm per pixel as an edge, so on these
  renders every pixel of a sloped roof is an edge; roof lines are measured at
  eave undersides and with narrow windows, and the roof's hips and ridges were
  checked on crease overlays by hand (PROVENANCE.md, "Uncertainty").
- The aerial map tile has non-square pixels (latitude-longitude export); its
  camera and its public description account for it.
