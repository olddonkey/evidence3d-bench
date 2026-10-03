// Long-span industrial shed: a portal-frame building whose frame lines show as
// cover strips on the long walls, a masonry dado under profiled cladding, and a
// low-pitched, monitor (raised clerestory) or sawtooth roof. Roller shutters and
// a gable louvre in the front gable, a raised loading dock with an optional
// canopy on one long side, a lean-to office block on the other, an external stair
// to a mezzanine door on the rear gable, rooflights and ridge ventilators, and an
// optional sprinkler tank. Plan, roof form and attachments change with the seed.
//
// Frame: the front gable wall face is z = 0, the shed runs back to z = -L and is
// W wide, centred on x = 0.
import {
  ModelBuilder, wallFrame, wall, opening, glazedOpening, doorOpening, louvreOpening, gableRoofZ, band, railing, ladder, draw, DEG,
} from '../kit.mjs';

const T = 0.25;           // cladding wall (sheeting, rails and lining as one solid)
const DADO_PROUD = 0.12;  // the masonry dado stands this far in front of the cladding
const STRIP_PROUD = 0.2;  // frame-line cover strips stand this far in front of the cladding

// Cladding is painted steel: the 'frame' kind renders as smooth paint, which is
// what profiled sheeting reads as at photograph distance ('metal' renders bare).
const PALETTES = [
  { cladding: '#9aa3a6', block: '#8f8b84', roof: '#6c7376', trim: '#3b4246', shutter: '#c9cccd', office: '#b9b3a7', brick: false, tank: '#7d8f86' },
  { cladding: '#5f7468', block: '#9a958c', roof: '#53595c', trim: '#2c3133', shutter: '#d7d9d6', office: '#a8664f', brick: true, tank: '#9aa0a3' },
  { cladding: '#c9c6bd', block: '#7c7a75', roof: '#7d8487', trim: '#2f4f6b', shutter: '#2f4f6b', office: '#d9d3c5', brick: false, tank: '#b5372f' },
  { cladding: '#46607a', block: '#a39e94', roof: '#5f6669', trim: '#e3e3df', shutter: '#e3e3df', office: '#8c5546', brick: true, tank: '#c8cbc9' },
];

export function sample(r) {
  const m = r.fork('massing');
  const bays = m.int(5, 9), bayLen = draw(m, 5.5, 7.5, 0.25), width = draw(m, 16, 30, 0.5);
  const roof = m.pick(['gable', 'gable', 'monitor', 'sawtooth']);
  const massing = {
    bays, bayLen, width, eaves: draw(m, 5.8, 8.6), roof, pitch: draw(m, 6, 12, 0.5), overhang: draw(m, 0.25, 0.45), dado: draw(m, 1.6, 2.4),
    monitor: { width: draw(m, 0.28, 0.42, 0.01), rise: draw(m, 1.3, 2.1), inset: m.int(0, 1) },
    sawtooth: { teeth: width >= 24 ? m.int(4, 5) : m.int(3, 4), pitch: draw(m, 20, 27, 1), glazing: m.pick([-1, 1]) },
  };
  const f = r.fork('front');
  const front = { shutters: width >= 24 ? f.int(1, 3) : f.int(1, 2), shutterW: draw(f, 3.6, 5.0), shutterH: draw(f, 4.2, 5.4),
    doorSide: f.pick([-1, 1]), louvre: f.chance(0.7), hood: f.chance(0.6) };
  const s = r.fork('sides');
  // The office sits on one long side near the front, the dock on the other. Both
  // zones are fixed here even when nothing is built in them, so an earlier state
  // keeps the same long walls.
  const office = { side: s.pick([-1, 1]), bays: s.int(1, 2), setback: draw(s, 0.5, 0.42 * bayLen), depth: draw(s, 4.5, 7.0), storey: draw(s, 3.0, 3.3),
    roof: s.pick(['flat', 'mono']), built: true };
  const dockBays = Math.min(s.int(2, 3), bays - 3);
  const dock = { bays: dockBays, first: s.int(1, bays - 2 - dockBays), height: draw(s, 1.15, 1.25), depth: draw(s, 2.6, 3.4),
    doorW: draw(s, 2.8, 3.0), doorH: draw(s, 3.0, 3.3), canopy: s.chance(0.7), canopyDepth: draw(s, 3.6, 4.6) };
  const o = r.fork('options');
  const stair = { side: o.pick([-1, 1]), height: draw(o, 3.0, 4.0) };
  // The tank stands beside the last bay of the building as generated; an earlier,
  // shorter state leaves it where it is.
  const tank = o.chance(0.6) ? { radius: draw(o, 2.0, 2.6), height: draw(o, 5.0, 8.0) } : null;
  if (tank) tank.u = bays * bayLen - tank.radius - 1.4;
  return { massing, front, office, dock, stair, tank, roofLights: o.chance(0.8), vents: o.int(2, 4), sideWindows: o.chance(0.75),
    palette: r.fork('palette').int(0, PALETTES.length - 1) };
}

// Clips a wall-top polyline (points from the right end to the left end) to [u0, u1].
function clipTop(points, u0, u1) {
  const at = u => {
    for (let i = 0; i + 1 < points.length; i++) {
      const [ua, ya] = points[i], [ub, yb] = points[i + 1];
      if ((u <= ua && u >= ub) && ua !== ub) return ya + (yb - ya) * (u - ua) / (ub - ua);
    }
    return points.find(p => Math.abs(p[0] - u) < 1e-9)?.[1] ?? points[0][1];
  };
  return [[u1, at(u1)], ...points.filter(([u]) => u < u1 - 1e-6 && u > u0 + 1e-6), [u0, at(u0)]];
}

