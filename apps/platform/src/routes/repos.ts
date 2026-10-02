import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import {
  ChangeListQuery,
  ChangeSummarySchema,
  CreateRepoBody,
  DeployTargetBody,
  IdempotencyHeaders,
  Lane0Body,
  LaneCountsSchema,
  PlanSchema,
  PrincipalsMapSchema,
  parseStatusList,
  RepoIdParam,
  RepoSchema,
  RepoSummarySchema,
  ShadowStatsSchema,
} from "../api/schemas.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { filterRepos } from "../auth/repo-scope.js";
import { idempotent } from "../idempotency.js";
import { listChangeSummaries } from "../services/changes.js";
import { listPlans } from "../services/plans.js";
import {
  createRepo,
  getRepoDetail,
  listRepoSummaries,
  setDeployTarget,
  setLane0,
} from "../services/repos.js";
import { type ApiApp, body, errors, json, SECURITY } from "./common.js";

const list = createRoute({
  method: "get",
  path: "/api/v1/repos",
  tags: ["repos"],
  summary: "Repos with lane counts and shadow-mode stats",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read"])] as const,
  responses: {
    200: json(z.object({ repos: z.array(RepoSummarySchema) }), "Repos"),
    ...errors(401, 403),
  },
});

const create = createRoute({
  method: "post",
  path: "/api/v1/repos",
  tags: ["repos"],
  summary: "Create a repo, or import one from a public https git URL",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:admin"]), idempotent()] as const,
  request: { headers: IdempotencyHeaders, body: body(CreateRepoBody) },
  responses: {
    201: json(z.object({ repo: RepoSchema }), "Created"),
    ...errors(400, 401, 403, 409, 502),
  },
});

const detail = createRoute({
  method: "get",
  path: "/api/v1/repos/{repoId}",
  tags: ["repos"],
  summary: "A repo with shadow-mode stats and lane counts",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: { params: RepoIdParam },
  responses: {
    200: json(
      z.object({ repo: RepoSchema, shadow: ShadowStatsSchema, counts: LaneCountsSchema }),
      "Repo",
    ),
    ...errors(401, 403, 404),
  },
});

const lane0 = createRoute({
  method: "patch",
  path: "/api/v1/repos/{repoId}/lane0",
  tags: ["repos"],
  summary: "Turn Lane 0 (auto-merge) on or off",
  description: "409 (threshold-not-met) unless the shadow-mode agreement threshold is met.",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:admin"], { humanOnly: true }), idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: RepoIdParam, body: body(Lane0Body) },
  responses: {
    200: json(z.object({ repo: RepoSchema }), "Updated"),
    ...errors(400, 401, 403, 404, 409, 502),
  },
});

const deployTarget = createRoute({
  method: "patch",
  path: "/api/v1/repos/{repoId}/deploy-target",
  tags: ["repos"],
  summary:
    "Set or clear the Worker merged Changes roll out to (human repo admin, claimed projects)",
  description:
    "The Worker is `gf-<repoId>-<script>` in the platform's account (namespaced, so a project can never target the platform's own Worker or another project's). The first rollout creates it with a workers.dev URL. 403 `unclaimed-limit` for unclaimed projects.",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:admin"], { humanOnly: true }), idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: RepoIdParam, body: body(DeployTargetBody) },
  responses: {
    200: json(
      z.object({
        repo: RepoSchema,
        script: z.string().nullable().describe("The Worker name rollouts deploy to"),
      }),
      "Updated",
    ),
    ...errors(400, 401, 403, 404),
  },
});

const plans = createRoute({
  method: "get",
  path: "/api/v1/repos/{repoId}/plans",
  tags: ["plans"],
  summary: "Plans of a repo, newest first",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: { params: RepoIdParam },
  responses: {
    200: json(z.object({ plans: z.array(PlanSchema) }), "Plans"),
    ...errors(401, 403, 404),
  },
});

const changes = createRoute({
  method: "get",
  path: "/api/v1/repos/{repoId}/changes",
  tags: ["changes"],
  summary: "Changes of a repo (with plan title and author), most recently updated first",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: { params: RepoIdParam, query: ChangeListQuery },
  responses: {
    200: json(
      z.object({ changes: z.array(ChangeSummarySchema), principals: PrincipalsMapSchema }),
      "Changes",
    ),
    ...errors(400, 401, 403, 404),
  },
});

export function registerRepoRoutes(app: ApiApp): void {
  app.openapi(list, async (c) =>
    c.json(
      { repos: filterRepos(callerOf(c).principal, await listRepoSummaries(c.get("services"))) },
      200,
    ),
  );
  app.openapi(create, async (c) => {
    const repo = await createRepo(c.get("services"), callerOf(c), c.req.valid("json"));
    return c.json({ repo }, 201);
  });
  app.openapi(detail, async (c) =>
    c.json(await getRepoDetail(c.get("services"), c.req.valid("param").repoId), 200),
  );
  app.openapi(lane0, async (c) => {
    const repo = await setLane0(
      c.get("services"),
      callerOf(c),
      c.req.valid("param").repoId,
      c.req.valid("json").enabled,
    );
    return c.json({ repo }, 200);
  });
  app.openapi(deployTarget, async (c) => {
    const result = await setDeployTarget(
      c.get("services"),
      callerOf(c),
      c.req.valid("param").repoId,
      c.req.valid("json").script,
    );
    return c.json(result, 200);
  });
  app.openapi(plans, async (c) =>
    c.json(await listPlans(c.get("services"), c.req.valid("param").repoId), 200),
  );
  app.openapi(changes, async (c) => {
    const q = c.req.valid("query");
    const list = await listChangeSummaries(c.get("services"), c.req.valid("param").repoId, {
      statuses: parseStatusList(q.status),
      lane: q.lane === undefined ? undefined : (Number(q.lane) as 0 | 1 | 2),
    });
    return c.json(list, 200);
  });
}
