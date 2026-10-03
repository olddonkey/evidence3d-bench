// Two-storey civic building on an L, T or U plan: a main range along the street
// with one or two rear wings, roofs that intersect in valleys (hipped, or gabled
// behind parapeted gable walls), a raised ground floor on a plinth, a string
// course, regular window bays, an entrance portico on columns (pediment or flat
// top) in front of the main doors, an optional cupola or clock turret on the main
// ridge, optional chimney stacks, and an external steel escape stair against one
// end wall.
//
// Frame: the main front wall face is z = 0, the main range spans x in [-Lm/2, Lm/2]
// and runs back to z = -Dm; wings run further back from the main rear wall.
//
// Roofs are closed solids (boxed eaves): the main range's block, and for each wing a
// block whose front end is a vertical gable buried in the main block at its ridge
// line (a wing is always narrower than the main range is deep). Wing soffits sit
// 3 cm above the main soffit, so the overlapping eaves at the re-entrant corners
// are not coplanar.
import {
  ModelBuilder, wallFrame, wall, opening, glazedOpening, doorOpening, gableRoofZ, hipRoof, band, lintel, railing, draw, DEG,
} from '../kit.mjs';

const T = 0.45;           // masonry walls
const FASCIA = 0.45;      // boxed eaves / cornice depth
const BAND_PROUD = 0.12;  // plinth and string course projection

const PALETTES = [
  { wall: ['#d8cfbd', 'stone'], dressing: '#ece6d6', roof: '#4b5054', frame: '#f1f0ea', door: '#2c3a2e', metal: '#2a2c2e', copper: '#5f8a7a' },
  { wall: ['#a35a43', 'brick'], dressing: '#e2dccb', roof: '#3e4347', frame: '#ffffff', door: '#3b2b22', metal: '#26292b', copper: '#6a9585' },
  { wall: ['#c9c2b2', 'stone'], dressing: '#e8e2d2', roof: '#6c5a4c', frame: '#2f3236', door: '#22344d', metal: '#2a2c2e', copper: '#4f6f63' },
  { wall: ['#b48f6a', 'wall'], dressing: '#efe9da', roof: '#5b5450', frame: '#f4f3ef', door: '#5a2224', metal: '#2a2c2e', copper: '#5c8577' },
];

export function sample(r) {
  const m = r.fork('massing');
  const plan = m.pick(['L', 'T', 'U']);
  const length = draw(m, 24, 38, 0.5), depth = draw(m, 10, 13.5, 0.25);
  const massing = { plan, length, depth, ground: draw(m, 4.0, 4.8), upper: draw(m, 3.6, 4.2), floor: draw(m, 0.6, 1.1), attic: draw(m, 0.3, 0.6),
    roof: m.pick(['hip', 'hip', 'gable']), pitch: draw(m, 30, 38, 1), eaves: draw(m, 0.5, 0.8), bay: draw(m, 3.2, 3.9) };
  // Wings: width below the main depth, inset from the ends so no roof plane is shared.
  const w = r.fork('wings');
  const wing = () => ({ width: draw(w, 8.5, Math.min(12, depth - 1.2)), length: draw(w, 10, 18), inset: draw(w, 0.8, 2.6), built: true });
  const wings = plan === 'U' ? [{ ...wing(), side: -1 }, { ...wing(), side: 1 }]
    : plan === 'L' ? [{ ...wing(), side: w.pick([-1, 1]) }] : [{ ...wing(), side: 0 }];
  // A T wing stands well off the centre line (3.5-7 m, at least 1.2 m in from the
  // end): with the portico and cupola on the axis, a centred wing would leave the
  // building nearly mirror-symmetric.
  if (plan === 'T') wings[0].offset = w.pick([-1, 1]) * Math.min(draw(w, 3.5, 7.0), length / 2 - 1.2 - wings[0].width / 2);
  if (plan === 'U' && Math.abs(wings[0].length - wings[1].length) < 2.5) wings[w.int(0, 1)].length += 3.5;
  const pf = r.fork('portico');
  const portico = { columns: pf.pick([2, 4, 4, 6]), spacing: draw(pf, 2.3, 2.9), diameter: draw(pf, 0.55, 0.75), depth: draw(pf, 2.6, 3.6),
    top: pf.chance(0.7) ? 'pediment' : 'flat', pitch: draw(pf, 17, 23, 1) };
  const o = r.fork('options');
  const cupola = o.chance(0.75) ? { shape: o.pick(['square', 'octagon']), width: draw(o, 2.4, 3.2), height: draw(o, 2.0, 2.8), clock: o.chance(0.6),
    top: o.pick(['dome', 'pyramid']) } : null;
  const stair = { side: o.pick([-1, 1]), built: true };
  const chimneys = o.chance(0.6);
  return { massing, wings, portico, cupola, stair, chimneys, palette: r.fork('palette').int(0, PALETTES.length - 1) };
}