export function build(p) {
  const b = new ModelBuilder(), M = p.massing, pal = PALETTES[p.palette];
  const W = M.width, L = M.bays * M.bayLen, He = M.eaves, ov = M.overhang, bl = M.bayLen, tan = Math.tan(M.pitch * DEG);
  const s = p.office.side, ds = -s;               // office side, dock side
  const sideName = x => x < 0 ? 'left' : 'right';
  b.material('cladding', pal.cladding, 'frame', { roughness: 0.55, metalness: 0.2 });
  b.material('block', pal.block, 'concrete', { roughness: 0.9 });
  b.material('roof', pal.roof, 'roof', { roughness: 0.7 });
  b.material('trim', pal.trim, 'frame', { roughness: 0.45, metalness: 0.3 });
  b.material('shutter', pal.shutter, 'metal', { roughness: 0.5, metalness: 0.4 });
  b.material('glass', '#34474f', 'glass', { roughness: 0.05 });
  b.material('frame', '#d8d9d6', 'frame', { roughness: 0.4 });
  b.material('concrete', '#a9a69e', 'concrete', { roughness: 0.9 });
  // A material key containing 'brick' is rendered with brick coursing.
  const officeMat = b.material(pal.brick ? 'office-brick' : 'office-render', pal.office, 'wall', { roughness: 0.9 });
  b.material('coping', '#a3a099', 'stone', { roughness: 0.8 });
  b.material('steel', '#4a4f54', 'metal', { roughness: 0.4, metalness: 0.7 });
  b.material('rail', '#d6b11f', 'metal', { roughness: 0.5, metalness: 0.2 });
  b.material('rubber', '#1e1f20', 'frame', { roughness: 0.9 });
  b.material('tank', pal.tank, 'metal', { roughness: 0.45, metalness: 0.5 });
  b.material('door', '#4a4f55', 'metal', { roughness: 0.5, metalness: 0.4 });

  b.group('body', 'Cladding walls, masonry dado and rear door', 'massing', 0.3, 'all');
  b.group('roof', 'Main roof (' + M.roof + ')', 'roof', 0.3, 'roof');
  b.group('frames', 'Frame-line cover strips on the long walls', 'structure', 0.15, 'all');
  b.group('front.doors', 'Roller shutters, personnel door and gable louvre', 'entrance', 0.12, 'front');
  b.group('dock', 'Raised loading dock, dock doors and shelters', 'openings', 0.12, sideName(ds));
  b.group('stair', 'External stair and mezzanine door on the rear', 'structure', 0.06, 'rear');

  // ---- roof form (decides the wall tops) --------------------------------------------
  let sawtooth = null;
  // Wall-top outline across the width from x = +W/2 to -W/2, at the roof underside.
  let underline;
  if (M.roof === 'sawtooth') {
    const n = M.sawtooth.teeth, tw = W / n, g = M.sawtooth.glazing, sp = M.sawtooth.pitch * DEG, rise = tw * Math.tan(sp);
    // Tooth k spans [a, c]; its slope rises towards the glazed side g.
    const teeth = [...Array(n).keys()].map(k => ({ a: -W / 2 + k * tw, c: -W / 2 + (k + 1) * tw }));
    const heightAt = x => {
      const k = Math.min(n - 1, Math.max(0, Math.floor((x + W / 2) / tw))), t = (x - teeth[k].a) / tw;
      return He + rise * (g > 0 ? t : 1 - t);
    };
    sawtooth = { n, tw, g, sp, rise, teeth, heightAt, tvv: 0.22 / Math.cos(sp) };
    const pts = [];
    for (let k = n - 1; k >= 0; k--) {
      const { a, c } = teeth[k];
      // Underside from the right end of the tooth to its left end; the vertical drop
      // at the glazed edge comes from the neighbouring tooth's first point.
      pts.push(...(g > 0 ? [[c, He + rise], [a, He]] : [[c, He], [a, He + rise]]));
    }
    underline = pts.filter((q, i) => i === 0 || Math.abs(q[0] - pts[i - 1][0]) > 1e-9 || Math.abs(q[1] - pts[i - 1][1]) > 1e-9);
  } else {
    underline = [[W / 2, He], [0, He + W / 2 * tan], [-W / 2, He]];
  }
  const lowSide = sawtooth ? -sawtooth.g : -1;
  // Height of the side walls; the high side of a sawtooth stops under its last slab.
  const sideTop = { [-1]: He, [1]: He };
  if (sawtooth) sideTop[sawtooth.g] = He + sawtooth.rise - 0.1;

  // ---- walls -------------------------------------------------------------------
  const wfF = wallFrame('z', 1, 0), wfB = wallFrame('z', -1, -L), wfL = wallFrame('x', -1, -W / 2), wfR = wallFrame('x', 1, W / 2);
  const wfD = ds < 0 ? wfL : wfR;
  const gableTop = clipTop(underline.map(([x, y]) => [x, y + 0.05]), -W / 2 + T, W / 2 - T);

  // Front gable: shutters in the part of the wall away from the personnel door.
  const nS = p.front.shutters, ds0 = p.front.doorSide;
  const zone = ds0 > 0 ? [-W / 2 + 1.2, W / 2 - 2.6] : [-W / 2 + 2.6, W / 2 - 1.2], slot = (zone[1] - zone[0]) / nS;
  const sw = Math.min(p.front.shutterW, slot - 1.4), sh = Math.min(p.front.shutterH, He - 1.3);
  const shutters = [...Array(nS).keys()].map(k => { const xc = zone[0] + slot * (k + 0.5); return opening({ u0: xc - sw / 2, u1: xc + sw / 2, y0: 0, y1: sh }); });
  const pdX = ds0 * (W / 2 - 1.3), pdoor = opening({ u0: pdX - 0.5, u1: pdX + 0.5, y0: 0, y1: 2.2 });
  const louvreTop = He + Math.min(1.5, W / 2 * tan - 0.9);
  const louvre = p.front.louvre && !sawtooth && louvreTop - (He + 0.25) > 0.5 ? opening({ u0: -0.9, u1: 0.9, y0: He + 0.25, y1: louvreTop }) : null;
  wall(b, wfF, { id: 'wall-front', group: 'body', material: 'cladding', u0: -W / 2 + T, u1: W / 2 - T, y0: 0, top: gableTop, thickness: T,
    openings: [...shutters, pdoor, ...(louvre ? [louvre] : [])] });
  // Rear gable: a personnel door and the mezzanine door the stair serves.
  const st = p.stair, hm = st.height, sx = st.side * W * 0.28, rearDoorX = -st.side * W * 0.3;
  // Wall frames along Z use u = x on the rear wall too.
  const mezz = opening({ u0: sx - 0.5, u1: sx + 0.5, y0: hm, y1: hm + 2.15 });
  const rearDoor = opening({ u0: rearDoorX - 0.5, u1: rearDoorX + 0.5, y0: 0, y1: 2.2 });
  wall(b, wfB, { id: 'wall-rear', group: 'body', material: 'cladding', u0: -W / 2 + T, u1: W / 2 - T, y0: 0, top: gableTop, thickness: T, openings: [rearDoor, mezz] });

  // Long walls. Zones are fixed by the parameters whether or not anything is built
  // in them: office on side s near the front, dock doors on side ds. u = -z.
  const officeU = [p.office.setback, (p.office.bays + 0.5) * bl];
  const dockU = [p.dock.first * bl, (p.dock.first + p.dock.bays) * bl];
  const dh = p.dock.height, ddH = Math.min(p.dock.doorH, He - dh - 1.9);
  const dockDoors = [];
  for (let k = p.dock.first; k < p.dock.first + p.dock.bays; k++) {
    const uc = (k + 0.5) * bl;
    // Sill 3 cm above the platform, so the platform top is not the opening's floor.
    dockDoors.push(opening({ u0: uc - p.dock.doorW / 2, u1: uc + p.dock.doorW / 2, y0: dh + 0.03, y1: dh + 0.03 + ddH }));
  }
  const dado = M.dado;
  const winY0 = Math.max(dado + 0.8, He - 2.1), winY1 = Math.min(winY0 + 1.1, He - 0.5);
  const sideWins = { [-1]: [], [1]: [] };
  if (p.sideWindows && winY1 - winY0 >= 0.6) {
    for (const side of [-1, 1]) for (let k = 0; k < M.bays; k++) {
      const uc = (k + 0.5) * bl, half = Math.min(1.8, bl / 2 - 0.9);
      if (side === s && uc - half < officeU[1] + 0.8) continue;
      if (side === ds && uc + half > dockU[0] - 1.2 && uc - half < dockU[1] + 1.2) continue;
      sideWins[side].push(opening({ u0: uc - half, u1: uc + half, y0: winY0, y1: winY1 }));
    }
  }
  for (const [side, wf] of [[-1, wfL], [1, wfR]]) {
    wall(b, wf, { id: 'wall-' + sideName(side), group: 'body', material: 'cladding', u0: 0, u1: L, y0: 0, y1: sideTop[side] + 0.05, thickness: T,
      openings: [...sideWins[side], ...(side === ds ? dockDoors : [])] });
  }
  // Masonry dado: front and rear bands wrap the corners, side bands stop at them.
  // On the dock side it stops clear of the shelters round the dock doors.
  const gap = (o, e = 0.05) => [o.u0 - e, o.u1 + e];
  band(b, wfF, { id: 'dado-front', group: 'body', material: 'block', u0: -W / 2 - DADO_PROUD, u1: W / 2 + DADO_PROUD, y0: 0, y1: dado, proud: DADO_PROUD, embed: 0.1,
    gaps: [...shutters, pdoor].map(o => gap(o)) });
  band(b, wfB, { id: 'dado-rear', group: 'body', material: 'block', u0: -W / 2 - DADO_PROUD, u1: W / 2 + DADO_PROUD, y0: 0, y1: dado, proud: DADO_PROUD, embed: 0.1,
    gaps: [gap(rearDoor)] });
  for (const [side, wf] of [[-1, wfL], [1, wfR]]) {
    band(b, wf, { id: 'dado-' + sideName(side), group: 'body', material: 'block', u0: 0.1, u1: L - 0.1, y0: 0, y1: dado, proud: DADO_PROUD, embed: 0.1,
      gaps: side === ds ? dockDoors.map(o => gap(o, 0.42)) : [] });
  }
  if (p.sideWindows && (sideWins[-1].length || sideWins[1].length)) {
    b.group('side.windows', 'High-level windows in the long walls', 'openings', 0.08, 'all');
    for (const [side, wf] of [[-1, wfL], [1, wfR]]) {
      sideWins[side].forEach((o, k) => glazedOpening(b, wf, o, { id: 'window-' + sideName(side) + '-' + (k + 1), group: 'side.windows', frame: 'frame', glass: 'glass',
        recess: 0.06, frameWidth: 0.07, frameDepth: 0.1, mullions: Math.max(1, Math.round((o.u1 - o.u0) / 1.2) - 1) }));
    }
  }

  // Frame lines: cover strips on both long walls, from the dado top into the roof.
  // Inside the dock zone the frames stay behind the cladding (a strip would cut a shelter).
  const strips = { [-1]: [], [1]: [] };
  for (const [side, wf] of [[-1, wfL], [1, wfR]]) {
    for (let k = 1; k < M.bays; k++) {
      const u = k * bl;
      if (side === ds && u > dockU[0] + 0.1 && u < dockU[1] - 0.1) continue;
      // Up into the roof slab: on a sawtooth's high side that slab rises outwards.
      const top = sawtooth && side === sawtooth.g ? He + sawtooth.rise : sideTop[side] + 0.02;
      wf.box(b, 'strip-' + sideName(side) + '-' + k, 'frames', 'trim', u - 0.15, u + 0.15, dado - 0.03, top, -STRIP_PROUD, 0.02);
      strips[side].push(k);
    }
  }

  // ---- roof ----------------------------------------------------------------------
  let roofInfo = null, monitor = null, roofTopAt;
  if (sawtooth) {
    const { teeth, g, rise, sp, tvv } = sawtooth;
    teeth.forEach(({ a, c }, k) => {
      // Slab rising towards the glazed side. Its low end runs 12 cm into the glazing
      // wall of the previous tooth (or oversails the eaves); the last high end
      // oversails the side wall by 25 cm, past the cover strips on that wall.
      const lo = g > 0 ? a : c, hiEdge = g > 0 ? c : a, eave = k === (g > 0 ? 0 : teeth.length - 1), last = k === (g > 0 ? teeth.length - 1 : 0);
      const reach = eave ? ov : 0.12, loX = lo - g * reach, loY = He - reach * Math.tan(sp);
      const hi = hiEdge + (last ? g * 0.25 : 0), hiY = He + rise + (last ? 0.25 * Math.tan(sp) : 0);
      b.prismZ('roof-tooth-' + (k + 1), 'roof', 'roof', [[loX, loY], [hi, hiY], [hi, hiY + tvv], [loX, loY + tvv]], -L - ov, ov);
    });
    // North lights: a glazed screen under each inner high edge, facing the glazed side.
    b.group('roof.glazing', 'Sawtooth roof glazing', 'openings', 0.1, 'roof');
    teeth.forEach(({ a, c }, k) => {
      const hi = g > 0 ? c : a;
      if (Math.abs(hi) > W / 2 - 0.1) return;
      // The screen stands 4 cm back from the slab's high end (and the gable's step),
      // so its face is not theirs, runs 3 cm up into the slab and ends 5 cm inside
      // the gable walls.
      const wf = wallFrame('x', g, hi - g * 0.04), light = opening({ u0: 0.5, u1: L - 0.5, y0: He + 0.3, y1: He + rise - 0.25 });
      wall(b, wf, { id: 'north-light-' + (k + 1), group: 'roof.glazing', material: 'cladding', u0: 0.05, u1: L - 0.05, y0: He - 0.2, y1: He + rise + 0.03,
        thickness: 0.18, openings: [light] });
      glazedOpening(b, wf, light, { id: 'north-light-' + (k + 1) + '.glazing', group: 'roof.glazing', frame: 'trim', glass: 'glass', recess: 0.04,
        frameWidth: 0.08, frameDepth: 0.1, mullions: Math.max(1, Math.round((L - 1) / 1.8) - 1) });
    });
    roofTopAt = x => sawtooth.heightAt(x) + tvv;
  } else {
    roofInfo = gableRoofZ(b, { id: 'roof-main', group: 'roof', material: 'roof', z0: -L - ov, z1: ov, xRidge: 0, halfWidth: W / 2, plate: He, pitch: M.pitch * DEG,
      overhang: ov, thickness: 0.22 });
    roofTopAt = x => roofInfo.top(Math.abs(x));
    // Barge flashings: 4 cm proud of the gable ends, running 2.5 cm past the eave faces.
    const { under, tv } = roofInfo, e = roofInfo.s + 0.025;
    const flashing = [[-e, under(e) - 0.06], [0, under(0) - 0.06], [e, under(e) - 0.06], [e, under(e) + tv + 0.05], [0, under(0) + tv + 0.05], [-e, under(e) + tv + 0.05]];
    b.prismZ('roof-barge-front', 'roof', 'trim', flashing, ov - 0.03, ov + 0.04);
    b.prismZ('roof-barge-rear', 'roof', 'trim', flashing, -L - ov - 0.04, -L - ov + 0.03);
    roofInfo.flashTop = under(0) + tv + 0.05;
    if (M.roof === 'monitor') {
      const mw = W * M.monitor.width, inset = M.monitor.inset * bl, mz0 = -L + inset + 1.0, mz1 = -inset - 1.0, rise = M.monitor.rise;
      const base = roofInfo.top(mw / 2), mPlate = base + rise;
      b.group('roof.monitor', 'Roof monitor with clerestory glazing', 'roof', 0.15, 'roof');
      // Clerestory walls stand on the roof slope, 12 cm down into the slab.
      const lights = [];
      for (const side of [-1, 1]) {
        const wf = wallFrame('x', side, side * mw / 2), light = opening({ u0: -mz1 + 0.5, u1: -mz0 - 0.5, y0: base + 0.3, y1: Math.max(base + 0.4, mPlate - 0.25) });
        const glazed = light.top - light.y0 >= 0.6;
        wall(b, wf, { id: 'monitor-wall-' + sideName(side), group: 'roof.monitor', material: 'cladding', u0: -mz1, u1: -mz0, y0: base - 0.12, y1: mPlate + 0.05, thickness: 0.2,
          openings: glazed ? [light] : [] });
        if (glazed) lights.push([wf, light, side]);
      }
      const ridgeUnder = mPlate + mw / 2 * tan;
      for (const [k, wf] of [[1, wallFrame('z', 1, mz1)], [2, wallFrame('z', -1, mz0)]]) {
        const u0 = -mw / 2 + 0.2, u1 = mw / 2 - 0.2;
        wall(b, wf, { id: 'monitor-end-' + k, group: 'roof.monitor', material: 'cladding', u0, u1, y0: base - 0.12, thickness: 0.2,
          top: [[u1, mPlate + 0.2 * tan + 0.05], [0, ridgeUnder + 0.05], [u0, mPlate + 0.2 * tan + 0.05]] });
      }
      lights.forEach(([wf, o, side]) => glazedOpening(b, wf, o, { id: 'monitor-glazing-' + sideName(side), group: 'roof.monitor', frame: 'trim', glass: 'glass', recess: 0.04,
        frameWidth: 0.08, frameDepth: 0.1, mullions: Math.max(1, Math.round((o.u1 - o.u0) / 1.8) - 1) }));
      const info = gableRoofZ(b, { id: 'monitor-roof', group: 'roof.monitor', material: 'roof', z0: mz0 - 0.35, z1: mz1 + 0.35, xRidge: 0, halfWidth: mw / 2, plate: mPlate,
        pitch: M.pitch * DEG, overhang: 0.3, thickness: 0.18 });
      monitor = { mw, mz0, mz1, base, mPlate, ridgeTop: info.ridgeTop };
    }
  }

  // ---- rooflights and ridge ventilators --------------------------------------------
  const lightBays = [];
  if (!sawtooth) {
    b.group('roof.lights', 'Rooflights and ridge ventilators', 'roof', 0.1, 'roof');
    const lift = 0.16 / Math.cos(M.pitch * DEG);
    const range = monitor ? [monitor.mw / 2 + 0.8, W / 2 - 1.2] : [W * 0.14, W / 2 - 1.4];
    if (p.roofLights && range[1] - range[0] > 1.0) {
      for (let k = 0; k < M.bays; k += 2) {
        lightBays.push(k);
        const z0 = -(k + 1) * bl + 0.9, z1 = -k * bl - 0.9;
        for (const side of [-1, 1]) {
          const xa = side * range[0], xc = side * Math.min(range[1], range[0] + 1.6);
          b.prismZ('rooflight-' + (k + 1) + '-' + sideName(side), 'roof.lights', 'glass',
            [[xa, roofTopAt(xa) - 0.05], [xc, roofTopAt(xc) - 0.05], [xc, roofTopAt(xc) + lift], [xa, roofTopAt(xa) + lift]], z0, z1);
        }
      }
    }
    const ventY = monitor ? monitor.ridgeTop : roofInfo.ridgeTop;
    const z0 = monitor ? monitor.mz0 + 1.0 : -L + bl * 0.5, z1 = monitor ? monitor.mz1 - 1.0 : -bl * 0.5;
    for (let k = 0; k < p.vents; k++) {
      const z = z0 + (z1 - z0) * k / (p.vents - 1);
      b.cylinder('vent-' + (k + 1), 'roof.lights', 'steel', [0, ventY - 0.12, z], 0.75, 0.32, { segments: 16 });
      b.cylinder('vent-' + (k + 1) + '-cap', 'roof.lights', 'steel', [0, ventY + 0.6, z], 0.12, 0.5, { top: 0.2, segments: 16 });
    }
  }

  // ---- rainwater -------------------------------------------------------------------
  b.group('rainwater', 'Gutters, hoppers and downpipes', 'attachments', 0.12, 'all');
  const pipes = { [-1]: [], [1]: [] };
  if (!sawtooth) {
    const gy = roofInfo.fasciaBottom + 0.04, gx = W / 2 + ov + 0.11;
    for (const side of [-1, 1]) {
      b.beam('gutter-' + sideName(side), 'rainwater', 'trim', [side * gx, gy, ov - 0.05], [side * gx, gy, -L - ov + 0.05], 0.11, 16);
      for (let k = 0; k < M.bays; k += 2) {
        const u = k * bl + (k === 0 ? 1.0 : 0.6);
        if (side === s && u < officeU[1] + 0.6) continue;
        if (side === ds && u > dockU[0] - 1.5 && u < dockU[1] + 1.5) continue;
        const x = side * (W / 2 + 0.24), id = 'downpipe-' + sideName(side) + '-' + (k + 1);
        b.beam(id + '-offset', 'rainwater', 'trim', [side * gx, gy - 0.04, -u], [x, gy - 0.6, -u], 0.06, 12);
        b.beam(id, 'rainwater', 'trim', [x, gy - 0.6, -u], [x, 0.05, -u], 0.06, 12);
        pipes[side].push(u);
      }
    }
  } else {
    // Valley gutters discharge through hoppers on the rear gable, clear of the stair.
    const { teeth, g } = sawtooth;
    teeth.forEach(({ a, c }, k) => {
      const valley = g > 0 ? a : c;
      if (Math.abs(valley) > W / 2 - 0.5) return;
      const x = valley + g * 0.3;
      if (Math.abs(x - sx) < 1.6 || Math.abs(x - rearDoorX) < 1.2 || (x - sx) * st.side < 0 && Math.abs(x - sx) < hm / Math.tan(37 * DEG) + 1.4) return;
      wfB.box(b, 'hopper-' + (k + 1), 'rainwater', 'trim', x - 0.18, x + 0.18, He - 0.55, He - 0.05, -0.4, 0.02);
      b.beam('downpipe-rear-' + (k + 1), 'rainwater', 'trim', [x, He - 0.53, -L - 0.24], [x, 0.05, -L - 0.24], 0.06, 12);
      pipes.rear = [...(pipes.rear ?? []), x];
    });
  }

  // ---- front doors -------------------------------------------------------------------
  shutters.forEach((o, k) => {
    const id = 'shutter-' + (k + 1), w0 = 0.12;
    wfF.extrude(b, id + '.guides', 'front.doors', 'trim', [[o.u0, 0], [o.u0 + 0.14, 0], [o.u0 + 0.14, o.top - 0.14], [o.u1 - 0.14, o.top - 0.14], [o.u1 - 0.14, 0], [o.u1, 0], [o.u1, o.top], [o.u0, o.top]], w0, w0 + 0.14);
    wfF.box(b, id + '.curtain', 'front.doors', 'shutter', o.u0 + 0.12, o.u1 - 0.12, 0, o.top - 0.12, w0 + 0.05, w0 + 0.09);
    for (let j = 1; j <= Math.floor((o.top - 0.3) / 0.6); j++) {
      wfF.box(b, id + '.rib-' + j, 'front.doors', 'shutter', o.u0 + 0.16, o.u1 - 0.16, j * 0.6 - 0.03, j * 0.6 + 0.03, w0 + 0.025, w0 + 0.065);
    }
    wfF.box(b, id + '.coil-box', 'front.doors', 'trim', o.u0 - 0.12, o.u1 + 0.12, o.top + 0.05, o.top + 0.6, -0.5, 0.02);
    for (const [j, u] of [[1, o.u0 - 0.35], [2, o.u1 + 0.35]]) b.cylinder(id + '.bollard-' + j, 'front.doors', 'rail', wfF.toModel(u, 0, -0.6), 1.1, 0.11, { segments: 16 });
  });
  doorOpening(b, wfF, pdoor, { id: 'front-door', group: 'front.doors', frame: 'trim', leaf: 'door', glass: 'glass', metal: 'steel', style: 'boarded', handleSide: -ds0 });
  if (p.front.hood) wfF.box(b, 'front-door-hood', 'front.doors', 'trim', pdoor.u0 - 0.35, pdoor.u1 + 0.35, pdoor.top + 0.25, pdoor.top + 0.4, -1.0, 0.02);
  if (louvre) louvreOpening(b, wfF, louvre, { id: 'gable-louvre', group: 'front.doors', slat: 'trim', backing: 'door', recess: 0.04 });
  doorOpening(b, wfB, rearDoor, { id: 'rear-door', group: 'body', frame: 'trim', leaf: 'door', glass: 'glass', metal: 'steel', style: 'boarded' });

  // ---- loading dock ----------------------------------------------------------------------
  const dd = p.dock.depth, dz0 = -dockU[1] - 0.6, dz1 = -dockU[0] + 0.6, xw = ds * W / 2;
  const outX = w => xw + ds * w;                          // w measured outward from the dock-side wall face
  b.box('dock-platform', 'dock', 'concrete', [Math.min(outX(-0.06), outX(dd)), 0, dz0], [Math.max(outX(-0.06), outX(dd)), dh, dz1]);
  // Steps down from the front end of the platform: adjacent blocks, so no two share a face.
  for (let j = 1; j <= 4; j++) {
    b.box('dock-step-' + j, 'dock', 'concrete', [Math.min(outX(0.4), outX(1.6)), 0, dz1 + (j - 1) * 0.3 - (j === 1 ? 0.05 : 0)],
      [Math.max(outX(0.4), outX(1.6)), dh * (5 - j) / 5, dz1 + j * 0.3]);
  }
  dockDoors.forEach((o, k) => {
    const id = 'dock-door-' + (k + 1), w0 = 0.1;
    wfD.extrude(b, id + '.guides', 'dock', 'trim', [[o.u0, o.y0], [o.u0 + 0.12, o.y0], [o.u0 + 0.12, o.top - 0.12], [o.u1 - 0.12, o.top - 0.12], [o.u1 - 0.12, o.y0], [o.u1, o.y0], [o.u1, o.top], [o.u0, o.top]], w0, w0 + 0.12);
    wfD.box(b, id + '.curtain', 'dock', 'shutter', o.u0 + 0.1, o.u1 - 0.1, o.y0, o.top - 0.1, w0 + 0.04, w0 + 0.08);
    // Dock shelter: a padded U-frame round the door, 0.6 m deep.
    wfD.extrude(b, id + '.shelter', 'dock', 'rubber', [[o.u0 - 0.35, o.y0 + 0.02], [o.u0 - 0.05, o.y0 + 0.02], [o.u0 - 0.05, o.top + 0.05], [o.u1 + 0.05, o.top + 0.05],
      [o.u1 + 0.05, o.y0 + 0.02], [o.u1 + 0.35, o.y0 + 0.02], [o.u1 + 0.35, o.top + 0.4], [o.u0 - 0.35, o.top + 0.4]], -0.6, 0.02);
    for (const [j, u] of [[1, o.u0 + 0.3], [2, o.u1 - 0.3]]) b.box(id + '.bumper-' + j, 'dock', 'rubber', wfD.toModel(u - 0.12, dh - 0.35, -dd - 0.15), wfD.toModel(u + 0.12, dh - 0.05, -dd + 0.02));
  });
  let canopy = null;
  if (p.dock.canopy) {
    b.group('dock.canopy', 'Loading dock canopy', 'attachments', 0.15, sideName(ds));
    const cy = Math.min(dh + 0.03 + ddH + 0.75, He - 0.9), cd = p.dock.canopyDepth;
    wfD.box(b, 'dock-canopy', 'dock.canopy', 'trim', dockU[0] - 0.9, dockU[1] + 0.9, cy, cy + 0.25, -cd, 0.03);
    const rodTop = Math.min(cy + 2.2, sideTop[ds] - 0.35);
    for (let k = 0; k <= p.dock.bays; k++) {
      const u = dockU[0] - 0.5 + k * (dockU[1] - dockU[0] + 1.0) / p.dock.bays;
      b.beam('dock-canopy-rod-' + (k + 1), 'dock.canopy', 'steel', wfD.toModel(u, cy + 0.2, -cd + 0.2), wfD.toModel(u, rodTop, 0.0), 0.03, 8);
    }
    canopy = { cy, cd };
  }

  // ---- office block --------------------------------------------------------------------------
  let office = null;
  if (p.office.built) {
    const od = p.office.depth, oz1 = -officeU[0], oz0 = -officeU[1], xIn = s * (W / 2 - 0.05), xOut = s * (W / 2 + od), to = 0.3;
    const floors = He >= 7.4 ? 2 : 1, fh = p.office.storey, flat = p.office.roof === 'flat';
    b.group('office', 'Office block on the ' + sideName(s) + ' side', 'massing', 0.25, sideName(s));
    b.group('office.windows', 'Office windows, door and door canopy', 'openings', 0.07, sideName(s));
    const wfOF = wallFrame('z', 1, oz1), wfOB = wallFrame('z', -1, oz0), wfOS = wallFrame('x', s, xOut);
    const [ua, ub] = s < 0 ? [xOut + to, xIn] : [xIn, xOut - to];
    // Flat roof: a deck inside parapets. Mono-pitch: a lean-to falling away from the
    // shed at 6 degrees, its low side just above the top floor's ceiling; the walls
    // follow its underside. Either way it stays clear under the shed's gutter.
    const mp = 6 * DEG, tm = Math.tan(mp);
    const top = flat ? Math.min(floors * fh + 0.9, He - 0.45) : null;
    const yHigh = flat ? null : Math.min(floors * fh + 0.15 + od * tm, He - 0.6), underAt = x => yHigh - Math.abs(x - s * W / 2) * tm;
    const ceiling = flat ? top - 0.85 : underAt(xOut);
    const endTop = flat ? [[ub, top], [ua, top]] : [[ub, underAt(ub) + 0.05], [ua, underAt(ua) + 0.05]];
    const doorU0 = s < 0 ? ua + 0.9 : ub - 1.9, odoor = opening({ u0: doorU0, u1: doorU0 + 1.0, y0: 0, y1: 2.3 });
    const frontWins = [], sideWinsO = [];
    for (let f = 0; f < floors; f++) {
      // Window heads keep 35 cm below the roof (its deck or its lowest underside).
      const y0 = f * fh + 0.95, y1 = Math.min(y0 + Math.min(1.45, fh - 1.5), ceiling - 0.35);
      if (y1 - y0 < 0.8) continue;
      const span = [ua + 0.6, ub - 0.6], n = Math.max(1, Math.floor((span[1] - span[0]) / 2.4));
      for (let k = 0; k < n; k++) {
        const uc = span[0] + (span[1] - span[0]) * (k + 0.5) / n;
        if (f === 0 && uc + 0.65 > odoor.u0 - 0.45 && uc - 0.65 < odoor.u1 + 0.45) continue;
        frontWins.push(opening({ u0: uc - 0.65, u1: uc + 0.65, y0, y1 }));
      }
      const len = officeU[1] - officeU[0], m = Math.max(1, Math.round((len - 1.2) / 2.8));
      for (let k = 0; k < m; k++) {
        const uc = officeU[0] + 0.6 + (len - 1.2) * (k + 0.5) / m;
        sideWinsO.push(opening({ u0: uc - 0.65, u1: uc + 0.65, y0, y1 }));
      }
    }
    wall(b, wfOF, { id: 'office-front', group: 'office', material: officeMat, u0: ua, u1: ub, y0: 0, top: endTop, thickness: to, openings: [odoor, ...frontWins] });
    wall(b, wfOB, { id: 'office-rear', group: 'office', material: officeMat, u0: ua, u1: ub, y0: 0, top: endTop, thickness: to });
    wall(b, wfOS, { id: 'office-side', group: 'office', material: officeMat, u0: officeU[0], u1: officeU[1], y0: 0, y1: flat ? top : ceiling + 0.05, thickness: to,
      openings: sideWinsO });
    const win = { frame: 'frame', glass: 'glass', sill: 'coping', recess: 0.1, frameWidth: 0.07, frameDepth: 0.1, mullions: 1 };
    frontWins.forEach((o, k) => glazedOpening(b, wfOF, o, { ...win, id: 'office-window-f' + (k + 1), group: 'office.windows' }));
    sideWinsO.forEach((o, k) => glazedOpening(b, wfOS, o, { ...win, id: 'office-window-s' + (k + 1), group: 'office.windows' }));
    doorOpening(b, wfOF, odoor, { id: 'office-door', group: 'office.windows', frame: 'frame', leaf: 'frame', glass: 'glass', metal: 'steel', style: 'full-glass', handleSide: s });
    wfOF.box(b, 'office-door-canopy', 'office.windows', 'trim', odoor.u0 - 0.5, odoor.u1 + 0.5, odoor.top + 0.3, odoor.top + 0.48, -1.3, 0.02);
    if (flat) {
      // Roof deck inside the parapets (embedded in the shed wall), coping round the free walls.
      const xa = Math.min(xIn, xOut), xb = Math.max(xIn, xOut), c = 0.05;
      b.box('office-roof', 'office', 'roof', [xa + (s < 0 ? 0.2 : 0.02), top - 0.85, oz0 + 0.2], [xb - (s < 0 ? 0.02 : 0.2), top - 0.55, oz1 - 0.2]);
      b.box('office-coping-front', 'office', 'coping', [xa - (s < 0 ? c : 0), top - 0.04, oz1 - to - c], [xb + (s > 0 ? c : 0), top + 0.1, oz1 + c]);
      b.box('office-coping-rear', 'office', 'coping', [xa - (s < 0 ? c : 0), top - 0.04, oz0 - c], [xb + (s > 0 ? c : 0), top + 0.1, oz0 + to + c]);
      b.box('office-coping-side', 'office', 'coping', [s < 0 ? xOut - c : xOut - to - c, top - 0.04, oz0 + to + c], [s < 0 ? xOut + to + c : xOut + c, top + 0.1, oz1 - to - c]);
    } else {
      const yBack = yHigh + 0.05 * tm, tvm = 0.2 / Math.cos(mp), yFront = yHigh - (od + 0.35) * tm;
      (s < 0 ? wfL : wfR).sideProfile(b, 'office-roof', 'office', 'roof', [[0.05, yBack], [-(od + 0.35), yFront], [-(od + 0.35), yFront + tvm], [0.05, yBack + tvm]],
        officeU[0] - 0.35, officeU[1] + 0.35);
    }
    office = { xOut, oz0, oz1, top: flat ? top : yHigh + 0.2 / Math.cos(mp), floors, fh, flat, sideWinsO };
  }

  // ---- rear stair ------------------------------------------------------------------------
  let stairExtent;
  {
    // Landing in front of the mezzanine door, 2 cm below its sill and 5 cm into the
    // wall; the flight climbs to it from the side nearer the middle of the gable.
    const zw = -L, landW = 1.5, landD = 1.4, run = hm / Math.tan(37 * DEG);
    const lx0 = sx - landW / 2, lx1 = sx + landW / 2, edge = sx - st.side * landW / 2, foot = edge - st.side * run;
    b.box('stair-landing', 'stair', 'steel', [lx0, hm - 0.14, zw - landD], [lx1, hm - 0.02, zw + 0.05]);
    for (const [k, x] of [[1, lx0 + 0.08], [2, lx1 - 0.08]]) b.beam('stair-post-' + k, 'stair', 'steel', [x, 0, zw - landD + 0.08], [x, hm - 0.12, zw - landD + 0.08], 0.05, 10);
    const zA = zw - landD + 0.05, zB = zA + 1.0;
    for (const [k, z] of [[1, zA + 0.05], [2, zB - 0.05]]) b.beam('stair-stringer-' + k, 'stair', 'steel', [foot, 0.02, z], [edge, hm - 0.08, z], 0.05, 8);
    const risers = Math.round(hm / 0.185), tread = run / risers;
    for (let k = 1; k < risers; k++) {
      const x = foot + st.side * k * tread, y = k * hm / risers;
      b.box('stair-tread-' + k, 'stair', 'steel', [Math.min(x, x + st.side * tread) + 0.01, y - 0.04, zA + 0.1], [Math.max(x, x + st.side * tread) - 0.01, y, zB - 0.1]);
    }
    railing(b, { id: 'stair-rail', group: 'stair', material: 'rail', points: [[foot, 0, zA], [edge, hm - 0.02, zA], [sx + st.side * landW / 2, hm - 0.02, zA]], height: 1.0, spacing: 1.4 });
    doorOpening(b, wfB, mezz, { id: 'mezzanine-door', group: 'stair', frame: 'trim', leaf: 'door', glass: 'glass', metal: 'steel', style: 'boarded' });
    stairExtent = [Math.min(foot, lx0) - 0.3, Math.max(foot, lx1) + 0.3];
  }

  // ---- sprinkler tank ------------------------------------------------------------------------
  let tank = null;
  if (p.tank) {
    b.group('tank', 'Sprinkler water tank', 'attachments', 0.2, sideName(s));
    const R = p.tank.radius, Ht = p.tank.height, tx = s * (W / 2 + 1.8 + R), tz = -p.tank.u;
    b.box('tank-base', 'tank', 'concrete', [tx - R - 0.3, 0, tz - R - 0.3], [tx + R + 0.3, 0.3, tz + R + 0.3]);
    b.cylinder('tank-shell', 'tank', 'tank', [tx, 0.28, tz], Ht, R, { segments: 64 });
    b.cylinder('tank-roof', 'tank', 'tank', [tx, 0.26 + Ht, tz], R * 0.3, R + 0.08, { top: 0.25, segments: 64 });
    ladder(b, { id: 'tank-ladder', group: 'tank', material: 'rail', base: [tx, 0.3, tz + R + 0.25], top: [tx, Ht + 0.2, tz + R + 0.25], across: [1, 0, 0] });
    tank = { R, Ht, tx, tz };
  }

  // ---- probes ------------------------------------------------------------------------------
  const claddingY = (dado + winY0) / 2;
  const clearOf = (u, list, margin) => list.every(v => Math.abs(u - v) > margin);
  // Rear gable, away from the stair, the rear door and any downpipes.
  for (const f of [0.12, 0.42, 0.02, 0.2]) {
    const x = -st.side * W * f;
    if (Math.abs(x - rearDoorX) < 1.1 || (x > stairExtent[0] - 0.3 && x < stairExtent[1] + 0.3) || !clearOf(x, pipes.rear ?? [], 0.5)) continue;
    b.probe('rear-wall', 'Position of the rear gable wall', [x, claddingY, -300], [0, 0, 1]);
  }
  if (office) {
    // The office's outer wall between windows, at a height that meets bare cladding
    // (or the dado) when the office is absent, away from frame lines.
    const y = office.floors > 1 ? office.fh + 0.45 : 0.55;
    const edges = [officeU[0], ...office.sideWinsO.filter(o => o.y0 < office.fh).flatMap(o => [o.u0, o.u1]), officeU[1]];
    const gaps = [];
    for (let i = 0; i + 1 < edges.length; i += 2) gaps.push([edges[i] + 0.35, edges[i + 1] - 0.35]);
    const spots = gaps.flatMap(([a, c]) => [(a + c) / 2, a + 0.1, c - 0.1].filter(u => u >= a && u <= c));
    for (const u of spots.filter(u => clearOf(u, strips[s].map(k => k * bl), 0.6))) b.probe('office-side', 'Position of the office side wall', [s * 300, y, -u], [-s, 0, 0]);
    for (const f of [0.5, 0.3, 0.7]) b.probe('office-roof', 'Height of the office roof', [s * (W / 2 + p.office.depth * 0.55), 300, -(officeU[0] + (officeU[1] - officeU[0]) * f)], [0, -1, 0]);
  }
  if (canopy) for (const f of [0.45, 0.3]) b.probe('dock-canopy', 'Height of the loading dock canopy', [ds * (W / 2 + Math.min(canopy.cd, dd) * f + 0.3), 300, -(dockU[0] + dockU[1]) / 2 - 0.4], [0, -1, 0]);
  if (tank) for (const dz of [-0.1, 0.3]) b.probe('tank', 'Position of the sprinkler tank', [s * 300, claddingY, tank.tz + dz], [-s, 0, 0]);
  // Roof slopes: middle of bays without rooflights.
  const roofBays = [...Array(M.bays).keys()].filter(k => !lightBays.includes(k)).sort((a, c) => Math.abs(a - M.bays / 2) - Math.abs(c - M.bays / 2));
  for (const k of roofBays.slice(0, 3)) for (const side of [-1, 1]) {
    const x = sawtooth ? (() => { const t = sawtooth.teeth[side < 0 ? 0 : sawtooth.n - 1]; return (t.a + t.c) / 2; })()
      : side * (monitor ? (monitor.mw / 2 + W / 2) / 2 : W * 0.33);
    b.probe('roof', 'Height of the main roof', [x, 300, -(k + 0.5) * bl], [0, -1, 0]);
  }
  if (monitor) for (const f of [0.5, 0.3]) b.probe('monitor-roof', 'Height of the roof monitor', [monitor.mw * 0.24, 300, monitor.mz0 + (monitor.mz1 - monitor.mz0) * f + 0.4], [0, -1, 0]);
  // Front gable between the openings.
  const spans = [...shutters, pdoor].map(o => [o.u0, o.u1]).sort((a, c) => a[0] - c[0]), piers = [];
  let prev = -W / 2 + 0.3;
  for (const [a, c] of spans) { piers.push([prev, a]); prev = c; }
  piers.push([prev, W / 2 - 0.3]);
  piers.sort((a, c) => (c[1] - c[0]) - (a[1] - a[0]));
  const frontY = Math.min(sh + 1.2, He - 0.6);
  for (const [a, c] of piers.slice(0, 2)) b.probe('front-gable', 'Position of the front gable wall', [(a + c) / 2, frontY, 300], [0, 0, -1]);
  for (const side of [-1, 1]) {
    for (const k of [M.bays - 2, M.bays - 3, Math.floor(M.bays / 2)]) {
      const u = (k + 0.5) * bl + 1.0;
      if (side === s && u < officeU[1] + 1.0) continue;
      if (side === ds && u > dockU[0] - 1.6 && u < dockU[1] + 1.6) continue;
      if (tank && side === s && Math.abs(-u - tank.tz) < tank.R + 0.6) continue;
      b.probe(sideName(side) + '-wall', 'Position of the ' + sideName(side) + ' long wall', [side * 300, claddingY, -u], [-side, 0, 0]);
    }
  }
  // Under a canopy the platform cannot be measured from above.
  if (!canopy) for (const f of [0.5, 0.3]) b.probe('dock-platform', 'Height of the loading dock platform', [ds * (W / 2 + dd * f + 0.25), 300, dz0 + 0.4 + (dz1 - dz0 - 0.8) * f], [0, -1, 0]);

  // ---- dimensions ----------------------------------------------------------------------------
  b.dimension('overall-width', 'Overall width across the front gable', [-W / 2, 0, 0], [W / 2, 0, 0], 'front');
  b.dimension('overall-length', 'Overall length of the shed', [W / 2, 0, 0], [W / 2, 0, -L], 'plan');
  b.dimension('eaves-height', 'Height of the eaves at the wall line', [lowSide * W / 2, 0, 0], [lowSide * W / 2, He, 0], 'front');
  if (sawtooth) {
    const x = sawtooth.g > 0 ? sawtooth.teeth[0].c : sawtooth.teeth[0].a;
    b.dimension('ridge-height', 'Height to the top of the sawtooth ridges', [x, 0, 0], [x, He + sawtooth.rise + sawtooth.tvv, 0], 'front');
    b.dimension('tooth-width', 'Width of one sawtooth bay', [sawtooth.teeth[1].a, He, 0], [sawtooth.teeth[1].c, He, 0], 'front');
  } else b.dimension('ridge-height', 'Height to the top of the barge flashing at the ridge', [0, 0, 0], [0, roofInfo.flashTop, 0], 'front');
  // Frame spacing on the right wall, between two cover strips that are both there.
  const right = strips[1];
  const pair = right.find(k => right.includes(k + 1) && (s < 0 || k * bl > officeU[1] + 0.3));
  if (pair) b.dimension('frame-spacing', 'Frame spacing (cover strip to cover strip)', [W / 2 + STRIP_PROUD, (dado + He) / 2, -pair * bl + 0.15], [W / 2 + STRIP_PROUD, (dado + He) / 2, -(pair + 1) * bl + 0.15], 'right');
  b.dimension('shutter-width', 'Width of a roller shutter opening', [shutters[0].u0, 0, 0], [shutters[0].u1, 0, 0], 'front');
  b.dimension('shutter-height', 'Height of a roller shutter opening', [shutters[0].u0, 0, 0], [shutters[0].u0, shutters[0].top, 0], 'front');
  b.dimension('dock-depth', 'Projection of the loading dock platform', [ds * W / 2, dh, dz0], [ds * (W / 2 + dd), dh, dz0], 'plan');
  if (office) {
    b.dimension('office-projection', 'Projection of the office block from the shed wall', [s * W / 2, 0, office.oz1], [office.xOut, 0, office.oz1], 'front');
    b.dimension('office-length', 'Length of the office block', [office.xOut, 0, office.oz1], [office.xOut, 0, office.oz0], 'plan');
  }
  if (monitor) b.dimension('monitor-width', 'Width of the roof monitor', [-monitor.mw / 2, monitor.mPlate, monitor.mz1], [monitor.mw / 2, monitor.mPlate, monitor.mz1], 'front');
  if (canopy) b.dimension('canopy-depth', 'Projection of the dock canopy', [ds * W / 2, canopy.cy, -dockU[0] - 0.4], [ds * (W / 2 + canopy.cd), canopy.cy, -dockU[0] - 0.4], 'plan');
  b.dimensions.splice(12);

  const roofWord = { gable: 'a low-pitched roof', monitor: 'a roof monitor', sawtooth: 'a sawtooth roof' }[M.roof];
  return {
    builder: b,
    title: 'Industrial shed with ' + roofWord,
    frame: {
      origin: 'On the ground at the midpoint of the front gable wall; that wall face is the plane z = 0 and the shed extends towards -Z.',
      front: 'The front gable, with the roller shutters, faces +Z; +X is to the right when you look at the front.',
    },
    scope_note: 'The building exterior only: walls, roof, roof monitor or glazing, rooflights and ventilators, doors and shutters, loading dock and canopy, ' +
      'office block, external stair, gutters and downpipes, and the sprinkler tank where present. No ground plane, yard, fences, vehicles, containers or neighbouring buildings.',
    probeOrder: ['rear-wall', 'office-side', 'dock-canopy', 'tank', 'office-roof', 'front-gable', 'roof', 'monitor-roof', 'left-wall', 'right-wall', 'dock-platform'],
    structure: { roof: M.roof, bays: M.bays, shutters: nS, office: office ? (office.flat ? 'flat' : 'mono') + '-' + office.floors : null, officeSide: s,
      dockBays: p.dock.bays, dockCanopy: !!canopy, tank: !!tank, sideWindows: sideWins[-1].length + sideWins[1].length > 0 },
  };
}

