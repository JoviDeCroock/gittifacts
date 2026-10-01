/**
 * The ChangeWorkflow body: steps 1–11 of the change lifecycle (docs/architecture.md). One
 * instance per (change, head) with id `${changeId}-${head[0..12]}`.
 *
 *  load → diff → policy (BASE) → plan-ci → ci-start ⇢ ci-finished → ci-outcome → evidence →
 *  judge → evidence-note → verify-revert → classify → tour → reclassify → route →
 *  (enqueue | request-review ⇢ review) ⇢ merged → rollout
 *
 * Every external call is its own `step.do` (idempotent, retried per RETRY). Code between steps is
 * deterministic: it only uses step results, so a replay takes the same path. Node-safe; the
 * WorkflowEntrypoint wrapper lives in change-workflow.ts.
 */
import { type ClassifyResult, classify, type TourStatus } from "@app/classifier";
import {
  type ClaimedCategory,
  diffStatsOf,
  type Lane,
  type PipelineRun,
  type RepoPolicy,
  type RolloutState,
  Tour,
} from "@app/domain";
import { EVIDENCE_NOTES_REF, type EvidenceItem, encodeNote, type Screenshots } from "@app/evidence";
import { type CoordinatorBindings, createOrGet } from "./bindings.js";
import {
  ChangeWorkflowParams,
  CiFinishedEvent,
  EVENT_CI_FINISHED,
  EVENT_MERGED,
  EVENT_REVIEW,
  MergedEvent,
  ReviewEvent,
  type RolloutParams,
} from "./events.js";
import {
  assembleEvidence,
  erroredJudgment,
  judgmentItems,
  previewItem,
  type SealedEvidence,
  sealEvidence,
} from "./evidence.js";
import { changeSubject, ciRunIdFor, isBootstrapChange, rolloutWorkflowId } from "./ids.js";
import { PUSHABLE_STATUSES, toCiStatus } from "./lifecycle.js";
import { withChangeNotifications } from "./milestones.js";
import {
  errorMessage,
  escalateForPolicy,
  type ResolvedPolicy,
  resolvePolicy,
  unavailablePolicy,
} from "./policy.js";
import {
  type CiRunRequest,
  type CiRunStatus,
  type Ports,
  type PreviewOutcome,
  SYSTEM_PRINCIPAL_ID,
} from "./ports.js";
import { verifyPureRevert } from "./revert.js";
import { toPipelineRun } from "./run-sink.js";
import { RETRY, type Step, waitOrTimeout } from "./step.js";

export interface FlowDeps {
  ports: Ports;
  bindings: CoordinatorBindings;
}

export type ChangeOutcome =
  | "skipped"
  | "bootstrapped"
  | "blocked"
  | "changes-requested"
  | "rejected"
  | "review-expired"
  | "merge-failed"
  | "merge-wait-expired"
  | "merged";

export interface ChangeWorkflowOutput {
  outcome: ChangeOutcome;
  lane: Lane | null;
  detail: string | null;
  rollout: "started" | "skipped" | "none" | null;
}

/** How long CI may take before the workflow asks the engine directly. */
export const CI_TIMEOUT = "3 hours";
/** Container-minute budget for one full run. */
export const CI_BUDGET_MINUTES = 90;
export const REVIEW_TIMEOUT = "7 days";
/** Reminders before a review request expires (4 × 7 days). */
export const REVIEW_ROUNDS = 4;
/** The workflow wakes this often while queued to re-read the change (conflicts are seen here). */
export const MERGE_POLL = "30 minutes";
export const MERGE_ROUNDS = 7 * 48;

interface Loaded {
  skip: string | null;
  repoId: string;
  mainRepo: string;
  defaultBranch: string;
  forkName: string;
  baseSha: string;
  planId: string | null;
  category: ClaimedCategory;
  revertOf: string | null;
  agentTraceId: string | null;
  title: string;
  /** Unclaimed projects never auto-merge and never deploy to production. */
  claimed: boolean;
  /** The repo's bootstrap Change: CI + evidence + preview, then released (no lane, no review). */
  bootstrap: boolean;
}

const SKIPPED: Omit<Loaded, "skip"> = {
  repoId: "",
  mainRepo: "",
  defaultBranch: "",
  forkName: "",
  baseSha: "",
  planId: null,
  category: "chore",
  revertOf: null,
  agentTraceId: null,
  title: "",
  claimed: false,
  bootstrap: false,
};

