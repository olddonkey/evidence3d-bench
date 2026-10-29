import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { rng } from '../lib/rng.mjs';
import { buildLeaderboard, writeReport, summaryMarkdown, correctFamily, holmAdjust, tTestP, tInterval, parseRoster, readRoster, rosterPath, inferLadders, studentQuantile,
  allPairsNote, FAMILY_ALPHA } from '../lib/report/index.mjs';
import { writeSampleRuns } from '../lib/report/sample-runs.mjs';

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' is not within ' + tolerance + ' of ' + expected);
const NOW = new Date('2026-10-28T12:00:00Z');
const random = rng('ladder-tests');
const normal = () => Math.sqrt(-2 * Math.log(1 - random.next())) * Math.cos(2 * Math.PI * random.next());

// Hand-made attempts: one per task, t2 / t4 / c1 on `objects` objects. Each
// configuration is [system, model, effort, mean]; objects share an effect.
function design(configurations, { objects = 12, noise = 3, set = 'test' } = {}) {
  const attempts = [];
  for (let o = 0; o < objects; o++) {
    const objectEffect = 8 * normal();
    for (const [system, model, effort, base] of configurations) {
      for (const variant of ['t2', 't4', 'c1']) {
        const score = Math.max(0, Math.min(100, base + objectEffect + noise * normal()));
        attempts.push({ batch: [system, model, effort ?? 'none'].join('-'), task_id: 'o' + o + '-' + variant, attempt: 1, system, model, effort, status: 'ok', excluded: false,
          valid: true, score, object: 'o' + o, variant, set, archetype: 'house', scale_evidence: 'none', usage: null, wall_seconds: null, cost_usd: null,
          report: { valid: true, score, alignment: { frame_error: { offset_fraction: 0, offset_m: 0, yaw_deg: 0 } }, detail: { score: 0 }, shape: { scale: 1 } } });
      }
    }
  }
  return { attempts, batches: [], problems: [] };
}

test('Holm adjustment and the paired t p-value by hand', () => {
  // Sorted 0.005, 0.01, 0.03, 0.04 with m = 4: x4, x3, x2, x1, never below the one before.
  const adjusted = holmAdjust([0.01, 0.04, 0.03, 0.005]);
  [0.03, 0.06, 0.06, 0.02].forEach((value, index) => near(adjusted[index], value));
  // Untestable entries are not counted in m and stay null.
  assert.deepEqual(holmAdjust([0.01, null, 0.02, undefined]).map(value => value === null ? null : Math.round(value * 1e9) / 1e9), [0.02, null, 0.02, null]);
  assert.deepEqual(holmAdjust([]), []);
  near(holmAdjust([0.6, 0.7])[1], 1, 0);
  // One comparison: no adjustment.
  near(holmAdjust([0.012])[0], 0.012);

  // t = 3 / (sqrt(2.5) / sqrt(5)) = 4.243 on 4 df: p = 0.01324.
  near(tTestP([1, 2, 3, 4, 5]), 0.013236, 1e-5);
  // Differences that do not vary leave t undefined: no p-value (such a pair is incomplete).
  assert.equal(tTestP([2, 2, 2]), null, 'identical nonzero differences');
  assert.equal(tTestP([0, 0, 0]), null, 'no difference at all');
  assert.equal(tTestP([5]), null);
  // The t interval at level 1 - p just touches zero, so p < 0.05 exactly when
  // the 95 % t interval excludes zero.
  for (let trial = 0; trial < 200; trial++) {
    const values = Array.from({ length: 3 + (trial % 20) }, () => 0.4 * (trial % 7) + normal());
    const p = tTestP(values), interval = tInterval(values);
    assert.equal(p < 0.05, interval[0] > 0 || interval[1] < 0, 'trial ' + trial + ': p ' + p + ' interval ' + interval);
    if (p > 1e-6 && p < 1) {
      const touching = tInterval(values, 1 - p), half = (touching[1] - touching[0]) / 2;
      near(Math.abs(touching[0] + touching[1]) / 2, half, 1e-6 * Math.max(1, half));
    }
  }
  assert.ok(studentQuantile(0.975, 4) > 2.77 && studentQuantile(0.975, 4) < 2.78);
});

