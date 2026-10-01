/**
 * Hand-built classifier inputs mirroring the fixture repos in `fixtures/` (claims, plan scope,
 * changed files with their real line counts, evidence facts from each `fixture.json`, and the
 * policy in `fixtures/_base/.platform/policy.ts`), together with the expected outcome.
 *
 * Integration tests that run the real evidence pipeline over a fixture should reach the same
 * expectations; import via `@app/classifier/test/scenarios`. Note that `includes` lists reason
 * codes that must be present — the classifier also emits Lane-0 "ok" reasons for every gate.
 *
 * Every builder takes `{ lane0Enabled }` (default false, like the fixture base policy) and returns
 * the input plus the expected result under that policy.
 */
import type { Lane, RepoPolicy } from "@app/domain";
import type { EvidenceItem, RedGreenProof } from "@app/evidence";
import type { ReasonCode } from "../src/index.js";
import {
  BASE_SHA,
  type ClassifyInput,
  coverage,
  dependencies,
  diff,
  file,
  greenContext,
  HEAD_SHA,
  mutation,
  plan,
  policy,
  publicApi,
  redGreen,
  sensitivePaths,
  testRun,
  transform,
} from "./helpers.js";

export interface ScenarioExpectation {
  computedLane: Lane;
  lane: Lane;
  shadow: boolean;
  blocked: boolean;
  requiresHumanApproval: boolean;
  /** Reason codes that must be present. */
  includes: ReasonCode[];
  /** Reason codes that must be absent. */
  excludes: ReasonCode[];
}

export interface Scenario {
  /** Directory name under fixtures/. */
  fixture: string;
  description: string;
  input: ClassifyInput;
  expected: ScenarioExpectation;
}

export interface ScenarioOptions {
  lane0Enabled?: boolean;
}

/** `sensitivePaths` from fixtures/_base/.platform/policy.ts (otherwise the domain defaults). */
export const FIXTURE_SENSITIVE_PATHS = [
  "**/auth/**",
  "**/payments/**",
  "**/billing/**",
  "**/migrations/**",
  "**/*.sql",
  ".platform/**",
  ".github/workflows/**",
];

const PACKAGE = "@fixture/lib";

function fixturePolicy(opts: ScenarioOptions): RepoPolicy {
  return policy({
    lane0Enabled: opts.lane0Enabled ?? false,
    sensitivePaths: FIXTURE_SENSITIVE_PATHS,
  });
}

/** Expected routing for a computed lane under the given policy (no revert exception). */
function routed(
  computedLane: Lane,
  opts: ScenarioOptions,
): Pick<ScenarioExpectation, "computedLane" | "lane" | "shadow"> {
  const shadow = computedLane === 0 && !(opts.lane0Enabled ?? false);
  return { computedLane, lane: shadow ? 1 : computedLane, shadow };
}

/** A proven red-green item for tests named "file > suite > test", as in fixture.json. */
function proven(names: string[]): RedGreenProof {
  const tests = names.map((name, i) => ({
    id: `t${i + 1}`,
    file: name.split(" > ")[0] ?? name,
    name,
  }));
  return redGreen("proven", {
    tests,
    base: { sha: BASE_SHA, results: tests.map((t) => ({ id: t.id, outcome: "fail" as const })) },
    head: { sha: HEAD_SHA, results: tests.map((t) => ({ id: t.id, outcome: "pass" as const })) },
  });
}

/** Evidence every fixture has: tests, coverage, mutation, no API/dependency/sensitive findings. */
function common(): EvidenceItem[] {
  return [
    testRun(),
    coverage(1),
    mutation(0.85),
    publicApi("none"),
    dependencies(),
    sensitivePaths(),
  ];
}

function replacing(items: EvidenceItem[], ...replacements: EvidenceItem[]): EvidenceItem[] {
  const kinds = new Set(replacements.map((r) => r.kind));
  return [...items.filter((i) => !kinds.has(i.kind)), ...replacements];
}

const NO_FLAGS = { blocked: false, requiresHumanApproval: false } as const;

const ALLOCATE_PLAN = {
  title: "Fix allocate() losing a minor unit on uneven splits",
  intent:
    "allocate() drops one minor unit when the total does not divide evenly. Hand out every leftover minor unit, first share first, and pin the behaviour with a regression test.",
  outOfScope: [
    "Switching to a largest-remainder distribution strategy",
    "Changes to any module other than allocate",
  ],
  scopePaths: ["src/allocate.ts", "test/allocate.test.ts"],
};

