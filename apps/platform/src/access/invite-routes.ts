/**
 * Invite API (src/access/invites.ts). Owners create invites through POST .../members (202).
 *
 *   DELETE /api/v1/repos/{repoId}/invites/{inviteId}   human owner: revoke an open invite
 *   GET    /api/v1/invites/{token}                     public: what the link offers (a session fills `viewer`)
 *   POST   /api/v1/invites/{token}/accept              a signed-in person with the invited e-mail joins
 *
 * Membership is a person's act (owners decide who joins; the invitee accepts for themselves), so
 * there is no MCP twin: agents read members with list_members and hand invites to their human.
 */
import { createRoute } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { IdempotencyHeaders, RepoIdParam } from "../api/schemas.js";
import type { AppEnv } from "../app-env.js";
import { callerOf, requirePrincipal, resolveCaller } from "../auth/middleware.js";
import { ApiError } from "../errors.js";
import { idempotent } from "../idempotency.js";
import { type ApiApp, errors, json, SECURITY } from "../routes/common.js";
import { acceptInvite, getInviteLink, revokeInvite } from "./invites.js";
import { REPO_ROLES } from "./roles.js";

const Role = z.enum(REPO_ROLES);

export const InviteSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    role: Role,
    invitedBy: z.object({ principalId: z.string(), name: z.string() }),
    createdAt: z.string(),
    expiresAt: z.string(),
    expired: z.boolean(),
  })
  .meta({ id: "RepoInvite" });

const InviteLinkSchema = z
  .object({
    status: z.enum(["pending", "accepted", "expired", "revoked"]),
    repo: z.object({ id: z.string(), name: z.string() }),
    role: Role,
    invitedBy: z.object({ name: z.string() }),
    emailHint: z.string().describe("The invited e-mail, partly hidden"),
    expiresAt: z.string(),
    viewer: z.object({
      signedIn: z.boolean(),
      emailMatches: z.boolean(),
      role: Role.nullable(),
    }),
  })
  .meta({ id: "InviteLink" });

const TokenParam = z.object({ token: z.string().min(1).max(200) });

/**
 * Accepting needs a signed-in person, said before the idempotency middleware (which keys on the
 * caller) runs, with the way back to the link.
 */
const signedInPerson: MiddlewareHandler<AppEnv> = async (c, next) => {
  const caller = await resolveCaller(c);
  if (!caller || caller.principal.kind !== "human" || !caller.user) {
    const token = c.req.param("token") ?? "";
    throw new ApiError(401, "unauthorized", "sign in to accept this invite", undefined, {
      explanation: `A person accepts an invite for themselves. Sign in with the invited e-mail, then open ${c.get("services").origin}/invite/${encodeURIComponent(token)} again.`,
    });
  }
  await next();
};
const InviteParams = RepoIdParam.extend({ inviteId: z.string().min(1).max(64) });

const revoke = createRoute({
  method: "delete",
  path: "/api/v1/repos/{repoId}/invites/{inviteId}",
  tags: ["members"],
  summary: "Revoke an open invite (human owner); its link stops working",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:admin"], { humanOnly: true }), idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: InviteParams },
  responses: {
    200: json(z.object({ revoked: z.literal(true), inviteId: z.string() }), "Revoked"),
    ...errors(401, 403, 404),
  },
});

const view = createRoute({
  method: "get",
  path: "/api/v1/invites/{token}",
  tags: ["members"],
  summary: "What an invite link offers: the repo, the role, who sent it (no sign-in needed)",
  request: { params: TokenParam },
  responses: { 200: json(InviteLinkSchema, "The invite"), ...errors(404) },
});

const accept = createRoute({
  method: "post",
  path: "/api/v1/invites/{token}/accept",
  tags: ["members"],
  summary: "Accept an invite: a signed-in person whose e-mail is the invited one joins the repo",
  description:
    "Needs the link and the invited e-mail. 403 `invite-email-mismatch` for another account; 409 `invite-closed` once used, revoked or expired.",
  security: SECURITY,
  middleware: [signedInPerson, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: TokenParam },
  responses: {
    200: json(
      z.object({ repoId: z.string(), role: Role, alreadyMember: z.boolean() }),
      "You are a member",
    ),
    ...errors(401, 403, 404, 409),
  },
});

export function registerInviteRoutes(app: ApiApp): void {
  app.openapi(revoke, async (c) => {
    const p = c.req.valid("param");
    return c.json(await revokeInvite(c.get("services"), callerOf(c), p.repoId, p.inviteId), 200);
  });
  app.openapi(view, async (c) => {
    const caller = await resolveCaller(c).catch(() => null);
    const out = await getInviteLink(c.get("services"), caller, c.req.valid("param").token);
    return c.json(out, 200, { "cache-control": "no-store" });
  });
  app.openapi(accept, async (c) =>
    c.json(await acceptInvite(c.get("services"), callerOf(c), c.req.valid("param").token), 200),
  );
}
