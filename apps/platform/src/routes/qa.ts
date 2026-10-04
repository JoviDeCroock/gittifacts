/**
 * QA on request (docs/research/agentic-qa.md): ask for a run, list a change's runs, and the signed
 * thumbnail route GitHub's image proxy fetches (no session; a 72-hour HMAC instead).
 */

import { QaRun } from "@app/evidence";
import { createRoute } from "@hono/zod-openapi";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { ChangeIdParam, IdempotencyHeaders } from "../api/schemas.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { idempotent } from "../idempotency.js";
import { verifyQaImage } from "../qa/images.js";
import { QaStore, viewOf } from "../qa/store.js";
import { listQaRuns, requestQaFor } from "../services/qa.js";
import { type ApiApp, body, errors, json, SECURITY } from "./common.js";

export const QaRunViewSchema = z
  .object({
    id: z.string(),
    changeId: z.string(),
    repoId: z.string(),
    headSha: z.string(),
    status: z.enum(["queued", "running", "done", "failed"]),
    trigger: z.enum(["platform", "mcp", "cli", "github-check", "github-comment"]),
    requestedBy: z.string(),
    requestedLogin: z.string().nullable(),
    progress: z.string().nullable(),
    summary: z
      .object({ passed: z.number(), failed: z.number(), couldntTest: z.number() })
      .nullable(),
    laneBefore: z.number().nullable(),
    laneAfter: z.number().nullable(),
    costUsd: z.number().nullable(),
    wallMs: z.number().nullable(),
    error: z.string().nullable(),
    withdrawn: z.array(z.object({ reviewId: z.string(), reviewerId: z.string(), name: z.string() })).describe("Approvals this run withdrew (a failed criterion)"),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    report: QaRun.nullable().describe(
      "The signed qa-run item: criteria, verdicts, steps and artifact refs (GET /api/v1/blobs/{ref})",
    ),
  })
  .openapi("QaRunView");

const QaRequestBody = z.object({
  force: z.boolean().optional().describe("Run again although this head already has a finished run"),
  via: z
    .enum(["platform", "cli"])
    .optional()
    .describe("Who is asking (the web app or the CLI); default platform"),
});

const request = createRoute({
  method: "post",
  path: "/api/v1/changes/{changeId}/qa",
  tags: ["changes"],
  summary: "Ask for QA in a browser on the current head (on request only; idempotent per head)",
  description:
    "An agent drives the app built from the head in a real browser against the Plan's acceptance criteria, with a screenshot per step, a replay GIF and a pass / fail / couldn't-test verdict per criterion, signed into the evidence. A failure raises the lane; nothing lowers it. Needs green CI on the head; at most 6 runs an hour and 30 a day per repo.",
  security: SECURITY,
  middleware: [requirePrincipal([], { need: "read" }), idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: ChangeIdParam, body: body(QaRequestBody) },
  responses: {
    202: json(
      z.object({ run: QaRunViewSchema, reused: z.boolean() }),
      "Started, or the head's existing run",
    ),
    ...errors(400, 401, 403, 404, 409, 429, 502, 503),
  },
});

const list = createRoute({
  method: "get",
  path: "/api/v1/changes/{changeId}/qa",
  tags: ["changes"],
  summary: "The change's QA runs, newest first",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: { params: ChangeIdParam },
  responses: {
    200: json(z.object({ runs: z.array(QaRunViewSchema) }), "QA runs"),
    ...errors(401, 403, 404),
  },
});

export function registerQaRoutes(app: ApiApp): void {
  app.openapi(request, async (c) => {
    const { force, via } = c.req.valid("json");
    const out = await requestQaFor(c.get("services"), callerOf(c), c.req.valid("param").changeId, {
      ...(force === true ? { force } : {}),
      trigger: via ?? "platform",
    });
    return c.json(out, 202);
  });
  app.openapi(list, async (c) => {
    const runs = await listQaRuns(c.get("services"), callerOf(c), c.req.valid("param").changeId);
    return c.json({ runs }, 200);
  });

  // Signed thumbnails for GitHub's image proxy: only a run's `thumb` artifacts, only while signed.
  app.get("/qa-img/:runId/:name", async (c) => {
    const { runId, name } = c.req.param();
    const env = c.env;
    const check = await verifyQaImage(
      env.BETTER_AUTH_SECRET,
      runId,
      name,
      c.req.query("exp"),
      c.req.query("sig"),
      Date.now(),
    );
    if (check !== "ok")
      return c.text(
        check === "expired"
          ? "This QA thumbnail link expired. Open the QA report on gittifacts."
          : "Not found",
        check === "expired" ? 410 : 404,
      );
    const row = await new QaStore(drizzle(env.DB)).get(runId);
    const art =
      row === null
        ? undefined
        : viewOf(row).report?.artifacts.find((a) => a.name === name && a.role === "thumb");
    const obj = art === undefined ? null : await env.BLOBS.get(art.ref);
    if (obj === null) return c.text("Not found", 404);
    return new Response(obj.body, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, nofollow",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  });
}
