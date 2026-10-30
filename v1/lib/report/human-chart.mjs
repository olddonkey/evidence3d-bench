import { esc, num, NOT_EVALUATED } from './html.mjs';
import { CURVE_REASONS, INTERVAL_REASONS, SHARES } from '../study/curve.mjs';
import { HUMAN_REASONS } from './human.mjs';

// The human curve on the page and in summary.md (human.mjs,
// docs/V1-ROUND4-PLAN.md section 6): the panel's three shares and the
// half-score win rate per bin of the score gap, as an inline SVG and a table;
// and the cell "panel half-score win rate of A" of the pairwise tables.

const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const pct = (value, digits = 0) => isNumber(value) ? (100 * value).toFixed(digits) + '%' : 'n/a';
export const SHARE_LABELS = { higher: 'chose the higher-scored', tie: 'cannot tell', lower: 'chose the lower-scored', half_win: 'half-score win rate W' };
// Series slots of html.mjs STYLE, one per share, the same on every page.
const SLOTS = { half_win: 1, higher: 3, tie: 4, lower: 2 };
const binRange = (bin, last) => '[' + bin.min + ', ' + bin.max + (last ? ']' : ')');
const intervalWords = share => share.ci95 ? '[' + pct(share.ci95[0], 1) + ', ' + pct(share.ci95[1], 1) + ']' : 'no interval: ' + (INTERVAL_REASONS[share.interval] ?? share.interval);

function chart(curve) {
  const W = 640, H = 280, left = 44, right = 16, top = 12, bottom = 44, bins = curve.bins;
  const step = (W - left - right) / bins.length, x = k => left + step * (k + 0.5), y = value => top + (H - top - bottom) * (1 - value);
  const grid = [0, 0.25, 0.5, 0.75, 1].map(value => '<line class="grid" x1="' + left + '" x2="' + (W - right) + '" y1="' + y(value) + '" y2="' + y(value) + '"/>' +
    '<text class="axis" x="' + (left - 6) + '" y="' + (y(value) + 4) + '" text-anchor="end">' + Math.round(100 * value) + '%</text>').join('');
  const xAxis = bins.map((bin, k) => '<text class="axis" x="' + x(k) + '" y="' + (H - bottom + 16) + '" text-anchor="middle">' + esc(binRange(bin, k === bins.length - 1)) + '</text>').join('') +
    '<text class="axis" x="' + ((left + W - right) / 2) + '" y="' + (H - 6) + '" text-anchor="middle">gap between the two submissions&rsquo; headline scores (points)</text>';
  const offset = { half_win: -9, higher: -3, tie: 3, lower: 9 };
  const series = SHARES.map(share => {
    const colour = 'var(--series-' + SLOTS[share] + ')';
    const points = bins.map((bin, k) => [x(k) + offset[share], bin.shares[share]]);
    const line = '<polyline class="series" points="' + points.map(([px, item]) => px.toFixed(1) + ',' + y(item.value).toFixed(1)).join(' ') + '" style="stroke: ' + colour +
      (share === 'half_win' ? '' : '; stroke-dasharray: 4 3') + '"/>';
    const marks = points.map(([px, item], k) => (item.ci95 ? '<line class="whisker" x1="' + px.toFixed(1) + '" x2="' + px.toFixed(1) + '" y1="' + y(item.ci95[0]).toFixed(1) +
      '" y2="' + y(item.ci95[1]).toFixed(1) + '" style="stroke: ' + colour + '"/>' : '') +
      '<circle class="mark" cx="' + px.toFixed(1) + '" cy="' + y(item.value).toFixed(1) + '" r="4" style="fill: ' + colour + '"><title>' +
      esc(binRange(bins[k], k === bins.length - 1) + ', ' + SHARE_LABELS[share] + ': ' + pct(item.value, 1) + ' ' + intervalWords(item) + ', ' + bins[k].pairs + ' pairs') + '</title></circle>').join('');
    return '<g>' + line + marks + '</g>';
  }).join('');
  return '<figure class="time-chart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Shares of the panel&rsquo;s conclusions against the score gap">' +
    grid + xAxis + series + '</svg><figcaption><ul class="series-legend">' +
    SHARES.map(share => '<li><span class="swatch" style="background: var(--series-' + SLOTS[share] + ')"></span>' + esc(SHARE_LABELS[share]) + '</li>').join('') + '</ul></figcaption></figure>';
}

