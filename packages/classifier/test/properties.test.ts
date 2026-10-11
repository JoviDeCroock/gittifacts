/**
 * Property-style tests: run every base input through every single negative mutation and check
 * invariants that must hold for ANY input — monotonicity (unknown/negative never lowers the lane),
 * LLM judgments only raising, checklist consistency, sorting, determinism and immutability.
 */
import type { EvidenceKind } from "@app/evidence";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ClassifyResult,
  classify,
  GATES,
  REASON_CODES,
  type ReasonCode,
} from "../src/index.js";
import {
  addFiles,
  bump,
  type ClassifyInput,
  coverage,
  deepFreeze,
  dependencies,
  file,
  green,
  llm,
  mutate,
  mutation,
  plan,
  preview,
  publicApi,
  quarantine,
  raisedCodes,
  redGreen,
  replaceKind,
  resolution,
  run,
  setStatus,
  testRun,
  transform,
  withFiles,
  withItems,
  withoutKind,
} from "./helpers.js";
import { codemodRename, pureBugfixWithRegressionTest } from "./scenarios.js";

// ---------------------------------------------------------------- bases

/**
 * These tests enumerate inputs × mutations (the pairs test is quadratic). They take seconds and
 * run while other suites load the machine (the M5 dogfood ran six CI runs at once), so they get
 * an explicit budget far above their cost instead of vitest's 5 s default, and the enumeration is
 * bounded so growth is a visible decision, not a slow creep into the budget.
 */
const PROPERTY_TIMEOUT_MS = 120_000;
const MAX_PAIRS = 10_000;

const BASES: ReadonlyArray<readonly [string, () => ClassifyInput]> = [
  ["green (Lane 0)", green],
  ["green in shadow mode", () => mutate(green(), (d) => (d.policy.lane0Enabled = false))],
  ["additive API (Lane 1)", () => replaceKind(green(), "public-api", publicApi("additive"))],
  [
    "claimed feature (no red-green requirement)",
    () => mutate(green(), (d) => (d.change.category = "feature")),
  ],
  [
    "planless dependency patch",
    () =>
      mutate(
        replaceKind(
          withFiles(green(), [file("package.json", 1, 1), file("pnpm-lock.yaml", 4, 4)]),
          "dependencies",
          dependencies({
            changed: [bump("left-pad", "patch")],
            lockfileChanged: true,
            lockfile: {
              verified: true,
              changes: [
                { lockfile: "pnpm-lock.yaml", name: "left-pad", from: "1.2.3", to: "1.2.4" },
              ],
              problems: [],
            },
          }),
        ),
        (d) => {
          d.plan = null;
          d.change.category = "dependency";
          d.policy.planlessLane0 = ["dependency-patch"];
        },
      ),
  ],
  [
    "verified revert in shadow mode (auto-merge exception)",
    () =>
      mutate(withoutKind(withFiles(green(), [file("src/slugify.ts", 1, 4)]), "red-green"), (d) => {
        d.plan = null;
        d.change.category = "revert";
        d.policy.lane0Enabled = false;
        d.context.pureRevertVerified = true;
      }),
  ],
  [
    "codemod rename scenario (45 extra files)",
    () => codemodRename({ lane0Enabled: true, extraFiles: 45 }).input,
  ],
  ["pure bugfix scenario (shadow)", () => pureBugfixWithRegressionTest().input],
];

// ---------------------------------------------------------------- negative mutations

type Mutation = readonly [
  name: string,
  kind: "add" | "status" | "remove" | "plan",
  apply: (i: ClassifyInput) => ClassifyInput,
];

const REQUIRED_KINDS: EvidenceKind[] = [
  "test-run",
  "public-api",
  "dependencies",
  "sensitive-paths",
  "red-green",
];
const ALL_KINDS: EvidenceKind[] = [
  ...REQUIRED_KINDS,
  "coverage",
  "mutation",
  "preview",
  "screenshots",
  "agent-trace",
  "transform",
  "llm-judgment",
];

