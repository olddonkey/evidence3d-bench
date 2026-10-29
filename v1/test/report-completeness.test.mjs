import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rng } from '../lib/rng.mjs';
import { layout } from '../lib/contract.mjs';
import { writeSampleRuns, taskIdFor } from '../lib/report/sample-runs.mjs';
import { buildLeaderboard, summaryMarkdown, collectRuns, parseRoster, rosterProvenance, rosterTasks, INCOMPLETE_REASONS, REAL_TIER_MIN_OBJECTS, MISSING_SHARE_LIMIT,
  FAMILY_ALPHA } from '../lib/report/index.mjs';
import { indexPage } from '../lib/report/index-page.mjs';

// Completeness, demotion and incomplete pairs (docs/V1-ROUND4-PLAN.md sections 2 to 4).

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' is not within ' + tolerance + ' of ' + expected);
const NOW = new Date('2026-10-29T12:00:00Z');
const keyOf = (system, model, effort) => [system, model, effort ?? '-'].join(' / ');

// Hand-made attempts, one per task, on `objects` objects and the given
// variants. Each configuration is [system, model, effort, mean]; `skip` maps a
// configuration key to the task ids it has no counted sample on.
function design(configurations, { objects = 12, noise = 3, set = 'test', variants = ['t2', 't4', 'c1'], skip = {}, seed = 'completeness-tests', score = null } = {}) {
  const random = rng(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - random.next())) * Math.cos(2 * Math.PI * random.next());
  const attempts = [];
  for (let o = 0; o < objects; o++) {
    const objectEffect = 8 * normal();
    for (const [system, model, effort, base] of configurations) {
      const key = keyOf(system, model, effort);
      for (const variant of variants) {
        const task = 'o' + o + '-' + variant, value = score ? score(base, o) : Math.max(0, Math.min(100, base + objectEffect + noise * normal()));
        if (skip[key]?.includes(task)) continue;
        attempts.push({ batch: [system, model, effort ?? 'none'].join('-'), task_id: task, attempt: 1, system, model, effort, status: 'ok', excluded: false,
          valid: true, score: value, object: 'o' + o, variant, set, archetype: 'house', scale_evidence: 'none', usage: null, wall_seconds: null, cost_usd: null,
          report: { valid: true, score: value, alignment: { frame_error: { offset_fraction: 0, offset_m: 0, yaw_deg: 0 } }, detail: { score: 0 }, shape: { scale: 1 } } });
      }
    }
  }
  return { attempts, batches: [], problems: [] };
}

const FOUR = [['codex', 'astra', 'high', 70], ['codex', 'astra', 'max', 76], ['claude-code', 'opus', 'high', 66], ['claude-code', 'opus', 'max', 72]];
const ASTRA = keyOf('codex', 'astra', 'high'), ASTRA_MAX = keyOf('codex', 'astra', 'max'), OPUS = keyOf('claude-code', 'opus', 'high'), OPUS_MAX = keyOf('claude-code', 'opus', 'max');
// The four configurations on their ladders; `extra` is merged into one configuration by key.
function roster(extra = {}, top = {}) {
  const item = (system, model, effort, ladder) => ({ system, model, effort, ladder, ...(extra[keyOf(system, model, effort)] ?? {}) });
  return parseRoster({ schema: 'e3d-roster-v1', round: 'test', ...top, configurations: [item('codex', 'astra', 'high', 'default'), item('codex', 'astra', 'max', 'top'),
    item('claude-code', 'opus', 'high', 'default'), item('claude-code', 'opus', 'max', 'top')] }, { file: 'rounds/test.json' });
}
const pairOf = (set, a, b) => set.pairwise.pairs.find(pair => (pair.a === a && pair.b === b) || (pair.a === b && pair.b === a));
const involves = key => pair => pair.a === key || pair.b === key;

test('a roster records missing tasks, demotions and required variants, and refuses malformed ones', () => {
  assert.throws(() => parseRoster({ schema: 'e3d-roster-v1', required_variants: [], configurations: [{ system: 'codex', model: 'a', effort: 'high' }] }),
    /required_variants must be a non-empty list/);
  assert.throws(() => parseRoster({ schema: 'e3d-roster-v1', required_variants: ['t2', 'x9', 't2'], configurations: [
    { system: 'codex', model: 'a', effort: 'high', missing_tasks: 'o1-t2' },
    { system: 'codex', model: 'b', effort: 'high', missing_tasks: [{ task: 'o1-t2' }, { task: 'o2-t2', reason: 'quota' }, { task: 'o2-t2', reason: 'again' }] },
    { system: 'codex', model: 'c', effort: 'high', demoted: '  ' },
  ] }), error => {
    assert.match(error.message, /unknown variant "x9"/);
    assert.match(error.message, /required_variants lists a variant twice/);
    assert.match(error.message, /configurations\[0\]: missing_tasks must be a list/);
    assert.match(error.message, /configurations\[1\]\.missing_tasks\[0\]: needs a task id and a reason/);
    assert.match(error.message, /missing task o2-t2 is listed twice/);
    assert.match(error.message, /configurations\[2\]: demoted must be the reason/);
    return true;
  });
  const parsed = parseRoster({ schema: 'e3d-roster-v1', required_variants: ['t4', 't2'], configurations: [
    { system: 'codex', model: 'a', effort: 'high', missing_tasks: [{ task: ' o1-t2 ', reason: ' usage limit until the window closed ' }] },
    { system: 'codex', model: 'b', effort: 'high', demoted: 'missed 30 of 216 tasks' }, { system: 'codex', model: 'c', effort: 'high' }] });
  assert.deepEqual(parsed.required_variants, ['t4', 't2']);
  assert.deepEqual(parsed.configurations.map(item => [item.missing_tasks, item.demoted]),
    [[[{ task: 'o1-t2', reason: 'usage limit until the window closed' }], null], [[], 'missed 30 of 216 tasks'], [[], null]]);
  assert.deepEqual(rosterTasks(parsed), ['o1-t2']);
  const provenance = rosterProvenance(parsed);
  assert.deepEqual(provenance.required_variants, ['t4', 't2']);
  assert.deepEqual(provenance.configurations[1].demoted, 'missed 30 of 216 tasks');
  assert.equal(parseRoster({ schema: 'e3d-roster-v1', configurations: [{ system: 'codex', model: 'a' }] }).required_variants, null);
  assert.equal(MISSING_SHARE_LIMIT, 0.05);
});