const panelWords = curve => curve.panel.size + ' qualified rater' + (curve.panel.size === 1 ? '' : 's') + (curve.panel.size ? ' (' + curve.panel.raters.join(', ') + ')' : '');
const scorerWords = curve => 'scorer ' + curve.scorer.version + (curve.scorer.weights ? ' (shape ' + curve.scorer.weights.shape + ' / detail ' + curve.scorer.weights.detail + ')' : '');

// The section of index.html; '' without a curve.
export function humanSection(board) {
  const curve = board.human_curve;
  if (!curve) return '';
  const source = '<p class="muted">From <code>' + esc(curve.file ?? 'the human curve') + '</code>' + (curve.study?.name ? ' (study <code>' + esc(curve.study.name) + '</code>)' : '') +
    ' · ' + esc(scorerWords(curve)) + ' · panel of ' + esc(panelWords(curve)) + '</p>';
  const left = (curve.panel.considered ?? []).filter(item => !item.qualified);
  const leftOut = left.length ? '<p class="legend">Not on the panel: ' + left.map(item => esc(item.rater) + (item.reasons?.length ? ' (' + esc(item.reasons.join('; ')) + ')' : '')).join(', ') + '.</p>' : '';
  if (!curve.available) return '<h2 id="human-curve">Human curve</h2>' + source + leftOut + '<p><strong>No human curve:</strong> ' + esc(CURVE_REASONS[curve.reason] ?? curve.reason) +
    '. The pairwise tables have no panel half-score win rate.</p>';
  const table = '<div class="scroll"><table><thead><tr><th>Score gap</th><th class="num">Pairs</th>' +
    SHARES.map(share => '<th class="num">' + esc(SHARE_LABELS[share]) + '</th>').join('') + '</tr></thead><tbody>' +
    curve.bins.map((bin, k) => '<tr><td>' + esc(binRange(bin, k === curve.bins.length - 1)) + '<small>' + esc(bin.strata.join(' + ')) + '</small></td>' +
      '<td class="num">' + bin.pairs + '<small>' + bin.objects + ' objects · mean gap ' + num(bin.mean_gap) + '</small></td>' +
      SHARES.map(share => '<td class="num">' + esc(pct(bin.shares[share].value, 1)) + '<small>' + esc(intervalWords(bin.shares[share])) + '</small></td>').join('') + '</tr>').join('\n') +
    '</tbody></table></div>';
  const e = curve.equal;
  return '<h2 id="human-curve">Human curve</h2>' + source + leftOut + chart(curve) + table +
    '<p class="legend">In the blind study, raters saw the reference and two submissions of one task and said which is geometrically closer, or that they cannot tell. ' +
    'Each original pair counts once, with the panel&rsquo;s conclusion (the plurality of the qualified raters; a tie for the most votes is &ldquo;cannot tell&rdquo;). ' +
    'Per bin of the gap between the two headline scores: the share of pairs where the panel chose the higher-scored submission, could not tell, or chose the lower-scored one, and ' +
    'the half-score win rate W = higher + &frac12; cannot tell. Bins are the study&rsquo;s strata, a stratum with fewer than ' + curve.min_bin_pairs + ' pairs merged into the next. ' +
    '95% intervals: cluster bootstrap over the study&rsquo;s ' + curve.bootstrap.clusters + ' objects (' + curve.bootstrap.resamples + ' resamples' +
    (curve.bootstrap.redrawn ? '; ' + curve.bootstrap.redrawn + ' draws that left a bin empty were drawn again' : '') + '); none at a share of 0 or 1. ' +
    e.pairs + ' pair' + (e.pairs === 1 ? '' : 's') + ' with equal scores (gap &lt; ' + curve.tie_gap + ') have no higher side and are in no bin' +
    (e.pairs ? ' (panel: A ' + e.panel.a + ', cannot tell ' + e.panel.tie + ', B ' + e.panel.b + ')' : '') + '. ' +
    curve.notes.map(esc).join(' ') + '</p>';
}

// Whether a set's pairwise tables carry the column.
export const hasHuman = set => Boolean(set.human?.available);
export const humanHead = '<th class="num" title="the panel&rsquo;s half-score win rate of A: per task both delivered a valid model, the human curve&rsquo;s W at the task&rsquo;s score gap ' +
  '(1 &minus; W when B scored higher, 0.5 at equal scores), averaged within objects, then over objects; &ldquo;cannot tell&rdquo; counts half, so this is not the probability that the panel prefers A; ' +
  'two-level bootstrap interval">Panel &frac12;-win of A<small>half-score win rate, 95%</small></th>';

