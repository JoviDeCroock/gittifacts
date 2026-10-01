import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import {
  ApprovePlanBody,
  ChangeSchema,
  IdempotencyHeaders,
  PlanDraftBody,
  PlanIdParam,
  PlanSchema,
  PrincipalsMapSchema,
  RejectPlanBody,
} from "../api/schemas.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { idempotent } from "../idempotency.js";
import { approvePlan, createPlan, getPlanDetail, rejectPlan } from "../services/plans.js";
import { type ApiApp, body, errors, json, SECURITY } from "./common.js";

const create = createRoute({
  method: "post",
  path: "/api/v1/plans",
  tags: ["plans"],
  summary: "Draft a plan (intent, acceptance criteria, scope)",
  security: SECURITY,
  middleware: [requirePrincipal(["plan:create"]), idempotent()] as const,
  request: { headers: IdempotencyHeaders, body: body(PlanDraftBody) },
  responses: {
    201: json(z.object({ plan: PlanSchema }), "Created"),
    ...errors(400, 401, 403, 404, 409),
  },
});

const detail = createRoute({
  method: "get",
  path: "/api/v1/plans/{planId}",
  tags: ["plans"],
  summary: "A plan and the changes that implement it",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: { params: PlanIdParam },
  responses: {
    200: json(
      z.object({
        plan: PlanSchema,
        changes: z.array(ChangeSchema),
        principals: PrincipalsMapSchema,
      }),
      "Plan",
    ),
    ...errors(401, 403, 404),
  },
});

const approve = createRoute({
  method: "post",
  path: "/api/v1/plans/{planId}/approve",
  tags: ["plans"],
  summary: "Approve a draft plan (human, plan:approve, not the author); signs the approval",
  security: SECURITY,
  middleware: [requirePrincipal(["plan:approve"], { humanOnly: true }), idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: PlanIdParam, body: body(ApprovePlanBody) },
  responses: {
    200: json(z.object({ plan: PlanSchema }), "Approved"),
    ...errors(400, 401, 403, 404, 409),
  },
});

const reject = createRoute({
  method: "post",
  path: "/api/v1/plans/{planId}/reject",
  tags: ["plans"],
  summary: "Reject a draft plan (human, plan:approve; the author may withdraw)",
  security: SECURITY,
  middleware: [requirePrincipal(["plan:approve"], { humanOnly: true }), idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: PlanIdParam, body: body(RejectPlanBody) },
  responses: {
    200: json(z.object({ plan: PlanSchema }), "Rejected"),
    ...errors(400, 401, 403, 404, 409),
  },
});

export function registerPlanRoutes(app: ApiApp): void {
  app.openapi(create, async (c) => {
    const plan = await createPlan(c.get("services"), callerOf(c), c.req.valid("json"));
    return c.json({ plan }, 201);
  });
  app.openapi(detail, async (c) =>
    c.json(await getPlanDetail(c.get("services"), c.req.valid("param").planId), 200),
  );
  app.openapi(approve, async (c) => {
    const plan = await approvePlan(
      c.get("services"),
      callerOf(c),
      c.req.valid("param").planId,
      c.req.valid("json"),
    );
    return c.json({ plan }, 200);
  });
  app.openapi(reject, async (c) => {
    const plan = await rejectPlan(
      c.get("services"),
      callerOf(c),
      c.req.valid("param").planId,
      c.req.valid("json"),
    );
    return c.json({ plan }, 200);
  });
}
