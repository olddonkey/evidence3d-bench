import { basename } from 'node:path';
import { VARIANTS } from '../contract.mjs';
import { UNNAMED_SET } from './collect.mjs';
import { cellKey, conflictShare, conflictKind, toleranceRows } from './aggregate.mjs';
import { esc, num, percent, fractionLabel, page, NOT_EVALUATED } from './html.mjs';

// One page per task: the evidence given, the ground truth next to each
// configuration's best, median and worst attempt (same cameras), the scorer's
// error maps for those, their numbers, and every other attempt collapsed.

const isNumber = value => typeof value === 'number' && Number.isFinite(value);
export const attemptLabel = attempt => cellKey(attempt) + ' · ' + attempt.batch + ' · ' + (attempt.slot ?? 'a' + attempt.attempt);

function evidenceSection(task, inputs) {
  if (!task) return '<p class="muted">task.json not found; the evidence given cannot be shown.</p>';
  const figures = inputs.map(input => {
    const caption = '<figcaption><strong>' + esc(input.kind) + '</strong> · ' + esc(input.captured_at ?? 'undated') + '<br>' + esc(input.description ?? input.id) + '</figcaption>';
    if (!input.href) return '<figure><div class="placeholder">missing file ' + esc(input.path) + '</div>' + caption + '</figure>';
    if (/\.(png|jpe?g|webp|gif)$/i.test(input.href)) {
      return '<figure><a href="' + esc(input.href) + '"><img loading="lazy" src="' + esc(input.href) + '" alt="' + esc(input.description ?? input.id) + '"></a>' + caption + '</figure>';
    }
    const preview = input.text ? '<details><summary>show text</summary><pre class="notes">' + esc(input.text) + '</pre></details>' : '';
    return '<figure><div class="placeholder"><a href="' + esc(input.href) + '">' + esc(basename(input.href)) + '</a></div>' + caption + preview + '</figure>';
  });
  return '<div class="evidence">' + figures.join('\n') + '</div>';
}

// rows: [{ label (html), alt, images: { view: href } | null, placeholder, group (html) }]
function rendersSection(views, rows) {
  const header = '<div class="render-row heading" style="--views:' + views.length + '"><div class="corner"></div>' + views.map(view => '<div class="view"><strong>' + esc(view) + '</strong></div>').join('') + '</div>';
  const body = rows.map(row => (row.group ? '<div class="group-head">' + row.group + '</div>' : '') +
    '<div class="render-row" style="--views:' + views.length + '"><div class="label">' + row.label + '</div>' +
    views.map(view => row.images?.[view] ? '<a href="' + esc(row.images[view]) + '"><img loading="lazy" src="' + esc(row.images[view]) + '" alt="' + esc(row.alt + ', ' + view) + '"></a>'
      : '<div class="placeholder">' + esc(row.placeholder ?? 'not rendered') + '</div>').join('') + '</div>').join('\n');
  return '<div class="renders-wrap"><div class="renders">' + header + body + '</div></div>';
}

// The scorer's error maps of the drawn attempts: one row per attempt, one
// column per map name, so the same view lines up down the page.
function mapsSection(maps) {
  if (!maps.length) return '';
  const names = [...new Set(maps.flatMap(row => row.files.map(file => file.name)))].sort();
  const rows = maps.map(row => '<div class="map-row" style="--maps:' + names.length + '"><div class="label">' + row.label + '</div>' +
    names.map(name => {
      const file = row.files.find(item => item.name === name);
      return file ? '<a href="' + esc(file.href) + '"><img loading="lazy" src="' + esc(file.href) + '" alt="' + esc(row.alt + ', ' + name) + '"></a>' : '<div class="placeholder">no ' + esc(name) + '</div>';
    }).join('') + '</div>');
  return '<h3>Scorer error maps</h3><div class="renders-wrap"><div class="maps renders">' +
    '<div class="map-row heading" style="--maps:' + names.length + '"><div class="corner"></div>' + names.map(name => '<div class="view"><strong>' + esc(name) + '</strong></div>').join('') + '</div>' +
    rows.join('\n') + '</div></div>';
}

