// A small hand-written ground-truth model. It exists so that every v1 module can
// be developed and tested against one fixed object before the procedural
// generator lands, and it stays as the regression fixture afterwards.
//
// Frame: origin on the ground at the midpoint of the front wall; the front wall
// face is the plane z = 0 and the body extends towards -Z.
const WIDTH = 9, DEPTH = 7, EAVE = 5.4, WALL = 0.3, ROOF_HALF = 3.95, ROOF_RISE = 2.93, ROOF_BASE = 5.3;

function windowParts(id, group, cx, y0, y1, width) {
  const cy = (y0 + y1) / 2, height = y1 - y0, frame = 0.07, parts = [];
  parts.push({ id: id + '.glass', type: 'box', size: [width, height, 0.02], position: [cx, cy, -0.16], material: 'glass', group });
  for (const [name, size, offset] of [
    ['left', [frame, height, 0.1], [-(width - frame) / 2, 0]], ['right', [frame, height, 0.1], [(width - frame) / 2, 0]],
    ['head', [width, frame, 0.1], [0, (height - frame) / 2]], ['sill', [width, frame, 0.1], [0, -(height - frame) / 2]],
  ]) parts.push({ id: id + '.frame-' + name, type: 'box', size, position: [cx + offset[0], cy + offset[1], -0.08], material: 'frame', group });
  parts.push({ id: id + '.mullion', type: 'box', size: [0.05, height - 2 * frame, 0.07], position: [cx, cy, -0.095], material: 'frame', group });
  return parts;
}