test('listed missing tasks within 5 %: still ranked, but its pairs are incomplete, in m with p = 1', () => {
  const data = design(FOUR, { skip: { [OPUS]: ['o3-t4'] } });
  const board = buildLeaderboard(data, { now: NOW, roster: roster({ [OPUS]: { missing_tasks: [{ task: 'o3-t4', reason: 'usage limit until the window closed' }] } }) });
  const set = board.sets[0];
  assert.equal(set.tier, 'main');
  // 1 of 36 tasks (2.8 %) is within the limit: ranked, nothing demoted, no data problem.
  assert.ok(Number.isInteger(board.entries.find(entry => entry.key === OPUS).rank));
  assert.deepEqual(set.demoted_configurations, []);
  assert.ok(!board.problems.some(problem => /does not list as missing|refused/.test(problem)), board.problems.join('\n'));
  const record = set.completeness.configurations.find(item => item.key === OPUS);
  assert.deepEqual([record.expected, record.sampled, record.missing, record.unlisted], [36, 35, [{ task: 'o3-t4', reason: 'usage limit until the window closed' }], []]);
  assert.equal(set.completeness.missing_share_limit, MISSING_SHARE_LIMIT);
  // Its three pairs: no verdict, intervals kept, p = 1 in a family that still has all six pairs.
  for (const pair of set.pairwise.pairs.filter(involves(OPUS))) {
    assert.equal(pair.verdict, 'incomplete');
    assert.equal(pair.incomplete, 'missing_tasks');
    assert.ok(pair.ci95 && pair.t_ci95, 'the gap keeps its intervals');
    assert.equal(pair.holm.verdict, 'incomplete');
    near(pair.holm.p_adjusted, 1);
    assert.match(pair.statement, /incomplete, no verdict: tasks the roster lists as missing/);
  }
  assert.deepEqual([set.pairwise.correction.comparisons, set.pairwise.correction.incomplete], [6, 3]);
  // The other pairs keep their uncorrected numbers, and m stays six: the
  // incomplete pairs make no other pair easier to separate.
  const plain = buildLeaderboard(design(FOUR), { now: NOW, roster: roster() }).sets[0];
  for (const pair of set.pairwise.pairs.filter(pair => !involves(OPUS)(pair))) {
    const same = pairOf(plain, pair.a, pair.b);
    assert.deepEqual([pair.mean_difference, pair.ci95, pair.p_t, pair.verdict], [same.mean_difference, same.ci95, same.p_t, same.verdict]);
    assert.equal(pair.holm.comparisons, 6);
    assert.ok(pair.holm.p_adjusted >= same.holm.p_adjusted - 1e-12);
  }
  // On the default ladder (Astra high vs Opus high) the only pair is incomplete too.
  const ladder = set.ladders.find(item => item.id === 'default');
  assert.deepEqual(ladder.pairwise.pairs.map(pair => pair.verdict), ['incomplete']);
  assert.equal(ladder.pairwise.correction.incomplete, 1);
  // The effort pair of Opus as well; Astra's is decided.
  assert.equal(set.effort.pairs.find(pair => pair.model === 'opus').verdict, 'incomplete');
  assert.notEqual(set.effort.pairs.find(pair => pair.model === 'astra').verdict, 'incomplete');
});

test('a formal configuration missing more than 5 % is refused unless the roster demotes it', () => {
  const gaps = ['o3-t4', 'o7-c1'], listed = gaps.map(task => ({ task, reason: 'usage limit' }));
  const data = design(FOUR, { skip: { [OPUS]: gaps } });
  assert.throws(() => buildLeaderboard(data, { now: NOW, roster: roster({ [OPUS]: { missing_tasks: listed } }) }),
    /roster rounds\/test.json refused: in set test, claude-code \/ opus \/ high misses 2 of 36 tasks \(5\.6 %\), more than 5 %; the roster must mark it demoted/);

  const board = buildLeaderboard(data, { now: NOW, roster: roster({ [OPUS]: { missing_tasks: listed, demoted: 'missed 2 of 36 tasks (usage limit)' } }) });
  const set = board.sets[0], opus = board.entries.find(entry => entry.key === OPUS);
  // No rank, but listed, and in every family it belongs to.
  assert.equal(opus.rank, null);
  assert.equal(opus.demoted, 'missed 2 of 36 tasks (usage limit)');
  assert.equal(opus.reference, false);
  assert.deepEqual(set.demoted_configurations, [OPUS]);
  assert.ok(!set.configurations.includes(OPUS));
  assert.deepEqual(board.entries.map(entry => entry.rank), [1, 2, 3, null], 'ranked rows first, then the demoted one');
  for (const pair of set.pairwise.pairs.filter(involves(OPUS))) {
    assert.equal(pair.incomplete, 'demoted');
    assert.equal(pair.holm.verdict, 'incomplete');
  }
  assert.equal(set.pairwise.correction.comparisons, 6);
  const ladder = set.ladders.find(item => item.id === 'default');
  assert.deepEqual(ladder.entries, [{ key: ASTRA, rank: 1 }, { key: OPUS, rank: null }]);
  assert.equal(ladder.pairwise.correction.comparisons, 1, 'the demoted configuration stays in the ladder family');
  assert.equal(ladder.pairwise.pairs[0].verdict, 'incomplete');
  assert.ok(!board.problems.some(problem => /demotes/.test(problem)));

  // Demoting within the limit is allowed, but reported.
  const within = buildLeaderboard(design(FOUR, { skip: { [OPUS]: ['o3-t4'] } }), { now: NOW,
    roster: roster({ [OPUS]: { missing_tasks: [listed[0]], demoted: 'judged unreliable' } }) });
  assert.ok(within.problems.some(problem => /demotes claude-code \/ opus \/ high, but in set test it misses only 1 of 36 listed tasks \(2\.8 %\)/.test(problem)));
  assert.equal(within.entries.find(entry => entry.key === OPUS).rank, null);
});

