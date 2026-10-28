import { KEY_CHOICES, LEGACY_RATER, latestChoices, votedTrail, nextUnrated, afterCurrent, progress, elapsed, raterId } from './state.js';

// The rating page. Asks the rater's name on the first visit (kept in this
// browser), reads pairs.json and that rater's votes so far, shows the first
// unrated pair, and posts each choice, with the rater, to the local server.
// Plain DOM, no external resources.

// The reference sits in the middle row so A and B are each one row from it:
// with the reference on top, A would be compared at a glance and B across a row.
const ROWS = [
  { role: 'a', label: 'A', name: 'A' },
  { role: 'r', label: '参考', name: '参考' },
  { role: 'b', label: 'B', name: 'B' },
];
const EVIDENCE = { t2: '照片和航拍', t3: '照片、航拍和图纸', t4: '照片、航拍、图纸和勘测笔记', c1: '照片、航拍和较早的图纸' };
const CHOICE_TEXT = { a: 'A 更接近', tie: '分不出', b: 'B 更接近' };
const RATER_STORAGE = 'e3d-study-rater';

const state = {
  pairs: [], views: [], latest: new Map(), trail: [], ahead: [], current: -1,
  shownAt: 0, hiddenMs: 0, hiddenSince: null, busy: false, zoom: null, cells: new Map(), rater: null, asking: null,
};
const $ = id => document.getElementById(id);
const choiceButtons = () => [...document.querySelectorAll('button.choice')];

function setStatus(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

function buildGrid() {
  const grid = $('grid');
  grid.replaceChildren();
  grid.append(document.createElement('span'));
  for (const view of state.views) {
    const label = document.createElement('span');
    label.className = 'view-label';
    label.textContent = view.label;
    grid.append(label);
  }
  ROWS.forEach((row, rowIndex) => {
    const label = document.createElement('span');
    label.className = 'row-label' + (row.role === 'r' ? ' ref' : '');
    label.textContent = row.label;
    grid.append(label);
    state.views.forEach((view, viewIndex) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cell' + (row.role === 'r' ? ' ref' : '');
      button.title = '点击放大';
      const image = document.createElement('img');
      image.width = 560;
      image.height = 420;
      image.decoding = 'async';
      button.append(image);
      button.addEventListener('click', () => openZoom(viewIndex, rowIndex));
      grid.append(button);
      state.cells.set(row.role + '/' + view.id, image);
    });
  });
}

const imageUrl = name => 'images/' + encodeURIComponent(name);

function preload(index) {
  if (index < 0) return;
  for (const byRole of Object.values(state.pairs[index].images)) for (const name of Object.values(byRole)) new Image().src = imageUrl(name);
}

function updateControls() {
  const pair = state.pairs[state.current];
  const chosen = pair ? state.latest.get(pair.id) : undefined;
  for (const button of choiceButtons()) {
    button.disabled = state.busy || !pair || !state.rater;
    button.classList.toggle('chosen', chosen === button.dataset.choice);
  }
  $('back').disabled = state.busy || !state.trail.length;
  $('change-rater').disabled = state.busy;
  $('forward').disabled = state.busy || !pair || chosen === undefined;
  const { rated, total } = progress(state.pairs, state.latest);
  $('progress').textContent = '已评 ' + rated + ' / ' + total;
}

function show(index) {
  state.current = index;
  closeZoom();
  if (index < 0) {
    $('grid').hidden = true;
    $('message').hidden = false;
    $('message').textContent = '全部 ' + state.pairs.length + ' 对都已评完，谢谢！需要修改可以按“上一对”。';
    $('task').textContent = '';
    setStatus('');
    updateControls();
    return;
  }
  const pair = state.pairs[index];
  $('grid').hidden = false;
  $('message').hidden = true;
  // A picture stays blank until it has loaded, so the previous pair's pictures
  // never show under this pair; votes wait until all of them are there.
  for (const row of ROWS) {
    for (const view of state.views) {
      const image = state.cells.get(row.role + '/' + view.id);
      image.classList.add('loading');
      image.onload = () => image.classList.remove('loading');
      image.onerror = () => { image.classList.remove('loading'); setStatus('有图片没有加载出来，请刷新页面。', true); };
      image.src = imageUrl(pair.images[view.id][row.role]);
      image.alt = row.name + '，' + view.label;
      if (image.complete && image.naturalWidth) image.classList.remove('loading');
    }
  }
  $('task').textContent = pair.title + (EVIDENCE[pair.variant] ? ' · 资料：' + EVIDENCE[pair.variant] : '');
  const chosen = state.latest.get(pair.id);
  setStatus(chosen ? '这一对已选“' + CHOICE_TEXT[chosen] + '”。再选一次即修改，按“下一对”保持不变。' : '');
  state.shownAt = performance.now();
  state.hiddenMs = 0;
  state.hiddenSince = document.hidden ? state.shownAt : null;
  updateControls();
  preload(nextUnrated(state.pairs, state.latest, index));
}

