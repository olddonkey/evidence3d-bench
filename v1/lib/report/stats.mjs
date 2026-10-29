import { rng } from '../rng.mjs';

// Small, dependency-free statistics for the leaderboard. Every interval is a
// percentile bootstrap over OBJECTS: the variants of one object share its
// geometry and evidence, so they are not independent samples.
export const BOOTSTRAP_SAMPLES = 2000;
// Pairwise intervals decide "does A beat B"; the share of resamples with A > B
// is printed to the percent, so it gets enough resamples to be stable there.
export const PAIRWISE_SAMPLES = 10000;
export const LOW_EVIDENCE_OBJECTS = 3;
// Below this many objects a percentile bootstrap of a mean is clearly too
// narrow (it ignores the n - 1 and the t tail: with 5 objects the interval is
// about 37 % narrower than a Student-t interval), so a t interval is shown next
// to it and the verdict says so.
export const SMALL_SAMPLE_OBJECTS = 10;
// Per-object differences closer than this are ties (scores are reported to two
// decimals, so this means "equal as reported").
export const TIE_TOLERANCE = 1e-6;

export const finite = value => typeof value === 'number' && Number.isFinite(value);

export function mean(values) {
  const list = values.filter(finite);
  return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null;
}

// Sample standard deviation (n - 1); null below two values.
export function sampleSD(values) {
  const list = values.filter(finite);
  if (list.length < 2) return null;
  const centre = mean(list);
  return Math.sqrt(list.reduce((sum, value) => sum + (value - centre) ** 2, 0) / (list.length - 1));
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

// Median and interquartile range (linear-interpolated quartiles) of one value
// per object: a description of the spread, not an interval for the median.
// No range from a single value.
export function spread(values) {
  const list = values.filter(finite).sort((a, b) => a - b);
  return { median: quantile(list, 0.5), iqr: list.length >= 2 ? [quantile(list, 0.25), quantile(list, 0.75)] : null };
}

// Means of `samples` resamples (with replacement) of `list`, sorted.
function resampleMeans(list, seed, samples) {
  const random = rng(seed), n = list.length, means = new Float64Array(samples);
  for (let b = 0; b < samples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += list[Math.floor(random.next() * n)];
    means[b] = sum / n;
  }
  return means.sort();
}

// 95 % percentile bootstrap interval of the mean of `values` (one value per
// object). `seed` is anything rng() accepts. Fewer than two values give null:
// one object says nothing about spread, and a zero-width interval would claim
// a precision that does not exist.
export function bootstrapMean(values, { seed = 'e3d-bootstrap', samples = BOOTSTRAP_SAMPLES, level = 0.95 } = {}) {
  const list = values.filter(finite);
  if (list.length < 2) return null;
  const means = resampleMeans(list, seed, samples), tail = (1 - level) / 2;
  return [quantile(means, tail), quantile(means, 1 - tail)];
}

// Paired bootstrap of per-object differences A - B: the percentile interval of
// the mean difference and how often a resample puts A ahead, behind or level.
// The shares are bootstrap proportions, not p-values.
export function pairedBootstrap(differences, { seed = 'e3d-paired', samples = PAIRWISE_SAMPLES, level = 0.95 } = {}) {
  const list = differences.filter(finite);
  if (list.length < 2) return null;
  const means = resampleMeans(list, seed, samples), tail = (1 - level) / 2;
  let above = 0, below = 0;
  for (const value of means) {
    if (value > TIE_TOLERANCE) above++;
    else if (value < -TIE_TOLERANCE) below++;
  }
  return { ci95: [quantile(means, tail), quantile(means, 1 - tail)], share_a_higher: above / samples, share_b_higher: below / samples,
    share_level: (samples - above - below) / samples, samples };
}

// ---------------------------------------------------------------- Student t
// Only for the small-sample cross-check next to the bootstrap; accurate to far
// better than the two decimals printed.

function logGamma(x) {
  // Lanczos approximation, g = 7, n = 9.
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let sum = c[0];
  for (let i = 1; i < 9; i++) sum += c[i] / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(sum);
}

// Continued fraction for the incomplete beta function (modified Lentz).
function betaFraction(a, b, x) {
  const tiny = 1e-300;
  let c = 1, d = 1 - (a + b) * x / (a + 1);
  d = 1 / (Math.abs(d) < tiny ? tiny : d);
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let term = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + term * d; d = 1 / (Math.abs(d) < tiny ? tiny : d);
    c = 1 + term / c; if (Math.abs(c) < tiny) c = tiny;
    h *= d * c;
    term = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + term * d; d = 1 / (Math.abs(d) < tiny ? tiny : d);
    c = 1 + term / c; if (Math.abs(c) < tiny) c = tiny;
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < 1e-14) break;
  }
  return h;
}

// Regularised incomplete beta I_x(a, b).
export function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? front * betaFraction(a, b, x) / a : 1 - front * betaFraction(b, a, 1 - x) / b;
}

