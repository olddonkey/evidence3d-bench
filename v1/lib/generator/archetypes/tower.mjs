// Multi-storey block: a podium with a glazed ground storey, a recessed entrance
// and canopy; a shaft whose facade grid (curtain-wall fins and spandrels, ribbon
// windows, or punched windows) is real geometry; a solid core strip with a lift
// overrun on one side; a crown (setback upper floors, plant screen or extended
// fins with a ring beam) and rooftop plant.
import { ModelBuilder, wallFrame, wall, opening, glazedOpening, doorOpening, draw } from '../kit.mjs';

const PALETTES = [
  { podium: ['#c9c3b6', 'stone'], panel: '#d9d7d1', fin: '#8c9298', core: ['#b8b3a9', 'concrete'], glass: '#3b5566', wall: ['#cfc8ba', 'concrete'] },
  { podium: ['#5d5e60', 'stone'], panel: '#2f3337', fin: '#1f2326', core: ['#77797b', 'concrete'], glass: '#2c4150', wall: ['#8a8c8e', 'concrete'] },
  { podium: ['#a46e55', 'wall'], panel: '#e6e2d8', fin: '#c4c7c9', core: ['#9a6450', 'wall'], glass: '#46606b', wall: ['#b07a5e', 'wall'] },
  { podium: ['#e3dfd6', 'stone'], panel: '#b9bfc4', fin: '#6f777e', core: ['#d0cbc0', 'concrete'], glass: '#30495a', wall: ['#e0dbd0', 'concrete'] },
];

export function sample(r) {
  const m = r.fork('massing');
  const podiumBays = m.int(3, 5), podiumBayW = draw(m, 7.5, 9.0, 0.25), podiumW = podiumBays * podiumBayW, podiumD = draw(m, 22, 32, 0.5);
  const facade = m.pick(['curtain', 'curtain', 'ribbon', 'punched']);
  const shaftW = draw(m, 16, Math.min(30, podiumW - 5), 0.5), shaftD = draw(m, 15, Math.min(24, podiumD - 5), 0.5);
  const slack = (podiumW - shaftW) / 2 - 1;
  const massing = {
    left: -podiumW / 2, podiumBays, podiumBayW, podiumD, podiumFloors: m.int(1, 3), ground: draw(m, 4.6, 5.4), podiumStorey: draw(m, 3.8, 4.2),
    shaftW, shaftD, shaftX: m.pick([-1, 1]) * draw(m, Math.min(1.5, slack), Math.max(1.5, slack), 0.5),
    shaftSetback: draw(m, 1.5, Math.min(4, podiumD - shaftD - 1), 0.5),
    floors: facade === 'punched' ? m.int(8, 16) : m.int(10, 24), floorH: draw(m, 3.6, 3.9),
    facade, module: draw(m, 1.35, 1.8), coreSide: m.pick([-1, 1]), coreW: draw(m, 5, 7, 0.5),
  };
  const c = r.fork('crown');
  const crown = { type: c.pick(['setback', 'screen', 'fins']), floors: c.int(2, 3), setback: draw(c, 2.0, 3.5), screenH: draw(c, 3.0, 4.2), finRise: draw(c, 2.0, 3.2) };
  const e = r.fork('entrance');
  const entrance = { bay: e.pick([...Array(podiumBays).keys()].filter(i => Math.abs(i - (podiumBays - 1) / 2) >= 0.9)), canopyDepth: draw(e, 2.6, 3.8), recess: draw(e, 1.2, 2.0) };
  const o = r.fork('options');
  const plant = [...Array(o.int(2, 4)).keys()].map(k => {
    const p = r.fork('plant-' + k);
    return { w: draw(p, 2.0, 4.0), d: draw(p, 1.5, 2.5), h: draw(p, 1.4, 2.4), u: p.next(), v: p.next(), round: p.chance(0.4) };
  });
  // A later one-bay extension of the podium on the side away from the shaft offset.
  const podiumExtension = o.chance(0.6);
  return { massing, crown, entrance, plant, mast: o.chance(0.6), podiumExtension, podiumPlant: o.chance(0.5), palette: r.fork('palette').int(0, PALETTES.length - 1) };
}