const MUTATIONS: Mutation[] = [
  ...[...REQUIRED_KINDS, "coverage", "mutation", "transform"].map(
    (k): Mutation => [`remove ${k}`, "remove", (i) => withoutKind(i, k as EvidenceKind)],
  ),
  ...ALL_KINDS.map((k): Mutation => [`${k} errored`, "status", (i) => setStatus(i, k, "error")]),
  ...[...REQUIRED_KINDS, "coverage", "mutation", "transform"].map(
    (k): Mutation => [`${k} skipped`, "status", (i) => setStatus(i, k as EvidenceKind, "skipped")],
  ),
  ["evidence null", "remove", (i) => mutate(i, (d) => (d.evidence = null))],
  ["diffStats null", "remove", (i) => mutate(i, (d) => (d.diffStats = null))],
  ...(["failed", "errored", "cancelled", "unknown"] as const).map(
    (s): Mutation => [`CI ${s}`, "add", (i) => mutate(i, (d) => (d.context.ciStatus = s))],
  ),
  ["evidence unverified", "add", (i) => mutate(i, (d) => (d.context.evidenceVerified = false))],
  ["budget exceeded", "add", (i) => mutate(i, (d) => (d.context.budgetExceeded = true))],
  ["tour failed", "add", (i) => mutate(i, (d) => (d.context.tourStatus = "failed"))],
  [
    "revert no longer verified",
    "add",
    (i) => mutate(i, (d) => (d.context.pureRevertVerified = false)),
  ],
  ["Lane 0 disabled", "add", (i) => mutate(i, (d) => (d.policy.lane0Enabled = false))],
  [
    "auto-merge of reverts off",
    "add",
    (i) => mutate(i, (d) => (d.policy.autoMergeVerifiedReverts = false)),
  ],
  ["planless categories off", "add", (i) => mutate(i, (d) => (d.policy.planlessLane0 = []))],
  [
    "patch bumps disallowed",
    "add",
    (i) => mutate(i, (d) => (d.policy.dependencies.allowPatchBumpsInLane0 = false)),
  ],
  ["LLM concern", "add", (i) => withItems(i, llm("concern", { id: "llm:x:concern" }))],
  ["LLM unsure", "add", (i) => withItems(i, llm("unsure", { id: "llm:x:unsure" }))],
  [
    "LLM errored",
    "add",
    (i) => withItems(i, llm("concern", { id: "llm:x:error", status: "error" })),
  ],
  [
    "preview errored (added)",
    "add",
    (i) => withItems(i, preview({ id: "preview:2", status: "error" })),
  ],
  ["API additive", "add", (i) => withItems(i, publicApi("additive", { id: "public-api:2" }))],
  ["API breaking", "add", (i) => withItems(i, publicApi("breaking", { id: "public-api:2" }))],
  [
    "dependency added",
    "add",
    (i) =>
      withItems(
        i,
        dependencies({
          id: "deps:2",
          added: [{ name: "x", version: "1.0.0", dev: false, manifest: "package.json" }],
        }),
      ),
  ],
  [
    "dependency removed",
    "add",
    (i) =>
      withItems(
        i,
        dependencies({
          id: "deps:2",
          removed: [{ name: "x", version: "1.0.0", dev: false, manifest: "package.json" }],
        }),
      ),
  ],
  ...(["major", "minor", "prerelease", "other"] as const).map(
    (b): Mutation => [
      `${b} bump`,
      "add",
      (i) => withItems(i, dependencies({ id: "deps:2", changed: [bump("y", b)] })),
    ],
  ),
  [
    "install script",
    "add",
    (i) =>
      withItems(
        i,
        dependencies({
          id: "deps:2",
          newInstallScripts: [{ name: "y", script: "postinstall", command: "x" }],
        }),
      ),
  ],
  [
    "lockfile-only change",
    "add",
    (i) => withItems(i, dependencies({ id: "deps:2", lockfileChanged: true })),
  ],
  // Merge queue: a conflict resolution (any shape) and quarantined tests may only add reasons.
  ["resolution within hunks", "add", (i) => withItems(i, resolution({ id: "res:within" }))],
  [
    "resolution outside hunks",
    "add",
    (i) => withItems(i, resolution({ id: "res:outside", touchesOutsideConflictHunks: true })),
  ],
  [
    "resolution with edits but no hunks",
    "add",
    (i) => withItems(i, resolution({ id: "res:nohunks", conflictHunks: [] })),
  ],
  [
    "semantic resolution",
    "add",
    (i) =>
      withItems(
        i,
        resolution({
          id: "res:semantic",
          conflictHunks: [],
          touchesOutsideConflictHunks: true,
          semanticConflictWith: "chg_upstream",
        }),
      ),
  ],
  [
    "resolution truncated",
    "add",
    (i) => withItems(i, resolution({ id: "res:truncated", truncated: true })),
  ],
  [
    "resolution skipped",
    "add",
    (i) => withItems(i, resolution({ id: "res:skipped", status: "skipped", note: "n/a" })),
  ],
  [
    "resolution errored",
    "add",
    (i) => withItems(i, resolution({ id: "res:error", status: "error", note: "invalid twice" })),
  ],
  ["quarantined test in affected set", "add", (i) => withItems(i, quarantine({ id: "q:1" }))],
  [
    "quarantined tests outside the affected set",
    "add",
    (i) => withItems(i, quarantine({ id: "q:2", inAffectedSet: [] })),
  ],
  [
    "quarantine list errored",
    "add",
    (i) => withItems(i, quarantine({ id: "q:3", status: "error", note: "registry down" })),
  ],
  ["coverage low", "add", (i) => withItems(i, coverage(0.3, { id: "coverage:2" }))],
  ["mutation low", "add", (i) => withItems(i, mutation(0.2, { id: "mutation:2" }))],
  ["tests failing", "add", (i) => withItems(i, testRun({ id: "test-run:2", failed: 1 }))],
  [
    "red-green not-proven",
    "add",
    (i) => withItems(i, redGreen("not-proven", { id: "red-green:2" })),
  ],
  ["red-green no-tests", "add", (i) => withItems(i, redGreen("no-tests", { id: "red-green:2" }))],
  [
    "transform mismatch",
    "add",
    (i) =>
      withItems(
        i,
        transform(["src/slugify.ts"], {
          id: "transform:2",
          verified: false,
          mismatchedFiles: ["src/slugify.ts"],
        }),
      ),
  ],
  ["sensitive file", "add", (i) => addFiles(i, file("src/auth/x.ts", 1, 0))],
  ["migration file", "add", (i) => addFiles(i, file("db/migrations/0001.sql", 5, 0))],
  ["platform file", "add", (i) => addFiles(i, file(".platform/ci.ts", 1, 0))],
  ["file outside scope", "add", (i) => addFiles(i, file("lib/x.ts", 1, 0))],
  ["outOfScope file", "add", (i) => addFiles(i, file("src/legacy/x.ts", 1, 0))],
  ["big file", "add", (i) => addFiles(i, file("src/big.ts", 500, 400))],
  [
    "many files",
    "add",
    (i) => addFiles(i, ...Array.from({ length: 45 }, (_, n) => file(`src/many/${n}.ts`, 1, 0))),
  ],
  ["plan removed", "plan", (i) => mutate(i, (d) => (d.plan = null))],
  [
    "plan draft",
    "plan",
    (i) => mutate(i, (d) => (d.plan = plan({ ...(d.plan ?? {}), status: "draft" }))),
  ],
  [
    "plan scope undeclared",
    "plan",
    (i) => mutate(i, (d) => (d.plan = plan({ ...(d.plan ?? {}), scopePaths: [] }))),
  ],
];

