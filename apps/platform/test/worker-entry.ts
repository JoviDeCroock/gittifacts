/**
 * Test entry (`main` for the vitest pool): the production Worker module, with the coordinator's
 * Ports for Artifacts, containers and the reviewer model swapped for fakes (test/integration/
 * fakes.ts says why each one). Re-configuring after `src/index.ts` ran its own
 * `configureCoordinatorRuntime` makes the Durable Objects and Workflows use these.
 */

import { inspectRepo } from "@app/conventions";
import { configureCoordinatorRuntime } from "@app/coordinator/workers";
import type { Bindings } from "../src/app-env.js";
import { COORDINATOR_OPTIONS } from "../src/coordinator.js";
import { configureImportRuntime } from "../src/import/detect-job.js";
import { buildPorts } from "../src/runtime/ports.js";
import { configureWorkspaceRuntime } from "../src/workspace/runtime.js";
import { integrationFakes, integrationOverrides } from "./integration/fakes.js";
import { fakeMachineFor } from "./integration/workspace-fakes.js";

export * from "../src/index.js";
export { default } from "../src/index.js";
// The real PreviewHost with a fake container (an explicit export wins over the star export).
export { TestPreviewHost as PreviewHost } from "./integration/preview-fakes.js";

configureCoordinatorRuntime<Bindings>({
  ports: (env, role) => buildPorts(env, role, { overrides: integrationOverrides(role, env) }),
  coordinatorOptions: COORDINATOR_OPTIONS,
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
