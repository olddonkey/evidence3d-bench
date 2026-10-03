// DESIGN.md 9.4. Fits p' = s * Ry(yaw) * p + t from candidate to truth. Only
// these degrees of freedom exist: the frame origin and heading are conventions,
// size is a convention only when the evidence carries no scale.
//
// A point set here is { points (xyz), normals, grid (nearest-point index) }
// plus, for the truth, `evidenced` flags; optionally `full` (the
// full-resolution set the thinned points are measured against), `empty` (the
// shown-empty-space test) and `filter` (when the set is only part of the
// truth). Candidate points stay in the candidate's own space; truth points are
// mapped back through the inverse transform instead of re-indexing the
// candidate on every iteration.
export const SCALE_BOUNDS = [0.2, 5];
export const IDENTITY = Object.freeze({ scale: 1, yaw: 0, translation: [0, 0, 0] });

export function forward(transform, x, y, z, out) {
  const { scale: s, yaw, translation: t } = transform, c = Math.cos(yaw), n = Math.sin(yaw);
  out[0] = s * (c * x + n * z) + t[0]; out[1] = s * y + t[1]; out[2] = s * (-n * x + c * z) + t[2];
  return out;
}

export function inverse(transform, x, y, z, out) {
  const { scale: s, yaw, translation: t } = transform, c = Math.cos(yaw), n = Math.sin(yaw);
  const a = (x - t[0]) / s, b = (y - t[1]) / s, d = (z - t[2]) / s;
  out[0] = c * a - n * d; out[1] = b; out[2] = n * a + c * d;
  return out;
}

export const wrapAngle = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

// Precision / recall / F at distance tau (truth units) for one transform. The
// query points may be a thinned subset; distances are measured against the
// full-resolution sets (`full`) when given, because thinning the targets
// biases recall downwards by the thinned spacing and makes poses whose F
// differs by a few per cent indistinguishable. Candidate points whose nearest
// truth point is not evidenced are left out of precision (9.5), unless the
// evidence shows their place to be empty (truth.empty, see coverage.mjs).
export function fScores(truth, candidate, transform, taus) {
  const q = [0, 0, 0], truthTarget = truth.full ?? truth, candidateTarget = candidate.full ?? candidate, reach = Math.max(...taus);
  const precise = taus.map(() => 0), recalled = taus.map(() => 0);
  let counted = 0, evidenced = 0;
  for (let i = 0; i < candidate.points.length; i += 3) {
    forward(transform, candidate.points[i], candidate.points[i + 1], candidate.points[i + 2], q);
    if (!inPart(truth, q)) continue;
    const j = truthTarget.grid.nearest(q[0], q[1], q[2]);
    if (j < 0) continue;
    if (!truthTarget.evidenced[j] && !truth.empty?.(q[0], q[1], q[2])) continue;
    counted++;
    for (let k = 0; k < taus.length; k++) if (truthTarget.grid.distance <= taus[k]) precise[k]++;
  }
  for (let j = 0, n = truth.points.length / 3; j < n; j++) {
    if (!truth.evidenced[j]) continue;
    evidenced++;
    inverse(transform, truth.points[3 * j], truth.points[3 * j + 1], truth.points[3 * j + 2], q);
    if (candidateTarget.grid.nearest(q[0], q[1], q[2], reach / transform.scale) < 0) continue;
    const d = candidateTarget.grid.distance * transform.scale;
    for (let k = 0; k < taus.length; k++) if (d <= taus[k]) recalled[k]++;
  }
  return taus.map((tau, k) => {
    const precision = counted ? precise[k] / counted : 0, recall = evidenced ? recalled[k] / evidenced : 0;
    return { tau, precision, recall, f: precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0, counted, evidenced };
  });
}

export const fScore = (truth, candidate, transform, tau) => fScores(truth, candidate, transform, [tau])[0];

