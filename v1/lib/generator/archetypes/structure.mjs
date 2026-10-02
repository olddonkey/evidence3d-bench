// Non-building engineering structures, three sub-types:
//   water-tower   elevated tank on battered legs with strut-and-rod bracing, balcony
//                 with railing, ladders, riser pipe, footings and a valve house
//   guide-frame   gasholder guide frame: columns on a circle, polygonal ring girders,
//                 X bracing, the bell inside, a base tank wall, a stair tower and a
//                 governor house
//   dish          dish antenna on a pedestal: turntable, yoke, elevation axle, a
//                 paraboloid dish with backing ribs, quadripod and subreflector,
//                 counterweight, platform with railing, ladder and an equipment hut
// Lathe profiles run outward along the bottom, up, then inward along the top, which
// is the winding three.js turns into outward-facing normals.
import { ModelBuilder, wallFrame, wall, opening, glazedOpening, doorOpening, gableRoofX, railing, ladder, draw, DEG, TAU } from '../kit.mjs';

export const SUBTYPES = ['water-tower', 'guide-frame', 'dish'];

export function sample(r) {
  const kind = r.fork('kind').pick(SUBTYPES);
  const m = r.fork(kind);
  const palette = r.fork('palette').int(0, 2);
  if (kind === 'water-tower') {
    const legs = m.pick([4, 4, 6]), panel = draw(m, 4.0, 5.5), panels = m.int(3, 5);
    const legR = draw(m, 3.2, 5.0), tankR = draw(m, Math.max(3.6, legR * 0.9 + 0.6), 6.5);
    return { kind, palette, legs, legR, batter: draw(m, 0.78, 0.92, 0.01), panel, panels, tankR, shell: draw(m, 5.0, 8.0), bottom: m.pick(['cone', 'dome']),
      roofPitch: draw(m, 18, 28, 1), balcony: draw(m, 1.0, 1.3), house: { side: m.pick([-1, 1]), w: draw(m, 3.0, 4.2), d: draw(m, 3.0, 3.8), h: draw(m, 2.6, 3.2) },
      overflowLeg: m.int(1, legs - 1) };
  }
  if (kind === 'guide-frame') {
    const tiers = m.int(2, 4), tier = draw(m, 6.0, 8.5);
    return { kind, palette, R: draw(m, 12, 20), columns: m.pick([8, 10, 12]), tiers, tier, bell: draw(m, 0.35, 0.85, 0.05), tank: draw(m, 1.6, 3.0),
      stair: { angle: m.pick([0.5, 1.5, 2.5, 3.5]) * Math.PI / 6 * (m.chance(0.5) ? 1 : -1) }, house: { side: m.pick([-1, 1]), w: draw(m, 4.0, 6.0), d: draw(m, 3.5, 4.5) } };
  }
  return { kind, palette, diameter: draw(m, 10, 20), fd: draw(m, 0.36, 0.45, 0.01), pedestal: draw(m, 4.5, 8.0), pedestalR: draw(m, 2.2, 3.2),
    az: draw(m, 25, 70, 1) * (m.chance(0.5) ? 1 : -1), el: draw(m, 22, 55, 1), hut: { side: m.pick([-1, 1]), w: draw(m, 4.0, 6.0), d: draw(m, 3.0, 4.0) } };
}

const PALETTES = [
  { steel: '#6d7f86', tank: '#c9d0cf', concrete: '#a9a69e', roof: '#5a5e61', wall: '#b07d5f' },
  { steel: '#3f5a46', tank: '#7d9381', concrete: '#9d998f', roof: '#4c5052', wall: '#c9b8a0' },
  { steel: '#8a5a44', tank: '#d8d5cc', concrete: '#b3b0a7', roof: '#3f4245', wall: '#9c6b52' },
];

function materials(b, pal) {
  b.material('steel', pal.steel, 'metal', { roughness: 0.5, metalness: 0.6 });
  b.material('tank', pal.tank, 'metal', { roughness: 0.45, metalness: 0.5 });
  b.material('concrete', pal.concrete, 'concrete', { roughness: 0.9 });
  b.material('roof', pal.roof, 'roof', { roughness: 0.8 });
  b.material('wall', pal.wall, 'wall', { roughness: 0.9 });
  b.material('frame', '#e8e6e0', 'frame', { roughness: 0.5 });
  b.material('glass', '#34474f', 'glass', { roughness: 0.1 });
  b.material('door', '#4b5155', 'metal', { roughness: 0.5, metalness: 0.4 });
  b.material('rail', '#d9b318', 'metal', { roughness: 0.5, metalness: 0.4 });
}

