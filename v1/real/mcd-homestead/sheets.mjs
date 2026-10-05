// Registration of the drawing sheets for verify (v1/lib/real/verify.mjs), and the
// main lines whose position the truth must reproduce. Sheet files are the
// key-sheet renders of the reference pack (3600 x 2400, 100 dpi), relative to
// the pack's planning-and-dimensions/key-sheets/ directory.
//
// Anchors. Scale: elevations are drawn at 3/16" = 1'-0" and rendered at 100 dpi,
// so 18.75 px/ft (the two plan sheets confirm the render: A1.0A's graphic scale
// gives 25.03 px/ft for 1/4" = 1'-0", A1.0B's printed 40'-4" gives 25.00); plans
// take their scale from the graphic scale bar or a printed dimension. Offsets:
// the rows of the printed datum leaders (T/SLAB, B/WINDOW +3'-1", B/CANOPY
// +9'-0", T/WINDOW +14'-5", T/PARAPET +18'-10", T/PLAY PLACE +20'-6") for the
// height, one building end for the position along the facade, one wall face per
// axis on a plan. The datum residuals show how well the drawn datums agree with
// the printed scale (within a pixel or two). `at` / `span` are expected positions in metres in the
// sheet's view (front: u = x; right: u = distance north of the front wall;
// left: u = z; rear: u = -x; plan: u = z, v = x); the line itself is found in
// the render and on the sheet (see verify.mjs).
import { ft, KEY } from './model.mjs';

const { T, L, xE, xWS, xWM, xWN, STEP_SOUTH, STEP_NORTH, JUNCTION, TOWER0, TOWER1, PILASTER0, PILASTER1, DT_BAY1_END,
  H_TALL, H_MAIN, RB_EAST, RB_WEST, CANOPY_UNDER, DT_UNDER, UPPER_HEAD, LOWER_HEAD, SOUTH_LOWER_HEAD, B_WINDOW, BATTEN_PROUD: P } = KEY;
const row = (v, py, note) => ({ type: 'row', v, py, note });
const ELEVATION_SCALE = { type: 'scale', metres: 0.3048, pixels: 18.75, exact: true, note: '3/16" = 1\'-0" at 100 dpi' };
const col = (u, px, note) => ({ type: 'col', u, px, note });
const h = (id, label, at, span, extra = {}) => ({ id, label, axis: 'h', at, span, ...extra });
const v = (id, label, at, span, extra = {}) => ({ id, label, axis: 'v', at, span, ...extra });

