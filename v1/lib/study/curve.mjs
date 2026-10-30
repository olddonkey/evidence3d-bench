import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJSON } from '../../../lib/io.mjs';
import { rng } from '../rng.mjs';
import { STRATA, SKIPPED_VARIANTS } from './select.mjs';
import { readVoteFiles, checkFinished } from './votes.mjs';
import { TIE_GAP, CANDIDATE_WEIGHTS, CURRENT_SCORER, NEXT_SCORER, rescorePair, latestVotes, qualifyRaters, panelOriginals, percentileInterval } from './panel.mjs';
import { LEGACY_RATER } from './page/state.js';

// The human curve (docs/V1-ROUND4-PLAN.md section 6): per band of the gap
// between two submissions' headline scores, how often the panel (the
// plurality of the qualified raters, section 5.1) picks the higher-scored one,
// cannot tell, or picks the lower-scored one, and the half-score win rate
// W = higher + ½ cannot tell. The results report looks up each task's gap in
// it for the column "panel half-score win rate of A" (report/human.mjs).
//
// - Scores are the headline at the weights of the scorer in use (null: the
//   1.1.0 score stored in key.json). An original pair whose two scores differ
//   by less than TIE_GAP has no higher side: it is in no bin, and is counted
//   apart with the panel's choices.
// - Bins: the study's four strata of the gap. From the smallest up, a stratum
//   with fewer than MIN_BIN_PAIRS pairs merges into the next one up and the
//   merged bin is checked again; then the largest, if still short, merges
//   into the one below. Fewer than two bins: no curve ("人眼数据不够").
// - Intervals: cluster bootstrap over the objects of the binned pairs
//   (CURVE_SAMPLES resamples, percentiles). One draw of the objects serves
//   every bin, so bins that share objects move together as they would in
//   another study, and the report's two-level bootstrap redraws the curve the
//   same way. A draw that leaves a bin without a pair has no value there and
//   is drawn again (counted in `bootstrap.redrawn`). A share observed at
//   exactly 0 or 1, or the same in every resample, has no interval (section 4).

export const CURVE_SCHEMA = 'e3d-human-curve-v1';
export const CURVE_FILE = 'human-curve.json';
export const MIN_BIN_PAIRS = 10;
export const MIN_PANEL = 2;
export const CURVE_SAMPLES = 10000;
export const CURVE_LEVEL = 0.95;
// What the panel concluded about a binned pair, relative to the scores.
export const OUTCOMES = ['higher', 'tie', 'lower'];
// The shares of a bin: the three outcomes and the half-score win rate.
export const SHARES = [...OUTCOMES, 'half_win'];
// A bootstrap that keeps drawing bins without a pair gives up after this many
// redraws per resample asked for.
const MAX_REDRAWS_PER_SAMPLE = 100;

const finite = value => typeof value === 'number' && Number.isFinite(value);

// The bins from the pairs per stratum (same order as `strata`): each bin is
// { strata: [ids], min, max, pairs }, contiguous from the first stratum's min
// to the last one's max.
export function mergeBins(counts, { strata = STRATA, minPairs = MIN_BIN_PAIRS } = {}) {
  if (counts.length !== strata.length) throw new Error('one count per stratum');
  const bins = strata.map((stratum, index) => ({ strata: [stratum.id], min: stratum.min, max: stratum.max, pairs: counts[index] }));
  const join = (low, high) => ({ strata: [...low.strata, ...high.strata], min: low.min, max: high.max, pairs: low.pairs + high.pairs });
  for (let i = 0; i < bins.length - 1;) {
    if (bins[i].pairs < minPairs) bins.splice(i, 2, join(bins[i], bins[i + 1]));
    else i++;
  }
  if (bins.length >= 2 && bins.at(-1).pairs < minPairs) bins.splice(-2, 2, join(bins.at(-2), bins.at(-1)));
  return bins;
}

