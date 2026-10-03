import { describe, expect, it } from "vitest";
import { newFailureCount, stripAnsi, type TestRun } from "../src/index.js";

describe("stripAnsi", () => {
  it("removes colours, cursor moves and hyperlinks, and leaves plain text alone", () => {
    expect(stripAnsi("\u001b[32m09:08:11 (812) INFO\u001b[39m done")).toBe(
      "09:08:11 (812) INFO done",
    );
    expect(stripAnsi("\u001b[1;31mError\u001b[0m: \u001b[2Kx")).toBe("Error: x");
    expect(stripAnsi("\u001b]8;;https://x.dev\u0007link\u001b]8;;\u0007")).toBe("link");
    expect(stripAnsi("plain [32m text")).toBe("plain [32m text");
  });
});

describe("newFailureCount", () => {
  const sha = "a".repeat(40);
  const run = (over: Partial<TestRun> = {}): TestRun => ({
    id: "test-run",
    kind: "test-run",
    status: "ok",
    sha: "b".repeat(40),
    step: "test",
    runner: "vitest",
    passed: 5,
    failed: 3,
    skipped: 0,
    durationMs: 1,
    failures: [
      { name: "a", message: "x" },
      { name: "b", message: "y" },
      { name: "c", message: "z" },
    ],
    ...over,
  });

  it("counts every failure without a usable baseline (unknown escalates)", () => {
    expect(newFailureCount(run({ preExisting: ["a", "b"] }))).toBe(3);
    const unavailable = { sha, status: "unavailable" as const };
    expect(newFailureCount(run({ preExisting: ["a"], baseline: unavailable }))).toBe(3);
  });

  it("discounts only listed failures proven pre-existing on the same base", () => {
    const ok = { sha, status: "ok" as const, source: "run" as const };
    expect(newFailureCount(run({ preExisting: ["a", "b"], baseline: ok }), sha)).toBe(1);
    expect(newFailureCount(run({ preExisting: ["a", "nope"], baseline: ok }), sha)).toBe(2);
    expect(newFailureCount(run({ preExisting: ["a", "b"], baseline: ok }), "c".repeat(40))).toBe(3);
  });
});
