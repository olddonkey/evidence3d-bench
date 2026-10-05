// Camera estimation for real photographs: a photograph's camera is recovered
// from building points identified in it (resection). The camera JSON is the
// kernel's perspectiveCamera, exactly what rendered photographs record
// (v1/lib/evidence/photos.mjs), so coverage treats real and rendered photographs
// alike.
//
// Pose: position (m), heading_deg (compass bearing of the view with the model's
// -Z as north and +X as east: 0 looks along -Z, 90 along +X), pitch_deg (up
// positive), roll_deg (turns the image clockwise), fov_y_deg, width, height.
import { perspectiveCamera, projectPoint, normalize, cross, dot } from '../raster.mjs';

const RAD = Math.PI / 180;

function rotateAbout(v, k, angle) {
  const c = Math.cos(angle), s = Math.sin(angle), kv = cross(k, v), d = dot(k, v);
  return [0, 1, 2].map(i => v[i] * c + kv[i] * s + k[i] * d * (1 - c));
}

export function cameraFromPose({ position, heading_deg, pitch_deg = 0, roll_deg = 0, fov_y_deg, width, height }) {
  const h = heading_deg * RAD, p = pitch_deg * RAD;
  const forward = normalize([Math.sin(h) * Math.cos(p), Math.sin(p), -Math.cos(h) * Math.cos(p)]);
  const up = roll_deg ? rotateAbout([0, 1, 0], forward, roll_deg * RAD) : [0, 1, 0];
  return perspectiveCamera({ position, forward, up, fov_y_deg, width, height });
}

const PARAMS = ['x', 'y', 'z', 'heading_deg', 'pitch_deg', 'roll_deg', 'fov_y_deg'];
const STEP = [1e-3, 1e-3, 1e-3, 1e-3, 1e-3, 1e-3, 1e-3];
const toPose = (p, size) => ({ position: [p[0], p[1], p[2]], heading_deg: p[3], pitch_deg: p[4], roll_deg: p[5], fov_y_deg: p[6], ...size });

function residuals(p, points, size) {
  const camera = cameraFromPose(toPose(p, size)), out = [];
  for (const { model, image } of points) {
    const [x, y, depth] = projectPoint(camera, model);
    // A point behind the camera is pushed back in front with a steep penalty.
    if (!(depth > 0.1)) { out.push(1e4, 1e4); continue; }
    out.push(x - image[0], y - image[1]);
  }
  return out;
}

function solveLinear(a, b) {
  const n = b.length, m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-15) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k]; }
  }
  return m.map((row, i) => row[n] / row[i]);
}

// points: [{ name, model: [x,y,z], image: [px, py] }]; start: a pose; fixed:
// names of pose parameters to hold (e.g. ['fov_y_deg'] when the lens is known).
// Levenberg-Marquardt on the pixel reprojection error, numeric Jacobian.
export function resect({ points, start, width, height, fixed = [], iterations = 200 }) {
  if (points.length < 4) throw new Error('Resection needs at least four points');
  const size = { width, height };
  let p = [...start.position, start.heading_deg, start.pitch_deg ?? 0, start.roll_deg ?? 0, start.fov_y_deg];
  const free = PARAMS.map((name, i) => fixed.includes(name) ? -1 : i).filter(i => i >= 0);
  const cost = r => r.reduce((sum, e) => sum + e * e, 0);
  let r = residuals(p, points, size), c = cost(r), lambda = 1e-2;
  for (let it = 0; it < iterations; it++) {
    const jac = free.map(i => {
      const q = [...p]; q[i] += STEP[i];
      return residuals(q, points, size).map((e, k) => (e - r[k]) / STEP[i]);
    });
    const jtj = free.map((_, a) => free.map((__, b) => jac[a].reduce((sum, e, k) => sum + e * jac[b][k], 0)));
    const jtr = free.map((_, a) => jac[a].reduce((sum, e, k) => sum + e * r[k], 0));
    let improved = false;
    for (let tries = 0; tries < 12 && !improved; tries++) {
      const damped = jtj.map((row, a) => row.map((value, b) => value + (a === b ? lambda * (value || 1) : 0)));
      const delta = solveLinear(damped, jtr.map(value => -value));
      if (!delta) { lambda *= 10; continue; }
      const q = [...p];
      free.forEach((i, a) => { q[i] += delta[a]; });
      const rq = residuals(q, points, size), cq = cost(rq);
      if (cq < c) {
        const done = c - cq < 1e-9 * Math.max(1, c);
        p = q; r = rq; c = cq; lambda = Math.max(1e-7, lambda / 3); improved = true;
        if (done) it = iterations;
      }
      else lambda *= 4;
    }
    if (!improved) break;
  }
  const pose = toPose(p.map((value, i) => Math.round(value * (i < 3 ? 1000 : 100)) / (i < 3 ? 1000 : 100)), size);
  const final = residuals([...pose.position, pose.heading_deg, pose.pitch_deg, pose.roll_deg, pose.fov_y_deg], points, size);
  const errors = points.map((point, k) => ({ name: point.name, error_px: Math.round(Math.hypot(final[2 * k], final[2 * k + 1]) * 10) / 10 }));
  return { pose, rms_px: Math.round(Math.sqrt(cost(final) / points.length) * 10) / 10, errors };
}
