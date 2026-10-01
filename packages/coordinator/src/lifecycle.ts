/** Which statuses allow which lifecycle actions. */
import type { ChangeStatus } from "@app/domain";
import type { CiStatus } from "@app/classifier";
import type { RunStatus } from "@app/domain";

/** Statuses in which an agent may still push new heads to its fork. */
export const PUSHABLE_STATUSES: readonly ChangeStatus[] = [
  "awaiting-push",
  "running",
  "failing",
  "awaiting-review",
  "approved",
  "queued",
];

/** Merged changes a human may kill (flag off, roll back, revert). */
export const KILLABLE_STATUSES: readonly ChangeStatus[] = ["merged", "rolling-out", "released"];

/** No further pushes, reviews or abandonment. */
export const FINAL_STATUSES: readonly ChangeStatus[] = [
  "merged",
  "rolling-out",
  "released",
  "reverted",
  "rejected",
  "abandoned",
];

/** RunStatus → the classifier's CiStatus. Anything not terminal-and-known is "unknown". */
export function toCiStatus(status: RunStatus): CiStatus {
  switch (status) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "errored":
      return "errored";
    case "cancelled":
    case "superseded":
      return "cancelled";
    default:
      return "unknown";
  }
}
