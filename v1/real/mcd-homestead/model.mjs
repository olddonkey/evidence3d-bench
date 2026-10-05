// Truth model of a real building: a single-storey drive-through restaurant with
// a taller glazed front block (a children's play room), authored by hand from the
// approved planning-application drawing set (2018, eleven sheets). The
// contestant never sees the drawings; the photographs are the evidence.
//
// Every number below was read off a sheet. Printed dimensions are quoted as
// printed; everything else was scaled off the 100 dpi renders of the sheets:
// plans at 25.0 px/ft (A1.0A scale bar 0..16 ft = 400.5 px), elevations at
// 18.73-18.78 px/ft (each sheet registered on its own printed datums, e.g. A2.1A
// T/SLAB 1598, +3'-1" 1539, +9'-0" 1429, +14'-5" 1328, +20'-6" 1214). A reading
// "A2.1A x 1308.5" is a sheet pixel column; elevation positions along a facade are
// measured from that sheet's building end. PROVENANCE.md lists every reading,
// the conflicts between sheets and which one was believed.
//
// Frame (DESIGN.md 3): metres, +Y up; the front is the south elevation, facing
// the street, and faces +Z; +X is east. Origin on the ground at the midpoint of
// the front wall. The east wall is one straight line; all width changes are on
// the west (drive-through) side.
import { ModelBuilder, wallFrame, wall, opening, doorOpening, r4 } from '../../lib/generator/kit.mjs';
import { MODEL_SCHEMA, validateModel } from '../../lib/model.mjs';

const FT = 0.3048, IN = 0.0254;
export const ft = (feet, inches = 0) => feet * FT + inches * IN;

// ---- plan (A1.0A main floor plan, A1.0B front-block plan, both 1/4" = 1'-0") ----
const T = ft(0, 10.5);                 // wall thickness: A1.0A east 405->427, west 1414->1435, 1481->1504 (21-23 px = 0.84-0.92 ft)
const W_SOUTH = ft(40, 4) - 2 * ft(1, 6); // A1.0B printed 40'-4" between canopy edges less the printed 1'-6" each side = 37'-4"; scaled 464->1398 = 37.36 ft
const W_MIDDLE = ft(44, 0);            // A1.0A scaled 405->1504 = 1099 px = 43.96 ft
const BOOTH_STEP = ft(2, 9.5);         // A1.0A printed 2'-9 1/2" (cash-booth expansion, 1434->1504)
const W_NORTH = W_MIDDLE - BOOTH_STEP; // = 41'-2 1/2"; A1.0A scaled 405->1435 = 41.20 ft
const L = ft(162, 5.5);                // A1.0A north wall 372 -> match line 3150.5 = 111.14 ft, A1.0B match line 367 -> south wall 1650 = 51.32 ft; 162.46 ft
const STEP_SOUTH = L - ft(84, 9);      // middle/south step: A1.0A 372->2491 = 84.76 ft from the north wall (A2.2A DT bay edge 77.60 ft from the south)
const STEP_NORTH = ft(33, 4.5);        // cash-booth step from the north wall: A1.0A 372->1206 = 33.36 ft; A2.2B 1216->1843 = 33.44 ft

const xE = W_SOUTH / 2;                // east wall face; the front wall is centred on x = 0
const xWS = xE - W_SOUTH, xWM = xE - W_MIDDLE, xWN = xE - W_NORTH;

// ---- heights (elevation datums as printed, otherwise scaled) ----
const H_TALL = ft(20, 6);              // T/PLAY PLACE and T/PARAPET +20'-6" (A2.0, A2.1A, A2.1B, A2.2B; A2.2A prints +23'-0" but its own datums put the line at 20.50 ft)
const H_MAIN = ft(18, 10);             // T/PARAPET WALL +18'-10" (A2.0, A2.1B, A2.2B)
// Roof decks are on no sheet (the set has no roof plan or section). The new
// parapets were built on the existing walls: the existing mansard top (A2.0
// EXISTING, T/PARAPET +16'-2") bounds the old flat roof from above, and the old
// front-block eave was at B/OVERHANG +16'-8" (A2.2A EXISTING). Uncertainty 0.5 m.
const DECK_MAIN = ft(16, 2);
const DECK_FRONT = ft(16, 8);
const RB_EAST = ft(9, 8);              // bottom of the reveal-panel band, east: A2.1A rows 1416/1417 -> 9.69 ft
const RB_WEST = ft(11, 7);             // same, west, north and step walls: A2.2A 1357.5 -> 11.61, A2.0 rear 1407 -> 11.64, A2.0 step 1408 -> 11.59 ft
const CANOPY_UNDER = ft(9, 0);         // B/CANOPY +9'-0" (A2.0, A2.1A, A2.2A)
const CANOPY_FRONT_TOP = ft(10, 0);    // A2.1A row 1410 -> 10.04, A2.0 1437.5 -> 10.01, A2.2A 1388 -> 9.98 ft
const CANOPY_EAST_TOP = RB_EAST;       // east main canopies: fascia 1416.5..1429.5 on A2.1A, top on the reveal-band line
const DT_UNDER = ft(10, 11);           // B/DT. CANOPY +10'-11" (A2.0); west canopies A2.2A 1370.5 -> 10.92 ft
const DT_TOP = ft(11, 7);              // A2.2A row 1357.5 -> 11.61 ft, A2.2B 1362 -> 11.60 ft
const UPPER_HEAD = ft(14, 5);          // T/WINDOW +14'-5"
const UPPER_SILL = ft(10, 1);          // A2.1A 1407.5 -> 10.17, A2.0 1437.5 -> 10.01, A2.2A 1386 -> 10.09 ft
const LOWER_HEAD = ft(7, 10);          // A2.1A 1450.5 -> 7.87, A2.2A 1427 -> 7.90 ft
const SOUTH_LOWER_HEAD = ft(8, 8);     // A2.0 row 1462 -> 8.70 ft (front lower windows run up to the canopy)
const B_WINDOW = ft(3, 1);             // B/WINDOW +3'-1"
const LOW_PANEL = ft(1, 1);            // bottom of the low lights: A2.1A 1578 -> 1.07, A2.2A 1554.5 -> 1.09 ft
const TRANSOM_GAP = 0.05;              // the 3'-1" transom of a low light is modelled as wall, 50 mm

