import { performance } from 'node:perf_hooks';
import { soupFromGLB, transformSoup, soupBounds } from '../soup.mjs';
import { raycast } from '../raster.mjs';
import { PROTOCOL, REPORT_SCHEMA } from '../contract.mjs';
import { PointGrid } from './grid.mjs';
import { sampleSurface, strideIndices, gather, boxOf, boxCentre, boxDiagonal, areaBounds } from './sampling.mjs';
import { multiStartAlign, icp, planeRefine, fScore, forward, inverse, poseQuality, betterPose, IDENTITY, SCALE_BOUNDS, TIE, FRAME_MARGIN, FINAL_SIGMA_FRACTION } from './align.mjs';
import { surfaceMetrics, poseShape, appearance, round, HEADLINE_FRACTION, SHAPE_FRACTIONS } from './metrics.mjs';
import { visibleSurface } from './surface.mjs';
import { scoreGroups } from './detail.mjs';
import { writeErrorMaps } from './errormap.mjs';
import { makeContext, loadContext, SAMPLE_FRACTION, PIXELS_PER_VOXEL, SEARCH_POINTS, REFINE_POINTS } from './context.mjs';
import { mutations } from './mutations.mjs';
import { calibrate } from './calibrate.mjs';
import { SCORER } from './version.mjs';

export { makeContext, loadContext, mutations, calibrate, SCORER };

const clampScale = value => Math.min(SCALE_BOUNDS[1], Math.max(SCALE_BOUNDS[0], value));

// Every report, valid or not, names the scorer that wrote it (version.mjs).
function baseReport(context) {
  return { schema: REPORT_SCHEMA, protocol: PROTOCOL, scorer: { ...SCORER }, task_id: context?.task_id ?? null, object: context?.object ?? null, variant: context?.variant ?? null };
}

function technical(candidate, bytes) {
  const finite = candidate?.bounds && candidate.bounds.min.every(Number.isFinite);
  return { triangles: candidate?.triangles ?? 0, bytes: bytes ?? null, mesh_count: candidate?.parts?.length ?? 0,
    bounds: finite ? { min: candidate.bounds.min.map(v => round(v)), max: candidate.bounds.max.map(v => round(v)) } : { min: [], max: [] } };
}

function invalidReport(context, error, { candidate = null, bytes = null, started }) {
  return { ...baseReport(context), valid: false, error, score: 0, technical: technical(candidate, bytes), artifacts: [],
    timing_ms: Math.round(performance.now() - started), warnings: context?.warnings ?? [] };
}

// A submission's visible surface. The spacing is the truth's (as the
// submission will be after scaling) unless the submission has so much surface
// that this would exceed MAX_CANDIDATE_POINTS: then it is coarsened uniformly,
// which keeps precision area-weighted. Views are framed on the area-trimmed
// bounds (see areaBounds).
export const MAX_CANDIDATE_POINTS = 400000;
function sampleCandidate(soup, voxel, { keepViews = false } = {}) {
  const { area, box } = areaBounds(soup);
  const spacing = Math.max(voxel, Math.sqrt(area / MAX_CANDIDATE_POINTS));
  return sampleSurface(soup, { voxel: spacing, pixel: spacing / PIXELS_PER_VOXEL, box, keepViews });
}

// The aligned candidate's sample in the truth frame, indexed and set up as a
// distance target (its triangles and sampling views, see surface.mjs).
function finalSurface(aligned, diagonal) {
  const final = sampleCandidate(aligned, SAMPLE_FRACTION * diagonal, { keepViews: true });
  final.grid = new PointGrid(final.points, 0.02 * diagonal);
  final.target = visibleSurface(aligned, final, final.grid);
  delete final.views; delete final.voxelTriangles;
  return final;
}

