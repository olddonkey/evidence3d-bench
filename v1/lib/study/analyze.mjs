import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJSON } from '../../../lib/io.mjs';
import { readVoteFiles } from './votes.mjs';
import { LEGACY_RATER } from './page/state.js';

// Joins the votes of every rater with key.json. Per rater: how often the rater
// picks the submission the score ranks higher, overall and per gap stratum,
// for the headline score and for its two halves; ties; self-consistency on the
// repeated pairs; and the largest disagreements to inspect. Between raters:
// agreement of every two raters (share of the same choice and Cohen's kappa),
// Fleiss' kappa when there are three raters or more, and how often the
// majority of the raters picks the higher-scored submission. Counts,
// proportions, Wilson intervals and kappas only.
//
// The last vote per rater and pair wins (a revision is a new line). Agreement
// is counted on the original pairs; a repeat is the same two submissions shown
// again with the sides swapped, used only for self-consistency, so no pair
// counts twice. Votes without a rater are the legacy rater's (r0 by default;
// see votes.mjs).

export const ANALYSIS_SCHEMA = 'e3d-study-analysis-v2';
export const Z95 = 1.959963984540054;
// The choices as every rater saw them (the sides are the same for everyone).
export const CATEGORIES = ['a', 'tie', 'b'];
const MEASURES = [
  { id: 'score', field: 'higher', title: 'headline score' },
  { id: 'shape_score', field: 'higher_shape', title: 'shape_score alone' },
  { id: 'detail_score', field: 'higher_detail', title: 'detail.score alone' },
];

