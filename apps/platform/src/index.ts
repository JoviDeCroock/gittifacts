/**
 * The gittifacts Worker: Hono API (+ OpenAPI), better-auth, MCP, webhooks, static assets, and the
 * Durable Object / Workflow / entrypoint classes wrangler.jsonc declares.
 */

import { configureCoordinatorRuntime } from "@app/coordinator/workers";
import { createApp } from "./app.js";
import type { Bindings } from "./app-env.js";
import { COORDINATOR_OPTIONS } from "./coordinator.js";
import { handlePreviewRequest } from "./previews/gateway.js";
import { isPreviewHost, previewZone } from "./previews/ids.js";
import { buildPorts } from "./runtime/ports.js";

// Durable Objects and Workflows are instantiated by the runtime with only `env`; this is how they
// get their Ports. The MergeQueue DO asks for the "merge-queue" role (the only main-repo writer).
configureCoordinatorRuntime<Bindings>({
  ports: (env, role) => buildPorts(env, role),
  coordinatorOptions: COORDINATOR_OPTIONS,
});

export { CiEgressGateway, CiRunWorkflow, Runner } from "@app/ci-engine";
export {
  ChangeCoordinator,
  ChangeWorkflow,
  MergeQueue,
  PushRouter,
  RolloutWorkflow,
} from "@app/coordinator/workers";
export { AuditLog } from "./audit/audit-log-do.js";
export { PreviewHost } from "./previews/preview-host.js";
export { WorkspaceEgressGateway } from "./workspace/egress.js";
export { ProjectLedger } from "./workspace/ledger-do.js";
export { Workspace } from "./workspace/workspace-do.js";

const app = createApp();

export default {
  // *.preview.resynapse.dev is the preview gateway; every other host is the platform.
  fetch: (request, env, ctx) =>
    isPreviewHost(new URL(request.url).hostname, previewZone(env))
      ? handlePreviewRequest(request, env)
      : app.fetch(request, env, ctx),
} satisfies ExportedHandler<Bindings>;
