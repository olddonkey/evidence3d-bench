// Ground-truth generator (DESIGN.md section 8.A). Each archetype is a seeded
// parametric family: sample(rng) draws a JSON parameter set, build(params) turns
// it into parts, groups, probes and dimensions. Everything here is a pure
// function of (archetype, seed), so a model can be regenerated from its id.
import { rng } from '../rng.mjs';
import { validateModel, MODEL_SCHEMA } from '../model.mjs';
import { soupFromModel } from '../soup.mjs';
import { probeCheck, diagonal } from './checks.mjs';
import { r4 } from './kit.mjs';
import house from './archetypes/house.mjs';
import retail from './archetypes/retail.mjs';
import tower from './archetypes/tower.mjs';
import hall from './archetypes/hall.mjs';
import structure from './archetypes/structure.mjs';
import warehouse from './archetypes/warehouse.mjs';
import terrace from './archetypes/terrace.mjs';
import civic from './archetypes/civic.mjs';

export const GENERATOR_VERSION = 'e3d-generator-1.1';
const FAMILIES = { house, retail, tower, hall, structure, warehouse, terrace, civic };
export const ARCHETYPES = Object.freeze(Object.keys(FAMILIES));

const MAX_PROBES = 12, MIN_PROBES = 6;
// Contested probes must differ by at least this share of the bounding-box diagonal.
export const CONTESTED_FRACTION = 0.04;

export function generateModel({ archetype, seed } = {}) {
  const family = FAMILIES[archetype];
  if (!family) throw new Error('Generator: unknown archetype ' + archetype + ' (known: ' + ARCHETYPES.join(', ') + ')');
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('Generator: seed must be a non-negative integer');
  const params = family.sample(rng(archetype + ':' + seed));
  return assemble(family, params, { archetype, seed, id: archetype + '-' + String(seed).padStart(4, '0') }).model;
}

// Rounds every coordinate to 0.1 mm. Rotations and probe directions keep full
// precision: rounding them would tilt long walls and break unit length.
function roundPart(part) {
  const out = {};
  for (const [key, value] of Object.entries(part)) {
    if (key === 'rotation' || typeof value === 'string') out[key] = value;
    else out[key] = roundDeep(value);
  }
  return out;
}
const roundDeep = value => Array.isArray(value) ? value.map(roundDeep) : typeof value === 'number' ? r4(value) : value;

function assemble(family, params, { archetype, seed, id, probes: fixedProbes = null, base = null }) {
  const built = family.build(params), b = built.builder;
  const dimensions = b.dimensions.map(d => {
    const a = roundDeep(d.a), c = roundDeep(d.b);
    return { id: d.id, label: d.label, value_m: r4(Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2])), a, b: c, view: d.view };
  });
  const model = {
    schema: MODEL_SCHEMA, id, archetype, seed,
    title: base?.title ?? built.title,
    frame: base?.frame ?? built.frame,
    scope_note: base?.scope_note ?? built.scope_note,
    materials: b.materials,
    // A group whose optional parts did not fit (or are absent in an earlier state) is dropped.
    groups: b.groups.filter(g => b.parts.some(part => part.group === g.id)),
    probes: [],
    dimensions,
    parts: b.parts.map(roundPart),
    generator: { version: GENERATOR_VERSION, params, structure: built.structure },
  };
  validateModel(model);
  const soup = soupFromModel(model);
  // Probe candidates sharing an id are alternatives in order of preference; the
  // first one that is robust (>= 0.3 m from any edge, not grazing) is kept.
  // built.probeOrder (optional) ranks probe ids, e.g. those an earlier state changes first,
  // so the cap of 12 never drops them; the sort is stable within an id.
  const rank = id => { const k = built.probeOrder?.indexOf(id) ?? -1; return k < 0 ? Infinity : k; };
  const candidates = fixedProbes ?? b.probes.map((q, i) => ({ q, i })).sort((x, y) => rank(x.q.id) - rank(y.q.id) || x.i - y.i)
    .map(({ q }) => ({ id: q.id, label: q.label, origin: roundDeep(q.origin), direction: q.direction }));
  const kept = [], decided = new Set(), rejected = [];
  for (const probe of candidates) {
    if (decided.has(probe.id) || kept.length >= MAX_PROBES) continue;
    const check = probeCheck(soup, probe);
    if (check.ok) { kept.push(probe); decided.add(probe.id); } else rejected.push(probe.id + ': ' + check.reason);
  }
  if (!fixedProbes && kept.length < MIN_PROBES) throw new Error('Generator: ' + id + ' has only ' + kept.length + ' robust probes (' + rejected.join('; ') + ')');
  model.probes = kept;
  return { model: validateModel(model), soup };
}