export const edits = [
  {
    // The shed was extended by one frame bay at the rear; the rear gable and its stair moved back.
    id: 'fewer-bays', applies: p => p.massing.bays >= 6 && p.dock.first + p.dock.bays <= p.massing.bays - 2,
    scope: ['body', 'roof', 'frames', 'rainwater', 'roof.lights', 'roof.monitor', 'roof.glazing', 'side.windows', 'stair'],
    apply: p => ({ ...p, massing: { ...p.massing, bays: p.massing.bays - 1 } }),
    phrase: 'the shed was one frame bay shorter at the rear',
  },
  { id: 'no-office', scope: ['office', 'office.windows'], applies: (p, s) => !!s.office, apply: p => ({ ...p, office: { ...p.office, built: false } }), phrase: 'the office block had not been built' },
  { id: 'no-dock-canopy', scope: ['dock.canopy'], applies: (p, s) => s.dockCanopy, apply: p => ({ ...p, dock: { ...p.dock, canopy: false } }), phrase: 'the loading dock had no canopy' },
  { id: 'no-tank', scope: ['tank'], applies: (p, s) => s.tank, apply: p => ({ ...p, tank: null }), phrase: 'the sprinkler tank had not been installed' },
];

export default { id: 'warehouse', sample, build, edits };
