// Detached house: one or two storeys, optional attic storey with dormers, gable
// or hipped roof, chimney, entrance landing with an optional porch, optional bay
// window, side garage and rear extension. Dimensions follow ordinary European
// practice (2.7-3.0 m storeys, 0.3 m walls, 30-50 degree pitches).
import {
  ModelBuilder, wallFrame, wall, opening, glazedOpening, doorOpening, garageDoor, gableRoofX, gableRoofZ, hipRoof,
  leanToRoof, band, lintel, quoins, draw, DEG,
} from '../kit.mjs';

const T = 0.3;          // main wall thickness
const ROOF_T = 0.24;    // roof slab thickness, normal to the slope
const FASCIA = 0.22;    // hipped roof fascia height

// heads: material of window heads (null = none); quoins on rendered walls.
const PALETTES = [
  { wall: ['#9a5741', 'wall'], trim: ['#5f3a2d', 'wall'], roof: ['#7a3d2e', 'roof'], frame: '#f1f0ea', door: '#2c4a35', metal: '#2a2c2e', sill: '#c2bcae', fascia: '#f1f0ea', heads: 'sill', quoins: false },
  { wall: ['#e7e0d1', 'wall'], trim: ['#9d978a', 'stone'], roof: ['#3e4347', 'roof'], frame: '#f4f3ef', door: '#6c2224', metal: '#ecebe6', sill: '#bdb6a6', fascia: '#f4f3ef', heads: 'sill', quoins: true },
  { wall: ['#b7865f', 'wall'], trim: ['#7e5b43', 'wall'], roof: ['#5b5450', 'roof'], frame: '#3f4448', door: '#22344d', metal: '#2a2c2e', sill: '#a9a294', fascia: '#2f3236', heads: 'trim', quoins: false },
  { wall: ['#d9cfbb', 'wall'], trim: ['#8c4b38', 'wall'], roof: ['#8b4a36', 'roof'], frame: '#e9e2cf', door: '#5a3f2c', metal: '#ecebe6', sill: '#c8c1b1', fascia: '#e9e2cf', heads: 'trim', quoins: true },
  { wall: ['#8a4b3b', 'wall'], trim: ['#a59f92', 'stone'], roof: ['#474c50', 'roof'], frame: '#ffffff', door: '#1f2a33', metal: '#2a2c2e', sill: '#d2cdc0', fascia: '#ffffff', heads: 'sill', quoins: false },
];

export function sample(r) {
  const m = r.fork('massing');
  const floors = m.chance(0.3) ? 1 : 2;
  const attic = m.chance(floors === 1 ? 0.6 : 0.35);
  const width = draw(m, floors === 1 ? 9.0 : 7.8, floors === 1 ? 12.6 : 11.4);
  const depth = draw(m, 7.2, 9.4);
  const roofType = m.chance(0.6) ? 'gable' : 'hip';
  const massing = {
    floors, attic, width, depth, roofType,
    storey: draw(m, 2.7, 3.0), floorLevel: draw(m, 0.15, 0.3),
    pitch: roofType === 'gable' ? draw(m, attic ? 40 : 34, attic ? 50 : 44, 1) : draw(m, attic ? 34 : 26, attic ? 42 : 36, 1),
    knee: attic ? draw(m, 0.5, 0.9) : 0.25,
    overhang: draw(m, 0.3, 0.5), verge: draw(m, 0.15, 0.35),
  };

  const f = r.fork('facade');
  const cols = width < 9 ? f.pick([2, 3]) : width < 10.6 ? f.pick([3, 3, 4]) : f.pick([3, 4]);
  const bay = width / cols;
  const facade = {
    cols, doorCol: cols % 2 ? f.pick([...Array(cols).keys()].filter(i => i !== (cols - 1) / 2)) : f.int(0, cols - 1),
    windowW: Math.min(draw(f, 1.0, 1.5), bay - 0.9), upperW: draw(f, 0.85, 1.3),
    windowH: draw(f, 1.25, 1.5), upperH: draw(f, 1.05, 1.3),
    doorW: draw(f, 1.0, 1.15), doorH: draw(f, 2.1, 2.2),
    fanlight: floors > 1 && f.chance(0.45) ? draw(f, 0.3, 0.4) : 0,
    doorStyle: f.pick(['panel', 'glazed', 'panel', 'boarded']),
    mullions: f.pick([0, 1, 1, 2]), transom: f.chance(0.55),
    rearCols: f.int(floors === 1 ? 3 : 2, cols + 1), rearDoorCol: f.int(0, 1),
    sideWindows: floors === 1 ? 2 : f.int(1, 2),
    // Fixed even when no wing is built, so an earlier state keeps the same walls:
    // the windowed side (a garage goes on the other one) and the blank stretch of
    // rear wall where an extension stands or would stand.
    sideWindowSide: f.pick([-1, 1]),
    rearWing: { side: f.pick([-1, 1]), width: draw(f, 3.4, Math.min(4.8, width / 2 + 0.4)) },
  };
  facade.upperW = Math.min(facade.upperW, facade.windowW);

  const e = r.fork('entrance');
  const entrance = { landingDepth: draw(e, 1.3, 1.7), landingExtra: draw(e, 0.35, 0.6) };

  const o = r.fork('options');
  const porch = o.chance(0.7) ? { type: o.pick(['hood', 'gabled', 'leanto']), pitch: draw(o, 30, 42, 1) } : null;
  const nonDoor = [...Array(cols).keys()].filter(i => i !== facade.doorCol && Math.abs(i - facade.doorCol) > 1);
  const bayWin = cols >= 3 && nonDoor.length && o.chance(0.45) ? { col: o.pick(nonDoor), depth: draw(o, 0.75, 1.0), pitch: draw(o, 20, 30, 1) } : null;
  const garage = o.chance(0.45) ? {
    side: -facade.sideWindowSide, width: draw(o, 3.0, 3.6), depth: draw(o, 5.2, Math.min(6.4, depth - 0.6)), setback: draw(o, 0.4, 1.4),
    plate: draw(o, 2.55, 2.8), roof: o.pick(['flat', 'gable', 'leanto']), pitch: draw(o, 30, 40, 1),
  } : null;
  const extension = o.chance(0.45) ? { depth: draw(o, 3.0, 4.4), plate: draw(o, 2.6, 2.85), roof: o.pick(['flat', 'leanto']) } : null;
  const dormers = attic && o.chance(0.85) ? { count: width > 10.5 ? o.int(1, 3) : o.int(1, 2), width: draw(o, 1.4, 1.8), setback: draw(o, 0.35, 0.6) } : null;
  const c = r.fork('chimney');
  // 'gable': an external breast and stack on the windowed gable wall (gabled roofs only).
  const chimney = { side: c.pick([-1, 1]), at: roofType === 'gable' ? c.pick(['ridge', 'rear', 'gable', 'gable']) : c.pick(['ridge', 'rear']),
    breastWidth: draw(c, 1.2, 1.6), breastDepth: draw(c, 0.45, 0.6), offset: draw(c, 0.9, 1.7), w: draw(c, 0.6, 0.9), d: draw(c, 0.5, 0.7),
    above: draw(c, 0.6, 1.1), pots: c.int(1, 3), aerial: c.chance(0.5) };
  const rain = r.fork('rainwater');
  const downpipes = rain.pick([['front-left', 'rear-right'], ['front-right', 'rear-left'], ['front-left'], ['front-right'], ['front-left', 'front-right']]);
  const palette = r.fork('palette').int(0, PALETTES.length - 1);
  const params = { massing, facade, entrance, porch, bay: bayWin, garage, extension, dormers, chimney, downpipes, palette };
  // Every house needs at least one later addition so an earlier state exists.
  // Every house gets a wing: it is the one later addition that always fits (a porch or a
  // bay can be dropped for lack of headroom), so an earlier state always exists, and it
  // gives the massing a clear left/right asymmetry.
  if (!garage && !extension) {
    const w = r.fork('fallback-wing');
    params.extension = { depth: draw(w, 3.0, 4.4), plate: draw(w, 2.6, 2.85), roof: w.pick(['flat', 'leanto']) };
  }
  return params;
}

