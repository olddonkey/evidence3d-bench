// Single-storey commercial building: parapet walls on a structural bay rhythm,
// storefront glazing with mullions, a masonry base band, a raised entrance tower
// with a blank sign box and canopy, awnings or a continuous canopy, a blank sign
// band, rooftop plant and a rear loading bay. No lettering or logos anywhere.
import {
  ModelBuilder, wallFrame, wall, opening, glazedOpening, doorOpening, band, draw, DEG,
} from '../kit.mjs';

const T = 0.3;

const PALETTES = [
  { wall: ['#b9b2a6', 'concrete'], base: ['#6e4a3a', 'wall'], pier: '#a39b8e', frame: '#2b2e31', sign: '#ececea', awning: '#7b1f22', plant: '#a9adb0' },
  { wall: ['#8d5844', 'wall'], base: ['#5a5753', 'stone'], pier: '#7a4a39', frame: '#d6d8d9', sign: '#2c3034', awning: '#1f3d2e', plant: '#b8bcbe' },
  { wall: ['#d8d2c4', 'wall'], base: ['#8a8378', 'stone'], pier: '#c4bcab', frame: '#3a3f44', sign: '#f2f2f0', awning: '#22385a', plant: '#9da2a6' },
  { wall: ['#c7c9c8', 'concrete'], base: ['#4d4f52', 'stone'], pier: '#a6a9aa', frame: '#9ea3a8', sign: '#1d2022', awning: '#5a5f63', plant: '#c3c6c8' },
];

export function sample(r) {
  const m = r.fork('massing');
  const bays = m.int(4, 8), bayW = draw(m, 4.2, 6.0);
  // left: x of the left end wall. It is -W/2 for the building as generated and
  // stays put when an earlier state drops a bay, so both share one frame.
  const massing = {
    bays, bayW, left: -bays * bayW / 2, bay0: 0, depth: draw(m, Math.max(14, bays * bayW * 0.45), Math.min(30, bays * bayW * 0.85)),
    height: draw(m, 5.2, 6.8), parapet: draw(m, 0.7, 1.1),
  };
  const f = r.fork('front');
  const towerBay = f.pick([...Array(bays).keys()].filter(i => Math.abs(i - (bays - 1) / 2) >= 0.9));
  const front = {
    towerBay, towerWide: f.chance(0.4), towerRise: draw(f, 2.2, 3.6), towerProj: draw(f, 0.6, 1.4), towerBack: draw(f, 1.8, 3.0),
    riser: draw(f, 0.45, 0.65), head: draw(f, 3.0, Math.min(3.6, massing.height - massing.parapet - 1.1)), pier: draw(f, 0.5, 0.7),
    // Bays at the far end may be blank (masonry) rather than glazed.
    doorH: draw(f, 2.4, 2.7), doorW: draw(f, 2.0, 2.4),
  };
  front.towerWide = front.towerWide && towerBay + 1 < bays;
  const far = towerBay < bays / 2 ? bays - 1 : 0;
  // Positions fixed in the frame of the building as generated (centre x of bays).
  const bayCentre = i => massing.left + bayW * (i + 0.5);
  front.blankX = f.chance(0.35) ? bayCentre(far) : null;
  const towerSpan = front.towerWide ? 2 : 1;
  const glazed = [...Array(bays).keys()].filter(i => (i < towerBay || i >= towerBay + towerSpan) && bayCentre(i) !== front.blankX);
  front.signSide = glazed.filter(i => i < towerBay).length >= glazed.filter(i => i > towerBay).length ? -1 : 1;
  const o = r.fork('options');
  const shade = o.pick(['awnings', 'canopy', 'canopy-posts', 'none']);
  const canopy = { depth: draw(o, 1.6, 2.4), awningDepth: draw(o, 1.0, 1.5) };
  const W = bays * bayW;
  const plant = [...Array(o.int(2, 5)).keys()].map(k => {
    const p = r.fork('plant-' + k), w = draw(p, 1.4, 3.0);
    return { w, d: draw(p, 1.0, 1.8), h: draw(p, 1.0, 1.7), fans: p.int(1, 2),
      x: massing.left + 1.2 + w / 2 + (W - 2.4 - w) * p.next(), z: -massing.depth * (0.5 + 0.35 * p.next()) };
  });
  const sides = { serviceSide: o.pick([-1, 1]), highWindows: o.int(2, 4), dockCanopy: o.chance(0.6), loadingWidth: draw(o, 3.0, 4.0) };
  // The loading bay sits near the end wall on the tower side, which never moves.
  const towerEnd = towerBay < bays / 2 ? massing.left : massing.left + W;
  sides.loadingX = towerEnd - Math.sign(towerEnd || -1) * (bayW * 0.5 + sides.loadingWidth / 2 + 0.6);
  sides.staffX = sides.loadingX - Math.sign(towerEnd || -1) * (sides.loadingWidth / 2 + 2.0);
  const entrance = { canopyDepth: draw(o, 1.6, 2.6), posts: o.chance(0.5) };
  return { massing, front, shade, canopy, plant, sides, entrance, palette: r.fork('palette').int(0, PALETTES.length - 1) };
}

