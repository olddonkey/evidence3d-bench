import { surfaceDistance, SEARCH_SLACK_FRACTION } from './surface.mjs';
import { forward, inverse } from './align.mjs';

// Headline surface agreement (DESIGN.md 9.5) and appearance (9.9).
// shape_score is 100 x the mean F over SHAPE_FRACTIONS (of the diagonal); the
// report also carries the rows in DIAGNOSTIC_FRACTIONS, which do not enter it.
// Chosen on the dev set and the first pilot (README "Choosing the
// tolerances"): at 1 / 2 / 5 % the two strongest configurations averaged 97.7
// and 94.9 on shape and every task with scaled drawings scored 99-100; at
// 0.5 / 1 / 2 % still 94.2 and 89.5; at 0.25 / 0.5 / 1 % 88.0 and 80.4 (the
// weakest 37.8), while the truth sampled independently of itself still scores
// >= 99.6 at 0.25 % on all 25 dev tasks (point to surface; point to point it
// fell to 60.7).
export const SHAPE_FRACTIONS = [0.0025, 0.005, 0.01];
export const DIAGNOSTIC_FRACTIONS = [0.02, 0.05];
export const THRESHOLDS = [...SHAPE_FRACTIONS, ...DIAGNOSTIC_FRACTIONS].sort((a, b) => a - b);
// The matching radius for the pair-based secondary measures (appearance,
// normal consistency) and for the single-tolerance F values (strict, shape,
// alternates[].f).
export const HEADLINE_FRACTION = 0.02;
// CIE76 difference under which two base colours count as "the same colour" in
// appearance.match_fraction. About four just-noticeable differences: a colour
// read off a photograph under unknown light is not expected to be closer.
export const COLOUR_MATCH_DELTA_E = 10;

const round = (value, digits = 4) => value === null || !Number.isFinite(value) ? value : Number(value.toFixed(digits));
export { round };

