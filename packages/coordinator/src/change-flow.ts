/**
 * The ChangeWorkflow body: steps 1–11 of the change lifecycle (docs/architecture.md). One
 * instance per (change, head) with id `${changeId}-${head[0..12]}`.
 *
 *  load → diff → policy (BASE) → plan-ci → ci-start ⇢ ci-finished → ci-outcome → evidence →
 *  verify-revert → revert-tree → judge (skipped for a tree-identical verified revert) →
 *  evidence-note → classify → tour → reclassify → route →
 *  (enqueue | request-review ⇢ review) ⇢ merged → rollout
 *
 * From the CI run to the final classification, the body is `@app/core`'s `gradeChange` (the
 * pipeline GitHub mode runs too); the native steps in between (preview, screenshots, bootstrap,
 * pure-revert checks, git notes) are its hooks. Step names and results are unchanged.
 *
 * Every external call is its own `step.do` (idempotent, retried per RETRY). Code between steps is
 * deterministic: it only uses step results, so a replay takes the same path. Node-safe; the
 * WorkflowEntrypoint wrapper lives in change-workflow.ts.
 */
import {
  type AfterEvidence,
  type EvidenceReport,
  gradeChange,
  type SealedEvidence,
} from "@app/core";
import type {
  ClaimedCategory,
  GithubChangeHost,
  GithubRepoHost,
  Lane,
  PipelineRun,
  RepoPolicy,
  RolloutState,
} from "@app/domain";
import { LANE_LABELS } from "@app/domain/vocabulary";
import { EVIDENCE_NOTES_REF, type EvidenceItem, encodeNote, type Screenshots } from "@app/evidence";
import { type HostAdapter, type LaneVerdict, NATIVE_CAPABILITIES } from "@app/host";
import { type CoordinatorBindings, createOrGet } from "./bindings.js";
import {
  ChangeWorkflowParams,
  CiFinishedEvent,
  EVENT_CI_FINISHED,
  EVENT_MERGED,
  EVENT_REVIEW,
  MergedEvent,
  QueueEjectedEvent,
  ReviewEvent,
  type RolloutParams,
} from "./events.js";
import { previewItem, carryQaRun, sealEvidence } from "./evidence.js";
import { durableStages, persistClassification, persistTour, storeGradeData } from "./grading.js";
import { changeSubject, ciRunIdFor, isBootstrapChange, rolloutWorkflowId } from "./ids.js";
import { PUSHABLE_STATUSES, toCiStatus } from "./lifecycle.js";
import { withChangeNotifications } from "./milestones.js";
import { pipelineShaFor } from "./pipeline-adoption.js";
import { errorMessage, type ResolvedPolicy, resolvePolicy, unavailablePolicy } from "./policy.js";
import {
  type CiRunRequest,
  type CiRunStatus,
  type Ports,
  type PreviewOutcome,
  SYSTEM_PRINCIPAL_ID,
} from "./ports.js";
import { revertTrees, verifyPureRevert } from "./revert.js";
import { toPipelineRun } from "./run-sink.js";
import { RETRY, type Step, waitOrTimeout } from "./step.js";

/** Where non-native changes live: the platform builds a host adapter per change (GitHub mode). */
export interface FlowHosts {
  github?(input: {
    changeId: string;
    repoId: string;
    repo: GithubRepoHost;
    change: GithubChangeHost;
  }): HostAdapter | null;
}

export interface FlowDeps {
  ports: Ports;
  bindings: CoordinatorBindings;
  /** Absent: native only (a GitHub change is then skipped, never graded blind). */
  hosts?: FlowHosts;
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
  | "merged"
  /** Graded and published on a host where the platform doesn't merge (GitHub shadow mode). */
  | "graded";

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
  /** GitHub mode: the repo and pull request (null: a native change). */
  host: { repo: GithubRepoHost; change: GithubChangeHost } | null;
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
  host: null,
};