// Small gable-roofed service building (valve house, governor house, equipment hut)
// with its door facing +Z. Returns its footprint.
function serviceHouse(b, { id, group, x0, x1, z0, z1, h, door = true, window = true, doorX = null }) {
  const t = 0.25, wfF = wallFrame('z', 1, z1), wfB = wallFrame('z', -1, z0), wfL = wallFrame('x', -1, x0), wfR = wallFrame('x', 1, x1);
  const w = x1 - x0, cx = (x0 + x1) / 2, pitch = 30 * DEG;
  const dc = doorX ?? cx - w * 0.15, d = opening({ u0: dc - 0.5, u1: dc + 0.5, y0: 0, y1: 2.1 });
  wall(b, wfF, { id: id + '-front', group, material: 'wall', u0: x0 + t, u1: x1 - t, y0: 0, y1: h + 0.05, thickness: t, openings: door ? [d] : [] });
  wall(b, wfB, { id: id + '-rear', group, material: 'wall', u0: x0 + t, u1: x1 - t, y0: 0, y1: h + 0.05, thickness: t });
  const D = z1 - z0, gable = [[-z0, h + 0.05], [-(z0 + z1) / 2, h + D / 2 * Math.tan(pitch) + 0.05], [-z1, h + 0.05]];
  const win = opening({ u0: -z1 + D * 0.35, u1: -z1 + D * 0.35 + 0.9, y0: 1.2, y1: 2.0 });
  wall(b, wfL, { id: id + '-left', group, material: 'wall', u0: -z1, u1: -z0, y0: 0, top: gable, thickness: t, openings: window ? [win] : [] });
  wall(b, wfR, { id: id + '-right', group, material: 'wall', u0: -z1, u1: -z0, y0: 0, top: gable, thickness: t });
  if (door) doorOpening(b, wfF, d, { id: id + '-door', group, frame: 'frame', leaf: 'door', glass: 'glass', metal: 'steel', style: 'boarded' });
  if (window) glazedOpening(b, wfL, win, { id: id + '-window', group, frame: 'frame', glass: 'glass', mullions: 0 });
  // Ridge along X: gables face left and right.
  const info = gableRoofX(b, { id: id + '-roof', group, material: 'roof', x0: x0 - 0.2, x1: x1 + 0.2, zRidge: (z0 + z1) / 2, halfDepth: D / 2, plate: h, pitch, overhang: 0.25, thickness: 0.15 });
  return { ridgeTop: info.ridgeTop, under: info.under };
}

