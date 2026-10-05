// Memory tasks (variants m2 and m3): well-known structures, named in the task,
// each modelled twice. `published` is the structure built to its widely quoted
// figures; the twin is the surveyed object, the same structure with three or
// more named quantities changed by 12-30 % (or counts by at least 2), drawn from
// a seed. The twin is the hidden truth and the evidence is rendered from it; the
// published model is stored beside it as the alternate "remembered", so the
// scorer's contested probes tell whether a submission followed the evidence or
// the memory.
//
// Every twin keeps a datum part of the structure exactly as published (the
// Arc's footprint, the towers' shafts, the Memorial's terrace and podium). The
// scorer reads contested probes in the frame fixed by the surface both states
// share (score/context.mjs, at least 30 % of the evidenced surface): without a
// shared datum the scale-free fit of m2 meets a memorised model half way and the
// probes come out "neither". With it, position, height and (on m2) scale are
// fixed by the datum, and the changed parts are measured where they stand.
import { rng } from '../../rng.mjs';
import { validateModel, MODEL_SCHEMA } from '../../model.mjs';
import { soupFromModel } from '../../soup.mjs';
import { raycast } from '../../raster.mjs';
import { probeCheck, diagonal } from '../checks.mjs';
import { r4 } from '../kit.mjs';
import elizabethTower from './elizabeth-tower.mjs';
import arcDeTriomphe from './arc-de-triomphe.mjs';
import washingtonMonument from './washington-monument.mjs';
import lincolnMemorial from './lincoln-memorial.mjs';

export const LANDMARKS_VERSION = 'e3d-landmarks-1.0';
const FAMILIES = Object.fromEntries([elizabethTower, arcDeTriomphe, washingtonMonument, lincolnMemorial].map(family => [family.id, family]));
export const LANDMARKS = Object.freeze(Object.keys(FAMILIES));

// The alternate id pack.mjs stores the published model under.
export const REMEMBERED = 'remembered';
// A changed length differs from its published value by this share (inclusive).
export const CHANGE_RANGE = Object.freeze([0.12, 0.30]);
// A changed count differs by at least this many.
export const MIN_COUNT_CHANGE = 2;
// At least this many quantities change, and at least two of them have a
// published (sourced) value: estimated quantities alone would test nothing a
// contestant could remember.
export const MIN_CHANGED = 3, MIN_SOURCED_CHANGED = 2;
// A probe is contested when the two states differ there by at least 0.5 % of
// the bounding-box diagonal: twice the finest shape tolerance (0.25 %), so a
// submission that matches either state within that tolerance is attributed to
// it (score: `closer_to` needs the measurement within half the gap).
export const CONTESTED_FRACTION = 0.005;
export const MIN_CONTESTED = 3;
// No uniform scale about the frame origin maps the twin's contested probe hits
// onto the published ones within this relative error.
export const UNIFORM_SCALE_LIMIT = 0.05;
const MAX_PROBES = 12, MIN_PROBES = 6, MAX_INCIDENCE_DEG = 60, ATTEMPTS = 60;

const fail = message => { throw new Error('Landmarks: ' + message); };
const familyOf = landmark => FAMILIES[landmark] ?? fail('unknown landmark ' + landmark + ' (known: ' + LANDMARKS.join(', ') + ')');

// Coordinates to 0.1 mm, as the generator does; rotations and directions keep full precision.
const roundDeep = value => Array.isArray(value) ? value.map(roundDeep) : typeof value === 'number' ? r4(value) : value;
function roundPart(part) {
  const out = {};
  for (const [key, value] of Object.entries(part)) out[key] = key === 'rotation' || typeof value === 'string' ? value : roundDeep(value);
  return out;
}

