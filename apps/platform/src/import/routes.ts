/**
 * `POST /api/v1/repos/{repoId}/platform-config`: (re-)run import detection and propose
 * `.platform/*` + AGENTS.md as a Plan + Change a human approves (the HTTP twin of
 * `propose_platform_config`). `GET` returns the latest proposal without starting one.
 */
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { IdempotencyHeaders, RepoIdParam } from "../api/schemas.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { idempotent } from "../idempotency.js";
import { type ApiApp, body, errors, json, SECURITY } from "../routes/common.js";
import { latestProposal, proposePlatformConfig } from "./service.js";

const Detection = z.object({
  confidence: z.enum(["high", "medium", "low"]),
  packageManager: z.string(),
  testRunner: z.string().nullable(),
  workers: z.array(z.string()),
  uncertain: z.array(z.string()),
  buildScriptsNeedingApproval: z.array(z.string()),
});

export const ProposalSchema = z
  .object({
    proposalId: z.string(),
    repoId: z.string(),
    status: z.enum(["running", "proposed", "not-needed", "failed"]),
    baseSha: z.string().nullable(),
    planId: z.string().nullable(),
    changeId: z.string().nullable(),
    detection: Detection.nullable(),
    error: z.string().nullable(),
    startedAt: z.string(),
  })
  .openapi("PlatformConfigProposal");

const ProposeBody = z.object({
  rerun: z
    .boolean()
    .default(false)
    .describe("Detect again even if a proposal exists for this commit"),
  waitSec: z.number().int().min(0).max(50).default(0).describe("Wait this long for the result"),
});

const propose = createRoute({
  method: "post",
  path: "/api/v1/repos/{repoId}/platform-config",
  tags: ["repos"],
  summary: "Propose .platform/ci.ts, .platform/policy.ts and AGENTS.md from import detection",
  description:
    "Runs detection in a sandbox on the default branch and opens a draft Plan (authored by the platform, every doubt listed as a risk) plus a Change with the files on a fork. Lane 2: a human approves both; nothing is applied silently. Idempotent per default-branch commit unless `rerun`.",
  security: SECURITY,
  middleware: [requirePrincipal(["plan:create", "change:create"]), idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: RepoIdParam, body: body(ProposeBody) },
  responses: {
    202: json(z.object({ proposal: ProposalSchema }), "Started (or found); see `status`"),
    ...errors(400, 401, 403, 404, 409, 502),
  },
});

const latest = createRoute({
  method: "get",
  path: "/api/v1/repos/{repoId}/platform-config",
  tags: ["repos"],
  summary: "The repo's latest .platform proposal (null when none was made)",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: { params: RepoIdParam },
  responses: {
    200: json(z.object({ proposal: ProposalSchema.nullable() }), "Latest proposal"),
    ...errors(401, 403, 404),
  },
});

export function registerImportRoutes(app: ApiApp): void {
  app.openapi(propose, async (c) => {
    const { rerun, waitSec } = c.req.valid("json");
    const proposal = await proposePlatformConfig(c.get("services"), callerOf(c), {
      repoId: c.req.valid("param").repoId,
      rerun,
      waitSec,
    });
    return c.json({ proposal }, 202);
  });
  app.openapi(latest, async (c) =>
    c.json({ proposal: await latestProposal(c.get("services"), c.req.valid("param").repoId) }, 200),
  );
}
