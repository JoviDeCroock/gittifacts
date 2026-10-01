// Repository policy for @fixture/lib.
//
// The platform reads this file from the BASE commit of every change (never from the
// change's head), so editing it only affects changes that start after it merges.
// Kept as a plain object literal with no imports so it can be evaluated in isolation.
export default {
  version: 1,
  // Shadow mode: the classifier still computes Lane 0, but such changes are routed
  // to Lane 1 until humans have agreed with enough Lane 0 calls.
  lane0Enabled: false,
  shadow: { agreementThreshold: 0.95, minSamples: 25 },
  sensitivePaths: [
    "**/auth/**",
    "**/payments/**",
    "**/billing/**",
    "**/migrations/**",
    "**/*.sql",
    ".platform/**",
    ".github/workflows/**",
  ],
  thresholds: {
    // Temporarily lowered while legacy formatting code is backfilled with tests.
    changedLineCoverage: 0.5,
    mutationScore: 0.6,
    lane0MaxDiffLines: 150,
    lane0MaxFiles: 8,
    lane1MaxDiffLines: 800,
    lane1MaxFiles: 40,
  },
  dependencies: { allowPatchBumpsInLane0: true },
  planlessLane0: [],
  autoMergeVerifiedReverts: true,
  ai: { budgetUsdPerChange: 0.5, reviewerModel: "auto" },
  previewRoutes: [],
};
