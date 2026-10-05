// The photographs handed to the contestant, with the camera estimated for each in
// the truth frame and the things standing in front of the building. Files live
// under the sources root (git-ignored); `node v1/scripts/real.mjs prepare` makes
// them from the reference pack: `prepared_from` names the pack file and the crop
// (the plaza foreground with its inscribed benches is cut off; the cameras below
// carry the matching principal point).
//
// Epoch. The evidence is the building as it stands now: four photographs of the
// front taken from the plaza in 2013-01 and 2025-04, and a current aerial map
// tile. The survey drawings the truth is read from date from 1995; the 1995
// survey photographs in the pack are not used (see PROVENANCE.md, "Epoch").
//
// Cameras: resected from building points identified in each photograph (scratch
// tool, Levenberg-Marquardt on the reprojection error like v1/lib/real/resect.mjs,
// with the principal point free where the photograph was taken with a shifted
// lens); the points and the fit are in CAMERA_POINTS and PROVENANCE.md. Occluders:
// the fountain and the trees between the plaza and the front, as cylinders and
// ellipsoids in the truth frame (from the aerial and the photographs, a few metres).
import { orthoCamera } from '../../lib/raster.mjs';
import { cameraFromPose } from '../../lib/real/resect.mjs';

// A pose resected on the full frame, re-expressed for a crop of it: the image
// keeps its focal length and the principal point moves with the crop.
function cropped(pose, { x = 0, y = 0, width, height }, principal = {}) {
  const c = cameraFromPose(pose);
  return { ...c, cx: (principal.cx ?? c.cx) - x, cy: (principal.cy ?? c.cy) - y, width, height };
}

// Things in front of the building (metres, truth frame). The fountain stands on
// the front's centre line 25 m out (aerial); tree crowns as ellipsoids.
const FOUNTAIN = [
  { type: 'cylinder', base: [0.8, 0, 25.0], radius: 3.8, height: 0.6, note: 'fountain basin' },
  { type: 'cylinder', base: [0.8, 0, 25.0], radius: 2.3, height: 1.6, note: 'fountain bowl on its pedestal' },
];
const TREE_SW = [{ type: 'ellipsoid', center: [11.0, 8.5, 19.7], radii: [7, 5.5, 7], note: 'deciduous tree south-west of the fountain (in leaf)' },
  { type: 'cylinder', base: [11.9, 0, 19.7], radius: 0.45, height: 4, note: 'its trunk' }];
const TREE_SW_BARE = [{ type: 'cylinder', base: [11.9, 0, 19.7], radius: 0.45, height: 9, note: 'deciduous tree south-west of the fountain, bare in January (trunk only; the building shows through the branches)' }];
const TREE_S = [{ type: 'ellipsoid', center: [9.0, 7.5, 30.0], radii: [6, 5, 6], note: 'tree at the south edge of the plaza' }];
const TREE_NW = [{ type: 'ellipsoid', center: [-22.0, 5.5, 14.7], radii: [6, 4.5, 6], note: 'tree in front of the left colonnade end' }];
const OAK_2013 = [{ type: 'ellipsoid', center: [-11.3, 7.2, 14.9], radii: [9.3, 6.9, 7], note: 'evergreen tree in front of the left wing (2013; gone by 2025), from its outline in the photograph at 40 m' },
  { type: 'cylinder', base: [-12.0, 0, 14.9], radius: 0.6, height: 4, note: 'its trunk' }];

