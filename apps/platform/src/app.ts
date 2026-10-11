import { TOOL_NAMES } from "@app/conventions";
import { z } from "zod";
import { registerMemberRoutes } from "./access/routes.js";
import { ErrorSchema } from "./api/schemas.js";
import { type AppOptions, createServices } from "./app-env.js";
import { authFor, callerOf, requirePrincipal } from "./auth/middleware.js";
import { registerClaimRoutes } from "./claim/routes.js";
import { getCoordinator } from "./coordinator.js";
import { fixFor, toErrorResponse } from "./errors.js";
import { registerGithubRoutes } from "./github/routes.js";
import { registerImportGrantRoutes } from "./import/push-grant-routes.js";
import { registerImportRoutes } from "./import/routes.js";
import { registerIntegrationRoutes } from "./integrations/routes.js";
import { RateLimited } from "./limits/creation.js";
import { registerLimitRoutes } from "./limits/routes.js";
import { handleMcp, MCP_PATH } from "./mcp/route.js";
import { originOf } from "./oauth/context.js";
import { QaRateLimited } from "./qa/request.js";
import { registerQueueRoutes } from "./queue/routes.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerChangeRoutes } from "./routes/changes.js";
import { registerCliRoutes } from "./routes/cli.js";
import { type ApiApp, newApiApp, SECURITY } from "./routes/common.js";
import { registerDocsRoutes } from "./routes/docs.js";
import { registerFrontDoorRoutes } from "./routes/front-door.js";
import { registerGettingStartedRoutes } from "./routes/getting-started.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerIdentityRoutes } from "./routes/identity.js";
import { registerPlanRoutes } from "./routes/plans.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerQaRoutes } from "./routes/qa.js";
import { registerRepoRoutes } from "./routes/repos.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerWellKnownRoutes } from "./routes/well-known.js";
import { readBlob } from "./services/blobs.js";
import {
  handleIssuesWebhook,
  ISSUES_WEBHOOK_PATH,
  NotificationEnvelope,
} from "./webhooks/workers-issues.js";

export const OPENAPI_PATH = "/api/v1/openapi.json";
export const BLOBS_PATH = "/api/v1/blobs";

/** Paths the Worker owns; everything else is the SPA (static assets). */
const WORKER_PATHS =
  /^\/(api\/|mcp$|mcp\/|webhooks\/|\.well-known\/|internal\/ttfg$|git\/|github\/)/;

const OPENAPI_CONFIG = {
  openapi: "3.1.0",
  info: {
    title: "gittifacts",
    version: "1.0.0",
    description:
      "Agent-native git platform. Humans approve intent; machines prove conformance. Start at /start. Errors are `{ error: { code, message, fix, details? } }`.",
  },
} as const;

