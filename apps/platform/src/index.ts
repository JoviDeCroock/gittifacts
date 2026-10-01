/**
 * The gittifacts Worker: Hono API (+ OpenAPI), better-auth, MCP, webhooks, static assets, and the
 * Durable Object / Workflow / entrypoint classes wrangler.jsonc declares.
 */

import { configureCoordinatorRuntime } from "@app/coordinator/workers";
import { createApp } from "./app.js";
import type { Bindings } from "./app-env.js";
import { COORDINATOR_OPTIONS } from "./coordinator.js";
import { buildPorts } from "./runtime/ports.js";

// Durable Objects and Workflows are instantiated by the runtime with only `env`; this is how they
// get their Ports. The MergeQueue DO asks for the "merge-queue" role (the only main-repo writer).
configureCoordinatorRuntime<Bindings>({
  ports: (env, role) => buildPorts(env, role),
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
// The coordinator's DO with the CI engine's build artifact mapped onto its run sink.
export { ChangeCoordinator } from "./runtime/change-coordinator.js";

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Bindings>;