test('a gap the roster does not list is a data problem: the configuration keeps its rank, its pairs get no verdict', () => {
  const board = buildLeaderboard(design(FOUR, { skip: { [ASTRA_MAX]: ['o0-t2', 'o1-t2'] } }), { now: NOW, roster: roster() });
  const set = board.sets[0];
  assert.ok(board.problems.some(problem => problem === 'set test: codex / astra / max has no counted sample on 2 tasks that the roster does not list as missing (o0-t2, o1-t2); its pairs get no verdict'));
  assert.ok(Number.isInteger(board.entries.find(entry => entry.key === ASTRA_MAX).rank));
  for (const pair of set.pairwise.pairs.filter(involves(ASTRA_MAX))) assert.equal(pair.incomplete, 'unlisted_gaps');
  assert.equal(set.pairwise.correction.incomplete, 3);
  assert.deepEqual(set.completeness.configurations.find(item => item.key === ASTRA_MAX).unlisted, ['o0-t2', 'o1-t2']);

  // A listed task that has a counted sample after all: the sample counts, and the roster is told.
  const stale = buildLeaderboard(design(FOUR), { now: NOW, roster: roster({ [ASTRA]: { missing_tasks: [{ task: 'o2-c1', reason: 'thought lost' }] } }) });
  assert.ok(stale.problems.some(problem => /lists o2-c1 as missing for codex \/ astra \/ high, but set test has a counted sample; the sample counts/.test(problem)));
  assert.ok(stale.sets[0].pairwise.pairs.every(pair => pair.verdict !== 'incomplete'));

  // A planned task nobody ran (a manifest's, through taskInfo) is owed by every
  // formal configuration: unlisted, every pair is incomplete.
  const planned = design(FOUR);
  planned.taskInfo = new Map([['o12-t2', { set: 'test', object: 'o12', variant: 't2' }]]);
  const owed = buildLeaderboard(planned, { now: NOW, roster: roster() }).sets[0];
  assert.equal(owed.completeness.expected_tasks, 37);
  assert.ok(owed.pairwise.pairs.every(pair => pair.incomplete === 'unlisted_gaps'));
  // A missing task no batch planned and no truth.json places is reported.
  const unplaced = buildLeaderboard(design(FOUR), { now: NOW, roster: roster({ [OPUS]: { missing_tasks: [{ task: 'zz9-t2', reason: 'typo' }] } }) });
  assert.ok(unplaced.problems.some(problem => /lists missing tasks that no batch planned and no truth.json places in a set: zz9-t2/.test(problem)));
});

test('required_variants: only those variants are owed', () => {
  const skipC1 = Array.from({ length: 12 }, (_, o) => 'o' + o + '-c1');
  const data = design(FOUR, { skip: { [OPUS_MAX]: skipC1 } });
  const strict = buildLeaderboard(data, { now: NOW, roster: roster() });
  assert.ok(strict.problems.some(problem => /opus \/ max has no counted sample on 12 tasks that the roster does not list/.test(problem)));
  const relaxed = buildLeaderboard(data, { now: NOW, roster: roster({}, { required_variants: ['t2', 't4'] }) });
  const set = relaxed.sets[0];
  assert.ok(!relaxed.problems.some(problem => /does not list as missing/.test(problem)), relaxed.problems.join('\n'));
  assert.deepEqual([set.completeness.expected_tasks, set.completeness.required_variants], [24, ['t2', 't4']]);
  assert.ok(set.pairwise.pairs.every(pair => pair.verdict !== 'incomplete'));
  // Opus max is compared with the others on the tasks both ran: t2 and t4.
  assert.equal(pairOf(set, ASTRA, OPUS_MAX).tasks, 24);
  assert.equal(pairOf(set, ASTRA, OPUS).tasks, 36);
});

