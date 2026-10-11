/**
 * `wait_for_change` milestones, decided from a Change snapshot (pure), and the Ports wrapper that
 * pokes the change's Durable Object after every change-row update so long-polls wake up.
 */
import type { Change, WaitUntil } from "@app/domain";
import type { CoordinatorBindings } from "./bindings.js";
import { isBootstrapChange } from "./ids.js";
import type { Ports, Store } from "./ports.js";

/**
 * A human sent the change back before the milestone, so waiting longer is pointless until the
 * author acts: `changes-requested` (a review asked for changes on the current head: push a new
 * one), `rejected` (a review rejected it: it ended), `approval-withdrawn` (the approval of the
 * current head stopped counting, e.g. a QA failure or a lane the merge queue raised: it waits for
 * a fresh review).
 */
export type SentBack = "changes-requested" | "rejected" | "approval-withdrawn";

/**
 * The machines sent it back before a merged/reverted milestone: the current head is `failing`
 * (red CI, or the merge queue ejected it, or the merge failed). Only a new push (or a re-run)
 * moves it again, so a merged wait answers instead of holding until its timeout.
 */
export type MachinesSentBack = "failing";

export type MilestoneState = "reached" | "pending" | "unreachable" | SentBack | MachinesSentBack;

/** Why `wait_for_change` answered: a settled milestone state, or the timeout. */
export type WaitReason = Exclude<MilestoneState, "pending"> | "timeout";

export const WAIT_REASONS = [
  "reached",
  "timeout",
  "unreachable",
  "changes-requested",
  "rejected",
  "approval-withdrawn",
  "failing",
] as const satisfies readonly WaitReason[];

const ENDED: ReadonlySet<Change["status"]> = new Set(["abandoned", "rejected"]);
/** Approved for its head and on the way to the default branch. */
const CLEARED: ReadonlySet<Change["status"]> = new Set(["approved", "queued"]);
/** Back in front of the classifier or a reviewer. */
const REGRADED: ReadonlySet<Change["status"]> = new Set(["running", "awaiting-review"]);
/** Past review/routing: a change here that has no tour will not get one for this head. */
const ROUTED: ReadonlySet<Change["status"]> = new Set([
  "approved",
  "queued",
  "merged",
  "rolling-out",
  "released",
  "reverted",
]);

/**
 * Whether `change` (its current head) has reached `until`. "reached" means the milestone holds
 * now, so the snapshot returned with it never contradicts it:
 *
 * - evidence_ready: CI finished (passed or failed) and the head's signed evidence is sealed. A
 *   bootstrap Change also has its final status by then (released when green, failing when not).
 * - lane_assigned: the head has a lane (the status stays "running" while the tour is written).
 * - tour_ready: the head has a tour and the change was routed (no longer "running").
 * - merged / reverted: on the default branch / reverted.
 *
 * Not reached and sent back by a human (see `SentBack`): `rejected` when a review rejected it;
 * `changes-requested` when the head that was pushed is awaiting a new push again (a review asked
 * for changes); `approval-withdrawn` when `since` (the snapshot the wait started from) was
 * approved or queued and the same head is back to running or awaiting review (merged/reverted
 * waits only: the approval was what they were waiting on). And `failing` (merged/reverted waits)
 * when the head is failing: red CI, a queue ejection or a failed merge, fixed by a new push.
 */
export function milestoneState(
  change: Change,
  until: WaitUntil,
  since: Change | null = null,
): MilestoneState {
  const bootstrap = isBootstrapChange(change);
  // A bootstrap Change is never classified: no lane, no tour.
  if (bootstrap && (until === "lane_assigned" || until === "tour_ready")) {
    return "unreachable";
  }
  let reached: boolean;
  switch (until) {
    case "evidence_ready":
      reached = change.evidenceId !== null && !(bootstrap && change.status === "running");
      break;
    case "lane_assigned":
      reached = change.lane !== null;
      break;
    case "tour_ready":
      reached = change.tourId !== null && change.status !== "running";
      if (
        !reached &&
        change.lane !== null &&
        (ROUTED.has(change.status) || change.status === "failing")
      ) {
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
  if (change.status === "rejected") return "rejected";
  if (ENDED.has(change.status)) return "unreachable";
  if (!bootstrap && change.status === "awaiting-push" && change.headSha !== null) {
    return "changes-requested";
  }
  if (
    (until === "merged" || until === "reverted") &&
    since !== null &&
    CLEARED.has(since.status) &&
    REGRADED.has(change.status) &&
    since.headSha === change.headSha
  ) {
    return "approval-withdrawn";
  }
  if ((until === "merged" || until === "reverted") && change.status === "failing") {
    return "failing";
  }
  return "pending";
}

/**
 * Opaque version of a change row for watchers: any field change changes it (an `updatedAt` alone
 * can repeat within one millisecond).
 */
export function changeVersion(change: Change): string {
  const text = JSON.stringify(change);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/** Longest a single long-poll may hold a request. */
export const MAX_WAIT_MS = 10 * 60_000;

export function clampWait(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 0;
  return Math.min(Math.trunc(timeoutMs), MAX_WAIT_MS);
}

/** How long past its own timeout a held long-poll may take before the caller answers itself. */
export const WAIT_GRACE_MS = 5_000;
/** `retryAfterSec` of a long-poll the platform could not hold (a deploy reset the DO). */
export const WAIT_RETRY_AFTER_SEC = 2;

/**
 * `p`'s value, or `{ kind: "interrupted" }` once it rejects or `ms` pass, whichever is first. The
 * late result of `p` is dropped (and its rejection swallowed).
 */
export async function withDeadline<T>(
  p: Promise<T>,
  ms: number,
): Promise<{ kind: "answered"; value: T } | { kind: "interrupted"; error: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ kind: "interrupted"; error: unknown }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "interrupted", error: "deadline" }), ms);
  });
  try {
    return await Promise.race([
      p.then(
        (value) => ({ kind: "answered" as const, value }),
        (error: unknown) => ({ kind: "interrupted" as const, error }),
      ),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
    get(target, prop) {
      if (prop === "updateChange") {
        const update: Store["updateChange"] = async (id, patch) => {
          const row = await target.updateChange(id, patch);
          await poke(id);
          return row;
        };
        return update;
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { ...ports, store: wrapped };
}
