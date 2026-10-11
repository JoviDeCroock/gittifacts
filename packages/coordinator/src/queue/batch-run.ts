/**
 * The BatchRunWorkflow body (`BatchRunWorkflowContract` in @app/merge-queue): one Workflow
 * instance per speculative batch run (`StartBatchRun`) or flake re-check (`RunFlakeRecheck`),
 * built on the existing `CiEngine`.
 *
 * run:     verify the commit's tree → start the CI run on `refs/queue/<batchId>`'s commit in the
 *          main repo (required checks; or only `targets` + the non-test steps) → poll, failing
 *          fast as soon as a step fails → report `BatchResult{ treeSha, outcome, scope }`.
 * recheck: the same pipeline on the batch commit AND on main's head, in parallel → report
 *          `FlakeRecheckResult`. Runs report whole-run outcomes per listed test (the engine's
 *          status has no per-test results), which the core handles (`__run__`).
 *
 * The result goes to the repo's MergeQueue DO (`onQueueResult`), which validates it like any
 * other event. Node-safe; the WorkflowEntrypoint wrapper is in batch-run-workflow.ts.
 */
import { type CoreEventInput, StartBatchRun } from "@app/merge-queue";
import { z } from "zod";
import type { FlowDeps } from "../change-flow.js";
import type { CiRunStatus } from "../ports.js";
import { RETRY, type Step } from "../step.js";

const RecheckCommand = z.object({
  type: z.literal("RunFlakeRecheck"),
  batchId: z.string(),
  runId: z.string(),
  treeSha: z.string(),
  commitSha: z.string(),
  mainSha: z.string(),
  tests: z.array(z.string()),
});

export const BatchRunParams = z.object({
  repoId: z.string().min(1),
  /** The main repo (Artifacts name): CI checks out `refs/queue/<batchId>` commits from it. */
  mainRepo: z.string().min(1),
  /** A real Change the CI run is filed under (pipeline_runs references changes). */
  changeId: z.string().min(1),
  /** CI run id prefix (unique per queue lifetime). */
  ciRunPrefix: z.string().min(1).max(80),
  network: z.enum(["open", "registries-only"]),
  maxMinutes: z.number().int().min(1).max(240).default(60),
  /** The engine accepts `testTargets` (impacted-target revalidation). */
  targetsSupported: z.boolean().default(false),
  command: z.discriminatedUnion("type", [StartBatchRun, RecheckCommand]),
});
export type BatchRunParams = z.input<typeof BatchRunParams>;

export interface BatchRunOutput {
  outcome: string;
  ciRunIds: string[];
}

interface Polled {
  status: "running" | "passed" | "failed" | "errored" | "cancelled";
  failedSteps: string[];
  logRef: string | null;
  durationMs: number | null;
  bundleRef: string | null;
}

/** Poll every 15 s for 3 minutes, then every 30 s (≈ 220 steps for a 90-minute run). */
function pollDelay(round: number): `${number} seconds` {
  return round <= 12 ? "15 seconds" : "30 seconds";
}

export function summarizeStatus(s: CiRunStatus, startedAt: number, now: number): Polled {
  const failed = s.steps.filter((x) => x.kind === "user" && x.status === "failed");
  const errored = s.steps.filter((x) => x.status === "errored");
  const logRef = failed[0]?.logRef ?? errored[0]?.logRef ?? null;
  const bundle = (s as { artifacts?: Record<string, { key?: string }> }).artifacts?.bundle?.key;
  const base = {
    failedSteps: failed.map((x) => x.name),
    logRef,
    durationMs: Math.max(0, now - startedAt),
    bundleRef: typeof bundle === "string" ? bundle : null,
  };
  if (s.status === "passed") return { status: "passed", ...base };
  if (s.status === "cancelled" || s.status === "superseded")
    return { status: "cancelled", ...base };
  // Fail fast: a failed user step decides the run even while later steps are still going.
  if (failed.length > 0) return { status: "failed", ...base };
  if (s.status === "failed") return { status: errored.length > 0 ? "errored" : "failed", ...base };
  return { status: "running", ...base };
}

/**
 * `ciRun`, but a step that failed for good (start refused, polling broken) is an errored run
 * instead of an errored Workflow instance: the instance must always report back, or the batch
 * sits "running" in the DO until its run timeout (live 2026-10-11: 25+ min, four landings).
 */
async function ciRunOrErrored(
  deps: FlowDeps,
  params: z.output<typeof BatchRunParams>,
  step: Step,
  input: Parameters<typeof ciRun>[3],
): Promise<Polled & { error?: string }> {
  try {
    return await ciRun(deps, params, step, input);
  } catch (e) {
    const error = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 2000);
    return {
      status: "errored",
      failedSteps: [],
      logRef: null,
      durationMs: null,
      bundleRef: null,
      error,
    };
  }
}