// Params -> validated model. `probes` given: those probes verbatim, kept where
// they hit this model at most 60 degrees off the surface normal (the published
// model takes the twin's probes). Otherwise the family's probe candidates: per
// id the first that is robust here (checks.probeCheck), probes about `changed`
// quantities first, at most 12.
function assemble(family, params, { id, seed, state, probes: fixed = null, changed = [] }) {
  const built = family.build(params), b = built.builder;
  const dimensions = b.dimensions.map(d => {
    const a = roundDeep(d.a), c = roundDeep(d.b);
    return { id: d.id, label: d.label, value_m: r4(Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2])), a, b: c, view: d.view };
  });
  const model = {
    schema: MODEL_SCHEMA, id, archetype: family.id, ...(seed === undefined ? {} : { seed }),
    title: family.title, frame: family.frame, scope_note: family.scope_note,
    materials: b.materials,
    groups: b.groups.filter(g => b.parts.some(part => part.group === g.id)),
    probes: [], dimensions, parts: b.parts.map(roundPart),
    generator: { version: LANDMARKS_VERSION, landmark: family.id, state, params, structure: built.structure },
  };
  validateModel(model);
  const soup = soupFromModel(model);
  if (fixed) {
    model.probes = fixed.filter(probe => {
      const check = probeCheck(soup, probe);
      return check.reason !== 'miss' && check.incidence <= MAX_INCIDENCE_DEG;
    });
  } else {
    const about = probe => probe.about?.some(key => changed.includes(key)) ? 0 : 1;
    const candidates = built.probes.map((probe, index) => ({ probe, index })).sort((x, y) => about(x.probe) - about(y.probe) || x.index - y.index).map(({ probe }) => probe);
    const kept = [], decided = new Set();
    for (const probe of candidates) {
      if (decided.has(probe.id) || kept.length >= MAX_PROBES) continue;
      const clean = { id: probe.id, label: probe.label, origin: roundDeep(probe.origin), direction: unit(probe.direction) };
      if (probeCheck(soup, clean).ok) { kept.push(clean); decided.add(probe.id); }
    }
    model.probes = kept;
  }
  return { model: validateModel(model), soup };
}
const unit = v => { const length = Math.hypot(...v); return v.map(x => x / length); };

// The structure as published, with its own robust probes.
export function publishedModel(landmark) {
  const family = familyOf(landmark);
  return assemble(family, structuredClone(family.published), { id: family.id + '-published', state: 'published' }).model;
}

// Published figures and the quantities a twin may change, for reports and tests.
export function landmarkInfo(landmark) {
  const family = familyOf(landmark);
  return { id: family.id, title: family.title, published: structuredClone(family.published), quantities: family.quantities.map(q => ({ ...q })) };
}

// One draw of a twin's parameters: MIN_CHANGED to MIN_CHANGED + 1 quantities,
// each changed within its allowed directions and range; null when the
// structure would be implausible (the family says why).
function drawTwin(family, r) {
  const keys = family.quantities.map(q => q.key);
  const order = [...keys], pick = r.fork('pick');
  for (let i = order.length - 1; i > 0; i--) { const j = pick.int(0, i); [order[i], order[j]] = [order[j], order[i]]; }
  const count = r.fork('count').int(MIN_CHANGED, Math.min(MIN_CHANGED + 1, order.length));
  const chosen = order.slice(0, count);
  if (chosen.filter(key => family.quantities.find(q => q.key === key).sourced).length < MIN_SOURCED_CHANGED) return null;
  const params = structuredClone(family.published), deltas = [];
  for (const key of keys.filter(k => chosen.includes(k))) {
    const q = family.quantities.find(item => item.key === key), d = r.fork(key), was = family.published[key];
    let value;
    if (q.kind === 'count') value = was + d.pick(q.steps);
    else {
      const sign = d.pick(q.signs ?? [-1, 1]), [low, high] = q.range ?? CHANGE_RANGE, step = q.step ?? 0.05;
      const share = d.range(low, high);
      value = Math.round(was * (1 + sign * share) / step) * step;
      // Rounding to the survey step must not leave the range.
      while (Math.abs(value / was - 1) < low) value += sign * step;
      while (Math.abs(value / was - 1) > high) value -= sign * step;
      value = r4(value);
    }
    params[key] = value;
    deltas.push({ quantity: key, label: q.label, unit: q.kind === 'count' ? 'count' : 'm', sourced: !!q.sourced, published: was, surveyed: value,
      change: q.kind === 'count' ? value - was : r4((value - was) / was) });
  }
  const reason = family.implausible(params);
  return reason ? null : { params, deltas, chosen };
}

