import { readFile, readdir, open, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { RATER_PATTERN, LEGACY_RATER, isRater } from './page/state.js';

// The votes of one study, from every rater. The server appends to votes.jsonl;
// a rater who rated on another machine sends back that machine's votes.jsonl,
// which is saved next to it as votes-<rater>.jsonl. Every vote names its rater.
// A line without a rater was recorded before raters were named: in
// votes-<id>.jsonl it is <id>'s, in votes.jsonl it is the legacy rater's (r0,
// unless the owner says whose they are).

export const CHOICES = ['a', 'b', 'tie'];
export const VOTES_FILE = 'votes.jsonl';
// The study's lock: held by a step that changes the study's pairs (add-catch)
// for as long as it runs, and by the server for each vote while it checks the
// study and saves the vote, so neither happens during the other.
export const VOTING_LOCK = 'voting.lock';
// How long taking the lock waits for a vote being saved.
const LOCK_WAIT_MS = 2000;
const RATER_FILE = /^votes-(.*)\.jsonl$/;
// Anything that looks like a votes file but is not read is reported, never silently dropped.
const VOTES_LIKE = /^votes.*\.jsonl$/;

// One file's text -> { votes, malformed, unnamed }; `unnamed` counts the votes
// that carry no rater and were given `rater`. A line that is not a valid vote (a
// torn write, a hand edit, a rater that is not an id) is counted and skipped,
// never guessed at.
export function parseVotes(text, { rater = LEGACY_RATER } = {}) {
  const votes = [];
  let malformed = 0, unnamed = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let vote;
    try { vote = JSON.parse(line); } catch { malformed++; continue; }
    if (!vote || typeof vote.pair !== 'string' || !CHOICES.includes(vote.choice)) { malformed++; continue; }
    const named = vote.rater !== undefined && vote.rater !== null;
    if (named && !(typeof vote.rater === 'string' && RATER_PATTERN.test(vote.rater))) { malformed++; continue; }
    if (!named) unnamed++;
    votes.push({ rater: named ? vote.rater : rater, pair: vote.pair, choice: vote.choice, ms: Number.isFinite(vote.ms) ? vote.ms : null,
      hidden_ms: Number.isFinite(vote.hidden_ms) ? vote.hidden_ms : null, at: typeof vote.at === 'string' ? vote.at : null });
  }
  return { votes, malformed, unnamed };
}

// The files a study directory holds votes in: votes.jsonl first, then
// votes-<id>.jsonl by name; `ignored` lists votes-like names that are not read.
export async function voteFiles(studyDir) {
  let names;
  try { names = await readdir(studyDir); } catch (error) {
    if (error.code === 'ENOENT') return { files: [], ignored: [] };
    throw error;
  }
  const files = [], ignored = [];
  if (names.includes(VOTES_FILE)) files.push({ file: VOTES_FILE, rater: null });
  for (const name of names.sort()) {
    if (name === VOTES_FILE) continue;
    const match = name.match(RATER_FILE);
    if (match && isRater(match[1])) files.push({ file: name, rater: match[1] });
    else if (VOTES_LIKE.test(name)) ignored.push(name);
  }
  return { files, ignored };
}

const compareText = (p, q) => p < q ? -1 : p > q ? 1 : 0;
const identity = vote => JSON.stringify([vote.rater, vote.pair, vote.choice, vote.ms, vote.hidden_ms, vote.at]);

// Marks every node with its strongly connected component (Tarjan, iterative):
// nodes on a common cycle of `next` edges share `component`.
function markComponents(nodes) {
  let counter = 0;
  const stack = [];
  for (const root of nodes) {
    if (root.index !== undefined) continue;
    root.index = root.low = counter++;
    stack.push(root);
    root.onStack = true;
    const work = [[root, root.next.values()]];
    while (work.length) {
      const [node, edges] = work[work.length - 1], step = edges.next();
      if (!step.done) {
        const next = step.value;
        if (next.index === undefined) {
          next.index = next.low = counter++;
          stack.push(next);
          next.onStack = true;
          work.push([next, next.next.values()]);
        } else if (next.onStack) node.low = Math.min(node.low, next.index);
        continue;
      }
      work.pop();
      if (work.length) work[work.length - 1][0].low = Math.min(work[work.length - 1][0].low, node.low);
      if (node.low !== node.index) continue;
      let member;
      do {
        member = stack.pop();
        member.onStack = false;
        member.component = node.index;
      } while (member !== node);
    }
  }
}

