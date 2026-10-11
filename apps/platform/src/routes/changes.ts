import { pageUrl } from "@app/conventions";
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { assertChangeAccess } from "../access/access.js";
import {
  AuditEventSchema,
  ChangeDiffSchema,
  ChangeIdParam,
  ChangeSchema,
  ClassifyResultApiSchema,
  CloseBody,
  EvidenceSchema,
  GitRemoteSchema,
  IdempotencyHeaders,
  KillBody,
  LinkedIssueSchema,
  OverlapReportSchema,
  PipelineRunSchema,
  PlanSchema,
  PrincipalsMapSchema,
  RequestReviewBody,
  RerunBody,
  ResolutionSchema,
  ReviewBody,
  ReviewDecisionSchema,
  RolloutPolicySchema,
  RolloutStateSchema,
  StartChangeBody,
  TourSchema,
  VerificationSchema,
} from "../api/schemas.js";
import { callerOf, type HumanOnlyFix, requirePrincipal } from "../auth/middleware.js";
import { idempotent } from "../idempotency.js";
import {
  closeChange,
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
  rerunChangeCi,
  startChange,
  submitReview,
} from "../services/changes.js";
import { changeEventStream } from "../services/events.js";
import { getChangeOverlaps } from "../services/overlaps.js";
import { type ApiApp, body, errors, json, SECURITY } from "./common.js";

const read = requirePrincipal(["repo:read"]);

