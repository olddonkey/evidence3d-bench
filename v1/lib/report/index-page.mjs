import { VARIANTS } from '../contract.mjs';
import { UNNAMED_SET, UNKNOWN_SET } from './collect.mjs';
import { intervalText, attemptShareText, VARIANT_ORDER, CONFLICT_KINDS } from './aggregate.mjs';
import { esc, num, percent, statCell, sdCell, slug, fractionLabel, page, NOT_EVALUATED } from './html.mjs';

// index.html: per task set the leaderboard, the pairwise comparison, where the
// noise is, the breakdowns and the task index; then provenance, excluded
// attempts and data problems.

const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const plural = (count, word) => count + ' ' + word + (count === 1 ? '' : 's');

// ------------------------------------------------------------ leaderboard

const identityHead = '<th class="num">#</th><th>System</th><th>Model</th><th>Effort</th>';
const identity = (entry, index) => '<td class="num">' + (entry.rank ?? index + 1) + '</td><td>' + esc(entry.system) + '</td><td>' + esc(entry.model) + '</td><td>' +
  (entry.effort === null ? NOT_EVALUATED : esc(entry.effort)) + '</td>';

// One row per configuration of the set, `cells(entry)` giving the rest.
function entryTable(entries, head, cells) {
  return '<div class="scroll"><table><thead><tr>' + identityHead + head + '</tr></thead><tbody>' +
    (entries.length ? entries.map((entry, index) => '<tr>' + identity(entry, index) + cells(entry).join('') + '</tr>').join('\n')
      : '<tr><td colspan="99" class="muted">No scored attempts.</td></tr>') + '</tbody></table></div>';
}

function scoreTable(entries) {
  const variants = VARIANT_ORDER.filter(variant => entries.some(entry => entry.variants[variant]));
  return entryTable(entries,
    '<th class="num">Score</th>' + variants.map(variant => '<th class="num" title="' + esc(VARIANTS[variant].title) + '">' + variant + '</th>').join('') +
      '<th class="num" title="overall surface agreement: the scorer&rsquo;s shape_score (mean F over its shape tolerance rows)">Shape</th><th class="num" title="small features, scored group by group">Detail</th>' +
      '<th class="num" title="attempts with a valid score report">Success</th>',
    entry => [
      statCell(entry.score),
      ...variants.map(variant => statCell(entry.variants[variant])),
      statCell(entry.shape),
      statCell(entry.detail),
      '<td class="num">' + percent(entry.success.rate) + '<small>' + entry.success.valid + ' / ' + entry.success.attempts + ' att.</small></td>',
    ]);
}

// Memory tasks get their own column only in a set that has them.
const hasMemory = set => (set.variants ?? []).some(variant => CONFLICT_KINDS.find(kind => kind.id === 'memory').variants.includes(variant));

function diagnosticsTable(entries, set) {
  const memory = hasMemory(set);
  return entryTable(entries,
    '<th class="num" title="share of contested probes closer to the as-photographed state">Conflict</th>' +
      (memory ? '<th class="num" title="memory tasks: share of contested probes closer to the surveyed object the evidence shows than to the published figures">Memory</th>' : '') +
      '<th class="num" title="alignment offset as % of the truth diagonal">Frame offset</th><th class="num" title="absolute alignment yaw">Frame yaw</th>' +
      '<th class="num" title="|fitted scale - 1| on metric tasks">Scale error</th><th class="num">Median wall</th><th class="num">Tokens / att.</th><th class="num">Cost / att.</th>',
    entry => [
      statCell(entry.conflict, { scale: 100, digits: 0, suffix: '%' }),
      ...(memory ? [statCell(entry.memory, { scale: 100, digits: 0, suffix: '%' })] : []),
      statCell(entry.frame_error.offset_fraction, { scale: 100, digits: 1, suffix: '%' }),
      statCell(entry.frame_error.yaw_deg, { digits: 1, suffix: '°' }),
      statCell(entry.scale_error_pct, { digits: 1, suffix: '%' }),
      '<td class="num">' + (isNumber(entry.wall_seconds.median) ? num(entry.wall_seconds.median / 60, 1, { suffix: ' min' }) : NOT_EVALUATED) +
        '<small>n = ' + entry.wall_seconds.attempts + '</small></td>',
      '<td class="num">' + (isNumber(entry.tokens.mean_total) ? esc(Math.round(entry.tokens.mean_total).toLocaleString('en-US')) : NOT_EVALUATED) +
        '<small>' + entry.tokens.attempts_reporting + ' / ' + entry.tokens.attempts + ' reported</small></td>',
      '<td class="num">' + (isNumber(entry.cost_usd.mean) ? num(entry.cost_usd.mean, 2, { suffix: ' $' }) : NOT_EVALUATED) +
        '<small>' + entry.cost_usd.attempts_reporting + ' / ' + entry.attempts + ' reported</small></td>',
    ]);
}