const roleText = item => item.role ? '<span class="role">' + esc(item.role) + (item.of > 1 ? ' of ' + item.of : '') + '</span>' : '';
// Configuration, then batch and attempt, then role, on separate lines: with
// eight attempts side by side one-line labels would make the table very wide.
const columnHead = item => '<th class="num"><span class="col-head">' + esc(cellKey(item.attempt)) + '</span><small>' + esc(item.attempt.batch + ' · ' + (item.attempt.slot ?? 'a' + item.attempt.attempt)) +
  '</small>' + (item.role ? '<small>' + esc(item.role + (item.of > 1 ? ' of ' + item.of : '')) + '</small>' : '') + '</th>';

// The share of contested probes closer to the primary state, labelled for what
// it means on this task: the as-photographed state (c1) or the evidence rather
// than memory (m2, m3). Other variants get the c1 row, empty, as before.
function evidenceUseRow(attempts, metric) {
  const kind = conflictKind(attempts[0]?.variant);
  const label = kind?.id === 'memory' ? 'Memory <small>closer to the evidence</small>' : 'Conflict <small>closer to primary</small>';
  return [metric(label, attempt => percent(attempt.valid && kind ? conflictShare(attempt.report) : undefined))];
}

// items: [{ attempt, role, of }]
function numbersTable(items) {
  const attempts = items.map(item => item.attempt);
  const metric = (label, value) => '<tr><th>' + label + '</th>' + attempts.map(attempt => '<td class="num">' + value(attempt) + '</td>').join('') + '</tr>';
  const report = attempt => attempt.valid ? attempt.report : null;
  // Whatever tolerance rows the reports carry, in order; a row the report names
  // as entering the shape score is marked, and the label never assumes which.
  const rowsOf = new Map(attempts.map(attempt => [attempt, toleranceRows(report(attempt))]));
  const fractions = [...new Set([...rowsOf.values()].flat().map(row => row.fraction))].sort((a, b) => a - b);
  const threshold = (attempt, fraction) => rowsOf.get(attempt).find(item => Math.abs(item.fraction - fraction) < 1e-9);
  const inShape = fraction => {
    const flags = [...rowsOf.values()].map(rows => rows.find(row => Math.abs(row.fraction - fraction) < 1e-9)?.in_shape_score).filter(flag => typeof flag === 'boolean');
    return !flags.length ? null : flags.every(Boolean) ? true : flags.some(Boolean) ? 'mixed' : false;
  };
  const naming = [...rowsOf.values()].filter(rows => rows.length).map(rows => rows.some(row => row.in_shape_score !== null));
  const named = naming.length && naming.every(Boolean) ? 'all' : naming.some(Boolean) ? 'some' : null;
  const rows = [
    metric('Status', attempt => esc(attempt.status) + (attempt.excluded ? ' <small>(excluded)</small>' : '') + (attempt.valid ? '' : '<small class="bad">' + esc(attempt.failure) + '</small>')),
    metric('Score <small>(shape + detail) / 2</small>', attempt => attempt.excluded ? NOT_EVALUATED : '<strong>' + num(attempt.score, 1) + '</strong>'),
    metric('Shape score <small>' + (named === 'all' ? 'mean F over the rows marked &#9670;' : named === 'some' ? 'rows marked &#9670; where the report names them'
      : 'as reported; rows entering it not stated') + '</small>', attempt => num(report(attempt)?.shape_score, 1)),
    ...fractions.map(fraction => {
      const flag = inShape(fraction);
      const mark = flag === true ? ' <span title="enters the shape score">&#9670;</span>' : flag === 'mixed' ? ' <span title="enters the shape score in some reports only" class="bad">&#9671;</span>' : '';
      return metric('F@' + fractionLabel(fraction) + mark + ' <small>P / R</small>', attempt => {
        const item = threshold(attempt, fraction);
        return item ? num(item.f, 3) + '<small>' + num(item.precision, 2) + ' / ' + num(item.recall, 2) + '</small>' : NOT_EVALUATED;
      });
    }),
    metric('Strict F <small>no fitting</small>', attempt => num(report(attempt)?.strict?.f, 3)),
    metric('Shape F <small>scale fitted</small>', attempt => num(report(attempt)?.shape?.f, 3) + '<small>scale ' + num(report(attempt)?.shape?.scale, 3) + '</small>'),
    metric('Detail score', attempt => num(report(attempt)?.detail?.score, 1)),
    metric('Frame error', attempt => {
      const error = report(attempt)?.alignment?.frame_error;
      return error ? num(error.offset_m, 2, { suffix: ' m' }) + '<small>' + percent(error.offset_fraction, 1) + ' of D · yaw ' + num(error.yaw_deg, 1, { suffix: '°' }) +
        ' · log scale ' + num(error.scale_log, 3) + '</small>' : NOT_EVALUATED;
    }),
    metric('Alignment applied', attempt => {
      const alignment = report(attempt)?.alignment;
      return alignment ? 'yaw ' + num(alignment.yaw_deg, 1, { suffix: '°' }) + '<small>scale ' + num(alignment.scale, 3) + (alignment.scale_locked ? ' (locked)' : '') +
        ' · t [' + (alignment.translation_m ?? []).map(value => num(value, 2)).join(', ') + ']</small>' : NOT_EVALUATED;
    }),
    metric('Probes', attempt => {
      const summary = report(attempt)?.probe_summary;
      return summary ? num(summary.mean_error_m, 2, { suffix: ' m' }) + '<small>' + summary.evaluated + ' evaluated, ' + summary.missed + ' missed</small>' : NOT_EVALUATED;
    }),
    ...evidenceUseRow(attempts, metric),
    metric('Appearance &Delta;E', attempt => {
      const appearance = report(attempt)?.appearance;
      return appearance ? num(appearance.delta_e_mean, 1) + '<small>' + percent(appearance.match_fraction) + ' matched, ' + (appearance.compared_points ?? 0) + ' pts</small>' : NOT_EVALUATED;
    }),
    metric('Triangles', attempt => {
      const technical = report(attempt)?.technical;
      return technical && isNumber(technical.triangles) ? esc(technical.triangles.toLocaleString('en-US')) + '<small>' + (technical.mesh_count ?? '?') + ' meshes</small>' : NOT_EVALUATED;
    }),
    metric('Wall time', attempt => isNumber(attempt.wall_seconds) ? num(attempt.wall_seconds / 60, 1, { suffix: ' min' }) : NOT_EVALUATED),
    metric('Tokens <small>input / output</small>', attempt => attempt.usage && isNumber(attempt.usage.total)
      ? esc(attempt.usage.total.toLocaleString('en-US')) + '<small>' + esc(attempt.usage.input ?? '?') + ' / ' + esc(attempt.usage.output ?? '?') + '</small>' : NOT_EVALUATED),
    metric('Cost', attempt => isNumber(attempt.cost_usd) ? num(attempt.cost_usd, 2, { suffix: ' $' }) : NOT_EVALUATED),
  ];
  return '<div class="scroll"><table><thead><tr><th></th>' + items.map(columnHead).join('') + '</tr></thead><tbody>' + rows.join('\n') + '</tbody></table></div>';
}

