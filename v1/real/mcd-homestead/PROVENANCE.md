# Provenance of the truth model `mcd-homestead` (public object id `real-0001`)

A single-storey drive-through restaurant with a taller glazed front block (a
children's play room), an entrance tower on the right (east) side and a
three-step left (west, drive-through) side. The truth is authored by hand in
`model.mjs` from the approved planning-application drawing set (2018, eleven
sheets, City planning file PLN2018-13252). The contestant never sees the
drawings. This file is private documentation: it names the source; nothing in
the task packs does (ids, title, descriptions and notes are neutral, checked by
`build.mjs` and the tests).

Source pack (read only, owner's machine):
`img2threejs/forge-artifacts/reference/mcdonalds-3509-homestead-santa-clara-2026-07-30/`.

## Sheets used

The key-sheet renders `planning-and-dimensions/key-sheets/01..08-*.jpg` are
byte-identical to `development-plans-rendered/page-02..09.jpg` (md5). All are
3600 x 2400 renders of the plotted sheets at 100 dpi.

| Sheet | File | Scale | Registration |
| --- | --- | --- | --- |
| A1.0A floor plan, rear part | `02-main-floor-plan.jpg` | 1/4" = 1'-0" | graphic scale 0..16 ft = 2773.5..3174 px (25.03 px/ft) |
| A1.0B floor plan, front part | `03-playplace-floor-plan.jpg` | 1/4" = 1'-0" | printed 40'-4" between its ticks 427.7..1436 (25.00 px/ft) |
| A2.0 front (south) and rear (north) elevations | `04-south-front-and-north-rear-elevations.jpg` | 3/16" = 1'-0" | 18.75 px/ft; datums T/SLAB 1625, +3'-1" 1567, +9'-0" 1457, +10'-11" 1421, +18'-10" 1271, +20'-6" 1241 (rear: 1626, 1457, 1421, 1272, 1237) |
| A2.1A right (east) elevation, front part | `05-east-...-a.jpg` | 3/16" | datums +3'-1" 1539, +9'-0" 1429, +14'-5" 1328, +20'-6" 1214; slab 1598 |
| A2.1B right (east) elevation, rear part | `06-east-...-b.jpg` | 3/16" | slab 1598, +18'-10" 1243, +20'-6" 1213 |
| A2.2A left (west) elevation, front part | `07-west-...-a.jpg` | 3/16" | +3'-1" 1517, +9'-0" 1406, +14'-5" 1305; slab 1575; top datum 1191 (see conflict 2) |
| A2.2B left (west) elevation, rear part | `08-west-...-b.jpg` | 3/16" | slab 1580, +18'-10" 1225, +20'-6" 1192 |
| Key notes / material legend | on every elevation sheet, `09-material-and-signage-legend.jpg` | — | colours of the named finishes |

The site plan SP1 (`01-proposed-site-plan.jpg`, 1" = 20'-0"), the landscape
sheets and SP0 (existing site) were not used for the truth or the cameras.
Elevation scale: the drawing scale at 100 dpi is 18.75 px/ft; every elevation's
own datums agree with it to within 1-2 px (0.05-0.1 ft), so verify holds the
printed scale and fits only the offsets (see `v1/lib/real/README.md`).

Readings are sheet pixel coordinates found with an ink profile (the darkest
rows/columns over a span) and checked by eye on 2-5x crops; positions along a
facade are measured from that sheet's building end (corner battens) and
converted at the sheet's scale. `model.mjs` carries the reading next to every
number; the table below collects them.

## Dimensions

Feet-inches are as printed when the column says "printed", otherwise the
nearest half inch of the scaled reading. Metres = feet x 0.3048.

### Plan

| Quantity | Value | Source |
| --- | --- | --- |
| Overall length, front wall to rear wall | 162'-5 1/2" (49.517 m) | scaled: A1.0A rear wall 372 -> match line 3150.5 (111.14 ft) + A1.0B match line 367 -> front wall 1650 (51.32 ft) = 162.46 ft. Elevations: A2.1A+A2.1B 162.4, A2.2A+A2.2B 162.6 ft |
| Front-block width (and dining part of the left side) | 37'-4" (11.379 m) | printed 40'-4" between the outer edges of the two 1'-6" side canopies (A1.0B) less 2 x 1'-6"; scaled east 464 -> west 1398 = 37.36 ft. The pack prose says 37'-7 1/4"; that string is the canopy-end dimension on A1.0B, not the width (see conflicts) |
| Widest part (drive-through booth side) | 44'-0" (13.411 m) | scaled A1.0A 405 -> 1504 = 43.96 ft |
| Cash-booth step | 2'-9 1/2" | printed on A1.0A ("CASH BOOTH EXPANSION"); scaled 1434 -> 1504 |
| Rear part width | 41'-2 1/2" (12.560 m) | 44'-0" - 2'-9 1/2"; scaled 405 -> 1435 = 41.20 ft |
| Step from dining room to widest part, from front | 77'-8 1/2" | 162'-5 1/2" - 84'-9" (A1.0A 372 -> 2491 = 84.76 ft); A2.2A bay edge 1427.5 -> 77.60 ft |
| Cash-booth step, from rear | 33'-4 1/2" | A1.0A 372 -> 1206 = 33.36 ft; A2.2B 1216 -> 1843 = 33.44 ft |
| Wall thickness | 10 1/2" | A1.0A 405->427, 1414->1435, 1481->1504 (21-23 px) |
| Batten projection | 3" | A1.0B corner 458 vs 464, A1.0A 6-8 px |
| Front-block canopy projection (front, right, left) | 1'-6" (0.457 m) | printed on A1.0B (both sides) |
| Main side canopies | 4'-0" (1.219 m) | printed 4'-0" on A1.0B (west); scaled A1.0A 405 -> 303 = 4.08 ft (east) |
| Entrance canopy | 4'-4" | scaled A1.0A 405 -> 297 = 4.32 ft |
| Drive-through canopies | 4'-4 1/2", 3'-10" | scaled A1.0A 1504 -> 1613, 1505 -> 1600 |

### Heights (printed datums)

| Quantity | Value | Sheets |
| --- | --- | --- |
| Front block, entrance tower, drive-through bays, corner battens | +20'-6" (6.248 m) | A2.0 (T/PLAY PLACE), A2.1A, A2.1B, A2.2B (T/PARAPET WALL) |
| Main parapet | +18'-10" (5.740 m) | A2.0, A2.1B, A2.2B (T/PARAPET WALL) |
| Upper window head | +14'-5" (4.394 m) | A2.1A, A2.2A (T/WINDOW) |
| Canopy underside, front block and right side | +9'-0" (2.743 m) | A2.0, A2.1A, A2.2A (B/CANOPY) |
| Canopy underside, left side and drive-through | +10'-11" (3.327 m) | A2.0 (B/DT. CANOPY); A2.2A 1370.5 -> 10.92 ft |
| Lower window sill | +3'-1" (0.940 m) | A2.0, A2.1A, A2.2A (B/WINDOW) |

### Heights (scaled)

| Quantity | Value | Reading |
| --- | --- | --- |
| Upper window sill | 10'-1" | A2.1A 1407.5 -> 10.17, A2.0 1437.5 -> 10.01, A2.2A 1386 -> 10.09 ft |
| Lower window head (sides) | 7'-10" | A2.1A 1450.5 -> 7.87, A2.2A 1427 -> 7.90 ft |
| Lower window head (front) | 8'-8" | A2.0 1462 -> 8.70 ft |
| Low lights below the transom | from 1'-1" | A2.1A 1578 -> 1.07, A2.2A 1554.5 -> 1.09 ft |
| Canopy top, front block | 10'-0" | A2.1A 1410, A2.0 1437.5, A2.2A 1388 |
| Reveal-panel band bottom, right side | 9'-8" | A2.1A 1416.5 |
| Reveal-panel band bottom, left / rear / step walls | 11'-7" | A2.2A 1357.5, A2.0 rear 1407, A2.0 step 1408 |
| Drive-through canopy top | 11'-7" | A2.2A 1357.5, A2.2B 1362 |

### Along the right (east) side, from the front wall (A2.1A, front end at 571.5, 18.75 px/ft)

Front-block windows 2'-11 1/2" -> 37'-2 1/2" (upper), -> 29'-3 1/2" (lower, four lights); mullions 9'-11", 16'-9",
23'-7", 30'-4 1/2"; rear of front block 39'-3 1/2" (1308.5); exit door 39'-10" -> 42'-10", head 7'-9"; dining window 1
52'-11 1/2" -> 62'-4" (mullions 56'-0 1/2", 59'-3"); entrance tower 70'-9" -> 85'-6" (batten field 1897.5 -> 2173.5;
plan A1.0A 70.9 -> 85.4 ft); entrance opening 73'-0 1/2" -> 83'-2 1/2", doors 74'-11 1/2" -> 80'-11 1/2", door head
7'-10"; dining window 2 89'-4 1/2" -> 98'-10"; flush pilaster 116'-4 1/2" -> 124'-11" (A2.1A 2752.5; A2.1B 1261.5).
Rear doors (A2.1B, rear end at 1970): 20'-6" -> 16'-2" and 7'-9" -> 3'-11" from the rear, heads 7'-3" (see conflict 5).

### Along the left (west) side (A2.2A front end at 2881; A2.2B rear end at 1216)

Front-block windows 2'-11 1/2" -> 36'-3" (mullions 9'-8 1/2", 16'-6 1/2", 23'-4 1/2", 30'-2 1/2"; A1.0B printed
36'-5" to the canopy end); rear of front block 39'-3 1/2" (2145.5); glazed exit door 39'-8 1/2" -> 42'-9"; dining window
52'-7 1/2" -> 62'-1"; batten strip 62'-2" -> 64'-7", top 18'-11"; drive-through bay 1 77'-8 1/2" -> 90'-2 1/2"
(raised to +20'-6"), window 80'-5" -> 87'-5", sill 3'-3", head 8'-2", transom 7'-0"; bay 2 from 41'-6" to 33'-4 1/2" from
the rear, window 39'-9" -> 35'-3" from the rear; high window 32'-10 1/2" -> 25'-0" from the rear, sill 6'-3", head 8'-1";
rear corner battens 8'-1 1/2" from the rear (A1.0A 8.08 ft).

### Front and rear walls

Front (A2.0, centre at x 1022): window bands -10'-1 1/2" -> +16'-7" from the centre line, mullions -3'-4 1/2", 3'-4",
10'-0 1/2"; corner battens -18'-8" -> -10'-3" (left) and 16'-8" -> 18'-8" (right). Rear (A2.0 rear, right-side end
at 2196): double door 27'-7 1/2" -> 32'-9 1/2" from the right side, head 7'-5"; single door 33'-8" -> 36'-10 1/2",
head 7'-3"; step window in each step wall (A2.0 583.5-604.5 and 2972-2992), head 7'-10"/7'-11".

### Roof decks — not on any sheet

The set has no roof plan and no section, so the roof decks are not dimensioned.
They are hidden behind the parapets from every street view, but the aerial shows
them, so they are scored. The new parapets were built on the existing walls: the
existing elevations show the old mansard top at +16'-2" (A2.0 EXISTING,
T/PARAPET) and the old front-block eave at B/OVERHANG +16'-8" (A2.2A EXISTING).
The main deck is set at 16'-2" and the front-block deck at 16'-8" (uncertainty
0.5 m, recorded in `model.meta.uncertain`). Nothing else rests on these numbers.

