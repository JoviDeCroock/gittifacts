/**
 * Merge-queue HTTP API (parity with the MCP tools, docs/prompts/03-merge-queue.md §5):
 *
 *   GET    /api/v1/repos/{repoId}/queue           queue_overview
 *   GET    /api/v1/repos/{repoId}/queue/events    SSE of the §5 events
 *   POST   /api/v1/repos/{repoId}/queue/freeze    human-signed freeze   (repo:admin, human)
 *   POST   /api/v1/repos/{repoId}/queue/thaw      human-signed thaw     (repo:admin, human)
 *   POST   /api/v1/repos/{repoId}/queue/resume    resume after a halt   (repo:admin, human)
 *   GET    /api/v1/changes/{changeId}/queue       queue_status
 *   POST   /api/v1/changes/{changeId}/queue       enqueue (options; admission stays the workflow's)
 *   PATCH  /api/v1/changes/{changeId}/queue       reprioritize
 *   DELETE /api/v1/changes/{changeId}/queue       dequeue
 *   GET    /api/v1/changes/{changeId}/queue/wait  wait_for_merge (long-poll ≤ 55 s)
 */
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { ChangeIdParam, IdempotencyHeaders, RepoIdParam } from "../api/schemas.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { idempotent } from "../idempotency.js";
import { type ApiApp, body, errors, json, SECURITY } from "../routes/common.js";
import { queueEventStream } from "./events.js";
import {
  EnqueueBody,
  EnqueueResultSchema,
  FreezeBody,
  QueueEntrySchema,
  QueueOverviewSchema,
  ReprioritizeBody,
  WaitForMergeSchema,
} from "./schemas.js";
import {
  dequeueChange,
  enqueueChange,
  queueOverview,
  queueStatus,
  reprioritizeChange,
  resumeQueue,
  setQueueFrozen,
  waitForMerge,
} from "./service.js";

const read = requirePrincipal(["repo:read"]);
const write = requirePrincipal(["change:create"]);
const admin = requirePrincipal(["repo:admin"], { humanOnly: true });

const overview = createRoute({
  method: "get",
  path: "/api/v1/repos/{repoId}/queue",
  tags: ["merge-queue"],
  summary: "The merge queue: tracks, batches, landing, freeze state, entries with reasons and ETAs",
  security: SECURITY,
  middleware: [read] as const,
  request: { params: RepoIdParam },
  responses: { 200: json(QueueOverviewSchema, "Overview"), ...errors(401, 403, 404) },
});

const status = createRoute({
  method: "get",
  path: "/api/v1/changes/{changeId}/queue",
  tags: ["merge-queue"],
  summary: "A Change's place in the merge queue (state, track, batch, position, ETA, why it waits)",
  security: SECURITY,
  middleware: [read] as const,
  request: { params: ChangeIdParam },
  responses: {
    200: json(z.object({ status: QueueEntrySchema.nullable() }), "Status (null: not queued)"),
    ...errors(401, 403, 404),
  },
});

const enqueue = createRoute({
  method: "post",
  path: "/api/v1/changes/{changeId}/queue",
  tags: ["merge-queue"],
  summary: "Enqueue options (priority, stack, plan group, land mode); the Change joins on approval",
  description:
    "Records the options and answers where the Change stands. It never bypasses review: a Change joins the queue when its workflow admits it (Lane 0 auto-merge, or a human approval); options given earlier apply then. The incident class needs a human or an approved incident Plan.",
  security: SECURITY,
  middleware: [write, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: ChangeIdParam, body: body(EnqueueBody) },
  responses: {
    200: json(EnqueueResultSchema, "Queued (or registered)"),
    ...errors(400, 401, 403, 404, 409),
  },
});

const reprioritize = createRoute({
  method: "patch",
  path: "/api/v1/changes/{changeId}/queue",
  tags: ["merge-queue"],
  summary: "Reprioritize a queued Change (incident needs a human or an approved incident Plan)",
  security: SECURITY,
  middleware: [write, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: ChangeIdParam, body: body(ReprioritizeBody) },
  responses: {
    200: json(z.object({ status: QueueEntrySchema.nullable() }), "Updated"),
    ...errors(400, 401, 403, 404, 409),
  },
});

const dequeue = createRoute({
  method: "delete",
  path: "/api/v1/changes/{changeId}/queue",
  tags: ["merge-queue"],
  summary: "Take a Change out of the merge queue (its stack dependents leave too)",
  security: SECURITY,
  middleware: [write, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: ChangeIdParam },
  responses: {
    200: json(z.object({ status: QueueEntrySchema.nullable(), removed: z.boolean() }), "Dequeued"),
    ...errors(401, 403, 404, 409),
  },
});