// Every pair of variants present in the set, paired by object.
function deltaTable(entries, set) {
  if (!set.variant_pairs?.length) return '<p class="muted">Only one variant in this set; no evidence deltas.</p>';
  return entryTable(entries,
    set.variant_pairs.map(key => {
      const [high, low] = key.split('-');
      return '<th class="num" title="per object: mean score on ' + esc(high) + ' minus mean score on ' + esc(low) + '">' + esc(high) + ' &minus; ' + esc(low) + '</th>';
    }).join(''),
    entry => set.variant_pairs.map(key => {
      const delta = entry.evidence_deltas?.[key];
      const t = delta?.t_ci95 ? '<small title="Student-t interval of the per-object deltas">t ' + esc(intervalText(delta.t_ci95)) + '</small>' : '';
      return statCell(delta, { signed: true, unit: 'pairs', extra: t });
    }));
}

function archetypeTable(entries, set) {
  if (!set.archetypes?.length) return '<p class="muted">No archetypes recorded.</p>';
  return entryTable(entries,
    set.archetypes.map(item => '<th class="num">' + esc(item.id) + '<small>' + plural(item.objects, 'object') + '</small></th>').join(''),
    entry => set.archetypes.map(item => statCell(entry.archetypes?.[item.id])));
}

// ---------------------------------------------------------------- pairwise

const verdictText = { a_higher: 'A higher', b_higher: 'B higher', not_separated: 'not separated', unsettled: 'unsettled', not_evaluated: 'not evaluated' };
const verdictNote = { a_higher: 'both intervals exclude 0', b_higher: 'both intervals exclude 0', not_separated: 'both intervals include 0',
  unsettled: 'the two intervals disagree', not_evaluated: 'fewer than 2 objects' };
export const VERDICT_TEXT = verdictText;

function pairwiseSection(set) {
  const pairs = set.pairwise.pairs;
  if (!pairs.length) return '<p class="muted">Fewer than two ranked configurations in this set; nothing to compare.</p>';
  // Same wording as the statements: a bound that rounds to zero keeps a digit.
  const interval = ci => ci ? esc(intervalText(ci)) : NOT_EVALUATED;
  const rows = pairs.map(pair => {
    const verdictClass = pair.verdict === 'a_higher' || pair.verdict === 'b_higher' ? 'good' : pair.verdict === 'unsettled' ? 'low' : 'na';
    const small = pair.t_ci95 ? '<small title="Student-t interval of the per-object differences">t ' + interval(pair.t_ci95) + '</small>' : '';
    return '<tr><td>' + esc(pair.a) + '</td><td>' + esc(pair.b) + '</td>' +
      '<td class="num">' + pair.objects + '<small>' + pair.tasks + ' tasks' + (pair.unpaired_objects ? ' · ' + pair.unpaired_objects + ' obj. unpaired' : '') +
        (pair.unpaired_tasks ? ' · ' + plural(pair.unpaired_tasks, 'task') + ' unpaired' : '') + '</small></td>' +
      '<td class="num' + (pair.low_evidence ? ' low' : '') + '"><strong>' + num(pair.mean_difference, 1, { signed: true }) + '</strong>' + (pair.low_evidence ? '<span class="dagger">&dagger;</span>' : '') + '</td>' +
      '<td class="num">' + interval(pair.ci95) + small + '</td>' +
      '<td class="num">' + (pair.share_a_higher === null ? NOT_EVALUATED : percent(pair.share_a_higher, pair.share_a_higher > 0.99 && pair.share_a_higher < 1 ? 2 : 0)) + '</td>' +
      '<td class="num">' + pair.won + ' / ' + pair.tied + ' / ' + pair.lost + '</td>' +
      '<td class="' + verdictClass + '">' + esc(verdictText[pair.verdict] ?? pair.verdict) + '<small>' + esc(verdictNote[pair.verdict] ?? '') +
        (pair.small_sample && pair.verdict !== 'not_evaluated' ? '; only ' + pair.objects + ' objects' : '') + '</small></td></tr>';
  });
  const table = '<div class="scroll"><table><thead><tr><th>A</th><th>B</th><th class="num" title="objects with at least one task run by both">Objects</th>' +
    '<th class="num" title="mean over objects of (A - B); per object, attempts are averaged within a task and tasks within the object">A &minus; B</th>' +
    '<th class="num" title="95% percentile bootstrap over objects; below it the Student-t interval">95% interval<small>bootstrap / t</small></th><th class="num" title="share of bootstrap resamples in which A&rsquo;s mean is higher; not a p-value">A ahead</th>' +
    '<th class="num" title="objects on which A scored higher / the same / lower">Won / tied / lost</th><th>Verdict</th></tr></thead><tbody>' + rows.join('\n') + '</tbody></table></div>';
  const words = '<ul class="statements">' + pairs.map(pair => '<li>' + esc(pair.statement) + '</li>').join('') + '</ul>';
  return table + words + '<p class="legend">A is the higher-ranked configuration of each pair. Each object counts once: on the tasks both configurations ran, ' +
    'attempts are averaged within a task and tasks within the object, then B is subtracted from A. The interval resamples objects (paired); ' +
    '&ldquo;A ahead&rdquo; is the share of resamples with a positive mean difference, a description of this sample, not a probability that A is better. ' +
    (set.pairwise.multiple_comparisons ? esc(set.pairwise.multiple_comparisons) + ' ' : '') +
    'Both a bootstrap and a Student-t interval are given: the bootstrap runs narrow with few objects (on synthetic data it covered the true difference 84% of the time with 5 objects, 93% with 24), ' +
    'so a pair counts as separated only when both exclude zero and as unsettled when they disagree.</p>';
}

