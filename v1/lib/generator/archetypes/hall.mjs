// Large masonry hall (church-like): a long nave with a steep pitched roof,
// stepped buttresses at every bay, arched windows (round or pointed), an arched
// west door with a moulded surround, a main tower with a parapet, pyramid roof or
// spire, and optionally a smaller second tower, an apse, a transept and a side porch.
import { ModelBuilder, wallFrame, wall, opening, glazedOpening, doorOpening, louvreOpening, gableRoofZ, gableRoofX, band, draw, DEG } from '../kit.mjs';

const PALETTES = [
  { stone: ['#b9ad96', 'stone'], dressing: '#d2c8b4', roof: '#4b5054', door: '#4a3426', glass: '#3a4a52' },
  { stone: ['#8e7f6c', 'stone'], dressing: '#b3a58f', roof: '#3b3f42', door: '#3d2b20', glass: '#34444c' },
  { stone: ['#a0614b', 'wall'], dressing: '#cfbfa3', roof: '#5a4a45', door: '#2f3a2c', glass: '#3a4a52' },
  { stone: ['#c8c2b4', 'stone'], dressing: '#e0dbcf', roof: '#6f5a4c', door: '#5a3b28', glass: '#36464f' },
];

export function sample(r) {
  const m = r.fork('massing');
  const bays = m.int(4, 8), bayLen = draw(m, 3.6, 5.0);
  const massing = { width: draw(m, 9, 14), bays, bayLen, height: draw(m, 7, 10.5), pitch: draw(m, 46, 56, 1), wall: draw(m, 0.75, 0.95) };
  const s = r.fork('style');
  const style = { arch: s.pick(['round', 'pointed']), windowW: draw(s, 1.2, 1.8), sill: draw(s, 2.6, 3.4), buttressDepth: draw(s, 0.9, 1.3), buttressW: draw(s, 0.6, 0.9),
    doorW: draw(s, 1.8, 2.4), westWindowW: draw(s, 2.4, 3.6) };
  const t = r.fork('tower');
  const tower = { place: t.pick(['centre', 'left', 'right', 'side-left', 'side-right']), side: draw(t, 4.8, 7.5), rise: draw(t, 7, 17), belfry: draw(t, 4.2, 5.6),
    top: t.pick(['parapet', 'pyramid', 'spire']), spire: draw(t, 1.6, 2.6), clock: t.chance(0.5), pinnacles: t.chance(0.7) };
  const o = r.fork('options');
  // A centre (west) tower must clear the nave ridge, even in its earlier, lower state.
  const ridgeRise = massing.width / 2 * Math.tan(massing.pitch * Math.PI / 180);
  if (tower.place === 'centre') tower.rise = Math.max(tower.rise, ridgeRise + tower.belfry + 3.5);
  // Optional wings keep their footprint when not built, so an earlier state keeps the
  // same walls (the bays they cover stay blank).
  const tower2 = { built: o.chance(0.5), side: draw(o, 3.0, 4.2), rise: draw(o, 2.0, Math.max(2.5, tower.rise - 4)), top: o.pick(['pyramid', 'parapet']) };
  const apse = o.chance(0.5);
  const transept = o.chance(0.4) ? { bay: o.int(2, Math.max(2, bays - 2)), arms: o.pick(['both', 'left', 'right']), depth: draw(o, 4.0, 6.5) } : null;
  const porch = { built: o.chance(0.55), side: o.pick([-1, 1]), depth: draw(o, 2.4, 3.4) };
  // A west tower on the axis is symmetric: give the hall a clearly one-sided element.
  if (tower.place === 'centre' && !tower2.built && transept?.arms !== 'left' && transept?.arms !== 'right') porch.built = true;
  return { massing, style, tower, tower2, apse, transept, porch, palette: r.fork('palette').int(0, PALETTES.length - 1) };
}

// U-shaped moulded surround around an arched opening, proud of the wall. It starts
// 4 cm outside the opening so its inner face is not the opening's reveal, and its
// legs stop at `from` (a hood mould over a window stops above the sill).
function archSurround(b, wf, o, { id, group, material, inner = 0.04, outer = 0.35, proud = 0.15, from = o.y0 }) {
  const a = o.inset(-inner), c = o.inset(-outer);
  const outline = [[c.u0, from], [a.u0, from], ...a.head(), [a.u1, from], [c.u1, from], ...c.head().reverse()];
  wf.extrude(b, id, group, material, outline, -proud, 0.05);
}

