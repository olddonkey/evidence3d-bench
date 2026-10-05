// Registration of the survey sheets for verify (v1/lib/real/verify.mjs), and the
// main lines whose position the truth must reproduce. Sheet files are the 1024 px
// renders of the survey sheets, relative to the pack's official-docs/habs-sheets/
// directory.
//
// Anchors. These renders carry no usable printed scale (the graphic scale bars
// are 75 px long and their ticks 1 px apart from their digits), and the renders
// of different sheets differ in scale by up to 1.5 %, so every sheet is
// registered on its own printed numbers and the scale is fitted, not held:
// - elevations: the rows of the printed level datums (GROUND 88'-10", MAIN
//   103'-10", MEZZANINE 118'-10", FOURTH 129'-4", FIFTH 136'-4" (136'-4 1/2" on
//   sheet 16), BASEMENT 79'-10", stack tiers W1..W7 = 81'-4" + 7'-6" steps), and
//   two building ends whose distance is printed on the plans (182'-0" across the
//   wings, 231'-0" and 19'-0" along the building);
// - the roof plan: the extension lines of its printed dimension strings
//   (182'-0" + 30'-0" + 19'-0" east-west, 45'-0" + 92'-0" + 45'-0" north-south).
// The anchor residuals (within 1-2 px) show how well the drawn datums and ends
// agree with one uniform scale. `at` / `span` are expected positions in metres
// in the sheet's view (front: u = x; left: u = z; right: u = -z; rear: u = -x;
// plan: u = z, v = x); the line itself is found in the render and on the sheet.
//
// Choice of lines. verify.mjs marks a truth edge wherever the depth steps by more
// than 4 cm between neighbouring pixels; on these sheets a pixel is ~0.1 m, so
// every pixel of a sloped tile roof is an "edge" (27-31 degree pitch). A line
// whose one side is roof would be pulled into the roof, so eaves are measured at
// their soffit (the foot of the fascia, wall below it) in elevation, and with a
// search window of 0.6 ft (under 2 px) on the roof plan, where every eave has
// roof on one side. Ridges in elevation are left out for the same reason; their
// heights are checked against all four elevations in PROVENANCE.md.
import { FT, level, KEY } from './model.mjs';

const m = ft => ft * FT;
const { Z_WING, Z_EAST, X_OUT, X_BLOCK, H_EAVE, H_RIDGE, H_BLOCK_SOFFIT, H_CORNICE, XE_OUT, ZE_WING, ZE_EAST, XE_IN, ZE_EAST_OUT,
  ZB0, ZB1, XB, BAYS, CORNER_PIER, WING_WINDOWS, COLONNADE, H_ATTIC, X_HALL, X_ROT, TOWER, H_EAST_SOFFIT } = KEY;
const SOFFIT = H_EAVE;                  // the drawn eave line is the lower edge of the overhang
const datum = (elev, py, note) => ({ type: 'row', v: m(level(elev)), py, note });
const row = (vFt, py, note) => ({ type: 'row', v: m(vFt), py, note });
const col = (uFt, px, note) => ({ type: 'col', u: m(uFt), px, note });
const h = (id, label, atFt, spanFt, extra = {}) => ({ id, label, axis: 'h', at: m(atFt), span: spanFt.map(m), ...extra, ...(extra.search_ft ? { search_m: m(extra.search_ft) } : {}) });
const v = (id, label, atFt, spanFt, extra = {}) => ({ id, label, axis: 'v', at: m(atFt), span: spanFt.map(m), ...extra, ...(extra.search_ft ? { search_m: m(extra.search_ft) } : {}) });
const LEVELS = (rows, fifth = 136.333) => [
  datum(fifth, rows[0], 'FIFTH LEVEL'), datum(129.333, rows[1], 'FOURTH LEVEL 129\'-4"'), datum(118.833, rows[2], 'MEZZANINE 118\'-10"'),
  datum(103.833, rows[3], 'MAIN LEVEL 103\'-10"'), datum(88.833, rows[4], 'GROUND LEVEL 88\'-10"'), datum(79.833, rows[5], 'BASEMENT 79\'-10"')].filter(a => a.py !== null);
const TIERS = rows => rows.map((py, k) => datum(81.333 + 7.5 * k, py, 'W' + (k + 1) + ' TIERED STACKS'));

