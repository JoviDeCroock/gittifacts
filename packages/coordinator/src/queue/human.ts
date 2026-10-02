/**
 * Commands that involve people: a fresh approval when the queue raised a Change's lane (or a
 * resolution invalidated the approval it had), and the "fix the flaky test" Plan a quarantine
 * opens. Neither ever approves anything: approvals come back as `Approved` from a human review.
 */
import type { Plan } from "@app/domain";
import type { CommandOf } from "@app/merge-queue";
import { changeSubject } from "../ids.js";
import { SYSTEM_PRINCIPAL_ID } from "../ports.js";
import type { QueueContext } from "./context.js";

/**
 * Lane rose above the approval (or a resolution with new lines / outside the hunks / a semantic
 * fix): the Change goes back to `awaiting-review` (so the review UI and `submit_review` accept it)
 * at the raised lane, and a human other than the author and its resolvers must approve.
 */
export async function requestApproval(
  ctx: QueueContext,
  cmd: CommandOf<"RequestApproval">,
): Promise<void> {
  const { store, notifier } = ctx.ports;
  const change = await store.getChange(cmd.changeId);
  if (change === null) return;
  const known = new Set(change.laneReasons.map((r) => r.code));
  const lane = Math.max(change.lane ?? 0, cmd.lane) as 0 | 1 | 2;
  const awaiting = change.status === "queued" || change.status === "approved";
  await store.updateChange(change.id, {
    lane,
    laneReasons: [...change.laneReasons, ...cmd.reasons.filter((r) => !known.has(r.code))],
    ...(awaiting ? { status: "awaiting-review" as const } : {}),
  });
  const why = cmd.reasons
    .map((r) => r.message)
    .slice(0, 3)
    .join(" ");
  await notifier.notify({
    kind: "review-requested",
    changeId: change.id,
    repoId: change.repoId,
    message:
      `${change.title} needs a fresh Lane ${lane} approval in the merge queue. ${why}`.trim(),
  });
  const tourId = await resolutionTour(ctx, change.id).catch(() => null);
  await ctx.audit(changeSubject(change.id), "merge-queue.approval-requested", {
    lane,
    reasons: cmd.reasons.map((r) => r.code),
    excludePrincipals: cmd.excludePrincipals,
    tourId,
  });
}

/**
 * A fresh tour for the head the queue resolved (when there is one): the reviewer agent sees the
 * resolved head's evidence, so its `conflict-resolution` item becomes the platform's "Conflict
 * resolution" stop (@app/tour). Best effort, within the Change's AI budget; the review binds to
 * the Change as before.
 */
async function resolutionTour(ctx: QueueContext, changeId: string): Promise<string | null> {
  const { store, reviewer } = ctx.ports;
  const entry = ctx.deps.state().entries[changeId];
  const change = await store.getChange(changeId);
  if (entry === undefined || change === null || entry.resolverIds.length === 0) return null;
  const head = entry.headSha;
  const [evidence, classification, diff, plan, repo] = await Promise.all([
    store.getEvidence(changeId, head),
    store.getClassification(changeId, head),
    change.headSha === null ? null : store.getDiff(changeId, change.headSha),
    change.planId === null ? null : store.getPlan(change.planId),
    ctx.repo(),
  ]);
  if (evidence === null || classification === null || diff === null) return null;
  const coordinator = ctx.deps.bindings.changeCoordinator(changeId);
  const limitUsd = repo.policy.ai.budgetUsdPerChange;
  const spentUsd = await coordinator.spent(changeId);
  if (spentUsd >= limitUsd) return null;
  const replay = ctx.deps.store.getHead(changeId, head);
  const out = await reviewer.tour({
    change: {
      id: change.id,
      title: change.title,
      headSha: head,
      baseSha: replay?.replayBase ?? change.baseSha,
    },
    plan,
    diff,
    evidence,
    classification,
    budget: { changeId, limitUsd, spentUsd },
    model: repo.policy.ai.reviewerModel,
  });
  await coordinator.recordSpend({ changeId, usd: out.costUsd });
  if (out.status !== "ok") return null;
  await store.putTour(out.tour);
  await store.updateChange(changeId, { tourId: out.tour.id });
  return out.tour.id;
}

function planIdFor(repoId: string, test: string): string {
  let h = 0x811c9dc5;
  for (const ch of `${repoId}\n${test}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return `plan-flaky-${h.toString(36)}`;
}

/** A draft Plan, authored by the platform, to fix a quarantined test (idempotent per test). */
export async function openFlakyTestPlan(
  ctx: QueueContext,
  cmd: CommandOf<"OpenPlan">,
): Promise<void> {
  const { store } = ctx.ports;
  const id = planIdFor(ctx.repoId, cmd.test);
  if ((await store.getPlan(id)) !== null) return;
  if (store.insertPlan === undefined) {
    await ctx.audit(ctx.repoSubject(), "merge-queue.plan-not-opened", {
      test: cmd.test,
      why: "this store cannot create plans",
    });
    return;
  }
  const plan: Plan = {
    id,
    repoId: ctx.repoId,
    title: cmd.title.slice(0, 200),
    intent:
      `The merge queue quarantined ${cmd.test} as suspected-flaky: it failed on a batch tree and on main's head. Find why it is nondeterministic and make it deterministic, then un-quarantine it.`.slice(
        0,
        10_000,
      ),
    acceptanceCriteria: [
      `${cmd.test} passes deterministically (e.g. 50 repeated runs, also under parallel load).`,
      "The fix does not weaken what the test asserts.",
    ],
    outOfScope: ["Deleting or skipping the test."],
    riskDeclarations: [],
    scopePaths: [],
    affectedRoutes: [],
    status: "draft",
    authorId: SYSTEM_PRINCIPAL_ID,
    approvedBy: null,
    approvedAt: null,
    approvalSignature: null,
    supersedes: null,
    createdAt: ctx.ports.clock.now().toISOString(),
  };
  await store.insertPlan(plan);
  await ctx.audit(ctx.repoSubject(), "merge-queue.flaky-plan-opened", {
    planId: id,
    test: cmd.test,
    evidenceRefs: cmd.evidenceRefs,
  });
}