// Pose quality for choosing between fits: F@2 % first, and when two poses are
// within half a point of each other, F@1 %. F@2 % alone is flat for small
// offsets, so it cannot tell a fit from the same fit slid 20 cm along a wall.
// The shape score's tolerances are finer: index.mjs refines the chosen pose
// for them in a last stage that never leaves its basin. The ranking itself
// stays at 2 % / 1 %: no test or calibration row showed a problem with it, and
// FRAME_MARGIN below is calibrated in F@2 % points.
export const TIE = 0.005;
// The pairing radius the fit settles at: the ranking threshold. A narrower
// final kernel (1 %) was tried: it locks a mis-sized model onto whichever wall
// happens to agree instead of balancing the error, and lost 14 points
// of F@2 % on a 10 % oversized fixture against the pose F@2 % itself prefers.
export const FINAL_SIGMA_FRACTION = 0.02;
export function poseQuality(truth, candidate, transform, diagonal) {
  const [f2, f1] = fScores(truth, candidate, transform, [0.02 * diagonal, 0.01 * diagonal]).map(row => row.f);
  return { f: f2, f1 };
}
export const betterPose = (a, b) => Math.abs(a.f - b.f) > TIE ? a.f > b.f : a.f1 >= b.f1;

// One trimmed, robustly weighted ICP update. Pairs come from both directions
// (truth -> nearest candidate, and candidate -> nearest truth when that truth
// point is evidenced), each direction carrying equal total weight: junk in the
// candidate corrupts only the second, missing parts only the first. Pairs
// further apart than sigma are trimmed; the rest are weighted 1 / (1 + (d/c)^2)
// with c = sigma / 2. A smooth weight rather than a tight hard cut: with a
// hard cut at a few times the median, a surface that starts to slide (a roof
// while the fit drifts upwards between vertical walls) drops out of the fit and
// stops pulling back, and the fit runs away along the unconstrained direction.
// Moments are taken about fixed reference points so far-away models stay exact.
// Once the radius is small the thinned query points are paired with the
// full-resolution targets: thinned targets put every pair a few centimetres
// apart even at the true pose, which a narrow kernel cannot tell from error.
export const FULL_PAIRING_FRACTION = 0.05;
const NORMAL_AGREEMENT = Math.cos(Math.PI / 4);
// When the truth set is only part of the object (`filter`, see context.mjs),
// a candidate point counts for it only if its nearest whole-truth point is in
// that part.
function inPart(truth, q) {
  if (!truth.filter) return true;
  const k = truth.filter.index.nearest(q[0], q[1], q[2]);
  return k >= 0 && truth.filter.mask[k] === 1;
}

