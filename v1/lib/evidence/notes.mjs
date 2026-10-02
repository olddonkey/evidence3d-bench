import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateModel } from '../model.mjs';
import { validateEvidenceItem } from '../contract.mjs';
import { rng } from '../rng.mjs';

// Site-survey notes: the model's named dimensions written up the way a surveyor
// would, plus a few remarks that carry no geometry. Everything numeric comes
// straight from model.dimensions, so the notes can never contradict the truth;
// the remarks are chosen to be true of any object (weather, access, method) and
// never name parts, materials or features the object might not have.
export const NOTES_FILE = 'notes/survey-notes.md';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SURVEYORS = ['A. M.', 'J. R.', 'K. L.', 'S. T.', 'P. D.', 'R. N.', 'H. B.', 'E. C.', 'M. O.', 'L. V.'];
const WEATHER = [
  'Dry and overcast during the visit; good light for the laser readings.',
  'Bright and dry with a light wind.',
  'Light drizzle on arrival, dry by the time measuring started.',
  'Cold, dry and still.',
  'Warm and hazy; no problems with the instruments.',
];
const ACCESS = [
  'External survey only; the interior was not inspected.',
  'Access to every side was arranged in advance; no internal survey was carried out.',
  'All sides could be reached from public land; nothing was measured inside.',
];
const METHOD = [
  'Lengths taken with a laser distance meter and checked by tape where reachable.',
  'Readings taken twice with a laser distance meter and averaged.',
  'Measured with a laser distance meter; tape checks agreed with the laser readings.',
];
const MILLIMETRE_PHRASES = [
  (label, mm) => label + ' measured ' + mm + ' mm.',
  (label, mm) => label + ': ' + mm + ' mm.',
  (label, mm) => label + ' taken as ' + mm + ' mm.',
];

export async function writeNotes({ model, outDir, seed, capturedAt }) {
  validateModel(model);
  const { text, metric } = surveyNotes({ model, seed, capturedAt });
  await mkdir(join(outDir, 'notes'), { recursive: true });
  const bytes = Buffer.from(text, 'utf8');
  await writeFile(join(outDir, NOTES_FILE), bytes);
  return [validateEvidenceItem({
    id: 'notes', kind: 'notes', file: NOTES_FILE, captured_at: capturedAt,
    description: 'Site survey notes with measured dimensions', metric, source_model: 'primary',
    camera: null, occluders: [], sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
  })];
}

// Pure text generation, deterministic in (model, seed, capturedAt).
export function surveyNotes({ model, seed, capturedAt }) {
  const match = /^(\d{4})-(\d{2})$/.exec(capturedAt ?? '');
  if (!match || +match[2] < 1 || +match[2] > 12) throw new Error('capturedAt must be YYYY-MM');
  const random = rng(seed ?? 0).fork('notes/' + capturedAt);
  const day = random.int(3, 26), date = day + ' ' + MONTHS[+match[2] - 1] + ' ' + match[1];
  const dimensions = model.dimensions ?? [];

  // Surveyors write small things in millimetres: the smallest one or two go to prose in mm.
  const millimetreCount = dimensions.length >= 4 ? 2 : dimensions.length >= 2 ? 1 : 0;
  const inMillimetres = new Set([...dimensions].map((d, order) => ({ d, order }))
    .sort((p, q) => p.d.value_m - q.d.value_m || p.order - q.order).slice(0, millimetreCount).map(entry => entry.d));
  const sentence = label => label.charAt(0).toUpperCase() + label.slice(1);

  const lines = ['# Site survey notes', '', '- Subject: ' + model.title, '- Date of visit: ' + date, '- Surveyor: ' + random.pick(SURVEYORS), ''];
  lines.push('## Measured dimensions', '');
  const tableRows = dimensions.filter(d => !inMillimetres.has(d));
  if (tableRows.length) {
    lines.push('| Measurement | Value |', '| --- | --- |');
    for (const d of tableRows) lines.push('| ' + d.label.replace(/\|/g, '/') + ' | ' + d.value_m.toFixed(2) + ' m |');
    lines.push('', 'Values in metres are rounded to the nearest 10 mm.', '');
  }
  for (const d of dimensions.filter(item => inMillimetres.has(item))) {
    lines.push(random.pick(MILLIMETRE_PHRASES)(sentence(d.label), Math.round(d.value_m * 1000)));
  }
  if (!dimensions.length) lines.push('No dimensions were recorded on this visit.');
  lines.push('', '## Remarks', '');
  const remarks = [random.pick(WEATHER), random.pick(ACCESS), random.pick(METHOD)];
  for (const remark of remarks.slice(0, random.chance(0.5) ? 2 : 3)) lines.push('- ' + remark);
  lines.push('');
  return { text: lines.join('\n'), metric: dimensions.length > 0, date, millimetres: [...inMillimetres].map(d => d.id) };
}
