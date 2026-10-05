// What the rating page decides without the DOM: which key means which choice,
// where to resume, and how far the rater is. Loaded by the page as a module and
// by the tests directly.

// The rater's choice per key: left / 1 for A, down / 0 for "cannot tell", right / 2 for B.
export const KEY_CHOICES = Object.freeze({ ArrowLeft: 'a', 1: 'a', ArrowDown: 'tie', 0: 'tie', ArrowRight: 'b', 2: 'b' });

// Latest choice per pair: a later line replaces an earlier one (a revision).
export function latestChoices(votes) {
  const latest = new Map();
  for (const vote of votes) latest.set(vote.pair, vote.choice);
  return latest;
}

// Pairs in the order they were last voted on, oldest first: the trail "上一对"
// walks back along after a reload.
export function votedTrail(pairs, votes) {
  const index = new Map(pairs.map((pair, i) => [pair.id, i]));
  const last = new Map();
  votes.forEach((vote, line) => { if (index.has(vote.pair)) last.set(vote.pair, line); });
  return [...last.entries()].sort((p, q) => p[1] - q[1]).map(([id]) => index.get(id));
}

// The first unrated pair after position `after` in presentation order, then
// from the start; -1 when every pair has a vote.
export function nextUnrated(pairs, latest, after = -1) {
  for (let step = 1; step <= pairs.length; step++) {
    const i = (after + step) % pairs.length;
    if (!latest.has(pairs[i].id)) return i;
  }
  return -1;
}

// Where to go once the current pair is done with (a vote, or "下一对"): back
// to where "上一对" was pressed (`ahead`, a stack; -1 is the closing screen),
// else the next unrated pair. Pops from `ahead`.
export function afterCurrent(pairs, latest, current, ahead) {
  while (ahead.length) {
    const index = ahead.pop();
    if (index >= 0 && index !== current) return index;
  }
  return nextUnrated(pairs, latest, current);
}

export function progress(pairs, latest) {
  return { rated: pairs.filter(pair => latest.has(pair.id)).length, total: pairs.length };
}

// Time on a pair: all of it (ms), and the part during which the page was
// hidden (another tab, a covered window), so the analysis can leave that out.
export function elapsed(shownAt, now, hiddenMs) {
  const ms = Math.max(0, Math.round(now - shownAt));
  return { ms, hidden_ms: Math.min(ms, Math.max(0, Math.round(hiddenMs))) };
}
