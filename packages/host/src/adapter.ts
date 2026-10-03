/**
 * `HostAdapter`: everything the platform needs from where the code lives. The core never knows
 * which host it runs on; it calls these and reads `capabilities()`.
 *
 * Implementations: `@app/host-artifacts` (native: Artifacts, the platform's own merge queue,
 * git-notes evidence) and `@app/host-github` (GitHub App, M2). Both run the contract suite
 * (`@app/host-contract`): the same change gets the same lane, evidence and tour on either host.
 */
import type { ChangeDiff, ClaimedCategory, Tour } from "@app/domain";
import type { HostCapabilities } from "./capabilities.js";
import type { HostEvents, Identity } from "./events.js";
import type { ChangeRef } from "./ref.js";
import type { LaneVerdict } from "./verdict.js";

/** The host-neutral description of a change (a native Change, a GitHub PR). */
export interface ChangeMeta {
  ref: ChangeRef;
  title: string;
  /**
   * The author's own description. Stored and shown to humans, never given to the reviewer
   * agent (it must not grade the author's summary of their own change).
   */
  body: string | null;
  author: Identity;
  /** The default branch the change targets, and the base it was cut from. */
  baseBranch: string;
  baseSha: string;
  /** Null until something was pushed. */
  headSha: string | null;
  /** What the author claims the change is (GitHub: from labels/title conventions, else null). */
  category: ClaimedCategory | null;
  /** Linked Plan ids (native: the Change's plan; GitHub: `Closes #N`, plan files, plan refs). */
  planRefs: string[];
  /** The change this one reverts, if it is a revert. */
  revertOf: ChangeRef | null;
  agentTraceId: string | null;
  /**
   * Where the head lives. `fork: true` means the head is in a repo the author controls and the
   * platform treats it as untrusted code (natively every change is a fork: agents never get a
   * write token for the main repo).
   */
  source: { fork: boolean; repo: string };
  state: "open" | "closed" | "merged";
}

/** The diff between a change's base and head (hunks, line counts, transform flags). */
export type DiffInfo = ChangeDiff;

/** A tree checked out (or mounted) for a sandbox. Sandboxes only ever get read access. */
export interface SandboxCheckout {
  ref: ChangeRef;
  sha: string;
  /** The Artifacts repo backing the checkout (native: the change's fork; GitHub: the mirror). */
  artifactsRepo: string;
  /** Git remote to clone or mount. */
  remote: string;
  token: { scope: "read"; value: string; expiresAt: string };
  writable: false;
}

export type MergeMethod = "fast-forward" | "merge" | "squash" | "rebase";

export type MergeResult =
  | { status: "merged"; mergedSha: string }
  /** Hosts with their own queue: admitted; `main.advanced` follows when it lands. */
  | { status: "queued"; position: number }
  | {
      status: "refused";
      reason: "stale-head" | "not-allowed" | "not-mergeable" | "closed";
      detail: string;
      /** The head the host has now (the caller re-grades it). */
      currentHeadSha: string | null;
    };

export interface ReviewRequest {
  /** Host ids of the requested reviewers; empty → the host's default (CODEOWNERS, repo owners). */
  reviewers: string[];
  /** One line on why (lane and the top reason). */
  reason: string;
}

export interface HostAdapter {
  readonly kind: ChangeRef["host"];
  capabilities(): HostCapabilities;
  getChange(ref: ChangeRef): Promise<ChangeMeta>;
  /** Get the tree at `sha` into a sandbox (read-only). */
  materialize(ref: ChangeRef, sha: string): Promise<SandboxCheckout>;
  diff(ref: ChangeRef): Promise<DiffInfo>;
  publishVerdict(ref: ChangeRef, verdict: LaneVerdict): Promise<void>;
  publishTour(ref: ChangeRef, tour: Tour): Promise<void>;
  requestReview(ref: ChangeRef, request: ReviewRequest): Promise<void>;
  /** Must be guarded by `expectedHeadSha`: a head that moved is refused, never merged. */
  merge(
    ref: ChangeRef,
    input: { expectedHeadSha: string; method: MergeMethod },
  ): Promise<MergeResult>;
  /** Open a revert of `mergedSha` as a new change. */
  revert(mergedSha: string, reason: string, opts?: { of?: ChangeRef }): Promise<ChangeRef>;
  events(): HostEvents;
}

/** Thrown by adapters for a ref they do not serve or a change they cannot find. */
export class HostError extends Error {
  constructor(
    readonly code: "wrong-host" | "not-found" | "invalid" | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "HostError";
  }
}
