/**
 * Membership HTTP API:
 *
 *   GET    /api/v1/repos/{repoId}/members                 anyone who can read the repo
 *   POST   /api/v1/repos/{repoId}/members                 owner: add by e-mail/principal id, or change a role
 *   DELETE /api/v1/repos/{repoId}/members/{principalId}   owner; or a member leaving
 */
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { IdempotencyHeaders, RepoIdParam } from "../api/schemas.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { idempotent } from "../idempotency.js";
import { type ApiApp, body, errors, json, SECURITY } from "../routes/common.js";
import { addMember, listMembers, removeMember } from "./members.js";
import { REPO_ROLES } from "./roles.js";

export const RepoRoleSchema = z
  .enum(REPO_ROLES)
  .describe(
    "reader: read; reviewer: + review changes, its agents draft plans and start changes; maintainer: + approve plans, kill switch; owner: + members, deploy target, Lane 0",
  );

export const MemberSchema = z
  .object({
    principalId: z.string(),
    name: z.string(),
    email: z.string().nullable().describe("Shown to the repo's owners only"),
    role: RepoRoleSchema,
    addedBy: z.string(),
    addedAt: z.string(),
  })
  .meta({ id: "RepoMember" });

const MembersSchema = z.object({
  repoId: z.string(),
  members: z.array(MemberSchema),
  viewerRole: RepoRoleSchema.nullable(),
  canManage: z.boolean().describe("The caller may add, change and remove members"),
});

const AddMemberBody = z
  .object({
    email: z.string().email().max(320).optional().describe("A signed-up user's e-mail"),
    principalId: z.string().min(1).max(64).optional().describe("A human principal id (hu_…)"),
    role: RepoRoleSchema,
  })
  .refine((b) => (b.email === undefined) !== (b.principalId === undefined), {
    message: "pass exactly one of email or principalId",
    path: ["email"],
  });

const MemberParams = RepoIdParam.extend({ principalId: z.string().min(1).max(64) });

const list = createRoute({
  method: "get",
  path: "/api/v1/repos/{repoId}/members",
  tags: ["members"],
  summary: "A repo's members and their roles (anyone who can read the repo)",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: { params: RepoIdParam },
  responses: { 200: json(MembersSchema, "Members"), ...errors(401, 403, 404) },
});

const add = createRoute({
  method: "post",
  path: "/api/v1/repos/{repoId}/members",
  tags: ["members"],
  summary: "Add a member by e-mail or principal id, or change a member's role (human owner)",
  description:
    "Only humans are members (agents act with their owner's role). 409 when the change would leave the repo without an owner.",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:admin"], { humanOnly: true }), idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: RepoIdParam, body: body(AddMemberBody) },
  responses: {
    200: json(z.object({ member: MemberSchema }), "Role changed"),
    201: json(z.object({ member: MemberSchema }), "Added"),
    ...errors(400, 401, 403, 404, 409),
  },
});

const remove = createRoute({
  method: "delete",
  path: "/api/v1/repos/{repoId}/members/{principalId}",
  tags: ["members"],
  summary: "Remove a member (human owner), or leave the repo (your own principal id)",
  description: "409 when it would leave the repo without an owner.",
  security: SECURITY,
  // `read`: a member may always leave; removing someone else re-checks `admin` in the service.
  middleware: [requirePrincipal(["repo:read"], { humanOnly: true }), idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: MemberParams },
  responses: {
    200: json(z.object({ removed: z.literal(true), principalId: z.string() }), "Removed"),
    ...errors(401, 403, 404, 409),
  },
});

export function registerMemberRoutes(app: ApiApp): void {
  app.openapi(list, async (c) =>
    c.json(await listMembers(c.get("services"), callerOf(c), c.req.valid("param").repoId), 200),
  );
  app.openapi(add, async (c) => {
    const r = await addMember(
      c.get("services"),
      callerOf(c),
      c.req.valid("param").repoId,
      c.req.valid("json"),
    );
    return r.created ? c.json({ member: r.member }, 201) : c.json({ member: r.member }, 200);
  });
  app.openapi(remove, async (c) => {
    const p = c.req.valid("param");
    return c.json(await removeMember(c.get("services"), callerOf(c), p.repoId, p.principalId), 200);
  });
}