// Square-plan tower: four walls (with belfry openings), string courses, and a top.
function squareTower(b, { id, group, topGroup, belfryGroup, x0, x1, z0, z1, height, wallT, belfry, top, spireRatio, pinnacles, clock, arch, material, dressing, roof, spireMat = roof, frameMat, glass, door }) {
  const w = x1 - x0, d = z1 - z0, faces = [
    ['front', wallFrame('z', 1, z1), x0, x1], ['rear', wallFrame('z', -1, z0), x0, x1],
    ['left', wallFrame('x', -1, x0), -z1 + wallT, -z0 - wallT], ['right', wallFrame('x', 1, x1), -z1 + wallT, -z0 - wallT]];
  const parapet = top !== 'pyramid' ? 1.1 : 0, wallTop = height + parapet;
  const openings = {};
  for (const [face, wf, u0, u1] of faces) {
    // Openings stay clear of the corners, where the side walls abut the front and rear walls.
    const along = face === 'front' || face === 'rear', start = (along ? x0 : -z1) + wallT, span = (along ? w : d) - 2 * wallT;
    const n = span > 3.6 ? 2 : 1, ow = Math.min(1.3, span / (n * 2.2));
    const list = [];
    for (let k = 0; k < n; k++) {
      const uc = start + span * (k + 0.5) / n;
      list.push(opening({ u0: uc - ow / 2, u1: uc + ow / 2, y0: height - belfry + 0.7, y1: height - 0.7, shape: 'arch', ratio: arch === 'round' ? 0.5 : 0.8 }));
    }
    if (face === 'front' && door) list.push(door);
    openings[face] = list;
    wall(b, wf, { id: id + '-wall-' + face, group, material, u0, u1, y0: 0, y1: wallTop, thickness: wallT, openings: list });
  }
  for (const [face, wf] of faces) {
    openings[face].filter(o => o !== door).forEach((o, k) => louvreOpening(b, wf, o, { id: id + '-belfry-' + face + '-' + (k + 1), group: belfryGroup, slat: frameMat, backing: roof, recess: 0.2 }));
  }
  // String courses: front and rear pieces wrap the corners, side pieces stop at them.
  const courses = [height - belfry - 0.25, height * 0.45].filter(y => y > 1.5);
  courses.forEach((y, k) => {
    const y0 = y, y1 = y + 0.22, p = 0.08;
    b.box(id + '-course-' + (k + 1) + '-front', group, dressing, [x0 - p, y0, z1 - 0.02], [x1 + p, y1, z1 + p]);
    b.box(id + '-course-' + (k + 1) + '-rear', group, dressing, [x0 - p, y0, z0 - p], [x1 + p, y1, z0 + 0.02]);
    b.box(id + '-course-' + (k + 1) + '-left', group, dressing, [x0 - p, y0, z0 + 0.02], [x0 + 0.02, y1, z1 - 0.02]);
    b.box(id + '-course-' + (k + 1) + '-right', group, dressing, [x1 - 0.02, y0, z0 + 0.02], [x1 + p, y1, z1 - 0.02]);
  });
  if (clock) {
    const cy = height - belfry - 1.4, r = Math.min(0.95, w / 5);
    b.add({ id: id + '-clock', type: 'cylinder', radius: r, height: 0.16, segments: 32, position: [(x0 + x1) / 2, cy, z1 + 0.06], rotation: [Math.PI / 2, 0, 0], material: dressing, group });
    b.add({ id: id + '-clock-face', type: 'cylinder', radius: r - 0.12, height: 0.06, segments: 32, position: [(x0 + x1) / 2, cy, z1 + 0.15], rotation: [Math.PI / 2, 0, 0], material: roof, group });
  }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  let peak = wallTop, peakX = cx;
  if (top === 'pyramid') {
    // A helm roof of about 40-48 degrees.
    const half = Math.max(w, d) / 2 + 0.25, h = (0.45 + 0.1 * Math.min(1, Math.max(0, spireRatio - 1.6))) * Math.max(w, d);
    // A 4-sided cone turned 45 degrees is a square pyramid with sides along the axes.
    b.cylinder(id + '-roof', topGroup, roof, [cx, height - 0.05, cz], h, half * Math.SQRT2, { top: 0, segments: 4, yaw: Math.PI / 4 });
    peak = height - 0.05 + h;
  } else {
    b.box(id + '-deck', topGroup, roof, [x0 + 0.1, height - 0.3, z0 + 0.1], [x1 - 0.1, height, z1 - 0.1]);
    const p = 0.07;
    b.box(id + '-coping-front', topGroup, dressing, [x0 - p, wallTop - 0.04, z1 - wallT - p], [x1 + p, wallTop + 0.14, z1 + p]);
    b.box(id + '-coping-rear', topGroup, dressing, [x0 - p, wallTop - 0.04, z0 - p], [x1 + p, wallTop + 0.14, z0 + wallT + p]);
    b.box(id + '-coping-left', topGroup, dressing, [x0 - p, wallTop - 0.04, z0 + wallT + p], [x0 + wallT + p, wallTop + 0.14, z1 - wallT - p]);
    b.box(id + '-coping-right', topGroup, dressing, [x1 - wallT - p, wallTop - 0.04, z0 + wallT + p], [x1 + p, wallTop + 0.14, z1 - wallT - p]);
    peak = wallTop + 0.14;
    if (pinnacles) {
      for (const [k, px, pz] of [[1, x0, z0], [2, x1, z0], [3, x1, z1], [4, x0, z1]]) {
        const ix = px === x0 ? x0 + 0.32 : x1 - 0.32, iz = pz === z0 ? z0 + 0.32 : z1 - 0.32;
        b.box(id + '-pinnacle-' + k + '-base', topGroup, dressing, [ix - 0.25, wallTop + 0.12, iz - 0.25], [ix + 0.25, wallTop + 0.75, iz + 0.25]);
        b.cylinder(id + '-pinnacle-' + k, topGroup, dressing, [ix, wallTop + 0.73, iz], 1.4, 0.3 * Math.SQRT2, { top: 0, segments: 4, yaw: Math.PI / 4 });
      }
      peak = wallTop + 2.13; peakX = x0 + 0.32;
    }
    if (top === 'spire') {
      // Octagonal spire rising inside the parapet; flats face the axes.
      const apothem = Math.min(w, d) / 2 - wallT - 0.05, rv = apothem / Math.cos(Math.PI / 8), h = spireRatio * Math.min(w, d);
      b.cylinder(id + '-spire', topGroup, spireMat, [cx, height - 0.05, cz], h, rv, { top: 0, segments: 8, yaw: Math.PI / 8 });
      b.beam(id + '-finial', topGroup, dressing, [cx, height - 0.05 + h - 0.3, cz], [cx, height - 0.05 + h + 1.2, cz], 0.05, 8);
      peak = height - 0.05 + h + 1.2;
      return { peak, peakX: cx, wallTop, spire: { h, apothem, base: height - 0.05 } };
    }
  }
  return { peak, peakX, wallTop };
}

