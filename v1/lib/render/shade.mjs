import * as raster from '../raster.mjs';
import { encodePNG } from '../png.mjs';
import { createShader, DEFAULT_SHADING, VIEW_NAMES } from '../../tools/shading.mjs';

// Shaded rendering for the benchmark side (reports, calibration pictures). The
// implementation lives in v1/tools/shading.mjs so that the contestant preview
// kit, which is copied out of the repository, draws exactly the same pictures.
const shader = createShader(raster);

export { DEFAULT_SHADING, VIEW_NAMES };

// shadeSoup(soup, camera, options) -> { width, height, pixels (RGB Uint8Array), covered, grid }
//   options: clay, background, clayColor, ambient, diffuse, fill, edges, edgeColor,
//            edgeStrength, creaseDeg, ground, groundY, grid, supersample
export const shadeSoup = shader.shadeSoup;

// standardViews(bounds, size) -> { front, rear, left, right, top, iso, 'iso-rear' } kernel cameras.
export const standardViews = shader.standardViews;

// customCamera({ position, target, fov_y_deg, width, height }) -> perspective camera.
export const customCamera = shader.customCamera;

export function shadeToPNG(soup, camera, options) {
  const image = shadeSoup(soup, camera, options);
  return { ...image, png: encodePNG(image.width, image.height, image.pixels, 3) };
}

// Union of bounding boxes, so several models can share one set of cameras.
export function unionBounds(...boxes) {
  const valid = boxes.filter(box => box && box.min.every(Number.isFinite) && box.max.every(Number.isFinite));
  if (!valid.length) throw new Error('unionBounds needs at least one finite box');
  return {
    min: [0, 1, 2].map(i => Math.min(...valid.map(box => box.min[i]))),
    max: [0, 1, 2].map(i => Math.max(...valid.map(box => box.max[i]))),
  };
}
