// HTML building blocks for the static results report. Plain strings, escaped at
// the boundary; no scripts, no external assets, light and dark via CSS.
export const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const isNumber = value => typeof value === 'number' && Number.isFinite(value);
export const NOT_EVALUATED = '<span class="na" title="not evaluated or not reported">n/a</span>';

export function num(value, digits = 1, { signed = false, suffix = '' } = {}) {
  if (!isNumber(value)) return NOT_EVALUATED;
  const text = value.toFixed(digits);
  return esc((signed && value > 0 ? '+' : '') + (text === '-' + (0).toFixed(digits) ? (0).toFixed(digits) : text) + suffix);
}

export const percent = (fraction, digits = 0) => isNumber(fraction) ? num(fraction * 100, digits, { suffix: '%' }) : NOT_EVALUATED;

// A summarised metric (stats.summarise) as a table cell: value, interval and n.
export function statCell(stat, { digits = 1, signed = false, suffix = '', scale = 1, unit = 'objects' } = {}) {
  if (!stat || !isNumber(stat.mean)) {
    const n = stat?.objects ? ' (n = ' + stat.objects + ')' : '';
    return '<td class="num">' + NOT_EVALUATED + (n ? '<small>' + esc(n) + '</small>' : '') + '</td>';
  }
  const value = num(stat.mean * scale, digits, { signed, suffix });
  const ci = stat.ci95 ? '[' + num(stat.ci95[0] * scale, digits, { signed }) + ', ' + num(stat.ci95[1] * scale, digits, { signed }) + ']' : 'no interval';
  const n = 'n = ' + stat.objects + ' ' + (stat.objects === 1 ? unit.replace(/s$/, '') : unit) + (isNumber(stat.attempts) ? ', ' + stat.attempts + ' att.' : '');
  const title = n + (stat.basis ? '; ' + stat.basis : '') + (stat.low_evidence ? '; LOW EVIDENCE: fewer than 3 objects' : '');
  return '<td class="num' + (stat.low_evidence ? ' low' : '') + '" title="' + esc(title) + '">' + value + (stat.low_evidence ? '<span class="dagger">&dagger;</span>' : '') +
    '<small>' + ci + '</small><small>' + esc(n) + '</small></td>';
}

export function page({ title, body, root = '.' }) {
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + esc(title) + '</title>\n<link rel="stylesheet" href="' + esc(root) + '/assets/style.css">\n</head>\n<body>\n<main>\n' + body + '\n</main>\n</body>\n</html>\n';
}

export const STYLE = `:root {
  color-scheme: light dark;
  --bg: #fbfaf7; --panel: #ffffff; --fg: #1c1e21; --muted: #5d636a; --line: #dedad2; --head: #f1efe9;
  --accent: #245a8c; --low: #8a6412; --bad: #a3352a; --good: #276a3b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15171a; --panel: #1c1f23; --fg: #e7e5e0; --muted: #a3a9b0; --line: #343940; --head: #22262b;
    --accent: #8fbbe6; --low: #e0bd62; --bad: #ef8f80; --good: #8fd3a2;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1440px; margin: 0 auto; padding: 24px 16px 72px; }
h1 { font-size: 1.6rem; margin: 0 0 4px; }
h2 { font-size: 1.2rem; margin: 36px 0 10px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.02rem; margin: 22px 0 8px; }
a { color: var(--accent); }
p { max-width: 80ch; }
small, .muted { color: var(--muted); }
code { font: 0.92em ui-monospace, SFMono-Regular, Menlo, monospace; }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
table { border-collapse: collapse; font-variant-numeric: tabular-nums; width: max-content; min-width: 100%; }
th, td { padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
thead th { background: var(--head); font-weight: 600; position: sticky; top: 0; }
tbody tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; }
td small { display: block; font-size: 0.78em; line-height: 1.3; }
td.low { color: var(--low); }
.dagger { margin-left: 1px; }
.na { color: var(--muted); font-style: italic; }
.bad { color: var(--bad); }
.good { color: var(--good); }
.legend { font-size: 0.9em; color: var(--muted); max-width: 100ch; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 8px 0 0; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; }
.evidence { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
figure { margin: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
figure img { display: block; width: 100%; height: auto; border-radius: 3px; }
figcaption { font-size: 0.85em; margin-top: 6px; }
.renders { display: grid; gap: 10px; }
.render-row { display: grid; grid-template-columns: 180px repeat(var(--views), minmax(150px, 1fr)); gap: 8px; align-items: start; }
.render-row .label, .render-row .view { font-size: 0.88em; padding-top: 4px; overflow-wrap: anywhere; }
.render-row .label small { display: block; }
/* Same box for every view; the renders' own background colour fills the letterbox. */
.render-row img { display: block; width: 100%; height: auto; aspect-ratio: 4 / 3; object-fit: contain; background: #f3f2ee; border: 1px solid var(--line); border-radius: 4px; }
.placeholder { border: 1px dashed var(--line); border-radius: 4px; padding: 18px 10px; text-align: center; color: var(--muted); font-size: 0.88em; }
.renders-wrap { overflow-x: auto; }
.renders-wrap .renders { min-width: 820px; }
pre.notes { white-space: pre-wrap; max-height: 320px; overflow: auto; font-size: 0.85em; background: var(--head); padding: 8px; border-radius: 4px; }
details > summary { cursor: pointer; color: var(--accent); }
nav.crumbs { font-size: 0.9em; margin-bottom: 12px; }
@media (max-width: 720px) {
  .render-row { grid-template-columns: repeat(var(--views), minmax(140px, 1fr)); }
  .render-row .label { grid-column: 1 / -1; }
  .render-row .corner { display: none; }
}
`;