/** One CI run of the pipeline on `commitSha` (main repo), polled to its end with fail-fast. */
async function ciRun(
  deps: FlowDeps,
  params: z.output<typeof BatchRunParams>,
  step: Step,
  input: {
    name: string;
    ciRunId: string;
    commitSha: string;
    baseSha: string;
    targets: string[] | null;
  },
): Promise<Polled> {
  const { ci, git, clock } = deps.ports;
  const started = await step.do(`${input.name}-start`, RETRY.remote, async () => {
    await ci.start({
      runId: input.ciRunId,
      changeId: params.changeId,
      repo: { remote: git.remoteOf(params.mainRepo), tokenProvider: "artifacts" },
      artifactsRepo: params.mainRepo,
      headSha: input.commitSha,
      baseSha: input.baseSha,
      // The pipeline comes from the base (main), like every run: a Change never edits its own CI.
      pipelineFrom: "base",
      evidenceSteps: [],
      limits: { maxMinutes: params.maxMinutes },
      network: params.network,
      ...(input.targets !== null && params.targetsSupported ? { testTargets: input.targets } : {}),
    });
    return clock.now().getTime();
  });
  for (let round = 1; round <= 400; round++) {
    const polled = await step.do(`${input.name}-poll-${round}`, RETRY.quick, async () =>
      summarizeStatus(await ci.status(input.ciRunId), started, clock.now().getTime()),
    );
    if (polled.status !== "running") {
      if (polled.status === "failed")
        await step.do(`${input.name}-cancel`, RETRY.quick, async () => {
          await ci.cancel(input.ciRunId, "fail fast: a required step failed");
          return true;
        });
      return polled;
    }
    await step.sleep(`${input.name}-wait-${round}`, pollDelay(round));
  }
  await step.do(`${input.name}-timeout`, RETRY.quick, async () => {
    await ci.cancel(input.ciRunId, "merge queue run timed out");
    return true;
  });
  return { status: "errored", failedSteps: [], logRef: null, durationMs: null, bundleRef: null };
}

export async function runBatchRun(
  deps: FlowDeps,
  raw: BatchRunParams,
  step: Step,
): Promise<BatchRunOutput> {
  const params = BatchRunParams.parse(raw);
  const cmd = params.command;
  const queue = deps.bindings.mergeQueue(params.repoId);
  const report = (event: CoreEventInput, meta: Record<string, unknown> = {}) =>
    step.do("report", RETRY.quick, async () => {
      if (queue.onQueueResult === undefined) throw new Error("merge queue cannot take results");
      await queue.onQueueResult({ event, meta });
      return true;
    });
  const ciRunId = (suffix: string) => `${params.ciRunPrefix}-${suffix}`.slice(0, 100);

  if (cmd.type === "StartBatchRun") {
    // The tested tree is the commit's tree in the main repo (what main will point at).
    const treeSha = await step.do("tree", RETRY.remote, async () => {
      const t = await deps.ports.git.treeOf(params.mainRepo, cmd.commitSha);
      return t ?? cmd.treeSha;
    });
    // No impacted test target (a docs-only revalidation) is not "nothing to check": the build and
    // lint steps still have to pass on the new tree, and the engine takes no empty target list
    // (it refused `testTargets: []`; live 2026-10-11). Run everything: "all" covers [].
    const targets = cmd.targets === "all" || cmd.targets.length === 0 ? null : cmd.targets;
    const id = ciRunId("r");
    const r = await ciRunOrErrored(deps, params, step, {
      name: "run",
      ciRunId: id,
      commitSha: cmd.commitSha,
      baseSha: cmd.baseSha,
      targets,
    });
    const outcome = r.status === "running" ? "errored" : r.status;
    await report(
      {
        type: "BatchResult",
        batchId: cmd.batchId,
        runId: cmd.runId,
        treeSha,
        outcome,
        // Whole-run granularity: the core re-checks the run on main (`__run__`) before believing it.
        failingTests: [],
        scope: targets !== null && params.targetsSupported ? targets : "all",
        ...(r.durationMs === null ? {} : { durationMs: r.durationMs }),
        ...(r.logRef === null ? {} : { logRef: r.logRef }),
      },
      {
        ciRunId: id,
        bundleRef: r.bundleRef,
        failedSteps: r.failedSteps,
        ...(r.error === undefined ? {} : { error: r.error }),
      },
    );
    return { outcome, ciRunIds: [id] };
  }

  // Infra errors are retried (twice) before they count: a re-run that could not run at all must
  // not decide between "flaky" and "real".
  const decided = async (name: string, commitSha: string): Promise<Polled> => {
    let last: Polled | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      last = await ciRunOrErrored(deps, params, step, {
        name: `${name}${attempt}`,
        ciRunId: ciRunId(`k${name[0]}${attempt}`),
        commitSha,
        baseSha: cmd.mainSha,
        targets: null,
      });
      if (last.status === "passed" || last.status === "failed") return last;
    }
    return (
      last ?? {
        status: "errored",
        failedSteps: [],
        logRef: null,
        durationMs: null,
        bundleRef: null,
      }
    );
  };
  const [onBatch, onMain] = await Promise.all([
    decided("batch", cmd.commitSha),
    decided("main", cmd.mainSha),
  ]);
  // An infra error is not a pass: unknown escalates (the core reads "failed on batch" as real).
  const verdict = (p: Polled): "passed" | "failed" => (p.status === "passed" ? "passed" : "failed");
  await report({
    type: "FlakeRecheckResult",
    batchId: cmd.batchId,
    runId: cmd.runId,
    results: cmd.tests.map((test) => ({
      test,
      onBatch: verdict(onBatch),
      onMain: verdict(onMain),
    })),
  });
  return { outcome: `${onBatch.status}/${onMain.status}`, ciRunIds: [] };
}
