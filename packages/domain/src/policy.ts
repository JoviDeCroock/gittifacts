import { z } from "zod";

/** Narrow categories a repo may let reach Lane 0 without an approved Plan. */
export const PlanlessCategory = z.enum(["dependency-patch", "pure-revert", "verified-transform"]);
export type PlanlessCategory = z.infer<typeof PlanlessCategory>;

export const RolloutPolicy = z.object({
  /** Percent of traffic per stage; last stage must be 100. */
  stages: z.array(z.number().int().min(1).max(100)).min(1).default([5, 25, 100]),
  /** Minutes to hold each stage before advancing. */
  stageMinutes: z.number().int().min(1).max(24 * 60).default(10),
  /** Minutes to keep watching after reaching 100%. */
  watchMinutes: z.number().int().min(1).max(7 * 24 * 60).default(30),
  /** Absolute error-rate increase (0..1) over the previous version that triggers a revert. */
  maxErrorRateIncrease: z.number().min(0).max(1).default(0.01),
  /** New Workers Issues groups for the change's version that trigger a revert. */
  maxNewIssueGroups: z.number().int().min(0).default(0),
  /** Minimum requests in a window before error rates are trusted. */
  minRequests: z.number().int().min(0).default(50),
});
export type RolloutPolicy = z.infer<typeof RolloutPolicy>;

export const RepoPolicy = z.object({
  version: z.literal(1).default(1),
  /**
   * Shadow mode: Lane 0 starts disabled. The classifier still computes it and the
   * platform records whether humans agreed. Owners flip this once trust is earned.
   */
  lane0Enabled: z.boolean().default(false),
  shadow: z
    .object({
      /** Agreement ratio (0..1) needed before the UI offers to enable Lane 0. */
      agreementThreshold: z.number().min(0).max(1).default(0.95),
      /** Minimum number of human-reviewed Lane-0 candidates before the ratio counts. */
      minSamples: z.number().int().min(1).default(25),
    })
    .default({ agreementThreshold: 0.95, minSamples: 25 }),
  sensitivePaths: z
    .array(z.string())
    .default([
      "**/auth/**",
      "**/payments/**",
      "**/billing/**",
      "**/migrations/**",
      "**/*.sql",
      ".platform/**",
      ".github/workflows/**",
      "**/wrangler.json",
      "**/wrangler.jsonc",
      "**/wrangler.toml",
      "**/cloudflare.config.ts",
    ]),
  thresholds: z
    .object({
      /** Changed-line coverage needed for Lane 0 (0..1). */
      changedLineCoverage: z.number().min(0).max(1).default(0.8),
      /** Mutation score on changed lines needed for Lane 0 (0..1). */
      mutationScore: z.number().min(0).max(1).default(0.6),
      /** Max added+deleted lines for Lane 0. */
      lane0MaxDiffLines: z.number().int().min(1).default(150),
      lane0MaxFiles: z.number().int().min(1).default(8),
      /** Above this a change is Lane 2 on size alone. */
      lane1MaxDiffLines: z.number().int().min(1).default(800),
      lane1MaxFiles: z.number().int().min(1).default(40),
    })
    .default({
      changedLineCoverage: 0.8,
      mutationScore: 0.6,
      lane0MaxDiffLines: 150,
      lane0MaxFiles: 8,
      lane1MaxDiffLines: 800,
      lane1MaxFiles: 40,
    }),
  dependencies: z
    .object({
      /** Lane 0 may include semver patch bumps of existing deps. Everything else blocks Lane 0. */
      allowPatchBumpsInLane0: z.boolean().default(true),
    })
    .default({ allowPatchBumpsInLane0: true }),
  planlessLane0: z.array(PlanlessCategory).default([]),
  rollout: RolloutPolicy.default({
    stages: [5, 25, 100],
    stageMinutes: 10,
    watchMinutes: 30,
    maxErrorRateIncrease: 0.01,
    maxNewIssueGroups: 0,
    minRequests: 50,
  }),
  ai: z
    .object({
      /** Hard budget for all model calls on one Change, in USD. Exceeding it escalates the lane. */
      budgetUsdPerChange: z.number().min(0).default(0.5),
      reviewerModel: z.string().default("auto"),
    })
    .default({ budgetUsdPerChange: 0.5, reviewerModel: "auto" }),
  /** Routes to screenshot for every change, in addition to plan-declared ones. */
  previewRoutes: z.array(z.string()).default([]),
});
export type RepoPolicy = z.infer<typeof RepoPolicy>;
export type RepoPolicyInput = z.input<typeof RepoPolicy>;

export const POLICY_PATH = ".platform/policy.ts";
export const CI_PATH = ".platform/ci.ts";
export const TRANSFORMS_DIR = ".platform/transforms/";

export function defaultPolicy(): RepoPolicy {
  return RepoPolicy.parse({});
}

/** Identity helper for `.platform/policy.ts` authors: `export default definePolicy({...})`. */
export function definePolicy(input: RepoPolicyInput): RepoPolicyInput {
  return input;
}