// Probes measuring both states measurably differently, with their distances.
function contestedProbes(twin, published) {
  const limit = CONTESTED_FRACTION * Math.max(diagonal(twin.soup.bounds), diagonal(published.soup.bounds));
  const rows = [];
  for (const probe of published.model.probes) {
    const a = raycast(twin.soup, probe.origin, probe.direction), c = raycast(published.soup, probe.origin, probe.direction);
    if (!a || !c) continue;
    const gap = Math.abs(a.distance - c.distance);
    if (gap >= limit) rows.push({ probe, twin: a, published: c, gap });
  }
  return rows;
}

// The smallest relative error with which one uniform scale about the frame
// origin maps the twin's contested probe hits onto the published ones. Each hit
// is read as its coordinate along the probe axis (a height for a probe from
// above, a face position for one from the side); probes whose coordinate is
// under a metre in either state are skipped (a ratio there means nothing).
// Infinity when two states disagree in sign (no positive scale can map them).
export function uniformScaleMismatch(rows) {
  const ratios = [];
  for (const { probe, twin, published } of rows) {
    const along = point => -(point[0] * probe.direction[0] + point[1] * probe.direction[1] + point[2] * probe.direction[2]);
    const t = along(twin.point), p = along(published.point);
    if (Math.abs(t) < 1 || Math.abs(p) < 1) continue;
    if (Math.sign(t) !== Math.sign(p)) return Infinity;
    ratios.push(t / p);
  }
  if (ratios.length < 2) return 0;
  const low = Math.min(...ratios), high = Math.max(...ratios);
  return (high - low) / (high + low);
}

// The twin of `landmark` for `seed`, with the published model as its
// "remembered" alternate: { model, alternate: { id, model, change, stale: false } }.
// change = { note (public, no values), contested_probes, deltas (private) }.
export function generateLandmark({ landmark, seed } = {}) {
  const family = familyOf(landmark);
  if (!Number.isSafeInteger(seed) || seed < 0) fail('seed must be a non-negative integer');
  const r = rng('landmark:' + landmark + ':' + seed);
  const id = landmark + '-' + String(seed).padStart(4, '0');
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const draw = drawTwin(family, r.fork('attempt-' + attempt));
    if (!draw) continue;
    const twin = assemble(family, draw.params, { id, seed, state: 'surveyed', changed: draw.chosen });
    if (twin.model.probes.length < MIN_PROBES) continue;
    const published = assemble(family, structuredClone(family.published), { id: landmark + '-published', state: 'published', probes: twin.model.probes });
    const rows = contestedProbes(twin, published);
    if (rows.length < MIN_CONTESTED) continue;
    const mismatch = uniformScaleMismatch(rows);
    if (!(mismatch >= UNIFORM_SCALE_LIMIT)) continue;
    twin.model.generator.changed = draw.chosen;
    const labels = draw.deltas.map(delta => delta.label.charAt(0).toLowerCase() + delta.label.slice(1));
    const change = {
      // Public: names what differs, never by how much.
      note: 'The remembered state is the structure as published, built to its widely quoted figures. The surveyed object differs from it in ' +
        (labels.length > 1 ? labels.slice(0, -1).join(', ') + ' and ' + labels.at(-1) : labels[0]) + '.',
      contested_probes: rows.map(row => row.probe.id),
      // Private: what the twin changed (the object directory is never given to a contestant).
      deltas: draw.deltas,
      uniform_scale_mismatch: r4(mismatch),
      attempt,
    };
    return { model: twin.model, alternate: { id: REMEMBERED, model: published.model, change, stale: false } };
  }
  return fail('no plausible twin of ' + landmark + ' with ' + MIN_CONTESTED + ' contested probes for seed ' + seed);
}
