/**
 * The LLM judge is skipped for exactly one kind of Change: a platform-verified pure revert whose
 * tree is the pre-merge tree of the Change it reverts (a state the platform already merged under
 * review). Everything else, including a verified revert on top of later Changes, is judged.
 */
import type { LlmJudgment } from "@app/evidence";
import { describe, expect, it } from "vitest";
import { revertIdFor } from "../../src/ids.js";
import { reload, type Scenario, scenario, startAndPush } from "./helpers.js";

const concern: LlmJudgment[] = [
  {
    id: "llm:hidden",
    kind: "llm-judgment",
    status: "ok",
    question: "hidden-behavior-change",
    outcome: "concern",
    rationale: "removes a code path the plan doesn't mention",
    model: "m",
  },
];

async function mergeOne(s: Scenario, files?: Record<string, string | null>) {
  const started = await startAndPush(s, files);
  await s.coordinator.submitReview(s.reviewer, started.change.id, { decision: "approve" });
  await s.settle();
  return reload(s, started.change.id);
}

const codes = (c: { laneReasons: Array<{ code: string }> }) => c.laneReasons.map((r) => r.code);

describe("judge skip for tree-identical verified reverts", () => {
  it("skips the judge (audited with both trees) and auto-merges with llm.none", async () => {
    const s = await scenario({ policy: { autoMergeVerifiedReverts: true } });
    const original = await mergeOne(s);
    expect(original.mergedSha).not.toBeNull();
    s.ports.reviewer.judgeItems = concern; // would hold the revert for a human if asked
    const judged = s.ports.reviewer.judgeCalls.length;
    await s.coordinator.kill(s.reviewer, original.id, "broke something");
    await s.settle();

    const revert = await reload(s, revertIdFor(original.id));
    expect(revert.mergedSha).not.toBeNull();
    expect(codes(revert)).toEqual(
      expect.arrayContaining(["llm.none", "revert.verified", "revert.auto-merge"]),
    );
    expect(codes(revert)).not.toContain("llm.concern");
    expect(s.ports.reviewer.judgeCalls.length).toBe(judged);
    const skipped = s.ports.audit.payloadOf("change.judge-skipped") as Record<string, unknown>;
    expect(skipped).toMatchObject({ reason: "verified-pure-revert", revertOf: original.id });
    expect(skipped.headTree).toBe(skipped.restoredTree);
  });

  it("judges a verified revert on top of later Changes (tree differs): a concern holds it", async () => {
    const s = await scenario({ policy: { autoMergeVerifiedReverts: true } });
    const first = await mergeOne(s, { "src/a.ts": "export const a = 2;\n" });
    await mergeOne(s, { "src/b.ts": "export const b = 1;\n" });
    s.ports.reviewer.judgeItems = concern;
    const judged = s.ports.reviewer.judgeCalls.length;
    await s.coordinator.kill(s.reviewer, first.id, "broke something");
    await s.settle();

    const revert = await reload(s, revertIdFor(first.id));
    expect(codes(revert)).toContain("revert.verified");
    expect(codes(revert)).toContain("llm.concern");
    expect(revert.lane).toBe(2);
    expect(revert.status).toBe("awaiting-review");
    expect(revert.mergedSha).toBeNull();
    expect(s.ports.reviewer.judgeCalls.length).toBe(judged + 1);
    expect(s.ports.audit.actions(`change:${revert.id}`)).not.toContain("change.judge-skipped");
  });

  it("unclaimed projects still never auto-merge a revert, judged or not", async () => {
    const s = await scenario({
      policy: { autoMergeVerifiedReverts: true, lane0Enabled: true },
      claim: { status: "unclaimed", ownerId: null, expiresAt: "2026-10-08T00:00:00.000Z" },
    });
    const original = await mergeOne(s);
    await s.coordinator.kill(s.reviewer, original.id, "broke something");
    await s.settle();
    const revert = await reload(s, revertIdFor(original.id));
    expect(codes(revert)).toContain("revert.verified");
    expect(codes(revert)).not.toContain("revert.auto-merge");
    expect(revert).toMatchObject({ status: "awaiting-review", mergedSha: null });
  });
});