// truth:     { points, normals, evidenced, grid, target } — the visible-surface sample
// candidate: { points, normals, grid, target } — already in the truth frame
// `target` (surface.mjs visibleSurface) is what distances are measured to:
// each query point's distance to the other model's first-visible surface.
// Without a target the nearest sample point's distance is used instead.
// Returns the report blocks plus per-point nearest data reused by appearance
// and the error maps (the pair-based measures keep using the nearest sample
// pairs, `truthDistance` / `candidateDistance`; the thresholds use
// `truthSurfaceDistance` / `candidateSurfaceDistance`).
export function surfaceMetrics(truth, candidate, diagonal) {
  const taus = THRESHOLDS.map(fraction => fraction * diagonal), reach = taus[taus.length - 1] * 1.5;
  const tauMin = taus[0], tauMax = taus[taus.length - 1], slack = SEARCH_SLACK_FRACTION * diagonal;
  // A point already within the smallest tolerance of a sample point is a hit
  // at every tolerance; one with no sample within the largest tolerance plus
  // the search slack is a miss at every one.
  const refine = (target, x, y, z, nearest) => (target && nearest > tauMin && nearest <= tauMax + slack
    ? surfaceDistance(target, x, y, z, nearest, Math.min(nearest, tauMax) + slack) : nearest);
  const truthCount = truth.points.length / 3, candidateCount = candidate.points.length / 3;
  const candidateDistance = new Float64Array(candidateCount).fill(Infinity), candidateNearest = new Int32Array(candidateCount).fill(-1);
  const candidateSurfaceDistance = new Float64Array(candidateCount).fill(Infinity);
  const counted = new Uint8Array(candidateCount);
  let countedTotal = 0;
  for (let i = 0; i < candidateCount; i++) {
    const x = candidate.points[3 * i], y = candidate.points[3 * i + 1], z = candidate.points[3 * i + 2];
    const j = truth.grid.nearest(x, y, z);
    if (j < 0) continue;
    candidateNearest[i] = j; candidateDistance[i] = truth.grid.distance;
    if (truth.evidenced[j] || truth.empty?.(x, y, z)) { counted[i] = 1; countedTotal++; }
    candidateSurfaceDistance[i] = counted[i] ? refine(truth.target, x, y, z, candidateDistance[i]) : candidateDistance[i];
  }
  const truthDistance = new Float64Array(truthCount).fill(Infinity), truthNearest = new Int32Array(truthCount).fill(-1);
  const truthSurfaceDistance = new Float64Array(truthCount).fill(Infinity);
  let evidencedTotal = 0;
  for (let j = 0; j < truthCount; j++) {
    if (!truth.evidenced[j]) continue;
    evidencedTotal++;
    const x = truth.points[3 * j], y = truth.points[3 * j + 1], z = truth.points[3 * j + 2];
    const i = candidate.grid.nearest(x, y, z, reach);
    if (i < 0) continue;
    truthNearest[j] = i; truthDistance[j] = candidate.grid.distance;
    truthSurfaceDistance[j] = refine(candidate.target, x, y, z, truthDistance[j]);
  }
  const thresholds = THRESHOLDS.map((fraction, k) => {
    let precise = 0, recalled = 0;
    for (let i = 0; i < candidateCount; i++) if (counted[i] && candidateSurfaceDistance[i] <= taus[k]) precise++;
    for (let j = 0; j < truthCount; j++) if (truth.evidenced[j] && truthSurfaceDistance[j] <= taus[k]) recalled++;
    const precision = countedTotal ? precise / countedTotal : 0, recall = evidencedTotal ? recalled / evidencedTotal : 0;
    const f = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    return { fraction, tau_m: round(taus[k]), precision: round(precision), recall: round(recall), f: round(f), in_shape_score: SHAPE_FRACTIONS.includes(fraction) };
  });
  // Mean |cos| between matched surface normals at the headline threshold.
  const headlineTau = HEADLINE_FRACTION * diagonal;
  let normalSum = 0, normalPairs = 0;
  for (let j = 0; j < truthCount; j++) {
    const i = truthNearest[j];
    if (i < 0 || truthDistance[j] > headlineTau) continue;
    normalSum += Math.abs(truth.normals[3 * j] * candidate.normals[3 * i] + truth.normals[3 * j + 1] * candidate.normals[3 * i + 1] + truth.normals[3 * j + 2] * candidate.normals[3 * i + 2]);
    normalPairs++;
  }
  return {
    thresholds,
    headline: thresholds.find(row => row.fraction === HEADLINE_FRACTION),
    shape_score: shapeScoreOf(thresholds),
    normal_consistency: normalPairs ? round(normalSum / normalPairs) : null,
    points: { truth: truthCount, truth_evidenced: evidencedTotal, candidate: candidateCount, candidate_counted: countedTotal },
    nearest: { truthDistance, truthNearest, candidateDistance, candidateNearest, counted, truthSurfaceDistance, candidateSurfaceDistance },
  };
}

// 100 x the mean F over the rows that enter the shape score. A single
// tolerance is a cliff (at 2 % a model 5 % too large still scored 99.9); the
// mean over a geometric ladder gives graded credit for coarse, medium and fine
// agreement.
export function shapeScoreOf(thresholds) {
  const rows = thresholds.filter(row => row.in_shape_score);
  return rows.length ? round(100 * rows.reduce((sum, row) => sum + row.f, 0) / rows.length, 2) : null;
}

