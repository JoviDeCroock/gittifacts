/**
 * Lane reasons, ordered for people: the reasons that set the lane come first, then the ones that
 * raised it less far, and the passing checks (Lane 0 "ok" rows) last and folded. Every surface
 * (web, CLI, MCP responses, GitHub summary) reads a Change's reasons through this, so a reader
 * sees the 2-3 reasons that matter instead of 19 rows where 13 say "ok". Pure; order is stable.
 */
import type { Lane, LaneReason } from "./model.js";

export interface LaneReasonGroups {
  /** The highest lane any reason forces (0 when there are none). */
  lane: Lane;
  /** Reasons that force exactly that lane: why the Change is in it. Empty when lane is 0. */
  deciding: LaneReason[];
  /** Reasons that raise the lane, but less far than `deciding`. */
  raising: LaneReason[];
  /** Lane 0 reasons: checks that passed. Show folded ("13 checks passed"). */
  passing: LaneReason[];
}

export function groupLaneReasons(reasons: readonly LaneReason[]): LaneReasonGroups {
  const lane = reasons.reduce<Lane>((max, r) => (r.lane > max ? r.lane : max), 0);
  return {
    lane,
    deciding: lane === 0 ? [] : reasons.filter((r) => r.lane === lane),
    raising: reasons.filter((r) => r.lane > 0 && r.lane < lane),
    passing: reasons.filter((r) => r.lane === 0),
  };
}

/** Reasons in reading order: deciding, raising, passing. */
export function orderLaneReasons(reasons: readonly LaneReason[]): LaneReason[] {
  const g = groupLaneReasons(reasons);
  return [...g.deciding, ...g.raising, ...g.passing];
}
