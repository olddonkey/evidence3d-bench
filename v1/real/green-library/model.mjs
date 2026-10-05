// Truth model of a real building: a monumental masonry building with a
// five-storey central block (three great arches over an entrance porch, an attic
// of colonnettes, a hipped roof), lower wings with gable-roofed colonnades in
// front, and four hipped ranges round a central court block with a roof lantern.
// Authored by hand from the 1995 measured survey drawings of the building (16
// sheets, see PROVENANCE.md). The contestant never sees the drawings; the
// photographs (2013 and 2025, west front only) and an aerial are the evidence.
//
// The drawings are 1024 px renders of the survey sheets, about 2.9 px per foot,
// so one pixel is about 0.1 m. Every number below was read off a sheet; each
// carries the reading. Each sheet is registered on its own (the renders differ
// in scale by up to 1.5 %): plans on their printed overall dimension strings
// (182'-0" + 30'-0" + 19'-0" = 231'-0" east-west, 45'-0" + 92'-0" + 45'-0" =
// 182'-0" north-south; the digits are about 4 px tall and illegible, the values
// are the only ones consistent with each sheet's graphic scale), elevations and
// sections on their printed level datums (GROUND 88'-10", MAIN 103'-10",
// MEZZANINE 118'-10", FOURTH 129'-4", FIFTH 136'-4", BASEMENT 79'-10", and the
// stack tiers W1..W7 at 7'-6"). Readings are given as sheet pixels:
//   "W 100.2"  sheet 15 west elevation row (2.9103 px/ft, grade line 291.93),
//   "N 514.5"  sheet 15 north elevation row (2.9168 px/ft, datum fit),
//   "S 549"    sheet 16 south elevation row (W4 103'-10" at 638.04, 2.9343 px/ft),
//   "E 184"    sheet 16 east elevation row, "AA/CC/DD 111.8" section rows,
//   "R 782"    sheet 10 roof plan column or row (2.950 px/ft; z = 0 at 827.8,
//              x = 0 at row 392.25), "P5"/"P3"/"P9" sheets 05/03/09 plans.
// All values are in feet, converted once at the end (0.3048 m/ft).
//
// Frame (DESIGN.md 3): metres, +Y up. The front is the west front (three great
// arches, the steps, the colonnades) and faces +Z; +X is to the right when you
// look at the front, i.e. south. z = 0 is the front face of the five-storey
// block (its arches and attic, between the buttresses), x = 0 the building's
// centre line (it is symmetric about it), y = 0 the ground at the foot of the
// entrance steps (W grade line, 84'-11" on the survey's datum).
import { ModelBuilder, wallFrame, wall, opening, r4 } from '../../lib/generator/kit.mjs';
import { MODEL_SCHEMA, validateModel } from '../../lib/model.mjs';

export const FT = 0.3048;
const M = v => r4(v * FT);
const GRADE = 84.92;                     // W: grade line 291.93 on the datum fit (88'-10" at 280.54, 2.9103 px/ft)
export const level = elev => elev - GRADE; // survey elevation (ft) -> height above y = 0 (ft)

// ---- plan (ft) ---------------------------------------------------------------------
const Z_FRONT = 0;                       // front face of the central block (P5 832.03 = end of the 19'-0" string)
const Z_WING = -19;                      // west face of the wings (19'-0" string; P5 776.96, P3 777.0)
const Z_BLOCK = -49;                     // east wall of the central block / west block (30'-0" string; P9 685.97)
const Z_EAST = -231;                     // east face of the corner blocks (231'-0" overall; P5 157.98)
const X_OUT = 91;                        // north and south faces (182'-0" overall)
const X_BLOCK = 46;                      // sides of the central block (92'-0" string; W buttress faces 372 / 640 = +-46.04)
const T_WING = 2;                        // wing west wall slab (its windows are holes in it)

// ---- heights (ft above y = 0) --------------------------------------------------------
const H_PORCH_FLOOR = level(88.833);     // GROUND LEVEL 88'-10" = 3.91 (top of the steps)
const H_MAIN = level(103.833);           // MAIN LEVEL 103'-10" = 18.91 (court floors)
// Ring ranges and wings. Eave = the drawn eave line, the lower edge of the roof
// overhang (a 2 px line: the fascia; the dotted rafter ends under it, W 153.15,
// are below the detail scale): W 150.3 -> 48.66, N 514.5 -> 48.91, S 549.0 ->
// 49.26, E 184 -> 48.71. The roof surface at the edge is the fascia (0.6 ft)
// higher. Ridge (top of the tiles): W 110.4 (wing) -> 62.39, N 471.1 -> 63.79,
// S 509 -> 62.89, E 141 -> 63.37, AA outer apex 107.4 -> 62.75; the sections
// disagree by +-1 ft (CC 61.7 / 63.75) and are not used. Means of the elevations.
const H_EAVE = 48.9;                     // soffit at the outer eave
const H_RIDGE = 63.0;
const FASCIA = 0.6;
// East range (between the corner blocks, one storey lower): its ridge is fixed by
// where its valleys meet the corner blocks' slopes on R (z + 205.4 at x 52.2, the
// valley foot at R 183.3 / 276.7) at 15.26 ft of run below the range ridges: 55.44;
// its outer eave edge then falls at 45.5 (E 195 -> 44.6 measured, the soffit).
const H_EAST_RIDGE = H_RIDGE - 15.26 * (H_RIDGE - H_EAVE - FASCIA) / 27.25;
// Central block: eave line W 100.2 -> 65.88, DD 506.5 -> 65.79 (the soffit at the
// edge; the roof surface a fascia higher); ridge W 47.33 -> 84.05, DD 454 -> 83.70.
const H_BLOCK_SOFFIT = 65.85, H_BLOCK_EAVE = H_BLOCK_SOFFIT + FASCIA, H_BLOCK_RIDGE = 83.9;
const H_CORNICE = 61.1;                  // W 114.1: top of the attic, foot of the cornice
const H_ATTIC = 54.6;                    // W 133.0: foot of the attic (top of the buttresses' shafts)
const H_ATTIC_OPEN = 60.8;               // W 115: head of the attic openings (colonnettes 115..134)