// ---------------------------------------------------------------- variance

function varianceSection(set) {
  const variance = set.variance;
  if (!variance) return '';
  const configurations = '<div class="scroll"><table><thead><tr><th>Configuration</th><th class="num">Attempts per task</th>' +
    '<th class="num" title="pooled standard deviation between attempts on the same task (tasks with at least two counted attempts)">Between attempts<small>SD, same task</small></th>' +
    '<th class="num" title="standard deviation of the per-object mean scores">Between objects<small>SD of object means</small></th>' +
    '<th class="num" title="share of the between-object variance that attempt noise alone would produce">Attempt noise in it</th></tr></thead><tbody>' +
    variance.configurations.map(item => {
      const range = item.attempts_per_task.min === item.attempts_per_task.max ? String(item.attempts_per_task.min) : item.attempts_per_task.min + '&ndash;' + item.attempts_per_task.max;
      const attempt = item.attempt_sd;
      const note = attempt.df ? plural(attempt.tasks, 'task') + (attempt.failures ? ', ' + plural(attempt.failures, 'failure') + ' (0)' : '') : 'no task run twice';
      return '<tr><td>' + esc(item.key) + '</td><td class="num">' + range + '</td>' + sdCell(attempt, { note }) +
        sdCell(item.object_sd, { note: plural(item.object_sd.objects, 'object') }) +
        '<td class="num">' + (isNumber(item.object_sd.attempt_share) ? esc(attemptShareText(item.object_sd.attempt_share)) : NOT_EVALUATED) + '</td></tr>';
    }).join('\n') + '</tbody></table></div>';
  const planned = variance.planned_objects;
  const projectedHead = variance.pairs.some(row => row.projected) ? '<th class="num" title="same SD, same attempts and tasks per object">At ' + planned + ' objects<small>resolution / detectable</small></th>' : '';
  const pairs = variance.pairs.length ? '<div class="scroll"><table><thead><tr><th>A</th><th>B</th><th class="num">Objects</th>' +
    '<th class="num" title="standard deviation of the per-object differences A - B">Paired difference<small>SD over objects</small></th>' +
    '<th class="num" title="half-width of the 95% t interval: the smallest observed mean difference whose interval excludes zero">Resolution<small>95% half-width</small></th>' +
    '<th class="num" title="true difference found with 80% probability by a two-sided 95% t test; range from the SD&rsquo;s own uncertainty">Detectable<small>80% power</small></th>' +
    projectedHead + '<th class="num" title="share of the variance of the per-object differences due to attempt noise">Attempt noise</th></tr></thead><tbody>' +
    variance.pairs.map(row => {
      const range = row.detectable_range ? '<small>' + num(row.detectable_range[0], 1) + '&ndash;' + num(row.detectable_range[1], 1) + '</small>' : '';
      const projected = projectedHead ? '<td class="num">' + (row.projected ? num(row.projected.resolution, 1) + ' / ' + num(row.projected.detectable, 1) +
        (row.projected.detectable_range ? '<small>' + num(row.projected.detectable_range[0], 1) + '&ndash;' + num(row.projected.detectable_range[1], 1) + '</small>' : '') : NOT_EVALUATED) + '</td>' : '';
      const share = isNumber(row.attempt_share) ? esc(attemptShareText(row.attempt_share)) : isNumber(row.attempt_share_at_least) ? esc(attemptShareText(row.attempt_share_at_least, { atLeast: true }))
        : '<span class="na">not estimable</span>';
      return '<tr><td>' + esc(row.a) + '</td><td>' + esc(row.b) + '</td><td class="num">' + row.objects + '</td>' + sdCell(row.difference_sd) +
        '<td class="num">' + num(row.resolution, 1) + '</td><td class="num' + (row.difference_sd.little_data ? ' low' : '') + '">' + num(row.detectable, 1) + range + '</td>' +
        projected + '<td class="num">' + share + '</td></tr>';
    }).join('\n') + '</tbody></table></div>' +
    // The table carries the numbers; the sentences repeat them per pair, so they are folded.
    '<details class="more"><summary>The same per pair, in words</summary><ul class="statements">' + variance.pairs.map(row => '<li>' + esc(row.statement) + '</li>').join('') + '</ul></details>' : '';
  return (variance.summary ? '<p>' + esc(variance.summary) + '</p>' : '') + configurations + pairs +
    '<p class="legend">All on report.score, failures as 0, excluded attempts left out. <strong>Between attempts</strong>: standard deviation of repeated attempts on the same task, ' +
    'pooled over every task a configuration ran at least twice. <strong>Between objects</strong>: standard deviation of a configuration&rsquo;s per-object mean scores, ' +
    'which its own leaderboard interval resamples. <strong>Paired difference</strong>: standard deviation of the per-object differences of a pair, which the pairwise interval resamples; ' +
    'pairing removes whatever makes an object easy or hard for both. <strong>Resolution</strong>: an observed difference must exceed this for its t interval to exclude zero. ' +
    '<strong>Detectable</strong>: a true difference of this size would be found about 80% of the time (two-sided 95% t test), taking the estimated SD as true; ' +
    'the small range under it comes from the SD&rsquo;s own uncertainty. Projections to ' + planned + ' objects keep the attempts and tasks per object. ' +
    '95% ranges of an SD assume roughly normal noise (chi-square); <span class="low">&Dagger; little data: fewer than ' + variance.little_data_df + ' degrees of freedom.</span></p>';
}

