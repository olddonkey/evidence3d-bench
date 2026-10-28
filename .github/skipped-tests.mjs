import { relative } from 'node:path';

// A node:test reporter that lists every test which skipped itself, with its
// file and reason, as Markdown. CI prints the list and puts it in the job
// summary, so what Linux did not run (Seatbelt, Blender, batches and reference
// packs that are only on the Mac) is visible without reading the whole log.
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//     --test-reporter=./.github/skipped-tests.mjs --test-reporter-destination=skipped.md <files>
const cell = text => String(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export default async function* skippedTests(source) {
  const rows = [];
  for await (const { type, data } of source) {
    if (type === 'test:pass' && data.skip) rows.push([data.file ? relative(process.cwd(), data.file) : '', data.name, data.skip === true ? '' : data.skip]);
  }
  if (!rows.length) { yield 'No test skipped itself.\n'; return; }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  yield `${rows.length} skipped:\n\n| File | Test | Reason |\n| --- | --- | --- |\n`;
  for (const row of rows) yield '| ' + row.map(cell).join(' | ') + ' |\n';
}