// Closed roof block along Z over [x0, x1] x [z0, z1] (z1 the front end), boxed
// eaves from `soffit` up `fascia`, slopes at `pitch` to a ridge on x = (x0+x1)/2.
// The front end is a vertical gable; the rear end is a gable or a hip.
function wingRoof(b, { id, group, material, x0, x1, z0, z1, soffit, fascia, pitch, rear }) {
  const xc = (x0 + x1) / 2, half = (x1 - x0) / 2, yt = soffit + fascia, yr = yt + half * Math.tan(pitch);
  const v = [[x0, soffit, z1], [x1, soffit, z1], [x1, yt, z1], [xc, yr, z1], [x0, yt, z1],
    [x0, soffit, z0], [x1, soffit, z0], [x1, yt, z0], [x0, yt, z0]];
  const faces = [[0, 1, 6, 5], [1, 2, 7, 6], [4, 0, 5, 8], [0, 1, 2, 3, 4]];
  if (rear === 'hip') {
    v.push([xc, yr, z0 + half]);
    faces.push([2, 3, 9, 7], [3, 4, 8, 9], [5, 6, 7, 8], [7, 8, 9]);
  } else {
    v.push([xc, yr, z0]);
    faces.push([2, 3, 9, 7], [3, 4, 8, 9], [5, 6, 7, 9, 8]);
  }
  b.convex(id, group, material, v, faces);
  return { ridgeTop: yr, top: (x, z) => yt + Math.min(half - Math.abs(x - xc), rear === 'hip' ? z - z0 : Infinity, half) * Math.tan(pitch) };
}

