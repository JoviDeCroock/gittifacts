/**
 * The ports the grading pipeline needs. Hosts and runtimes implement them: the native
 * ChangeWorkflow over its store, CI engine and Durable Objects (each stage a durable step);
 * `memoryGradeDeps` in memory (tests, the contract suite, backtests).
 */
import type { CiStatus, ClassifyResult, TourStatus } from "@app/classifier";
import type { Change, ChangeDiff, ClaimedCategory, Plan, RepoPolicy, Tour } from "@app/domain";
import type { EvidenceItem, EvidencePayload, LlmJudgment, SignedEvidence } from "@app/evidence";
import type { HostCapabilities, LaneVerdict } from "@app/host";
import type { SealedEvidence } from "./evidence.js";
import type { ResolvedPolicy } from "./policy.js";

/** Retry classes a durable runner maps to its own retry presets. */
export type RetryClass = "quick" | "remote" | "model" | "sandbox" | "preview";

/**
 * Runs one named stage. A durable host wraps it in a workflow step (same name, same retry class)
 * so a replay skips finished stages; in memory it just runs. Stage results must be plain JSON,
 * and grading only ever uses stage results between stages (replay-deterministic).
 */
export type StageRunner = <T>(name: string, retry: RetryClass, run: () => Promise<T>) => Promise<T>;

export const runStageNow: StageRunner = (_name, _retry, run) => run();

/** The change being graded, host-neutral (from `HostAdapter.getChange`). */
export interface GradeChange {
  id: string;
  title: string;
  baseSha: string;
  headSha: string;
  category: ClaimedCategory;
  agentTraceId: string | null;
}

export interface GradeInput {
  change: GradeChange;
  /** The policy from BASE (never the head), with where it came from. */
  policy: ResolvedPolicy;
  /** May this change merge without a human at all (native: the project is claimed)? */
  autoMergeAllowed: boolean;
  capabilities: HostCapabilities;
}

/** What the CI/sandbox evidence run reports (hosts may return more; grading reads these). */
export interface EvidenceReport {
  ciStatus: CiStatus;
  /** Raw evidence items from the run, untrusted (validated one by one during assembly). */
  items: readonly unknown[];
}

/** Runs the change's pipeline (user steps + evidence steps) at head against base. */
export interface EvidenceRunner<R extends EvidenceReport = EvidenceReport> {
  run(input: { change: GradeChange; policy: RepoPolicy }): Promise<R>;
}

/** Sign the items for (change, head), verify the attestation, keep it; returns the summary. */
export interface EvidenceSealer {
  seal(items: EvidenceItem[]): Promise<SealedEvidence>;
}

/** Structural twin of `@app/coordinator`'s `Signer` evidence half. */
export interface EvidenceSigner {
  signEvidence(payload: EvidencePayload): Promise<SignedEvidence>;
  verifyEvidence(signed: SignedEvidence): Promise<{ ok: boolean; reason?: string }>;
}

export interface Budget {
  changeId: string;
  limitUsd: number;
  spentUsd: number;
}

/** The reviewer agent (`@app/tour`), structurally the coordinator's `Reviewer` port. */
export interface GradeReviewer {
  /** Model judgments about scope/conformance. Raise-only. Never sees the author's summary. */
  judge(input: { plan: Plan | null; diff: ChangeDiff; budget: Budget; model?: string }): Promise<{
    items: LlmJudgment[];
    costUsd: number;
    budgetExceeded: boolean;
  }>;
  tour(input: {
    change: Pick<Change, "id" | "title" | "headSha" | "baseSha">;
    plan: Plan | null;
    diff: ChangeDiff;
    evidence: SignedEvidence;
    classification: ClassifyResult;
    budget: Budget;
    model?: string;
  }): Promise<
    | { status: "ok"; tour: Tour; costUsd: number; budgetExceeded: boolean }
    | { status: "failed"; reason: string; costUsd: number; budgetExceeded: boolean }
  >;
}

/** AI spend across every head of the change (the per-change budget is not per head). */
export interface SpendLedger {
  spent(): Promise<number>;
  /** Returns the new total. */
  record(usd: number): Promise<number>;
}

/**
 * What grading reads. Durable hosts keep the diff and evidence in their store (they can be
 * large) and read them inside each stage; in memory they are plain values.
 */
export interface GradeData {
  change(): Promise<Pick<Change, "id" | "title"> | null>;
  plan(): Promise<Plan | null>;
  diff(): Promise<ChangeDiff | null>;
  evidence(): Promise<SignedEvidence | null>;
  classification(): Promise<ClassifyResult | null>;
}

/** Where verdicts and tours go (native: the Change row; GitHub: check run and PR review). */
export interface GradeSink {
  verdict(verdict: LaneVerdict, classification: ClassifyResult): Promise<void>;
  tour(tour: Tour): Promise<void>;
}

export interface SkipJudge {
  reason: string;
  /** Logged with `change.judge-skipped`. */
  detail: Record<string, unknown>;
}

export type AfterEvidence =
  | { stop: true }
  | {
      stop?: false;
      sealed: SealedEvidence;
      pureRevertVerified: boolean;
      skipJudge: SkipJudge | null;
    };

/** Host steps that sit inside the pipeline (each one must itself be durable on a durable host). */
export interface GradeHooks<R extends EvidenceReport> {
  /** Items the host produced after the run (native: the preview). */
  workerItems?(ci: R): Promise<EvidenceItem[]>;
  /**
   * After the evidence is sealed (native: onboarding metrics, screenshots, bootstrap release,
   * pure-revert verification). `stop` ends grading without a verdict.
   */
  afterEvidence?(input: { ci: R; sealed: SealedEvidence }): Promise<AfterEvidence>;
  /** Write the evidence to the host (native: `refs/notes/evidence`); only with `supportsNotes`. */
  publishEvidence?(): Promise<void>;
}

export interface GradeDeps<R extends EvidenceReport = EvidenceReport> {
  stage: StageRunner;
  evidence: EvidenceRunner<R>;
  sealer: EvidenceSealer;
  reviewer: GradeReviewer;
  budget: SpendLedger;
  data: GradeData;
  sink: GradeSink;
  /** Audit trail (native: the signed, hash-chained audit log). */
  log(action: string, payload: unknown): Promise<void>;
  hooks?: GradeHooks<R>;
}

/** The classification as the pipeline carries it between stages (plain JSON). */
export interface Classified {
  lane: ClassifyResult["lane"];
  computedLane: ClassifyResult["lane"];
  shadow: boolean;
  blocked: boolean;
  requiresHumanApproval: boolean;
  /** The classifier waived every raised reason of a verified pure revert (`revert.auto-merge`). */
  revertAutoMerge?: boolean;
}

/** The verdict without the reasons and checklist (those are in the published `LaneVerdict`). */
export type VerdictSummary = Omit<LaneVerdict, "reasons" | "checklist">;

export type GradeOutcome<R extends EvidenceReport = EvidenceReport> =
  | { status: "stopped"; ci: R; evidence: SealedEvidence }
  | {
      status: "graded";
      ci: R;
      evidence: SealedEvidence;
      classification: Classified;
      tour: { status: Exclude<TourStatus, "not-generated">; reason: string | null } | null;
      verdict: VerdictSummary;
      budgetExceeded: boolean;
      pureRevertVerified: boolean;
    };
