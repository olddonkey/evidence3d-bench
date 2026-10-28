// What the rating page decides without the DOM: which key means which choice,
// where to resume, and how far the rater is. Loaded by the page as a module and
// by the tests directly.

// The rater's choice per key: left / 1 for A, down / 0 for "cannot tell", right / 2 for B.
export const KEY_CHOICES = Object.freeze({ ArrowLeft: 'a', 1: 'a', ArrowDown: 'tie', 0: 'tie', ArrowRight: 'b', 2: 'b' });

// A rater is named by an id of lower-case letters and digits; it is stored with
// every vote and names the rater's file (votes-<id>.jsonl). r0 stands for the
// votes recorded before raters were named, so nobody can take it.
export const RATER_PATTERN = /^[a-z0-9]{1,32}$/;
export const LEGACY_RATER = 'r0';
export const isRater = id => typeof id === 'string' && RATER_PATTERN.test(id) && id !== LEGACY_RATER;

// What the rater typed -> their id (trimmed, lower case), or null if it is not one.
export function raterId(text) {
  const id = String(text ?? '').trim().toLowerCase();
  return isRater(id) ? id : null;
}

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

// Time on a pair that does not count as looking at it: while the page is
// hidden (another tab, a covered window) or the name form is open. The reasons
// can overlap (the form open, then another tab); their union counts once.
// Times are the caller's clock (performance.now() on the page).
export function pauseClock() {
  const reasons = new Set();
  let since = null, total = 0;
  return {
    pause(reason, now) {
      if (!reasons.size) since = now;
      reasons.add(reason);
    },
    resume(reason, now) {
      if (!reasons.delete(reason) || reasons.size) return;
      total += now - since;
      since = null;
    },
    // A new pair is shown at `now`: count afresh; a reason still in force goes on counting.
    restart(now) {
      total = 0;
      since = reasons.size ? now : null;
    },
    excluded(now) { return total + (since === null ? 0 : now - since); },
  };
}

// Time on a pair: all of it (ms), and the part during which the page was
// hidden or the name form open (pauseClock), so the analysis can leave that out.
export function elapsed(shownAt, now, hiddenMs) {
  const ms = Math.max(0, Math.round(now - shownAt));
  return { ms, hidden_ms: Math.min(ms, Math.max(0, Math.round(hiddenMs))) };
}
