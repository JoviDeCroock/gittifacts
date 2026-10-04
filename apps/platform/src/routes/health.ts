/**
 * `GET /api/v1/health`: is this deployment alive, and which one is it. The post-deploy smoke
 * (apps/e2e, docs/testing.md) asserts `commit` equals the commit it just deployed: deploys pass
 * `wrangler deploy --tag <sha>` and the version metadata binding hands the tag back. A failing
 * D1 read answers 503, so the smoke (and its automatic rollback) sees a broken binding.
 */
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { type ApiApp, json } from "./common.js";

export const HEALTH_PATH = "/api/v1/health";

export const HealthSchema = z.object({
  ok: z.boolean().describe("True when the database answered"),
  version: z.string().describe("Worker version id (the same as the x-gittifacts-version header)"),
  commit: z
    .string()
    .nullable()
    .describe("The git commit this version was deployed from (its version tag), when known"),
  deployedAt: z.string().nullable().describe("When this version was created"),
  db: z.enum(["ok", "error"]),
});

const route = createRoute({
  method: "get",
  path: HEALTH_PATH,
  tags: ["meta"],
  summary: "Liveness and the deployed version and commit, no auth",
  responses: {
    200: json(HealthSchema, "Healthy"),
    503: json(HealthSchema, "The database did not answer"),
  },
});

export function registerHealthRoutes(app: ApiApp): void {
  app.openapi(route, async (c) => {
    let db: "ok" | "error" = "ok";
    try {
      await c.env.DB.prepare("SELECT 1").first();
    } catch {
      db = "error";
    }
    const v = c.env.VERSION;
    const body = {
      ok: db === "ok",
      version: v?.id ?? "dev",
      commit: v?.tag ? v.tag : null,
      deployedAt: v?.timestamp ? v.timestamp : null,
      db,
    };
    return c.json(body, db === "ok" ? 200 : 503, { "cache-control": "no-store" });
  });
}