## Conflicts and what was believed

1. **Parapet tiers (pack prose vs drawings).** The pack's README and brief give
   two parapet heights, 16'-2" and 18'-10". 16'-2" appears only on the EXISTING
   elevations. Every PROPOSED elevation draws one main parapet at +18'-10" and
   +20'-6" at the front block, the tower, the drive-through bays and the corner
   battens. Believed: the proposed elevations. The 2022 and 2026 photographs show
   one parapet line.
2. **A2.2A top datum labelled "T/PLAY PLACE +23'-0"".** Against that sheet's own
   +3'-1", +9'-0" and +14'-5" datums and the printed scale, its leader (row 1191)
   sits at 20.50 ft; A2.0 and A2.1A print +20'-6". Believed: 20'-6" (a typo).
   verify leaves the label out of the fit and reports the line: residual 0.000 m.
3. **Front-block width "37'-7 1/4" x 40'-4"" (pack prose).** On A1.0B the
   37'-7 1/4" string is the rear end of the right-side canopy measured from the
   front canopy edge, and 40'-4" is the width over both side canopies. The walls
   scale to 37.36 ft = 40'-4" - 2 x 1'-6". Believed: the sheet geometry.
4. **Right-side front-block windows and canopy end: A2.1A vs A1.0B.** A2.1A draws
   the upper band and canopy to 37'-2 1/2" and the lower band in four lights to
   29'-3 1/2"; A1.0B prints 37'-7 1/4" including the 1'-6" front canopy, i.e.
   36'-1 1/4" from the wall. The 2022 and 2026 photographs show the four lower
   lights and the upper band ending at the junction as A2.1A draws them.
   Believed: A2.1A. verify reports the A1.0B line: -0.335 m (declared).
