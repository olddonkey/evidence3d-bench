// Building blocks shared by the archetype generators: a part collector with the
// model-level bookkeeping (materials, groups, probes, dimensions), wall frames
// that let openings, frames and attachments be written in wall coordinates, and
// the recurring fittings (windows, doors, roofs, bands, rails, ladders).
//
// Layering rule used throughout (DESIGN.md section 5): no two parts may have
// parallel faces that overlap closer than 2 cm, hidden or not, because every
// renderer z-fights them. Attachments are therefore embedded 2-5 cm into their
// host instead of being laid flush on it, and the depth layers inside a window
// (frame, glazing bars, glass) are 2 cm apart.
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

// Model JSON keeps 0.1 mm: enough for every inset and stable across platforms.
export const r4 = value => { const v = Math.round(value * 1e4) / 1e4; return Object.is(v, -0) ? 0 : v; };
export const snap = (value, step) => Math.round(value / step) * step;
export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
export const lerp = (a, b, t) => a + (b - a) * t;
const unit = v => { const length = Math.hypot(...v); return v.map(x => x / length); };

// Uniform draws on a grid so generated buildings have survey-like dimensions.
export const draw = (r, low, high, step = 0.05) => snap(r.range(low, high), step);

export class ModelBuilder {
  constructor() {
    this.parts = []; this.partIds = new Set();
    this.groups = []; this.groupIds = new Set();
    this.materials = {};
    this.probes = []; this.dimensions = [];
  }

  material(name, color, kind, { roughness = 0.8, metalness = 0 } = {}) {
    this.materials[name] = { color, roughness, metalness, kind };
    return name;
  }

  group(id, title, category, detail_size_m, facade) {
    if (this.groupIds.has(id)) throw new Error('Generator: duplicate group ' + id);
    this.groupIds.add(id);
    this.groups.push({ id, title, category, detail_size_m, facade });
    return id;
  }

  add(part) {
    if (this.partIds.has(part.id)) throw new Error('Generator: duplicate part id ' + part.id);
    if (!this.groupIds.has(part.group)) throw new Error('Generator: part ' + part.id + ' uses undeclared group ' + part.group);
    if (!this.materials[part.material]) throw new Error('Generator: part ' + part.id + ' uses undeclared material ' + part.material);
    this.partIds.add(part.id);
    this.parts.push(part);
    return part;
  }

  // Axis-aligned box between two corners.
  box(id, group, material, min, max) {
    const lo = [0, 1, 2].map(i => Math.min(min[i], max[i])), hi = [0, 1, 2].map(i => Math.max(min[i], max[i]));
    const size = [0, 1, 2].map(i => hi[i] - lo[i]);
    if (!size.every(s => s > 1e-4)) throw new Error('Generator: box ' + id + ' has a non-positive size ' + size.join(','));
    return this.add({ id, type: 'box', size, position: [0, 1, 2].map(i => (lo[i] + hi[i]) / 2), material, group });
  }

  // Box turned about +Y by yaw (DESIGN.md: x' = x cos + z sin, z' = -x sin + z cos).
  turnedBox(id, group, material, center, size, yaw) {
    return this.add({ id, type: 'box', size, position: center, rotation: [0, yaw, 0], material, group });
  }

  beam(id, group, material, start, end, radius, segments = 12) {
    return this.add({ id, type: 'beam', start, end, radius, segments, material, group });
  }

  // Vertical cylinder or cone standing on `base`.
  cylinder(id, group, material, base, height, radius, { top = radius, segments = 32, yaw = 0 } = {}) {
    const part = { id, type: 'cylinder', radius: top, radius_bottom: radius, height, segments,
      position: [base[0], base[1] + height / 2, base[2]], material, group };
    if (yaw) part.rotation = [0, yaw, 0];
    return this.add(part);
  }

  extrude(id, group, material, { polygon, holes, depth, position, rotation }) {
    const part = { id, type: 'extrude', polygon, depth, position, material, group };
    if (holes?.length) part.holes = holes;
    if (rotation) part.rotation = rotation;
    return this.add(part);
  }

