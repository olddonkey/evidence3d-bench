import { readFile, readdir } from 'node:fs/promises';
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

// Merges the files' votes into one list. A file's lines keep their order: they
// were appended in the order cast, whatever the clock said (it can step back),
// so a revision stays after the vote it revises. The same line in several files
// (a log copied, whole or in part) is one vote that keeps every file's order
// around it. Otherwise the next vote is the earliest by the server's time stamp
// (a missing one counts as earliest), then the earlier file and line. Files
// whose orders contradict each other (a cycle) give way to the time stamp.
// Returns the votes and how many lines were copies.
function mergeFiles(lists) {
  const nodes = new Map();
  let copies = 0;
  lists.forEach((list, file) => {
    let previous = null;
    list.forEach((vote, line) => {
      const id = identity(vote);
      let node = nodes.get(id);
      if (node) copies++;
      else nodes.set(id, node = { vote, at: vote.at ?? '', file, line, waiting: 0, next: new Set() });
      if (previous && previous !== node && !previous.next.has(node)) { previous.next.add(node); node.waiting++; }
      previous = node;
    });
  });
  const earlier = (p, q) => compareText(p.at, q.at) || p.file - q.file || p.line - q.line;
  const left = new Set(nodes.values()), ready = new Set([...left].filter(node => !node.waiting)), merged = [];
  while (left.size) {
    let pick = null;
    for (const node of ready.size ? ready : left) if (!pick || earlier(node, pick) < 0) pick = node;
    ready.delete(pick);
    left.delete(pick);
    merged.push(pick.vote);
    for (const node of pick.next) if (left.has(node) && --node.waiting === 0) ready.add(node);
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