function detailTable(items) {
  const valid = items.filter(item => item.attempt.valid && item.attempt.report.detail?.groups?.length);
  if (!valid.length) return '<p class="muted">No detail-group results (no valid report).</p>';
  const groups = new Map();
  for (const { attempt } of valid) for (const group of attempt.report.detail.groups) if (!groups.has(group.id)) groups.set(group.id, group);
  const rows = [...groups.values()].map(group => '<tr><td>' + esc(group.title ?? group.id) + '<small><code>' + esc(group.id) + '</code></small></td><td>' + esc(group.category) +
    '</td><td class="num">' + num(group.tau_m, 3, { suffix: ' m' }) + '</td><td class="num">' + percent(group.evidenced_fraction) + '</td>' +
    valid.map(({ attempt }) => {
      const result = attempt.report.detail.groups.find(item => item.id === group.id);
      if (!result) return '<td class="num">' + NOT_EVALUATED + '</td>';
      if (!result.scored) return '<td class="num"><span class="na">not scored</span><small>' + esc(result.reason ?? '') + '</small></td>';
      return '<td class="num">' + num(result.f, 2) + '<small>P ' + num(result.precision, 2) + ' · R ' + num(result.recall, 2) + ' · shift ' + num(result.local_offset_m, 2, { suffix: ' m' }) + '</small></td>';
    }).join('') + '</tr>');
  const categories = '<tr><th colspan="4">Detail score (mean over categories)</th>' + valid.map(({ attempt }) => '<td class="num"><strong>' + num(attempt.report.detail.score, 1) + '</strong><small>' +
    (attempt.report.detail.categories ?? []).map(category => esc(category.id) + ' ' + num(category.f, 2)).join(' · ') + '</small></td>').join('') + '</tr>';
  return '<div class="scroll"><table><thead><tr><th>Group</th><th>Category</th><th class="num">&tau;</th><th class="num">Evidenced</th>' +
    valid.map(columnHead).join('') + '</tr></thead><tbody>' + rows.join('\n') + categories + '</tbody></table></div>';
}