// ---- roof plan (ft): eave lines and ridges read on R --------------------------------
const XE_OUT = 94.7;                     // outer eaves of the north and south ranges: R 114.1 -> 94.29, R 673.0 -> -95.17 (symmetric mean)
const ZE_WING = -15.5;                   // west eave of the wings: R 781.95 / 782.98 -> -15.6 / -15.3
const ZE_EAST = -235.6;                  // east eave of the corner blocks: R 132.7
const RUN = 27.25;                       // eave to ridge: R 114.1 -> 194.4 (27.2 ft), R 592.5 -> 673.0 (27.3), R 700 -> 782 (27.8)
const XR = XE_OUT - RUN;                 // range ridges at x = +-67.45 (R 194.4 -> 67.07, R 592.5 -> -67.88)
const ZR_WING = ZE_WING - RUN;           // ridge of each wing's roof, along x: -42.75 (R 700 -> -43.3)
const ZR_EAST = ZE_EAST + RUN;           // hip ends of the ranges over the corner blocks: -208.35 (R 213.3 -> -208.3)
const XE_IN = 42.25;                     // inner eave of the ranges: R 266.9 -> 42.49; valley foot R 268.3 -> 42.0
const XE_CORNER = 40.2;                  // inner eave of the corner blocks (R 276.7 -> 39.2; hip end of a regular range at 40.2: see PROVENANCE)
const ZE_WING_IN = -51.1;                // inner eave of the wings' roofs: R 677 -> -51.1 (valley foot R 676.7, 218 -> x 59.07)
const ZE_EAST_OUT = -225.4;              // east eave of the east range: R 162.92
const ZR_EASTR = -205.4;                 // ridge of the east range: R 221.94
const ZE_EAST_IN = -183.6;               // inner eave of the east range: R 286
const K = (H_RIDGE - H_EAVE - FASCIA) / RUN;   // roof slope, 0.495 (26.3 degrees)
const H_EDGE = H_EAVE + FASCIA;          // roof surface at the outer eave edge
const H_EAST_EAVE = H_EAST_RIDGE - K * (ZR_EASTR - ZE_EAST_OUT);   // roof edge at the rear range's outer eave, 45.5
const H_EAST_SOFFIT = H_EAST_RIDGE - K * (ZE_EAST_IN - ZR_EASTR) - FASCIA;   // under its lower (inner) eave edge, 44.0
// Central block roof: eave rectangle R 660.1..841.6 x 243..543, ridge R 750.85 from row 333 to 452.
const ZB0 = -56.85, ZB1 = 4.68, XB = 50.85;

// ---- central block front (W columns, u = (px - 506.0) / 2.9103 ft) --------------------
const BAYS = [[-40.55, -17.18], [-11.68, 11.68], [17.18, 40.55]];   // between the buttresses 372/388, 456/472, 540/556, 624/640
const BUTTRESS_PROUD = 2.7;              // P5 840 vs 832, P9 840 vs 832 (8 px)
// Corner piers: P5 outline 815 -> 830.8 x rows 247.5 -> 257.2 (the part proud of the block's side:
// z -5.8..-0.4, x 45.85..49.2) and 830.8 -> 840 x rows 257.2 -> 273.3 (the buttress proud of the
// front: z -0.4..+2.7, x 40.3..45.85); W 624 / 640 / 649 -> 40.55, 46.04, 49.3.
const CORNER_PIER = { x0: 40.55, x1: 49.2, xSide: 46.0, z0: -5.8, zSide: -0.4 };
// Great arches and their windows are round (semicircular): the traced arcs of W bay 2
// (crown row 140, rows 152 / 161 at 26 / 32 px off the centre line; window crown 154,
// 163 at 20 px) fit a semicircle within 2 px, and every photograph shows round heads.
const ARCH_TOP = 51.5;                   // crown between the archivolt's outer (W 140 -> 52.2) and inner (W 143-144 -> 51.2) rings
const WINDOW_HALF = 8.6, WINDOW_SILL = 25.7, WINDOW_TOP = 47.4;      // W 397..447 (bay 1), 217, 154
const Z_WINDOW = -8.2;                   // window wall: P5 808 (8.2 ft behind the face)
const H_PORCH_TOP = 15.4;                // W 247: porch ceiling under the window wall
const Z_PORCH = Z_WING;                  // porch back wall: P3 777 (in line with the wings)
const PORCH_COLUMNS = [-36.7, -29.3, -21.5, -8.0, 0, 8.0, 21.5, 29.3, 36.7]; // P3 rows 280..495 (x = (387.5 - row) / 2.929), symmetrised
const COLUMN_Z = [-6.0, -7.8];           // P3 808..812 and 813..818: each position is a pair in depth
const DOORS = [[-36.1, -29.9], [-27.8, -22.0], [-7.2, -1.0], [1.0, 7.2], [22.0, 27.8], [29.9, 36.1]]; // W 401..419, 425..442 (+ mirrored)
const H_DOOR = 14.0;                     // W 251
const ATTIC_OPENINGS = [[-38.6, -18.7], [-9.9, 9.9], [18.7, 38.6]];  // W colonnette groups 393.5..451.3, 477.4..534.0, 560..618
const COLONNETTE_STEP = 3.68;            // W 395.7, 406.2, 417.0, 428.0, 438.3, 449.2 (6 per group)
const Z_COLONNETTE = -1.4;               // P9 822..830 in a wall 817..832
const STEPS = { z1: 12.6, count: 7 };    // P3 steps to 870 (12.6 ft); rise 3.91 ft

// ---- wings and colonnades -------------------------------------------------------------
const WING_WINDOWS = [[54.8, 65.2], [70.4, 80.8]];  // W 316.3..345.9 / 271.8..300.95 (u -65.2..-54.8, -80.8..-70.4), mirrored
const WING_SILL = 23.7, WING_TOP = 43.6;  // W 223, 165 (round heads: springing W 180 -> 38.5 = crown less the half span)
const PILASTER = { x0: 86.3, x1: 93.5, proud: 2.2, top: 42.9, cap: 45.3 }; // W 254.9 / 234; P5 SW pier 6.4 px proud; W 167, 160
const COLONNADE = { x0: 45.9, x1: 95.1, zOut: -4.0, zRidge: -11.5, eave: 16.8 + FASCIA, ridge: 21.9, soffit: 16.8,
  beam0: 14.7, plinth: 4.1, endX0: 86.3, zEnd: -5.7 };  // R 816 (outer eave), W 243.1 / 228.07 (eave / ridge), 249 (beam foot), 280 (plinth), 229.99 (end wall); end wall front S elev 188
