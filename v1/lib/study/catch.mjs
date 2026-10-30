import { readFile, writeFile, mkdir, stat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON } from '../../../lib/io.mjs';
import { rng } from '../rng.mjs';
import { soupFromModel } from '../soup.mjs';
import { validateModel } from '../model.mjs';
import { decodePNG } from '../png.mjs';
import { generateModel, GENERATOR_VERSION } from '../generator/index.mjs';
import { mutations } from '../score/mutations.mjs';
import { studyCameras, renderViews, STUDY_VIEWS, STUDY_SIZE, STUDY_SHADING, FRAME_FILL, BACKGROUND } from './render.mjs';
import { imageName, ROLES } from './select.mjs';
import { voteFiles, readVoteFiles, lockVoting, KEY_BACKUP } from './votes.mjs';
import { LEGACY_RATER } from './page/state.js';
import { isCatch, isOriginal } from './panel.mjs';
import { studyDir, DEFAULT_DATA_ROOT } from './index.mjs';

// Catch pairs for rater qualification (Round 4 plan, docs/V1-ROUND4-PLAN.md
// section 5.1). Their answer is fixed by construction, not by the scorer: a
// development-set object's truth on one side, the same truth with one massing
// or roof group taken away on the other (calibrate's dropGroup defect), both
// drawn exactly as the study draws a pair (same cameras on the truth's bounds,
// same clay shading), the truth on side A in half of them. They are added to a
// prepared study, also one that the owner has started rating, but before any
// other rater has voted: no pair is changed or moved before the last pair the
// owner has rated, and no vote is touched. Voting stops while they are added:
// add-catch holds the study's lock (votes.mjs VOTING_LOCK) from reading the
// study to writing it, the server saves each vote under the same lock, and a
// server started before refuses votes until it is restarted. key.json marks them (`catch`), pairs.json does not, and they
// count in no agreement, only in the qualification.

export const CATCH_PAIRS = 6;
export const CATCH_CATEGORIES = ['massing', 'roof'];
// The group's absence must be plain to see: at least this share of the
// truth's drawn pixels, over the four views, changes when it is taken away
// (a chimney changes about 2 %, a house's roof about 34 %).
export const MIN_CHANGED_SHARE = 0.15;
export const DEV_SET_FILE = fileURLToPath(new URL('../../sets/dev.json', import.meta.url));

const exists = async path => stat(path).then(item => item.size > 0, () => false);

// The development set's truth models, by id (generated from v1/sets/dev.json,
// which is public: its seeds are not secret).
export async function devModels(file = DEV_SET_FILE) {
  const set = await readJSON(file), models = new Map();
  for (const entry of set.objects) {
    const model = validateModel(generateModel({ archetype: entry.archetype, seed: entry.seed }));
    models.set(model.id, { model, set: set.name, archetype: entry.archetype, seed: entry.seed });
  }
  return models;
}

// The share of the truth's drawn pixels that differ in another set of renders
// of the same views (`truthPixels`: decoded, per view; `otherViews`: PNG bytes).
function changedShare(truthPixels, otherViews, background) {
  let drawn = 0, changed = 0;
  for (const view of Object.keys(truthPixels)) {
    const a = truthPixels[view], b = decodePNG(otherViews[view].png).pixels;
    for (let i = 0; i < a.length; i += 3) {
      if (a[i] !== background[0] || a[i + 1] !== background[1] || a[i + 2] !== background[2]) drawn++;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) changed++;
    }
  }
  return drawn ? changed / drawn : 0;
}

