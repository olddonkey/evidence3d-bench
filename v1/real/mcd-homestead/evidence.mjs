// The photographs handed to the contestant, with the camera estimated for each
// in the truth frame and the things standing in front of the building. Files
// live under the sources root (git-ignored); `node v1/scripts/real.mjs prepare`
// makes them from the reference pack: `prepared_from` names the pack file, the
// crop that removes the screenshot chrome (centred on the viewer's centre, so
// the principal point stays in the middle of the frame) and the map labels
// that are painted over with a patch of the same image (the faint "(c) year
// provider" watermarks of the street views, the place labels of the map tile).
//
// Cameras: resected from building points identified in each photograph
// (v1/lib/real/resect.mjs; the points and the fit are in CAMERA_POINTS below and
// PROVENANCE.md). Occluders: the vehicles and street furniture that hide part
// of the building in a photograph, as boxes and cylinders in the truth frame.

import { orthoCamera } from '../../lib/raster.mjs';

// Street-level panoramas (2022-06): viewer area x 480..2560, y 0..1233 of the
// 2560 x 1233 screenshot, centre (1520, 616).
const STREET_CROP = { x: 550, y: 135, width: 1940, height: 962 };
// The panorama viewer's default view spans 90 degrees across its 2080 px width,
// so f = 1040 px and the 962 px crop spans 2·atan(481 / 1040) vertically. The
// free fit of photo-2 (the most oblique view) gives 48.75 degrees, 2 % from it.
const STREET_FOV = 2 * Math.atan(481 / 1040) * 180 / Math.PI;