function probeTable(items) {
  const valid = items.filter(item => item.attempt.valid && item.attempt.report.probes?.length);
  if (!valid.length) return '<p class="muted">No probe results (no valid report).</p>';
  const probes = new Map();
  for (const { attempt } of valid) for (const probe of attempt.report.probes) if (!probes.has(probe.id)) probes.set(probe.id, probe);
  const rows = [...probes.values()].map(probe => '<tr><td>' + esc(probe.label ?? probe.id) + '<small><code>' + esc(probe.id) + '</code></small></td><td class="num">' +
    num(probe.truth_m, 2, { suffix: ' m' }) + '</td><td>' + (probe.evidenced === false ? '<span class="na">not evidenced</span>' : 'yes') + '</td>' +
    valid.map(({ attempt }) => {
      const result = attempt.report.probes.find(item => item.id === probe.id);
      if (!result) return '<td class="num">' + NOT_EVALUATED + '</td>';
      if (result.evidenced === false) return '<td class="num"><span class="na">skipped</span></td>';
      if (!isNumber(result.measured_m)) return '<td class="num"><span class="bad">miss</span></td>';
      return '<td class="num">' + num(result.measured_m, 2, { suffix: ' m' }) + '<small>error ' + num(result.error_m, 2, { suffix: ' m' }) + '</small></td>';
    }).join('') + '</tr>');
  return '<div class="scroll"><table><thead><tr><th>Probe</th><th class="num">Truth</th><th>Evidenced</th>' +
    valid.map(columnHead).join('') + '</tr></thead><tbody>' + rows.join('\n') + '</tbody></table></div>';
}

// Headings and words per kind of alternate: on a memory task the alternate is
// the structure as published, and "primary" is the surveyed object the evidence shows.
const ALTERNATE_WORDS = {
  conflict: { heading: 'Conflict: out-of-date evidence', primary: 'Primary', alternate: 'Alternate', sides: {} },
  memory: { heading: 'Memory: the evidence against the published figures', primary: 'Surveyed <small>evidence</small>', alternate: 'Published <small>memory</small>',
    sides: { primary: 'primary (evidence)', alternate: 'alternate (memory)' },
    legend: 'This structure is named in the task, and the surveyed object the evidence shows differs from its published figures. Each contested probe is measured on the submission: ' +
      'closer to the surveyed value means the model followed the evidence, closer to the published value that it followed what is remembered about the structure.' },
};