  // Vertical prism from a footprint polygon given as [x, z] points.
  prismY(id, group, material, footprint, y0, y1, holes) {
    return this.extrude(id, group, material, { polygon: footprint.map(([x, z]) => [x, -z]), holes: holes?.map(h => h.map(([x, z]) => [x, -z])),
      depth: y1 - y0, position: [0, y0, 0], rotation: [-Math.PI / 2, 0, 0] });
  }

  // Prism along X from a profile of [z, y] points.
  prismX(id, group, material, profile, x0, x1) {
    return this.extrude(id, group, material, { polygon: profile.map(([z, y]) => [-z, y]), depth: x1 - x0, position: [x0, 0, 0], rotation: [0, Math.PI / 2, 0] });
  }

  // Prism along Z from a profile of [x, y] points.
  prismZ(id, group, material, profile, z0, z1) {
    return this.extrude(id, group, material, { polygon: profile, depth: z1 - z0, position: [0, 0, z0] });
  }

  // Closed convex solid from polygonal faces; each face is turned to face away
  // from the centroid so the exported winding (and Blender's normals) is outward.
  convex(id, group, material, vertices, faces) {
    const centre = [0, 1, 2].map(i => vertices.reduce((sum, v) => sum + v[i], 0) / vertices.length);
    const triangles = [];
    for (const face of faces) {
      const [a, b, c] = face.slice(0, 3).map(i => vertices[i]);
      const n = cross3(sub3(b, a), sub3(c, a));
      const mid = [0, 1, 2].map(i => face.reduce((sum, k) => sum + vertices[k][i], 0) / face.length);
      const ordered = dot3(n, sub3(mid, centre)) >= 0 ? face : [...face].reverse();
      for (let k = 1; k + 1 < ordered.length; k++) triangles.push([ordered[0], ordered[k], ordered[k + 1]]);
    }
    return this.add({ id, type: 'mesh', vertices, triangles, material, group });
  }

  lathe(id, group, material, profile, position, { segments = 48, rotation } = {}) {
    const part = { id, type: 'lathe', profile, segments, position, material, group };
    if (rotation) part.rotation = rotation;
    return this.add(part);
  }

  // Horizontal ring (axis +Y) centred on `center`.
  ring(id, group, material, center, radius, tube, { radial = 6, tubular = 48 } = {}) {
    return this.add({ id, type: 'torus', radius, tube, radial_segments: radial, tubular_segments: tubular,
      position: center, rotation: [Math.PI / 2, 0, 0], material, group });
  }

  probe(id, label, origin, direction) {
    this.probes.push({ id, label, origin, direction: unit(direction) });
  }

  dimension(id, label, a, b, view) {
    this.dimensions.push({ id, label, a, b, view });
  }
}

export const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// A wall frame maps wall coordinates (u along the wall, y up, w depth measured
// inward from the outer face; negative w projects outward) to model space.
//   axis 'z': the wall faces along Z (front/rear walls), u = x
//   axis 'x': the wall faces along X (side walls), u = -z
// outward is the sign of the outward normal on that axis; face is the outer face.
export function wallFrame(axis, outward, face) {
  const toModel = (u, y, w) => axis === 'z' ? [u, y, face - outward * w] : [face - outward * w, y, -u];
  return {
    axis, outward, face, toModel,
    normal: axis === 'z' ? [0, 0, outward] : [outward, 0, 0],
    box(b, id, group, material, u0, u1, y0, y1, w0, w1) {
      return b.box(id, group, material, toModel(u0, y0, w0), toModel(u1, y1, w1));
    },
    // A prism whose cross-section lies in the wall plane, spanning w0..w1.
    extrude(b, id, group, material, polygon, w0, w1, holes) {
      if (!(w1 > w0)) throw new Error('Generator: ' + id + ' has an empty depth range');
      const depth = w1 - w0;
      if (axis === 'z') return b.extrude(id, group, material, { polygon, holes, depth, position: [0, 0, outward > 0 ? face - w1 : face + w0] });
      return b.extrude(id, group, material, { polygon, holes, depth, position: [outward > 0 ? face - w1 : face + w0, 0, 0], rotation: [0, Math.PI / 2, 0] });
    },
    // A prism whose cross-section is a [w, y] profile, running along u from u0 to u1
    // (brackets, sloped sills, lean-to roofs projecting from the wall).
    sideProfile(b, id, group, material, profile, u0, u1) {
      const points = profile.map(([w, y]) => toModel(0, y, w));
      if (axis === 'z') return b.prismX(id, group, material, points.map(p => [p[2], p[1]]), Math.min(u0, u1), Math.max(u0, u1));
      return b.prismZ(id, group, material, points.map(p => [p[0], p[1]]), Math.min(-u0, -u1), Math.max(-u0, -u1));
    },
  };
}