// ------------------------------------------------------------- provenance

const shortHash = value => value ? '<code title="' + esc(value) + '">' + esc(value.slice(0, 12)) + '</code>' : NOT_EVALUATED;
const hashes = values => values?.length ? values.map(shortHash).join(' ') : NOT_EVALUATED;
export const day = value => value ? esc(value.replace('T', ' ').replace(/\.\d+Z$/, 'Z')) : NOT_EVALUATED;

// One column per batch, one row per fact, so a reader can scan a row for the
// batch that differs. Batches are ordered by set, then configuration; within a
// configuration that merges several batches, a fact that differs between them
// is marked.
function provenanceTable(board) {
  if (!board.batches.length) return '<p class="muted">No batches.</p>';
  const setOrder = id => { const index = board.sets.findIndex(set => set.id === id); return index < 0 ? Infinity : index; };
  const rankOf = batch => Math.min(...board.entries.filter(entry => entry.batches.includes(batch.id)).map(entry => setOrder(entry.set) * 1000 + entry.rank), Infinity);
  const batches = [...board.batches].sort((a, b) => rankOf(a) - rankOf(b) || a.id.localeCompare(b.id));
  // What computed the numbers: the stamp in each report (after any rescore).
  const scorer = batch => {
    const versions = batch.scorer_versions?.length ? '<small>version ' + batch.scorer_versions.map(esc).join(', ') + '</small>' : '';
    const unstamped = batch.reports_unstamped ? '<small class="bad">' + plural(batch.reports_unstamped, 'report') + ' without a stamp</small>' : '';
    const rescored = batch.rescored ? '<small>' + plural(batch.rescored, 'report') + ' recomputed by rescore</small>' : '';
    const frozen = batch.manifest?.scorer_stamp_sha256 ? (batch.reports_off_manifest
      ? '<small class="bad">' + plural(batch.reports_off_manifest, 'report') + ' not by the scorer frozen in the manifest</small>' : '<small>all match the scorer frozen in the manifest</small>') : '';
    if (batch.scorer_sha256.length) return hashes(batch.scorer_sha256) + versions + frozen + unstamped + rescored;
    return '<span class="na">not recorded</span>' + versions + rescored;
  };
  // What the runner froze at prepare time; another hash scheme, never compared with the stamp.
  const scorerSource = batch => batch.manifest?.scorer_sha256
    ? shortHash(batch.manifest.scorer_sha256) + (batch.manifest.scorer_version ? '<small>version ' + esc(batch.manifest.scorer_version) + '</small>' : '')
    : '<span class="na">not recorded</span>';
  const facts = [
    ['Set', batch => batch.sets.length ? batch.sets.map(esc).join(', ') : '<span class="na">no attempts</span>'],
    ['Configuration', batch => batch.configurations.length ? batch.configurations.map(esc).join('<br>') : NOT_EVALUATED],
    ['Model reported by the harness', batch => batch.models_reported.length ? batch.models_reported.map(esc).join(', ') : '<span class="na">not reported</span>'],
    ['CLI version', batch => batch.manifest?.cli_version ? esc(batch.manifest.cli_version) : NOT_EVALUATED, 'cli_version'],
    ['CLI binary', batch => shortHash(batch.manifest?.cli_sha256) + (batch.manifest?.login ? '<small>login ' + esc(batch.manifest.login) + '</small>' : ''), 'cli_sha256'],
    ['Runner', batch => batch.manifest?.runner ? esc(batch.manifest.runner) : NOT_EVALUATED],
    ['Runner source', batch => shortHash(batch.manifest?.runner_sha256), 'runner_sha256'],
    ['Prompt', batch => (batch.manifest?.prompt_version ? esc(batch.manifest.prompt_version) : NOT_EVALUATED) + '<small>' + hashes(batch.manifest?.prompt_sha256) + '</small>', 'prompt_sha256'],
    ['Contestant tool kit', batch => shortHash(batch.manifest?.tools_sha256), 'tools_sha256'],
    ['Runtime', batch => (batch.manifest?.runtime ? esc(batch.manifest.runtime) + ' ' : '') + shortHash(batch.manifest?.runtime_sha256) +
      (batch.manifest?.node_version ? '<small>node ' + esc(batch.manifest.node_version) + '</small>' : ''), 'runtime_sha256'],
    ['Scorer <small>stamped in the reports</small>', scorer, 'scorer'],
    ['Scorer source <small>frozen in the manifest</small>', scorerSource, 'scorer_source'],
    ['Generator source', batch => shortHash(batch.manifest?.generator_sha256)],
    ['Protocol', batch => (batch.manifest?.protocol ? esc(batch.manifest.protocol) : NOT_EVALUATED) +
      (batch.report_protocols.length ? '<small>reports: ' + batch.report_protocols.map(esc).join(', ') + '</small>' : ''), 'protocol'],
    ['Repository', batch => batch.manifest?.repository_commit ? shortHash(batch.manifest.repository_commit) + (batch.manifest.repository_dirty ? '<small class="low">dirty tree</small>' : '') : NOT_EVALUATED],
    ['Isolation preflight', batch => !batch.preflight ? '<span class="bad">no preflight.json</span>'
      : (batch.preflight.passed ? '<span class="good">passed</span>' : '<span class="bad">not passed</span>') +
        (batch.preflight.bound_to_manifest === false ? '<small class="bad">verdict is for another manifest</small>' : batch.preflight.bound_to_manifest ? '<small>bound to this manifest</small>' : '')],
    ['Attempts counted', batch => batch.counted + ' of ' + batch.attempts + (batch.manifest?.attempts_per_task ? '<small>' + batch.manifest.attempts_per_task + ' per task planned</small>' : '') +
      (batch.excluded ? '<small>' + batch.excluded + ' excluded</small>' : '') + (batch.unfinished ? '<small class="bad">' + batch.unfinished + ' without result.json</small>' : '') +
      (batch.infra_retries ? '<small>' + plural(batch.infra_retries, 'earlier try') + ' archived after infra_error</small>' : '')],
    ['Statuses', batch => Object.entries(batch.status_counts ?? {}).map(([status, count]) => esc(status) + ' ' + count).join('<br>') || NOT_EVALUATED],
    ['Attempts ran', batch => day(batch.first_started_at) + '<small>to ' + day(batch.last_finished_at) + '</small>'],
    ['Prepared', batch => day(batch.manifest?.created_at)],
  ];
  const flagged = new Set();
  for (const entry of board.entries) for (const conflict of entry.provenance_conflicts ?? []) for (const batch of Object.keys(conflict.values)) flagged.add(conflict.field + '|' + batch);
  const rows = facts.map(([label, cell, field]) => '<tr><th>' + label + '</th>' + batches.map(batch => {
    const differs = field && flagged.has(field + '|' + batch.id);
    return '<td' + (differs ? ' class="differs" title="differs between batches of the same configuration"' : '') + '>' + cell(batch) + '</td>';
  }).join('') + '</tr>');
  return '<div class="scroll"><table class="provenance"><thead><tr><th>Batch</th>' + batches.map(batch => '<th><code>' + esc(batch.id) + '</code></th>').join('') +
    '</tr></thead><tbody>' + rows.join('\n') + '</tbody></table></div>' +
    '<p class="legend">As frozen in each batch&rsquo;s manifest.json at prepare time, plus what the attempts themselves recorded (reported model, start and finish times, the scorer stamped into each report). ' +
    'The scorer stamp (scorer version.mjs) and the manifest&rsquo;s scorer source (runner) hash the same code by different schemes, so they never match each other; each is compared only across batches. ' +
    'Hashes are shortened; hover for the full value. A highlighted cell differs between batches merged into one configuration. ' +
    '<span class="na">n/a</span> and &ldquo;not recorded&rdquo; mean the field is absent, never that it matched.</p>';
}

