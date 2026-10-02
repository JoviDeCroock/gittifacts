/**
 * `RequestResolution` (spec §4.4): the resolver agent (`system:resolver`, never the author) fixes
 * a textual or semantic conflict in the scratch repo, the resolution is its own attributable
 * commit, the Change is re-evidenced and re-classified on the merged tree (lanes only rise:
 * `reclassifyAfterResolution`), and the approval binding rules decide whether a human must
 * approve again (DECISIONS.md "Conflict resolution (Q3) semantics").
 *
 *   merge-attempt (scratch: onto + preceding, then the Change) → resolver (model, budget) →
 *   apply-resolution (scratch) → seal evidence (+ conflict-resolution item) → reclassify →
 *   ResolutionResult{ newHeadSha, lane, outsideHunks, blamedUpstream, resolutionRef }
 */
import { reclassifyAfterResolution } from "@app/classifier";
import { type ChangeDiff, diffStatsOf, type LaneReason } from "@app/domain";
import type { CommandOf, CoreEventInput } from "@app/merge-queue";
import type { MergeAttempt as MergeAttemptDoc } from "@app/resolver";
import {
  ApplyResolutionDoc,
  applyFailed,
  MergeAttempt,
  RESOLVER_PRINCIPAL_ID,
  type ResolutionOutcome,
  type ResolverInput,
} from "@app/resolver";
import { sealEvidence } from "../evidence.js";
import { changeSubject } from "../ids.js";
import type { QueueContext } from "./context.js";
import type { ReplaySpec } from "./jobs.js";

type Emit = (event: CoreEventInput) => Promise<void>;
type Outcome = Extract<CoreEventInput, { type: "ResolutionResult" }>["outcome"];

/** Unified diff text of a stored ChangeDiff (what the resolver reads). */
export function diffText(diff: ChangeDiff | null): string {
  if (diff === null) return "";
  const out: string[] = [];
  for (const f of diff.files) {
    out.push(`diff --git a/${f.previousPath ?? f.path} b/${f.path}`);
    out.push(`--- ${f.status === "added" ? "/dev/null" : `a/${f.previousPath ?? f.path}`}`);
    out.push(`+++ ${f.status === "deleted" ? "/dev/null" : `b/${f.path}`}`);
    for (const h of f.hunks) {
      out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
      for (const l of h.lines)
        out.push(`${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`);
    }
  }
  return out.join("\n");
}

function failed(message: string): Outcome {
  return { status: "failed", message: message.slice(0, 2000) };
}

/** The resolver's ejection, in the core's terms (the core decides retry vs eject). */
function fromEjection(o: Extract<ResolutionOutcome, { status: "ejected" }>): Outcome {
  const message = o.eject.message.slice(0, 2000);
  if (o.eject.cause === "budget-exceeded") return { status: "budget-exhausted", message };
  if (o.eject.cause === "not-a-conflict") return { status: "not-a-conflict", message };
  return { status: "failed", message };
}

export async function resolutionHandler(
  ctx: QueueContext,
  cmd: CommandOf<"RequestResolution">,
  emit: Emit,
): Promise<void> {
  const report = (outcome: Outcome) =>
    emit({
      type: "ResolutionResult",
      changeId: cmd.changeId,
      attempt: cmd.attempt,
      resolverId: RESOLVER_PRINCIPAL_ID,
      outcome,
    });
  if (cmd.excludePrincipals.includes(RESOLVER_PRINCIPAL_ID))
    return report(failed("the resolver is excluded for this Change"));
  const factory = ctx.deps.resolver;
  if (factory === undefined) return report(failed("no resolver is configured on this platform"));

  const repo = await ctx.repo();
  const change = await ctx.change(cmd.changeId);
  const state = ctx.deps.state();
  const spec = await ctx.replaySpec(cmd.changeId, cmd.headSha);
  const preceding: ReplaySpec[] = [];
  for (const id of cmd.preceding) {
    const head = state.entries[id]?.headSha;
    if (head !== undefined) preceding.push(await ctx.replaySpec(id, head));
  }
  await ctx.deps.jobs.ensureScratch({ mainRepo: repo.artifactsName, scratch: ctx.scratch });
  const prepared = await ctx.deps.jobs.mergeAttempt({
    scratch: ctx.scratch,
    baseRepo: repo.artifactsName,
    ontoSha: cmd.ontoSha,
    preceding,
    change: spec,
    ref: `refs/heads/mq/res/${cmd.changeId}-${cmd.attempt}`,
  });
  const merge = MergeAttempt.parse(prepared.doc);
  if (merge.status === "error") throw new Error(`merge-attempt: ${merge.note}`);
  const onto = prepared.ontoSha;
  if (cmd.kind === "textual" && merge.status === "clean") {
    // Upstream moved since the conflict: the Change replays cleanly now (nothing to resolve).
    ctx.deps.store.putHead(cmd.changeId, merge.newSha, { replayBase: onto, repo: ctx.scratch });
    return report({
      status: "resolved",
      newHeadSha: merge.newSha,
      lane: (change.lane ?? 2) as 0 | 1 | 2,
      laneReasons: [],
      outsideHunks: false,
      blamedUpstream: null,
      resolutionRef: "none:clean-replay",
      affected: null,
    });
  }
  return resolveAndApply(
    ctx,
    cmd,
    { change, merge, onto, factoryModel: repo.policy.ai.reviewerModel },
    report,
  );
}

