/**
 * What the agent-native MergeQueue DO needs besides its Ports (coordinator `MergeQueueRuntime`):
 *
 * - `jobs`: batch trees, affected sets and resolutions on the Runner container, in the repo's
 *   scratch repo (`mqs-<repoId>`), with the merge-queue role's GitHost (the only main writer).
 * - `batchRuns`: the BatchRunWorkflow binding (one instance per speculative batch run).
 * - `resolver`: the conflict resolver (@app/resolver) on the platform's model client; the base
 *   policy's `ai.reviewerModel` picks the model ("auto" → Workers AI Kimi, `REVIEWER_MODEL`
 *   overrides), exactly like the reviewer.
 * - `trains`: deploy trains on unless `MERGE_QUEUE_TRAINS` is "off" (then one RolloutWorkflow
 *   per merged Change, as before the queue).
 */
import { RunKeys } from "@app/ci-engine";
import { type MergeQueueRuntime, type Ports, workflowHandle } from "@app/coordinator";
import { ContainerQueueJobs, type RunnerLike } from "@app/coordinator/adapters";
import { createResolver } from "@app/resolver";
import { DEFAULT_PRICES, reviewerLlmFromEnv } from "@app/tour";
import { PLATFORM_AUTO_REVIEWER_MODEL, WORKERS_AI_PRICES } from "./ports.js";

/** The bindings and vars the queue runtime reads. */
export type QueueRuntimeEnv = Pick<Env, "RUNNER" | "CI_BUCKET" | "BATCH_RUN_WORKFLOW"> & {
  REVIEWER_MODEL?: string;
  MERGE_QUEUE_TRAINS?: string;
};

/** "auto" → the platform's model (REVIEWER_MODEL overrides), like `lazyReviewer`. */
export function resolverModel(env: { REVIEWER_MODEL?: string }, requested: string): string {
  const r = requested.trim();
  if (r !== "" && r !== "auto") return r;
  const override = env.REVIEWER_MODEL?.trim();
  return override !== undefined && override !== "" ? override : PLATFORM_AUTO_REVIEWER_MODEL;
}

export function buildQueueRuntime(env: QueueRuntimeEnv, ports: Ports): MergeQueueRuntime {
  const prices = { ...DEFAULT_PRICES, ...WORKERS_AI_PRICES };
  return {
    jobs: new ContainerQueueJobs({
      runner: (name) => env.RUNNER.getByName(name) as unknown as RunnerLike,
      git: ports.git,
      logKey: (jobId, step) => RunKeys.log(jobId, step),
      readLog: async (key) => {
        const object = await env.CI_BUCKET.get(key);
        return object === null ? null : object.text();
      },
    }),
    batchRuns: workflowHandle(env.BATCH_RUN_WORKFLOW),
    resolver: (model) =>
      createResolver(reviewerLlmFromEnv(env, { model: resolverModel(env, model), prices }), {
        prices,
      }),
    // The engine passes GITTIFACTS_TEST_TARGETS to user steps (ci-engine RunRequest.testTargets).
    targetsSupported: true,
    trains: env.MERGE_QUEUE_TRAINS !== "off",
  };
}