function summary(r: ClassifyResult): string {
  return `computed=${r.computedLane} lane=${r.lane} raised=${JSON.stringify(raisedCodes(r))}`;
}

// ---------------------------------------------------------------- invariants

function expectInvariants(r: ClassifyResult, label: string): void {
  // Reasons sorted by lane desc, then code.
  for (let i = 1; i < r.reasons.length; i++) {
    const a = r.reasons[i - 1];
    const b = r.reasons[i];
    if (!a || !b) continue;
    expect(
      a.lane > b.lane || (a.lane === b.lane && a.code <= b.code),
      `${label}: sort at ${i}`,
    ).toBe(true);
  }
  // Every code is catalogued and carries the catalogue's lane (one documented exception).
  for (const reason of r.reasons) {
    expect(Object.hasOwn(REASON_CODES, reason.code), `${label}: ${reason.code}`).toBe(true);
    const spec = REASON_CODES[reason.code as ReasonCode];
    if (reason.code === "signal.error.red-green") expect([1, 2]).toContain(reason.lane);
    else expect(reason.lane, `${label}: lane of ${reason.code}`).toBe(spec.lane);
  }
  // computedLane is the max over reasons other than the shadow reason; lane is max over all.
  const nonShadow = r.reasons.filter((x) => x.code !== "shadow.lane0-disabled");
  expect(r.computedLane, label).toBe(Math.max(0, ...nonShadow.map((x) => x.lane)));
  expect(r.lane, label).toBe(Math.max(0, ...r.reasons.map((x) => x.lane)));
  expect(r.lane >= r.computedLane, label).toBe(true);
  // Shadow mode.
  expect(r.shadow, label).toBe(r.reasons.some((x) => x.code === "shadow.lane0-disabled"));
  if (r.shadow) expect([r.computedLane, r.lane], label).toEqual([0, 1]);
  // Blocking and human approval only ever come with Lane 2.
  if (r.blocked) expect(r.lane, label).toBe(2);
  if (r.requiresHumanApproval) expect(r.lane, label).toBe(2);
  // Checklist: fixed gates in order, consistent with the computed lane.
  expect(
    r.checklist.map((c) => c.gate),
    label,
  ).toEqual([...GATES]);
  for (const c of r.checklist)
    expect(c.detail.length, `${label}: ${c.gate} detail`).toBeGreaterThan(0);
  const gates = r.checklist.filter((c) => c.gate !== "lane0-enabled");
  expect(r.computedLane === 0, `${label}: computed 0 ⇔ all gates pass`).toBe(
    gates.every((c) => c.passed === true),
  );
  expect(r.lane === 0, `${label}: lane 0 ⇔ every gate passes`).toBe(
    r.checklist.every((c) => c.passed === true),
  );
}