export function sampleModel() {
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const ground = [-2.7, 2.7].map(x => ({ x, y0: 0.9, y1: 2.3, w: 1.4 }));
  const upper = [-2.7, 0, 2.7].map(x => ({ x, y0: 3.2, y1: 4.5, w: 1.2 }));
  const openings = [...ground, ...upper].map(o => rect(o.x - o.w / 2, o.y0, o.x + o.w / 2, o.y1));
  const gable = [[-DEPTH / 2, 0], [DEPTH / 2, 0], [0, 2.6]];
  const parts = [
    { id: 'wall-front', type: 'extrude', polygon: rect(-WIDTH / 2, 0, WIDTH / 2, EAVE), holes: [...openings, rect(-0.55, 0.15, 0.55, 2.25)],
      depth: WALL, position: [0, 0, -WALL], material: 'render', group: 'body' },
    { id: 'wall-rear', type: 'box', size: [WIDTH, EAVE, WALL], position: [0, EAVE / 2, -DEPTH + WALL / 2], material: 'render', group: 'body' },
    { id: 'wall-left', type: 'box', size: [WALL, EAVE, DEPTH - 2 * WALL], position: [-(WIDTH - WALL) / 2, EAVE / 2, -DEPTH / 2], material: 'render', group: 'body' },
    { id: 'wall-right', type: 'box', size: [WALL, EAVE, DEPTH - 2 * WALL], position: [(WIDTH - WALL) / 2, EAVE / 2, -DEPTH / 2], material: 'render', group: 'body' },
    { id: 'gable-left', type: 'extrude', polygon: gable, depth: WALL, rotation: [0, Math.PI / 2, 0], position: [-WIDTH / 2, EAVE, -DEPTH / 2], material: 'render', group: 'body' },
    { id: 'gable-right', type: 'extrude', polygon: gable, depth: WALL, rotation: [0, Math.PI / 2, 0], position: [WIDTH / 2 - WALL, EAVE, -DEPTH / 2], material: 'render', group: 'body' },
    // Inset so its edges sit inside the walls: coplanar faces of two parts z-fight in every renderer.
    { id: 'floor', type: 'box', size: [WIDTH - 0.1, 0.15, DEPTH - 0.1], position: [0, 0.075, -DEPTH / 2], material: 'stone', group: 'body' },
    { id: 'roof', type: 'extrude', polygon: [[-ROOF_HALF, 0], [ROOF_HALF, 0], [0, ROOF_RISE]], depth: WIDTH + 0.8, rotation: [0, Math.PI / 2, 0],
      position: [-WIDTH / 2 - 0.4, ROOF_BASE, -DEPTH / 2], material: 'tile', group: 'roof' },
    { id: 'chimney', type: 'box', size: [0.7, 1.8, 0.7], position: [2.6, 7.9, -4.2], material: 'brick', group: 'chimney' },
    { id: 'door', type: 'box', size: [1.1, 2.1, 0.06], position: [0, 1.2, -0.2], material: 'door', group: 'front.door' },
    { id: 'door-step', type: 'box', size: [1.5, 0.15, 0.5], position: [0, 0.075, 0.25], material: 'stone', group: 'front.door' },
    { id: 'canopy', type: 'box', size: [1.9, 0.12, 1.0], position: [0, 2.55, 0.5], material: 'tile', group: 'front.canopy' },
    { id: 'canopy-post-left', type: 'beam', start: [-0.85, 0.15, 0.9], end: [-0.85, 2.49, 0.9], radius: 0.05, material: 'steel', group: 'front.canopy' },
    { id: 'canopy-post-right', type: 'beam', start: [0.85, 0.15, 0.9], end: [0.85, 2.49, 0.9], radius: 0.05, material: 'steel', group: 'front.canopy' },
    ...ground.flatMap((o, i) => windowParts('window-ground-' + i, 'front.windows.ground', o.x, o.y0, o.y1, o.w)),
    ...upper.flatMap((o, i) => windowParts('window-upper-' + i, 'front.windows.upper', o.x, o.y0, o.y1, o.w)),
  ];
  return {
    schema: 'e3d-model-v1', id: 'sample-house', archetype: 'fixture', seed: 0, title: 'Two-storey gabled house',
    frame: {
      origin: 'On the ground at the midpoint of the front wall; the front wall face is the plane z = 0.',
      front: 'The front facade (with the entrance door) faces +Z; +X is to the right when you look at the front.',
    },
    scope_note: 'The house exterior only: walls, roof, chimney, openings and the entrance canopy. No ground plane, garden or neighbours.',
    materials: {
      render: { color: '#d8cfc0', roughness: 0.9, kind: 'wall' }, tile: { color: '#6b4a3f', roughness: 0.8, kind: 'roof' },
      brick: { color: '#8f5b4a', roughness: 0.9, kind: 'wall' }, glass: { color: '#2d3f4a', roughness: 0.1, kind: 'glass' },
      frame: { color: '#f2f0ea', roughness: 0.6, kind: 'frame' }, door: { color: '#7a2e2a', roughness: 0.6, kind: 'wood' },
      stone: { color: '#9a968c', roughness: 0.9, kind: 'stone' }, steel: { color: '#55595e', roughness: 0.4, metalness: 0.8, kind: 'metal' },
    },
    groups: [
      { id: 'body', title: 'Walls and floor slab', category: 'massing', detail_size_m: 0.3, facade: 'all' },
      { id: 'roof', title: 'Gabled roof', category: 'roof', detail_size_m: 0.3, facade: 'roof' },
      { id: 'chimney', title: 'Chimney', category: 'roof', detail_size_m: 0.3, facade: 'roof' },
      { id: 'front.door', title: 'Entrance door and step', category: 'entrance', detail_size_m: 0.06, facade: 'front' },
      { id: 'front.canopy', title: 'Entrance canopy and posts', category: 'attachments', detail_size_m: 0.1, facade: 'front' },
      { id: 'front.windows.ground', title: 'Ground-floor windows', category: 'openings', detail_size_m: 0.07, facade: 'front' },
      { id: 'front.windows.upper', title: 'Upper-floor windows', category: 'openings', detail_size_m: 0.07, facade: 'front' },
    ],
    probes: [
      { id: 'ridge-height', label: 'Roof ridge height', origin: [0, 40, -DEPTH / 2], direction: [0, -1, 0] },
      { id: 'left-wall', label: 'Left wall position', origin: [-40, 2.7, -DEPTH / 2], direction: [1, 0, 0] },
      { id: 'right-wall', label: 'Right wall position', origin: [40, 2.7, -DEPTH / 2], direction: [-1, 0, 0] },
      { id: 'rear-wall', label: 'Rear wall position', origin: [3.9, 2.7, -40], direction: [0, 0, 1] },
      { id: 'canopy-top', label: 'Canopy top height', origin: [0, 40, 0.5], direction: [0, -1, 0] },
    ],
    dimensions: [
      { id: 'overall-width', label: 'Overall width', value_m: WIDTH, a: [-WIDTH / 2, 0, 0], b: [WIDTH / 2, 0, 0], view: 'front' },
      { id: 'eave-height', label: 'Eaves height', value_m: EAVE, a: [-WIDTH / 2, 0, 0], b: [-WIDTH / 2, EAVE, 0], view: 'front' },
      { id: 'ridge-height', label: 'Ridge height', value_m: ROOF_BASE + ROOF_RISE, a: [0, 0, 0], b: [0, ROOF_BASE + ROOF_RISE, 0], view: 'front' },
      { id: 'overall-depth', label: 'Overall depth', value_m: DEPTH, a: [WIDTH / 2, 0, 0], b: [WIDTH / 2, 0, -DEPTH], view: 'plan' },
      { id: 'door-width', label: 'Door opening width', value_m: 1.1, a: [-0.55, 0.15, 0], b: [0.55, 0.15, 0], view: 'front' },
    ],
    parts,
  };
}
