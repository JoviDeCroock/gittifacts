/**
 * Pushes a Change's fork received that did not grade anything: to another branch, a tag, or the
 * branch still at the base commit. The ChangeCoordinator records them (newest last, a few kept)
 * and clears them when a push starts a pipeline; get_change_status and wait_for_change surface
 * them with the fix, so an agent whose push went nowhere is told instead of waiting on timeouts.
 * Pure.
 */
import { z } from "zod";
import type { ErrorFix } from "./model.js";

export const PushIssueKind = z.enum(["wrong-ref", "tag", "no-new-commits"]);
export type PushIssueKind = z.infer<typeof PushIssueKind>;

export const PushIssue = z.object({
  kind: PushIssueKind,
  /** The ref that was pushed, e.g. refs/heads/feature or refs/tags/v1. */
  ref: z.string().min(1),
  /** The ref that grades the Change, e.g. refs/heads/main. */
  expectedRef: z.string().min(1),
  /** What the push pointed `ref` at. */
  sha: z.string(),
  at: z.string(),
  why: z.string(),
});
export type PushIssue = z.infer<typeof PushIssue>;

/** How many ignored pushes a Change keeps (the newest). */
export const MAX_PUSH_ISSUES = 5;

const branchOf = (ref: string) => ref.replace(/^refs\/heads\//, "");

export function describePushIssue(kind: PushIssueKind, ref: string, expectedRef: string): string {
  switch (kind) {
    case "tag":
      return `Pushed tag ${ref}: tags are ignored; only ${expectedRef} on the fork grades the Change.`;
    case "wrong-ref":
      return `Pushed ${ref}, which is ignored: only ${expectedRef} on the fork grades the Change.`;
    case "no-new-commits":
      return `Pushed ${ref}, but it is still at the Change's base commit: there is nothing to grade. Commit your work first.`;
  }
}

/** The fix for an ignored push: push HEAD to the Change's branch of the fork. */
export function pushIssueFix(issue: PushIssue, changeId: string): ErrorFix {
  const branch = branchOf(issue.expectedRef);
  const command = `git push <fork> HEAD:${branch}`;
  return issue.kind === "no-new-commits"
    ? {
        explanation: `Commit your changes, then push them: \`${command}\` (<fork> is remote.url from refresh_push_token, with its token).`,
        command: `git commit -am "<what you changed>" && ${command}`,
      }
    : {
        explanation: `Push your commits to ${branch} of the fork: \`${command}\` (<fork> is remote.url from refresh_push_token({ changeId: "${changeId}" }), with its token).`,
        command,
      };
}

/** Issues still worth showing for a Change at `headSha`: a push of the graded head is harmless. */
export function openPushIssues(
  issues: readonly PushIssue[] | undefined,
  headSha: string | null,
): PushIssue[] {
  return (issues ?? []).filter((i) => i.sha !== headSha);
}
