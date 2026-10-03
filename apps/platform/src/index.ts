/**
 * The gittifacts Worker: Hono API (+ OpenAPI), better-auth, MCP, webhooks, static assets, and the
 * Durable Object / Workflow / entrypoint classes wrangler.jsonc declares.
 */

import { configureCoordinatorRuntime } from "@app/coordinator/workers";
import { createApp } from "./app.js";
import type { Bindings } from "./app-env.js";
import { runExpiry } from "./claim/expire-runtime.js";
import { COORDINATOR_OPTIONS } from "./coordinator.js";
import { GITHUB_EVENTS_QUEUE, runGithubEventQueue, runGithubSweep } from "./github/consumer.js";
import { runGithubRedeliveries } from "./github/redeliver.js";
import { githubHostFor } from "./github/runtime.js";
import { platformPushObserver, runImportGrantSweep } from "./import/push-grant-runtime.js";
import { runWebhookQueue, runWebhookSweep } from "./integrations/worker.js";
import { withUnclaimedLimits } from "./limits/ci-quota.js";
import { handlePreviewRequest } from "./previews/gateway.js";
import { isPreviewHost, previewZone } from "./previews/ids.js";
import { runRetention } from "./retention.js";
import { buildPorts } from "./runtime/ports.js";
import { buildQueueRuntime } from "./runtime/queue.js";

// Durable Objects and Workflows are instantiated by the runtime with only `env`; this is how they
// get their Ports. The MergeQueue DO asks for the "merge-queue" role (the only main-repo writer).
// Every role's CI port goes through the unclaimed-project gate (quotas, clamped limits,
// registries-only egress; src/limits/ci-quota.ts).
configureCoordinatorRuntime<Bindings>({
  ports: (env, role) => withUnclaimedLimits(buildPorts(env, role), env),
  coordinatorOptions: COORDINATOR_OPTIONS,
  // The agent-native merge queue (MergeQueue DO): scratch-repo jobs, BatchRunWorkflow, resolver.
  mergeQueue: (env, ports) => buildQueueRuntime(env, ports),
  // Every push (default branch, change forks) → `push` webhooks of installed integrations; the
  // first push to a repo with an import-by-push grant closes it (src/import/push-grant.ts).
  onPushEvent: (env, push) => platformPushObserver(env, push),
  // GitHub mode: the ChangeWorkflow publishes a GitHub PR's verdict through its GitHub host.
  hosts: (env, ports) => ({ github: ({ repo }) => githubHostFor(env, ports, repo).host }),
});

export { CiEgressGateway, CiRunWorkflow, Runner } from "@app/ci-engine";
export {
  BatchRunWorkflow,
  ChangeWorkflow,
  MergeQueue,
  PushRouter,
  RolloutWorkflow,
} from "@app/coordinator/workers";
export { AuditLog } from "./audit/audit-log-do.js";
export { GithubWriteGate } from "./github/write-gate-do.js";
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
  // Cron (wrangler.jsonc triggers.crons): delete unclaimed projects whose TTL ran out; re-queue
  // integration webhook deliveries a lost queue send left pending; close import-by-push grants
  // past their TTL (and finish unconfirmed revocations); purge agent tokens and finished webhook
  // deliveries 30 days after they ended (src/retention.ts).
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(runExpiry(env).then(() => undefined));
    ctx.waitUntil(runWebhookSweep(env).then(() => undefined));
    ctx.waitUntil(runImportGrantSweep(env).then(() => undefined));
    ctx.waitUntil(runGithubSweep(env));
    ctx.waitUntil(runGithubRedeliveries(env).then(() => undefined).catch(() => undefined));
    ctx.waitUntil(runRetention(env).then(() => undefined));
  },
  // WEBHOOK_QUEUE consumer: signed integration webhook deliveries (src/integrations/delivery.ts);
  // GITHUB_EVENTS consumer: verified GitHub App deliveries (src/github/consumer.ts).
  queue: (batch, env) =>
    batch.queue === GITHUB_EVENTS_QUEUE
      ? runGithubEventQueue(batch, env)
      : runWebhookQueue(batch, env),
} satisfies ExportedHandler<Bindings>;