export function build(p) {
  const b = new ModelBuilder();
  const { floors, attic, width: W, depth: D, roofType, storey, floorLevel: yf, knee, overhang: ov, verge } = p.massing;
  const pitch = p.massing.pitch * DEG, tan = Math.tan(pitch);
  const pal = PALETTES[p.palette];
  b.material('wall', pal.wall[0], pal.wall[1], { roughness: 0.9 });
  b.material('trim', pal.trim[0], pal.trim[1], { roughness: 0.9 });
  b.material('roof', pal.roof[0], 'roof', { roughness: 0.8 });
  b.material('frame', pal.frame, 'frame', { roughness: 0.5 });
  b.material('glass', '#2e4250', 'glass', { roughness: 0.05 });
  b.material('door', pal.door, 'wood', { roughness: 0.6 });
  b.material('sill', pal.sill, 'stone', { roughness: 0.8 });
  b.material('metal', pal.metal, 'metal', { roughness: 0.4, metalness: 0.6 });
  b.material('timber', '#ece9e1', 'wood', { roughness: 0.6 });
  b.material('paving', '#a7a297', 'stone', { roughness: 0.9 });
  b.material('chimney', pal.wall[1] === 'wall' && pal.wall[0] < '#c' ? pal.wall[0] : '#8c5444', 'wall', { roughness: 0.9 });
  b.material('garage-door', '#d9d7d0', 'metal', { roughness: 0.5, metalness: 0.3 });
  b.material('fascia', pal.fascia, 'wood', { roughness: 0.6 });
  b.material('ridge', '#2c2a29', 'roof', { roughness: 0.8 });

  const plate = yf + floors * storey + knee;
  const upperSill = floors > 1 ? yf + storey + 0.85 : Infinity;
  const { cols, windowW, upperW, windowH, upperH, doorW, doorH, fanlight } = p.facade;
  const bayPitch = W / cols, colX = i => -W / 2 + bayPitch * (i + 0.5);
  const doorX = colX(p.facade.doorCol);

  b.group('body', 'Main walls and plinth', 'massing', 0.3, 'all');
  b.group('roof', 'Main roof', 'roof', 0.24, 'roof');
  b.group('chimney', 'Chimney stack, cap and pots', 'roof', 0.15, 'roof');
  b.group('front.windows.ground', 'Front ground-floor windows', 'openings', 0.07, 'front');
  if (floors > 1) b.group('front.windows.upper', 'Front upper-floor windows', 'openings', 0.07, 'front');
  b.group('front.entrance', 'Front door and landing', 'entrance', 0.08, 'front');
  b.group('rear.windows', 'Rear windows and back door', 'openings', 0.07, 'rear');
  const sideSign = p.facade.sideWindowSide;
  const sideName = sideSign < 0 ? 'left' : 'right';
  b.group('side.windows', 'Windows in the ' + sideName + ' side wall', 'openings', 0.07, sideName);
  b.group('rainwater', 'Gutters and downpipes', 'attachments', 0.08, 'all');

  // ---- main walls -------------------------------------------------------------
  const wfFront = wallFrame('z', 1, 0), wfRear = wallFrame('z', -1, -D);
  const wfLeft = wallFrame('x', -1, -W / 2), wfRight = wallFrame('x', 1, W / 2);
  const frontOpenings = [], rearOpenings = [], sideOpenings = [];
  const groundSill = yf + 0.9;
  const door = opening({ u0: doorX - doorW / 2, u1: doorX + doorW / 2, y0: yf, y1: yf + doorH + fanlight });
  frontOpenings.push({ kind: 'door', o: door });
  // Headroom under the front eaves (and below upper windows) for porches and bays,
  // decided before the openings so a bay that cannot fit leaves a normal window.
  const eaveLow = roofType === 'gable' ? plate - ov * tan : plate;
  const frontLimit = Math.min(eaveLow - 0.08, upperSill - 0.12);
  const landingX = [door.u0 - p.entrance.landingExtra, door.u1 + p.entrance.landingExtra];
  let bayPlan = null;
  if (p.bay) {
    const bx = colX(p.bay.col), bw = windowW + 0.8, bd = p.bay.depth, bp = p.bay.pitch * DEG;
    const bayPlate = groundSill + windowH + 0.28, x0 = bx - bw / 2, x1 = bx + bw / 2;
    const topAtWall = bayPlate + (bd + 0.05) * Math.tan(bp) + 0.12 / Math.cos(bp);
    if (topAtWall <= frontLimit && x0 > -W / 2 + 0.5 && x1 < W / 2 - 0.5 && (x1 < landingX[0] - 0.25 || x0 > landingX[1] + 0.25)) bayPlan = { bx, bw, bd, bp, bayPlate, x0, x1 };
  }
  const groundWindows = [];
  for (let i = 0; i < cols; i++) {
    if (i === p.facade.doorCol || (bayPlan && i === p.bay.col)) continue;
    const x = colX(i), o = opening({ u0: x - windowW / 2, u1: x + windowW / 2, y0: groundSill, y1: groundSill + windowH });
    frontOpenings.push({ kind: 'ground', o }); groundWindows.push(o);
  }
  if (floors > 1) {
    for (let i = 0; i < cols; i++) {
      const w = i === p.facade.doorCol ? Math.min(0.75, upperW) : upperW, x = colX(i);
      frontOpenings.push({ kind: 'upper', o: opening({ u0: x - w / 2, u1: x + w / 2, y0: upperSill, y1: upperSill + upperH }) });
    }
  }
  // Rear: a back door and windows; the ground floor keeps clear of where the
  // extension stands (or would stand), so the wall behind it is blank.
  const ext = p.extension, wing = p.facade.rearWing;
  const extRange = wing.side < 0 ? [-W / 2 + 0.6, -W / 2 + 0.6 + wing.width] : [W / 2 - 0.6 - wing.width, W / 2 - 0.6];
  const rearPitch = W / p.facade.rearCols, rearX = i => -W / 2 + rearPitch * (i + 0.5);
  const clearOfExt = (u0, u1) => u1 < extRange[0] - 0.4 || u0 > extRange[1] + 0.4;
  let backDoorPlaced = false;
  for (let i = 0; i < p.facade.rearCols; i++) {
    const x = rearX(i), wantDoor = !backDoorPlaced && i >= p.facade.rearDoorCol;
    const w = wantDoor ? 0.95 : Math.min(windowW, rearPitch - 0.8);
    const o = wantDoor ? opening({ u0: x - w / 2, u1: x + w / 2, y0: yf, y1: yf + 2.1 })
      : opening({ u0: x - w / 2, u1: x + w / 2, y0: groundSill + 0.1, y1: groundSill + 0.1 + windowH - 0.1 });
    if (clearOfExt(o.u0, o.u1)) { rearOpenings.push({ kind: wantDoor ? 'door' : 'window', o }); if (wantDoor) backDoorPlaced = true; }
    if (floors > 1) {
      const uw = Math.min(upperW, rearPitch - 0.8);
      rearOpenings.push({ kind: 'window', o: opening({ u0: x - uw / 2, u1: x + uw / 2, y0: upperSill, y1: upperSill + upperH - 0.1 }) });
    }
  }
  // Side windows: one side only, clear of the garage zone; attic gable windows on gables.
  const sideWf = sideSign < 0 ? wfLeft : wfRight;
  for (let level = 0; level < floors; level++) {
    const y0 = level === 0 ? groundSill : upperSill;
    for (let k = 0; k < p.facade.sideWindows; k++) {
      // An external chimney breast takes the middle of the gable.
      const gableStack = p.chimney.at === 'gable';
      const u = p.facade.sideWindows === 1 ? D * (gableStack ? 0.2 : 0.62) : D * (k === 0 ? (gableStack ? 0.18 : 0.3) : (gableStack ? 0.82 : 0.7));
      sideOpenings.push(opening({ u0: u - 0.45, u1: u + 0.45, y0, y1: y0 + (level === 0 ? 1.2 : 1.05) }));
    }
  }
  const atticFloor = yf + floors * storey;
  const gableWindow = attic && roofType === 'gable' ? opening({ u0: D / 2 - 0.4, u1: D / 2 + 0.4, y0: atticFloor + 0.9, y1: atticFloor + 1.9 }) : null;
  // The attic gable window moves to the other gable when the stack is external.
  const otherOpenings = [];
  if (gableWindow) (p.chimney.at === 'gable' ? otherOpenings : sideOpenings).push(gableWindow);

  const wallTop = plate + 0.05;
  const gableTop = roofType === 'gable' ? [[D, wallTop], [D / 2, plate + D / 2 * tan + 0.05], [0, wallTop]] : [[D, wallTop], [0, wallTop]];
  wall(b, wfFront, { id: 'wall-front', group: 'body', material: 'wall', u0: -W / 2 + T, u1: W / 2 - T, y0: 0, y1: wallTop, thickness: T, openings: frontOpenings.map(x => x.o) });
  wall(b, wfRear, { id: 'wall-rear', group: 'body', material: 'wall', u0: -W / 2 + T, u1: W / 2 - T, y0: 0, y1: wallTop, thickness: T, openings: rearOpenings.map(x => x.o) });
  for (const [name, wf] of [['left', wfLeft], ['right', wfRight]]) {
    wall(b, wf, { id: 'wall-' + name, group: 'body', material: 'wall', u0: 0, u1: D, y0: 0, top: gableTop, thickness: T, openings: wf === sideWf ? sideOpenings : otherOpenings });
  }
  // Plinth course; the front and rear bands wrap the corners, the side bands stop at them.
  const plinthTop = Math.min(yf + 0.12, 0.4);
  const doorGap = o => [o.u0 - 0.04, o.u1 + 0.04];
  band(b, wfFront, { id: 'plinth-front', group: 'body', material: 'trim', u0: -W / 2 - 0.03, u1: W / 2 + 0.03, y0: 0, y1: plinthTop, gaps: [doorGap(door)] });
  band(b, wfRear, { id: 'plinth-rear', group: 'body', material: 'trim', u0: -W / 2 - 0.03, u1: W / 2 + 0.03, y0: 0, y1: plinthTop,
    gaps: rearOpenings.filter(x => x.kind === 'door').map(x => doorGap(x.o)) });
  band(b, wfLeft, { id: 'plinth-left', group: 'body', material: 'trim', u0: 0.02, u1: D - 0.02, y0: 0, y1: plinthTop });
  band(b, wfRight, { id: 'plinth-right', group: 'body', material: 'trim', u0: 0.02, u1: D - 0.02, y0: 0, y1: plinthTop });

  // ---- windows and doors -------------------------------------------------------
  const winOpts = { frame: 'frame', glass: 'glass', sill: 'sill', mullions: p.facade.mullions };
  let g = 0, u = 0;
  for (const { kind, o } of frontOpenings) {
    if (kind === 'door') continue;
    const ground = kind === 'ground', id = ground ? 'window-front-g' + (++g) : 'window-front-u' + (++u);
    glazedOpening(b, wfFront, o, { ...winOpts, id, group: ground ? 'front.windows.ground' : 'front.windows.upper',
      mullions: o.u1 - o.u0 < 0.9 ? 0 : p.facade.mullions, transoms: p.facade.transom ? [o.top - 0.42] : [] });
    if (pal.heads) lintel(b, wfFront, o, { id: id + '.head', group: ground ? 'front.windows.ground' : 'front.windows.upper', material: pal.heads });
  }
  doorOpening(b, wfFront, door, { id: 'door-front', group: 'front.entrance', frame: 'frame', leaf: 'door', glass: 'glass', metal: 'metal',
    style: p.facade.doorStyle, fanlight, handleSide: doorX > 0 ? -1 : 1 });
  let rw = 0;
  for (const { kind, o } of rearOpenings) {
    if (kind === 'door') doorOpening(b, wfRear, o, { id: 'door-rear', group: 'rear.windows', frame: 'frame', leaf: 'door', glass: 'glass', metal: 'metal', style: 'glazed' });
    else {
      glazedOpening(b, wfRear, o, { ...winOpts, id: 'window-rear-' + (++rw), group: 'rear.windows', mullions: o.u1 - o.u0 < 0.9 ? 0 : 1 });
      if (pal.heads) lintel(b, wfRear, o, { id: 'window-rear-' + rw + '.head', group: 'rear.windows', material: pal.heads });
    }
  }
  if (otherOpenings.length) {
    const otherWf = sideSign < 0 ? wfRight : wfLeft, otherName = sideSign < 0 ? 'right' : 'left';
    b.group('gable.window', 'Attic window in the ' + otherName + ' gable', 'openings', 0.07, otherName);
    glazedOpening(b, otherWf, otherOpenings[0], { ...winOpts, id: 'window-gable', group: 'gable.window', mullions: 0 });
    if (pal.heads) lintel(b, otherWf, otherOpenings[0], { id: 'window-gable.head', group: 'gable.window', material: pal.heads });
  }
  sideOpenings.forEach((o, k) => {
    glazedOpening(b, sideWf, o, { ...winOpts, id: 'window-side-' + (k + 1), group: 'side.windows', mullions: 0, transoms: [] });
    if (pal.heads) lintel(b, sideWf, o, { id: 'window-side-' + (k + 1) + '.head', group: 'side.windows', material: pal.heads });
  });

  // Entrance landing (always there: porches are later additions built over it).
  const lx0 = door.u0 - p.entrance.landingExtra, lx1 = door.u1 + p.entrance.landingExtra, ld = p.entrance.landingDepth;
  b.box('landing', 'front.entrance', 'paving', [lx0, 0, -0.02], [lx1, yf - 0.02, ld]);
  {
    // Wall lamp beside the door, on the side towards the middle of the facade.
    const side = doorX > 0 ? -1 : 1, lu = side > 0 ? door.u1 + 0.3 : door.u0 - 0.3, ly = door.top - 0.95;
    wfFront.box(b, 'door-lamp', 'front.entrance', 'metal', lu - 0.07, lu + 0.07, ly - 0.12, ly + 0.12, -0.12, 0.02);
    wfFront.box(b, 'door-lamp-glass', 'front.entrance', 'glass', lu - 0.05, lu + 0.05, ly - 0.09, ly + 0.07, -0.15, -0.09);
    const back = rearOpenings.find(x => x.kind === 'door');
    if (back) {
      const o = back.o, hy = o.top + 0.2;
      wfRear.box(b, 'rear-step', 'rear.windows', 'paving', o.u0 - 0.15, o.u1 + 0.15, 0, yf - 0.02, -0.45, 0.02);
      // Small hood over the back door when it fits under the rear eaves.
      if (hy + 0.1 < Math.min(eaveLow - 0.1, upperSill - 0.1)) {
        wfRear.box(b, 'rear-hood', 'rear.windows', 'roof', o.u0 - 0.2, o.u1 + 0.2, hy, hy + 0.1, -0.7, 0.03);
        for (const [k, u] of [[1, o.u0 - 0.08], [2, o.u1 + 0.08]]) {
          wfRear.sideProfile(b, 'rear-hood-bracket-' + k, 'rear.windows', 'timber', [[0.02, hy + 0.02], [0.02, hy - 0.4], [-0.55, hy + 0.02]], u - 0.035, u + 0.035);
        }
      }
    }
  }

  // Electricity meter box low on the windowed side wall, near the front corner.
  sideWf.box(b, 'meter-box', 'body', 'trim', 0.75, 1.3, 0.4, 0.95, -0.22, 0.02);

  // ---- roof ----------------------------------------------------------------------
  let roofInfo, frontEaveZ, rearEaveZ, roofTopFront;
  if (roofType === 'gable') {
    roofInfo = gableRoofX(b, { id: 'roof-main', group: 'roof', material: 'roof', x0: -W / 2 - verge, x1: W / 2 + verge, zRidge: -D / 2,
      halfDepth: D / 2, plate, pitch, overhang: ov, thickness: ROOF_T });
    frontEaveZ = ov; rearEaveZ = -D - ov;
    roofTopFront = z => plate + -z * tan + roofInfo.tv;          // front slope, z in [-D/2, ov]
  } else {
    roofInfo = hipRoof(b, { id: 'roof-main', group: 'roof', material: 'roof', x0: -W / 2 - ov, x1: W / 2 + ov, z0: -D - ov, z1: ov, soffit: plate, fascia: FASCIA, pitch });
    frontEaveZ = ov; rearEaveZ = -D - ov;
    roofTopFront = z => plate + FASCIA + (ov - z) * tan;
  }
  const ridgeTop = roofInfo.ridgeTop;
  // Ridge cap, fascia and barge boards: painted timber edges are what make a roof
  // read as built rather than as a block. Boards hang 4-6 cm below the soffit and
  // stop 4 cm below the roof surface, so none of their faces is coplanar with it.
  if (roofType === 'gable') {
    const { under, tv, s } = roofInfo, xe = W / 2 + verge;
    b.beam('roof-ridge', 'roof', 'ridge', [-xe - 0.06, ridgeTop - 0.03, -D / 2], [xe + 0.06, ridgeTop - 0.03, -D / 2], 0.09, 16);
    // The boards run 2.5 cm past the slab's eave faces, flush with the fascia boards.
    const e = s + 0.025;
    const barge = [[e, under(e) - 0.04], [0, under(0) - 0.04], [-e, under(e) - 0.04], [-e, under(e) + tv - 0.04], [0, under(0) + tv - 0.04], [e, under(e) + tv - 0.04]]
      .map(([d, y]) => [-D / 2 + d, y]);
    b.prismX('roof-barge-left', 'roof', 'fascia', barge, -xe - 0.025, -xe + 0.02);
    b.prismX('roof-barge-right', 'roof', 'fascia', barge, xe - 0.02, xe + 0.025);
    b.box('roof-fascia-front', 'roof', 'fascia', [-xe + 0.02, under(s) - 0.06, ov - 0.02], [xe - 0.02, under(s) + tv - 0.05, ov + 0.025]);
    b.box('roof-fascia-rear', 'roof', 'fascia', [-xe + 0.02, under(s) - 0.06, -D - ov - 0.025], [xe - 0.02, under(s) + tv - 0.05, -D - ov + 0.02]);
  } else {
    const xe = W / 2 + ov, zf = ov, zr = -D - ov, y0 = plate - 0.04, y1 = plate + FASCIA - 0.04;
    b.box('roof-fascia-front', 'roof', 'fascia', [-xe - 0.025, y0, zf - 0.02], [xe + 0.025, y1, zf + 0.025]);
    b.box('roof-fascia-rear', 'roof', 'fascia', [-xe - 0.025, y0, zr - 0.025], [xe + 0.025, y1, zr + 0.02]);
    b.box('roof-fascia-left', 'roof', 'fascia', [-xe - 0.025, y0, zr + 0.02], [-xe + 0.02, y1, zf - 0.02]);
    b.box('roof-fascia-right', 'roof', 'fascia', [xe - 0.02, y0, zr + 0.02], [xe + 0.025, y1, zf - 0.02]);
    const [r0, r1] = roofInfo.ridge, lift = q => [q[0], q[1] - 0.02, q[2]];
    if (Math.hypot(r1[0] - r0[0], r1[2] - r0[2]) > 0.05) b.beam('roof-ridge', 'roof', 'ridge', lift(r0), lift(r1), 0.08, 16);
    roofInfo.corners.forEach((c, k) => {
      const end = Math.hypot(c[0] - r0[0], c[2] - r0[2]) < Math.hypot(c[0] - r1[0], c[2] - r1[2]) ? r0 : r1;
      b.beam('roof-hip-' + (k + 1), 'roof', 'ridge', lift(c), lift(end), 0.07, 12);
    });
  }
  if (pal.quoins) {
    const top = eaveLow - 0.12;
    for (const [name, cx, cz, sx, sz] of [['fl', -W / 2, 0, -1, 1], ['fr', W / 2, 0, 1, 1], ['rl', -W / 2, -D, -1, -1], ['rr', W / 2, -D, 1, -1]]) {
      quoins(b, { id: 'quoin-' + name, group: 'body', material: 'sill', corner: [cx, cz], sx, sz, y0: plinthTop, y1: top });
    }
  }

  // ---- chimney ---------------------------------------------------------------------
  {
    const c = p.chimney, top = ridgeTop + c.above;
    let xa, xb, za, zb, base;
    if (c.at === 'gable') {
      // External breast with sloped shoulders, then the stack up through the verge.
      const s = sideSign, cz = -D / 2, bw = c.breastWidth, sw = c.w;
      [xa, xb] = s < 0 ? [-W / 2 - c.breastDepth, -W / 2 + 0.05] : [W / 2 - 0.05, W / 2 + c.breastDepth];
      [za, zb] = [cz - sw / 2, cz + sw / 2];
      const yw = eaveLow - 0.6;
      base = yw + (bw - sw) / 2;
      b.prismX('chimney-breast', 'chimney', 'chimney', [[cz - bw / 2, 0], [cz + bw / 2, 0], [cz + bw / 2, yw], [zb, base], [za, base], [cz - bw / 2, yw]], xa, xb);
    } else {
      let cx = c.side * (W / 2 - c.offset), cz = c.at === 'ridge' ? -D / 2 : -D / 2 - 1.1;
      if (roofType === 'hip') {
        const ridgeHalf = roofInfo.alongX ? Math.max(0, (W + 2 * ov) / 2 - roofInfo.half) : 0;
        if (Math.abs(cx) > ridgeHalf - 0.2) cz = -D / 2 - Math.min(1.1, D / 4);
        cx = Math.sign(cx || 1) * Math.min(Math.abs(cx), W / 2 - 0.9);
      }
      const reach = Math.abs(cz + D / 2) + c.d / 2;
      base = plate + Math.max(0, D / 2 - reach - 0.4) * tan - 0.4;
      [xa, xb, za, zb] = [cx - c.w / 2, cx + c.w / 2, cz - c.d / 2, cz + c.d / 2];
    }
    b.box('chimney-stack', 'chimney', 'chimney', [xa, base, za], [xb, top, zb]);
    b.box('chimney-cap', 'chimney', 'sill', [xa - 0.06, top - 0.04, za - 0.06], [xb + 0.06, top + 0.1, zb + 0.06]);
    b.box('chimney-band', 'chimney', 'chimney', [xa - 0.04, top - 0.36, za - 0.04], [xb + 0.04, top - 0.24, zb + 0.04]);
    const cx = (xa + xb) / 2, cz = (za + zb) / 2, alongX = xb - xa >= zb - za, span = (alongX ? xb - xa : zb - za) - 0.26;
    for (let k = 0; k < c.pots; k++) {
      const t = c.pots === 1 ? 0 : (k / (c.pots - 1) - 0.5) * span;
      b.cylinder('chimney-pot-' + (k + 1), 'chimney', 'chimney', [cx + (alongX ? t : 0), top + 0.07, cz + (alongX ? 0 : t)], 0.42, 0.11, { top: 0.09, segments: 20 });
    }
    if (c.aerial) {
      // TV aerial clamped to the stack: mast, boom and elements (thin, 1-2 cm).
      const mx = xa - 0.05, m0 = [mx, top - 0.7, cz], m1 = [mx, top + 1.3, cz];
      b.beam('chimney-aerial-mast', 'chimney', 'metal', m0, m1, 0.022, 8);
      b.beam('chimney-aerial-boom', 'chimney', 'metal', [mx, top + 1.15, cz - 0.15], [mx, top + 1.15, cz + 0.85], 0.015, 8);
      for (let k = 0; k < 4; k++) {
        const z = cz + 0.05 + k * 0.25, half = 0.32 - k * 0.04;
        b.beam('chimney-aerial-element-' + (k + 1), 'chimney', 'metal', [mx - half, top + 1.15, z], [mx + half, top + 1.15, z], 0.008, 6);
      }
    }
    b.dimension('chimney-height', 'Height to the top of the chimney cap', [cx, 0, 0], [cx, top + 0.1, 0], 'front');
    var chimneyX = cx, chimneyHalf = (xb - xa) / 2 + 0.06;
  }

  // ---- rainwater -------------------------------------------------------------------
  {
    const gy = eaveLow + 0.07, run = roofType === 'gable' ? W / 2 + verge - 0.05 : W / 2 + ov - 0.05;
    b.beam('gutter-front', 'rainwater', 'metal', [-run, gy, frontEaveZ + 0.06], [run, gy, frontEaveZ + 0.06], 0.065, 24);
    b.beam('gutter-rear', 'rainwater', 'metal', [-run, gy, rearEaveZ - 0.06], [run, gy, rearEaveZ - 0.06], 0.065, 24);
    // Gutter brackets every ~0.75 m, sunk 2 cm into the fascia board and the gutter.
    for (const [name, zf, sign] of [['front', frontEaveZ, 1], ['rear', rearEaveZ, -1]]) {
      const n = Math.floor(2 * run / 0.75);
      for (let k = 0; k <= n; k++) {
        const x = -run + 0.1 + k * (2 * run - 0.2) / n;
        b.box('gutter-' + name + '-bracket-' + (k + 1), 'rainwater', 'metal', [x - 0.015, gy - 0.085, Math.min(zf + sign * 0.005, zf + sign * 0.11)], [x + 0.015, gy - 0.045, Math.max(zf + sign * 0.005, zf + sign * 0.11)]);
      }
    }
    if (roofType === 'hip') {
      for (const s of [-1, 1]) b.beam('gutter-' + (s < 0 ? 'left' : 'right'), 'rainwater', 'metal', [s * (W / 2 + ov + 0.06), gy, frontEaveZ - 0.05], [s * (W / 2 + ov + 0.06), gy, rearEaveZ + 0.05], 0.065, 24);
    }
    // Soil vent pipe through the rear slope, on the side away from the chimney.
    const vx = (chimneyX > 0 ? -1 : 1) * W / 4, vz = -D / 2 - Math.min(1.4, D / 4);
    const surface = roofType === 'gable' ? plate + (D / 2 - Math.abs(vz + D / 2)) * tan + roofInfo.tv : roofInfo.surface(vx, vz);
    b.cylinder('soil-vent', 'rainwater', 'metal', [vx, surface - 0.5, vz], 1.2, 0.055, { segments: 16 });
    for (const name of p.downpipes) {
      const s = name.endsWith('left') ? -1 : 1, front = name.startsWith('front');
      // Corners where a wing is or could be built keep no downpipe, wing or not.
      if (-p.facade.sideWindowSide === s) continue;
      if (!front && wing.side === s) continue;
      const x = s * (W / 2 - 0.22), zg = front ? frontEaveZ + 0.06 : rearEaveZ - 0.06, zw = front ? 0.1 : -D - 0.1;
      b.beam('downpipe-' + name + '-offset', 'rainwater', 'metal', [x, gy - 0.03, zg], [x, gy - 0.5, zw], 0.04, 16);
      b.beam('downpipe-' + name, 'rainwater', 'metal', [x, gy - 0.5, zw], [x, 0.05, zw], 0.04, 16);
    }
  }

  // ---- porch -------------------------------------------------------------------------
  const doorTop = door.top, xc = (lx0 + lx1) / 2, lw = lx1 - lx0;
  let porchType = null;
  if (p.porch) {
    b.group('front.porch', 'Entrance porch roof and supports', 'attachments', 0.1, 'front');
    const pp = p.porch.pitch * DEG, base = doorTop + 0.18;
    const fits = {
      gabled: base + (lw / 2 + 0.15) * Math.tan(pp) + 0.16 / Math.cos(pp) <= frontLimit,
      leanto: base + (ld + 0.05) * Math.tan(18 * DEG) + 0.14 / Math.cos(18 * DEG) <= frontLimit,
      hood: base + 0.12 <= frontLimit,
    };
    porchType = [p.porch.type, 'leanto', 'hood'].find(t => fits[t]) ?? null;
    // Vertical probes must land in front of the main eaves and gutter (z > ov + 0.12).
    const porchProbe = (label, x, front) => {
      for (const z of [(ov + 0.17 + front) / 2, front - 0.32, ld / 2]) b.probe('porch-top', label, [x, 30, z], [0, -1, 0]);
    };
    if (porchType === 'hood') {
      const depth = ld - 0.1;
      b.box('porch-hood', 'front.porch', 'roof', [lx0 + 0.05, base, -0.03], [lx1 - 0.05, base + 0.12, depth]);
      for (const [k, x] of [[1, lx0 + 0.18], [2, lx1 - 0.18]]) {
        wfFront.sideProfile(b, 'porch-bracket-' + k, 'front.porch', 'timber', [[0.02, base + 0.02], [0.02, base - 0.55], [-(Math.min(depth, 1.0) - 0.15), base + 0.02]], x - 0.04, x + 0.04);
      }
      porchProbe('Height of the top of the entrance hood', xc, depth);
    } else if (porchType) {
      const postTop = base, px = [lx0 + 0.12, lx1 - 0.12], pz = ld - 0.12;
      px.forEach((x, k) => b.box('porch-post-' + (k + 1), 'front.porch', 'timber', [x - 0.06, yf - 0.04, pz - 0.06], [x + 0.06, postTop + 0.02, pz + 0.06]));
      b.box('porch-beam', 'front.porch', 'timber', [lx0 + 0.03, postTop - 0.2, pz - 0.09], [lx1 - 0.03, postTop, pz + 0.09]);
      if (porchType === 'gabled') {
        gableRoofZ(b, { id: 'porch-roof', group: 'front.porch', material: 'roof', z0: -0.05, z1: ld + 0.1, xRidge: xc, halfWidth: lw / 2,
          plate: postTop, pitch: pp, overhang: 0.15, thickness: 0.16 });
        // Gable infill (pediment) just behind the roof's front edge; its sloped top runs
        // parallel to the roof underside, 3 cm up inside the slab.
        const tp = Math.tan(pp), eave = postTop + 0.04 * tp + 0.03;
        const tri = [[lx0 + 0.04, postTop - 0.02], [lx1 - 0.04, postTop - 0.02], [lx1 - 0.04, eave], [xc, postTop + lw / 2 * tp + 0.03], [lx0 + 0.04, eave]];
        b.prismZ('porch-gable', 'front.porch', 'timber', tri, pz - 0.04, pz + 0.04);
        porchProbe('Height of the porch roof slope', xc + lw / 4, ld + 0.1);
      } else {
        leanToRoof(b, wfFront, { id: 'porch-roof', group: 'front.porch', material: 'roof', u0: lx0 - 0.1, u1: lx1 + 0.1, wBack: 0.05,
          wFront: -(ld + 0.1), yBack: postTop + (ld - 0.12 + 0.05) * Math.tan(18 * DEG), pitch: 18 * DEG, thickness: 0.14 });
        porchProbe('Height of the porch roof', xc, ld + 0.1);
      }
    }
    if (!porchType) porchProbe('Height of the entrance landing', xc, ld);
  } else {
    for (const z of [(ov + 0.17 + ld) / 2, ld - 0.32, ld / 2]) b.probe('porch-top', 'Height of the entrance landing', [xc, 30, z], [0, -1, 0]);
  }
  b.dimension('porch-projection', 'Projection of the entrance landing', [lx1, 0, 0], [lx1, 0, ld], 'plan');

  // ---- bay window ----------------------------------------------------------------------
  let bayInfo = null;
  if (bayPlan) {
    const { bx, bd, x0, x1, bp, bayPlate } = bayPlan, tb = 0.2;
    {
      b.group('front.bay', 'Ground-floor bay window', 'attachments', 0.07, 'front');
      const under = w => bayPlate + (w + bd) * Math.tan(bp);
      const wfBay = wallFrame('z', 1, bd);
      const win = opening({ u0: x0 + 0.22, u1: x1 - 0.22, y0: groundSill - 0.05, y1: groundSill + windowH });
      wall(b, wfBay, { id: 'bay-front', group: 'front.bay', material: 'wall', u0: x0 + tb, u1: x1 - tb, y0: 0, y1: bayPlate + 0.05, thickness: tb, openings: [win] });
      glazedOpening(b, wfBay, win, { ...winOpts, id: 'bay-window-front', group: 'front.bay', recess: 0.06, frameDepth: 0.1, mullions: 2, transoms: [] });
      for (const [s, xf] of [[-1, x0], [1, x1]]) {
        const wf = wallFrame('x', s, xf), sideWin = bd >= 0.85 ? [opening({ u0: -(bd - tb) + 0.1, u1: -0.12, y0: groundSill - 0.05, y1: groundSill + windowH })] : [];
        wall(b, wf, { id: 'bay-side-' + (s < 0 ? 'left' : 'right'), group: 'front.bay', material: 'wall', u0: -bd, u1: 0.05, y0: 0,
          top: [[0.05, under(0.05) + 0.05], [-bd, under(-bd) + 0.05]], thickness: tb, openings: sideWin });
        if (sideWin.length) glazedOpening(b, wf, sideWin[0], { ...winOpts, id: 'bay-window-' + (s < 0 ? 'left' : 'right'), group: 'front.bay', recess: 0.04, frameDepth: 0.1, frameWidth: 0.06 });
      }
      leanToRoof(b, wfFront, { id: 'bay-roof', group: 'front.bay', material: 'roof', u0: x0 - 0.12, u1: x1 + 0.12, wBack: 0.05, wFront: -(bd + 0.15),
        yBack: under(0.05), pitch: bp, thickness: 0.12 });
      bayInfo = { x0, x1, bd, apronTop: groundSill - 0.05 - 0.05 };
      const py = (plinthTop + Math.min(bayInfo.apronTop, groundSill - 0.07)) / 2;
      b.probe('bay-front', 'Position of the bay window front', [bx, py, 30], [0, 0, -1]);
    }
  }

  // ---- garage --------------------------------------------------------------------------
  let garageInfo = null;
  if (p.garage) {
    const gp = p.garage, s = gp.side, gw = gp.width, gd = gp.depth, sb = gp.setback, tg = 0.25, gpl = gp.plate;
    b.group('garage', 'Attached side garage', 'massing', 0.2, s < 0 ? 'left' : 'right');
    // The wing is embedded 5 cm into the main side wall; its outer side wall runs
    // the full depth and the front and rear walls fit between.
    const inner = s * (W / 2 - 0.05), outer = s * (W / 2 + gw);
    const wfGF = wallFrame('z', 1, -sb), wfGR = wallFrame('z', -1, -sb - gd), wfGS = wallFrame('x', s, outer);
    const gx = s * (W / 2 + gw / 2), doorWidth = Math.min(2.5, gw - 0.7);
    const gDoor = opening({ u0: gx - doorWidth / 2, u1: gx + doorWidth / 2, y0: 0, y1: 2.1 });
    // The roof type is limited by the headroom under the main eaves.
    const gpitch = gp.pitch * DEG, leanPitch = 12 * DEG, tg2 = Math.tan(gpitch), tl = Math.tan(leanPitch);
    const gableTopY = gpl + gw / 2 * tg2 + 0.16 / Math.cos(gpitch);
    const leanTopY = gpl + (gw + 0.05) * tl + 0.14 / Math.cos(leanPitch);
    const limit = eaveLow - 0.15;
    const roof = gp.roof === 'gable' && gableTopY < limit ? 'gable' : gp.roof !== 'flat' && leanTopY < limit ? 'leanto' : 'flat';
    const [ua, ub] = s < 0 ? [outer + tg, inner] : [inner, outer - tg];
    // Wall tops follow the roof underside 5 cm up, so they sit inside the roof slab.
    const topY = roof === 'gable' ? x => gpl + (gw / 2 - Math.abs(x - gx)) * tg2 + 0.05
      : roof === 'leanto' ? x => gpl + (gw - Math.abs(x - s * W / 2)) * tl + 0.05 : () => gpl + 0.05;
    const endTop = roof === 'gable' ? [[ub, topY(ub)], [gx, topY(gx)], [ua, topY(ua)]] : [[ub, topY(ub)], [ua, topY(ua)]];
    wall(b, wfGF, { id: 'garage-wall-front', group: 'garage', material: 'wall', u0: ua, u1: ub, y0: 0, top: endTop, thickness: tg, openings: [gDoor] });
    wall(b, wfGR, { id: 'garage-wall-rear', group: 'garage', material: 'wall', u0: ua, u1: ub, y0: 0, top: endTop, thickness: tg });
    const sideWin = opening({ u0: sb + gd * 0.62, u1: sb + gd * 0.62 + 0.9, y0: 1.2, y1: 2.0 });
    wall(b, wfGS, { id: 'garage-wall-side', group: 'garage', material: 'wall', u0: sb, u1: sb + gd, y0: 0, y1: gpl + 0.05, thickness: tg, openings: [sideWin] });
    glazedOpening(b, wfGS, sideWin, { ...winOpts, id: 'garage-window', group: 'garage', mullions: 0 });
    garageDoor(b, wfGF, gDoor, { id: 'garage-door', group: 'garage', frame: 'frame', leaf: 'garage-door' });
    let garageTop;
    if (roof === 'flat') {
      const slab = s < 0 ? [outer - 0.15, inner] : [inner, outer + 0.15];
      b.box('garage-roof', 'garage', 'trim', [slab[0], gpl, -sb - gd - 0.15], [slab[1], gpl + 0.22, -sb + 0.15]);
      garageTop = gpl + 0.22;
      b.probe('garage-roof', 'Height of the garage roof', [gx, 30, -sb - gd / 2], [0, -1, 0]);
    } else if (roof === 'gable') {
      garageTop = gableRoofZ(b, { id: 'garage-roof', group: 'garage', material: 'roof', z0: -sb - gd - 0.2, z1: -sb + 0.2, xRidge: gx, halfWidth: gw / 2,
        plate: gpl, pitch: gpitch, overhang: 0.2, thickness: 0.16 }).ridgeTop;
      b.probe('garage-roof', 'Height of the garage roof slope', [gx + s * gw / 4, 30, -sb - gd / 2], [0, -1, 0]);
    } else {
      const info = leanToRoof(b, s < 0 ? wfLeft : wfRight, { id: 'garage-roof', group: 'garage', material: 'roof', u0: sb - 0.15, u1: sb + gd + 0.15, wBack: 0.05,
        wFront: -(gw + 0.15), yBack: gpl + (gw + 0.05) * tl, pitch: leanPitch, thickness: 0.14 });
      garageTop = info.topAt(0);
      b.probe('garage-roof', 'Height of the garage roof', [gx, 30, -sb - gd / 2], [0, -1, 0]);
    }
    garageInfo = { s, gw, gd, sb, top: garageTop, roof };
    for (const y of [1.45, 1.1, 0.8]) b.probe('garage-side', 'Position of the garage side wall', [s * 40, y, -sb - gd * 0.3], [-s, 0, 0]);
    b.dimension('garage-width', 'Width of the garage', [s * W / 2, 0, -sb], [s * (W / 2 + gw), 0, -sb], 'front');
  }

  // ---- rear extension ----------------------------------------------------------------------
  let extInfo = null;
  if (ext) {
    const [ex0, ex1] = extRange, ed = ext.depth, te = 0.25, ep = ext.plate;
    b.group('rear.extension', 'Single-storey rear extension', 'massing', 0.2, 'rear');
    const wfER = wallFrame('z', -1, -D - ed), wfEL = wallFrame('x', -1, ex0), wfERt = wallFrame('x', 1, ex1);
    const leanPitch = 10 * DEG;
    const lean = ext.roof === 'leanto' && ep + (ed + 0.05) * Math.tan(leanPitch) + 0.14 / Math.cos(leanPitch) < eaveLow - 0.15 - ov * 0.2 ? true : false;
    const under = w => ep + (w + ed) * Math.tan(leanPitch);     // w inward from the main rear wall face
    // Doors on one side of the rear wall leave a blank pier for the probe.
    const doorSide = wing.side;   // doors towards the outer corner
    const dw = Math.min(1.6, ex1 - ex0 - 1.6);
    const du0 = doorSide < 0 ? ex0 + te + 0.3 : ex1 - te - 0.3 - dw;
    const garden = opening({ u0: du0, u1: du0 + dw, y0: yf, y1: yf + 2.1 });
    const rearTop = lean ? [[ex1 - te, ep + 0.05], [ex0 + te, ep + 0.05]] : [[ex1 - te, ep + 0.05], [ex0 + te, ep + 0.05]];
    wall(b, wfER, { id: 'extension-wall-rear', group: 'rear.extension', material: 'wall', u0: ex0 + te, u1: ex1 - te, y0: 0, top: rearTop, thickness: te, openings: [garden] });
    doorOpening(b, wfER, garden, { id: 'extension-doors', group: 'rear.extension', frame: 'frame', leaf: 'frame', glass: 'glass', metal: 'metal', style: 'full-glass', leaves: 2 });
    for (const [name, wf, sx] of [['left', wfEL, -1], ['right', wfERt, 1]]) {
      const top = lean ? [[D + ed, under(-ed) + 0.05], [D - 0.05, under(0.05) + 0.05]] : [[D + ed, ep + 0.05], [D - 0.05, ep + 0.05]];
      const win = sx === -doorSide ? [opening({ u0: D + ed * 0.35, u1: D + ed * 0.35 + 1.0, y0: groundSill, y1: groundSill + 1.1 })] : [];
      wall(b, wf, { id: 'extension-wall-' + name, group: 'rear.extension', material: 'wall', u0: D - 0.05, u1: D + ed, y0: 0, top, thickness: te, openings: win });
      if (win.length) glazedOpening(b, wf, win[0], { ...winOpts, id: 'extension-window', group: 'rear.extension', mullions: 0 });
    }
    // The lean-to's walls are cut to the slope: rebuild the side tops from the frame of the main rear wall.
    let extTop;
    if (lean) {
      const info = leanToRoof(b, wfRear, { id: 'extension-roof', group: 'rear.extension', material: 'roof', u0: ex0 - 0.15, u1: ex1 + 0.15, wBack: 0.05,
        wFront: -(ed + 0.15), yBack: under(0.05), pitch: leanPitch, thickness: 0.14 });
      extTop = info.topAt(-ed / 2);
    } else {
      b.box('extension-roof', 'rear.extension', 'trim', [ex0 - 0.15, ep, -D - ed - 0.15], [ex1 + 0.15, ep + 0.22, -D + 0.05]);
      extTop = ep + 0.22;
    }
    const pierU = doorSide < 0 ? (du0 + dw + ex1 - te) / 2 : (ex0 + te + du0) / 2;
    b.probe('extension-rear', 'Position of the rear extension back wall', [pierU, 1.3, -40], [0, 0, 1]);
    b.probe('extension-roof', 'Height of the rear extension roof', [(ex0 + ex1) / 2, 30, -D - ed / 2], [0, -1, 0]);
    b.dimension('extension-depth', 'Depth of the rear extension', [ex1, 0, -D], [ex1, 0, -D - ed], 'plan');
    extInfo = { ex0, ex1, ed, top: extTop };
  }

  // ---- dormers -------------------------------------------------------------------------------
  let dormerCount = 0;
  if (p.dormers) {
    const dp = p.dormers, dw = dp.width, sb = dp.setback, pd = 42 * DEG, td = 0.12;
    const ridgeHalf = roofType === 'gable' ? W / 2 - 0.4 : (roofInfo.alongX ? (W + 2 * ov) / 2 - roofInfo.half - 0.3 : 0);
    const n = dp.count, spacing = n > 1 ? Math.min(3.2, (2 * ridgeHalf - dw) / (n - 1)) : 0;
    const centres = [...Array(n).keys()].map(k => (k - (n - 1) / 2) * spacing + (n === 1 ? -chimneyX * 0.15 : 0));
    const yRoofFront = roofTopFront(-sb);
    const sill = Math.max(atticFloor + 0.75, yRoofFront + 0.15), dh = 1.05;
    const dplate = sill + dh + 0.18, dRidgeTop = dplate + dw / 2 * Math.tan(pd) + 0.15 / Math.cos(pd);
    const zBackNeeded = roofType === 'gable' ? (dRidgeTop + 0.12 - plate - roofInfo.tv) / tan : (dRidgeTop + 0.12 - plate - FASCIA) / tan - ov;
    const ok = centres.every(x => Math.abs(x) + dw / 2 + 0.2 < ridgeHalf && Math.abs(x - chimneyX) > dw / 2 + chimneyHalf + 0.3) &&
      zBackNeeded + 0.3 < D / 2 && dRidgeTop + 0.25 < ridgeTop && ridgeHalf > dw;
    if (ok) {
      b.group('roof.dormers', 'Dormers on the front roof slope', 'roof', 0.1, 'front');
      const zBack = -(zBackNeeded + 0.25);
      centres.forEach((x, k) => {
        const id = 'dormer-' + (k + 1), x0 = x - dw / 2, x1 = x + dw / 2;
        const under = xx => dplate + (dw / 2 - Math.abs(xx - x)) * Math.tan(pd);
        const wfD = wallFrame('z', 1, -sb);
        const win = opening({ u0: x - (dw - 0.5) / 2, u1: x + (dw - 0.5) / 2, y0: sill, y1: sill + dh });
        const bottom = yRoofFront - 0.35;
        wall(b, wfD, { id: id + '-front', group: 'roof.dormers', material: 'wall', u0: x0 + td, u1: x1 - td, y0: bottom,
          top: [[x1 - td, under(x1 - td) + 0.05], [x, under(x) + 0.05], [x0 + td, under(x0 + td) + 0.05]], thickness: td, openings: [win] });
        glazedOpening(b, wfD, win, { ...winOpts, id: id + '-window', group: 'roof.dormers', sill: null, recess: 0.03, frameDepth: 0.08, mullions: 1 });
        const uMeet = (dplate + 0.05 - roofTopFront(0) ) / tan;    // -z where the roof top reaches the cheek top
        const uEnd = Math.max(sb + 0.3, uMeet + 0.3);
        for (const [s, xf] of [[-1, x0], [1, x1]]) {
          const wf = wallFrame('x', s, xf);
          const poly = [[sb, roofTopFront(-sb) - 0.35], [uEnd, roofTopFront(-uEnd) - 0.35], [uEnd, dplate + 0.05], [sb, dplate + 0.05]];
          wf.extrude(b, id + '-cheek-' + (s < 0 ? 'left' : 'right'), 'roof.dormers', 'wall', poly, 0, td);
        }
        gableRoofZ(b, { id: id + '-roof', group: 'roof.dormers', material: 'roof', z0: zBack, z1: -sb + 0.12, xRidge: x, halfWidth: dw / 2,
          plate: dplate, pitch: pd, overhang: 0.1, thickness: 0.15 });
        // Near the dormer front, where it stands highest above the main roof.
        if (k === 0) for (const [dx, dz] of [[0.36, 0.42], [0.4, 0.55], [dw / 4, 0.7]]) b.probe('dormer-roof', 'Height of the dormer roof slope', [x + dx, 30, -sb - dz], [0, -1, 0]);
      });
      dormerCount = n;
    }
  }

  // ---- probes on the main body ------------------------------------------------------------
  const probes = [];
  // Front wall: piers between ground-floor openings, then spandrels.
  const groundSpans = frontOpenings.filter(x => x.kind !== 'upper').map(x => [x.o.u0, x.o.u1]).sort((a, c) => a[0] - c[0]);
  const piers = [];
  let prev = -W / 2;
  for (const [a, c] of groundSpans) { piers.push([prev, a]); prev = c; }
  piers.push([prev, W / 2]);
  piers.sort((a, c) => (c[1] - c[0]) - (a[1] - a[0]));
  const yMid = (Math.max(plinthTop, yf) + groundSill + windowH) / 2;
  for (const [a, c] of piers) probes.push(['front-wall', 'Position of the front wall', [(a + c) / 2, yMid + 0.3, 30], [0, 0, -1]]);
  if (floors > 1) for (let i = 0; i < cols; i++) probes.push(['front-wall', 'Position of the front wall', [colX(i), (groundSill + windowH + upperSill) / 2, 30], [0, 0, -1]]);
  // Side walls at a height clear of attached wings.
  for (const [s, name] of [[-1, 'left'], [1, 'right']]) {
    const blocked = garageInfo && garageInfo.s === s;
    const ys = blocked ? [garageInfo.top + 0.6, plate + 0.6] : [1.6, yf + storey + 1.4, plate + 0.5];
    for (const y of ys) for (const uu of [D * 0.2, D * 0.8, D * 0.45]) probes.push([name + '-wall', 'Position of the ' + name + ' side wall', [s * 40, y, -uu], [-s, 0, 0]]);
  }
  for (const x of [0, -W / 4, W / 4, -W / 3, W / 3]) {
    const y = extInfo && x > extInfo.ex0 - 0.5 && x < extInfo.ex1 + 0.5 ? (floors > 1 ? (extInfo.top + upperSill) / 2 : null) : 1.5;
    if (y !== null) probes.push(['rear-wall', 'Position of the rear wall', [x, y, -40], [0, 0, 1]]);
    if (floors > 1) probes.push(['rear-wall', 'Position of the rear wall', [x, yf + storey + 0.4, -40], [0, 0, 1]]);
  }
  // Roof slopes, away from the chimney and dormers.
  const slopeXs = [W / 2 - 1.0, -(W / 2 - 1.0), 0, W / 4, -W / 4].map(x => x * (chimneyX > 0 ? -1 : 1));
  for (const x of slopeXs) probes.push(['roof-front', 'Height of the front roof slope', [x, 40, -D * 0.25 + ov * 0.25], [0, -1, 0]]);
  for (const x of slopeXs) probes.push(['roof-rear', 'Height of the rear roof slope', [x, 40, -D * 0.75 - ov * 0.25], [0, -1, 0]]);
  // Element probes were registered while building; put them first so decoys have contested probes.
  const elementProbes = b.probes.splice(0);
  const order = ['front-wall', 'porch-top', 'garage-side', 'extension-rear', 'bay-front', 'dormer-roof', 'left-wall', 'right-wall', 'rear-wall', 'roof-front', 'roof-rear', 'garage-roof', 'extension-roof'];
  const all = [...elementProbes.map(q => [q.id, q.label, q.origin, q.direction]), ...probes];
  for (const id of order) for (const q of all) if (q[0] === id) b.probe(...q);

  // ---- dimensions ------------------------------------------------------------------------------
  const dims = b.dimensions.splice(0);
  b.dimension('overall-width', 'Overall width of the main front wall', [-W / 2, 0, 0], [W / 2, 0, 0], 'front');
  b.dimension('overall-depth', 'Overall depth of the main body', [W / 2, 0, 0], [W / 2, 0, -D], 'plan');
  b.dimension('eaves-height', 'Height to the underside of the front eaves', [-W / 2, 0, 0], [-W / 2, eaveLow, 0], 'front');
  b.dimension('ridge-height', 'Height to the top of the roof ridge', [0, 0, 0], [0, ridgeTop, 0], 'front');
  if (roofType === 'gable') b.dimension('ridge-height-side', 'Ridge height on the right gable', [W / 2, 0, -D / 2], [W / 2, ridgeTop, -D / 2], 'right');
  else b.dimension('eaves-height-side', 'Eaves height on the right side', [W / 2, 0, -D / 2], [W / 2, plate, -D / 2], 'right');
  b.dimension('door-width', 'Width of the front door opening', [door.u0, door.y0, 0], [door.u1, door.y0, 0], 'front');
  const gw0 = groundWindows[0];
  if (gw0) b.dimension('window-width', 'Width of a ground-floor window opening', [gw0.u0, gw0.y0, 0], [gw0.u1, gw0.y0, 0], 'front');
  for (const d of dims) if (d.id !== 'chimney-height') b.dimension(d.id, d.label, d.a, d.b, d.view);
  if (gw0) b.dimension('window-sill-height', 'Height of a ground-floor window opening above ground', [gw0.u0, 0, 0], [gw0.u0, gw0.y0, 0], 'front');
  const chim = dims.find(d => d.id === 'chimney-height');
  b.dimension(chim.id, chim.label, chim.a, chim.b, chim.view);
  b.dimensions.splice(12);

  const roofWord = roofType === 'gable' ? 'gabled' : 'hipped';
  const storeyWord = floors === 1 ? (attic ? 'One-and-a-half-storey' : 'Single-storey') : (attic ? 'Two-and-a-half-storey' : 'Two-storey');
  return {
    builder: b,
    title: storeyWord + ' detached house with a ' + roofWord + ' roof',
    frame: {
      origin: 'On the ground at the midpoint of the main front wall; the front wall face is the plane z = 0 and the house extends towards -Z.',
      front: 'The front facade, with the front door, faces +Z; +X is to the right when you look at the front.',
    },
    scope_note: 'The house exterior only: walls, roofs, chimney, windows, doors, the entrance landing and porch, bay window, attached garage ' +
      'and rear extension where present, gutters and downpipes. No ground plane, garden, fences, paths, vehicles or neighbouring buildings.',
    structure: { floors, attic, roof: roofType, cols, porch: porchType, bay: !!bayInfo, garage: garageInfo ? p.garage.roof : null,
      extension: extInfo ? ext.roof : null, dormers: dormerCount, chimney: p.chimney.at },
  };
}

export const edits = [
  { id: 'no-extension', scope: ['rear.extension'], applies: (p, s) => !!s.extension, apply: p => ({ ...p, extension: null }), phrase: 'the single-storey rear extension had not been built' },
  { id: 'no-garage', scope: ['garage'], applies: (p, s) => !!s.garage, apply: p => ({ ...p, garage: null }), phrase: 'the side garage had not been built' },
  { id: 'no-porch', scope: ['front.porch'], applies: (p, s) => !!s.porch, apply: p => ({ ...p, porch: null }), phrase: 'the entrance porch over the landing had not been added' },
  { id: 'no-bay', scope: ['front.bay', 'front.windows.ground', 'body'], applies: (p, s) => s.bay, apply: p => ({ ...p, bay: null }), phrase: 'the ground-floor bay window had not been built and a flat window stood in its place' },
  { id: 'no-dormers', scope: ['roof.dormers'], applies: (p, s) => s.dormers > 0, apply: p => ({ ...p, dormers: null }), phrase: 'the dormers had not been added to the front roof slope' },
];

export default { id: 'house', sample, build, edits };
