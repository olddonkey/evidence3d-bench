// Results report: leaderboard aggregation and the static HTML site.
export { aggregate, buildLeaderboard, conflictShare, cellKey, comparePair, pairStatement, taskMeans, toleranceRows, toleranceSummary, variantPairs, attemptNoise,
  varianceStatement, attemptShareText, LEADERBOARD_SCHEMA, LADDER, VARIANT_ORDER, LITTLE_DATA_DF, PLANNED_OBJECTS, SET_NOTES } from './aggregate.mjs';
export { writeReport, pickRepresentatives, objectFrame, REPORT_VIEWS, REPRESENTATIVES } from './write.mjs';
export { summaryMarkdown } from './markdown.mjs';
export { collectRuns, normaliseUsage, manifestProvenance, scorerIdentity, scorerVersion, DEFAULT_EXCLUDED_STATUSES, UNNAMED_SET, UNKNOWN_SET,
  UNKNOWN_ARCHETYPE } from './collect.mjs';
export { bootstrapMean, pairedBootstrap, tInterval, studentQuantile, chiSquareQuantile, incompleteGamma, sdRange, pooledSD, detectableDifference, summarise,
  mean, median, quantile, sampleSD, LOW_EVIDENCE_OBJECTS, BOOTSTRAP_SAMPLES, PAIRWISE_SAMPLES, SMALL_SAMPLE_OBJECTS } from './stats.mjs';
