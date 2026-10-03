// A row of three to five attached houses built as one terrace: each house has its
// own front and rear wall, roof slab and openings; neighbours share party walls
// that may rise through the roof as parapets, and ridge stacks straddle them. Doors
// are paired across party walls, rear outshots are paired back to back, bays and
// dormers vary from house to house, the row may step up part way along (the later
// houses have taller storeys), and the house at one end differs: a corner shop, a
// wider double-fronted house with a gable stack, or a house entered from its gable.
//
// Frame: the front wall face is z = 0, the row runs along X centred on x = 0 as
// generated (an earlier, shorter row keeps that frame), the houses extend to z = -D.
import {
  ModelBuilder, wallFrame, wall, opening, glazedOpening, doorOpening, gableRoofX, gableRoofZ, leanToRoof, lintel, draw, DEG,
} from '../kit.mjs';

const T = 0.3;            // external walls
const ROOF_T = 0.22;      // roof slab thickness, normal to the slope
const UP = 0.35;          // party-wall parapet height above the roof surface
const DOOR_COLOURS = ['#2c4a35', '#6c2224', '#22344d', '#1f1f1f', '#5a3f2c', '#3d5a5b', '#7a6a2c'];

const PALETTES = [
  { brick: '#9a5741', trim: '#e9e4d8', roof: '#4b5054', frame: '#f1f0ea', sill: '#cfc8b8', stack: '#8c4a37', shop: '#1f3d2e' },
  { brick: '#b07a5e', trim: '#ece7da', roof: '#5b4d48', frame: '#ffffff', sill: '#d4cdbd', stack: '#a36a52', shop: '#5a1f22' },
  { brick: '#7e4a3b', trim: '#d8d2c2', roof: '#3e4347', frame: '#ece9e1', sill: '#bdb6a6', stack: '#6f4033', shop: '#22385a' },
  { brick: '#c09a6f', trim: '#f1ede2', roof: '#6c5a4c', frame: '#2f3236', sill: '#d9d2c1', stack: '#a8805a', shop: '#2c2f33' },
];

export function sample(r) {
  const m = r.fork('massing');
  const n = m.int(3, 5);
  const massing = { units: n, unitW: draw(m, 4.4, 5.6), depth: draw(m, 7.6, 9.4), storey: draw(m, 2.7, 3.0), floorLevel: draw(m, 0.3, 0.55),
    knee: draw(m, 0.15, 0.3), pitch: draw(m, 34, 44, 1), overhang: draw(m, 0.25, 0.35), verge: draw(m, 0.15, 0.25) };
  const e = r.fork('end');
  const end = { side: e.pick([-1, 1]), kind: e.pick(['shop', 'wide', 'side']), extra: draw(e, 1.4, 2.2) };
  const st = r.fork('step');
  // At party wall `at` (between houses at-1 and at) the row steps: the houses on side
  // `high` of it have storeys taller by rise / 2.
  // A shop or a gable entrance barely changes the row's shape (a mirror image of
  // the row would differ by little more than a fascia), so those rows always step.
  const step = st.chance(0.5) || end.kind !== 'wide' ? { at: st.int(1, n - 1), rise: draw(st, 0.5, 0.9), high: st.pick([-1, 1]) } : null;
  const ro = r.fork('roof');
  const roof = { upstands: ro.chance(0.5), attic: ro.chance(0.55),
    stack: { w: draw(ro, 0.9, 1.3), d: draw(ro, 0.55, 0.7), above: draw(ro, 0.7, 1.1), pots: ro.int(2, 4), behind: ro.chance(0.5) } };
  const houses = [...Array(n).keys()].map(i => {
    const u = r.fork('house-' + i);
    return { bay: u.chance(0.5), dormer: u.chance(0.65), hood: u.chance(0.5), door: u.int(0, DOOR_COLOURS.length - 1), style: u.pick(['panel', 'panel', 'glazed']),
      mullions: u.pick([0, 1]), upperDoorWindow: u.chance(0.6), windowW: draw(u, 1.2, 1.5), upperW: draw(u, 0.9, 1.15), bayDepth: draw(u, 0.65, 0.9) };
  });
  // Outshots stand back to back in pairs of houses (0,1), (2,3) across the shared
  // party wall. Their zone on the rear wall is kept free of ground-floor openings
  // whether or not they are built, so an earlier state keeps the same walls.
  const pairs = [...Array(Math.floor(n / 2)).keys()].map(k => {
    const o = r.fork('outshot-' + k);
    return { built: o.chance(0.65), depth: draw(o, 2.4, 3.4), plate: draw(o, 2.4, 2.7) };
  });
  return { massing, end, step, roof, houses, pairs, removed: null, palette: r.fork('palette').int(0, PALETTES.length - 1) };
}