const wait = createRoute({
  method: "get",
  path: "/api/v1/changes/{changeId}/queue/wait",
  tags: ["merge-queue"],
  summary: "Long-poll until the Change merges, is ejected or dequeued, or the queue freezes",
  security: SECURITY,
  middleware: [read] as const,
  request: {
    params: ChangeIdParam,
    query: z.object({ timeoutSec: z.coerce.number().int().min(1).max(55).default(50) }),
  },
  responses: {
    200: json(WaitForMergeSchema, "Outcome (reason timeout: call again)"),
    ...errors(401, 403, 404),
  },
});

const freezeRoute = (frozen: boolean) =>
  createRoute({
    method: "post",
    path: `/api/v1/repos/{repoId}/queue/${frozen ? "freeze" : "thaw"}`,
    tags: ["merge-queue"],
    summary: frozen
      ? "Freeze the queue: only reverts and incident fixes land (human-signed audit event)"
      : "Thaw the queue; batches built on the bad main are invalidated (human-signed audit event)",
    security: SECURITY,
    middleware: [admin, idempotent()] as const,
    request: { headers: IdempotencyHeaders, params: RepoIdParam, body: body(FreezeBody) },
    responses: {
      200: json(z.object({ frozen: z.boolean() }), "Done"),
      ...errors(400, 401, 403, 404),
    },
  });

const resume = createRoute({
  method: "post",
  path: "/api/v1/repos/{repoId}/queue/resume",
  tags: ["merge-queue"],
  summary: "Resume a queue that halted on an invariant violation (after an operator checked it)",
  security: SECURITY,
  middleware: [admin] as const,
  request: { params: RepoIdParam },
  responses: { 200: json(z.object({ resumed: z.boolean() }), "Resumed"), ...errors(401, 403, 404) },
});

export const QUEUE_EVENTS_PATH = "/api/v1/repos/:repoId/queue/events";

export function registerQueueRoutes(app: ApiApp): void {
  app.get(QUEUE_EVENTS_PATH, read, async (c) =>
    queueEventStream(c.get("services"), c.req.param("repoId"), {
      since: c.req.header("last-event-id") ?? c.req.query("since") ?? null,
      ...(c.req.query("changeId") === undefined ? {} : { changeId: c.req.query("changeId") }),
      signal: c.req.raw.signal,
    }),
  );
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/api/v1/repos/{repoId}/queue/events",
    tags: ["merge-queue"],
    summary: "The merge queue's events as Server-Sent Events",
    description:
      "`text/event-stream`. One `queue` event per §5 event (entered_batch, resolving_conflict, resolution_ready, ejected, merged, deployed, flag_killed, frozen, thawed); `id` is its sequence number: reconnect with `Last-Event-ID` (or `?since=`) to resume. `?changeId=` filters to one Change. Heartbeat comments while quiet; the stream ends after 15 minutes.",
    security: SECURITY,
    request: {
      params: RepoIdParam,
      query: z.object({
        since: z.string().optional().describe("Sequence number to resume after"),
        changeId: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Event stream",
        content: { "text/event-stream": { schema: z.string() } },
      },
      ...errors(401, 403, 404),
    },
  });

  app.openapi(overview, async (c) =>
    c.json(await queueOverview(c.get("services"), c.req.valid("param").repoId), 200),
  );
  app.openapi(status, async (c) =>
    c.json({ status: await queueStatus(c.get("services"), c.req.valid("param").changeId) }, 200),
  );
  app.openapi(enqueue, async (c) => {
    const r = await enqueueChange(c.get("services"), callerOf(c), {
      changeId: c.req.valid("param").changeId,
      ...c.req.valid("json"),
    });
    const { ok: _ok, ...out } = r as typeof r & { ok?: true };
    return c.json(out, 200);
  });
  app.openapi(reprioritize, async (c) => {
    const r = await reprioritizeChange(c.get("services"), callerOf(c), {
      changeId: c.req.valid("param").changeId,
      ...c.req.valid("json"),
    });
    return c.json({ status: r.status }, 200);
  });
  app.openapi(dequeue, async (c) => {
    const r = await dequeueChange(c.get("services"), callerOf(c), c.req.valid("param").changeId);
    return c.json({ status: r.status, removed: r.removed }, 200);
  });
  app.openapi(wait, async (c) =>
    c.json(
      await waitForMerge(
        c.get("services"),
        c.req.valid("param").changeId,
        c.req.valid("query").timeoutSec * 1000,
      ),
      200,
    ),
  );
  for (const frozen of [true, false]) {
    app.openapi(freezeRoute(frozen), async (c) =>
      c.json(
        await setQueueFrozen(c.get("services"), callerOf(c), {
          repoId: c.req.valid("param").repoId,
          frozen,
          reason: c.req.valid("json").reason,
        }),
        200,
      ),
    );
  }
  app.openapi(resume, async (c) => {
    await resumeQueue(c.get("services"), callerOf(c), c.req.valid("param").repoId);
    return c.json({ resumed: true }, 200);
  });
}
