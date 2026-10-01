/**
 * Projects (onboarding §3): `POST /api/v1/projects` (= the `create_project` MCP tool), the
 * time-to-first-green dashboard data (`GET /internal/ttfg`), and the template cache seeding
 * admin call (`POST /api/v1/admin/seed-cache`).
 */
import { TEMPLATE_IDS, TemplateId } from "@app/conventions";
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { IdempotencyHeaders } from "../api/schemas.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { ttfgFromAnalyticsEngine, ttfgFromD1, ttfgReport } from "../projects/onboarding.js";
import { engineFor, seedTemplateCaches } from "../projects/seed-cache.js";
import { buildPorts } from "../runtime/ports.js";
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
    projectId: z.string().describe("The repo id: use it as repoId everywhere else"),
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
      .describe("Push grant for your first Change's fork (at the initial commit)"),
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
  })
  .meta({ id: "ProjectCreated" });

const create = createRoute({
  method: "post",
  path: "/api/v1/projects",
  tags: ["projects"],
  summary:
    "Create a project in one call: repo + .platform/* + AGENTS.md + first CI + first preview",
  description: `Template (${TEMPLATE_IDS.join(", ")}), import (\`from\`: a public https git URL) or empty. Returns at once; CI and the preview finish in the background (wait on \`bootstrapChangeId\`). Not stored by the idempotency middleware (the response holds a push grant): the key is forwarded, so a retry with the same Idempotency-Key returns the same project with a fresh grant.`,
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read", "change:create"])] as const,
  request: {
    headers: IdempotencyHeaders,
    body: body(
      z.object({
        name: z.string().min(1).max(63).optional(),
        template: TemplateId.optional(),
        from: z.string().url().startsWith("https://").max(500).optional(),
        description: z.string().max(500).optional(),
      }),
    ),
  },
  responses: {
    201: json(ProjectCreatedSchema, "Created"),
    ...errors(400, 401, 403, 409, 502),
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
    const out = await createProject(
      c.get("services"),
      callerOf(c),
      input,
      c.req.valid("header")["idempotency-key"],
    );
    return c.json(out, 201);
  });

  app.openapi(ttfg, async (c) => {
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
    const { template } = c.req.valid("query");
    const ports = buildPorts(c.env, "default");
    const seeds = await seedTemplateCaches(
      { git: ports.git, engine: engineFor(c.env), origin: c.get("services").origin },
      template === undefined ? undefined : [template],
    );
    return c.json({ seeds }, 202);
  });
}