// ---- finishes. The finish names are from the A2.x key notes; colours are not on the
// sheets: RAL 7022 uses the published value, the rest are approximations of the
// named finishes (appearance is a secondary score; see PROVENANCE.md, "Colours") ----
const BATTEN_PROUD = ft(0, 3);         // AL battens stand proud of the wall: A1.0B SE corner 458 vs 464 (6 px), A1.0A NW 8 px, NE 6 px
const FIN = ft(0, 7);                  // corner fins above the parapet: A2.0 rear posts 12-15 px = 0.64-0.80 ft thick
const RECESS = 0.05;                   // storefront frame set back: A1.0B glazing centre 9 px (0.11 m) behind the face, frame 0.12 m deep
const FRAME_W = ft(0, 2);              // frame and mullion width: 3 px double lines on the elevations

export function model() {
  const b = new ModelBuilder();
  b.material('eifs-dark', '#4c4a44', 'wall', { roughness: 0.9 });    // E C1 / AP: RAL 7022 Umbra grey
  b.material('eifs-grey', '#5f5c56', 'wall', { roughness: 0.9 });    // E C2: SW 7019 Gauntlet Gray (published RGB 98, 96, 90 = #62605a)
  b.material('reveal-panel', '#a9a69f', 'metal', { roughness: 0.6, metalness: 0.4 }); // CM: 7" reveal panel, Weathered Zinc
  b.material('batten', '#9a7a56', 'wood', { roughness: 0.8 });       // AL: aluminium batten, wood-grain finish
  b.material('canopy-white', '#eeece6', 'metal', { roughness: 0.5, metalness: 0.3 });   // C1
  b.material('canopy-charcoal', '#36353a', 'metal', { roughness: 0.5, metalness: 0.3 }); // C2
  b.material('frame', '#2e2823', 'frame', { roughness: 0.4, metalness: 0.5 });          // W1: Extra Dark Bronze
  b.material('glass', '#2a3036', 'glass', { roughness: 0.05 });
  b.material('door', '#4c4a44', 'metal', { roughness: 0.5, metalness: 0.3 });           // D: hollow metal door, paint to match C2
  b.material('roof', '#8e8b84', 'roof', { roughness: 0.9 });

  b.group('body', 'Walls and roof of the restaurant block', 'massing', 0.3, 'all');
  b.group('front.block', 'Taller glazed front block', 'massing', 0.3, 'all');
  b.group('parapets', 'Parapet walls above the restaurant roof', 'roof', 0.25, 'all');
  b.group('entrance.tower', 'Raised batten-clad entrance tower', 'massing', 0.25, 'right');
  b.group('entrance', 'Entrance doors, side lights and entrance canopy', 'entrance', 0.1, 'right');
  b.group('front.canopy', 'Canopy across the front windows', 'attachments', 0.1, 'front');
  b.group('right.canopies', 'Canopies on the right side', 'attachments', 0.1, 'right');
  b.group('left.canopies', 'Canopies on the left side', 'attachments', 0.1, 'left');
  b.group('front.glazing', 'Front window bands', 'openings', 0.08, 'front');
  b.group('right.glazing', 'Windows in the right side', 'openings', 0.08, 'right');
  b.group('left.glazing', 'Windows in the left side', 'openings', 0.08, 'left');
  b.group('drive-thru', 'Drive-through window bays, windows and canopies', 'openings', 0.1, 'left');
  b.group('right.doors', 'Exit and service doors in the right side', 'openings', 0.08, 'right');
  b.group('left.doors', 'Exit door in the left side', 'openings', 0.08, 'left');
  b.group('rear.openings', 'Rear doors and the window in the rear-facing step', 'openings', 0.08, 'rear');
  b.group('battens', 'Batten-clad corners and strip', 'ornament', 0.07, 'all');

  const wfE = wallFrame('x', 1, xE);
  const wfWS = wallFrame('x', -1, xWS), wfWM = wallFrame('x', -1, xWM), wfWN = wallFrame('x', -1, xWN);
  const wfS = wallFrame('z', 1, 0), wfN = wallFrame('z', -1, -L);
  const wfStepS = wallFrame('z', 1, -STEP_SOUTH), wfStepN = wallFrame('z', -1, -(L - STEP_NORTH));
  const wfJunction = wallFrame('z', -1, -JUNCTION);

  // ---- walls -----------------------------------------------------------------------
  // A facade is a run of zones along the wall. A plain zone is EIFS below the
  // reveal-panel band, panel above it up to the roof deck, and a panel parapet
  // above the deck; the front block, pilaster, tower and drive-through bays are
  // EIFS full height. Parts are stacked, never overlapped, so no faces are coplanar.
  const facade = (wf, prefix, zones, { band, deck = DECK_MAIN }) => {
    for (const z of zones) {
      const id = prefix + '-' + z.name, open = z.openings ?? [];
      const lowGroup = z.group ?? 'body';
      if (z.kind === 'plain') {
        wall(b, wf, { id, group: lowGroup, material: 'eifs-grey', u0: z.u0, u1: z.u1, y0: 0, y1: band, thickness: T, openings: open });
        wall(b, wf, { id: id + '-band', group: lowGroup, material: 'reveal-panel', u0: z.u0, u1: z.u1, y0: band, y1: deck, thickness: T });
        wall(b, wf, { id: id + '-parapet', group: 'parapets', material: 'reveal-panel', u0: z.u0, u1: z.u1, y0: deck, y1: H_MAIN, thickness: T });
      } else {
        const top = z.top ?? H_MAIN, low = z.deck ?? deck;
        wall(b, wf, { id, group: lowGroup, material: z.material ?? 'eifs-dark', u0: z.u0, u1: z.u1, y0: 0, y1: low, thickness: T, openings: open });
        wall(b, wf, { id: id + '-parapet', group: z.parapetGroup ?? 'parapets', material: z.material ?? 'eifs-dark', u0: z.u0, u1: z.u1, y0: low, y1: top, thickness: T });
      }
    }
  };

  // East (right) side, u = distance north of the front wall. A2.1A positions:
  // front wall at x 571.5 (corner battens 567 stand 4.5 px proud), 18.74 px/ft.
  const eUpper = opening({ u0: ft(2, 11.5), u1: ft(37, 2.5), y0: UPPER_SILL, y1: UPPER_HEAD });   // A2.1A 627 -> 1268.75 (2.96 -> 37.21 ft)
  const eLower = opening({ u0: ft(2, 11.5), u1: ft(29, 3.5), y0: B_WINDOW, y1: LOWER_HEAD });     // A2.1A 627 -> 1120.5 (29.30 ft), four lights
  const eLowLights = opening({ u0: ft(9, 11) - FRAME_W / 2, u1: ft(29, 3.5), y0: LOW_PANEL, y1: B_WINDOW - TRANSOM_GAP }); // lights 2-4 run down to 1'-1"
  const eExit = opening({ u0: ft(39, 10), u1: ft(42, 10), y0: 0, y1: ft(7, 9) });                  // A2.1A 1316-1376 -> 39.81-42.85 ft, head 1452.5 -> 7.77 ft
  const eWin1 = opening({ u0: ft(52, 11.5), u1: ft(62, 4), y0: B_WINDOW, y1: LOWER_HEAD });         // A2.1A 1563.5-1740 -> 52.94-62.35 ft
  const eWin1Low = opening({ u0: ft(52, 11.5), u1: ft(62, 4), y0: LOW_PANEL, y1: B_WINDOW - TRANSOM_GAP });
  const entry = opening({ u0: ft(73, 0.5), u1: ft(83, 2.5), y0: 0, y1: CANOPY_UNDER });             // A2.1A batten jambs 1940.5-2131 -> 73.05-83.22 ft
  const eWin2 = opening({ u0: ft(89, 4.5), u1: ft(98, 10), y0: B_WINDOW, y1: LOWER_HEAD });         // A2.1A 2246.5-2423.5 -> 89.38-98.83 ft
  const eWin2Low = opening({ u0: ft(89, 4.5), u1: ft(98, 10), y0: LOW_PANEL, y1: B_WINDOW - TRANSOM_GAP });
  // North-end doors: A2.1B, measured from its north end (x 1970) at 18.78 px/ft.
  const eDoorN1 = opening({ u0: L - ft(20, 6), u1: L - ft(16, 2), y0: 0, y1: ft(7, 3) });          // A2.1B 1585-1666 -> 20.50-16.19 ft from north, head 1461.5 -> 7.24 ft
  // A2.1B puts this door's jamb 4.37 ft from the north end and the corner battens
  // to 4.63 ft; the plan (A1.0A 372->468->470) puts the battens to 3.84 and the
  // jamb at 3.92 ft. Plan positions, A2.1B width (1816-1888 = 3.83 ft).
  const eDoorN2 = opening({ u0: L - ft(7, 9), u1: L - ft(3, 11), y0: 0, y1: ft(7, 3) });
  facade(wfE, 'wall-right', [
    { name: 'front', kind: 'tall', u0: 0, u1: JUNCTION, top: H_TALL, deck: DECK_FRONT, group: 'front.block', parapetGroup: 'front.block', openings: [eUpper, eLower, eLowLights] },
    { name: 'dining', kind: 'plain', u0: JUNCTION, u1: TOWER0, openings: [eExit, eWin1, eWin1Low] },
    { name: 'tower', kind: 'tall', u0: TOWER0, u1: TOWER1, top: H_TALL, material: 'eifs-grey', group: 'entrance.tower', parapetGroup: 'entrance.tower', openings: [entry] },
    { name: 'middle', kind: 'plain', u0: TOWER1, u1: PILASTER0, openings: [eWin2, eWin2Low] },
    { name: 'pilaster', kind: 'tall', u0: PILASTER0, u1: PILASTER1 },
    { name: 'north', kind: 'plain', u0: PILASTER1, u1: L, openings: [eDoorN1, eDoorN2] },
  ], { band: RB_EAST });

  // West (left) side. A2.2A: front wall at x 2881 (corner battens 2886), 18.73 px/ft;
  // A2.2B: north end at x 1216, 18.75 px/ft.
  const wUpper = opening({ u0: ft(2, 11.5), u1: ft(36, 3), y0: UPPER_SILL, y1: UPPER_HEAD });     // A2.2A 2826 -> 2202 (2.94 -> 36.25 ft); A1.0B printed 36'-5" to the canopy end
  const wLower = opening({ u0: ft(2, 11.5), u1: ft(36, 3), y0: B_WINDOW, y1: LOWER_HEAD });
  const wLowLights = opening({ u0: ft(9, 8.5) - FRAME_W / 2, u1: ft(30, 2.5) + FRAME_W / 2, y0: LOW_PANEL, y1: B_WINDOW - TRANSOM_GAP }); // lights 2-4: A2.2A 1553/1556
  const wExit = opening({ u0: ft(39, 8.5), u1: ft(42, 9), y0: 0, y1: LOWER_HEAD });               // A2.2A 2080.5-2137.5 -> 42.74-39.70 ft, head 1429 -> 7.80 ft
  const wWin = opening({ u0: ft(52, 7.5), u1: ft(62, 1), y0: B_WINDOW, y1: LOWER_HEAD });          // A2.2A 1895.5-1718.5 -> 52.62-62.07 ft
  const wWinLow = opening({ u0: ft(52, 7.5), u1: ft(62, 1), y0: LOW_PANEL, y1: B_WINDOW - TRANSOM_GAP });
  facade(wfWS, 'wall-left', [
    { name: 'front', kind: 'tall', u0: 0, u1: JUNCTION, top: H_TALL, deck: DECK_FRONT, group: 'front.block', parapetGroup: 'front.block', openings: [wUpper, wLower, wLowLights] },
    { name: 'dining', kind: 'plain', u0: JUNCTION, u1: STEP_SOUTH, openings: [wExit, wWin, wWinLow] },
  ], { band: RB_WEST });
  const dt1Win = opening({ u0: ft(80, 5), u1: ft(87, 5), y0: ft(3, 3), y1: ft(8, 2) });            // A2.2A 1374.5-1244 -> 80.43-87.40 ft; sill 1514 -> 3.26, head 1421.5 -> 8.20 ft
  const dt2Win = opening({ u0: L - ft(39, 9), u1: L - ft(35, 3), y0: ft(3, 4), y1: ft(8, 2) });    // A2.2B 1876.5-1961 -> 35.23-39.73 ft from north; sill 1517 -> 3.33, head 1426.5 -> 8.16 ft
  facade(wfWM, 'wall-left-dt', [
    { name: 'bay-1', kind: 'tall', u0: STEP_SOUTH, u1: DT_BAY1_END, top: H_TALL, parapetGroup: 'drive-thru', openings: [dt1Win] },
    { name: 'middle', kind: 'plain', u0: DT_BAY1_END, u1: L - ft(41, 6) },
    { name: 'bay-2', kind: 'tall', u0: L - ft(41, 6), u1: L - STEP_NORTH, top: H_TALL, parapetGroup: 'drive-thru', openings: [dt2Win] },
  ], { band: RB_WEST });
  const highWin = opening({ u0: L - ft(32, 10.5), u1: L - ft(25, 0), y0: ft(6, 3), y1: ft(8, 1) }); // A2.2B 1832.5-1685 -> 32.88-25.01 ft from north; sill 1462.5 -> 6.24, head 1427.5 -> 8.11 ft
  facade(wfWN, 'wall-left-north', [
    { name: 'kitchen', kind: 'plain', u0: L - STEP_NORTH, u1: L, openings: [highWin] },
  ], { band: RB_WEST });

  // Front (south) wall, between the side walls. A2.0: x = (px - 1022) / 18.73 ft.
  const sUpper = opening({ u0: ft(-10, -1.5), u1: ft(16, 7), y0: UPPER_SILL, y1: UPPER_HEAD });  // A2.0 832 -> 1332.5 (-10.14 -> 16.58 ft)
  const sLower = opening({ u0: ft(-10, -1.5), u1: ft(16, 7), y0: B_WINDOW, y1: SOUTH_LOWER_HEAD });
  facade(wfS, 'wall-front', [
    { name: 'block', kind: 'tall', u0: xWS + T, u1: xE - T, top: H_TALL, deck: DECK_FRONT, group: 'front.block', parapetGroup: 'front.block', openings: [sUpper, sLower] },
  ], { band: RB_WEST });
  // Rear (north) wall. A2.0 rear: from its east end at x 2196, 18.73 px/ft.
  const nDouble = opening({ u0: xE - ft(32, 9.5), u1: xE - ft(27, 7.5), y0: 0, y1: ft(7, 5) });   // 2713.5-2810.5 -> 27.63-32.81 ft from the east end, head 1486.5 -> 7.42 ft
  const nSingle = opening({ u0: xE - ft(36, 10.5), u1: xE - ft(33, 8), y0: 0, y1: ft(7, 3) });    // 2826.5-2886.5 -> 33.66-36.87 ft, head 1490 -> 7.23 ft
  facade(wfN, 'wall-rear', [
    { name: 'kitchen', kind: 'plain', u0: xWN + T, u1: xE - T, group: 'body', openings: [nDouble, nSingle] },
  ], { band: RB_WEST });
  // Step walls where the drive-through side widens.
  const stepSWin = opening({ u0: xWM + ft(1, 7.5), u1: xWM + ft(2, 9), y0: B_WINDOW, y1: ft(7, 11) }); // A2.0 583.5-604.5, 1.63-2.75 ft from the wide wall; head 1477 -> 7.90 ft
  facade(wfStepS, 'wall-step-front', [
    { name: 'kitchen', kind: 'plain', u0: xWM + T, u1: xWS + T, openings: [stepSWin] },
  ], { band: RB_WEST });
  const stepNWin = opening({ u0: xWN - ft(1, 4), u1: xWN - ft(0, 3.5), y0: B_WINDOW, y1: ft(7, 10) }); // A2.0 rear 2972-2992: 0.27-1.34 ft beyond the narrow wall; head 1477.5 -> 7.88 ft
  facade(wfStepN, 'wall-step-rear', [
    { name: 'booth', kind: 'tall', u0: xWM + T, u1: xWN + T, top: H_TALL, group: 'body', parapetGroup: 'drive-thru', openings: [stepNWin] },
  ], { band: RB_WEST });
  // The front block's rear wall, seen above the restaurant roof.
  wall(b, wfJunction, { id: 'front-block-rear', group: 'front.block', material: 'eifs-dark', u0: xWS + T, u1: xE - T, y0: DECK_MAIN - 0.35, y1: H_TALL, thickness: T });

  // ---- roof decks (embedded half a wall into the walls) ------------------------------
  const h = T / 2;
  b.prismY('roof-deck', 'body', 'roof', [
    [xE - h, -JUNCTION + h], [xE - h, -L + h], [xWN + h, -L + h], [xWN + h, -(L - STEP_NORTH) + h],
    [xWM + h, -(L - STEP_NORTH) + h], [xWM + h, -STEP_SOUTH - h], [xWS + h, -STEP_SOUTH - h], [xWS + h, -JUNCTION + h],
  ], DECK_MAIN - 0.3, DECK_MAIN);
  b.box('front-block-deck', 'front.block', 'roof', [xWS + h, DECK_FRONT - 0.3, -JUNCTION + h], [xE - h, DECK_FRONT, -h]);

  // ---- battens (AL), 3" proud, embedded 20 mm ----------------------------------------
  const P = BATTEN_PROUD, e = 0.02;
  // Front corners wrap round; their tops stop 20 mm under the wall top so no faces are coplanar.
  b.box('battens-front-right', 'battens', 'batten', [ft(16, 8), 0, -e], [xE + P, H_TALL - e, P]);            // A2.0 1334-1372 -> 16.66-18.69 ft
  b.box('battens-right-front', 'battens', 'batten', [xE - e, 0, -ft(2, 11.5)], [xE + P, H_TALL - e, -e]);   // A2.1A 567-627 -> 2.96 ft
  b.box('battens-front-left', 'battens', 'batten', [xWS - P, 0, -e], [ft(-10, -3), H_TALL - e, P]);          // A2.0 672-830 -> -18.69..-10.25 ft
  b.box('battens-left-front', 'battens', 'batten', [xWS - P, 0, -ft(2, 10)], [xWS + e, H_TALL - e, -e]);    // A2.2A 2828-2886 -> 2.83 ft
  // Rear corners rise as fins to +20'-6" over the 18'-10" parapet (A2.1B 1212-1217, A2.2B 1191-1192).
  b.box('battens-right-rear', 'battens', 'batten', [xE - FIN + P, 0, -L - 0.03], [xE + P, H_TALL, -L + ft(3, 10)]);    // A1.0A 372->468 = 3.84 ft
  b.box('battens-left-rear', 'battens', 'batten', [xWN - P, 0, -L - 0.03], [xWN - P + FIN, H_TALL, -L + ft(8, 1.5)]);  // A2.2B 1216-1369 -> 8.16 ft; A1.0A 372->574 = 8.08 ft
  // Strip beside the left window: A2.2A 1671-1717 -> 64.60-62.15 ft, top 1220 -> 18.95 ft (1" over the parapet).
  b.box('battens-left-strip', 'battens', 'batten', [xWS - P, 0, -ft(64, 7)], [xWS + e, H_MAIN + IN, -ft(62, 2)]);
  // Entrance tower: battens over the whole tower face, notched for the entrance up to the canopy top.
  const towerFace = opening({ u0: entry.u0, u1: entry.u1, y0: 0, y1: CANOPY_FRONT_TOP });
  wall(b, wfE, { id: 'tower-battens', group: 'entrance.tower', material: 'batten', u0: TOWER0, u1: TOWER1, y0: 0, y1: H_TALL - e, thickness: P + e, w0: -P, openings: [towerFace] });

  // ---- canopies --------------------------------------------------------------------
  const PP = ft(1, 6);                  // front-block canopy projection: A1.0B printed 1'-6" (east, west and front)
  b.box('canopy-front', 'front.canopy', 'canopy-white', [xWS - PP, CANOPY_UNDER, -e], [xE + PP, CANOPY_FRONT_TOP, PP]);           // A2.0 644.5-1399.5
  b.box('canopy-right-block', 'right.canopies', 'canopy-white', [xE - e, CANOPY_UNDER, -ft(37, 2.5)], [xE + PP, CANOPY_FRONT_TOP, -e]); // A2.1A 542.5-1268.75
  b.box('canopy-left-block', 'left.canopies', 'canopy-white', [xWS - PP, CANOPY_UNDER, -ft(36, 4)], [xWS + e, CANOPY_FRONT_TOP, -e]);   // A2.2A 2200.5 -> 36.33 ft; A1.0B printed 36'-5"
  const MAIN = ft(4, 0);                // main canopies: A1.0B printed 4'-0" (west), A1.0A scaled 405->303 = 4.08 ft (east)
  b.box('canopy-right-1', 'right.canopies', 'canopy-white', [xE - e, CANOPY_UNDER, -TOWER0 - e], [xE + MAIN, CANOPY_EAST_TOP, -ft(38, 11.5)]); // A2.1A 1301.5 -> 38.95 ft, to the tower
  b.box('canopy-right-2', 'right.canopies', 'canopy-white', [xE - e, CANOPY_UNDER, -ft(98, 11)], [xE + MAIN, CANOPY_EAST_TOP, -ft(89, 4)]);   // A2.1A 2245.5-2425.5
  b.box('canopy-entrance', 'entrance', 'canopy-white', [xE - e, CANOPY_UNDER, -entry.u1], [xE + ft(4, 4), CANOPY_FRONT_TOP, -entry.u0]);      // A2.1A 1410-1430; A1.0A 405->297 = 4.32 ft
  b.box('canopy-left-1', 'left.canopies', 'canopy-white', [xWS - MAIN, DT_UNDER, -ft(62, 2) - e], [xWS + e, DT_TOP, -ft(38, 10.5)]);        // A2.2A 1716.7-2152.7 -> 62.16-38.88 ft
  b.box('canopy-drive-thru-1', 'drive-thru', 'canopy-charcoal', [xWM - ft(4, 4.5), DT_UNDER, -DT_BAY1_END], [xWM + e, DT_TOP, -STEP_SOUTH - e]); // A2.2A fascia across the bay; A1.0A 1504->1613 = 4.36 ft
  b.box('canopy-drive-thru-2', 'drive-thru', 'canopy-charcoal', [xWM - ft(3, 10), DT_UNDER, -(L - STEP_NORTH) + e], [xWM + e, DT_TOP, -(L - ft(41, 6))]); // A2.2B 1842-1995; A1.0A 1505->1600 = 3.80 ft

  // ---- glazing -----------------------------------------------------------------------
  const band = (wf, id, group, o, { mullions = [], transoms = [] } = {}) => windowBand(b, wf, id, group, o, { mullions, transoms });
  const eMullions = [ft(9, 11), ft(16, 9), ft(23, 7), ft(30, 4.5)];               // A2.1A 757, 885, 1013, 1141 -> 9.90, 16.73, 23.56, 30.39 ft
  band(wfE, 'right-upper', 'right.glazing', eUpper, { mullions: eMullions });
  band(wfE, 'right-lower', 'right.glazing', eLower, { mullions: eMullions.slice(0, 3) });
  band(wfE, 'right-low', 'right.glazing', eLowLights, { mullions: eMullions.slice(1, 3) });
  band(wfE, 'right-window-1', 'right.glazing', eWin1, { mullions: [ft(56, 0.5), ft(59, 3)] });     // A2.1A 1621.5, 1681.5
  band(wfE, 'right-window-1-low', 'right.glazing', eWin1Low, { mullions: [ft(56, 0.5), ft(59, 3)] });
  band(wfE, 'right-window-2', 'right.glazing', eWin2, { mullions: [ft(92, 6.5), ft(95, 9)] });     // A2.1A 2305.5, 2365.5
  band(wfE, 'right-window-2-low', 'right.glazing', eWin2Low, { mullions: [ft(92, 6.5), ft(95, 9)] });
  const wMullions = [ft(9, 8.5), ft(16, 6.5), ft(23, 4.5), ft(30, 2.5)];          // A2.2A 2699, 2571, 2443, 2315 -> 9.72, 16.55, 23.38, 30.22 ft
  band(wfWS, 'left-upper', 'left.glazing', wUpper, { mullions: wMullions });
  band(wfWS, 'left-lower', 'left.glazing', wLower, { mullions: wMullions });
  band(wfWS, 'left-low', 'left.glazing', wLowLights, { mullions: wMullions.slice(1, 3) });
  band(wfWS, 'left-window', 'left.glazing', wWin, { mullions: [ft(55, 9), ft(58, 11.5)] });        // A2.2A 1837, 1777 -> 55.74, 58.94 ft
  band(wfWS, 'left-window-low', 'left.glazing', wWinLow, { mullions: [ft(55, 9), ft(58, 11.5)] });
  band(wfWN, 'left-high-window', 'left.glazing', highWin, { mullions: [L - ft(28, 11)] });         // A2.2B 1758.5 -> 28.93 ft from north
  const sMullions = [ft(-3, -4.5), ft(3, 4), ft(10, 0.5)];                         // A2.0 958.5, 1084.5, 1210.5 -> -3.39, 3.34, 10.06 ft
  band(wfS, 'front-upper', 'front.glazing', sUpper, { mullions: sMullions });
  band(wfS, 'front-lower', 'front.glazing', sLower, { mullions: sMullions });
  band(wfStepS, 'front-step-window', 'front.glazing', stepSWin);
  band(wfStepN, 'rear-step-window', 'rear.openings', stepNWin);
  // Drive-through windows: a fixed transom light over a slider (A2.2A 1443.5, A2.2B 1446.5 -> 7.0 ft).
  band(wfWM, 'drive-thru-window-1', 'drive-thru', dt1Win, { mullions: [ft(83, 6)], transoms: [ft(7, 0)] });  // A2.2A 1314-1320 mid-bar -> 83.50 ft
  band(wfWM, 'drive-thru-window-2', 'drive-thru', dt2Win, { transoms: [ft(7, 0)] });

  // ---- doors ------------------------------------------------------------------------
  const metalDoor = (wf, id, group, o, leaves = 1) => doorOpening(b, wf, o, { id, group, frame: 'frame', leaf: 'door', glass: 'glass', metal: 'frame',
    style: 'boarded', leaves, recess: 0.1, frameWidth: FRAME_W, frameDepth: 0.12 });
  metalDoor(wfE, 'right-exit-door', 'right.doors', eExit);
  metalDoor(wfE, 'right-door-1', 'right.doors', eDoorN1);
  metalDoor(wfE, 'right-door-2', 'right.doors', eDoorN2);
  doorOpening(b, wfWS, wExit, { id: 'left-exit-door', group: 'left.doors', frame: 'frame', leaf: 'frame', glass: 'glass', metal: 'frame',
    style: 'full-glass', recess: RECESS, frameWidth: FRAME_W, frameDepth: 0.12 });   // A2.2A: glazed leaf
  metalDoor(wfN, 'rear-door-double', 'rear.openings', nDouble, 2);
  metalDoor(wfN, 'rear-door', 'rear.openings', nSingle);
  // Entrance: double doors between two side lights, a metal panel above them up to
  // the canopy (A2.1A doors 1976.5-2088.5 -> 74.97-80.95 ft, head 1451 -> 7.84 ft;
  // side-light glass from 1580 -> 0.96 ft).
  const doors = opening({ u0: ft(74, 11.5), u1: ft(80, 11.5), y0: 0, y1: LOWER_HEAD });
  doorOpening(b, wfE, doors, { id: 'entrance-doors', group: 'entrance', frame: 'frame', leaf: 'frame', glass: 'glass', metal: 'frame',
    style: 'full-glass', leaves: 2, recess: RECESS, frameWidth: FRAME_W, frameDepth: 0.12 });
  windowBand(b, wfE, 'entrance-light-1', 'entrance', opening({ u0: entry.u0, u1: doors.u0, y0: ft(1, 0), y1: LOWER_HEAD }), {});
  windowBand(b, wfE, 'entrance-light-2', 'entrance', opening({ u0: doors.u1, u1: entry.u1, y0: ft(1, 0), y1: LOWER_HEAD }), {});
  wfE.box(b, 'entrance-head-panel', 'entrance', 'door', entry.u0, entry.u1, LOWER_HEAD, CANOPY_UNDER + e, RECESS + 0.04, RECESS + 0.1);
  wfE.box(b, 'entrance-kick-1', 'entrance', 'door', entry.u0, doors.u0, 0, ft(1, 0), RECESS + 0.04, RECESS + 0.1);
  wfE.box(b, 'entrance-kick-2', 'entrance', 'door', doors.u1, entry.u1, 0, ft(1, 0), RECESS + 0.04, RECESS + 0.1);

  // ---- probes (DESIGN.md 5): a ray's first hit is the named dimension ---------------------
  // Robust to 0.12 m rather than the generator's 0.3 m: the parapets are 0.27 m
  // thick and the canopy fascias 0.2-0.3 m deep, so a height probe on them can
  // stand at most 0.13 m from an edge. No probe measures a window head: the
  // frames sit 50 mm behind the wall face, too shallow for a ray to tell apart
  // (window heads are checked on the sheets and scored through the glazing groups).
  b.probe('front-wall', 'Position of the front wall (left corner battens)', [-4.4, 1.6, 40], [0, 0, -1]);
  b.probe('rear-wall', 'Position of the rear wall', [2.0, 1.6, -90], [0, 0, 1]);
  b.probe('right-wall', 'Position of the right side wall', [60, 1.6, -ft(48, 0)], [-1, 0, 0]);
  b.probe('left-wall', 'Position of the left side wall beside the front block', [-60, 1.6, -ft(47, 6)], [1, 0, 0]);
  b.probe('left-wall-drive-thru', 'Position of the widest part of the left side wall', [-60, 1.6, -ft(105, 0)], [1, 0, 0]);
  b.probe('front-block-top', 'Height of the taller front block (front parapet)', [0, 40, -T / 2], [0, -1, 0]);
  b.probe('main-parapet', 'Height of the main parapet (right side)', [xE - T / 2, 40, -ft(50, 0)], [0, -1, 0]);
  b.probe('tower-top', 'Height of the entrance tower', [xE - T / 2, 40, -ft(78, 0)], [0, -1, 0]);
  b.probe('front-block-rear', 'Position of the rear face of the taller front block', [0, 6.05, -90], [0, 0, 1]);
  b.probe('front-canopy-underside', 'Height of the underside of the canopy across the front', [0, 0.2, PP / 2], [0, 1, 0]);
  b.probe('right-canopy-underside', 'Height of the underside of the right-side canopies', [xE + 0.6, 0.2, -ft(55, 0)], [0, 1, 0]);
  b.probe('left-canopy-underside', 'Height of the underside of the left-side canopies', [xWS - 0.6, 0.2, -ft(50, 0)], [0, 1, 0]);
  b.probe('drive-thru-canopy-underside', 'Height of the underside of the drive-through canopy', [xWM - 0.6, 0.2, -ft(83, 0)], [0, 1, 0]);
  b.probe('entrance-canopy-projection', 'Position of the outer edge of the entrance canopy', [60, ft(9, 6), -ft(78, 0)], [-1, 0, 0]);
  b.probe('front-canopy-projection', 'Position of the outer edge of the canopy across the front', [0, ft(9, 6), 40], [0, 0, -1]);
  b.probe('tower-face', 'Position of the face of the entrance tower', [60, ft(15, 0), -ft(78, 0)], [-1, 0, 0]);
  b.probe('front-block-right-face', 'Position of the right face of the taller front block above its windows', [60, 5.7, -ft(20, 0)], [-1, 0, 0]);

  // ---- named dimensions (what the survey notes state) -------------------------------------
  b.dimension('overall-length', 'Overall length from the front wall to the rear wall', [xE, 0, 0], [xE, 0, -L], 'plan');
  b.dimension('front-width', 'Width of the front wall', [xWS, 0, 0], [xE, 0, 0], 'front');
  b.dimension('greatest-width', 'Greatest width (drive-through side)', [xWM, 0, -ft(100, 0)], [xE, 0, -ft(100, 0)], 'plan');
  b.dimension('main-parapet-height', 'Height to the top of the main parapet', [xE, 0, -ft(50, 0)], [xE, H_MAIN, -ft(50, 0)], 'right');
  b.dimension('front-block-height', 'Height to the top of the taller front block', [xE, 0, 0], [xE, H_TALL, 0], 'front');
  b.dimension('front-canopy-underside', 'Height to the underside of the canopy across the front windows', [0, 0, PP], [0, CANOPY_UNDER, PP], 'front');

  const roundDeep = v => Array.isArray(v) ? v.map(roundDeep) : typeof v === 'number' ? r4(v) : v;
  const parts = b.parts.map(part => Object.fromEntries(Object.entries(part).map(([k, v]) => [k, k === 'rotation' || typeof v === 'string' ? v : roundDeep(v)])));
  return validateModel({
    schema: MODEL_SCHEMA,
    id: 'mcd-homestead',
    archetype: 'real',
    title: 'Single-storey restaurant with a taller glazed front block and a drive-through',
    frame: {
      origin: 'On the ground at the midpoint of the front wall (the end wall of the taller glazed block, facing the street); that wall face is the plane z = 0 and the building extends towards -Z.',
      front: 'The front is the short end with the taller glazed block, facing the street; it faces +Z, and +X is to the right when you look at the front.',
    },
    scope_note: 'The building only: walls and parapets, the taller front block, the entrance tower, batten-clad corners, canopies, the drive-through window bays, windows and doors. ' +
      'Not part of it: the free-standing roadside sign, menu boards and order-point canopies, site walls, enclosures and bollards, parking and kerbs, planting, ' +
      'wall lettering and logos, wall lights, the canopy tie rods and the rooftop mechanical equipment.',
    materials: b.materials,
    groups: b.groups,
    probes: b.probes.map(q => ({ ...q, origin: roundDeep(q.origin) })),
    dimensions: b.dimensions.map(d => ({ id: d.id, label: d.label, value_m: r4(Math.hypot(...d.b.map((v, i) => v - d.a[i]))), a: roundDeep(d.a), b: roundDeep(d.b), view: d.view })),
    parts,
    meta: {
      source: 'Hand-authored from the approved planning-application drawings (2018); see PROVENANCE.md',
      truth_uncertainty_m: 0.15,
      uncertain: { roof_decks_m: 0.5, front_block_right_windows_m: 0.3 },
    },
  });
}

