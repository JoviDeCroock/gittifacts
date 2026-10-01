/**
 * Agent bearer tokens (`gtf_…`), bound to an agent Principal that a human owns.
 *
 * Decision (2026-10-01): our own `agent_tokens` table instead of better-auth's api-key plugin.
 * - api-key keys reference a better-auth *user* (or org); agents are not users. We would have to
 *   smuggle the agent principal id through key metadata and re-validate it on every request.
 * - Scopes are our domain `Scope` enum, checked per route/tool; the plugin's permission map would
 *   be a second vocabulary to keep in sync.
 * - The plugin rate-limits keys to 10 requests/day by default and writes `request_count` and
 *   `last_request` to D1 on every verify. Ours does one indexed read by hash and refreshes
 *   `last_used_at` at most hourly, in the background.
 * - Revocation per principal (`DELETE /principals/:id/tokens`) is a single UPDATE.
 * Tokens are 32 random bytes, stored only as SHA-256 hex; the plaintext is shown once.
 *
 * Delegated sessions (OAuth / device flow, ../oauth) mint the same `gtf_` tokens with an RFC 8707
 * `audience` and a `sessionId`; their refresh tokens (`gtr_…`) can never be used as a bearer.
 * A disabled principal (revoked session) fails verification immediately.
 */
import { type Principal, Scope } from "@app/domain";
import { base64urlEncode, sha256Hex } from "@app/evidence";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { agentSessions, agentTokens, oauthRefreshTokens, principals } from "../db/schema.js";
import type { D1Store } from "../store/d1-store.js";

export const TOKEN_PREFIX = "gtf_";
/** Refresh tokens: a different prefix so they never pass as a bearer token. */
export const REFRESH_TOKEN_PREFIX = "gtr_";
const TOKEN_SHAPE = /^gtf_[A-Za-z0-9_-]{43}$/;
const REFRESH_SHAPE = /^gtr_[A-Za-z0-9_-]{43}$/;
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

export function isAgentToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

function randomToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}${base64urlEncode(bytes)}`;
}

export function generateAgentToken(): string {
  return randomToken(TOKEN_PREFIX);
}

export function generateRefreshToken(): string {
  return randomToken(REFRESH_TOKEN_PREFIX);
}

export function isRefreshTokenShape(token: string): boolean {
  return REFRESH_SHAPE.test(token);
}

export async function hashAgentToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export interface IssuedToken {
  id: string;
  token: string;
  prefix: string;
  expiresAt: string | null;
}

export async function issueAgentToken(
  store: D1Store,
  input: {
    principalId: string;
    scopes: Scope[];
    createdBy: string;
    expiresAt: Date | null;
    now: Date;
    /** RFC 8707 audience; omitted/null = any platform resource. */
    audience?: readonly string[] | null;
    sessionId?: string | null;
  },
): Promise<IssuedToken> {
  const token = generateAgentToken();
  const id = `tok_${crypto.randomUUID()}`;
  const prefix = token.slice(0, 12);
  const expiresAt = input.expiresAt ? input.expiresAt.toISOString() : null;
  await store.db.insert(agentTokens).values({
    id,
    principalId: input.principalId,
    tokenHash: await hashAgentToken(token),
    prefix,
    scopes: input.scopes,
    createdBy: input.createdBy,
    createdAt: input.now.toISOString(),
    expiresAt,
    lastUsedAt: null,
    revokedAt: null,
    audience: input.audience ? [...input.audience] : null,
    sessionId: input.sessionId ?? null,
  });
  return { id, token, prefix, expiresAt };
}

export interface VerifiedAgent {
  principal: Principal;
  tokenId: string;
  /** Unix seconds; required by the MCP SDK's bearer gate. */
  expiresAtSec: number;
  /** Resources the token is bound to; null = any platform resource. */
  audience: string[] | null;
  sessionId: string | null;
}

/**
 * Resolve a bearer token to its agent principal, or null when the token is unknown, malformed,
 * revoked, expired, or belongs to a principal that is not an agent or is disabled. Effective
 * scopes are the intersection of the token's scopes and the principal's current scopes. The
 * caller checks `audience` against the resource it serves (see ../oauth/urls.ts audienceAllows).
 */
export async function verifyAgentToken(
  store: D1Store,
  token: string,
  now: Date,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<VerifiedAgent | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const hash = await hashAgentToken(token);
  const joined = await store.db
    .select({ token: agentTokens, disabledAt: principals.disabledAt })
    .from(agentTokens)
    .innerJoin(principals, eq(principals.id, agentTokens.principalId))
    .where(and(eq(agentTokens.tokenHash, hash), isNull(agentTokens.revokedAt)))
    .get();
  if (!joined || joined.disabledAt !== null) return null;
  const row = joined.token;
  if (row.expiresAt !== null && Date.parse(row.expiresAt) <= now.getTime()) return null;
  const principal = await store.getPrincipal(row.principalId);
  if (principal?.kind !== "agent") return null;
  const tokenScopes = z.array(Scope).safeParse(row.scopes);
  if (!tokenScopes.success) return null;
  const scopes = principal.scopes.filter((s) => tokenScopes.data.includes(s));

  const lastUsed = row.lastUsedAt ? Date.parse(row.lastUsedAt) : 0;
  if (now.getTime() - lastUsed > LAST_USED_RESOLUTION_MS) {
    const touch = store.db
      .update(agentTokens)
      .set({ lastUsedAt: now.toISOString() })
      .where(eq(agentTokens.id, row.id))
      .then(() => undefined);
    if (waitUntil) waitUntil(touch);
    else await touch;
  }

  const expiresAtSec = row.expiresAt
    ? Math.floor(Date.parse(row.expiresAt) / 1000)
    : Math.floor(now.getTime() / 1000) + 3600;
  const audience = row.audience === null ? null : z.array(z.string()).safeParse(row.audience);
  if (audience !== null && !audience.success) return null;
  return {
    principal: { ...principal, scopes },
    tokenId: row.id,
    expiresAtSec,
    audience: audience === null ? null : audience.data,
    sessionId: row.sessionId,
  };
}

/**
 * Revoke every live token of a principal, including the refresh tokens of its delegated sessions
 * (otherwise a client could mint a fresh access token right after). Returns how many access
 * tokens were revoked.
 */
export async function revokeAgentTokens(
  store: D1Store,
  principalId: string,
  now: Date,
): Promise<number> {
  const at = now.toISOString();
  const rows = await store.db
    .update(agentTokens)
    .set({ revokedAt: at })
    .where(and(eq(agentTokens.principalId, principalId), isNull(agentTokens.revokedAt)))
    .returning({ id: agentTokens.id });
  const sessions = await store.db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.principalId, principalId))
    .all();
  if (sessions.length > 0) {
    await store.db
      .update(oauthRefreshTokens)
      .set({ revokedAt: at })
      .where(
        and(
          inArray(
            oauthRefreshTokens.sessionId,
            sessions.map((s) => s.id),
          ),
          isNull(oauthRefreshTokens.revokedAt),
        ),
      );
  }
  return rows.length;
}