interface Classified {
  lane: Lane;
  computedLane: Lane;
  shadow: boolean;
  blocked: boolean;
  requiresHumanApproval: boolean;
}

function placeholderRun(runId: string, changeId: string, headSha: string, at: string): PipelineRun {
  return {
    id: runId,
    changeId,
    headSha,
    engine: "workflows",
    status: "errored",
    startedAt: null,
    finishedAt: at,
    steps: [],
  };
}

export async function runChangeWorkflow(
  deps: FlowDeps,
  rawParams: ChangeWorkflowParams,
  step: Step,
  instanceId: string,
): Promise<ChangeWorkflowOutput> {
  const { bindings } = deps;
  // Every change-row update also wakes `wait_for_change` long-polls on the change's DO.
  const ports = withChangeNotifications(deps.ports, bindings);
  const { store, git, audit, notifier, clock } = ports;
  const params = ChangeWorkflowParams.parse(rawParams);
  const { changeId, headSha } = params;
  const subject = changeSubject(changeId);
  const done = (
    outcome: ChangeOutcome,
    lane: Lane | null,
    detail: string | null = null,
  ): ChangeWorkflowOutput => ({
    outcome,
    lane,
    detail,
    rollout: null,
  });
  const log = (action: string, payload: unknown) =>
    audit.append({ principalId: SYSTEM_PRINCIPAL_ID, action, subject, payload });

  // ------------------------------------------------------------ load
  const ctx = await step.do("load", RETRY.quick, async (): Promise<Loaded> => {
    const change = await store.getChange(changeId);
    if (change === null) return { ...SKIPPED, skip: "change not found" };
    if (change.headSha !== headSha)
      return { ...SKIPPED, skip: `superseded by ${change.headSha ?? "nothing"}` };
    if (!PUSHABLE_STATUSES.includes(change.status))
      return { ...SKIPPED, skip: `change is ${change.status}` };
    const repo = await store.getRepo(change.repoId);
    if (repo === null) return { ...SKIPPED, skip: "repo not found" };
    if (change.status !== "running") await store.updateChange(changeId, { status: "running" });
    await log("change.pipeline-started", { headSha, instanceId });
    return {
      skip: null,
      repoId: repo.id,
      mainRepo: repo.artifactsName,
      defaultBranch: repo.defaultBranch,
      forkName: change.forkName,
      baseSha: change.baseSha,
      planId: change.planId,
      category: change.claim.category,
      revertOf: change.revertOf,
      agentTraceId: change.agentTraceId,
      title: change.title,
      claimed: repo.claim.status === "claimed",
      bootstrap: isBootstrapChange(change),
    };
  });
  if (ctx.skip !== null) return done("skipped", null, ctx.skip);
  const { baseSha, forkName, repoId } = ctx;

  // ------------------------------------------------------------ 1. diff
  await step.do("diff", RETRY.remote, async () => {
    const diff = await git.diff(forkName, baseSha, headSha);
    await store.putDiff(changeId, diff);
    return { files: diff.files.length, additions: diff.additions, deletions: diff.deletions };
  });

  // ------------------------------------------------------------ 2. policy from BASE
  let resolved: ResolvedPolicy;
  try {
    resolved = await step.do("policy", RETRY.sandbox, async () => {
      const repo = await store.getRepo(repoId);
      if (repo === null) throw new Error(`repo ${repoId} not found`);
      return resolvePolicy(ports, {
        repo,
        repoName: ctx.mainRepo,
        sha: baseSha,
        onSandboxError: "throw",
      });
    });
  } catch (e) {
    const reason = errorMessage(e);
    resolved = await step.do("policy-unavailable", RETRY.quick, async () => {
      const repo = await store.getRepo(repoId);
      await log("change.policy-unavailable", { baseSha, error: reason });
      return unavailablePolicy(repo, `policy evaluation failed: ${reason}`);
    });
  }
  const policy: RepoPolicy = resolved.policy;

  // ------------------------------------------------------------ 3. plan-ci (sandbox, plan mode, at BASE)
  let pipeline: unknown = null;
  let planWarning: string | null = null;
  try {
    pipeline = (
      await step.do("plan-ci", RETRY.sandbox, async () => ({
        spec: (await ports.sandbox.planPipeline({ repo: forkName, sha: baseSha })) ?? null,
      }))
    ).spec;
  } catch (e) {
    // The engine falls back to detected defaults; missing evidence escalates on its own.
    planWarning = `plan mode failed, using default pipeline: ${errorMessage(e)}`;
  }

  // ------------------------------------------------------------ 4. ci
  const runId = ciRunIdFor(instanceId);
  await step.do("ci-start", RETRY.remote, async () => {
    const request: CiRunRequest = {
      runId,
      changeId,
      repo: { remote: git.remoteOf(forkName), tokenProvider: "artifacts" },
      artifactsRepo: forkName,
      headSha,
      baseSha,
      // The pipeline comes from BASE: a change must not edit the CI that judges it.
      pipelineFrom: "base",
      limits: { maxMinutes: CI_BUDGET_MINUTES },
      // Unclaimed projects: sandbox egress to package registries only (onboarding §4).
      network: ctx.claimed ? "open" : "registries-only",
      // A bootstrap has no diff (base = head): evidence steps would have nothing to measure.
      ...(ctx.bootstrap ? { evidenceSteps: [] } : {}),
    };
    let note = planWarning;
    try {
      await ports.ci.start(pipeline === null ? request : { ...request, pipeline });
    } catch (e) {
      if (pipeline === null) throw e;
      // The engine rejected our planned spec: let it plan from base itself.
      note = `planned pipeline rejected (${errorMessage(e)}); the engine plans it`;
      await ports.ci.start(request);
    }
    // Visible in the API right away; the run sink replaces it when the run finishes.
    if ((await store.getRun(runId)) === null) {
      await store.upsertRun({
        ...placeholderRun(runId, changeId, headSha, clock.now().toISOString()),
        status: "running",
        finishedAt: null,
      });
    }
    await bindings.changeCoordinator(changeId).registerRun({ changeId, instanceId, runId });
    await log("change.ci-started", { runId, headSha, note });
    return { runId };
  });

  const finished = await waitOrTimeout<unknown>(
    step,
    EVENT_CI_FINISHED,
    EVENT_CI_FINISHED,
    CI_TIMEOUT,
  );
  let report: CiFinishedEvent;
  const parsedReport = finished === null ? null : CiFinishedEvent.safeParse(finished.payload);
  if (parsedReport?.success && parsedReport.data.run.id === runId) {
    report = parsedReport.data;
  } else {
    // Timed out or malformed: ask the engine. A run we cannot account for is "errored" (unknown),
    // and without its summary the evidence is missing (which escalates).
    report = await step.do("ci-status", RETRY.remote, async (): Promise<CiFinishedEvent> => {
      const at = clock.now().toISOString();
      let latest: CiRunStatus | null = null;
      try {
        latest = await ports.ci.status(runId);
      } catch {
        latest = null;
      }
      const lost = [{ step: "*", message: "the run's evidence never reached the coordinator" }];
      if (latest !== null && latest.status !== "queued" && latest.status !== "running") {
        return {
          run: toPipelineRun(latest),
          items: [],
          evidenceErrors: lost,
          outputs: { bundleRef: null, snapshots: {} },
        };
      }
      try {
        await ports.ci.cancel(runId, "no result within the CI timeout");
      } catch {
        // best effort
      }
      const run =
        latest === null
          ? placeholderRun(runId, changeId, headSha, at)
          : { ...toPipelineRun(latest), status: "errored" as const, finishedAt: at };
      return { run, items: [], evidenceErrors: lost, outputs: { bundleRef: null, snapshots: {} } };
    });
  }
  const ciStatus = toCiStatus(report.run.status);

  await step.do("ci-outcome", RETRY.quick, async () => {
    await store.upsertRun(report.run);
    if (ciStatus === "failed") {
      await store.updateChange(changeId, { status: "failing" });
      await notifier.notify({
        kind: "failing",
        changeId,
        repoId,
        message: `CI failed for ${ctx.title} at ${headSha.slice(0, 12)}.`,
      });
    }
    await log(ciStatus === "passed" ? "change.ci-passed" : "change.ci-failed", {
      runId,
      status: report.run.status,
      items: report.items.length,
      evidenceErrors: report.evidenceErrors,
    });
    return ciStatus;
  });

  // ------------------------------------------------------------ 4b. preview (Worker-side, informational)
  // Started from the CI build snapshot and served through the preview gateway. Before the
  // evidence is sealed, so `evidence_ready` means "CI finished and the preview answers".
  const previews = ports.previews;
  let preview: PreviewOutcome | null = null;
  if (previews !== undefined) {
    if (ciStatus !== "passed") {
      preview = {
        status: "skipped",
        url: null,
        reason: "CI did not pass, so there is no build to preview (informational)",
      };
    } else {
      try {
        preview = await step.do("preview", RETRY.preview, async (): Promise<PreviewOutcome> => {
          const repo = await store.getRepo(repoId);
          const out = await previews.start({
            changeId,
            repoId,
            artifactsRepo: forkName,
            headSha,
            snapshots: report.outputs.snapshots,
            claimed: ctx.claimed,
            template: repo?.template ?? null,
          });
          await log("change.preview", out);
          return out;
        });
      } catch (e) {
        preview = {
          status: "error",
          url: null,
          reason: `the preview did not start: ${errorMessage(e)}`,
        };
      }
    }
  }

  // ------------------------------------------------------------ 5. evidence (CI + Worker items, signed)
  let sealed: SealedEvidence = await step.do("evidence", RETRY.quick, async () => {
    const diff = await store.getDiff(changeId, headSha);
    const { items, dropped } = assembleEvidence({
      ciItems: report.items,
      diff,
      policy,
      agentTraceId: ctx.agentTraceId,
      workerItems: preview === null ? [] : [previewItem(preview)],
    });
    const out = await sealEvidence(ports, { changeId, headSha, baseSha, items });
    await log("change.evidence-signed", { ...out, dropped });
    return out;
  });

  // ------------------------------------------------------------ bootstrap: time-to-first-green
  const onboarding = ports.onboarding;
  if (ctx.bootstrap && onboarding !== undefined) {
    try {
      await step.do("onboarding", RETRY.quick, async () => {
        await onboarding.bootstrapReady({
          repoId,
          changeId,
          ciStatus,
          evidenceAt: clock.now().toISOString(),
          preview,
        });
        return true;
      });
    } catch {
      // Metrics are best effort.
    }
  }

  // ------------------------------------------------------------ 5b. screenshots of the preview
  const resealWith = async (item: EvidenceItem): Promise<SealedEvidence> => {
    const current = await store.getEvidence(changeId, headSha);
    if (current === null) throw new Error("evidence disappeared");
    const keep = current.items.filter((i) => i.kind !== item.kind);
    return sealEvidence(ports, { changeId, headSha, baseSha, items: [...keep, item] });
  };
  if (previews !== undefined && preview?.status === "ready") {
    const url = preview.url;
    try {
      sealed = await step.do("screenshots", RETRY.preview, async () => {
        const [repo, plan] = await Promise.all([
          store.getRepo(repoId),
          ctx.planId === null ? null : store.getPlan(ctx.planId),
        ]);
        const routes = [...new Set([...policy.previewRoutes, ...(plan?.affectedRoutes ?? [])])];
        const shots = await previews.screenshots({
          changeId,
          headSha,
          url,
          routes,
          template: repo?.template ?? null,
        });
        const out = await resealWith(shots);
        await log("change.screenshots", { status: shots.status, shots: shots.shots.length });
        return out;
      });
    } catch (e) {
      const reason = errorMessage(e);
      sealed = await step.do("screenshots-failed", RETRY.quick, async () => {
        const failed: Screenshots = {
          id: "screenshots",
          kind: "screenshots",
          status: "error",
          note: `screenshots failed: ${reason}`.slice(0, 4000),
          shots: [],
        };
        await log("change.screenshots-failed", { error: reason });
        return resealWith(failed);
      });
    }
  }

  // ------------------------------------------------------------ bootstrap: released, never routed
  if (ctx.bootstrap) {
    // No judge (no diff), no note (the main repo is only written by the merge queue), no lane.
    const released = await step.do("bootstrap-done", RETRY.quick, async () => {
      const green = ciStatus === "passed";
      if (green) await store.updateChange(changeId, { status: "released", mergedSha: headSha });
      await log(green ? "change.bootstrap-released" : "change.bootstrap-failed", {
        headSha,
        ciStatus,
        evidenceId: sealed.evidenceId,
      });
      return green;
    });
    return done(released ? "bootstrapped" : "blocked", null, released ? null : "ci failed");
  }

  // ------------------------------------------------------------ 6. judge (raise-only, within budget)
  const coordinator = bindings.changeCoordinator(changeId);
  const limitUsd = policy.ai.budgetUsdPerChange;
  let budgetExceeded = false;
  const reseal = async (extra: EvidenceItem[]): Promise<SealedEvidence> => {
    const current = await store.getEvidence(changeId, headSha);
    if (current === null) throw new Error("evidence disappeared");
    const keep = current.items.filter((i) => i.kind !== "llm-judgment");
    return sealEvidence(ports, { changeId, headSha, baseSha, items: [...keep, ...extra] });
  };
  try {
    const judged = await step.do("judge", RETRY.model, async () => {
      const spentUsd = await coordinator.spent(changeId);
      if (spentUsd >= limitUsd) {
        return { sealed: null, budgetExceeded: true, costUsd: 0, judgments: 0 };
      }
      const [plan, diff] = await Promise.all([
        ctx.planId === null ? null : store.getPlan(ctx.planId),
        store.getDiff(changeId, headSha),
      ]);
      if (diff === null) throw new Error("diff missing");
      const out = await ports.reviewer.judge({
        plan,
        diff,
        budget: { changeId, limitUsd, spentUsd },
        model: policy.ai.reviewerModel,
      });
      const total = await coordinator.recordSpend({ changeId, usd: out.costUsd });
      const items = judgmentItems(out.items);
      const resealed = items.length > 0 ? await reseal(items) : null;
      await log("change.judged", {
        judgments: items.length,
        costUsd: out.costUsd,
        totalUsd: total,
      });
      return {
        sealed: resealed,
        budgetExceeded: out.budgetExceeded || total > limitUsd,
        costUsd: out.costUsd,
        judgments: items.length,
      };
    });
    if (judged.sealed !== null) sealed = judged.sealed;
    budgetExceeded = judged.budgetExceeded;
  } catch (e) {
    const reason = errorMessage(e);
    sealed = await step.do("judge-failed", RETRY.quick, async () => {
      const out = await reseal([erroredJudgment(`judge failed: ${reason}`)]);
      await log("change.judge-failed", { error: reason });
      return out;
    });
  }

  // ------------------------------------------------------------ evidence note on the fork
  try {
    await step.do("evidence-note", RETRY.remote, async () => {
      const evidence = await store.getEvidence(changeId, headSha);
      if (evidence === null) throw new Error("evidence missing");
      await git.writeNote(forkName, headSha, encodeNote(evidence), {
        notesRef: EVIDENCE_NOTES_REF,
        mode: "replace",
      });
      await store.putEvidence({ ...evidence, notesWritten: true });
      return true;
    });
  } catch (e) {
    const reason = errorMessage(e);
    await step.do("evidence-note-failed", RETRY.quick, async () => {
      await log("change.evidence-note-failed", { error: reason });
      return true;
    });
  }

  // ------------------------------------------------------------ pure revert? (platform-verified)
  let pureRevertVerified = false;
  if (ctx.revertOf !== null && ctx.category === "revert") {
    const revertOf = ctx.revertOf;
    try {
      pureRevertVerified = await step.do("verify-revert", RETRY.remote, async () => {
        const original = await store.getChange(revertOf);
        if (original?.mergedSha == null || original.repoId !== repoId) return false;
        const ok = await verifyPureRevert(git, {
          repo: forkName,
          baseSha,
          headSha,
          mergedSha: original.mergedSha,
        });
        await log("change.revert-verified", {
          revertOf,
          mergedSha: original.mergedSha,
          pureRevertVerified: ok,
        });
        return ok;
      });
    } catch {
      pureRevertVerified = false; // unknown is not verified
    }
  }

  // ------------------------------------------------------------ 7. classify (pure)
  const classifyStep = (
    name: string,
    tourStatus: TourStatus,
    overBudget: boolean,
    verified: boolean,
  ) =>
    step.do(name, RETRY.quick, async (): Promise<Classified> => {
      const [evidence, diff, plan] = await Promise.all([
        store.getEvidence(changeId, headSha),
        store.getDiff(changeId, headSha),
        ctx.planId === null ? null : store.getPlan(ctx.planId),
      ]);
      const raw: ClassifyResult = classify(
        evidence === null ? null : { items: evidence.items },
        policy,
        plan,
        diff === null ? null : diffStatsOf(diff),
        { category: ctx.category },
        {
          ciStatus,
          evidenceVerified: verified,
          budgetExceeded: overBudget,
          tourStatus,
          pureRevertVerified,
        },
      );
      const result = escalateForPolicy(raw, resolved);
      await store.putClassification(changeId, headSha, result);
      await store.updateChange(changeId, {
        computedLane: result.computedLane,
        lane: result.lane,
        laneReasons: result.reasons,
      });
      await log("change.classified", {
        headSha,
        lane: result.lane,
        computedLane: result.computedLane,
        shadow: result.shadow,
        blocked: result.blocked,
        requiresHumanApproval: result.requiresHumanApproval,
        tourStatus,
        budgetExceeded: overBudget,
        pureRevertVerified,
        policy: resolved.source,
        reasons: result.reasons.filter((r) => r.lane > 0).map((r) => r.code),
      });
      return {
        lane: result.lane,
        computedLane: result.computedLane,
        shadow: result.shadow,
        blocked: result.blocked,
        requiresHumanApproval: result.requiresHumanApproval,
      };
    });
  let cls = await classifyStep("classify", "not-generated", budgetExceeded, sealed.verified);

  // ------------------------------------------------------------ 8. tour (lane ≥ 1, and shadowed lane 0)
  if (!cls.blocked && (cls.lane >= 1 || cls.shadow)) {
    let tour: { status: "ok" | "failed"; reason: string | null; budgetExceeded: boolean };
    try {
      tour = await step.do("tour", RETRY.model, async () => {
        const spentUsd = await coordinator.spent(changeId);
        if (spentUsd >= limitUsd)
          return { status: "failed" as const, reason: "AI budget exhausted", budgetExceeded: true };
        const [change, plan, diff, evidence, classification] = await Promise.all([
          store.getChange(changeId),
          ctx.planId === null ? null : store.getPlan(ctx.planId),
          store.getDiff(changeId, headSha),
          store.getEvidence(changeId, headSha),
          store.getClassification(changeId, headSha),
        ]);
        if (change === null || diff === null || evidence === null || classification === null) {
          throw new Error("tour inputs missing");
        }
        // The reviewer agent never sees the author's own summary: only id/title/shas.
        const out = await ports.reviewer.tour({
          change: { id: change.id, title: change.title, headSha, baseSha },
          plan,
          diff,
          evidence,
          classification,
          budget: { changeId, limitUsd, spentUsd },
          model: policy.ai.reviewerModel,
        });
        const total = await coordinator.recordSpend({ changeId, usd: out.costUsd });
        const overBudget = out.budgetExceeded || total > limitUsd;
        if (out.status === "failed") {
          await log("change.tour-failed", { reason: out.reason, costUsd: out.costUsd });
          return { status: "failed" as const, reason: out.reason, budgetExceeded: overBudget };
        }
        const valid = Tour.safeParse(out.tour);
        if (!valid.success || valid.data.changeId !== changeId || valid.data.headSha !== headSha) {
          await log("change.tour-failed", {
            reason: "tour failed schema validation or is for another head",
          });
          return { status: "failed" as const, reason: "invalid tour", budgetExceeded: overBudget };
        }
        await store.putTour(valid.data);
        await store.updateChange(changeId, { tourId: valid.data.id });
        await log("change.tour-generated", {
          tourId: valid.data.id,
          stops: valid.data.stops.length,
          costUsd: out.costUsd,
        });
        return { status: "ok" as const, reason: null, budgetExceeded: overBudget };
      });
    } catch (e) {
      tour = { status: "failed", reason: errorMessage(e), budgetExceeded: false };
    }
    budgetExceeded = budgetExceeded || tour.budgetExceeded;
    // Tour failure → reclassify (Lane 2); success is recorded too so the reasons say "generated".
    cls = await classifyStep("reclassify", tour.status, budgetExceeded, sealed.verified);
  }
  if (budgetExceeded) {
    await step.do("budget-exceeded", RETRY.quick, async () => {
      await notifier.notify({
        kind: "budget-exceeded",
        changeId,
        repoId,
        message: `The AI budget ($${limitUsd.toFixed(2)}) for ${ctx.title} was exceeded; it needs a full human review.`,
      });
      await log("change.budget-exceeded", { limitUsd });
      return true;
    });
  }

  // ------------------------------------------------------------ 9. route
  if (cls.blocked) {
    await step.do("blocked", RETRY.quick, async () => {
      await store.updateChange(changeId, { status: "failing" });
      if (ciStatus !== "failed") {
        await notifier.notify({
          kind: "failing",
          changeId,
          repoId,
          message: `${ctx.title} cannot merge: the evidence attestation did not verify.`,
        });
      }
      await log("change.blocked", { ciStatus, evidenceVerified: sealed.verified });
      return true;
    });
    return done("blocked", cls.lane, ciStatus === "failed" ? "ci failed" : "evidence unverified");
  }

  const enqueue = (
    name: string,
    via: "lane-0" | "verified-revert" | "review",
    reviewId: string | null,
  ) =>
    step.do(name, RETRY.quick, async () => {
      // Queued before the RPC: the queue may merge (and set "merged") before this step returns.
      await store.updateChange(changeId, { status: "queued" });
      const { position } = await bindings
        .mergeQueue(repoId)
        .enqueue({ repoId, changeId, headSha, workflowInstanceId: instanceId });
      await log("change.queued", { via, reviewId, position, lane: cls.lane });
      return position;
    });

  // Unclaimed projects never auto-merge (their policy already has Lane 0 and revert auto-merge off;
  // this is the belt to that pair of braces).
  const autoMerge =
    ctx.claimed &&
    !cls.requiresHumanApproval &&
    (cls.lane === 0 || (pureRevertVerified && policy.autoMergeVerifiedReverts));
  if (autoMerge) {
    await enqueue("enqueue", cls.lane === 0 ? "lane-0" : "verified-revert", null);
  } else {
    await step.do("request-review", RETRY.quick, async () => {
      await store.updateChange(changeId, { status: "awaiting-review" });
      await notifier.notify({
        kind: "review-requested",
        changeId,
        repoId,
        message: `${ctx.title} is Lane ${cls.lane}${cls.shadow ? " (Lane 0 in shadow mode)" : ""} and needs a review.`,
      });
      await log("change.review-requested", { lane: cls.lane, shadow: cls.shadow });
      return true;
    });
    let review: ReviewEvent | null = null;
    let waits = 0;
    for (let round = 1; review === null && round <= REVIEW_ROUNDS && waits < REVIEW_ROUNDS + 50; ) {
      waits++;
      const event = await waitOrTimeout<unknown>(
        step,
        `review-${waits}`,
        EVENT_REVIEW,
        REVIEW_TIMEOUT,
      );
      if (event === null) {
        if (round < REVIEW_ROUNDS) {
          const n = round;
          await step.do(`review-reminder-${n}`, RETRY.quick, async () => {
            await notifier.notify({
              kind: "review-requested",
              changeId,
              repoId,
              message: `Reminder: ${ctx.title} has been waiting ${n * 7} days for a review.`,
            });
            return true;
          });
        }
        round++;
        continue;
      }
      const parsed = ReviewEvent.safeParse(event.payload);
      // Reviews bind to a head; anything else is ignored.
      if (parsed.success && parsed.data.headSha === headSha) review = parsed.data;
    }
    if (review === null) {
      await step.do("review-expired", RETRY.quick, async () => {
        await log("change.review-expired", { days: REVIEW_ROUNDS * 7 });
        return true;
      });
      return done("review-expired", cls.lane);
    }
    const decided = review;
    if (decided.decision === "request-changes") {
      await step.do("changes-requested", RETRY.quick, async () => {
        await store.updateChange(changeId, { status: "awaiting-push" });
        await log("change.changes-requested", {
          reviewId: decided.reviewId,
          reviewerId: decided.reviewerId,
        });
        return true;
      });
      return done("changes-requested", cls.lane);
    }
    if (decided.decision === "reject") {
      await step.do("rejected", RETRY.quick, async () => {
        await store.updateChange(changeId, { status: "rejected" });
        await coordinator.scheduleForkGc({ changeId, forkName, delayMs: 60 * 60_000 });
        await log("change.rejected", {
          reviewId: decided.reviewId,
          reviewerId: decided.reviewerId,
        });
        return true;
      });
      return done("rejected", cls.lane);
    }
    await step.do("approved", RETRY.quick, async () => {
      await store.updateChange(changeId, { status: "approved" });
      await log("change.approved", { reviewId: decided.reviewId, reviewerId: decided.reviewerId });
      return true;
    });
    await enqueue("enqueue", "review", decided.reviewId);
  }

  // ------------------------------------------------------------ 10. merge (MergeQueue → "merged")
  let merged: MergedEvent | null = null;
  let failure: string | null = null;
  for (let round = 1; merged === null && failure === null && round <= MERGE_ROUNDS; round++) {
    const event = await waitOrTimeout<unknown>(step, `merged-${round}`, EVENT_MERGED, MERGE_POLL);
    const parsed = event === null ? null : MergedEvent.safeParse(event.payload);
    if (parsed?.success) {
      merged = parsed.data;
      break;
    }
    // Woke without a merge: the change row is the truth (the queue marks conflicts "failing").
    const status = await step.do(`merge-status-${round}`, RETRY.quick, async () => {
      const change = await store.getChange(changeId);
      return { status: change?.status ?? "missing", mergedSha: change?.mergedSha ?? null };
    });
    if (
      status.mergedSha !== null &&
      (status.status === "merged" || status.status === "rolling-out")
    ) {
      merged = {
        mergedSha: status.mergedSha,
        rebasedFrom: status.mergedSha === headSha ? null : headSha,
        bundleRef: null,
      };
    } else if (status.status !== "queued" && status.status !== "approved") {
      failure = `merge queue gave up: change is ${status.status}`;
    }
  }
  if (merged === null) {
    const detail = failure ?? "no merge result within a week";
    await step.do("merge-failed", RETRY.quick, async () => {
      const change = await store.getChange(changeId);
      if (change?.status === "queued") await store.updateChange(changeId, { status: "failing" });
      await log("change.merge-failed", { detail });
      return true;
    });
    return done(failure === null ? "merge-wait-expired" : "merge-failed", cls.lane, detail);
  }

  // ------------------------------------------------------------ 11. rollout
  const mergedEvent = merged;
  const rollout = await step.do("merged", RETRY.quick, async () => {
    const repo = await store.getRepo(repoId);
    await notifier.notify({
      kind: "merged",
      changeId,
      repoId,
      message: `${ctx.title} merged as ${mergedEvent.mergedSha.slice(0, 12)}${mergedEvent.rebasedFrom ? " (rebased)" : ""}.`,
    });
    if (repo?.deployTarget == null) {
      await store.updateChange(changeId, { status: "released" });
      await log("change.released", {
        mergedSha: mergedEvent.mergedSha,
        reason: "no deploy target",
      });
      return "none" as const;
    }
    if (repo.claim.status !== "claimed") {
      // Previews only: unclaimed projects never get a production deploy.
      await log("rollout.skipped", {
        reason: "unclaimed project (previews only)",
        mergedSha: mergedEvent.mergedSha,
      });
      return "skipped" as const;
    }
    // A rebased merge must deploy a bundle built from the merged sha, never the pre-rebase head.
    const bundleRef =
      mergedEvent.rebasedFrom !== null
        ? mergedEvent.bundleRef
        : (mergedEvent.bundleRef ?? report.outputs.bundleRef);
    if (bundleRef === null) {
      await log("rollout.skipped", {
        reason: "no bundle for the merged sha",
        mergedSha: mergedEvent.mergedSha,
      });
      await notifier.notify({
        kind: "rollout-stage",
        changeId,
        repoId,
        message: `Rollout of ${ctx.title} skipped: the pipeline produced no bundle for ${mergedEvent.mergedSha.slice(0, 12)}.`,
      });
      return "skipped" as const;
    }
    const params: RolloutParams = { changeId, bundleRef, rollout: policy.rollout };
    const { created } = await createOrGet(
      bindings.rolloutWorkflow,
      rolloutWorkflowId(changeId),
      params,
    );
    const pending: RolloutState = {
      status: "pending",
      versionId: null,
      previousVersionId: null,
      stages: policy.rollout.stages.map((percent) => ({
        percent,
        startedAt: null,
        completedAt: null,
      })),
      watchUntil: null,
      flagKey: null,
      lastCheck: null,
    };
    const change = await store.getChange(changeId);
    if (change?.status === "merged") {
      await store.updateChange(changeId, {
        status: "rolling-out",
        rolloutState: change.rolloutState ?? pending,
      });
    }
    await log("change.rollout-started", { mergedSha: mergedEvent.mergedSha, bundleRef, created });
    return "started" as const;
  });
  return { outcome: "merged", lane: cls.lane, detail: mergedEvent.mergedSha, rollout };
}
