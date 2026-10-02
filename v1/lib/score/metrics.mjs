// Headline surface agreement (DESIGN.md 9.5) and appearance (9.9).
export const THRESHOLDS = [0.01, 0.02, 0.05];
export const HEADLINE_FRACTION = 0.02;
// CIE76 difference under which two base colours count as "the same colour" in
// appearance.match_fraction. About four just-noticeable differences: a colour
// read off a photograph under unknown light is not expected to be closer.
export const COLOUR_MATCH_DELTA_E = 10;

const round = (value, digits = 4) => value === null || !Number.isFinite(value) ? value : Number(value.toFixed(digits));
export { round };

// truth:     { points, normals, evidenced, grid } — the visible-surface sample
// candidate: { points, normals, grid } — already in the truth frame
// Returns the report blocks plus per-point nearest data reused by appearance
// and the error maps.
export function surfaceMetrics(truth, candidate, diagonal) {
  const taus = THRESHOLDS.map(fraction => fraction * diagonal), reach = taus[taus.length - 1] * 1.5;
  const truthCount = truth.points.length / 3, candidateCount = candidate.points.length / 3;
  const candidateDistance = new Float64Array(candidateCount).fill(Infinity), candidateNearest = new Int32Array(candidateCount).fill(-1);
  const counted = new Uint8Array(candidateCount);
  let countedTotal = 0;
  for (let i = 0; i < candidateCount; i++) {
    const j = truth.grid.nearest(candidate.points[3 * i], candidate.points[3 * i + 1], candidate.points[3 * i + 2]);
    if (j < 0) continue;
    candidateNearest[i] = j; candidateDistance[i] = truth.grid.distance;
    if (truth.evidenced[j] || truth.empty?.(candidate.points[3 * i], candidate.points[3 * i + 1], candidate.points[3 * i + 2])) { counted[i] = 1; countedTotal++; }
  }
  const truthDistance = new Float64Array(truthCount).fill(Infinity), truthNearest = new Int32Array(truthCount).fill(-1);
  let evidencedTotal = 0;
  for (let j = 0; j < truthCount; j++) {
    if (!truth.evidenced[j]) continue;
    evidencedTotal++;
    const i = candidate.grid.nearest(truth.points[3 * j], truth.points[3 * j + 1], truth.points[3 * j + 2], reach);
    if (i >= 0) { truthNearest[j] = i; truthDistance[j] = candidate.grid.distance; }
  }
  const thresholds = THRESHOLDS.map((fraction, k) => {
    let precise = 0, recalled = 0;
    for (let i = 0; i < candidateCount; i++) if (counted[i] && candidateDistance[i] <= taus[k]) precise++;
    for (let j = 0; j < truthCount; j++) if (truth.evidenced[j] && truthDistance[j] <= taus[k]) recalled++;
    const precision = countedTotal ? precise / countedTotal : 0, recall = evidencedTotal ? recalled / evidencedTotal : 0;
    const f = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    return { fraction, tau_m: round(taus[k]), precision: round(precision), recall: round(recall), f: round(f) };
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
    normal_consistency: normalPairs ? round(normalSum / normalPairs) : null,
    points: { truth: truthCount, truth_evidenced: evidencedTotal, candidate: candidateCount, candidate_counted: countedTotal },
    nearest: { truthDistance, truthNearest, candidateDistance, candidateNearest, counted },
  };
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
