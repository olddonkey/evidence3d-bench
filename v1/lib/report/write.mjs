import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { join, resolve, dirname, basename, relative } from 'node:path';
import { writeJSON, contained } from '../../../lib/io.mjs';
import { layout, VARIANTS } from '../contract.mjs';
import { encodePNG } from '../png.mjs';
import { soupFromModel, soupFromGLB, transformSoup } from '../soup.mjs';
import { validateModel } from '../model.mjs';
import { shadeSoup, standardViews, unionBounds } from '../render/shade.mjs';
import { collectRuns, DEFAULT_EXCLUDED_STATUSES } from './collect.mjs';
import { buildLeaderboard, cellKey, reportName, conflictShare, VARIANT_ORDER, LADDER } from './aggregate.mjs';
import { esc, num, percent, statCell, page, STYLE, NOT_EVALUATED } from './html.mjs';

// Static results site: index.html (leaderboard + task index), one page per
// task under tasks/, renders and copied evidence under assets/, and the
// leaderboard as JSON. Opens from disk; no server, no external assets.
export const REPORT_VIEWS = ['iso', 'front', 'top', 'iso-rear'];

const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const slug = text => String(text).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
const attemptLabel = attempt => cellKey(attempt) + ' · ' + attempt.batch + ' · a' + attempt.attempt;
// The attempt directory name is unique within a batch and task; the attempt
// number inside result.json is only what the runner reported.
const attemptSlug = attempt => slug(attempt.batch) + '--' + slug(attempt.slot ?? 'a' + attempt.attempt);

async function readJSON(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}
async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

// Frames every model of a task with one set of cameras. A candidate that is far
// larger than the truth (a unit mistake, a stray triangle) would shrink the
// truth to a dot, so then the frame is the truth's box grown by half and the
// page says that the candidate is clipped.
function frameFor(truthBounds, candidateBounds) {
  const diagonal = box => Math.hypot(...box.max.map((value, i) => value - box.min[i]));
  if (!truthBounds) return { bounds: candidateBounds.length ? unionBounds(...candidateBounds) : null, clipped: false };
  const union = unionBounds(truthBounds, ...candidateBounds);
  if (diagonal(union) <= 2 * diagonal(truthBounds)) return { bounds: union, clipped: false };
  const centre = truthBounds.min.map((value, i) => (value + truthBounds.max[i]) / 2);
  const half = truthBounds.max.map((value, i) => (value - truthBounds.min[i]) * 0.75);
  return { bounds: { min: centre.map((c, i) => c - half[i]), max: centre.map((c, i) => c + half[i]) }, clipped: true };
}

async function writeShaded(soup, camera, file) {
  const image = shadeSoup(soup, camera, { supersample: 2 });
  await writeFile(file, encodePNG(image.width, image.height, image.pixels, 3));
  return image.covered;
}

// -------------------------------------------------------------------- index

