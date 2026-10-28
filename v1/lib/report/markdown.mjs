import { VARIANTS } from '../contract.mjs';
import { intervalText, signedText, attemptShareText, VARIANT_ORDER, CONFLICT_KINDS } from './aggregate.mjs';
import { fractionLabel } from './html.mjs';
import { timeMarkdown } from './time-chart.mjs';

// summary.md: the same numbers as index.html in plain Markdown, to paste into
// a document. Tables use GitHub pipe syntax; nothing links back to the site.

const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const fixed = (value, digits = 1, signed = false) => isNumber(value) ? (signed ? signedText(value, digits) : value.toFixed(digits)) : 'n/a';
const ci = (interval, digits = 1, signed = false) => interval ? '[' + fixed(interval[0], digits, signed) + ', ' + fixed(interval[1], digits, signed) + ']' : 'no interval';
const plural = (count, word) => count + ' ' + word + (count === 1 ? '' : 's');

// The first `left` columns hold names and are left-aligned; the rest are numbers.
function table(head, rows, left = 1) {
  return ['| ' + head.map(cell).join(' | ') + ' |', '|' + head.map((_, i) => i < left ? ' --- |' : ' ---: |').join(''), ...rows.map(row => '| ' + row.map(cell).join(' | ') + ' |')].join('\n');
}

// A summarised metric: "79.7 [77.1, 82.3]" plus a dagger below 3 objects.
const stat = (value, { digits = 1, signed = false, scale = 1, suffix = '' } = {}) => !value || !isNumber(value.mean) ? 'n/a'
  : fixed(value.mean * scale, digits, signed) + suffix + ' ' + (value.ci95 ? ci(value.ci95.map(bound => bound * scale), digits, signed) : '(no interval)') + (value.low_evidence ? ' †' : '');

const verdicts = { a_higher: 'A higher', b_higher: 'B higher', not_separated: 'not separated', unsettled: 'unsettled', not_evaluated: 'not evaluated' };

