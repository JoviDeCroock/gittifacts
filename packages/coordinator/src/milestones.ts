/**
 * `wait_for_change` milestones, decided from a Change snapshot (pure), and the Ports wrapper that
 * pokes the change's Durable Object after every change-row update so long-polls wake up.
 */
import type { Change, WaitUntil } from "@app/domain";
import type { CoordinatorBindings } from "./bindings.js";
import type { Ports, Store } from "./ports.js";

export type MilestoneState = "reached" | "pending" | "unreachable";

const ENDED: ReadonlySet<Change["status"]> = new Set(["abandoned", "rejected"]);
/** Past review/routing: a change here that has no tour will not get one for this head. */
const ROUTED: ReadonlySet<Change["status"]> = new Set([
  "approved",
  "queued",
  "merged",
  "rolling-out",
  "released",
  "reverted",
]);

export function milestoneState(change: Change, until: WaitUntil): MilestoneState {
  let reached: boolean;
  switch (until) {
    case "evidence_ready":
      reached = change.evidenceId !== null;
      break;
    case "lane_assigned":
      reached = change.lane !== null;
      break;
    case "tour_ready":
      reached = change.tourId !== null;
      if (!reached && change.lane !== null && (ROUTED.has(change.status) || change.status === "failing")) {
        // Auto-merged (lane 0 / verified revert) or blocked: no tour is coming for this head.
        return "unreachable";
      }
      break;
    case "merged":
      reached = change.mergedSha !== null;
      break;
    case "reverted":
      reached = change.status === "reverted" || change.revertedBy !== null;
      break;
  }
  if (reached) return "reached";
  return ENDED.has(change.status) ? "unreachable" : "pending";
}

/** Longest a single long-poll may hold a request. */
export const MAX_WAIT_MS = 10 * 60_000;

export function clampWait(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 0;
  return Math.min(Math.trunc(timeoutMs), MAX_WAIT_MS);
}

/**
 * Ports whose `store.updateChange` also tells the change's ChangeCoordinator DO that the row
 * changed (best effort), so `waitFor`/`watchChange` waiters re-check immediately.
 */
export function withChangeNotifications(ports: Ports, bindings: CoordinatorBindings): Ports {
  const store = ports.store;
  const poke = async (changeId: string): Promise<void> => {
    try {
      await bindings.changeCoordinator(changeId).changed(changeId);
    } catch {
      // Waiters also re-check on their own timeout; a lost poke only delays them.
    }
  };
  const wrapped = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "updateChange") {
        const update: Store["updateChange"] = async (id, patch) => {
          const row = await target.updateChange(id, patch);
          await poke(id);
          return row;
        };
        return update;
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...ports, store: wrapped };
}