test('a corrected verdict separates only what Holm keeps and the uncorrected verdict already separates', () => {
  const rows = [{ verdict: 'a_higher', p_t: 0.001 }, { verdict: 'a_higher', p_t: 0.03 }, { verdict: 'unsettled', p_t: 0.04 }, { verdict: 'incomplete', p_t: 0.0002 },
    { verdict: 'b_higher', p_t: 0.012 }, { verdict: 'unsettled', p_t: 0.0001 }];
  const holm = correctFamily(rows, 'all');
  // The incomplete pair stays in m with p = 1, whatever p it had: m = 6, sorted
  // 0.0001 x6, 0.001 x5, 0.012 x4, 0.03 x3, 0.04 x2 (raised to 0.09), 1 x1.
  assert.deepEqual(holm.map(item => item.verdict), ['a_higher', 'not_separated', 'not_separated', 'incomplete', 'b_higher', 'not_separated']);
  assert.ok(holm.every(item => item.comparisons === 6 && item.family === 'all'));
  near(holm[0].p_adjusted, 0.005);
  near(holm[1].p_adjusted, 0.09);
  near(holm[2].p_adjusted, 0.09);
  near(holm[3].p_adjusted, 1);
  // 0.012 x 4 (it would be x 3 with the incomplete pair left out of m).
  near(holm[4].p_adjusted, 0.048);
  // An unsettled pair (the two intervals disagree) stays unseparated even with a tiny p.
  assert.ok(holm[5].p_adjusted < FAMILY_ALPHA);
});

test('ladders are inferred from effort: default, top, effort pairs, and what is placed nowhere', () => {
  const board = buildLeaderboard(design([
    ['codex', 'astra', 'high', 70], ['codex', 'astra', 'max', 76], ['codex', 'astra', 'medium', 64],
    // Opus scores lower at max than at high here: the effort pair must read top - default all the same.
    ['claude-code', 'opus', 'high', 68], ['claude-code', 'opus', 'max', 66],
    ['claude-code', 'haiku', null, 30],
    ['grok', 'g', 'xhigh', 50],
    ['antigravity', 'gemini', 'high', 60],
  ]), { now: NOW });
  const set = board.sets[0];
  const ladder = id => set.ladders.find(item => item.id === id);
  assert.deepEqual(ladder('default').entries.map(item => item.key), ['codex / astra / high', 'claude-code / opus / high', 'claude-code / haiku / -']
    .sort((a, b) => board.entries.find(entry => entry.key === b).score.mean - board.entries.find(entry => entry.key === a).score.mean));
  assert.deepEqual(ladder('default').entries.map(item => item.rank), [1, 2, 3]);
  assert.deepEqual(new Set(ladder('top').entries.map(item => item.key)), new Set(['codex / astra / max', 'claude-code / opus / max', 'grok / g / xhigh']));
  // Every configuration is formal without a roster; off-ladder ones keep their leaderboard rank.
  assert.ok(board.entries.every(entry => entry.reference === false && Number.isInteger(entry.rank)));
  assert.deepEqual(board.entries.find(entry => entry.key === 'codex / astra / medium').ladders, []);
  assert.deepEqual(board.entries.find(entry => entry.key === 'antigravity / gemini / high').ladders, []);
  assert.ok(set.ladder_notes.some(note => /codex \/ astra \/ medium: below the client’s default/.test(note)));
  assert.ok(set.ladder_notes.some(note => /does not know antigravity’s default effort/.test(note)));
  assert.match(set.ladder_rule, /inferred/);

  // A ladder's pairs are the leaderboard's pairs, same numbers, Holm over the ladder alone.
  const full = new Map(set.pairwise.pairs.map(pair => [pair.a + '|' + pair.b, pair]));
  const defaults = ladder('default').pairwise;
  assert.equal(defaults.pairs.length, 3);
  assert.equal(defaults.correction.comparisons, 3);
  for (const pair of defaults.pairs) {
    const same = full.get(pair.a + '|' + pair.b);
    assert.ok(same, pair.a + ' vs ' + pair.b + ' keeps the table\'s orientation');
    assert.deepEqual([pair.mean_difference, pair.ci95, pair.t_ci95, pair.p_t, pair.verdict], [same.mean_difference, same.ci95, same.t_ci95, same.p_t, same.verdict]);
    assert.equal(pair.holm.comparisons, 3);
    assert.equal(same.holm.comparisons, set.pairwise.correction.comparisons);
    assert.ok(pair.holm.p_adjusted <= same.holm.p_adjusted + 1e-12, 'a smaller family never corrects harder');
  }
  assert.equal(set.pairwise.correction.comparisons, 28, 'all 8 configurations: 28 pairs');

  // Effort pairs: top - default per client and model with both; Opus read the other way round.
  assert.deepEqual(set.effort.pairs.map(pair => [pair.system, pair.model, pair.default_effort, pair.top_effort]).sort(),
    [['claude-code', 'opus', 'high', 'max'], ['codex', 'astra', 'high', 'max']]);
  const opus = set.effort.pairs.find(pair => pair.model === 'opus');
  const stored = full.get('claude-code / opus / high|claude-code / opus / max');
  assert.equal(opus.a, 'claude-code / opus / max');
  near(opus.mean_difference, -stored.mean_difference);
  assert.deepEqual(opus.ci95, [-stored.ci95[1], -stored.ci95[0]]);
  assert.deepEqual([opus.won, opus.lost], [stored.lost, stored.won]);
  assert.equal(opus.verdict, { a_higher: 'b_higher', b_higher: 'a_higher' }[stored.verdict] ?? stored.verdict);
  assert.equal(set.effort.correction.comparisons, 2);
});

