/**
 * In-memory grading deps: everything `gradeChange` needs, held in plain values. Used by tests,
 * the host contract suite and any runtime that grades without a durable store (backtests).
 */
import type { ClassifyResult } from "@app/classifier";
import type { ChangeDiff, Plan, Tour } from "@app/domain";
import type { EvidenceItem, SignedEvidence } from "@app/evidence";
import type { LaneVerdict } from "@app/host";
import { uniqueIds } from "./evidence.js";
import type {
  EvidenceReport,
  EvidenceRunner,
  EvidenceSigner,
  GradeChange,
  GradeDeps,
  GradeHooks,
  GradeReviewer,
} from "./ports.js";
import { runStageNow } from "./ports.js";

export interface MemoryGradeState {
  diff: ChangeDiff | null;
  plan: Plan | null;
  evidence: SignedEvidence | null;
  /** Every seal, in order (judgments reseal the bundle). */
  seals: SignedEvidence[];
  classification: ClassifyResult | null;
  /** Every published verdict, in order (preliminary, then final). */
  verdicts: LaneVerdict[];
  tours: Tour[];
  spentUsd: number;
  log: Array<{ action: string; payload: unknown }>;
  /** Stage names in the order they ran. */
  stages: string[];
}

export interface MemoryGradeOptions<R extends EvidenceReport> {
  change: GradeChange;
  diff: ChangeDiff | null;
  plan: Plan | null;
  runner: EvidenceRunner<R>;
  reviewer: GradeReviewer;
  signer: EvidenceSigner;
  hooks?: GradeHooks<R>;
  /** Spend already recorded for the change (earlier heads). */
  spentUsd?: number;
}

export function memoryGradeDeps<R extends EvidenceReport>(
  opts: MemoryGradeOptions<R>,
): { deps: GradeDeps<R>; state: MemoryGradeState } {
  const state: MemoryGradeState = {
    diff: opts.diff,
    plan: opts.plan,
    evidence: null,
    seals: [],
    classification: null,
    verdicts: [],
    tours: [],
    spentUsd: opts.spentUsd ?? 0,
    log: [],
    stages: [],
  };
  const { change } = opts;
  const deps: GradeDeps<R> = {
    stage: (name, retry, run) => {
      state.stages.push(name);
      return runStageNow(name, retry, run);
    },
    evidence: opts.runner,
    sealer: {
      async seal(items: EvidenceItem[]) {
        const signed = await opts.signer.signEvidence({
          changeId: change.id,
          headSha: change.headSha,
          items: uniqueIds(items),
        });
        const check = await opts.signer.verifyEvidence(signed);
        state.evidence = signed;
        state.seals.push(signed);
        return {
          evidenceId: `ev-${change.id}-${change.headSha.slice(0, 12)}`,
          verified: check.ok,
          itemCount: signed.items.length,
        };
      },
    },
    reviewer: opts.reviewer,
    budget: {
      spent: async () => state.spentUsd,
      record: async (usd) => {
        state.spentUsd += usd;
        return state.spentUsd;
      },
    },
    data: {
      change: async () => ({ id: change.id, title: change.title }),
      plan: async () => state.plan,
      diff: async () => state.diff,
      evidence: async () => state.evidence,
      classification: async () => state.classification,
    },
    sink: {
      async verdict(verdict, classification) {
        state.classification = classification;
        state.verdicts.push(verdict);
      },
      async tour(tour) {
        state.tours.push(tour);
      },
    },
    log: async (action, payload) => {
      state.log.push({ action, payload });
    },
    ...(opts.hooks === undefined ? {} : { hooks: opts.hooks }),
  };
  return { deps, state };
}