// The bin of a gap (the last bin closed at its max); -1 outside every bin.
export function binOf(gap, bins) {
  if (!finite(gap)) return -1;
  const index = bins.findIndex(bin => gap >= bin.min && gap < bin.max);
  return index >= 0 ? index : bins.length && gap === bins.at(-1).max ? bins.length - 1 : -1;
}

// Per object, the binned pairs' outcomes: one row of bins × 3 counts
// (higher, tie, lower per bin) per object, objects by id.
export function curveClusters(pairs, binCount) {
  const rows = new Map();
  for (const pair of pairs) {
    if (!rows.has(pair.object)) rows.set(pair.object, new Float64Array(3 * binCount));
    rows.get(pair.object)[3 * pair.bin + OUTCOMES.indexOf(pair.outcome)]++;
  }
  return [...rows].sort(([p], [q]) => p.localeCompare(q)).map(([, row]) => row);
}

// The shares of bin k from a row of totals; null when the bin has no pair.
export function binShares(totals, k) {
  const higher = totals[3 * k], tie = totals[3 * k + 1], lower = totals[3 * k + 2], n = higher + tie + lower;
  return n ? { higher: higher / n, tie: tie / n, lower: lower / n, half_win: (higher + tie / 2) / n } : null;
}
export const halfWinAt = (totals, k) => {
  const n = totals[3 * k] + totals[3 * k + 1] + totals[3 * k + 2];
  return n ? (totals[3 * k] + totals[3 * k + 1] / 2) / n : null;
};

// Draws of the curve: each draw takes as many objects as there are, with
// replacement, and returns the summed rows (reused between calls), drawing
// again while a bin has no pair; null once MAX_REDRAWS_PER_SAMPLE × `samples`
// redraws are spent.
export function curveSampler(clusters, binCount, random, { samples = CURVE_SAMPLES } = {}) {
  const count = clusters.length, width = 3 * binCount, totals = new Float64Array(width), limit = MAX_REDRAWS_PER_SAMPLE * samples;
  let redrawn = 0;
  const draw = () => {
    for (;;) {
      totals.fill(0);
      for (let i = 0; i < count; i++) {
        const row = clusters[Math.floor(random.next() * count)];
        for (let j = 0; j < width; j++) totals[j] += row[j];
      }
      let empty = false;
      for (let k = 0; k < binCount && !empty; k++) empty = totals[3 * k] + totals[3 * k + 1] + totals[3 * k + 2] === 0;
      if (!empty) return totals;
      if (++redrawn > limit) return null;
    }
  };
  return { draw, redrawn: () => redrawn };
}

// A share and its percentile interval from the sorted resampled values, by
// the rule of section 4 (panel.mjs percentileInterval). No interval
// (`interval` says why) when the share is exactly 0 or 1, every resample gave
// the same value, or there were no resamples.
export function shareInterval(value, sorted, { level = CURVE_LEVEL } = {}) {
  const result = percentileInterval(value, sorted ?? [], { level, proportion: true });
  if (result.available) return { value, ci95: [result.low, result.high], interval: null };
  return { value: finite(value) ? value : null, ci95: null,
    interval: !finite(value) ? 'no_value' : value === 0 || value === 1 ? 'boundary' : !sorted?.length ? 'no_resamples' : 'constant' };
}

export const INTERVAL_REASONS = {
  boundary: 'the value is exactly 0 or 1',
  constant: 'every resample gave the same value',
  no_resamples: 'no resample had a pair in every bin',
  no_value: 'no value',
  few_objects: 'fewer than 2 objects',
  real_tier: 'fewer than 8 objects (real tier)',
};

// The scorer a weighting stands for: null (or '50/50') is 1.1.0, any other
// candidate of section 5.2 is 1.2.0.
export function curveScorer(weights) {
  if (!weights) return { version: CURRENT_SCORER, weights: null };
  const candidate = CANDIDATE_WEIGHTS.find(item => item.shape === weights.shape && item.detail === weights.detail);
  if (!candidate) throw new Error('weights must be one of the candidates of section 5.2: ' + CANDIDATE_WEIGHTS.map(item => item.id).join(', '));
  return candidate.id === CANDIDATE_WEIGHTS[0].id ? { version: CURRENT_SCORER, weights: null }
    : { version: NEXT_SCORER, weights: { id: candidate.id, shape: candidate.shape, detail: candidate.detail } };
}