test('an undecidable test is incomplete without a roster too: no common object, one object, differences that do not vary', () => {
  // Every task of B scores exactly 4 below A's: t is undefined (no variation).
  const flat = design([['codex', 'a', 'high', 60], ['codex', 'b', 'high', 56], ['codex', 'c', 'high', 40]],
    { score: (base, o) => base === 40 ? 40 + 3 * ((o * 7) % 5) : base + 2 * o });
  const set = buildLeaderboard(flat, { now: NOW }).sets[0];
  const ab = pairOf(set, keyOf('codex', 'a', 'high'), keyOf('codex', 'b', 'high'));
  assert.equal(ab.p_t, null);
  assert.deepEqual([ab.verdict, ab.incomplete, ab.holm.verdict], ['incomplete', 'undefined_test', 'incomplete']);
  near(ab.mean_difference, 4);
  assert.equal(set.pairwise.correction.comparisons, 3);
  assert.equal(set.pairwise.correction.incomplete, 1);
  assert.notEqual(pairOf(set, keyOf('codex', 'a', 'high'), keyOf('codex', 'c', 'high')).verdict, 'incomplete');

  const one = buildLeaderboard(design([['codex', 'a', 'high', 60], ['codex', 'b', 'high', 50]], { objects: 1 }), { now: NOW }).sets[0];
  assert.deepEqual([one.pairwise.pairs[0].verdict, one.pairwise.pairs[0].incomplete, one.pairwise.correction.comparisons], ['incomplete', 'few_objects', 1]);
  assert.equal(one.completeness, null, 'no roster: nothing to check completeness against');
  assert.deepEqual(Object.keys(INCOMPLETE_REASONS), ['demoted', 'missing_tasks', 'unlisted_gaps', 'few_complete_objects', 'few_objects', 'undefined_test']);
});

test('real tier: compared on the objects both completed, at least 8 of them; missing tasks give no veto and no demotion', () => {
  const real = { set: 'real', variants: ['r2', 'r4'] };
  // Opus misses one task on each of 3 of 12 objects (3 of 24 tasks, 12.5 %): no
  // refusal and no demotion in the real tier; 9 objects complete on both sides.
  const gaps = ['o0-r4', 'o4-r2', 'o9-r4'], listed = gaps.map(task => ({ task, reason: 'photographs withdrawn' }));
  const board = buildLeaderboard(design(FOUR, { ...real, skip: { [OPUS]: gaps } }), { now: NOW, roster: roster({ [OPUS]: { missing_tasks: listed } }) });
  const set = board.sets[0];
  assert.equal(set.tier, 'real');
  assert.equal(set.completeness.missing_share_limit, null);
  assert.deepEqual(set.demoted_configurations, []);
  assert.ok(!board.problems.some(problem => /refused|demotes|does not list as missing/.test(problem)), board.problems.join('\n'));
  const decided = pairOf(set, ASTRA, OPUS);
  assert.deepEqual([decided.objects, decided.complete_objects, decided.tasks, decided.incomplete], [9, 9, 18, null]);
  assert.notEqual(decided.verdict, 'incomplete');
  assert.ok(decided.ci95 && finiteP(decided.p_t));
  // A pair of two complete configurations uses all 12 objects.
  assert.equal(pairOf(set, ASTRA, ASTRA_MAX).complete_objects, 12);

  // On 10 objects the same gaps leave 7 complete: below the minimum, no verdict and no intervals.
  const small = buildLeaderboard(design(FOUR, { ...real, objects: 10, skip: { [OPUS]: gaps } }), { now: NOW, roster: roster({ [OPUS]: { missing_tasks: listed } }) }).sets[0];
  const few = pairOf(small, ASTRA, OPUS);
  assert.equal(REAL_TIER_MIN_OBJECTS, 8);
  assert.deepEqual([few.complete_objects, few.verdict, few.incomplete, few.ci95, few.t_ci95], [7, 'incomplete', 'few_complete_objects', null, null]);
  assert.match(few.statement, /fewer than 8 objects both completed/);
  near(few.holm.p_adjusted, 1);
  assert.ok(small.pairwise.pairs.filter(pair => !involves(OPUS)(pair)).every(pair => pair.complete_objects === 10 && pair.verdict !== 'incomplete'));
  // An unlisted real-tier gap is still a data problem.
  const unlisted = buildLeaderboard(design(FOUR, { ...real, skip: { [OPUS]: ['o0-r4'] } }), { now: NOW, roster: roster() });
  assert.ok(unlisted.problems.some(problem => /set real: claude-code \/ opus \/ high has no counted sample on 1 task that the roster does not list/.test(problem)));
  assert.equal(pairOf(unlisted.sets[0], ASTRA, OPUS).incomplete, 'unlisted_gaps');
  // The real tier owes every one of its tasks, whatever required_variants says
  // (Round 3's roster names the test set's t2, t4, c1).
  const required = roster({}, { required_variants: ['t2', 't4', 'c1'] });
  const owedAll = buildLeaderboard(design(FOUR, { ...real, skip: { [OPUS]: ['o0-r4'] } }), { now: NOW, roster: required });
  assert.deepEqual([owedAll.sets[0].completeness.expected_tasks, owedAll.sets[0].completeness.required_variants], [24, null]);
  assert.ok(owedAll.problems.some(problem => /set real: claude-code \/ opus \/ high has no counted sample on 1 task that the roster does not list/.test(problem)));
  // An unlisted gap below 8 complete objects: no verdict and no interval either.
  const unlistedFew = buildLeaderboard(design(FOUR, { ...real, objects: 10, skip: { [OPUS]: ['o0-r4', 'o1-r4', 'o2-r2', 'o3-r4', 'o4-r2'] } }), { now: NOW, roster: roster() }).sets[0];
  const gap = pairOf(unlistedFew, ASTRA, OPUS);
  assert.deepEqual([gap.complete_objects, gap.incomplete, gap.ci95, gap.t_ci95], [5, 'unlisted_gaps', null, null]);
  // A main-set demotion does not reach the real tier: ranked, judged on complete objects.
  const demoted = buildLeaderboard(design(FOUR, { ...real, objects: 10 }), { now: NOW, roster: roster({ [OPUS]: { demoted: 'missed 30 of 216 main tasks' } }) });
  const tier = demoted.sets[0];
  assert.ok(Number.isInteger(demoted.entries.find(entry => entry.key === OPUS).rank));
  assert.equal(demoted.entries.find(entry => entry.key === OPUS).demoted, null);
  assert.deepEqual(tier.demoted_configurations, []);
  assert.equal(tier.completeness.configurations.find(item => item.key === OPUS).demoted, null);
  assert.ok(tier.pairwise.pairs.every(pair => pair.verdict !== 'incomplete' && pair.complete_objects === 10), 'no pair incomplete');
  assert.ok(!demoted.problems.some(problem => /demotes/.test(problem)));
});
const finiteP = value => typeof value === 'number' && Number.isFinite(value);