// Window band in a wall opening: frame ring, mullions at the given u, transoms
// between them, one glass pane. Depth layers as the generator's glazedOpening
// (frame recess..recess+0.12, bars 20 mm inside it, glass in the middle).
function windowBand(b, wf, id, group, o, { mullions = [], transoms = [] }) {
  const fw = FRAME_W, fd = 0.12, w0 = RECESS, inner = o.inset(fw);
  wf.extrude(b, id + '.frame', group, 'frame', o.points(), w0, w0 + fd, [inner.points()]);
  const pane = o.inset(fw / 2);
  wf.box(b, id + '.glass', group, 'glass', pane.u0, pane.u1, pane.y0, pane.y1, w0 + fd / 2 - 0.006, w0 + fd / 2 + 0.006);
  const bw = FRAME_W, b0 = w0 + 0.02, b1 = w0 + fd - 0.02;
  for (const [k, u] of mullions.entries()) wf.box(b, id + '.mullion-' + (k + 1), group, 'frame', u - bw / 2, u + bw / 2, inner.y0 - 0.03, inner.y1 + 0.03, b0, b1);
  for (const [j, y] of transoms.entries()) {
    const stops = [inner.u0 - 0.03, ...mullions.flatMap(u => [u - bw / 2, u + bw / 2]), inner.u1 + 0.03];
    for (let k = 0; k < stops.length; k += 2) wf.box(b, id + '.transom-' + (j + 1) + '-' + (k / 2 + 1), group, 'frame', stops[k], stops[k + 1], y - bw / 2, y + bw / 2, b0, b1);
  }
}