export function build(p) {
  const b = new ModelBuilder(), M = p.massing, S = p.style, T = p.tower, pal = PALETTES[p.palette];
  b.material('stone', pal.stone[0], pal.stone[1], { roughness: 0.95 });
  b.material('dressing', pal.dressing, 'stone', { roughness: 0.9 });
  b.material('roof', pal.roof, 'roof', { roughness: 0.8 });
  b.material('lead', '#5f6366', 'metal', { roughness: 0.6, metalness: 0.3 });
  b.material('door', pal.door, 'wood', { roughness: 0.7 });
  b.material('glass', pal.glass, 'glass', { roughness: 0.1 });
  b.material('frame', '#5a5d5f', 'frame', { roughness: 0.5, metalness: 0.4 });
  b.material('iron', '#2b2d2f', 'metal', { roughness: 0.5, metalness: 0.6 });

  const W = M.width, L = M.bays * M.bayLen, H = M.height, tw = M.wall, pitch = M.pitch * DEG, tan = Math.tan(pitch);
  const ridge = H + W / 2 * tan;
  const archRatio = S.arch === 'round' ? 0.5 : 0.8;
  b.group('nave', 'Nave walls and plinth', 'massing', 0.4, 'all');
  b.group('nave.roof', 'Nave roof', 'roof', 0.3, 'roof');
  b.group('buttresses', 'Buttresses', 'structure', 0.3, 'all');
  b.group('windows.left', 'Nave windows, left side', 'openings', 0.1, 'left');
  b.group('windows.right', 'Nave windows, right side', 'openings', 0.1, 'right');
  b.group('west.front', 'West door, surround and west window', 'entrance', 0.1, 'front');
  b.group('tower', 'Main tower', 'massing', 0.3, T.place === 'side-left' ? 'left' : T.place === 'side-right' ? 'right' : 'front');
  b.group('tower.top', 'Main tower top (' + T.top + ')', 'roof', 0.2, 'roof');
  b.group('tower.belfry', 'Belfry openings and louvres', 'openings', 0.12, 'all');

  // ---- tower footprint (decided first: it decides which bays keep their windows) ----
  const ts = T.side, ttw = 0.85;
  let tx0, tx1, tz0, tz1, westDoorX = 0, doorInTower = false;
  if (T.place === 'centre') { tx0 = -ts / 2; tx1 = ts / 2; tz0 = -0.45; tz1 = ts - 0.45; doorInTower = true; }
  else if (T.place === 'left' || T.place === 'right') {
    const s = T.place === 'left' ? -1 : 1, inner = s * (W / 2 - 1.6), outer = inner + s * ts;
    [tx0, tx1] = s < 0 ? [outer, inner] : [inner, outer]; tz1 = 1.4; tz0 = tz1 - ts; westDoorX = -s * 0.6;
  } else {
    const s = T.place === 'side-left' ? -1 : 1, inner = s * (W / 2 - 0.45), outer = inner + s * ts;
    [tx0, tx1] = s < 0 ? [outer, inner] : [inner, outer]; tz1 = -M.bayLen * 0.4; tz0 = tz1 - ts;
  }
  const towerSide = T.place.includes('left') ? -1 : T.place.includes('right') ? 1 : 0;
  const coveredByTower = (side, u0, u1) => side === towerSide && !(u1 < -tz1 - 0.5 || u0 > -tz0 + 0.5);

  // ---- transept ------------------------------------------------------------------
  const tr = p.transept;
  const trZ = tr ? [-(tr.bay * M.bayLen) - M.bayLen * 0.7, -(tr.bay * M.bayLen) + M.bayLen * 0.7] : null;  // [z0, z1]
  const trArms = tr ? (tr.arms === 'both' ? [-1, 1] : [tr.arms === 'left' ? -1 : 1]) : [];
  const coveredByTransept = (side, u0, u1) => tr && trArms.includes(side) && !(u1 < -trZ[1] - 0.6 || u0 > -trZ[0] + 0.6);
  // ---- side porch ----------------------------------------------------------------
  // Second tower: opposite front corner beside a corner tower, else the rear corner on the other side.
  const t2 = p.tower2, s2 = towerSide === 0 ? 1 : -towerSide, t2front = T.place === 'left' || T.place === 'right';
  const t2x = s2 < 0 ? [-(W / 2 - 1.0) - t2.side, -(W / 2 - 1.0)] : [W / 2 - 1.0, W / 2 - 1.0 + t2.side];
  const t2z = t2front ? [1.0 - t2.side, 1.0] : [-L - 1.0, -L - 1.0 + t2.side];
  const coveredByTower2 = (side, u0, u1) => side === s2 && !(u1 < -t2z[1] - 0.5 || u0 > -t2z[0] + 0.5);
  // Side porch in the first free stretch of its side wall, behind any tower there.
  const porchSide = p.porch.side;
  let pz1 = -M.bayLen * 0.8;
  if (porchSide === towerSide) pz1 = Math.min(pz1, tz0 - 0.8);
  if (porchSide === s2 && t2front) pz1 = Math.min(pz1, t2z[0] - 0.8);
  const pz0 = pz1 - 2.6;
  const porchFits = pz0 > -L + 1.5 && (!tr || !trArms.includes(porchSide) || pz0 > trZ[1] + 0.8 || pz1 < trZ[0] - 0.8) &&
    !(porchSide === s2 && !t2front && pz0 < t2z[1] + 0.8);
  const porchBuilt = p.porch.built && porchFits;
  const coveredByPorch = (side, u0, u1) => porchFits && side === porchSide && !(u1 < -pz1 - 0.4 || u0 > -pz0 + 0.4);
  const covered = (side, u0, u1) => coveredByTower(side, u0, u1) || coveredByTransept(side, u0, u1) || coveredByPorch(side, u0, u1) || coveredByTower2(side, u0, u1);

  // ---- nave walls -----------------------------------------------------------------
  const wfW = wallFrame('z', 1, 0), wfE = wallFrame('z', -1, -L), wfL = wallFrame('x', -1, -W / 2), wfR = wallFrame('x', 1, W / 2);
  const gableTop = [[W / 2, H + 0.05], [0, ridge + 0.05], [-W / 2, H + 0.05]];
  const doorH = Math.min(4.0, H * 0.45);
  const westDoor = opening({ u0: westDoorX - S.doorW / 2, u1: westDoorX + S.doorW / 2, y0: 0, y1: doorH, shape: 'arch', ratio: archRatio });
  const wwTop = Math.min(ridge - 1.6, H + 1.5), wwBottom = doorH + 1.6;
  // A central tower stands in front of the west wall: the door is in the tower and the
  // wall behind it has no window.
  const westWindow = doorInTower ? null : opening({ u0: westDoorX - S.westWindowW / 2, u1: westDoorX + S.westWindowW / 2, y0: wwBottom, y1: wwTop, shape: 'arch', ratio: archRatio });
  const westOpenings = doorInTower ? [] : [westDoor, westWindow];
  wall(b, wfW, { id: 'nave-west', group: 'nave', material: 'stone', u0: -W / 2, u1: W / 2, y0: 0, top: gableTop, thickness: tw, openings: westOpenings.filter(Boolean) });
  const eastWindow = !p.apse ? opening({ u0: -S.westWindowW / 2, u1: S.westWindowW / 2, y0: S.sill, y1: Math.min(ridge - 1.4, H + 1.2), shape: 'arch', ratio: archRatio }) : null;
  wall(b, wfE, { id: 'nave-east', group: 'nave', material: 'stone', u0: -W / 2, u1: W / 2, y0: 0, top: gableTop, thickness: tw, openings: eastWindow ? [eastWindow] : [] });
  const windowTop = H - 0.9, sideWindows = { [-1]: [], [1]: [] };
  for (const [side, wf] of [[-1, wfL], [1, wfR]]) {
    for (let k = 0; k < M.bays; k++) {
      const uc = (k + 0.5) * M.bayLen, u0 = uc - S.windowW / 2, u1 = uc + S.windowW / 2;
      if (covered(side, u0, u1)) continue;
      sideWindows[side].push(opening({ u0, u1, y0: S.sill, y1: windowTop, shape: 'arch', ratio: archRatio }));
    }
    wall(b, wf, { id: 'nave-' + (side < 0 ? 'left' : 'right'), group: 'nave', material: 'stone', u0: tw, u1: L - tw, y0: 0, y1: H + 0.05, thickness: tw, openings: sideWindows[side] });
  }
  // Plinth: front and rear bands wrap the corners, side bands stop at them.
  const plinth = 0.65, pr = 0.08;
  band(b, wfW, { id: 'plinth-west', group: 'nave', material: 'dressing', u0: -W / 2 - pr, u1: W / 2 + pr, y0: 0, y1: plinth, proud: pr, gaps: doorInTower ? [] : [[westDoor.u0 - 0.4, westDoor.u1 + 0.4]] });
  band(b, wfE, { id: 'plinth-east', group: 'nave', material: 'dressing', u0: -W / 2 - pr, u1: W / 2 + pr, y0: 0, y1: plinth, proud: pr });
  band(b, wfL, { id: 'plinth-left', group: 'nave', material: 'dressing', u0: 0.02, u1: L - 0.02, y0: 0, y1: plinth, proud: pr });
  band(b, wfR, { id: 'plinth-right', group: 'nave', material: 'dressing', u0: 0.02, u1: L - 0.02, y0: 0, y1: plinth, proud: pr });

  // ---- nave roof (ridge along Z) ---------------------------------------------------
  const roofInfo = gableRoofZ(b, { id: 'nave-roof', group: 'nave.roof', material: 'roof', z0: -L - 0.3, z1: 0.3, xRidge: 0, halfWidth: W / 2, plate: H, pitch, overhang: 0.35, thickness: 0.3 });
  b.beam('nave-ridge', 'nave.roof', 'lead', [0, roofInfo.ridgeTop - 0.03, 0.36], [0, roofInfo.ridgeTop - 0.03, -L - 0.36], 0.1, 16);
  // Gable crosses at both ends.
  for (const [k, z] of [[1, 0.1], [2, -L - 0.1]]) {
    const y = roofInfo.ridgeTop + 0.05;
    b.box('nave-cross-' + k + '-stem', 'nave.roof', 'dressing', [-0.09, y - 0.3, z - 0.09], [0.09, y + 1.4, z + 0.09]);
    b.box('nave-cross-' + k + '-arm', 'nave.roof', 'dressing', [-0.45, y + 0.75, z - 0.06], [0.45, y + 0.95, z + 0.06]);
  }

  // ---- windows and west door ---------------------------------------------------------
  const win = { frame: 'frame', glass: 'glass', sill: 'dressing', recess: 0.28, frameWidth: 0.08, frameDepth: 0.1, mullions: S.arch === 'pointed' ? 1 : 0 };
  for (const [side, wf] of [[-1, wfL], [1, wfR]]) {
    const group = side < 0 ? 'windows.left' : 'windows.right', name = side < 0 ? 'left' : 'right';
    sideWindows[side].forEach((o, k) => {
      glazedOpening(b, wf, o, { ...win, id: 'window-' + name + '-' + (k + 1), group });
      archSurround(b, wf, o, { id: 'window-' + name + '-' + (k + 1) + '.hood', group, material: 'dressing', outer: 0.2, proud: 0.06, from: o.spring - 0.3 });
    });
  }
  if (eastWindow) glazedOpening(b, wfE, eastWindow, { ...win, id: 'window-east', group: 'nave', mullions: 2 });
  const doorFrame = doorInTower ? wallFrame('z', 1, tz1) : wfW;
  doorOpening(b, doorFrame, westDoor, { id: 'west-door', group: 'west.front', frame: 'dressing', leaf: 'door', glass: 'glass', metal: 'iron', style: 'boarded',
    leaves: 2, recess: 0.3, frameWidth: 0.12, frameDepth: 0.12, fanlightMaterial: 'dressing' });
  archSurround(b, doorFrame, westDoor, { id: 'west-door-surround', group: 'west.front', material: 'dressing', outer: 0.4, proud: 0.16 });
  b.box('west-step', 'west.front', 'dressing', [westDoor.u0 + westDoorX * 0 - 0.6, 0, (doorInTower ? tz1 : 0) - 0.05], [westDoor.u1 + 0.6, 0.15, (doorInTower ? tz1 : 0) + 1.2]);
  if (westWindow && !doorInTower) {
    glazedOpening(b, wfW, westWindow, { ...win, id: 'west-window', group: 'west.front', mullions: 2 });
    archSurround(b, wfW, westWindow, { id: 'west-window.hood', group: 'west.front', material: 'dressing', outer: 0.24, proud: 0.08, from: westWindow.spring - 0.3 });
  }

  // ---- buttresses ------------------------------------------------------------------------
  const bd = S.buttressDepth, bwid = S.buttressW, step = H * 0.5, topAtWall = H - 0.9;
  const profile = [[0.05, 0], [-bd, 0], [-bd, step], [-bd * 0.6, step + bd * 0.4], [-bd * 0.6, topAtWall - bd * 0.6 - 0.3], [0.05, topAtWall]];
  let nb = 0;
  for (const [side, wf] of [[-1, wfL], [1, wfR]]) {
    const positions = [];
    for (let k = 1; k < M.bays; k++) positions.push(k * M.bayLen);
    // Corner buttresses only where they clear the end windows (and their hood moulds).
    const firstWindowU0 = M.bayLen / 2 - S.windowW / 2 - 0.25;
    if (0.15 + bwid < firstWindowU0) positions.push(0.15 + bwid / 2, L - 0.15 - bwid / 2);
    for (const u of positions) {
      if (covered(side, u - bwid / 2, u + bwid / 2)) continue;
      wf.sideProfile(b, 'buttress-' + (++nb), 'buttresses', 'stone', profile, u - bwid / 2, u + bwid / 2);
    }
  }

  // ---- main tower -------------------------------------------------------------------------
  const Ht = H + T.rise;
  const towerTop = squareTower(b, { id: 'tower', group: 'tower', topGroup: 'tower.top', belfryGroup: 'tower.belfry', x0: tx0, x1: tx1, z0: tz0, z1: tz1, height: Ht,
    wallT: ttw, belfry: T.belfry, top: T.top, spireRatio: T.spire, pinnacles: T.pinnacles, clock: T.clock, arch: S.arch, material: 'stone', dressing: 'dressing',
    roof: 'roof', spireMat: 'lead', frameMat: 'frame', glass: 'glass', door: doorInTower ? westDoor : null });

  // ---- second tower ------------------------------------------------------------------------
  let tower2Info = null;
  if (t2.built) {
    const [ax0, ax1] = t2x, [az0, az1] = t2z;
    b.group('tower2', 'Second (smaller) tower', 'massing', 0.25, t2front ? 'front' : 'rear');
    const info = squareTower(b, { id: 'tower2', group: 'tower2', topGroup: 'tower2', belfryGroup: 'tower2', x0: ax0, x1: ax1, z0: az0, z1: az1, height: H + t2.rise,
      wallT: 0.6, belfry: 2.6, top: t2.top, spireRatio: 1.0, pinnacles: false, clock: false, arch: S.arch, material: 'stone', dressing: 'dressing', roof: 'roof',
      frameMat: 'frame', glass: 'glass', door: null });
    tower2Info = { x0: ax0, x1: ax1, z0: az0, z1: az1, height: H + t2.rise, top: t2.top, peak: info.peak };
  }

  // ---- apse ----------------------------------------------------------------------------------
  let apseInfo = null;
  if (p.apse) {
    b.group('apse', 'Apse', 'massing', 0.3, 'rear');
    const R = W / 2 - 0.6, zc = -L + 0.05, n = 9, Ha = H - 1.2;
    const outerArc = [], innerArc = [];
    for (let k = 0; k <= n; k++) {
      const a = Math.PI * k / n;     // from +X round the back (-Z) to -X
      outerArc.push([R * Math.cos(a), zc - R * Math.sin(a)]);
      innerArc.push([(R - tw) * Math.cos(a), zc - (R - tw) * Math.sin(a)]);
    }
    // The wall top stays 5 cm under the roof surface at the outer face (inside the roof solid).
    b.prismY('apse-wall', 'apse', 'stone', [...outerArc, ...innerArc.reverse()], 0, Ha - 0.05);
    // Half-cone roof with its flat face buried in the east wall.
    const er = R + 0.3, eaves = Ha - 0.3 * Math.tan(pitch * 0.8), apexY = Ha + R * Math.tan(pitch * 0.8);
    const verts = [[0, apexY, zc]], ring = [];
    for (let k = 0; k <= n; k++) { const a = Math.PI * k / n; verts.push([er * Math.cos(a), eaves, zc - er * Math.sin(a)]); ring.push(k + 1); }
    const faces = [[...ring]];                                     // underside
    faces.push([0, 1, n + 1]);                                     // back
    for (let k = 1; k <= n; k++) faces.push([0, k, k + 1]);
    b.convex('apse-roof', 'apse', 'roof', verts, faces);
    apseInfo = { R, zc, Ha, apexY, reach: R * Math.cos(Math.PI / (2 * n)) };
  }

  // ---- transept --------------------------------------------------------------------------------
  if (tr) {
    b.group('transept', 'Transept arms', 'massing', 0.3, trArms.length === 2 ? 'all' : trArms[0] < 0 ? 'left' : 'right');
    const [z0, z1] = trZ, tW = z1 - z0, depth = tr.depth;
    for (const s of trArms) {
      const name = s < 0 ? 'left' : 'right', xIn = s * (W / 2 - 0.4), xOut = s * (W / 2 + depth);
      const wfEnd = wallFrame('x', s, xOut), wfN = wallFrame('z', 1, z1), wfS = wallFrame('z', -1, z0);
      const endWin = opening({ u0: -(z0 + z1) / 2 - 1.1, u1: -(z0 + z1) / 2 + 1.1, y0: S.sill, y1: Math.min(H + 1.0, H + tW / 2 * tan - 1.0), shape: 'arch', ratio: archRatio });
      const tTop = [[-z0, H + 0.05], [-(z0 + z1) / 2, H + tW / 2 * tan + 0.05], [-z1, H + 0.05]];
      wall(b, wfEnd, { id: 'transept-' + name + '-end', group: 'transept', material: 'stone', u0: -z1, u1: -z0, y0: 0, top: tTop, thickness: tw, openings: [endWin] });
      glazedOpening(b, wfEnd, endWin, { ...win, id: 'transept-' + name + '-window', group: 'transept', mullions: 2 });
      const [ua, ub] = s < 0 ? [xOut + tw, xIn] : [xIn, xOut - tw];
      wall(b, wfN, { id: 'transept-' + name + '-north', group: 'transept', material: 'stone', u0: ua, u1: ub, y0: 0, y1: H + 0.05, thickness: tw });
      wall(b, wfS, { id: 'transept-' + name + '-south', group: 'transept', material: 'stone', u0: ua, u1: ub, y0: 0, y1: H + 0.05, thickness: tw });
      // Roof: ridge along X, buried in the nave roof at its inner end.
      const xr0 = s < 0 ? xOut - 0.3 : 0, xr1 = s < 0 ? 0 : xOut + 0.3;
      gableRoofX(b, { id: 'transept-' + name + '-roof', group: 'transept', material: 'roof', x0: xr0, x1: xr1, zRidge: (z0 + z1) / 2, halfDepth: tW / 2, plate: H, pitch, overhang: 0.35, thickness: 0.3 });
    }
  }

  // ---- side porch ------------------------------------------------------------------------------
  if (porchBuilt) {
    b.group('porch', 'Side porch', 'attachments', 0.15, porchSide < 0 ? 'left' : 'right');
    const s = porchSide, depth = p.porch.depth, xIn = s * (W / 2 - 0.3), xOut = s * (W / 2 + depth), ph = 3.4;
    const wfP = wallFrame('x', s, xOut), wfPN = wallFrame('z', 1, pz1), wfPS = wallFrame('z', -1, pz0);
    const mid = -(pz0 + pz1) / 2, pdoor = opening({ u0: mid - 0.75, u1: mid + 0.75, y0: 0, y1: 2.6, shape: 'arch', ratio: 0.5 });
    wall(b, wfP, { id: 'porch-front', group: 'porch', material: 'stone', u0: -pz1, u1: -pz0, y0: 0, top: [[-pz0, ph + 0.05], [mid, ph + 1.3 * tan + 0.05], [-pz1, ph + 0.05]], thickness: 0.5, openings: [pdoor] });
    archSurround(b, wfP, pdoor, { id: 'porch-arch', group: 'porch', material: 'dressing', outer: 0.28, proud: 0.1 });
    doorOpening(b, wfP, pdoor, { id: 'porch-door', group: 'porch', frame: 'dressing', leaf: 'door', glass: 'glass', metal: 'iron', style: 'boarded', leaves: 2,
      recess: 0.15, frameWidth: 0.1, frameDepth: 0.12, fanlightMaterial: 'dressing' });
    const [ua, ub] = s < 0 ? [xOut + 0.5, xIn] : [xIn, xOut - 0.5];
    wall(b, wfPN, { id: 'porch-north', group: 'porch', material: 'stone', u0: ua, u1: ub, y0: 0, y1: ph + 0.05, thickness: 0.5 });
    wall(b, wfPS, { id: 'porch-south', group: 'porch', material: 'stone', u0: ua, u1: ub, y0: 0, y1: ph + 0.05, thickness: 0.5 });
    const xr0 = s < 0 ? xOut - 0.25 : xIn - 0.1, xr1 = s < 0 ? xIn + 0.1 : xOut + 0.25;
    gableRoofX(b, { id: 'porch-roof', group: 'porch', material: 'roof', x0: xr0, x1: xr1, zRidge: (pz0 + pz1) / 2, halfDepth: (pz1 - pz0) / 2, plate: ph, pitch, overhang: 0.25, thickness: 0.22 });
    var porchInfo = { xOut, ph, mid };
  }

  // ---- probes ----------------------------------------------------------------------------------
  const bayMid = k => -(k + 0.5) * M.bayLen;
  const freeBays = side => [...Array(M.bays).keys()].filter(k => !covered(side, (k + 0.2) * M.bayLen, (k + 0.8) * M.bayLen));
  // Middle bays first: they are the least likely to change in an earlier state.
  const byMiddle = list => [...list].sort((a, c) => Math.abs(a - (M.bays - 1) / 2) - Math.abs(c - (M.bays - 1) / 2));
  for (const [name, s] of [['nave-left', -1], ['nave-right', 1]]) {
    for (const k of byMiddle(freeBays(s))) b.probe(name, 'Position of the nave ' + name.split('-')[1] + ' wall', [s * 80, 1.7, bayMid(k)], [-s, 0, 0]);
  }
  for (const [name, s] of [['roof-left', -1], ['roof-right', 1]]) {
    const nearTransept = k => tr && trArms.includes(s) && Math.abs(bayMid(k) - (trZ[0] + trZ[1]) / 2) < M.bayLen * 1.3;
    for (const k of byMiddle([...Array(M.bays).keys()]).filter(k => !nearTransept(k))) {
      b.probe(name, 'Height of the nave roof, ' + name.split('-')[1] + ' slope', [s * W / 4, 120, bayMid(k)], [0, -1, 0]);
    }
  }
  for (const x of [-W / 4, W / 4]) b.probe('west-gable', 'Position of the west gable', [x, H + 0.6, 120], [0, 0, -1]);
  // The east end: the gable wall, or the apse beyond it.
  if (apseInfo) for (const y of [1.6, 2.6]) b.probe('east-end', 'Position of the east end (apse)', [0.15, y, -200], [0, 0, 1]);
  else for (const [x, y] of [[0, 1.6], [W / 4, 1.6], [-W / 4, 1.6], [0, 2.3]]) b.probe('east-end', 'Position of the east gable wall', [x, y, -200], [0, 0, 1]);
  for (const x of [-W / 2 + 1.0, W / 2 - 1.0, 0]) b.probe('west-front', 'Position of the west front', [x, 1.6, 120], [0, 0, -1]);
  // Main tower top: deck, pyramid facet or spire facet (angled so it is not grazing).
  const tcx = (tx0 + tx1) / 2, tcz = (tz0 + tz1) / 2;
  if (T.top === 'spire') {
    const sp = towerTop.spire, y = sp.base + sp.h * 0.3, z = tcz + sp.apothem * 0.7;
    const dir = [0, -0.8, -0.6];
    b.probe('tower-top', 'Position of the tower spire', [tcx, y + 0.8 * 60, z + 0.6 * 60], dir);
    b.probe('tower-top', 'Position of the tower spire', [tcx, sp.base + sp.h * 0.4, 120], [0, 0, -1]);
  } else if (T.top === 'pyramid') {
    for (const dz of [0.25, 0.3]) b.probe('tower-top', 'Height of the tower roof', [tcx, 150, tcz + dz * (tz1 - tz0)], [0, -1, 0]);
  } else {
    for (const [dx, dz] of [[0, 0], [0.4, 0], [0, 0.4]]) b.probe('tower-top', 'Height of the tower roof deck', [tcx + dx, 150, tcz + dz], [0, -1, 0]);
  }
  // Tower faces below the lower string course (and above the door surround on a west tower).
  const lowCourse = Ht * 0.45, faceYs = [(Math.min(doorH + 0.5, lowCourse - 1) + lowCourse) / 2, lowCourse * 0.5, lowCourse * 0.7];
  for (const y of faceYs) {
    if (towerSide === 0) b.probe('tower-face', 'Position of the tower front face', [tcx + (tx1 - tx0) * 0.3, y, 120], [0, 0, -1]);
    else b.probe('tower-face', 'Position of the tower side face', [towerSide * 120, y, tcz], [-towerSide, 0, 0]);
  }
  if (towerSide !== 0 && T.place.startsWith('side')) for (const y of faceYs) b.probe('tower-front', 'Position of the tower front face', [tcx, y, 120], [0, 0, -1]);
  if (tower2Info) {
    const t2 = tower2Info, cx = (t2.x0 + t2.x1) / 2, cz = (t2.z0 + t2.z1) / 2;
    if (t2.top === 'pyramid') for (const dz of [0.25, 0.3]) b.probe('tower2-top', 'Height of the second tower roof', [cx, 150, cz + dz * (t2.z1 - t2.z0)], [0, -1, 0]);
    else b.probe('tower2-top', 'Height of the second tower roof deck', [cx, 150, cz], [0, -1, 0]);
  }
  if (tr) for (const s of trArms) b.probe('transept-' + (s < 0 ? 'left' : 'right'), 'Position of the transept end wall', [s * 120, 1.6, trZ[0] + 0.6], [-s, 0, 0]);
  // The porch front gable above the door arch; in an earlier state the same ray meets blank nave wall.
  if (porchBuilt) for (const dy of [0.35, 0.25]) b.probe('porch-side', 'Position of the side porch front', [porchSide * 120, 3.4 + dy, (pz0 + pz1) / 2], [-porchSide, 0, 0]);

  // ---- dimensions -------------------------------------------------------------------------------
  b.dimension('nave-width', 'Width of the nave west front', [-W / 2, 0, 0], [W / 2, 0, 0], 'front');
  b.dimension('nave-length', 'Length of the nave', [W / 2, 0, 0], [W / 2, 0, -L], 'plan');
  b.dimension('eaves-height', 'Height of the nave wall plate', [-W / 2, 0, 0], [-W / 2, H, 0], 'front');
  b.dimension('ridge-height', 'Height to the top of the nave roof', [W / 2, 0, -L / 2], [W / 2, roofInfo.ridgeTop, -L / 2], 'right');
  b.dimension('tower-height', 'Height to the top of the main tower walls', [tcx, 0, tz1], [tcx, towerTop.wallTop, tz1], 'front');
  b.dimension('tower-peak', 'Height to the highest point of the main tower', [towerTop.peakX, 0, tz1], [towerTop.peakX, towerTop.peak, tz1], 'front');
  b.dimension('tower-side', 'Width of the main tower', [tx0, 0, tz1], [tx1, 0, tz1], 'front');
  b.dimension('bay-length', 'Bay spacing along the nave', [W / 2, 0, -M.bayLen], [W / 2, 0, -2 * M.bayLen], 'plan');
  b.dimension('west-door-width', 'Width of the west door opening', [westDoor.u0, 0, doorInTower ? tz1 : 0], [westDoor.u1, 0, doorInTower ? tz1 : 0], 'front');
  if (apseInfo) b.dimension('apse-depth', 'Projection of the apse beyond the east wall', [0, 0, -L], [0, 0, apseInfo.zc - apseInfo.reach], 'plan');
  if (tr) b.dimension('transept-span', 'Overall span across the transept', [trArms.includes(-1) ? -W / 2 - tr.depth : -W / 2, 0, trZ[1]], [trArms.includes(1) ? W / 2 + tr.depth : W / 2, 0, trZ[1]], 'plan');
  if (porchBuilt) b.dimension('porch-projection', 'Projection of the side porch', [porchSide * W / 2, 0, pz1], [porchInfo.xOut, 0, pz1], 'plan');
  b.dimensions.splice(12);

  return {
    builder: b,
    title: 'Masonry hall with a tower',
    frame: {
      origin: 'On the ground at the midpoint of the west front of the nave; that wall face is the plane z = 0 and the nave extends towards -Z.',
      front: 'The west front, with the main door, faces +Z; +X is to the right when you look at the west front.',
    },
    scope_note: 'The building exterior only: nave, roof, buttresses, windows and doors, towers with their tops, and the apse, transept and porch where present. ' +
      'No ground plane, churchyard, walls, gravestones, trees or neighbouring buildings.',
    probeOrder: ['east-end', 'tower-top', 'tower2-top', 'porch-side', 'transept-left', 'transept-right', 'nave-left', 'nave-right', 'roof-left', 'roof-right',
      'west-front', 'tower-face', 'tower-front', 'west-gable'],
    structure: { bays: M.bays, arch: S.arch, tower: T.place, top: T.top, tower2: t2.built, apse: !!p.apse, transept: tr ? tr.arms : null, porch: porchBuilt },
  };
}

