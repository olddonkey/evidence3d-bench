import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJSON } from '../../../lib/io.mjs';
import { readVotes } from './server.mjs';

// Joins the rater's votes with key.json: how often the rater picks the
// submission the score ranks higher, overall and per gap stratum, for the
// headline score and for its two halves; ties; self-consistency on the
// repeated pairs; and the largest disagreements to inspect. Counts,
// proportions and Wilson intervals only.
//
// The last vote per pair wins (a revision is a new line). Agreement is counted
// on the original pairs; a repeat is the same two submissions shown again with
// the sides swapped, used only for self-consistency, so no pair counts twice.

export const ANALYSIS_SCHEMA = 'e3d-study-analysis-v1';
export const Z95 = 1.959963984540054;
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

export function analyzeStudy({ key, votes, malformed = 0 }) {
  const byId = new Map(key.pairs.map(pair => [pair.id, pair]));
  const known = votes.filter(vote => byId.has(vote.pair));
  const latest = new Map();
  for (const vote of known) latest.set(vote.pair, vote);
  const rated = [...latest.values()].map(vote => ({ pair: byId.get(vote.pair), choice: vote.choice, ms: vote.ms, hidden_ms: vote.hidden_ms ?? null }));
  const originals = rated.filter(item => !item.pair.repeat_of);
  const strata = (key.strata ?? []).map(item => item.id);
  for (const pair of key.pairs) if (!strata.includes(pair.stratum)) strata.push(pair.stratum);

  const votesSummary = {
    lines: votes.length + malformed, valid_lines: votes.length, malformed_lines: malformed, unknown_pair_lines: votes.length - known.length,
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
    schema: ANALYSIS_SCHEMA, study: key.name, prepared_at: key.created_at ?? null,
    votes: votesSummary, agreement: agreementByMeasure, curve, side_preference_a: sidePreference, self_consistency: consistency, largest_disagreements: disagreements,
    notes: [
      'The last vote per pair counts; earlier votes on the same pair are revisions.',
      'Agreement is counted on original pairs only; repeated pairs (sides swapped) are used for self-consistency only.',
      'A "cannot tell" vote is a tie and is left out of agreement; pairs whose two values are equal have no higher side and are left out of that measure.',
      'Intervals are Wilson 95 % score intervals on counts of pairs; pairs share tasks and submissions, so they are not fully independent.',
    ],
  };
}

const pct = value => value === null || value === undefined ? 'n/a' : (100 * value).toFixed(1) + '%';
const interval = stat => stat.n ? pct(stat.p) + ' [' + pct(stat.low) + ', ' + pct(stat.high) + ']' : 'n/a';
const seconds = ms => ms === null || ms === undefined ? 'n/a' : (ms / 1000).toFixed(1) + ' s';
const num = (value, digits = 2) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a';

