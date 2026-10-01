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
 */
import { type Principal, Scope } from "@app/domain";
import { base64urlEncode, sha256Hex } from "@app/evidence";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { agentTokens } from "../db/schema.js";
import type { D1Store } from "../store/d1-store.js";

export const TOKEN_PREFIX = "gtf_";
const TOKEN_SHAPE = /^gtf_[A-Za-z0-9_-]{43}$/;
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

export function isAgentToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

export function generateAgentToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${TOKEN_PREFIX}${base64urlEncode(bytes)}`;
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
  });
  return { id, token, prefix, expiresAt };
}

export interface VerifiedAgent {
  principal: Principal;
  tokenId: string;
  /** Unix seconds; required by the MCP SDK's bearer gate. */
  expiresAtSec: number;
}

/**
 * Resolve a bearer token to its agent principal, or null when the token is unknown, malformed,
 * revoked, expired, or belongs to a principal that is not an agent. Effective scopes are the
 * intersection of the token's scopes and the principal's current scopes.
 */
export async function verifyAgentToken(
  store: D1Store,
  token: string,
  now: Date,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<VerifiedAgent | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const hash = await hashAgentToken(token);
  const row = await store.db
    .select()
    .from(agentTokens)
    .where(and(eq(agentTokens.tokenHash, hash), isNull(agentTokens.revokedAt)))
    .get();
  if (!row) return null;
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
  return { principal: { ...principal, scopes }, tokenId: row.id, expiresAtSec };
}

/** Revoke every live token of a principal. Returns how many were revoked. */
export async function revokeAgentTokens(
  store: D1Store,
  principalId: string,
  now: Date,
): Promise<number> {
  const rows = await store.db
    .update(agentTokens)
    .set({ revokedAt: now.toISOString() })
    .where(and(eq(agentTokens.principalId, principalId), isNull(agentTokens.revokedAt)))
    .returning({ id: agentTokens.id });
  return rows.length;
}
