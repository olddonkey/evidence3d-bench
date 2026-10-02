import { perspectiveCamera, orthoViewOfBounds } from '../raster.mjs';
import { soupFromModel } from '../soup.mjs';
import { VARIANTS } from '../contract.mjs';
import { boxCentre, boxDiagonal } from './sampling.mjs';

// Evidence items with real kernel cameras but no rendered files. The scorer
// reads only an item's camera, occluders, kind and source_model, so tests and
// offline calibration can pose any model at any evidence level without the
// photograph and drawing renderers. Nothing here is shown to a contestant.
const EYE = 1.6;

export function syntheticCameras(model, { width = 960, height = 720 } = {}) {
  const bounds = soupFromModel(model).bounds, centre = boxCentre(bounds), diagonal = boxDiagonal(bounds);
  const distance = 1.8 * diagonal, fov = 40;
  const street = (dx, dz) => perspectiveCamera({ position: [centre[0] + dx * distance, EYE, centre[2] + dz * distance], target: centre, fov_y_deg: fov, width, height });
  return {
    'photo-front': street(0, 1),
    'photo-left': street(-1, 0),
    'photo-right': street(1, 0),
    'photo-rear': street(0, -1),
    'photo-front-left': street(-Math.SQRT1_2, Math.SQRT1_2),
    'photo-front-right': street(Math.SQRT1_2, Math.SQRT1_2),
    // High oblique from the front-right, as an aerial survey would see it.
    aerial: perspectiveCamera({ position: [centre[0] + 0.35 * distance, centre[1] + 1.6 * distance, centre[2] + 0.6 * distance], target: centre, up: [0, 0, -1],
      fov_y_deg: fov, width: height, height }),
    'elevation-front': orthoViewOfBounds(bounds, 'front', { width: 1000 }),
    'elevation-right': orthoViewOfBounds(bounds, 'right', { width: 1000 }),
    'elevation-top': orthoViewOfBounds(bounds, 'top', { width: 1000 }),
  };
}

const KIND = id => id.startsWith('photo') ? 'photo' : id === 'aerial' ? 'aerial' : id.startsWith('elevation') ? 'elevation' : id;

// items: ids from syntheticCameras plus 'plan' and 'notes'; or a variant name
// (t1 ... c1) for that variant's standard item list. occluders: { [id]: [...] }.
export function syntheticEvidence(model, { items = 't2', occluders = {}, sourceModel = 'primary', stale = [], width, height } = {}) {
  const ids = typeof items === 'string' ? VARIANTS[items].items : items;
  const cameras = syntheticCameras(model, { width, height });
  return ids.map(id => {
    const kind = KIND(id);
    if (!['photo', 'aerial', 'elevation', 'plan', 'notes'].includes(kind)) throw new Error('No synthetic evidence item ' + id);
    const camera = ['plan', 'notes'].includes(kind) ? null : cameras[id];
    if (camera === undefined) throw new Error('No synthetic camera for ' + id);
    const source = stale.includes(id) ? 'earlier' : sourceModel;
    return { id: source === 'primary' ? id : id + '@' + source, kind, file: kind + 's/' + id + '.png', captured_at: '2025-09', description: 'Synthetic ' + id,
      metric: kind === 'elevation' || kind === 'plan', source_model: source, camera, occluders: occluders[id] ?? [], sha256: '0'.repeat(64), bytes: 1 };
  });
}