export function humanCell(pair) {
  const human = pair.human;
  if (!human) return '<td class="num">' + NOT_EVALUATED + '</td>';
  const coverage = '<small title="tasks where both delivered a valid model the curve applies to, of the tasks both ran">' + human.tasks + ' / ' + human.tasks_paired + ' tasks' +
    (isNumber(human.share) && human.share < 1 ? ' (' + pct(human.share) + ')' : '') + '</small>';
  if (!isNumber(human.win_rate_a)) return '<td class="num">' + NOT_EVALUATED + coverage + '</td>';
  return '<td class="num">' + esc(pct(human.win_rate_a, 1)) + '<small>' + esc(human.ci95 ? '[' + pct(human.ci95[0], 1) + ', ' + pct(human.ci95[1], 1) + ']'
    : 'no interval: ' + (INTERVAL_REASONS[human.interval] ?? human.interval)) + '</small>' + coverage + '</td>';
}

// One sentence for the pairwise legend of a set.
export function humanLegend(set) {
  if (!set.human) return '';
  if (!set.human.available) return ' <strong>No panel half-score win rate</strong> in this set: ' + esc(HUMAN_REASONS[set.human.reason] ?? set.human.reason) +
    (set.human.versions?.length ? ' (' + esc(set.human.versions.join(', ')) + ')' : '') + '.';
  return ' <strong>Panel &frac12;-win of A</strong>: the panel&rsquo;s half-score win rate of A from the <a href="#human-curve">human curve</a>, on the tasks where both delivered a valid model ' +
    '(failures, integrity zeros and t1 tasks are outside what the curve measured; the share of tasks covered is under it): per task the curve&rsquo;s W at the task&rsquo;s gap, 1 &minus; W when B scored higher, ' +
    '0.5 at equal scores, averaged like the score. &ldquo;Cannot tell&rdquo; counts half, so it is not the probability that the panel prefers A; 50% is no visible difference. ' +
    'Its interval redraws the study&rsquo;s objects and this set&rsquo;s together (two-level bootstrap).';
}

// --------------------------------------------------------------- markdown

export const humanMarkdownCell = pair => !pair.human || !isNumber(pair.human.win_rate_a) ? 'n/a'
  : pct(pair.human.win_rate_a, 1) + (pair.human.ci95 ? ' [' + pct(pair.human.ci95[0], 1) + ', ' + pct(pair.human.ci95[1], 1) + ']' : '') + ' (' + pair.human.tasks + '/' + pair.human.tasks_paired + ' tasks)';

export function humanMarkdown(board) {
  const curve = board.human_curve;
  if (!curve) return [];
  const lines = ['## Human curve', '', 'From `' + (curve.file ?? 'the human curve') + '`' + (curve.study?.name ? ' (study `' + curve.study.name + '`)' : '') + '; ' + scorerWords(curve) +
    '; panel of ' + panelWords(curve) + '.', ''];
  if (!curve.available) return [...lines, '**No human curve**: ' + (CURVE_REASONS[curve.reason] ?? curve.reason) + '.', ''];
  const cell = value => String(value).replace(/\|/g, '\\|');
  lines.push('| Score gap | Pairs | ' + SHARES.map(share => SHARE_LABELS[share]).join(' | ') + ' |', '|---|---:|' + SHARES.map(() => '---:|').join(''));
  curve.bins.forEach((bin, k) => lines.push('| ' + cell(binRange(bin, k === curve.bins.length - 1)) + ' | ' + bin.pairs + ' | ' +
    SHARES.map(share => pct(bin.shares[share].value, 1) + ' ' + cell(intervalWords(bin.shares[share]))).join(' | ') + ' |'));
  lines.push('', 'Panel conclusions on the original pairs of the blind study, per bin of the headline gap; W = higher + ½ cannot tell; 95% cluster bootstrap intervals over ' +
    curve.bootstrap.clusters + ' objects. ' + curve.equal.pairs + ' pairs with equal scores (gap < ' + curve.tie_gap + ') are in no bin' +
    (curve.equal.pairs ? ' (panel: A ' + curve.equal.panel.a + ', cannot tell ' + curve.equal.panel.tie + ', B ' + curve.equal.panel.b + ')' : '') + '. ' + curve.notes.join(' '), '');
  return lines;
}