const COLONNADE_COLUMNS = [54.1, 57.9, 61.9, 65.8, 69.7, 73.5, 77.5, 81.4]; // W 348.5 .. 269.1 (8 per colonnade)
const COLONNADE_COLUMN_Z = [-6.1, -9.5];  // P3 805..815 pairs

// ---- centre (inside the ring) ----------------------------------------------------------
const Z_HALL1 = -117.9;                  // stair hall and light courts: R 480 .. 660 (pavilion)
const X_HALL = 21.2;                     // R 330 / 455
const Z_ROT1 = -163.6;                   // crossing: R 345 .. 480
const X_ROT = 21.6;                      // R row 328.5 (verify; the crossing square round the lantern)
const Z_APSE1 = -187.2;                  // east block: R 286 (inner eave) less the 3.6 ft overhang
const H_HALL = 56.1;                     // DD 535, CC 165
const H_TRANSEPT = 45.85;                // CC 195
const H_APSE = 44.1;                     // DD 570
// Stair tower at the central block's rear right corner, its hipped roof between the block's eave and
// ridge: R 642..680 x rows 252..287 (eaves); S elev eave 483 -> 71.8, apex 473 -> 75.2; N 439 -> 74.8; E 102 -> 76.8.
const TOWER = { x0: 35.7, x1: 47.5, z0: -63.0, z1: -50.1, eave: 71.8, apex: 75.6 };   // eave = soffit (S 483)
const LANTERN = { z: -141.6, x: 0, r: 13.5, wall: 70.9, apex: 77.9 }; // R octagon centre 410, 395; DD 555..627.5, 491.5, 471