function alternatesSection(truth, items, variant) {
  const alternates = truth?.alternates ?? [];
  const valid = items.map(item => item.attempt).filter(attempt => attempt.valid && attempt.report.alternates?.length);
  if (!alternates.length && !valid.length) return '';
  const words = ALTERNATE_WORDS[conflictKind(variant)?.id] ?? ALTERNATE_WORDS.conflict;
  let html = '<h2>' + words.heading + '</h2>' + (words.legend ? '<p class="legend">' + esc(words.legend) + '</p>' : '') +
    (alternates.length ? '<ul>' + alternates.map(alternate => '<li><code>' + esc(alternate.id) + '</code>: ' +
    esc(alternate.note ?? '') + ' <small>contested probes: ' + esc((alternate.contested_probes ?? []).join(', ')) + '</small></li>').join('') + '</ul>' : '');
  for (const attempt of valid) {
    for (const alternate of attempt.report.alternates) {
      html += '<h3>' + esc(attemptLabel(attempt)) + ' vs <code>' + esc(alternate.id) + '</code> <small>F against the alternate ' + num(alternate.f, 3) + '</small></h3>' +
        '<div class="scroll"><table><thead><tr><th>Probe</th><th class="num">' + words.primary + '</th><th class="num">' + words.alternate + '</th><th class="num">Measured</th><th>Closer to</th></tr></thead><tbody>' +
        (alternate.contested ?? []).map(item => '<tr><td><code>' + esc(item.probe) + '</code></td><td class="num">' + num(item.primary_m, 2) + '</td><td class="num">' +
          num(item.alternate_m, 2) + '</td><td class="num">' + num(item.measured_m, 2) + '</td><td class="' + (item.closer_to === 'primary' ? 'good' : item.closer_to === 'alternate' ? 'bad' : '') + '">' +
          esc(words.sides[item.closer_to] ?? item.closer_to) + '</td></tr>').join('') + '</tbody></table></div>';
    }
  }
  return html;
}

// Attempts that are not drawn: one compact row each, nothing rendered.
function collapsedTable(collapsed) {
  if (!collapsed.length) return '';
  const report = attempt => attempt.valid ? attempt.report : null;
  const rows = collapsed.map(attempt => '<tr><td>' + esc(cellKey(attempt)) + '</td><td><code>' + esc(attempt.batch + '/' + (attempt.slot ?? 'a' + attempt.attempt)) + '</code></td>' +
    '<td>' + esc(attempt.status) + (attempt.excluded ? ' <small>excluded' + (attempt.status_reason ? ': ' + esc(attempt.status_reason) : '') + '</small>' : '') +
      (!attempt.valid && !attempt.excluded ? '<small class="bad">' + esc(attempt.failure) + '</small>' : '') + '</td>' +
    '<td class="num">' + (attempt.excluded ? NOT_EVALUATED : '<strong>' + num(attempt.score, 1) + '</strong>') + '</td>' +
    '<td class="num">' + num(report(attempt)?.shape_score, 1) + '</td><td class="num">' + num(report(attempt)?.detail?.score, 1) + '</td>' +
    '<td class="num">' + percent(report(attempt)?.alignment?.frame_error?.offset_fraction, 1) + '</td>' +
    '<td class="num">' + (isNumber(attempt.wall_seconds) ? num(attempt.wall_seconds / 60, 1, { suffix: ' min' }) : NOT_EVALUATED) + '</td></tr>');
  return '<details class="more"><summary>' + collapsed.length + ' more attempt' + (collapsed.length === 1 ? '' : 's') + ', not drawn</summary>' +
    '<div class="scroll"><table><thead><tr><th>Configuration</th><th>Attempt</th><th>Status</th><th class="num">Score</th><th class="num">Shape</th><th class="num">Detail</th>' +
    '<th class="num">Frame offset</th><th class="num">Wall</th></tr></thead><tbody>' + rows.join('\n') + '</tbody></table></div></details>';
}

