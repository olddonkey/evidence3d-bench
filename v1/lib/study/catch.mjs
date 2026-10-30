import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON } from '../../../lib/io.mjs';
import { rng } from '../rng.mjs';
import { soupFromModel } from '../soup.mjs';
import { validateModel } from '../model.mjs';
import { decodePNG } from '../png.mjs';
import { generateModel, GENERATOR_VERSION } from '../generator/index.mjs';
import { studyCameras, renderViews, STUDY_VIEWS, STUDY_SIZE, STUDY_SHADING, FRAME_FILL, BACKGROUND } from './render.mjs';
import { imageName, ROLES } from './select.mjs';
import { voteFiles, readVoteFiles, VOTES_FILE } from './votes.mjs';
import { isCatch, isOriginal } from './panel.mjs';
import { studyDir, DEFAULT_DATA_ROOT } from './index.mjs';

// Catch pairs for rater qualification (Round 4 plan, docs/V1-ROUND4-PLAN.md
// section 5.1). Their answer is fixed by construction, not by the scorer: a
// development-set object's truth on one side, the same truth with one massing
// or roof group taken away on the other, both drawn exactly as the study draws
// a pair (same cameras on the truth's bounds, same clay shading), the truth on
// side A in half of them. They are added to a prepared study, also one that
// has votes: no pair is changed or moved before the last pair anyone has rated,
// and no vote is touched. key.json marks them (`catch`), pairs.json does not,
// and they count in no agreement, only in the qualification.

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

// The share of the truth's drawn pixels that differ between two sets of
// renders of the same views (PNG bytes).
function changedShare(truthViews, otherViews, background) {
  let drawn = 0, changed = 0;
  for (const view of Object.keys(truthViews)) {
    const a = decodePNG(truthViews[view].png).pixels, b = decodePNG(otherViews[view].png).pixels;
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
//     places (written into the private record with the objects).
export async function addCatchPairs({ dataRoot = DEFAULT_DATA_ROOT, name, objects, seed, count = CATCH_PAIRS, minChangedShare = MIN_CHANGED_SHARE,
  devSet = DEV_SET_FILE, now = () => new Date(), log = () => {} }) {
  if (!Array.isArray(objects) || !objects.length) throw new Error('add-catch needs at least one development-set object');
  if (new Set(objects).size !== objects.length) throw new Error('an object is named twice: ' + objects.join(','));
  if (seed === undefined || seed === null || seed === '') throw new Error('add-catch needs a seed');
  if (!Number.isInteger(count) || count < 1) throw new Error('the number of catch pairs must be a positive integer');
  const dir = studyDir(dataRoot, name);
  const key = JSON.parse(await readFile(join(dir, 'key.json'), 'utf8'));
  const study = JSON.parse(await readFile(join(dir, 'pairs.json'), 'utf8'));
  if (study.pairs.length !== key.pairs.length || study.pairs.some((pair, index) => pair.id !== key.pairs[index].id)) {
    throw new Error('pairs.json and key.json do not list the same pairs in the same order');
  }
  if (key.pairs.some(isCatch)) throw new Error(dir + ' already has catch pairs');
  // A rater's votes sent back mean their copy went out without the catch pairs.
  for (const { file } of (await voteFiles(dir)).files) {
    if (file !== VOTES_FILE && await exists(join(dir, file))) throw new Error(join(dir, file) + ' holds a rater\'s votes: catch pairs go in before the study is exported to any rater');
  }

  // Nothing is placed before the last pair anyone has rated here.
  const order = new Map(study.pairs.map((pair, index) => [pair.id, index]));
  const { votes } = await readVoteFiles(dir);
  const lastRated = votes.reduce((last, vote) => Math.max(last, order.get(vote.pair) ?? -1), -1);

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
    const groups = [];
    for (const group of model.groups.filter(item => CATCH_CATEGORIES.includes(item.category))) {
      const dropped = renderViews(soupFromModel({ ...model, parts: model.parts.filter(part => part.group !== group.id) }), cameras, shading);
      const share = changedShare(truthViews, dropped, BACKGROUND);
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

  // Images first, then key.json, then pairs.json (what the page reads).
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
  await writeJSON(join(dir, 'key.json'), key);
  await writeJSON(join(dir, 'pairs.json'), { ...study, pairs: publicPairs });
  return {
    dir, added: count, pairs: keyPairs.length, after_position: lastRated, images: written,
    groups: chosen.map(item => ({ object: item.object, group: item.group, category: item.category, changed_share: item.changed_share })),
  };
}
