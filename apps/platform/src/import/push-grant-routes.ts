/**
 * Import-by-push grant routes (src/import/push-grant.ts):
 *
 * - `GET    /api/v1/repos/{repoId}/import-grant`: its state (never the token), for readers.
 * - `POST   /api/v1/repos/{repoId}/import-grant`: (re-)open one for an empty project: human owner.
 * - `DELETE /api/v1/repos/{repoId}/import-grant`: close it now (revoke the token): human owner.
 *
 * Not idempotency-stored: a POST response holds a write token.
 */
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { ErrorSchema, RepoIdParam } from "../api/schemas.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { type ApiApp, errors, json, SECURITY } from "../routes/common.js";
import { requireRepo } from "../services/changes.js";
import { closeImportGrant, importGrantStatus, openImportGrant } from "./push-grant.js";
import { grantDeps } from "./push-grant-runtime.js";

const GrantViewSchema = z
  .object({
    repoId: z.string(),
    status: z.enum(["open", "closing", "closed"]),
    openedBy: z.string(),
    openedAt: z.string(),
    openUntil: z.string(),
    closeReason: z.enum(["pushed", "change-started", "expired", "closed-by-owner"]).nullable(),
    closedAt: z.string().nullable(),
    mainSha: z.string().nullable().describe("The default branch's head when the grant closed"),
    imported: z.boolean().describe("Closed with the default branch present"),
  })
  .openapi("ImportGrantStatus");

const GrantSchema = z.object({
  url: z.string(),
  branch: z.string(),
  token: z.string(),
  expiresAt: z.string(),
  command: z.string(),
  closesWhen: z.string(),
});

const status = createRoute({
  method: "get",
  path: "/api/v1/repos/{repoId}/import-grant",
  tags: ["repos"],
  summary: "The project's import-by-push grant (state only, never the token)",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: { params: RepoIdParam },
  responses: {
    200: json(z.object({ grant: GrantViewSchema.nullable() }), "Grant state (null: none)"),
    ...errors(401, 403, 404),
  },
});

const open = createRoute({
  method: "post",
  path: "/api/v1/repos/{repoId}/import-grant",
  tags: ["repos"],
  summary: "Open a new import-by-push grant for a project that has no default branch yet",
  description:
    "Human owners only. A live grant is closed (its token revoked) first. 409 `already-imported` once the default branch exists: from then on only the merge queue writes it.",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:admin"], { humanOnly: true, need: "admin" })] as const,
  request: { params: RepoIdParam },
  responses: {
    201: json(z.object({ grant: GrantSchema, status: GrantViewSchema }), "Opened"),
    ...errors(401, 403, 404, 409, 502),
    503: json(ErrorSchema, "The previous grant's revocation is not confirmed yet: retry"),
  },
});

const close = createRoute({
  method: "delete",
  path: "/api/v1/repos/{repoId}/import-grant",
  tags: ["repos"],
  summary: "Close the import-by-push grant now (revokes its token)",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:admin"], { humanOnly: true, need: "admin" })] as const,
  request: { params: RepoIdParam },
  responses: {
    200: json(z.object({ grant: GrantViewSchema.nullable() }), "Closed (or closing)"),
    ...errors(401, 403, 404),
  },
});

export function registerImportGrantRoutes(app: ApiApp): void {
  app.openapi(status, async (c) => {
    const svc = c.get("services");
    const repo = await requireRepo(svc, c.req.valid("param").repoId);
    return c.json({ grant: await importGrantStatus(grantDeps(svc), repo) }, 200);
  });
  app.openapi(open, async (c) => {
    const svc = c.get("services");
    const repo = await requireRepo(svc, c.req.valid("param").repoId);
    const { grant, view } = await openImportGrant(grantDeps(svc), callerOf(c).principal, repo);
    return c.json({ grant, status: view }, 201);
  });
  app.openapi(close, async (c) => {
    const svc = c.get("services");
    const caller = callerOf(c);
    const repo = await requireRepo(svc, c.req.valid("param").repoId);
    const view = await closeImportGrant(
      grantDeps(svc),
      repo,
      caller.principal.id,
      "closed-by-owner",
    );
    return c.json({ grant: view }, 200);
  });
}
