import { scoreSoup } from './index.mjs';
import { mutations } from './mutations.mjs';
import { FACADE_NORMALS } from './detail.mjs';

// Runs every mutation against the context's own ground truth and checks it
// against what DESIGN.md section 10 says the scorer must do with it. Rows are
// flat: { id, expectation, ok, score, detail, frame_error, ... }.
export const SCALE_STEPS = [1.05, 1.1, 1.2];

function summary(report) {
  const at2 = report.global?.thresholds?.find(row => row.fraction === 0.02);
  return {
    valid: report.valid, error: report.error, score: report.score, shape: report.shape_score ?? null, detail: report.detail?.score ?? null,
    precision: at2?.precision ?? null, recall: at2?.recall ?? null, strict_f: report.strict?.f ?? null,
    shape_f: report.shape?.f ?? null, shape_scale: report.shape?.scale ?? null, scale: report.alignment?.scale ?? null,
    frame_error: report.alignment?.frame_error ?? null, delta_e: report.appearance?.delta_e_mean ?? null,
    groups: Object.fromEntries((report.detail?.groups ?? []).map(group => [group.id, group.f])),
    probe_mean_error_m: report.probe_summary?.mean_error_m ?? null, timing_ms: report.timing_ms,
  };
}

// True when every item that gives coverage looks at the object from the front.
function frontOnly(context) {
  return context.maps.length > 0 && context.maps.every(map => map.camera.forward[2] < -0.5);
}

export function calibrate(context) {
  const base = context.soup, rows = [];
  const run = mutation => summary(scoreSoup({ candidate: mutation.apply(base, context), context }));
  const identity = run(mutations.identity());
  const delta = row => row.score - identity.score, deltaShape = row => row.shape - identity.shape;
  const add = (id, row, expectation, ok) => { rows.push({ id, expectation, ok: Boolean(ok && row.valid), ...row }); return row; };
  add('identity', identity, 'the truth scores >= 98', identity.score >= 98);

  for (const [mutation, label] of [[mutations.retessellate(2), 'retessellate(2)'], [mutations.rename(), 'rename'], [mutations.recolor(), 'recolor']]) {
    const row = run(mutation);
    const colourOk = label !== 'recolor' || (row.delta_e ?? 0) > (identity.delta_e ?? 0) + 5;
    add(label, row, 'geometry score unchanged (|delta| <= 0.5)' + (label === 'recolor' ? ', colour difference rises' : ''), Math.abs(delta(row)) <= 0.5 && colourOk);
  }

  const offset = [0.21, 0.03, -0.14].map(value => value * context.diagonal);
  const shifted = run(mutations.shift(offset));
  add('shift', shifted, 'score unchanged (|delta| <= 1), offset reported in frame_error',
    Math.abs(delta(shifted)) <= 1 && Math.abs(shifted.frame_error.offset_m - Math.hypot(...offset)) <= 0.01 * context.diagonal);
  for (const degrees of [37, 180, -150]) {
    const row = run(mutations.yaw(degrees));
    const reported = row.frame_error?.yaw_deg ?? NaN, error = Math.abs(((reported + degrees) % 360 + 540) % 360 - 180);
    add('yaw(' + degrees + ')', row, 'score unchanged (|delta| <= 1), yaw reported in frame_error', Math.abs(delta(row)) <= 1 && error <= 1);
  }

  let previous = identity;
  for (const factor of SCALE_STEPS) {
    const row = run(mutations.scale(factor));
    if (context.scaleEvidence === 'metric') {
      // DESIGN.md asks for a monotonic fall; how far 5 % falls depends on how
      // much of the object lies further than tau from its centre (see README).
      add('scale(' + factor + ')', row, 'metric task: score falls with every step (' + previous.score + ' before), shape names the scale', row.score < previous.score &&
        Math.abs(Math.log(row.shape_scale * factor)) <= 0.02);
    } else {
      add('scale(' + factor + ')', row, 'scale-free task: score unchanged (|delta| <= 1), scale fitted to 1/k',
        Math.abs(delta(row)) <= 1 && Math.abs(Math.log(row.scale * factor)) <= 0.02);
    }
    previous = row;
  }

  // A mirror image differs from the truth only where the object is asymmetric
  // and the evidence shows that asymmetry: no fixed drop can be demanded.
  const mirrored = run(mutations.mirrorX());
  add('mirrorX', mirrored, 'no gain over the truth; the drop is the evidenced asymmetry (score ' + (delta(mirrored) >= 0 ? '+' : '') + delta(mirrored).toFixed(2) + ', detail ' +
    ((mirrored.detail ?? 0) - (identity.detail ?? 0)).toFixed(2) + ')', mirrored.score <= identity.score + 0.1);

  const scoredGroups = context.groups.filter(group => group.scored).map(group => group.id);
  for (const group of context.groups) {
    const row = run(mutations.dropGroup(group.id));
    if (!group.scored) { add('dropGroup(' + group.id + ')', row, 'group not scored on this evidence (' + group.reason + '): no expectation', true); continue; }
    const others = scoredGroups.filter(id => id !== group.id);
    const drift = Math.max(0, ...others.map(id => Math.abs((row.groups[id] ?? 0) - (identity.groups[id] ?? 0))));
    add('dropGroup(' + group.id + ')', row, 'that group F <= 0.15, other groups move <= 0.05 (max drift ' + drift.toFixed(3) + ')', row.groups[group.id] <= 0.15 && drift <= 0.05);
  }

  for (const group of context.groups) {
    const normal = FACADE_NORMALS[group.facade] ?? (group.facade === 'roof' ? [0, 1, 0] : null);
    if (!normal || !group.scored) continue;
    const axis = normal.findIndex(value => value !== 0), relief = group.box.max[axis] - group.box.min[axis];
    const row = run(mutations.flattenGroup(group.id));
    const small = relief <= 0.02 * context.diagonal;
    const groupDrop = (identity.groups[group.id] ?? 0) - (row.groups[group.id] ?? 0);
    add('flattenGroup(' + group.id + ')', row, (small ? 'small relief (' + relief.toFixed(2) + ' m): shape score within 2, ' : 'relief ' + relief.toFixed(2) + ' m: ') + 'group F down >= 0.1',
      groupDrop >= 0.1 && (!small || Math.abs(row.shape - identity.shape) <= 2));
  }

  const box = run(mutations.massingBox());
  // A box IS most of a slab tower's surface, so shape alone cannot be asked to
  // reject it; the headline, which is half detail, must.
  add('massingBox', box, 'clearly below the truth (score down >= 35) and detail <= 30', delta(box) <= -35 && (box.detail ?? 0) <= 30);

  const shell = run(mutations.frontShell());
  if (frontOnly(context)) add('frontShell', shell, 'front-only evidence: the unseen rear is not punished (|delta| <= 2)', Math.abs(delta(shell)) <= 2);
  else add('frontShell', shell, 'all-round evidence: the missing rear is punished (shape down >= 10)', deltaShape(shell) <= -10);

  const ground = run(mutations.addGroundPlane());
  add('addGroundPlane', ground, 'junk is punished through precision (shape down >= 5)', deltaShape(ground) <= -5 && ground.precision < identity.precision);
  const duplicate = run(mutations.addDuplicate());
  add('addDuplicate', duplicate, 'a second copy beside the model is punished (shape down >= 15)', deltaShape(duplicate) <= -15);
  const interior = run(mutations.addInterior());
  add('addInterior', interior, 'hidden interior geometry changes nothing (|delta| <= 0.5)', Math.abs(delta(interior)) <= 0.5);
  return rows;
}
