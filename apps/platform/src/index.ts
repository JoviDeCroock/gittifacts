/**
 * The gittifacts Worker: Hono API (+ OpenAPI), better-auth, MCP, webhooks, static assets, and the
 * Durable Object / Workflow classes wrangler.jsonc declares.
 */

import { createApp } from "./app.js";
import type { Bindings } from "./app-env.js";

export { AuditLog } from "./audit/audit-log-do.js";

// TODO(lead): export the coordinator classes once packages/coordinator ships them, e.g.
// export { ChangeCoordinator, MergeQueue, ChangeWorkflow, CiRunWorkflow, RolloutWorkflow, PushRouter } from "@app/coordinator";
// export { Runner } from "@app/ci-engine";

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Bindings>;
