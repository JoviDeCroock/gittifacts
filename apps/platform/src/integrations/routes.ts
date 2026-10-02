/**
 * Every external-integration route (docs/prompts/04-integrations.md), mounted by src/app.ts:
 * developer portal, install screen + installed integrations, deployments and the read-only git
 * proxy. The OAuth protocol endpoints themselves stay in src/oauth/routes.ts, which hands
 * integration clients (`client_id` = `gtic_…`) to ./install.ts and ./tokens.ts. The integrator
 * guide is static markdown in packages/docs/content/guides/integrations/.
 */
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { IdempotencyHeaders, RepoIdParam } from "../api/schemas.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { idempotent } from "../idempotency.js";
import { type ApiApp, body, errors, json, SECURITY } from "../routes/common.js";
import {
  addDeploymentStatus,
  createDeployment,
  DeploymentInput,
  DeploymentListQuery,
  DeploymentStatusInput,
  DeploymentViewSchema,
  getDeployment,
  listDeployments,
} from "./deployments.js";
import { GIT_PREFIX, handleGit } from "./git-proxy.js";
import { registerInstallRoutes } from "./routes-install.js";
import { registerPortalRoutes } from "./routes-portal.js";

const TAG = ["deployments"];
const DeploymentParam = z.object({ deploymentId: z.string().min(1).max(64) });
const One = z.object({ deployment: DeploymentViewSchema });
const INTEGRATION_ONLY = [{ Bearer: [] }];

const create = createRoute({
  method: "post",
  path: "/api/v1/repos/{repoId}/deployments",
  tags: TAG,
  security: INTEGRATION_ONLY,
  summary: "Integrations: report a deployment of a commit (preview of a Change, or production)",
  description:
    "Integration token with deployments:write, on a repo of its installation (never an unclaimed project). changeId ties a preview to its Change; production deployments are matched to the merged Change by sha.",
  middleware: [requirePrincipal(["deployments:write"]), idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: RepoIdParam, body: body(DeploymentInput) },
  responses: { 201: json(One, "Created"), ...errors(400, 401, 403, 404) },
});
const status = createRoute({
  method: "post",
  path: "/api/v1/deployments/{deploymentId}/statuses",
  tags: TAG,
  security: INTEGRATION_ONLY,
  summary:
    "Integrations: report a deployment's state (queued, in_progress, success, failure, error) with its URL and log",
  description:
    "A successful preview becomes a signed `preview` evidence item on its Change (informational: it never lowers a lane). Production deployments appear in the Change's rollout timeline; failures with their log link.",
  middleware: [requirePrincipal(["deployments:write"]), idempotent()] as const,
  request: {
    headers: IdempotencyHeaders,
    params: DeploymentParam,
    body: body(DeploymentStatusInput),
  },
  responses: { 201: json(One, "Recorded"), ...errors(400, 401, 403, 404) },
});
const get = createRoute({
  method: "get",
  path: "/api/v1/deployments/{deploymentId}",
  tags: TAG,
  security: SECURITY,
  summary: "A deployment with its status history",
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: { params: DeploymentParam },
  responses: { 200: json(One, "Deployment"), ...errors(401, 403, 404) },
});
const list = createRoute({
  method: "get",
  path: "/api/v1/repos/{repoId}/deployments",
  tags: TAG,
  security: SECURITY,
  summary: "Deployments reported for a repo (newest first)",
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: { params: RepoIdParam, query: DeploymentListQuery },
  responses: {
    200: json(z.object({ deployments: z.array(DeploymentViewSchema) }), "Deployments"),
    ...errors(401, 403, 404),
  },
});

function registerGitDocs(app: ApiApp): void {
  const params = z.object({
    owner: z.string().describe("The repo owner's handle"),
    repo: z.string().describe("The repo name"),
  });
  const auth = {
    401: { description: "No or bad credential (WWW-Authenticate: Basic)" },
    403: { description: "Missing contents:read / repo:read, or git-receive-pack (always refused)" },
    404: { description: "Unknown repo, or not in your grant" },
  };
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/git/{owner}/{repo}.git/info/refs",
    tags: ["git"],
    summary: "Git smart HTTP ref advertisement (service=git-upload-pack only; read-only)",
    description:
      "Basic `x-access-token:<token>` or Bearer. Integration tokens need contents:read; agent tokens repo:read. A Change's fork: /git/{owner}/{repo}/changes/{changeId}.git/…",
    security: [{ Bearer: [] }],
    request: { params, query: z.object({ service: z.literal("git-upload-pack") }) },
    responses: { 200: { description: "application/x-git-upload-pack-advertisement" }, ...auth },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/git/{owner}/{repo}.git/git-upload-pack",
    tags: ["git"],
    summary: "Git smart HTTP upload-pack (clone/fetch), streamed from the Artifacts remote",
    security: [{ Bearer: [] }],
    request: { params },
    responses: { 200: { description: "application/x-git-upload-pack-result" }, ...auth },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/git/{owner}/{repo}.git/git-receive-pack",
    tags: ["git"],
    summary: "Always 403: nothing pushes through the integration git endpoint",
    request: { params },
    responses: { 403: { description: '`{ error: { code: "read-only", message, fix } }`' } },
  });
}

export function registerIntegrationRoutes(app: ApiApp): void {
  registerPortalRoutes(app);
  registerInstallRoutes(app);
  app.openapi(create, async (c) =>
    c.json(
      {
        deployment: await createDeployment(
          c.get("services"),
          callerOf(c),
          c.req.valid("param").repoId,
          c.req.valid("json"),
        ),
      },
      201,
    ),
  );
  app.openapi(status, async (c) =>
    c.json(
      {
        deployment: await addDeploymentStatus(
          c.get("services"),
          callerOf(c),
          c.req.valid("param").deploymentId,
          c.req.valid("json"),
        ),
      },
      201,
    ),
  );
  app.openapi(get, async (c) =>
    c.json(
      {
        deployment: await getDeployment(
          c.get("services"),
          callerOf(c),
          c.req.valid("param").deploymentId,
        ),
      },
      200,
    ),
  );
  app.openapi(list, async (c) =>
    c.json(
      {
        deployments: await listDeployments(
          c.get("services"),
          c.req.valid("param").repoId,
          c.req.valid("query"),
        ),
      },
      200,
    ),
  );
  app.on(["GET", "POST", "HEAD", "PUT", "DELETE"], `${GIT_PREFIX}*`, handleGit);
  registerGitDocs(app);
}