5. **Rear door on the right side: A2.1B vs A1.0A.** A2.1B puts the jamb of the
   rear-most door 4.37 ft from the rear end and the corner battens to 4.63 ft;
   the plan puts the battens to 3.84 ft and the jamb at 3.92 ft. Believed: the
   plan for position, A2.1B for width (3.83 ft). verify reports +0.089 m.
6. **Drive-through bay 2 height: A2.0 rear vs A2.2B / A2.1B.** A2.2B (and the
   rear-view edge on A2.1B) raise the second drive-through bay to +20'-6"; the
   A2.0 rear elevation draws the bay's end wall at the +18'-10" parapet.
   Believed: A2.2B (two sheets, and the bay is the drive-through feature the
   elevation of that side dimensions). verify reports A2.0's line: +0.520 m
   (declared). The photographs do not show this side.
7. **Rear wall left end on A2.0 rear: +0.154 m**, the largest undeclared
   residual: the elevation's left end reads 41.7 ft from the right-side end, the
   plan 41.2 ft (+3" battens); A1.0A agrees with the rest of the plan to 0.02 m.
   Believed: A1.0A.

The owner's three.js model (`img2threejs/src/mcdonalds/measured.ts`) was used
after the readings only as a cross-check. Its heights and its notes on conflicts
1 and 2 agree; its widest part (13.411 m) is the same; its length (49.621 m) and
widths (11.521 and 12.649 m) are 0.10-0.14 m larger, traced on the site plan at
5 px/ft against the 1/4" plans here (25 px/ft). It ends the front block 40'-4"
(12.29 m) from the front, reading the 40'-4" string of A1.0B as the block's
length; on A1.0B that string runs across the building (it spans the walls plus
both 1'-6" canopies, and verify puts both walls and both canopy edges on the
sheet to 0.07 m), and both side elevations put the block's rear end at
39'-3 1/2" (verify residuals 0.000 and -0.065 m). No number in `model.mjs`
comes from that model.

## Colours

The key notes name the finishes, not their colours. RAL 7022 (E C1, AP; #4c4a44)
is the published value of the named colour. The others are approximations of the
named finishes, not measurements: E C2 SW 7019 Gauntlet Gray #5f5c56 (the
maker publishes RGB 98, 96, 90 = #62605a, CIE76 ΔE about 1.5 away; noticed after
the object was built, left as built), CM Weathered Zinc #a9a69f, C1 white #eeece6,
C2 charcoal #36353a, W1 Extra Dark Bronze #2e2823, AL wood-grain #9a7a56, glass
#2a3036, roof membrane #8e8b84 (these hex values are the ones the owner's model
uses; colour is the secondary appearance score and no geometry depends on it).