function taskIndexTable(entries, tasks) {
  const keys = entries.map(entry => entry.key);
  const head = '<th>Task</th><th>Object</th><th>Archetype</th><th>Variant</th><th>Scale</th>' + keys.map(key => '<th class="num">' + esc(key) + '</th>').join('');
  const rows = tasks.map(task => {
    const cells = keys.map(key => {
      const cell = task.cells[key];
      if (!cell) return '<td class="num"><span class="na">not run</span></td>';
      const detail = cell.attempts.map(attempt => attempt.excluded ? 'excl.' : attempt.valid ? num(attempt.score, 1) : '<span class="bad" title="' + esc(attempt.failure) + '">fail</span>').join(' · ');
      return '<td class="num">' + num(cell.mean, 1) + '<small>' + detail + '</small></td>';
    });
    return '<tr><td><a href="tasks/' + esc(slug(task.task_id)) + '.html">' + esc(task.task_id) + '</a></td><td>' + esc(task.object) + '</td><td>' + esc(task.archetype ?? '') + '</td><td>' +
      esc(task.variant) + '</td><td>' + esc(task.scale_evidence) + '</td>' + cells.join('') + '</tr>';
  });
  return '<div class="scroll"><table><thead><tr>' + head + '</tr></thead><tbody>' + rows.join('\n') + '</tbody></table></div>';
}