export function createApp(options: Partial<AppOptions> = {}): ApiApp {
  const opts: AppOptions = { coordinator: getCoordinator, ...options };
  const app = newApiApp();

  app.use("*", async (c, next) => {
    // Hono types executionCtx with its own minimal interface; at runtime it is the Worker's ctx.
    c.set("services", createServices(c.env, c.executionCtx as ExecutionContext, opts, originOf(c)));
    c.set("caller", undefined);
    await next();
    c.header("x-gittifacts-version", c.env.VERSION?.id ?? "dev");
  });

  app.onError((err, c) => {
    const r = toErrorResponse(err);
    if (err instanceof RateLimited || err instanceof QaRateLimited)
      c.header("retry-after", String(err.retryAfterSec));
    return c.json(r.body, r.status);
  });

  app.notFound((c) => {
    if (!WORKER_PATHS.test(new URL(c.req.url).pathname)) return c.env.ASSETS.fetch(c.req.raw);
    return c.json(
      {
        error: {
          code: "not-found",
          message: "no such route",
          fix: fixFor("not-found", {
            explanation: `No route ${c.req.method} ${new URL(c.req.url).pathname}. The API is described at ${OPENAPI_PATH}.`,
          }),
        },
      },
      404,
    );
  });

  // better-auth (sign-up/in, sessions, GitHub OAuth callback, passkeys).
  app.on(["GET", "POST"], "/api/auth/*", (c) => authFor(c).handler(c.req.raw));

  registerFrontDoorRoutes(app, () => app.getOpenAPI31Document(OPENAPI_CONFIG));
  // Liveness + the deployed commit (the post-deploy smoke checks it, docs/testing.md).
  registerHealthRoutes(app);
  // Documentation (packages/docs build in the static assets): HTML, or markdown on request.
  registerDocsRoutes(app);
  // The CLI as an npm tarball (packages/cli pack:assets): npx -y <origin>/cli/gittifacts.tgz.
  registerCliRoutes(app);
  registerWellKnownRoutes(app);
  registerIdentityRoutes(app);
  // The dashboard's first-run checklist.
  registerGettingStartedRoutes(app);
  registerRepoRoutes(app);
  registerMemberRoutes(app);
  registerImportRoutes(app);
  registerImportGrantRoutes(app);
  registerQueueRoutes(app);
  registerPlanRoutes(app);
  registerChangeRoutes(app);
  // QA in a browser, on request (src/qa/): ask, list, and signed thumbnails for GitHub.
  registerQaRoutes(app);
  registerProjectRoutes(app);
  // Public aggregates the landing page quotes (live time to first green).
  registerStatsRoutes(app);
  registerClaimRoutes(app);
  registerLimitRoutes(app);
  registerAuditRoutes(app);
  // External integrations: developer portal, installs, deployments, the /git/ proxy.
  registerIntegrationRoutes(app);
  // GitHub mode: App manifest flow, install verification, webhooks (src/github/).
  registerGithubRoutes(app);

  // R2-backed references (logs, screenshots, spilled diffs). `:ref` may contain slashes.
  app.get(`${BLOBS_PATH}/:ref{.+}`, requirePrincipal(["repo:read"]), (c) =>
    readBlob(c.get("services"), callerOf(c), c.req.param("ref")),
  );
  app.openAPIRegistry.registerPath({
    method: "get",
    path: `${BLOBS_PATH}/{ref}`,
    tags: ["blobs"],
    summary:
      "Raw bytes of an R2 reference (logRef, beforeRef, afterRef), authorized by the owning repo",
    security: SECURITY,
    request: {
      params: z.object({
        ref: z.string().describe("The reference exactly as returned (URL-encoded)"),
      }),
    },
    responses: {
      200: { description: "The object (images, JSON or text; anything else as an attachment)" },
      400: {
        description: "Not a reference",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "Unknown or not readable",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  // MCP: POST only (stateless); GET/DELETE are answered 405 by the SDK handler.
  app.on(["GET", "POST", "DELETE"], MCP_PATH, handleMcp);
  app.openAPIRegistry.registerPath({
    method: "post",
    path: MCP_PATH,
    tags: ["mcp"],
    summary: "MCP server (streamable HTTP, stateless)",
    description:
      "JSON-RPC MCP endpoint for agents. `Authorization: Bearer gtf_…` (agent token); without one, only initialize, tools/list, create_project (an unclaimed project and its own token) and whoami are served. " +
      // From the contract's tool list (tested equal to the registered tools), so it can't go stale.
      `The ${TOOL_NAMES.length} tools: ${TOOL_NAMES.join(", ")}. tools/list has each one's schemas; search_tools finds one by what you want to do.`,
    security: [{ Bearer: [] }],
    request: { body: { content: { "application/json": { schema: z.unknown() } }, required: true } },
    responses: {
      200: { description: "JSON-RPC response (application/json or text/event-stream)" },
      401: { description: "Missing or invalid agent token (WWW-Authenticate: Bearer)" },
      403: { description: "Foreign Origin" },
    },
  });

  app.post(ISSUES_WEBHOOK_PATH, handleIssuesWebhook);
  app.openAPIRegistry.registerPath({
    method: "post",
    path: ISSUES_WEBHOOK_PATH,
    tags: ["webhooks"],
    summary: "Workers Issues generic webhook (Cloudflare Notifications)",
    description:
      "Authenticated by the shared secret in `cf-webhook-auth`. Body is parsed leniently.",
    request: {
      headers: z.object({ "cf-webhook-auth": z.string() }),
      body: { content: { "application/json": { schema: NotificationEnvelope } }, required: true },
    },
    responses: {
      202: {
        description: "Stored (and forwarded to the coordinator when possible)",
        content: {
          "application/json": {
            schema: z.object({
              received: z.literal(true),
              issueId: z.string(),
              changeId: z.string().nullable(),
              forwarded: z.boolean(),
            }),
          },
        },
      },
      401: {
        description: "Bad or missing secret",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
    type: "http",
    scheme: "bearer",
    description: "Agent token (gtf_…) or a better-auth session token",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "Session", {
    type: "apiKey",
    in: "cookie",
    name: "better-auth.session_token",
  });
  app.doc31(OPENAPI_PATH, OPENAPI_CONFIG);

  return app;
}