async function vote(choice) {
  const pair = state.pairs[state.current];
  if (!pair || state.busy || state.zoom || state.asking || !state.rater) return;
  if (document.querySelector('.cell img.loading')) { setStatus('图片还在加载，请稍候再选。'); return; }
  const now = performance.now(), rater = state.rater;
  const hidden = state.hiddenMs + (state.hiddenSince === null ? 0 : now - state.hiddenSince);
  // busy also keeps 更换 off until the vote is saved, so the vote and its result stay this rater's.
  state.busy = true;
  updateControls();
  setStatus('正在保存……');
  try {
    const response = await fetch('vote', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rater, pair: pair.id, choice, ...elapsed(state.shownAt, now, hidden) }) });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(answer.error || 'HTTP ' + response.status);
    if (state.rater !== rater) { state.busy = false; return; }
    state.latest.set(pair.id, choice);
    state.trail = state.trail.filter(item => item !== state.current);
    state.trail.push(state.current);
    state.busy = false;
    show(afterCurrent(state.pairs, state.latest, state.current, state.ahead));
  } catch (error) {
    state.busy = false;
    updateControls();
    setStatus('保存失败：' + error.message + '。请再选一次。', true);
  }
}

function back() {
  if (state.busy || state.asking || !state.trail.length) return;
  state.ahead.push(state.current);
  show(state.trail.pop());
}

function forward() {
  const pair = state.pairs[state.current];
  if (state.busy || state.asking || !pair || !state.latest.has(pair.id)) return;
  state.trail = state.trail.filter(item => item !== state.current);
  state.trail.push(state.current);
  show(afterCurrent(state.pairs, state.latest, state.current, state.ahead));
}

// Enlarged view of one picture; arrows move through the grid of the same pair.
function openZoom(viewIndex, rowIndex) {
  if (state.current < 0 || state.asking) return;
  state.zoom = { view: viewIndex, row: rowIndex };
  drawZoom();
  $('zoom').hidden = false;
}
function drawZoom() {
  const pair = state.pairs[state.current], view = state.views[state.zoom.view], row = ROWS[state.zoom.row];
  $('zoom-image').src = imageUrl(pair.images[view.id][row.role]);
  $('zoom-image').alt = row.name + '，' + view.label;
  $('zoom-caption').textContent = row.name + ' · ' + view.label;
}
function closeZoom() {
  state.zoom = null;
  $('zoom').hidden = true;
}
function zoomKey(event) {
  const moves = { ArrowUp: ['row', -1], ArrowDown: ['row', 1], ArrowLeft: ['view', -1], ArrowRight: ['view', 1] };
  if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); closeZoom(); return; }
  const move = moves[event.key];
  if (!move) return;
  event.preventDefault();
  const [axis, step] = move, count = axis === 'row' ? ROWS.length : state.views.length;
  state.zoom[axis] = (state.zoom[axis] + step + count) % count;
  drawZoom();
}

// The rater's name: kept in this browser, so it is asked once. Storage may be
// unavailable (a private window); then it is asked on every visit.
function storedRater() {
  try { return raterId(localStorage.getItem(RATER_STORAGE)); } catch { return null; }
}
function storeRater(id) {
  try { localStorage.setItem(RATER_STORAGE, id); } catch { /* asked again next time */ }
}