const setAnchor = id => 'set-' + slug(id);
const shortValue = value => String(value).split(',').map(part => /^[a-f0-9]{40,64}$/.test(part) ? shortHash(part) : esc(part)).join(', ');
const withShortHashes = text => esc(text).replace(/\b[a-f0-9]{40,64}\b/g, match => shortHash(match));
const setTitle = set => set.id === UNNAMED_SET ? 'Set: unnamed <small>(truth.json names no set)</small>'
  : set.id === UNKNOWN_SET ? 'Set: unknown <small>(truth.json missing; kept apart from every named set)</small>' : 'Set: <code>' + esc(set.id) + '</code>';

function toleranceNote(tolerances) {
  if (!tolerances.fractions.length) return 'No tolerance rows in the reports.';
  const list = fractions => fractions.map(fractionLabel).join(', ');
  return 'Tolerance rows in these reports: ' + list(tolerances.fractions) + (tolerances.consistent ? '' : ' <span class="bad">(not the same in every report)</span>') +
    '; rows entering the shape score: ' + (tolerances.shape_score_fractions ? list(tolerances.shape_score_fractions) || 'none' : 'not stated by the reports') + '.';
}

// What the set is: development sets and tasks the build records place in one
// are flagged loudly, because their numbers are not test results.
function setNotice(set) {
  const description = set.description;
  if (!description) return '';
  const development = description.development === true;
  const file = description.set_file;
  const facts = file ? '<p><small>Set file <code>' + esc(file.file ?? 'not found') + '</code>' + (file.private === true ? ' (private)' : file.private === false ? ' (public)' : '') +
    (file.created_at ? ' · created ' + day(file.created_at) : '') + (file.built_at ? ' · built ' + day(file.built_at) : '') +
    (isNumber(file.objects_in_file) ? ' · ' + plural(file.objects_in_file, 'object') + ' in the file' : '') + '</small></p>' : '';
  return '<div class="notice' + (development ? ' dev' : ' plain') + '">' + (development ? '<strong>Not test results.</strong> ' : '') + esc(description.text) + facts + '</div>';
}