// An opening outline in wall coordinates. shape 'rect', or 'arch' with
// ratio = arc radius / span: 0.5 is a round (semicircular) arch, larger values
// give a pointed arch. y1 is the top (apex). inset(d) is the concentric outline.
export function opening({ u0, u1, y0, y1, shape = 'rect', ratio = 0.5, segments = 6 }) {
  const span = u1 - u0;
  if (!(span > 0) || !(y1 > y0)) throw new Error('Generator: empty opening');
  if (shape === 'rect') return makeOpening({ shape, u0, u1, y0, y1, segments });
  const radius = ratio * span, cR = u1 - radius, cL = u0 + radius, uc = (u0 + u1) / 2;
  const rise = Math.sqrt(radius * radius - (uc - cR) ** 2);
  return makeOpening({ shape, u0, u1, y0, spring: y1 - rise, radius, cL, cR, segments });
}

function makeOpening(o) {
  const uc = (o.u0 + o.u1) / 2;
  if (o.shape === 'rect') {
    return { ...o, uc, top: o.y1,
      points: () => [[o.u0, o.y0], [o.u1, o.y0], [o.u1, o.y1], [o.u0, o.y1]],
      // Points from the left springing over the top to the right springing.
      head: () => [[o.u0, o.y1], [o.u1, o.y1]],
      heightAt: () => o.y1,
      inset: d => makeOpening({ ...o, u0: o.u0 + d, u1: o.u1 - d, y0: o.y0 + d, y1: o.y1 - d }) };
  }
  const phi = Math.acos(clamp((uc - o.cR) / o.radius, -1, 1)), rise = o.radius * Math.sin(phi);
  if (!(o.spring > o.y0)) throw new Error('Generator: arch springs below its sill');
  // Left springing -> apex on the arc centred at cL, then apex -> right springing
  // on the arc centred at cR (for a round arch both centres coincide).
  const head = () => {
    const points = [];
    for (let i = 0; i <= o.segments; i++) {
      const c = Math.PI - phi * i / o.segments;
      points.push([o.cL + o.radius * Math.cos(c), o.spring + o.radius * Math.sin(c)]);
    }
    for (let i = 1; i <= o.segments; i++) {
      const a = phi * (1 - i / o.segments);
      points.push([o.cR + o.radius * Math.cos(a), o.spring + o.radius * Math.sin(a)]);
    }
    return points;
  };
  return { ...o, uc, top: o.spring + rise,
    points: () => [[o.u0, o.y0], [o.u1, o.y0], ...head().reverse()],
    head,
    heightAt: u => u <= uc ? o.spring + Math.sqrt(Math.max(0, o.radius ** 2 - (u - o.cL) ** 2)) : o.spring + Math.sqrt(Math.max(0, o.radius ** 2 - (u - o.cR) ** 2)),
    inset: d => makeOpening({ ...o, u0: o.u0 + d, u1: o.u1 - d, y0: o.y0 + d, radius: o.radius - d }) };
}

