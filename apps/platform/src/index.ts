/**
 * The gittifacts Worker: Hono API (+ OpenAPI), better-auth, MCP, webhooks, static assets, and the
 * Durable Object / Workflow / entrypoint classes wrangler.jsonc declares.
 */

import { configureCoordinatorRuntime } from "@app/coordinator/workers";
import { createApp } from "./app.js";
import type { Bindings } from "./app-env.js";
import { runExpiry } from "./claim/expire-runtime.js";
import { COORDINATOR_OPTIONS } from "./coordinator.js";
import { withUnclaimedLimits } from "./limits/ci-quota.js";
import { handlePreviewRequest } from "./previews/gateway.js";
import { isPreviewHost, previewZone } from "./previews/ids.js";
import { buildPorts } from "./runtime/ports.js";

// Durable Objects and Workflows are instantiated by the runtime with only `env`; this is how they
// get their Ports. The MergeQueue DO asks for the "merge-queue" role (the only main-repo writer).
// Every role's CI port goes through the unclaimed-project gate (quotas, clamped limits,
// registries-only egress; src/limits/ci-quota.ts).
configureCoordinatorRuntime<Bindings>({
  ports: (env, role) => withUnclaimedLimits(buildPorts(env, role), env),
  coordinatorOptions: COORDINATOR_OPTIONS,
});

export { CiEgressGateway, CiRunWorkflow, Runner } from "@app/ci-engine";
export {
  ChangeWorkflow,
  MergeQueue,
  PushRouter,
  RolloutWorkflow,
} from "@app/coordinator/workers";
export { AuditLog } from "./audit/audit-log-do.js";
export { PlatformConfigWorkflow } from "./import/workflow.js";
// The coordinator's ChangeCoordinator + settling unclaimed projects' CI usage on run finish.
export { ChangeCoordinator } from "./limits/coordinator-do.js";
export { AbuseLimiter } from "./limits/limiter-do.js";
export { PreviewHost } from "./previews/preview-host.js";
export { WorkspaceEgressGateway } from "./workspace/egress.js";
export { ProjectLedger } from "./workspace/ledger-do.js";
export { Workspace } from "./workspace/workspace-do.js";

const app = createApp();

export default {
  // *-pv.resynapse.dev is the preview gateway; every other host is the platform.
  fetch: (request, env, ctx) =>
    isPreviewHost(new URL(request.url).hostname, previewZone(env))
      ? handlePreviewRequest(request, env)
      : app.fetch(request, env, ctx),
  // Cron (wrangler.jsonc triggers.crons): delete unclaimed projects whose TTL ran out.
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(runExpiry(env).then(() => undefined));
  },
} satisfies ExportedHandler<Bindings>;