export const PHOTOS = [
  {
    id: 'photo-1', kind: 'photo', file: 'photo-1.jpg', captured_at: '2013-01',
    description: 'Photograph of the front from the far side of the plaza in front of it (winter; lens shifted to keep verticals parallel)',
    prepared_from: { file: 'visual-references/bing-wing-overview.jpg', crop: { x: 0, y: 0, width: 1280, height: 700 } },
    // Shift lens: level camera (pitch 0, verticals parallel in the image), principal point fitted (cy 600 of 853).
    camera: cropped({ position: [0.378, 1.6, 54.892], heading_deg: -0.13, pitch_deg: 0, roll_deg: -0.32, fov_y_deg: 38.61, width: 1280, height: 853 },
      { width: 1280, height: 700 }, { cy: 600.0 }),
    occluders: [...FOUNTAIN, ...OAK_2013, ...TREE_SW_BARE],
  },
  {
    id: 'photo-2', kind: 'photo', file: 'photo-2.jpg', captured_at: '2025-04',
    description: 'Wide-angle photograph of the front from the far side of the plaza',
    prepared_from: { file: 'visual-references/bing-wing-facade-01.jpg', crop: { x: 0, y: 0, width: 1280, height: 640 } },
    camera: cropped({ position: [-0.142, 1.5, 42.222], heading_deg: -1.86, pitch_deg: 4.32, roll_deg: 0.38, fov_y_deg: 82.02, width: 1280, height: 960 },
      { width: 1280, height: 640 }),
    occluders: [...FOUNTAIN, ...TREE_SW, ...TREE_S, ...TREE_NW],
  },
  {
    id: 'photo-3', kind: 'photo', file: 'photo-3.jpg', captured_at: '2025-04',
    description: 'Photograph of the front from the plaza, past the fountain',
    prepared_from: { file: 'visual-references/bing-wing-facade-02.jpg', crop: { x: 0, y: 0, width: 1280, height: 960 } },
    camera: cropped({ position: [1.72, 1.5, 47.467], heading_deg: -8.77, pitch_deg: 6.65, roll_deg: 0.21, fov_y_deg: 49.38, width: 1280, height: 960 },
      { width: 1280, height: 960 }),
    occluders: [...FOUNTAIN, ...TREE_SW, ...TREE_S, ...TREE_NW],
  },
  {
    id: 'photo-4', kind: 'photo', file: 'photo-4.jpg', captured_at: '2025-04',
    description: 'Photograph from beside the fountain, looking at the left part of the front at an angle',
    prepared_from: { file: 'visual-references/bing-wing-facade-03.jpg', crop: { x: 0, y: 0, width: 1280, height: 1707 } },
    camera: cropped({ position: [2.228, 1.5, 30.892], heading_deg: -42.68, pitch_deg: -0.19, roll_deg: -2.61, fov_y_deg: 75.48, width: 1280, height: 1707 },
      { width: 1280, height: 1707 }),
    // The camera stands 7-8 m from the fountain, whose bowl fills the lower half of the frame: its
    // occluder is placed where this photograph puts it (camera + 7.6 m along the view, bowl top 1.0 m
    // from the rim's image row), 3.7 m from where the aerial puts it - the camera's own error this close.
    occluders: [{ type: 'cylinder', base: [-2.9, 0, 25.3], radius: 3.8, height: 0.5, note: 'fountain basin' },
      { type: 'cylinder', base: [-2.9, 0, 25.3], radius: 2.3, height: 1.0, note: 'fountain bowl' }, ...TREE_NW],
  },
  {
    id: 'aerial', kind: 'aerial', file: 'aerial.jpg', captured_at: '2026-08',
    description: 'Aerial image (map tile, north up; image up is not the front). The tile is drawn in latitude and longitude, so its pixels are not square: a metre east-west spans 1.37 times as many pixels as a metre north-south.',
    prepared_from: { file: 'aerial-and-maps/esri-site.jpg', crop: { x: 600, y: 470, width: 380, height: 330 } },
    // EPSG:4326 export of 0.0055 deg lon x 0.0045 deg lat at 1800 x 1350 px (the pack's
    // build script), at latitude 37.427: 3.701 px/m east-west, 2.704 px/m north-south.
    // Treated as orthographic; true east and north in the truth frame and the offset
    // fitted on nine roof points (eave corners, ridge ends, lantern), rms 2.6 px.
    camera: orthoCamera({ origin: [0, 100, 0], right: [-0.27664, 0, -0.96097], up: [-0.96097, 0, 0.27664],
      extent: [-18.297, 84.373, -76.341, 45.7], width: 380, height: 330 }),
    occluders: [],
  },
];

