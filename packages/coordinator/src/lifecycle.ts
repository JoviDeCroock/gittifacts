/** Which statuses allow which lifecycle actions. */

import type { CiStatus } from "@app/classifier";
import type { ChangeStatus, RunStatus } from "@app/domain";

/** Statuses in which an agent may still push new heads to its fork. */
export const PUSHABLE_STATUSES: readonly ChangeStatus[] = [
  "awaiting-push",
  "running",
  "failing",
  "awaiting-review",
  "approved",
  "queued",
];

/**
 * The title `create_project` gives the Change it opens for the caller before anything is pushed.
 * While a Change still has it, its first push renames it (the Plan's title, else the pushed
 * commit's subject), so the list doesn't fill up with "First change".
 */
export const PLACEHOLDER_CHANGE_TITLE = "First change";

/** A commit message's subject as a Change title: its first non-empty line, at most 200 chars. */
export function titleFromCommitMessage(message: string | null | undefined): string | null {
  const subject = (message ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (subject === undefined) return null;
  if (subject.length <= 200) return subject;
  // Never cut a surrogate pair in half: a lone surrogate is not canonical JSON (audit M10).
  const cut = subject.slice(0, 199);
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
}

/** Statuses in which CI may be re-run on the same head (`rerun_ci`). */
export const RERUNNABLE_STATUSES: readonly ChangeStatus[] = [
  "running",
  "failing",
  "awaiting-review",
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