function waterTower(b, p) {
  b.group('legs', 'Legs and footings', 'structure', 0.3, 'all');
  b.group('bracing', 'Struts and diagonal rods', 'structure', 0.1, 'all');
  b.group('tank', 'Tank shell, bottom and roof', 'massing', 0.3, 'all');
  b.group('balcony', 'Balcony and railing', 'attachments', 0.08, 'all');
  b.group('ladders', 'Ladders', 'attachments', 0.05, 'front');
  b.group('riser', 'Riser pipe, overflow and footing', 'structure', 0.2, 'all');
  b.group('valve.house', 'Valve house', 'massing', 0.2, p.house.side < 0 ? 'left' : 'right');
  const n = p.legs, a0 = n === 4 ? Math.PI / 4 : Math.PI / 6, footY = 0.8;
  const Hb = footY + p.panel * p.panels, Rt = p.tankR, Ht = p.shell, Rtop = p.legR * p.batter;
  const legAt = (k, y) => {
    const a = a0 + k * TAU / n, t = (y - footY) / (Hb - footY), rr = p.legR + (Rtop - p.legR) * t;
    return [rr * Math.cos(a), y, rr * Math.sin(a)];
  };
  // Legs land on the ring girder just under the tank bottom.
  for (let k = 0; k < n; k++) {
    const base = legAt(k, footY);
    b.box('footing-' + (k + 1), 'legs', 'concrete', [base[0] - 0.65, 0, base[2] - 0.65], [base[0] + 0.65, footY + 0.02, base[2] + 0.65]);
    b.beam('leg-' + (k + 1), 'legs', 'steel', [base[0], footY - 0.05, base[2]], legAt(k, Hb + 0.15), 0.28, 16);
  }
  for (let level = 1; level <= p.panels; level++) {
    const y = footY + level * p.panel, yPrev = y - p.panel;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      if (level < p.panels) b.beam('strut-' + level + '-' + (k + 1), 'bracing', 'steel', legAt(k, y), legAt(j, y), 0.12, 10);
      b.beam('rod-' + level + '-' + (k + 1) + 'a', 'bracing', 'steel', legAt(k, yPrev + 0.25), legAt(j, y - 0.25), 0.035, 8);
      b.beam('rod-' + level + '-' + (k + 1) + 'b', 'bracing', 'steel', legAt(j, yPrev + 0.25), legAt(k, y - 0.25), 0.035, 8);
    }
  }
  // Ring girder, bottom, shell and roof.
  b.ring('ring-girder', 'tank', 'steel', [0, Hb + 0.15, 0], Rtop, 0.3, { radial: 8, tubular: 64 });
  const depth = p.bottom === 'cone' ? Rt * 0.55 : Rt * 0.45;
  const bottomProfile = [];
  if (p.bottom === 'cone') bottomProfile.push([0, Hb - depth], [0.7, Hb - depth], [Rt, Hb + 0.05], [0, Hb + 0.05]);
  else {
    for (let i = 0; i <= 8; i++) { const a = i / 8 * Math.PI / 2; bottomProfile.push([Rt * Math.sin(a), Hb + 0.05 - depth * Math.cos(a)]); }
    bottomProfile.push([0, Hb + 0.05]);
  }
  b.lathe('tank-bottom', 'tank', 'tank', bottomProfile, [0, 0, 0], { segments: 48 });
  b.cylinder('tank-shell', 'tank', 'tank', [0, Hb, 0], Ht, Rt, { segments: 48 });
  const roofR = Rt + 0.15, roofH = roofR * Math.tan(p.roofPitch * DEG), yr = Hb + Ht - 0.02;
  b.cylinder('tank-roof', 'tank', 'roof', [0, yr, 0], roofH, roofR, { top: 0.35, segments: 48 });
  b.cylinder('tank-vent', 'tank', 'steel', [0, yr + roofH * (1 - 0.35 / roofR) - 0.05, 0], 0.7, 0.32, { top: 0.12, segments: 16 });
  // Telecom mast with three panel antennas on the roof, on the valve-house side.
  b.group('antennas', 'Roof mast and panel antennas', 'attachments', 0.15, 'roof');
  const mx = p.house.side * Rt * 0.5, mz = -Rt * 0.2, my = yr + roofH * (1 - Math.hypot(mx, mz) / roofR);
  b.beam('antenna-mast', 'antennas', 'steel', [mx, my - 0.3, mz], [mx, my + 4.5, mz], 0.08, 12);
  for (let k = 0; k < 3; k++) {
    const a = k * TAU / 3 + 0.4, ax = mx + 0.32 * Math.cos(a), az = mz + 0.32 * Math.sin(a);
    b.turnedBox('antenna-panel-' + (k + 1), 'antennas', 'frame', [ax, my + 3.3, az], [0.32, 1.6, 0.14], -a + Math.PI / 2);
    b.beam('antenna-arm-' + (k + 1), 'antennas', 'steel', [mx, my + 3.3, mz], [mx + 0.26 * Math.cos(a), my + 3.3, mz + 0.26 * Math.sin(a)], 0.03, 6);
  }
  // Balcony round the shell base: deck (a closed annulus) and railing.
  const bw = p.balcony, yb = Hb + 0.25, ro = Rt + bw;
  b.lathe('balcony-deck', 'balcony', 'steel', [[Rt - 0.08, yb - 0.1], [ro, yb - 0.1], [ro, yb], [Rt - 0.08, yb], [Rt - 0.08, yb - 0.1]], [0, 0, 0], { segments: 48 });
  const posts = Math.max(12, Math.round(TAU * ro / 1.6));
  for (let k = 0; k < posts; k++) {
    const a = (k + 0.5) / posts * TAU, rr = ro - 0.06;
    b.beam('balcony-post-' + (k + 1), 'balcony', 'rail', [rr * Math.cos(a), yb - 0.02, rr * Math.sin(a)], [rr * Math.cos(a), yb + 1.1, rr * Math.sin(a)], 0.03, 8);
  }
  b.ring('balcony-rail-top', 'balcony', 'rail', [0, yb + 1.1, 0], ro - 0.06, 0.035, { radial: 6, tubular: 64 });
  b.ring('balcony-rail-mid', 'balcony', 'rail', [0, yb + 0.55, 0], ro - 0.06, 0.03, { radial: 6, tubular: 64 });
  // Ladder up the front-left leg, then up the shell to the roof eave.
  const frontLeg = [...Array(n).keys()].sort((i, j) => legAt(j, 1)[2] - legAt(i, 1)[2] || legAt(i, 1)[0] - legAt(j, 1)[0])[0];
  const lb = legAt(frontLeg, footY + 0.3), lt = legAt(frontLeg, Hb - 0.4), out = [Math.cos(a0 + frontLeg * TAU / n), 0, Math.sin(a0 + frontLeg * TAU / n)];
  const across = [-out[2], 0, out[0]];
  ladder(b, { id: 'ladder-leg', group: 'ladders', material: 'rail', base: [lb[0] + out[0] * 0.45, 0.05, lb[2] + out[2] * 0.45],
    top: [lt[0] + out[0] * 0.45, yb - 0.12, lt[2] + out[2] * 0.45], across });
  const la = a0 + frontLeg * TAU / n + 0.12, sr = Rt + 0.3;
  ladder(b, { id: 'ladder-shell', group: 'ladders', material: 'rail', base: [sr * Math.cos(la), yb + 0.02, sr * Math.sin(la)],
    top: [sr * Math.cos(la), yr - 0.1, sr * Math.sin(la)], across: [-Math.sin(la), 0, Math.cos(la)] });
  // Riser pipe on its footing, an overflow pipe down one leg.
  b.box('riser-footing', 'riser', 'concrete', [-1.0, 0, -1.0], [1.0, 0.8, 1.0]);
  b.cylinder('riser', 'riser', 'steel', [0, 0.78, 0], Hb - depth - 0.78 + 0.25, 0.5, { segments: 24 });
  const ol = legAt(p.overflowLeg, Hb - 0.6), olb = legAt(p.overflowLeg, footY + 0.2), oo = [Math.cos(a0 + p.overflowLeg * TAU / n), 0, Math.sin(a0 + p.overflowLeg * TAU / n)];
  b.beam('overflow', 'riser', 'steel', [ol[0] - oo[0] * 0.5, Hb - 0.3, ol[2] - oo[2] * 0.5], [olb[0] - oo[0] * 0.5, 0.2, olb[2] - oo[2] * 0.5], 0.08, 10);
  // Valve house beside the riser footing.
  // Valve house in front of the tower, to one side of the axis: it overlaps the riser
  // footing in x, so a probe through it is backed by the footing in an earlier state.
  const s = p.house.side, hx0 = 0, hx1 = hx0 + s * p.house.w, hz0 = p.legR + 1.4, hz1 = hz0 + p.house.d;
  const houseBuilt = p.house.built !== false, outerX = s * (p.house.w - 0.9);
  const house = houseBuilt ? serviceHouse(b, { id: 'valve-house', group: 'valve.house', x0: Math.min(hx0, hx1), x1: Math.max(hx0, hx1), z0: hz0, z1: hz1, h: p.house.h,
    window: false, doorX: outerX }) : null;
  if (houseBuilt) b.beam('valve-pipe', 'riser', 'steel', [s * 0.6, 0.45, 0.95], [s * 0.6, 0.45, hz0 + 0.05], 0.15, 12);

  const probes = [];
  for (const [x, z] of [[Rt * 0.5, Rt * 0.1], [-Rt * 0.4, -Rt * 0.3], [Rt * 0.2, -Rt * 0.5]]) probes.push(['tank-roof', 'Height of the tank roof', [x, 200, z], [0, -1, 0]]);
  const shellY = Hb + Ht * 0.55;
  for (const [name, dir] of [['tank-front', [0, 0, -1]], ['tank-rear', [0, 0, 1]], ['tank-left', [1, 0, 0]], ['tank-right', [-1, 0, 0]]]) {
    for (const off of [0.25, -0.25, 0.4]) {
      const side = [dir[2], 0, -dir[0]].map(v => v * off * Rt);
      probes.push([name, 'Position of the tank shell (' + name.split('-')[1] + ')', [-dir[0] * 200 + side[0], shellY, -dir[2] * 200 + side[2]], dir]);
    }
  }
  // Exactly between two railing posts, at mid-width of the deck.
  for (const frac of [0.3, 0.55, 0.8, 0.05]) {
    const a = Math.round(frac * posts) / posts * TAU, rr = Rt + bw * 0.5;
    probes.push(['balcony', 'Height of the balcony deck', [rr * Math.cos(a), 200, rr * Math.sin(a)], [0, -1, 0]]);
  }
  const hcz = (hz0 + hz1) / 2;
  for (const y of [0.4, 0.5]) probes.push(['valve-house-front', 'Position of the valve house front', [s * 0.6, y, 200], [0, 0, -1]]);
  for (const y of [1.4, 0.8]) probes.push(['valve-house-side', 'Position of the valve house end wall', [s * 200, y, hcz], [-s, 0, 0]]);
  probes.push(['valve-house-roof', 'Height of the valve house roof', [(hx0 + hx1) / 2, 200, hcz + p.house.d / 4], [0, -1, 0]]);
  // Dimension endpoints sit on rims and corners (crease edges), never on a round silhouette.
  const dims = [
    ['tank-bottom-height', 'Height of the tank shell base above ground', [0, 0, 0], [0, Hb, 0], 'front'],
    ['tank-shell-height', 'Height of the cylindrical tank shell', [Rt, Hb, 0], [Rt, Hb + Ht, 0], 'front'],
    ['tank-diameter', 'Diameter of the tank shell', [-Rt, Hb, 0], [Rt, Hb, 0], 'front'],
    ['overall-height', 'Height to the top of the roof vent', [0, 0, 0], [0, yr + roofH * (1 - 0.35 / roofR) - 0.05 + 0.7, 0], 'front'],
    ['balcony-width', 'Width of the balcony deck', [Rt, yb, 0], [ro, yb, 0], 'front'],
    ['riser-footing', 'Width of the riser footing', [-1.0, 0, 1.0], [1.0, 0, 1.0], 'front'],
  ];
  if (house) {
    dims.push(['valve-house-width', 'Width of the valve house', [Math.min(hx0, hx1), 0, hz1], [Math.max(hx0, hx1), 0, hz1], 'front']);
    dims.push(['valve-house-eaves', 'Eaves height of the valve house', [Math.min(hx0, hx1), 0, hz1], [Math.min(hx0, hx1), house.under(p.house.d / 2 + 0.25), hz1], 'front']);
  }
  return { probes, dims, title: 'Elevated water tank', top: yr + roofH, label: 'the tank',
    structure: { kind: 'water-tower', legs: n, panels: p.panels, bottom: p.bottom, house: s } };
}

