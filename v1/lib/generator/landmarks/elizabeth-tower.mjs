// Elizabeth Tower (the clock tower known as Big Ben), Palace of Westminster,
// London. A square shaft with corner piers and string courses, a projecting
// clock stage with a dial on each face, a stone cornice where the masonry ends,
// the belfry with louvred openings, and the cast-iron spire with the lantern
// and the finial. Corner pinnacles on both cornices.
//
// Frame: the origin is on the ground on the axis of the tower; the north face
// faces +Z. The tower is four-fold symmetric: the scorer's yaw fit may turn a
// correct model by a quarter turn, which shows in frame_error only.
//
// The datum a twin never changes: the plinth, the shaft's section and the lower
// string courses, so both states share the shaft up to the lower clock stage.
// A twin moves the clock (dial height), resizes the dials (and with them the
// clock stage), and changes the belfry and the spire.
import { ModelBuilder, wallFrame, wall, opening, louvreOpening } from '../kit.mjs';
import { squareFrustum, ringBand, orientedBox } from './parts.mjs';

const PUBLISHED = {
  // Wikipedia, "Big Ben", https://en.wikipedia.org/wiki/Big_Ben (read 2026-10-05): "Its base is
  // square, measuring 40 feet (12 m) on each side".
  width: 12.0,
  // UK Parliament, Elizabeth Tower facts and figures (parliament.uk; quoted from search results,
  // the page refuses automated fetches): "The centre of each dial is 55m from the ground" and
  // "The clock dials are 7m in diameter". Wikipedia gives 180 ft (54.9 m) and 22.5 ft (6.9 m);
  // Parliament's figures are used.
  dialHeight: 55.0, dialDiameter: 7.0,
  // Wikipedia (above): "The bottom 200 feet (61.0 m) of the tower's structure consists of
  // brickwork with sand-coloured Anston limestone cladding. The remainder of the tower's height
  // is a framed spire of cast iron"; height 96 m (Parliament) / 316 ft (96.3 m, Wikipedia).
  // The iron part above the masonry: 96 - 61 = 35 m.
  spireHeight: 35.0,
  // The belfry, the lowest stage of the iron spire: no published height found; estimated.
  belfryHeight: 9.0,
};
// Estimated from photographs; no published figures found. The masonry ends 2.5 m above the
// top of the dials, which with the published 55 m and 7 m reproduces the published 61 m.
const PLINTH = { top: 2.4, half: 6.3 }, CORE_HALF = 5.65, PIER = 1.3;
const COURSES = [13.0, 26.0], COURSE_PROUD = 0.3;
const CLOCK = { below: 2.2, above: 2.5, half: 6.55, cornice: 1.2, corniceProud: 0.4, frame: 0.7 };
const BELFRY = { half: 5.6, wall: 0.7, cornice: 0.9, corniceProud: 0.35 };
const SPIRE = { baseHalf: 5.0, topHalf: 1.4, roof: 0.62, lantern: 0.12, lanternRadius: 1.5 };

const QUANTITIES = [
  { key: 'dialHeight', label: 'Height of the clock dials', kind: 'length', sourced: true, range: [0.12, 0.2] },
  { key: 'dialDiameter', label: 'Diameter of the clock dials', kind: 'length', sourced: true },
  { key: 'spireHeight', label: 'Height of the spire above the masonry', kind: 'length', sourced: true },
  { key: 'belfryHeight', label: 'Height of the belfry', kind: 'length', sourced: false },
];

function levels(p) {
  const r = p.dialDiameter / 2, clockBase = p.dialHeight - r - CLOCK.below, stoneTop = p.dialHeight + r + CLOCK.above;
  const belfryTop = stoneTop + p.belfryHeight, rest = p.spireHeight - p.belfryHeight;
  const roofTop = belfryTop + SPIRE.roof * rest, lanternTop = roofTop + SPIRE.lantern * rest;
  return { r, clockBase, stoneTop, belfryTop, roofTop, lanternTop, height: stoneTop + p.spireHeight };
}

function implausible(p) {
  const l = levels(p);
  if (l.r + CLOCK.frame > CLOCK.half - 0.3) return 'the dials would not fit the clock stage';
  if (l.clockBase < COURSES.at(-1) + 4) return 'the clock stage would come down to the string courses';
  if (p.belfryHeight < 5 || p.spireHeight - p.belfryHeight < 15) return 'the belfry or the roof above it would be too short';
  return null;
}

