import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { assertChangeAccess } from "../access/access.js";
import {
  AuditEventSchema,
  ChangeDiffSchema,
  ChangeIdParam,
  ChangeSchema,
  ClassifyResultApiSchema,
  EvidenceSchema,
  GitRemoteSchema,
  IdempotencyHeaders,
  KillBody,
  LinkedIssueSchema,
  PipelineRunSchema,
  PlanSchema,
  PrincipalsMapSchema,
  RequestReviewBody,
  ResolutionSchema,
  ReviewBody,
  ReviewDecisionSchema,
  RolloutPolicySchema,
  RolloutStateSchema,
  StartChangeBody,
  TourSchema,
  VerificationSchema,
} from "../api/schemas.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { idempotent } from "../idempotency.js";
import {
  getChangeDetail,
  getChangeDiff,
  getChangeEvidence,
  getChangeResolution,
  getChangeRollout,
  getChangeTour,
  killChange,
  listChangeIssues,
  listChangeReviews,
  refreshPushGrant,
  requestReview,
  startChange,
  submitReview,
} from "../services/changes.js";
import { changeEventStream } from "../services/events.js";
import { type ApiApp, body, errors, json, SECURITY } from "./common.js";

const read = requirePrincipal(["repo:read"]);

const start = createRoute({
  method: "post",
  path: "/api/v1/changes",
  tags: ["changes"],
  summary: "Start a change: fork the repo and get a push grant for the fork only",
  security: SECURITY,
  // Not stored by the idempotency middleware: the response holds a push token. The key is
  // forwarded to the coordinator, whose startChange is idempotent per (actor, key) and returns
  // the same change with a fresh grant.
  middleware: [requirePrincipal(["change:create"])] as const,
  request: { headers: IdempotencyHeaders, body: body(StartChangeBody) },
  responses: {
    201: json(z.object({ change: ChangeSchema, remote: GitRemoteSchema }), "Started"),
    ...errors(400, 401, 403, 404, 409, 502),
  },
});

const detail = createRoute({
  method: "get",
  path: "/api/v1/changes/{changeId}",
  tags: ["changes"],
  summary: "A change with its plan, pipeline runs and classification for the current head",
  security: SECURITY,
  middleware: [read] as const,
  request: { params: ChangeIdParam },
  responses: {
    200: json(
      z.object({
        change: ChangeSchema,
        plan: PlanSchema.nullable(),
        runs: z.array(PipelineRunSchema),
        classification: ClassifyResultApiSchema.nullable(),
        principals: PrincipalsMapSchema,
      }),
      "Change",
    ),
    ...errors(401, 403, 404),
  },
});

const token = createRoute({
  method: "post",
  path: "/api/v1/changes/{changeId}/token",
  tags: ["changes"],
  summary: "Fresh short-lived push token for the change's fork (author only)",
  security: SECURITY,
  // Minting a fresh grant is naturally safe to retry; grants are never stored.
  middleware: [requirePrincipal(["change:create"])] as const,
  request: { headers: IdempotencyHeaders, params: ChangeIdParam },
  responses: {
    200: json(z.object({ remote: GitRemoteSchema }), "Grant"),
    ...errors(401, 403, 404, 409, 502),
  },
});

const diff = createRoute({
  method: "get",
  path: "/api/v1/changes/{changeId}/diff",
  tags: ["changes"],
  summary: "Diff of the current head against the base",
  security: SECURITY,
  middleware: [read] as const,
  request: { params: ChangeIdParam },
  responses: { 200: json(z.object({ diff: ChangeDiffSchema }), "Diff"), ...errors(401, 403, 404) },
});

const evidence = createRoute({
  method: "get",
  path: "/api/v1/changes/{changeId}/evidence",
  tags: ["changes"],
  summary: "Signed evidence for the current head, re-verified against the platform keys",
  security: SECURITY,
  middleware: [read] as const,
  request: { params: ChangeIdParam },
  responses: {
    200: json(z.object({ evidence: EvidenceSchema, verification: VerificationSchema }), "Evidence"),
    ...errors(401, 403, 404),
  },
});