// The rows drawn on the page: the truth, then per configuration its chosen attempts.
// withKey: false under a configuration heading, which already names it.
export function candidateLabel(item, { clipped = false, unaligned = false, withKey = true } = {}) {
  const { attempt } = item;
  return roleText(item) + (withKey ? esc(cellKey(attempt)) : '') + '<small>' + esc(attempt.batch) + ' · ' + esc(attempt.slot ?? 'a' + attempt.attempt) + ' · ' +
    (attempt.excluded ? 'excluded' : attempt.valid ? 'score ' + num(attempt.score, 1) : '<span class="bad">failed (0)</span>') +
    (unaligned ? ' · <span class="bad">no alignment reported, shown as submitted</span>' : '') +
    (clipped ? ' · <span class="bad">extends beyond the frame, clipped</span>' : '') + '</small>';
}

// The set line, with what the set is when the report knows (dev: not test results).
function setFact(taskInfo, setInfo) {
  const name = taskInfo.set === UNNAMED_SET ? 'unnamed <small>(truth.json names no set)</small>' : '<code>' + esc(taskInfo.set) + '</code>';
  const development = setInfo?.development === true;
  return name + (development ? ' <small class="low">development set: its objects were used to tune the scorer, so these are not test results</small>' : '');
}

export function taskPage({ taskInfo, task, inputs, truthModel, truthInfo, setInfo, views, renderRows, maps, shown, collapsed, counts, frameNote }) {
  const variant = VARIANTS[taskInfo.variant];
  const countNote = counts.attempts > shown.length
    ? 'Per configuration the best, median and worst counted attempt by score are drawn (' + shown.length + ' of ' + counts.attempts + ' attempts); the others are listed below the renders.'
    : 'Every attempt is drawn.';
  const body = `<nav class="crumbs"><a href="../index.html">&larr; Leaderboard</a></nav>
<h1>${esc(taskInfo.task_id)}</h1>
<dl class="facts">
<dt>Set</dt><dd>${setFact(taskInfo, setInfo)}</dd>
<dt>Object</dt><dd><code>${esc(taskInfo.object)}</code>${truthModel ? ' — ' + esc(truthModel.title) : ''}${taskInfo.archetype ? ' <small>(' + esc(taskInfo.archetype) + ')</small>' : ''}</dd>
<dt>Variant</dt><dd>${esc(taskInfo.variant)} — ${esc(variant?.title ?? '')}</dd>
<dt>Scale</dt><dd>${taskInfo.scale_evidence === 'metric' ? 'metric (scale locked to 1 when scoring)' : 'not fixed by the evidence (scale fitted when scoring)'}</dd>
${task ? '<dt>Target</dt><dd>' + esc(task.target_state) + '</dd>' : ''}
</dl>
${task ? '<details><summary>Prompt given to the contestant</summary><pre class="notes">' + esc(task.prompt) + '</pre></details>' : ''}
<h2>Evidence given</h2>
${evidenceSection(task, inputs)}
<h2>Ground truth and candidates</h2>
<p class="legend">Same cameras for every row and for every task of this object. Candidates are drawn after the scorer's reported alignment (yaw, translation and, on scale-free tasks, scale), so what differs is shape, not placement. ${esc(countNote)} Click an image for full size.${frameNote ? ' ' + esc(frameNote) : ''}</p>
${renderRows.length ? rendersSection(views, renderRows) : '<p class="muted">Nothing to render.</p>'}
${collapsedTable(collapsed)}
${mapsSection(maps)}
<h2>Key numbers</h2>
${shown.length ? numbersTable(shown) : '<p class="muted">No attempts.</p>'}
<h2>Detail groups</h2>
${detailTable(shown)}
<h2>Probes</h2>
${probeTable(shown)}
${alternatesSection(truthInfo, shown, taskInfo.variant)}`;
  return page({ title: taskInfo.task_id + ' · Evidence3D', body, root: '..' });
}
