import { esc, num, NOT_EVALUATED } from './html.mjs';

// The score-over-time section (curves.mjs): an inline SVG line chart, one line
// per configuration, and the same numbers as a table; and the table alone for
// summary.md. Static like the rest of the site: the chart's hover text is SVG
// <title>, the table is the accessible view.

const isNumber = value => typeof value === 'number' && Number.isFinite(value);
// Categorical slots (html.mjs STYLE, --series-1 .. --series-8), assigned in
// this fixed order; a ninth configuration is left to the table.
export const SERIES_SLOTS = 8;
const minutes = seconds => Math.round(seconds / 6) / 10;
const minuteLabel = seconds => String(minutes(seconds)).replace(/\.0$/, '');

const curved = entries => entries.filter(entry => entry.time_curve?.available);

function t95Text(t95) {
  if (!t95 || !isNumber(t95.median_seconds)) return 'n/a';
  return minuteLabel(t95.median_seconds) + ' min (IQR ' + minuteLabel(t95.q1_seconds) + '–' + minuteLabel(t95.q3_seconds) + ', n = ' + t95.attempts +
    (t95.low_final ? ', ' + t95.low_final + ' below ' + t95.min_final : '') + ')';
}

// Colour follows the configuration, not its rank: slots go by name.
function slots(entries) {
  const keys = [...new Set(entries.map(entry => entry.key))].sort();
  return new Map(keys.map((key, index) => [key, index < SERIES_SLOTS ? index + 1 : null]));
}