// Positions along the sides used in more than one place (feet from the front wall).
const JUNCTION = ft(39, 3.5);   // rear of the front block: A2.1A 1308.5 -> 39.33 ft, A2.2A 2145.5 -> 39.27 ft
const TOWER0 = ft(70, 9);       // entrance tower battens: A2.1A 1897.5 -> 70.76 ft
const TOWER1 = ft(85, 6);       //   to 2173.5 -> 85.49 ft (plan A1.0A 2300-2661 -> 70.9-85.4 ft)
const PILASTER0 = ft(116, 4.5); // flush EIFS pilaster: A2.1A 2752.5 -> 116.38 ft
const PILASTER1 = ft(124, 11);  //   to A2.1B 1261.5 (+1651 overlap shift) -> 124.92 ft
const DT_BAY1_END = ft(90, 2.5); // raised drive-through bay: A2.2A 1191.5 -> 90.20 ft (starts at the step, 1427.5 -> 77.60 ft)

export default model;

// Named positions for sheets.mjs (registration anchors and expected line positions).
export const KEY = {
  T, L, xE, xWS, xWM, xWN, STEP_SOUTH, STEP_NORTH, JUNCTION, TOWER0, TOWER1, PILASTER0, PILASTER1, DT_BAY1_END,
  H_TALL, H_MAIN, DECK_MAIN, DECK_FRONT, RB_EAST, RB_WEST, CANOPY_UNDER, CANOPY_FRONT_TOP, DT_UNDER, DT_TOP,
  UPPER_HEAD, UPPER_SILL, LOWER_HEAD, SOUTH_LOWER_HEAD, B_WINDOW, BATTEN_PROUD,
};
