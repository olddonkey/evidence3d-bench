# Provenance of the truth model `green-library` (public object id `real-0002`)

A monumental masonry library building of 1919: a five-storey central block on
the front (three great round arches over an open entrance porch, an attic of
colonnettes, a deep cornice and a hipped tile roof), lower wings either side
with gable-roofed colonnades in front, and four hipped ranges round a central
block of courts, a stair hall and a crossing under an octagonal lantern. The
truth is authored by hand in `model.mjs` from the measured survey drawings of
the building made in 1995 for the Historic American Buildings Survey (HABS
CA-2613, sixteen sheets by J. Nicola, The Architects' Collaborative; data pages
by M. S. Bernard). The contestant never sees the drawings. This file is private
documentation: it names the source; nothing in the task packs does (ids,
title, descriptions and notes are neutral, checked by `build.mjs` and the tests;
`FORBIDDEN` in `evidence.mjs`).

Source pack (read only, owner's machine):
`img2threejs/forge-artifacts/reference/stanford-campus-landmarks-2026-08-31/06-green-library/`.

## Scope

The historic west wing only (the survey's subject), its exterior. Not part of
it: the later east building attached to the rear (1980) and its connectors;
the covered walk that continues the south colonnade past its end wall; the
fountain, curved benches, paving, lamp posts, trees; the carved figures and
relief ornament (below the detail scale); the rooftop mechanical equipment the
aerial shows on the central flat roofs (on no sheet). The north, south and
rear faces are modelled as plain walls (their windows are left out): no
evidence item shows them, so they are not scored. The central roofs (stair
hall, courts, crossing, transepts, east block, lantern, roof lights) are
modelled as flat or hipped blocks at the heights the sections give; only the
aerial sees them.

## Epoch

Two epochs are in the pack: the 1995 survey (drawings, Jan-Apr 1995, which
record the building as it stood before the 1989 earthquake; photographs Jan
1995) and later photographs (Commons: 2013-01 and three of 2025-04, all of the
front from the plaza) with a current aerial map tile.

The evidence is the later set: `r2`/`r4` require an aerial view, and the only
aerial is a current map tile (retrieved 2026-08, imagery date not published),
so the 1995 photographs would have put two epochs into one pack (the task's
target state is the newest input's date). The 1995 photographs also carry the
survey number in the frame, show construction fences, and three of the five
are mostly trees. The cost: only the front and the roof are evidenced.

The truth is the building as the later photographs show it. Each evidenced
face was compared with the 1995 sheets:
- Front (sheet 15, west elevation, against all four photographs, overlaid
  through their fitted cameras): the three great arches, the buttresses and
  corner piers, the attic's three groups of six colonnettes, the cornice and
  eaves, the porch with three columns per bay, the steps, the wings' arched
  windows and corner pilasters, the colonnades (eight column positions, gable
  roofs, end walls) and every roof line agree with the drawing within the
  cameras' few-pixel error. No change was found.
- Roof (sheet 10 and the sections, against the aerial overlaid through its
  fitted camera): every eave, hip and ridge of the ranges, wings, corner
  blocks, rear range and central block, the central block's roof light, the
  lantern, the stair tower and the small hipped roof lights are where the
  sheet draws them. The aerial adds rooftop mechanical equipment on the
  central flat roofs (excluded) and shows nothing removed.
- Seen in the photographs and not on the sheets: the covered walk continuing
  south from the south colonnade (the roof plan draws 22 ft of it, cut at the
  sheet edge; the west elevation stops at the end wall) - left out of scope.

## Sheets used and how each is registered

The renders are 1024 px wide (the Library of Congress "v" images), about 2.9
px per foot, so a pixel is about 0.1 m. Their scales differ by up to 1.5 %
from sheet to sheet (the scans were cropped differently), so each sheet is
registered on its own printed numbers and no common scale is assumed. The
digits of the dimension strings are about 4 px tall and illegible: each
string's value is the only one consistent with that sheet's graphic scale bar
and with the other strings (182'-0" + 30'-0" + 19'-0" = 231'-0" east-west;
45'-0" + 92'-0" + 45'-0" = 182'-0" north-south; extension lines measured on
sheets 02-10 at 2.907-2.952 px/ft, every segment within 1 px of its value).

| Sheet | Content | Registration (verify) | Scale |
| --- | --- | --- | --- |
| 10 | Roof plan | the eight extension lines of the two strings | 2.949 px/ft |
| 15 top | West (front) elevation | six level datums (FIFTH 136'-4" .. BASEMENT 79'-10"), the two wing faces (182'-0") | 2.921 px/ft |
| 15 bottom | North elevation | six level datums, east face and wing face (231'-0", 19'-0") | 2.919 px/ft |
| 16 bottom | South elevation | stack tiers W1..W7 and six level datums, east face and wing face | 2.941 px/ft |
| 16 top | East elevation | stack tiers and four level datums, north and south faces | 2.932 px/ft |
| 02-09 | Plans (basement .. fifth level) | readings only (pier and wall positions) | 2.907-2.953 px/ft |
| 11-14 | Sections A-A .. J-J | readings only (roof and central heights) | 2.933 px/ft |

Anchor residuals: within 0.55 px on sheets 10 and 15, up to 1.7 px on sheet 16
(its left and right datum columns disagree by 2 px: the scan is turned by about
0.14 degree).

Height datum: y = 0 is the grade line drawn under the west elevation (row
291.93 on sheet 15, 84'-11" on the survey's datum by the least-squares fit of
its six level datums at 2.9103 px/ft, residuals 0.32 px or less). Every height
below is "level - 84.92 ft".

## Dimensions

Feet; "printed" = a dimension string or a level datum, otherwise scaled.
Positions: x is to the south (+X, the right side of the front), z to the west
(+Z, the front), z = 0 the front face of the central block.

### Plan

| Quantity | Value | Source |
| --- | --- | --- |
| Front of the central block to the rear face of the corner blocks | 231'-0" (70.41 m) | printed, sheets 02-10 |
| Width across the wings (north to south face) | 182'-0" (55.47 m) | printed |
| Central block width | 92'-0" (28.04 m) | printed; west elevation 372 / 640 -> 92.1 ft |
| Central block projection in front of the wings | 19'-0" | printed |
| Depth of the west block (wings, central block's east wall) | 30'-0" | printed |
| Buttresses (faces 2.7 ft proud) | u -17.18..-11.68, +11.68..+17.18 | W 456 / 472 / 540 / 556; plan 05 and 09 840 vs 832 |
| Corner piers | x 40.55..46.0 (front, 2.7 ft proud), 46.0..49.2 (side, z -5.8..-0.4) | plan 05 outline 815 / 830.8 / 840 x rows 247.5 / 257.2 / 273.3; W 624 / 640 / 649 |
| Great window wall (in the arches) | z -8.2 | plan 05 808 |
| Porch back wall (doors) | z -19 | plan 03 777 |
| Porch columns | 3 per bay, pairs at z -6.0 and -7.8 | plan 03 rows 280..495, cols 808..818 |
| Steps | z 0..+12.6, seven risers | plan 03 to 870 |
| Attic colonnettes | z -1.4, 6 per opening, 3.68 ft apart | plan 09 822..830; W 395.7..449.2 |
| Colonnades | outer eave z -4.0, ridge z -11.5, columns z -6.1 / -9.5, end wall front z -5.7 | roof plan 816; plan 03 805..815; S elevation 188 / 191.5 |
| Roof eaves: ranges | x +-94.7 | roof plan 114.1 / 673.0 (-> +94.29 / -95.17, made symmetric) |
| Roof eaves: wings, front | z -15.5 | roof plan 781.95 / 782.98 |
| Roof eaves: corner blocks, rear | z -235.6 | roof plan 132.7 |
| Ridges of the ranges | x +-67.45 (27.25 ft of run from the eave) | roof plan 194.4 / 592.5 (27.2 / 27.3 ft) |
| Wing ridges (along x) | z -42.75 | roof plan 700 (-43.3) |
| Wing inner eave, valley foot | z -51.1, x 59.1 | roof plan 677, (676.7, 218) |
| Range inner eaves | x +-42.25 | roof plan 266.9 / 268.3 |
| Corner blocks' inner eaves | x +-40.2 | see conflict 4 (drawn 39.2) |
| Rear range | eaves z -225.4 / -183.6, ridge z -205.4 | roof plan 162.92 / 286 / 221.94 |
| Central block roof | eave rectangle x +-50.85, z -56.85..+4.68; ridge x +-20.08 at z -26.08 | roof plan 660.1..841.6 x 243..543, ridge 750.85, 333..452 |
| Central roof light | x +-20.4, z -38.9..-26.7 | roof plan 712.9..748.9 x 332..453 |
| Stair tower | eaves x 35.7..47.5, z -63.0..-50.1 | roof plan 642..680 x 252..287 |
| Stair hall / crossing | x +-21.2, z -117.9..-49 / x +-21.6, z -163.6..-117.9 | roof plan 330 / 455, 480; 328.5, 345 |
| Lantern | octagon, 13.5 ft to the corners, centre z -141.6 | roof plan centre 410, 395; section D-D 555..627.5 |

### Heights (above the west grade)

| Quantity | Value | Source |
| --- | --- | --- |
| Porch floor, top of the steps | 3.91 | printed GROUND LEVEL 88'-10" |
| Court floors (roofs over the first floor, 1963) | 18.91 | printed MAIN LEVEL 103'-10"; section E-E |
| Eave of the ranges and wings (underside of the overhang; the roof edge 0.6 ft higher) | 48.9 (14.90 m) | W 150.3 -> 48.66, N 514.5 -> 48.91, S 549 -> 49.26, E 184 -> 48.71; mean |
| Ridge of the ranges and wings | 63.0 (19.20 m) | W 110.4 -> 62.39, N 471.1 -> 63.79, S 509 -> 62.89, E 141 -> 63.37; mean (conflict 2) |
| Rear range ridge / outer eave edge | 55.4 / 45.5 | from where its valleys meet the corner blocks (roof plan); E 195 -> 44.6 (soffit) |
| Central block eave (underside) | 65.85 (20.07 m) | W 100.2 -> 65.88, D-D 506.5 -> 65.79 |
| Central block ridge | 83.9 (25.57 m) | W 47.33 -> 84.05, D-D 454 -> 83.70 |
| Cornice foot / attic foot / attic openings' head | 61.1 / 54.6 / 60.8 | W 114.1 / 133.0 / 115 |
| Great arch crown (round, spans the bay) | 51.5 | W 140 (outer ring 52.2) / 143-144 (inner ring 51.2) |
| Great window crown / sill (round head, 17.2 ft wide) | 47.4 / 25.7 | W 154 / 217; columns 397..447 |
| Porch ceiling / door heads | 15.4 / 14.0 | W 247 / 251 |
| Wing windows (round heads, 10.4 ft wide) | sill 23.7, crown 43.6 | W 223 / 165 |
| Wing corner pilasters | top 42.9, cap 45.3; 7.2 ft wide, 2.2 ft proud | W 167 / 160; 234 / 254.9 |
| Colonnade eave (underside) / ridge / beam foot / plinth | 16.8 / 21.9 / 14.7 / 4.1 | W 243.1 / 228.07 / 249 / 280 |
| Stair tower eave / apex | 71.8 / 75.6 | S 483 -> 71.8, apex S 473 -> 75.2, N 439 -> 74.8, E 102 -> 76.8 |
| Lantern wall top / apex | 70.9 / 77.9 | D-D 491.5 / 471; C-C 101 -> 77.9 |
| Stair hall and crossing roofs / transepts / east block | 56.1 / 45.85 / 44.1 | D-D 535, C-C 165 / C-C 195 / D-D 570 |
| Small hipped roof lights | to 62.2 (stair hall), 50.1 (east block, transepts) | D-D 517, 552.5; C-C 182.5 |
| Field Room roof light | 1.6 ft over the north range ridge | D-D 510 -> 64.6 |

Conventions (below the sheets' resolution of about 0.1 m, declared, not read):
the window frames sit 0.18 ft (wings) and 0.3 ft (great windows) behind their
wall face, the glass 0.04 m behind the frame front (the plans draw the wing
wall 1.7-2.6 ft thick with the glazing somewhere inside it: sheet 07 cols
760.8-765.8, sheet 05 768.3-775.8); column radii 0.6-0.72 ft (1-2 px on the
plans); the wing wall is a 2 ft slab in front of the range's mass; the doors
are 0.25 ft slabs on the porch's back wall. Detail groups are scored after a
local translation fit, so a uniformly deeper reveal is fitted out.

## Conflicts and what was believed

1. **Overall size: data pages vs drawings.** The data pages give "180 feet
   wide ... 235 feet long" and "approximately 229 by 180 ft" at the perimeter
   columns. Every plan prints 231'-0" and 182'-0". Believed: the drawings
   (the text's 235 ft probably runs to the foot of the steps or the eaves; it
   is not a dimension string).
2. **Ridge heights of the ranges.** The four elevations put the ring ridges
   at 62.39 (west, the wings), 63.79 (north), 62.89 (south) and 63.37 ft
   (east); sections A-A and C-C disagree among themselves by 2 ft. The data
   pages call the north range the "symmetric twin (in terms of exterior
   massing)" of the south range. Believed: one ridge height, the mean of the
   elevations, 63.0 ft; uncertainty 0.35 m.
3. **Eave line.** Each elevation draws the eave as one 2 px line with the
   rafter ends dotted below it. Read as the lower edge of the overhang (the
   underside), with the roof surface a fascia (0.6 ft) higher; a first draft
   that took it for the top of the roof edge sat 0.37 m low against all four
   elevations.
4. **Corner blocks' inner eave.** The roof plan draws it at x 39.2 ft; a
   regular hip end (whose corner heights agree with the other eaves) needs
   40.2. Believed: 40.2 (3 px; the hip lines then meet where the sheet draws).
5. **Stair tower on the west elevation.** The roof plan, the north, south
   and east elevations draw a hipped stair tower behind the central block's
   right rear corner (apex 74.8-76.8 ft); from the front its roof would show
   about 4 ft above the central block's right hip, and the west elevation
   does not draw it. The photographs do not settle it (a tree covers that
   spot in all four). Believed: the four sheets that draw it.
6. **South colonnade.** See "Epoch": the truth stops both colonnades at the
   end walls the west elevation draws.
7. **Great arches.** At 1024 px the arcs fit a semicircle and a flatter
   segmental arch about equally well (traced rows within 2 px of either);
   every photograph, and the 1995 detail photograph of the centre bay, shows
   round heads. Believed: round (semicircular) arches and window heads.
8. **North-south symmetry of the roof plan.** The roof plan's north eave
   and ridge lie 1.3 px further from the centre than the south ones, against
   its own dimension strings. The truth is symmetric (the strings and the
   elevations are): verify reports +0.26 m on the north eave.
9. **Sections vs elevations at the eaves.** Section A-A draws the stack
   range's inner eave 2.7 ft above its outer eave and the outer eave 1 ft
   below the south elevation's. Believed: the elevations (they show the
   eaves the photographs see); the inner eaves follow the roof plan's lines on
   the planes of the outer slopes.

## Uncertainty

`model.meta.truth_uncertainty_m = 0.2`. Verify (45 lines on five sheets, every
line found): median 0.052 m, worst 0.364 m (the north corner block's soffit on
the east elevation, whose datum columns disagree by 2 px), all within 0.37 m;
see `.local/v1/scratch/real2/verify/residuals.json` and the overlays. One pixel
is 0.10 m on these renders, and the sheets disagree with each other by up to
1.4 ft (0.43 m) on the ring ridges, so 0.2 m is the typical, 0.35 m the
roof-height uncertainty. The central roofs (only in sections, which disagree
by about 1 ft) are uncertain to about 0.6 m (`meta.uncertain`). Plan positions
on the front read from 1-2 px features (buttresses, piers, windows) are good
to about 0.1 m. Sloped roofs make verify's depth-step edges fill every pixel of
a roof, so eaves are measured at their underside in elevation and with a
0.6 ft search window on the roof plan; ridges were compared by hand on
crease overlays (scratch tool `crease.mjs`): the truth's hips, valleys and
ridges coincide with the roof plan's lines to about a pixel.

## Evidence and cameras

Photographs (copied, cropped under `.local/`; the pack is never modified):

| id | pack file | date | licence | camera |
| --- | --- | --- | --- | --- |
| photo-1 | `visual-references/bing-wing-overview.jpg` (cropped to 1280 x 700) | 2013-01 | CC0 | resected on 6 points, rms 3.4 px; level, principal point row fitted (600 of 853: a shifted lens) |
| photo-2 | `visual-references/bing-wing-facade-01.jpg` (1280 x 640) | 2025-04 | CC BY-SA 4.0 | 10 points, rms 2.6 px (ultra-wide, 82 degrees vertical) |
| photo-3 | `visual-references/bing-wing-facade-02.jpg` | 2025-04 | CC BY-SA 4.0 | 10 points, rms 7.0 px |
| photo-4 | `visual-references/bing-wing-facade-03.jpg` | 2025-04 | CC BY-SA 4.0 | 7 points, rms 8.6 px |
| aerial | `aerial-and-maps/esri-site.jpg` (crop x 600..980, y 470..800) | 2026-08 (retrieved; imagery date not published) | Esri World Imagery, attribution and terms apply | orthographic, see below |

The CC BY-SA photographs need attribution if the packs are ever published
(GualdimG, Wikimedia Commons); the CC0 one is by LPS.1.

Method. For each photograph 6-10 building points were identified on 4-6x
crops (the central block's eave corner and ridge ends, the attic openings'
corners, the left wing's eave corner and window crowns, one colonnade eave)
and position, heading, pitch, roll and field of view fitted by
Levenberg-Marquardt on the reprojection error, the camera height held at 1.5
m (1.6 m for photo-1). Photo-1 has parallel verticals: it was taken with a
shifted lens, so its pitch is held at 0 and the principal point's row fitted.
Points in the arches were not used: their dark recess edge is a shadow line in
sunlit photographs. The photographs were cropped at the bottom (plaza
foreground with inscribed benches); the cameras carry the crop. The fits put
the cameras 31-55 m in front of the front, on the plaza. The depth along the
view is weakly fixed (the points lie near one plane), which coverage does not
need; photo-4's camera, 7-8 m from the fountain, is a few metres off (its
fountain occluder is placed where that photograph puts it).

Aerial: the pack's build script exported it in latitude-longitude (EPSG:4326,
0.0055 x 0.0045 degrees at 1800 x 1350 px), so at latitude 37.4 its pixels are
not square: 3.701 px/m east-west, 2.704 px/m north-south (a free fit on the
roof gives 3.614 / 2.687). The description says so. Treated as orthographic;
the direction of true east and north in the truth frame (the front faces
west-north-west) and the offset fitted on nine roof points (eave corners of the
central block and wings, ridge ends, lantern apex) with the export's pixel
sizes held: rms 2.6 px.

Occluders (truth frame, from the aerial and the photographs, a few metres):
the fountain on the front's centre line 25 m out (basin and bowl); a deciduous
tree south-west of the fountain (bare in 2013: trunk only, the building shows
through the branches; in leaf in 2025); a tree at the south edge of the
plaza; a tree in front of the left colonnade's end; in 2013 an evergreen in
front of the left wing (gone by 2025).

Coverage of the truth's visible surface (`real.mjs coverage`, scratch build):
52.4 % overall; roof-facing 91.6 %, front-facing 69.6 % (the front elevation
band 80.6 %), left- and right-facing 5.1 % and 4.6 % (silhouette strips and
the colonnade and pilaster ends; the side elevations themselves 0.4 % and
0.2 %), rear 0.3 % (rear elevation 0). Per item: aerial 42.4 %, photographs
4.1-7.6 % each. Truth score in the scratch build: 99.90 (r2) and 99.91 (r4),
shape 100, detail 99.8, all 12 probes evaluated with error 0. Detail groups scored on the truth: roof, central block roof,
buttresses, great arches, attic, wing windows, pilasters, colonnades, centre,
roof lights; not scored (under half evidenced): the ranges' walls (3 %), the
central block's walls (41 %: its sides and rear are not seen), the entrance
porch (48 %: from eye height 30-55 m away the treads of the steps and the
porch floor are seen more than 80 degrees off their normal, which the scorer
does not count, and the fountain hides the middle steps), the lantern (46 %:
the aerial sees its roof, no photograph its drum).

## Colours

Not on the drawings. Approximations of the photographed finishes (sandstone
#c9b48e, buff brick #c2ab84, red clay tile #9a4a32, flat roofs #8d8a84, glass,
dark frames, doors); appearance is the secondary score and no geometry depends
on them.

## Calibration

`node v1/cli.mjs calibrate --task real-0002-r4` on the scratch build: 39 of 41
rows meet their expectation. The two that do not are `dropGroup(roof)` and
`dropGroup(front.block.roof)`: each drops the group's F to 0 as expected, but
the missing roof (the ring roofs are 40 % of the evidenced surface) moves the
global alignment by 1.09 m and 0.91 m (1 % of the diagonal), and other groups
drift by up to 0.99 (the centre group, whose candidate geometry is no longer
attributed to it at zero offset) and 0.12. A scorer behaviour on an object whose
evidence one roof dominates, not a defect of the truth; not tuned away. A
mirrored model scores 97.0: the building is symmetric but for the stair tower
and the north range's roof light.

