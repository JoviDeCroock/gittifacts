/**
 * The contract scenarios, defined once and run against every host. Inputs come from the
 * classifier's fixture scenarios (`@app/classifier/test/scenarios`: plan, base policy, claimed
 * category, measured evidence) and the fixture repos (`fixtures/`: real base and head trees);
 * the expectations are the classifier's plus what every host must show the same way.
 */
import {
  type Scenario as ClassifierScenario,
  SCENARIOS,
  type ScenarioName,
} from "@app/classifier/test/scenarios";
import type { ClaimedCategory, Lane, Plan, RepoPolicy } from "@app/domain";
import type { LaneAction } from "@app/host";

export const CONTRACT_SCENARIO_NAMES = [
  "pure-bugfix-with-regression-test",
  "breaking-api",
  "new-dependency",
  "touches-auth",
  "codemod-rename",
  "scope-drift",
  "fork-pr",
  "force-push-during-eval",
  "stale-head-at-merge",
] as const;
export type ContractScenarioName = (typeof CONTRACT_SCENARIO_NAMES)[number];

/**
 * - `grade`: open the change, let the host grade it, compare.
 * - `fork`: the head comes from a fork / an author without push access to main.
 * - `force-push`: `firstFixture`'s head is pushed, then force-replaced mid-grading.
 * - `stale-head`: graded, then a new head arrives and a merge for the old head is attempted.
 */
export type ContractKind = "grade" | "fork" | "force-push" | "stale-head";

export interface ContractExpectation {
  lane: Lane;
  computedLane: Lane;
  shadow: boolean;
  blocked: boolean;
  requiresHumanApproval: boolean;
  /** Reason codes that must be present / absent in the final verdict. */
  includes: string[];
  excludes: string[];
  /** The routing on a host with every capability (others degrade via `laneZeroAction`). */
  action: LaneAction;
  /** Exactly the evidence kinds in the sealed bundle. */
  evidenceKinds: string[];
  /** The file the tour's first risk stop cites; null when there is no tour. */
  riskiestFile: string | null;
}

export interface ContractScenario {
  name: ContractScenarioName;
  kind: ContractKind;
  description: string;
  /** fixtures/<fixture>: the base and (final) head trees. */
  fixture: string;
  /** force-push: the head pushed first, then replaced. */
  firstFixture?: string;
  category: ClaimedCategory;
  plan: Plan | null;
  /** The policy on the base (default branch). */
  policy: RepoPolicy;
  /** What CI emits for (base, head): the measured evidence, without platform-computed kinds. */
  ciItems(shas: { baseSha: string; headSha: string }): unknown[];
  expected: ContractExpectation;
}

/** Kinds the platform computes itself, whatever CI says (`assembleEvidence`). */
const PLATFORM_KINDS = ["sensitive-paths", "preview", "screenshots", "agent-trace"];
const FIXTURE_BASE_SHA = "a".repeat(40);
const FIXTURE_HEAD_SHA = "b".repeat(40);

/** The riskiest hunk's file for each fixture (rank 1 of `rankHunks` over the real diff). */
const RISKIEST: Record<string, string | null> = {
  // No risk factor on either hunk: the larger one (the 19-line regression test) ranks first.
  "pure-bugfix-with-regression-test": "test/allocate.test.ts",
  "breaking-api": "src/format.ts",
  "new-dependency": "package.json",
  "touches-auth": "src/auth/token.ts",
  "codemod-rename": "src/format.ts",
  "scope-drift": "src/money.ts",
};

function fromClassifier(
  name: ContractScenarioName,
  base: ScenarioName,
  kind: ContractKind,
  extra: Partial<ContractScenario> = {},
): ContractScenario {
  const s: ClassifierScenario = SCENARIOS[base]();
  const ci = (s.input.evidence?.items ?? []).filter(
    (i) => i.kind !== "sensitive-paths" && i.kind !== "llm-judgment",
  );
  const json = JSON.stringify(ci);
  const kinds = [...new Set([...ci.map((i) => i.kind), ...PLATFORM_KINDS])].sort();
  const e = s.expected;
  return {
    name,
    kind,
    description: s.description,
    fixture: s.fixture,
    category: s.input.change.category,
    plan: s.input.plan,
    policy: s.input.policy,
    ciItems: ({ baseSha, headSha }) =>
      JSON.parse(
        json.replaceAll(FIXTURE_BASE_SHA, baseSha).replaceAll(FIXTURE_HEAD_SHA, headSha),
      ) as unknown[],
    expected: {
      lane: e.lane,
      computedLane: e.computedLane,
      shadow: e.shadow,
      blocked: e.blocked,
      requiresHumanApproval: e.requiresHumanApproval,
      includes: [...e.includes],
      excludes: [...e.excludes],
      action: e.blocked ? "blocked" : e.lane === 0 ? "merge" : "request-review",
      evidenceKinds: kinds,
      riskiestFile: e.lane === 0 && !e.shadow ? null : (RISKIEST[s.fixture] ?? null),
    },
    ...extra,
  };
}

export const CONTRACT_SCENARIOS: Record<ContractScenarioName, () => ContractScenario> = {
  "pure-bugfix-with-regression-test": () =>
    fromClassifier("pure-bugfix-with-regression-test", "pure-bugfix-with-regression-test", "grade"),
  "breaking-api": () => fromClassifier("breaking-api", "breaking-api", "grade"),
  "new-dependency": () => fromClassifier("new-dependency", "new-dependency", "grade"),
  "touches-auth": () => fromClassifier("touches-auth", "touches-auth", "grade"),
  "codemod-rename": () => fromClassifier("codemod-rename", "codemod-rename", "grade"),
  "scope-drift": () => fromClassifier("scope-drift", "scope-drift", "grade"),
  "fork-pr": () =>
    fromClassifier("fork-pr", "pure-bugfix-with-regression-test", "fork", {
      description:
        "The model bugfix, from an author who cannot push to main: same lane, same evidence, read-only sandboxes.",
    }),
  "force-push-during-eval": () =>
    fromClassifier("force-push-during-eval", "pure-bugfix-with-regression-test", "force-push", {
      firstFixture: "bugfix-without-test",
      description:
        "A head without the test is force-replaced by the fixed head while it is graded: only the latest head gets a verdict.",
    }),
  "stale-head-at-merge": () =>
    fromClassifier("stale-head-at-merge", "pure-bugfix-with-regression-test", "stale-head", {
      description:
        "Graded, then a new head arrives: a merge guarded by the old head is refused and the new head is graded.",
    }),
};