// Candidate point set at a given voxel size, with indexes for the search and
// set up as a distance target in its own space (for poseShape).
function candidateSurface(soup, voxel, diagonalHint) {
  const { views, voxelTriangles, ...sample } = sampleCandidate(soup, voxel, { keepViews: true });
  const full = { points: sample.points, normals: sample.normals, grid: new PointGrid(sample.points, 0.02 * diagonalHint) };
  const subset = (limit, cell) => {
    const indices = strideIndices(sample.count, limit), points = gather(sample.points, indices);
    return { points, normals: gather(sample.normals, indices), grid: new PointGrid(points, cell), full };
  };
  return { ...sample, grid: full.grid, target: visibleSurface(soup, { tri: sample.tri, views, voxelTriangles }, full.grid),
    search: subset(SEARCH_POINTS, 0.05 * diagonalHint), refine: subset(REFINE_POINTS, 0.025 * diagonalHint), centre: boxCentre(boxOf(sample.points)) };
}

// The radii of the fit's last stage: the shape tolerances below the final ICP
// radius, coarse to fine. The search ranks poses by F@2 % and settles at a 2 %
// radius, which balances a mis-sized model's error so that every wall lies
// within 2 % but few within the finer tolerances; for the shape score, which
// also counts agreement at those, a pose that fits part of the model closely
// is worth more. (Fixture on a metric task, 5 / 10 / 20 % too large: shape 8.7,
// 49.2, 32.9 at the searched pose - 5 % spread evenly, 10 % already fitted to
// the walls that agree - and 57.1, 50.2, 32.9 with this stage.)
export const FINE_SIGMA_FRACTIONS = SHAPE_FRACTIONS.filter(fraction => fraction < FINAL_SIGMA_FRACTION).sort((a, b) => b - a);

// DESIGN.md 9.4: multi-start search on thinned sets, then refinement on denser
// ones (`transform`). With `fine`, a last point-to-plane stage at
// FINE_SIGMA_FRACTIONS gives `shapeTransform`, the pose the global surface
// measures are taken at: a fine-stage pose replaces the searched one there
// only when it raises the shape score by more than a tie (half a point). That
// stage only refines the pose the search chose, so it never changes which
// basin (heading, scale, position) the fit is in; detail groups and probes
// keep the searched pose they were calibrated with.
function fitTransform(truth, candidate, { diagonal, scaleFree, scaleInits, fine = true }) {
  const centres = { truth: truth.centre, candidate: candidate.centre };
  const searched = multiStartAlign(truth.search, candidate.search, { diagonal, scaleFree, centres, scaleInits });
  const refined = icp(truth.refine, candidate.refine, searched.transform, { diagonal, scaleFree, centres, sigmaStart: 0.04 * diagonal, sigmaEnd: FINAL_SIGMA_FRACTION * diagonal, iterations: 25 });
  const polished = planeRefine(truth.refine, candidate.refine, refined, { diagonal, scaleFree, centres, sigma: FINAL_SIGMA_FRACTION * diagonal });
  // Each refinement is kept unless it made the pose clearly worse.
  let best = { transform: searched.transform, ...poseQuality(truth.refine, candidate.refine, searched.transform, diagonal) };
  for (const transform of [refined, polished]) {
    const judged = { transform, ...poseQuality(truth.refine, candidate.refine, transform, diagonal) };
    if (!(best.f > judged.f + TIE)) best = judged;
  }
  let shapeTransform = best.transform, stage = 'search';
  if (fine && truth.target && candidate.target) {
    const judge = transform => poseShape(truth, candidate, transform, diagonal, { queries: { truth: truth.refine, candidate: candidate.refine } });
    let shape = judge(shapeTransform), from = shapeTransform;
    // Nothing to gain once the searched pose is within a tie of perfect.
    for (const fraction of shape < 100 - 100 * TIE ? FINE_SIGMA_FRACTIONS : []) {
      from = planeRefine(truth.refine, candidate.refine, from, { diagonal, scaleFree, centres, sigma: fraction * diagonal });
      const judged = judge(from);
      if (judged > shape + 100 * TIE) { shapeTransform = from; shape = judged; stage = 'fine ' + fraction * 100 + ' %'; }
    }
  }
  return { transform: best.transform, shapeTransform, stage, start: searched.start, starts: searched.starts, candidates: searched.candidates };
}

