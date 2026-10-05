// Arc de Triomphe, Paris. Two piers carry the main vault (through the arch,
// front to rear) and are each pierced by a transverse vault (left to right);
// four sculpture groups on pedestals stand against the pier faces, reliefs sit
// above them and on the sides, an entablature (frieze and cornice) runs round
// the top of the body, and the attic above carries the shields.
//
// Frame: the front face is the plane z = 0 and the arch extends to z = -depth;
// x runs across, the main vault is centred on x = 0.
//
// The datum a twin never changes: the footprint, the plinth, the sculpture
// groups and the front reliefs. A twin changes the vaults, the attic, the
// shield count; a taller main vault pushes the entablature up with it.
import { ModelBuilder } from '../kit.mjs';
import { ringBand, roundArchHead } from './parts.mjs';

// Published figures: Wikipedia, "Arc de Triomphe", https://en.wikipedia.org/wiki/Arc_de_Triomphe
// (read 2026-10-05). Guides usually round them to 50 x 45 x 22 m; the precise ones are used.
const PUBLISHED = {
  // "width of 44.82 m (147.0 ft) and depth of 22.21 m (72.9 ft)"
  width: 44.82, depth: 22.21,
  // "its large vault is 29.19 m (95.8 ft) high and 14.62 m (48.0 ft) wide"
  archWidth: 14.62, archHeight: 29.19,
  // "The smaller transverse vaults are 18.68 m (61.3 ft) high and 8.44 m (27.7 ft) wide"
  vaultWidth: 8.44, vaultHeight: 18.68,
  // "30 shields engraved with the names of major French victories" on the attic
  shields: 30,
  // The attic: from the top of the entablature (37.5 m, estimated from elevations; no
  // published figure found) to the published "overall height of 49.54 m (162.5 ft)".
  atticHeight: 12.04,
};

// Estimated from photographs and elevation drawings; no published figures found.
const PLINTH_TOP = 2.0, PLINTH_PROUD = 0.35;
const FRIEZE_BASE = 33.0, CROWN_TO_FRIEZE = FRIEZE_BASE - PUBLISHED.archHeight, FRIEZE_HEIGHT = 2.6, CORNICE_HEIGHT = 1.9, CORNICE_PROUD = 1.2;
const ATTIC_INSET = 0.4, ATTIC_CORNICE = 0.85;
const PEDESTAL = { half: 4.0, top: 4.5, proud: 2.6 }, GROUP = { half: 3.2, top: 11.0, proud: 2.0, upperHalf: 2.2, upperTop: 15.0, upperProud: 1.6 };
const RELIEF = { half: 4.5, y0: 18.0, y1: 23.0, proud: 0.35, sideRise: 1.5, sideHeight: 4.5 };
const SHIELD = { radius: 0.8, proud: 0.3 };

const QUANTITIES = [
  { key: 'archWidth', label: 'Width of the main vault', kind: 'length', sourced: true },
  { key: 'archHeight', label: 'Height of the main vault', kind: 'length', sourced: true },
  { key: 'vaultWidth', label: 'Width of the transverse vaults', kind: 'length', sourced: true },
  { key: 'vaultHeight', label: 'Height of the transverse vaults', kind: 'length', sourced: true },
  { key: 'atticHeight', label: 'Height of the attic', kind: 'length', sourced: false },
  { key: 'shields', label: 'Number of shields on the attic', kind: 'count', sourced: true, steps: [-4, 4] },
];

// Heights that follow from the parameters.
function levels(p) {
  const spring = p.archHeight - p.archWidth / 2;
  const frieze = Math.max(FRIEZE_BASE, p.archHeight + CROWN_TO_FRIEZE);
  const entTop = frieze + FRIEZE_HEIGHT + CORNICE_HEIGHT;
  return { spring, frieze, entTop, height: entTop + p.atticHeight, vaultSpring: p.vaultHeight - p.vaultWidth / 2, pier: (p.width - p.archWidth) / 2 };
}

function implausible(p) {
  const l = levels(p);
  if (l.spring < p.vaultHeight + 1.5) return 'the transverse vaults would reach the springing of the main vault';
  if (l.pier < 11.5) return 'the piers would be too narrow for the sculpture groups';
  if (l.vaultSpring < 6) return 'the transverse vaults would spring too low';
  if (p.vaultWidth > p.depth - 9) return 'the transverse vaults would leave walls under 4.5 m';
  if (p.vaultHeight + RELIEF.sideRise + RELIEF.sideHeight > l.frieze - 1) return 'the side reliefs would run into the frieze';
  return null;
}

