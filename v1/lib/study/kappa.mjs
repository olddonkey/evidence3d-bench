// Agreement between raters beyond chance: Cohen's kappa for two raters,
// Fleiss' kappa for three or more (used by analyze.mjs and g1.mjs).

// The choices as every rater saw them (the sides are the same for everyone).
export const CATEGORIES = ['a', 'tie', 'b'];

// Cohen's kappa for two raters over the same items, from [first, second]
// choice pairs: (observed - chance) / (1 - chance), chance from each rater's
// own shares of the categories. null when chance is 1 (both raters used one
// and the same category throughout) or there are no items.
export function cohenKappa(choicePairs, categories = CATEGORIES) {
  const n = choicePairs.length;
  if (!n) return { n: 0, same: 0, observed: null, chance: null, kappa: null };
  const first = new Map(categories.map(category => [category, 0])), second = new Map(first);
  let same = 0;
  for (const [p, q] of choicePairs) {
    if (!first.has(p) || !second.has(q)) throw new Error('unknown category ' + JSON.stringify(first.has(p) ? q : p));
    first.set(p, first.get(p) + 1);
    second.set(q, second.get(q) + 1);
    if (p === q) same++;
  }
  const observed = same / n;
  const chance = categories.reduce((sum, category) => sum + (first.get(category) / n) * (second.get(category) / n), 0);
  return { n, same, observed, chance, kappa: chance < 1 ? (observed - chance) / (1 - chance) : null };
}

// Fleiss' kappa: `counts` has one row per item with the number of raters who
// chose each category; every row sums to the same number of raters (two or
// more). Observed agreement is the mean share of agreeing rater pairs per item,
// chance the sum of the squared overall category shares.
export function fleissKappa(counts) {
  const items = counts.length;
  if (!items) return { items: 0, raters_per_item: null, observed: null, chance: null, shares: null, kappa: null };
  const sum = row => row.reduce((total, value) => total + value, 0);
  const m = sum(counts[0]), width = counts[0].length;
  if (!(m >= 2) || counts.some(row => row.length !== width || sum(row) !== m)) throw new Error('Fleiss kappa needs the same number of ratings, two or more, for every item');
  const totals = new Array(width).fill(0);
  let agreeing = 0;
  for (const row of counts) {
    row.forEach((count, j) => { totals[j] += count; });
    agreeing += (row.reduce((total, count) => total + count * count, 0) - m) / (m * (m - 1));
  }
  const observed = agreeing / items, shares = totals.map(total => total / (items * m));
  const chance = shares.reduce((total, share) => total + share * share, 0);
  return { items, raters_per_item: m, observed, chance, shares, kappa: chance < 1 ? (observed - chance) / (1 - chance) : null };
}