export function model() {
  const b = new ModelBuilder();
  // Colours are not on the drawings. They are approximations of the photographed
  // finishes (sandstone, buff brick, red clay tile), for the secondary appearance score.
  b.material('stone', '#c9b48e', 'stone', { roughness: 0.9 });
  b.material('brick', '#c2ab84', 'wall', { roughness: 0.9 });
  b.material('tile', '#9a4a32', 'roof', { roughness: 0.8 });
  b.material('roof-flat', '#8d8a84', 'roof', { roughness: 0.9 });
  b.material('glass', '#2b2f33', 'glass', { roughness: 0.1 });
  b.material('frame', '#3a3430', 'frame', { roughness: 0.6 });
  b.material('door', '#4a3a2c', 'wood', { roughness: 0.7 });

  b.group('body', 'Walls of the four ranges round the centre', 'massing', 0.4, 'all');
  b.group('roof', 'Hipped tile roofs of the ranges and wings', 'roof', 0.4, 'roof');
  b.group('front.block', 'Five-storey central block', 'massing', 0.3, 'front');
  b.group('front.block.roof', 'Hipped roof of the central block and its roof light', 'roof', 0.3, 'roof');
  b.group('buttresses', 'Buttresses and corner piers of the central block', 'structure', 0.25, 'front');
  b.group('front.arches', 'Great arches with their recessed windows', 'openings', 0.2, 'front');
  b.group('front.attic', 'Attic openings with their colonnettes, and the cornice', 'ornament', 0.15, 'front');
  b.group('entrance', 'Entrance porch: columns, doors and steps', 'entrance', 0.15, 'front');
  b.group('wings.windows', 'Arched windows of the wings', 'openings', 0.12, 'front');
  b.group('pilasters', 'Corner pilasters of the wings', 'structure', 0.2, 'front');
  b.group('colonnades', 'Gable-roofed colonnades in front of the wings', 'attachments', 0.2, 'front');
  b.group('centre', 'Central block round the courts: stair hall, crossing and courts', 'massing', 0.4, 'roof');
  b.group('lantern', 'Octagonal roof lantern over the crossing', 'roof', 0.3, 'roof');
  b.group('skylights', 'Roof lights on the ranges and the centre', 'roof', 0.15, 'roof');

  const box = (id, group, material, [x0, x1], [y0, y1], [z0, z1]) =>
    b.box(id, group, material, [M(x0), M(y0), M(z0)], [M(x1), M(y1), M(z1)]);
  const mirror = (f) => { f(1, ''); f(-1, '-n'); };   // +X = south (no suffix), -X = north ('-n' parts)

  // ---- ring ranges and wings: bodies --------------------------------------------------
  const top = H_EAVE + 0.1;                  // walls stop just inside the roof solids
  mirror((s, n) => {
    const xs = v => s * v, span = (a, c) => [Math.min(xs(a), xs(c)), Math.max(xs(a), xs(c))];
    box('range' + n, 'body', 'brick', span(45.5, X_OUT), [0, top], [Z_EAST, Z_WING - T_WING + 0.1]);
    // Wing west wall (sandstone), with two arched windows.
    const wf = wallFrame('z', 1, M(Z_WING));
    const o = WING_WINDOWS.map(([a, c]) => opening({ u0: M(Math.min(xs(a), xs(c))), u1: M(Math.max(xs(a), xs(c))), y0: M(WING_SILL), y1: M(WING_TOP), shape: 'arch', ratio: 0.5, segments: 8 }));
    const [u0, u1] = span(X_BLOCK - 0.1, X_OUT);
    wall(b, wf, { id: 'wing-wall' + n, group: 'body', material: 'stone', u0: M(u0), u1: M(u1), y0: 0, y1: M(top), thickness: M(T_WING), openings: o });
    o.forEach((w, k) => windowIn(b, wf, 'wing-window' + n + '-' + (k + 1), 'wings.windows', w, { recess: 0.18, frame: 0.1 }));
    // Corner pilaster: proud of the west face and of the side face, chamfered cap.
    const [p0, p1] = span(PILASTER.x0, PILASTER.x1);
    box('pilaster' + n, 'pilasters', 'stone', [p0, p1], [0, PILASTER.top], [Z_WING - 3, Z_WING + PILASTER.proud]);
    box('pilaster-cap' + n, 'pilasters', 'stone', span(PILASTER.x0 + 0.6, PILASTER.x1 - 0.6), [PILASTER.top, PILASTER.cap], [Z_WING - 2.4, Z_WING + PILASTER.proud - 0.6]);
  });
  // Corner pilasters at the rear corners: E elev 245.99..267 (2.0 ft proud of the side face), N elev 158.75..180
  // (2.1 ft proud of the rear face, 7.3 ft wide), top S elev 569 -> 42.4.
  mirror((s, n) => {
    const [p0, p1] = [s * 86.2, s * 93.0].sort((p, q) => p - q);
    box('rear-pilaster' + n, 'body', 'brick', [p0, p1], [0, 42.4], [Z_EAST - 2.1, Z_EAST + 5.1]);
  });
  // East range between the corner blocks (its east face is where the attached later building meets it).
  box('east-range', 'body', 'brick', [-45.5, 45.5], [0, H_EAST_SOFFIT + 0.1], [ZE_EAST_OUT + 3.6, ZE_EAST_IN - 3.6]);

  // ---- ring roofs: explicit facets (plan polygons [x, z], heights from their planes) ------
  const ringBase = H_EAVE, eastBase = H_EAST_SOFFIT;
  const outS = (x) => H_EDGE + K * (XE_OUT - x);            // south-facing slope of the south range
  const inS = (x) => H_RIDGE - K * (XR - x);                // north-facing slope of the south range
  const wingW = (x, z) => H_EDGE + K * (ZE_WING - z);       // west-facing slope of a wing
  const wingE = (x, z) => H_RIDGE - K * (ZR_WING - z);      // east-facing slope of a wing
  const cornerE = (x, z) => H_EDGE + K * (z - ZE_EAST);     // east-facing hip end of a corner block
  const eastOut = (x, z) => H_EAST_RIDGE - K * (ZR_EASTR - z);
  const eastIn = (x, z) => H_EAST_RIDGE - K * (z - ZR_EASTR);
  // Valleys where the east range meets the corner blocks' inner slopes (equal pitch):
  // eastOut = inS  ->  z - x = c1;  eastIn = inS  ->  z + x = c2.
  const c1 = ZR_EASTR - XR + (H_RIDGE - H_EAST_RIDGE) / K;
  const c2 = ZR_EASTR + XR - (H_RIDGE - H_EAST_RIDGE) / K;
  const vEastFoot = [XE_CORNER, XE_CORNER + c1];            // valley foot on the corner block's inner eave
  const vTop = [(c2 - c1) / 2, (c1 + c2) / 2];              // where both valleys meet the east range ridge
  const vInFoot = [XE_IN, c2 - XE_IN];                      // valley foot on the range's inner eave
  const wingValleyFoot = [XR - (ZR_WING - ZE_WING_IN), ZE_WING_IN];   // wing inner slope meets the range's inner slope
  mirror((s, n) => {
    const P = pts => pts.map(([x, z]) => [s * x, z]);
    const H = f => (x, z) => f(s * x, z);
    facet(b, 'roof-out' + n, 'roof', 'tile', P([[XE_OUT, ZE_EAST], [XE_OUT, ZE_WING], [XR, ZR_WING], [XR, ZR_EAST]]), H(outS), ringBase);
    facet(b, 'roof-corner' + n, 'roof', 'tile', P([[XE_OUT, ZE_EAST], [XR, ZR_EAST], [XE_CORNER, ZE_EAST]]), H(cornerE), ringBase);
    facet(b, 'roof-wing-w' + n, 'roof', 'tile', P([[XE_OUT, ZE_WING], [X_BLOCK - 0.2, ZE_WING], [X_BLOCK - 0.2, ZR_WING], [XR, ZR_WING]]), H(wingW), ringBase);
    facet(b, 'roof-wing-e' + n, 'roof', 'tile', P([[XR, ZR_WING], [X_BLOCK - 0.2, ZR_WING], [X_BLOCK - 0.2, ZE_WING_IN], wingValleyFoot]), H(wingE), ringBase);
    facet(b, 'roof-in' + n, 'roof', 'tile', P([[XR, ZR_EAST], [XR, ZR_WING], wingValleyFoot, [XE_IN, ZE_WING_IN], vInFoot, vTop, vEastFoot, [XE_CORNER, ZE_EAST]]), H(inS), ringBase);
  });
  facet(b, 'roof-east-out', 'roof', 'tile', [[XE_CORNER, ZE_EAST_OUT], vEastFoot, vTop, [-vTop[0], vTop[1]], [-vEastFoot[0], vEastFoot[1]], [-XE_CORNER, ZE_EAST_OUT]], eastOut, eastBase);
  facet(b, 'roof-east-in', 'roof', 'tile', [vTop, vInFoot, [XE_IN, ZE_EAST_IN], [-XE_IN, ZE_EAST_IN], [-vInFoot[0], vInFoot[1]], [-vTop[0], vTop[1]]], eastIn, eastBase);
  // Field Room roof light: a gabled glazed light straddling the north range ridge (R 300..615, rows 570..620).
  // 17 ft wide (rows 570..620), centred here on the model's ridge; its top 1.6 ft over the ridge (DD 510 -> 64.6).
  const SKY = { x0: -XR - 8.5, x1: -XR + 8.5, z0: -178.9, z1: -72.1, ridge: H_RIDGE + 1.6 };
  const onRange = x => H_RIDGE - K * Math.abs(x + XR);
  b.prismZ('roof-light-north', 'skylights', 'glass', [[SKY.x0, onRange(SKY.x0) - 0.3], [SKY.x0, onRange(SKY.x0) + 0.8], [-XR, SKY.ridge],
    [SKY.x1, onRange(SKY.x1) + 0.8], [SKY.x1, onRange(SKY.x1) - 0.3]].map(([x, y]) => [M(x), M(y)]), M(SKY.z0), M(SKY.z1));

  // ---- central block (five storeys) ----------------------------------------------------
  // Masses behind the front: the ground storey behind the porch, everything above it.
  box('block-ground', 'front.block', 'stone', [-X_BLOCK, X_BLOCK], [0, H_PORCH_TOP + 0.1], [Z_BLOCK + 0.03, Z_PORCH]);
  box('block-upper', 'front.block', 'stone', [-X_BLOCK, X_BLOCK], [H_PORCH_TOP, H_BLOCK_SOFFIT + 0.1], [Z_BLOCK + 0.03, Z_WINDOW - 1.5 + 0.03]);
  const wfF = wallFrame('z', 1, M(Z_FRONT));
  // Front wall of arches: buttress cores and spandrels, the great arches open to the ground.
  const arches = BAYS.map(([a, c]) => opening({ u0: M(a), u1: M(c), y0: 0, y1: M(ARCH_TOP), shape: 'arch', ratio: 0.5, segments: 10 }));
  wall(b, wfF, { id: 'front-arches', group: 'front.block', material: 'stone', u0: M(-X_BLOCK), u1: M(X_BLOCK), y0: 0, y1: M(H_ATTIC), thickness: M(-Z_WINDOW), openings: arches });
  // Window wall inside the arches, with the great windows.
  const wfW = wallFrame('z', 1, M(Z_WINDOW + 0.02));
  const windows = BAYS.map(([a, c]) => { const m = (a + c) / 2; return opening({ u0: M(m - WINDOW_HALF), u1: M(m + WINDOW_HALF), y0: M(WINDOW_SILL), y1: M(WINDOW_TOP), shape: 'arch', ratio: 0.5, segments: 10 }); });
  wall(b, wfW, { id: 'window-wall', group: 'front.arches', material: 'stone', u0: M(-X_BLOCK + 3), u1: M(X_BLOCK - 3), y0: M(H_PORCH_TOP), y1: M(H_ATTIC - 0.1), thickness: M(1.5), openings: windows });
  windows.forEach((w, k) => windowIn(b, wfW, 'great-window-' + (k + 1), 'front.arches', w, { recess: 0.3, frame: 0.12 }));
  // Attic with three openings, six colonnettes in each, the leaded lights behind them.
  const attic = ATTIC_OPENINGS.map(([a, c]) => opening({ u0: M(a), u1: M(c), y0: M(H_ATTIC + 0.1), y1: M(H_ATTIC_OPEN) }));
  wall(b, wfF, { id: 'attic', group: 'front.attic', material: 'stone', u0: M(-X_BLOCK), u1: M(X_BLOCK), y0: M(H_ATTIC - 0.03), y1: M(H_CORNICE), thickness: M(-Z_WINDOW + 1.47), openings: attic });
  ATTIC_OPENINGS.forEach(([a, c], k) => {
    wfF.box(b, 'attic-light-' + (k + 1), 'front.attic', 'glass', M(a - 0.05), M(c + 0.05), M(H_ATTIC + 0.05), M(H_ATTIC_OPEN + 0.05), M(4.0), M(4.2));
    const first = (a + c) / 2 - 2.5 * COLONNETTE_STEP;
    for (let j = 0; j < 6; j++) {
      const u = first + j * COLONNETTE_STEP;
      b.cylinder('colonnette-' + (k + 1) + '-' + (j + 1), 'front.attic', 'stone', [M(u), M(H_ATTIC + 0.05), M(Z_COLONNETTE)], M(H_ATTIC_OPEN - H_ATTIC), M(0.72), { segments: 12 });
    }
  });
  // Cornice under the eaves.
  box('cornice', 'front.attic', 'stone', [-X_BLOCK - 0.6, X_BLOCK + 0.6], [H_CORNICE - 0.03, H_BLOCK_SOFFIT + 0.05], [Z_WINDOW - 1.48, 1.0]);
  // Buttresses (proud of the face) and the corner piers (proud of the face and the sides).
  BAYS.slice(0, 2).forEach(([, c], k) => {
    const [a2] = BAYS[k + 1];
    box('buttress-' + (k + 1), 'buttresses', 'stone', [c, a2], [0, H_CORNICE - 0.1], [-0.1, BUTTRESS_PROUD]);
  });
  mirror((s, n) => {
    // The front part runs 0.1 ft past the block's side so its face is not coplanar with the wall ends behind it.
    const [f0, f1] = [s * CORNER_PIER.x0, s * (CORNER_PIER.xSide + 0.1)].sort((p, q) => p - q), [s0, s1] = [s * (CORNER_PIER.xSide - 0.1), s * CORNER_PIER.x1].sort((p, q) => p - q);
    box('corner-pier' + n, 'buttresses', 'stone', [f0, f1], [0, H_CORNICE - 0.1], [-0.1, BUTTRESS_PROUD]);
    box('corner-pier-side' + n, 'buttresses', 'stone', [s0, s1], [0, H_CORNICE - 0.1], [CORNER_PIER.z0, CORNER_PIER.zSide]);
  });
  // Porch: floor, columns, doors; steps down to the plaza.
  box('porch-floor', 'entrance', 'stone', [-X_BLOCK + 0.1, X_BLOCK - 0.1], [0, H_PORCH_FLOOR], [Z_PORCH - 0.1, Z_FRONT - 0.03]);
  PORCH_COLUMNS.forEach((x, k) => COLUMN_Z.forEach((z, j) =>
    b.cylinder('porch-column-' + (k + 1) + '-' + (j + 1), 'entrance', 'stone', [M(x), M(H_PORCH_FLOOR - 0.05), M(z)], M(H_PORCH_TOP - H_PORCH_FLOOR + 0.1), M(0.65), { segments: 12 })));
  DOORS.forEach(([a, c], k) => box('door-' + (k + 1), 'entrance', 'door', [a, c], [H_PORCH_FLOOR, H_DOOR], [Z_PORCH - 0.1, Z_PORCH + 0.15]));
  // One stepped prism (separate boxes would share their side faces); its top 0.07 ft under the porch floor.
  const rise = H_PORCH_FLOOR / STEPS.count, tread = STEPS.z1 / STEPS.count, stair = [[-0.5, 0], [STEPS.z1, 0]];
  for (let k = 1; k <= STEPS.count; k++) {
    const y = k < STEPS.count ? k * rise : H_PORCH_FLOOR - 0.07, z = STEPS.z1 - (k - 1) * tread;
    stair.push([z, y], [k < STEPS.count ? z - tread : -0.5, y]);
  }
  b.prismX('steps', 'entrance', 'stone', stair.map(([z, y]) => [M(z), M(y)]), M(-X_BLOCK + 0.1), M(X_BLOCK - 0.1));
  // Hipped roof over its eave rectangle and the roof light on its east slope.
  const roofB = hipRoofFt(b, 'block-roof', 'front.block.roof', 'tile', { x0: -XB, x1: XB, z0: ZB0, z1: ZB1, soffit: H_BLOCK_SOFFIT, eave: H_BLOCK_EAVE, ridge: H_BLOCK_RIDGE });
  // R 712.9..748.9 x rows 332..453: a glazed monitor on the east slope, its top level with the ridge.
  const lightZ0 = -38.9, lightZ1 = -26.7, lightX = 20.4;
  facet(b, 'block-roof-light', 'front.block.roof', 'glass', [[lightX, lightZ0], [lightX, lightZ1], [-lightX, lightZ1], [-lightX, lightZ0]], () => H_BLOCK_RIDGE - 0.3, roofB.at(lightX, lightZ0) - 0.5);

  // Stair tower (TOWER above).
  box('stair-tower', 'front.block', 'brick', [TOWER.x0 + 1, TOWER.x1 - 1], [40, TOWER.eave + 0.1], [TOWER.z0 + 1, TOWER.z1 - 1]);
  hipRoofFt(b, 'stair-tower-roof', 'front.block.roof', 'tile', { x0: TOWER.x0, x1: TOWER.x1, z0: TOWER.z0, z1: TOWER.z1, soffit: TOWER.eave, eave: TOWER.eave + FASCIA, ridge: TOWER.apex });

  // ---- colonnades ------------------------------------------------------------------------
  const C = COLONNADE;
  mirror((s, n) => {
    const span = (a, c) => [Math.min(s * a, s * c), Math.max(s * a, s * c)];
    const [x0, x1] = span(C.x0, C.x1);
    // Gable along the colonnade: outer eave, ridge, and the inner slope down to the wing wall.
    const pitch = (C.ridge - C.eave) / (C.zOut - C.zRidge), inner = C.ridge - pitch * (C.zRidge - (Z_WING - 0.05));
    b.prismX('colonnade-roof' + n, 'colonnades', 'tile', [[C.zOut, C.soffit], [C.zOut, C.eave], [C.zRidge, C.ridge], [Z_WING - 0.05, inner], [Z_WING - 0.05, C.soffit]]
      .map(([z, y]) => [M(z), M(y)]), M(x0), M(x1));
    box('colonnade-beam' + n, 'colonnades', 'stone', span(C.x0, C.endX0), [C.beam0, C.soffit + 0.05], [COLONNADE_COLUMN_Z[1] - 0.8, COLONNADE_COLUMN_Z[0] + 0.8]);
    box('colonnade-wall' + n, 'colonnades', 'stone', span(C.x0, C.endX0), [0, C.plinth], [Z_WING - 0.05, COLONNADE_COLUMN_Z[0] + 0.9]);
    box('colonnade-end' + n, 'colonnades', 'stone', span(C.endX0 - 0.05, C.x1), [0, C.soffit + 0.05], [Z_WING - 0.05, C.zEnd]);
    COLONNADE_COLUMNS.forEach((x, k) => COLONNADE_COLUMN_Z.forEach((z, j) =>
      b.cylinder('colonnade-column' + n + '-' + (k + 1) + '-' + (j + 1), 'colonnades', 'stone', [M(s * x), M(C.plinth - 0.05), M(z)], M(C.beam0 - C.plinth + 0.1), M(0.6), { segments: 12 })));
  });

  // ---- centre ----------------------------------------------------------------------------
  box('stair-hall', 'centre', 'brick', [-X_HALL, X_HALL], [0, H_HALL], [Z_HALL1, Z_BLOCK + 0.1]);
  mirror((s, n) => {
    const span = (a, c) => [Math.min(s * a, s * c), Math.max(s * a, s * c)];
    box('court' + n, 'centre', 'roof-flat', span(X_HALL - 0.05, 45.55), [0, H_MAIN], [Z_HALL1, Z_BLOCK + 0.03]);
    box('transept' + n, 'centre', 'brick', span(X_ROT - 0.05, 45.55), [0, H_TRANSEPT], [Z_ROT1, Z_HALL1 + 0.05]);
  });
  box('crossing', 'centre', 'brick', [-X_ROT, X_ROT], [0, H_HALL], [Z_ROT1, Z_HALL1]);
  box('apse', 'centre', 'brick', [-45.55, 45.55], [0, H_APSE], [Z_APSE1 + 0.05, Z_ROT1 + 0.05]);
  // Lantern: octagonal drum and roof.
  const L = LANTERN, oct = k => [L.x + L.r * Math.cos((k + 0.5) * Math.PI / 4), L.z + L.r * Math.sin((k + 0.5) * Math.PI / 4)];
  b.prismY('lantern-drum', 'lantern', 'brick', Array.from({ length: 8 }, (_, k) => oct(k)).map(([x, z]) => [M(x), M(z)]), M(H_HALL - 0.1), M(L.wall));
  const eaveR = L.r + 1.0, apex = [M(L.x), M(L.apex), M(L.z)];
  const ring = Array.from({ length: 8 }, (_, k) => [M(L.x + eaveR * Math.cos((k + 0.5) * Math.PI / 4)), M(L.wall), M(L.z + eaveR * Math.sin((k + 0.5) * Math.PI / 4))]);
  b.convex('lantern-roof', 'lantern', 'tile', [...ring, apex], [ring.map((_, k) => k), ...ring.map((_, k) => [k, (k + 1) % 8, 8])]);
  // Small hipped roof lights: stair hall (R 535..560, 612..636 x 383..405), east block (R 290..345 x 280..325, 370..415, 460..505).
  const lights = [[-99.3, -90.8, -4.3, 3.1, H_HALL, 62.2], [-73.1, -65.0, -4.3, 3.1, H_HALL, 62.2],
    [-182.2, -163.6, 22.8, 38.0, H_APSE, 50.1], [-182.2, -163.6, -7.5, 7.5, H_APSE, 50.1], [-182.2, -163.6, -38.2, -23.0, H_APSE, 50.1],
    // transept lights: R 392.5..432.5 x rows 272.5..315 (and mirrored); CC 182.5 -> 50.1
    [-147.6, -134.0, 26.2, 40.6, H_TRANSEPT, 50.1], [-147.6, -134.0, -40.6, -26.2, H_TRANSEPT, 50.1]];
  lights.forEach(([z0, z1, x0, x1, h0, h1], k) => {
    const hip = Math.min(z1 - z0, x1 - x0) / 2;
    hipRoofFt(b, 'roof-light-' + (k + 1), 'skylights', 'glass', { x0, x1, z0, z1, soffit: h0 - 0.1, eave: h0 + 1.0, ridge: Math.min(h1, h0 + 1.0 + hip * 1.2) });
  });

  // ---- probes (DESIGN.md 5): first hit along each ray is the named dimension ------------------
  b.probe('front-face', 'Position of the front face above the middle arch', [0, M(53.0), M(60)], [0, 0, -1]);
  b.probe('buttress-face', 'Position of the face of a buttress between the arches', [M(14.43), M(30), M(60)], [0, 0, -1]);
  b.probe('wing-face', 'Position of the front face of the left wing, between its windows', [M(-67.8), M(30), M(60)], [0, 0, -1]);
  b.probe('porch-depth', 'Depth of the entrance porch (door line) in the middle arch', [M(-4.1), M(9), M(60)], [0, 0, -1]);
  b.probe('colonnade-front', 'Position of the front of the right colonnade (its beam)', [M(68), M(15.25), M(60)], [0, 0, -1]);
  b.probe('block-roof', 'Height of the central block roof (front slope, near the ridge)', [M(10), M(140), M(-18)], [0, -1, 0]);
  b.probe('block-eave', 'Height of the central block roof at the front eave', [M(10), M(140), M(3.6)], [0, -1, 0]);
  b.probe('range-roof', 'Height of the right range roof near its ridge', [M(73), M(140), M(-120)], [0, -1, 0]);
  b.probe('wing-roof', 'Height of the left wing roof (front slope)', [M(-70), M(140), M(-28)], [0, -1, 0]);
  b.probe('colonnade-roof', 'Height of the left colonnade roof (front slope)', [M(-68), M(140), M(-7.5)], [0, -1, 0]);
  b.probe('lantern-roof', 'Height of the lantern roof', [M(4), M(140), M(LANTERN.z)], [0, -1, 0]);
  b.probe('centre-roof', 'Height of the flat roof over the stair hall', [M(12), M(140), M(-82)], [0, -1, 0]);

  // ---- named dimensions (what the survey notes state) -----------------------------------------
  b.dimension('overall-length', 'Overall length, front face of the central block to the rear face of the corner blocks', [M(X_OUT), 0, M(Z_FRONT)], [M(X_OUT), 0, M(Z_EAST)], 'plan');
  b.dimension('overall-width', 'Overall width across the wings', [M(-X_OUT), 0, M(Z_WING)], [M(X_OUT), 0, M(Z_WING)], 'front');
  b.dimension('central-block-width', 'Width of the five-storey central block', [M(-X_BLOCK), M(30), M(Z_FRONT)], [M(X_BLOCK), M(30), M(Z_FRONT)], 'front');
  b.dimension('central-block-projection', 'Projection of the central block in front of the wings', [M(X_BLOCK), 0, M(Z_WING)], [M(X_BLOCK), 0, M(Z_FRONT)], 'plan');
  b.dimension('central-block-eave', 'Height to the eaves (underside of the overhang) of the central block', [M(X_BLOCK), 0, M(ZB1)], [M(X_BLOCK), M(H_BLOCK_SOFFIT), M(ZB1)], 'front');
  b.dimension('range-eave', 'Height to the eaves (underside of the overhang) of the wings and ranges', [M(X_OUT), 0, M(ZE_WING)], [M(X_OUT), M(H_EAVE), M(ZE_WING)], 'front');
  b.dimension('range-ridge', 'Height to the ridges of the wings and ranges', [M(XR), 0, M(ZR_WING)], [M(XR), M(H_RIDGE), M(ZR_WING)], 'front');
  b.dimension('central-block-ridge', 'Height to the ridge of the central block roof', [0, 0, M(-26.08)], [0, M(H_BLOCK_RIDGE), M(-26.08)], 'front');

  const roundDeep = v => Array.isArray(v) ? v.map(roundDeep) : typeof v === 'number' ? r4(v) : v;
  const parts = b.parts.map(part => Object.fromEntries(Object.entries(part).map(([k, v]) => [k, k === 'rotation' || typeof v === 'string' ? v : roundDeep(v)])));
  return validateModel({
    schema: MODEL_SCHEMA,
    id: 'green-library',
    archetype: 'real',
    title: 'Monumental masonry building with a five-storey arched central block, lower wings, front colonnades and hipped tile roofs',
    frame: {
      origin: 'On the ground at the foot of the entrance steps, on the centre line of the building: the front face of the five-storey central block (the face of its great arches and attic, between the buttresses) is the plane z = 0, x = 0 is the centre line, and the building extends towards -Z.',
      front: 'The front is the face with the three great arches, the entrance steps and the two colonnades; it faces +Z, and +X is to the right when you look at the front.',
    },
    scope_note: 'The building only: the walls and hipped tile roofs of the ranges and wings, the five-storey central block with its buttresses, great arches and windows, entrance porch, attic colonnettes, cornice and roof light, the entrance steps, the two gable-roofed colonnades in front of the wings up to their end walls, and the central roofs, courts, roof lights and lantern. ' +
      'Not part of it: the later building attached to the rear, the covered walk that continues a colonnade beyond its end wall, the fountain, its curved benches and the paved plaza, lamp posts, trees and planting, bicycles, carved figures and relief ornament, and the rooftop mechanical equipment.',
    materials: b.materials,
    groups: b.groups,
    probes: b.probes.map(q => ({ ...q, origin: roundDeep(q.origin) })),
    dimensions: b.dimensions.map(d => ({ id: d.id, label: d.label, value_m: r4(Math.hypot(...d.b.map((v, i) => v - d.a[i]))), a: roundDeep(d.a), b: roundDeep(d.b), view: d.view })),
    parts,
    meta: {
      source: 'Hand-authored from the 1995 measured survey drawings (16 sheets, 1024 px renders); see PROVENANCE.md',
      truth_uncertainty_m: 0.2,
      uncertain: { ring_ridge_m: 0.35, centre_roofs_m: 0.6 },
    },
  });
}