test('inferLadders: two runs that both count as the default are not guessed between', () => {
  const { ladders, notes } = inferLadders([{ key: 'claude-code / opus / -', system: 'claude-code', model: 'opus', effort: null },
    { key: 'claude-code / opus / high', system: 'claude-code', model: 'opus', effort: 'high' }, { key: 'claude-code / opus / max', system: 'claude-code', model: 'opus', effort: 'max' },
    { key: 'grok / g / turbo', system: 'grok', model: 'g', effort: 'turbo' }]);
  assert.deepEqual(ladders.get('claude-code / opus / -'), []);
  assert.deepEqual(ladders.get('claude-code / opus / high'), []);
  assert.deepEqual(ladders.get('claude-code / opus / max'), ['top']);
  assert.deepEqual(ladders.get('grok / g / turbo'), []);
  assert.ok(notes.some(note => /both count as the client’s default/.test(note)));
  assert.ok(notes.some(note => /turbo: effort not in the known order/.test(note)));
});

test('a roster is validated as a whole', () => {
  assert.throws(() => parseRoster({ schema: 'nope', configurations: [] }), error => /schema must be "e3d-roster-v1"/.test(error.message) && /non-empty list/.test(error.message));
  assert.throws(() => parseRoster({ schema: 'e3d-roster-v1', configurations: [
    { system: 'codex', model: 'a', effort: 'high', ladder: 'default' },
    { system: 'codex', model: 'a', effort: 'high', ladder: 'top' },
    { system: 'codex', model: 'a', effort: 'max', ladder: 'default' },
    { system: 'codex', model: 'b', effort: 'max', ladder: 'best' },
    { model: 'c', effort: 3 },
  ] }), error => {
    assert.match(error.message, /codex \/ a \/ high is listed twice/);
    assert.match(error.message, /codex \/ a is on the default ladder twice/);
    assert.match(error.message, /unknown ladder "best"/);
    assert.match(error.message, /system is required/);
    assert.match(error.message, /effort must be a name or null/);
    return true;
  });
  const roster = parseRoster({ schema: 'e3d-roster-v1', round: 'r', configurations: [{ system: 'claude-code', model: 'haiku', effort: null, ladder: ['top', 'default'] },
    { system: 'codex', model: 'a', effort: 'high' }] });
  assert.deepEqual(roster.configurations.map(item => [item.key, item.ladders]), [['claude-code / haiku / -', ['default', 'top']], ['codex / a / high', []]]);
});