export function build(p) {
  const b = new ModelBuilder(), M = p.massing, pal = PALETTES[p.palette];
  b.material('podium', pal.podium[0], pal.podium[1], { roughness: 0.8 });
  b.material('panel', pal.panel, 'wall', { roughness: 0.6, metalness: 0.2 });
  b.material('fin', pal.fin, 'metal', { roughness: 0.4, metalness: 0.6 });
  b.material('core', pal.core[0], pal.core[1], { roughness: 0.9 });
  b.material('glass', pal.glass, 'glass', { roughness: 0.05, metalness: 0.2 });
  b.material('wall', pal.wall[0], pal.wall[1], { roughness: 0.85 });
  b.material('frame', '#3a3d40', 'frame', { roughness: 0.4, metalness: 0.5 });
  b.material('roof', '#6a6c6d', 'roof', { roughness: 0.9 });
  b.material('coping', '#a6a49d', 'stone', { roughness: 0.8 });
  b.material('steel', '#4a4f54', 'metal', { roughness: 0.4, metalness: 0.7 });
  b.material('plant', '#b4b8ba', 'metal', { roughness: 0.5, metalness: 0.4 });

  // Podium bays are fixed in the frame of the building as generated; the
  // extension adds one bay on the side away from the shaft offset.
  const bw = M.podiumBayW, extSide = M.shaftX >= 0 ? -1 : 1;
  const first = p.podiumExtension && extSide < 0 ? -1 : 0, last = M.podiumBays - 1 + (p.podiumExtension && extSide > 0 ? 1 : 0);
  const bayIdx = []; for (let i = first; i <= last; i++) bayIdx.push(i);
  const bayX = i => M.left + i * bw;                          // left edge of bay i (i may be -1)
  const xL = bayX(first), xR = bayX(last + 1), xMid0 = M.left + M.podiumBays * bw / 2;
  const Dp = M.podiumD, Hp = M.ground + (M.podiumFloors - 1) * M.podiumStorey, parapet = 1.0, Hpp = Hp + parapet;
  const sx0 = M.shaftX - M.shaftW / 2, sx1 = M.shaftX + M.shaftW / 2, sz1 = -M.shaftSetback, sz0 = sz1 - M.shaftD;
  const fh = M.floorH, crown = p.crown;
  const lowFloors = crown.type === 'setback' ? M.floors - crown.floors : M.floors;

  b.group('podium', 'Podium walls, parapet and roof', 'massing', 0.3, 'all');
  b.group('podium.glazing', 'Ground-storey glazing and piers', 'openings', 0.1, 'front');
  b.group('podium.windows', 'Upper podium windows', 'openings', 0.08, 'all');
  b.group('entrance', 'Recessed entrance and doors', 'entrance', 0.1, 'front');
  b.group('canopy', 'Entrance canopy', 'attachments', 0.15, 'front');
  b.group('shaft', 'Shaft volume and roof slabs', 'massing', 0.3, 'all');
  b.group('facade.grid', 'Shaft facade grid (' + M.facade + ')', 'openings', M.facade === 'punched' ? 0.1 : 0.12, 'all');
  b.group('core', 'Core strip and lift overrun', 'massing', 0.3, M.coreSide < 0 ? 'left' : 'right');
  b.group('crown', 'Crown (' + crown.type + ')', 'roof', 0.2, 'roof');
  b.group('roof.plant', 'Rooftop plant and mast', 'attachments', 0.3, 'roof');

  // ---- podium -------------------------------------------------------------------
  const t = 0.35, wfF = wallFrame('z', 1, 0), wfB = wallFrame('z', -1, -Dp), wfL = wallFrame('x', -1, xL), wfR = wallFrame('x', 1, xR);
  const entBay = p.entrance.bay, ex0 = bayX(entBay) + 0.5, ex1 = bayX(entBay + 1) - 0.5, er = p.entrance.recess;
  const gTop = M.ground - 0.9;
  const groundOpenings = [], upperOpenings = [];
  for (const i of bayIdx) if (i !== entBay) groundOpenings.push(opening({ u0: bayX(i) + 0.5, u1: bayX(i + 1) - 0.5, y0: 0.35, y1: gTop }));
  const entranceNotch = opening({ u0: ex0, u1: ex1, y0: 0, y1: gTop });
  for (let f = 1; f < M.podiumFloors; f++) {
    const y0 = M.ground + (f - 1) * M.podiumStorey + 0.9;
    for (const i of bayIdx) upperOpenings.push(opening({ u0: bayX(i) + 0.7, u1: bayX(i + 1) - 0.7, y0, y1: y0 + M.podiumStorey - 1.6 }));
  }
  wall(b, wfF, { id: 'podium-front', group: 'podium', material: 'podium', u0: xL + t, u1: xR - t, y0: 0, y1: Hpp, thickness: t, openings: [...groundOpenings, entranceNotch, ...upperOpenings] });
  const rearOpenings = upperOpenings.map(o => opening({ u0: o.u0, u1: o.u1, y0: o.y0, y1: o.top }));
  const serviceX = bayX(Math.floor(M.podiumBays / 2)) + bw / 2, service = opening({ u0: serviceX - 1.8, u1: serviceX + 1.8, y0: 0, y1: 4.0 });
  wall(b, wfB, { id: 'podium-rear', group: 'podium', material: 'podium', u0: xL + t, u1: xR - t, y0: 0, y1: Hpp, thickness: t, openings: [service, ...rearOpenings] });
  const sideCols = Math.max(2, Math.round(Dp / 8.2)), sideBay = Dp / sideCols, sideOpenings = [];
  for (let f = 1; f < M.podiumFloors; f++) {
    const y0 = M.ground + (f - 1) * M.podiumStorey + 0.9;
    for (let i = 0; i < sideCols; i++) sideOpenings.push(opening({ u0: i * sideBay + 0.9, u1: (i + 1) * sideBay - 0.9, y0, y1: y0 + M.podiumStorey - 1.6 }));
  }
  for (const [name, wf] of [['left', wfL], ['right', wfR]]) wall(b, wf, { id: 'podium-' + name, group: 'podium', material: 'podium', u0: 0, u1: Dp, y0: 0, y1: Hpp, thickness: t, openings: sideOpenings });
  b.box('podium-roof', 'podium', 'roof', [xL + 0.2, Hp - 0.3, -Dp + 0.2], [xR - 0.2, Hp, -0.2]);
  b.box('podium-coping-front', 'podium', 'coping', [xL - 0.05, Hpp - 0.04, -t - 0.05], [xR + 0.05, Hpp + 0.1, 0.05]);
  b.box('podium-coping-rear', 'podium', 'coping', [xL - 0.05, Hpp - 0.04, -Dp - 0.05], [xR + 0.05, Hpp + 0.1, -Dp + t + 0.05]);
  b.box('podium-coping-left', 'podium', 'coping', [xL - 0.05, Hpp - 0.04, -Dp + t + 0.05], [xL + t + 0.05, Hpp + 0.1, -t - 0.05]);
  b.box('podium-coping-right', 'podium', 'coping', [xR - t - 0.05, Hpp - 0.04, -Dp + t + 0.05], [xR + 0.05, Hpp + 0.1, -t - 0.05]);
  // Ground storey: piers proud of the wall between the bays, a fascia band above them.
  for (let i = first; i <= last + 1; i++) {
    const x = bayX(i), x0 = i === first ? xL - 0.2 : x - 0.4, x1 = i === last + 1 ? xR + 0.2 : x + 0.4;
    b.box('podium-pier-' + (i - first), 'podium.glazing', 'podium', [x0, 0, -0.02], [x1, gTop + 0.5, 0.2]);
  }
  wfF.box(b, 'podium-fascia', 'podium.glazing', 'panel', xL - 0.25, xR + 0.25, gTop + 0.5, M.ground + 0.1, -0.25, 0.02);
  const glaze = { frame: 'frame', glass: 'glass', recess: 0.12, frameWidth: 0.08, frameDepth: 0.1 };
  const mulls = o => Math.max(1, Math.round((o.u1 - o.u0) / 1.5) - 1);
  groundOpenings.forEach((o, k) => glazedOpening(b, wfF, o, { ...glaze, id: 'podium-glazing-' + (k + 1), group: 'podium.glazing', sill: 'coping', recess: 0.15,
    frameWidth: 0.1, frameDepth: 0.12, mullions: Math.max(1, Math.round((o.u1 - o.u0) / 1.6) - 1), transoms: [Math.min(3.0, gTop - 0.6)] }));
  upperOpenings.forEach((o, k) => glazedOpening(b, wfF, o, { ...glaze, id: 'podium-window-f' + (k + 1), group: 'podium.windows', mullions: mulls(o) }));
  rearOpenings.forEach((o, k) => glazedOpening(b, wfB, o, { ...glaze, id: 'podium-window-r' + (k + 1), group: 'podium.windows', mullions: mulls(o) }));
  for (const [name, wf] of [['left', wfL], ['right', wfR]]) {
    sideOpenings.forEach((o, k) => glazedOpening(b, wf, o, { ...glaze, id: 'podium-window-' + name + '-' + (k + 1), group: 'podium.windows', mullions: mulls(o) }));
  }
  doorOpening(b, wfB, service, { id: 'service-door', group: 'podium', frame: 'steel', leaf: 'steel', glass: 'glass', metal: 'steel', style: 'boarded', leaves: 2, frameWidth: 0.12 });

  // ---- recessed entrance and canopy ------------------------------------------------
  const cd = p.entrance.canopyDepth, cy = gTop + 0.55, cx0 = ex0 - 1.2, cx1 = ex1 + 1.2;
  {
    const wfE = wallFrame('z', 1, -er), wfEL = wallFrame('x', 1, ex0), wfER = wallFrame('x', -1, ex1);
    const doors = opening({ u0: (ex0 + ex1) / 2 - 1.5, u1: (ex0 + ex1) / 2 + 1.5, y0: 0, y1: 3.0 });
    const lights = [[ex0 + 0.4, doors.u0 - 0.4], [doors.u1 + 0.4, ex1 - 0.4]].filter(([a, c]) => c - a > 0.5).map(([u0, u1]) => opening({ u0, u1, y0: 0.3, y1: gTop - 0.4 }));
    wall(b, wfE, { id: 'entrance-screen', group: 'entrance', material: 'podium', u0: ex0 - 0.05, u1: ex1 + 0.05, y0: 0, y1: gTop + 0.05, thickness: 0.3, openings: [doors, ...lights] });
    doorOpening(b, wfE, doors, { id: 'entrance-doors', group: 'entrance', frame: 'frame', leaf: 'frame', glass: 'glass', metal: 'steel', style: 'full-glass', leaves: 2, fanlight: 0.5, frameWidth: 0.1, frameDepth: 0.12 });
    lights.forEach((o, k) => glazedOpening(b, wfE, o, { ...glaze, id: 'entrance-light-' + (k + 1), group: 'entrance', frameDepth: 0.12, mullions: 1 }));
    // Linings and soffit close the recess; they stand 2 cm proud of the facade and
    // the linings stop under the soffit, so no face is flush with another part.
    wfEL.box(b, 'entrance-reveal-left', 'entrance', 'panel', -0.02, er + 0.02, 0, gTop - 0.04, -0.04, 0.02);
    wfER.box(b, 'entrance-reveal-right', 'entrance', 'panel', -0.02, er + 0.02, 0, gTop - 0.04, -0.04, 0.02);
    b.box('entrance-soffit', 'entrance', 'panel', [ex0 - 0.02, gTop - 0.04, -er - 0.02], [ex1 + 0.02, gTop + 0.02, 0.02]);
    b.box('canopy-slab', 'canopy', 'fin', [cx0, cy, 0.16], [cx1, cy + 0.35, cd]);
    b.box('canopy-fascia', 'canopy', 'panel', [cx0 - 0.03, cy - 0.12, cd - 0.02], [cx1 + 0.03, cy + 0.4, cd + 0.03]);
    const anchorY = Math.min(cy + 2.6, Hpp - 0.4);
    for (const [k, x] of [[1, cx0 + 0.6], [2, cx1 - 0.6]]) b.beam('canopy-hanger-' + k, 'canopy', 'steel', [x, cy + 0.3, cd - 0.3], [x, anchorY, 0.22], 0.04, 10);
  }

  // ---- shaft --------------------------------------------------------------------------
  const spandrel = M.facade === 'curtain' ? 0.95 : 1.25;
  const modules = w => Math.max(2, Math.round(w / M.module));
  const coreZ = [(sz0 + sz1) / 2 - M.coreW / 2, (sz0 + sz1) / 2 + M.coreW / 2];
  const coreFace = M.coreSide < 0 ? 'left' : 'right';
  // One volume of the shaft: facade grid over a glazed or walled box, and a roof slab.
  const volume = (id, x0, x1, z0, z1, y0, floors, finRise = 0) => {
    const yTop = y0 + floors * fh;
    if (M.facade !== 'punched') {
      b.box(id + '-glass', 'shaft', 'glass', [x0, y0 - 0.3, z0], [x1, yTop + 0.02, z1]);
      const proud = 0.07;
      for (let f = 0; f <= floors; f++) {
        const ya = f === 0 ? y0 - 0.3 : y0 + f * fh - spandrel / 2, yb = Math.min(yTop + 0.02, y0 + f * fh + spandrel / 2);
        b.box(id + '-spandrel-' + f + '-front', 'facade.grid', 'panel', [x0 - proud, ya, z1 - 0.02], [x1 + proud, yb, z1 + proud]);
        b.box(id + '-spandrel-' + f + '-rear', 'facade.grid', 'panel', [x0 - proud, ya, z0 - proud], [x1 + proud, yb, z0 + 0.02]);
        b.box(id + '-spandrel-' + f + '-left', 'facade.grid', 'panel', [x0 - proud, ya, z0 + 0.02], [x0 + 0.02, yb, z1 - 0.02]);
        b.box(id + '-spandrel-' + f + '-right', 'facade.grid', 'panel', [x1 - 0.02, ya, z0 + 0.02], [x1 + proud, yb, z1 - 0.02]);
      }
      const depth = M.facade === 'curtain' ? 0.32 : 0.16, fw = M.facade === 'curtain' ? 0.09 : 0.07, yb = yTop + (finRise || 0.02);
      for (const [face, a, c] of [['front', x0, x1], ['rear', x0, x1], ['left', z0, z1], ['right', z0, z1]]) {
        const n = modules(c - a), step = (c - a) / n;
        for (let k = 1; k < n; k++) {
          const s = a + k * step;
          if (face === coreFace && s > coreZ[0] - 0.4 && s < coreZ[1] + 0.4) continue;
          const fid = id + '-fin-' + face + '-' + k;
          if (face === 'front') b.box(fid, 'facade.grid', 'fin', [s - fw / 2, y0 - 0.3, z1 - 0.02], [s + fw / 2, yb, z1 + depth]);
          else if (face === 'rear') b.box(fid, 'facade.grid', 'fin', [s - fw / 2, y0 - 0.3, z0 - depth], [s + fw / 2, yb, z0 + 0.02]);
          else if (face === 'left') b.box(fid, 'facade.grid', 'fin', [x0 - depth, y0 - 0.3, s - fw / 2], [x0 + 0.02, yb, s + fw / 2]);
          else b.box(fid, 'facade.grid', 'fin', [x1 - 0.02, y0 - 0.3, s - fw / 2], [x1 + depth, yb, s + fw / 2]);
        }
      }
    } else {
      // Punched facade: four walls with a window per double module and floor.
      const tw = 0.35;
      const faces = [['front', wallFrame('z', 1, z1), x0 + tw, x1 - tw], ['rear', wallFrame('z', -1, z0), x0 + tw, x1 - tw],
        ['left', wallFrame('x', -1, x0), -z1, -z0], ['right', wallFrame('x', 1, x1), -z1, -z0]];
      for (const [face, wf, u0, u1] of faces) {
        const n = Math.max(2, Math.round((u1 - u0) / (M.module * 2))), step = (u1 - u0) / n, openings = [];
        for (let f = 0; f < floors; f++) for (let k = 0; k < n; k++) {
          const uc = u0 + (k + 0.5) * step;
          if (face === coreFace && -uc > coreZ[0] - 1.2 && -uc < coreZ[1] + 1.2) continue;
          const ya = y0 + f * fh + 0.95;
          openings.push(opening({ u0: uc - step * 0.3, u1: uc + step * 0.3, y0: ya, y1: ya + fh - 1.55 }));
        }
        wall(b, wf, { id: id + '-wall-' + face, group: 'shaft', material: 'wall', u0, u1, y0: y0 - 0.3, y1: yTop + 0.02, thickness: tw, openings });
        openings.forEach((o, k) => glazedOpening(b, wf, o, { ...glaze, id: id + '-window-' + face + '-' + (k + 1), group: 'facade.grid', recess: 0.1,
          frameWidth: 0.07, mullions: o.u1 - o.u0 > 1.6 ? 1 : 0 }));
      }
    }
    b.box(id + '-roof', 'shaft', M.facade === 'punched' ? 'wall' : 'panel', [x0 - 0.1, yTop, z0 - 0.1], [x1 + 0.1, yTop + 1.2, z1 + 0.1]);
    return yTop + 1.2;
  };
  const mainTop = volume('shaft', sx0, sx1, sz0, sz1, Hp, lowFloors, crown.type === 'fins' ? crown.finRise + 1.2 : 0);
  let roofTop = mainTop, roofArea = { x0: sx0, x1: sx1, z0: sz0, z1: sz1, y: mainTop };
  if (crown.type === 'setback') {
    // The upper floors step back from the front and from the side away from the core.
    const sb = crown.setback, ux0 = M.coreSide < 0 ? sx0 : sx0 + sb, ux1 = M.coreSide < 0 ? sx1 - sb : sx1;
    roofTop = volume('upper', ux0, ux1, sz0, sz1 - sb, mainTop, crown.floors);
    roofArea = { x0: ux0, x1: ux1, z0: sz0, z1: sz1 - sb, y: roofTop };
    b.box('crown-balustrade', 'crown', 'glass', [sx0 + 0.3, mainTop - 0.02, sz1 - 0.38], [sx1 - 0.3, mainTop + 1.1, sz1 - 0.3]);
  } else if (crown.type === 'screen') {
    const inset = 3.0, y = mainTop, x0 = sx0 + inset, x1 = sx1 - inset, z0 = sz0 + inset, z1 = sz1 - inset, h = crown.screenH;
    // The base is inset 5 cm so its sides stay inside the screen walls.
    b.box('crown-screen-base', 'crown', 'roof', [x0 + 0.05, y - 0.02, z0 + 0.05], [x1 - 0.05, y + 0.3, z1 - 0.05]);
    b.box('crown-screen-front', 'crown', 'fin', [x0, y + 0.28, z1 - 0.15], [x1, y + h, z1]);
    b.box('crown-screen-rear', 'crown', 'fin', [x0, y + 0.28, z0], [x1, y + h, z0 + 0.15]);
    b.box('crown-screen-left', 'crown', 'fin', [x0, y + 0.28, z0 + 0.15], [x0 + 0.15, y + h, z1 - 0.15]);
    b.box('crown-screen-right', 'crown', 'fin', [x1 - 0.15, y + 0.28, z0 + 0.15], [x1, y + h, z1 - 0.15]);
    roofTop = y + h;
  } else {
    // Fins run up past the roof slab and carry a ring beam along their outer edges.
    const yb = mainTop + crown.finRise, depth = M.facade === 'curtain' ? 0.32 : 0.16, d0 = 0.1, d1 = depth + 0.03;
    b.box('crown-ring-front', 'crown', 'fin', [sx0 - d1, yb - 0.35, sz1 + d0], [sx1 + d1, yb + 0.02, sz1 + d1]);
    b.box('crown-ring-rear', 'crown', 'fin', [sx0 - d1, yb - 0.35, sz0 - d1], [sx1 + d1, yb + 0.02, sz0 - d0]);
    b.box('crown-ring-left', 'crown', 'fin', [sx0 - d1, yb - 0.35, sz0 - d0], [sx0 - d0, yb + 0.02, sz1 + d0]);
    b.box('crown-ring-right', 'crown', 'fin', [sx1 + d0, yb - 0.35, sz0 - d0], [sx1 + d1, yb + 0.02, sz1 + d0]);
    roofTop = yb + 0.02;
  }
  // Core strip with lift overrun on one side face, up past the highest roof.
  const s = M.coreSide, face = s < 0 ? sx0 : sx1;
  const coreBox = { xa: s < 0 ? face - 0.45 : face - 0.8, xb: s < 0 ? face + 0.8 : face + 0.45, za: coreZ[0], zb: coreZ[1],
    top: (crown.type === 'setback' ? roofTop : mainTop) + 2.8 };
  b.box('core', 'core', 'core', [coreBox.xa, Hp - 0.3, coreBox.za], [coreBox.xb, coreBox.top, coreBox.zb]);

  // ---- rooftop plant -------------------------------------------------------------------
  const placed = [];
  if (crown.type !== 'screen') {
    p.plant.forEach((unit, k) => {
      const x = roofArea.x0 + 1.5 + unit.w / 2 + (roofArea.x1 - roofArea.x0 - 3 - unit.w) * unit.u;
      const z = roofArea.z0 + 1.5 + unit.d / 2 + (roofArea.z1 - roofArea.z0 - 3 - unit.d) * unit.v * 0.6;
      if (placed.some(q => Math.abs(q.x - x) < (q.w + unit.w) / 2 + 1 && Math.abs(q.z - z) < (q.d + unit.d) / 2 + 1)) return;
      if (x + unit.w / 2 > coreBox.xa - 1 && x - unit.w / 2 < coreBox.xb + 1 && z + unit.d / 2 > coreBox.za - 1 && z - unit.d / 2 < coreBox.zb + 1) return;
      placed.push({ x, z, w: unit.w, d: unit.d });
      if (unit.round) b.cylinder('plant-' + (k + 1), 'roof.plant', 'plant', [x, roofArea.y - 0.02, z], unit.h, Math.min(unit.w, unit.d) / 2, { segments: 24 });
      else {
        b.box('plant-' + (k + 1), 'roof.plant', 'plant', [x - unit.w / 2, roofArea.y - 0.02, z - unit.d / 2], [x + unit.w / 2, roofArea.y + unit.h, z + unit.d / 2]);
        b.cylinder('plant-' + (k + 1) + '-fan', 'roof.plant', 'steel', [x, roofArea.y + unit.h - 0.02, z], 0.3, Math.min(0.6, unit.d / 2 - 0.15), { segments: 20 });
      }
    });
  }
  if (p.mast) {
    const mx = (coreBox.xa + coreBox.xb) / 2, mz = coreBox.zb - 0.8;
    b.beam('mast', 'roof.plant', 'steel', [mx, coreBox.top - 0.05, mz], [mx, coreBox.top + 6, mz], 0.09, 12);
    for (let k = 0; k < 3; k++) b.beam('mast-arm-' + (k + 1), 'roof.plant', 'steel', [mx - 0.6, coreBox.top + 3.6 + k * 0.8, mz], [mx + 0.6, coreBox.top + 3.6 + k * 0.8, mz], 0.03, 8);
  }
  if (p.podiumPlant) {
    const px = M.shaftX >= 0 ? Math.max(sx1 + 3, bayX(0) + 2.5) : Math.min(sx0 - 3, bayX(M.podiumBays) - 2.5), pz = -Dp + 4;
    if (px - 1.5 > bayX(0) + 1 && px + 1.5 < bayX(M.podiumBays) - 1 && (px - 1.5 > sx1 + 1 || px + 1.5 < sx0 - 1)) {
      b.box('podium-plant', 'roof.plant', 'plant', [px - 1.5, Hp - 0.02, pz - 1], [px + 1.5, Hp + 1.6, pz + 1]);
    }
  }

  // ---- probes ------------------------------------------------------------------------
  const pcx = (roofArea.x0 + roofArea.x1) / 2;
  for (const [x, z] of [[pcx, roofArea.z1 - 2], [roofArea.x0 + 2, roofArea.z1 - 2], [roofArea.x1 - 2, roofArea.z1 - 2], [pcx, (roofArea.z0 + roofArea.z1) / 2]]) {
    b.probe('roof-height', 'Height of the main roof', [x, 300, z], [0, -1, 0]);
  }
  // Podium roof on the original podium (an earlier, narrower podium has it too).
  const terraceX = M.shaftX >= 0 ? (bayX(0) + sx0) / 2 : (sx1 + bayX(M.podiumBays)) / 2;
  for (const z of [-Dp / 2, -Dp / 3, -2 * Dp / 3]) b.probe('podium-roof', 'Height of the podium roof', [terraceX, 300, z], [0, -1, 0]);
  if (crown.type === 'setback') for (const x of [(sx0 + sx1) / 2, sx0 + 2, sx1 - 2]) b.probe('setback-terrace', 'Height of the setback terrace roof', [x, 300, sz1 - 1.6], [0, -1, 0]);
  // Shaft faces: mid-pane between fins for glazed facades, the band between window rows for punched ones.
  const f0 = Math.floor(lowFloors / 2);
  const faceY = M.facade === 'punched' ? Hp + (f0 + 1) * fh + 0.175 : Hp + f0 * fh + fh / 2;
  const paneCentres = (a, c) => { const n = modules(c - a), step = (c - a) / n; return [Math.floor(n / 2), Math.floor(n / 3), Math.floor(2 * n / 3)].map(k => a + (k + 0.5) * step); };
  for (const x of paneCentres(sx0, sx1)) b.probe('shaft-front', 'Position of the shaft front face', [x, faceY, 300], [0, 0, -1]);
  for (const x of paneCentres(sx0, sx1)) b.probe('shaft-rear', 'Position of the shaft rear face', [x, faceY, -300], [0, 0, 1]);
  for (const [name, sgn] of [['shaft-left', -1], ['shaft-right', 1]]) {
    for (const z of paneCentres(sz0, sz1).filter(z => (sgn < 0 ? 'left' : 'right') !== coreFace || z < coreZ[0] - 0.8 || z > coreZ[1] + 0.8)) {
      b.probe(name, 'Position of the shaft ' + name.split('-')[1] + ' face', [sgn * 300, faceY, z], [-sgn, 0, 0]);
    }
  }
  const fasciaY = (gTop + 0.5 + M.ground + 0.1) / 2;
  for (const x of [xMid0, bayX(0) + bw / 2, bayX(M.podiumBays) - bw / 2]) b.probe('podium-front', 'Position of the podium front fascia', [x, fasciaY, 300], [0, 0, -1]);
  for (const [name, sgn] of [['podium-left', -1], ['podium-right', 1]]) for (const [y, z] of [[Hp + 0.45, -Dp / 2], [1.8, -Dp / 2], [1.8, -Dp / 4]]) {
    b.probe(name, 'Position of the podium ' + name.split('-')[1] + ' wall', [sgn * 300, y, z], [-sgn, 0, 0]);
  }
  b.probe('core-top', 'Height of the lift overrun', [(coreBox.xa + coreBox.xb) / 2, 300, coreBox.za + 0.9], [0, -1, 0]);
  b.probe('canopy-top', 'Height of the entrance canopy', [(cx0 + cx1) / 2, 300, (0.16 + cd) / 2], [0, -1, 0]);

  // ---- dimensions --------------------------------------------------------------------
  b.dimension('podium-width', 'Width of the podium front', [xL, 0, 0], [xR, 0, 0], 'front');
  b.dimension('podium-height', 'Height to the top of the podium parapet', [xL, 0, 0], [xL, Hpp + 0.1, 0], 'front');
  b.dimension('overall-height', 'Height to the top of the main roof slab', [M.shaftX, 0, 0], [M.shaftX, mainTop, 0], 'front');
  b.dimension('shaft-width', 'Width of the shaft', [sx0, Hp + 2, sz1], [sx1, Hp + 2, sz1], 'front');
  b.dimension('shaft-setback', 'Setback of the shaft behind the podium front', [sx0, Hp, 0], [sx0, Hp, sz1], 'plan');
  b.dimension('podium-depth', 'Depth of the podium', [xR, 0, 0], [xR, 0, -Dp], 'plan');
  b.dimension('shaft-depth', 'Depth of the shaft', [sx1, Hp + 2, sz1], [sx1, Hp + 2, sz0], 'right');
  b.dimension('storey-height', 'Floor-to-floor height of the shaft', [sx0, Hp + 3 * fh, sz1], [sx0, Hp + 4 * fh, sz1], 'front');
  b.dimension('canopy-depth', 'Projection of the entrance canopy', [cx1, cy, 0], [cx1, cy, cd + 0.03], 'plan');
  b.dimension('entrance-width', 'Width of the entrance recess', [ex0, 0, 0], [ex1, 0, 0], 'front');
  b.dimension('core-overrun', 'Height to the top of the lift overrun', [coreBox.xa, 0, coreBox.zb], [coreBox.xa, coreBox.top, coreBox.zb], 'right');

  return {
    builder: b,
    title: 'Multi-storey office building on a podium',
    frame: {
      origin: 'On the ground at the midpoint of the podium front wall; that wall face is the plane z = 0 and the building extends towards -Z.',
      front: 'The podium front, with the main entrance and its canopy, faces +Z; +X is to the right when you look at the front.',
    },
    scope_note: 'The building exterior only: podium, shaft, facade grid, core and lift overrun, crown, rooftop plant and mast, entrance and canopy. ' +
      'No ground plane, street furniture, trees, vehicles, lettering or neighbouring buildings.',
    structure: { facade: M.facade, floors: M.floors, podiumFloors: M.podiumFloors, crown: crown.type, podiumBays: bayIdx.length, plant: placed.length, mast: p.mast,
      podiumExtension: p.podiumExtension, coreSide: M.coreSide },
  };
}

export const edits = [
  { id: 'fewer-floors', scope: ['shaft', 'facade.grid', 'core', 'crown', 'roof.plant'], applies: p => p.massing.floors >= 8,
    apply: p => ({ ...p, massing: { ...p.massing, floors: p.massing.floors - (p.massing.floors >= 16 ? 4 : p.massing.floors >= 10 ? 3 : 2) } }),
    phrase: 'the shaft was several floors lower' },
  { id: 'no-podium-extension', scope: ['podium', 'podium.glazing', 'podium.windows'], applies: p => p.podiumExtension, apply: p => ({ ...p, podiumExtension: false }), phrase: 'the podium was one bay narrower' },
  { id: 'no-mast', scope: ['roof.plant'], applies: (p, s) => s.mast, apply: p => ({ ...p, mast: false }), phrase: 'there was no mast on the roof' },
];

export default { id: 'tower', sample, build, edits };