function setMarkdown(board, set) {
  const entries = board.entries.filter(entry => entry.set === set.id);
  const lines = ['## Set: ' + set.id, ''];
  if (set.description?.text) lines.push((set.description.development ? '**Not test results.** ' : '') + set.description.text, '');
  lines.push(plural(set.objects, 'object') + ', ' + plural(set.tasks, 'task') + ', ' + set.counted + ' of ' + plural(set.attempts, 'attempt') + ' counted, batches ' +
    set.batches.join(', ') + (set.first_started_at ? '; attempts ran ' + set.first_started_at + ' to ' + set.last_finished_at : '') + '.', '');
  for (const warning of set.warnings) lines.push('> Warning: ' + warning, '');

  const variants = VARIANT_ORDER.filter(variant => entries.some(entry => entry.variants[variant]));
  lines.push('### Leaderboard', '', table(['#', 'Configuration', 'Score', ...variants, 'Shape', 'Detail', 'Success'],
    entries.map(entry => [entry.rank, entry.key, stat(entry.score), ...variants.map(variant => stat(entry.variants[variant])), stat(entry.shape), stat(entry.detail),
      entry.success.valid + ' / ' + entry.success.attempts]), 2), '');
  lines.push('Mean over objects with a 95% bootstrap interval over objects; attempts averaged within a task, tasks within an object; failures count as 0. † fewer than 3 objects.', '');
  if (set.unranked.length) lines.push('Not ranked (every attempt excluded): ' + set.unranked.map(item => item.key + ' (' + item.excluded_attempts + ')').join(', ') + '.', '');

  const pairs = set.pairwise.pairs;
  lines.push('### Pairwise comparison', '');
  if (pairs.length) {
    lines.push(table(['A', 'B', 'Objects', 'A − B', '95% bootstrap', '95% Student-t', 'A ahead', 'Won / tied / lost', 'Verdict'],
      pairs.map(pair => [pair.a, pair.b, pair.objects, fixed(pair.mean_difference, 1, true), pair.ci95 ? intervalText(pair.ci95) : 'n/a', pair.t_ci95 ? intervalText(pair.t_ci95) : 'n/a',
        isNumber(pair.share_a_higher) ? (100 * pair.share_a_higher).toFixed(pair.share_a_higher > 0.99 && pair.share_a_higher < 1 ? 2 : 0) + '%' : 'n/a',
        pair.won + ' / ' + pair.tied + ' / ' + pair.lost, verdicts[pair.verdict] ?? pair.verdict]), 2), '');
    for (const pair of pairs) lines.push('- ' + pair.statement);
    lines.push('');
    if (set.pairwise.multiple_comparisons) lines.push(set.pairwise.multiple_comparisons, '');
  } else lines.push('Fewer than two ranked configurations; nothing to compare.', '');

  const variance = set.variance;
  if (variance) {
    lines.push('### Where the noise is', '');
    if (variance.summary) lines.push(variance.summary, '');
    const sd = entry => !entry || !isNumber(entry.sd) ? 'n/a' : fixed(entry.sd) + ' (' + entry.df + ' df' + (entry.ci95 ? ', 95% range ' + fixed(entry.ci95[0]) + '–' + fixed(entry.ci95[1]) : '') + ')' + (entry.little_data ? ' ‡' : '');
    lines.push(table(['Configuration', 'Attempts per task', 'Between attempts (SD)', 'Between objects (SD)'],
      variance.configurations.map(item => [item.key, item.attempts_per_task.min === item.attempts_per_task.max ? item.attempts_per_task.min : item.attempts_per_task.min + '–' + item.attempts_per_task.max,
        item.attempt_sd.df ? sd(item.attempt_sd) : 'n/a (no task run twice)', sd(item.object_sd)])), '');
    if (variance.pairs.length) {
      const projected = variance.pairs.some(row => row.projected);
      lines.push(table(['A', 'B', 'Objects', 'SD of paired differences', 'Resolution (95%)', 'Detectable (80% power)', ...(projected ? ['At ' + variance.planned_objects + ' objects'] : []), 'Attempt noise share'],
        variance.pairs.map(row => [row.a, row.b, row.objects, sd(row.difference_sd), fixed(row.resolution),
          fixed(row.detectable) + (row.detectable_range ? ' (' + fixed(row.detectable_range[0]) + '–' + fixed(row.detectable_range[1]) + ')' : ''),
          ...(projected ? [row.projected ? fixed(row.projected.resolution) + ' / ' + fixed(row.projected.detectable) + (row.projected.detectable_range ? ' (' + fixed(row.projected.detectable_range[0]) + '–' + fixed(row.projected.detectable_range[1]) + ')' : '') : 'n/a'] : []),
          attemptShareText(row.attempt_share) ?? attemptShareText(row.attempt_share_at_least, { atLeast: true }) ?? 'not estimable']), 2), '');
      for (const row of variance.pairs) lines.push('- ' + row.statement);
      lines.push('');
    }
    lines.push('Resolution: an observed mean difference must exceed it for the 95% t interval to exclude zero. Detectable: true difference found about 80% of the time (two-sided 95% t test), ' +
      'taking the estimated SD as true; the range in brackets comes from the SD\'s own uncertainty. ‡ fewer than ' + variance.little_data_df + ' degrees of freedom.', '');
  }

  if (set.variant_pairs?.length) {
    lines.push('### Evidence deltas (paired by object)', '', table(['Configuration', ...set.variant_pairs.map(key => key.replace('-', ' − '))],
      entries.map(entry => [entry.key, ...set.variant_pairs.map(key => {
        const delta = entry.evidence_deltas?.[key];
        return !delta || !isNumber(delta.mean) ? 'n/a' : stat(delta, { signed: true }) + ' t ' + (delta.t_ci95 ? intervalText(delta.t_ci95) : 'n/a') + ', ' + plural(delta.pairs, 'object');
      })])), '');
  }
  if (set.archetypes?.length) {
    lines.push('### By archetype', '', table(['Configuration', ...set.archetypes.map(item => item.id + ' (' + plural(item.objects, 'object') + ')')],
      entries.map(entry => [entry.key, ...set.archetypes.map(item => stat(entry.archetypes?.[item.id]))])), '');
  }
  // Memory tasks (m2, m3) get their own column, and a line on what it means, only in a set that has them.
  const memory = (set.variants ?? []).some(variant => CONFLICT_KINDS.find(kind => kind.id === 'memory').variants.includes(variant));
  lines.push('### Conflict and frame', '', table(['Configuration', 'Conflict (closer to photographed)', ...(memory ? ['Memory (closer to the evidence)'] : []), 'Frame offset', 'Scale error (metric tasks)'],
    entries.map(entry => [entry.key, stat(entry.conflict, { scale: 100, digits: 0, suffix: '%' }), ...(memory ? [stat(entry.memory, { scale: 100, digits: 0, suffix: '%' })] : []),
      stat(entry.frame_error.offset_fraction, { scale: 100, suffix: '%' }), stat(entry.scale_error_pct, { suffix: '%' })])), '');
  if (memory) {
    lines.push('Memory: on m2 / m3 tasks (a named landmark whose surveyed proportions differ from its published figures), the share of contested probes closer to the ' +
      'surveyed object the evidence shows than to the structure as published; low means the model built what it remembered.', '');
  }
  const time = timeMarkdown(entries);
  if (time) lines.push(time);
  return lines.join('\n');
}