// The shape score (unrounded, 0..100) of a candidate kept in its own space
// ({ points, grid, target }) and placed by `transform`, measured as
// surfaceMetrics measures it. No re-sampling is needed: distances to the
// surface do not depend on where the samples happen to fall. Used to choose
// between poses of one fit (index.mjs), on evenly thinned query points
// (`queries.truth` { points, evidenced }, `queries.candidate` { points }):
// the targets stay complete, and poses are compared on the same points.
export function poseShape(truth, candidate, transform, diagonal, { fractions = SHAPE_FRACTIONS, queries = {} } = {}) {
  const taus = fractions.map(fraction => fraction * diagonal), tauMin = Math.min(...taus), tauMax = Math.max(...taus);
  const slack = SEARCH_SLACK_FRACTION * diagonal, s = transform.scale, q = [0, 0, 0];
  const truthQuery = queries.truth ?? truth, candidatePoints = (queries.candidate ?? candidate).points;
  const precise = taus.map(() => 0), recalled = taus.map(() => 0);
  let counted = 0, evidenced = 0;
  for (let i = 0; i < candidatePoints.length; i += 3) {
    forward(transform, candidatePoints[i], candidatePoints[i + 1], candidatePoints[i + 2], q);
    const j = truth.grid.nearest(q[0], q[1], q[2]);
    if (j < 0 || !(truth.evidenced[j] || truth.empty?.(q[0], q[1], q[2]))) continue;
    counted++;
    let d = truth.grid.distance;
    if (d > tauMin && d <= tauMax + slack) d = surfaceDistance(truth.target, q[0], q[1], q[2], d, Math.min(d, tauMax) + slack);
    for (let k = 0; k < taus.length; k++) if (d <= taus[k]) precise[k]++;
  }
  for (let j = 0, n = truthQuery.points.length / 3; j < n; j++) {
    if (!truthQuery.evidenced[j]) continue;
    evidenced++;
    inverse(transform, truthQuery.points[3 * j], truthQuery.points[3 * j + 1], truthQuery.points[3 * j + 2], q);
    if (candidate.grid.nearest(q[0], q[1], q[2], (tauMax + slack) / s) < 0) continue;
    let d = candidate.grid.distance;
    if (d * s > tauMin) d = surfaceDistance(candidate.target, q[0], q[1], q[2], d, Math.min(d, tauMax / s) + slack / s);
    for (let k = 0; k < taus.length; k++) if (d * s <= taus[k]) recalled[k]++;
  }
  let sum = 0;
  for (let k = 0; k < taus.length; k++) {
    const precision = counted ? precise[k] / counted : 0, recall = evidenced ? recalled[k] / evidenced : 0;
    sum += precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  }
  return 100 * sum / taus.length;
}

// linear-sRGB (D65) -> CIE L*a*b*. Base colours in a soup are already linear
// (glTF baseColorFactor, and three.js converts '#rrggbb' to linear on load).
export function linearToLab(r, g, b) {
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
  const f = t => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  const fx = f(X / 0.95047), fy = f(Y), fz = f(Z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE76(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

// Matched pairs at the headline threshold, truth points whose material is glass
// excluded (a window's colour in a photograph is mostly reflection).
export function appearance({ truth, truthSoup, truthKinds, candidate, candidateSoup, nearest, diagonal }) {
  const tau = HEADLINE_FRACTION * diagonal, cache = new Map();
  const labOf = (soup, t, key) => {
    let lab = cache.get(key);
    if (!lab) { lab = linearToLab(soup.colors[3 * t], soup.colors[3 * t + 1], soup.colors[3 * t + 2]); cache.set(key, lab); }
    return lab;
  };
  let sum = 0, matched = 0, compared = 0;
  for (let j = 0; j < truth.points.length / 3; j++) {
    const i = nearest.truthNearest[j];
    if (i < 0 || nearest.truthDistance[j] > tau) continue;
    const tt = truth.tri[j];
    if (truthKinds[truthSoup.triPart[tt]] === 'glass') continue;
    const ct = candidate.tri[i];
    // Colours are per part (truth) or per mesh (candidate), so cache by those.
    const e = deltaE76(labOf(truthSoup, tt, 't' + truthSoup.triPart[tt]), labOf(candidateSoup, ct, 'c' + (candidateSoup.triPart?.[ct] ?? ct) + ':' + candidateSoup.colors[3 * ct] + ',' + candidateSoup.colors[3 * ct + 1] + ',' + candidateSoup.colors[3 * ct + 2]));
    sum += e; compared++;
    if (e <= COLOUR_MATCH_DELTA_E) matched++;
  }
  return compared
    ? { delta_e_mean: round(sum / compared, 2), match_fraction: round(matched / compared), compared_points: compared }
    : { delta_e_mean: null, match_fraction: null, compared_points: 0, note: 'not evaluated: no matched non-glass points' };
}
