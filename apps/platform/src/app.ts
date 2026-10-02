import { z } from "zod";
import { ErrorSchema } from "./api/schemas.js";
import { type AppOptions, createServices } from "./app-env.js";
import { authFor, callerOf, requirePrincipal } from "./auth/middleware.js";
import { getCoordinator } from "./coordinator.js";
import { fixFor, toErrorResponse } from "./errors.js";
import { registerImportRoutes } from "./import/routes.js";
import { handleMcp, MCP_PATH } from "./mcp/route.js";
import { originOf } from "./oauth/context.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerChangeRoutes } from "./routes/changes.js";
import { type ApiApp, newApiApp, SECURITY } from "./routes/common.js";
import { registerFrontDoorRoutes } from "./routes/front-door.js";
import { registerIdentityRoutes } from "./routes/identity.js";
import { registerPlanRoutes } from "./routes/plans.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerRepoRoutes } from "./routes/repos.js";
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
const WORKER_PATHS = /^\/(api\/|mcp$|mcp\/|webhooks\/|\.well-known\/|internal\/ttfg$)/;

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
  registerWellKnownRoutes(app);
  registerIdentityRoutes(app);
  registerRepoRoutes(app);
  registerImportRoutes(app);
  registerPlanRoutes(app);
  registerChangeRoutes(app);
  registerProjectRoutes(app);
  registerAuditRoutes(app);

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
      "JSON-RPC MCP endpoint for agents. `Authorization: Bearer gtf_…` (agent token). Tools: create_project, whoami, list_repos, create_plan, start_change, get_change_status, get_evidence, get_tour, request_review, list_issues_for_change, refresh_push_token, wait_for_change.",
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
