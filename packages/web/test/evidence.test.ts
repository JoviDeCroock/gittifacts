import type { LaneReason } from "@app/domain";
import { describe, expect, it } from "vitest";
import { unmeasuredEffect, verifyCommand } from "../src/lib/evidence.js";

const r = (code: string, lane: LaneReason["lane"], evidenceRef?: string): LaneReason => ({ code, lane, message: code, evidenceRef });

describe("unmeasuredEffect", () => {
  it("says a missing measurement raised the lane only when a reason anchored to it did", () => {
    const reasons = [r("plan.missing", 1), r("signal.missing.coverage", 1, "coverage")];
    expect(unmeasuredEffect("coverage", reasons)).toBe("Unknown counts as risk: this forces at least Lane 1.");
    expect(unmeasuredEffect("agent-trace", reasons)).toBe("It did not raise this change's lane.");
  });
  it("names a skip the policy accepts", () => {
    expect(unmeasuredEffect("mutation", [r("signal.skip-accepted.mutation", 0, "mutation")])).toMatch(/policy accepts this skip/);
  });
  it("before classification it can only say the gap can raise the lane", () => {
    expect(unmeasuredEffect("coverage", [])).toBe("Unknown counts as risk, so it can raise the lane.");
  });
});

describe("verifyCommand", () => {
  it("is one pasteable line: the evidence head (12 chars) and this platform's keys", () => {
    expect(verifyCommand("19c18b61ebbd4f0e9d7c2a1b3c4d5e6f7a8b9c0d", "https://gf.example/")).toBe(
      "verify-attestation --repo . --commit 19c18b61ebbd --keys-url https://gf.example/.well-known/gittifacts-keys.json",
    );
  });
});