// Pairs for one step. Per pair: candidate point xyz (candidate space), truth
// point xyz, truth unit normal, distance (truth units).
const PAIR = 10;
function collectPairs(truth, candidate, transform, sigma, diagonal) {
  const q = [0, 0, 0], fine = sigma <= FULL_PAIRING_FRACTION * diagonal;
  const truthTarget = fine && truth.full?.points ? truth.full : truth, candidateTarget = fine && candidate.full?.points ? candidate.full : candidate;
  const tp = truth.points, cp = candidate.points, nt = tp.length / 3, nc = cp.length / 3;
  const tt = truthTarget.points, ct = candidateTarget.points, tn = truth.normals, ttn = truthTarget.normals;
  const pairs = [{ data: new Float64Array(PAIR * nt), n: 0 }, { data: new Float64Array(PAIR * nc), n: 0 }];
  const push = (list, px, py, pz, qx, qy, qz, normals, j, d) => {
    const at = PAIR * list.n++, data = list.data;
    data[at] = px; data[at + 1] = py; data[at + 2] = pz; data[at + 3] = qx; data[at + 4] = qy; data[at + 5] = qz;
    if (normals) { data[at + 6] = normals[3 * j]; data[at + 7] = normals[3 * j + 1]; data[at + 8] = normals[3 * j + 2]; }
    data[at + 9] = d;
  };
  // In the fine stage a pair must also face the same way (normals within 45
  // degrees, the candidate's turned by the current yaw). Otherwise, with
  // one-sided evidence, the candidate's unseen side walls pair with the seen
  // front wall's edge.
  const cos = Math.cos(transform.yaw), sin = Math.sin(transform.yaw), check = fine && tn && candidate.normals;
  const agree = (cn, i, normals, j) => Math.abs((cos * cn[3 * i] + sin * cn[3 * i + 2]) * normals[3 * j] + cn[3 * i + 1] * normals[3 * j + 1] + (-sin * cn[3 * i] + cos * cn[3 * i + 2]) * normals[3 * j + 2]) >= NORMAL_AGREEMENT;
  for (let j = 0; j < nt; j++) {
    if (!truth.evidenced[j]) continue;
    inverse(transform, tp[3 * j], tp[3 * j + 1], tp[3 * j + 2], q);
    const i = candidateTarget.grid.nearest(q[0], q[1], q[2], sigma / transform.scale);
    if (i < 0 || (check && !agree(candidateTarget.normals, i, tn, j))) continue;
    push(pairs[0], ct[3 * i], ct[3 * i + 1], ct[3 * i + 2], tp[3 * j], tp[3 * j + 1], tp[3 * j + 2], tn, j, candidateTarget.grid.distance * transform.scale);
  }
  for (let i = 0; i < nc; i++) {
    forward(transform, cp[3 * i], cp[3 * i + 1], cp[3 * i + 2], q);
    if (!inPart(truth, q)) continue;
    const j = truthTarget.grid.nearest(q[0], q[1], q[2], sigma);
    if (j < 0 || !truthTarget.evidenced[j] || (check && !agree(candidate.normals, i, ttn, j))) continue;
    push(pairs[1], cp[3 * i], cp[3 * i + 1], cp[3 * i + 2], tt[3 * j], tt[3 * j + 1], tt[3 * j + 2], ttn, j, truthTarget.grid.distance);
  }
  return pairs;
}