// Edits an archetype can take away from a generated model (they record what the
// generator actually built, so an edit never claims to remove something absent).
export function applicableEdits(model) {
  const family = FAMILIES[model?.archetype];
  if (!family || !model?.generator?.params) throw new Error('Generator: needs a model made by generateModel');
  return family.edits.filter(edit => edit.applies(model.generator.params, model.generator.structure)).map(edit => edit.id);
}

// The model with the named later additions taken away: the generator re-run with
// edited parameters, in the same frame, with the original's probes copied verbatim
// (those that still land robustly). Used by decoyModel; exported for inspection.
export function earlierState(model, editIds, { id = model.id + '.earlier' } = {}) {
  const family = FAMILIES[model?.archetype];
  if (!family || !model?.generator?.params) throw new Error('Generator: needs a model made by generateModel');
  const pool = [...family.edits, ...(family.fallbackEdits ?? [])];
  const edits = editIds.map(editId => pool.find(edit => edit.id === editId) ?? fail('unknown edit ' + editId));
  let params = structuredClone(model.generator.params);
  for (const edit of edits) params = edit.apply(params);
  const { model: earlier, soup } = assemble(family, params, { archetype: model.archetype, seed: model.seed, id, probes: model.probes, base: model });
  earlier.generator.edits = edits.map(edit => edit.id);
  // Groups the edits may change; every part outside them is meant to stay identical.
  const scope = [...new Set(edits.flatMap(edit => edit.scope ?? []))];
  return { model: earlier, soup, scope, phrases: edits.map(edit => edit.phrase) };
}
const fail = message => { throw new Error('Generator: ' + message); };

// The same building in an earlier state: the generator re-run with 1-3 later
// additions taken away (DESIGN.md section 8.A). Probes are copied verbatim, so
// contested probes have identical id, origin and direction in both models.
export function decoyModel(model, { seed = 0 } = {}) {
  const applicable = applicableEdits(model);
  if (!applicable.length) throw new Error('Generator: ' + model.id + ' has no later addition to take away');
  const primarySoup = soupFromModel(model);
  const primaryDistance = new Map(model.probes.map(q => [q.id, probeCheck(primarySoup, q).distance]));
  const r = rng('decoy:' + model.id + ':' + seed);
  const order = [...applicable];
  for (let i = order.length - 1; i > 0; i--) { const j = r.int(0, i); [order[i], order[j]] = [order[j], order[i]]; }
  const wanted = r.int(1, Math.min(3, order.length));
  // The seeded choice first; if it moves no probe measurably, single edits in turn;
  // then (generator 1.1) the archetype's fallback edits, which are reached only by
  // models whose decoy generator 1.0 could not build, so no 1.0 decoy changes.
  const fallbacks = (FAMILIES[model.archetype].fallbackEdits ?? []).filter(edit => edit.applies(model.generator.params, model.generator.structure)).map(edit => [edit.id]);
  const attempts = [order.slice(0, wanted), ...order.map(edit => [edit]), ...fallbacks];
  for (const editIds of attempts) {
    const { model: earlier, soup, phrases } = earlierState(model, editIds, { id: model.id + '.earlier-' + seed });
    const limit = CONTESTED_FRACTION * Math.max(diagonal(primarySoup.bounds), diagonal(soup.bounds));
    const contested = earlier.probes.filter(q => Math.abs(probeCheck(soup, q).distance - primaryDistance.get(q.id)) >= limit).map(q => q.id);
    if (!contested.length) continue;
    const list = phrases.length > 1 ? phrases.slice(0, -1).join(', ') + ' and ' + phrases.at(-1) : phrases[0];
    return { model: earlier, change: { note: 'In this earlier state ' + list + '.', contested_probes: contested } };
  }
  throw new Error('Generator: no earlier state of ' + model.id + ' differs measurably at a probe');
}