// Merges the files' votes into one list. A file's lines keep their order: they
// were appended in the order cast, whatever the clock said (it can step back),
// so a revision stays after the vote it revises. The same line in several files
// (a log copied, whole or in part) is one vote that keeps every file's order
// around it; a line repeated within a file (a, b, then a again, without times)
// is a vote each time, and its n-th time in one file is a copy of its n-th time
// in another. Where files contradict each other (their orders form a cycle),
// those contradicting orders are dropped and the time stamps decide among the
// votes on the cycle; every other order is kept. Among the votes free to go
// next, the earliest time stamp goes first (a missing one counts as earliest),
// then the earlier file and line. Returns the votes and how many lines were copies.
function mergeFiles(lists) {
  const nodes = new Map();
  let copies = 0;
  lists.forEach((list, file) => {
    const times = new Map();
    let previous = null;
    list.forEach((vote, line) => {
      const text = identity(vote), nth = times.get(text) ?? 0;
      times.set(text, nth + 1);
      const id = text + '#' + nth;
      let node = nodes.get(id);
      if (node) copies++;
      else nodes.set(id, node = { vote, at: vote.at ?? '', file, line, waiting: 0, next: new Set() });
      if (previous) previous.next.add(node);
      previous = node;
    });
  });
  markComponents(nodes.values());
  for (const node of nodes.values()) {
    for (const next of node.next) {
      if (next.component === node.component) node.next.delete(next);
      else next.waiting++;
    }
  }
  const earlier = (p, q) => compareText(p.at, q.at) || p.file - q.file || p.line - q.line;
  const ready = new Set([...nodes.values()].filter(node => !node.waiting)), merged = [];
  while (ready.size) {
    let pick = null;
    for (const node of ready) if (!pick || earlier(node, pick) < 0) pick = node;
    ready.delete(pick);
    merged.push(pick.vote);
    for (const node of pick.next) if (--node.waiting === 0) ready.add(node);
  }
  return { votes: merged, copies };
}

// Every vote of a study directory, each file in its own line order, files
// interleaved by time (see mergeFiles). A line that appears in two files (the
// same vote copied twice) counts once.
//   legacyRater: whose the votes in votes.jsonl without a rater are (default r0).
export async function readVoteFiles(studyDir, { legacyRater = LEGACY_RATER } = {}) {
  if (legacyRater !== LEGACY_RATER && !isRater(legacyRater)) throw new Error('legacy rater must be letters and digits (not r0): ' + JSON.stringify(legacyRater));
  const { files, ignored } = await voteFiles(studyDir);
  const lists = [], summaries = [];
  let malformed = 0;
  for (const { file, rater } of files) {
    let text;
    try { text = await readFile(join(studyDir, file), 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const parsed = parseVotes(text, { rater: rater ?? legacyRater });
    malformed += parsed.malformed;
    summaries.push({ file, lines: parsed.votes.length + parsed.malformed, valid_lines: parsed.votes.length, malformed_lines: parsed.malformed, unnamed_lines: parsed.unnamed,
      raters: [...new Set(parsed.votes.map(vote => vote.rater))].sort() });
    lists.push(parsed.votes);
  }
  const { votes, copies } = mergeFiles(lists);
  return { votes, malformed, duplicates: copies, files: summaries, ignored, legacy_rater: legacyRater };
}

// Who holds the study's lock, or null: { pid, kind, token, stale } (pid null
// while the file is being written; stale when that process is gone).
export async function votingLock(studyDir) {
  let text;
  try { text = await readFile(join(studyDir, VOTING_LOCK), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let lock = {};
  try { lock = JSON.parse(text) ?? {}; } catch {}
  const pid = Number.isInteger(lock.pid) && lock.pid > 0 ? lock.pid : null;
  let stale = false;
  if (pid !== null) { try { process.kill(pid, 0); } catch (error) { stale = error.code === 'ESRCH'; } }
  return { pid, kind: typeof lock.kind === 'string' ? lock.kind : null, token: typeof lock.token === 'string' ? lock.token : null, stale };
}

// Takes the study's lock for `kind` ('add-catch', or 'vote' while a vote is
// saved) and returns the function that gives it back. The file is created
// only if it does not exist, so of two callers one gets it. It waits a moment
// for a vote being saved (or a lock being written); any other holder is an
// error with code ELOCKED. A lock is never taken from anyone, also not from a
// process that is gone: that file is deleted by hand. Giving it back removes
// the file only if it is still this caller's.
export async function lockVoting(studyDir, { kind = 'add-catch', waitMs = LOCK_WAIT_MS } = {}) {
  const path = join(studyDir, VOTING_LOCK), token = randomUUID(), started = Date.now();
  for (;;) {
    try {
      const handle = await open(path, 'wx');
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, kind, token, at: new Date().toISOString() }) + '\n'); } finally { await handle.close(); }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const held = await votingLock(studyDir);
    if (!held) continue;
    const brief = !held.stale && (held.pid === null || held.kind === 'vote');
    if (brief && Date.now() - started < waitMs) { await delay(10); continue; }
    throw Object.assign(new Error(held.stale
      ? path + ' was left by process ' + held.pid + ', which has ended: delete the file if nothing is changing this study, then try again'
      : path + ': ' + (held.kind === 'add-catch' ? 'add-catch is changing this study' : 'another step holds this study') + (held.pid ? ' (process ' + held.pid + ')' : '') +
        '; wait for it to end' + (held.pid ? '' : ', or delete the file if nothing is running')), { code: 'ELOCKED', holder: held });
  }
  return async () => {
    if ((await votingLock(studyDir))?.token === token) await rm(path, { force: true });
  };
}
