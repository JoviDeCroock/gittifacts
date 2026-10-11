import type { LaneReason } from "@app/domain";
import type { EvidenceItem } from "@app/evidence";
import { describe, expect, it } from "vitest";
import {
  splitFailures,
  stripAnsi,
  summarize,
  unmeasuredEffect,
  verifyCommand,
} from "../src/lib/evidence.js";

const r = (code: string, lane: LaneReason["lane"], evidenceRef?: string): LaneReason => ({
  code,
  lane,
  message: code,
  evidenceRef,
});

describe("unmeasuredEffect", () => {
  it("says a missing measurement raised the lane only when a reason anchored to it did", () => {
    const reasons = [r("plan.missing", 1), r("signal.missing.coverage", 1, "coverage")];
    expect(unmeasuredEffect("coverage", reasons)).toBe(
      "Unknown counts as risk: this forces at least Lane 1.",
    );
    expect(unmeasuredEffect("agent-trace", reasons)).toBe("It did not raise this change's lane.");
  });
  it("names a skip the policy accepts", () => {
    expect(
      unmeasuredEffect("mutation", [r("signal.skip-accepted.mutation", 0, "mutation")]),
    ).toMatch(/policy accepts this skip/);
  });
  it("before classification it can only say the gap can raise the lane", () => {
    expect(unmeasuredEffect("coverage", [])).toBe(
      "Unknown counts as risk, so it can raise the lane.",
    );
  });
});

describe("verifyCommand", () => {
  it("is one pasteable line: the evidence head (12 chars) and this platform's keys", () => {
    expect(verifyCommand("19c18b61ebbd4f0e9d7c2a1b3c4d5e6f7a8b9c0d", "https://gf.example/")).toBe(
      "verify-attestation --repo . --commit 19c18b61ebbd --keys-url https://gf.example/.well-known/gittifacts-keys.json",
    );
  });
});

describe("pre-existing failures and untested code", () => {
  const run = (over: Record<string, unknown> = {}) =>
    ({
      id: "test-run",
      kind: "test-run",
      status: "ok",
      sha: "b".repeat(40),
      step: "test",
      runner: "vitest",
      passed: 9,
      failed: 2,
      skipped: 0,
      durationMs: 1,
      failures: [
        { name: "a > old", message: "x" },
        { name: "b > new", message: "y" },
      ],
      preExisting: ["a > old"],
      baseline: { sha: "a".repeat(40), status: "ok" },
      ...over,
    }) as Extract<EvidenceItem, { kind: "test-run" }>;

  it("counts only new failures, and names the pre-existing ones apart", () => {
    expect(summarize(run())).toMatchObject({
      value: "1 failing (+1 pre-existing)",
      tone: "danger",
    });
    expect(
      summarize(run({ failed: 1, failures: [{ name: "a > old", message: "x" }] })),
    ).toMatchObject({
      value: "1 pre-existing",
      tone: "warn",
    });
    expect(splitFailures(run()).pre.map((f) => f.name)).toEqual(["a > old"]);
  });

  it("without a usable baseline every failure counts", () => {
    const item = run({ baseline: { sha: "a".repeat(40), status: "unavailable" } });
    expect(summarize(item)).toMatchObject({ value: "2 failing", tone: "danger" });
  });

  it("says when no test covers mutated code, and strips colour codes", () => {
    const m = {
      id: "mutation",
      kind: "mutation",
      status: "ok",
      tool: "stryker",
      files: ["src/App.tsx"],
      killed: 0,
      survived: 0,
      timedOut: 0,
      noCoverage: 7,
      score: 0,
      survivors: [],
    } as Extract<EvidenceItem, { kind: "mutation" }>;
    expect(summarize(m)).toMatchObject({ value: "No tests cover it", tone: "warn" });
    expect(stripAnsi("\u001b[32m09:08:11\u001b[39m INFO")).toBe("09:08:11 INFO");
  });
});