export const PHOTOS = [
  {
    id: 'photo-1', kind: 'photo', file: 'photo-1.jpg', captured_at: '2022-06',
    description: 'Street-level photograph of the right side, square-on at the entrance',
    prepared_from: { file: 'streetview/front-center-2022-06.jpg', crop: STREET_CROP },
    camera: { position: [15.473, 2.372, -20.351], heading_deg: 268.87, pitch_deg: -1.08, roll_deg: 0.31, fov_y_deg: STREET_FOV, width: 1940, height: 962 },
    occluders: [{ type: 'box', center: [10.6, 0.53, -22.45], size: [4.8, 1.05, 1.85], note: 'car parked nose-in at the entrance (body below the glass roof)' }],
  },
  {
    id: 'photo-2', kind: 'photo', file: 'photo-2.jpg', captured_at: '2022-06',
    description: 'Street-level photograph of the right side from near the entrance, looking along it towards the rear',
    prepared_from: { file: 'streetview/front-east-entry-2022-06.jpg', crop: STREET_CROP, masks: [{ x: 1116, y: 883, width: 80, height: 20, from: [1116, 860] }] },
    camera: { position: [15.524, 2.107, -20.507], heading_deg: 304.33, pitch_deg: 0.62, roll_deg: 0.19, fov_y_deg: STREET_FOV, width: 1940, height: 962 },
    occluders: [{ type: 'box', center: [10.6, 0.53, -22.45], size: [4.8, 1.05, 1.85], note: 'car parked nose-in at the entrance (body below the glass roof)' }],
  },
  {
    id: 'photo-3', kind: 'photo', file: 'photo-3.jpg', captured_at: '2022-06',
    description: 'Street-level photograph from the right, looking along the rear part of the right side',
    prepared_from: { file: 'streetview/front-2022-06.jpg', crop: STREET_CROP, masks: [{ x: 1700, y: 458, width: 50, height: 20, from: [1700, 436] }] },
    camera: { position: [16.059, 2.368, -20.253], heading_deg: 360.73, pitch_deg: -0.23, roll_deg: -0.14, fov_y_deg: STREET_FOV, width: 1940, height: 962 },
    occluders: [],
  },
  {
    id: 'photo-4', kind: 'photo', file: 'photo-4.jpg', captured_at: '2022-06',
    description: 'Street-level photograph from the right, looking along the right side towards the front',
    prepared_from: { file: 'streetview/front-west-logo-2022-06.jpg', crop: STREET_CROP,
      masks: [{ x: 792, y: 758, width: 100, height: 26, from: [792, 790] }, { x: 462, y: 694, width: 46, height: 18, from: [462, 674] }] },
    camera: { position: [15.904, 2.802, -20.129], heading_deg: 219.17, pitch_deg: -2.44, roll_deg: 1.4, fov_y_deg: STREET_FOV, width: 1940, height: 962 },
    occluders: [{ type: 'box', center: [11.5, 0.74, -10.5], size: [4.85, 1.48, 1.84], note: 'saloon car parked nose-in beside the front block' },
      { type: 'box', center: [12.2, 0.95, -8.2], size: [5.1, 1.9, 2.0], note: 'large SUV parked nose-in beside the front block' }],
  },
  {
    id: 'photo-5', kind: 'photo', file: 'photo-5.jpg', captured_at: '2026-07',
    description: 'Photograph from the front-right car park, showing the right side of the taller front block',
    // Photo viewer: the 4:3 photograph fills x 698..2341, y 0..1233; the crop keeps its centre.
    prepared_from: { file: 'current-photos/google-maps-photo-current-playplace.jpg', crop: { x: 700, y: 135, width: 1640, height: 963 } },
    camera: { position: [21.076, 1.5, -7.672], heading_deg: 261.93, pitch_deg: 14.18, roll_deg: -0.37, fov_y_deg: 52.21, width: 1640, height: 963 },
    occluders: [{ type: 'box', center: [9.95, 0.86, -3.0], size: [4.45, 1.72, 1.8], note: 'SUV parked nose-in beside the front block' }],
  },
  {
    id: 'aerial', kind: 'aerial', file: 'aerial.jpg', captured_at: '2026-07',
    description: 'Near-vertical aerial image (satellite map tile); image up is not necessarily the front',
    // Map labels painted over the roof (the operator's name, the play room's name,
    // a one-way marker) are covered with the roof directly above or below them.
    prepared_from: { file: 'aerial-and-maps/google-satellite-21z.jpg', crop: { x: 1000, y: 100, width: 480, height: 1050 },
      masks: [{ x: 188, y: 484, width: 110, height: 38, from: [188, 444] }, { x: 140, y: 803, width: 96, height: 37, from: [140, 850] },
        { x: 148, y: 616, width: 16, height: 22, from: [148, 590] }] },
    // A north-up map tile: orthographic, image right = +X (east), image up = -Z
    // (north). Registered on the roof outline: east and west faces of the rear
    // part at x 343 and 113 of the crop (18.31 px/m), rear and front walls at
    // y 69 and 955 (17.89 px/m); the two scales differ by the lean of the roof
    // edges in the tile and the reading of a soft edge.
    camera: orthoCamera({ origin: [0, 100, 0], right: [1, 0, 0], up: [0, 0, -1],
      extent: [-238.8 / 18.31, (480 - 238.8) / 18.31, 955 / 17.89 - 1050 / 17.89, 955 / 17.89], width: 480, height: 1050 }),
    occluders: [],
  },
];