function setSection(board, set) {
  const entries = board.entries.filter(entry => entry.set === set.id), tasks = board.tasks.filter(task => task.set === set.id);
  const warnings = set.warnings.length ? '<div class="notice"><strong>Comparisons in this set may be unfair:</strong><ul>' +
    set.warnings.map(warning => '<li>' + withShortHashes(warning) + '</li>').join('') + '</ul></div>' : '';
  const merged = entries.filter(entry => entry.provenance_conflicts?.length);
  const mergedNote = merged.length ? '<div class="notice"><strong>Configurations merged from batches that differ:</strong><ul>' +
    merged.flatMap(entry => entry.provenance_conflicts.map(conflict => '<li>' + esc(entry.key) + ': ' + esc(conflict.label) + ' &mdash; ' +
      Object.entries(conflict.values).map(([batch, value]) => '<code>' + esc(batch) + '</code> ' + shortValue(value)).join('; ') + '</li>')).join('') + '</ul></div>' : '';
  const unranked = set.unranked.length ? '<p class="legend bad">Not ranked, every attempt excluded: ' +
    set.unranked.map(item => esc(item.key) + ' (' + item.excluded_attempts + ')').join(', ') + '.</p>' : '';
  const multi = entries.some(entry => entry.attempts_per_task.max > 1);
  return `<section id="${setAnchor(set.id)}">
<h2>${setTitle(set)}</h2>
${setNotice(set)}
<p class="muted">${plural(set.objects, 'object')} · ${plural(set.tasks, 'task')} · ${set.counted} of ${plural(set.attempts, 'attempt')} counted · ${plural(set.configurations.length, 'ranked configuration')} · batches ${set.batches.map(id => '<code>' + esc(id) + '</code>').join(', ')}${set.first_started_at ? ' · attempts ran ' + day(set.first_started_at) + ' to ' + day(set.last_finished_at) : ''}</p>
${warnings}${mergedNote}
<h3>Leaderboard</h3>
${scoreTable(entries)}
${unranked}
<p class="legend">Each cell: mean, 95% bootstrap interval over objects (variants of one object are not independent), and sample size.
<strong>Score</strong> = the scorer&rsquo;s report.score, (shape score + detail score) / 2; attempts that produced no valid model count as 0, as do their shape and detail scores.
${toleranceNote(set.tolerances)}
Attempts are averaged within a task and tasks within an object, so every object weighs the same however many attempts it has${multi ? ' (configurations here ran different numbers of attempts per task)' : ''}.
Overlapping leaderboard intervals do not mean two configurations are tied, nor do separate ones prove a difference: the pairwise table below is the comparison.
<span class="low">&dagger; low evidence: fewer than 3 objects.</span> <span class="na">n/a</span> means not evaluated or not reported, never zero.</p>
<h3>Pairwise comparison</h3>
${pairwiseSection(set)}
<h3>Where the noise is</h3>
${varianceSection(set)}
<h3>Evidence deltas</h3>
${deltaTable(entries, set)}
<p class="legend">Per object, the mean score on one variant minus the mean score on another, over objects that have both; every pair of variants in the set, not only adjacent rungs.
t4 &minus; t2 is what scaled drawings and survey notes add to photographs; c1 &minus; t4 what out-of-date drawings cost against current drawings and notes (c1 is t3 with stale drawings, so with t3 present c1 &minus; t3 is the cleaner contrast).
Variants are paired only within their family (generated objects t1&ndash;t4 and c1; named landmarks m2, m3; real buildings r2, r4): m3 &minus; m2 is what scaled drawings add on a named landmark.
Under each mean: the bootstrap interval, then the Student-t interval, which is the honest one at a handful of objects.</p>
<h3>By archetype</h3>
${archetypeTable(entries, set)}
<p class="legend">Mean score over the objects of each archetype (from the ground-truth model), same averaging as the leaderboard. With few objects per archetype these are descriptions, not comparisons.</p>
<h3>Evidence use, frame and cost</h3>
${diagnosticsTable(entries, set)}
<p class="legend"><strong>Conflict</strong>: on c1 tasks (drawings out of date), the share of contested probes closer to the as-photographed building.${hasMemory(set)
    ? '\n<strong>Memory</strong>: on m2 / m3 tasks (a named landmark whose surveyed proportions differ from its published figures), the share of contested probes closer to the surveyed object the evidence shows than to the structure as published; low means the model built what it remembered.' : ''}
Frame and scale errors use valid attempts only; scale error is |fitted scale &minus; 1| on metric tasks.
Tokens are input (including cached reads) + output as recorded in result.json; cost is whatever the harness reported (Claude Code: its list-price estimate) and stays n/a when not reported.</p>
<h3>Tasks</h3>
${taskIndexTable(entries, tasks)}
</section>`;
}