function guideFrame(b, p) {
  b.group('columns', 'Guide columns and caps', 'structure', 0.3, 'all');
  b.group('girders', 'Ring girders', 'structure', 0.25, 'all');
  b.group('bracing', 'Diagonal bracing', 'structure', 0.08, 'all');
  b.group('bell', 'Holder bell and crown', 'massing', 0.4, 'all');
  b.group('tank', 'Base tank wall', 'massing', 0.4, 'all');
  b.group('stair', 'Stair tower', 'attachments', 0.1, 'all');
  b.group('governor.house', 'Governor house', 'massing', 0.2, 'front');
  const R = p.R, n = p.columns, Htank = p.tank, H = Htank + p.tiers * p.tier, cw = 0.75;
  const colAt = (k, y) => { const a = (k + 0.5) / n * TAU; return [R * Math.cos(a), y, R * Math.sin(a)]; };
  // Base tank: a brick ring wall, solid annulus.
  b.lathe('tank-wall', 'tank', 'wall', [[R - 1.2, 0], [R + 0.9, 0], [R + 0.9, Htank], [R - 1.2, Htank], [R - 1.2, 0]], [0, 0, 0], { segments: 64 });
  b.lathe('tank-coping', 'tank', 'concrete', [[R - 1.3, Htank - 0.05], [R + 1.0, Htank - 0.05], [R + 1.0, Htank + 0.15], [R - 1.3, Htank + 0.15], [R - 1.3, Htank - 0.05]], [0, 0, 0], { segments: 64 });
  for (let k = 0; k < n; k++) {
    const c = colAt(k, 0), a = (k + 0.5) / n * TAU;
    b.turnedBox('column-' + (k + 1), 'columns', 'steel', [c[0], (Htank + H) / 2 + 0.06, c[2]], [cw, H - Htank + 0.04, cw], -a);
    b.turnedBox('column-' + (k + 1) + '-cap', 'columns', 'steel', [c[0], H + 0.15, c[2]], [1.3, 0.3, 1.3], -a);
  }
  for (let t = 1; t <= p.tiers; t++) {
    const y = Htank + t * p.tier - (t === p.tiers ? 0.45 : 0);
    for (let k = 0; k < n; k++) b.beam('girder-' + t + '-' + (k + 1), 'girders', 'steel', colAt(k, y), colAt((k + 1) % n, y), 0.32, 10);
    for (let k = 0; k < n; k++) {
      const y0 = Htank + (t - 1) * p.tier + 0.5, y1 = y - 0.5, j = (k + 1) % n;
      b.beam('brace-' + t + '-' + (k + 1) + 'a', 'bracing', 'steel', colAt(k, y0), colAt(j, y1), 0.06, 8);
      b.beam('brace-' + t + '-' + (k + 1) + 'b', 'bracing', 'steel', colAt(j, y0), colAt(k, y1), 0.06, 8);
    }
  }
  // Bell: the floating holder with a shallow domed crown.
  const Rb = R - 2.2, hb = Htank + p.bell * (H - Htank - 3), dome = Rb * 0.12, profile = [[0, Htank - 0.5], [Rb, Htank - 0.5], [Rb, hb]];
  for (let i = 1; i <= 8; i++) { const r = Rb * (1 - i / 8); profile.push([r, hb + dome * (1 - (r / Rb) ** 2)]); }
  b.lathe('bell', 'bell', 'tank', profile, [0, 0, 0], { segments: 64 });
  // Stair tower: four posts, landings and flights, on the given bearing outside the frame.
  const sa = p.stair.angle + Math.PI / 2, sc = [(R + 3.2) * Math.cos(sa), (R + 3.2) * Math.sin(sa)], half = 1.4;
  const ux = [Math.cos(sa), Math.sin(sa)], uz = [-Math.sin(sa), Math.cos(sa)];
  const corner = (i, j) => [sc[0] + ux[0] * i * half + uz[0] * j * half, sc[1] + ux[1] * i * half + uz[1] * j * half];
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([i, j], k) => {
    const c = corner(i, j);
    b.beam('stair-post-' + (k + 1), 'stair', 'steel', [c[0], 0, c[1]], [c[0], H + 1.2, c[1]], 0.1, 10);
  });
  const flights = Math.ceil(H / 3.2);
  for (let f = 0; f < flights; f++) {
    const y0 = f * H / flights, y1 = (f + 1) * H / flights, j = f % 2 ? 1 : -1;
    const a = corner(-0.75, j * 0.5), c = corner(0.75, j * 0.5);
    const [s0, s1] = f % 2 ? [c, a] : [a, c];
    b.beam('stair-flight-' + (f + 1), 'stair', 'steel', [s0[0], y0 + 0.1, s0[1]], [s1[0], y1 - 0.05, s1[1]], 0.18, 8);
    b.turnedBox('stair-landing-' + (f + 1), 'stair', 'steel', [sc[0], y1, sc[1]], [2 * half - 0.3, 0.12, 2 * half - 0.3], -sa);
  }
  // Gangway from the stair top to the nearest column cap.
  const top = H + 0.3, near = colAt(Math.round(((sa / TAU) * n - 0.5 + n) % n) % n, top);
  b.beam('stair-gangway', 'stair', 'steel', [sc[0], top, sc[1]], near, 0.15, 8);
  // Governor house in front, offset to one side.
  const s = p.house.side, hx0 = s * 3.0, hx1 = s * (3.0 + p.house.w), hz1 = R + 6 + p.house.d, hz0 = R + 6;
  const houseBuilt = p.house.built !== false;
  // Door at the outer end; the probe takes the inner half, which in an earlier state
  // without the house looks straight at the tank wall.
  const hcx = (hx0 + hx1) / 2;
  if (houseBuilt) serviceHouse(b, { id: 'governor-house', group: 'governor.house', x0: Math.min(hx0, hx1), x1: Math.max(hx0, hx1), z0: hz0, z1: hz1, h: 3.0, doorX: hcx + s * p.house.w * 0.25 });

  const probes = [];
  for (const [x, z] of [[0, Rb * 0.3], [Rb * 0.3, 0], [-Rb * 0.3, -Rb * 0.2]]) probes.push(['bell-crown', 'Height of the bell crown', [x, 300, z], [0, -1, 0]]);
  for (let k = 0; k < n; k++) { const c = colAt(k, 0); probes.push(['column-cap', 'Height of the column caps', [c[0] * 0.995, 300, c[2] * 0.995], [0, -1, 0]]); }
  for (const [name, dir] of [['tank-front', [0, 0, -1]], ['tank-rear', [0, 0, 1]], ['tank-left', [1, 0, 0]], ['tank-right', [-1, 0, 0]]]) {
    for (const off of [0.0, 0.2, -0.2]) {
      const side = [dir[2], 0, -dir[0]].map(v => v * off * R);
      probes.push([name, 'Position of the base tank wall (' + name.split('-')[1] + ')', [-dir[0] * 300 + side[0], Htank * 0.5, -dir[2] * 300 + side[2]], dir]);
    }
  }
  for (const y of [1.2, 1.6]) probes.push(['house-front', 'Position of the governor house front', [hcx - s * p.house.w * 0.25, y, 300], [0, 0, -1]]);
  probes.push(['house-roof', 'Height of the governor house roof', [hcx, 300, (hz0 + hz1) / 2 + p.house.d / 4], [0, -1, 0]]);
  const c0 = colAt(0, 0);
  const dims = [
    ['frame-height', 'Height to the top of the column caps', [c0[0], 0, c0[2]], [c0[0], H + 0.3, c0[2]], 'front'],
    ['tank-height', 'Height of the base tank wall', [R + 0.9, 0, 0], [R + 0.9, Htank, 0], 'right'],
    ['tank-diameter', 'Outer diameter of the base tank wall', [-(R + 0.9), 0, 0], [R + 0.9, 0, 0], 'front'],
    ['bell-height', 'Height of the bell shoulder (top of its side wall)', [0, 0, 0], [0, hb, 0], 'front'],
  ];
  if (houseBuilt) {
    dims.push(['house-width', 'Width of the governor house', [Math.min(hx0, hx1), 0, hz1], [Math.max(hx0, hx1), 0, hz1], 'front']);
    dims.push(['house-depth', 'Depth of the governor house', [Math.max(hx0, hx1), 0, hz0], [Math.max(hx0, hx1), 0, hz1], 'plan']);
  }
  return { probes, dims, title: 'Gasholder guide frame', top: H + 1.2, label: 'the frame',
    structure: { kind: 'guide-frame', columns: n, tiers: p.tiers, house: s, stair: Math.round(p.stair.angle * 100) / 100 } };
}