test('the page and summary.md show incomplete pairs, the demoted row and the completeness table', () => {
  const gaps = ['o3-t4', 'o7-c1'];
  const board = buildLeaderboard(design(FOUR, { skip: { [OPUS]: gaps } }), { now: NOW,
    roster: roster({ [OPUS]: { missing_tasks: gaps.map(task => ({ task, reason: 'usage limit' })), demoted: 'missed 2 of 36 tasks' } }) });
  const page = indexPage(board), summary = summaryMarkdown(board);
  for (const text of ['incomplete', '<h4>Demoted</h4>', 'Completeness', 'missed 2 of 36 tasks', 'usage limit', 'in m with p = 1']) assert.ok(page.includes(text), 'index.html has ' + text);
  for (const text of ['incomplete', 'Completeness', '| dem |', 'missed 2 of 36 tasks', 'p = 1']) assert.ok(summary.includes(text), 'summary.md has ' + text);
  assert.ok(FAMILY_ALPHA === 0.05);
  // A main set of variants the roster does not require owes nothing.
  const memory = buildLeaderboard(design(FOUR, { set: 'memory', variants: ['m2', 'm3'] }), { now: NOW, roster: roster({}, { required_variants: ['t2', 't4', 'c1'] }) });
  assert.equal(memory.sets[0].completeness.expected_tasks, 0);
  assert.match(indexPage(memory), /required variants \(t2, t4, c1\) ask nothing of this set/);
  assert.match(summaryMarkdown(memory), /required variants \(t2, t4, c1\) ask nothing of this set/);
});