export function indexPage(board, { summaryFile = 'summary.md' } = {}) {
  const excluded = board.excluded.length
    ? '<h2>Excluded attempts</h2><p class="legend">Failures of the harness, the machine or the scorer (' + esc(board.method.excluded_statuses.join(', ')) +
      ') are not samples: they are left out of every mean and every comparison.</p><ul>' +
      board.excluded.map(item => '<li><code>' + esc(item.batch) + '/' + esc(item.task_id) + '/a' + item.attempt + '</code> ' + esc(item.cell) + ': ' + esc(item.status) + (item.reason ? ' (' + esc(item.reason) + ')' : '') +
        (board.sets.length > 1 ? ' <small>(set ' + esc(item.set) + ')</small>' : '') + '</li>').join('') + '</ul>'
    : '';
  const problems = board.problems.length
    ? '<h2>Data problems</h2><ul>' + board.problems.map(problem => '<li>' + withShortHashes(problem) + '</li>').join('') + '</ul>' : '';
  const sets = board.sets.length > 1
    ? 'This report covers ' + board.sets.length + ' task sets: ' + board.sets.map(set => '<a href="#' + setAnchor(set.id) + '">' + esc(set.id) + '</a>').join(', ') +
      '. Each set is ranked and compared on its own; no number on this page pools two sets.'
    : board.sets.length === 1 ? 'This report covers one task set.' : '';
  const body = `<h1>Evidence3D results</h1>
<p class="muted">Protocol ${esc(board.protocol)} · generated ${esc(board.generated_at)} · ${plural(board.sets.length, 'task set')} · ${plural(new Set(board.entries.map(entry => entry.key)).size, 'system configuration')} · ${plural(board.tasks.length, 'task')}</p>
<div class="notice plain"><p><strong>Task sets.</strong> Every task belongs to the set recorded in its truth.json: the group of objects it was built with.
The <code>dev</code> set&rsquo;s seeds are public and its objects were used to develop and tune the scorer, so its numbers are development measurements, not test results;
a private test set built after the scorer is frozen gives test results. ${sets}</p></div>
${board.sets.map(set => setSection(board, set)).join('\n')}
${board.sets.length ? '' : '<p class="muted">No attempts.</p>'}
<h2>Provenance</h2>
${provenanceTable(board)}
${excluded}
${problems}
<p class="legend">Machine-readable: <a href="leaderboard.json">leaderboard.json</a>. Plain text for documents: <a href="${esc(summaryFile)}">${esc(summaryFile)}</a>.</p>`;
  return page({ title: 'Evidence3D results', body, root: '.' });
}