export const SHEETS = [
  {
    id: 'a2-0-front', title: 'A2.0 proposed front elevation (south)', file: '04-south-front-and-north-rear-elevations.jpg', view: 'front',
    crop: { x: 440, y: 1200, width: 1020, height: 445 },
    anchors: [ELEVATION_SCALE, row(0, 1625, 'T/SLAB +0\'-0"'), row(ft(3, 1), 1567, 'B/WINDOW +3\'-1"'), row(ft(9, 0), 1457, 'B/CANOPY +9\'-0"'),
      row(ft(10, 11), 1421, 'B/DT. CANOPY +10\'-11"'), row(ft(18, 10), 1271, 'T/PARAPET WALL +18\'-10"'), row(ft(20, 6), 1241, 'T/PLAY PLACE +20\'-6"'),
      col(xE, 1372, 'right end of the front block'), col(xWS, 672, 'left end of the front block (A2.0 draws the block 37\'-4" wide, without the battens\' side projection)')],
    lines: [
      h('front-block-top', 'Top of the front block', H_TALL, [-2.5, 0.5]),
      h('upper-head', 'Head of the upper windows', UPPER_HEAD, [-2, 2]),
      h('canopy-underside', 'Underside of the front canopy', CANOPY_UNDER, [-2, 2], { search_m: 0.06 }),
      h('lower-head', 'Head of the lower windows', SOUTH_LOWER_HEAD, [-2, 2], { search_m: 0.06 }),
      h('lower-sill', 'Sill of the lower windows', B_WINDOW, [-2, 2]),
      h('step-parapet', 'Parapet of the wider block behind', H_MAIN, [-7.5, -6.1]),
      h('dt-canopy-underside', 'Underside of the drive-through canopy (end on)', DT_UNDER, [-8.7, -7.85], { search_m: 0.1 }),
      v('front-block-left', 'Left end of the front block', xWS - P, [3.4, 5.6]),
      v('band-left', 'Left end of the window bands', ft(-10, -1.5), [1.2, 2.4]),
      v('band-right', 'Right end of the window bands', ft(16, 7), [1.2, 2.4]),
      v('mullion-2', 'Second mullion', ft(3, 4), [3.2, 4.2], { search_m: 0.1 }),
      v('wide-block-left', 'Left end of the wider block behind', xWM, [0.4, 2.6]),
    ],
  },
  {
    id: 'a2-1a-right', title: 'A2.1A proposed right side elevation (east), front part', file: '05-east-non-drive-thru-elevation-a.jpg', view: 'right',
    crop: { x: 520, y: 1180, width: 2310, height: 440 },
    anchors: [ELEVATION_SCALE, row(ft(3, 1), 1539, 'B/WINDOW +3\'-1"'), row(ft(9, 0), 1429, 'B/CANOPY +9\'-0"'), row(ft(14, 5), 1328, 'T/WINDOW +14\'-5"'),
      row(ft(20, 6), 1214, 'T/PLAY PLACE +20\'-6"'), col(-P, 567, 'front end (corner battens)')],
    lines: [
      h('ground', 'Ground line', 0, [5, 20]),
      h('front-block-top', 'Top of the front block', H_TALL, [3, 9]),
      h('main-parapet', 'Top of the main parapet', H_MAIN, [14, 20]),
      h('tower-top', 'Top of the entrance tower', H_TALL, [22, 25.5]),
      h('canopy-underside-block', 'Underside of the front-block canopy', CANOPY_UNDER, [3, 10]),
      h('canopy-underside-main', 'Underside of the main canopy', CANOPY_UNDER, [13, 20]),
      h('reveal-band', 'Bottom of the reveal-panel band', RB_EAST, [17, 20]),
      h('upper-head', 'Head of the upper windows', UPPER_HEAD, [2, 10]),
      h('lower-head', 'Head of the lower windows', LOWER_HEAD, [2, 8]),
      h('lower-sill', 'Sill of the first lower window', B_WINDOW, [1.1, 2.9]),
      v('front-block-rear', 'Rear end of the front block', JUNCTION, [3.2, 4.8]),
      v('upper-band-end', 'End of the upper window band', ft(37, 2.5), [3.2, 4.3]),
      v('lower-band-end', 'End of the lower window band', ft(29, 3.5), [1.0, 2.3]),
      v('exit-door', 'Exit door (front jamb)', ft(39, 10), [0.3, 2.0], { search_m: 0.12 }),
      v('window-1', 'First dining window (front jamb)', ft(52, 11.5), [0.4, 2.3]),
      v('tower-front', 'Front edge of the entrance tower', TOWER0, [3.2, 5.6]),
      v('tower-rear', 'Rear edge of the entrance tower', TOWER1, [3.2, 5.6]),
      v('entrance', 'Entrance opening (front jamb)', ft(73, 0.5), [0.3, 2.3]),
      v('window-2', 'Second dining window (front jamb)', ft(89, 4.5), [0.4, 2.3]),
      v('pilaster', 'Front edge of the flush pilaster', PILASTER0, [3.2, 5.5]),
    ],
  },
  {
    id: 'a2-1b-right', title: 'A2.1B proposed right side elevation (east), rear part', file: '06-east-non-drive-thru-elevation-b.jpg', view: 'right',
    crop: { x: 620, y: 1180, width: 1430, height: 430 },
    anchors: [ELEVATION_SCALE, row(0, 1598, 'T/SLAB +0\'-0"'), row(ft(18, 10), 1243, 'T/PARAPET WALL +18\'-10"'), row(ft(20, 6), 1213, 'T/PARAPET WALL +20\'-6"'),
      col(L, 1970, 'rear end')],
    lines: [
      h('main-parapet', 'Top of the main parapet', H_MAIN, [40, 46]),
      h('fin-top', 'Top of the rear corner battens', H_TALL, [48.6, 49.3]),
      h('reveal-band', 'Bottom of the reveal-panel band', RB_EAST, [40, 46]),
      v('pilaster-front', 'Front edge of the flush pilaster', PILASTER0, [3.2, 5.5]),
      v('pilaster-rear', 'Rear edge of the flush pilaster', PILASTER1, [3.2, 5.5]),
      v('door-1-front', 'Service door 1 (front jamb)', L - ft(20, 6), [0.3, 2.0], { search_m: 0.1 }),
      v('door-1-rear', 'Service door 1 (rear jamb)', L - ft(16, 2), [0.3, 2.0], { search_m: 0.1 }),
      v('door-2-front', 'Service door 2 (front jamb)', L - ft(7, 9), [0.3, 2.0], { search_m: 0.1 }),
      v('corner-battens', 'Front edge of the rear corner battens', L - ft(3, 10), [5.8, 6.15], { search_m: 0.35 }),
    ],
  },
  {
    id: 'a2-2a-left', title: 'A2.2A proposed left side elevation (west, drive-through), front part', file: '07-west-drive-thru-elevation-a.jpg', view: 'left',
    crop: { x: 690, y: 1150, width: 2240, height: 440 },
    // The sheet's top datum is labelled T/PLAY PLACE +23'-0"; it is left out of the
    // fit and its row (1191) is reported as a residual line ('typo-datum').
    anchors: [ELEVATION_SCALE, row(ft(3, 1), 1517, 'B/WINDOW +3\'-1"'), row(ft(9, 0), 1406, 'B/CANOPY +9\'-0"'), row(ft(14, 5), 1305, 'T/WINDOW +14\'-5"'),
      col(P, 2886, 'front end (corner battens)')],
    lines: [
      h('ground', 'Ground line', 0, [-22, -14]),
      h('front-block-top', 'Top of the front block (sheet label says +23\'-0")', H_TALL, [-9, -3]),
      h('main-parapet', 'Top of the main parapet', H_MAIN, [-22, -20.5]),
      h('dt-bay-top', 'Top of the drive-through bay', H_TALL, [-27, -24.5]),
      h('canopy-underside-block', 'Underside of the front-block canopy', CANOPY_UNDER, [-10, -2]),
      h('canopy-underside-main', 'Underside of the left-side canopy', DT_UNDER, [-17, -13]),
      h('upper-head', 'Head of the upper windows', UPPER_HEAD, [-10, -2]),
      h('lower-head', 'Head of the lower windows', LOWER_HEAD, [-10, -2]),
      h('reveal-band', 'Bottom of the reveal-panel band', RB_WEST, [-22, -20.5]),
      v('front-block-rear', 'Rear end of the front block', -JUNCTION, [3.7, 5.5]),
      v('upper-band-end', 'End of the upper window band', -ft(36, 3), [3.2, 4.3]),
      v('exit-door', 'Exit door (rear jamb)', -ft(42, 9), [0.3, 2.0], { search_m: 0.12 }),
      v('window', 'Dining window (rear jamb)', -ft(62, 1), [0.4, 2.3], { search_m: 0.1 }),
      v('batten-strip', 'Rear edge of the batten strip', -ft(64, 7), [3.8, 5.5]),
      v('dt-bay-front', 'Front edge of the drive-through bay', -STEP_SOUTH, [5.8, 6.15]),
      v('dt-bay-rear', 'Rear edge of the drive-through bay', -DT_BAY1_END, [0.3, 3.0]),
      v('dt-window', 'Drive-through window (rear jamb)', -ft(87, 5), [1.1, 2.4]),
    ],
  },
  {
    id: 'a2-2b-left', title: 'A2.2B proposed left side elevation (west, drive-through), rear part', file: '08-west-drive-thru-elevation-b.jpg', view: 'left',
    crop: { x: 1100, y: 1150, width: 1480, height: 440 },
    anchors: [ELEVATION_SCALE, row(0, 1580, 'T/SLAB +0\'-0"'), row(ft(18, 10), 1225, 'T/PARAPET WALL +18\'-10"'), row(ft(20, 6), 1192, 'T/PARAPET WALL +20\'-6"'),
      col(-L, 1216, 'rear end')],
    lines: [
      h('ground', 'Ground line', 0, [-46, -40]),
      h('main-parapet', 'Top of the main parapet', H_MAIN, [-46, -42]),
      h('fin-top', 'Top of the rear corner battens', H_TALL, [-49.3, -47.3]),
      h('dt-bay-top', 'Top of the drive-through bay', H_TALL, [-37.8, -36.6]),
      h('reveal-band', 'Bottom of the reveal-panel band', RB_WEST, [-46, -42]),
      v('corner-battens', 'Front edge of the rear corner battens', -L + ft(8, 1.5), [5.8, 6.15]),
      v('dt-bay-rear', 'Rear edge of the drive-through bay', -(L - STEP_NORTH), [5.8, 6.15]),
      v('dt-bay-front', 'Front edge of the drive-through bay', -(L - ft(41, 6)), [5.8, 6.15]),
      v('high-window', 'High window (front jamb)', -(L - ft(32, 10.5)), [1.95, 2.4], { search_m: 0.08 }),
      v('dt-window', 'Drive-through window (front jamb)', -(L - ft(39, 9)), [1.1, 2.4], { search_m: 0.12 }),
    ],
  },
  {
    id: 'a2-0-rear', title: 'A2.0 proposed rear elevation (north)', file: '04-south-front-and-north-rear-elevations.jpg', view: 'rear',
    crop: { x: 2060, y: 1190, width: 1010, height: 450 },
    anchors: [ELEVATION_SCALE, row(0, 1626, 'T/SLAB +0\'-0"'), row(ft(9, 0), 1457, 'B/ CANOPY +9\'-0"'), row(ft(10, 11), 1421, 'B/DT. CANOPY +10\'-11"'),
      row(ft(18, 10), 1272, 'T/PARAPET WALL +18\'-10"'), row(ft(20, 6), 1237, 'T/ PARAPET WALL +20\'-6"'), col(-(xE + P), 2195, 'right-side end (corner battens)')],
    lines: [
      h('ground', 'Ground line', 0, [-3, 3]),
      h('main-parapet', 'Top of the main parapet', H_MAIN, [-3, 3]),
      h('reveal-band', 'Bottom of the reveal-panel band', RB_WEST, [-3, 3]),
      v('left-end', 'Left-side end of the rear wall', -xWN, [0.5, 3.0]),
      v('door-double', 'Double door (right jamb as seen)', -xE + ft(27, 7.5), [0.3, 2.0], { search_m: 0.12 }),
      v('door-single', 'Single door (left jamb as seen)', -xE + ft(36, 10.5), [0.3, 2.0], { search_m: 0.12 }),
      v('booth-end', 'Left-side end of the wider block', -xWM, [0.5, 3.0], { search_m: 0.12 }),
      // The truth raises the drive-through bay to +20'-6" as A2.2B and both right-side
      // sheets draw it; this sheet draws the bay's end wall at the +18'-10" parapet.
      h('booth-top', 'Top of the drive-through bay end wall', H_TALL, [7.0, 7.6], { search_m: 0.1, sheet_at: H_MAIN }),
    ],
  },
  {
    id: 'a1-0a-plan', title: 'A1.0A floor plan (rear part), roof outline over it', file: '02-main-floor-plan.jpg', view: 'plan-north-left',
    crop: { x: 340, y: 270, width: 2920, height: 1380 },
    anchors: [{ type: 'scale', metres: ft(16, 0), pixels: 3174 - 2773.5, exact: true, note: 'graphic scale 0..16 ft' },
      col(-L, 372, 'rear wall, outer face'), row(xE, 405, 'right wall, outer face')],
    lines: [
      h('left-wall-rear', 'Left wall, rear part', xWN, [-48, -40], { search_m: 0.2 }),
      h('left-wall-drive-thru', 'Left wall, widest part', xWM, [-35, -27], { search_m: 0.2 }),
      h('left-wall-front', 'Left wall beside the dining room', xWS, [-22, -16], { search_m: 0.2 }),
      v('step-front', 'Step between the widest part and the dining room', -STEP_SOUTH, [-7.5, -6.0], { search_m: 0.2 }),
      v('step-rear', 'Cash-booth step', -(L - STEP_NORTH), [-7.5, -7.0], { search_m: 0.2 }),
      h('canopy-right-2', 'Outer edge of a right-side canopy', xE + ft(4, 0), [-30, -27.5], { min_ink: 0.3 }),
      h('canopy-right-1', 'Outer edge of the main right-side canopy', xE + ft(4, 0), [-20, -16], { min_ink: 0.3 }),
      h('canopy-dt-1', 'Outer edge of the drive-through canopy', xWM - ft(4, 4.5), [-26.5, -24.5], { min_ink: 0.3 }),
    ],
  },
  {
    id: 'a1-0b-plan', title: 'A1.0B floor plan (front part), roof outline over it', file: '03-playplace-floor-plan.jpg', view: 'plan-north-left',
    crop: { x: 300, y: 380, width: 1450, height: 1100 },
    anchors: [{ type: 'scale', metres: ft(40, 4), pixels: 1436 - 427.7, exact: true, note: 'printed 40\'-4" between its ticks' },
      col(0, 1650, 'front wall, outer face'), row(xE, 464, 'right wall, outer face')],
    lines: [
      h('left-wall-block', 'Left wall of the front block', xWS, [-10, -2], { search_m: 0.2 }),
      h('left-wall-dining', 'Left wall of the dining room', xWS, [-15.5, -13], { search_m: 0.2 }),
      h('right-wall-dining', 'Right wall of the dining room', xE, [-15.5, -13], { search_m: 0.2 }),
      h('canopy-right-block', 'Outer edge of the right front-block canopy', xE + ft(1, 6), [-10, -2], { min_ink: 0.3 }),
      h('canopy-left-block', 'Outer edge of the left front-block canopy', xWS - ft(1, 6), [-10, -2], { min_ink: 0.3 }),
      v('canopy-front', 'Outer edge of the front canopy', ft(1, 6), [-4, 4], { min_ink: 0.3 }),
      // The truth follows A2.1A here (37'-2 1/2"); this sheet prints 37'-7 1/4" less 1'-6", i.e. 36'-1 1/4".
      v('canopy-right-block-end', 'Rear end of the right front-block canopy', -ft(37, 2.5), [5.75, 6.1], { min_ink: 0.3, search_m: 0.12, sheet_at: -ft(36, 1.25) }),
      v('canopy-left-block-end', 'Rear end of the left front-block canopy', -ft(36, 4), [-6.1, -5.75], { min_ink: 0.3, search_m: 0.3 }),
    ],
  },
];
