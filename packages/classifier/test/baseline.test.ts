/**
 * Failures that are pre-existing on the Change's base don't count against it, but only when the
 * baseline is usable and of the Change's own base commit (unknown escalates); mutation of code no
 * test covers is a measured "no coverage", not a tool error; tool colour codes never reach reasons.
 */
import { describe, expect, it } from "vitest";
import {
  BASE_SHA,
  green,
  mutate,
  mutation,
  raisedCodes,
  replaceKind,
  run,
  setStatus,
  testRun,
} from "./helpers.js";

const failures = [
  { name: "test/a.test.ts > old", message: "expected 1 to be 2" },
  { name: "test/b.test.ts > new", message: "boom" },
];
const ok = { sha: BASE_SHA, status: "ok" as const, source: "run" as const };

describe("pre-existing test failures", () => {
  it("only new failures count: identical ones on base are pre-existing (Lane 0 reason)", () => {
    const allOld = testRun({
      failed: 1,
      failures: [failures[0]!],
      preExisting: ["test/a.test.ts > old"],
      baseline: ok,
    });
    const r = run(replaceKind(green(), "test-run", allOld));
    expect(raisedCodes(r)).not.toContain("tests.failing");
    expect(r.reasons.map((x) => x.code)).toEqual(
      expect.arrayContaining(["tests.passed", "tests.preexisting"]),
    );
    expect(r.reasons.find((x) => x.code === "tests.preexisting")?.message).toBe(
      `1 failing test(s) in unit fail identically on base ${BASE_SHA.slice(0, 12)}: pre-existing, not counted.`,
    );
    expect(r.computedLane).toBe(0);
  });

  it("a new failure next to pre-existing ones still forces Lane 2, counting only the new one", () => {
    const mixed = testRun({
      failed: 2,
      failures,
      preExisting: ["test/a.test.ts > old"],
      baseline: ok,
    });
    const r = run(replaceKind(green(), "test-run", mixed));
    const failing = r.reasons.find((x) => x.code === "tests.failing");
    expect(failing?.lane).toBe(2);
    expect(failing?.message).toBe("Test run unit reported 1 failing test(s).");
  });

  it("escalates without a usable baseline of the Change's base: every failure counts", () => {
    const noBaseline = testRun({
      failed: 1,
      failures: [failures[0]!],
      preExisting: ["test/a.test.ts > old"],
    });
    const unavailable = testRun({
      failed: 1,
      failures: [failures[0]!],
      preExisting: ["test/a.test.ts > old"],
      baseline: { sha: BASE_SHA, status: "unavailable" },
    });
    const otherBase = testRun({
      failed: 1,
      failures: [failures[0]!],
      preExisting: ["test/a.test.ts > old"],
      baseline: { ...ok, sha: "c".repeat(40) },
    });
    for (const item of [noBaseline, unavailable, otherBase]) {
      expect(raisedCodes(run(replaceKind(green(), "test-run", item)))).toContain("tests.failing");
    }
    const withoutDiff = mutate(
      replaceKind(
        green(),
        "test-run",
        testRun({
          failed: 1,
          failures: [failures[0]!],
          preExisting: ["test/a.test.ts > old"],
          baseline: ok,
        }),
      ),
      (d) => {
        d.diffStats = null;
      },
    );
    expect(raisedCodes(run(withoutDiff))).toContain("tests.failing");
  });
});

describe("mutation without covering tests", () => {
  it("is a measured no-coverage result (Lane 1, fail), not an error", () => {
    const untested = mutation(0, {
      killed: 0,
      survived: 0,
      timedOut: 0,
      noCoverage: 7,
      survivors: [],
    });
    const r = run(replaceKind(green(), "mutation", untested));
    const reason = r.reasons.find((x) => x.code === "mutation.no-coverage");
    expect(reason).toMatchObject({ lane: 1 });
    expect(reason?.message).toMatch(/No test exercises the changed lines: 7 mutant\(s\)/);
    expect(raisedCodes(r)).not.toContain("signal.error.mutation");
    expect(raisedCodes(r)).not.toContain("mutation.below-threshold");
  });
});

describe("reason text", () => {
  it("never carries ANSI escapes from tool output", () => {
    const r = run(
      setStatus(
        green(),
        "mutation",
        "error",
        "stryker exited 0 without a report: \u001b[32m09:08:11\u001b[39m INFO",
      ),
    );
    const text = r.reasons.find((x) => x.code === "signal.error.mutation")?.message ?? "";
    expect(text).toContain("09:08:11 INFO");
    expect(text).not.toContain("\u001b");
  });
});