/** fixtures/pure-bugfix-with-regression-test — the model Lane 0 change (computed 0). */
export function pureBugfixWithRegressionTest(opts: ScenarioOptions = {}): Scenario {
  return {
    fixture: "pure-bugfix-with-regression-test",
    description:
      "One-line allocate() fix plus regression tests that fail on base and pass on head.",
    input: {
      evidence: {
        items: [
          ...common(),
          proven([
            "test/allocate.test.ts > allocate > hands leftover minor units to the first shares",
            "test/allocate.test.ts > allocate > never loses or creates a minor unit",
          ]),
        ],
      },
      policy: fixturePolicy(opts),
      plan: plan(ALLOCATE_PLAN),
      diffStats: diff([file("src/allocate.ts", 1, 1), file("test/allocate.test.ts", 19, 0)]),
      change: { category: "fix" },
      context: greenContext(),
    },
    expected: {
      ...routed(0, opts),
      ...NO_FLAGS,
      includes: [
        "red-green.proven",
        "coverage.ok",
        "mutation.ok",
        "plan.approved",
        "scope.within",
        "size.ok",
      ],
      excludes: [],
    },
  };
}

/** fixtures/bugfix-without-test — same fix, no test: red-green "no-tests" on a claimed fix → 2. */
export function bugfixWithoutTest(opts: ScenarioOptions = {}): Scenario {
  return {
    fixture: "bugfix-without-test",
    description: "The allocate() fix with no test change; nothing proves it.",
    input: {
      evidence: { items: [...common(), redGreen("no-tests")] },
      policy: fixturePolicy(opts),
      plan: plan(ALLOCATE_PLAN),
      diffStats: diff([file("src/allocate.ts", 1, 1)]),
      change: { category: "fix" },
      context: greenContext(),
    },
    expected: {
      ...routed(2, opts),
      ...NO_FLAGS,
      includes: ["red-green.no-tests"],
      excludes: ["red-green.proven"],
    },
  };
}

/** fixtures/additive-api — adds an exported multiply(): additive public API → 1. */
export function additiveApi(opts: ScenarioOptions = {}): Scenario {
  return {
    fixture: "additive-api",
    description: "Adds and re-exports multiply(value, factor); no existing export changes.",
    input: {
      evidence: {
        items: replacing(
          common(),
          publicApi("additive", {
            packages: [
              {
                name: PACKAGE,
                entry: "src/index.ts",
                added: [{ symbol: "multiply", after: "(value: Money, factor: number) => Money" }],
                removed: [],
                changed: [],
              },
            ],
          }),
          proven([
            "test/money.test.ts > multiply > scales by a whole factor",
            "test/money.test.ts > multiply > rounds a fractional result to the nearest minor unit",
            "test/money.test.ts > multiply > rounds halves away from zero",
            "test/money.test.ts > multiply > returns a positive zero rather than negative zero",
            "test/money.test.ts > multiply > keeps the currency",
            "test/money.test.ts > multiply > rejects non-finite factors",
          ]),
        ),
      },
      policy: fixturePolicy(opts),
      plan: plan({
        title: "Add multiply() for scaling money by a factor",
        intent: "Add multiply(value, factor) that scales an amount and rounds half away from zero.",
        outOfScope: [
          "Changing add, subtract or any other existing export",
          "Banker's rounding or configurable rounding modes",
        ],
        scopePaths: ["src/money.ts", "src/index.ts", "test/money.test.ts", "README.md"],
      }),
      diffStats: diff([
        file("README.md", 1, 0),
        file("src/index.ts", 1, 1),
        file("src/money.ts", 13, 0),
        file("test/money.test.ts", 34, 1),
      ]),
      change: { category: "feature" },
      context: greenContext(),
    },
    expected: {
      ...routed(1, opts),
      ...NO_FLAGS,
      includes: ["api.additive", "red-green.not-required", "scope.within"],
      excludes: ["api.breaking"],
    },
  };
}