export const SHEETS = [
  {
    id: 'w-elevation', title: 'Sheet 15, west elevation (the front)', file: 'sheet-15.jpg', view: 'front',
    crop: { x: 200, y: 40, width: 620, height: 262 },
    anchors: [...LEVELS([142.09, 163.00, 193.14, 237.00, 280.23, 306.92]),
      col(-X_OUT, 240.0, 'north face of the wings (182\'-0")'), col(X_OUT, 772.0, 'south face of the wings (182\'-0")')],
    lines: [
      h('block-soffit', 'Soffit of the central block eaves', H_BLOCK_SOFFIT, [-30, -20], { search_ft: 1 }),
      h('cornice', 'Foot of the cornice', H_CORNICE, [-30, -20], { search_ft: 1 }),
      h('attic-openings', 'Foot of the attic openings', H_ATTIC + 0.1, [-36, -21], { search_ft: 2 }),
      h('wing-soffit-left', 'Soffit of the left wing eaves', SOFFIT, [-88, -52], { search_ft: 1 }),
      h('wing-soffit-right', 'Soffit of the right wing eaves', SOFFIT, [52, 88], { search_ft: 1 }),
      h('wing-ridge', 'Ridge of the left wing roof (silhouette)', H_RIDGE, [-64, -50], { search_ft: 1 }),
      h('colonnade-eave-left', 'Eave of the left colonnade', COLONNADE.soffit, [-84, -56], { search_ft: 1 }),
      h('colonnade-eave-right', 'Eave of the right colonnade', COLONNADE.soffit, [56, 84], { search_ft: 1 }),
      v('buttress-1a', 'Buttress, left face', BAYS[0][1], [25, 40]),
      v('buttress-1b', 'Buttress, right face', BAYS[1][0], [25, 40]),
      v('buttress-2a', 'Buttress, left face', BAYS[1][1], [25, 40]),
      v('buttress-2b', 'Buttress, right face', BAYS[2][0], [25, 40]),
      v('corner-buttress-left', 'Left corner buttress, inner face', -CORNER_PIER.x0, [25, 40]),
      v('corner-buttress-right', 'Right corner buttress, inner face', CORNER_PIER.x0, [25, 40]),
      v('block-left', 'Left side of the central block', -CORNER_PIER.xSide, [25, 40], { search_ft: 1.5 }),
      v('corner-pier-left', 'Left corner pier, outer face', -CORNER_PIER.x1, [52, 60], { search_ft: 1.5, min_ink: 0.3 }),
      v('corner-pier-right', 'Right corner pier, outer face', CORNER_PIER.x1, [52, 60], { search_ft: 1.5, min_ink: 0.3 }),
      // Window jambs: on the left wing the right-hand jambs are drawn dark (a shadow line); the other jambs, and the
      // right wing's, are too light for the ink test.
      v('wing-window-1', 'Outer left wing window, right jamb', -WING_WINDOWS[1][0], [27, 35], { search_ft: 1.5, min_ink: 0.3 }),
      v('wing-window-2', 'Inner left wing window, right jamb', -WING_WINDOWS[0][0], [27, 35], { search_ft: 1.5, min_ink: 0.3 }),
      v('colonnade-end-left', 'End wall of the left colonnade', -COLONNADE.x1, [2, 12], { search_ft: 1.5 }),
      v('colonnade-end-right', 'End wall of the right colonnade', COLONNADE.x1, [2, 12], { search_ft: 1.5 }),
    ],
  },
  {
    id: 'roof-plan', title: 'Sheet 10, roof plan', file: 'sheet-10.jpg', view: 'plan-north-left',
    crop: { x: 100, y: 40, width: 790, height: 650 },
    anchors: [col(Z_EAST, 146.0, 'east end (231\'-0")'), col(-49, 683.0, '30\'-0" / 182\'-0"'), col(Z_WING, 771.0, '19\'-0" / 30\'-0"'), col(0, 827.8, 'front (19\'-0")'),
      row(X_OUT, 124.0, 'south face (45\'-0")'), row(X_BLOCK, 257.0, '45\'-0" / 92\'-0"'), row(-X_BLOCK, 528.0, '92\'-0" / 45\'-0"'), row(-X_OUT, 660.5, 'north face (45\'-0")')],
    lines: [
      h('south-eave', 'Outer eave of the right range', XE_OUT, [-200, -60], { search_ft: 0.6 }),
      h('north-eave', 'Outer eave of the left range', -XE_OUT, [-200, -60], { search_ft: 0.6 }),
      h('south-inner-eave', 'Inner eave of the right range', XE_IN, [-180, -130], { search_ft: 0.6 }),
      h('block-eave-s', 'Right eave of the central block roof', XB, [-45, -5], { search_ft: 0.6 }),
      h('block-eave-n', 'Left eave of the central block roof', -XB, [-45, -5], { search_ft: 0.6 }),
      h('stair-hall-s', 'Right edge of the stair hall roof', X_HALL, [-110, -62], { search_ft: 1, min_ink: 0.25 }),
      h('crossing-s', 'Right edge of the crossing roof', X_ROT, [-160, -150], { search_ft: 1 }),
      v('wing-eave-s', 'Front eave of the right wing', ZE_WING, [60, 88], { search_ft: 0.6 }),
      v('wing-eave-n', 'Front eave of the left wing', ZE_WING, [-88, -60], { search_ft: 0.6 }),
      v('block-eave-front', 'Front eave of the central block roof', ZB1, [-40, 40], { search_ft: 0.6 }),
      v('block-eave-rear', 'Rear eave of the central block roof', ZB0, [-25, 25], { search_ft: 0.6 }),
      v('corner-eave-s', 'Rear eave of the right corner block', ZE_EAST, [50, 90], { search_ft: 0.6 }),
      v('corner-eave-n', 'Rear eave of the left corner block', ZE_EAST, [-90, -50], { search_ft: 0.6 }),
      v('east-range-eave', 'Rear eave of the rear range', ZE_EAST_OUT, [-30, 30], { search_ft: 0.6 }),
      v('colonnade-front-s', 'Front edge of the right colonnade roof', COLONNADE.zOut, [60, 85], { search_ft: 0.6 }),
    ],
  },
  {
    id: 'n-elevation', title: 'Sheet 15, north elevation (the left side)', file: 'sheet-15.jpg', view: 'left',
    crop: { x: 130, y: 420, width: 740, height: 252 },
    anchors: [...LEVELS([507.00, 528.01, 558.00, 602.00, 645.73, 672.01]),
      col(Z_EAST, 165.0, 'east face (231\'-0")'), col(Z_WING, 784.0, 'west face of the wing (19\'-0")')],
    lines: [
      h('soffit', 'Soffit of the left range eaves', SOFFIT, [-200, -40], { search_ft: 1 }),
      h('block-soffit', 'Soffit of the central block eaves (behind)', H_BLOCK_SOFFIT, [-40, -5], { search_ft: 1.5 }),
    ],
  },
  {
    id: 's-elevation', title: 'Sheet 16, south elevation (the right side)', file: 'sheet-16.jpg', view: 'right',
    crop: { x: 140, y: 420, width: 760, height: 300 },
    anchors: [...TIERS([704.05, 682.06, 660.04, 638.04, 616.01, 594.02, 572.00]), ...LEVELS([544.95, 565.00, 596.00, 640.00, 683.99, 709.99], 136.375),
      col(-Z_EAST, 853.12, 'east face (231\'-0")'), col(-Z_WING, 228.95, 'west face of the wing (19\'-0")')],
    lines: [
      h('soffit', 'Soffit of the right range eaves', SOFFIT, [40, 200], { search_ft: 1 }),
      h('block-soffit', 'Soffit of the central block eaves', H_BLOCK_SOFFIT, [5, 40], { search_ft: 1.5 }),
      v('colonnade-end-front', 'Front face of the right colonnade end wall', -(COLONNADE.zEnd), [2, 12], { search_ft: 1.5 }),
      v('tower-rear', 'Rear face of the stair tower', -(TOWER.z0 + 1), [66, 70], { search_ft: 1.5, min_ink: 0.3 }),
    ],
  },
  {
    id: 'e-elevation', title: 'Sheet 16, east elevation (the rear)', file: 'sheet-16.jpg', view: 'rear',
    crop: { x: 200, y: 60, width: 640, height: 290 },
    anchors: [...TIERS([336.19, 314.12, 292.37, 270.90, 248.85, 226.96, 204.93]), ...LEVELS([null, 195.02, 226.01, 269.04, 313.00, null]),
      col(-X_OUT, 251.98, 'south face (182\'-0")'), col(X_OUT, 786.00, 'north face (182\'-0")')],
    lines: [
      h('corner-soffit-s', 'Soffit of the right corner block eaves', SOFFIT, [-88, -50], { search_ft: 1 }),
      h('corner-soffit-n', 'Soffit of the left corner block eaves', SOFFIT, [50, 88], { search_ft: 1 }),
      h('rear-range-soffit', 'Soffit of the rear range eaves', H_EAST_SOFFIT, [-30, 30], { search_ft: 1.5 }),
    ],
  },
];