async function resolveAndApply(
  ctx: QueueContext,
  cmd: CommandOf<"RequestResolution">,
  input: {
    change: Awaited<ReturnType<QueueContext["change"]>>;
    merge: Exclude<MergeAttemptDoc, { status: "error" }>;
    onto: string;
    factoryModel: string;
  },
  report: (o: Outcome) => Promise<void>,
): Promise<void> {
  const { store } = ctx.ports;
  const { change, merge, onto } = input;
  const repo = await ctx.repo();
  const [plan, diff] = await Promise.all([
    change.planId === null ? null : store.getPlan(change.planId),
    change.headSha === null ? null : store.getDiff(change.id, change.headSha),
  ]);
  const upstream: ResolverInput["upstream"][number][] = [];
  for (const id of cmd.upstream.slice(0, 10)) {
    const u = await store.getChange(id);
    if (u === null) continue;
    const [uPlan, uDiff] = await Promise.all([
      u.planId === null ? null : store.getPlan(u.planId),
      u.headSha === null ? null : store.getDiff(u.id, u.headSha),
    ]);
    upstream.push({
      changeId: u.id,
      sha: u.mergedSha ?? u.headSha ?? merge.onto,
      title: u.title,
      plan: uPlan,
      diff: diffText(uDiff),
    });
  }
  const coordinator = ctx.deps.bindings.changeCoordinator(change.id);
  const spentUsd = await coordinator.spent(change.id).catch(() => 0);
  const resolverInput: ResolverInput = {
    // Only id, title and SHAs: never the author's summary, claim or trace.
    change: { id: change.id, title: change.title, baseSha: merge.base, headSha: cmd.headSha },
    plan,
    diff: diffText(diff),
    upstream,
    merge,
    ...(cmd.kind === "semantic"
      ? {
          semantic: {
            failingTests: cmd.failingTests.map((id) => ({ id })),
            candidates: cmd.upstream,
          },
        }
      : {}),
    budget: { changeId: change.id, limitUsd: repo.policy.ai.budgetUsdPerChange, spentUsd },
    excludePrincipals: cmd.excludePrincipals,
  };
  const resolver = ctx.deps.resolver?.(input.factoryModel);
  if (resolver === undefined) return report(failed("no resolver is configured on this platform"));
  let outcome = await resolver.resolve(resolverInput);
  await coordinator.recordSpend({ changeId: change.id, usd: outcome.costUsd }).catch(() => 0);
  let newHead: string | null = null;
  if (outcome.status === "resolved") {
    const applied = ApplyResolutionDoc.parse(
      await ctx.deps.jobs.applyResolution({
        scratch: ctx.scratch,
        patch: outcome.patch,
        onto: outcome.applyOnto,
        ref: `refs/heads/mq/res/${cmd.changeId}-${cmd.attempt}-resolved`,
      }),
    );
    if (applied.status === "resolved") newHead = applied.newSha;
    else outcome = applyFailed(outcome, resolverInput, applied.note);
  }
  await ctx.audit(changeSubject(change.id), "merge-queue.resolution", {
    attempt: cmd.attempt,
    kind: cmd.kind,
    status: outcome.status,
    resolverId: RESOLVER_PRINCIPAL_ID,
    model: input.factoryModel,
    costUsd: outcome.costUsd,
    upstream: cmd.upstream,
    newHead,
    ...(outcome.status === "ejected"
      ? { eject: outcome.eject.code, cause: outcome.eject.cause }
      : {}),
  });
  if (outcome.status === "ejected" || newHead === null)
    return report(outcome.status === "ejected" ? fromEjection(outcome) : failed("not applied"));
  // The resolved head lives in the scratch repo and replays from P (onto + preceding).
  ctx.deps.store.putHead(change.id, newHead, { replayBase: onto, repo: ctx.scratch });
  await report(await reEvidence(ctx, cmd, change, outcome, newHead, onto, diff));
}