// Which scorer computed the numbers, from the stamps in the reports.
function scorerLine(batches) {
  const hashes = [...new Set(batches.flatMap(batch => batch.scorer_sha256 ?? []))];
  const versions = [...new Set(batches.flatMap(batch => batch.scorer_versions ?? []))];
  const unstamped = batches.reduce((sum, batch) => sum + (batch.reports_unstamped ?? 0), 0);
  const rescored = batches.reduce((sum, batch) => sum + (batch.rescored ?? 0), 0);
  const verb = (count, singular, many) => plural(count, 'report') + (count === 1 ? singular : many);
  const tail = (unstamped && hashes.length ? '; ' + verb(unstamped, ' carries no stamp', ' carry no stamp') : '') +
    (rescored ? '; ' + verb(rescored, ' was recomputed by rescore', ' were recomputed by rescore') : '');
  if (!hashes.length) return 'Scorer: no report carries a scorer stamp, so which scorer computed these numbers is not recorded' + tail + '.';
  return 'Scorer stamped in the reports: ' + (versions.length ? 'version ' + versions.join(', ') + ', ' : '') + hashes.map(hash => hash.slice(0, 12)).join(', ') +
    (hashes.length > 1 ? ' (MORE THAN ONE SCORER)' : '') + tail + '.';
}

export function summaryMarkdown(board) {
  const tolerances = board.tolerances;
  const caveats = [
    'Task sets are never pooled. The dev set\'s objects were used to tune the scorer: its numbers are development measurements, not test results.',
    'Pairwise intervals are not corrected for multiple comparisons; a pair counts as separated only when the bootstrap and the Student-t interval both exclude zero.',
    'Failures (no valid model) count as 0; ' + plural(board.excluded.length, 'attempt') + ' with status ' + board.method.excluded_statuses.join(', ') +
      ' ' + (board.excluded.length === 1 ? 'was left out: it is not a sample.' : 'were left out: they are not samples.'),
    'Tolerance rows in the reports: ' + (tolerances.fractions.length ? tolerances.fractions.map(fractionLabel).join(', ') : 'none') + '; rows entering the shape score: ' +
      (tolerances.shape_score_fractions ? tolerances.shape_score_fractions.map(fractionLabel).join(', ') || 'none' : 'not stated by the reports') + (tolerances.consistent ? '' : ' (not the same in every report)') + '.',
    scorerLine(board.batches),
    ...(board.problems.length ? [plural(board.problems.length, 'data problem') + ' listed in index.html and leaderboard.json.'] : []),
  ];
  const batches = board.batches.length ? ['## Batches', '', table(['Batch', 'Set', 'Configuration', 'CLI', 'Counted', 'Excluded', 'Ran'],
    board.batches.map(batch => [batch.id, batch.sets.join(', ') || 'n/a', batch.configurations.join('; ') || 'n/a', batch.manifest?.cli_version ?? 'n/a',
      batch.counted + ' / ' + batch.attempts, batch.excluded + (batch.unfinished ? ' (+' + batch.unfinished + ' unfinished)' : ''),
      (batch.first_started_at ?? 'n/a') + ' to ' + (batch.last_finished_at ?? 'n/a')]), 4), ''] : [];
  return ['# Evidence3D results', '',
    'Protocol ' + board.protocol + ', generated ' + board.generated_at + '. ' + plural(board.sets.length, 'task set') + ', ' + plural(board.tasks.length, 'task') + '. Variants: ' +
      VARIANT_ORDER.filter(variant => board.tasks.some(task => task.variant === variant)).map(variant => variant + ' (' + VARIANTS[variant].title.toLowerCase() + ')').join('; ') + '.', '',
    ...board.sets.map(set => setMarkdown(board, set)),
    ...batches,
    '## Caveats', '', ...caveats.map(line => '- ' + line), ''].join('\n');
}