// A wall slab in a wall frame. `top` lists the outline's upper points from the
// right end (u1) back to the left end (u0); default is a flat top at y1.
// Openings that reach the bottom edge become notches in the outline (doors),
// the others become holes, so every opening is a real hole with reveals.
export function wall(b, wf, { id, group, material, u0, u1, y0, y1, top, thickness, w0 = 0, openings = [] }) {
  const notches = openings.filter(o => o.y0 <= y0 + 1e-6).sort((a, c) => a.u0 - c.u0);
  const holes = openings.filter(o => o.y0 > y0 + 1e-6).map(o => o.points());
  const outline = [[u0, y0]];
  for (const n of notches) {
    if (n.u0 <= u0 + 0.05 || n.u1 >= u1 - 0.05) throw new Error('Generator: ' + id + ' notch reaches the wall end');
    outline.push([n.u0, y0], ...n.head(), [n.u1, y0]);
  }
  outline.push([u1, y0], ...(top ?? [[u1, y1], [u0, y1]]));
  return wf.extrude(b, id, group, material, outline, w0, w0 + thickness, holes);
}

// Glazed window in an opening: frame ring, glass, glazing bars and an external sill.
// Depth layers measured from the frame front: frame 0..fd, bars 0.02..fd-0.02,
// glass centred, so no two parallel faces are closer than 2 cm.
export function glazedOpening(b, wf, o, { id, group, frame, glass, sill = null, recess = 0.1, frameWidth = 0.07, frameDepth = 0.1,
  mullions = 0, transoms = [], sillDepth = 0.06, sillHeight = 0.07 }) {
  // Bars sit 2 cm inside the frame faces and the glass 2 cm inside the bars, so a
  // frame shallower than 10 cm cannot hold all three layers.
  const fw = frameWidth, fd = Math.max(frameDepth, 0.1), w0 = recess, inner = o.inset(fw);
  wf.extrude(b, id + '.frame', group, frame, o.points(), w0, w0 + fd, [inner.points()]);
  const pane = o.inset(fw / 2);
  if (o.shape === 'rect') wf.box(b, id + '.glass', group, glass, pane.u0, pane.u1, pane.y0, pane.y1, w0 + fd / 2 - 0.006, w0 + fd / 2 + 0.006);
  else wf.extrude(b, id + '.glass', group, glass, pane.points(), w0 + fd / 2 - 0.006, w0 + fd / 2 + 0.006);
  const barW = Math.min(0.05, fw * 0.8), b0 = w0 + 0.02, b1 = w0 + fd - 0.02;
  // Arched heads keep one pane: bars stop at the springing, where a transom sits.
  const barTop = o.shape === 'rect' ? inner.y1 : o.spring - barW / 2;
  const rails = o.shape === 'rect' ? [...transoms] : [o.spring, ...transoms];
  const mullionAt = [];
  for (let i = 1; i <= mullions; i++) {
    const u = lerp(inner.u0, inner.u1, i / (mullions + 1));
    mullionAt.push(u);
    wf.box(b, id + '.mullion-' + i, group, frame, u - barW / 2, u + barW / 2, inner.y0 - 0.03, barTop + (o.shape === 'rect' ? 0.03 : 0), b0, b1);
  }
  for (const [j, y] of rails.entries()) {
    // Transoms run between mullions so no two bars cross in the same depth layer.
    const stops = [inner.u0 - 0.03, ...mullionAt.flatMap(u => [u - barW / 2, u + barW / 2]), inner.u1 + 0.03];
    for (let k = 0; k < stops.length; k += 2) {
      wf.box(b, id + '.transom-' + (j + 1) + '-' + (k / 2 + 1), group, frame, stops[k], stops[k + 1], y - barW / 2, y + barW / 2, b0, b1);
    }
  }
  if (sill) wf.box(b, id + '.sill', group, sill, o.u0 - 0.05, o.u1 + 0.05, o.y0 - sillHeight + 0.02, o.y0 + 0.02, -sillDepth, w0 + 0.02);
}

