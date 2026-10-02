import { join } from 'node:path';
import { readJSON, objectHash } from '../../../lib/io.mjs';
import { validateModel } from '../model.mjs';
import { soupFromModel } from '../soup.mjs';
import { raycast } from '../raster.mjs';
import { layout, validateTask, validateTruth, validateEvidenceItem, VARIANTS, DEFAULT_BUDGET } from '../contract.mjs';
import { SurfaceIndex, TriangleGrid } from './grid.mjs';
import { sampleSurface, strideIndices, gather, boxOf, boxCentre, boxDiagonal, triangleNormals } from './sampling.mjs';
import { coverageMaps, coverageMask, emptySpaceTest } from './coverage.mjs';
import { prepareGroups } from './detail.mjs';

// Sample spacing as a fraction of the diagonal (DESIGN.md 9.2) and the pixel
// size used to reach it: half a voxel, so every voxel on a visible surface is hit.
export const SAMPLE_FRACTION = 0.004;
export const PIXELS_PER_VOXEL = 2;
// Point-set sizes for the alignment search (thinned evenly) and its refinement.
export const SEARCH_POINTS = 5000, REFINE_POINTS = 20000;

// The scorer's view of one surface it compares against: the visible-surface
// sample with evidence flags, nearest-neighbour indexes at two resolutions, and
// thinned subsets for the alignment search.
export function truthSurface(soup, maps, diagonal) {
  const voxel = SAMPLE_FRACTION * diagonal;
  const sample = sampleSurface(soup, { voxel, pixel: voxel / PIXELS_PER_VOXEL });
  const evidenced = coverageMask(maps, sample.points, sample.normals, diagonal);
  // Candidate surface counts in precision when its nearest truth point is
  // evidenced (DESIGN.md 9.5) or when the evidence shows its place to be empty.
  const empty = emptySpaceTest(maps, 0.01 * diagonal);
  const full = { points: sample.points, normals: sample.normals, grid: new SurfaceIndex(sample.points, diagonal), evidenced };
  const subset = (limit, cell) => {
    const indices = strideIndices(sample.count, limit), points = gather(sample.points, indices);
    return { points, normals: gather(sample.normals, indices), evidenced: Uint8Array.from(indices, i => evidenced[i]),
      grid: new SurfaceIndex(points, diagonal, { cell, reach: 3 * cell, farPoints: 1000 }), full, empty };
  };
  const box = boxOf(sample.points);
  return {
    ...sample, evidenced, evidencedCount: evidenced.reduce((sum, value) => sum + value, 0), empty,
    grid: full.grid, search: subset(SEARCH_POINTS, 0.05), refine: subset(REFINE_POINTS, 0.025),
    centre: boxCentre(box),
  };
}

// For each scored group, the truth sample without that group's parts. A group
// is judged in the frame that the rest of the object fixes, so it cannot pull
// the frame towards itself — and a missing group cannot be "found" by a global
// fit that slides neighbouring geometry into its place (a roofless model is
// lifted 0.25 m by the headline fit because its gable tops then touch the
// roof). When the rest is too small to fix a frame, the global frame is used.
export const MIN_FRAME_SHARE = 0.3;
// The truth sample restricted to the points `keep` accepts, as a set the
// alignment can fit to; null when it holds too little evidenced surface.
function partOfSurface(surface, diagonal, keep) {
  const kept = [];
  let evidencedKept = 0;
  for (let i = 0; i < surface.count; i++) {
    if (!keep(i)) continue;
    kept.push(i);
    if (surface.evidenced[i]) evidencedKept++;
  }
  if (evidencedKept < Math.max(500, MIN_FRAME_SHARE * surface.evidencedCount)) return null;
  const subset = (limit, cell) => {
    const picked = Int32Array.from(strideIndices(kept.length, limit), k => kept[k]), points = gather(surface.points, picked);
    return { points, normals: gather(surface.normals, picked), evidenced: Uint8Array.from(picked, i => surface.evidenced[i]),
      grid: new SurfaceIndex(points, diagonal, { cell, reach: 3 * cell, farPoints: 1000 }) };
  };
  // Candidate surface takes part in fitting to this part only where the truth
  // surface nearest to it belongs to the part: an old roof must not pair with
  // the strip of the new roof that both states share, nor a candidate gable
  // top with the roof of a frame fitted without the roof.
  const mask = new Uint8Array(surface.count);
  for (const i of kept) mask[i] = 1;
  return { ...subset(SEARCH_POINTS, 0.05), full: subset(REFINE_POINTS, 0.025), empty: surface.empty, filter: { index: surface.grid, mask } };
}

function attachGroupFrames(groups, surface, soup, diagonal) {
  for (const group of groups) if (group.scored) group.frame = partOfSurface(surface, diagonal, i => !group.parts[soup.triPart[surface.tri[i]]]);
  return groups;
}

function measureProbes(model, soup, maps, diagonal) {
  const normals = triangleNormals(soup);
  return (model.probes ?? []).map(probe => {
    const hit = raycast(soup, probe.origin, probe.direction);
    let evidenced = false;
    if (hit) {
      const t = hit.tri, d = probe.direction;
      let n = [normals[3 * t], normals[3 * t + 1], normals[3 * t + 2]];
      if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] > 0) n = n.map(value => -value);
      evidenced = coverageMask(maps, Float64Array.from(hit.point), Float32Array.from(n), diagonal)[0] === 1;
    }
    return { id: probe.id, label: probe.label, origin: probe.origin, direction: probe.direction, truth_m: hit ? hit.distance : null, point: hit?.point ?? null, evidenced };
  });
}