/** fixtures/breaking-api — formatMoney gains a required parameter: breaking public API → 2. */
export function breakingApi(opts: ScenarioOptions = {}): Scenario {
  return {
    fixture: "breaking-api",
    description: "formatMoney(value) becomes formatMoney(value, options) with a required options.",
    input: {
      evidence: {
        items: replacing(
          common(),
          publicApi("breaking", {
            packages: [
              {
                name: PACKAGE,
                entry: "src/index.ts",
                added: [{ symbol: "FormatOptions" }],
                removed: [],
                changed: [
                  {
                    symbol: "formatMoney",
                    before: "(value: Money) => string",
                    after: "(value: Money, options: FormatOptions) => string",
                  },
                ],
              },
            ],
          }),
          proven([
            "test/format.test.ts > formatMoney with style: symbol > puts the currency symbol in front of the amount",
            "test/format.test.ts > formatMoney with style: symbol > puts the minus sign before the symbol",
          ]),
        ),
      },
      policy: fixturePolicy(opts),
      plan: plan({
        title: "Let formatMoney() render currency symbols",
        intent:
          "Give formatMoney an options parameter with a required style and update every caller.",
        outOfScope: ["Locale-aware formatting via Intl", "Parsing the symbol style"],
        scopePaths: ["src/format.ts", "src/index.ts", "test/format.test.ts", "README.md"],
      }),
      diffStats: diff([
        file("README.md", 3, 2),
        file("src/format.ts", 27, 11),
        file("src/index.ts", 1, 0),
        file("test/format.test.ts", 23, 8),
      ]),
      change: { category: "feature" },
      context: greenContext(),
    },
    expected: {
      ...routed(2, opts),
      ...NO_FLAGS,
      includes: ["api.breaking"],
      excludes: ["scope.drift"],
    },
  };
}

/** fixtures/new-dependency — adds nanoid to package.json only (no lockfile): → 2. */
export function newDependency(opts: ScenarioOptions = {}): Scenario {
  return {
    fixture: "new-dependency",
    description: "Adds nanoid ^5.1.5 to package.json dependencies; nothing else changes.",
    input: {
      evidence: {
        items: replacing(
          common(),
          dependencies({
            added: [{ name: "nanoid", version: "^5.1.5", dev: false, manifest: "package.json" }],
            lockfileChanged: false,
          }),
          redGreen("no-tests"),
          // No executable lines changed: full coverage of zero lines, zero mutants.
          mutation(1, { files: [], killed: 0, survived: 0 }),
        ),
      },
      policy: fixturePolicy(opts),
      plan: plan({
        title: "Add nanoid as a runtime dependency",
        intent: "Transfers need short, URL-safe idempotency keys. Add nanoid now.",
        outOfScope: ["Generating idempotency keys (follow-up change)"],
        scopePaths: ["package.json", "pnpm-lock.yaml"],
      }),
      diffStats: diff([file("package.json", 3, 0)]),
      change: { category: "dependency" },
      context: greenContext(),
    },
    expected: {
      ...routed(2, opts),
      ...NO_FLAGS,
      includes: ["dependency.added"],
      excludes: ["scope.drift", "dependency.lockfile-only", "plan.planless"],
    },
  };
}

/** fixtures/touches-auth — a perfect Lane-0 fix, except it is under src/auth/ → 2. */
export function touchesAuth(opts: ScenarioOptions = {}): Scenario {
  return {
    fixture: "touches-auth",
    description:
      "Rejects session tokens at their exact expiry second, with a proven boundary test.",
    input: {
      evidence: {
        items: replacing(
          common(),
          sensitivePaths([{ path: "src/auth/token.ts", pattern: "**/auth/**" }], {
            patterns: FIXTURE_SENSITIVE_PATHS,
          }),
          proven([
            "test/auth.test.ts > signToken / verifyToken > rejects a token at its exact expiry second",
          ]),
        ),
      },
      policy: fixturePolicy(opts),
      plan: plan({
        title: "Reject session tokens at their exact expiry second",
        intent:
          "verifyToken accepts a token during the second named by exp. Tighten the comparison.",
        outOfScope: ["Clock-skew leeway", "Changing the token format or signing algorithm"],
        scopePaths: ["src/auth/token.ts", "test/auth.test.ts"],
      }),
      diffStats: diff([file("src/auth/token.ts", 2, 1), file("test/auth.test.ts", 10, 0)]),
      change: { category: "fix" },
      context: greenContext(),
    },
    expected: {
      ...routed(2, opts),
      ...NO_FLAGS,
      includes: ["sensitive.hit", "red-green.proven", "scope.within"],
      excludes: [],
    },
  };
}

export interface CodemodOptions extends ScenarioOptions {
  /**
   * Extra generated files (24 changed lines each) also reproduced by the verified transform.
   * The fixture itself has 0; tests use 45 to show that size subtraction makes a large rename fit.
   */
  extraFiles?: number;
}