function dishAntenna(b, p) {
  b.group('pedestal', 'Pedestal, platform and railing', 'massing', 0.3, 'all');
  b.group('mount', 'Turntable, yoke, axle and counterweight', 'structure', 0.3, 'all');
  b.group('dish', 'Reflector dish and rim', 'massing', 0.25, 'front');
  b.group('backing', 'Dish backing ribs and hub', 'structure', 0.15, 'rear');
  b.group('feed', 'Quadripod and subreflector', 'attachments', 0.1, 'front');
  b.group('access', 'Ladder', 'attachments', 0.05, 'front');
  b.group('hut', 'Equipment hut', 'massing', 0.2, p.hut.side < 0 ? 'left' : 'right');
  const Rp = p.pedestalR, Hp = p.pedestal, az = p.az * DEG, el = p.el * DEG, Dd = p.diameter, Rd = Dd / 2, f = p.fd * Dd;
  const d = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
  const k = [Math.cos(az), 0, -Math.sin(az)];                            // elevation axle
  const rot = [Math.atan2(Math.cos(el) * Math.cos(az), Math.sin(el)), 0, Math.asin(-Math.cos(el) * Math.sin(az))];
  const add = (a, c, s = 1) => a.map((v, i) => v + s * c[i]);
  b.cylinder('pedestal', 'pedestal', 'concrete', [0, 0, 0], Hp, Rp, { segments: 40 });
  b.cylinder('pedestal-base', 'pedestal', 'concrete', [0, 0, 0], 0.5, Rp + 0.8, { segments: 40 });
  b.lathe('platform', 'pedestal', 'steel', [[Rp - 0.1, Hp - 0.05], [Rp + 1.1, Hp - 0.05], [Rp + 1.1, Hp + 0.1], [Rp - 0.1, Hp + 0.1], [Rp - 0.1, Hp - 0.05]], [0, 0, 0], { segments: 40 });
  b.ring('platform-rail', 'pedestal', 'rail', [0, Hp + 1.15, 0], Rp + 1.0, 0.035, { radial: 6, tubular: 48 });
  for (let i = 0; i < 12; i++) { const a = (i + 0.5) / 12 * TAU; b.beam('platform-post-' + (i + 1), 'pedestal', 'rail', [(Rp + 1.0) * Math.cos(a), Hp + 0.08, (Rp + 1.0) * Math.sin(a)], [(Rp + 1.0) * Math.cos(a), Hp + 1.18, (Rp + 1.0) * Math.sin(a)], 0.03, 8); }
  // Door at the pedestal foot and a ladder up its front.
  b.box('pedestal-door', 'access', 'door', [-0.55, 0.5, Rp - 0.15], [0.55, 2.6, Rp + 0.06]);
  ladder(b, { id: 'pedestal-ladder', group: 'access', material: 'rail', base: [1.0, 0.5, Rp * Math.cos(Math.asin(1.0 / Rp)) + 0.25], top: [1.0, Hp + 0.05, Rp * Math.cos(Math.asin(1.0 / Rp)) + 0.25], across: [1, 0, 0] });
  // Turntable, yoke arms, axle; the axle height keeps the lowest rim above the platform.
  b.cylinder('turntable', 'mount', 'steel', [0, Hp + 0.08, 0], 0.9, Rp - 0.2, { segments: 40 });
  const He = Hp + 1.6 + Rd * Math.cos(el) + 0.5, E = [0, He, 0], arm = 1.6;
  for (const s of [-1, 1]) {
    const c = add(E, k, s * arm);
    b.turnedBox('yoke-' + (s < 0 ? 'left' : 'right'), 'mount', 'steel', [c[0], (Hp + 0.95 + He + 0.5) / 2, c[2]], [0.6, He + 0.5 - Hp - 0.95, 1.0], az);
  }
  b.beam('elevation-axle', 'mount', 'steel', add(E, k, -arm - 0.45), add(E, k, arm + 0.45), 0.3, 16);
  b.add({ id: 'counterweight', type: 'box', size: [2.6, 1.2, 1.4], position: add(E, d, -1.9), rotation: rot, material: 'concrete', group: 'mount' });
  b.beam('counterweight-arm', 'mount', 'steel', add(E, d, 0.2), add(E, d, -1.4), 0.25, 12);
  // Dish: paraboloid shell 0.25 m thick, vertex 1.2 m in front of the axle.
  const V = add(E, d, 1.2), t = 0.25, steps = 10, profile = [];
  const yAt = r => r * r / (4 * f);
  for (let i = 0; i <= steps; i++) { const r = Rd * i / steps; profile.push([r, yAt(r) - t]); }
  for (let i = steps; i >= 0; i--) { const r = Rd * i / steps; profile.push([r, yAt(r)]); }
  b.lathe('dish', 'dish', 'tank', profile, V, { segments: 48, rotation: rot });
  const rimY = yAt(Rd);
  // Rim stiffener: a closed ring section round the shell edge, in the dish's own frame.
  b.lathe('dish-rim', 'dish', 'steel', [[Rd - 0.12, rimY - 0.3], [Rd + 0.1, rimY - 0.3], [Rd + 0.1, rimY + 0.04], [Rd - 0.12, rimY + 0.04], [Rd - 0.12, rimY - 0.3]], V, { segments: 48, rotation: rot });
  // Perpendicular basis of the dish aperture.
  const e1 = k, e2 = [d[1] * k[2] - d[2] * k[1], d[2] * k[0] - d[0] * k[2], d[0] * k[1] - d[1] * k[0]];
  const rimPoint = (a, back = 0) => add(add(V, d, rimY - back), add(e1.map(v => v * Rd * Math.cos(a)), e2.map(v => v * Rd * Math.sin(a))));
  b.beam('hub', 'backing', 'steel', add(V, d, -0.15), add(V, d, -1.0), 0.9, 20);
  // Ribs follow the convex back surface 0.3 m behind it in short chords; one
  // straight chord from hub to rim would cut through the reflector.
  for (let i = 0; i < 8; i++) {
    const a = (i + 0.5) / 8 * TAU, at = q => add(add(V, d, yAt(Rd * q) - t - 0.3), add(e1.map(v => v * Rd * q * Math.cos(a)), e2.map(v => v * Rd * q * Math.sin(a))));
    const chain = [add(V, d, -0.7), at(0.1), at(0.4), at(0.7), at(0.95)];
    for (let j = 0; j + 1 < chain.length; j++) b.beam('rib-' + (i + 1) + '-' + (j + 1), 'backing', 'steel', chain[j], chain[j + 1], 0.07, 8);
  }
  const F = add(V, d, f);
  for (let i = 0; i < 4; i++) b.beam('quadripod-' + (i + 1), 'feed', 'steel', rimPoint(i / 4 * TAU + Math.PI / 4, 0.05), add(F, d, -0.3), 0.08, 10);
  b.add({ id: 'subreflector', type: 'cylinder', radius: Rd * 0.035, radius_bottom: Rd * 0.08, height: 0.6, segments: 24, position: add(F, d, -0.1), rotation: rot, material: 'tank', group: 'feed' });
  b.add({ id: 'feed-horn', type: 'cylinder', radius: 0.35, radius_bottom: 0.45, height: 1.6, segments: 20, position: add(V, d, 0.7), rotation: rot, material: 'steel', group: 'feed' });
  // Equipment hut beside the pedestal.
  const s = p.hut.side, hx0 = s * (Rp + 2.8), hx1 = hx0 + s * p.hut.w, hz0 = -p.hut.d / 2, hz1 = p.hut.d / 2;
  const hutBuilt = p.hut.built !== false;
  if (hutBuilt) {
    serviceHouse(b, { id: 'hut', group: 'hut', x0: Math.min(hx0, hx1), x1: Math.max(hx0, hx1), z0: hz0, z1: hz1, h: 2.8 });
    b.beam('cable-tray', 'hut', 'steel', [s * (Rp - 0.05), 2.2, 0], [s * (Rp + 2.85), 2.2, 0], 0.12, 8);
  }

  const probes = [];
  for (const [q, a] of [[0.45, 0], [0.5, Math.PI / 2], [0.55, Math.PI], [0.45, 1.5 * Math.PI]]) {
    const target = add(add(V, d, yAt(Rd * q)), add(e1.map(v => v * Rd * q * Math.cos(a)), e2.map(v => v * Rd * q * Math.sin(a))));
    probes.push(['dish-face', 'Position of the reflector surface', add(target, d, 120), d.map(v => -v)]);
  }
  // Front probes stay above the door and away from the ladder; the side probe comes
  // from the side away from the hut, so it measures the pedestal itself.
  for (const [name, dir] of [['pedestal-front', [0, 0, -1]], ['pedestal-rear', [0, 0, 1]], ['pedestal-side', [s, 0, 0]]]) {
    for (const [off, y] of [[-0.6, Math.max(3.0, Hp * 0.6)], [-Rp * 0.45, Hp * 0.75], [0.0, Math.max(3.0, Hp * 0.8)]]) {
      const lateral = [dir[2], 0, -dir[0]].map(v => v * off), originPt = [-dir[0] * 200 + lateral[0], y, -dir[2] * 200 + lateral[2]];
      probes.push([name, 'Position of the pedestal (' + name.split('-')[1] + ')', originPt, dir]);
    }
  }
  // The back of the reflector between two ribs, the counterweight and the turntable.
  for (const [q, i] of [[0.6, 1], [0.55, 3], [0.6, 5], [0.65, 7]]) {
    const a = i / 8 * TAU, target = add(add(V, d, yAt(Rd * q) - t), add(e1.map(v => v * Rd * q * Math.cos(a)), e2.map(v => v * Rd * q * Math.sin(a))));
    probes.push(['dish-back', 'Position of the back of the reflector', add(target, d, -120), d]);
  }
  probes.push(['counterweight', 'Position of the counterweight', add(add(E, d, -1.9 - 0.6), d, -120), d]);
  for (const a of [0.3, 1.4, 2.6, 4.2]) {
    const dir = [-Math.cos(a), 0, -Math.sin(a)], r0 = 200;
    probes.push(['turntable', 'Position of the turntable rim', [r0 * Math.cos(a), Hp + 0.53, r0 * Math.sin(a)], dir]);
  }
  for (const y of [1.2, 0.9]) probes.push(['hut-side', 'Position of the equipment hut end wall', [s * 200, y, -0.15], [-s, 0, 0]]);
  for (const f of [0.75, 0.25]) probes.push(['hut-front', 'Position of the equipment hut front', [hx0 + (hx1 - hx0) * f, 1.4, 200], [0, 0, -1]]);
  probes.push(['hut-roof', 'Height of the equipment hut roof', [(hx0 + hx1) / 2, 200, p.hut.d / 4], [0, -1, 0]]);
  const dims = [
    ['pedestal-height', 'Height of the platform underside', [Rp, 0, 0], [Rp, Hp - 0.05, 0], 'front'],
    ['pedestal-diameter', 'Diameter of the pedestal', [-Rp, Hp, 0], [Rp, Hp, 0], 'front'],
    ['turntable-height', 'Height to the top of the turntable', [0, 0, 0], [0, Hp + 0.98, 0], 'front'],
    ['base-diameter', 'Diameter of the pedestal base ring', [-(Rp + 0.8), 0.5, 0], [Rp + 0.8, 0.5, 0], 'front'],
    ['platform-diameter', 'Diameter of the platform', [0, Hp + 0.1, -(Rp + 1.1)], [0, Hp + 0.1, Rp + 1.1], 'right'],
  ];
  if (hutBuilt) {
    dims.push(['hut-width', 'Width of the equipment hut', [Math.min(hx0, hx1), 0, hz1], [Math.max(hx0, hx1), 0, hz1], 'front']);
    dims.push(['hut-offset', 'Gap between the pedestal and the hut', [s * Rp, 0, 0], [hx0, 0, 0], 'plan']);
    dims.push(['hut-depth', 'Depth of the equipment hut', [Math.max(hx0, hx1), 0, hz0], [Math.max(hx0, hx1), 0, hz1], 'plan']);
  }
  return { probes, dims, title: 'Dish antenna on a pedestal', top: He + Rd + 2, label: 'the antenna',
    structure: { kind: 'dish', azimuthSign: Math.sign(p.az), hut: s, dishClass: Dd > 15 ? 'large' : 'medium' } };
}

