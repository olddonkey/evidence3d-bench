// Washington Monument, Washington, D.C. A tapering square marble shaft with a
// visible change of marble a third of the way up, a pyramidion with pairs of
// observation windows in its faces, and the entrance pavilion on the east face.
//
// Frame: the origin is on the ground on the axis of the shaft; the east face,
// with the entrance pavilion, faces +Z.
//
// The datum a twin never changes: the base width and the taper of the shaft, so
// both states share the shaft faces up to the lower of the two shaft heights. A
// twin changes the shaft height (the top width follows the taper), the
// pyramidion, the number of windows and the pavilion.
import { ModelBuilder } from '../kit.mjs';
import { squareFrustum, orientedBox, unit } from './parts.mjs';

const FT = 0.3048, IN = 0.0254;
const PUBLISHED = {
  // National Park Service, National Register nomination (NRHP 66000035), quoted at
  // https://npgallery.nps.gov/NRHP/GetAsset/NRHP/66000035_text: "The shaft tapers from a base
  // width of 55' 1-1/2" to a width of 34' 5-1/2" at the 500' level". The ASCE landmark page
  // (https://www.asce.org/about-civil-engineering/history-and-heritage/historic-landmarks/washington-monument)
  // says "just under 40 feet at the top of the shaft"; the NPS figure is used.
  baseWidth: 55 * FT + 1.5 * IN, topWidth: 34 * FT + 5.5 * IN,
  // NPS (same nomination): "555' 5-1/8" tall, 500 of these feet forming the shaft while the
  // remainder constitute the capping pyramidion". The 2013-14 National Geodetic Survey gave
  // 554' 7-11/32" (169.046 m; https://en.wikipedia.org/wiki/Washington_Monument); the long
  // quoted 555' 5-1/8" (169.294 m) is what is remembered and is used.
  shaftHeight: 500 * FT, pyramidionHeight: 55 * FT + 5.125 * IN,
  // Wikipedia (above): "Four pairs of 3-foot (91 cm) wide observation windows ... Six are
  // 1 foot 6 inches (46 cm) high while two on the east face are 2 feet (61 cm) high."
  windows: 8,
  // The marble changes colour where construction stopped in 1854 and resumed in 1879, at
  // 150 ft: https://washington.org/dc-guide-to/washington-monument ("begins at the 150-foot mark").
  colourChange: 150 * FT,
  // The entrance pavilion (security screening facility on the east face): no published
  // dimensions found; estimated from photographs.
  pavilionWidth: 9.0, pavilionDepth: 6.0,
};
const TAPER = (PUBLISHED.baseWidth - PUBLISHED.topWidth) / 2 / PUBLISHED.shaftHeight;   // per side, per metre of height
// Window rise above the shaft top, pitch, frame bar width and how far the frame stands out: estimated.
const WINDOW = { width: 3 * FT, height: 1.5 * FT, eastHeight: 2 * FT, rise: 1.6, pitch: 2.0, bar: 0.18, proud: 0.3 };
const PAVILION_HEIGHT = 4.2;

const QUANTITIES = [
  { key: 'shaftHeight', label: 'Height of the shaft', kind: 'length', sourced: true },
  { key: 'pyramidionHeight', label: 'Height of the pyramidion', kind: 'length', sourced: true },
  { key: 'windows', label: 'Number of observation windows', kind: 'count', sourced: true, steps: [-4, 4] },
  { key: 'pavilionWidth', label: 'Width of the entrance pavilion', kind: 'length', sourced: false },
  { key: 'pavilionDepth', label: 'Projection of the entrance pavilion', kind: 'length', sourced: false },
];

const halfAt = (p, y) => p.baseWidth / 2 - TAPER * y;

function implausible(p) {
  const top = halfAt(p, p.shaftHeight), perFace = p.windows / 4;
  if (top < 3.5) return 'the shaft would taper to under 7 m';
  if (p.pyramidionHeight / top < 1.8 || p.pyramidionHeight / top > 5) return 'the pyramidion would be too flat or too sharp';
  const halfAtWindows = top * (1 - WINDOW.rise / p.pyramidionHeight);
  if ((perFace - 1) / 2 * WINDOW.pitch + WINDOW.width / 2 + 0.6 > halfAtWindows) return 'the windows would not fit their face';
  if (p.pavilionWidth > p.baseWidth - 3) return 'the pavilion would be wider than the shaft';
  if (p.colourChange > p.shaftHeight - 20) return 'the shaft would end near the colour change';
  return null;
}

