// Results report: leaderboard aggregation and the static HTML site.
export { aggregate, buildLeaderboard, conflictShare, conflictKind, cellKey, comparePair, pairStatement, correctFamily, holmSentence, allPairsNote, pText, rosterTasks, INCOMPLETE_REASONS, REAL_TIER_MIN_OBJECTS, taskMeans,
  toleranceRows, toleranceSummary, variantPairs, variantFamily, attemptNoise, varianceStatement, attemptShareText, probeErrors, categoryScore, detailCategories,
  LEADERBOARD_SCHEMA, LADDER, VARIANT_ORDER, CONFLICT_KINDS, DETAIL_CATEGORIES, LITTLE_DATA_DF, PLANNED_OBJECTS, SET_NOTES } from './aggregate.mjs';
export { parseRoster, readRoster, rosterPath, inferLadders, rosterProvenance, ROSTER_SCHEMA, MISSING_SHARE_LIMIT, LADDERS, EFFORT_ORDER, CLIENT_DEFAULT_EFFORT } from './roster.mjs';
export { writeReport, pickRepresentatives, objectFrame, REPORT_VIEWS, REPRESENTATIVES } from './write.mjs';
export { summaryMarkdown } from './markdown.mjs';
export { compareRounds, regressionReport, regressionMarkdown, regressionStatement, parseSystems, tostP, maxConcurrent, REGRESSION_SCHEMA, REGRESSION_SET, REGRESSION_SYSTEMS,
  REGRESSION_VERDICTS, REGRESSION_REASONS, MAIN_VARIANTS, EQUIVALENCE_MARGIN, EQUIVALENCE_LEVEL, REGRESSION_SAMPLES, ROUND_LABELS } from './regression.mjs';
export { collectRuns, normaliseUsage, manifestProvenance, scorerIdentity, scorerVersion, DEFAULT_EXCLUDED_STATUSES, UNNAMED_SET, UNKNOWN_SET,
  UNKNOWN_ARCHETYPE } from './collect.mjs';
export { bootstrapMean, pairedBootstrap, tInterval, tTestP, holmAdjust, studentQuantile, chiSquareQuantile, incompleteGamma, sdRange, pooledSD, detectableDifference,
  summarise, mean, median, quantile, spread, sampleSD, LOW_EVIDENCE_OBJECTS, BOOTSTRAP_SAMPLES, PAIRWISE_SAMPLES, SMALL_SAMPLE_OBJECTS, FAMILY_ALPHA } from './stats.mjs';
