/**
 * Test entry (`main` for the vitest pool): the production Worker module, with the coordinator's
 * Ports for Artifacts, containers and the reviewer model swapped for fakes (test/integration/
 * fakes.ts says why each one). Re-configuring after `src/index.ts` ran its own
 * `configureCoordinatorRuntime` makes the Durable Objects and Workflows use these.
 */

import { inspectRepo } from "@app/conventions";
import { workflowHandle } from "@app/coordinator";
import { FakeQueueJobs } from "@app/coordinator/fakes";
import { configureCoordinatorRuntime } from "@app/coordinator/workers";
import type { Bindings } from "../src/app-env.js";
import { COORDINATOR_OPTIONS } from "../src/coordinator.js";
import { githubHostFor } from "../src/github/runtime.js";
import { configureImportRuntime } from "../src/import/detect-job.js";
import { platformPushObserver } from "../src/import/push-grant-runtime.js";
import { withUnclaimedLimits } from "../src/limits/ci-quota.js";
import { buildPorts } from "../src/runtime/ports.js";
import { configureWorkspaceRuntime } from "../src/workspace/runtime.js";
import { integrationFakes, integrationOverrides } from "./integration/fakes.js";
import { fakeMachineFor } from "./integration/workspace-fakes.js";

export * from "../src/index.js";
export { default } from "../src/index.js";
// The real PreviewHost with a fake container (an explicit export wins over the star export).
export { TestPreviewHost as PreviewHost } from "./integration/preview-fakes.js";

configureCoordinatorRuntime<Bindings>({
  // Like src/index.ts: every role's CI port goes through the unclaimed-project gate.
  ports: (env, role) =>
    withUnclaimedLimits(buildPorts(env, role, { overrides: integrationOverrides(role, env) }), env),
  coordinatorOptions: COORDINATOR_OPTIONS,
  // The real MergeQueue DO and BatchRunWorkflow; its sandbox jobs replay on FakeGitHost files.
  mergeQueue: (env) => ({
    jobs: new FakeQueueJobs(integrationFakes().git),
    batchRuns: workflowHandle(env.BATCH_RUN_WORKFLOW),
    targetsSupported: true,
  }),
  // Like src/index.ts: webhooks, and the first push to a repo closes its import-by-push grant.
  onPushEvent: (env, push) => platformPushObserver(env, push),
  // Like src/index.ts: GitHub PRs publish their verdict through a GitHub host.
  hosts: (env, ports) => ({ github: ({ repo }) => githubHostFor(env, ports, repo).host }),
});

// Workspaces: the real Workspace DO over an in-memory machine (no containers in workerd).
configureWorkspaceRuntime({ machine: (_ctx, name) => fakeMachineFor(name) });

// Import detection: the real inspection (@app/conventions inspectRepo) over FakeGitHost files,
// instead of a Runner container job.
configureImportRuntime({
  sandbox: () => ({
    detect: async ({ sha }) => {
      const files = integrationFakes().git.filesAt(sha);
      return inspectRepo({ files: Object.keys(files), read: (p) => files[p] ?? null }, { sha });
    },
  }),
});