// Wilson score interval for k successes in n trials.
export function wilson(k, n, z = Z95) {
  if (!(n > 0)) return { k, n, p: null, low: null, high: null };
  const p = k / n, z2 = z * z, denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denominator;
  return { k, n, p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

const median = values => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Agreement of the rater with one measure over a list of rated pairs.
function agreement(rated, field) {
  const decided = rated.filter(item => item.choice !== 'tie');
  const comparable = decided.filter(item => item.pair[field] === 'a' || item.pair[field] === 'b');
  const k = comparable.filter(item => item.choice === item.pair[field]).length;
  return { ...wilson(k, comparable.length), no_higher_side: decided.length - comparable.length };
}

// Cohen's kappa for two raters over the same items, from [first, second]
// choice pairs: (observed - chance) / (1 - chance), chance from each rater's
// own shares of the categories. null when chance is 1 (both raters used one
// and the same category throughout) or there are no items.
export function cohenKappa(choicePairs, categories = CATEGORIES) {
  const n = choicePairs.length;
  if (!n) return { n: 0, same: 0, observed: null, chance: null, kappa: null };
  const first = new Map(categories.map(category => [category, 0])), second = new Map(first);
  let same = 0;
  for (const [p, q] of choicePairs) {
    if (!first.has(p) || !second.has(q)) throw new Error('unknown category ' + JSON.stringify(first.has(p) ? q : p));
    first.set(p, first.get(p) + 1);
    second.set(q, second.get(q) + 1);
    if (p === q) same++;
  }
  const observed = same / n;
  const chance = categories.reduce((sum, category) => sum + (first.get(category) / n) * (second.get(category) / n), 0);
  return { n, same, observed, chance, kappa: chance < 1 ? (observed - chance) / (1 - chance) : null };
}

// Fleiss' kappa: `counts` has one row per item with the number of raters who
// chose each category; every row sums to the same number of raters (two or
// more). Observed agreement is the mean share of agreeing rater pairs per item,
// chance the sum of the squared overall category shares.
export function fleissKappa(counts) {
  const items = counts.length;
  if (!items) return { items: 0, raters_per_item: null, observed: null, chance: null, shares: null, kappa: null };
  const sum = row => row.reduce((total, value) => total + value, 0);
  const m = sum(counts[0]), width = counts[0].length;
  if (!(m >= 2) || counts.some(row => row.length !== width || sum(row) !== m)) throw new Error('Fleiss kappa needs the same number of ratings, two or more, for every item');
  const totals = new Array(width).fill(0);
  let agreeing = 0;
  for (const row of counts) {
    row.forEach((count, j) => { totals[j] += count; });
    agreeing += (row.reduce((total, count) => total + count * count, 0) - m) / (m * (m - 1));
  }
  const observed = agreeing / items, shares = totals.map(total => total / (items * m));
  const chance = shares.reduce((total, share) => total + share * share, 0);
  return { items, raters_per_item: m, observed, chance, shares, kappa: chance < 1 ? (observed - chance) / (1 - chance) : null };
}

// One rater's analysis from their votes (in the order cast). Returns the
// analysis and the rater's last vote per pair.
function raterAnalysis(key, byId, strata, rater, votes) {
  const known = votes.filter(vote => byId.has(vote.pair));
  const latest = new Map();
  for (const vote of known) latest.set(vote.pair, vote);
  const rated = [...latest.values()].map(vote => ({ pair: byId.get(vote.pair), choice: vote.choice, ms: vote.ms, hidden_ms: vote.hidden_ms ?? null }));
  const originals = rated.filter(item => !item.pair.repeat_of);

  const votesSummary = {
    lines: votes.length, unknown_pair_lines: votes.length - known.length,
    revisions: known.length - latest.size, pairs_total: key.pairs.length, pairs_rated: latest.size, pairs_unrated: key.pairs.length - latest.size,
    originals_total: key.pairs.filter(pair => !pair.repeat_of).length, originals_rated: originals.length,
    ties: originals.filter(item => item.choice === 'tie').length,
    median_ms: median(rated.map(item => item.ms).filter(Number.isFinite)),
    median_visible_ms: median(rated.filter(item => Number.isFinite(item.ms)).map(item => item.ms - (Number.isFinite(item.hidden_ms) ? item.hidden_ms : 0))),
  };

  const agreementByMeasure = MEASURES.map(measure => ({
    measure: measure.id, title: measure.title,
    overall: agreement(originals, measure.field),
    strata: strata.map(id => ({ stratum: id, ...agreement(originals.filter(item => item.pair.stratum === id), measure.field) })),
  }));

  // The "detectable by a human" curve: P(rater picks the higher-scored) against |Δ|.
  const curve = strata.map(id => {
    const inStratum = originals.filter(item => item.pair.stratum === id);
    const definition = (key.strata ?? []).find(item => item.id === id) ?? null;
    const ties = inStratum.filter(item => item.choice === 'tie').length;
    return {
      stratum: id, min: definition?.min ?? null, max: definition?.max ?? null,
      pairs: key.pairs.filter(pair => pair.stratum === id && !pair.repeat_of).length, rated: inStratum.length,
      mean_gap: inStratum.length ? inStratum.reduce((sum, item) => sum + item.pair.gap, 0) / inStratum.length : null,
      ties, tie_rate: wilson(ties, inStratum.length),
      agreement: agreement(inStratum, 'higher'),
    };
  });

  // Side habit: among decided original pairs, how often A was chosen. The
  // selection puts the higher-scored submission on A in half the pairs of each
  // stratum, so a side habit cannot pass for agreement; this shows whether there is one.
  const decided = originals.filter(item => item.choice !== 'tie');
  const sidePreference = wilson(decided.filter(item => item.choice === 'a').length, decided.length);

  // Self-consistency: the repeat shows the same two submissions with the
  // sides swapped, so choosing A once and B the other time is the same choice.
  const consistency = { repeats: key.pairs.filter(pair => pair.repeat_of).length, both_rated: 0, same: 0, opposite: 0, both_tie: 0, one_tie: 0, items: [] };
  for (const repeat of key.pairs.filter(pair => pair.repeat_of)) {
    const first = latest.get(repeat.repeat_of), second = latest.get(repeat.id);
    if (!first || !second) continue;
    consistency.both_rated++;
    const swapped = { a: 'b', b: 'a', tie: 'tie' }[second.choice];
    let outcome;
    if (first.choice === 'tie' && second.choice === 'tie') outcome = 'both_tie';
    else if (first.choice === 'tie' || second.choice === 'tie') outcome = 'one_tie';
    else outcome = first.choice === swapped ? 'same' : 'opposite';
    consistency[outcome]++;
    consistency.items.push({ original: repeat.repeat_of, repeat: repeat.id, original_choice: first.choice, repeat_choice: second.choice, outcome });
  }
  consistency.same_share_of_decided = wilson(consistency.same, consistency.same + consistency.opposite);
  consistency.exact_share = wilson(consistency.same + consistency.both_tie, consistency.both_rated);

  // The largest disagreements: the rater chose the lower-scored side, biggest |Δ| first.
  const disagreements = originals
    .filter(item => item.choice !== 'tie' && (item.pair.higher === 'a' || item.pair.higher === 'b') && item.choice !== item.pair.higher)
    .sort((p, q) => q.pair.gap - p.pair.gap || p.pair.id.localeCompare(q.pair.id))
    .slice(0, 10)
    .map(({ pair, choice }) => ({
      pair: pair.id, stratum: pair.stratum, gap: pair.gap, delta_a_minus_b: pair.a.score - pair.b.score, choice,
      score_a: pair.a.score, score_b: pair.b.score, shape_a: pair.a.shape_score, shape_b: pair.b.shape_score, detail_a: pair.a.detail_score, detail_b: pair.b.detail_score,
      task: pair.task_id, title: pair.title, variant: pair.variant, a: pair.a.dir, b: pair.b.dir, images: pair.images,
    }));

  return {
    analysis: { rater, votes: votesSummary, agreement: agreementByMeasure, curve, side_preference_a: sidePreference, self_consistency: consistency, largest_disagreements: disagreements },
    latest,
  };
}

// Between raters, on the original pairs: every two raters (the pairs both
// rated; the same choice among a / tie / b, Cohen's kappa, and the same side
// among pairs both decided), Fleiss' kappa over all raters on the pairs every
// one of them rated (three raters or more), and the majority vote.
function betweenRaters(key, strata, raters, latestByRater) {
  const originals = key.pairs.filter(pair => !pair.repeat_of);
  const choiceOf = (rater, pair) => latestByRater.get(rater).get(pair.id)?.choice;

  const pairwise = [];
  for (let i = 0; i < raters.length; i++) {
    for (let j = i + 1; j < raters.length; j++) {
      const both = originals.map(pair => [choiceOf(raters[i], pair), choiceOf(raters[j], pair)]).filter(([p, q]) => p && q);
      const kappa = cohenKappa(both);
      const decided = both.filter(([p, q]) => p !== 'tie' && q !== 'tie');
      pairwise.push({ raters: [raters[i], raters[j]], both_rated: both.length, same_choice: wilson(kappa.same, both.length),
        cohen_kappa: kappa.kappa, chance_agreement: kappa.chance, both_decided_same_side: wilson(decided.filter(([p, q]) => p === q).length, decided.length) });
    }
  }

  let fleiss = null;
  if (raters.length >= 3) {
    const common = originals.filter(pair => raters.every(rater => choiceOf(rater, pair)));
    const counts = common.map(pair => CATEGORIES.map(category => raters.filter(rater => choiceOf(rater, pair) === category).length));
    const result = fleissKappa(counts);
    fleiss = { raters: raters.slice(), pairs: result.items, observed: result.observed, chance: result.chance,
      shares: result.shares && Object.fromEntries(CATEGORIES.map((category, index) => [category, result.shares[index]])), kappa: result.kappa };
  }

  // The majority vote of a pair: the choice of more than half of the raters
  // who rated it, among pairs rated by two raters or more. A majority for
  // "cannot tell" is a tie; no majority (e.g. A, B, cannot tell) is left out.
  const items = [], ratersPerPair = {};
  let noMajority = 0;
  for (const pair of originals) {
    const choices = raters.map(rater => choiceOf(rater, pair)).filter(Boolean);
    if (choices.length < 2) continue;
    ratersPerPair[choices.length] = (ratersPerPair[choices.length] ?? 0) + 1;
    const winner = CATEGORIES.find(category => 2 * choices.filter(choice => choice === category).length > choices.length);
    if (winner) items.push({ pair, choice: winner }); else noMajority++;
  }
  const majority = {
    pairs: items.length + noMajority, raters_per_pair: ratersPerPair,
    decided: items.filter(item => item.choice !== 'tie').length, tie: items.filter(item => item.choice === 'tie').length, no_majority: noMajority,
    agreement: MEASURES.map(measure => ({
      measure: measure.id, title: measure.title,
      overall: agreement(items, measure.field),
      strata: strata.map(id => ({ stratum: id, ...agreement(items.filter(item => item.pair.stratum === id), measure.field) })),
    })),
  };
  return { raters: raters.slice(), pairwise, fleiss, majority };
}

//   votes: every vote, in the order cast (readVoteFiles); a vote without a
//     rater is the legacy rater's.
//   raters: only these raters (default: everyone who voted).
//   malformed, duplicates, files, ignored: what readVoteFiles reports, for the summary.
export function analyzeStudy({ key, votes, malformed = 0, duplicates = 0, files = null, ignored = [], legacyRater = LEGACY_RATER, raters = null }) {
  const byId = new Map(key.pairs.map(pair => [pair.id, pair]));
  const strata = (key.strata ?? []).map(item => item.id);
  for (const pair of key.pairs) if (!strata.includes(pair.stratum)) strata.push(pair.stratum);
  const named = votes.map(vote => ({ ...vote, rater: vote.rater ?? legacyRater }));
  const voters = [...new Set(named.map(vote => vote.rater))].sort();
  const listed = raters ? voters.filter(id => raters.includes(id)) : voters;
  // A rater of this study has a vote for one of its pairs. One whose every vote
  // names another pair (another study's votes, say) is reported with those
  // lines, never analysed or compared with the others.
  const chosen = listed.filter(id => named.some(vote => vote.rater === id && byId.has(vote.pair)));

  const perRater = [], latestByRater = new Map();
  for (const rater of chosen) {
    const { analysis, latest } = raterAnalysis(key, byId, strata, rater, named.filter(vote => vote.rater === rater));
    perRater.push(analysis);
    latestByRater.set(rater, latest);
  }
  const kept = named.filter(vote => listed.includes(vote.rater));

  const votesSummary = {
    files, ignored_files: ignored, legacy_rater: legacyRater,
    lines: votes.length + duplicates + malformed, valid_lines: votes.length, malformed_lines: malformed, duplicate_lines: duplicates,
    unknown_pair_lines: kept.filter(vote => !byId.has(vote.pair)).length,
    raters: chosen, raters_only_unknown_pairs: listed.filter(id => !chosen.includes(id)),
    raters_left_out: voters.filter(id => !listed.includes(id)), raters_not_found: (raters ?? []).filter(id => !voters.includes(id)),
    left_out_lines: named.length - kept.length,
    pairs_total: key.pairs.length, originals_total: key.pairs.filter(pair => !pair.repeat_of).length,
  };

  return {
    schema: ANALYSIS_SCHEMA, study: key.name, prepared_at: key.created_at ?? null,
    votes: votesSummary, raters: perRater, between_raters: betweenRaters(key, strata, chosen, latestByRater),
    notes: [
      'Each rater counts with their last vote per pair; earlier votes on the same pair are revisions.',
      'Agreement is counted on original pairs only; repeated pairs (sides swapped) are used for self-consistency only.',
      'A "cannot tell" vote is a tie and is left out of agreement; pairs whose two values are equal have no higher side and are left out of that measure.',
      'Between raters, choices are compared as shown (A closer / cannot tell / B closer); every rater sees the same sides of a pair.',
      'Votes in votes.jsonl recorded before raters had names count as rater ' + legacyRater + (legacyRater === LEGACY_RATER ? ' (analyze with --legacy-rater <id> if they are one named rater\'s)' : '') + '.',
      'Intervals are Wilson 95 % score intervals on counts of pairs; pairs share tasks and submissions, so they are not fully independent. Kappas are point estimates.',
    ],
  };
}

const pct = value => value === null || value === undefined ? 'n/a' : (100 * value).toFixed(1) + '%';
const interval = stat => stat.n ? pct(stat.p) + ' [' + pct(stat.low) + ', ' + pct(stat.high) + ']' : 'n/a';
const seconds = ms => ms === null || ms === undefined ? 'n/a' : (ms / 1000).toFixed(1) + ' s';
const num = (value, digits = 2) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a';

const kappa = value => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : 'n/a';
const range = row => '[' + row.min + ', ' + row.max + (row.max === 100 ? ']' : ')');

// One rater's sections: the analysis of a single rater, as before raters were named.
function raterMarkdown(item, lines) {
  const v = item.votes;
  lines.push('## Rater ' + item.rater, '');
  lines.push('### Votes', '');
  lines.push('| | count |', '|---|---|');
  lines.push('| valid lines | ' + v.lines + ' |', '| lines for unknown pairs (skipped) | ' + v.unknown_pair_lines + ' |',
    '| revisions (earlier votes replaced) | ' + v.revisions + ' |', '| pairs rated / total | ' + v.pairs_rated + ' / ' + v.pairs_total + ' |',
    '| pairs unrated | ' + v.pairs_unrated + ' |', '| original pairs rated / total | ' + v.originals_rated + ' / ' + v.originals_total + ' |',
    '| ties ("cannot tell") among rated originals | ' + v.ties + ' |', '| median time per rated pair (last vote) | ' + seconds(v.median_ms) + ' |',
    '| the same, page-hidden time left out | ' + seconds(v.median_visible_ms) + ' |', '');
  lines.push('### Agreement with the rater', '');
  lines.push('Share of decided original pairs in which the rater chose the submission the measure ranks higher (Wilson 95 % interval).', '');
  lines.push('| measure | agree / decided | agreement | no higher side |', '|---|---|---|---|');
  for (const measure of item.agreement) lines.push('| ' + measure.title + ' | ' + measure.overall.k + ' / ' + measure.overall.n + ' | ' + interval(measure.overall) + ' | ' + measure.overall.no_higher_side + ' |');
  lines.push('');
  lines.push('Per stratum of the headline gap |Δ|:', '');
  lines.push('| measure | ' + item.curve.map(row => row.stratum).join(' | ') + ' |', '|---|' + item.curve.map(() => '---|').join(''));
  for (const measure of item.agreement) lines.push('| ' + measure.title + ' | ' + measure.strata.map(row => row.k + '/' + row.n + ' ' + interval(row)).join(' | ') + ' |');
  lines.push('');
  lines.push('### P(rater picks the higher-scored) against |Δ|', '');
  lines.push('| stratum | pairs | rated | mean gap | ties | tie rate | agree / decided | P(higher) [95 %] |', '|---|---|---|---|---|---|---|---|');
  for (const row of item.curve) {
    lines.push('| ' + range(row) + ' | ' + row.pairs + ' | ' + row.rated + ' | ' + num(row.mean_gap, 1) + ' | ' + row.ties + ' | ' +
      interval(row.tie_rate) + ' | ' + row.agreement.k + ' / ' + row.agreement.n + ' | ' + interval(row.agreement) + ' |');
  }
  lines.push('');
  const side = item.side_preference_a;
  lines.push('Side habit: among decided original pairs the rater chose A in ' + side.k + ' of ' + side.n + ' (' + interval(side) + '). Half of the pairs in each stratum have the higher-scored submission on A.', '');
  const c = item.self_consistency;
  lines.push('### Self-consistency on repeated pairs', '');
  lines.push('| repeats | both rated | same choice | opposite | both "cannot tell" | one "cannot tell" | same / decided | exact (ties included) |', '|---|---|---|---|---|---|---|---|');
  lines.push('| ' + c.repeats + ' | ' + c.both_rated + ' | ' + c.same + ' | ' + c.opposite + ' | ' + c.both_tie + ' | ' + c.one_tie + ' | ' + interval(c.same_share_of_decided) + ' | ' + interval(c.exact_share) + ' |', '');
  lines.push('### Largest disagreements', '');
  if (!item.largest_disagreements.length) lines.push('None: the rater never chose the lower-scored side.', '');
  else {
    lines.push('The rater chose the lower-scored side; largest |Δ| first. Δ = score A − score B. Images are `<pair>-<r|a|b>-<view>.png` in images/.', '');
    lines.push('| pair | Δ | score A | score B | chose | shape A / B | detail A / B | task | variant | A | B |', '|---|---|---|---|---|---|---|---|---|---|---|');
    for (const row of item.largest_disagreements) {
      lines.push('| ' + row.pair + ' | ' + num(row.delta_a_minus_b) + ' | ' + num(row.score_a) + ' | ' + num(row.score_b) + ' | ' + row.choice.toUpperCase() + ' | ' +
        num(row.shape_a, 1) + ' / ' + num(row.shape_b, 1) + ' | ' + num(row.detail_a, 1) + ' / ' + num(row.detail_b, 1) + ' | ' + row.task + ' | ' + row.variant + ' | ' + row.a + ' | ' + row.b + ' |');
    }
    lines.push('');
  }
}

export function analysisMarkdown(analysis) {
  const v = analysis.votes, between = analysis.between_raters, lines = [];
  lines.push('# Human-agreement study: ' + analysis.study, '');
  lines.push('Prepared ' + (analysis.prepared_at ?? 'n/a') + '. Generated by `node v1/scripts/study.mjs analyze`.', '');
  lines.push('## Votes', '');
  if (v.files?.length) {
    lines.push('| file | lines | valid | malformed | without a rater | raters |', '|---|---|---|---|---|---|');
    for (const file of v.files) lines.push('| ' + file.file + ' | ' + file.lines + ' | ' + file.valid_lines + ' | ' + file.malformed_lines + ' | ' + file.unnamed_lines + ' | ' + (file.raters.join(', ') || '–') + ' |');
    lines.push('');
  }
  if (v.ignored_files?.length) lines.push('Not read (not `votes.jsonl` or `votes-<rater>.jsonl` with a rater id of lower-case letters and digits): ' + v.ignored_files.join(', ') + '.', '');
  lines.push('| | count |', '|---|---|');
  lines.push('| lines | ' + v.lines + ' |', '| malformed lines (skipped) | ' + v.malformed_lines + ' |', '| the same vote in two files (counted once) | ' + v.duplicate_lines + ' |',
    '| lines for unknown pairs (skipped) | ' + v.unknown_pair_lines + ' |', '| raters | ' + (v.raters.join(', ') || 'none') + ' |');
  if (v.raters_only_unknown_pairs.length) lines.push('| raters whose votes are all for unknown pairs (not analysed) | ' + v.raters_only_unknown_pairs.join(', ') + ' |');
  if (v.raters_left_out.length) lines.push('| raters left out (--raters) | ' + v.raters_left_out.join(', ') + ' (' + v.left_out_lines + ' lines) |');
  if (v.raters_not_found.length) lines.push('| raters asked for but without votes | ' + v.raters_not_found.join(', ') + ' |');
  lines.push('');
  if (v.raters.includes(LEGACY_RATER)) {
    lines.push(LEGACY_RATER + ' holds the votes in votes.jsonl recorded before raters had names. If they are one named rater\'s, `analyze --legacy-rater <id>` counts them as that rater\'s.', '');
  } else if (v.legacy_rater !== LEGACY_RATER) lines.push('Votes in votes.jsonl without a rater count as ' + v.legacy_rater + '\'s (--legacy-rater).', '');

  lines.push('## Raters', '');
  lines.push('Each rater on their own, on the original pairs they rated (details per rater below).', '');
  lines.push('| rater | pairs rated / total | originals rated | ties | agree / decided | agreement with the headline score | chose A | same on repeats / decided | median time |',
    '|---|---|---|---|---|---|---|---|---|');
  for (const item of analysis.raters) {
    const headline = item.agreement[0].overall, c = item.self_consistency;
    lines.push('| ' + item.rater + ' | ' + item.votes.pairs_rated + ' / ' + item.votes.pairs_total + ' | ' + item.votes.originals_rated + ' / ' + item.votes.originals_total + ' | ' +
      item.votes.ties + ' | ' + headline.k + ' / ' + headline.n + ' | ' + interval(headline) + ' | ' + interval(item.side_preference_a) + ' | ' +
      c.same + ' / ' + (c.same + c.opposite) + ' | ' + seconds(item.votes.median_ms) + ' |');
  }
  lines.push('');
  if (analysis.raters.length) {
    const stratumRows = analysis.raters[0].curve;
    const showMajority = analysis.raters.length >= 2;
    lines.push('P(rater picks the higher-scored) per stratum of the headline gap |Δ|, agree / decided [95 %]:', '');
    lines.push('| stratum | ' + analysis.raters.map(item => item.rater).join(' | ') + (showMajority ? ' | majority |' : ' |'),
      '|---|' + analysis.raters.map(() => '---|').join('') + (showMajority ? '---|' : ''));
    stratumRows.forEach((row, index) => {
      const cells = analysis.raters.map(item => { const stat = item.curve[index].agreement; return stat.k + '/' + stat.n + ' ' + interval(stat); });
      if (showMajority) { const stat = between.majority.agreement[0].strata[index]; cells.push(stat.k + '/' + stat.n + ' ' + interval(stat)); }
      lines.push('| ' + range(row) + ' | ' + cells.join(' | ') + ' |');
    });
    lines.push('');
  }

  lines.push('## Between raters', '');
  if (between.raters.length < 2) {
    lines.push((between.raters.length ? 'One rater (' + between.raters[0] + ')' : 'No rater') + ': agreement between raters needs two or more. ' +
      'Every rater rates in their own copy of the study and sends back votes.jsonl, saved here as votes-<rater>.jsonl (see v1/lib/study/README.md).', '');
  } else {
    lines.push('Two raters at a time, on the original pairs both rated. The choices are compared as shown: A closer, cannot tell, B closer. ' +
      'Cohen\'s κ corrects the share of the same choice for the agreement expected from each rater\'s own shares of the three choices.', '');
    lines.push('| raters | both rated | same choice [95 %] | Cohen\'s κ | chance agreement | same side / both decided [95 %] |', '|---|---|---|---|---|---|');
    for (const row of between.pairwise) {
      lines.push('| ' + row.raters.join(' – ') + ' | ' + row.both_rated + ' | ' + row.same_choice.k + ' (' + interval(row.same_choice) + ') | ' + kappa(row.cohen_kappa) + ' | ' +
        pct(row.chance_agreement) + ' | ' + row.both_decided_same_side.k + ' / ' + row.both_decided_same_side.n + ' (' + interval(row.both_decided_same_side) + ') |');
    }
    lines.push('');
    const f = between.fleiss;
    if (!f) lines.push('Fleiss\' κ is given for three raters or more.', '');
    else {
      lines.push('Fleiss\' κ over ' + f.raters.join(', ') + ', on the ' + f.pairs + ' original pairs every one of them rated: ' +
        (f.pairs ? 'κ = ' + kappa(f.kappa) + ' (observed agreement ' + pct(f.observed) + ', chance ' + pct(f.chance) + '; shares A ' + pct(f.shares.a) + ', cannot tell ' + pct(f.shares.tie) + ', B ' + pct(f.shares.b) + ').' : 'n/a.'), '');
    }
    const m = between.majority;
    lines.push('### Majority vote', '');
    lines.push('The choice of more than half of the raters who rated a pair, on original pairs rated by two raters or more: ' + m.pairs + ' pairs (' +
      Object.entries(m.raters_per_pair).map(([count, pairs]) => pairs + ' rated by ' + count).join(', ') + '); majority for A or B ' + m.decided + ', for "cannot tell" ' + m.tie + ', no majority ' + m.no_majority + '.', '');
    lines.push('| measure | agree / decided | agreement | no higher side |', '|---|---|---|---|');
    for (const measure of m.agreement) lines.push('| ' + measure.title + ' | ' + measure.overall.k + ' / ' + measure.overall.n + ' | ' + interval(measure.overall) + ' | ' + measure.overall.no_higher_side + ' |');
    lines.push('');
    lines.push('Per stratum of the headline gap |Δ|:', '');
    lines.push('| measure | ' + m.agreement[0].strata.map(row => row.stratum).join(' | ') + ' |', '|---|' + m.agreement[0].strata.map(() => '---|').join(''));
    for (const measure of m.agreement) lines.push('| ' + measure.title + ' | ' + measure.strata.map(row => row.k + '/' + row.n + ' ' + interval(row)).join(' | ') + ' |');
    lines.push('');
  }

  for (const item of analysis.raters) raterMarkdown(item, lines);
  lines.push('## Notes', '', ...analysis.notes.map(note => '- ' + note), '');
  return lines.join('\n');
}

//   legacyRater, raters: see readVoteFiles and analyzeStudy.
export async function writeAnalysis(studyDir, { legacyRater = LEGACY_RATER, raters = null } = {}) {
  const key = JSON.parse(await readFile(join(studyDir, 'key.json'), 'utf8'));
  const read = await readVoteFiles(studyDir, { legacyRater });
  const analysis = analyzeStudy({ key, votes: read.votes, malformed: read.malformed, duplicates: read.duplicates, files: read.files, ignored: read.ignored, legacyRater, raters });
  await writeJSON(join(studyDir, 'analysis.json'), analysis);
  await writeFile(join(studyDir, 'analysis.md'), analysisMarkdown(analysis));
  return { analysis, files: [join(studyDir, 'analysis.md'), join(studyDir, 'analysis.json')] };
}