export function build(p) {
  const b = new ModelBuilder();
  materials(b, PALETTES[p.palette]);
  const built = p.kind === 'water-tower' ? waterTower(b, p) : p.kind === 'guide-frame' ? guideFrame(b, p) : dishAntenna(b, p);
  for (const q of built.probes) b.probe(...q);
  for (const dim of built.dims) b.dimension(...dim);
  const what = p.kind === 'water-tower' ? 'the ladder' : p.kind === 'guide-frame' ? 'the governor house' : 'the pedestal ladder and door';
  return {
    builder: b,
    title: built.title,
    frame: {
      origin: 'On the ground at the centre of the structure\'s base (the axis of ' + built.label + '); the ground is y = 0.',
      front: 'The front, with ' + what + ', faces +Z; +X is to the right when you look at the front.',
    },
    scope_note: 'The structure and its attached service building only. No ground plane, fences, roads, vegetation, cables beyond the structure or neighbouring buildings.',
    structure: built.structure,
  };
}

export const edits = [
  { id: 'lower-tank', scope: ['legs', 'bracing', 'tank', 'balcony', 'ladders', 'riser', 'antennas'], applies: p => p.kind === 'water-tower' && p.panels > 3, apply: p => ({ ...p, panels: p.panels - 1 }), phrase: 'the tank stood one bracing panel lower' },
  { id: 'shorter-shell', scope: ['tank', 'ladders', 'antennas'], applies: p => p.kind === 'water-tower', apply: p => ({ ...p, shell: p.shell - 2.5 }), phrase: 'the tank shell was 2.5 m shorter' },
  { id: 'no-valve-house', scope: ['valve.house', 'riser'], applies: p => p.kind === 'water-tower' && p.house.built !== false, apply: p => ({ ...p, house: { ...p.house, built: false } }), phrase: 'the valve house had not been built' },
  { id: 'one-tier-fewer', scope: ['columns', 'girders', 'bracing', 'bell', 'stair'], applies: p => p.kind === 'guide-frame' && p.tiers > 2, apply: p => ({ ...p, tiers: p.tiers - 1 }), phrase: 'the guide frame was one tier lower' },
  { id: 'no-governor-house', scope: ['governor.house'], applies: p => p.kind === 'guide-frame' && p.house.built !== false, apply: p => ({ ...p, house: { ...p.house, built: false } }), phrase: 'the governor house had not been built' },
  { id: 'lower-pedestal', scope: ['pedestal', 'mount', 'dish', 'backing', 'feed', 'access'], applies: p => p.kind === 'dish' && p.pedestal > 5.5, apply: p => ({ ...p, pedestal: p.pedestal - 2.5 }), phrase: 'the dish stood on a pedestal 2.5 m lower' },
  { id: 'no-hut', scope: ['hut'], applies: p => p.kind === 'dish' && p.hut.built !== false, apply: p => ({ ...p, hut: { ...p.hut, built: false } }), phrase: 'the equipment hut had not been built' },
];

export default { id: 'structure', sample, build, edits };
