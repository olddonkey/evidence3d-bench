// Lincoln Memorial, Washington, D.C. A terrace inside its retaining wall, the
// podium with two steps up to the stylobate, a Doric colonnade round the hall
// (twelve columns on the front and rear, eight on the ends), the entablature
// with its cornice, the attic set back above it, the hall walls with the
// entrance and its two columns in antis, and two flights of steps on the front.
//
// Frame: the front face of the terrace wall is the plane z = 0, the memorial
// extends towards -Z and the lower flight of steps projects towards +Z.
//
// The datum a twin never changes: the terrace, the podium and stylobate, and the
// hall walls. A twin changes the colonnade (columns per side, their height and
// diameter; the colonnade still spans the same stylobate), the attic and the
// width of the steps.
import { ModelBuilder, wallFrame, wall, opening } from '../kit.mjs';
import { ringBand } from './parts.mjs';

const FT = 0.3048, IN = 0.0254;
// National Park Service, "Lincoln Memorial Building Statistics",
// https://www.nps.gov/linc/learn/historyculture/lincoln-memorial-building-statistics.htm (read 2026-10-05).
const PUBLISHED = {
  // "Retaining Wall: Height—14 feet; Width (east and west sides)—257 feet; Depth (north and south sides)—187 feet"
  terraceWidth: 257 * FT, terraceDepth: 187 * FT, terraceHeight: 14 * FT,
  // "Total width of building north to south: 201 feet 10 inches at widest point"; "Total depth of
  // building east to west: 132 feet at widest point" (taken as the podium).
  podiumWidth: 201 * FT + 10 * IN, podiumDepth: 132 * FT,
  // "Height of building: ... 99 feet above grade at foot of terrace walls"
  height: 99 * FT,
  // "Doric Colonnade: Number—36 plus 2 at entrance; Height—44 feet; Column diameter—7 feet 5 inches".
  // Twelve on the front and rear and eight on each end (12 + 12 + 8 + 8 - 4 corners = 36): from
  // photographs and plans; no fetched source states the count per side.
  columnsFront: 12, columnsSide: 8, columnHeight: 44 * FT, columnDiameter: 7 * FT + 5 * IN,
  // Wikipedia (https://en.wikipedia.org/wiki/Lincoln_Memorial): "The structure measures 189.7 by
  // 118.5 feet (57.8 by 36.1 m)"; read here as the attic, which stands back from the colonnade.
  atticWidth: 189.7 * FT, atticDepth: 118.5 * FT,
  // Estimated (no published figure found): the attic from the top of the entablature to the
  // published 99 ft, and the width of the lower flight of steps.
  atticHeight: 99 * FT - 8.7 - 44 * FT - 3.69, stepsWidth: 24.0,
};
// Estimated from photographs and the 58 steps from the plaza to the hall; no published figures found.
const STYLOBATE = 8.7, PODIUM_TOP = 7.7, STEP = 0.3, EDGE = 1.4, ENTABLATURE = 3.69, CORNICE = 0.74, CORNICE_PROUD = 0.5;
const HALL = { halfWidth: 23.0, halfDepth: 13.2, wall: 1.5, door: 7.5, doorTop: 20.5 };
const FLIGHT_A = { risers: 28, tread: 0.4 }, FLIGHT_B = { risers: 29, landing: 0.6, share: 0.8 };

const QUANTITIES = [
  { key: 'columnsFront', label: 'Number of columns on the front and rear', kind: 'count', sourced: true, steps: [-2, 2] },
  { key: 'columnsSide', label: 'Number of columns on each end', kind: 'count', sourced: true, steps: [-2, 2] },
  { key: 'columnHeight', label: 'Height of the columns', kind: 'length', sourced: true },
  { key: 'columnDiameter', label: 'Diameter of the columns', kind: 'length', sourced: true },
  { key: 'atticHeight', label: 'Height of the attic', kind: 'length', sourced: false },
  { key: 'stepsWidth', label: 'Width of the main steps', kind: 'length', sourced: false },
];

function layout(p) {
  const zc = -p.terraceDepth / 2;
  const stylobate = { x: p.podiumWidth / 2 - 2 * STEP, z: p.podiumDepth / 2 - 2 * STEP };
  const cols = { x: stylobate.x - EDGE, z: stylobate.z - EDGE };
  const ent = { x: cols.x + 1.2, z: cols.z + 1.2 };
  const capital = STYLOBATE + p.columnHeight, entTop = capital + ENTABLATURE;
  return { zc, stylobate, cols, ent, capital, entTop, top: entTop + p.atticHeight,
    pitchFront: 2 * cols.x / (p.columnsFront - 1), pitchSide: 2 * cols.z / (p.columnsSide - 1) };
}