const tour = createRoute({
  method: "get",
  path: "/api/v1/changes/{changeId}/tour",
  tags: ["changes"],
  summary: "The reviewer agent's guided tour for the current head",
  security: SECURITY,
  middleware: [read] as const,
  request: { params: ChangeIdParam },
  responses: {
    200: json(
      z.object({
        tour: TourSchema,
        stale: z
          .boolean()
          .describe("The tour was generated for an older head than the change's current one"),
      }),
      "Tour",
    ),
    ...errors(401, 403, 404),
  },
});

const review = createRoute({
  method: "post",
  path: "/api/v1/changes/{changeId}/review",
  tags: ["changes"],
  summary: "Review a change (human, change:review, not the author); binds to a head",
  security: SECURITY,
  middleware: [requirePrincipal(["change:review"], { humanOnly: true }), idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: ChangeIdParam, body: body(ReviewBody) },
  responses: {
    200: json(z.object({ change: ChangeSchema }), "Reviewed"),
    ...errors(400, 401, 403, 404, 409, 502),
  },
});

const requestReviewRoute = createRoute({
  method: "post",
  path: "/api/v1/changes/{changeId}/request-review",
  tags: ["changes"],
  summary: "Ask for human attention on a change (author or its owner); notifies, never approves",
  security: SECURITY,
  middleware: [requirePrincipal(["change:create"]), idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: ChangeIdParam, body: body(RequestReviewBody) },
  responses: {
    200: json(z.object({ change: ChangeSchema, notified: z.boolean() }), "Requested"),
    ...errors(400, 401, 403, 404, 409),
  },
});

const reviews = createRoute({
  method: "get",
  path: "/api/v1/changes/{changeId}/reviews",
  tags: ["changes"],
  summary: "Human reviews of a change, oldest first (each bound to a head)",
  security: SECURITY,
  middleware: [read] as const,
  request: { params: ChangeIdParam },
  responses: {
    200: json(
      z.object({ reviews: z.array(ReviewDecisionSchema), principals: PrincipalsMapSchema }),
      "Reviews",
    ),
    ...errors(401, 403, 404),
  },
});

const resolution = createRoute({
  method: "get",
  path: "/api/v1/changes/{changeId}/resolution",
  tags: ["changes"],
  summary:
    "The merge queue's conflict resolution of this change (null when it needed none): what lands, what each side had",
  security: SECURITY,
  middleware: [read] as const,
  request: { params: ChangeIdParam },
  responses: {
    200: json(z.object({ resolution: ResolutionSchema.nullable() }), "Resolution"),
    ...errors(401, 403, 404),
  },
});

const rollout = createRoute({
  method: "get",
  path: "/api/v1/changes/{changeId}/rollout",
  tags: ["changes"],
  summary: "Rollout state and the change's audit timeline",
  security: SECURITY,
  middleware: [read] as const,
  request: { params: ChangeIdParam },
  responses: {
    200: json(
      z.object({
        rollout: RolloutStateSchema.nullable(),
        timeline: z.array(AuditEventSchema),
        policy: RolloutPolicySchema.describe(
          "Rollout policy from the change's base, not the repo's current one",
        ),
        policySha: z.string().nullable().describe("Default-branch sha the policy was read from"),
        principals: PrincipalsMapSchema,
      }),
      "Rollout",
    ),
    ...errors(401, 403, 404),
  },
});

const kill = createRoute({
  method: "post",
  path: "/api/v1/changes/{changeId}/kill",
  tags: ["changes"],
  summary: "Kill switch: flag off, roll back, open a revert change (human maintainer or owner)",
  security: SECURITY,
  middleware: [
    requirePrincipal(["change:review"], { humanOnly: true, need: "approve" }),
    idempotent(),
  ] as const,
  request: { headers: IdempotencyHeaders, params: ChangeIdParam, body: body(KillBody) },
  responses: {
    200: json(z.object({ change: ChangeSchema }), "Killed"),
    ...errors(400, 401, 403, 404, 409, 502),
  },
});

const issues = createRoute({
  method: "get",
  path: "/api/v1/changes/{changeId}/issues",
  tags: ["changes"],
  summary: "Workers Issues attributed to the change (or its rollout version)",
  security: SECURITY,
  middleware: [read] as const,
  request: { params: ChangeIdParam },
  responses: {
    200: json(z.object({ issues: z.array(LinkedIssueSchema) }), "Issues"),
    ...errors(401, 403, 404),
  },
});