describe.each(BASES)("base: %s", (_name, base) => {
  const before = run(base());

  it("satisfies the invariants", () => expectInvariants(before, "base"));

  it("no single negative mutation lowers computedLane or lane", {
    timeout: PROPERTY_TIMEOUT_MS,
  }, () => {
    for (const [name, , apply] of MUTATIONS) {
      const after = run(apply(base()));
      const msg = `${name}: before ${summary(before)} / after ${summary(after)}`;
      expect(after.computedLane >= before.computedLane, msg).toBe(true);
      expect(after.lane >= before.lane, msg).toBe(true);
      expectInvariants(after, name);
    }
  });

  it("a no-concern LLM judgment never changes the outcome (judgments only raise)", {
    timeout: PROPERTY_TIMEOUT_MS,
  }, () => {
    for (const [name, , apply] of [
      ["(none)", "add", (i: ClassifyInput) => i] as const,
      ...MUTATIONS,
    ]) {
      const mutated = apply(base());
      // A judgment can only be added to an existing bundle; with no bundle there is nothing to add to.
      if (mutated.evidence === null) continue;
      const without = run(mutated);
      for (const question of [
        "scope-drift",
        "plan-conformance",
        "hidden-behavior-change",
      ] as const) {
        const withJudgment = run(
          withItems(apply(base()), llm("no-concern", { id: `llm:${question}:ok`, question })),
        );
        const msg = `${name} + no-concern(${question})`;
        expect(withJudgment.computedLane, msg).toBe(without.computedLane);
        expect(withJudgment.lane, msg).toBe(without.lane);
        expect(withJudgment.shadow, msg).toBe(without.shadow);
        expect(withJudgment.blocked, msg).toBe(without.blocked);
        expect(raisedCodes(withJudgment), msg).toEqual(raisedCodes(without));
      }
    }
  });
});