test('collectRuns places planned and roster-listed tasks in their sets, run or not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e3d-completeness-'));
  try {
    const dataRoot = join(root, 'data');
    await writeSampleRuns(dataRoot, { withModels: false, withInputs: false });
    // demo-claude was also prepared with a task it never ran (one of Codex's).
    const file = join(layout(dataRoot).runs, 'demo-claude', 'manifest.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
    const planned = taskIdFor('demo-house-c', 't2'), listed = taskIdFor('demo-house-a', 'c1');
    manifest.tasks.push({ id: planned, attempts: [] });
    await writeFile(file, JSON.stringify(manifest));
    const collected = await collectRuns({ dataRoot, batches: ['demo-claude'], alsoTasks: [listed, 'no-such-task', '../escape'] });
    assert.ok(!collected.attempts.some(attempt => attempt.task_id === planned || attempt.task_id === listed));
    assert.deepEqual(collected.taskInfo.get(planned), { set: collected.taskInfo.get(taskIdFor('demo-house-a', 't1')).set, object: 'demo-house-c', variant: 't2' });
    assert.equal(collected.taskInfo.get(listed).variant, 'c1');
    assert.ok(!collected.taskInfo.has('no-such-task') && !collected.taskInfo.has('../escape'));
    for (const attempt of collected.attempts) assert.equal(collected.taskInfo.get(attempt.task_id).object, attempt.object);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('constant decimal differences leave t undefined despite rounding', async () => {
  const { tTestP, sampleSD } = await import('../lib/report/index.mjs');
  const twelve = Array(12).fill(2.3);
  assert.ok(sampleSD(twelve) > 0, 'rounding leaves a tiny SD (' + sampleSD(twelve) + ')');
  assert.equal(tTestP(twelve), null);
  assert.equal(tTestP(twelve.map((value, index) => value + (index % 2 ? 4e-15 : -4e-15))), null);
  assert.ok(tTestP([2.3, 2.3, 2.3000001, 2.3]) !== null, 'a real, if small, variation is tested');
  // In a leaderboard: B scores 2.3 below A on every task of every object.
  const set = buildLeaderboard(design([['codex', 'a', 'high', 61.7], ['codex', 'b', 'high', 59.4]], { score: (base, o) => base + 1.1 * o }), { now: NOW }).sets[0];
  const pair = set.pairwise.pairs[0];
  near(pair.mean_difference, 2.3, 1e-9);
  assert.deepEqual([pair.p_t, pair.verdict, pair.incomplete, pair.holm.verdict], [null, 'incomplete', 'undefined_test', 'incomplete']);
});

test('real tier: an object is complete only with both r2 and r4; scores use complete objects, intervals from 8', () => {
  const real = { set: 'real', variants: ['r2', 'r4'] };
  // Only r2 ran: no object is complete, whatever required_variants says.
  const r2only = buildLeaderboard(design(FOUR, { set: 'real', variants: ['r2'] }), { now: NOW, roster: roster({}, { required_variants: ['r2', 'r4'] }) });
  const lone = r2only.sets[0];
  assert.equal(lone.tier, 'real');
  assert.ok(r2only.problems.some(problem => /set real \(real tier\) has no task in these batches for 12 object × variants \(o0 r4, o1 r4, o10 r4, \.\.\.\): every formal configuration owes them/.test(problem)));
  // Every configuration owes the r4 placeholders: unlisted gaps, so no pair is decided (and none has an interval).
  assert.equal(lone.completeness.expected_tasks, 24);
  assert.ok(lone.completeness.configurations.every(record => record.unlisted.length === 12 && record.unlisted.includes('o3 r4 (no task in these batches)')));
  assert.ok(lone.pairwise.pairs.every(pair => pair.complete_objects === 0 && pair.incomplete === 'unlisted_gaps' && pair.ci95 === null));
  // No complete object: no score and no rank, but still listed and in every family.
  assert.ok(r2only.entries.every(entry => entry.rank === null && entry.score.mean === null && entry.real_tier.complete_objects === 0));
  assert.equal(lone.pairwise.correction.comparisons, 6);
  assert.match(indexPage(r2only), /no object with every r2 and r4 task sampled, so no score/);
  assert.match(summaryMarkdown(r2only), /\| – \| codex \/ astra \/ high \|/);

  // Opus misses r4 on 3 of 10 objects (listed): scored on its 7 complete objects, a point estimate only.
  const gaps = ['o0-r4', 'o4-r4', 'o9-r4'];
  const board = buildLeaderboard(design(FOUR, { ...real, objects: 10, skip: { [OPUS]: gaps } }), { now: NOW,
    roster: roster({ [OPUS]: { missing_tasks: gaps.map(task => ({ task, reason: 'photographs withdrawn' })) } }) });
  const opus = board.entries.find(entry => entry.key === OPUS), astra = board.entries.find(entry => entry.key === ASTRA);
  assert.deepEqual([opus.real_tier, opus.score.objects, opus.score.ci95, opus.shape.ci95, opus.variants.r2.objects], [{ complete_objects: 7, sampled_objects: 10, intervals: false }, 7, null, null, 7]);
  assert.ok(Number.isInteger(opus.rank));
  assert.deepEqual([astra.real_tier.complete_objects, astra.score.objects], [10, 10]);
  assert.ok(astra.score.ci95, 'ten complete objects: an interval');
  assert.match(indexPage(board), /missing tasks<\/span><small>ranked; its pairs use the objects both completed/);
  assert.match(summaryMarkdown(board), /missing tasks \(ranked; pairs use the objects both completed\)/);
});

test('families stay frozen when every formal attempt of a set is excluded', () => {
  const data = design([...FOUR, ['grok', 'g', 'high', 50]]);
  for (const attempt of data.attempts) if (attempt.system !== 'grok') Object.assign(attempt, { excluded: true, status: 'infra_error' });
  const board = buildLeaderboard(data, { now: NOW, roster: roster() });
  const set = board.sets[0];
  assert.deepEqual(set.absent_configurations.sort(), [ASTRA, ASTRA_MAX, OPUS, OPUS_MAX].sort());
  assert.equal(set.pairwise.correction.comparisons, 6);
  assert.equal(set.pairwise.correction.incomplete, 6);
  assert.equal(set.completeness.configurations.length, 4);
  assert.deepEqual(set.unranked.map(item => item.key).sort(), [ASTRA, ASTRA_MAX, OPUS, OPUS_MAX].sort());
});

test('required_variants must name variants by their own string keys; an unplaceable planned task is reported', async () => {
  for (const bad of [[['t2']], ['toString'], [7]]) {
    assert.throws(() => parseRoster({ schema: 'e3d-roster-v1', required_variants: bad, configurations: [{ system: 'codex', model: 'a' }] }), /required_variants: unknown variant/);
  }
  const root = await mkdtemp(join(tmpdir(), 'e3d-completeness-'));
  try {
    const dataRoot = join(root, 'data');
    await writeSampleRuns(dataRoot, { withModels: false, withInputs: false });
    const file = join(layout(dataRoot).runs, 'demo-claude', 'manifest.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.tasks.push({ id: 'ghost-t2', attempts: [] }, { id: '../escape', attempts: [] });
    await writeFile(file, JSON.stringify(manifest));
    const collected = await collectRuns({ dataRoot, batches: ['demo-claude'] });
    assert.ok(!collected.taskInfo.has('ghost-t2'));
    assert.ok(collected.problems.some(problem => problem.startsWith('batch demo-claude planned task ghost-t2, but it has no truth.json')));
    assert.ok(collected.problems.some(problem => problem.startsWith('batch demo-claude planned task ../escape, but it has no truth.json')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real tier: every per-object figure uses the complete objects; bookkeeping counts every attempt', () => {
  const withCurves = data => {
    for (const attempt of data.attempts) Object.assign(attempt, { wall_limit_seconds: 600, wall_seconds: 550, cost_usd: 1,
      snapshots: { interval_seconds: 300, points: [{ t: 300, score: attempt.score / 2 }] } });
    return data;
  };
  // Seven of ten objects complete for Opus (r4 listed missing on three).
  const gaps = ['o0-r4', 'o4-r4', 'o9-r4'];
  const data = withCurves(design(FOUR, { set: 'real', variants: ['r2', 'r4'], objects: 10, skip: { [OPUS]: gaps } }));
  const opusAttempts = data.attempts.filter(attempt => attempt.model === 'opus' && attempt.effort === 'high');
  opusAttempts.find(attempt => attempt.task_id === 'o0-r2').valid = false;
  const board = buildLeaderboard(data, { now: NOW, roster: roster({ [OPUS]: { missing_tasks: gaps.map(task => ({ task, reason: 'photographs withdrawn' })) } }) });
  const opus = board.entries.find(entry => entry.key === OPUS);
  assert.deepEqual([opus.archetypes.house.objects, opus.archetypes.house.ci95], [7, null]);
  assert.ok(opus.time_curve.available && opus.time_curve.points.every(point => point.objects === 7 && point.ci95 === null));
  assert.equal(opus.time_curve.points.at(-1).mean, opus.score.mean, 'the curve still ends at the score');
  assert.deepEqual([opus.frame_error.offset_m.ci95, opus.evidence_deltas['r4-r2']?.ci95 ?? null], [null, null]);
  // Bookkeeping: all 17 attempts, the invalid one on a partial object included.
  assert.deepEqual([opus.attempts, opus.success.attempts, opus.success.valid, opus.cost_usd.total, opus.objects], [17, 17, 16, 17, 10]);
  const astra = board.entries.find(entry => entry.key === ASTRA);
  assert.ok(astra.archetypes.house.ci95 && astra.time_curve.points.every(point => point.ci95), 'ten complete objects: intervals');

  // No complete object (only r2 ran): no figure at all, the attempts still counted.
  const none = buildLeaderboard(withCurves(design(FOUR, { set: 'real', variants: ['r2'], objects: 10 })), { now: NOW, roster: roster() });
  const lone = none.entries.find(entry => entry.key === OPUS);
  assert.deepEqual([lone.score.mean, lone.archetypes, lone.variants, lone.time_curve, lone.attempts, lone.success.attempts], [null, {}, {}, null, 10, 10]);
});

test('a ladder whose only pair has a demoted or absent member still shows it; the status names a configuration without a complete object', () => {
  const two = [['codex', 'astra', 'high', 70], ['claude-code', 'opus', 'high', 66]];
  const gaps = ['o3-t4', 'o7-c1'];
  const pick = extra => parseRoster({ schema: 'e3d-roster-v1', configurations: [{ system: 'codex', model: 'astra', effort: 'high', ladder: 'default' },
    { system: 'claude-code', model: 'opus', effort: 'high', ladder: 'default', ...extra }] });
  const demoted = buildLeaderboard(design(two, { skip: { [OPUS]: gaps } }), { now: NOW,
    roster: pick({ missing_tasks: gaps.map(task => ({ task, reason: 'usage limit' })), demoted: 'missed 2 of 36 tasks' }) });
  const page = indexPage(demoted);
  assert.match(page, /<details class="more" open><summary>All 1 pair of this ladder<\/summary>/);
  const absent = buildLeaderboard(design([two[0]]), { now: NOW, roster: pick({}) });
  assert.match(indexPage(absent), /All 1 pair of this ladder/);
  // Opus has r2 everywhere but lists every r4 as missing: no complete object, no rank.
  const r4 = Array.from({ length: 10 }, (_, o) => 'o' + o + '-r4');
  const real = buildLeaderboard(design(two, { set: 'real', variants: ['r2', 'r4'], objects: 10, skip: { [OPUS]: r4 } }), { now: NOW,
    roster: pick({ missing_tasks: r4.map(task => ({ task, reason: 'no survey notes' })) }) });
  assert.equal(real.entries.find(entry => entry.key === OPUS).rank, null);
  assert.equal(real.sets[0].completeness.configurations.find(item => item.key === OPUS).complete_objects, 0);
  assert.match(indexPage(real), /no complete object<\/span><small>no object with every r2 and r4 task: no score, no rank/);
  assert.match(summaryMarkdown(real), /no complete object \(no score, no rank; pairs incomplete\)/);
});

test('real tier: variance rows and Student-t intervals follow the complete-object rules too', () => {
  const gaps = ['o0-r4', 'o4-r4', 'o9-r4'];
  const board = buildLeaderboard(design(FOUR, { set: 'real', variants: ['r2', 'r4'], objects: 10, skip: { [OPUS]: gaps } }), { now: NOW,
    roster: roster({ [OPUS]: { missing_tasks: gaps.map(task => ({ task, reason: 'photographs withdrawn' })) } }) });
  const set = board.sets[0], opus = board.entries.find(entry => entry.key === OPUS);
  // Seven complete objects: the evidence delta keeps no interval of either kind.
  assert.ok(opus.evidence_deltas['r4-r2'], 'r4 - r2 is reported');
  assert.deepEqual([opus.evidence_deltas['r4-r2'].ci95 ?? null, opus.evidence_deltas['r4-r2'].t_ci95 ?? null], [null, null]);
  assert.doesNotMatch(summaryMarkdown(board).split('\n').filter(line => line.includes(OPUS) && line.includes('t [')).join('\n'), /t \[/);
  const row = set.variance.configurations.find(item => item.key === OPUS);
  assert.deepEqual([row.object_sd.objects, row.object_sd.ci95, row.attempt_sd.ci95], [7, null, null]);
  const astraRow = set.variance.configurations.find(item => item.key === ASTRA);
  assert.ok(astraRow.object_sd.ci95 && astraRow.object_sd.objects === 10);
  const pairRow = set.variance.pairs.find(item => [item.a, item.b].includes(OPUS) && [item.a, item.b].includes(ASTRA));
  assert.deepEqual([pairRow.objects, pairRow.difference_sd.ci95, pairRow.detectable_range], [7, null, null]);
  assert.doesNotMatch(pairRow.statement, /95% range/);
  // No complete object (only r2 ran): no object SD at all.
  const none = buildLeaderboard(design(FOUR, { set: 'real', variants: ['r2'], objects: 10 }), { now: NOW, roster: roster() }).sets[0];
  assert.ok(none.variance.configurations.every(item => item.object_sd.objects === 0 && item.object_sd.sd === null && item.object_sd.ci95 === null));
});

test('a ladder family whose members are all absent is shown; so is a configuration that never ran a real task', () => {
  // Only the default-effort configurations ran: the top family is one incomplete pair of two absent members.
  const board = buildLeaderboard(design([FOUR[0], FOUR[2]]), { now: NOW, roster: roster() });
  const top = board.sets[0].ladders.find(ladder => ladder.id === 'top');
  assert.deepEqual([top.entries.length, top.pairwise.pairs.length, top.pairwise.pairs[0].incomplete], [0, 1, 'unlisted_gaps']);
  const page = indexPage(board);
  assert.match(page, /Each client’s top effort <small>0 of 1 pair separated after Holm \(0 uncorrected; 1 incomplete, in m with p = 1\)<\/small><\/h4><p class="muted">No configuration of this set is on this ladder with a counted attempt/);
  assert.match(page, /<details class="more" open><summary>All 1 pair of this ladder/);
  // Real tier: Opus max never ran, and the roster lists all its tasks as missing.
  const all = Array.from({ length: 10 }, (_, o) => ['o' + o + '-r2', 'o' + o + '-r4']).flat();
  const real = buildLeaderboard(design([FOUR[0], FOUR[1], FOUR[2]], { set: 'real', variants: ['r2', 'r4'], objects: 10 }), { now: NOW,
    roster: roster({ [OPUS_MAX]: { missing_tasks: all.map(task => ({ task, reason: 'not run' })) } }) });
  const record = real.sets[0].completeness.configurations.find(item => item.key === OPUS_MAX);
  assert.deepEqual([record.present, record.complete_objects, record.unlisted.length], [false, 0, 0]);
  assert.match(indexPage(real), /no complete object<\/span>/);
  assert.match(summaryMarkdown(real), new RegExp(OPUS_MAX.replace(/[/]/g, '\\/') + '.*no complete object'));
});

test('real tier: an object missing one variant is a gap of everyone; each summary and the pooled SD keep intervals only from 8 objects', () => {
  // Nine objects with r2 and r4, a tenth with r2 only.
  const data = design(FOUR, { set: 'real', variants: ['r2', 'r4'], objects: 10 });
  data.attempts = data.attempts.filter(attempt => attempt.task_id !== 'o9-r4');
  const board = buildLeaderboard(data, { now: NOW, roster: roster() });
  const set = board.sets[0];
  assert.equal(set.completeness.expected_tasks, 20);
  assert.ok(board.problems.some(problem => /has no task in these batches for 1 object × variant \(o9 r4\)/.test(problem)));
  assert.ok(set.completeness.configurations.every(record => record.sampled === 19 && record.unlisted[0] === 'o9 r4 (no task in these batches)'));
  assert.ok(set.pairwise.pairs.every(pair => pair.incomplete === 'unlisted_gaps' && pair.complete_objects === 9));

  // Ten complete objects in two archetypes of five: the configuration keeps its
  // interval, each archetype row does not; seven usable objects on a curve point neither.
  const mixed = design(FOUR, { set: 'real', variants: ['r2', 'r4'], objects: 10 });
  for (const attempt of mixed.attempts) {
    const o = Number(attempt.object.slice(1));
    Object.assign(attempt, { archetype: o < 5 ? 'house' : 'shop', wall_limit_seconds: 600, wall_seconds: 550,
      snapshots: { interval_seconds: 300, points: [{ t: 300, ...(o < 3 ? { status: 'score_error' } : { score: attempt.score / 2 }) }] } });
  }
  // Repeated attempts so the pooled attempt SD is estimated.
  mixed.attempts.push(...mixed.attempts.map(attempt => ({ ...attempt, attempt: 2, score: attempt.score + 1, report: { ...attempt.report, score: attempt.score + 1 } })));
  const wide = buildLeaderboard(mixed, { now: NOW, roster: roster() });
  const astra = wide.entries.find(entry => entry.key === ASTRA);
  assert.ok(astra.score.ci95, 'ten complete objects');
  assert.deepEqual([astra.archetypes.house.objects, astra.archetypes.house.ci95, astra.archetypes.shop.ci95], [5, null, null]);
  const early = astra.time_curve.points.find(point => point.t === 300);
  assert.deepEqual([early.objects, early.ci95], [7, null]);
  assert.ok(astra.time_curve.points.find(point => point.t === 600).ci95, 'the final point rests on ten objects');
  assert.ok(wide.sets[0].variance.attempt_sd_pooled.ci95, 'pooled over ten objects: a range');

  // Seven objects in all, every one complete: the pooled SD has no range either.
  const seven = design(FOUR, { set: 'real', variants: ['r2', 'r4'], objects: 7 });
  seven.attempts.push(...seven.attempts.map(attempt => ({ ...attempt, attempt: 2, score: attempt.score + 1, report: { ...attempt.report, score: attempt.score + 1 } })));
  const pooled = buildLeaderboard(seven, { now: NOW, roster: roster() }).sets[0].variance.attempt_sd_pooled;
  assert.ok(Number.isFinite(pooled.sd));
  assert.deepEqual([pooled.objects, pooled.ci95], [7, null]);
});
