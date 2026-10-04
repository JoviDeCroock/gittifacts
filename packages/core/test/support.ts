import type { Scenario } from "@app/classifier/test/scenarios";
import type { ChangeDiff, Tour } from "@app/domain";
import type { EvidenceItem, SignedEvidence } from "@app/evidence";
import { NATIVE_CAPABILITIES } from "@app/host";
import type {
  EvidenceReport,
  EvidenceSigner,
  GradeInput,
  GradeReviewer,
  MemoryGradeOptions,
} from "../src/index.js";

export const signer: EvidenceSigner & { fail: boolean } = {
  fail: false,
  async signEvidence(payload): Promise<SignedEvidence> {
    return {
      ...payload,
      attestation: {
        v: 1,
        alg: "Ed25519",
        keyId: "test",
        payloadDigest: "d",
        signature: "s",
        signedAt: "2026-10-03T00:00:00.000Z",
        signer: "test",
      },
    };
  },
  async verifyEvidence() {
    return this.fail ? { ok: false, reason: "test" } : { ok: true };
  },
};

export function tourFor(changeId: string, headSha: string, evidence: SignedEvidence): Tour {
  return {
    id: `tour-${changeId}`,
    changeId,
    headSha,
    stops: [
      {
        kind: "intent",
        title: "What this change does",
        why: "It implements the plan.",
        hunkRefs: [],
        evidenceRefs: evidence.items.slice(0, 1).map((i) => i.id),
        verdict: "proven",
      },
    ],
    leastConfident: ["Nothing in particular."],
    notDone: ["Nothing left out."],
    generatedBy: {
      principalId: "reviewer",
      model: "test",
      promptVersion: "1",
      attempts: 1,
      costUsd: 0.01,
    },
    createdAt: "2026-10-03T00:00:00.000Z",
  };
}

export function reviewer(
  opts: { judgeError?: Error; tour?: "ok" | "failed" } = {},
): GradeReviewer & { tours: number; judged: Parameters<GradeReviewer["judge"]>[0][] } {
  return {
    tours: 0,
    judged: [],
    async judge(input) {
      this.judged.push(input);
      if (opts.judgeError !== undefined) throw opts.judgeError;
      return { items: [], costUsd: 0.01, budgetExceeded: false };
    },
    async tour(input) {
      this.tours++;
      if (opts.tour === "failed") {
        return { status: "failed", reason: "no", costUsd: 0.01, budgetExceeded: false };
      }
      const tour = tourFor(input.change.id, input.change.headSha ?? "", input.evidence);
      return { status: "ok", tour, costUsd: 0.01, budgetExceeded: false };
    },
  };
}

/** The scenario's diff as a ChangeDiff (no hunks: the classifier reads only the stats). */
export function diffOf(s: Scenario): ChangeDiff {
  const stats = s.input.diffStats;
  if (stats === null) throw new Error("scenario without a diff");
  return {
    ...stats,
    files: stats.files.map((f) => ({
      ...f,
      transformVerified: false,
      hunks: [],
      truncated: false,
    })),
  };
}

/** What CI would emit: everything but the kinds the platform computes itself. */
export function ciItemsOf(s: Scenario): EvidenceItem[] {
  return (s.input.evidence?.items ?? []).filter(
    (i) => i.kind !== "sensitive-paths" && i.kind !== "llm-judgment",
  );
}

export function gradeSetup(
  s: Scenario,
  over: Partial<GradeInput> = {},
): { input: GradeInput; opts: MemoryGradeOptions<EvidenceReport> } {
  const diff = diffOf(s);
  const change = {
    id: "c1",
    title: s.description.slice(0, 100),
    baseSha: diff.baseSha,
    headSha: diff.headSha,
    category: s.input.change.category,
    agentTraceId: null,
  };
  return {
    input: {
      change,
      policy: { policy: s.input.policy, source: "cache", error: null },
      autoMergeAllowed: true,
      capabilities: NATIVE_CAPABILITIES,
      ...over,
    },
    opts: {
      change,
      diff,
      plan: s.input.plan,
      runner: { run: async () => ({ ciStatus: "passed", items: ciItemsOf(s) }) },
      reviewer: reviewer(),
      signer,
    },
  };
}