/** The CI run as grading sees it, plus the full report (preview snapshots, bundle for rollout). */
interface NativeReport extends EvidenceReport {
  report: CiFinishedEvent;
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
      host:
        change.host != null && repo.host != null ? { repo: repo.host, change: change.host } : null,
    };
  });
  if (ctx.skip !== null) return done("skipped", null, ctx.skip);
  const { baseSha, forkName, repoId } = ctx;

  // ------------------------------------------------------------ the host (GitHub mode)
  // Built per run, never inside a step (an adapter is not a step result). A GitHub change with no
  // GitHub host configured is not graded at all: no verdict beats a verdict nobody can publish.
  const host: HostAdapter | null =
    ctx.host == null
      ? null
      : (deps.hosts?.github?.({ changeId, repoId, repo: ctx.host.repo, change: ctx.host.change }) ??
        null);
  if (ctx.host != null && host === null) {
    return done("skipped", null, "GitHub change, but no GitHub host is configured");
  }
  const capabilities = host?.capabilities() ?? NATIVE_CAPABILITIES;
  /** A merged PR graded by the backtest: no GitHub writes, no tour, never up for review. */
  const backtest = ctx.host?.change.backtest === true;

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
  // At BASE, except a Change that adopts the repo's first .platform/ci.ts (pipeline-adoption.ts).
  let pipeline: unknown = null;
  let planWarning: string | null = null;
  try {
    pipeline = (
      await step.do("plan-ci", RETRY.sandbox, async () => {
        const sha = await pipelineShaFor(git, forkName, baseSha, headSha);
        const input = { repo: forkName, sha, cacheScope: ctx.mainRepo };
        return { spec: (await ports.sandbox.planPipeline(input)) ?? null };
      })
    ).spec;
  } catch (e) {
    // The engine falls back to detected defaults; missing evidence escalates on its own.
    planWarning = `plan mode failed, using default pipeline: ${errorMessage(e)}`;
  }

  // ------------------------------------------------------------ 4. ci (the evidence run)
  const runId = ciRunIdFor(instanceId);
  const runCi = async (): Promise<NativeReport> => {
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
        // Unclaimed projects and fork pull requests (untrusted code, spec §3.8): sandbox egress
        // to package registries only (onboarding §4).
        network: ctx.claimed && ctx.host?.change.fork !== true ? "open" : "registries-only",
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
        return {
          run,
          items: [],
          evidenceErrors: lost,
          outputs: { bundleRef: null, snapshots: {} },
        };
      });
    }
    const ciStatus = toCiStatus(report.run.status);

    await step.do("ci-outcome", RETRY.quick, async () => {
      await store.upsertRun(report.run);
      // A backtest's red CI is history, not news: nobody is notified.
      if (ciStatus === "failed" && ctx.host?.change.backtest !== true) {
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
    return { ciStatus, items: report.items, report };
  };

  // ------------------------------------------------------------ 4b. preview (Worker-side, informational)
  // Started from the CI build snapshot and served through the preview gateway. Before the
  // evidence is sealed, so `evidence_ready` means "CI finished and the preview answers".
  // No previews of GitHub repos yet: a preview URL is public and their code may be private.
  const previews = host === null ? ports.previews : undefined;
  let preview: PreviewOutcome | null = null;
  const startPreview = async ({ ciStatus, report }: NativeReport): Promise<EvidenceItem[]> => {
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
    return preview === null ? [] : [previewItem(preview)];
  };

  // ------------------------------------------------------------ after sealing (native steps)
  // Onboarding metrics, screenshots, the bootstrap release and the pure-revert checks.
  let released = false;
  const afterEvidence = async (input: {
    ci: NativeReport;
    sealed: SealedEvidence;
  }): Promise<AfterEvidence> => {
    const { ciStatus } = input.ci;
    let sealed = input.sealed;
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

    // ------------------------------------------------------------ bootstrap: released, never routed
    // Right after sealing, before the screenshots: `evidence_ready` on a bootstrap Change waits
    // for this final status (journey 10: "reached" while the status still said running).
    if (ctx.bootstrap) {
      // No judge (no diff), no note (the main repo is only written by the merge queue), no lane.
      const evidenceId = sealed.evidenceId;
      released = await step.do("bootstrap-done", RETRY.quick, async () => {
        const green = ciStatus === "passed";
        if (green) await store.updateChange(changeId, { status: "released", mergedSha: headSha });
        await log(green ? "change.bootstrap-released" : "change.bootstrap-failed", {
          headSha,
          ciStatus,
          evidenceId,
        });
        return green;
      });
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

    // ------------------------------------------------------------ bootstrap: never routed
    if (ctx.bootstrap) return { stop: true };

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

    // A verified revert whose tree IS the pre-merge tree of the Change it reverts restores a state
    // the platform already merged under review: the LLM judge is skipped for it (and only for it),
    // so a model can't keep the undo of a regression waiting for a human. Anything else is judged.
    let skipJudge: { headTree: string; restoredTree: string; mergedSha: string } | null = null;
    if (pureRevertVerified && ctx.revertOf !== null) {
      const revertOf = ctx.revertOf;
      try {
        skipJudge = await step.do("revert-tree", RETRY.remote, async () => {
          const original = await store.getChange(revertOf);
          if (original?.mergedSha == null) return null;
          const trees = await revertTrees(git, {
            repo: forkName,
            headSha,
            mergedSha: original.mergedSha,
          });
          return trees === null || trees.headTree !== trees.restoredTree
            ? null
            : { ...trees, mergedSha: original.mergedSha };
        });
      } catch {
        skipJudge = null; // unknown: judge as usual
      }
    }
    return {
      sealed,
      pureRevertVerified,
      skipJudge:
        skipJudge === null
          ? null
          : {
              reason: "verified-pure-revert",
              detail: {
                revertOf: ctx.revertOf,
                mergedSha: skipJudge.mergedSha,
                headTree: skipJudge.headTree,
                restoredTree: skipJudge.restoredTree,
              },
            },
    };
  };

  // ------------------------------------------------------------ evidence note on the fork
  const writeEvidenceNote = async (): Promise<void> => {
    const evidence = await store.getEvidence(changeId, headSha);
    if (evidence === null) throw new Error("evidence missing");
    await git.writeNote(forkName, headSha, encodeNote(evidence), {
      notesRef: EVIDENCE_NOTES_REF,
      mode: "replace",
    });
    await store.putEvidence({ ...evidence, notesWritten: true });
  };

  // ------------------------------------------------------------ 7b. the lane on the host, early
  // GitHub: the classifier's lane goes into the open check run (still in progress) while the tour
  // is written. Its own durable step; a failure is logged and never fails grading.
  const publishLane = async (): Promise<void> => {
    if (host === null || ctx.host == null || backtest) return;
    const ref = { host: "github" as const, owner: ctx.host.repo.owner, repo: ctx.host.repo.repo, number: ctx.host.change.number };
    try {
      await step.do("publish-lane", RETRY.remote, async () => {
        const stored = await store.getClassification(changeId, headSha);
        if (stored === null) throw new Error("classification missing");
        await host.publishVerdict(ref, {
          ...stored,
          headSha,
          action: "request-review",
          degradations: [],
          tourStatus: "not-generated",
          preliminary: true,
          evidence: null,
        });
        await log("change.lane-published", { host: "github", headSha, lane: stored.lane, preliminary: true });
        return true;
      });
    } catch (e) {
      const reason = errorMessage(e);
      await step.do("publish-lane-failed", RETRY.quick, async () => {
        await log("change.host-publish-failed", { host: "github", what: "publish-lane", headSha, error: reason });
        return true;
      });
    }
  };

  // ------------------------------------------------------------ 5–8. grade (@app/core)
  // evidence (signed) → judge → evidence note → classify → tour → reclassify: the same pipeline
  // a GitHub PR goes through, with each stage a durable step of this workflow.
  const coordinator = bindings.changeCoordinator(changeId);
  const graded = await gradeChange<NativeReport>(
    {
      change: {
        id: changeId,
        title: ctx.title,
        baseSha,
        headSha,
        category: ctx.category,
        agentTraceId: ctx.agentTraceId,
      },
      policy: resolved,
      // Unclaimed projects never auto-merge (their policy already has Lane 0 off; belt and braces).
      autoMergeAllowed: ctx.claimed,
      capabilities,
      // A backtest grades history: the lane is the point, not the tour.
      ...(backtest ? { skipTour: true } : {}),
    },
    {
      stage: durableStages(step),
      evidence: { run: runCi },
      sealer: {
        // A re-grade of this head keeps its on-request QA result (only from a bundle that verifies).
        seal: async (items) => {
          const qa = await carryQaRun(ports, { changeId, headSha, items });
          if (qa.carried > 0 || qa.dropped !== null) await log("change.qa-carried", { carried: qa.carried, dropped: qa.dropped });
          return sealEvidence(ports, { changeId, headSha, baseSha, items: qa.items });
        },
      },
      reviewer: ports.reviewer,
      budget: {
        spent: () => coordinator.spent(changeId),
        record: (usd) => coordinator.recordSpend({ changeId, usd }),
      },
      data: storeGradeData(store, { changeId, headSha, planId: ctx.planId }),
      sink: {
        verdict: (_verdict, result) => persistClassification(store, { changeId, headSha, result }),
        tour: (tour) => persistTour(store, changeId, tour),
      },
      log: async (action, payload) => {
        await log(action, payload);
      },
      hooks: { workerItems: startPreview, afterEvidence, publishEvidence: writeEvidenceNote, laneKnown: publishLane },
    },
  );
  if (graded.status === "stopped") {
    return done(released ? "bootstrapped" : "blocked", null, released ? null : "ci failed");
  }
  const { ciStatus, report } = graded.ci;
  const sealed = graded.evidence;
  const cls = graded.classification;
  const limitUsd = policy.ai.budgetUsdPerChange;
  if (graded.budgetExceeded) {
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

  // ------------------------------------------------------------ 8b. publish on the host (GitHub)
  // Its own durable step after grading: a GitHub outage retries the publish, never the grading.
  // Shadow mode writes nothing to the pull request but this one check run.
  if (host !== null && ctx.host != null && !backtest) {
    const ref = {
      host: "github" as const,
      owner: ctx.host.repo.owner,
      repo: ctx.host.repo.repo,
      number: ctx.host.change.number,
    };
    const summary = graded.verdict;
    try {
      await step.do("publish-verdict", RETRY.remote, async () => {
        const stored = await store.getClassification(changeId, headSha);
        if (stored === null) throw new Error("classification missing");
        const verdict: LaneVerdict = {
          ...stored,
          headSha,
          action: summary.action,
          degradations: summary.degradations,
          tourStatus: summary.tourStatus,
          preliminary: false,
          evidence: summary.evidence,
        };
        await host.publishVerdict(ref, verdict);
        await log("change.verdict-published", { host: "github", headSha, lane: verdict.lane });
        return true;
      });
    } catch (e) {
      const reason = errorMessage(e);
      await step.do("publish-verdict-failed", RETRY.quick, async () => {
        await log("change.verdict-publish-failed", { host: "github", headSha, error: reason });
        return true;
      });
    }
    // The tour as one PR review (Lane ≥ 1) and the summary comment: each its own step, so a
    // GitHub hiccup retries that write only; neither changes the verdict.
    const publishOnHost = async (name: string, run: () => Promise<void>) => {
      try {
        await step.do(name, RETRY.remote, async () => {
          await run();
          return true;
        });
      } catch (e) {
        const reason = errorMessage(e);
        await step.do(`${name}-failed`, RETRY.quick, async () => {
          await log("change.host-publish-failed", { host: "github", what: name, headSha, error: reason });
          return true;
        });
      }
    };
    // The summary first: on a new PR it is the first thing in the timeline, the review below it.
    const publishSummary = host.publishSummary;
    if (publishSummary !== undefined) {
      await publishOnHost("publish-summary", () => publishSummary.call(host, ref));
    }
    await publishOnHost("publish-tour", async () => {
      const tour = (await store.getTour?.(changeId, headSha)) ?? null;
      if (tour !== null) await host.publishTour(ref, tour);
    });
  }

  // ------------------------------------------------------------ 9. route
  if (cls.blocked && !backtest) {
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

  if (backtest) {
    await step.do("backtest-graded", RETRY.quick, async () => {
      await store.updateChange(changeId, { status: "merged", mergedSha: headSha });
      await log("change.backtest-graded", { lane: cls.lane, computedLane: cls.computedLane, blocked: cls.blocked });
      return true;
    });
    return done("graded", cls.lane, "backtest");
  }

  // GitHub mode, shadow: the verdict is the whole outcome. Nothing merges here; GitHub's own
  // merge closes the PR (`pull_request.closed`). Approvals from GitHub bind in M3.
  if (host !== null) {
    await step.do("graded-on-host", RETRY.quick, async () => {
      await store.updateChange(changeId, { status: "awaiting-review" });
      await log("change.graded-on-host", {
        host: "github",
        lane: cls.lane,
        action: graded.verdict.action,
        shadow: cls.shadow,
      });
      return true;
    });
    return done("graded", cls.lane, graded.verdict.action);
  }

  const enqueue = (
    name: string,
    via: "lane-0" | "verified-revert" | "review",
    reviewId: string | null,
  ) =>
    step.do(name, RETRY.quick, async () => {
      // Queued before the RPC: the queue may merge (and set "merged") before this step returns.
      await store.updateChange(changeId, { status: "queued" });
      const { position } = await bindings.mergeQueue(repoId).enqueue({
        repoId,
        changeId,
        headSha,
        workflowInstanceId: instanceId,
        lane: cls.lane,
        // What admits it: the Lane 0 rule, the verified-revert policy, or a human's review.
        approvedLane: via === "lane-0" ? 0 : cls.lane,
        via,
      });
      await log("change.queued", { via, reviewId, position, lane: cls.lane });
      return position;
    });

  // The core's routing: Lane 0, nothing needing a human, and a claimed project (unclaimed projects
  // never auto-merge; their policy already has Lane 0 and revert auto-merge off, this is the belt to
  // that pair of braces). A verified pure revert is Lane 0 only when every raised reason was
  // waivable (`revert.auto-merge`); anything else raised still goes to a human. Natively the
  // platform can merge, so "merge" is never degraded to "label-ready" here.
  const autoMerge = graded.verdict.action === "merge";
  if (autoMerge) {
    await enqueue("enqueue", cls.revertAutoMerge === true ? "verified-revert" : "lane-0", null);
  } else {
    await step.do("request-review", RETRY.quick, async () => {
      await store.updateChange(changeId, { status: "awaiting-review" });
      await notifier.notify({
        kind: "review-requested",
        changeId,
        repoId,
        message:
          cls.lane === 0
            ? `${ctx.title} needs a person's approval (${LANE_LABELS[0].name}, ${LANE_LABELS[0].badge}).`
            : `${ctx.title} needs a ${LANE_LABELS[cls.lane].name.toLowerCase()} (${LANE_LABELS[cls.lane].badge})${cls.shadow ? "; the evidence alone says auto-merge, but auto-merge is calibrating on this repo" : ""}.`,
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
    // The agent-native queue ejected it (machine-readable reason, `fix` aimed at the author).
    const ejected = event === null ? null : QueueEjectedEvent.safeParse(event.payload);
    if (ejected?.success) {
      const r = ejected.data.reason;
      failure = `merge queue ejected it (${r.code}): ${r.message} Next: ${r.fix.call ?? r.fix.explanation}`;
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
    } else if (
      status.status !== "queued" &&
      status.status !== "approved" &&
      // The queue asks for a fresh approval when it raised the lane; it stays queued meanwhile.
      status.status !== "awaiting-review"
    ) {
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
    if (mergedEvent.deployVia === "train") {
      // The merge queue's deploy trains roll it out (with the Changes merged around it).
      await log("rollout.via-train", { mergedSha: mergedEvent.mergedSha });
      return "started" as const;
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