function build(p) {
  const b = new ModelBuilder();
  b.material('marble', '#e4e0d6', 'stone', { roughness: 0.85 });
  // The upper marble weathered a slightly different shade from the lower third.
  b.material('marble-upper', '#dcd6ca', 'stone', { roughness: 0.85 });
  b.material('glass', '#26343c', 'glass', { roughness: 0.1 });
  b.material('granite', '#9b968c', 'stone', { roughness: 0.8 });
  b.material('frame', '#4a4f53', 'metal', { roughness: 0.5, metalness: 0.5 });
  b.group('shaft.lower', 'Shaft below the change of marble', 'massing', 0.5, 'all');
  b.group('shaft.upper', 'Shaft above the change of marble', 'massing', 0.5, 'all');
  b.group('pyramidion', 'Pyramidion', 'roof', 0.4, 'all');
  b.group('windows', 'Observation windows', 'openings', 0.1, 'all');
  b.group('entrance', 'Entrance pavilion', 'entrance', 0.2, 'front');

  const h0 = p.baseWidth / 2, hc = halfAt(p, p.colourChange), h1 = halfAt(p, p.shaftHeight), Hs = p.shaftHeight, Hp = p.pyramidionHeight;
  squareFrustum(b, 'shaft-lower', 'shaft.lower', 'marble', { y0: 0, y1: p.colourChange, h0, h1: hc });
  squareFrustum(b, 'shaft-upper', 'shaft.upper', 'marble-upper', { y0: p.colourChange, y1: Hs, h0: hc, h1 });

  // Pyramidion: one closed solid. The windows are framed on its faces: a ring of
  // four bars and the glass set back inside it. (Face slabs pierced by real holes
  // were tried: the slabs' hip faces lie within a few degrees of the next face
  // and z-fight along every hip.)
  squareFrustum(b, 'pyramidion', 'pyramidion', 'marble-upper', { y0: Hs, y1: Hs + Hp, h0: h1, h1: 0 });
  const apex = [0, Hs + Hp, 0], slant = Math.hypot(Hp, h1), perFace = p.windows / 4;
  const faces = [['front', [1, 0, 0], [0, 0, 1]], ['right', [0, 0, -1], [1, 0, 0]], ['rear', [-1, 0, 0], [0, 0, -1]], ['left', [0, 0, 1], [-1, 0, 0]]];
  for (const [name, u, out] of faces) {
    const base = [out[0] * h1, Hs, out[2] * h1], v = unit([apex[0] - base[0], apex[1] - base[1], apex[2] - base[2]]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const tall = (name === 'front' ? WINDOW.eastHeight : WINDOW.height) * slant / Hp, vc = WINDOW.rise * slant / Hp;
    // A point on this face at (du, dv) in its plane, dn off it.
    const at = (du, dv, dn) => [0, 1, 2].map(i => base[i] + u[i] * du + v[i] * dv + n[i] * dn);
    for (let k = 0; k < perFace; k++) {
      const uc = (k - (perFace - 1) / 2) * WINDOW.pitch, id = 'window-' + name + '-' + (k + 1), hw = WINDOW.width / 2, hh = tall / 2, bar = WINDOW.bar;
      // Bars 5 cm into the face and standing out; the glass 4 cm in and 10 cm out, so it sits in the frame's recess.
      const frame = (suffix, du, dv, hu, hv) => orientedBox(b, id + '-' + suffix, 'windows', 'frame', { centre: at(uc + du, vc + dv, (WINDOW.proud - 0.05) / 2), u, v, n, hu, hv, hn: (WINDOW.proud + 0.05) / 2 });
      frame('head', 0, hh + bar / 2, hw + bar, bar / 2);
      frame('sill', 0, -hh - bar / 2, hw + bar, bar / 2);
      frame('left', -hw - bar / 2, 0, bar / 2, hh);
      frame('right', hw + bar / 2, 0, bar / 2, hh);
      orientedBox(b, id + '-glass', 'windows', 'glass', { centre: at(uc, vc, 0.03), u, v, n, hu: hw + 0.02, hv: hh + 0.02, hn: 0.07 });
    }
  }

  // Entrance pavilion against the east face, its back 15 cm inside the shaft.
  const pw = p.pavilionWidth / 2, pz0 = h0 - 0.15, pz1 = h0 + p.pavilionDepth;
  b.box('pavilion', 'entrance', 'granite', [-pw, 0, pz0], [pw, PAVILION_HEIGHT, pz1]);
  b.box('pavilion-roof', 'entrance', 'granite', [-pw - 0.3, PAVILION_HEIGHT - 0.05, pz0], [pw + 0.3, PAVILION_HEIGHT + 0.4, pz1 + 0.3]);
  const gw = pw - 1.2;
  b.box('pavilion-glazing', 'entrance', 'glass', [-gw, 0.25, pz1 - 0.05], [gw, PAVILION_HEIGHT - 0.6, pz1 + 0.14]);
  for (let k = 0; k <= 3; k++) {
    const x = -gw + k * 2 * gw / 3;
    b.box('pavilion-mullion-' + (k + 1), 'entrance', 'frame', [x - 0.06, 0.2, pz1 + 0.1], [x + 0.06, PAVILION_HEIGHT - 0.55, pz1 + 0.26]);
  }

  const probes = [];
  const probe = (id, label, origin, direction, about = []) => probes.push({ id, label, origin, direction, about });
  // Pyramidion faces at the twin's own heights; near the apex, where a changed
  // height moves the face most.
  for (const f of [0.4, 0.6]) {
    const y = Hs + f * Hp;
    probe('pyramidion-front', 'Position of the east face of the pyramidion', [0.8, y, 400], [0, 0, -1], ['shaftHeight', 'pyramidionHeight']);
    probe('pyramidion-right', 'Position of the north face of the pyramidion', [400, y, -0.8], [-1, 0, 0], ['shaftHeight', 'pyramidionHeight']);
    probe('pyramidion-rear', 'Position of the west face of the pyramidion', [-0.8, y, -400], [0, 0, 1], ['shaftHeight', 'pyramidionHeight']);
  }
  probe('pyramidion-upper', 'Position of the south face of the pyramidion near the apex', [-400, Hs + 0.8 * Hp, 0], [1, 0, 0], ['shaftHeight', 'pyramidionHeight']);
  // The same faces at the heights the published pyramidion occupies.
  const Hpub = PUBLISHED.shaftHeight, Ppub = PUBLISHED.pyramidionHeight;
  probe('upper-front', 'Position of the east face at the published pyramidion height', [-0.8, Hpub + 0.45 * Ppub, 400], [0, 0, -1], ['shaftHeight', 'pyramidionHeight']);
  probe('upper-right', 'Position of the north face at the published pyramidion height', [400, Hpub + 0.8 * Ppub, 0], [-1, 0, 0], ['shaftHeight', 'pyramidionHeight']);
  probe('pavilion-front', 'Position of the front of the entrance pavilion', [gw + 0.45, 2.0, 400], [0, 0, -1], ['pavilionDepth']);
  probe('pavilion-side', 'Position of the side of the entrance pavilion', [400, 2.0, (pz0 + 0.15 + pz1) / 2], [-1, 0, 0], ['pavilionWidth']);
  // Datum: the shaft faces.
  probe('shaft-front', 'Position of the east face of the shaft', [2.0, 30, 400], [0, 0, -1]);
  probe('shaft-right', 'Position of the north face of the shaft', [400, 60, 1.5], [-1, 0, 0]);
  probe('shaft-rear', 'Position of the west face of the shaft', [-1.5, 80, -400], [0, 0, 1]);
  probe('shaft-left', 'Position of the south face of the shaft', [-400, 20, -2.0], [1, 0, 0]);

  b.dimension('base-width', 'Width of the shaft at the base', [-h0, 0, 0], [h0, 0, 0], 'front');
  b.dimension('shaft-height', 'Height of the shaft', [-h1, 0, 0], [-h1, Hs, 0], 'front');
  b.dimension('top-width', 'Width of the shaft at its top', [-h1, Hs, 0], [h1, Hs, 0], 'front');
  b.dimension('overall-height', 'Overall height', [0, 0, 0], [0, Hs + Hp, 0], 'front');
  b.dimension('colour-change', 'Height of the change of marble', [-hc, 0, 0], [-hc, p.colourChange, 0], 'front');
  b.dimension('pavilion-width', 'Width of the entrance pavilion', [-pw, 0, pz1], [pw, 0, pz1], 'front');
  b.dimension('pavilion-depth', 'Projection of the entrance pavilion', [pw, 0, h0], [pw, 0, pz1], 'plan');
  b.dimension('pavilion-height', 'Height of the entrance pavilion walls', [pw, 0, pz1], [pw, PAVILION_HEIGHT, pz1], 'right');

  return { builder: b, probes, structure: { windowsPerFace: perFace, topWidth: Math.round(2 * h1 * 100) / 100, height: Math.round((Hs + Hp) * 100) / 100 } };
}

export default {
  id: 'washington-monument',
  title: 'Washington Monument, National Mall, Washington DC',
  frame: {
    origin: 'On the ground at the centre of the base of the shaft (its axis); the ground is y = 0.',
    front: 'The front, the east face with the entrance pavilion, faces +Z; +X is to the right when you look at the front.',
  },
  scope_note: 'The obelisk and its entrance pavilion only: shaft, pyramidion with its windows, and the pavilion against the east face. ' +
    'No ground plane, plaza, the ring of flagpoles, paths, benches, trees or other buildings.',
  published: PUBLISHED, quantities: QUANTITIES, implausible, build,
};