// The curve from the panel's conclusions on the original pairs
// (panel.mjs panelOriginals: [{ id, object, a, b, choice }], null when fewer
// than two raters qualified).
//   weights: null for the 1.1.0 headline, else a candidate of section 5.2.
//   panel: the qualified raters; considered: every rater checked, with why
//     the others were left out ([{ rater, qualified, reasons }]).
export function humanCurve(originals, { weights = null, panel = [], considered = [], seed, samples = CURVE_SAMPLES, level = CURVE_LEVEL, strata = STRATA,
  minPairs = MIN_BIN_PAIRS, study = null } = {}) {
  if (seed === undefined || seed === null || seed === '') throw new Error('the human curve needs a seed (record it in the private record)');
  if (new Set(panel).size !== panel.length) throw new Error('the panel names a rater twice: ' + panel.join(', '));
  const scorer = curveScorer(weights);
  const base = {
    schema: CURVE_SCHEMA, study, scorer, tie_gap: TIE_GAP, min_bin_pairs: minPairs, strata: strata.map(({ id, min, max }) => ({ id, min, max })),
    skipped_variants: [...SKIPPED_VARIANTS], seed: String(seed), samples, level,
    panel: { raters: [...panel], size: panel.length, considered: considered.map(({ rater, qualified, reasons }) => ({ rater, qualified, reasons: reasons ?? [] })) },
  };
  // Section 5.1: no curve from fewer than two qualified raters, whatever pairs come with them.
  if (!originals || panel.length < MIN_PANEL) return { ...base, available: false, reason: 'panel', notes: notesOf(base, false) };

  const pairs = [], equal = [];
  for (const pair of originals) {
    if (!['a', 'tie', 'b'].includes(pair.choice)) throw new Error('pair ' + pair.id + ': the panel\'s choice must be a, tie or b, not ' + JSON.stringify(pair.choice));
    const scored = rescorePair(pair, scorer.weights, strata);
    if (!finite(scored.score_a) || !finite(scored.score_b)) throw new Error('pair ' + pair.id + ': no headline score at weights ' + (scorer.weights?.id ?? '50/50'));
    if (scored.higher === 'tie') { equal.push({ id: pair.id, object: pair.object, gap: scored.gap, choice: pair.choice }); continue; }
    if (!scored.stratum) throw new Error('pair ' + pair.id + ': gap ' + scored.gap + ' is in no stratum');
    pairs.push({ id: pair.id, object: pair.object, gap: scored.gap, stratum: scored.stratum,
      outcome: pair.choice === 'tie' ? 'tie' : pair.choice === scored.higher ? 'higher' : 'lower' });
  }
  const perStratum = strata.map(stratum => pairs.filter(pair => pair.stratum === stratum.id).length);
  const merged = mergeBins(perStratum, { strata, minPairs });
  for (const pair of pairs) pair.bin = merged.findIndex(bin => bin.strata.includes(pair.stratum));
  const equalSummary = { pairs: equal.length, panel: Object.fromEntries(['a', 'tie', 'b'].map(choice => [choice, equal.filter(item => item.choice === choice).length])), items: equal };
  const counted = { ...base, originals: originals.length, binned: pairs.length, equal: equalSummary,
    stratum_pairs: Object.fromEntries(strata.map((stratum, index) => [stratum.id, perStratum[index]])) };
  if (merged.length < 2) return { ...counted, available: false, reason: 'too_few_pairs', bins: merged, pairs, notes: notesOf(base, false) };

  const clusters = curveClusters(pairs, merged.length);
  const observed = new Float64Array(3 * merged.length);
  for (const row of clusters) row.forEach((value, j) => { observed[j] += value; });
  const sampler = curveSampler(clusters, merged.length, rng(String(seed) + '/human-curve'), { samples });
  let drawn = SHARES.map(() => merged.map(() => []));
  for (let b = 0; b < samples; b++) {
    const totals = sampler.draw();
    // Too many draws with an empty bin: no interval rests on the few that worked.
    if (!totals) { drawn = SHARES.map(() => merged.map(() => [])); break; }
    merged.forEach((_, k) => { const shares = binShares(totals, k); SHARES.forEach((share, s) => drawn[s][k].push(shares[share])); });
  }
  const bins = merged.map((bin, k) => {
    const inBin = pairs.filter(pair => pair.bin === k), shares = binShares(observed, k);
    return {
      ...bin, objects: new Set(inBin.map(pair => pair.object)).size,
      mean_gap: inBin.reduce((sum, pair) => sum + pair.gap, 0) / inBin.length,
      counts: Object.fromEntries(OUTCOMES.map((outcome, j) => [outcome, observed[3 * k + j]])),
      shares: Object.fromEntries(SHARES.map((share, s) => [share, shareInterval(shares[share], Float64Array.from(drawn[s][k]).sort(), { level })])),
    };
  });
  return { ...counted, available: true, reason: null, bins, bootstrap: { clusters: clusters.length, resamples: drawn[0][0].length, redrawn: sampler.redrawn() }, pairs,
    notes: notesOf(base, true) };
}

