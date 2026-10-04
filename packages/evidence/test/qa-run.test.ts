import { describe, expect, it } from "vitest";
import {
  EvidenceItem,
  generateSigningKey,
  type QaRun,
  signEvidence,
  summarizeItem,
  verifyEvidence,
} from "../src/index.js";
import { HEAD_SHA } from "./helpers.js";

export function sampleQaRun(over: Partial<QaRun> = {}): QaRun {
  return {
    id: "qa-run",
    kind: "qa-run",
    status: "ok",
    runId: "qa_1",
    trigger: "mcp",
    requestedBy: "ag_1",
    app: { source: "private-preview", snapshotStep: "build", origin: "https://q-c1-0123abcd-pv.resynapse.dev" },
    model: "@cf/zai-org/glm-5.3-flash",
    promptVersion: "qa/1",
    criteria: [
      {
        index: 0,
        text: "Clicking + increments the counter",
        source: "plan",
        verdict: "pass",
        reason: "the counter read 1 after one click",
        before: "c0-before.jpg",
        steps: [
          { action: "click", target: "#inc", ok: true, shot: "c0-s1.jpg" },
          { action: "expect_text", target: "#n", value: "1", ok: true, shot: "c0-s2.jpg" },
        ],
        consoleErrors: 0,
        networkErrors: 0,
      },
    ],
    artifacts: [
      { name: "c0-s1.jpg", ref: "qa/c1/qa_1/c0-s1.jpg", sha256: "a".repeat(64), bytes: 1200, contentType: "image/jpeg", role: "step" },
    ],
    blockedOrigins: ["https://fonts.googleapis.com"],
    usage: { wallMs: 41_000, browserMs: 30_000, llmCalls: 3, inputTokens: 9000, outputTokens: 900, llmUsd: 0.0018 },
    ...over,
  };
}

describe("qa-run evidence", () => {
  it("is an evidence item kind and summarizes honestly", () => {
    const item = EvidenceItem.parse(sampleQaRun());
    expect(item.kind).toBe("qa-run");
    expect(summarizeItem(item)).toContain("1 passed, 0 failed, 0 couldn't test");
  });

  it("rejects an artifact without a full SHA-256 and an unknown verdict", () => {
    const bad = sampleQaRun();
    expect(EvidenceItem.safeParse({ ...bad, artifacts: [{ ...bad.artifacts[0], sha256: "abc" }] }).success).toBe(false);
    const c = { ...bad.criteria[0], verdict: "probably" };
    expect(EvidenceItem.safeParse({ ...bad, criteria: [c] }).success).toBe(false);
  });

  it("is covered by the bundle signature: a changed screenshot hash no longer verifies", async () => {
    const k = await generateSigningKey();
    const signer = { privateKey: k.privateKey, publicKey: k.publicKey, name: "test" };
    const signed = await signEvidence({ changeId: "c1", headSha: HEAD_SHA, items: [sampleQaRun()] }, signer);
    expect((await verifyEvidence(signed, k.publicKey)).ok).toBe(true);
    const tampered = structuredClone(signed);
    const qa = tampered.items[0] as QaRun;
    (qa.artifacts[0] as { sha256: string }).sha256 = "b".repeat(64);
    expect((await verifyEvidence(tampered, k.publicKey)).ok).toBe(false);
  });
});
