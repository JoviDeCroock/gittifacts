/**
 * Integration access tokens (`gti_…`): rows in `agent_tokens` bound to the installation's
 * `integration` principal, audience `<origin>/api`, 1 hour. They never verify as agent tokens
 * (`gtf_…` shape) and so never reach MCP, and agent tokens never verify here.
 *
 * Verification is one indexed read plus the installation: an uninstalled installation, a disabled
 * principal, a deleted integration or an expired/revoked token fails at once. The principal's
 * repos are re-resolved per request (./access.ts), so a repo that stops qualifying drops out.
 */
import { type Principal, Scope } from "@app/domain";
import { sha256Hex } from "@app/evidence";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Services } from "../app-env.js";
import { agentTokens, installations, integrations, principals } from "../db/schema.js";
import { RateLimited } from "../limits/creation.js";
import { installationRepoIds } from "./access.js";
import { ACCESS_TOKEN_PREFIX, isIntegrationAccessToken, randomSecret } from "./crypto.js";
import type { InstallationRow } from "./installations.js";
import type { IntegrationRow } from "./registry.js";
import type { IntegrationBindings } from "./runtime.js";

export const ACCESS_TOKEN_TTL_SEC = 3600;
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

export interface VerifiedIntegration {
  principal: Principal;
  installation: InstallationRow;
  integration: IntegrationRow;
  tokenId: string;
  expiresAtSec: number;
  audience: string[] | null;
}

export async function issueAccessToken(
  svc: Pick<Services, "store">,
  inst: InstallationRow,
  scopes: readonly Scope[],
  audience: readonly string[],
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomSecret(ACCESS_TOKEN_PREFIX);
  const expiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_SEC * 1000);
  await svc.store.db.insert(agentTokens).values({
    id: `tok_${crypto.randomUUID()}`,
    principalId: inst.principalId,
    tokenHash: await sha256Hex(token),
    prefix: token.slice(0, 12),
    scopes: [...scopes],
    createdBy: inst.installedBy,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    lastUsedAt: null,
    revokedAt: null,
    audience: [...audience],
    sessionId: inst.sessionId,
  });
  return { token, expiresAt };
}

export async function verifyIntegrationToken(
  svc: Services,
  token: string,
): Promise<VerifiedIntegration | null> {
  if (!isIntegrationAccessToken(token)) return null;
  const now = svc.clock.now();
  const joined = await svc.store.db
    .select({ token: agentTokens, disabledAt: principals.disabledAt, kind: principals.kind })
    .from(agentTokens)
    .innerJoin(principals, eq(principals.id, agentTokens.principalId))
    .where(and(eq(agentTokens.tokenHash, await sha256Hex(token)), isNull(agentTokens.revokedAt)))
    .get();
  if (!joined || joined.disabledAt !== null || joined.kind !== "integration") return null;
  const row = joined.token;
  if (row.expiresAt === null || Date.parse(row.expiresAt) <= now.getTime()) return null;
  const inst = await svc.store.db
    .select()
    .from(installations)
    .where(and(eq(installations.principalId, row.principalId), eq(installations.status, "active")))
    .get();
  if (!inst) return null;
  const integration = await svc.store.db
    .select()
    .from(integrations)
    .where(eq(integrations.id, inst.integrationId))
    .get();
  if (!integration || integration.deletedAt !== null) return null;
  const principal = await svc.store.getPrincipal(row.principalId);
  if (principal?.kind !== "integration") return null;
  const tokenScopes = z.array(Scope).safeParse(row.scopes);
  if (!tokenScopes.success) return null;
  const audience = row.audience === null ? null : z.array(z.string()).safeParse(row.audience);
  if (audience !== null && !audience.success) return null;

  if (now.getTime() - (row.lastUsedAt ? Date.parse(row.lastUsedAt) : 0) > LAST_USED_RESOLUTION_MS) {
    svc.waitUntil(
      svc.store.db.update(agentTokens).set({ lastUsedAt: now.toISOString() }).where(eq(agentTokens.id, row.id)),
    );
  }
  return {
    principal: {
      ...principal,
      scopes: principal.scopes.filter((s) => tokenScopes.data.includes(s)),
      repoIds: await installationRepoIds(svc, inst),
    },
    installation: inst,
    integration,
    tokenId: row.id,
    expiresAtSec: Math.floor(Date.parse(row.expiresAt) / 1000),
    audience: audience === null ? null : audience.data,
  };
}

/**
 * Per-integration request rate (Workers Rate Limiting binding `INTEGRATION_LIMITER`, keyed by the
 * integration id: all its installations share one budget). No binding (local dev): no limit.
 */
export async function enforceIntegrationRate(env: unknown, integrationId: string): Promise<void> {
  const limiter = (env as IntegrationBindings).INTEGRATION_LIMITER;
  if (!limiter) return;
  let ok = true;
  try {
    ok = (await limiter.limit({ key: `integration:${integrationId}` })).success;
  } catch (e) {
    console.error("integration rate limiter failed (allowing)", e);
  }
  if (!ok) {
    // One budget per integration across all its installations; the binding's period is 60 s.
    throw new RateLimited("token", 60, "too many requests from this integration", { integrationId });
  }
}

/** Is this bearer token shaped like an integration token (routing only; not verification)? */
export const isIntegrationBearer = (token: string): boolean => token.startsWith(ACCESS_TOKEN_PREFIX);