export function build(p) {
  const b = new ModelBuilder();
  const { bays, bayW, depth: D, height: H, parapet } = p.massing;
  const W = bays * bayW, deck = H - parapet, pal = PALETTES[p.palette];
  const xL = p.massing.left, xR = xL + W;
  const { riser, head, pier: pw } = p.front;
  b.material('wall', pal.wall[0], pal.wall[1], { roughness: 0.9 });
  b.material('base', pal.base[0], pal.base[1], { roughness: 0.9 });
  b.material('pier', pal.pier, pal.wall[1], { roughness: 0.9 });
  b.material('coping', '#9a978f', 'stone', { roughness: 0.8 });
  b.material('frame', pal.frame, 'frame', { roughness: 0.4, metalness: 0.5 });
  b.material('glass', '#33464f', 'glass', { roughness: 0.05 });
  b.material('sign', pal.sign, 'sign', { roughness: 0.5 });
  b.material('awning', pal.awning, 'wood', { roughness: 0.9 });
  b.material('steel', '#3d4145', 'metal', { roughness: 0.4, metalness: 0.7 });
  b.material('roof', '#5d5f60', 'roof', { roughness: 0.9 });
  b.material('plant', pal.plant, 'metal', { roughness: 0.5, metalness: 0.4 });
  b.material('door', '#4a4f55', 'metal', { roughness: 0.5, metalness: 0.4 });
  b.material('concrete', '#a8a59d', 'concrete', { roughness: 0.9 });
  b.material('bollard', '#d6b11f', 'metal', { roughness: 0.5, metalness: 0.2 });

  b.group('body', 'Walls, parapet and coping', 'massing', 0.3, 'all');
  b.group('base', 'Masonry base band', 'ornament', 0.05, 'front');
  b.group('piers', 'Front piers', 'ornament', 0.15, 'front');
  b.group('storefront', 'Storefront glazing and mullions', 'openings', 0.08, 'front');
  b.group('entrance.tower', 'Raised entrance tower', 'massing', 0.25, 'front');
  b.group('entrance', 'Entrance doors and canopy', 'entrance', 0.1, 'front');
  b.group('signs', 'Blank sign band and sign box', 'attachments', 0.2, 'front');
  b.group('roof.plant', 'Rooftop plant units', 'attachments', 0.3, 'roof');
  b.group('rear.service', 'Loading bay and rear doors', 'openings', 0.12, 'rear');
  const serviceName = p.sides.serviceSide < 0 ? 'left' : 'right';
  b.group('side.openings', 'Service door and high windows in the ' + serviceName + ' wall', 'openings', 0.08, serviceName);

  const bayX = i => xL + bayW * i;                     // left edge of bay i
  // Part ids use absolute bay numbers, so an earlier state without the first bay keeps them.
  const bayNo = i => i + (p.massing.bay0 ?? 0);
  const tb = p.front.towerBay, wide = p.front.towerWide;
  const tx0 = bayX(tb) + pw / 2 + 0.25, tx1 = bayX(tb + (wide ? 2 : 1)) - pw / 2 - 0.25;
  const towerBays = wide ? [tb, tb + 1] : [tb];
  const glazedBays = [...Array(bays).keys()].filter(i => !towerBays.includes(i) && !(p.front.blankX !== null && Math.abs(bayX(i) + bayW / 2 - p.front.blankX) < 0.01));

  // ---- main walls -----------------------------------------------------------
  const wfF = wallFrame('z', 1, 0), wfB = wallFrame('z', -1, -D), wfL = wallFrame('x', -1, xL), wfR = wallFrame('x', 1, xR);
  // Each glazed bay is one shop unit: a glazed door at one side, the window beside it.
  const shopDoors = [], shopfronts = [], shopBay = [];
  for (const i of glazedBays) {
    shopBay.push(bayNo(i));
    const a = bayX(i) + pw / 2 + 0.2, c = bayX(i + 1) - pw / 2 - 0.2, doorLeft = bayNo(i) % 2 === 0;
    const d0 = doorLeft ? a : c - 1.15, d1 = doorLeft ? a + 1.15 : c;
    shopDoors.push(opening({ u0: d0, u1: d1, y0: 0, y1: head }));
    shopfronts.push(opening({ u0: doorLeft ? d1 + 0.35 : a, u1: doorLeft ? c : d0 - 0.35, y0: riser, y1: head }));
  }
  // Inside the entrance tower the front wall stops at deck level (its cut edges are
  // buried in the tower's side walls), so the tower roof may sit below the parapet top.
  wall(b, wfF, { id: 'wall-front', group: 'body', material: 'wall', u0: xL + T, u1: xR - T, y0: 0, thickness: T, openings: [...shopfronts, ...shopDoors],
    top: [[xR - T, H], [tx1 - 0.15, H], [tx1 - 0.15, deck], [tx0 + 0.15, deck], [tx0 + 0.15, H], [xL + T, H]] });
  // Rear: loading door and a personnel door, placed away from the service side.
  const loadW = p.sides.loadingWidth, loadH = Math.min(4.2, deck - 0.9), loadX = p.sides.loadingX;
  const loading = opening({ u0: loadX - loadW / 2, u1: loadX + loadW / 2, y0: 0, y1: loadH });
  const staff = opening({ u0: p.sides.staffX - 0.5, u1: p.sides.staffX + 0.5, y0: 0.15, y1: 2.25 });
  wall(b, wfB, { id: 'wall-rear', group: 'body', material: 'wall', u0: xL + T, u1: xR - T, y0: 0, y1: H, thickness: T, openings: [loading, staff] });
  // Service side: a door and high windows; the other side is blank.
  const sideWf = p.sides.serviceSide < 0 ? wfL : wfR;
  const serviceDoor = opening({ u0: D * 0.62, u1: D * 0.62 + 1.0, y0: 0.15, y1: 2.25 });
  const high = [...Array(p.sides.highWindows).keys()].map(k => {
    const u = D * (0.15 + 0.5 * k / Math.max(1, p.sides.highWindows - 1)) * (p.sides.highWindows > 1 ? 1 : 1);
    return opening({ u0: u - 0.6, u1: u + 0.6, y0: deck - 1.6, y1: deck - 0.7 });
  }).filter(o => o.u1 < serviceDoor.u0 - 0.6 || o.u0 > serviceDoor.u1 + 0.6);
  for (const [name, wf] of [['left', wfL], ['right', wfR]]) {
    wall(b, wf, { id: 'wall-' + name, group: 'body', material: 'wall', u0: 0, u1: D, y0: 0, y1: H, thickness: T, openings: wf === sideWf ? [serviceDoor, ...high] : [] });
  }
  // Roof deck inside the parapets, embedded 10 cm into the walls.
  b.box('roof-deck', 'body', 'roof', [xL + 0.2, deck - 0.3, -D + 0.2], [xR - 0.2, deck, -0.2]);
  // Coping: front and rear pieces wrap the corners, side pieces stop at them.
  b.box('coping-front-left', 'body', 'coping', [xL - 0.05, H - 0.04, -T - 0.05], [tx0 + 0.15, H + 0.1, 0.05]);
  b.box('coping-front-right', 'body', 'coping', [tx1 - 0.15, H - 0.04, -T - 0.05], [xR + 0.05, H + 0.1, 0.05]);
  b.box('coping-rear', 'body', 'coping', [xL - 0.05, H - 0.04, -D - 0.05], [xR + 0.05, H + 0.1, -D + T + 0.05]);
  b.box('coping-left', 'body', 'coping', [xL - 0.05, H - 0.04, -D + T + 0.05], [xL + T + 0.05, H + 0.1, -T - 0.05]);
  b.box('coping-right', 'body', 'coping', [xR - T - 0.05, H - 0.04, -D + T + 0.05], [xR + 0.05, H + 0.1, -T - 0.05]);

  // ---- base band and piers ------------------------------------------------------
  const baseTop = riser - 0.06;
  band(b, wfF, { id: 'base-front', group: 'base', material: 'base', u0: xL - 0.03, u1: xR + 0.03, y0: 0, y1: baseTop,
    gaps: [[tx0 - 0.02, tx1 + 0.02], ...shopDoors.map(o => [o.u0 - 0.05, o.u1 + 0.05])] });
  band(b, wfL, { id: 'base-left', group: 'base', material: 'base', u0: 0.02, u1: D - 0.02, y0: 0, y1: baseTop,
    gaps: sideWf === wfL ? [[serviceDoor.u0 - 0.05, serviceDoor.u1 + 0.05]] : [] });
  band(b, wfR, { id: 'base-right', group: 'base', material: 'base', u0: 0.02, u1: D - 0.02, y0: 0, y1: baseTop,
    gaps: sideWf === wfR ? [[serviceDoor.u0 - 0.05, serviceDoor.u1 + 0.05]] : [] });
  for (let i = 0; i <= bays; i++) {
    const x = bayX(i);
    if (i > 0 && i < bays && towerBays.includes(i - 1) && towerBays.includes(i)) continue;   // inside a wide tower
    const x0 = i === 0 ? xL - 0.15 : x - pw / 2, x1 = i === bays ? xR + 0.15 : x + pw / 2;
    b.box('pier-' + bayNo(i), 'piers', 'pier', [x0, 0, -0.02], [x1, H + 0.16, 0.15]);
  }

  // ---- storefronts ---------------------------------------------------------------
  shopDoors.forEach((o, k) => doorOpening(b, wfF, o, { id: 'shop-door-' + shopBay[k], group: 'storefront', frame: 'frame', leaf: 'frame', glass: 'glass', metal: 'steel',
    style: 'full-glass', fanlight: Math.max(0.3, head - 2.35), recess: 0.15, frameWidth: 0.09, frameDepth: 0.12, handleSide: shopBay[k] % 2 ? -1 : 1 }));
  shopfronts.forEach((o, k) => {
    const span = o.u1 - o.u0;
    glazedOpening(b, wfF, o, { id: 'shopfront-' + shopBay[k], group: 'storefront', frame: 'frame', glass: 'glass', sill: 'coping',
      recess: 0.15, frameWidth: 0.09, frameDepth: 0.12, mullions: Math.max(1, Math.round(span / 1.5) - 1), transoms: [Math.min(2.55, head - 0.55)], sillDepth: 0.06 });
  });

  // ---- entrance tower --------------------------------------------------------------
  const tp = p.front.towerProj, tback = -p.front.towerBack, Ht = H + p.front.towerRise, tt = 0.3;
  const wfTF = wallFrame('z', 1, tp), wfTB = wallFrame('z', -1, tback), wfTL = wallFrame('x', -1, tx0), wfTR = wallFrame('x', 1, tx1);
  const tcx = (tx0 + tx1) / 2, dW = Math.min(p.front.doorW, tx1 - tx0 - 1.2);
  const doors = opening({ u0: tcx - dW / 2, u1: tcx + dW / 2, y0: 0, y1: p.front.doorH + 0.6 });
  // Side lights flank the doors where the tower is wide enough.
  const lights = [[tx0 + tt + 0.25, doors.u0 - 0.35], [doors.u1 + 0.35, tx1 - tt - 0.25]]
    .filter(([u0, u1]) => u1 - u0 > 0.4).map(([u0, u1]) => opening({ u0, u1, y0: riser, y1: doors.top }));
  wall(b, wfTF, { id: 'tower-front', group: 'entrance.tower', material: 'pier', u0: tx0 + tt, u1: tx1 - tt, y0: 0, y1: Ht, thickness: tt, openings: [doors, ...lights] });
  wall(b, wfTB, { id: 'tower-back', group: 'entrance.tower', material: 'pier', u0: tx0 + tt, u1: tx1 - tt, y0: deck - 0.4, y1: Ht, thickness: tt });
  for (const [name, wf] of [['left', wfTL], ['right', wfTR]]) {
    wall(b, wf, { id: 'tower-' + name, group: 'entrance.tower', material: 'pier', u0: -tp, u1: -tback, y0: 0, y1: Ht, thickness: tt });
  }
  b.box('tower-roof', 'entrance.tower', 'roof', [tx0 + 0.15, Ht - 0.75, tback + 0.15], [tx1 - 0.15, Ht - 0.45, tp - 0.15]);
  b.box('tower-coping-front', 'entrance.tower', 'coping', [tx0 - 0.05, Ht - 0.04, tp - tt - 0.05], [tx1 + 0.05, Ht + 0.12, tp + 0.05]);
  b.box('tower-coping-back', 'entrance.tower', 'coping', [tx0 - 0.05, Ht - 0.04, tback - 0.05], [tx1 + 0.05, Ht + 0.12, tback + tt + 0.05]);
  b.box('tower-coping-left', 'entrance.tower', 'coping', [tx0 - 0.05, Ht - 0.04, tback + tt + 0.05], [tx0 + tt + 0.05, Ht + 0.12, tp - tt - 0.05]);
  b.box('tower-coping-right', 'entrance.tower', 'coping', [tx1 - tt - 0.05, Ht - 0.04, tback + tt + 0.05], [tx1 + 0.05, Ht + 0.12, tp - tt - 0.05]);
  doorOpening(b, wfTF, doors, { id: 'entrance-doors', group: 'entrance', frame: 'frame', leaf: 'frame', glass: 'glass', metal: 'steel',
    style: 'full-glass', leaves: 2, fanlight: 0.55, recess: 0.12, frameWidth: 0.09, frameDepth: 0.12 });
  lights.forEach((o, k) => glazedOpening(b, wfTF, o, { id: 'entrance-light-' + (k + 1), group: 'entrance', frame: 'frame', glass: 'glass', recess: 0.12,
    frameWidth: 0.08, frameDepth: 0.12, mullions: 0, transoms: [p.front.doorH] }));
  // Blank sign box on the tower face.
  const signLow = Math.max(doors.top + 0.5, H - 0.3);
  // A tower that barely rises above the parapet has no room for a sign box.
  if (Ht - 0.55 - signLow >= 0.6) wfTF.box(b, 'tower-sign', 'signs', 'sign', tx0 + 0.45, tx1 - 0.45, signLow, Ht - 0.55, -0.22, 0.02);
  // Entrance canopy, wider than the tower, on posts or hung from tie rods.
  const cy = doors.top + 0.35, cd = p.entrance.canopyDepth, cx0 = tx0 - 0.6, cx1 = tx1 + 0.6;
  b.box('entrance-canopy', 'entrance', 'steel', [cx0, cy, tp - 0.03], [cx1, cy + 0.25, tp + cd]);
  if (p.entrance.posts) {
    for (const [k, x] of [[1, cx0 + 0.3], [2, cx1 - 0.3]]) b.beam('entrance-post-' + k, 'entrance', 'steel', [x, 0, tp + cd - 0.3], [x, cy + 0.02, tp + cd - 0.3], 0.1, 16);
  } else {
    for (const [k, x] of [[1, cx0 + 0.5], [2, tx0 + 0.25], [3, tx1 - 0.25], [4, cx1 - 0.5]]) {
      const anchorX = Math.min(Math.max(x, tx0 + 0.2), tx1 - 0.2);
      b.beam('entrance-rod-' + k, 'entrance', 'steel', [x, cy + 0.2, tp + cd - 0.15], [anchorX, cy + 1.7, tp - 0.01], 0.03, 8);
    }
  }

  // ---- awnings / canopy over the storefronts -------------------------------------------
  let shadeKind = p.shade;
  if (shadeKind === 'awnings') {
    b.group('shading', 'Storefront awnings and braces', 'attachments', 0.08, 'front');
    const ad = p.canopy.awningDepth, a = 24 * DEG, yTop = head + 0.5, yFront = yTop - ad * Math.tan(a);
    shopfronts.forEach((o, k) => {
      const id = 'awning-' + shopBay[k], u0 = o.u0 - 0.1, u1 = o.u1 + 0.1;
      wfF.sideProfile(b, id, 'shading', 'awning', [[0.03, yTop + 0.03], [0.03, yTop - 0.04], [-ad, yFront - 0.04], [-ad, yFront + 0.03]], u0, u1);
      wfF.box(b, id + '-valance', 'shading', 'awning', u0, u1, yFront - 0.28, yFront + 0.01, -ad - 0.02, -ad + 0.04);
      for (const [j, u] of [[1, u0 + 0.25], [2, u1 - 0.25]]) {
        const s = wfF.toModel(u, yTop - 0.75, 0.02), e = wfF.toModel(u, yFront - 0.06, -ad + 0.1);
        b.beam(id + '-brace-' + j, 'shading', 'steel', s, e, 0.02, 8);
      }
    });
  } else if (shadeKind === 'canopy' || shadeKind === 'canopy-posts') {
    b.group('shading', 'Storefront canopy', 'attachments', 0.1, 'front');
    const cdep = p.canopy.depth, y0 = head + 0.3;
    // Continuous canopy on the side of the tower chosen when generated.
    const run = glazedBays.filter(i => p.front.signSide < 0 ? i < tb : i > tb + (wide ? 1 : 0));
    if (run.length) {
      const x0 = bayX(Math.min(...run)) + 0.15, x1 = bayX(Math.max(...run) + 1) - 0.15;
      b.box('canopy', 'shading', 'steel', [x0, y0, 0.12], [x1, y0 + 0.2, cdep]);
      const n = run.length;
      for (let k = 0; k <= n; k++) {
        const x = x0 + 0.25 + k * (x1 - x0 - 0.5) / n;
        if (shadeKind === 'canopy-posts') b.beam('canopy-post-' + (k + 1), 'shading', 'steel', [x, 0, cdep - 0.25], [x, y0 + 0.02, cdep - 0.25], 0.08, 16);
        else b.beam('canopy-rod-' + (k + 1), 'shading', 'steel', [x, y0 + 0.16, cdep - 0.12], [x, y0 + 1.5, 0.16], 0.025, 8);
      }
    } else shadeKind = 'none';
  }

  // ---- sign band ---------------------------------------------------------------------------
  {
    const run = glazedBays.filter(i => p.front.signSide < 0 ? i < tb : i > tb + (wide ? 1 : 0));
    if (run.length) {
      const x0 = bayX(Math.min(...run)) + pw / 2 + 0.1, x1 = bayX(Math.max(...run) + 1) - pw / 2 - 0.1;
      const y0 = Math.max(head + 0.75, deck - 1.0), y1 = Math.min(H - 0.3, y0 + 1.1);
      wfF.box(b, 'sign-band', 'signs', 'sign', x0, x1, y0, y1, -0.26, 0.02);
    }
  }

  // ---- side and rear openings ----------------------------------------------------------------
  doorOpening(b, sideWf, serviceDoor, { id: 'service-door', group: 'side.openings', frame: 'steel', leaf: 'door', glass: 'glass', metal: 'steel', style: 'boarded' });
  high.forEach((o, k) => glazedOpening(b, sideWf, o, { id: 'high-window-' + (k + 1), group: 'side.openings', frame: 'frame', glass: 'glass', recess: 0.1, mullions: 1 }));
  // Roller shutter: frame, ribbed curtain and the coil box above.
  {
    const o = loading, w0 = 0.12;
    wfB.extrude(b, 'loading-frame', 'rear.service', 'steel', [[o.u0, 0], [o.u0 + 0.12, 0], [o.u0 + 0.12, o.top - 0.12], [o.u1 - 0.12, o.top - 0.12], [o.u1 - 0.12, 0], [o.u1, 0], [o.u1, o.top], [o.u0, o.top]], w0, w0 + 0.12);
    wfB.box(b, 'loading-shutter', 'rear.service', 'door', o.u0 + 0.1, o.u1 - 0.1, 0, o.top - 0.1, w0 + 0.05, w0 + 0.09);
    const ribs = Math.floor((o.top - 0.2) / 0.45);
    for (let k = 1; k <= ribs; k++) wfB.box(b, 'loading-rib-' + k, 'rear.service', 'door', o.u0 + 0.14, o.u1 - 0.14, k * 0.45 - 0.03, k * 0.45 + 0.03, w0 + 0.025, w0 + 0.065);
    wfB.box(b, 'loading-coil-box', 'rear.service', 'steel', o.u0 - 0.1, o.u1 + 0.1, o.top + 0.05, o.top + 0.55, -0.45, 0.02);
    if (p.sides.dockCanopy) {
      b.group('rear.dock', 'Loading dock canopy', 'attachments', 0.1, 'rear');
      const y = o.top + 0.75;
      wfB.box(b, 'dock-canopy', 'rear.dock', 'steel', o.u0 - 0.6, o.u1 + 0.6, y, y + 0.18, -2.2, 0.03);
      for (const [k, u] of [[1, o.u0 - 0.4], [2, o.u1 + 0.4]]) b.beam('dock-rod-' + k, 'rear.dock', 'steel', wfB.toModel(u, y + 0.14, -2.05), wfB.toModel(u, y + 1.2, 0.0), 0.025, 8);
    }
    for (const [k, u] of [[1, o.u0 - 0.35], [2, o.u1 + 0.35]]) {
      const base = wfB.toModel(u, 0, -0.5);
      b.cylinder('bollard-' + k, 'rear.service', 'bollard', base, 1.1, 0.11, { segments: 16 });
    }
  }
  // Rainwater from the flat roof: hoppers through the rear parapet and downpipes.
  for (const [k, u] of [[1, xL + 0.7], [2, xR - 0.7]]) {
    wfB.box(b, 'hopper-' + k, 'rear.service', 'steel', u - 0.16, u + 0.16, deck - 0.45, deck + 0.05, -0.32, 0.02);
    b.beam('downpipe-' + k, 'rear.service', 'steel', wfB.toModel(u, deck - 0.43, -0.16), wfB.toModel(u, 0.05, -0.16), 0.06, 16);
  }
  doorOpening(b, wfB, staff, { id: 'staff-door', group: 'rear.service', frame: 'steel', leaf: 'door', glass: 'glass', metal: 'steel', style: 'boarded' });

  // ---- rooftop plant -----------------------------------------------------------------------------
  // Units in the rear half, kept 1.2 m inside the parapets and clear of each other and the tower.
  const placed = [];
  p.plant.forEach((unit, k) => {
    const { x, z } = unit;
    // Units that would overhang the parapet (in a shorter earlier state), clash with an
    // earlier unit or crowd the tower are left out.
    if (x - unit.w / 2 < xL + 1.2 || x + unit.w / 2 > xR - 1.2) return;
    if (placed.some(q => Math.abs(q.x - x) < (q.w + unit.w) / 2 + 0.8 && Math.abs(q.z - z) < (q.d + unit.d) / 2 + 0.8)) return;
    if (x + unit.w / 2 > tx0 - 0.8 && x - unit.w / 2 < tx1 + 0.8 && z + unit.d / 2 > tback - 0.8) return;
    placed.push({ x, z, w: unit.w, d: unit.d });
    const id = 'plant-' + (k + 1);
    b.box(id, 'roof.plant', 'plant', [x - unit.w / 2, deck - 0.02, z - unit.d / 2], [x + unit.w / 2, deck + unit.h, z + unit.d / 2]);
    for (let f = 0; f < unit.fans; f++) {
      const fx = x + (unit.fans === 1 ? 0 : (f - 0.5) * unit.w / 2), r = Math.min(0.42, unit.d / 2 - 0.12, unit.w / (2 * unit.fans) - 0.1);
      b.cylinder(id + '-fan-' + (f + 1), 'roof.plant', 'steel', [fx, deck + unit.h - 0.02, z], 0.22, r, { segments: 20 });
    }
  });

  // Roof access hatch near the rear corner on the tower side.
  {
    const hx = p.sides.loadingX, hz = -D + 2.0;
    b.box('roof-hatch', 'roof.plant', 'plant', [hx - 0.55, deck - 0.02, hz - 0.55], [hx + 0.55, deck + 0.45, hz + 0.55]);
    b.box('roof-hatch-lid', 'roof.plant', 'steel', [hx - 0.62, deck + 0.43, hz - 0.62], [hx + 0.62, deck + 0.52, hz + 0.62]);
  }

  // ---- probes ------------------------------------------------------------------------------------
  const cx = (i) => bayX(i) + bayW / 2;
  const xm = (xL + xR) / 2;
  const deckProbeSpots = [[xm, -D * 0.25], [xm + W / 4, -D * 0.3], [xm - W / 4, -D * 0.3], [xm, -D * 0.4], [xm + W / 3, -D * 0.2], [xm - W / 3, -D * 0.2]];
  for (const [x, z] of deckProbeSpots) b.probe('roof-deck', 'Height of the main roof deck', [x, 40, z], [0, -1, 0]);
  for (const [x, z] of [[tcx, (tback + tp) / 2], [tcx + 0.3, (tback + tp) / 2 - 0.3]]) b.probe('tower-roof', 'Height of the entrance tower roof', [x, 40, z], [0, -1, 0]);
  const farSide = tb < bays / 2 ? 1 : -1;   // the end away from the tower: where bays were added
  for (const [name, s] of [[farSide > 0 ? 'right-wall' : 'left-wall', farSide], [farSide > 0 ? 'left-wall' : 'right-wall', -farSide]]) {
    for (const [y, u] of [[1.6, D * 0.4], [2.6, D * 0.3], [3.4, D * 0.5]]) b.probe(name, 'Position of the ' + name.split('-')[0] + ' side wall', [s * 60, y, -u], [-s, 0, 0]);
  }
  for (const [x, y] of [[tcx, deck - 1.4], [xm + W / 4, 2.0], [xm - W / 4, 2.0], [xm + W / 3, 1.5]]) b.probe('rear-wall', 'Position of the rear wall', [x, y, -60], [0, 0, 1]);
  for (const i of glazedBays) b.probe('front-parapet', 'Position of the front parapet wall', [cx(i), (H + Math.max(head + 0.75, deck - 1.0) + 1.1) / 2 + 0.3, 40], [0, 0, -1]);
  for (const i of glazedBays) b.probe('front-parapet', 'Position of the front parapet wall', [cx(i), H - 0.45, 40], [0, 0, -1]);
  b.probe('tower-sign', 'Position of the sign box on the entrance tower', [tcx, (signLow + Ht - 0.55) / 2, 40], [0, 0, -1]);
  b.probe('tower-side', 'Position of the entrance tower side', [-farSide * 60, H + p.front.towerRise / 2, (tback + tp) / 2], [farSide, 0, 0]);
  if (placed.length) b.probe('plant-top', 'Height of the largest rooftop unit', [placed[0].x - placed[0].w / 4, 40, placed[0].z - placed[0].d / 4], [0, -1, 0]);

  // ---- dimensions --------------------------------------------------------------------------------
  b.dimension('overall-width', 'Overall width of the front wall', [xL, 0, 0], [xR, 0, 0], 'front');
  b.dimension('overall-depth', 'Overall depth', [xR, 0, 0], [xR, 0, -D], 'plan');
  b.dimension('parapet-height', 'Height to the top of the parapet coping', [xL, 0, 0], [xL, H + 0.1, 0], 'front');
  b.dimension('tower-height', 'Height to the top of the entrance tower coping', [tcx, 0, 0], [tcx, Ht + 0.12, 0], 'front');
  b.dimension('tower-width', 'Width of the entrance tower', [tx0, 0, tp], [tx1, 0, tp], 'front');
  b.dimension('tower-projection', 'Projection of the entrance tower in front of the facade', [tx1, 0, 0], [tx1, 0, tp], 'plan');
  b.dimension('bay-width', 'Structural bay width (pier centre to pier centre)', [bayX(1), 0, 0.15], [bayX(2), 0, 0.15], 'front');
  if (shopfronts[0]) b.dimension('shopfront-width', 'Width of a storefront opening', [shopfronts[0].u0, riser, 0], [shopfronts[0].u1, riser, 0], 'front');
  if (shopfronts[0]) b.dimension('riser-height', 'Height of the storefront sill above ground', [shopfronts[0].u0, 0, 0], [shopfronts[0].u0, riser, 0], 'front');
  b.dimension('side-height', 'Parapet height on the right side', [xR, 0, -D / 2], [xR, H + 0.1, -D / 2], 'right');
  b.dimension('entrance-canopy-depth', 'Projection of the entrance canopy', [cx1, cy, tp], [cx1, cy, tp + cd], 'plan');

  return {
    builder: b,
    title: 'Single-storey retail building',
    frame: {
      origin: 'On the ground at the midpoint of the main storefront wall; that wall face is the plane z = 0, the building extends towards -Z and the entrance tower projects towards +Z.',
      front: 'The storefront facade, with the main entrance, faces +Z; +X is to the right when you look at the front.',
    },
    scope_note: 'The building exterior only: walls, parapets, storefront glazing, entrance tower, canopies and awnings, blank sign boxes, rooftop plant, ' +
      'the rear loading bay with its bollards. No ground plane, car park, kerbs, trolleys, lettering or neighbouring buildings.',
    structure: { bays, towerBay: tb, towerWide: wide, glazed: glazedBays.length, shade: shadeKind, plant: placed.length, dockCanopy: p.sides.dockCanopy,
      entrancePosts: p.entrance.posts },
  };
}

