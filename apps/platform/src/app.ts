import { z } from "zod";
import { ErrorSchema } from "./api/schemas.js";
import { type AppOptions, createServices } from "./app-env.js";
import { authFor } from "./auth/middleware.js";
import { getCoordinator } from "./coordinator.js";
import { fixFor, toErrorResponse } from "./errors.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerChangeRoutes } from "./routes/changes.js";
import { type ApiApp, newApiApp } from "./routes/common.js";
import { registerIdentityRoutes } from "./routes/identity.js";
import { registerPlanRoutes } from "./routes/plans.js";
import { registerRepoRoutes } from "./routes/repos.js";
import { registerWellKnownRoutes } from "./routes/well-known.js";
import {
  handleIssuesWebhook,
  ISSUES_WEBHOOK_PATH,
  NotificationEnvelope,
} from "./webhooks/workers-issues.js";

export const OPENAPI_PATH = "/api/v1/openapi.json";

/** Paths the Worker owns; everything else is the SPA (static assets). */
const WORKER_PATHS = /^\/(api\/|mcp$|mcp\/|webhooks\/|\.well-known\/)/;

export function createApp(options: Partial<AppOptions> = {}): ApiApp {
  const opts: AppOptions = { coordinator: getCoordinator, ...options };
  const app = newApiApp();

  app.use("*", async (c, next) => {
    // Hono types executionCtx with its own minimal interface; at runtime it is the Worker's ctx.
    c.set("services", createServices(c.env, c.executionCtx as ExecutionContext, opts));
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

  registerWellKnownRoutes(app);
  registerIdentityRoutes(app);
  registerRepoRoutes(app);
  registerPlanRoutes(app);
  registerChangeRoutes(app);
  registerAuditRoutes(app);

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
  app.doc31(OPENAPI_PATH, {
    openapi: "3.1.0",
    info: {
      title: "gittifacts",
      version: "1.0.0",
      description:
        "Agent-native git platform. Humans approve intent; machines prove conformance. Errors are `{ error: { code, message, details? } }`.",
    },
  });

  return app;
}