function materialKinds(model, soup) {
  const parts = new Map(model.parts.map(part => [part.id, part]));
  return soup.parts.map(id => model.materials[parts.get(id)?.material]?.kind ?? null);
}

// In-memory context. `evidenceItems` are the items actually supplied to the
// contestant (with cameras and occluders); `alternates` are earlier states of
// the object: [{ id, model, contested_probes, note }].
export function makeContext({ model, task = null, evidenceItems = [], scaleEvidence, alternates = [], truth = null, warnings = [] }) {
  validateModel(model);
  const scale = scaleEvidence ?? truth?.scale_evidence ?? task?.scale_evidence ?? VARIANTS[task?.variant]?.scale;
  if (!['none', 'metric'].includes(scale)) throw new Error('Context needs scaleEvidence none or metric');
  // DESIGN.md names a stale item "<item>@<alt-id>", but the kernel's id rule
  // has no '@'; check everything else and accept that one form.
  for (const item of evidenceItems) validateEvidenceItem(/^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/.test(item.id ?? '') ? { ...item, id: item.id.replace('@', '.') } : item);
  const soup = soupFromModel(model), diagonal = boxDiagonal(soup.bounds);
  const { maps, ignored } = coverageMaps(soup, evidenceItems);
  const surface = truthSurface(soup, maps, diagonal);
  const prepared = alternates.map(alternate => {
    validateModel(alternate.model);
    const altSoup = soupFromModel(alternate.model), altDiagonal = boxDiagonal(altSoup.bounds);
    // The same supplied cameras, looking at the earlier state: "what the
    // evidence would show if the building still looked like this".
    const altMaps = coverageMaps(altSoup, evidenceItems).maps;
    const altSurface = truthSurface(altSoup, altMaps, altDiagonal);
    // The surface both states share — primary sample points lying on the
    // earlier state's triangles (sample points sit exactly on their triangles,
    // so 0.02 % of the diagonal only absorbs rounding) — is the frame in which
    // contested probes are read. A looser tolerance admits strips where the two
    // states merely cross, which pull the frame towards one of them.
    const shared = new TriangleGrid(altSoup, 0.0002 * diagonal);
    const common = partOfSurface(surface, diagonal, i => shared.distance(surface.points[3 * i], surface.points[3 * i + 1], surface.points[3 * i + 2]) <= 0.0002 * diagonal);
    return { id: alternate.id, note: alternate.note ?? null, contested_probes: alternate.contested_probes ?? [], model: alternate.model,
      soup: altSoup, diagonal: altDiagonal, surface: altSurface, common, probes: measureProbes(alternate.model, altSoup, altMaps, altDiagonal) };
  });
  return {
    schema: 'e3d-score-context-v1',
    task_id: task?.id ?? truth?.task_id ?? null, object: truth?.object ?? model.id, variant: task?.variant ?? truth?.variant ?? null,
    scaleEvidence: scale, budget: task?.budget ?? DEFAULT_BUDGET,
    model, soup, diagonal, centre: boxCentre(soup.bounds), kinds: materialKinds(model, soup),
    evidence: { supplied: evidenceItems.map(item => item.id), coverage: maps.map(map => map.id), ignored },
    maps, surface, groups: attachGroupFrames(prepareGroups({ model, soup, diagonal, maps }), surface, soup, diagonal), probes: measureProbes(model, soup, maps, diagonal),
    alternates: prepared, warnings,
  };
}

// Reads task.json, truth.json, the object's model.json, evidence.json and any
// alternates named by the truth record (DESIGN.md section 6).
export async function loadContext({ taskDir, truthDir, dataRoot }) {
  const task = validateTask(await readJSON(join(taskDir, 'task.json')));
  const truth = validateTruth(await readJSON(join(truthDir, 'truth.json')));
  if (truth.task_id !== task.id) throw new Error('truth.json is for task ' + truth.task_id + ', not ' + task.id);
  const warnings = [];
  if (truth.task_sha256 !== objectHash(task)) warnings.push('task.json changed after its truth record was written (task_sha256 mismatch)');
  if (truth.scale_evidence !== task.scale_evidence) warnings.push('task and truth disagree on scale_evidence; the truth record is used');
  const objectDir = layout(dataRoot).object(truth.object);
  const model = validateModel(await readJSON(join(objectDir, 'model.json')));
  const evidence = await readJSON(join(objectDir, 'evidence', 'evidence.json'));
  const byId = new Map((evidence.items ?? []).map(item => [item.id, item]));
  const items = truth.evidence.map(id => {
    const item = byId.get(id);
    if (!item) throw new Error('Evidence item ' + id + ' named by truth.json is missing from ' + truth.object + '/evidence/evidence.json');
    return item;
  });
  const alternates = [];
  for (const alternate of truth.alternates ?? []) {
    const altModel = validateModel(await readJSON(join(objectDir, 'alternates', alternate.id, 'model.json')));
    alternates.push({ id: alternate.id, model: altModel, contested_probes: alternate.contested_probes, note: alternate.note });
  }
  return makeContext({ model, task, evidenceItems: items, scaleEvidence: truth.scale_evidence, alternates, truth, warnings });
}
