// Geometry helpers for the landmark models. The generator kit (../kit.mjs)
// covers walls, openings and roofs; monuments also need tapered solids,
// panels lying in sloped faces, round arches and bands that wrap a block.
// Layering follows the kit's rule: no two parts have parallel faces that
// overlap closer than 2 cm, so attachments are embedded, never laid flush.
const unit = v => { const length = Math.hypot(...v); return v.map(x => x / length); };
const add = (a, b, s = 1) => a.map((v, i) => v + s * b[i]);

// Square frustum (or pyramid when h1 is 0) on the vertical axis through
// (cx, cz): half widths h0 at y0 and h1 at y1. A closed convex mesh.
export function squareFrustum(b, id, group, material, { y0, y1, h0, h1, cx = 0, cz = 0 }) {
  const ring = (y, h) => [[cx - h, y, cz - h], [cx + h, y, cz - h], [cx + h, y, cz + h], [cx - h, y, cz + h]];
  if (h1 <= 1e-6) {
    const vertices = [...ring(y0, h0), [cx, y1, cz]];
    return b.convex(id, group, material, vertices, [[0, 1, 2, 3], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]]);
  }
  const vertices = [...ring(y0, h0), ...ring(y1, h1)];
  return b.convex(id, group, material, vertices, [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]);
}

// A box given by its centre, two in-plane unit axes and the outward normal,
// with half sizes along each: a panel lying in any face, sloped or not.
export function orientedBox(b, id, group, material, { centre, u, v, n, hu, hv, hn }) {
  const vertices = [];
  for (const su of [-1, 1]) for (const sv of [-1, 1]) for (const sn of [-1, 1]) vertices.push(add(add(add(centre, u, su * hu), v, sv * hv), n, sn * hn));
  // Index = su * 4 + sv * 2 + sn with each sign as 0 / 1.
  const faces = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
  return b.convex(id, group, material, vertices, faces);
}

// Points of a round (semicircular) arch head from the left springing over the
// crown to the right springing, in the 2-D coordinates of its elevation. An
// even segment count puts a vertex exactly on the crown.
export function roundArchHead(centre, spring, radius, segments = 24) {
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const a = Math.PI - Math.PI * i / segments;
    points.push([centre + radius * Math.cos(a), spring + radius * Math.sin(a)]);
  }
  return points;
}

// Four boxes wrapping the block [x0, x1] x [z0, z1] between heights y0 and y1:
// plinths, string courses, cornices. They stand `proud` of the faces and reach
// `embed` into the block. Front and rear runs span the corners; side runs stop
// short of them, so no two faces overlap. `gaps` breaks runs: { front: [[x0, x1]],
// rear: [...], left: [[z0, z1]], right: [...] }. `sides` limits the faces wrapped.
export function ringBand(b, { id, group, material, x0, x1, z0, z1, y0, y1, proud, embed = 0.05, gaps = {}, sides = ['front', 'rear', 'left', 'right'] }) {
  const p = proud, e = embed;
  const pieces = (from, to, list = []) => {
    const out = [];
    let start = from;
    for (const [g0, g1] of [...list].sort((a, c) => a[0] - c[0])) {
      if (g0 > start + 0.05) out.push([start, g0]);
      start = Math.max(start, g1);
    }
    if (to > start + 0.05) out.push([start, to]);
    return out;
  };
  const made = [];
  const run = (name, spans, make) => spans.forEach(([a, c], k) => made.push(make(id + '-' + name + (spans.length > 1 ? '-' + (k + 1) : ''), a, c)));
  if (sides.includes('front')) run('front', pieces(x0 - p, x1 + p, gaps.front), (pid, a, c) => b.box(pid, group, material, [a, y0, z1 - e], [c, y1, z1 + p]));
  if (sides.includes('rear')) run('rear', pieces(x0 - p, x1 + p, gaps.rear), (pid, a, c) => b.box(pid, group, material, [a, y0, z0 - p], [c, y1, z0 + e]));
  if (sides.includes('left')) run('left', pieces(z0 + e, z1 - e, gaps.left), (pid, a, c) => b.box(pid, group, material, [x0 - p, y0, a], [x0 + e, y1, c]));
  if (sides.includes('right')) run('right', pieces(z0 + e, z1 - e, gaps.right), (pid, a, c) => b.box(pid, group, material, [x1 - e, y0, a], [x1 + p, y1, c]));
  return made;
}

export { unit };