// Shows the name form; resolves with the rater's id, or null when a change of
// rater is cancelled. While it is open no key votes, so typing 1, 0 or 2 is safe.
function askRater({ current = '', cancellable = false } = {}) {
  closeZoom();
  return new Promise(resolve => {
    const opened = performance.now();
    const finish = id => {
      $('ask').hidden = true;
      state.asking = null;
      // The time the form was open does not count as time spent on the pair.
      state.hiddenMs += performance.now() - opened;
      resolve(id);
    };
    state.asking = { cancel: cancellable ? () => finish(null) : null };
    $('ask-name').value = current;
    $('ask-error').textContent = '';
    $('ask-cancel').hidden = !cancellable;
    $('ask-cancel').onclick = () => state.asking?.cancel?.();
    $('ask-form').onsubmit = event => {
      event.preventDefault();
      const typed = $('ask-name').value.trim().toLowerCase(), id = raterId(typed);
      if (!id) {
        $('ask-error').textContent = typed === LEGACY_RATER ? LEGACY_RATER + ' 留给没有记名的旧选择，请换一个名字。' : '名字只能用英文字母和数字，1 到 32 个。';
        return;
      }
      finish(id);
    };
    $('ask').hidden = false;
    $('ask-name').focus();
  });
}

// Reads this rater's votes, then makes them the rater and shows their first
// unrated pair. Nothing votes until then (busy): during a change of rater the
// pair on screen still belongs to the previous one. On failure the previous
// rater stays.
async function useRater(id) {
  state.busy = true;
  updateControls();
  let votes;
  try {
    const response = await fetch('votes?rater=' + encodeURIComponent(id), { cache: 'no-store' });
    if (!response.ok) throw new Error('已有选择 HTTP ' + response.status);
    ({ votes } = await response.json());
  } finally {
    state.busy = false;
    updateControls();
  }
  const known = new Set(state.pairs.map(pair => pair.id));
  storeRater(id);
  state.rater = id;
  state.latest = latestChoices(votes.filter(item => known.has(item.pair)));
  state.trail = votedTrail(state.pairs, votes);
  state.ahead = [];
  $('rater').textContent = '评审者 ' + id;
  $('change-rater').hidden = false;
  show(nextUnrated(state.pairs, state.latest));
}

async function changeRater() {
  if (state.busy || state.asking) return;
  const id = await askRater({ current: state.rater ?? '', cancellable: true });
  if (!id || id === state.rater) return;
  try { await useRater(id); } catch (error) { setStatus('没能换成评审者 ' + id + '（' + error.message + '），仍是评审者 ' + state.rater + '。', true); }
}

document.addEventListener('keydown', event => {
  if (state.asking) {
    if (event.key === 'Escape' && state.asking.cancel) { event.preventDefault(); state.asking.cancel(); }
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (state.zoom) { zoomKey(event); return; }
  if (event.repeat) return;
  const choice = KEY_CHOICES[event.key];
  if (choice) { event.preventDefault(); vote(choice); }
});
document.addEventListener('visibilitychange', () => {
  const now = performance.now();
  if (document.hidden) state.hiddenSince = now;
  else if (state.hiddenSince !== null) { state.hiddenMs += now - state.hiddenSince; state.hiddenSince = null; }
});
$('zoom').addEventListener('click', closeZoom);
$('back').addEventListener('click', back);
$('forward').addEventListener('click', forward);
$('change-rater').addEventListener('click', () => { $('change-rater').blur(); changeRater(); });
// Focus leaves a clicked button, so Enter or Space cannot vote again on the next pair.
for (const button of choiceButtons()) button.addEventListener('click', () => { button.blur(); vote(button.dataset.choice); });

async function start() {
  try {
    const pairsResponse = await fetch('pairs.json', { cache: 'no-store' });
    if (!pairsResponse.ok) throw new Error('题目列表 HTTP ' + pairsResponse.status);
    const study = await pairsResponse.json();
    state.pairs = study.pairs;
    state.views = study.views;
    buildGrid();
    let id = storedRater();
    if (!id) {
      setStatus('');
      id = await askRater();
    }
    await useRater(id);
  } catch (error) {
    setStatus('无法开始：' + error.message, true);
  }
}

start();
