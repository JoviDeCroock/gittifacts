/**
 * What a host provides to run the contract suite. Each host drives its own real event path
 * (native: push to the change fork → PushRouter → ChangeCoordinator → ChangeWorkflow; GitHub:
 * webhook → Queue → the same coordinator) and reports what it published; the suite compares that
 * with the scenario's expectations, which are the same for every host.
 */
import type { GradeReviewer } from "@app/core";
import type { Lane, Tour } from "@app/domain";
import type { ChangeRef, HostAdapter, LaneAction } from "@app/host";
import type { FileTree } from "./fixtures.js";
import type { ContractScenario } from "./scenarios.js";

export interface OpenInput {
  scenario: ContractScenario;
  /** Full tree of the default branch at the change's base. */
  base: FileTree;
  /** The first push on top of the base (null deletes a path). */
  push: Record<string, string | null>;
  title: string;
}

export interface PublishedVerdict {
  headSha: string;
  lane: Lane;
  computedLane: Lane;
  shadow: boolean;
  blocked: boolean;
  requiresHumanApproval: boolean;
  /** Every reason code in the verdict. */
  reasons: string[];
}

export interface Observed {
  /** The final verdict the host published for this head, or null. */
  verdict: PublishedVerdict | null;
  /** What the host did with it (merged/queued, asked for a review, blocked, labelled). */
  action: LaneAction | null;
  /** The sealed evidence for this head. */
  evidence: { kinds: string[]; verified: boolean } | null;
  tour: Tour | null;
  /** The evidence run for this head, as the host's CI reports it. */
  run: "queued" | "running" | "passed" | "failed" | "cancelled" | "superseded" | null;
  /**
   * The tour as the host shows it to humans (GitHub: the head's PR review), when the host
   * publishes it somewhere other than the platform: its stop count and its riskiest stop's file.
   */
  publishedTour?: { stops: number; riskiestFile: string | null } | null;
  /** An approval for this head is on record (the same record wherever it was given). */
  approved?: boolean;
}

/** Who reviews in the `approval` scenario. */
export type ContractReviewer = "maintainer" | "author" | "agent";

export interface ContractHost {
  readonly adapter: HostAdapter;
  /** Seed a repo at `base` with the scenario's policy and plan, open a change, push `push`. */
  open(input: OpenInput): Promise<{ ref: ChangeRef; headSha: string }>;
  /**
   * Push a new head: `changes` on top of the current head, or with `force` on top of the base
   * (the old head is no longer an ancestor).
   */
  push(
    ref: ChangeRef,
    changes: Record<string, string | null>,
    opts: { force: boolean },
  ): Promise<string>;
  /** While held, evidence runs do not finish; releasing finishes every run still in flight. */
  holdRuns(hold: boolean): Promise<void>;
  /** Wait until the host is quiet (gradings finished or waiting for a human). */
  settle(): Promise<void>;
  observe(ref: ChangeRef, headSha: string): Promise<Observed>;
  /** Every head that got a verdict published (preliminary or final), in order. */
  verdictHeads(ref: ChangeRef): Promise<string[]>;
  /** A review of `headSha` by `who`, through the host's own path (a refusal is not an error). */
  review(ref: ChangeRef, headSha: string, who: ContractReviewer): Promise<void>;
  dispose?(): Promise<void>;
}

export interface ContractHostFactory {
  /** Shown in test names, e.g. "artifacts (fakes)" or "github (recorded fixtures)". */
  name: string;
  /** A fresh host per scenario; `reviewer` must be the one the host grades with. */
  create(deps: { reviewer: GradeReviewer }): Promise<ContractHost>;
}