function shuffle(list, random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random.next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

//   objects: development-set object ids (v1/sets/dev.json), used in turn;
//   seed: chooses the groups, the sides, the variants shown, the ids and the
//     places (written into the private record with the objects);
//   legacyRater: the owner's id, as for serve and analyze: votes without a
//     rater, and votes under this id, are the owner's. Any other rater's vote
//     stops add-catch.
export async function addCatchPairs({ dataRoot = DEFAULT_DATA_ROOT, name, objects, seed, count = CATCH_PAIRS, minChangedShare = MIN_CHANGED_SHARE,
  legacyRater = LEGACY_RATER, devSet = DEV_SET_FILE, now = () => new Date(), log = () => {} }) {
  if (!Array.isArray(objects) || !objects.length) throw new Error('add-catch needs at least one development-set object');
  if (new Set(objects).size !== objects.length) throw new Error('an object is named twice: ' + objects.join(','));
  if (seed === undefined || seed === null || seed === '') throw new Error('add-catch needs a seed');
  if (!Number.isInteger(count) || count < 1) throw new Error('the number of catch pairs must be a positive integer');
  const dir = studyDir(dataRoot, name);
  // Everything from reading the study to writing it happens under its lock.
  const unlock = await lockVoting(dir, { kind: 'add-catch' });
  try {
    return await addLocked({ dir, objects, seed, count, minChangedShare, legacyRater, devSet, now, log });
  } finally {
    await unlock();
  }
}

// The owner's votes, as text to compare (read before the pictures are drawn
// and again before anything is written); throws on any other rater's.
async function ownerVotes(dir, legacyRater) {
  // A rater's votes sent back mean their copy went out without the catch pairs.
  for (const { file, rater } of (await voteFiles(dir)).files) {
    if (rater && rater !== legacyRater && await exists(join(dir, file))) throw new Error(join(dir, file) + ' holds a rater\'s votes: catch pairs go in before the study is exported to any rater');
  }
  const read = await readVoteFiles(dir, { legacyRater });
  const others = [...new Set(read.votes.map(vote => vote.rater).filter(rater => rater !== legacyRater))].sort();
  if (others.length) {
    throw new Error(dir + ' holds votes of ' + others.join(', ') + ' besides the owner (' + legacyRater + '): catch pairs go in before anyone else rates' +
      (legacyRater === LEGACY_RATER ? '; if those votes are yours, pass --legacy-rater <your id>' : ''));
  }
  return JSON.stringify(read.votes);
}

async function addLocked({ dir, objects, seed, count, minChangedShare, legacyRater, devSet, now, log }) {
  const recovered = await recover(dir);
  if (recovered) log({ event: 'catch-recovered', study: dir, key: recovered });
  const keyText = await readFile(join(dir, 'key.json'), 'utf8'), key = JSON.parse(keyText);
  const study = JSON.parse(await readFile(join(dir, 'pairs.json'), 'utf8'));
  if (study.pairs.length !== key.pairs.length || study.pairs.some((pair, index) => pair.id !== key.pairs[index].id)) {
    throw new Error('pairs.json and key.json do not list the same pairs in the same order');
  }
  if (key.pairs.some(isCatch)) throw new Error(dir + ' already has catch pairs');
  // Nothing is placed before the last pair the owner has rated.
  const order = new Map(study.pairs.map((pair, index) => [pair.id, index]));
  const voted = await ownerVotes(dir, legacyRater);
  const lastRated = JSON.parse(voted).reduce((last, vote) => Math.max(last, order.get(vote.pair) ?? -1), -1);

  const models = await devModels(devSet);
  const unknown = objects.filter(id => !models.has(id));
  if (unknown.length) throw new Error('not objects of the development set (' + devSet + '): ' + unknown.join(', ') + '; it has ' + [...models.keys()].join(', '));
  const inStudy = objects.filter(id => key.pairs.some(pair => pair.object === id));
  if (inStudy.length) throw new Error('already shown in the study: ' + inStudy.join(', '));

  const views = (key.views ?? STUDY_VIEWS).map(view => ({ ...view }));
  const size = key.render?.size ?? STUDY_SIZE, shading = key.render?.shading ?? STUDY_SHADING, fill = key.render?.fill ?? FRAME_FILL;
  const random = rng(String(seed));

  // Per object: the truth's renders and every massing or roof group whose absence is plain to see.
  const candidates = new Map();
  for (const id of objects) {
    const { model } = models.get(id), truth = soupFromModel(model);
    const cameras = studyCameras(truth.bounds, { views, width: size.width, height: size.height, fill });
    const truthViews = renderViews(truth, cameras, shading);
    const truthPixels = Object.fromEntries(Object.entries(truthViews).map(([view, image]) => [view, decodePNG(image.png).pixels]));
    const groups = [];
    for (const group of model.groups.filter(item => CATCH_CATEGORIES.includes(item.category))) {
      const dropped = renderViews(mutations.dropGroup(group.id).apply(truth, { model }), cameras, shading);
      const share = changedShare(truthPixels, dropped, BACKGROUND);
      log({ event: 'catch-candidate', object: id, group: group.id, category: group.category, changed_share: Math.round(share * 1000) / 1000 });
      if (share >= minChangedShare) groups.push({ group: group.id, category: group.category, changed_share: Math.round(share * 1e4) / 1e4, views: dropped });
    }
    candidates.set(id, { truthViews, groups: shuffle(groups, random.fork('groups/' + id)) });
  }
  const available = [...candidates.values()].reduce((sum, item) => sum + item.groups.length, 0);
  if (available < count) {
    throw new Error('only ' + available + ' massing or roof groups of ' + objects.join(', ') + ' change at least ' + minChangedShare * 100 + ' % of the picture; ' + count + ' catch pairs need more objects');
  }

  // The objects in turn, each giving its next group, until there are enough.
  const chosen = [];
  for (let turn = 0; chosen.length < count; turn++) {
    const id = objects[turn % objects.length], item = candidates.get(id);
    if (item.groups.length) chosen.push({ object: id, ...item.groups.shift(), truthViews: item.truthViews });
  }

  // Sides: the truth on A in exactly half (the odd one by a coin), at random.
  const sides = random.fork('sides'), sided = shuffle(chosen, sides);
  const half = Math.floor(count / 2) + (count % 2 && sides.chance(0.5) ? 1 : 0);
  const variants = [...new Set(key.pairs.filter(isOriginal).map(pair => pair.variant))].sort();
  const variantPick = random.fork('variants'), ids = random.fork('ids'), seen = new Set(key.pairs.map(pair => pair.id));
  const entries = sided.map((item, index) => {
    let id;
    do { id = Math.floor(ids.next() * 0x100000000).toString(16).padStart(8, '0'); } while (seen.has(id));
    seen.add(id);
    const correct = index < half ? 'a' : 'b', other = correct === 'a' ? 'b' : 'a';
    const dev = models.get(item.object);
    const shown = { r: item.truthViews, [correct]: item.truthViews, [other]: item.views };
    const images = Object.fromEntries(views.map(view => [view.id, Object.fromEntries(ROLES.map(role => [role, imageName(id, role, view.id)]))]));
    return {
      shown,
      key: {
        id, position: null, repeat_of: null,
        catch: { correct, object: item.object, set: dev.set, archetype: dev.archetype, seed: dev.seed, group: item.group, category: item.category, changed_share: item.changed_share },
        task_id: null, object: item.object, title: dev.model.title, variant: variants.length ? variantPick.pick(variants) : 't2', archetype: dev.archetype, set: dev.set,
        stratum: null, gap: null, cross_configuration: null, higher: null, higher_shape: null, higher_detail: null,
        [correct]: { kind: 'truth' }, [other]: { kind: 'drop_group', group: item.group, category: item.category },
        images,
        render: { clipped: Object.fromEntries(ROLES.map(role => [role, views.filter(view => shown[role][view.id].clipped).map(view => view.id)])),
          covered: Object.fromEntries(ROLES.map(role => [role, Object.fromEntries(views.map(view => [view.id, shown[role][view.id].covered]))])) },
      },
    };
  });

  // Places: the gaps after the last rated pair (before each later pair, or at
  // the end), split into `count` equal runs, one catch pair at a random gap of
  // each run, in a random order.
  const tail = study.pairs.length - lastRated - 1, gaps = tail + 1, places = random.fork('places');
  const placed = shuffle(entries, random.fork('order')).map((entry, k) => {
    const from = Math.floor(k * gaps / count), to = Math.max(from, Math.floor((k + 1) * gaps / count) - 1);
    return { entry, gap: from + Math.floor(places.next() * (to - from + 1)) };
  });
  const keyPairs = [], publicPairs = [];
  const insert = gap => {
    for (const { entry } of placed.filter(item => item.gap === gap)) {
      keyPairs.push(entry.key);
      publicPairs.push({ id: entry.key.id, title: entry.key.title, variant: entry.key.variant, images: entry.key.images });
    }
  };
  study.pairs.forEach((pair, index) => {
    if (index > lastRated) insert(index - lastRated - 1);
    keyPairs.push(key.pairs[index]);
    publicPairs.push(pair);
  });
  insert(tail);
  keyPairs.forEach((pair, position) => { pair.position = position; });

  // The server saves votes under the lock; a vote saved some other way while the pictures were drawn would move the last rated pair.
  if (await ownerVotes(dir, legacyRater) !== voted) throw new Error('votes changed while the catch pairs were drawn: stop serve, then run add-catch again');

  // Images first (named by nothing until pairs.json is), then key.json and pairs.json together.
  const imageDir = join(dir, 'images');
  await mkdir(imageDir, { recursive: true });
  let written = 0;
  for (const { entry } of placed) {
    for (const view of views) for (const role of ROLES) {
      await writeFile(join(imageDir, entry.key.images[view.id][role]), entry.shown[role][view.id].png);
      written++;
    }
  }
  key.pairs = keyPairs;
  key.catch_pairs = { added_at: now().toISOString(), seed: String(seed), count, objects: objects.slice(), dev_set: models.get(objects[0]).set,
    generator: GENERATOR_VERSION, categories: CATCH_CATEGORIES.slice(), min_changed_share: minChangedShare, after_position: lastRated };
  await publish(dir, keyText, key, { ...study, pairs: publicPairs });
  return {
    dir, ...(recovered ? { recovered } : {}), added: count, pairs: keyPairs.length, after_position: lastRated, images: written,
    groups: chosen.map(item => ({ object: item.object, group: item.group, category: item.category, changed_share: item.changed_share })),
  };
}

// An add-catch that did not finish (KEY_BACKUP is there) is put right before
// anything else: if key.json and pairs.json list the same pairs, it stopped
// before replacing either, or after replacing both, and the backup goes
// ('kept'); if pairs.json is the old one and the backup lists its pairs, the
// backup goes back to key.json ('restored'). Anything else is left alone, with
// an error. Returns null when there was nothing to put right.
async function recover(dir) {
  const keyFile = join(dir, 'key.json'), backup = join(dir, KEY_BACKUP);
  let backupText;
  try { backupText = await readFile(backup, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const ids = text => { try { return JSON.parse(text).pairs.map(pair => pair.id).join(','); } catch { return null; } };
  const listed = ids(await readFile(join(dir, 'pairs.json'), 'utf8'));
  let action;
  if (listed !== null && ids(await readFile(keyFile, 'utf8')) === listed) action = 'kept';
  else if (listed !== null && ids(backupText) === listed) { await rename(backup, keyFile); action = 'restored'; }
  else throw new Error(backup + ' is there and neither it nor key.json lists the pairs of pairs.json: put the study right by hand');
  for (const file of [backup, keyFile + '.add-catch.tmp', join(dir, 'pairs.json.add-catch.tmp')]) await rm(file, { force: true });
  return action;
}

// key.json and pairs.json change together or not at all. Both are written
// beside them first and key.json as it was is kept aside (KEY_BACKUP); then
// key.json and pairs.json are renamed into place. If pairs.json cannot be,
// the old key.json goes back. The backup is removed once both are in place
// (an error if it cannot be); if even putting it back fails, it stays: until
// add-catch runs again and puts the study right (recover), nothing reads the
// study (checkFinished).
async function publish(dir, keyText, key, pairs) {
  const keyFile = join(dir, 'key.json'), pairsFile = join(dir, 'pairs.json'), backup = join(dir, KEY_BACKUP);
  const nextKey = keyFile + '.add-catch.tmp', nextPairs = pairsFile + '.add-catch.tmp';
  const tidy = async (...files) => { for (const file of files) await rm(file, { force: true }).catch(() => {}); };
  try {
    await writeFile(backup, keyText);
    await writeFile(nextKey, JSON.stringify(key, null, 2) + '\n');
    await writeFile(nextPairs, JSON.stringify(pairs, null, 2) + '\n');
    await rename(nextKey, keyFile);
  } catch (error) {
    await tidy(nextKey, nextPairs, backup);
    throw new Error('add-catch could not write the study (' + error.message + '); nothing changed', { cause: error });
  }
  try {
    await rename(nextPairs, pairsFile);
  } catch (error) {
    await tidy(nextPairs);
    try { await rename(backup, keyFile); } catch (restore) {
      throw new Error('add-catch wrote key.json but not pairs.json (' + error.message + ') and could not put the old key.json back (' + restore.message + '); it is in ' +
        backup + '. Run add-catch again, which puts it back first; until then the study is not served, exported, qualified or analysed', { cause: error });
    }
    throw new Error('add-catch could not write pairs.json (' + error.message + '); key.json was put back, nothing changed', { cause: error });
  }
  // Both are in place; the backup still marks the study unfinished, so failing to remove it is an error too.
  try { await rm(backup, { force: true }); } catch (error) {
    throw new Error('add-catch added the catch pairs but could not remove ' + backup + ' (' + error.message + '), so the study is not served, exported, qualified or ' +
      'analysed. Run add-catch again: it finds key.json and pairs.json listing the same pairs, removes it, and stops with "already has catch pairs"', { cause: error });
  }
}
