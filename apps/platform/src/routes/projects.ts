/**
 * Projects (onboarding §3): `POST /api/v1/projects` (= the `create_project` MCP tool), the
 * time-to-first-green dashboard data (`GET /internal/ttfg`), and the template cache seeding
 * admin call (`POST /api/v1/admin/seed-cache`).
 */
import { TEMPLATE_IDS, TemplateId } from "@app/conventions";
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { isPlatformAuditor } from "../access/config.js";
import { ErrorSchema, IdempotencyHeaders } from "../api/schemas.js";
import { assertScopes, callerOf, requirePrincipal, resolveCaller } from "../auth/middleware.js";
import { assertRouteRepoAccess } from "../auth/repo-scope.js";
import { createUnclaimedProject } from "../claim/create.js";
import { unauthorized } from "../errors.js";
import { anonymousClient } from "../limits/client.js";
import { assertPlatformAdmin } from "../limits/routes.js";
import { ttfgFromAnalyticsEngine, ttfgFromD1, ttfgReport } from "../projects/onboarding.js";
import { engineFor, seedTemplateCaches } from "../projects/seed-cache.js";
import { seedGitHost } from "../projects/seed-on-deploy.js";
import { CreateProjectInput, createProject } from "../services/projects.js";
import { type ApiApp, body, errors, json, SECURITY } from "./common.js";

const NextStepSchema = z.object({
  title: z.string(),
  call: z.string().optional(),
  command: z.string().optional(),
  why: z.string().optional(),
});

export const ProjectCreatedSchema = z
  .object({
    repoId: z.string().optional().describe("The repo id: pass it as repoId everywhere else (always set since 2026-10-04)"),
    projectId: z.string().describe("Deprecated: the same value as repoId, kept for older clients"),
    name: z.string(),
    template: z.string().nullable(),
    defaultBranch: z.string(),
    remote: z
      .object({
        url: z.string(),
        username: z.string(),
        token: z.string(),
        expiresAt: z.string(),
        branch: z.string(),
        changeId: z.string(),
      })
      .nullable()
      .describe("Push token for your first Change's fork (at the initial commit)"),
    token: z
      .string()
      .nullable()
      .describe("Bearer token for unclaimed projects (O3); null for authenticated callers"),
    mcpUrl: z.string(),
    previewUrl: z
      .string()
      .nullable()
      .describe("Serves a 'building' page until the first CI run is green"),
    claimUrl: z.string().nullable(),
    bootstrapChangeId: z
      .string()
      .nullable()
      .describe("The Change running the first CI and preview: wait_for_change on it"),
    nextSteps: z.array(NextStepSchema),
    importGrant: z
      .object({
        url: z.string().describe("The project's main repo remote"),
        branch: z.string(),
        token: z
          .string()
          .describe("Artifacts write token for the main repo: one push, then revoked"),
        expiresAt: z.string(),
        command: z.string(),
        closesWhen: z.string(),
      })
      .optional()
      .describe(
        "importMode push only: the one-time grant to push the history (closes at the first push, the first Change or after 30 minutes)",
      ),
  })
  .meta({ id: "ProjectCreated" });

const create = createRoute({
  method: "post",
  path: "/api/v1/projects",
  tags: ["projects"],
  summary:
    "Create a project in one call: repo + .platform/* + AGENTS.md + first CI + first preview",
  description: `Template (${TEMPLATE_IDS.join(", ")}), import (\`from\`: a public https git URL), import by push (\`importMode: "push"\`: private repos; a signed-in human owner gets an empty project and a one-time \`importGrant\`, closed at the first push, the first Change or after 30 minutes) or empty. Returns at once; CI and the preview finish in the background (wait on \`bootstrapChangeId\`). Not stored by the idempotency middleware (the response holds a push grant): the key is forwarded, so a retry with the same Idempotency-Key returns the same project with a fresh grant.\n\n**No credentials needed**: without an Authorization header (and while the kill switch allows it) you get an *unclaimed* project, \`token\` (a Bearer token for that project only, valid until it expires) and \`claimUrl\` for a human. Unclaimed projects expire unless claimed and have hard limits (see /start). 429 \`rate-limited\` per IP, network or platform-wide; 503 \`creation-disabled\` when switched off. Without credentials an Idempotency-Key must be at least 16 characters.`,
  // Credentials are optional: none → an unclaimed project.
  security: [{}, ...SECURITY],
  request: {
    headers: IdempotencyHeaders,
    body: body(
      z.object({
        name: z.string().min(1).max(63).optional(),
        template: TemplateId.optional(),
        from: z.string().url().startsWith("https://").max(500).optional(),
        description: z.string().max(500).optional(),
        importMode: z
          .enum(["push"])
          .optional()
          .describe(
            "Private repos: an empty project and a one-time `importGrant` its human owner pushes the history with. Humans only (signed-in session).",
          ),
      }),
    ),
  },
  responses: {
    201: json(ProjectCreatedSchema, "Created"),
    ...errors(400, 401, 403, 409, 502),
    429: json(ErrorSchema, "Rate limited (unclaimed creation) or quota exceeded"),
    503: json(ErrorSchema, "Unclaimed creation is switched off (kill switch)"),
  },
});