export function studentCDF(t, df) {
  const tail = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

// Bisection is slow-ish and a report asks for the same few (p, df) many times.
const quantiles = new Map();
export function studentQuantile(p, df) {
  if (!(p > 0 && p < 1) || !(df > 0)) return null;
  const key = p + '/' + df;
  if (quantiles.has(key)) return quantiles.get(key);
  let low = -1e4, high = 1e4;
  for (let i = 0; i < 200; i++) {
    const middle = (low + high) / 2;
    if (studentCDF(middle, df) < p) low = middle; else high = middle;
  }
  quantiles.set(key, (low + high) / 2);
  return quantiles.get(key);
}

// Classical t interval of the mean; null below two values.
export function tInterval(values, level = 0.95) {
  const list = values.filter(finite);
  if (list.length < 2) return null;
  const centre = mean(list), half = studentQuantile(1 - (1 - level) / 2, list.length - 1) * sampleSD(list) / Math.sqrt(list.length);
  return [centre - half, centre + half];
}

// Two-sided p-value of the one-sample t test of mean = 0 (on paired
// differences, the paired t test): the t interval at level 1 - p just touches
// zero. null below two values or when the values do not vary.
export function tTestP(values) {
  const list = values.filter(finite);
  if (list.length < 2) return null;
  const centre = mean(list), sd = sampleSD(list);
  // Differences that do not vary leave t undefined (0 / 0 or x / 0): no p-value,
  // rather than the 0 or NaN an implementation would compute
  // (docs/V1-ROUND4-PLAN.md section 4); such a pair cannot be decided.
  if (!(sd > 0)) return null;
  const t = centre / (sd / Math.sqrt(list.length));
  return Math.min(1, 2 * (1 - studentCDF(Math.abs(t), list.length - 1)));
}

// ------------------------------------------------------ multiple comparisons

// Family-wise error rate the corrected verdicts hold.
export const FAMILY_ALPHA = 0.05;

// Holm's step-down adjustment of a family of p-values, returned in input
// order: sorted ascending, p_(k) becomes max over j <= k of (m - j + 1) p_(j),
// capped at 1. Rejecting every adjusted p below alpha is Holm's procedure at
// family-wise level alpha. Entries that are not numbers stay null and are not
// counted in m: an untestable comparison makes no claim.
export function holmAdjust(pValues) {
  const order = pValues.map((p, index) => [p, index]).filter(([p]) => finite(p)).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const m = order.length, adjusted = pValues.map(() => null);
  let running = 0;
  order.forEach(([p, index], k) => {
    running = Math.max(running, Math.min(1, (m - k) * p));
    adjusted[index] = running;
  });
  return adjusted;
}

// ------------------------------------------------------- variance components

// Regularised lower incomplete gamma P(a, x): series below a + 1, continued
// fraction (modified Lentz) above, as in Numerical Recipes.
export function incompleteGamma(a, x) {
  if (!(x > 0)) return 0;
  const front = Math.exp(-x + a * Math.log(x) - logGamma(a));
  if (x < a + 1) {
    let term = 1 / a, sum = term;
    for (let n = 1; n < 1000; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return Math.min(1, sum * front);
  }
  const tiny = 1e-300;
  let b = x + 1 - a, c = 1 / tiny, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < 1e-15) break;
  }
  return Math.max(0, 1 - front * h);
}

const chiQuantiles = new Map();
// Quantile of the chi-square distribution with `df` degrees of freedom.
export function chiSquareQuantile(p, df) {
  if (!(p > 0 && p < 1) || !(df > 0)) return null;
  const key = p + '/' + df;
  if (chiQuantiles.has(key)) return chiQuantiles.get(key);
  let low = 0, high = df + 60 * Math.sqrt(2 * df) + 100;
  for (let i = 0; i < 200; i++) {
    const middle = (low + high) / 2;
    if (incompleteGamma(df / 2, middle / 2) < p) low = middle; else high = middle;
  }
  chiQuantiles.set(key, (low + high) / 2);
  return chiQuantiles.get(key);
}

// Approximate 95 % range of a standard deviation estimated with `df` degrees
// of freedom (chi-square, i.e. assuming roughly normal noise). It is what
// makes "SD 3.2 from 5 objects" readable: the true SD could be 1.9 or 9.2.
export function sdRange(sd, df, level = 0.95) {
  if (!finite(sd) || !(df >= 1)) return null;
  const tail = (1 - level) / 2;
  return [sd * Math.sqrt(df / chiSquareQuantile(1 - tail, df)), sd * Math.sqrt(df / chiSquareQuantile(tail, df))];
}

// Pooled within-group standard deviation: sqrt(sum of squared deviations from
// each group's own mean / sum of (n_g - 1)). Groups with fewer than two values
// contribute nothing. -> { sd, df, groups, values } (sd null when df = 0).
export function pooledSD(groups) {
  let squares = 0, df = 0, used = 0, values = 0;
  for (const group of groups) {
    const list = group.filter(finite);
    if (list.length < 2) continue;
    const centre = mean(list);
    squares += list.reduce((sum, value) => sum + (value - centre) ** 2, 0);
    df += list.length - 1;
    used++;
    values += list.length;
  }
  return { sd: df ? Math.sqrt(squares / df) : null, df, groups: used, values };
}

// For a paired comparison over n objects whose per-object differences have
// standard deviation sd:
//   resolution: half-width of the 95 % t interval, i.e. the smallest observed
//               mean difference whose interval excludes zero (a true
//               difference of this size is detected about half the time);
//   detectable: the true difference detected with probability `power` by a
//               two-sided 95 % t test, (t_0.975 + t_power) * sd / sqrt(n).
// Both are approximations that take the estimated sd as if it were the truth.
export function detectableDifference(sd, n, { level = 0.95, power = 0.8 } = {}) {
  if (!finite(sd) || !(n >= 2)) return null;
  const se = sd / Math.sqrt(n), critical = studentQuantile(1 - (1 - level) / 2, n - 1);
  return { resolution: critical * se, detectable: (critical + studentQuantile(power, n - 1)) * se, power, level, n };
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