export function build(p) {
  const b = new ModelBuilder(), M = p.massing, pal = PALETTES[p.palette];
  const n = M.units, D = M.depth, pitch = M.pitch * DEG, tan = Math.tan(pitch), ov = M.overhang, vg = M.verge, yf = M.floorLevel;
  const e = p.end.side, special = e < 0 ? 0 : n - 1;
  b.material('brick', pal.brick, 'wall', { roughness: 0.9 });
  b.material('trim', pal.trim, 'wall', { roughness: 0.8 });
  b.material('roof', pal.roof, 'roof', { roughness: 0.8 });
  b.material('frame', pal.frame, 'frame', { roughness: 0.5 });
  b.material('glass', '#2e4250', 'glass', { roughness: 0.05 });
  b.material('sill', pal.sill, 'stone', { roughness: 0.8 });
  b.material('stack', pal.stack, 'wall', { roughness: 0.9 });
  b.material('pot', '#9a5a3c', 'wall', { roughness: 0.9 });
  b.material('metal', '#2a2c2e', 'metal', { roughness: 0.4, metalness: 0.6 });
  b.material('timber', '#ece9e1', 'wood', { roughness: 0.6 });
  b.material('paving', '#a7a297', 'stone', { roughness: 0.9 });
  b.material('ridge', '#2c2a29', 'roof', { roughness: 0.8 });
  b.material('shopfront', pal.shop, 'frame', { roughness: 0.45 });
  b.material('sign', '#ece9e1', 'sign', { roughness: 0.5 });
  for (const k of new Set(p.houses.map(h => h.door))) b.material('door-' + k, DOOR_COLOURS[k], 'wood', { roughness: 0.6 });

  // ---- houses along the row ------------------------------------------------------
  const widths = [...Array(n).keys()].map(i => M.unitW + (i === special && p.end.kind === 'wide' ? p.end.extra : 0));
  const total = widths.reduce((a, c) => a + c, 0);
  const xs = [-total / 2];
  for (const w of widths) xs.push(xs.at(-1) + w);
  const present = [...Array(n).keys()].filter(i => i !== p.removed);
  const first = present[0], last = present.at(-1), xL = xs[first], xR = xs[last + 1];
  const high = i => !!p.step && ((i >= p.step.at) === (p.step.high > 0));
  const houses = present.map(i => {
    const storey = M.storey + (high(i) ? p.step.rise / 2 : 0), plate = yf + 2 * storey + M.knee;
    const pair = Math.floor(i / 2) < p.pairs.length ? Math.floor(i / 2) : null, leftMember = i % 2 === 0;
    // Doors are paired across the shared party wall; a house without a partner opens on its outer side.
    const doorSide = pair === null ? (i === 0 ? -1 : 1) : leftMember ? 1 : -1;
    const kind = i === special ? p.end.kind : 'house';
    return { i, xa: xs[i], xb: xs[i + 1], w: widths[i], xc: (xs[i] + xs[i + 1]) / 2, storey, plate, pair, leftMember, doorSide, kind, h: p.houses[i],
      ridgeTop: plate + D / 2 * tan + ROOF_T / Math.cos(pitch), sill: yf + 0.85, upperSill: yf + storey + 0.85 };
  });
  const byIndex = new Map(houses.map(h => [h.i, h]));
  const partyLines = present.slice(1).map(i => ({ j: i, x: xs[i], left: byIndex.get(i - 1), right: byIndex.get(i) }));

  b.group('body', 'Front, rear and end walls', 'massing', 0.3, 'all');
  b.group('roof', 'Roof slabs, ridges and barge boards', 'roof', 0.24, 'roof');
  b.group('chimneys', 'Chimney stacks, caps and pots', 'roof', 0.15, 'roof');
  b.group('front.windows', 'Front windows', 'openings', 0.07, 'front');
  b.group('front.doors', 'Front doors, steps and door hoods', 'entrance', 0.08, 'front');
  b.group('rear', 'Rear windows, back doors and steps', 'openings', 0.07, 'rear');
  b.group('rainwater', 'Gutters and downpipes', 'attachments', 0.08, 'all');
  const winOpts = h => ({ frame: 'frame', glass: 'glass', sill: 'sill', mullions: h.h.mullions, transoms: [] });
  const wfF = wallFrame('z', 1, 0), wfB = wallFrame('z', -1, -D), wfL = wallFrame('x', -1, xL), wfR = wallFrame('x', 1, xR);
  const wfEnd = e < 0 ? wfL : wfR;
  const endHouse = byIndex.get(special) ?? null;      // null when the special end house is the one removed (it never is)

  // ---- front walls and openings ----------------------------------------------------
  const piers = [];             // [house, u0, u1, y] spans of plain front wall for probes
  for (const h of houses) {
    const u0 = h.i === first ? h.xa + T : h.xa, u1 = h.i === last ? h.xb - T : h.xb, top = h.plate + 0.05;
    const openings = [];
    const dw = 1.0, doorH = 2.15 + 0.35;
    h.windows = []; h.upper = [];
    if (h.kind === 'shop') {
      // Shopfront: a level door at the outer end and a glazed front on a stallriser.
      const du = e < 0 ? h.xa + T + 0.45 : h.xb - T - 0.45 - 1.1;
      h.door = opening({ u0: du, u1: du + 1.1, y0: 0, y1: 2.5 });
      const g0 = e < 0 ? h.door.u1 + 0.45 : h.xa + 0.45, g1 = e < 0 ? h.xb - 0.45 : h.door.u0 - 0.45;
      h.shopWindow = opening({ u0: g0, u1: g1, y0: 0.6, y1: yf + h.storey - 0.55 });
      openings.push(h.door, h.shopWindow);
    } else if (h.kind === 'side') {
      h.door = null;
    } else if (h.kind === 'wide') {
      h.door = opening({ u0: h.xc - dw / 2, u1: h.xc + dw / 2, y0: yf, y1: yf + doorH });
      openings.push(h.door);
    } else {
      const du = h.doorSide < 0 ? h.xa + 0.35 : h.xb - 0.35 - dw;
      h.door = opening({ u0: du, u1: du + dw, y0: yf, y1: yf + doorH });
      openings.push(h.door);
    }
    // Ground-floor windows (or a bay) in the stretch the door leaves free.
    const free = h.kind === 'wide' ? [[h.xa + 0.45, h.door.u0 - 0.45], [h.door.u1 + 0.45, h.xb - 0.45]]
      : h.kind === 'shop' ? [] : h.door ? [h.doorSide < 0 ? [h.door.u1 + 0.5, h.xb - 0.45] : [h.xa + 0.45, h.door.u0 - 0.5]] : [[h.xa + 0.45, h.xb - 0.45]];
    for (const [a, c] of free) {
      const w = Math.min(h.h.windowW, c - a - 0.5), uc = (a + c) / 2;
      h.windows.push(opening({ u0: uc - w / 2, u1: uc + w / 2, y0: h.sill, y1: h.sill + 1.45 }));
    }
    // A bay replaces the first ground window when it fits under the upper sill.
    h.bayPlan = null;
    if (h.h.bay && h.kind !== 'shop' && h.windows.length) {
      const o = h.windows[0], bw = o.u1 - o.u0 + 0.8, x0 = (o.u0 + o.u1) / 2 - bw / 2, x1 = x0 + bw, bd = h.h.bayDepth, bp = 22 * DEG;
      const bayPlate = o.top + 0.28, topAtWall = bayPlate + (bd + 0.05) * Math.tan(bp) + 0.12 / Math.cos(bp);
      const clearDoor = !h.door || h.door.y0 > 0.01 && (x1 < h.door.u0 - 0.35 || x0 > h.door.u1 + 0.35);
      if (topAtWall <= h.upperSill - 0.15 && x0 > h.xa + 0.2 && x1 < h.xb - 0.2 && clearDoor) h.bayPlan = { x0, x1, bd, bp, bayPlate, o };
    }
    openings.push(...h.windows.filter(o => !h.bayPlan || o !== h.bayPlan.o));
    // Upper floor: a window over each ground opening, a narrow one over the door.
    const over = [...h.windows.map(o => [(o.u0 + o.u1) / 2, Math.min(h.h.upperW, o.u1 - o.u0)])];
    if (h.kind === 'shop') over.push([(h.shopWindow.u0 + h.shopWindow.u1) / 2 - 0.9, h.h.upperW], [(h.shopWindow.u0 + h.shopWindow.u1) / 2 + 0.9, h.h.upperW]);
    if (h.kind === 'wide' || (h.door && h.h.upperDoorWindow && h.kind === 'house')) over.push([(h.door.u0 + h.door.u1) / 2, 0.7]);
    if (h.kind === 'side') over.push([h.xc + (h.xb - h.xa) * 0.25 * -e, 0.7]);
    for (const [uc, w] of over) {
      if (uc - w / 2 < h.xa + 0.35 || uc + w / 2 > h.xb - 0.35) continue;
      if (h.upper.some(o => uc - w / 2 < o.u1 + 0.5 && uc + w / 2 > o.u0 - 0.5)) continue;
      h.upper.push(opening({ u0: uc - w / 2, u1: uc + w / 2, y0: h.upperSill, y1: h.upperSill + 1.2 }));
    }
    openings.push(...h.upper);
    wall(b, wfF, { id: 'front-' + (h.i + 1), group: 'body', material: 'brick', u0, u1, y0: 0, y1: top, thickness: T, openings });
    // Plain wall between openings, for probes.
    const spans = openings.filter(o => o.y0 < h.upperSill - 0.1).map(o => [o.u0, o.u1]);
    if (h.bayPlan) spans.push([h.bayPlan.x0 - 0.15, h.bayPlan.x1 + 0.15]);
    spans.sort((a, c) => a[0] - c[0]);
    let prev = u0 + 0.05;
    for (const [a, c] of spans) { if (a - prev > 0.9) piers.push([h, prev, a]); prev = Math.max(prev, c); }
    if (u1 - 0.05 - prev > 0.9) piers.push([h, prev, u1 - 0.05]);
  }

  // ---- rear walls ------------------------------------------------------------------
  for (const h of houses) {
    const u0 = h.i === first ? h.xa + T : h.xa, u1 = h.i === last ? h.xb - T : h.xb;
    // The outshot zone is the half next to the pair's shared party wall.
    h.zone = h.pair === null ? null : h.leftMember ? [h.xc, h.xb] : [h.xa, h.xc];
    const freeHalf = h.zone ? (h.leftMember ? [h.xa + 0.4, h.xc - 0.3] : [h.xc + 0.3, h.xb - 0.4]) : [h.xa + 0.4, h.xb - 0.4];
    const outer = h.zone ? (h.leftMember ? -1 : 1) : (h.i === 0 ? -1 : 1);
    const bd0 = outer < 0 ? freeHalf[0] : freeHalf[1] - 0.9;
    h.backDoor = opening({ u0: bd0, u1: bd0 + 0.9, y0: yf, y1: yf + 2.1 });
    const rest = outer < 0 ? [h.backDoor.u1 + 0.4, freeHalf[1]] : [freeHalf[0], h.backDoor.u0 - 0.4];
    const rw = Math.min(1.1, rest[1] - rest[0] - 0.1), rc = (rest[0] + rest[1]) / 2;
    h.rearWindows = rw >= 0.8 ? [opening({ u0: rc - rw / 2, u1: rc + rw / 2, y0: h.sill + 0.1, y1: h.sill + 1.35 })] : [];
    h.rearUpper = [opening({ u0: h.xc - (h.w * 0.25) - 0.5, u1: h.xc - (h.w * 0.25) + 0.5, y0: h.upperSill, y1: h.upperSill + 1.1 }),
      opening({ u0: h.xc + (h.w * 0.25) - 0.45, u1: h.xc + (h.w * 0.25) + 0.45, y0: h.upperSill + 0.2, y1: h.upperSill + 1.1 })];
    wall(b, wfB, { id: 'rear-' + (h.i + 1), group: 'body', material: 'brick', u0, u1, y0: 0, y1: h.plate + 0.05, thickness: T,
      openings: [h.backDoor, ...h.rearWindows, ...h.rearUpper] });
  }

  // Party walls between the houses: hidden from outside, but the plan section shows them.
  for (const pl of partyLines) {
    b.box('party-wall-' + pl.j, 'body', 'brick', [pl.x - 0.1, 0, -D + T], [pl.x + 0.1, Math.min(pl.left.plate, pl.right.plate) + 0.04, -T]);
  }

  // ---- end walls -----------------------------------------------------------------------
  const endHouses = { [-1]: byIndex.get(first), [1]: byIndex.get(last) };
  const sideDoor = endHouse && endHouse.kind === 'side' ? opening({ u0: D * 0.3, u1: D * 0.3 + 1.0, y0: yf, y1: yf + 2.5 }) : null;
  const sideWindow = endHouse && endHouse.kind === 'side' ? opening({ u0: D * 0.3, u1: D * 0.3 + 0.8, y0: endHouse.upperSill, y1: endHouse.upperSill + 1.0 }) : null;
  for (const [side, wf] of [[-1, wfL], [1, wfR]]) {
    const h = endHouses[side], gable = [[D, h.plate + 0.05], [D / 2, h.plate + D / 2 * tan + 0.05], [0, h.plate + 0.05]];
    const openings = side === e && sideDoor ? [sideDoor, sideWindow] : [];
    wall(b, wf, { id: 'end-' + (side < 0 ? 'left' : 'right'), group: 'body', material: 'brick', u0: 0, u1: D, y0: 0, top: gable, thickness: T, openings });
  }

  // ---- roofs ------------------------------------------------------------------------
  // Party lines with a parapet: every one when the row has them, and always at a step.
  const parapet = new Map(partyLines.filter(pl => p.roof.upstands || pl.left.plate !== pl.right.plate).map(pl => [pl.j, pl]));
  for (const h of houses) {
    const lp = h.i === first ? null : parapet.has(h.i), rp = h.i === last ? null : parapet.has(h.i + 1);
    // Slabs end at a plain party line (meeting the neighbour's end face), 4 cm inside a parapet, or oversail a gable end.
    const x0 = lp === null ? h.xa - vg : lp ? h.xa + 0.11 : h.xa, x1 = rp === null ? h.xb + vg : rp ? h.xb - 0.11 : h.xb;
    h.roof = gableRoofX(b, { id: 'roof-' + (h.i + 1), group: 'roof', material: 'roof', x0, x1, zRidge: -D / 2, halfDepth: D / 2, plate: h.plate, pitch, overhang: ov, thickness: ROOF_T });
    h.rx = [x0, x1];
    b.beam('ridge-' + (h.i + 1), 'roof', 'ridge', [x0 + (lp === null ? -0.06 : 0), h.roof.ridgeTop - 0.03, -D / 2], [x1 + (rp === null ? 0.06 : 0), h.roof.ridgeTop - 0.03, -D / 2], 0.08, 16);
    h.eaveLow = h.plate - ov * tan;
  }
  // Barge boards at the two gable ends, 2.5 cm past the eave faces.
  for (const [side, h] of [[-1, endHouses[-1]], [1, endHouses[1]]]) {
    const { under, tv, s } = h.roof, ee = s + 0.025, xe = side < 0 ? h.rx[0] : h.rx[1];
    const barge = [[ee, under(ee) - 0.04], [0, under(0) - 0.04], [-ee, under(ee) - 0.04], [-ee, under(ee) + tv - 0.04], [0, under(0) + tv - 0.04], [ee, under(ee) + tv - 0.04]]
      .map(([d, y]) => [-D / 2 + d, y]);
    b.prismX('barge-' + (side < 0 ? 'left' : 'right'), 'roof', 'trim', barge, side < 0 ? xe - 0.025 : xe - 0.02, side < 0 ? xe + 0.02 : xe + 0.025);
  }
  // Parapet party walls: following the higher roof 35 cm up, from 3 cm inside the lower
  // slab's underside, slightly past both eaves.
  if (parapet.size) {
    b.group('party.walls', 'Party-wall parapets', 'roof', 0.15, 'roof');
    for (const pl of parapet.values()) {
      const lo = pl.left.plate <= pl.right.plate ? pl.left : pl.right, hi = lo === pl.left ? pl.right : pl.left;
      const s = lo.roof.s + 0.03;
      const bottom = d => lo.roof.under(d) + 0.03, top = d => hi.roof.top(d) + UP;
      const prof = [[-D / 2 + s, bottom(s)], [-D / 2, bottom(0)], [-D / 2 - s, bottom(s)], [-D / 2 - s, top(hi.roof.s + 0.03)], [-D / 2, top(0)], [-D / 2 + s, top(hi.roof.s + 0.03)]];
      b.prismX('parapet-' + pl.j, 'party.walls', 'brick', prof, pl.x - 0.15, pl.x + 0.15);
      // The coping runs 3 cm past the parapet's ends, so their end faces are not shared.
      const sc = s + 0.03, cap = [[-D / 2 - sc, top(sc)], [-D / 2, top(0)], [-D / 2 + sc, top(sc)]];
      b.prismX('parapet-' + pl.j + '-coping', 'party.walls', 'sill', [...cap.map(([z, y]) => [z, y - 0.06]), ...cap.reverse().map(([z, y]) => [z, y + 0.08])], pl.x - 0.2, pl.x + 0.2);
    }
  }

  // ---- chimney stacks ------------------------------------------------------------------
  const sk = p.roof.stack, stackZ = sk.behind ? -D / 2 - 0.65 : -D / 2;
  const stacks = [];
  for (const pl of partyLines) {
    const ridge = Math.max(pl.left.roof.ridgeTop, pl.right.roof.ridgeTop), topY = ridge + sk.above;
    const base = Math.min(pl.left.plate, pl.right.plate) + 0.6;
    stacks.push({ x: pl.x, w: sk.w, d: sk.d, z: stackZ, base, top: topY, id: 'stack-' + pl.j });
  }
  if (endHouse && endHouse.kind === 'wide') {
    // A gable stack on an external breast at the wide house's end wall.
    const h = endHouse, xw = e < 0 ? xL : xR, bw = 1.5, sw = 0.75, bdp = 0.55;
    const [xa, xb] = e < 0 ? [xw - bdp, xw + 0.05] : [xw - 0.05, xw + bdp], cz = -D / 2, yw = h.eaveLow - 0.6, sh = yw + (bw - sw) / 2;
    b.prismX('stack-gable-breast', 'chimneys', 'stack', [[cz - bw / 2, 0], [cz + bw / 2, 0], [cz + bw / 2, yw], [cz + sw / 2, sh], [cz - sw / 2, sh], [cz - bw / 2, yw]], xa, xb);
    stacks.push({ x: (xa + xb) / 2, w: xb - xa, d: sw, z: cz, base: sh, top: h.ridgeTop + sk.above, id: 'stack-gable', alongZ: true });
  }
  for (const st of stacks) {
    const x0 = st.x - st.w / 2, x1 = st.x + st.w / 2, z0 = st.z - st.d / 2, z1 = st.z + st.d / 2;
    b.box(st.id, 'chimneys', 'stack', [x0, st.base, z0], [x1, st.top, z1]);
    b.box(st.id + '-cap', 'chimneys', 'sill', [x0 - 0.06, st.top - 0.04, z0 - 0.06], [x1 + 0.06, st.top + 0.1, z1 + 0.06]);
    const long = st.alongZ ? z1 - z0 : x1 - x0, count = st.alongZ ? Math.min(2, sk.pots) : sk.pots;
    for (let k = 0; k < count; k++) {
      const t = count === 1 ? 0 : (k / (count - 1) - 0.5) * (long - 0.3);
      b.cylinder(st.id + '-pot-' + (k + 1), 'chimneys', 'pot', [st.x + (st.alongZ ? 0 : t), st.top + 0.07, st.z + (st.alongZ ? t : 0)], 0.45, 0.1, { top: 0.085, segments: 16 });
    }
  }

  // ---- windows and doors ------------------------------------------------------------------
  for (const h of houses) {
    h.windows.forEach((o, k) => {
      if (h.bayPlan && o === h.bayPlan.o) return;
      glazedOpening(b, wfF, o, { ...winOpts(h), id: 'window-' + (h.i + 1) + '-g' + (k + 1), group: 'front.windows', transoms: [o.top - 0.4] });
      lintel(b, wfF, o, { id: 'window-' + (h.i + 1) + '-g' + (k + 1) + '.head', group: 'front.windows', material: 'trim' });
    });
    h.upper.forEach((o, k) => {
      glazedOpening(b, wfF, o, { ...winOpts(h), id: 'window-' + (h.i + 1) + '-u' + (k + 1), group: 'front.windows', mullions: o.u1 - o.u0 < 0.9 ? 0 : h.h.mullions });
      lintel(b, wfF, o, { id: 'window-' + (h.i + 1) + '-u' + (k + 1) + '.head', group: 'front.windows', material: 'trim' });
    });
    if (h.kind === 'shop') {
      b.group('shopfront', 'Shopfront, fascia and pilasters', 'openings', 0.08, 'front');
      const o = h.shopWindow;
      glazedOpening(b, wfF, o, { id: 'shop-window', group: 'shopfront', frame: 'shopfront', glass: 'glass', sill: 'sill', recess: 0.12, frameWidth: 0.08, frameDepth: 0.12,
        mullions: Math.max(1, Math.round((o.u1 - o.u0) / 1.1) - 1), transoms: [o.top - 0.45] });
      doorOpening(b, wfF, h.door, { id: 'shop-door', group: 'shopfront', frame: 'shopfront', leaf: 'shopfront', glass: 'glass', metal: 'metal', style: 'full-glass', fanlight: 0.35,
        recess: 0.12, frameWidth: 0.08, frameDepth: 0.12 });
      const fy = yf + h.storey - 0.45;
      wfF.box(b, 'shop-fascia', 'shopfront', 'shopfront', h.xa + 0.12, h.xb - 0.12, fy, fy + 0.6, -0.22, 0.02);
      for (const [k, u] of [[1, h.xa + 0.12], [2, h.xb - 0.36]]) wfF.box(b, 'shop-pilaster-' + k, 'shopfront', 'shopfront', u, u + 0.24, 0, fy - 0.02, -0.14, 0.02);
      h.fascia = { y: fy + 0.3, u: (h.xa + h.xb) / 2 };
      continue;
    }
    if (!h.door) continue;
    doorOpening(b, wfF, h.door, { id: 'door-' + (h.i + 1), group: 'front.doors', frame: 'frame', leaf: 'door-' + h.h.door, glass: 'glass', metal: 'metal',
      style: h.h.style, fanlight: 0.35, handleSide: h.doorSide > 0 ? -1 : 1 });
    // Steps up to the raised ground floor: adjacent blocks, the top one 2 cm under the sill.
    const nSteps = Math.max(2, Math.round(yf / 0.17));
    for (let k = 1; k <= nSteps; k++) {
      b.box('step-' + (h.i + 1) + '-' + k, 'front.doors', 'paving', [h.door.u0 - 0.15, 0, (k - 1) * 0.28 - (k === 1 ? 0.02 : 0)],
        [h.door.u1 + 0.15, (yf - 0.02) * (nSteps - k + 1) / nSteps, k * 0.28]);
    }
    if (h.h.hood) {
      const y = h.door.top + 0.18;
      wfF.box(b, 'hood-' + (h.i + 1), 'front.doors', 'timber', h.door.u0 - 0.25, h.door.u1 + 0.25, y, y + 0.12, -0.8, 0.03);
      for (const [k, u] of [[1, h.door.u0 - 0.12], [2, h.door.u1 + 0.12]]) {
        wfF.sideProfile(b, 'hood-' + (h.i + 1) + '-bracket-' + k, 'front.doors', 'timber', [[0.02, y + 0.02], [0.02, y - 0.45], [-0.6, y + 0.02]], u - 0.035, u + 0.035);
      }
    }
  }

  // ---- bays -------------------------------------------------------------------------------
  const bays = houses.filter(h => h.bayPlan);
  if (bays.length) b.group('bays', 'Ground-floor bay windows', 'attachments', 0.07, 'front');
  for (const h of bays) {
    const { x0, x1, bd, bp, bayPlate, o } = h.bayPlan, tb = 0.2, id = 'bay-' + (h.i + 1);
    const under = w => bayPlate + (w + bd) * Math.tan(bp), wfBay = wallFrame('z', 1, bd);
    const win = opening({ u0: x0 + 0.22, u1: x1 - 0.22, y0: o.y0 - 0.05, y1: o.top });
    wall(b, wfBay, { id: id + '-front', group: 'bays', material: 'brick', u0: x0 + tb, u1: x1 - tb, y0: 0, y1: bayPlate + 0.05, thickness: tb, openings: [win] });
    glazedOpening(b, wfBay, win, { ...winOpts(h), id: id + '-window', group: 'bays', recess: 0.06, frameDepth: 0.1, mullions: 2 });
    for (const [s, xf] of [[-1, x0], [1, x1]]) {
      const wf = wallFrame('x', s, xf), sw = bd >= 0.8 ? [opening({ u0: -(bd - tb) + 0.1, u1: -0.12, y0: o.y0 - 0.05, y1: o.top })] : [];
      wall(b, wf, { id: id + '-side-' + (s < 0 ? 'left' : 'right'), group: 'bays', material: 'brick', u0: -bd, u1: 0.05, y0: 0,
        top: [[0.05, under(0.05) + 0.05], [-bd, under(-bd) + 0.05]], thickness: tb, openings: sw });
      if (sw.length) glazedOpening(b, wf, sw[0], { ...winOpts(h), id: id + '-window-' + (s < 0 ? 'left' : 'right'), group: 'bays', recess: 0.04, frameDepth: 0.1, frameWidth: 0.06, mullions: 0 });
    }
    leanToRoof(b, wfF, { id: id + '-roof', group: 'bays', material: 'roof', u0: x0 - 0.12, u1: x1 + 0.12, wBack: 0.05, wFront: -(bd + 0.15), yBack: under(0.05), pitch: bp, thickness: 0.12 });
    h.bayProbe = { x: (x0 + x1) / 2, y: Math.max(0.35, o.y0 - 0.45), z: bd };
  }

  // ---- side entrance (the house entered from its gable) ---------------------------------------
  if (sideDoor) {
    const side = e < 0 ? 'left' : 'right';
    b.group('side.entrance', 'Side door, steps and canopy in the ' + side + ' gable', 'entrance', 0.08, side);
    doorOpening(b, wfEnd, sideDoor, { id: 'side-door', group: 'side.entrance', frame: 'frame', leaf: 'door-' + endHouse.h.door, glass: 'glass', metal: 'metal', style: endHouse.h.style, fanlight: 0.35 });
    glazedOpening(b, wfEnd, sideWindow, { ...winOpts(endHouse), id: 'side-window', group: 'side.entrance', mullions: 0 });
    const nSteps = Math.max(2, Math.round(yf / 0.17));
    for (let k = 1; k <= nSteps; k++) {
      wfEnd.box(b, 'side-step-' + k, 'side.entrance', 'paving', sideDoor.u0 - 0.15, sideDoor.u1 + 0.15, 0, (yf - 0.02) * (nSteps - k + 1) / nSteps, -k * 0.28, -(k - 1) * 0.28 + (k === 1 ? 0.02 : 0));
    }
    const y = sideDoor.top + 0.2;
    wfEnd.box(b, 'side-canopy', 'side.entrance', 'timber', sideDoor.u0 - 0.3, sideDoor.u1 + 0.3, y, y + 0.12, -0.95, 0.03);
    for (const [k, u] of [[1, sideDoor.u0 - 0.15], [2, sideDoor.u1 + 0.15]]) {
      wfEnd.sideProfile(b, 'side-canopy-bracket-' + k, 'side.entrance', 'timber', [[0.02, y + 0.02], [0.02, y - 0.5], [-0.75, y + 0.02]], u - 0.035, u + 0.035);
    }
  }

  // ---- rear: back doors, windows, outshots ------------------------------------------------------
  for (const h of houses) {
    doorOpening(b, wfB, h.backDoor, { id: 'back-door-' + (h.i + 1), group: 'rear', frame: 'frame', leaf: 'door-' + h.h.door, glass: 'glass', metal: 'metal', style: 'glazed' });
    b.box('back-step-' + (h.i + 1), 'rear', 'paving', [h.backDoor.u0 - 0.15, 0, -D - 0.45], [h.backDoor.u1 + 0.15, yf - 0.02, -D + 0.02]);
    [...h.rearWindows, ...h.rearUpper].forEach((o, k) => glazedOpening(b, wfB, o, { ...winOpts(h), id: 'rear-window-' + (h.i + 1) + '-' + (k + 1), group: 'rear', mullions: 0 }));
  }
  const outshots = [];
  p.pairs.forEach((pair, k) => {
    const a = byIndex.get(2 * k), c = byIndex.get(2 * k + 1);
    if (!pair.built || !a || !c) return;
    if (!outshots.length) b.group('outshots', 'Single-storey rear outshots', 'massing', 0.2, 'rear');
    const px = a.xb, ow = Math.min(a.w, c.w) * 0.45, od = pair.depth, op = pair.plate, te = 0.25, lp = 12 * DEG, id = 'outshot-' + (k + 1);
    const ox0 = px - ow, ox1 = px + ow, under = w => op + (w + od) * Math.tan(lp);
    const wfO = wallFrame('z', -1, -D - od), wfOL = wallFrame('x', -1, ox0), wfOR = wallFrame('x', 1, ox1);
    // One rear window per house, towards its outer side, sill above a plain stretch for probes.
    const wins = [opening({ u0: ox0 + te + 0.35, u1: ox0 + te + 1.15, y0: 1.0, y1: 2.0 }), opening({ u0: ox1 - te - 1.15, u1: ox1 - te - 0.35, y0: 1.0, y1: 2.0 })];
    wall(b, wfO, { id: id + '-rear', group: 'outshots', material: 'brick', u0: ox0 + te, u1: ox1 - te, y0: 0, y1: op + 0.05, thickness: te, openings: wins });
    wins.forEach((o, j) => glazedOpening(b, wfO, o, { ...winOpts(a), id: id + '-window-' + (j + 1), group: 'outshots', mullions: 0 }));
    for (const [s, wf] of [[-1, wfOL], [1, wfOR]]) {
      wall(b, wf, { id: id + '-side-' + (s < 0 ? 'left' : 'right'), group: 'outshots', material: 'brick', u0: D - 0.05, u1: D + od, y0: 0,
        top: [[D + od, under(-od) + 0.05], [D - 0.05, under(0.05) + 0.05]], thickness: te });
    }
    leanToRoof(b, wfB, { id: id + '-roof', group: 'outshots', material: 'roof', u0: ox0 - 0.15, u1: ox1 + 0.15, wBack: 0.05, wFront: -(od + 0.15), yBack: under(0.05), pitch: lp, thickness: 0.14 });
    outshots.push({ k, px, ow, od, op, ox0, ox1 });
  });

  // ---- dormers ------------------------------------------------------------------------------
  const dormers = [];
  if (p.roof.attic) {
    for (const h of houses.filter(x => x.h.dormer && x.kind !== 'shop')) {
      const dw = 1.5, sb = 0.45, pd = 40 * DEG, td = 0.12, x = h.xc, dh = 1.0;
      const topAt = z => h.plate + (D / 2 - Math.abs(z + D / 2)) * tan + h.roof.tv;       // roof top surface over the front slope
      const yRoof = topAt(-sb), sill = Math.max(yf + 2 * h.storey + 0.75, yRoof + 0.15);
      const dplate = sill + dh + 0.15, dRidge = dplate + dw / 2 * Math.tan(pd) + 0.15 / Math.cos(pd);
      const zBack = -((dRidge + 0.12 - h.plate - h.roof.tv) / tan + 0.25);
      if (!(dRidge + 0.3 < h.ridgeTop && -zBack + 0.3 < D / 2 && dw + 0.6 < h.w - 1.4)) continue;
      if (!dormers.length) b.group('dormers', 'Dormers on the front roof slopes', 'roof', 0.1, 'front');
      const id = 'dormer-' + (h.i + 1), x0 = x - dw / 2, x1 = x + dw / 2, wfD = wallFrame('z', 1, -sb);
      const underD = xx => dplate + (dw / 2 - Math.abs(xx - x)) * Math.tan(pd);
      const win = opening({ u0: x - (dw - 0.5) / 2, u1: x + (dw - 0.5) / 2, y0: sill, y1: sill + dh });
      wall(b, wfD, { id: id + '-front', group: 'dormers', material: 'brick', u0: x0 + td, u1: x1 - td, y0: yRoof - 0.35,
        top: [[x1 - td, underD(x1 - td) + 0.05], [x, underD(x) + 0.05], [x0 + td, underD(x0 + td) + 0.05]], thickness: td, openings: [win] });
      glazedOpening(b, wfD, win, { ...winOpts(h), id: id + '-window', group: 'dormers', sill: null, recess: 0.03, frameDepth: 0.08, mullions: 1 });
      const uMeet = (dplate + 0.05 - topAt(0)) / tan, uEnd = Math.max(sb + 0.3, uMeet + 0.3);
      for (const [s, xf] of [[-1, x0], [1, x1]]) {
        wallFrame('x', s, xf).extrude(b, id + '-cheek-' + (s < 0 ? 'left' : 'right'), 'dormers', 'brick',
          [[sb, topAt(-sb) - 0.35], [uEnd, topAt(-uEnd) - 0.35], [uEnd, dplate + 0.05], [sb, dplate + 0.05]], 0, td);
      }
      gableRoofZ(b, { id: id + '-roof', group: 'dormers', material: 'roof', z0: zBack, z1: -sb + 0.12, xRidge: x, halfWidth: dw / 2, plate: dplate, pitch: pd, overhang: 0.1, thickness: 0.15 });
      dormers.push({ h, x, sb, dplate, dw });
    }
  }

  // ---- rainwater ----------------------------------------------------------------------------
  for (const h of houses) {
    const gy = h.eaveLow + 0.07, [x0, x1] = h.rx;
    for (const [name, z] of [['front', ov + 0.06], ['rear', -D - ov - 0.06]]) b.beam('gutter-' + (h.i + 1) + '-' + name, 'rainwater', 'metal', [x0 + 0.03, gy, z], [x1 - 0.03, gy, z], 0.065, 20);
    // One front downpipe per house, on the side away from its door (the neighbour's door
    // is beyond the party wall there only when the pair shares it, which is the door side).
    const dx = h.door && h.kind === 'house' ? (h.doorSide < 0 ? h.xb - 0.22 : h.xa + 0.22) : (e < 0 ? h.xb - 0.22 : h.xa + 0.22);
    if (h.kind !== 'shop' && !(h.bayPlan && dx > h.bayPlan.x0 - 0.2 && dx < h.bayPlan.x1 + 0.2)) {
      b.beam('downpipe-' + (h.i + 1) + '-offset', 'rainwater', 'metal', [dx, gy - 0.03, ov + 0.06], [dx, gy - 0.5, 0.1], 0.04, 12);
      b.beam('downpipe-' + (h.i + 1), 'rainwater', 'metal', [dx, gy - 0.5, 0.1], [dx, 0.05, 0.1], 0.04, 12);
      h.downpipe = dx;
    }
  }

  // ---- probes ---------------------------------------------------------------------------------
  // Plain front wall between ground-floor openings, widest stretches first.
  const pierList = piers.filter(([h, a, c]) => !(h.downpipe > a - 0.35 && h.downpipe < c + 0.35)).sort((x, y) => (y[2] - y[1]) - (x[2] - x[1]));
  for (const [h, a, c] of pierList.slice(0, 4)) b.probe('front-wall', 'Position of the front wall', [(a + c) / 2, yf + 1.6, 60], [0, 0, -1]);
  // The two gable ends, on blank brickwork.
  for (const side of [-1, 1]) {
    const h = endHouses[side], name = side < 0 ? 'left' : 'right';
    for (const [y, u] of [[1.6, D * 0.72], [h.upperSill + 0.5, D * 0.72], [1.6, D * 0.2], [h.plate - 0.6, D * 0.85]]) {
      if (side === e && sideDoor && Math.abs(u - (sideDoor.u0 + sideDoor.u1) / 2) < 1.6) continue;
      b.probe('end-' + name, 'Position of the ' + name + ' end wall', [side * 120, y, -u], [-side, 0, 0]);
    }
  }
  for (const o of outshots) for (const f of [0.5, 0.7]) b.probe('outshot-rear', 'Position of the rear outshot wall', [o.px + o.ow * (f - 0.1), 0.55, -60], [0, 0, 1]);
  for (const d of dormers) for (const [dx, dz] of [[0.36, 0.42], [0.4, 0.55]]) b.probe('dormer-roof', 'Height of the dormer roof slope', [d.x + dx, 60, -d.sb - dz], [0, -1, 0]);
  const stackX = stacks.map(st => st.x), dormerX = dormers.map(d => d.x);
  for (const h of houses) {
    const xsp = [h.xc + 0.6, h.xc - 0.6].filter(x => stackX.every(sx => Math.abs(x - sx) > sk.w / 2 + 0.8));
    for (const x of xsp.slice(0, 1)) {
      if (dormerX.every(dx => Math.abs(x - dx) > 1.6)) b.probe('roof-front', 'Height of the front roof slope', [x, 60, -D * 0.25], [0, -1, 0]);
      b.probe('roof-rear', 'Height of the rear roof slope', [x, 60, -D * 0.75], [0, -1, 0]);
    }
  }
  // Rear wall between the two upper rear windows, above any outshot roof.
  for (const h of [...houses].sort((a, c) => Math.abs(a.xc) - Math.abs(c.xc))) {
    const [a, c] = h.rearUpper, gap = [a.u1, c.u0];
    if (gap[1] - gap[0] > 0.9) b.probe('rear-wall', 'Position of the rear wall', [(gap[0] + gap[1]) / 2, h.upperSill + 0.6, -60], [0, 0, 1]);
  }
  // Front wall between upper windows.
  for (const h of houses) {
    const ups = [...h.upper].sort((a, c) => a.u0 - c.u0), edges = [h.i === first ? h.xa + T : h.xa, ...ups.flatMap(o => [o.u0, o.u1]), h.i === last ? h.xb - T : h.xb];
    for (let k = 0; k + 1 < edges.length; k += 2) {
      const [a, c] = [edges[k] + 0.1, edges[k + 1] - 0.1];
      if (c - a > 0.9) b.probe('front-upper', 'Position of the front wall at the upper floor', [(a + c) / 2, h.upperSill + 0.6, 60], [0, 0, -1]);
    }
  }
  for (const o of outshots) for (const f of [0.4, 0.6]) b.probe('outshot-roof', 'Height of a rear outshot roof', [o.px + o.ow * f, 60, -D - o.od * 0.6], [0, -1, 0]);
  if (endHouse?.fascia) b.probe('shop-fascia', 'Position of the shop fascia', [endHouse.fascia.u, endHouse.fascia.y, 60], [0, 0, -1]);
  for (const h of bays) b.probe('bay-front', 'Position of the bay window front', [h.bayProbe.x, h.bayProbe.y, 60], [0, 0, -1]);

  // ---- dimensions -------------------------------------------------------------------------------
  const h0 = endHouses[-1], hz = endHouses[1];
  b.dimension('overall-length', 'Overall length of the row along the front', [xL, 0, 0], [xR, 0, 0], 'front');
  b.dimension('depth', 'Depth of the houses', [xR, 0, 0], [xR, 0, -D], 'plan');
  b.dimension('eaves-height', 'Height of the eaves at the left end (underside at the wall line)', [xL, 0, 0], [xL, h0.plate, 0], 'front');
  b.dimension('ridge-height-right', 'Ridge height at the right gable', [xR, 0, -D / 2], [xR, hz.roof.ridgeTop, -D / 2], 'right');
  const mid = houses.find(h => h.i !== first && h.i !== last);
  if (mid) b.dimension('house-width', 'Width of one house (party wall to party wall)', [mid.xa, yf, 0], [mid.xb, yf, 0], 'front');
  const dh = houses.find(h => h.door && h.kind === 'house');
  if (dh) b.dimension('door-width', 'Width of a front door opening', [dh.door.u0, dh.door.y0, 0], [dh.door.u1, dh.door.y0, 0], 'front');
  const wh = houses.find(h => h.windows.some(o => !h.bayPlan || o !== h.bayPlan.o));
  if (wh) { const o = wh.windows.find(q => !wh.bayPlan || q !== wh.bayPlan.o); b.dimension('window-width', 'Width of a ground-floor window opening', [o.u0, o.y0, 0], [o.u1, o.y0, 0], 'front'); }
  if (stacks.length) { const st = stacks[0]; b.dimension('chimney-height', 'Height to the top of a chimney cap', [st.x - st.w / 2 - 0.06, 0, 0], [st.x - st.w / 2 - 0.06, st.top + 0.1, 0], 'front'); }
  if (outshots.length) { const o = outshots[0]; b.dimension('outshot-depth', 'Depth of a rear outshot', [o.ox1, 0, -D], [o.ox1, 0, -D - o.od], 'plan'); }
  if (bays.length) { const h = bays[0]; b.dimension('bay-projection', 'Projection of a bay window', [h.bayPlan.x1, 0, 0], [h.bayPlan.x1, 0, h.bayPlan.bd], 'plan'); }
  if (p.step && present.includes(p.step.at) && present.includes(p.step.at - 1)) {
    // At the step, the eaves of the houses on the far side of it from the left end:
    // 'eaves-height' already gives the left end's section, so naming the taller
    // houses when the left end is itself taller would state the same value twice
    // and never the other one.
    const other = [byIndex.get(p.step.at - 1), byIndex.get(p.step.at)].find(h => h.plate !== h0.plate), x = xs[p.step.at];
    if (other) b.dimension('step-eaves-height', 'Eaves height of the ' + (other.plate > h0.plate ? 'taller' : 'lower') + ' houses (at the step)', [x, 0, 0], [x, other.plate, 0], 'front');
  }
  b.dimensions.splice(12);

  return {
    builder: b,
    title: 'Row of terraced houses',
    frame: {
      origin: 'On the ground at the midpoint of the front wall of the whole row; the front wall face is the plane z = 0 and the houses extend towards -Z.',
      front: 'The street front, with the front doors, faces +Z; +X is to the right when you look at the front.',
    },
    scope_note: 'The row of houses only: walls, roofs, party-wall parapets, chimneys, windows, doors and steps, bays, dormers, the shopfront or side entrance where present, ' +
      'rear outshots, gutters and downpipes. No ground plane, front gardens, railings, boundary walls, pavements, vehicles or neighbouring buildings.',
    probeOrder: ['end-' + (e < 0 ? 'right' : 'left'), 'outshot-rear', 'dormer-roof', 'outshot-roof', 'front-wall', 'end-' + (e < 0 ? 'left' : 'right'), 'roof-front', 'roof-rear',
      'rear-wall', 'front-upper', 'shop-fascia', 'bay-front'],
    structure: { houses: present.length, end: p.end.kind, endSide: e, step: !!p.step, parapets: parapet.size, bays: bays.length, dormers: dormers.length, outshots: outshots.length },
  };
}

export const edits = [
  {
    // The house at the plain end was added later: the row was one house shorter.
    id: 'fewer-houses', applies: p => p.removed === null,
    scope: ['body', 'roof', 'chimneys', 'party.walls', 'front.windows', 'front.doors', 'rear', 'rainwater', 'bays', 'dormers', 'outshots'],
    apply: p => ({ ...p, removed: p.end.side < 0 ? p.massing.units - 1 : 0 }),
    phrase: 'the row was one house shorter',
  },
  { id: 'no-outshots', scope: ['outshots'], applies: (p, s) => s.outshots > 0, apply: p => ({ ...p, pairs: p.pairs.map(q => ({ ...q, built: false })) }), phrase: 'the rear outshots had not been built' },
  { id: 'no-dormers', scope: ['dormers'], applies: (p, s) => s.dormers > 0, apply: p => ({ ...p, roof: { ...p.roof, attic: false } }), phrase: 'the dormers had not been added' },
];

export default { id: 'terrace', sample, build, edits };