function build(p) {
  const b = new ModelBuilder(), l = levels(p), half = p.width / 2;
  b.material('stone', '#cdb88f', 'stone', { roughness: 0.85 });
  b.material('stone-dark', '#b9a37b', 'stone', { roughness: 0.85 });
  b.material('dial', '#efe9d6', 'glass', { roughness: 0.4 });
  b.material('gilt', '#a8873e', 'metal', { roughness: 0.4, metalness: 0.7 });
  b.material('hands', '#1e2124', 'metal', { roughness: 0.5, metalness: 0.4 });
  b.material('iron', '#3c4448', 'roof', { roughness: 0.7, metalness: 0.3 });
  b.material('louvre', '#4d4a43', 'wood', { roughness: 0.8 });
  b.material('backing', '#1f1d1a', 'wall', { roughness: 0.9 });
  b.group('shaft', 'Shaft and corner piers', 'massing', 0.35, 'all');
  b.group('base', 'Plinth and string courses', 'ornament', 0.25, 'all');
  b.group('clock.stage', 'Clock stage and stone cornice', 'massing', 0.35, 'all');
  b.group('dials', 'Clock dials, surrounds and hands', 'ornament', 0.2, 'all');
  b.group('belfry', 'Belfry walls and cornice', 'massing', 0.3, 'all');
  b.group('louvres', 'Belfry louvres', 'openings', 0.12, 'all');
  b.group('spire', 'Iron spire, lantern and finial', 'roof', 0.35, 'all');
  b.group('pinnacles', 'Corner pinnacles', 'ornament', 0.25, 'all');

  // Shaft: a core with corner piers standing out by 35 cm, up into the clock stage.
  const shaftTop = l.clockBase + 0.05;
  b.box('shaft-core', 'shaft', 'stone', [-CORE_HALF, 0, -CORE_HALF], [CORE_HALF, shaftTop, CORE_HALF]);
  for (const [sx, sz, name] of [[-1, -1, 'rear-left'], [1, -1, 'rear-right'], [1, 1, 'front-right'], [-1, 1, 'front-left']]) {
    b.box('pier-' + name, 'shaft', 'stone', [sx < 0 ? -half : half - PIER, 0, sz < 0 ? -half : half - PIER], [sx < 0 ? -half + PIER : half, shaftTop, sz < 0 ? -half + PIER : half]);
  }
  b.box('plinth', 'base', 'stone-dark', [-PLINTH.half, 0, -PLINTH.half], [PLINTH.half, PLINTH.top, PLINTH.half]);
  // String courses between the piers: the two lower ones are datum, the third sits under the clock.
  const inner = half - PIER;
  [...COURSES, l.clockBase - 4.0].forEach((y, k) => {
    for (const [face, a] of [['front', 0], ['right', 1], ['rear', 2], ['left', 3]]) {
      const id = 'course-' + (k + 1) + '-' + face, o = CORE_HALF + COURSE_PROUD, s = a < 2 ? 1 : -1;
      if (a % 2 === 0) b.box(id, 'base', 'stone-dark', [-inner - 0.02, y, s > 0 ? CORE_HALF - 0.05 : -o], [inner + 0.02, y + 0.6, s > 0 ? o : -CORE_HALF + 0.05]);
      else b.box(id, 'base', 'stone-dark', [s > 0 ? CORE_HALF - 0.05 : -o, y, -inner - 0.02], [s > 0 ? o : -CORE_HALF + 0.05, y + 0.6, inner + 0.02]);
    }
  });

  // Clock stage, its cornice (the inner edge runs into the belfry walls) and a dial on each face.
  b.box('clock-stage', 'clock.stage', 'stone', [-CLOCK.half, l.clockBase, -CLOCK.half], [CLOCK.half, l.stoneTop - 0.05, CLOCK.half]);
  ringBand(b, { id: 'clock-cornice', group: 'clock.stage', material: 'stone-dark', x0: -CLOCK.half, x1: CLOCK.half, z0: -CLOCK.half, z1: CLOCK.half,
    y0: l.stoneTop - CLOCK.cornice, y1: l.stoneTop, proud: CLOCK.corniceProud, embed: CLOCK.half - BELFRY.half + 0.05 });
  const faces = [['front', [1, 0, 0], [0, 0, 1]], ['right', [0, 0, -1], [1, 0, 0]], ['rear', [-1, 0, 0], [0, 0, -1]], ['left', [0, 0, 1], [-1, 0, 0]]];
  for (const [name, u, n] of faces) {
    const at = (du, dv, dn) => [u[0] * du + n[0] * dn, p.dialHeight + dv, u[2] * du + n[2] * dn];
    const plate = l.r + CLOCK.frame;
    orientedBox(b, 'dial-surround-' + name, 'dials', 'gilt', { centre: at(0, 0, CLOCK.half + 0.1), u, v: [0, 1, 0], n, hu: plate, hv: plate, hn: 0.15 });
    // Dial disc: a cylinder whose axis is the face normal, 5 cm into the surround
    // and 25 cm proud of it (surround front at half + 0.25, dial face at half + 0.5).
    const rotation = n[2] !== 0 ? [Math.PI / 2, 0, 0] : [0, 0, Math.PI / 2];
    b.add({ id: 'dial-' + name, type: 'cylinder', radius: l.r, height: 0.3, segments: 48, position: at(0, 0, CLOCK.half + 0.35), rotation, material: 'dial', group: 'dials' });
    // Hands at ten past ten, 2 cm into the dial and 8 cm proud of it.
    const dialFace = CLOCK.half + 0.5;
    for (const [hand, length, width, angle] of [['hour', 0.39 * p.dialDiameter, 0.28, -Math.PI / 3], ['minute', 0.6 * p.dialDiameter, 0.2, Math.PI / 3]]) {
      const dir = [Math.sin(angle), Math.cos(angle)], hu = [u[0] * dir[0], dir[1], u[2] * dir[0]], side = [u[0] * dir[1], -dir[0], u[2] * dir[1]];
      const centre = [u[0] * dir[0] * length / 2 + n[0] * (dialFace + 0.03), p.dialHeight + dir[1] * length / 2, u[2] * dir[0] * length / 2 + n[2] * (dialFace + 0.03)];
      orientedBox(b, 'hand-' + hand + '-' + name, 'dials', 'hands', { centre, u: side, v: hu, n, hu: width / 2, hv: length / 2, hn: 0.05 });
    }
  }

  // Belfry: four walls with three pointed openings each, louvred, under a cornice.
  // Walls stand 5 cm into the clock stage and stop 5 cm under the top of their cornice.
  const bb = l.stoneTop - 0.1, bt = l.belfryTop, t = BELFRY.wall, wf = {
    front: wallFrame('z', 1, BELFRY.half), rear: wallFrame('z', -1, -BELFRY.half), right: wallFrame('x', 1, BELFRY.half), left: wallFrame('x', -1, -BELFRY.half) };
  const openingAt = (uc, w) => opening({ u0: uc - w / 2, u1: uc + w / 2, y0: bb + 1.2, y1: bt - 1.6, shape: 'arch', ratio: 0.8 });
  for (const [name, frame] of Object.entries(wf)) {
    const along = frame.axis === 'z', span = along ? BELFRY.half : BELFRY.half - t;
    const openings = along ? [openingAt(-3.4, 2.2), openingAt(0, 2.2), openingAt(3.4, 2.2)] : [openingAt(-3.0, 2.0), openingAt(0, 2.0), openingAt(3.0, 2.0)];
    wall(b, frame, { id: 'belfry-' + name, group: 'belfry', material: 'stone', u0: -span, u1: span, y0: bb, y1: bt - 0.05, thickness: t, openings });
    openings.forEach((o, k) => louvreOpening(b, frame, o, { id: 'louvre-' + name + '-' + (k + 1), group: 'louvres', slat: 'louvre', backing: 'backing', recess: 0.12 }));
  }
  ringBand(b, { id: 'belfry-cornice', group: 'belfry', material: 'stone-dark', x0: -BELFRY.half, x1: BELFRY.half, z0: -BELFRY.half, z1: BELFRY.half,
    y0: bt - BELFRY.cornice, y1: bt, proud: BELFRY.corniceProud, embed: BELFRY.half - SPIRE.baseHalf + 0.15 });

  // Spire: a steep iron roof, the lantern and the finial.
  squareFrustum(b, 'spire-roof', 'spire', 'iron', { y0: bt - 0.05, y1: l.roofTop, h0: SPIRE.baseHalf, h1: SPIRE.topHalf });
  b.cylinder('lantern', 'spire', 'iron', [0, l.roofTop - 0.05, 0], l.lanternTop - l.roofTop + 0.05, SPIRE.lanternRadius, { segments: 8, yaw: Math.PI / 8 });
  b.cylinder('finial', 'spire', 'gilt', [0, l.lanternTop - 0.05, 0], l.height - l.lanternTop + 0.05, SPIRE.lanternRadius * 0.85, { top: 0, segments: 8, yaw: Math.PI / 8 });
  // Pinnacles on the corners of both cornices.
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const k = (sx > 0 ? 1 : 0) + (sz > 0 ? 2 : 0);
    squareFrustum(b, 'pinnacle-clock-' + k, 'pinnacles', 'stone-dark', { y0: l.stoneTop - 0.02, y1: l.stoneTop + 3.0, h0: 0.4, h1: 0, cx: sx * 6.45, cz: sz * 6.45 });
    squareFrustum(b, 'pinnacle-belfry-' + k, 'pinnacles', 'iron', { y0: bt - 0.02, y1: bt + 4.5, h0: 0.45, h1: 0, cx: sx * 5.5, cz: sz * 5.5 });
  }

  const probes = [];
  const probe = (id, label, origin, direction, about = []) => probes.push({ id, label, origin, direction, about });
  const clock = ['dialHeight', 'dialDiameter'], above = [...clock, 'belfryHeight'], spire = [...above, 'spireHeight'];
  probe('clock-stage-front', 'Position of the clock stage below the north dial', [0, l.clockBase + 0.7, 200], [0, 0, -1], clock);
  probe('clock-stage-right', 'Position of the clock stage below the east dial', [200, l.clockBase + 0.7, 0], [-1, 0, 0], clock);
  for (const [x, z] of [[0, (BELFRY.half + CLOCK.half + CLOCK.corniceProud) / 2], [-3, -(BELFRY.half + CLOCK.half + CLOCK.corniceProud) / 2]]) {
    probe('stone-top', 'Height of the stone cornice where the masonry ends', [x, 300, z], [0, -1, 0], clock);
  }
  probe('belfry-top', 'Height of the belfry cornice', [0, 300, (SPIRE.baseHalf + BELFRY.half + BELFRY.corniceProud) / 2], [0, -1, 0], above);
  const roof = l.roofTop - l.belfryTop;
  probe('spire-front', 'Position of the north face of the spire', [0.5, l.belfryTop + 0.35 * roof, 200], [0, 0, -1], spire);
  probe('spire-right', 'Position of the east face of the spire', [200, l.belfryTop + 0.55 * roof, -0.5], [-1, 0, 0], spire);
  probe('belfry-front', 'Position of the north wall of the belfry', [1.7, (l.stoneTop + l.belfryTop) / 2, 200], [0, 0, -1], above);
  probe('dial-front', 'Position of the north dial', [0, p.dialHeight - 0.55 * l.r, 200], [0, 0, -1], clock);
  // Datum: the shaft between the corner piers.
  probe('shaft-front', 'Position of the north face of the shaft', [2.0, 8.0, 200], [0, 0, -1]);
  probe('shaft-right', 'Position of the east face of the shaft', [200, 19.5, -2.0], [-1, 0, 0]);
  probe('shaft-rear', 'Position of the south face of the shaft', [-2.0, 8.0, -200], [0, 0, 1]);
  probe('shaft-left', 'Position of the west face of the shaft', [-200, 19.5, 2.0], [1, 0, 0]);

  b.dimension('plinth-width', 'Width of the plinth', [-PLINTH.half, 0, PLINTH.half], [PLINTH.half, 0, PLINTH.half], 'front');
  b.dimension('shaft-width', 'Width of the shaft', [-half, PLINTH.top, half], [half, PLINTH.top, half], 'front');
  b.dimension('clock-stage-base', 'Height of the underside of the clock stage', [-half, 0, half], [-half, l.clockBase, half], 'front');
  b.dimension('dial-bottom', 'Height of the bottom of the north dial', [0, 0, half], [0, p.dialHeight - l.r, half], 'front');
  b.dimension('dial-diameter', 'Diameter of the north dial', [-l.r, p.dialHeight, half], [l.r, p.dialHeight, half], 'front');
  b.dimension('stone-top', 'Height of the stone cornice', [-half, 0, half], [-half, l.stoneTop, half], 'front');
  b.dimension('belfry-top', 'Height of the belfry cornice', [-SPIRE.baseHalf, 0, half], [-SPIRE.baseHalf, l.belfryTop, half], 'front');
  b.dimension('overall-height', 'Overall height to the top of the finial', [0, 0, half], [0, l.height, half], 'front');
  b.dimension('shaft-depth', 'Depth of the shaft', [half, PLINTH.top, half], [half, PLINTH.top, -half], 'right');

  return { builder: b, probes, structure: { clockBase: Math.round(l.clockBase * 100) / 100, stoneTop: Math.round(l.stoneTop * 100) / 100, height: Math.round(l.height * 100) / 100 } };
}

export default {
  id: 'elizabeth-tower',
  title: 'Elizabeth Tower (Big Ben), Palace of Westminster, London',
  frame: {
    origin: 'On the ground at the centre of the base of the tower (its axis); the ground is y = 0.',
    front: 'The front, the north face, faces +Z; +X is to the right when you look at the front.',
  },
  scope_note: 'The tower only, from the ground to the finial: shaft, clock stage and dials, belfry, spire, lantern and pinnacles. ' +
    'No ground plane, the adjoining Palace buildings, railings, street furniture, vehicles or trees.',
  published: PUBLISHED, quantities: QUANTITIES, implausible, build,
};