// Initial scale guesses for a scale-free fit: height ratio (yaw-free, and a
// ground plane does not change it) and diagonal ratio.
function scaleGuesses(context, candidate) {
  const truthBox = context.soup.bounds, box = candidate.bounds;
  const guesses = [];
  const height = box.max[1] - box.min[1], diagonal = boxDiagonal(box);
  if (height > 1e-9) guesses.push(clampScale((truthBox.max[1] - truthBox.min[1]) / height));
  if (diagonal > 1e-9) guesses.push(clampScale(context.diagonal / diagonal));
  if (!guesses.length) guesses.push(1);
  return guesses.filter((value, i) => guesses.findIndex(other => Math.abs(Math.log(other / value)) < 0.05) === i);
}

function frameError(context, transform, scaleLocked) {
  const centre = context.centre, at = inverse(transform, centre[0], centre[1], centre[2], [0, 0, 0]);
  const offset = Math.hypot(at[0] - centre[0], at[1] - centre[1], at[2] - centre[2]);
  return { yaw_deg: round(transform.yaw * 180 / Math.PI, 3), offset_m: round(offset), offset_fraction: round(offset / context.diagonal),
    scale_log: scaleLocked ? 0 : round(Math.log(transform.scale)) };
}

// The pose the global surface measures were taken at, when the fit's fine
// stage moved it: how it differs from `alignment` and by how much it moves the
// truth's box corners (at most), in metres.
function shapePose(context, fit) {
  const { transform: a, shapeTransform: b, stage } = fit;
  if (a === b) return { stage, moved_m: 0 };
  let moved = 0;
  const { min, max } = context.soup.bounds;
  for (let corner = 0; corner < 8; corner++) {
    const p = [0, 1, 2].map(i => (corner >> i & 1 ? max[i] : min[i])), at = inverse(a, p[0], p[1], p[2], [0, 0, 0]), q = forward(b, at[0], at[1], at[2], [0, 0, 0]);
    moved = Math.max(moved, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
  }
  return { stage, moved_m: round(moved), yaw_deg: round(b.yaw * 180 / Math.PI, 3), scale: round(b.scale, 5), translation_m: b.translation.map(v => round(v)) };
}

function closerTo(primary, alternate, measured) {
  if (measured === null || primary === null || alternate === null) return 'neither';
  const gap = Math.abs(primary - alternate), toPrimary = Math.abs(measured - primary), toAlternate = Math.abs(measured - alternate);
  if (toPrimary > gap / 2 && toAlternate > gap / 2) return 'neither';
  return toPrimary <= toAlternate ? 'primary' : 'alternate';
}

// Scores a candidate soup against a context. Never throws for a bad candidate:
// a scorer failure is reported as such.
export function scoreSoup({ candidate, context, outDir, bytes = null }) {
  const started = performance.now();
  try {
    return scoreCandidate({ candidate, context, outDir, bytes, started });
  } catch (error) {
    return invalidReport(context, 'Scorer error: ' + (error?.message ?? String(error)), { candidate, bytes, started });
  }
}

function scoreCandidate({ candidate, context, outDir, bytes, started }) {
  const timing = {}, lap = name => { timing[name] = Math.round(performance.now() - started); };
  if (!candidate?.triangles || !(candidate.positions?.length === candidate.triangles * 9)) {
    return invalidReport(context, 'Candidate has no triangles', { candidate, bytes, started });
  }
  if (!candidate.bounds) candidate = { ...candidate, bounds: soupBounds(candidate.positions) };
  const { diagonal, surface: truth } = context, scaleFree = context.scaleEvidence === 'none';
  const guesses = scaleFree ? scaleGuesses(context, candidate) : [1];
  // Sample the candidate at the truth's spacing as it will be after scaling, so
  // a wrongly sized model is not also sampled more coarsely or finely.
  const initial = candidateSurface(candidate, SAMPLE_FRACTION * diagonal / guesses[0], diagonal / guesses[0]);
  if (!initial.count) return invalidReport(context, 'Candidate has no visible surface (empty or degenerate triangles only)', { candidate, bytes, started });
  lap('candidate_sampled');

  const main = fitTransform(truth, initial, { diagonal, scaleFree, scaleInits: guesses });
  lap('aligned');
  const tau = HEADLINE_FRACTION * diagonal;
  const fullTruth = { points: truth.points, evidenced: truth.evidenced, grid: truth.grid, empty: truth.empty };
  const fullCandidate = { points: initial.points, grid: initial.grid };
  const strict = fScore(fullTruth, fullCandidate, IDENTITY, tau);
  let shape;
  if (scaleFree) shape = { transform: main.transform };
  else {
    // Same search with the scale released: "right shape, wrong size" shows here.
    const centres = { truth: truth.centre, candidate: initial.centre };
    const released = icp(truth.refine, initial.refine, main.transform, { diagonal, scaleFree: true, centres, sigmaStart: 0.06 * diagonal, sigmaEnd: FINAL_SIGMA_FRACTION * diagonal, iterations: 30 });
    const searched = fitTransform(truth, initial, { diagonal, scaleFree: true, scaleInits: scaleGuesses(context, candidate), fine: false });
    const a = fScore(fullTruth, fullCandidate, released, tau).f, b = fScore(fullTruth, fullCandidate, searched.transform, tau).f;
    shape = { transform: a >= b ? released : searched.transform };
  }
  const shapeF = fScore(fullTruth, fullCandidate, shape.transform, tau);
  lap('strict_shape');

  // The aligned candidate is re-sampled in the truth frame, from the same 25
  // directions and at the same spacing as the truth itself. The global surface
  // measures are taken at the shape pose; detail and probes at the searched one.
  const aligned = transformSoup(candidate, main.transform);
  const shapeAligned = main.shapeTransform === main.transform ? aligned : transformSoup(candidate, main.shapeTransform);
  const final = finalSurface(shapeAligned, diagonal);
  const metrics = surfaceMetrics(truth, final, diagonal);
  lap('surface_metrics');
  const colour = appearance({ truth, truthSoup: context.soup, truthKinds: context.kinds, candidate: final, candidateSoup: shapeAligned, nearest: metrics.nearest, diagonal });

  // A pose fitted to part of the truth only (`set`, built in context.mjs:
  // everything but one group, or the surface two states share): the global
  // pose, its refinement on that part, or a refinement from the frame as
  // delivered, whichever fits the part best, then a point-to-plane polish. On
  // a scale-free task the part may also re-fix the scale, but only when the
  // candidate actually has that part: a frame fitted to walls the candidate
  // lacks is no frame.
  const centres = { truth: truth.centre, candidate: initial.centre };
  const partFrame = set => {
    // A part the candidate mostly lacks cannot fix a frame (dropping a
    // building's walls must not hand its plinth a frame fitted to nothing).
    const covered = fScore(set, initial.search, main.transform, HEADLINE_FRACTION * diagonal).recall;
    if (covered < 0.5) return main.transform;
    const options = { diagonal, scaleFree: false, fixedScale: main.transform.scale, centres, sigmaStart: 0.03 * diagonal, sigmaEnd: FINAL_SIGMA_FRACTION * diagonal, iterations: 20 };
    const delivered = { scale: main.transform.scale, yaw: 0, translation: [0, 0, 0] };
    const poses = [[main.transform, false], [icp(set, initial.search, main.transform, options), false], [icp(set, initial.search, delivered, options), true]];
    const free = scaleFree && covered >= 0.8;
    if (free) poses.push([icp(set, initial.search, main.transform, { ...options, scaleFree: true }), false], [icp(set, initial.search, { ...delivered, scale: 1 }, { ...options, scaleFree: true }), true]);
    // As for the global fit, the pose reached from the frame as delivered is
    // kept unless another beats it by more than FRAME_MARGIN in F@2 % (or by
    // more than TIE in F@1 %): a roofless model's exposed interior makes a 2 %
    // larger pose fit the rest of it 0.6 points better, and that is no reason
    // to move a frame the contestant got right.
    let best = null, own = null;
    for (const [transform, fromDelivered] of poses) {
      const judged = { transform, ...poseQuality(set, initial.search, transform, diagonal) };
      if (!best || !betterPose(best, judged)) best = judged;
      if (fromDelivered && (!own || !betterPose(own, judged))) own = judged;
    }
    if (own && best !== own && best.f <= own.f + FRAME_MARGIN && best.f1 <= own.f1 + TIE) best = own;
    const polished = planeRefine(set, initial.search, best.transform, { diagonal, scaleFree: free, centres, sigma: FINAL_SIGMA_FRACTION * diagonal, iterations: 30 });
    const judged = { transform: polished, ...poseQuality(set, initial.search, polished, diagonal) };
    return best.f > judged.f + TIE ? best.transform : polished;
  };
  // How far a pose moves a point from where the global pose puts it.
  const shiftAt = (transform, point) => {
    const at = inverse(main.transform, point[0], point[1], point[2], [0, 0, 0]), moved = forward(transform, at[0], at[1], at[2], [0, 0, 0]);
    return Math.hypot(moved[0] - point[0], moved[1] - point[1], moved[2] - point[2]);
  };
  // Each group is scored in the frame the rest of the object fixes (see context.mjs).
  const groupFrame = group => {
    if (!group.scored || !group.frame) return { soup: aligned, frameOffset: 0 };
    const transform = partFrame(group.frame), frameOffset = shiftAt(transform, boxCentre(group.box));
    if (frameOffset < 1e-4 * diagonal && Math.abs(transform.yaw - main.transform.yaw) < 1e-6 && transform.scale === main.transform.scale) return { soup: aligned, frameOffset: 0 };
    return { soup: transformSoup(candidate, transform), frameOffset };
  };
  const detail = scoreGroups(context.groups, groupFrame);
  lap('detail');

  const probes = context.probes.map(probe => {
    const hit = probe.truth_m === null ? null : raycast(aligned, probe.origin, probe.direction);
    const measured = hit ? hit.distance : null;
    return { id: probe.id, label: probe.label, truth_m: round(probe.truth_m), measured_m: round(measured),
      error_m: measured === null || probe.truth_m === null ? null : round(Math.abs(measured - probe.truth_m)), evidenced: probe.evidenced, missed: probe.truth_m !== null && !hit };
  });
  const evaluated = probes.filter(probe => probe.evidenced && probe.truth_m !== null), hits = evaluated.filter(probe => !probe.missed);
  const meanError = hits.length ? hits.reduce((sum, probe) => sum + probe.error_m, 0) / hits.length : null;
  const probeSummary = { evaluated: evaluated.length, missed: evaluated.length - hits.length, mean_error_m: round(meanError),
    mean_error_fraction: meanError === null ? null : round(meanError / diagonal) };
  lap('probes');

  const alternates = context.alternates.map(alternate => {
    const fit = fitTransform(alternate.surface, initial, { diagonal: alternate.diagonal, scaleFree, scaleInits: guesses });
    const altAligned = transformSoup(candidate, fit.shapeTransform);
    const altMetrics = surfaceMetrics(alternate.surface, finalSurface(altAligned, alternate.diagonal), alternate.diagonal), f = altMetrics.headline.f;
    // Contested probes are read in the frame fixed by what both states share,
    // so the fit cannot pull an old-state model towards the new state (or
    // back) before it is measured.
    const shared = alternate.common ? transformSoup(candidate, partFrame(alternate.common)) : aligned;
    const contested = alternate.contested_probes.map(id => {
      const primary = context.probes.find(probe => probe.id === id), earlier = alternate.probes.find(probe => probe.id === id);
      const spec = primary ?? earlier;
      const hit = spec ? raycast(shared, spec.origin, spec.direction) : null, measured = hit ? hit.distance : null;
      const primaryM = primary?.truth_m ?? null, alternateM = earlier?.truth_m ?? null;
      return { probe: id, primary_m: round(primaryM), alternate_m: round(alternateM), measured_m: round(measured), closer_to: closerTo(primaryM, alternateM, measured) };
    });
    return { id: alternate.id, note: alternate.note, f, shape_score: altMetrics.shape_score, closer_to_primary_fraction: contested.length ? round(contested.filter(item => item.closer_to === 'primary').length / contested.length) : null,
      contested, alignment: { yaw_deg: round(fit.shapeTransform.yaw * 180 / Math.PI, 3), scale: round(fit.shapeTransform.scale), translation_m: fit.shapeTransform.translation.map(v => round(v)), stage: fit.stage } };
  });
  lap('alternates');

  const artifacts = outDir ? writeErrorMaps({ context, aligned: shapeAligned, final, outDir, shapeScore: metrics.shape_score }) : [];
  lap('error_maps');

  // Shape: the mean F over the rows marked in_shape_score (metrics.mjs).
  const shapeScore = metrics.shape_score;
  // Headline: half overall shape, half detail. Surface agreement alone is
  // dominated by large flat faces: a bare bounding box of a slab tower earned 82
  // on the 1 / 2 / 5 % shape score and still earns 63 on the current one.
  // Detail is what separates a model of the object from a box around it.
  // When the evidence shows no group well enough to score, shape stands alone.
  const score = detail.score === null || detail.score === undefined ? shapeScore : round((shapeScore + detail.score) / 2, 2);
  return {
    ...baseReport(context), valid: true, error: null, score, shape_score: shapeScore,
    global: { diagonal_m: round(diagonal), normal_consistency: metrics.normal_consistency, thresholds: metrics.thresholds, shape_fractions: [...SHAPE_FRACTIONS],
      distance: 'point-to-visible-surface', points: metrics.points },
    alignment: { yaw_deg: round(main.transform.yaw * 180 / Math.PI, 3), scale: round(main.transform.scale, 5), scale_locked: !scaleFree,
      translation_m: main.transform.translation.map(v => round(v)), frame_error: frameError(context, main.transform, !scaleFree), start: main.start,
      shape_pose: shapePose(context, main),
      candidates: (main.candidates ?? []).map(entry => ({ start: entry.start, yaw_deg: round(entry.yaw_deg, 1), scale: round(entry.scale, 4), f: round(entry.f), f1: round(entry.f1) })) },
    strict: { f: round(strict.f), precision: round(strict.precision), recall: round(strict.recall) },
    shape: { f: round(shapeF.f), scale: round(shape.transform.scale, 5) },
    detail, probes, probe_summary: probeSummary, alternates, appearance: colour,
    technical: technical(candidate, bytes), artifacts,
    evidence: context.evidence, warnings: context.warnings,
    timing_ms: Math.round(performance.now() - started), timing_breakdown_ms: timing,
  };
}

// glb: Buffer. Always resolves to a report; never throws for a bad submission.
// `context` may be passed to score many submissions against one loaded task.
export async function scoreSubmission({ glb, taskDir, truthDir, dataRoot, outDir, context }) {
  const started = performance.now();
  context ??= await loadContext({ taskDir, truthDir, dataRoot });
  let candidate = null;
  const bytes = glb?.length ?? null;
  try {
    if (!glb || typeof glb.length !== 'number') throw new Error('No GLB bytes');
    candidate = await soupFromGLB(Buffer.isBuffer(glb) ? glb : Buffer.from(glb), context.budget);
  } catch (error) {
    return invalidReport(context, error?.message ?? String(error), { bytes, started });
  }
  const report = scoreSoup({ candidate, context, outDir, bytes });
  report.timing_ms = Math.round(performance.now() - started);
  return report;
}