export const CURVE_REASONS = {
  panel: 'fewer than 2 qualified raters (section 5.1): no human curve',
  too_few_pairs: 'fewer than 2 bins of ' + MIN_BIN_PAIRS + ' pairs after merging: 人眼数据不够',
};

function notesOf(base, available) {
  const notes = [];
  if (!available) return notes;
  notes.push('Panel: ' + base.panel.size + ' qualified raters (' + base.panel.raters.join(', ') + '); each pair counts with the plurality of their choices, a tie for the most votes counting as "cannot tell".');
  if (base.panel.size === 2) notes.push('With only 2 qualified raters a pair is decided only when both agree, so "cannot tell" is more frequent than with 3.');
  notes.push('The curve comes from the study\'s submissions (the Round 3 attempts it was prepared from). Applying it to Round 4 assumes that the gap a human can see does not depend on the task set.');
  return notes;
}

// The curve written next to the study: human-curve.json and human-curve.md.
// The panel is every rater of `raters` who qualifies (panel.mjs, section 5.1).
// Like G1, the curve needs the panel named (the raters the private record
// lists once the deadlines and replacements are over), never whoever voted.
export async function writeHumanCurve(studyDir, { seed, raters, weights = null, legacyRater = LEGACY_RATER, samples = CURVE_SAMPLES } = {}) {
  if (!Array.isArray(raters) || !raters.length) throw new Error('the human curve needs the named panel (--raters): the raters the private record lists (section 5.1)');
  const twice = raters.filter((rater, index) => raters.indexOf(rater) !== index);
  if (twice.length) throw new Error('--raters names ' + [...new Set(twice)].join(', ') + ' more than once: each rater counts once in the panel');
  // Like every reader of the study: not while an add-catch is unfinished (key.json and pairs.json may not belong together).
  await checkFinished(studyDir);
  const key = JSON.parse(await readFile(join(studyDir, 'key.json'), 'utf8'));
  const read = await readVoteFiles(studyDir, { legacyRater });
  const latest = latestVotes(key, read.votes);
  const asked = [...raters];
  const missing = asked.filter(rater => !latest.has(rater));
  if (missing.length) throw new Error('no votes for rater' + (missing.length === 1 ? ' ' : 's ') + missing.join(', ') + ' in ' + studyDir);
  const considered = qualifyRaters(key, asked, latest);
  const panel = considered.filter(item => item.qualified).map(item => item.rater);
  const curve = humanCurve(panelOriginals(key, latest, panel), { weights, panel, considered, seed, samples,
    study: { name: key.name, batches: key.batches ?? [], prepared_at: key.created_at ?? null, votes_files: read.files.map(file => file.file) } });
  await writeJSON(join(studyDir, CURVE_FILE), curve);
  await writeFile(join(studyDir, 'human-curve.md'), curveMarkdown(curve));
  return { curve, files: [join(studyDir, CURVE_FILE), join(studyDir, 'human-curve.md')] };
}