export const edits = [
  {
    id: 'fewer-bays', applies: p => p.massing.bays > 4,
    // The far end wall moves in and everything spanning the front shortens.
    scope: ['body', 'base', 'piers', 'storefront', 'signs', 'shading', 'rear.service', 'side.openings', 'roof.plant', 'rear.dock'],
    apply: p => {
      // The building was extended by one bay at the end away from the entrance tower.
      const q = structuredClone(p), atRight = p.front.towerBay < p.massing.bays / 2;
      q.massing.bays -= 1;
      if (!atRight) { q.front.towerBay -= 1; q.massing.left += p.massing.bayW; q.massing.bay0 += 1; }
      return q;
    },
    phrase: 'the building was one structural bay shorter',
  },
  {
    id: 'lower-tower', scope: ['entrance.tower', 'signs'], applies: () => true,
    apply: p => ({ ...p, front: { ...p.front, towerRise: 0.3 } }),
    phrase: 'the entrance tower rose only a little above the parapet',
  },
  { id: 'no-shading', scope: ['shading'], applies: (p, s) => s.shade !== 'none', apply: p => ({ ...p, shade: 'none' }), phrase: 'the storefronts had no awnings or canopy' },
  { id: 'less-plant', scope: ['roof.plant'], applies: (p, s) => s.plant > 1, apply: p => ({ ...p, plant: p.plant.slice(0, 1) }), phrase: 'there was only one rooftop plant unit' },
];

export default { id: 'retail', sample, build, edits };