function chart(entries, colour) {
  const shown = entries.filter(entry => colour.get(entry.key));
  if (!shown.length) return '';
  const limit = Math.max(...shown.map(entry => entry.time_curve.wall_limit_seconds ?? 0));
  if (!(limit > 0)) return '';
  const direct = shown.length <= 4;
  const W = 720, H = 300, left = 44, right = direct ? 196 : 16, top = 12, bottom = 40;
  const x = t => left + (W - left - right) * t / limit, y = value => top + (H - top - bottom) * (1 - value / 100);
  const ticks = [...new Set(shown.flatMap(entry => entry.time_curve.points.map(point => point.t)))].sort((a, b) => a - b);
  const grid = [0, 25, 50, 75, 100].map(value => '<line class="grid" x1="' + left + '" x2="' + (W - right) + '" y1="' + y(value) + '" y2="' + y(value) + '"/>' +
    '<text class="axis" x="' + (left - 6) + '" y="' + (y(value) + 4) + '" text-anchor="end">' + value + '</text>').join('');
  const xAxis = [0, ...ticks].map(t => '<text class="axis" x="' + x(t) + '" y="' + (H - bottom + 16) + '" text-anchor="middle">' + minuteLabel(t) + '</text>').join('') +
    '<text class="axis" x="' + ((left + W - right) / 2) + '" y="' + (H - 6) + '" text-anchor="middle">minutes after the CLI started</text>';
  const lines = shown.map(entry => {
    const slot = colour.get(entry.key), points = entry.time_curve.points.filter(point => isNumber(point.mean));
    // Runs of consecutive ticks with a mean, from the origin (no model at 0):
    // a tick where every counted attempt is missing breaks the line, so no
    // progress is drawn across it.
    const runs = [[[0, 0]]];
    for (const point of [...entry.time_curve.points].sort((a, b) => a.t - b.t)) {
      if (isNumber(point.mean)) runs.at(-1).push([point.t, point.mean]);
      else if (runs.at(-1).length) runs.push([]);
    }
    const path = runs.filter(run => run.length > 1).map(run => '<polyline class="series" points="' +
      run.map(([t, value]) => x(t).toFixed(1) + ',' + y(value).toFixed(1)).join(' ') + '" style="stroke: var(--series-' + slot + ')"/>').join('');
    const marks = points.map(point => '<circle class="mark" cx="' + x(point.t).toFixed(1) + '" cy="' + y(point.mean).toFixed(1) + '" r="4" style="fill: var(--series-' + slot + ')">' +
      '<title>' + esc(entry.key + ' at ' + minuteLabel(point.t) + ' min: ' + point.mean.toFixed(1) + (point.ci95 ? ' [' + point.ci95[0].toFixed(1) + ', ' + point.ci95[1].toFixed(1) + ']' : '') +
        '; ' + Math.round(100 * point.finished) + '% of attempts finished' + (point.missing ? '; ' + point.missing + ' missing' : '')) + '</title></circle>').join('');
    return '<g>' + path + marks + '</g>';
  }).join('');
  let labels = '';
  if (direct) {
    // Labels at the line ends, pushed apart so none overlaps another.
    const ends = shown.map(entry => ({ key: entry.key, y: y(entry.time_curve.points.filter(point => isNumber(point.mean)).at(-1)?.mean ?? 0) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 14);
    labels = ends.map(end => '<text class="label" x="' + (W - right + 8) + '" y="' + (end.y + 4).toFixed(1) + '">' + esc(end.key.length > 30 ? end.key.slice(0, 29) + '…' : end.key) + '</text>').join('');
  }
  return '<figure class="time-chart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Mean score against minutes after the CLI started, one line per configuration">' +
    grid + xAxis + lines + labels + '</svg><figcaption><ul class="series-legend">' +
    shown.map(entry => '<li><span class="swatch" style="background: var(--series-' + colour.get(entry.key) + ')"></span>' + esc(entry.key) +
      ' <small>95% of final: ' + esc(t95Text(entry.time_curve.t95)) + '</small></li>').join('') + '</ul></figcaption></figure>';
}

export function timeSection(entries) {
  const withCurve = curved(entries), partial = entries.filter(entry => entry.time_curve && !entry.time_curve.available);
  const missing = partial.length ? '<p class="legend">No curve for ' + partial.map(entry => esc(entry.key) + ' (' + esc(entry.time_curve.reason) + ')').join('; ') + '.</p>' : '';
  if (!withCurve.length) {
    return '<p class="muted">No score-over-time snapshots in these batches (prepared with <code>--snapshot-seconds 0</code> or by a runner older than the snapshots).</p>' + missing;
  }
  const colour = slots(withCurve);
  const ticks = [...new Set(withCurve.flatMap(entry => entry.time_curve.points.map(point => point.t)))].sort((a, b) => a - b);
  const table = '<div class="scroll"><table><thead><tr><th>Configuration</th>' + ticks.map(t => '<th class="num">' + minuteLabel(t) + ' min</th>').join('') +
    '<th class="num" title="median minutes to the first snapshot at 95% of the attempt’s final score">95% of final</th><th class="num">Snapshots</th></tr></thead><tbody>' +
    withCurve.map(entry => {
      const curve = entry.time_curve, byTick = new Map(curve.points.map(point => [point.t, point]));
      return '<tr><td>' + esc(entry.key) + '</td>' + ticks.map(t => {
        const point = byTick.get(t);
        if (!point || !isNumber(point.mean)) return '<td class="num">' + NOT_EVALUATED + '</td>';
        return '<td class="num">' + num(point.mean) + '<small>' + (point.ci95 ? '[' + num(point.ci95[0]) + ', ' + num(point.ci95[1]) + ']' : 'no interval') + '</small><small>' +
          Math.round(100 * point.finished) + '% finished</small>' + (point.missing ? '<small>' + point.missing + ' missing</small>' : '') + '</td>';
      }).join('') +
        '<td class="num">' + (isNumber(curve.t95.median_seconds) ? num(minutes(curve.t95.median_seconds), 1, { suffix: ' min' }) + '<small>IQR ' + minuteLabel(curve.t95.q1_seconds) + '–' +
          minuteLabel(curve.t95.q3_seconds) + '</small>' : NOT_EVALUATED) + '<small>n = ' + curve.t95.attempts + (curve.t95.low_final ? ', ' + curve.t95.low_final + ' below ' + curve.t95.min_final : '') + '</small></td>' +
        '<td class="num">' + curve.snapshots + (curve.score_errors ? '<small class="bad">' + curve.score_errors + ' not scored (scorer failed or not stored)</small>' : '') +
          (curve.not_scored ? '<small>' + curve.not_scored + ' not scored</small>' : '') + '</td></tr>';
    }).join('\n') + '</tbody></table></div>';
  const over = withCurve.length > SERIES_SLOTS ? '<p class="legend">The chart shows ' + SERIES_SLOTS + ' configurations (by name); the table has all ' + withCurve.length + '.</p>' : '';
  const interval = [...new Set(withCurve.map(entry => entry.time_curve.interval_seconds).flat())].map(minuteLabel).join(', ');
  return chart(withCurve, colour) + over + table + missing +
    '<p class="legend">While an attempt runs, the runner copies its <code>output/model.glb</code> every ' + interval + ' min (outside the sandbox) and scores the copies afterwards; the leaderboard still scores only the final file. ' +
    'At each tick an attempt counts its final score once it has ended, before that its last snapshot&rsquo;s score (0 while it had no valid model); ' +
    'an attempt whose last snapshot has no score because the scorer failed on it (also when the runner scored it again) or the runner could not store it is left out of that tick and counted as <em>missing</em>. ' +
    'Attempts, tasks and objects are averaged as for the score, ' +
    'so the last column of the curve is the leaderboard score. <strong>95% of final</strong>: per attempt with a final score of at least 10, the minutes to its first snapshot at 95% of that score ' +
    '(its end if no snapshot got there); median and interquartile range over attempts.</p>';
}

export function timeMarkdown(entries) {
  const withCurve = curved(entries);
  if (!withCurve.length) return '';
  const ticks = [...new Set(withCurve.flatMap(entry => entry.time_curve.points.map(point => point.t)))].sort((a, b) => a - b);
  const cell = value => String(value ?? '').replace(/\|/g, '\\|');
  const head = ['Configuration', ...ticks.map(t => minuteLabel(t) + ' min'), '95% of final (median)'];
  const rows = withCurve.map(entry => {
    const byTick = new Map(entry.time_curve.points.map(point => [point.t, point]));
    return [entry.key, ...ticks.map(t => isNumber(byTick.get(t)?.mean) ? byTick.get(t).mean.toFixed(1) + (byTick.get(t).missing ? ' (' + byTick.get(t).missing + ' missing)' : '') : 'n/a'),
      t95Text(entry.time_curve.t95)];
  });
  return ['### Score over time', '',
    '| ' + head.map(cell).join(' | ') + ' |', '|' + head.map((_, i) => i ? ' ---: |' : ' --- |').join(''), ...rows.map(row => '| ' + row.map(cell).join(' | ') + ' |'), '',
    'Mean score at each tick (minutes after the CLI started), from snapshots of output/model.glb: an attempt counts its final score once ended, before that its last snapshot\'s score ' +
      '(left out as missing when the scorer failed on that snapshot); ' +
      'averaged like the score, so the last column is the leaderboard score. 95% of final: median minutes to the first snapshot at 95% of an attempt\'s final score (final ≥ 10).', ''].join('\n');
}
