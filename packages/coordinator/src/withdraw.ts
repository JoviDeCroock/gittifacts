/**
 * A QA failure after approval withdraws the approval (user decision, DECISIONS 2026-10-04).
 *
 * The approvals of the tested head are marked withdrawn (the same record GitHub reviews, the check
 * run's button and the platform UI write, so it stops counting everywhere), audited as
 * `approval.withdrawn` with reason `qa-failed`, and announced to the repo's humans. Then:
 * - native: a queued Change leaves the merge queue, and the head is graded again (the QA item is
 *   carried into the new bundle), so it waits for a fresh approval at the raised lane;
 * - GitHub: the Change goes back to awaiting review (GitHub merges; nothing to dequeue).
 * "Couldn't test" and errored runs never withdraw anything: they only raise the lane.
 */
import type { ReviewDecision } from "@app/domain";
import type { CoordinatorBindings } from "./bindings.js";
import type { Ports } from "./ports.js";

export interface WithdrawOutcome {
  withdrawn: ReviewDecision[];
  dequeued: boolean;
  regraded: boolean;
}

export async function withdrawApprovalsForQa(
  ports: Pick<Ports, "store" | "audit" | "notifier" | "clock">,
  bindings: Pick<CoordinatorBindings, "mergeQueue" | "changeCoordinator">,
  input: { changeId: string; headSha: string; runId: string; failed: string[] },
): Promise<WithdrawOutcome> {
  const { store, audit, notifier, clock } = ports;
  const none: WithdrawOutcome = { withdrawn: [], dequeued: false, regraded: false };
  const change = await store.getChange(input.changeId);
  if (change === null || change.headSha !== input.headSha || store.withdrawReview === undefined) return none;
  if (["merged", "rolling-out", "released", "reverted", "rejected", "abandoned"].includes(change.status)) return none;
  const approvals = ((await store.listReviews?.(input.changeId)) ?? []).filter(
    (r) => r.headSha === input.headSha && r.decision === "approve" && r.withdrawn == null,
  );
  if (approvals.length === 0) return none;

  const withdrawal = { at: clock.now().toISOString(), reason: "qa-failed" as const, by: input.runId };
  for (const r of approvals) {
    await store.withdrawReview(r.id, withdrawal);
    await audit.append({
      principalId: "system",
      action: "approval.withdrawn",
      subject: `change:${input.changeId}`,
      payload: { reviewId: r.id, reviewerId: r.reviewerId, source: r.source ?? "platform", headSha: input.headSha, reason: "qa-failed", runId: input.runId, failed: input.failed.slice(0, 10) },
    });
  }
  const names = await Promise.all(approvals.map(async (r) => (await store.getPrincipal(r.reviewerId))?.name ?? r.reviewerId));
  await notifier.notify({
    kind: "approval-withdrawn",
    changeId: input.changeId,
    repoId: change.repoId,
    message: `QA failed on ${change.title} at ${input.headSha.slice(0, 12)}, so the approval by ${names.join(", ")} was withdrawn. Failed: ${input.failed.slice(0, 3).map((c) => `"${c.slice(0, 80)}"`).join("; ")}. It needs a fresh approval.`,
  });

  let dequeued = false;
  let regraded = false;
  if (change.host == null) {
    if (change.status === "queued") {
      dequeued = await bindings.mergeQueue(change.repoId).remove({ repoId: change.repoId, changeId: input.changeId }).catch(() => false);
    }
    if (change.status === "approved" || change.status === "queued") {
      // A fresh grade of the same head: the QA item rides along, the lane comes out raised, and
      // the workflow waits for a new approval (the old instance waited for a merge).
      const out = await bindings.changeCoordinator(input.changeId).regrade({ changeId: input.changeId, reason: `approval withdrawn: QA run ${input.runId} failed` });
      regraded = out.action === "started";
    }
  } else if (change.status === "approved") {
    await store.updateChange(input.changeId, { status: "awaiting-review" });
  }
  return { withdrawn: approvals, dequeued, regraded };
}