export function analysisMarkdown(analysis) {
  const v = analysis.votes, lines = [];
  lines.push('# Human-agreement study: ' + analysis.study, '');
  lines.push('Prepared ' + (analysis.prepared_at ?? 'n/a') + '. Generated by `node v1/scripts/study.mjs analyze`.', '');
  lines.push('## Votes', '');
  lines.push('| | count |', '|---|---|');
  lines.push('| lines in votes.jsonl | ' + v.lines + ' |', '| malformed lines (skipped) | ' + v.malformed_lines + ' |', '| lines for unknown pairs (skipped) | ' + v.unknown_pair_lines + ' |',
    '| revisions (earlier votes replaced) | ' + v.revisions + ' |', '| pairs rated / total | ' + v.pairs_rated + ' / ' + v.pairs_total + ' |',
    '| pairs unrated | ' + v.pairs_unrated + ' |', '| original pairs rated / total | ' + v.originals_rated + ' / ' + v.originals_total + ' |',
    '| ties ("cannot tell") among rated originals | ' + v.ties + ' |', '| median time per rated pair (last vote) | ' + seconds(v.median_ms) + ' |',
    '| the same, page-hidden time left out | ' + seconds(v.median_visible_ms) + ' |', '');
  lines.push('## Agreement with the rater', '');
  lines.push('Share of decided original pairs in which the rater chose the submission the measure ranks higher (Wilson 95 % interval).', '');
  lines.push('| measure | agree / decided | agreement | no higher side |', '|---|---|---|---|');
  for (const item of analysis.agreement) lines.push('| ' + item.title + ' | ' + item.overall.k + ' / ' + item.overall.n + ' | ' + interval(item.overall) + ' | ' + item.overall.no_higher_side + ' |');
  lines.push('');
  lines.push('Per stratum of the headline gap |Δ|:', '');
  lines.push('| measure | ' + analysis.curve.map(row => row.stratum).join(' | ') + ' |', '|---|' + analysis.curve.map(() => '---|').join(''));
  for (const item of analysis.agreement) lines.push('| ' + item.title + ' | ' + item.strata.map(row => row.k + '/' + row.n + ' ' + interval(row)).join(' | ') + ' |');
  lines.push('');
  lines.push('## P(rater picks the higher-scored) against |Δ|', '');
  lines.push('| stratum | pairs | rated | mean gap | ties | tie rate | agree / decided | P(higher) [95 %] |', '|---|---|---|---|---|---|---|---|');
  for (const row of analysis.curve) {
    lines.push('| [' + row.min + ', ' + row.max + (row.max === 100 ? ']' : ')') + ' | ' + row.pairs + ' | ' + row.rated + ' | ' + num(row.mean_gap, 1) + ' | ' + row.ties + ' | ' +
      interval(row.tie_rate) + ' | ' + row.agreement.k + ' / ' + row.agreement.n + ' | ' + interval(row.agreement) + ' |');
  }
  lines.push('');
  const side = analysis.side_preference_a;
  lines.push('Side habit: among decided original pairs the rater chose A in ' + side.k + ' of ' + side.n + ' (' + interval(side) + '). Half of the pairs in each stratum have the higher-scored submission on A.', '');
  const c = analysis.self_consistency;
  lines.push('## Self-consistency on repeated pairs', '');
  lines.push('| repeats | both rated | same choice | opposite | both "cannot tell" | one "cannot tell" | same / decided | exact (ties included) |', '|---|---|---|---|---|---|---|---|');
  lines.push('| ' + c.repeats + ' | ' + c.both_rated + ' | ' + c.same + ' | ' + c.opposite + ' | ' + c.both_tie + ' | ' + c.one_tie + ' | ' + interval(c.same_share_of_decided) + ' | ' + interval(c.exact_share) + ' |', '');
  lines.push('## Largest disagreements', '');
  if (!analysis.largest_disagreements.length) lines.push('None: the rater never chose the lower-scored side.', '');
  else {
    lines.push('The rater chose the lower-scored side; largest |Δ| first. Δ = score A − score B. Images are `<pair>-<r|a|b>-<view>.png` in images/.', '');
    lines.push('| pair | Δ | score A | score B | chose | shape A / B | detail A / B | task | variant | A | B |', '|---|---|---|---|---|---|---|---|---|---|---|');
    for (const row of analysis.largest_disagreements) {
      lines.push('| ' + row.pair + ' | ' + num(row.delta_a_minus_b) + ' | ' + num(row.score_a) + ' | ' + num(row.score_b) + ' | ' + row.choice.toUpperCase() + ' | ' +
        num(row.shape_a, 1) + ' / ' + num(row.shape_b, 1) + ' | ' + num(row.detail_a, 1) + ' / ' + num(row.detail_b, 1) + ' | ' + row.task + ' | ' + row.variant + ' | ' + row.a + ' | ' + row.b + ' |');
    }
    lines.push('');
  }
  lines.push('## Notes', '', ...analysis.notes.map(note => '- ' + note), '');
  return lines.join('\n');
}

export async function writeAnalysis(studyDir) {
  const key = JSON.parse(await readFile(join(studyDir, 'key.json'), 'utf8'));
  const { votes, malformed } = await readVotes(studyDir);
  const analysis = analyzeStudy({ key, votes, malformed });
  await writeJSON(join(studyDir, 'analysis.json'), analysis);
  await writeFile(join(studyDir, 'analysis.md'), analysisMarkdown(analysis));
  return { analysis, files: [join(studyDir, 'analysis.md'), join(studyDir, 'analysis.json')] };
}
