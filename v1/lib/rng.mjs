// Deterministic random numbers. Every generated object, camera and distractor is
// a pure function of a seed, so a task set can be regenerated or kept private by
// keeping its seeds private.
function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function rng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hashString(String(seed));
  const next = () => {
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (low, high) => low + (high - low) * next(),
    int: (low, high) => Math.floor(low + (high - low + 1) * next()),
    pick: items => items[Math.floor(next() * items.length)],
    chance: probability => next() < probability,
    // Independent stream for a named sub-task, so adding draws in one place
    // does not shift every later value elsewhere.
    fork: label => rng(hashString(String(seed) + '/' + label)),
  };
}
