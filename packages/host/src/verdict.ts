/**
 * `LaneVerdict`: what the core decided about one head of a change, in a form every host can
 * publish (native: the Change row + stored classification; GitHub: the `<platform>/lane` check
 * run). It is the classifier's result plus the routing action and any capability degradations.
 */
import type { ClassifyResult, TourStatus } from "@app/classifier";
import { type Degradation, type HostCapabilities, laneZeroAction } from "./capabilities.js";

/**
 * - `merge`: Lane 0 and nothing needs a human → the platform merges (through its queue natively).
 * - `label-ready`: same, but the host does not let the platform merge (degradation recorded).
 * - `request-review`: a human reviews the tour (Lane 1/2, shadowed Lane 0, or no auto-merge).
 * - `blocked`: cannot merge at all (CI failed or the evidence attestation did not verify).
 */
export type LaneAction = "merge" | "label-ready" | "request-review" | "blocked";

export interface LaneVerdict extends ClassifyResult {
  headSha: string;
  action: LaneAction;
  /** Capability-driven behaviour changes; empty on a host that can do everything. */
  degradations: Degradation[];
  tourStatus: TourStatus;
  /** True when a tour is still to come and the verdict will be re-published after it. */
  preliminary: boolean;
  /** The signed evidence bundle the verdict is based on. */
  evidence: { id: string; verified: boolean } | null;
}

export interface RouteInput {
  lane: ClassifyResult["lane"];
  blocked: boolean;
  requiresHumanApproval: boolean;
  /**
   * Whether this change may merge without a human at all, before capabilities (native:
   * the project is claimed; unclaimed projects never auto-merge).
   */
  autoMergeAllowed: boolean;
}

/** The routing decision for a classification on a host, with its degradations. */
export function routeVerdict(
  input: RouteInput,
  caps: Pick<HostCapabilities, "canMerge">,
): { action: LaneAction; degradations: Degradation[] } {
  if (input.blocked) return { action: "blocked", degradations: [] };
  if (input.autoMergeAllowed && !input.requiresHumanApproval && input.lane === 0) {
    const zero = laneZeroAction(caps);
    return {
      action: zero.action,
      degradations: zero.degradation === null ? [] : [zero.degradation],
    };
  }
  return { action: "request-review", degradations: [] };
}

/** Exactly the classifier's result inside a verdict (what the native store keeps). */
export function classificationOf(verdict: LaneVerdict): ClassifyResult {
  return {
    lane: verdict.lane,
    computedLane: verdict.computedLane,
    reasons: verdict.reasons,
    shadow: verdict.shadow,
    blocked: verdict.blocked,
    requiresHumanApproval: verdict.requiresHumanApproval,
    checklist: verdict.checklist,
  };
}