// Building points identified in each photograph (feet, truth frame -> pixel in
// the full pack image, before the crop). Eave corners are at the tile edge (the
// roof surface at the eave), ridge ends at the top of the ridge cap.
export const CAMERA_POINTS = {
  'photo-1': { free: 'position (height held at 1.6 m), heading, roll, field of view, principal point row; pitch held at 0', rms_px: 3.4, points: [
    ['central block eave, left corner', [-50.85, 66.45, 4.68], [281, 171]], ['ridge, left end', [-20.2, 83.75, -26.4], [515.8, 137.5]],
    ['ridge, right end', [20.2, 83.75, -26.4], [760.8, 137.5]], ['attic opening 1, top left', [-38.6, 60.8, 0], [380, 225]],
    ['attic opening 1, bottom right', [-18.7, 54.2, 0], [510, 268.75]], ['attic opening 3, top right', [38.6, 60.8, 0], [895, 225]]] },
  'photo-2': { free: 'position (height held at 1.5 m), heading, pitch, roll, field of view', rms_px: 2.6, points: [
    ['central block eave, left corner', [-50.85, 66.45, 4.68], [452.7, 279.3]], ['ridge, left end', [-20.2, 83.75, -26.4], [590, 265.7]],
    ['attic opening 1, top left', [-38.6, 60.8, 0], [510, 305]], ['attic opening 1, top right', [-18.7, 60.8, 0], [586.7, 305]],
    ['attic opening 2, top left', [-9.9, 60.8, 0], [621.7, 305]], ['attic opening 2, top right', [9.9, 60.8, 0], [696.7, 305]],
    ['attic opening 1, bottom left', [-38.6, 54.2, 0], [510, 335]], ['left wing eave, outer corner', [-94.7, 49.5, -15.5], [331.7, 367.3]],
    ['left wing outer window, crown', [-75.6, 43.6, -19], [405, 391.7]], ['left wing inner window, crown', [-60.0, 43.6, -19], [452.7, 391.7]]] },
  'photo-3': { free: 'position (height held at 1.5 m), heading, pitch, roll, field of view', rms_px: 7.0, points: [
    ['central block eave, left corner', [-50.85, 66.45, 4.68], [422.5, 204]], ['ridge, left end', [-20.2, 83.75, -26.4], [645, 160]],
    ['ridge, right end', [20.2, 83.75, -26.4], [875, 160]], ['attic opening 1, top left', [-38.6, 60.8, 0], [515, 245]],
    ['attic opening 1, bottom right', [-18.7, 54.2, 0], [637.5, 290]], ['attic opening 2, top left', [-9.9, 60.8, 0], [695, 232.5]],
    ['attic opening 2, bottom right', [9.9, 54.2, 0], [825, 280]], ['left wing eave, outer corner', [-94.7, 49.5, -15.5], [234, 355]],
    ['left wing outer window, crown', [-75.6, 43.6, -19], [351, 387.5]], ['left wing inner window, crown', [-60.0, 43.6, -19], [427.5, 387.5]]] },
  'photo-4': { free: 'position (height held at 1.5 m), heading, pitch, roll, field of view', rms_px: 8.6, points: [
    ['central block eave, left corner', [-50.85, 66.45, 4.68], [885, 252]], ['left wing inner window, crown', [-60.0, 43.6, -19], [910, 545]],
    ['left wing outer window, crown', [-75.6, 43.6, -19], [820, 562]], ['attic opening 1, top left', [-38.6, 60.8, 0], [1036, 277]],
    ['attic opening 1, top right', [-18.7, 60.8, 0], [1265, 213]], ['attic opening 1, bottom left', [-38.6, 54.2, 0], [1037, 345]],
    ['left colonnade eave at the corner pier', [-49.2, 16.8, -4.0], [927.5, 750]]] },
};

// The survey notes (notes.md) are dated with the newest photographs.
export const NOTES_CAPTURED_AT = '2025-04';

// Words no public text of this object may contain: the building's names, the
// university, the town and the streets, the architects and builders, the survey
// that drew it, the donors' names the rooms carry, and the landmark tower that
// stands beside it in the photographs.
export const FORBIDDEN = ['green library', 'cecil', 'bing', 'stanford', 'palo alto', 'lasuen', 'escondido', 'bakewell', 'arthur brown',
  'habs', 'historic american buildings', 'ca-2613', 'loma prieta', 'hoover', 'shainwald', 'bender room', 'field room', 'rumsey', 'library'];

// The public object id: task packs are named after it, so it says nothing about
// the building. The model's own id ('green-library') stays in the private files.
export const OBJECT_ID = 'real-0002';