// Door in an opening (notch or hole): three-sided frame, leaf with raised
// panels or a glazed upper half, handle, and an optional fanlight above a transom.
export function doorOpening(b, wf, o, { id, group, frame, leaf, glass, metal, recess = 0.12, frameWidth = 0.08, frameDepth = 0.1,
  style = 'panel', fanlight = 0, fanlightMaterial = null, leaves = 1, handleSide = 1 }) {
  const fw = frameWidth, fd = frameDepth, w0 = recess, arched = o.shape !== 'rect';
  // Arched doors always get a transom at the springing, so the leaves stay rectangular;
  // the head above it is glazed or, with fanlightMaterial, a solid tympanum.
  const light = arched || fanlight > 0;
  const leafTop = arched ? o.spring - fw * 0.8 : light ? o.top - fw - fanlight : o.top - fw;
  // Frame: jambs and head as one U-shaped prism; a transom bar closes the fanlight.
  const head = arched ? o.head().reverse() : [[o.u1, o.top], [o.u0, o.top]];
  const innerHead = arched ? o.inset(fw).head() : [[o.u0 + fw, o.top - fw], [o.u1 - fw, o.top - fw]];
  const outline = [[o.u0, o.y0], [o.u0 + fw, o.y0], ...innerHead, [o.u1 - fw, o.y0], [o.u1, o.y0], ...head];
  wf.extrude(b, id + '.frame', group, frame, outline, w0, w0 + fd);
  if (light) {
    wf.box(b, id + '.transom', group, frame, o.u0 + fw - 0.03, o.u1 - fw + 0.03, leafTop, leafTop + fw * 0.8, w0 + 0.02, w0 + fd - 0.02);
    const pane = arched
      ? [[o.u0 + fw / 2, leafTop + 0.02], [o.u1 - fw / 2, leafTop + 0.02], ...o.inset(fw / 2).head().reverse()]
      : [[o.u0 + fw / 2, leafTop + 0.02], [o.u1 - fw / 2, leafTop + 0.02], [o.u1 - fw / 2, o.top - fw / 2], [o.u0 + fw / 2, o.top - fw / 2]];
    wf.extrude(b, id + '.fanlight', group, fanlightMaterial ?? glass, pane, w0 + fd / 2 - 0.006, w0 + fd / 2 + 0.006);
  }
  const lf0 = w0 + 0.02, lf1 = w0 + fd - 0.02, span = (o.u1 - o.u0 - 2 * fw) / leaves;
  for (let k = 0; k < leaves; k++) {
    const a = o.u0 + fw + k * span, c = a + span, lid = id + '.leaf' + (leaves > 1 ? '-' + (k + 1) : '');
    const ua = a - (k === 0 ? 0.02 : 0), uc = c + (k === leaves - 1 ? 0.02 : 0);
    // Leaves meet edge to edge (contact faces are enclosed); outer edges sink 2 cm
    // into the frame. Under a transom the leaf only touches it: both share a depth layer.
    const top = light ? leafTop : leafTop + 0.02;
    if (style === 'glazed') {
      const g = [[a + 0.1, o.y0 + 0.45 * (top - o.y0)], [c - 0.1, o.y0 + 0.45 * (top - o.y0)], [c - 0.1, top - 0.12], [a + 0.1, top - 0.12]];
      wf.extrude(b, lid, group, leaf, [[ua, o.y0], [uc, o.y0], [uc, top], [ua, top]], lf0, lf1, [g]);
      wf.box(b, lid + '-glass', group, glass, a + 0.08, c - 0.08, g[0][1] - 0.02, g[2][1] + 0.02, (lf0 + lf1) / 2 - 0.006, (lf0 + lf1) / 2 + 0.006);
    } else if (style === 'full-glass') {
      const g = [[a + 0.07, o.y0 + 0.1], [c - 0.07, o.y0 + 0.1], [c - 0.07, top - 0.09], [a + 0.07, top - 0.09]];
      wf.extrude(b, lid, group, leaf, [[ua, o.y0], [uc, o.y0], [uc, top], [ua, top]], lf0, lf1, [g]);
      wf.box(b, lid + '-glass', group, glass, a + 0.05, c - 0.05, o.y0 + 0.08, top - 0.07, (lf0 + lf1) / 2 - 0.006, (lf0 + lf1) / 2 + 0.006);
    } else {
      wf.box(b, lid, group, leaf, ua, uc, o.y0, top, lf0, lf1);
      // Raised panels: proud 2 cm, embedded 2 cm.
      const rows = style === 'boarded' ? 0 : 3, height = top - o.y0;
      for (let p = 0; p < rows; p++) {
        const ya = o.y0 + 0.12 + p * (height - 0.12) / rows, yb = ya + (height - 0.12) / rows - 0.12;
        wf.box(b, lid + '-panel-' + (p + 1), group, leaf, a + 0.1, c - 0.1, ya, yb, lf0 - 0.02, lf0 + 0.02);
      }
    }
    const side = leaves > 1 ? (k === 0 ? 1 : -1) : handleSide;
    // The handle sits on the solid stile outside any glazing hole in the leaf.
    const hu = side > 0 ? c - 0.05 : a + 0.05, hy = o.y0 + Math.min(1.05, 0.5 * (top - o.y0));
    wf.box(b, lid + '-handle', group, metal, hu - 0.015, hu + 0.015, hy - 0.1, hy + 0.1, lf0 - 0.06, lf0 + 0.02);
  }
}