function implausible(p) {
  const l = layout(p);
  if (Math.min(l.pitchFront, l.pitchSide) - p.columnDiameter < 1.4) return 'the columns would stand closer than 1.4 m';
  if (Math.min(l.pitchFront, l.pitchSide) - p.columnDiameter > 4.5) return 'the columns would stand too far apart for the entablature';
  if (p.stepsWidth > 2 * l.stylobate.x - 10) return 'the steps would be wider than the front';
  if (p.atticWidth / 2 > l.ent.x - 0.4 || p.atticDepth / 2 > l.ent.z - 0.4) return 'the attic would not stand back from the entablature';
  return null;
}

function build(p) {
  const b = new ModelBuilder(), l = layout(p), zc = l.zc, H = p.columnHeight, D = p.columnDiameter;
  b.material('marble', '#e8e4da', 'stone', { roughness: 0.85 });
  b.material('granite', '#b7b2a7', 'stone', { roughness: 0.85 });
  b.material('shade', '#bcb6a8', 'stone', { roughness: 0.9 });
  b.group('terrace', 'Terrace and its retaining wall', 'massing', 0.4, 'all');
  b.group('podium', 'Podium, steps and stylobate', 'massing', 0.25, 'all');
  b.group('colonnade', 'Doric colonnade', 'structure', 0.3, 'all');
  b.group('entablature', 'Entablature and cornice', 'ornament', 0.3, 'all');
  b.group('attic', 'Attic and its coping', 'roof', 0.4, 'roof');
  b.group('hall', 'Hall walls', 'massing', 0.4, 'all');
  b.group('entrance', 'Columns in antis at the entrance', 'entrance', 0.3, 'front');
  b.group('steps', 'Main steps', 'entrance', 0.2, 'front');

  const tx = p.terraceWidth / 2;
  b.box('terrace', 'terrace', 'granite', [-tx, 0, -p.terraceDepth], [tx, p.terraceHeight, 0]);
  // Podium and its two steps, each 5 cm into the one below.
  const px = p.podiumWidth / 2, pz = p.podiumDepth / 2;
  b.box('podium', 'podium', 'marble', [-px, p.terraceHeight - 0.05, zc - pz], [px, PODIUM_TOP, zc + pz]);
  b.box('podium-step', 'podium', 'marble', [-px + STEP, PODIUM_TOP - 0.05, zc - pz + STEP], [px - STEP, (PODIUM_TOP + STYLOBATE) / 2, zc + pz - STEP]);
  b.box('stylobate', 'podium', 'marble', [-l.stylobate.x, (PODIUM_TOP + STYLOBATE) / 2 - 0.05, zc - l.stylobate.z], [l.stylobate.x, STYLOBATE, zc + l.stylobate.z]);

  // Colonnade: tapering shafts, an echinus and an abacus that reaches the capital height.
  const column = (id, group, x, z) => {
    const shaftTop = STYLOBATE + 0.94 * H;
    b.cylinder(id, group, 'marble', [x, STYLOBATE - 0.02, z], shaftTop - STYLOBATE + 0.02, D / 2, { top: 0.8 * D / 2, segments: 20 });
    b.cylinder(id + '-echinus', group, 'marble', [x, shaftTop - 0.02, z], 0.03 * H + 0.04, 0.4 * D, { top: 0.56 * D, segments: 20 });
    b.box(id + '-abacus', group, 'marble', [x - 0.58 * D, shaftTop + 0.03 * H, z - 0.58 * D], [x + 0.58 * D, l.capital, z + 0.58 * D]);
  };
  const xs = [...Array(p.columnsFront).keys()].map(k => -l.cols.x + k * l.pitchFront);
  const zs = [...Array(p.columnsSide).keys()].map(k => zc - l.cols.z + k * l.pitchSide);
  xs.forEach((x, k) => { column('column-front-' + (k + 1), 'colonnade', x, zc + l.cols.z); column('column-rear-' + (k + 1), 'colonnade', x, zc - l.cols.z); });
  zs.slice(1, -1).forEach((z, k) => { column('column-left-' + (k + 1), 'colonnade', -l.cols.x, z); column('column-right-' + (k + 1), 'colonnade', l.cols.x, z); });

  // Hall: four walls, the front one with the entrance; the entablature is its ceiling.
  const hx = HALL.halfWidth, front = zc + HALL.halfDepth, rear = zc - HALL.halfDepth, y0 = STYLOBATE - 0.02, y1 = l.capital + 0.02, t = HALL.wall;
  const door = opening({ u0: -HALL.door, u1: HALL.door, y0, y1: STYLOBATE + Math.min(HALL.doorTop - STYLOBATE, H - 1.0) });
  wall(b, wallFrame('z', 1, front), { id: 'hall-front', group: 'hall', material: 'shade', u0: -hx, u1: hx, y0, y1, thickness: t, openings: [door] });
  wall(b, wallFrame('z', -1, rear), { id: 'hall-rear', group: 'hall', material: 'shade', u0: -hx, u1: hx, y0, y1, thickness: t });
  for (const [name, s] of [['left', -1], ['right', 1]]) {
    wall(b, wallFrame('x', s, s * hx), { id: 'hall-' + name, group: 'hall', material: 'shade', u0: -(front - t), u1: -(rear + t), y0, y1, thickness: t });
  }
  for (const x of [-HALL.door / 3, HALL.door / 3]) column('column-antis-' + (x < 0 ? 'left' : 'right'), 'entrance', x, front - t / 2);

  // Entablature over the colonnade and the hall, its cornice running into the attic.
  b.box('entablature', 'entablature', 'marble', [-l.ent.x, l.capital - 0.02, zc - l.ent.z], [l.ent.x, l.entTop, zc + l.ent.z]);
  const ax = p.atticWidth / 2, az = p.atticDepth / 2;
  ringBand(b, { id: 'cornice', group: 'entablature', material: 'marble', x0: -l.ent.x, x1: l.ent.x, z0: zc - l.ent.z, z1: zc + l.ent.z,
    y0: l.entTop - 0.04, y1: l.entTop + CORNICE - 0.04, proud: CORNICE_PROUD, embed: Math.max(l.ent.x - ax, l.ent.z - az) + 0.05 });
  b.box('attic', 'attic', 'marble', [-ax, l.entTop - 0.05, zc - az], [ax, l.top, zc + az]);
  ringBand(b, { id: 'attic-coping', group: 'attic', material: 'marble', x0: -ax, x1: ax, z0: zc - az, z1: zc + az, y0: l.top - 0.7, y1: l.top - 0.15, proud: 0.3 });

  // Steps: a lower flight from the ground to the terrace, an upper one, narrower,
  // from a landing on the terrace to the stylobate. Each is one prism with a stepped profile.
  // Profile [z, y] of a flight rising from (z0, y0) to (z1, y1); the top tread
  // stays 2 cm under the level it reaches and runs 5 cm into what it meets.
  const flight = (risers, z0, z1, y0, y1) => {
    const rise = (y1 - y0) / risers, tread = (z0 - z1) / risers, profile = [[z0, y0]];
    for (let k = 1; k <= risers; k++) {
      const y = y0 + k * rise - (k === risers ? 0.02 : 0);
      profile.push([z0 - (k - 1) * tread, y], [z0 - k * tread, y]);
    }
    profile.push([z1 - 0.05, y1 - 0.02], [z1 - 0.05, y0]);
    return profile;
  };
  const wA = p.stepsWidth / 2, wB = FLIGHT_B.share * wA, runA = FLIGHT_A.risers * FLIGHT_A.tread, styFront = zc + l.stylobate.z;
  b.prismX('steps-lower', 'steps', 'granite', flight(FLIGHT_A.risers, runA, 0, 0, p.terraceHeight), -wA, wA);
  b.prismX('steps-upper', 'steps', 'marble', flight(FLIGHT_B.risers, -FLIGHT_B.landing, styFront, p.terraceHeight - 0.05, STYLOBATE), -wB, wB);

  const probes = [];
  const probe = (id, label, origin, direction, about = []) => probes.push({ id, label, origin, direction, about });
  const colonnade = ['columnsFront', 'columnsSide', 'columnDiameter'], height = ['columnHeight', 'atticHeight'];
  for (const [x, z] of [[8, zc], [-15, zc + 5]]) probe('attic-top', 'Height of the attic', [x, 300, z], [0, -1, 0], height);
  probe('cornice-top', 'Height of the cornice', [10, 300, zc + (az + l.ent.z + CORNICE_PROUD) / 2], [0, -1, 0], ['columnHeight']);
  probe('entablature-front', 'Position of the front of the entablature', [10, l.capital + 1.5, 300], [0, 0, -1], ['columnHeight']);
  // Between the columns onto the hall walls: where the published colonnade has a column, the ray stops short.
  const mid = STYLOBATE + 0.5 * H, bays = [1, 3, p.columnsFront - 4];
  bays.forEach((k, i) => probe('bay-front-' + 'abc'[i], 'Position of the hall wall seen between the front columns', [-l.cols.x + (k + 0.5) * l.pitchFront, mid, 300], [0, 0, -1], colonnade));
  [1, p.columnsSide - 3].forEach((k, i) => probe('bay-side-' + 'ab'[i], 'Position of the hall wall seen between the end columns', [300, mid, zc - l.cols.z + (k + 0.5) * l.pitchSide], [-1, 0, 0], colonnade));
  probe('steps-side', 'Position of the side of the lower steps', [300, 1.0, 5.0], [-1, 0, 0], ['stepsWidth']);
  // Datum: terrace and podium.
  probe('terrace-front', 'Position of the terrace wall (front)', [-30, 2.0, 300], [0, 0, -1]);
  probe('terrace-side', 'Position of the terrace wall (right)', [300, 2.0, -20], [-1, 0, 0]);
  probe('terrace-top', 'Height of the terrace', [-35, 300, zc], [0, -1, 0]);
  probe('podium-front', 'Position of the front of the podium', [-20, 6.0, 300], [0, 0, -1]);

  const cx = xs[0];
  b.dimension('terrace-width', 'Width of the terrace', [-tx, 0, 0], [tx, 0, 0], 'front');
  b.dimension('terrace-height', 'Height of the terrace wall', [-tx, 0, 0], [-tx, p.terraceHeight, 0], 'front');
  b.dimension('stylobate-height', 'Height of the stylobate', [-l.stylobate.x, 0, 0], [-l.stylobate.x, STYLOBATE, 0], 'front');
  b.dimension('column-height', 'Height of the columns, capital included', [cx + 0.58 * D, STYLOBATE, 0], [cx + 0.58 * D, l.capital, 0], 'front');
  b.dimension('column-pitch', 'Spacing of the front columns', [cx - 0.58 * D, l.capital, 0], [cx - 0.58 * D + l.pitchFront, l.capital, 0], 'front');
  b.dimension('overall-height', 'Overall height above the ground', [-ax, 0, 0], [-ax, l.top, 0], 'front');
  b.dimension('steps-width', 'Width of the lower steps', [-wA, 0, runA], [wA, 0, runA], 'front');
  b.dimension('podium-depth', 'Depth of the podium', [px, 6.0, zc + pz], [px, 6.0, zc - pz], 'right');
  b.dimension('terrace-depth', 'Depth of the terrace', [-tx, 0, 0], [-tx, 0, -p.terraceDepth], 'plan');
  b.dimension('steps-projection', 'Projection of the lower steps', [wA, 0, 0], [wA, 0, runA], 'plan');

  return { builder: b, probes, structure: { columns: 2 * p.columnsFront + 2 * p.columnsSide - 4, pitch: [Math.round(l.pitchFront * 100) / 100, Math.round(l.pitchSide * 100) / 100],
    height: Math.round(l.top * 100) / 100 } };
}

export default {
  id: 'lincoln-memorial',
  title: 'Lincoln Memorial, National Mall, Washington DC',
  frame: {
    origin: 'On the ground at the midpoint of the front (east) face of the terrace wall; that face is the plane z = 0, the memorial extends towards -Z and the lower flight of steps projects towards +Z.',
    front: 'The front, with the entrance and the main steps, faces +Z; +X is to the right when you look at the front.',
  },
  scope_note: 'The memorial on its terrace: terrace wall, podium, colonnade, entablature, attic, the hall walls seen through the entrance and the two flights of steps on the front. ' +
    'No ground plane, statue or interior furnishings, plaza, the Reflecting Pool, lamp posts, trees or people.',
  published: PUBLISHED, quantities: QUANTITIES, implausible, build,
};
