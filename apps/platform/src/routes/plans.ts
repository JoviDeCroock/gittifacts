import { pageUrl } from "@app/conventions";
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import {
  ApprovePlanBody,
  AttemptsSchema,
  ChangeIdParam,
  PickAttemptBody,
  PickAttemptResult,
  ChangeSchema,
  IdempotencyHeaders,
  PlanDraftBody,
  PlanIdParam,
  PlanSchema,
  PrincipalsMapSchema,
  RejectPlanBody,
  WithdrawPlanBody,
} from "../api/schemas.js";
import { callerOf, type HumanOnlyFix, requirePrincipal } from "../auth/middleware.js";
import { idempotent } from "../idempotency.js";
import { compareAttempts } from "../services/attempts.js";
import { pickAttempt } from "../services/attempts-pick.js";
import {
  approvePlan,
  createPlan,
  getPlanDetail,
  rejectPlan,
  withdrawPlan,
} from "../services/plans.js";
import { type ApiApp, body, errors, json, SECURITY } from "./common.js";

/** An agent at approve: a person approves the plan on its page; the agent checks with get_plan. */
const askToApprove: HumanOnlyFix = (c, origin) => {
  const planId = c.req.param("planId") ?? "<planId>";
  return {
    explanation: `Only a person approves a plan; agents never can (their own or anyone's). Ask a person to approve it at ${pageUrl(origin, { planId })}, then check its status with get_plan.`,
    call: `get_plan({ planId: "${planId}" })`,
  };
};

/** An agent at reject: its own draft it withdraws; anyone else's a person rejects. */
const withdrawOrAsk: HumanOnlyFix = (c, origin) => {
  const planId = c.req.param("planId") ?? "<planId>";
  return {
    explanation: `Only a person rejects a plan. If you drafted it, withdraw it yourself (POST /api/v1/plans/${planId}/withdraw or the call below); otherwise ask a person at ${pageUrl(origin, { planId })}.`,
    call: `withdraw_plan({ planId: "${planId}", reason: "<why>" })`,
  };
};

/** An agent at pick: picking approves a Change, which only a person does. */
const askToPick: HumanOnlyFix = (c, origin) => {
  const planId = c.req.param("planId") ?? "<planId>";
  return {
    explanation: `Only a person picks an attempt: picking approves that change, and agents never approve one (their own or another's). Ask a person to pick on the plan's page at ${pageUrl(origin, { planId })}; compare_attempts shows the ranking and which one is recommended.`,
    call: `compare_attempts({ planId: "${planId}" })`,
  };
};

const attempts = createRoute({
  method: "get",
  path: "/api/v1/plans/{planId}/attempts",
  tags: ["plans"],
  summary:
    "Every change attempting this plan, ranked by evidence and lane, with the recommended one",
  description:
    "Several agents may attempt the same approved plan. Ranked best first by: finished and green before the rest (still grading never ranks above finished), lane, tests, CI, red/green proof, scope drift, coverage, mutation, public API, diff size (smaller wins), time to green. Anything not measured ranks below measured. `recommended` is the best finished green attempt (provisional when nothing has finished). The newest 20 changes on the plan.",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: { params: PlanIdParam },
  responses: { 200: json(AttemptsSchema, "Attempts"), ...errors(401, 403, 404) },
});

const pick = createRoute({
  method: "post",
  path: "/api/v1/plans/{planId}/attempts/{changeId}/pick",
  tags: ["plans"],
  summary:
    "Pick one attempt (human, change:review, not its author): approves it, closes the others",
  description:
    "Approves the change through the normal review path (binds to `headSha`, or the current head; the change must be awaiting review, or already approved) and closes every other open change on the plan as superseded; their agents' wait_for_change answers `superseded`. One pick per plan (409 `already-picked`); the plan must be approved. Audited as `plan.attempt-picked` and `change.superseded`.",
  security: SECURITY,
  middleware: [
    requirePrincipal(["change:review"], { humanOnly: askToPick }),
    idempotent(),
  ] as const,
  request: {
    headers: IdempotencyHeaders,
    params: PlanIdParam.merge(ChangeIdParam),
    body: body(PickAttemptBody),
  },
  responses: {
    200: json(PickAttemptResult, "Picked"),
    ...errors(400, 401, 403, 404, 409, 502),
  },
});

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
  middleware: [
    requirePrincipal(["plan:approve"], { humanOnly: askToApprove }),
    idempotent(),
  ] as const,
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
  summary: "Reject a draft plan (human maintainer or owner; the author may withdraw)",
  security: SECURITY,
  // `read` here: rejectPlan decides (approve, or contribute for the author's own draft).
  middleware: [
    requirePrincipal(["plan:approve"], { humanOnly: withdrawOrAsk, need: "read" }),
    idempotent(),
  ] as const,
  request: { headers: IdempotencyHeaders, params: PlanIdParam, body: body(RejectPlanBody) },
  responses: {
    200: json(z.object({ plan: PlanSchema }), "Rejected"),
    ...errors(400, 401, 403, 404, 409),
  },
});

const withdraw = createRoute({
  method: "post",
  path: "/api/v1/plans/{planId}/withdraw",
  tags: ["plans"],
  summary: "Withdraw a draft plan you drafted (its author only, agents included)",
  security: SECURITY,
  // `read` here: withdrawPlan checks the author, then contribute on the plan's repo.
  middleware: [requirePrincipal(["plan:create"], { need: "read" }), idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: PlanIdParam, body: body(WithdrawPlanBody) },
  responses: {
    200: json(z.object({ plan: PlanSchema }), "Withdrawn"),
    ...errors(400, 401, 403, 404, 409),
  },
});

export function registerPlanRoutes(app: ApiApp): void {
  app.openapi(create, async (c) => {
    const plan = await createPlan(c.get("services"), callerOf(c), c.req.valid("json"));
    return c.json({ plan }, 201);
  });
  app.openapi(detail, async (c) =>
    c.json(await getPlanDetail(c.get("services"), callerOf(c), c.req.valid("param").planId), 200),
  );
  app.openapi(attempts, async (c) =>
    c.json(await compareAttempts(c.get("services"), callerOf(c), c.req.valid("param").planId), 200),
  );
  app.openapi(pick, async (c) => {
    const { planId, changeId } = c.req.valid("param");
    const out = await pickAttempt(
      c.get("services"),
      callerOf(c),
      planId,
      changeId,
      c.req.valid("json"),
      c.req.valid("header")["idempotency-key"],
    );
    return c.json(out, 200);
  });
  app.openapi(approve, async (c) => {
    const plan = await approvePlan(
      c.get("services"),
      callerOf(c),
      c.req.valid("param").planId,
      c.req.valid("json"),
    );
    return c.json({ plan }, 200);
  });
  app.openapi(withdraw, async (c) => {
    const plan = await withdrawPlan(
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