describe("pairs of additive negative mutations", () => {
  // Status flips and removals can legitimately replace one signal with another (e.g. a concern
  // that is then marked errored); plan edits remove the plan's own checks. Only signals that are
  // ADDED must compose monotonically.
  const additive = MUTATIONS.filter(([, kind]) => kind === "add");

  it("adding two negative signals is never lower than adding either one", {
    timeout: PROPERTY_TIMEOUT_MS,
  }, () => {
    expect(additive.length ** 2, "bounded: raise MAX_PAIRS consciously").toBeLessThanOrEqual(
      MAX_PAIRS,
    );
    const single = new Map(
      additive.map(([name, , apply]) => [name, run(apply(green())).computedLane]),
    );
    for (const [n1, , a1] of additive) {
      for (const [n2, , a2] of additive) {
        const both = run(a2(a1(green()))).computedLane;
        const floor = Math.max(single.get(n1) ?? 0, single.get(n2) ?? 0);
        expect(both >= floor, `${n1} + ${n2}: ${both} < ${floor}`).toBe(true);
      }
    }
  });
});

describe("determinism and purity", () => {
  afterEach(() => vi.restoreAllMocks());

  it("the same input twice gives deep-equal results", { timeout: PROPERTY_TIMEOUT_MS }, () => {
    for (const [, base] of BASES) {
      for (const [, , apply] of MUTATIONS.slice(0, 20)) {
        const input = apply(base());
        expect(run(input)).toStrictEqual(run(structuredClone(input)));
      }
    }
  });

  it("does not mutate its (deep-frozen) inputs", () => {
    const input = withItems(green(), llm("concern"), transform(["src/slugify.ts"]));
    const snapshot = JSON.stringify(input);
    const frozen = deepFreeze(structuredClone(input));
    expect(() =>
      classify(
        frozen.evidence,
        frozen.policy,
        frozen.plan,
        frozen.diffStats,
        frozen.change,
        frozen.context,
      ),
    ).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(snapshot);
  });

  it("never reads the clock or randomness", () => {
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now called");
    });
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random called");
    });
    for (const [, base] of BASES) expect(() => run(base())).not.toThrow();
  });

  it("evidence item order does not change the result", () => {
    const input = green();
    const reversed = mutate(input, (d) => d.evidence?.items.reverse());
    expect(run(reversed)).toStrictEqual(run(input));
  });

  it("diff file order does not change the result", () => {
    const input = addFiles(green(), file("lib/a.ts", 1, 0), file("src/auth/b.ts", 2, 0));
    const reversed = mutate(input, (d) => d.diffStats?.files.reverse());
    expect(run(reversed)).toStrictEqual(run(input));
  });
});

describe("reason ordering", () => {
  it("lists every reason sorted by lane desc then code, with lane-0 passes included", () => {
    const r = run(
      addFiles(
        withItems(replaceKind(green(), "public-api", publicApi("additive")), llm("concern")),
        file("lib/x.ts", 1, 0),
      ),
    );
    const head = r.reasons.slice(0, 4).map((x) => [x.lane, x.code]);
    expect(head).toEqual([
      [2, "llm.concern"],
      [2, "scope.drift"],
      [1, "api.additive"],
      [0, "budget.ok"],
    ]);
    expect(r.reasons.filter((x) => x.lane === 0).length).toBeGreaterThan(10);
  });
});