const start = createRoute({
  method: "post",
  path: "/api/v1/changes",
  tags: ["changes"],
  summary: "Start a change: fork the repo and get a push token for the fork only",
  security: SECURITY,
  // Not stored by the idempotency middleware: the response holds a push token. The key is
  // forwarded to the coordinator, whose startChange is idempotent per (actor, key) and returns
  // the same change with a fresh grant.
  middleware: [requirePrincipal(["change:create"])] as const,
  request: { headers: IdempotencyHeaders, body: body(StartChangeBody) },
  responses: {
    201: json(
      z.object({
        change: ChangeSchema,
        remote: GitRemoteSchema,
        overlaps: OverlapReportSchema.nullable().describe(
          "Open Changes in the repo on the same Plan or paths (the body's `paths`, the Plan's scopePaths). Null: not checked; ask GET /api/v1/changes/{changeId}/overlaps",
        ),
      }),
      "Started",
    ),
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
  summary: "The reviewer agent's walkthrough (tour) for the current head",
  security: SECURITY,
  middleware: [read] as const,
  request: { params: ChangeIdParam },
  responses: {
    200: json(
      z.object({
        tour: TourSchema,
        stale: z
          .boolean()
          .describe(
            "The walkthrough was generated for an older head than the change's current one",
          ),
      }),
      "Tour",
    ),
    ...errors(401, 403, 404),
  },
});

/** An agent at review: a person reviews the change on its page; the agent asks for it. */
const askForReview: HumanOnlyFix = (c, origin) => {
  const changeId = c.req.param("changeId") ?? "<changeId>";
  return {
    explanation: `Only a person reviews a change; agents never approve one (their own or another's). Ask for a review: a person reviews it at ${pageUrl(origin, { changeId })}.`,
    call: `request_review({ changeId: "${changeId}" })`,
  };
};

/** An agent at the kill switch: a person uses it; an unmerged change the agent can close. */
const askToKill: HumanOnlyFix = (c, origin) => {
  const changeId = c.req.param("changeId") ?? "<changeId>";
  return {
    explanation: `Only a person uses the kill switch on a merged change; ask one at ${pageUrl(origin, { changeId })}. A change that has not merged you can close yourself.`,
    call: `close_change({ changeId: "${changeId}", reason: "<why>" })`,
  };
};

const review = createRoute({
  method: "post",
  path: "/api/v1/changes/{changeId}/review",
  tags: ["changes"],
  summary: "Review a change (human, change:review, not the author); binds to a head",
  security: SECURITY,
  middleware: [
    requirePrincipal(["change:review"], { humanOnly: askForReview }),
    idempotent(),
  ] as const,
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
  summary:
    "Ask for a human review of a change (author or its owner): recorded in the audit log, no message is sent; never approves",
  security: SECURITY,
  middleware: [requirePrincipal(["change:create"]), idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: ChangeIdParam, body: body(RequestReviewBody) },
  responses: {
    200: json(
      z.object({
        change: ChangeSchema,
        requested: z
          .boolean()
          .describe("Recorded (audit log); nobody receives a message: share the change's page"),
      }),
      "Requested",
    ),
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
    requirePrincipal(["change:review"], { humanOnly: askToKill, need: "approve" }),
    idempotent(),
  ] as const,
  request: { headers: IdempotencyHeaders, params: ChangeIdParam, body: body(KillBody) },
  responses: {
    200: json(z.object({ change: ChangeSchema }), "Killed"),
    ...errors(400, 401, 403, 404, 409, 502),
  },
});

// Author (or its owner) or a maintainer: the coordinator checks the role; the route only needs
// a caller who can see the change. Stored by the idempotency middleware (no secrets in either).
const rerun = createRoute({
  method: "post",
  path: "/api/v1/changes/{changeId}/rerun",
  tags: ["changes"],
  summary: "Re-run CI, evidence, lane and walkthrough on the current head (author or maintainer)",
  description:
    "No push needed: a fresh workflow instance and CI run for the same head (a flaky step). Only while the change is running, failing or awaiting review; audited as `change.rerun-requested`.",
  security: SECURITY,
  middleware: [requirePrincipal([], { need: "read" }), idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: ChangeIdParam, body: body(RerunBody) },
  responses: {
    202: json(
      z.object({
        change: ChangeSchema,
        headSha: z.string(),
        instanceId: z.string().describe("The workflow instance now running"),
        superseded: z.string().nullable().describe("The instance the re-run replaced"),
      }),
      "Re-run started",
    ),
    ...errors(400, 401, 403, 404, 409, 502),
  },
});

const close = createRoute({
  method: "post",
  path: "/api/v1/changes/{changeId}/close",
  tags: ["changes"],
  summary: "Close (abandon) a change that won't merge (author or maintainer)",
  description:
    "Stops its CI, takes it out of the merge queue and deletes its fork later. `reason` is audited (`change.abandoned`). Closing a closed change returns it unchanged; a merged change can't be closed (kill it instead).",
  security: SECURITY,
  middleware: [requirePrincipal([], { need: "read" }), idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: ChangeIdParam, body: body(CloseBody) },
  responses: {
    200: json(z.object({ change: ChangeSchema }), "Closed"),
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

const overlaps = createRoute({
  method: "get",
  path: "/api/v1/changes/{changeId}/overlaps",
  tags: ["changes"],
  summary: "Open Changes in the same repo that share this change's Plan or touch the same paths",
  description:
    "Compared on the change's diff at its current head (before a push: its Plan's scopePaths) against the changed paths of the newest open Changes. A change with nothing pushed yet is listed when it shares the Plan (`paths-unknown`); any other whose overlap can't be decided is in `unchecked`.",
  security: SECURITY,
  middleware: [read] as const,
  request: { params: ChangeIdParam },
  responses: {
    200: json(z.object({ changeId: z.string(), overlaps: OverlapReportSchema }), "Overlaps"),
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
  app.openapi(overlaps, async (c) => {
    const { changeId } = c.req.valid("param");
    const report = await getChangeOverlaps(c.get("services"), callerOf(c), changeId);
    return c.json({ changeId, overlaps: report }, 200);
  });
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
  app.openapi(rerun, async (c) => {
    const out = await rerunChangeCi(
      c.get("services"),
      callerOf(c),
      c.req.valid("param").changeId,
      c.req.valid("json").reason,
    );
    return c.json(out, 202);
  });
  app.openapi(close, async (c) => {
    const change = await closeChange(
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