export const CHANGE_EVENTS_PATH = "/api/v1/changes/:changeId/events";

export function registerChangeRoutes(app: ApiApp): void {
  // Server-Sent Events: the change every time it changes (see services/events.ts).
  app.get(CHANGE_EVENTS_PATH, read, async (c) => {
    const svc = c.get("services");
    const caller = callerOf(c);
    const changeId = c.req.param("changeId");
    await assertChangeAccess(svc, caller.principal, changeId, "read");
    return changeEventStream(svc, caller, changeId, {
      since: c.req.header("last-event-id") ?? c.req.query("since") ?? null,
      signal: c.req.raw.signal,
    });
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/api/v1/changes/{changeId}/events",
    tags: ["changes"],
    summary: "The change as Server-Sent Events, one `change` event per update",
    description:
      "`text/event-stream`. Each `change` event's data is `{ change }` and its id is the change version: reconnect with `Last-Event-ID` (or `?since=`) to resume. Comment lines are heartbeats. The stream ends after 15 minutes or once the change reaches a final status.",
    security: SECURITY,
    request: {
      params: ChangeIdParam,
      query: z.object({ since: z.string().optional().describe("Change version to resume after") }),
    },
    responses: {
      200: {
        description: "Event stream",
        content: { "text/event-stream": { schema: z.string() } },
      },
      ...errors(401, 403, 404),
    },
  });

  app.openapi(start, async (c) => {
    const out = await startChange(
      c.get("services"),
      callerOf(c),
      c.req.valid("json"),
      c.req.valid("header")["idempotency-key"],
    );
    return c.json(out, 201);
  });
  app.openapi(detail, async (c) =>
    c.json(
      await getChangeDetail(c.get("services"), callerOf(c), c.req.valid("param").changeId),
      200,
    ),
  );
  app.openapi(token, async (c) => {
    const remote = await refreshPushGrant(
      c.get("services"),
      callerOf(c),
      c.req.valid("param").changeId,
    );
    return c.json({ remote }, 200);
  });
  app.openapi(diff, async (c) =>
    c.json(
      { diff: await getChangeDiff(c.get("services"), callerOf(c), c.req.valid("param").changeId) },
      200,
    ),
  );
  app.openapi(evidence, async (c) =>
    c.json(
      await getChangeEvidence(c.get("services"), callerOf(c), c.req.valid("param").changeId),
      200,
    ),
  );
  app.openapi(tour, async (c) =>
    c.json(await getChangeTour(c.get("services"), callerOf(c), c.req.valid("param").changeId), 200),
  );
  app.openapi(reviews, async (c) =>
    c.json(
      await listChangeReviews(c.get("services"), callerOf(c), c.req.valid("param").changeId),
      200,
    ),
  );
  app.openapi(review, async (c) => {
    const change = await submitReview(
      c.get("services"),
      callerOf(c),
      c.req.valid("param").changeId,
      c.req.valid("json"),
      c.req.valid("header")["idempotency-key"],
    );
    return c.json({ change }, 200);
  });
  app.openapi(requestReviewRoute, async (c) => {
    const out = await requestReview(
      c.get("services"),
      callerOf(c),
      c.req.valid("param").changeId,
      c.req.valid("json").message,
    );
    return c.json(out, 200);
  });
  app.openapi(resolution, async (c) =>
    c.json(
      await getChangeResolution(c.get("services"), callerOf(c), c.req.valid("param").changeId),
      200,
    ),
  );
  app.openapi(rollout, async (c) =>
    c.json(
      await getChangeRollout(c.get("services"), callerOf(c), c.req.valid("param").changeId),
      200,
    ),
  );
  app.openapi(kill, async (c) => {
    const change = await killChange(
      c.get("services"),
      callerOf(c),
      c.req.valid("param").changeId,
      c.req.valid("json").reason,
    );
    return c.json({ change }, 200);
  });
  app.openapi(issues, async (c) =>
    c.json(
      {
        issues: await listChangeIssues(
          c.get("services"),
          callerOf(c),
          c.req.valid("param").changeId,
        ),
      },
      200,
    ),
  );
}