## Uncertainty

`model.meta.truth_uncertainty_m = 0.15`: the overlay residuals (median 0.016 m,
max 0.154 m over 89 main lines on 8 sheets, two declared conflicts excepted)
measure how well the truth follows the drawings; the drawings are an approved
scheme, not an as-built survey, and the photographs agree with them at every
place they show (one parapet line, the four lower lights, tower and pilaster
positions, canopy rhythm). The roof decks (0.5 m) and conflict 4 (0.3 m) are
the known larger uncertainties.

## Out of scope (absent from the truth, named in `scope_note`)

The free-standing roadside sign; menu boards, order-point canopies and the
drive-through signage; site walls, the trash enclosure and bollards; parking,
kerbs, planting; wall lettering, the arches on the tower and the play-room
wordmark (relief of a few centimetres on 3-D letters that the sheets do not
dimension); wall lights; the canopy tie rods (drawn on the elevations, too thin
to score, and not dimensioned); the rooftop mechanical equipment (no roof plan:
the units are visible on the aerial but no sheet dimensions them). The interior
is not modelled: the glazing is opaque glass set 50 mm behind the wall face.

## Evidence and cameras

Photographs (copied, cropped and cleaned under `.local/v1/real-sources/`; the
pack is never modified):

| id | pack file | date | camera |
| --- | --- | --- | --- |
| photo-1 | `streetview/front-center-2022-06.jpg` | 2022-06 | resected, rms 3.6 px (9 points) |
| photo-2 | `streetview/front-east-entry-2022-06.jpg` | 2022-06 | resected, rms 7.0 px (10 points) |
| photo-3 | `streetview/front-2022-06.jpg` | 2022-06 | resected, rms 2.5 px (7 points) |
| photo-4 | `streetview/front-west-logo-2022-06.jpg` | 2022-06 | resected, rms 7.1 px (8 points) |
| photo-5 | `current-photos/google-maps-photo-current-playplace.jpg` | 2026-07 | resected, rms 9.3 px (9 points, height held at 1.5 m) |
| aerial | `aerial-and-maps/google-satellite-21z.jpg` | 2026-07 (as captured) | orthographic, registered on the roof outline |