// Two tables over the same rows: the scores, then evidence use and cost.
function leaderboardTables(board) {
  const variants = VARIANT_ORDER.filter(variant => board.entries.some(entry => entry.variants[variant]));
  // A ladder column appears once some configuration ran both rungs on one object.
  const ladder = LADDER.filter(([high, low]) => board.entries.some(entry => entry.ladder[high + '-' + low].pairs > 0));
  const identity = (entry, index) => '<td class="num">' + (index + 1) + '</td><td>' + esc(entry.system) + '</td><td>' + esc(entry.model) + '</td><td>' +
    (entry.effort === null ? NOT_EVALUATED : esc(entry.effort)) + '</td>';
  const identityHead = '<th class="num">#</th><th>System</th><th>Model</th><th>Effort</th>';
  const table = (head, cells) => '<div class="scroll"><table><thead><tr>' + identityHead + head + '</tr></thead><tbody>' +
    (board.entries.length ? board.entries.map((entry, index) => '<tr>' + identity(entry, index) + cells(entry).join('') + '</tr>').join('\n')
      : '<tr><td colspan="99" class="muted">No scored attempts.</td></tr>') + '</tbody></table></div>';
  const scores = table(
    '<th class="num">Score</th>' + variants.map(variant => '<th class="num" title="' + esc(VARIANTS[variant].title) + '">' + variant + '</th>').join('') +
      '<th class="num" title="overall surface agreement: mean of F@1%, F@2%, F@5%">Shape</th><th class="num" title="small features, scored group by group">Detail</th>' +
      '<th class="num" title="attempts with a valid score report">Success</th>',
    entry => [
      statCell(entry.score),
      ...variants.map(variant => statCell(entry.variants[variant])),
      statCell(entry.shape),
      statCell(entry.detail),
      '<td class="num">' + percent(entry.success.rate) + '<small>' + entry.success.valid + ' / ' + entry.success.attempts + ' att.</small></td>',
    ]);
  const diagnostics = table(
    ladder.map(([high, low]) => '<th class="num" title="paired by object">&Delta; ' + high + '&minus;' + low + '</th>').join('') +
      '<th class="num" title="share of contested probes closer to the as-photographed state">Conflict</th>' +
      '<th class="num" title="alignment offset as % of the truth diagonal">Frame offset</th><th class="num" title="absolute alignment yaw">Frame yaw</th>' +
      '<th class="num" title="|fitted scale - 1| on metric tasks">Scale error</th><th class="num">Median wall</th><th class="num">Tokens / att.</th><th class="num">Cost / att.</th>',
    entry => [
      ...ladder.map(([high, low]) => statCell(entry.ladder[high + '-' + low], { signed: true, unit: 'pairs' })),
      statCell(entry.conflict, { scale: 100, digits: 0, suffix: '%' }),
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
  return { scores, diagnostics };
}

function taskIndexTable(board) {
  const keys = board.entries.map(entry => entry.key);
  const head = '<th>Task</th><th>Object</th><th>Variant</th><th>Scale</th>' + keys.map(key => '<th class="num">' + esc(key) + '</th>').join('');
  const rows = board.tasks.map(task => {
    const cells = keys.map(key => {
      const cell = task.cells[key];
      if (!cell) return '<td class="num"><span class="na">not run</span></td>';
      const detail = cell.attempts.map(attempt => attempt.excluded ? 'excl.' : attempt.valid ? num(attempt.score, 1) : '<span class="bad" title="' + esc(attempt.failure) + '">fail</span>').join(' · ');
      return '<td class="num">' + num(cell.mean, 1) + '<small>' + detail + '</small></td>';
    });
    return '<tr><td><a href="tasks/' + esc(slug(task.task_id)) + '.html">' + esc(task.task_id) + '</a></td><td>' + esc(task.object) + '</td><td>' +
      esc(task.variant) + '</td><td>' + esc(task.scale_evidence) + '</td>' + cells.join('') + '</tr>';
  });
  return '<div class="scroll"><table><thead><tr>' + head + '</tr></thead><tbody>' + rows.join('\n') + '</tbody></table></div>';
}

function indexPage(board) {
  const batches = board.batches.map(batch => {
    const summary = batch.summary && typeof batch.summary === 'object'
      ? Object.entries(batch.summary).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 8)
        .map(([key, value]) => esc(key) + ': ' + esc(value)).join(' · ')
      : 'no summary.json';
    return '<li><code>' + esc(batch.id) + '</code> &mdash; ' + batch.attempts + ' attempt(s). <small>' + summary + '</small></li>';
  }).join('');
  const excluded = board.excluded.length
    ? '<h2>Excluded attempts</h2><p class="legend">Harness-side failures (' + esc(board.method.excluded_statuses.join(', ')) + ') are left out of every mean.</p><ul>' +
      board.excluded.map(item => '<li><code>' + esc(item.batch) + '/' + esc(item.task_id) + '/a' + item.attempt + '</code> ' + esc(item.cell) + ': ' + esc(item.status) + '</li>').join('') + '</ul>'
    : '';
  const problems = board.problems.length
    ? '<h2>Data problems</h2><ul>' + board.problems.map(problem => '<li>' + esc(problem) + '</li>').join('') + '</ul>' : '';
  const tables = leaderboardTables(board);
  const body = `<h1>Evidence3D results</h1>
<p class="muted">Protocol ${esc(board.protocol)} · generated ${esc(board.generated_at)} · ${board.entries.length} system configuration(s) · ${board.tasks.length} task(s)</p>
<h2>Leaderboard</h2>
${tables.scores}
<h3>Evidence use, frame and cost</h3>
${tables.diagnostics}
<p class="legend">Each cell: mean, 95% bootstrap interval over objects (variants of one object are not independent), and sample size.
<strong>Score</strong> = 100 &times; F@2% of the bounding-box diagonal after alignment; attempts that produced no valid model count as 0, as does their detail score.
Attempts are averaged within a task and tasks within an object, so every object weighs the same.
&Delta; columns pair the two rungs of the evidence ladder by object. <strong>Conflict</strong>: on c1 tasks (drawings out of date), the share of contested
probes closer to the as-photographed building. Frame and scale errors use valid attempts only; scale error is |fitted scale &minus; 1| on metric tasks.
Tokens are input (including cached reads) + output as recorded in result.json; cost is whatever the harness reported (Claude Code: its list-price estimate) and stays n/a when not reported.
<span class="low">&dagger; low evidence: fewer than 3 objects.</span> <span class="na">n/a</span> means not evaluated or not reported, never zero.</p>
<h2>Tasks</h2>
${taskIndexTable(board)}
<h2>Batches</h2>
<ul>${batches}</ul>
${excluded}
${problems}
<p class="legend">Machine-readable: <a href="leaderboard.json">leaderboard.json</a>.</p>`;
  return page({ title: 'Evidence3D results', body, root: '.' });
}

// ---------------------------------------------------------------- task page

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

function rendersSection(views, rows, clipped) {
  const header = '<div class="render-row heading" style="--views:' + views.length + '"><div class="corner"></div>' + views.map(view => '<div class="view"><strong>' + esc(view) + '</strong></div>').join('') + '</div>';
  const body = rows.map(row => '<div class="render-row" style="--views:' + views.length + '"><div class="label">' + row.label + '</div>' +
    views.map(view => row.images?.[view] ? '<a href="' + esc(row.images[view]) + '"><img loading="lazy" src="' + esc(row.images[view]) + '" alt="' + esc(row.alt + ', ' + view) + '"></a>'
      : '<div class="placeholder">' + esc(row.placeholder ?? 'not rendered') + '</div>').join('') + '</div>').join('\n');
  return (clipped ? '<p class="legend bad">At least one candidate is more than twice the size of the ground truth; the views are framed on the ground truth and the candidate is clipped.</p>' : '') +
    '<div class="renders-wrap"><div class="renders">' + header + body + '</div></div>';
}

function numbersTable(attempts) {
  const metric = (label, value) => '<tr><th>' + label + '</th>' + attempts.map(attempt => '<td class="num">' + value(attempt) + '</td>').join('') + '</tr>';
  const report = attempt => attempt.valid ? attempt.report : null;
  const threshold = (attempt, fraction) => report(attempt)?.global?.thresholds?.find(item => Math.abs(item.fraction - fraction) < 1e-9);
  const rows = [
    metric('Status', attempt => esc(attempt.status) + (attempt.excluded ? ' <small>(excluded)</small>' : '') + (attempt.valid ? '' : '<small class="bad">' + esc(attempt.failure) + '</small>')),
    metric('Score <small>(shape + detail) / 2</small>', attempt => attempt.excluded ? NOT_EVALUATED : '<strong>' + num(attempt.score, 1) + '</strong>'),
    metric('Shape <small>mean F at 1, 2, 5 %</small>', attempt => num(report(attempt)?.shape_score, 1)),
    ...[0.01, 0.02, 0.05].map(fraction => metric('F@' + fraction * 100 + '% <small>P / R</small>', attempt => {
      const item = threshold(attempt, fraction);
      return item ? num(item.f, 3) + '<small>' + num(item.precision, 2) + ' / ' + num(item.recall, 2) + '</small>' : NOT_EVALUATED;
    })),
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
    metric('Conflict <small>closer to primary</small>', attempt => {
      const share = attempt.valid && attempt.variant === 'c1' ? conflictShare(attempt.report) : undefined;
      return percent(share);
    }),
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
  return '<div class="scroll"><table><thead><tr><th></th>' + attempts.map(attempt => '<th class="num">' + esc(attemptLabel(attempt)) + '</th>').join('') +
    '</tr></thead><tbody>' + rows.join('\n') + '</tbody></table></div>';
}

function detailTable(attempts) {
  const valid = attempts.filter(attempt => attempt.valid && attempt.report.detail?.groups?.length);
  if (!valid.length) return '<p class="muted">No detail-group results (no valid report).</p>';
  const groups = new Map();
  for (const attempt of valid) for (const group of attempt.report.detail.groups) if (!groups.has(group.id)) groups.set(group.id, group);
  const rows = [...groups.values()].map(group => '<tr><td>' + esc(group.title ?? group.id) + '<small><code>' + esc(group.id) + '</code></small></td><td>' + esc(group.category) +
    '</td><td class="num">' + num(group.tau_m, 3, { suffix: ' m' }) + '</td><td class="num">' + percent(group.evidenced_fraction) + '</td>' +
    valid.map(attempt => {
      const result = attempt.report.detail.groups.find(item => item.id === group.id);
      if (!result) return '<td class="num">' + NOT_EVALUATED + '</td>';
      if (!result.scored) return '<td class="num"><span class="na">not scored</span><small>' + esc(result.reason ?? '') + '</small></td>';
      return '<td class="num">' + num(result.f, 2) + '<small>P ' + num(result.precision, 2) + ' · R ' + num(result.recall, 2) + ' · shift ' + num(result.local_offset_m, 2, { suffix: ' m' }) + '</small></td>';
    }).join('') + '</tr>');
  const categories = '<tr><th colspan="4">Detail score (mean over categories)</th>' + valid.map(attempt => '<td class="num"><strong>' + num(attempt.report.detail.score, 1) + '</strong><small>' +
    (attempt.report.detail.categories ?? []).map(category => esc(category.id) + ' ' + num(category.f, 2)).join(' · ') + '</small></td>').join('') + '</tr>';
  return '<div class="scroll"><table><thead><tr><th>Group</th><th>Category</th><th class="num">&tau;</th><th class="num">Evidenced</th>' +
    valid.map(attempt => '<th class="num">' + esc(attemptLabel(attempt)) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('\n') + categories + '</tbody></table></div>';
}

function probeTable(attempts) {
  const valid = attempts.filter(attempt => attempt.valid && attempt.report.probes?.length);
  if (!valid.length) return '<p class="muted">No probe results (no valid report).</p>';
  const probes = new Map();
  for (const attempt of valid) for (const probe of attempt.report.probes) if (!probes.has(probe.id)) probes.set(probe.id, probe);
  const rows = [...probes.values()].map(probe => '<tr><td>' + esc(probe.label ?? probe.id) + '<small><code>' + esc(probe.id) + '</code></small></td><td class="num">' +
    num(probe.truth_m, 2, { suffix: ' m' }) + '</td><td>' + (probe.evidenced === false ? '<span class="na">not evidenced</span>' : 'yes') + '</td>' +
    valid.map(attempt => {
      const result = attempt.report.probes.find(item => item.id === probe.id);
      if (!result) return '<td class="num">' + NOT_EVALUATED + '</td>';
      if (result.evidenced === false) return '<td class="num"><span class="na">skipped</span></td>';
      if (!isNumber(result.measured_m)) return '<td class="num"><span class="bad">miss</span></td>';
      return '<td class="num">' + num(result.measured_m, 2, { suffix: ' m' }) + '<small>error ' + num(result.error_m, 2, { suffix: ' m' }) + '</small></td>';
    }).join('') + '</tr>');
  return '<div class="scroll"><table><thead><tr><th>Probe</th><th class="num">Truth</th><th>Evidenced</th>' +
    valid.map(attempt => '<th class="num">' + esc(attemptLabel(attempt)) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('\n') + '</tbody></table></div>';
}

function alternatesSection(truth, attempts) {
  const alternates = truth?.alternates ?? [];
  const valid = attempts.filter(attempt => attempt.valid && attempt.report.alternates?.length);
  if (!alternates.length && !valid.length) return '';
  let html = '<h2>Conflict: out-of-date evidence</h2>' + (alternates.length ? '<ul>' + alternates.map(alternate => '<li><code>' + esc(alternate.id) + '</code>: ' +
    esc(alternate.note ?? '') + ' <small>contested probes: ' + esc((alternate.contested_probes ?? []).join(', ')) + '</small></li>').join('') + '</ul>' : '');
  for (const attempt of valid) {
    for (const alternate of attempt.report.alternates) {
      html += '<h3>' + esc(attemptLabel(attempt)) + ' vs <code>' + esc(alternate.id) + '</code> <small>F against the alternate ' + num(alternate.f, 3) + '</small></h3>' +
        '<div class="scroll"><table><thead><tr><th>Probe</th><th class="num">Primary</th><th class="num">Alternate</th><th class="num">Measured</th><th>Closer to</th></tr></thead><tbody>' +
        (alternate.contested ?? []).map(item => '<tr><td><code>' + esc(item.probe) + '</code></td><td class="num">' + num(item.primary_m, 2) + '</td><td class="num">' +
          num(item.alternate_m, 2) + '</td><td class="num">' + num(item.measured_m, 2) + '</td><td class="' + (item.closer_to === 'primary' ? 'good' : item.closer_to === 'alternate' ? 'bad' : '') + '">' +
          esc(item.closer_to) + '</td></tr>').join('') + '</tbody></table></div>';
    }
  }
  return html;
}

// ------------------------------------------------------------------ writer

export async function writeReport({ dataRoot, batches, outDir, views = REPORT_VIEWS, size = 360, seed, now, excludeStatuses = DEFAULT_EXCLUDED_STATUSES } = {}) {
  if (typeof dataRoot !== 'string' || !dataRoot) throw new Error('writeReport needs dataRoot');
  const root = resolve(dataRoot), paths = layout(root);
  const target = resolve(outDir ?? join(paths.reports, reportName(batches)));
  const collected = await collectRuns({ dataRoot: root, batches, excludeStatuses });
  const board = buildLeaderboard(collected, { seed, now, excludeStatuses });
  await mkdir(join(target, 'assets'), { recursive: true });
  await mkdir(join(target, 'tasks'), { recursive: true });
  await writeFile(join(target, 'assets', 'style.css'), STYLE);
  await writeJSON(join(target, 'leaderboard.json'), board);
  const notes = [];
  let images = 0;

  for (const taskInfo of board.tasks) {
    const taskId = taskInfo.task_id, taskSlug = slug(taskId);
    const assetDir = join(target, 'assets', 'tasks', taskSlug), renderDir = join(target, 'assets', 'renders', taskSlug);
    await mkdir(assetDir, { recursive: true });
    await mkdir(renderDir, { recursive: true });
    const href = file => relative(join(target, 'tasks'), file).split('\\').join('/');

    // Evidence actually given to the contestant: the task pack's inputs.
    const task = await readJSON(join(paths.task(taskId), 'task.json'));
    const inputs = [];
    for (const input of task?.inputs ?? []) {
      const entry = { ...input };
      try {
        const source = contained(paths.task(taskId), input.path), copy = join(assetDir, basename(input.path));
        if (await exists(source)) {
          await copyFile(source, copy);
          entry.href = href(copy);
          if (/\.(md|txt)$/i.test(input.path)) entry.text = await readFile(source, 'utf8');
        }
      } catch (error) { notes.push(taskId + ': input ' + input.path + ' not copied: ' + error.message); }
      inputs.push(entry);
    }

    const truthInfo = collected.truths.get(taskId) ?? await readJSON(join(paths.truth(taskId), 'truth.json'));
    let truthSoup = null, truthModel = null, truthNote = null;
    try {
      truthModel = validateModel(JSON.parse(await readFile(join(paths.object(taskInfo.object), 'model.json'), 'utf8')));
      truthSoup = soupFromModel(truthModel);
    } catch (error) { truthNote = 'ground truth not rendered: ' + error.message; }

    const attempts = collected.attempts.filter(attempt => attempt.task_id === taskId)
      .sort((a, b) => cellKey(a).localeCompare(cellKey(b)) || a.batch.localeCompare(b.batch) || a.attempt - b.attempt);
    const candidates = [];
    for (const attempt of attempts) {
      const row = { attempt, soup: null, placeholder: null };
      if (!attempt.model_path) row.placeholder = attempt.valid ? 'model file not found' : 'no model: ' + attempt.failure;
      else if (!attempt.valid) row.placeholder = 'not scored: ' + attempt.failure;
      else {
        try {
          const soup = await soupFromGLB(await readFile(attempt.model_path));
          const alignment = attempt.report.alignment ?? {};
          // The scorer reports p' = s * Ry(yaw) * p + t from candidate to truth.
          row.soup = transformSoup(soup, { scale: isNumber(alignment.scale) ? alignment.scale : 1,
            yaw: isNumber(alignment.yaw_deg) ? alignment.yaw_deg * Math.PI / 180 : 0,
            translation: Array.isArray(alignment.translation_m) && alignment.translation_m.length === 3 ? alignment.translation_m : [0, 0, 0] });
          if (!attempt.report.alignment) row.unaligned = true;
        } catch (error) { row.placeholder = 'model could not be read: ' + error.message; }
      }
      candidates.push(row);
    }
    const frame = frameFor(truthSoup?.bounds ?? null, candidates.filter(row => row.soup).map(row => row.soup.bounds));
    const cameras = frame.bounds ? standardViews(frame.bounds, size) : null;
    const rows = [];
    const renderRow = async (soup, name) => {
      const files = {};
      for (const view of views) {
        const file = join(renderDir, name + '-' + view + '.png');
        await writeShaded(soup, cameras[view], file);
        files[view] = href(file);
        images++;
      }
      return files;
    };
    rows.push({ label: '<strong>Ground truth</strong><small>' + esc(truthModel?.title ?? taskInfo.object) + '</small>', alt: 'ground truth',
      images: truthSoup && cameras ? await renderRow(truthSoup, 'truth') : null, placeholder: truthNote ?? 'not rendered' });
    for (const row of candidates) {
      const { attempt } = row;
      const label = esc(cellKey(attempt)) + '<small>' + esc(attempt.batch) + ' · a' + attempt.attempt + ' · ' +
        (attempt.excluded ? 'excluded' : attempt.valid ? 'score ' + num(attempt.score, 1) : '<span class="bad">failed (0)</span>') +
        (row.unaligned ? ' · <span class="bad">no alignment reported, shown as submitted</span>' : '') + '</small>';
      rows.push({ label, alt: attemptLabel(attempt), placeholder: row.placeholder,
        images: row.soup && cameras ? await renderRow(row.soup, attemptSlug(attempt)) : null });
    }

    // Scorer artifacts (e.g. error maps) referenced by the report.
    let artifacts = '';
    for (const attempt of attempts.filter(item => item.valid && Array.isArray(item.report.artifacts))) {
      const scoreDir = attempt.report_path ? dirname(attempt.report_path) : join(attempt.dir, 'score');
      for (const name of attempt.report.artifacts) {
        if (typeof name !== 'string' || !/\.(png|jpe?g)$/i.test(name)) continue;
        try {
          const source = contained(scoreDir, name);
          if (!(await exists(source))) continue;
          const copy = join(renderDir, attemptSlug(attempt) + '--' + slug(basename(name)));
          await copyFile(source, copy);
          artifacts += '<figure><a href="' + esc(href(copy)) + '"><img loading="lazy" src="' + esc(href(copy)) + '" alt=""></a><figcaption>' + esc(attemptLabel(attempt)) + ' · ' + esc(name) + '</figcaption></figure>';
        } catch (error) { notes.push(taskId + ': artifact ' + name + ' not copied: ' + error.message); }
      }
    }

    const variant = VARIANTS[taskInfo.variant];
    const body = `<nav class="crumbs"><a href="../index.html">&larr; Leaderboard</a></nav>
<h1>${esc(taskId)}</h1>
<dl class="facts">
<dt>Object</dt><dd><code>${esc(taskInfo.object)}</code>${truthModel ? ' — ' + esc(truthModel.title) : ''}</dd>
<dt>Variant</dt><dd>${esc(taskInfo.variant)} — ${esc(variant?.title ?? '')}</dd>
<dt>Scale</dt><dd>${taskInfo.scale_evidence === 'metric' ? 'metric (scale locked to 1 when scoring)' : 'not fixed by the evidence (scale fitted when scoring)'}</dd>
${task ? '<dt>Target</dt><dd>' + esc(task.target_state) + '</dd>' : ''}
</dl>
${task ? '<details><summary>Prompt given to the contestant</summary><pre class="notes">' + esc(task.prompt) + '</pre></details>' : ''}
<h2>Evidence given</h2>
${evidenceSection(task, inputs)}
<h2>Ground truth and candidates</h2>
<p class="legend">Same cameras for every row. Candidates are drawn after the scorer's reported alignment (yaw, translation and, on scale-free tasks, scale), so what differs is shape, not placement. Click an image for full size.</p>
${cameras ? rendersSection(views, rows, frame.clipped) : '<p class="muted">Nothing to render.</p>'}
${artifacts ? '<h3>Scorer artifacts</h3><div class="evidence">' + artifacts + '</div>' : ''}
<h2>Key numbers</h2>
${attempts.length ? numbersTable(attempts) : '<p class="muted">No attempts.</p>'}
<h2>Detail groups</h2>
${detailTable(attempts)}
<h2>Probes</h2>
${probeTable(attempts)}
${alternatesSection(truthInfo, attempts)}`;
    await writeFile(join(target, 'tasks', taskSlug + '.html'), page({ title: taskId + ' · Evidence3D', body, root: '..' }));
  }
  if (notes.length) board.problems.push(...notes);
  await writeFile(join(target, 'index.html'), indexPage(board));
  if (notes.length) await writeJSON(join(target, 'leaderboard.json'), board);
  return { outDir: target, index: join(target, 'index.html'), leaderboard: board, images, tasks: board.tasks.length };
}
