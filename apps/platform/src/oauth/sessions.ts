/**
 * The human's agent sessions (Agents screen): every agent principal they own, with the client it
 * was approved for, its scopes and repos, when it was created and last used, and when it ends.
 * Agents created directly on the Agents screen show up as `manual` sessions.
 *
 * Revoking is one call: all access and refresh tokens are revoked and the principal is disabled,
 * so the very next request with any of its tokens is refused. Audit-logged.
 */
import { Scope } from "@app/domain";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Caller, Services } from "../app-env.js";
import { revokeAgentTokens } from "../auth/agent-tokens.js";
import { disablePrincipal } from "../auth/principals.js";
import { agentSessions, agentTokens, principals } from "../db/schema.js";
import { apiError } from "./errors.js";
import { revokeSession } from "./tokens.js";
import type { OAuthUrls } from "./urls.js";

export const AgentSessionSchema = z
  .object({
    principalId: z.string(),
    name: z.string(),
    flow: z.enum(["authorization_code", "device_code", "manual"]),
    client: z.object({ id: z.string(), name: z.string(), uri: z.string().nullable() }).nullable(),
    scopes: z.array(Scope),
    /** null = every repo you can access. */
    repoIds: z.array(z.string()).nullable(),
    repos: z.array(z.object({ id: z.string(), name: z.string() })),
    /** Resources its tokens are bound to; null = any (manual agents). */
    audience: z.array(z.string()).nullable(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    /** When the session ends (null: a manual token that never expires). */
    expiresAt: z.string().nullable(),
    status: z.enum(["active", "expired", "revoked"]),
    revokedAt: z.string().nullable(),
    activeTokens: z.number().int(),
    tokenPrefix: z.string().nullable(),
  })
  .meta({ id: "AgentSession" });
export type AgentSession = z.infer<typeof AgentSessionSchema>;

interface TokenStats {
  lastUsedAt: string | null;
  maxExpiresAt: string | null;
  active: number;
  revoked: number;
  prefix: string | null;
}

async function tokenStats(
  svc: Services,
  ids: string[],
  nowIso: string,
): Promise<Map<string, TokenStats>> {
  const out = new Map<string, TokenStats>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await svc.store.db
      .select({
        principalId: agentTokens.principalId,
        lastUsedAt: sql<string | null>`max(${agentTokens.lastUsedAt})`,
        maxExpiresAt: sql<
          string | null
        >`max(case when ${agentTokens.revokedAt} is null then ${agentTokens.expiresAt} end)`,
        neverExpires: sql<number>`sum(case when ${agentTokens.revokedAt} is null and ${agentTokens.expiresAt} is null then 1 else 0 end)`,
        active: sql<number>`sum(case when ${agentTokens.revokedAt} is null and (${agentTokens.expiresAt} is null or ${agentTokens.expiresAt} > ${nowIso}) then 1 else 0 end)`,
        revoked: sql<number>`sum(case when ${agentTokens.revokedAt} is not null then 1 else 0 end)`,
        prefix: sql<string | null>`max(${agentTokens.prefix})`,
      })
      .from(agentTokens)
      .where(inArray(agentTokens.principalId, chunk))
      .groupBy(agentTokens.principalId)
      .all();
    for (const r of rows) {
      out.set(r.principalId, {
        lastUsedAt: r.lastUsedAt,
        maxExpiresAt: Number(r.neverExpires) > 0 ? null : r.maxExpiresAt,
        active: Number(r.active),
        revoked: Number(r.revoked),
        prefix: r.prefix,
      });
    }
  }
  return out;
}

export async function listAgentSessions(svc: Services, caller: Caller): Promise<AgentSession[]> {
  const now = svc.clock.now();
  const nowIso = now.toISOString();
  const agents = await svc.store.db
    .select()
    .from(principals)
    .where(and(eq(principals.ownerId, caller.principal.id), eq(principals.kind, "agent")))
    .orderBy(desc(principals.createdAt))
    .all();
  if (agents.length === 0) return [];
  const ids = agents.map((a) => a.id);
  const sessions = new Map<string, typeof agentSessions.$inferSelect>();
  for (let i = 0; i < ids.length; i += 90) {
    const rows = await svc.store.db
      .select()
      .from(agentSessions)
      .where(inArray(agentSessions.principalId, ids.slice(i, i + 90)))
      .all();
    for (const s of rows) sessions.set(s.principalId, s);
  }
  const stats = await tokenStats(svc, ids, nowIso);
  const repoNames = new Map((await svc.store.listRepos()).map((r) => [r.id, r.name]));

  return agents.map((a): AgentSession => {
    const s = sessions.get(a.id) ?? null;
    const t = stats.get(a.id) ?? {
      lastUsedAt: null,
      maxExpiresAt: null,
      active: 0,
      revoked: 0,
      prefix: null,
    };
    const repoIds = a.repoIds === null ? null : z.array(z.string()).catch([]).parse(a.repoIds);
    const revokedAt = s?.revokedAt ?? a.disabledAt ?? null;
    let status: AgentSession["status"];
    if (s) {
      status =
        revokedAt !== null
          ? "revoked"
          : Date.parse(s.expiresAt) <= now.getTime()
            ? "expired"
            : "active";
    } else {
      status =
        a.disabledAt !== null
          ? "revoked"
          : t.active > 0
            ? "active"
            : t.revoked > 0
              ? "revoked"
              : "expired";
    }
    return {
      principalId: a.id,
      name: a.name,
      flow: s?.flow ?? "manual",
      client: s ? { id: s.clientId, name: s.clientName, uri: s.clientUri } : null,
      scopes: z.array(Scope).catch([]).parse(a.scopes),
      repoIds,
      repos: (repoIds ?? []).map((id) => ({ id, name: repoNames.get(id) ?? id })),
      audience: s ? [...s.audience] : null,
      createdAt: s?.createdAt ?? a.createdAt,
      lastUsedAt: t.lastUsedAt,
      expiresAt: s?.expiresAt ?? t.maxExpiresAt,
      status,
      revokedAt,
      activeTokens: status === "revoked" ? 0 : t.active,
      tokenPrefix: t.prefix,
    };
  });
}

/** One-click revoke: tokens + refresh tokens + principal. Idempotent (revoking twice is fine). */
export async function revokeAgentSession(
  svc: Services,
  urls: OAuthUrls,
  caller: Caller,
  principalId: string,
): Promise<AgentSession> {
  const target = await svc.store.getPrincipal(principalId);
  if (target?.kind !== "agent" || target.ownerId !== caller.principal.id) {
    throw apiError(404, "not-found", `no agent session ${principalId} of yours`, urls.origin, {
      fix: {
        explanation: "List your sessions (GET /api/v1/agent-sessions) and use one of those ids.",
      },
    });
  }
  const session = await svc.store.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.principalId, principalId))
    .get();
  if (session) {
    await revokeSession(svc, session, caller.principal.id, "revoked by owner");
  } else {
    const now = svc.clock.now();
    const revoked = await revokeAgentTokens(svc.store, principalId, now);
    await disablePrincipal(svc.store, principalId, now);
    await svc.audit.append({
      principalId: caller.principal.id,
      action: "agent-session.revoked",
      subject: `principal:${principalId}`,
      payload: { sessionId: null, revokedTokens: revoked, reason: "revoked by owner" },
    });
  }
  const after = (await listAgentSessions(svc, caller)).find((s) => s.principalId === principalId);
  if (!after) throw new Error(`agent ${principalId} vanished after revoke`);
  return after;
}
