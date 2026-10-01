/**
 * `GittifactsCIWorkflow`: a `@cloudflare/ci` `CIWorkflow` whose `pipeline()` replays our
 * `PipelineSpec` (carried in the Workflow params as `gittifacts`) through `ci.runner()`,
 * `.runner()` chaining and parallel promises.
 *
 * This is the only module that imports `@cloudflare/ci`. Its TypeScript source does not pass this
 * repo's strict flags (`noImplicitOverride`, `noUncheckedIndexedAccess`) and needs Node types, so
 * this file is checked by `tsconfig.cloudflare.json` instead of `tsconfig.json`.
 *
 * Deploying it needs everything `@cloudflare/ci` needs (CF_TOKEN, R2 credentials, ARTIFACTS,
 * BACKUP_BUCKET, CLOUDFLARE_ACCOUNT_ID, the `CiSandbox` container class) plus CI_BUCKET.
 */

import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  CIWorkflow,
  type CiContext,
  type CiParams,
  type CiRunnerResult,
  type CloudflareArtifacts,
} from "@cloudflare/ci";
import type { CiBindings, RunnerOptions } from "@cloudflare/ci/worker";
import { type CiRunParams, RunRequest, type RunSink } from "../engine.js";
import { formatIssues } from "../plan/spec.js";
import { RunKeys, writeStepRecord } from "../run-store.js";
import { writeJson } from "../storage.js";
import type { RunSinkNamespace } from "../workflows/ci-run.js";
import { replayPipeline } from "./replay.js";
import { buildReplaySummary, replayStepStatus, runningStepStatus } from "./summary.js";
import type { CfCiContext, CfCiParams, CfRunnerOptions, CfRunnerResult } from "./types.js";

export type GittifactsCfBindings = CiBindings & {
  CI_BUCKET: R2Bucket;
  COORDINATOR?: RunSinkNamespace;
};

// Compile-time proof that the strict-side mirrors match the real package types.
const _context = (c: CiContext): CfCiContext => c;
const _result = (r: CiRunnerResult): CfRunnerResult => r;
const _options = (o: CfRunnerOptions): RunnerOptions => o;
const _params = (p: CfCiParams<CiRunParams>): CiParams<CloudflareArtifacts> => p;
void [_context, _result, _options, _params];

export class GittifactsCIWorkflow extends CIWorkflow<CloudflareArtifacts, GittifactsCfBindings> {
  /** Where the finished run is reported. Default: `env.COORDINATOR.getByName(changeId)`. */
  protected runSink(req: CiRunParams): RunSink {
    const ns = this.env.COORDINATOR;
    if (ns === undefined) return { onRunFinished: async () => undefined };
    return { onRunFinished: (summary) => ns.getByName(req.changeId).onRunFinished(summary) };
  }

  protected async pipeline(
    event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    step: WorkflowStep,
    ci: CiContext,
  ): Promise<void> {
    const parsed = RunRequest.safeParse((event.payload as { gittifacts?: unknown }).gittifacts);
    if (!parsed.success)
      throw new NonRetryableError(`invalid gittifacts run request\n${formatIssues(parsed.error)}`);
    const req = parsed.data;
    if (req.pipeline === undefined || req.evidenceSteps === undefined) {
      throw new NonRetryableError(
        "the cloudflare-ci engine needs an explicit pipeline and evidenceSteps",
      );
    }
    const store = this.env.CI_BUCKET;
    const startedAt = event.timestamp.toISOString();
    const result = await replayPipeline(
      ci,
      req.pipeline,
      req.evidenceSteps,
      { runId: req.runId, headSha: req.headSha, baseSha: req.baseSha },
      {
        onStepStart: (name, kind, at) =>
          writeStepRecord(store, req.runId, runningStepStatus(name, kind, at)),
        onStepFinish: (r) => writeStepRecord(store, req.runId, replayStepStatus(r)),
      },
    );
    await step.do(
      "finalize",
      { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
      async () => {
        const summary = buildReplaySummary(req, startedAt, new Date().toISOString(), result);
        await writeJson(store, RunKeys.summary(req.runId), summary);
        await this.runSink(req).onRunFinished(summary);
        return { status: summary.status, evidenceItems: summary.evidence.length };
      },
    );
  }
}