test('the Round 3 roster reproduces the ladders of docs/V1-ROUND3.md and matches what inference gives', async () => {
  const roster = await readRoster('v1/rounds/round3.roster.json');
  assert.equal(roster.file, 'v1/rounds/round3.roster.json');
  assert.match(roster.sha256, /^[a-f0-9]{64}$/);
  const onLadder = id => roster.configurations.filter(item => item.ladders.includes(id)).map(item => item.key);
  assert.equal(roster.configurations.length, 12, '12 configurations, 66 pairs');
  // Owed: the test set's three-variant headline; no missing task, nothing demoted.
  assert.deepEqual(roster.required_variants, ['t2', 't4', 'c1']);
  assert.ok(roster.configurations.every(item => !item.missing_tasks.length && item.demoted === null));
  // The keys exactly as the Round 3 result.json files record them (Haiku with its date suffix).
  assert.deepEqual(roster.configurations.map(item => item.key).sort(), [
    'claude-code / claude-haiku-4-5-20251001 / -', 'claude-code / claude-opus-5-5 / high', 'claude-code / claude-opus-5-5 / max',
    'codex / gpt-5.6-luna / high', 'codex / gpt-6-astra / high', 'codex / gpt-6-astra / max', 'codex / gpt-6-sol / high', 'codex / gpt-6.1-sol / high',
    'codex / gpt-6.1-sol / max', 'grok / grok-4.6 / high', 'grok / grok-4.7 / high', 'grok / grok-4.7-build-fast / high']);
  assert.deepEqual(onLadder('top'), ['codex / gpt-6-astra / max', 'codex / gpt-6.1-sol / max', 'claude-code / claude-opus-5-5 / max']);
  assert.equal(onLadder('default').length, 9);
  const { ladders } = inferLadders(roster.configurations);
  for (const item of roster.configurations) assert.deepEqual(ladders.get(item.key), item.ladders, item.key);
});

test('the roster file is recorded relative to the repository root, whatever the working directory, or by name outside it', () => {
  const inRepo = fileURLToPath(new URL('../rounds/round3.roster.json', import.meta.url)), cwd = process.cwd();
  try {
    process.chdir(tmpdir());
    assert.equal(rosterPath(inRepo), 'v1/rounds/round3.roster.json');
    assert.equal(rosterPath(join(tmpdir(), 'somewhere', 'round9.roster.json')), 'round9.roster.json');
  } finally { process.chdir(cwd); }
  assert.equal(rosterPath('v1/rounds/round3.roster.json'), 'v1/rounds/round3.roster.json');
});

test('a ladder pair notes when the table of all pairs corrects it the other way', () => {
  const holm = (verdict, p, comparisons) => ({ family: 'x', comparisons, p_adjusted: p, verdict });
  const set = { pairwise: { pairs: [
    { a: 'A', b: 'B', verdict: 'a_higher', holm: holm('not_separated', 0.088, 66) },
    { a: 'A', b: 'C', verdict: 'a_higher', holm: holm('a_higher', 0.001, 66) },
    { a: 'B', b: 'C', verdict: 'a_higher', reference: true, holm: null },
  ] } };
  const note = allPairsNote(set);
  assert.equal(note({ a: 'A', b: 'B', verdict: 'a_higher', holm: holm('a_higher', 0.0098, 3) }), 'not separated in the table of all 66 pairs (adj. p = 0.088)');
  // Read the other way round (an effort pair is top minus default): the same pair.
  assert.equal(note({ a: 'B', b: 'A', verdict: 'b_higher', holm: holm('b_higher', 0.0098, 3) }), 'not separated in the table of all 66 pairs (adj. p = 0.088)');
  assert.equal(note({ a: 'A', b: 'C', verdict: 'a_higher', holm: holm('a_higher', 0.0005, 3) }), '', 'same verdict: no note');
  assert.equal(note({ a: 'B', b: 'C', verdict: 'a_higher', holm: holm('a_higher', 0.01, 3) }), '', 'not corrected in the large table: no note');
  assert.equal(note(set.pairwise.pairs[0]), '', 'the pair itself');
});

