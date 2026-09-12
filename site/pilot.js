import { createViewers } from './viewer.js';
const $ = id => document.getElementById(id);
const el = (tag, text) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; };
let overview, viewer, epoch = 0, loadEpoch = 0, selection;
const states = { completed: '已交付', running: '作答中', pending: '待开始', timeout: '超时', generation_failed: '生成失败', missing_artifact: '无 GLB', invalid_artifact: '无效 GLB', evaluation_failed: '评测异常' };
async function api(url) { const response = await fetch(url); const data = await response.json(); if (!response.ok) throw new Error(data.error); return data; }
function error(e) { $('pilot-error').textContent = e.message; $('pilot-error').hidden = false; }
async function inspect(task) {
  const current = ++epoch; selection = task.id; viewer?.dispose(); viewer = null;
  $('pilot-view').replaceChildren(); $('pilot-inspection').hidden = false; $('pilot-title').textContent = task.title;
  for (const row of $('pilot-rows').children) row.classList.toggle('selected', row.dataset.id === task.id);
  const m = task.metrics;
  $('pilot-measurement').textContent = m ? `最大尺寸误差 ${(m.max_dimension_error * 100).toFixed(3)}% · 最低固定视角 IoU ${m.min_silhouette_iou.toFixed(4)}。这些是几何测量，没有换算为人工视觉分。`
    : task.eligibility === 'annotation_pending' ? '准确性未计分：该任务尚无独立核验的真值。模型可导入不等于建筑还原准确。'
      : ['pending','running'].includes(task.status) ? '本题尚未完成交付与评测。' : '本题未得到有效几何测量；请查看交付状态和原始运行记录。';
  $('pilot-details').hidden = !task.detail_url; if (task.detail_url) $('pilot-details').href = task.detail_url;
  $('pilot-sources').replaceChildren(...task.inputs.map(input => {
    const figure = el('figure'), link = el('a'); link.href = input.url; link.target = '_blank'; link.rel = 'noopener';
    if (/\.(png|jpe?g|svg)$/i.test(input.path)) { const img = el('img'); img.src = input.url; img.alt = task.title + ' · ' + input.role; img.loading = 'lazy'; link.append(img); }
    else link.textContent = '打开结构化输入资料';
    figure.append(link, el('figcaption', input.path.split('/').at(-1))); return figure;
  }));
  $('pilot-view-status').textContent = '预览相机按此产物的范围摆放，仅用于旋转检查；不参与评分。';
  if (!task.model_url) return;
  const next = await createViewers([{ element: 'pilot-view', url: task.model_url + '?style=material', label: task.title }], task.frame, { style: $('pilot-style').value });
  if (current !== epoch) next.dispose(); else viewer = next;
}
async function load(id) {
  const request = ++loadEpoch, data = await api('/api/pilots/' + id);
  if (request !== loadEpoch) return;
  overview = data;
  const u = new URL(location.href); u.searchParams.set('run', id); history.replaceState(null, '', u);
  $('pilot-meta').textContent = `${overview.model} · ${overview.reasoning_effort} · ${overview.harness} · ${overview.tools.codex} · ${overview.complete ? '本批完成' : '运行中，刷新查看新增结果'}`;
  $('pilot-conditions').replaceChildren(...overview.notes.map(note => el('p', note)));
  $('pilot-conditions').hidden = !overview.notes.length;
  $('pilot-rows').replaceChildren(...overview.tasks.map(task => {
    const row = el('tr'); row.tabIndex = 0; row.dataset.id = task.id;
    const detail = task.detail_checks ? `${task.detail_checks.passed} / ${task.detail_checks.total}` : '—';
    for (const text of [task.title, states[task.status] || task.status, task.wall_seconds === null ? task.status === 'running' ? '计时中' : '—' : (task.wall_seconds / 60).toFixed(1) + ' 分钟',
      task.metrics ? task.geometry_checks_pass ? '通过' : '检出差异' : '未计分', detail, '— 待人工评审']) row.append(el('td', text));
    row.addEventListener('click', () => inspect(task).catch(error));
    row.addEventListener('keydown', e => { if (e.key === 'Enter') inspect(task).catch(error); }); return row;
  }));
  const target = overview.tasks.find(t => t.id === selection && t.model_url) || overview.tasks.find(t => t.model_url);
  if (target) await inspect(target);
  else { ++epoch; viewer?.dispose(); viewer = null; $('pilot-inspection').hidden = true; }
}
async function refresh() {
  $('pilot-error').hidden = true;
  const list = await api('/api/pilots'), preferred = $('pilot-batch').value || new URLSearchParams(location.search).get('run');
  $('pilot-batch').replaceChildren(...list.map(run => { const o = el('option', `${run.id} · ${run.completed}/${run.tasks}`); o.value = run.id; return o; }));
  if (!list.length) { $('pilot-meta').textContent = '首个任务完成后，这里会出现实际结果。'; return; }
  $('pilot-batch').value = list.some(r => r.id === preferred) ? preferred : list[0].id;
  await load($('pilot-batch').value);
}
$('pilot-batch').addEventListener('change', () => { selection = undefined; load($('pilot-batch').value).catch(error); });
$('pilot-refresh').addEventListener('click', () => refresh().catch(error));
$('pilot-style').addEventListener('change', () => viewer?.setStyle($('pilot-style').value));
refresh().catch(error);