const TtfgStatsSchema = z.object({
  projects: z.number(),
  finished: z.number(),
  green: z.number(),
  withinTarget: z.number(),
  p50Ms: z.number().nullable(),
  p90Ms: z.number().nullable(),
});

const ttfg = createRoute({
  method: "get",
  path: "/internal/ttfg",
  tags: ["internal"],
  summary: "Time-to-first-green per project and template (Analytics Engine, else D1)",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:admin"], { humanOnly: true })] as const,
  request: { query: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }) },
  responses: {
    200: json(
      z.object({
        source: z.enum(["analytics-engine", "d1"]),
        sinceDays: z.number(),
        targetMs: z.number(),
        overall: TtfgStatsSchema,
        byTemplate: z.array(TtfgStatsSchema.extend({ template: z.string() })),
        recent: z.array(
          z.object({
            projectId: z.string(),
            template: z.string().nullable(),
            outcome: z.string().nullable(),
            createdAt: z.string(),
            msToRespond: z.number().nullable(),
            msToGreen: z.number().nullable(),
            msToPreview: z.number().nullable(),
          }),
        ),
        note: z.string().nullable(),
      }),
      "Report",
    ),
    ...errors(401, 403),
  },
});

const seed = createRoute({
  method: "post",
  path: "/api/v1/admin/seed-cache",
  tags: ["internal"],
  summary: "Pre-build every template's dependency snapshot (CI global cache)",
  description:
    "Runs the CI engine's seedCache for each template (or `?template=<id>`), so the first project per template starts warm. Idempotent per template content.",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:admin"], { humanOnly: true })] as const,
  request: { query: z.object({ template: TemplateId.optional() }) },
  responses: {
    202: json(
      z.object({
        seeds: z.array(
          z.object({
            templateId: z.string(),
            repo: z.string(),
            sha: z.string(),
            runId: z.string().nullable(),
            error: z.string().nullable(),
          }),
        ),
      }),
      "Seed runs started",
    ),
    ...errors(401, 403),
  },
});

export function registerProjectRoutes(app: ApiApp): void {
  app.openapi(create, async (c) => {
    const input = CreateProjectInput.parse(c.req.valid("json"));
    const key = c.req.valid("header")["idempotency-key"];
    const caller = await resolveCaller(c);
    if (caller === null) {
      // Credentials that don't verify never fall back to an unclaimed project: say so.
      if (c.req.header("authorization") || c.req.header("cookie")?.includes("session_token")) {
        throw unauthorized("invalid, expired or revoked credentials");
      }
      const out = await createUnclaimedProject(
        c.get("services"),
        await anonymousClient(c.req.raw, c.env),
        input,
        key,
      );
      return c.json(out, 201);
    }
    assertScopes(caller, ["repo:read", "change:create"]);
    await assertRouteRepoAccess(c, caller);
    const out = await createProject(c.get("services"), caller, input, key);
    return c.json(out, 201);
  });

  app.openapi(ttfg, async (c) => {
    // Platform-wide metrics (every project's id and timings): platform admins and auditors only.
    const caller = callerOf(c);
    if (!isPlatformAuditor(caller.principal, c.env)) assertPlatformAdmin(caller, c.env);
    const { days } = c.req.valid("query");
    const svc = c.get("services");
    const since = new Date(svc.clock.now().getTime() - days * 86_400_000);
    const env = c.env;
    let note: string | null = null;
    if (env.CF_API_TOKEN) {
      try {
        const rows = await ttfgFromAnalyticsEngine(
          {
            accountId: env.CF_ACCOUNT_ID,
            apiToken: env.CF_API_TOKEN,
            dataset: env.METRICS_DATASET ?? "gittifacts_metrics",
          },
          days,
        );
        return c.json(ttfgReport(rows, "analytics-engine", days, null), 200);
      } catch (e) {
        note = `Analytics Engine unavailable (${e instanceof Error ? e.message : String(e)}); showing D1.`;
      }
    } else {
      note = "CF_API_TOKEN is not set; showing D1.";
    }
    return c.json(ttfgReport(await ttfgFromD1(svc.store, since), "d1", days, note), 200);
  });

  app.openapi(seed, async (c) => {
    assertPlatformAdmin(callerOf(c), c.env); // a platform-wide action, not a repo's
    const { template } = c.req.valid("query");
    // A seed commit per worker version: the cache key includes the runner image, which most
    // deploys rebuild, and the engine keys seed runs by sha (src/projects/seed-on-deploy.ts).
    const version = c.env.VERSION?.id;
    const seeds = await seedTemplateCaches(
      { git: seedGitHost(c.env), engine: engineFor(c.env), origin: c.get("services").origin },
      template === undefined ? undefined : [template],
      version === undefined ? {} : { refresh: version },
    );
    return c.json({ seeds }, 202);
  });
}