// Building points identified in each photograph: model point (truth frame) ->
// pixel in the prepared image. Faces: battens stand 3" proud of the wall
// (x = xE + 0.076), window frames sit 50 mm behind it.
import { ft, KEY } from './model.mjs';
const { xE, L, TOWER0, TOWER1, PILASTER0, PILASTER1, JUNCTION, H_TALL, H_MAIN, RB_EAST, LOWER_HEAD, BATTEN_PROUD } = KEY;
const XB = xE + BATTEN_PROUD, XW = xE, XF = xE - 0.05;
const pt = (name, model, image) => ({ name, model, image });
export const CAMERA_POINTS = {
  'photo-1': { fixed: ['fov_y_deg'], points: [
    pt('tower front top', [XB, H_TALL, -TOWER0], [1121, 35]), pt('tower rear top', [XB, H_TALL, -TOWER1], [1608, 32]),
    pt('tower front foot', [XB, 0, -TOWER0], [1121, 717]), pt('tower rear foot', [XB, 0, -TOWER1], [1606, 717]),
    pt('window 1 head, front', [XF, LOWER_HEAD, -ft(52, 11.5)], [550, 462]), pt('window 1 head, rear', [XF, LOWER_HEAD, -ft(62, 4)], [852, 462]),
    pt('window 1 foot, front', [XF, ft(1, 1), -ft(52, 11.5)], [550, 680]),
    pt('exit door head, front', [XW, ft(7, 9), -ft(39, 10)], [133, 465]), pt('exit door foot, rear', [XW, 0, -ft(42, 10)], [230, 713]),
  ] },
  'photo-2': { fixed: ['fov_y_deg'], points: [
    pt('tower front top', [XB, H_TALL, -TOWER0], [415, 5]), pt('tower front foot', [XB, 0, -TOWER0], [413, 745]),
    pt('tower rear top', [XB, H_TALL, -TOWER1], [884, 98]), pt('tower rear foot', [XB, 0, -TOWER1], [884, 690]),
    pt('pilaster front top', [XW, H_MAIN, -PILASTER0], [1397, 262]), pt('pilaster front foot', [XW, 0, -PILASTER0], [1397, 622]),
    pt('pilaster rear top', [XW, H_MAIN, -PILASTER1], [1483, 285]),
    pt('rear battens foot', [XB, 0, -(L - ft(3, 10))], [1737, 578]),
    pt('window 2 head, front', [XF, LOWER_HEAD, -ft(89, 4.5)], [972, 462]), pt('window 2 foot, rear', [XF, ft(1, 1), -ft(98, 10)], [1152, 643]),
  ] },
  'photo-3': { fixed: ['fov_y_deg'], points: [
    pt('pilaster front top', [XW, H_MAIN, -PILASTER0], [244, 242]), pt('pilaster front foot', [XW, 0, -PILASTER0], [244, 637]),
    pt('pilaster rear top', [XW, H_MAIN, -PILASTER1], [345, 275]), pt('pilaster rear foot', [XW, 0, -PILASTER1], [345, 615]),
    pt('reveal band at pilaster rear', [XW, RB_EAST, -PILASTER1], [345, 445]),
    pt('rear battens top', [XB, H_TALL, -(L - ft(3, 10))], [575, 331]), pt('rear battens foot', [XB, 0, -(L - ft(3, 10))], [575, 564]),
  ] },
  'photo-4': { fixed: ['fov_y_deg'], points: [
    pt('front corner battens top, front', [XB, H_TALL, BATTEN_PROUD], [730, 276]), pt('front corner battens top, rear', [XB, H_TALL, -ft(2, 11.5)], [759, 274]),
    pt('front block top, rear end', [XW, H_TALL, -JUNCTION], [1194, 149]),
    pt('upper band head, front', [XF, ft(14, 5), -ft(2, 11.5)], [761, 360]), pt('upper band head, rear', [XF, ft(14, 5), -ft(37, 2.5)], [1145, 302]),
    pt('lower band foot, rear', [XF, ft(1, 1), -ft(29, 3.5)], [1035, 615]),
    pt('exit door head, front', [XW, ft(7, 9), -ft(39, 10)], [1210, 470]), pt('exit door foot, rear', [XW, 0, -ft(42, 10)], [1272, 665]),
  ] },
  'photo-5': { fixed: ['y'], points: [
    pt('front corner battens top, front', [XB, H_TALL, BATTEN_PROUD], [492, 442]), pt('front corner battens top, rear', [XB, H_TALL, -ft(2, 11.5)], [560, 442]),
    pt('upper band head, front', [XF, ft(14, 5), -ft(2, 11.5)], [547, 547]), pt('upper band head, rear', [XF, ft(14, 5), -ft(37, 2.5)], [1192, 535]),
    pt('upper band sill, front', [XF, ft(10, 1), -ft(2, 11.5)], [547, 624]), pt('upper band sill, rear', [XF, ft(10, 1), -ft(37, 2.5)], [1192, 620]),
    pt('front block top, rear end', [XW, H_TALL, -JUNCTION], [1240, 416]),
    pt('lower band head, front', [XF, LOWER_HEAD, -ft(2, 11.5)], [542, 675]), pt('lower band foot, rear', [XF, ft(1, 1), -ft(29, 3.5)], [1060, 827]),
  ] },
};

// The survey notes (notes.md) are dated with the newest photographs.
export const NOTES_CAPTURED_AT = '2026-07';

// Words no public text of this object may contain: the operator's brand, its
// play-room brand, the street, the city and the street number.
export const FORBIDDEN = ['mcdonald', 'mcd', 'playplace', 'play place', 'homestead', 'santa clara', '3509'];

// The public object id: task packs are named after it, so it says nothing about
// the building. The model's own id ('mcd-homestead') stays in the private files.
export const OBJECT_ID = 'real-0001';