// ---- helpers ------------------------------------------------------------------------------

// Glazed light in a wall opening: a frame ring and a pane, set back from the face.
function windowIn(b, wf, id, group, o, { recess, frame }) {
  const fr = frame * FT, w0 = recess * FT, inner = o.inset(fr);
  wf.extrude(b, id + '.frame', group, 'frame', o.points(), w0, w0 + 0.1, [inner.points()]);
  const pane = o.inset(fr / 2);
  wf.extrude(b, id + '.glass', group, 'glass', pane.points(), w0 + 0.04, w0 + 0.06);
}

// Closed roof facet: the plan polygon (feet, [x, z]) lifted onto `height(x, z)`
// above a flat underside at `base`; sides are vertical. Adjacent facets share
// edges, so a roof is a set of facets tiling its plan.
function facet(b, id, group, material, polygon, height, base) {
  const n = polygon.length;
  const top = polygon.map(([x, z]) => [M(x), M(height(x, z)), M(z)]);
  const bottom = polygon.map(([x, z]) => [M(x), M(base), M(z)]);
  const tris = earClip(polygon);
  const triangles = [...tris.map(([a, c, d]) => [a, c, d]), ...tris.map(([a, c, d]) => [n + a, n + d, n + c])];
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; triangles.push([i, n + i, n + j], [i, n + j, j]); }
  return b.add({ id, type: 'mesh', vertices: [...top, ...bottom], triangles, material, group });
}

