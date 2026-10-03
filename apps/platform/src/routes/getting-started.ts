/**
 * `GET /api/v1/me/getting-started`: the dashboard's first-run checklist reads real state from here
 * (src/services/getting-started.ts). Humans only; never cached (it changes as the first CI runs).
 */
import { createRoute } from "@hono/zod-openapi";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { GettingStartedSchema, gettingStarted } from "../services/getting-started.js";
import { type ApiApp, errors, json, SECURITY } from "./common.js";

export const GETTING_STARTED_PATH = "/api/v1/me/getting-started";

const route = createRoute({
  method: "get",
  path: GETTING_STARTED_PATH,
  tags: ["identity"],
  summary:
    "Your first-run checklist: a connected agent, the first green check (with its preview) and a repo brought in",
  security: SECURITY,
  middleware: [requirePrincipal([], { humanOnly: true })] as const,
  responses: {
    200: json(GettingStartedSchema, "Checklist state"),
    ...errors(401, 403),
  },
});

export function registerGettingStartedRoutes(app: ApiApp): void {
  app.openapi(route, async (c) => {
    c.header("cache-control", "no-store");
    return c.json(await gettingStarted(c.get("services"), callerOf(c)), 200);
  });
}