const pct = value => finite(value) ? (100 * value).toFixed(1) + '%' : 'n/a';
export const shareWords = share => pct(share.value) + (share.ci95 ? ' [' + pct(share.ci95[0]) + ', ' + pct(share.ci95[1]) + ']' : share.interval ? ' (no interval: ' + INTERVAL_REASONS[share.interval] + ')' : '');

// The bins as `[min, max)`, the last one closed.
export const binRange = (bin, last) => '[' + bin.min + ', ' + bin.max + (last ? ']' : ')');

// The pairs with equal scores, which are in no bin, and the panel on them.
export const equalWords = curve => 'Pairs with equal scores (gap < ' + curve.tie_gap + '), in no bin: ' + curve.equal.pairs +
  (curve.equal.pairs ? ' (panel: A ' + curve.equal.panel.a + ', cannot tell ' + curve.equal.panel.tie + ', B ' + curve.equal.panel.b + ')' : '') + '.';

export function curveMarkdown(curve) {
  const lines = ['# Human curve' + (curve.study?.name ? ': ' + curve.study.name : ''), ''];
  lines.push('Scorer ' + curve.scorer.version + (curve.scorer.weights ? ' (shape ' + curve.scorer.weights.shape + ' / detail ' + curve.scorer.weights.detail + ')' : '') +
    '; panel of ' + curve.panel.size + (curve.panel.size ? ' (' + curve.panel.raters.join(', ') + ')' : '') + '; seed `' + curve.seed + '`, ' + curve.samples + ' resamples.', '');
  const left = curve.panel.considered.filter(item => !item.qualified);
  if (left.length) lines.push('Not on the panel: ' + left.map(item => item.rater + (item.reasons.length ? ' (' + item.reasons.join('; ') + ')' : '')).join(', ') + '.', '');
  if (!curve.available) {
    lines.push('**No curve**: ' + CURVE_REASONS[curve.reason] + '.', '');
    if (curve.stratum_pairs) lines.push('Pairs per stratum (score gap ≥ ' + curve.tie_gap + '): ' + Object.entries(curve.stratum_pairs).map(([id, n]) => id + ': ' + n).join(', ') + '.', '');
    if (curve.equal) lines.push(equalWords(curve), '');
    return lines.join('\n');
  }
  lines.push('| gap | strata | pairs | objects | mean gap | higher | cannot tell | lower | half-score win rate W |', '|---|---|---|---|---|---|---|---|---|');
  curve.bins.forEach((bin, k) => lines.push('| ' + binRange(bin, k === curve.bins.length - 1) + ' | ' + bin.strata.join(' + ') + ' | ' + bin.pairs + ' | ' + bin.objects + ' | ' +
    bin.mean_gap.toFixed(1) + ' | ' + SHARES.map(share => shareWords(bin.shares[share])).join(' | ') + ' |'));
  lines.push('');
  lines.push('Shares of the panel\'s conclusions per bin of the headline gap, with 95% cluster bootstrap intervals over ' + curve.bootstrap.clusters + ' objects (' +
    curve.bootstrap.resamples + ' resamples' + (curve.bootstrap.redrawn ? ', ' + curve.bootstrap.redrawn + ' draws with an empty bin drawn again' : '') + '). W = higher + ½ cannot tell.', '');
  lines.push(equalWords(curve), '');
  lines.push(...curve.notes.map(note => '- ' + note), '');
  return lines.join('\n');
}