/** fixtures/codemod-rename — requireCurrency → toCurrencyCode via a verified transform: computed 0. */
export function codemodRename(opts: CodemodOptions = {}): Scenario {
  const extra = Array.from(
    { length: opts.extraFiles ?? 0 },
    (_, i) => `src/generated/currency-${String(i).padStart(2, "0")}.ts`,
  );
  const files = [
    file("src/format.ts", 2, 2),
    file("src/internal/currency.ts", 1, 1),
    file("src/money.ts", 2, 2),
    ...extra.map((p) => file(p, 12, 12)),
  ];
  return {
    fixture: "codemod-rename",
    description:
      "Head is exactly what node .platform/transforms/rename-helper.mjs produces on base; no hand edits.",
    input: {
      evidence: {
        items: [
          ...common(),
          redGreen("no-tests"),
          transform(
            files.map((f) => f.path),
            {
              id: "transform:rename-helper",
              transform: "rename-helper",
              command: "node .platform/transforms/rename-helper.mjs",
            },
          ),
        ],
      },
      policy: fixturePolicy(opts),
      plan: plan({
        title: "Rename requireCurrency to toCurrencyCode",
        intent: "Rename it everywhere by running the already-reviewed rename-helper codemod.",
        outOfScope: ["Any hand-written edits", "Renaming exported functions"],
        scopePaths: ["src/**"],
      }),
      diffStats: diff(files),
      change: { category: "transform" },
      context: greenContext(),
    },
    expected: {
      ...routed(0, opts),
      ...NO_FLAGS,
      includes: ["transform.verified", "size.transform-excluded", "size.ok", "plan.approved"],
      excludes: [
        "size.lines-over-lane0",
        "size.files-over-lane0",
        "size.lines-over-lane1",
        "size.files-over-lane1",
        "transform.unverified",
      ],
    },
  };
}

/** fixtures/policy-change — edits .platform/policy.ts: 2 + a non-author human must approve. */
export function policyChange(opts: ScenarioOptions = {}): Scenario {
  return {
    fixture: "policy-change",
    description: "Lowers thresholds.changedLineCoverage from 0.8 to 0.5 in .platform/policy.ts.",
    input: {
      evidence: {
        items: replacing(
          common(),
          sensitivePaths([{ path: ".platform/policy.ts", pattern: ".platform/**" }], {
            patterns: FIXTURE_SENSITIVE_PATHS,
          }),
          redGreen("no-tests"),
        ),
      },
      policy: fixturePolicy(opts),
      plan: plan({
        title: "Lower the Lane 0 changed-line coverage threshold to 50%",
        intent: "Lower thresholds.changedLineCoverage from 0.8 to 0.5 while tests are backfilled.",
        outOfScope: ["Enabling Lane 0", "Changing the mutation score threshold"],
        scopePaths: [".platform/policy.ts"],
      }),
      diffStats: diff([file(".platform/policy.ts", 2, 1)]),
      change: { category: "chore" },
      context: greenContext(),
    },
    expected: {
      ...routed(2, opts),
      blocked: false,
      requiresHumanApproval: true,
      includes: ["policy.changed", "sensitive.hit"],
      excludes: ["scope.drift"],
    },
  };
}

/** fixtures/scope-drift — the diff also edits src/money.ts, outside the plan's scope → 2. */
export function scopeDrift(opts: ScenarioOptions = {}): Scenario {
  return {
    fixture: "scope-drift",
    description: "parseMoney accepts comma-grouped thousands; the diff also edits src/money.ts.",
    input: {
      evidence: {
        items: [
          ...common(),
          proven(["test/format.test.ts > parseMoney > accepts comma-grouped thousands"]),
        ],
      },
      policy: fixturePolicy(opts),
      plan: plan({
        title: "parseMoney: accept comma-grouped thousands",
        intent:
          "Accept comma-grouped thousands in the whole part while rejecting malformed grouping.",
        outOfScope: ["Other modules", "Locale-specific separators (e.g. 1.234,56)"],
        scopePaths: ["src/format.ts", "test/format.test.ts"],
      }),
      diffStats: diff([
        file("src/format.ts", 8, 3),
        file("src/money.ts", 2, 1),
        file("test/format.test.ts", 7, 0),
      ]),
      change: { category: "feature" },
      context: greenContext(),
    },
    expected: {
      ...routed(2, opts),
      ...NO_FLAGS,
      includes: ["scope.drift"],
      excludes: ["scope.within"],
    },
  };
}

export const SCENARIOS = {
  "pure-bugfix-with-regression-test": pureBugfixWithRegressionTest,
  "bugfix-without-test": bugfixWithoutTest,
  "additive-api": additiveApi,
  "breaking-api": breakingApi,
  "new-dependency": newDependency,
  "touches-auth": touchesAuth,
  "codemod-rename": codemodRename,
  "policy-change": policyChange,
  "scope-drift": scopeDrift,
} as const satisfies Record<string, (opts?: ScenarioOptions) => Scenario>;

export type ScenarioName = keyof typeof SCENARIOS;