Not used: `historical/` (2017 state); every contact sheet; the photoreal-3D
renders (mixed dates, fused meshes); the `exact-property/current-*` files, which
are crops of the same 2022-06 street views (their overlay says so) except
`current-playplace-pylon-2026-07.jpg`, a crop of photo-5's source; the 19z/20z
satellite tiles (same imagery as 21z at lower zoom) and the map overview.
`front-angle-a-2022-06.jpg` is byte-identical to `front-center-2022-06.jpg`.

Method. The street views are screenshots of a panorama viewer whose default
view spans 90 degrees across the 2080 px viewer, so f = 1040 px; the crop keeps
the viewer centre as the principal point and gives a vertical field of view of
49.64 degrees (a free fit of photo-2 gives 48.75). The 2026 photograph is a phone
photograph shown whole in the viewer; its field of view is fitted (52.2 degrees).
For each photograph 7-10 building points were identified (tower and pilaster
edges at the parapet and the ground, window and door corners, the ends of the
front block), and position, heading, pitch and roll were fitted by
Levenberg-Marquardt on the pixel reprojection error (`v1/lib/real/resect.mjs`).
The four street views come out 0.6 m apart from one another (the panorama was
captured from one car position), 15.5-16.1 m east of the right wall and 20.1-20.5
m behind the front wall, eye height 2.1-2.8 m: in the car park on the right
side, as the photographs show (not checked against the site plan). The residuals (2.5-9 px, i.e. 0.03-0.2 m at the
building) include lens distortion of the phone photograph and the batten
projection; they are well inside what coverage needs.

Aerial: a north-up map tile (the property line bears S 89°57' W, so the
building is square to the tile), treated as orthographic (a 21z tile of a 6 m
building leans by less than a metre at its edges). Registered on the roof
outline: right and left faces of the rear part at x 343 and 113 of the crop
(18.31 px/m), rear and front walls at y 69 and 955 (17.89 px/m).

Occluders: the cars parked nose-in against the right side that hide part of the
building in a photograph (one in front of the entrance in photos 1 and 2, two
beside the front block in photo 4, one in photo 5), as boxes sized and placed
from the photographs (precision ~0.5 m). Street furniture (sign posts, menu
boards) is thin and left out.

Coverage of the truth's visible surface (`node v1/scripts/real.mjs coverage`):
59.3 % overall; the right side 97.1 %, the roof 99.0 %, the left side 0 %, the
rear 1.8 % and the front 0.1 % (both only silhouette strips). Per item: aerial
40.1 %, photos 6.5-11.6 % each.