test('with a roster: reference rows are listed, unranked and in no family; the uncorrected numbers do not move', () => {
  const data = design([['codex', 'astra', 'high', 70], ['codex', 'astra', 'max', 76], ['claude-code', 'opus', 'high', 68], ['claude-code', 'opus', 'max', 72],
    ['claude-code', 'haiku', null, 30], ['grok', 'g', 'high', 75]]);
  const roster = parseRoster({ schema: 'e3d-roster-v1', round: 'test', decided_at: '2026-10-28', configurations: [
    { system: 'codex', model: 'astra', effort: 'high', ladder: 'default' }, { system: 'codex', model: 'astra', effort: 'max', ladder: 'top' },
    { system: 'claude-code', model: 'opus', effort: 'high', ladder: 'default' }, { system: 'claude-code', model: 'opus', effort: 'max', ladder: 'top' },
    { system: 'codex', model: 'luna', effort: 'high', ladder: 'default' },
  ] }, { file: 'rounds/test.json' });
  const plain = buildLeaderboard(data, { now: NOW }), board = buildLeaderboard(data, { now: NOW, roster });
  const set = board.sets[0];
  assert.deepEqual(set.reference_configurations.sort(), ['claude-code / haiku / -', 'grok / g / high']);
  assert.equal(set.configurations.length, 4);
  // Formal entries first, ranked 1..4; reference rows after them, rank null, even the one that scored highest.
  assert.deepEqual(board.entries.map(entry => entry.rank), [1, 2, 3, 4, null, null]);
  assert.ok(board.entries.slice(4).every(entry => entry.reference));
  // Same seeds, same pairs: the roster changes no uncorrected number.
  const luna = 'codex / luna / high', ran = pair => pair.a !== luna && pair.b !== luna;
  const strip = pair => ({ ...pair, statement: undefined, holm: undefined, reference: undefined, incomplete: undefined });
  assert.deepEqual(set.pairwise.pairs.filter(ran).map(strip), plain.sets[0].pairwise.pairs.map(strip));
  // The family is the roster's: Luna never ran, yet its four pairs with the
  // other formal configurations count in m, undecided, with p = 1.
  assert.deepEqual(set.absent_configurations, [luna]);
  assert.equal(set.pairwise.correction.comparisons, 10, 'five roster configurations: ten pairs');
  assert.equal(set.pairwise.correction.incomplete, 4);
  for (const pair of set.pairwise.pairs) {
    if (pair.reference) assert.equal(pair.holm, null);
    else assert.equal(pair.holm.comparisons, 10);
    if (!ran(pair)) {
      assert.equal(pair.verdict, 'incomplete'); assert.equal(pair.incomplete, 'unlisted_gaps'); assert.equal(pair.objects, 0);
      if (!pair.reference) { assert.equal(pair.holm.verdict, 'incomplete'); near(pair.holm.p_adjusted, 1); }
    }
  }
  assert.match(set.pairwise.multiple_comparisons, /4 of them incomplete, entered with p = 1/);
  assert.match(set.pairwise.multiple_comparisons, /the 11 pairs with a reference row are not corrected/);
  const ladder = id => set.ladders.find(item => item.id === id);
  assert.deepEqual(ladder('default').missing, [luna]);
  assert.deepEqual(ladder('top').missing, []);
  assert.equal(ladder('default').entries.length, 2);
  assert.equal(ladder('default').pairwise.correction.comparisons, 3, 'Astra high, Opus high and the absent Luna');
  assert.equal(set.effort.pairs.length, 2);
  assert.ok(board.problems.some(problem => /roster rounds\/test.json lists codex \/ luna \/ high, which no attempt in these batches ran/.test(problem)));
  assert.ok(board.problems.some(problem => /codex \/ luna \/ high has no counted sample on 36 tasks that the roster does not list as missing/.test(problem)));
  assert.equal(board.roster.file, 'rounds/test.json');
  assert.equal(board.roster.decided_at, '2026-10-28');
  assert.match(board.method.correction, /Holm/);
  assert.match(set.ladder_rule, /reference rows/);
  // The same roster as plain JSON is parsed on the way in.
  const raw = buildLeaderboard(data, { now: NOW, roster: { schema: 'e3d-roster-v1', configurations: roster.configurations.map(({ system, model, effort, ladders }) => ({ system, model, effort, ladder: ladders })) } });
  assert.deepEqual(raw.entries.map(entry => [entry.key, entry.rank]), board.entries.map(entry => [entry.key, entry.rank]));
  assert.throws(() => buildLeaderboard(data, { roster: { schema: 'e3d-roster-v1', configurations: [] } }), /non-empty list/);
});