/**
 * Seal the resolved head's evidence (the Change's items + the conflict-resolution item) and
 * reclassify on it. Approval binding: a within-hunk resolution with zero novel lines keeps the
 * approval; novel lines (Lane ≥ 1), outside-hunk edits or a semantic fix invalidate it. The
 * protocol has one flag for "needs a fresh approval" (`outsideHunks`), so a novel-line
 * resolution of a Lane ≥ 1 Change reports it as well (conservative: it only adds a review).
 */
async function reEvidence(
  ctx: QueueContext,
  cmd: CommandOf<"RequestResolution">,
  change: Awaited<ReturnType<QueueContext["change"]>>,
  outcome: Extract<ResolutionOutcome, { status: "resolved" }>,
  newHead: string,
  onto: string,
  diff: ChangeDiff | null,
): Promise<Outcome> {
  const { store } = ctx.ports;
  const repo = await ctx.repo();
  const original =
    (await store.getEvidence(change.id, cmd.headSha)) ??
    (change.headSha === null ? null : await store.getEvidence(change.id, change.headSha));
  const items = [
    ...(original?.items ?? []).filter((i) => i.kind !== "conflict-resolution"),
    outcome.evidence,
  ];
  const sealed = await sealEvidence(ctx.ports, {
    changeId: change.id,
    headSha: newHead,
    baseSha: onto,
    items,
  });
  const previous =
    (await store.getClassification(change.id, cmd.headSha)) ??
    (change.headSha === null ? null : await store.getClassification(change.id, change.headSha));
  const plan = change.planId === null ? null : await store.getPlan(change.planId);
  const context = {
    ciStatus: "passed" as const,
    evidenceVerified: sealed.verified,
    budgetExceeded: outcome.budgetExceeded,
    tourStatus: change.tourId === null ? ("not-generated" as const) : ("ok" as const),
    pureRevertVerified: false,
  };
  const evidence = { items };
  const stats = diff === null ? null : diffStatsOf(diff);
  const cls =
    previous === null
      ? null
      : reclassifyAfterResolution(
          previous,
          evidence,
          repo.policy,
          plan,
          stats,
          { category: change.claim.category },
          context,
        );
  if (cls !== null) await store.putClassification(change.id, newHead, cls);
  const lane = Math.max(cls?.lane ?? 2, change.lane ?? 0) as 0 | 1 | 2;
  const outside = outcome.scope.touchesOutsideConflictHunks || cmd.kind === "semantic";
  const novel = outcome.scope.novelLines > 0;
  const reasons: LaneReason[] = (cls?.reasons ?? []).filter((r) => r.lane > 0);
  if (novel && lane >= 1 && !outside)
    reasons.push({
      code: "merge-queue.resolution-novel-lines",
      lane: 1,
      message: `The conflict resolution wrote ${outcome.scope.novelLines} line(s) found on neither side: the earlier approval no longer covers what lands.`,
    });
  return {
    status: "resolved",
    newHeadSha: newHead,
    lane,
    laneReasons: reasons,
    outsideHunks: outside || (novel && lane >= 1),
    blamedUpstream: cmd.kind === "semantic" ? outcome.semanticConflictWith : null,
    resolutionRef: sealed.evidenceId,
    affected: null,
  };
}