// Shields per main face and per side; the published 30 are ten on each main face and five on each side.
const shieldLayout = total => { const side = Math.round(total / 6); return { side, front: (total - 2 * side) / 2 }; };

function build(p) {
  const b = new ModelBuilder(), l = levels(p), w = p.width, d = p.depth, zc = -d / 2, half = p.vaultWidth / 2;
  const xp = (p.archWidth / 2 + w / 2) / 2;     // pier centre
  b.material('stone', '#ddd1b7', 'stone', { roughness: 0.9 });
  b.material('carved', '#cfc2a5', 'stone', { roughness: 0.9 });
  b.material('shield', '#c4b594', 'stone', { roughness: 0.85 });
  b.group('body', 'Piers and the masonry over the main vault', 'massing', 0.4, 'all');
  b.group('plinth', 'Plinth', 'ornament', 0.25, 'all');
  b.group('sculptures', 'Sculpture groups on their pedestals', 'ornament', 0.5, 'all');
  b.group('reliefs', 'Relief panels', 'ornament', 0.25, 'all');
  b.group('entablature', 'Frieze and cornice', 'ornament', 0.35, 'all');
  b.group('attic', 'Attic and its cornice', 'massing', 0.4, 'all');
  b.group('shields', 'Shields on the attic', 'ornament', 0.2, 'all');

  // Piers up to the springing, each pierced by its transverse vault (a prism
  // along X of the side profile); the masonry over the main vault spans both.
  const vault = roundArchHead(zc, l.vaultSpring, half, 16);
  const pierProfile = [[0, 0], [0, l.spring], [-d, l.spring], [-d, 0], [zc - half, 0], ...vault, [zc + half, 0]];
  b.prismX('pier-left', 'body', 'stone', pierProfile, -w / 2, -p.archWidth / 2);
  b.prismX('pier-right', 'body', 'stone', pierProfile, p.archWidth / 2, w / 2);
  const bodyTop = l.entTop - 0.05;
  const arch = roundArchHead(0, l.spring, p.archWidth / 2, 24);
  b.prismZ('vault-masonry', 'body', 'stone', [[-w / 2, l.spring], ...arch, [w / 2, l.spring], [w / 2, bodyTop], [-w / 2, bodyTop]], -d, 0);

  // Plinth round the outside, broken at the vault openings (it stops 3 cm short
  // of each jamb so its end does not lie in the jamb's plane).
  ringBand(b, { id: 'plinth', group: 'plinth', material: 'stone', x0: -w / 2, x1: w / 2, z0: -d, z1: 0, y0: 0, y1: PLINTH_TOP, proud: PLINTH_PROUD,
    gaps: { front: [[-p.archWidth / 2 - 0.03, p.archWidth / 2 + 0.03]], rear: [[-p.archWidth / 2 - 0.03, p.archWidth / 2 + 0.03]],
      left: [[zc - half - 0.03, zc + half + 0.03]], right: [[zc - half - 0.03, zc + half + 0.03]] } });

  // Sculpture groups: a pedestal and a two-stage block against the front and rear of each pier.
  for (const [side, x] of [['left', -xp], ['right', xp]]) {
    for (const [face, z, s] of [['front', 0, 1], ['rear', -d, -1]]) {
      // z range of a block standing `proud` out of this face and 5 cm into it.
      const id = 'group-' + face + '-' + side, span = proud => s > 0 ? [z - 0.05, z + proud] : [z - proud, z + 0.05];
      const [pz0, pz1] = span(PEDESTAL.proud), [gz0, gz1] = span(GROUP.proud), [uz0, uz1] = span(GROUP.upperProud);
      b.box(id + '-pedestal', 'sculptures', 'stone', [x - PEDESTAL.half, 0, pz0], [x + PEDESTAL.half, PEDESTAL.top, pz1]);
      b.box(id + '-lower', 'sculptures', 'carved', [x - GROUP.half, PEDESTAL.top - 0.02, gz0], [x + GROUP.half, GROUP.top, gz1]);
      b.box(id + '-upper', 'sculptures', 'carved', [x - GROUP.upperHalf, GROUP.top - 0.02, uz0], [x + GROUP.upperHalf, GROUP.upperTop, uz1]);
      // Relief panel above the group.
      const [rz0, rz1] = span(RELIEF.proud);
      b.box('relief-' + face + '-' + side, 'reliefs', 'carved', [x - RELIEF.half, RELIEF.y0, rz0], [x + RELIEF.half, RELIEF.y1, rz1]);
    }
  }
  // Side reliefs over the transverse vaults.
  const sideY0 = p.vaultHeight + RELIEF.sideRise, sideY1 = sideY0 + RELIEF.sideHeight;
  b.box('relief-left', 'reliefs', 'carved', [-w / 2 - RELIEF.proud, sideY0, zc - RELIEF.half], [-w / 2 + 0.05, sideY1, zc + RELIEF.half]);
  b.box('relief-right', 'reliefs', 'carved', [w / 2 - 0.05, sideY0, zc - RELIEF.half], [w / 2 + RELIEF.proud, sideY1, zc + RELIEF.half]);

  // Entablature: frieze, then a cornice whose inner edge runs into the attic, so
  // the top of the body is covered and nothing lies flush with it.
  ringBand(b, { id: 'frieze', group: 'entablature', material: 'carved', x0: -w / 2, x1: w / 2, z0: -d, z1: 0, y0: l.frieze, y1: l.frieze + FRIEZE_HEIGHT + 0.04, proud: 0.25 });
  ringBand(b, { id: 'cornice', group: 'entablature', material: 'stone', x0: -w / 2, x1: w / 2, z0: -d, z1: 0, y0: l.frieze + FRIEZE_HEIGHT, y1: l.entTop, proud: CORNICE_PROUD, embed: ATTIC_INSET + 0.05 });

  // Attic, set back from the faces, with its own crowning cornice.
  const ax = w / 2 - ATTIC_INSET, az0 = -d + ATTIC_INSET, az1 = -ATTIC_INSET;
  b.box('attic', 'attic', 'stone', [-ax, bodyTop - 0.05, az0], [ax, l.height, az1]);
  ringBand(b, { id: 'attic-cornice', group: 'attic', material: 'stone', x0: -ax, x1: ax, z0: az0, z1: az1, y0: l.height - 1.1, y1: l.height - 1.1 + ATTIC_CORNICE, proud: 0.6 });

  // Shields along the attic faces, between the cornice below and the attic cornice.
  const { front: nf, side: ns } = shieldLayout(p.shields), sy = l.entTop + (l.height - 1.1 - l.entTop) * 0.5, thick = SHIELD.proud + 0.05;
  const shield = (id, position, rotation) => b.add({ id, type: 'cylinder', radius: SHIELD.radius, height: thick, segments: 20, position, rotation, material: 'shield', group: 'shields' });
  for (let k = 0; k < nf; k++) {
    const x = -ax + 2.2 + (k + 0.5) * (2 * ax - 4.4) / nf;
    shield('shield-front-' + (k + 1), [x, sy, az1 + thick / 2 - 0.05], [Math.PI / 2, 0, 0]);
    shield('shield-rear-' + (k + 1), [x, sy, az0 - thick / 2 + 0.05], [Math.PI / 2, 0, 0]);
  }
  for (let k = 0; k < ns; k++) {
    const z = az0 + 2.2 + (k + 0.5) * (az1 - az0 - 4.4) / ns;
    shield('shield-left-' + (k + 1), [-ax - thick / 2 + 0.05, sy, z], [0, 0, Math.PI / 2]);
    shield('shield-right-' + (k + 1), [ax + thick / 2 - 0.05, sy, z], [0, 0, Math.PI / 2]);
  }

  // Probes. A probe's robustness window (checks.probeCheck) sees everything on
  // its line, behind the origin too, so every ray starts outside the arch: the
  // vault crowns from the ground under them, the jambs and the transverse vault
  // walls by oblique rays entering through the vault mouths, the attic and the
  // cornice from above, and the datum faces.
  const probes = [];
  const probe = (id, label, origin, direction, about = []) => probes.push({ id, label, origin, direction, about });
  const oblique = (hit, direction) => hit.map((v, i) => v - 150 * direction[i]);
  for (const z of [zc, -3.0]) probe('main-vault-crown', 'Height of the main vault crown', [0, 1.0, z], [0, 1, 0], ['archHeight']);
  // Jambs, 3.5 m into the vault from the front or the rear, by rays 40 degrees off their normal.
  const sj = Math.sin(50 * Math.PI / 180), cj = Math.cos(50 * Math.PI / 180);
  for (const [z, sz] of [[-3.5, -1], [-d + 3.5, 1]]) {
    for (const [side, s] of [['left', -1], ['right', 1]]) {
      const direction = [s * sj, 0, sz * cj];
      probe('main-vault-' + side, 'Position of the ' + side + ' jamb of the main vault', oblique([s * p.archWidth / 2, 8.0, z], direction), direction, ['archWidth']);
    }
  }
  // Transverse vault walls: a ray entering the mouth 35 degrees off the vault axis,
  // crossing the vault and meeting its far wall.
  const st = Math.sin(35 * Math.PI / 180), ct = Math.cos(35 * Math.PI / 180), cross = 1.4 * half / Math.tan(35 * Math.PI / 180);
  for (const [side, s] of [['left', -1], ['right', 1]]) {
    probe('vault-crown-' + side, 'Height of the ' + side + ' transverse vault crown', [s * xp, 1.0, zc], [0, 1, 0], ['vaultHeight']);
    const direction = [-s * ct, 0, st];
    probe('vault-side-' + side, 'Position of the far wall of the ' + side + ' transverse vault', oblique([s * (w / 2 - cross), 4.0, zc + half], direction), direction, ['vaultWidth']);
  }
  for (const [x, z] of [[w * 0.2, zc], [-w * 0.25, zc * 0.6]]) probe('attic-top', 'Height of the attic top', [x, 200, z], [0, -1, 0], ['atticHeight', 'archHeight']);
  // The cornice top between the overhang of the attic cornice and the cornice's edge.
  probe('cornice-top', 'Height of the main cornice', [w * 0.3, 200, (CORNICE_PROUD + 0.6 - ATTIC_INSET) / 2], [0, -1, 0], ['archHeight']);
  probe('front-face', 'Position of the front face', [xp, 16.5, 100], [0, 0, -1]);
  probe('rear-face', 'Position of the rear face', [-xp, 16.5, -100], [0, 0, 1]);
  probe('side-face-right', 'Position of the right side face', [100, 5.0, -3.0], [-1, 0, 0]);
  probe('side-face-left', 'Position of the left side face', [-100, 5.0, -3.0], [1, 0, 0]);
  probe('sculpture-front', 'Position of the front sculpture groups', [xp, 7.0, 100], [0, 0, -1]);

  // Dimensions on edges the drawings show.
  b.dimension('overall-width', 'Overall width above the plinth', [-w / 2, PLINTH_TOP, 0], [w / 2, PLINTH_TOP, 0], 'front');
  b.dimension('overall-height', 'Overall height', [ax, 0, 0], [ax, l.height, 0], 'front');
  b.dimension('arch-width', 'Width of the main vault', [-p.archWidth / 2, PLINTH_TOP, 0], [p.archWidth / 2, PLINTH_TOP, 0], 'front');
  b.dimension('arch-springing', 'Height of the springing of the main vault', [-p.archWidth / 2, 0, 0], [-p.archWidth / 2, l.spring, 0], 'front');
  b.dimension('entablature-top', 'Height to the top of the cornice', [-w / 2, 0, 0], [-w / 2, l.entTop, 0], 'front');
  b.dimension('depth', 'Depth', [w / 2, 0, 0], [w / 2, 0, -d], 'right');
  b.dimension('vault-width', 'Width of the transverse vault', [w / 2, 0, zc + half], [w / 2, 0, zc - half], 'right');
  b.dimension('vault-springing', 'Height of the springing of the transverse vault', [w / 2, 0, zc + half], [w / 2, l.vaultSpring, zc + half], 'right');
  b.dimension('attic-width', 'Width of the attic', [-ax, l.height, az1], [ax, l.height, az1], 'plan');

  return { builder: b, probes, structure: { shields: { front: nf, side: ns }, entablature: l.frieze > FRIEZE_BASE + 1e-9 ? 'raised' : 'as published', height: Math.round(l.height * 100) / 100 } };
}

export default {
  id: 'arc-de-triomphe',
  title: 'Arc de Triomphe, Place Charles de Gaulle, Paris',
  frame: {
    origin: 'On the ground at the midpoint of the front face, under the centre of the main vault; the front face is the plane z = 0 and the arch extends towards -Z.',
    front: 'The front, facing down the Champs-Élysées, faces +Z; +X is to the right when you look at the front.',
  },
  scope_note: 'The arch only: its piers and vaults, the sculpture groups on their pedestals, the reliefs, the frieze and cornice, the attic and its shields. ' +
    'No ground plane, roadway, the tomb and flame under the vault, railings, flagpoles, trees or the surrounding square.',
  published: PUBLISHED, quantities: QUANTITIES, implausible, build,
};
