/**
 * The merge queue's lane floor for conflict resolutions: a resolution can only keep or raise the
 * lane, never lower it.
 *
 * After a resolver agent resolves a conflict, the Change is re-evidenced and re-classified on the
 * merged tree (base + Change + resolution). That classification describes what actually lands,
 * but it may come out lower than the Change's previous one (for example, upstream already made
 * the same breaking change, so the merged diff no longer shows it). `neverLower` keeps the
 * previous lane in that case and says so with a `resolution.lane-kept` reason. Pure.
 */
import type { Lane, LaneReason } from "@app/domain";
import {
  type ChecklistEntry,
  type ClassifyChange,
  type ClassifyContext,
  type ClassifyEvidence,
  type ClassifyResult,
  classify,
} from "./classify.js";
import { compareStrings, formatList } from "./paths.js";
import { formatReason, type Gate, REASON_CODES, type ReasonCode } from "./reasons.js";

const SHADOW: ReasonCode = "shadow.lane0-disabled";

function compareReasons(a: LaneReason, b: LaneReason): number {
  return (
    b.lane - a.lane ||
    compareStrings(a.code, b.code) ||
    compareStrings(a.message, b.message) ||
    compareStrings(a.evidenceRef ?? "", b.evidenceRef ?? "")
  );
}

/** Mark `gate` with a raised reason, keeping whatever it already reported. */
function raiseGate(checklist: readonly ChecklistEntry[], gate: Gate, reason: LaneReason) {
  const outcome = REASON_CODES[reason.code as ReasonCode].outcome;
  return checklist.map((entry): ChecklistEntry => {
    if (entry.gate !== gate) return entry;
    if (entry.passed === true)
      return { gate, passed: outcome === "fail" ? false : null, detail: reason.message };
    return {
      gate,
      passed: entry.passed === false || outcome === "fail" ? false : null,
      detail: `${entry.detail} ${reason.message}`,
    };
  });
}

/**
 * `next` (the merged tree's classification), floored at `previous` (the Change's classification
 * before the resolution; null when there was none):
 * - `lane` and `computedLane` are never below `previous.lane` / `previous.computedLane`;
 * - when `next` is lower, a `resolution.lane-kept` reason at `previous.lane` is added (on the
 *   `conflict-resolution` gate) naming the previous raised reasons. Shadow mode no longer applies
 *   because the computed lane is then at least 1;
 * - `requiresHumanApproval` is kept if either required it; `blocked` describes the merged tree.
 * Every reason of `next` is kept.
 */
export function neverLower(previous: ClassifyResult | null, next: ClassifyResult): ClassifyResult {
  if (previous === null) return next;
  const requiresHumanApproval = previous.requiresHumanApproval || next.requiresHumanApproval;
  const lowered = next.lane < previous.lane || next.computedLane < previous.computedLane;
  if (!lowered) {
    return requiresHumanApproval === next.requiresHumanApproval
      ? next
      : { ...next, requiresHumanApproval };
  }
  // previous.lane >= previous.computedLane, and one of them is above next's: kept >= 1.
  const kept = Math.max(1, previous.lane, previous.computedLane) as Lane;
  const before = previous.reasons.filter((r) => r.lane > 0 && r.code !== SHADOW).map((r) => r.code);
  const keptReason: LaneReason = {
    code: "resolution.lane-kept",
    lane: kept,
    message: formatReason("resolution.lane-kept", {
      lane: kept,
      next: `Lane ${next.lane}`,
      codes: formatList(before, 8, previous.shadow ? "Lane 0 in shadow mode" : "no raised reason"),
    }),
  };
  const reasons = [...next.reasons.filter((r) => r.code !== SHADOW), keptReason].sort(
    compareReasons,
  );
  const computedLane = Math.max(next.computedLane, kept) as Lane;
  const lane = Math.max(0, ...reasons.map((r) => r.lane)) as Lane;
  return {
    lane,
    computedLane,
    reasons,
    shadow: false,
    blocked: next.blocked,
    requiresHumanApproval,
    checklist: raiseGate(next.checklist, "conflict-resolution", keptReason),
  };
}

/**
 * Re-classify a Change on the merged tree after a conflict resolution, floored at its previous
 * classification. The queue shell calls this (not `classify`) for resolved Changes, so the floor
 * cannot be forgotten. `previous` is required: without it there is nothing to keep.
 */
export function reclassifyAfterResolution(
  previous: ClassifyResult,
  evidence: ClassifyEvidence | null,
  policy: Parameters<typeof classify>[1],
  plan: Parameters<typeof classify>[2],
  diffStats: Parameters<typeof classify>[3],
  change: ClassifyChange,
  context: ClassifyContext,
): ClassifyResult {
  return neverLower(previous, classify(evidence, policy, plan, diffStats, change, context));
}