// Hipped roof (feet) over an eave rectangle; returns the surface height function.
function hipRoofFt(b, id, group, material, { x0, x1, z0, z1, soffit, eave, ridge }) {
  const half = Math.min(x1 - x0, z1 - z0) / 2, k = (ridge - eave) / half;
  const at = (x, z) => eave + k * Math.min(x - x0, x1 - x, z - z0, z1 - z, half);
  const alongX = x1 - x0 >= z1 - z0, xc = (x0 + x1) / 2, zc = (z0 + z1) / 2;
  const r0 = alongX ? [x0 + half, zc] : [xc, z0 + half], r1 = alongX ? [x1 - half, zc] : [xc, z1 - half];
  const v = [[x0, soffit, z0], [x1, soffit, z0], [x1, soffit, z1], [x0, soffit, z1], [x0, eave, z0], [x1, eave, z0], [x1, eave, z1], [x0, eave, z1],
    [r0[0], ridge, r0[1]], [r1[0], ridge, r1[1]]].map(([x, y, z]) => [M(x), M(y), M(z)]);
  const faces = [[0, 1, 2, 3], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  if (alongX) faces.push([4, 5, 9, 8], [6, 7, 8, 9], [7, 4, 8], [5, 6, 9]);
  else faces.push([4, 5, 8], [5, 6, 9, 8], [6, 7, 9], [7, 4, 8, 9]);
  b.convex(id, group, material, v, faces);
  return { at };
}

// Ear-clipping triangulation of a simple polygon given as [x, z] points.
function earClip(polygon) {
  const area = polygon.reduce((s, p, i) => { const q = polygon[(i + 1) % polygon.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0);
  const idx = polygon.map((_, i) => i);
  if (area < 0) idx.reverse();
  const cross = (o, a, c) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
  const inside = (p, a, c, d) => cross(a, c, p) >= -1e-9 && cross(c, d, p) >= -1e-9 && cross(d, a, p) >= -1e-9;
  const out = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 1000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = polygon[ia], c = polygon[ib], d = polygon[ic];
      if (cross(a, c, d) <= 1e-9) continue;
      if (idx.some(j => j !== ia && j !== ib && j !== ic && inside(polygon[j], a, c, d))) continue;
      out.push(area < 0 ? [ia, ic, ib] : [ia, ib, ic]);
      idx.splice(i, 1); clipped = true; break;
    }
    if (!clipped) throw new Error('earClip: polygon is not simple');
  }
  out.push(area < 0 ? [idx[0], idx[2], idx[1]] : [idx[0], idx[1], idx[2]]);
  return out;
}

export default model;

// Named positions for sheets.mjs and evidence.mjs (feet).
export const KEY = {
  Z_FRONT, Z_WING, Z_BLOCK, Z_EAST, X_OUT, X_BLOCK, H_EAVE, H_RIDGE, H_BLOCK_EAVE, H_BLOCK_RIDGE, H_BLOCK_SOFFIT, H_CORNICE, H_ATTIC,
  XE_OUT, ZE_WING, ZE_EAST, XR, ZR_WING, ZR_EAST, XE_IN, ZE_WING_IN, ZE_EAST_OUT, ZR_EASTR, ZE_EAST_IN, ZB0, ZB1, XB,
  BAYS, BUTTRESS_PROUD, CORNER_PIER, ARCH_TOP, WINDOW_HALF, WINDOW_SILL, WINDOW_TOP, H_PORCH_TOP, H_PORCH_FLOOR,
  WING_WINDOWS, WING_SILL, WING_TOP, PILASTER, COLONNADE, ATTIC_OPENINGS, H_ATTIC_OPEN, LANTERN, STEPS, FASCIA, X_HALL, X_ROT, Z_ROT1, TOWER,
  H_EAST_SOFFIT,
};