// Sectional garage door: plain leaf with horizontal ribs.
export function garageDoor(b, wf, o, { id, group, frame, leaf, recess = 0.15, frameWidth = 0.08 }) {
  const fw = frameWidth, w0 = recess;
  const outline = [[o.u0, o.y0], [o.u0 + fw, o.y0], [o.u0 + fw, o.top - fw], [o.u1 - fw, o.top - fw], [o.u1 - fw, o.y0], [o.u1, o.y0], [o.u1, o.top], [o.u0, o.top]];
  wf.extrude(b, id + '.frame', group, frame, outline, w0, w0 + 0.1);
  wf.box(b, id + '.leaf', group, leaf, o.u0 + fw - 0.02, o.u1 - fw + 0.02, o.y0, o.top - fw + 0.02, w0 + 0.04, w0 + 0.08);
  const ribs = Math.max(3, Math.round((o.top - o.y0) / 0.52));
  for (let k = 1; k < ribs; k++) {
    const y = o.y0 + k * (o.top - fw - o.y0) / ribs;
    wf.box(b, id + '.rib-' + k, group, leaf, o.u0 + fw + 0.04, o.u1 - fw - 0.04, y - 0.025, y + 0.025, w0 + 0.02, w0 + 0.06);
  }
}

// Louvred opening (belfry, plant room): a dark backing panel and horizontal slats.
export function louvreOpening(b, wf, o, { id, group, slat, backing, recess = 0.12, pitch = 0.22 }) {
  const inner = o;
  if (o.shape === 'rect') wf.box(b, id + '.backing', group, backing, o.u0 - 0.02, o.u1 + 0.02, o.y0 - 0.02, o.top + 0.02, recess + 0.12, recess + 0.18);
  else wf.extrude(b, id + '.backing', group, backing, o.inset(-0.02).points(), recess + 0.12, recess + 0.18);
  const top = o.shape === 'rect' ? o.top : o.spring;
  const count = Math.max(2, Math.floor((top - o.y0 - 0.1) / pitch));
  for (let k = 0; k < count; k++) {
    const y = o.y0 + 0.08 + k * pitch;
    wf.box(b, id + '.slat-' + (k + 1), group, slat, inner.u0 - 0.02, inner.u1 + 0.02, y, y + 0.05, recess, recess + 0.08);
  }
}

// Gable roof slab with its ridge along X ("chevron" profile, sloped soffit).
// The underside passes through the wall plate height `plate` at distance
// `halfDepth` from the ridge line zRidge. Returns the heights later parts need.
export function gableRoofX(b, { id, group, material, x0, x1, zRidge, halfDepth, plate, pitch, overhang, thickness }) {
  const t = Math.tan(pitch), tv = thickness / Math.cos(pitch), s = halfDepth + overhang;
  const under = d => plate + (halfDepth - d) * t;
  const profile = [[zRidge + s, under(s)], [zRidge, under(0)], [zRidge - s, under(s)], [zRidge - s, under(s) + tv], [zRidge, under(0) + tv], [zRidge + s, under(s) + tv]];
  b.prismX(id, group, material, profile, x0, x1);
  return { under, top: d => under(d) + tv, ridgeTop: under(0) + tv, fasciaBottom: under(s), fasciaTop: under(s) + tv, tv, s };
}

