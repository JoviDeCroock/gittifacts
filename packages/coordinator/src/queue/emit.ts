/**
 * `Emit`: the §5 events are already in `mq_events` (committed with the step that produced them,
 * which is what SSE and `wait_for_merge` read). This handler does their side effects on the rest
 * of the platform: the Change row, the ChangeWorkflow (merged / ejected), fork GC, notifications,
 * and the deploy trains (`ChangeMerged`). Every effect is idempotent.
 */
import type { QueueEvent } from "@app/merge-queue";
import { EVENT_MERGED, type MergedEvent, type QueueEjectedEvent } from "../events.js";
import { changeSubject, isForkName } from "../ids.js";
import { casKey } from "./cas.js";
import type { QueueContext } from "./context.js";

/** Merged Changes are deleted from their fork a day later (Artifacts bills per repo-op). */
export const FORK_GC_DELAY_MS = 24 * 60 * 60_000;

const PENDING: ReadonlySet<string> = new Set(["queued", "approved", "awaiting-review"]);

export async function onQueueEvent(ctx: QueueContext, event: QueueEvent): Promise<void> {
  switch (event.type) {
    case "merged":
      return onMerged(ctx, event);
    case "ejected":
      return onEjected(ctx, event);
    case "flag_killed": {
      const change = await ctx.ports.store.getChange(event.changeId);
      if (change === null) return;
      await ctx.ports.notifier.notify({
        kind: "regression-detected",
        changeId: change.id,
        repoId: change.repoId,
        message: `Regression ${event.issueId} on ${event.worker}: ${change.title}'s flag ${event.flagKey} was switched off (deploy batch ${event.trainId}).`,
      });
      return;
    }
    case "frozen":
    case "thawed":
      console.log(JSON.stringify({ mergeQueue: event.type, repoId: ctx.repoId, event }));
      return;
    default:
      return;
  }
}

async function onMerged(ctx: QueueContext, event: Extract<QueueEvent, { type: "merged" }>) {
  const { store } = ctx.ports;
  const change = await store.getChange(event.changeId);
  if (change === null) return;
  const repo = await ctx.repo();
  const landed = ctx.deps.store.getRun<{ bundleRef: string | null }>(casKey(event.casId));
  const bundleRef = landed?.bundleRef ?? null;
  if (PENDING.has(change.status) || change.mergedSha === null)
    await store.updateChange(change.id, { status: "merged", mergedSha: event.mergedSha });
  const deploys =
    ctx.deps.trains !== undefined &&
    repo.deployTarget !== null &&
    repo.claim.status === "claimed" &&
    bundleRef !== null;
  if (deploys && repo.deployTarget !== null) {
    ctx.deps.trains?.changeMerged({
      changeId: change.id,
      sha: event.mergedSha,
      deploysTo: [repo.deployTarget],
      flagKey: event.flagKey,
      files: event.files,
      modules: event.modules,
    });
  }
  if (isForkName(change.forkName))
    await ctx.deps.bindings
      .changeCoordinator(change.id)
      .scheduleForkGc({ changeId: change.id, forkName: change.forkName, delayMs: FORK_GC_DELAY_MS })
      .catch(() => undefined);
  const admitted = ctx.intent(change.id)?.admittedHead ?? change.headSha;
  const payload: MergedEvent = {
    mergedSha: event.mergedSha,
    rebasedFrom: admitted === event.mergedSha ? null : admitted,
    bundleRef,
    deployVia: deploys ? "train" : "rollout",
  };
  await ctx.deliver(change.id, EVENT_MERGED, payload);
}

async function onEjected(ctx: QueueContext, event: Extract<QueueEvent, { type: "ejected" }>) {
  const { store, notifier } = ctx.ports;
  const change = await store.getChange(event.changeId);
  if (change === null) return;
  if (PENDING.has(change.status)) await store.updateChange(change.id, { status: "failing" });
  const r = event.reason;
  await notifier.notify({
    kind: "failing",
    changeId: change.id,
    repoId: change.repoId,
    message: `${change.title} left the merge queue (${r.code}): ${r.message} Next: ${r.fix.call ?? r.fix.explanation}`,
  });
  await ctx.audit(changeSubject(change.id), "merge-queue.ejection-delivered", { code: r.code });
  const payload: QueueEjectedEvent = { ejected: true, reason: r };
  await ctx.deliver(change.id, EVENT_MERGED, payload);
}
