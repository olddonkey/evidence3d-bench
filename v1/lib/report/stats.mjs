import { rng } from '../rng.mjs';

// Small, dependency-free statistics for the leaderboard. Every interval is a
// percentile bootstrap over OBJECTS: the variants of one object share its
// geometry and evidence, so they are not independent samples.
export const BOOTSTRAP_SAMPLES = 2000;
export const LOW_EVIDENCE_OBJECTS = 3;

export const finite = value => typeof value === 'number' && Number.isFinite(value);

export function mean(values) {
  const list = values.filter(finite);
  return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null;
}

// Linear-interpolated quantile of a sorted array, q in [0, 1].
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q, low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

export function median(values) {
  const list = values.filter(finite).sort((a, b) => a - b);
  return quantile(list, 0.5);
}

// 95 % percentile bootstrap interval of the mean of `values` (one value per
// object). `seed` is anything rng() accepts. Fewer than two values give null:
// one object says nothing about spread, and a zero-width interval would claim
// a precision that does not exist.
export function bootstrapMean(values, { seed = 'e3d-bootstrap', samples = BOOTSTRAP_SAMPLES, level = 0.95 } = {}) {
  const list = values.filter(finite);
  if (list.length < 2) return null;
  const random = rng(seed), n = list.length, means = new Float64Array(samples);
  for (let b = 0; b < samples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += list[Math.floor(random.next() * n)];
    means[b] = sum / n;
  }
  means.sort();
  const tail = (1 - level) / 2;
  return [quantile(means, tail), quantile(means, 1 - tail)];
}

// One number for a metric, with its sample sizes and evidence flag.
//   perObject: Map(objectId -> value)
export function summarise(perObject, { seed, attempts = null, tasks = null, basis } = {}) {
  const ids = [...perObject.keys()].sort(), values = ids.map(id => perObject.get(id));
  return {
    mean: mean(values),
    ci95: bootstrapMean(values, { seed }),
    objects: ids.length,
    tasks,
    attempts,
    low_evidence: ids.length < LOW_EVIDENCE_OBJECTS,
    ...(basis ? { basis } : {}),
  };
}