export const edits = [
  { id: 'fewer-bays', scope: ['nave', 'nave.roof', 'buttresses', 'windows.left', 'windows.right', 'apse', 'tower2'], applies: p => p.massing.bays >= 5 && (!p.transept || p.transept.bay < p.massing.bays - 2),
    apply: p => ({ ...p, massing: { ...p.massing, bays: p.massing.bays - 1 } }), phrase: 'the nave was one bay shorter' },
  { id: 'lower-tower', scope: ['tower', 'tower.top', 'tower.belfry'], applies: () => true, apply: p => ({ ...p, tower: { ...p.tower, rise: p.tower.rise - p.tower.belfry - 0.8 } }),
    phrase: 'the main tower lacked its upper stage' },
  { id: 'no-spire', scope: ['tower.top'], applies: (p, s) => s.top === 'spire', apply: p => ({ ...p, tower: { ...p.tower, top: 'parapet' } }), phrase: 'the tower had a parapet but no spire' },
  { id: 'no-porch', scope: ['porch'], applies: (p, s) => s.porch, apply: p => ({ ...p, porch: { ...p.porch, built: false } }), phrase: 'the side porch had not been built' },
  { id: 'no-second-tower', scope: ['tower2'], applies: (p, s) => s.tower2, apply: p => ({ ...p, tower2: { ...p.tower2, built: false } }), phrase: 'the second tower had not been built' },
];

export default { id: 'hall', sample, build, edits };