function update(truth, candidate, transform, sigma, scaleFree, centres, diagonal, fixedScale = 1) {
  const [cx, cy, cz] = centres.candidate, [tx, ty, tz] = centres.truth;
  const pairs = collectPairs(truth, candidate, transform, sigma, diagonal);
  const sums = [new Float64Array(12), new Float64Array(12)], c2 = (sigma / 2) ** 2;
  for (const [direction, list] of pairs.entries()) {
    const s = sums[direction], data = list.data;
    for (let k = 0; k < list.n; k++) {
      const at = PAIR * k, w = 1 / (1 + data[at + 9] * data[at + 9] / c2);
      const px = data[at] - cx, py = data[at + 1] - cy, pz = data[at + 2] - cz;
      const qx = data[at + 3] - tx, qy = data[at + 4] - ty, qz = data[at + 5] - tz;
      s[0] += w; s[1] += w * px; s[2] += w * py; s[3] += w * pz; s[4] += w * qx; s[5] += w * qy; s[6] += w * qz;
      s[7] += w * (qx * px + qz * pz); s[8] += w * (qx * pz - qz * px); s[9] += w * qy * py; s[10] += w * (px * px + py * py + pz * pz);
      s[11]++;
    }
  }
  const total = new Float64Array(12);
  for (const s of sums) if (s[0] > 0) for (let k = 0; k < 11; k++) total[k] += s[k] / s[0];
  const W = total[0];
  if (!(W > 0) || sums[0][11] + sums[1][11] < 6) return { transform, pairs: sums[0][11] + sums[1][11] };
  const p = [total[1] / W, total[2] / W, total[3] / W], r = [total[4] / W, total[5] / W, total[6] / W];
  const A = total[7] - W * (r[0] * p[0] + r[2] * p[2]), B = total[8] - W * (r[0] * p[2] - r[2] * p[0]);
  const C = total[9] - W * r[1] * p[1], spread = total[10] - W * (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
  if (!(spread > 1e-12)) return { transform, pairs: sums[0][11] + sums[1][11] };
  const yaw = Math.atan2(B, A), c = Math.cos(yaw), n = Math.sin(yaw);
  // Scale is fitted only when the evidence carries none; otherwise it is held
  // (at 1, or at a previously fitted value when a fit is only being refined).
  const scale = scaleFree ? Math.min(SCALE_BOUNDS[1], Math.max(SCALE_BOUNDS[0], (c * A + n * B + C) / spread)) : fixedScale;
  // Back from reference-centred coordinates: q = s R (p - cc) + t~ + tc.
  const local = [r[0] - scale * (c * p[0] + n * p[2]), r[1] - scale * p[1], r[2] - scale * (-n * p[0] + c * p[2])];
  const translation = [
    local[0] + tx - scale * (c * cx + n * cz),
    local[1] + ty - scale * cy,
    local[2] + tz - scale * (-n * cx + c * cz),
  ];
  return { transform: { scale, yaw: wrapAngle(yaw), translation }, pairs: sums[0][11] + sums[1][11] };
}

function moved(a, b, diagonal) {
  const dt = Math.hypot(a.translation[0] - b.translation[0], a.translation[1] - b.translation[1], a.translation[2] - b.translation[2]);
  return Math.abs(wrapAngle(a.yaw - b.yaw)) > 1e-5 || Math.abs(Math.log(a.scale / b.scale)) > 1e-5 || dt > 1e-5 * diagonal;
}

// Trimmed ICP from `start`, with the pairing radius shrinking from sigmaStart to
// sigmaEnd by `shrink` per iteration, then held until the fit stops moving.
export function icp(truth, candidate, start, { diagonal, scaleFree, centres, sigmaStart, sigmaEnd, shrink = 0.8, iterations = 40, fixedScale = 1 }) {
  let transform = { scale: start.scale, yaw: start.yaw, translation: [...start.translation] }, sigma = sigmaStart;
  for (let k = 0; k < iterations; k++) {
    const next = update(truth, candidate, transform, sigma, scaleFree, centres, diagonal, fixedScale).transform;
    const settled = sigma <= sigmaEnd && !moved(next, transform, diagonal);
    transform = next;
    if (settled) break;
    sigma = Math.max(sigmaEnd, sigma * shrink);
  }
  return transform;
}

// Point-to-plane Gauss-Newton refinement of yaw, scale (when free) and
// translation, minimising the robustly weighted distance of each pair along
// the truth normal. The closed-form point-to-point step above converges very
// slowly along directions only a few edges constrain: with one photograph of
// a facade the evidence is nearly one plane, every on-plane pair pulls only
// across the plane, and point-to-point stops with the scale a per cent off.
// Point-to-plane lets the few window reveals and wall ends that do constrain
// it act undiluted.
export function planeRefine(truth, candidate, start, { diagonal, scaleFree, centres, sigma, iterations = 12, fixedScale = start.scale }) {
  let transform = { scale: scaleFree ? start.scale : fixedScale, yaw: start.yaw, translation: [...start.translation] };
  const [cx, cy, cz] = centres.candidate, size = scaleFree ? 5 : 4, c2 = (sigma / 2) ** 2;
  for (let k = 0; k < iterations; k++) {
    const pairs = collectPairs(truth, candidate, transform, sigma, diagonal);
    if (pairs[0].n + pairs[1].n < 12) break;
    const { yaw, scale: s, translation } = transform, cos = Math.cos(yaw), sin = Math.sin(yaw);
    // Centred parametrisation f(p) = s R (p - cc) + u keeps the yaw column well scaled.
    const u = [translation[0] + s * (cos * cx + sin * cz), translation[1] + s * cy, translation[2] + s * (-sin * cx + cos * cz)];
    const H = new Float64Array(size * size), g = new Float64Array(size), J = new Float64Array(size);
    for (const list of pairs) {
      if (!list.n) continue;
      const data = list.data, share = 1 / list.n;
      for (let m = 0; m < list.n; m++) {
        const at = PAIR * m, px = data[at] - cx, py = data[at + 1] - cy, pz = data[at + 2] - cz;
        const nx = data[at + 6], ny = data[at + 7], nz = data[at + 8];
        const rx = cos * px + sin * pz, rz = -sin * px + cos * pz, dx = -sin * px + cos * pz, dz = -cos * px - sin * pz;
        const fx = s * rx + u[0], fy = s * py + u[1], fz = s * rz + u[2];
        const residual = nx * (fx - data[at + 3]) + ny * (fy - data[at + 4]) + nz * (fz - data[at + 5]);
        const w = share / (1 + data[at + 9] * data[at + 9] / c2);
        J[0] = s * (nx * dx + nz * dz); J[1] = nx; J[2] = ny; J[3] = nz;
        if (scaleFree) J[4] = nx * rx + ny * py + nz * rz;
        for (let a = 0; a < size; a++) {
          g[a] += w * J[a] * residual;
          for (let b = 0; b < size; b++) H[a * size + b] += w * J[a] * J[b];
        }
      }
    }
    // A direction nothing constrains must not move: a small relative ridge.
    for (let a = 0; a < size; a++) H[a * size + a] += 1e-6 * H[a * size + a] + 1e-12;
    const step = solve(H, g, size);
    if (!step) break;
    const nextYaw = wrapAngle(yaw - step[0]), nextScale = scaleFree ? Math.min(SCALE_BOUNDS[1], Math.max(SCALE_BOUNDS[0], s - step[4])) : s;
    const nextU = [u[0] - step[1], u[1] - step[2], u[2] - step[3]], c = Math.cos(nextYaw), n = Math.sin(nextYaw);
    const next = { scale: nextScale, yaw: nextYaw, translation: [nextU[0] - nextScale * (c * cx + n * cz), nextU[1] - nextScale * cy, nextU[2] - nextScale * (-n * cx + c * cz)] };
    const settled = !moved(next, transform, diagonal);
    transform = next;
    if (settled) break;
  }
  return transform;
}

// Gaussian elimination with partial pivoting for the small normal equations.
function solve(H, g, size) {
  const a = Array.from({ length: size }, (_, r) => [...H.subarray(r * size, r * size + size), g[r]]);
  for (let col = 0; col < size; col++) {
    let pivot = col;
    for (let r = col + 1; r < size; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (!(Math.abs(a[pivot][col]) > 1e-300)) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < size; r++) {
      if (r === col) continue;
      const factor = a[r][col] / a[col][col];
      for (let k = col; k <= size; k++) a[r][k] -= factor * a[col][k];
    }
  }
  return a.map((row, r) => row[size] / row[r]);
}

// Multi-start fit. Starts: the model as delivered (contestants are told the
// frame, so a good model usually needs no fit at all), and twelve headings with
// the box centres matched, for each initial scale. Every start runs a short
// coarse ICP; the best few by F@2% — and always the as-delivered start — are
// run to convergence; the best by F@2% wins, except against the pose reached
// from the frame as delivered: that one is kept unless another pose beats it
// by more than FRAME_MARGIN in F@2 %, and within that margin it must also be
// better by more than TIE in F@1 % (ties go to the frame as delivered).
// With one-sided evidence a model turned round can match almost as well — on
// the fixture's front photograph the truth itself turned round loses only 2.1
// points of F@2 % (a plain rear wall is within 2 % of a facade with shallow
// recesses), and a front with two open window holes turned round gains 1.1
// points while losing 1.3 points of F@1 %. A near tie must not throw away a
// correct frame and with it every detail that the frame put in place; the
// margin stays below the 2.1 points so a model delivered backwards is still
// turned round.
export const FRAME_MARGIN = 0.015;

// Two poses are the same fit when they turn the model by less than 15 degrees,
// scale it by less than 10 % and move its centre by less than 10 % of the
// diagonal relative to each other; the frame preference above only arbitrates
// between different fits (turned round, mirrored halves matched), never
// between nearby poses of one fit, where F@2 % alone decides.
function sameBasin(a, b, centre, diagonal) {
  const at = inverse(b, centre[0], centre[1], centre[2], [0, 0, 0]), moved = forward(a, at[0], at[1], at[2], [0, 0, 0]);
  return Math.abs(wrapAngle(a.yaw - b.yaw)) < 15 * Math.PI / 180 && Math.abs(Math.log(a.scale / b.scale)) < 0.1 &&
    Math.hypot(moved[0] - centre[0], moved[1] - centre[1], moved[2] - centre[2]) < 0.1 * diagonal;
}
export function multiStartAlign(truth, candidate, { diagonal, scaleFree, centres, scaleInits = [1], keep = 4 }) {
  const starts = [];
  const rotate = (yaw, v) => [Math.cos(yaw) * v[0] + Math.sin(yaw) * v[2], v[1], -Math.sin(yaw) * v[0] + Math.cos(yaw) * v[2]];
  for (const scale of scaleFree ? scaleInits : [1]) {
    starts.push({ scale, yaw: 0, translation: [0, 0, 0], label: 'as delivered' });
    for (let k = 0; k < 12; k++) {
      const yaw = wrapAngle(k * Math.PI / 6), turned = rotate(yaw, centres.candidate);
      starts.push({ scale, yaw, translation: centres.truth.map((value, i) => value - scale * turned[i]), label: 'heading ' + k * 30 });
    }
  }
  const options = { diagonal, scaleFree, centres };
  const judge = (transform, label) => ({ transform, label, ...poseQuality(truth, candidate, transform, diagonal) });
  // ICP is kept unless it made the start clearly worse: a model delivered in
  // the right frame must not be dragged off it by pairing at a wide radius.
  const keepBetter = (before, after) => (before.f > after.f + TIE ? before : after);
  const coarse = starts.map(start => {
    const moved = icp(truth, candidate, start, { ...options, sigmaStart: 0.3 * diagonal, sigmaEnd: 0.03 * diagonal, iterations: 10 });
    return keepBetter(judge(start, start.label), judge(moved, start.label));
  }).sort((a, b) => (betterPose(a, b) ? -1 : 1));
  const chosen = coarse.slice(0, keep);
  for (const entry of coarse) if (entry.label === 'as delivered' && !chosen.includes(entry)) chosen.push(entry);
  let best = null, delivered = null;
  const refined = [];
  for (const entry of chosen) {
    const transform = icp(truth, candidate, entry.transform, { ...options, sigmaStart: 0.05 * diagonal, sigmaEnd: FINAL_SIGMA_FRACTION * diagonal, iterations: 40 });
    const result = keepBetter(entry, judge(transform, entry.label));
    refined.push(result);
    if (!best || !betterPose(best, result)) best = result;
    if (entry.label === 'as delivered' && (!delivered || !betterPose(delivered, result))) delivered = result;
  }
  if (delivered && best !== delivered && !sameBasin(best.transform, delivered.transform, centres.truth, diagonal) &&
      best.f <= delivered.f + FRAME_MARGIN && best.f1 <= delivered.f1 + TIE) best = delivered;
  return { transform: best.transform, f: best.f, start: best.label, starts: starts.length,
    candidates: refined.map(entry => ({ start: entry.label, yaw_deg: entry.transform.yaw * 180 / Math.PI, scale: entry.transform.scale, f: entry.f, f1: entry.f1 })) };
}