// Same, ridge along Z (gable faces front and rear).
export function gableRoofZ(b, { id, group, material, z0, z1, xRidge, halfWidth, plate, pitch, overhang, thickness }) {
  const t = Math.tan(pitch), tv = thickness / Math.cos(pitch), s = halfWidth + overhang;
  const under = d => plate + (halfWidth - d) * t;
  const profile = [[xRidge - s, under(s)], [xRidge, under(0)], [xRidge + s, under(s)], [xRidge + s, under(s) + tv], [xRidge, under(0) + tv], [xRidge - s, under(s) + tv]];
  b.prismZ(id, group, material, profile, z0, z1);
  return { under, top: d => under(d) + tv, ridgeTop: under(0) + tv, fasciaBottom: under(s), fasciaTop: under(s) + tv, tv, s };
}

// Hipped roof as a closed solid over the eave rectangle [x0,x1] x [z0,z1] with a
// boxed soffit at y = soffit and a fascia `fascia` high. Ridge on the long axis.
export function hipRoof(b, { id, group, material, x0, x1, z0, z1, soffit, fascia, pitch }) {
  const yt = soffit + fascia, lx = x1 - x0, lz = z1 - z0, alongX = lx >= lz;
  const half = (alongX ? lz : lx) / 2, rise = half * Math.tan(pitch), yr = yt + rise;
  const xc = (x0 + x1) / 2, zc = (z0 + z1) / 2;
  const ridge = alongX ? [[x0 + half, yr, zc], [x1 - half, yr, zc]] : [[xc, yr, z0 + half], [xc, yr, z1 - half]];
  const v = [[x0, soffit, z1], [x1, soffit, z1], [x1, soffit, z0], [x0, soffit, z0], [x0, yt, z1], [x1, yt, z1], [x1, yt, z0], [x0, yt, z0]];
  const faces = [[0, 1, 2, 3], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  if (Math.hypot(ridge[1][0] - ridge[0][0], ridge[1][2] - ridge[0][2]) < 0.05) {
    v.push([xc, yr, zc]);
    faces.push([4, 5, 8], [5, 6, 8], [6, 7, 8], [7, 4, 8]);
  } else if (alongX) {
    v.push(...ridge);
    faces.push([4, 5, 9, 8], [6, 7, 8, 9], [7, 4, 8], [5, 6, 9]);
  } else {
    v.push(...ridge);
    // ridge[0] is at the rear (z0), ridge[1] at the front (z1)
    faces.push([4, 5, 9], [5, 6, 8, 9], [6, 7, 8], [7, 4, 9, 8]);
  }
  b.convex(id, group, material, v, faces);
  const apex = v.length === 9;
  return { ridgeTop: yr, alongX, half, rise, fasciaTop: yt, corners: v.slice(4, 8), ridge: apex ? [v[8], v[8]] : [v[8], v[9]], surface: (x, z) => {
    // Height of the roof surface above a plan point inside the eave rectangle.
    const dx = Math.min(x - x0, x1 - x), dz = Math.min(z - z0, z1 - z);
    return yt + Math.min(dx, dz, half) * Math.tan(pitch);
  } };
}

// Mono-pitch (lean-to) slab projecting from a wall: its top falls from `high`
// at w = -embed... measured outward. The profile runs along the wall from u0 to u1.
export function leanToRoof(b, wf, { id, group, material, u0, u1, wBack, wFront, yBack, pitch, thickness }) {
  const t = Math.tan(pitch), tv = thickness / Math.cos(pitch);
  const yFront = yBack - (wBack - wFront) * t;
  wf.sideProfile(b, id, group, material, [[wBack, yBack], [wFront, yFront], [wFront, yFront + tv], [wBack, yBack + tv]], u0, u1);
  return { yFront, tv, topAt: w => yBack + tv - (wBack - w) * t, underAt: w => yBack - (wBack - w) * t };
}

// Head (lintel) over a rectangular opening. It starts 2 cm above the opening so
// its underside is not coplanar with the opening's head reveal.
export function lintel(b, wf, o, { id, group, material, height = 0.18, overhang = 0.1, proud = 0.025 }) {
  wf.box(b, id, group, material, o.u0 - overhang, o.u1 + overhang, o.top + 0.02, o.top + 0.02 + height, -proud, 0.02);
}

// Corner quoins: alternating long and short blocks wrapping an outside corner,
// proud of both faces. `corner` is the model-space corner [x, z]; sx and sz
// point outward along X and Z.
export function quoins(b, { id, group, material, corner, sx, sz, y0, y1, course = 0.3, long = 0.34, short = 0.2, proud = 0.025 }) {
  const count = Math.floor((y1 - y0) / course);
  for (let k = 0; k < count; k++) {
    const [a, c] = k % 2 ? [short, long] : [long, short];
    const x0 = corner[0] - sx * a, x1 = corner[0] + sx * proud, z0 = corner[1] - sz * c, z1 = corner[1] + sz * proud;
    b.box(id + '-' + (k + 1), group, material, [Math.min(x0, x1), y0 + k * course, Math.min(z0, z1)], [Math.max(x0, x1), y0 + (k + 1) * course - 0.0, Math.max(z0, z1)]);
  }
}

// Horizontal band (plinth, string course, sign band) on a wall: proud of the face
// by `proud`, embedded `embed`, broken at gaps [u0, u1].
export function band(b, wf, { id, group, material, u0, u1, y0, y1, proud = 0.03, embed = 0.02, gaps = [] }) {
  const pieces = [];
  let start = u0;
  for (const [g0, g1] of [...gaps].sort((a, c) => a[0] - c[0])) {
    if (g0 > start + 0.05) pieces.push([start, g0]);
    start = Math.max(start, g1);
  }
  if (u1 > start + 0.05) pieces.push([start, u1]);
  pieces.forEach(([a, c], k) => wf.box(b, id + (pieces.length > 1 ? '-' + (k + 1) : ''), group, material, a, c, y0, y1, -proud, embed));
  return pieces;
}

// Railing of posts with a top and a mid rail along a polyline of [x, y, z] points.
// A closed railing repeats its first point last and skips the duplicate post.
export function railing(b, { id, group, material, points, height = 1.1, spacing = 1.5, radius = 0.025, closed = false }) {
  let post = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], c = points[i + 1], length = Math.hypot(c[0] - a[0], c[2] - a[2]);
    const n = Math.max(1, Math.round(length / spacing)), last = closed && i + 2 === points.length ? n - 1 : n;
    for (let k = i === 0 ? 0 : 1; k <= last; k++) {
      const p = [lerp(a[0], c[0], k / n), lerp(a[1], c[1], k / n), lerp(a[2], c[2], k / n)];
      b.beam(id + '.post-' + (++post), group, material, [p[0], p[1] - 0.02, p[2]], [p[0], p[1] + height + 0.02, p[2]], radius, 8);
    }
    for (const [name, h] of [['top', height], ['mid', height * 0.5]]) {
      b.beam(id + '.' + name + '-' + (i + 1), group, material, [a[0], a[1] + h, a[2]], [c[0], c[1] + h, c[2]], radius * 1.2, 8);
    }
  }
}

// Vertical ladder: two stiles and rungs every 0.3 m, rungs along `across`.
export function ladder(b, { id, group, material, base, top, across, width = 0.45, radius = 0.025 }) {
  const half = across.map(v => v * width / 2);
  const sides = [-1, 1].map(s => [base.map((v, i) => v + s * half[i]), top.map((v, i) => v + s * half[i])]);
  sides.forEach(([a, c], k) => b.beam(id + '.stile-' + (k + 1), group, material, a, c, radius * 1.4, 8));
  const length = Math.hypot(...sub3(top, base)), rungs = Math.floor((length - 0.15) / 0.3);
  for (let k = 1; k <= rungs; k++) {
    const t = k * 0.3 / length;
    const a = sides[0][0].map((v, i) => lerp(v, sides[0][1][i], t)), c = sides[1][0].map((v, i) => lerp(v, sides[1][1][i], t));
    b.beam(id + '.rung-' + k, group, material, a, c, radius * 0.8, 6);
  }
}
