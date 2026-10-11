/**
 * Priority, aging and weighted fair queuing (§4.5).
 *
 * Rank (lower = sooner): revert/incident 0 → security 1 → Lane 0 2 → Lane 1 3 → Lane 2 4.
 * Aging lowers the rank by one per `agingStepMs` waited, but never below 1: an old entry catches up
 * with security fixes, never with reverts and incident fixes. Ties break on the fair-queuing tag,
 * then arrival order. Together these bound the wait of every entry (no starvation).
 */
import type { QueueConfig } from "./config.js";
import type { QueueEntry } from "./schema.js";
import type { QueueState } from "./state.js";

export function baseRank(e: Pick<QueueEntry, "priority" | "lane">): number {
  switch (e.priority) {
    case "revert":
    case "incident":
      return 0;
    case "security":
      return 1;
    case "normal":
      return 2 + e.lane;
  }
}

/**
 * Express = may land while the queue is frozen: reverts, and incident fixes a human put in the
 * incident class. An agent's incident class (even citing an approved Plan) only orders the entry:
 * a freeze is a human decision and only a human (or a revert) gets through it.
 */
export function isExpress(e: Pick<QueueEntry, "priority" | "incidentByHuman">): boolean {
  return e.priority === "revert" || (e.priority === "incident" && e.incidentByHuman === true);
}

export function effectiveRank(e: QueueEntry, now: number, cfg: QueueConfig): number {
  if (!cfg.features.priorities) return 0;
  const rank = baseRank(e);
  if (!cfg.features.aging || rank <= 1) return rank;
  const steps = Math.floor(Math.max(0, now - e.enqueuedAt) / cfg.agingStepMs);
  return Math.max(1, rank - steps);
}

/** Fair-queuing flow: the agent session if any, else the principal. */
export function flowKey(e: Pick<QueueEntry, "enqueuedBy">): string {
  return e.enqueuedBy.sessionId === null
    ? `p:${e.enqueuedBy.principalId}`
    : `s:${e.enqueuedBy.principalId}/${e.enqueuedBy.sessionId}`;
}

/**
 * Virtual finish tag (WFQ): a flow's entries are spaced 1/weight apart from the later of the
 * queue's virtual time and the flow's previous tag. A flooding session's entries get far-future
 * tags; a newcomer's first entry starts at "now".
 */
export function assignTag(s: QueueState, e: QueueEntry): number {
  if (!s.config.features.fairness) return e.seq;
  const weight = s.config.principalWeights[e.enqueuedBy.principalId] ?? 1;
  const key = flowKey(e);
  const start = Math.max(s.fairness.vtime, s.fairness.finish[key] ?? 0);
  const tag = start + 1 / weight;
  s.fairness.finish[key] = tag;
  return tag;
}

/** Called when an entry enters a batch: virtual time follows the service order. */
export function advanceVirtualTime(s: QueueState, e: QueueEntry): void {
  if (!s.config.features.fairness) return;
  const weight = s.config.principalWeights[e.enqueuedBy.principalId] ?? 1;
  // Virtual time = start tag of the entry entering service.
  s.fairness.vtime = Math.max(s.fairness.vtime, e.wfqTag - 1 / weight);
}

export interface Ordered {
  rank: number;
  tag: number;
  seq: number;
}

export function compareOrder(a: Ordered, b: Ordered): number {
  return a.rank - b.rank || a.tag - b.tag || a.seq - b.seq;
}
