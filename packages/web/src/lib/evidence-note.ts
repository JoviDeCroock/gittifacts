/**
 * The evidence page's "Git note" line: where the signed evidence sits in git, or why it does not.
 *
 * Two notes exist for a merged Change. The ChangeWorkflow writes one on the change's fork for the
 * graded head (the fork is deleted after the merge), and the merge queue writes the evidence for
 * what landed on the merged commit on main. When the head landed as is (the queue's fast path,
 * e.g. a revert onto an unmoved main), the evidence shown here IS the merged commit's.
 */
import type { Change } from "@app/domain";
import { shortSha } from "./vocab.js";

export interface GitNoteLine {
  text: string;
  /** "warn": a note that should exist is not recorded. */
  tone: "ok" | "warn" | null;
}

export function gitNoteLine(
  evidence: { headSha: string; notesWritten: boolean },
  change: Pick<Change, "mergedSha" | "host">,
): GitNoteLine {
  const head = evidence.headSha;
  const merged = change.mergedSha ?? null;
  const onMain = merged !== null && head === merged;
  if (change.host) {
    return {
      text: "Not written: a GitHub pull request keeps its evidence on the platform, not in git notes",
      tone: null,
    };
  }
  if (evidence.notesWritten) {
    if (onMain)
      return { text: `Written to refs/notes/evidence on main, on ${shortSha(head)}`, tone: "ok" };
    const landed =
      merged === null
        ? ""
        : `. What landed (${shortSha(merged)}) has its own evidence, signed for the merged commit`;
    return {
      text: `Written to refs/notes/evidence on ${shortSha(head)}, in the change's fork${landed}`,
      tone: "ok",
    };
  }
  if (onMain) {
    return {
      text: `Not written: the merge queue recorded no note on main for ${shortSha(head)}; the audit log has any failed write`,
      tone: "warn",
    };
  }
  return {
    text: "Not written yet: the note follows the model judgment; the audit log has any failed write",
    tone: "warn",
  };
}