test('Holm removes separations a 95 % table of many equal configurations would claim', () => {
  // Ten configurations with no true difference: uncorrected, some of the 45
  // pairs separate by chance; after Holm, none should (family-wise 5 %).
  let uncorrected = 0, corrected = 0;
  for (let trial = 0; trial < 6; trial++) {
    const board = buildLeaderboard(design(Array.from({ length: 10 }, (_, i) => ['codex', 'm' + i, 'high', 60]), { objects: 10, noise: 4 }), { now: NOW, seed: 'null-' + trial });
    const { correction } = board.sets[0].pairwise;
    assert.equal(correction.comparisons, 45);
    uncorrected += correction.separated_uncorrected;
    corrected += correction.separated;
    assert.ok(correction.separated <= correction.separated_uncorrected);
  }
  assert.ok(uncorrected > 0, 'some chance separations without correction (' + uncorrected + ')');
  assert.ok(corrected <= 1, 'at most a rare one with it (' + corrected + ')');
});

test('the page and summary.md show both ladders, the Holm column and the reference rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e3d-ladders-'));
  try {
    const dataRoot = join(root, 'data');
    await writeSampleRuns(dataRoot, { withModels: false });
    const rosterFile = join(root, 'roster.json');
    await writeFile(rosterFile, JSON.stringify({ schema: 'e3d-roster-v1', round: 'demo', configurations: [{ system: 'codex', model: 'gpt-demo', effort: 'high', ladder: 'default' }] }));
    const roster = await readRoster(rosterFile);
    assert.equal(roster.file, 'roster.json', 'outside the repository: the name alone');
    const result = await writeReport({ dataRoot, batches: ['demo-codex', 'demo-claude'], outDir: join(root, 'out'), now: NOW, roster });
    const index = await readFile(result.index, 'utf8'), summary = await readFile(result.summary, 'utf8');
    for (const text of ['<h3>Ladders</h3>', 'Each client’s default effort', 'Each client’s top effort', '>Holm<small>m = ', 'Reference rows', 'reference row']) {
      assert.ok(index.includes(text), 'index.html has ' + text);
    }
    for (const text of ['### Ladders', '#### Each client’s default effort', 'Holm (m = ', '| ref |', 'Formal configurations and ladders from the roster']) {
      assert.ok(summary.includes(text), 'summary.md has ' + text);
    }
    assert.equal(summary, summaryMarkdown(JSON.parse(await readFile(result.leaderboard, 'utf8'))));
    const set = result.sets[0];
    assert.deepEqual(set.ranking.map(row => [row.rank, row.reference ?? false]), [[1, false], [null, true]]);
    assert.deepEqual(set.ladders.map(ladder => ladder.id), ['default', 'top']);
    assert.ok(set.pairs.every(pair => pair.holm === null), 'the only pair has a reference row');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
