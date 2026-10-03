import { closestPointOnTriangle } from './grid.mjs';
import { triangleNormals } from './sampling.mjs';

// DESIGN.md 9.5: distance from a point to the other model's first-visible
// surface. The sample points (one per 0.4 % of the diagonal) say where that
// surface is; the distance itself is measured to the triangles seen in their
// voxels, so it is not limited by the sample spacing. Two samplings of one
// surface with independent pixel and voxel phases (a submission is framed on
// its own bounds) lie up to a spacing apart point to point: over 150 such
// re-samplings of the 25 dev truths the worst F was 55.0 at 0.25 % of the
// diagonal and 99.1 at 0.5 %; to the surface 99.6 and 99.8.
//
// Only the first-visible part of a triangle counts: its closest point is
// accepted only when a sampling view sees it - when the surface the view's
// depth map holds at that pixel's centre is not in front of the triangle's
// plane there (by more than a quarter pixel). Comparing at the pixel centre
// with the plane's own depth there, not with the point's depth, keeps the
// test exact on steep and grazing faces. Otherwise a wall triangle running on
// behind a porch would let a model without the porch match the wall it
// exposes. A hidden closest point falls back to the nearest sample's distance,
// which is conservative by at most a sample spacing. Hidden surface slips
// through only where what hides it stands less than a quarter pixel (0.05 %
// of the diagonal) in front of it.
export const VISIBILITY = {
  // Views within ~1 degree of a triangle's plane are not asked: its depth
  // there is ill-conditioned.
  minCos: 0.02,
  // Depth tolerance in pixels (rounding; the depth maps are Float32).
  tolerance: 0.25,
};
// The search for triangles under nearby samples reaches this much further
// than the nearest sample (as a fraction of the diagonal): two sample
// spacings, so the samples around the true closest point are always visited.
export const SEARCH_SLACK_FRACTION = 0.008;

// The sampled surface of `soup` as a distance target: its sample (from
// sampleSurface({ keepViews: true }): `views`, and `voxelTriangles`, the
// triangles seen in each point's voxel; failing that, each point's own
// triangle) and a PointGrid over the sample points.
export function visibleSurface(soup, sample, grid) {
  const lists = sample.voxelTriangles ?? { start: Int32Array.from({ length: sample.tri.length + 1 }, (_, k) => k), tris: sample.tri };
  return { soup, normals: triangleNormals(soup), lists, views: sample.views ?? [], grid, mark: new Uint32Array(soup.triangles), generation: 0 };
}

// Is point f, on triangle t of the target, first-visible in a sampling view?
// (Orthographic views; depth grows along `forward`.)
function isVisible(target, t, f) {
  const n = target.normals, nx = n[3 * t], ny = n[3 * t + 1], nz = n[3 * t + 2];
  for (const { camera, depth, pixel } of target.views) {
    const { origin, right, up, forward, width, height, extent } = camera;
    const nf = nx * forward[0] + ny * forward[1] + nz * forward[2];
    if (Math.abs(nf) < VISIBILITY.minCos) continue;
    const qx = f[0] - origin[0], qy = f[1] - origin[1], qz = f[2] - origin[2];
    const u = qx * right[0] + qy * right[1] + qz * right[2], v = qx * up[0] + qy * up[1] + qz * up[2];
    const px = (u - extent[0]) / (extent[1] - extent[0]) * width, py = (extent[3] - v) / (extent[3] - extent[2]) * height;
    if (!(px >= 0 && px < width && py >= 0 && py < height)) continue;
    const ix = Math.floor(px), iy = Math.floor(py);
    const uc = extent[0] + (ix + 0.5) / width * (extent[1] - extent[0]), vc = extent[3] - (iy + 0.5) / height * (extent[3] - extent[2]);
    // Depth of the triangle's plane at the pixel centre: n . (dq) = 0 along it.
    const nr = nx * right[0] + ny * right[1] + nz * right[2], nu = nx * up[0] + ny * up[1] + nz * up[2];
    const z = qx * forward[0] + qy * forward[1] + qz * forward[2], centre = z - (nr * (uc - u) + nu * (vc - v)) / nf;
    if (depth[iy * width + ix] >= centre - VISIBILITY.tolerance * pixel) return true;
  }
  return false;
}

// Distance from (x, y, z) to the target's visible surface, given `nearest`,
// the distance to its nearest sample point (an upper bound). The triangles
// seen in the voxels of the sample points within `radius` are tried; pass
// radius = nearest + slack (capped where larger distances no longer matter).
const foot = [0, 0, 0];
export function surfaceDistance(target, x, y, z, nearest, radius) {
  const { soup: { positions }, lists: { start, tris }, mark } = target, generation = ++target.generation;
  let best2 = nearest * nearest;
  target.grid.forEachWithin(x, y, z, radius, k => {
    for (let m = start[k], end = start[k + 1]; m < end; m++) {
      const t = tris[m];
      if (mark[t] === generation) continue;
      mark[t] = generation;
      const d2 = closestPointOnTriangle(positions, t, x, y, z, foot);
      if (d2 < best2 && isVisible(target, t, foot)) best2 = d2;
    }
  });
  return Math.sqrt(best2);
}