export function build(p) {
  const b = new ModelBuilder(), M = p.massing, pal = PALETTES[p.palette];
  const Lm = M.length, Dm = M.depth, yf = M.floor, hg = M.ground, hu = M.upper, pitch = M.pitch * DEG, tan = Math.tan(pitch), ov = M.eaves;
  const plate = yf + hg + hu + M.attic, gableRoof = M.roof === 'gable';
  b.material(pal.wall[1] === 'brick' ? 'brick' : 'masonry', pal.wall[0], pal.wall[1] === 'brick' ? 'wall' : pal.wall[1], { roughness: 0.9 });
  const wallMat = pal.wall[1] === 'brick' ? 'brick' : 'masonry';
  b.material('dressing', pal.dressing, 'stone', { roughness: 0.85 });
  b.material('roof', pal.roof, 'roof', { roughness: 0.8 });
  b.material('frame', pal.frame, 'frame', { roughness: 0.5 });
  b.material('glass', '#2e4250', 'glass', { roughness: 0.05 });
  b.material('door', pal.door, 'wood', { roughness: 0.6 });
  b.material('metal', pal.metal, 'metal', { roughness: 0.4, metalness: 0.6 });
  b.material('copper', pal.copper, 'metal', { roughness: 0.6, metalness: 0.3 });
  b.material('clock', '#f2efe6', 'sign', { roughness: 0.5 });
  b.material('steel', '#3d4145', 'metal', { roughness: 0.5, metalness: 0.6 });

  b.group('body', 'Main range walls', 'massing', 0.3, 'all');
  b.group('roof', 'Main roof' + (gableRoof ? ' and gable copings' : ''), 'roof', 0.3, 'roof');
  b.group('base', 'Plinth and string course', 'ornament', 0.08, 'all');
  b.group('front.windows', 'Front windows', 'openings', 0.08, 'front');
  b.group('windows', 'Side and rear windows of the main range', 'openings', 0.08, 'all');
  b.group('portico', 'Entrance portico, steps and main doors', 'entrance', 0.15, 'front');

  // ---- wings (footprints decided first: they blank the main rear wall) -------------
  const wings = p.wings.map((w, k) => {
    const x0 = w.side < 0 ? -Lm / 2 + w.inset : w.side > 0 ? Lm / 2 - w.inset - w.width : w.offset - w.width / 2;
    return { ...w, k, x0, x1: x0 + w.width, zr: -Dm - w.length };
  });
  const builtWings = wings.filter(w => w.built);
  const inWing = (u0, u1) => wings.some(w => u1 > w.x0 - 0.6 && u0 < w.x1 + 0.6);

  // ---- main range walls and openings ------------------------------------------------
  const nb = Math.max(5, Math.round(Lm / M.bay)) | 1, bw = Lm / nb;        // an odd number of bays: the door bay is central
  const bayX = k => -Lm / 2 + (k + 0.5) * bw, mid = (nb - 1) / 2;
  const gw = Math.min(1.7, bw - 1.4), gs = yf + 0.85, gh = Math.min(2.5, hg - 1.4), us = yf + hg + 0.75, uh = Math.min(2.1, hu - 1.2);
  // The portico takes at most 45 % of the front: fewer columns on a short front.
  const pc = p.portico;
  let cols = pc.columns;
  while (cols > 2 && (cols - 1) * pc.spacing + pc.diameter + 0.9 > 0.45 * Lm) cols -= 2;
  const pw = (cols - 1) * pc.spacing + pc.diameter + 0.9, pd = pc.depth;
  const door = opening({ u0: -1.0, u1: 1.0, y0: yf, y1: yf + Math.min(3.6, hg - 0.5) });
  const front = [door], frontWins = [];
  for (let k = 0; k < nb; k++) {
    const x = bayX(k);
    if (k !== mid) frontWins.push(opening({ u0: x - gw / 2, u1: x + gw / 2, y0: gs, y1: gs + gh }));
    // Upper windows behind the portico's entablature and pediment are left out.
    if (Math.abs(x) > pw / 2 + 0.3 + gw / 2) frontWins.push(opening({ u0: x - gw / 2, u1: x + gw / 2, y0: us, y1: us + uh }));
  }
  front.push(...frontWins);
  const wfF = wallFrame('z', 1, 0), wfB = wallFrame('z', -1, -Dm), wfL = wallFrame('x', -1, -Lm / 2), wfR = wallFrame('x', 1, Lm / 2);
  // Gable variant: the end walls rise 35 cm above the roof as parapets.
  const mainTop = z => plate + FASCIA + (Dm / 2 + ov - Math.abs(z + Dm / 2)) * tan;      // top of the gable block
  const endTop = gableRoof ? [[Dm, mainTop(-Dm) + 0.35], [Dm / 2, mainTop(-Dm / 2) + 0.35], [0, mainTop(0) + 0.35]] : [[Dm, plate + 0.05], [0, plate + 0.05]];
  wall(b, wfF, { id: 'wall-front', group: 'body', material: wallMat, u0: -Lm / 2 + T, u1: Lm / 2 - T, y0: 0, y1: plate + 0.05, thickness: T, openings: front });
  // Rear: windows except behind a wing (built or not), a service door in a free bay.
  const rear = [];
  let service = null;
  for (let k = 0; k < nb; k++) {
    const x = bayX(k);
    if (inWing(x - gw / 2, x + gw / 2)) continue;
    if (!service && k !== mid && Math.abs(k - mid) <= nb / 2) { service = opening({ u0: x - 0.6, u1: x + 0.6, y0: yf, y1: yf + 2.5 }); rear.push(service); }
    else rear.push(opening({ u0: x - gw / 2, u1: x + gw / 2, y0: gs, y1: gs + gh }));
    rear.push(opening({ u0: x - gw / 2, u1: x + gw / 2, y0: us, y1: us + uh }));
  }
  wall(b, wfB, { id: 'wall-rear', group: 'body', material: wallMat, u0: -Lm / 2 + T, u1: Lm / 2 - T, y0: 0, y1: plate + 0.05, thickness: T, openings: rear });
  // End walls: windows per storey; the stair side keeps its rear half for the escape door.
  const st = p.stair, es = st.side, fireU = Dm * 0.75, upperFloor = yf + hg;
  const fireDoor = opening({ u0: fireU - 0.55, u1: fireU + 0.55, y0: upperFloor, y1: upperFloor + 2.25 });
  const ends = { [-1]: [], [1]: [] };
  const nE = Math.max(2, Math.round(Dm / 4.2));
  // On the stair side (built or not) the ground floor is blank behind the flights and
  // landings, and the upper floor keeps clear of the fire door.
  const run = (upperFloor / 2) / Math.tan(36 * DEG), stairU = [fireU - 2.1 - run, fireU + 0.9];
  for (const side of [-1, 1]) for (let k = 0; k < nE; k++) {
    const u = Dm * (k + 0.5) / nE;
    for (const [y0, h] of [[gs, gh], [us, uh]]) {
      if (side === es && y0 === gs && u + 0.75 > stairU[0] && u - 0.75 < stairU[1]) continue;
      if (side === es && y0 === us && Math.abs(u - fireU) < 1.6) continue;
      ends[side].push(opening({ u0: u - Math.min(0.75, gw / 2), u1: u + Math.min(0.75, gw / 2), y0, y1: y0 + h }));
    }
  }
  for (const [side, wf] of [[-1, wfL], [1, wfR]]) {
    wall(b, wf, { id: 'wall-' + (side < 0 ? 'left' : 'right'), group: 'body', material: wallMat, u0: 0, u1: Dm, y0: 0, top: endTop, thickness: T,
      openings: [...ends[side], ...(side === es && st.built ? [fireDoor] : [])] });
  }

  // ---- plinth and string course -----------------------------------------------------------
  const bandRuns = (wf, u0, u1, y0, y1, id, gaps = []) => band(b, wf, { id, group: 'base', material: 'dressing', u0, u1, y0, y1, proud: BAND_PROUD, embed: 0.05, gaps });
  const plinthTop = yf - 0.03, scY = upperFloor - 0.1;
  // The string course breaks for the fire door (its sill is the upper floor level).
  const fireGap = side => st.built && side === es ? [[fireU - 0.75, fireU + 0.75]] : [];
  for (const [name, y0, y1] of [['plinth', 0, plinthTop], ['course', scY, scY + 0.28]]) {
    bandRuns(wfF, -Lm / 2 - BAND_PROUD, Lm / 2 + BAND_PROUD, y0, y1, name + '-front');
    bandRuns(wfB, -Lm / 2 - BAND_PROUD, Lm / 2 + BAND_PROUD, y0, y1, name + '-rear');
    bandRuns(wfL, 0.05, Dm - 0.05, y0, y1, name + '-left', name === 'course' ? fireGap(-1) : []);
    bandRuns(wfR, 0.05, Dm - 0.05, y0, y1, name + '-right', name === 'course' ? fireGap(1) : []);
  }

  // ---- main roof -------------------------------------------------------------------------------
  let roofInfo;
  if (gableRoof) {
    // A closed gable block between the parapeted end walls, ending 4 cm into them from
    // the inside: were it to reach their outer faces, a model without the walls would
    // still show the gables (the block's end faces) within their tolerance.
    const s = Dm / 2 + ov, yt = plate + FASCIA, apex = yt + s * tan;
    b.prismX('roof-main', 'roof', 'roof', [[ov, plate], [-Dm - ov, plate], [-Dm - ov, yt], [-Dm / 2, apex], [ov, yt]], -Lm / 2 + T - 0.04, Lm / 2 - T + 0.04);
    roofInfo = { ridgeTop: apex, top: (x, z) => mainTop(z) };
    // Sloped coping on each parapeted gable, 5 cm proud of both wall faces and past both ends.
    for (const [side, xo] of [[-1, -Lm / 2], [1, Lm / 2]]) {
      const zs = [0.08, -Dm / 2, -Dm - 0.08], prof = zs.map(z => [z, mainTop(Math.min(0, Math.max(-Dm, z))) + 0.3]);
      b.prismX('gable-coping-' + (side < 0 ? 'left' : 'right'), 'roof', 'dressing', [...prof, ...[...prof].reverse().map(([z, y]) => [z, y + 0.2])],
        side < 0 ? xo - 0.05 : xo - T - 0.05, side < 0 ? xo + T + 0.05 : xo + 0.05);
    }
  } else {
    roofInfo = hipRoof(b, { id: 'roof-main', group: 'roof', material: 'roof', x0: -Lm / 2 - ov, x1: Lm / 2 + ov, z0: -Dm - ov, z1: ov, soffit: plate, fascia: FASCIA, pitch });
    const surface = roofInfo.surface;
    roofInfo.top = (x, z) => surface(x, z);
  }

  // ---- wings ------------------------------------------------------------------------------------
  if (builtWings.length) b.group('wings', 'Rear wing' + (builtWings.length > 1 ? 's' : ''), 'massing', 0.3, 'rear');
  for (const w of builtWings) {
    const id = 'wing-' + (w.k + 1), wfS0 = wallFrame('x', -1, w.x0), wfS1 = wallFrame('x', 1, w.x1), wfE = wallFrame('z', -1, w.zr);
    const nw = Math.max(2, Math.round(w.length / M.bay)), ww = (w.length - 0.8) / nw;
    for (const [side, wf] of [[-1, wfS0], [1, wfS1]]) {
      const wins = [];
      for (let k = 0; k < nw; k++) {
        const u = Dm + 0.4 + (k + 0.5) * ww;
        for (const [y0, h] of [[gs, gh], [us, uh]]) wins.push(opening({ u0: u - Math.min(0.75, ww / 2 - 0.6), u1: u + Math.min(0.75, ww / 2 - 0.6), y0, y1: y0 + h }));
      }
      wall(b, wf, { id: id + '-side-' + (side < 0 ? 'left' : 'right'), group: 'wings', material: wallMat, u0: Dm - 0.05, u1: Dm + w.length, y0: 0, y1: plate + 0.05, thickness: T, openings: wins });
      wins.forEach((o, k) => {
        glazedOpening(b, wf, o, { id: id + '-window-' + (side < 0 ? 'l' : 'r') + (k + 1), group: 'wings', frame: 'frame', glass: 'glass', sill: 'dressing', recess: 0.25, mullions: 1, transoms: [o.top - 0.6] });
      });
      for (const [name, y0, y1] of [['plinth', 0, plinthTop], ['course', scY, scY + 0.28]]) {
        band(b, wf, { id: id + '-' + name + '-' + (side < 0 ? 'left' : 'right'), group: 'wings', material: 'dressing', u0: Dm + BAND_PROUD, u1: Dm + w.length - 0.05, y0, y1, proud: BAND_PROUD, embed: 0.05 });
      }
    }
    // Rear end: gable (parapeted on a gabled building) or the wall under a hip.
    const half = w.width / 2, yt = plate + 0.03 + FASCIA, wingTop = x => yt + (half + ov - Math.abs(x - (w.x0 + w.x1) / 2)) * tan;
    const endWins = [-1, 1].flatMap(sgn => [[gs, gh], [us, uh]].map(([y0, h]) => opening({ u0: (w.x0 + w.x1) / 2 + sgn * half * 0.45 - 0.7, u1: (w.x0 + w.x1) / 2 + sgn * half * 0.45 + 0.7, y0, y1: y0 + h })));
    const top = gableRoof ? [[w.x1 - T, wingTop(w.x1 - T) + 0.35], [(w.x0 + w.x1) / 2, wingTop((w.x0 + w.x1) / 2) + 0.35], [w.x0 + T, wingTop(w.x0 + T) + 0.35]] : null;
    wall(b, wfE, { id: id + '-end', group: 'wings', material: wallMat, u0: w.x0 + T, u1: w.x1 - T, y0: 0, y1: plate + 0.05, top: top ?? undefined, thickness: T, openings: endWins });
    endWins.forEach((o, k) => glazedOpening(b, wfE, o, { id: id + '-end-window-' + (k + 1), group: 'wings', frame: 'frame', glass: 'glass', sill: 'dressing', recess: 0.25, mullions: 1, transoms: [o.top - 0.6] }));
    for (const [name, y0, y1] of [['plinth', 0, plinthTop], ['course', scY, scY + 0.28]]) {
      band(b, wfE, { id: id + '-' + name + '-end', group: 'wings', material: 'dressing', u0: w.x0 - BAND_PROUD, u1: w.x1 + BAND_PROUD, y0, y1, proud: BAND_PROUD, embed: 0.05 });
    }
    const roofZ0 = gableRoof ? w.zr + T - 0.04 : w.zr - ov;
    w.roof = wingRoof(b, { id: id + '-roof', group: 'wings', material: 'roof', x0: w.x0 - ov, x1: w.x1 + ov, z0: roofZ0, z1: -Dm / 2, soffit: plate + 0.03, fascia: FASCIA, pitch,
      rear: gableRoof ? 'gable' : 'hip' });
    if (gableRoof) {
      const xs = [w.x0 - 0.08, (w.x0 + w.x1) / 2, w.x1 + 0.08], prof = xs.map(x => [x, wingTop(Math.min(w.x1, Math.max(w.x0, x))) + 0.3]);
      b.prismZ(id + '-coping', 'wings', 'dressing', [...prof, ...[...prof].reverse().map(([x, y]) => [x, y + 0.2])], w.zr - 0.05, w.zr + T + 0.05);
    }
  }

  // ---- windows -------------------------------------------------------------------------------------
  // Frames sit 25 cm back in the 45 cm walls: beyond the walls' own tolerance (0.6 x 0.3 m),
  // so a model without the walls does not recall them from the window frames.
  const win = { frame: 'frame', glass: 'glass', sill: 'dressing', recess: 0.25, frameWidth: 0.08, frameDepth: 0.12, mullions: 1 };
  frontWins.forEach((o, k) => {
    glazedOpening(b, wfF, o, { ...win, id: 'front-window-' + (k + 1), group: 'front.windows', transoms: [o.top - 0.6] });
    lintel(b, wfF, o, { id: 'front-window-' + (k + 1) + '.head', group: 'front.windows', material: 'dressing', height: 0.3, overhang: 0.15, proud: 0.06 });
  });
  rear.filter(o => o !== service).forEach((o, k) => glazedOpening(b, wfB, o, { ...win, id: 'rear-window-' + (k + 1), group: 'windows', transoms: [o.top - 0.6] }));
  if (service) {
    doorOpening(b, wfB, service, { id: 'service-door', group: 'windows', frame: 'frame', leaf: 'door', glass: 'glass', metal: 'metal', style: 'panel', leaves: 2 });
    const n = Math.max(2, Math.round(yf / 0.17));
    for (let k = 1; k <= n; k++) wfB.box(b, 'service-step-' + k, 'windows', 'dressing', service.u0 - 0.3, service.u1 + 0.3, 0, (yf - 0.02) * (n - k + 1) / n, -k * 0.3, -(k - 1) * 0.3 + (k === 1 ? 0.02 : 0));
  }
  for (const [side, wf] of [[-1, wfL], [1, wfR]]) ends[side].forEach((o, k) => glazedOpening(b, wf, o, { ...win, id: 'end-window-' + (side < 0 ? 'l' : 'r') + (k + 1), group: 'windows', transoms: [o.top - 0.6] }));

  // ---- portico ---------------------------------------------------------------------------------------
  doorOpening(b, wfF, door, { id: 'main-door', group: 'portico', frame: 'dressing', leaf: 'door', glass: 'glass', metal: 'metal', style: 'panel', leaves: 2, fanlight: 0.9,
    recess: 0.2, frameWidth: 0.12, frameDepth: 0.14 });
  const px0 = -pw / 2, px1 = pw / 2, colH = hg - 0.2, eb = yf + colH, cr = pc.diameter / 2, cz = pd - 0.15 - cr - 0.12;
  b.box('portico-floor', 'portico', 'dressing', [px0, 0, -0.05], [px1, yf - 0.02, pd]);
  const nSteps = Math.max(3, Math.round(yf / 0.16));
  for (let k = 1; k <= nSteps; k++) {
    // Adjacent blocks stepping down from the floor, so no two share a face.
    b.box('portico-step-' + k, 'portico', 'dressing', [px0 + 0.2, 0, pd + (k - 1) * 0.34 - (k === 1 ? 0.02 : 0)], [px1 - 0.2, (yf - 0.02) * (nSteps - k + 1) / (nSteps + 1), pd + k * 0.34]);
  }
  const colXs = [...Array(cols).keys()].map(k => -(cols - 1) / 2 * pc.spacing + k * pc.spacing);
  for (const [k, x] of colXs.entries()) {
    b.box('column-' + (k + 1) + '-base', 'portico', 'dressing', [x - cr - 0.12, yf - 0.04, cz - cr - 0.12], [x + cr + 0.12, yf + 0.25, cz + cr + 0.12]);
    b.cylinder('column-' + (k + 1), 'portico', 'dressing', [x, yf + 0.23, cz], colH - 0.23 - 0.3 + 0.02, cr, { top: cr * 0.88, segments: 20 });
    b.box('column-' + (k + 1) + '-capital', 'portico', 'dressing', [x - cr - 0.1, eb - 0.32, cz - cr - 0.1], [x + cr + 0.1, eb + 0.02, cz + cr + 0.1]);
  }
  // Entablature, then a pediment or a flat top with a blocking course.
  b.box('portico-entablature', 'portico', 'dressing', [px0 - 0.15, eb, -0.06], [px1 + 0.15, eb + 0.95, pd + 0.15]);
  let porticoTop;
  if (pc.top === 'pediment') {
    const pp = pc.pitch * DEG, info = gableRoofZ(b, { id: 'portico-roof', group: 'portico', material: 'roof', z0: -0.08, z1: pd + 0.3, xRidge: 0, halfWidth: pw / 2 + 0.15,
      plate: eb + 0.97, pitch: pp, overhang: 0.2, thickness: 0.2 });
    // Tympanum just behind the roof's front edge, its sloped top 3 cm up inside the slab.
    const tp = Math.tan(pp), base = eb + 0.93, hw = pw / 2 + 0.1;
    b.prismZ('portico-tympanum', 'portico', 'dressing', [[-hw, base], [hw, base], [hw, eb + 0.97 + 0.05 * tp + 0.03], [0, eb + 0.97 + (pw / 2 + 0.15) * tp + 0.03], [-hw, eb + 0.97 + 0.05 * tp + 0.03]],
      pd - 0.05, pd + 0.1);
    porticoTop = { ridge: info.ridgeTop, slope: x => info.top(Math.abs(x)) };
  } else {
    b.box('portico-blocking', 'portico', 'dressing', [px0 - 0.05, eb + 0.93, -0.06], [px1 + 0.05, eb + 1.45, pd + 0.05]);
    porticoTop = { ridge: eb + 1.45, slope: () => eb + 1.45 };
  }

  // ---- cupola ---------------------------------------------------------------------------------------
  let cupolaInfo = null;
  if (p.cupola) {
    b.group('cupola', 'Cupola / clock turret on the main ridge', 'roof', 0.15, 'roof');
    const c = p.cupola, cw = c.width, ridge = roofInfo.ridgeTop, cz0 = -Dm / 2, y0 = ridge + 0.5, y1 = y0 + c.height;
    b.box('cupola-base', 'cupola', 'roof', [-cw / 2 - 0.3, ridge - 1.4, cz0 - cw / 2 - 0.3], [cw / 2 + 0.3, y0 + 0.02, cz0 + cw / 2 + 0.3]);
    if (c.shape === 'square') b.box('cupola-drum', 'cupola', 'dressing', [-cw / 2, y0, cz0 - cw / 2], [cw / 2, y1, cz0 + cw / 2]);
    else b.cylinder('cupola-drum', 'cupola', 'dressing', [0, y0, cz0], c.height, cw / 2 / Math.cos(Math.PI / 8), { segments: 8, yaw: Math.PI / 8 });
    // The drum's flats face the axes, so the faces sit at the half width.
    const face = cw / 2;
    if (c.clock) for (const [k, dir] of [[1, 1], [2, -1]]) {
      b.add({ id: 'cupola-clock-' + k, type: 'cylinder', radius: cw * 0.3, height: 0.14, segments: 32, position: [0, (y0 + y1) / 2 + 0.1, cz0 + dir * (face + 0.05)], rotation: [Math.PI / 2, 0, 0], material: 'clock', group: 'cupola' });
    }
    else for (const [k, dir] of [[1, 1], [2, -1]]) b.box('cupola-louvre-' + k, 'cupola', 'metal', [-cw * 0.25, y0 + 0.4, cz0 + dir * (face - 0.02)], [cw * 0.25, y1 - 0.4, cz0 + dir * (face + 0.06)]);
    b.box('cupola-cornice', 'cupola', 'dressing', [-cw / 2 - 0.15, y1 - 0.02, cz0 - cw / 2 - 0.15], [cw / 2 + 0.15, y1 + 0.25, cz0 + cw / 2 + 0.15]);
    let peak;
    if (c.top === 'dome') {
      const R = cw / 2, prof = [];
      for (let i = 0; i <= 8; i++) { const a = i / 8 * Math.PI / 2; prof.push([R * Math.cos(a), y1 + 0.23 + R * 0.9 * Math.sin(a)]); }
      prof.unshift([0, y1 + 0.23]);
      b.lathe('cupola-dome', 'cupola', 'copper', prof.map(([rr, y], i) => i === prof.length - 1 ? [0, y] : [rr, y]), [0, 0, cz0], { segments: 32 });
      peak = y1 + 0.23 + R * 0.9;
    } else {
      b.cylinder('cupola-roof', 'cupola', 'copper', [0, y1 + 0.23, cz0], cw * 0.75, (cw / 2 + 0.1) * Math.SQRT2, { top: 0, segments: 4, yaw: Math.PI / 4 });
      peak = y1 + 0.23 + cw * 0.75;
    }
    b.beam('cupola-finial', 'cupola', 'metal', [0, peak - 0.2, cz0], [0, peak + 1.2, cz0], 0.04, 8);
    cupolaInfo = { cw, cz0, y0, y1, peak, shape: c.shape, top: c.top };
  }

  // ---- chimneys ----------------------------------------------------------------------------------------
  if (p.chimneys) {
    b.group('chimneys', 'Chimney stacks', 'roof', 0.15, 'roof');
    for (const [k, sx] of [[1, -1], [2, 1]]) {
      const x = sx * Lm * 0.32, z = -Dm / 2 - 1.1, top = roofInfo.ridgeTop + 1.1;
      b.box('chimney-' + k, 'chimneys', wallMat, [x - 0.6, plate + 0.3, z - 0.4], [x + 0.6, top, z + 0.4]);
      b.box('chimney-' + k + '-cap', 'chimneys', 'dressing', [x - 0.68, top - 0.04, z - 0.48], [x + 0.68, top + 0.12, z + 0.48]);
    }
  }

  // ---- escape stair ---------------------------------------------------------------------------------------
  let stairInfo = null;
  if (st.built) {
    b.group('escape.stair', 'External escape stair and fire door', 'structure', 0.06, es < 0 ? 'left' : 'right');
    const wfE = es < 0 ? wfL : wfR, H = upperFloor, w = 1.0;
    doorOpening(b, wfE, fireDoor, { id: 'fire-door', group: 'escape.stair', frame: 'frame', leaf: 'door', glass: 'glass', metal: 'metal', style: 'boarded', leaves: 2 });
    // Out from the wall face (w < 0): top landing at the door, a flight towards the
    // front close to the wall, a half landing, a flight back on the outer line.
    const outX = d => es * (Lm / 2 + d);
    const zTop = -fireU;                                               // top landing spans z in zTop +- 0.7
    const zHalf0 = zTop + 0.7 + run, zHalf1 = zHalf0 + 1.2;            // half landing along z
    const yHalf = H / 2;
    const box = (id, d0, d1, y0, y1, z0, z1) => b.box(id, 'escape.stair', 'steel', [Math.min(outX(d0), outX(d1)), y0, Math.min(z0, z1)], [Math.max(outX(d0), outX(d1)), y1, Math.max(z0, z1)]);
    box('stair-landing-top', -0.05, 1.15, H - 0.14, H - 0.02, zTop - 0.7, zTop + 0.7);
    box('stair-landing-half', 0.05, 2.35, yHalf - 0.12, yHalf, zHalf0, zHalf1);
    const flight = (id, d0, d1, zFrom, zTo, yFrom, yTo) => {
      const risers = Math.max(2, Math.round(Math.abs(yTo - yFrom) / 0.18)), dz = (zTo - zFrom) / risers;
      for (let k = 1; k < risers; k++) {
        const y = yFrom + (yTo - yFrom) * k / risers, za = zFrom + dz * (k - 0.5), zb = zFrom + dz * (k + 0.5);
        box(id + '-tread-' + k, d0 + 0.08, d1 - 0.08, y - 0.04, y, za + Math.sign(dz) * 0.01, zb - Math.sign(dz) * 0.01);
      }
      for (const [j, d] of [[1, d0 + 0.04], [2, d1 - 0.04]]) b.beam(id + '-stringer-' + j, 'escape.stair', 'steel', [outX(d), yFrom + 0.02, zFrom], [outX(d), yTo - 0.06, zTo], 0.045, 8);
    };
    // Flight A: from the top landing down to the half landing, near the wall.
    flight('stair-flight-a', 0.15, 0.15 + w, zTop + 0.7, zHalf0, H - 0.08, yHalf + 0.02);
    // Flight B: from the half landing down to the ground, on the outer line, back towards the rear.
    flight('stair-flight-b', 1.3, 1.3 + w, zHalf0, zHalf0 - run, yHalf - 0.06, 0.02);
    for (const [k, d, z] of [[1, 1.1, zTop - 0.62], [2, 2.3, zHalf1 - 0.08], [3, 0.12, zHalf1 - 0.08]]) {
      b.beam('stair-post-' + k, 'escape.stair', 'steel', [outX(d), 0, z], [outX(d), (k === 1 ? H : yHalf) - 0.13, z], 0.05, 10);
    }
    railing(b, { id: 'stair-rail-top', group: 'escape.stair', material: 'steel', points: [[outX(1.12), H - 0.02, zTop - 0.68], [outX(1.12), H - 0.02, zTop + 0.68]], height: 1.05, spacing: 1.3, radius: 0.025 });
    railing(b, { id: 'stair-rail-half', group: 'escape.stair', material: 'steel', points: [[outX(2.32), yHalf, zHalf0 + 0.05], [outX(2.32), yHalf, zHalf1 - 0.04], [outX(0.1), yHalf, zHalf1 - 0.04]], height: 1.05, spacing: 1.3, radius: 0.025 });
    railing(b, { id: 'stair-rail-flight', group: 'escape.stair', material: 'steel', points: [[outX(2.32), yHalf, zHalf0], [outX(2.32), 0, zHalf0 - run]], height: 1.0, spacing: 1.6, radius: 0.025 });
    stairInfo = { zTop, zHalf0, zHalf1, run, H };
  }

  // ---- probes ------------------------------------------------------------------------------------------
  // Front wall between ground windows (bay boundaries), outside the portico.
  for (const k of [1, nb - 1, 2, nb - 2]) {
    const x = -Lm / 2 + k * bw;
    if (Math.abs(x) > pw / 2 + 0.6) b.probe('front-wall', 'Position of the main front wall', [x, yf + 1.6, 80], [0, 0, -1]);
  }
  // Rear wall between windows away from the wings, and each wing's end wall.
  for (let k = 0; k + 1 < nb; k++) {
    const x = -Lm / 2 + (k + 1) * bw;
    if (inWing(x - 0.4, x + 0.4) || (service && Math.abs(x - (service.u0 + service.u1) / 2) < 1.5)) continue;
    b.probe('rear-wall', 'Position of the main rear wall', [x, yf + 1.6, -120], [0, 0, 1]);
  }
  for (const w of wings) {
    const x = (w.x0 + w.x1) / 2;
    // Between the two columns of end windows; the ray meets the main rear wall when the wing is absent.
    b.probe('wing-' + (w.k + 1) + '-end', 'Position of the end wall of wing ' + (w.k + 1), [x, yf + 1.4, -120], [0, 0, 1]);
    b.probe('wing-' + (w.k + 1) + '-roof', 'Height of the roof of wing ' + (w.k + 1), [x + w.width * 0.22, 120, w.zr + w.length * 0.35], [0, -1, 0]);
  }
  for (const side of [-1, 1]) {
    const name = side < 0 ? 'left' : 'right';
    // Piers between the end windows; on the stair side only the stretch in front of the stair.
    const us0 = [...Array(nE - 1).keys()].map(k => Dm * (k + 1) / nE).filter(u => !(side === es && stairInfo) || u < -stairInfo.zHalf1 - 0.6 && u > 0.6);
    for (const u of us0) b.probe('end-' + name, 'Position of the ' + name + ' end wall', [side * 120, yf + 1.6, -u], [-side, 0, 0]);
    if (side === es && stairInfo) for (const u of [Dm * 0.12, 0.9]) b.probe('end-' + name, 'Position of the ' + name + ' end wall', [side * 120, yf + 1.6, -u], [-side, 0, 0]);
  }
  const roofX = Lm * 0.18;
  for (const x of [roofX, -roofX]) {
    if (cupolaInfo && Math.abs(x) < cupolaInfo.cw / 2 + 1.0) continue;
    if (p.chimneys && Math.abs(Math.abs(x) - Lm * 0.32) < 1.4) continue;
    b.probe('roof-front', 'Height of the main roof, front slope', [x, 120, -Dm * 0.22], [0, -1, 0]);
    if (!inWing(x - Dm / 2, x + Dm / 2)) b.probe('roof-rear', 'Height of the main roof, rear slope', [x, 120, -Dm * 0.78], [0, -1, 0]);
  }
  if (cupolaInfo) {
    // A pyramid facet is flat enough to measure from above; a dome is not, so a
    // domed cupola is measured on its drum from the side.
    if (cupolaInfo.top === 'pyramid') for (const f of [0.25, 0.3]) b.probe('cupola', 'Height of the cupola roof', [0.05, 120, cupolaInfo.cz0 + cupolaInfo.cw * f], [0, -1, 0]);
    else b.probe('cupola', 'Position of the cupola drum', [120, (cupolaInfo.y0 + cupolaInfo.y1) / 2, cupolaInfo.cz0], [-1, 0, 0]);
  }
  if (pc.top === 'pediment') for (const f of [0.5, 0.3]) b.probe('portico-roof', 'Height of the portico pediment roof', [pw * f * 0.5, 120, pd * 0.55], [0, -1, 0]);
  else b.probe('portico-roof', 'Height of the portico top', [pw * 0.25, 120, pd * 0.5], [0, -1, 0]);
  b.probe('portico-front', 'Position of the portico entablature', [pw * 0.25, eb + 0.48, 80], [0, 0, -1]);

  // ---- dimensions -------------------------------------------------------------------------------------
  b.dimension('front-length', 'Length of the main front', [-Lm / 2, 0, 0], [Lm / 2, 0, 0], 'front');
  // Drawn on the right elevation, which otherwise carries no dimension.
  b.dimension('main-depth', 'Depth of the main range', [Lm / 2, 0, 0], [Lm / 2, 0, -Dm], 'right');
  b.dimension('eaves-height', 'Height to the underside of the eaves', [-Lm / 2, 0, 0], [-Lm / 2, plate, 0], 'front');
  b.dimension('ridge-height', 'Height to the top of the main roof', [0, 0, 0], [0, roofInfo.ridgeTop, 0], 'front');
  const lw = [...wings].sort((a, c) => c.length - a.length)[0];
  if (lw.built) {
    b.dimension('wing-length', 'Projection of the ' + (wings.length > 1 ? 'longer ' : '') + 'wing behind the main range', [lw.x1, 0, -Dm], [lw.x1, 0, lw.zr], 'plan');
    b.dimension('wing-width', 'Width of the ' + (wings.length > 1 ? 'longer ' : '') + 'wing', [lw.x0, 0, lw.zr], [lw.x1, 0, lw.zr], 'plan');
  }
  b.dimension('portico-projection', 'Projection of the portico floor', [px1, 0, 0], [px1, 0, pd], 'plan');
  b.dimension('portico-width', 'Width of the portico floor', [px0, 0, pd], [px1, 0, pd], 'front');
  b.dimension('bay-spacing', 'Window bay spacing on the front', [frontWins[0].u0, frontWins[0].y0, 0], [frontWins[0].u0 + bw, frontWins[0].y0, 0], 'front');
  b.dimension('window-width', 'Width of a ground-floor front window', [frontWins[0].u0, frontWins[0].y0, 0], [frontWins[0].u1, frontWins[0].y0, 0], 'front');
  if (cupolaInfo) b.dimension('cupola-height', 'Height to the top of the cupola cornice', [cupolaInfo.cw / 2 + 0.15, 0, 0], [cupolaInfo.cw / 2 + 0.15, cupolaInfo.y1 + 0.25, 0], 'front');
  b.dimensions.splice(12);

  return {
    builder: b,
    // The plan shape stays out of the title: an earlier state without its wing has
    // another plan, and stale drawings print the same title.
    title: 'Two-storey civic building with a portico',
    frame: {
      origin: 'On the ground at the midpoint of the main front wall; that wall face is the plane z = 0, the main range extends towards -Z and the wings behind it.',
      front: 'The main front, with the portico and the main doors, faces +Z; +X is to the right when you look at the front.',
    },
    scope_note: 'The building exterior only: walls, plinth and string course, roofs, wings, windows and doors, the entrance portico and its steps, the cupola, chimneys ' +
      'and the escape stair where present. No ground plane, forecourt, railings, flagpoles, statues, trees, vehicles or neighbouring buildings.',
    probeOrder: [...wings.map(w => 'wing-' + (w.k + 1) + '-end'), 'cupola', ...wings.map(w => 'wing-' + (w.k + 1) + '-roof'), 'front-wall', 'rear-wall', 'end-left', 'end-right',
      'roof-front', 'roof-rear', 'portico-roof', 'portico-front'],
    structure: { plan: M.plan, roof: M.roof, bays: nb, wings: builtWings.length, columns: cols, portico: pc.top, cupola: cupolaInfo ? cupolaInfo.shape + '-' + cupolaInfo.top : null,
      stair: es, chimneys: !!p.chimneys },
  };
}

export const edits = [
  {
    // The longer wing (the only one on an L or T plan) was added later.
    id: 'no-wing', scope: ['wings'], applies: p => p.wings.every(w => w.built),
    apply: p => {
      const k = p.wings.length > 1 && p.wings[1].length > p.wings[0].length ? 1 : 0;
      return { ...p, wings: p.wings.map((w, i) => i === k ? { ...w, built: false } : w) };
    },
    phrase: 'the rear wing had not been built',
  },
  { id: 'no-cupola', scope: ['cupola'], applies: (p, s) => !!s.cupola, apply: p => ({ ...p, cupola: null }), phrase: 'there was no cupola on the roof' },
  { id: 'no-escape-stair', scope: ['escape.stair', 'body', 'base'], applies: p => p.stair.built, apply: p => ({ ...p, stair: { ...p.stair, built: false } }),
    phrase: 'the external escape stair and its fire door had not been added' },
];

export default { id: 'civic', sample, build, edits };
