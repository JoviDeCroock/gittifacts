/**
 * POST /api/oauth/token and /api/oauth/revoke.
 *
 * Every successful first exchange (authorization code or device code) creates a NEW agent
 * principal owned by the approving human, with exactly the scopes and repos they picked (re-checked
 * against what the human holds now), plus an `agent_sessions` row. Tokens:
 * - access: `gtf_…` in `agent_tokens`, audience-bound, 1 hour (never past the session's end);
 * - refresh: `gtr_…`, rotated on every use; replaying a rotated one revokes the whole session.
 * Authorization codes are single-use: a second redemption revokes the session the first one made
 * (RFC 6749 §4.1.2).
 */
import { type Principal, Scope } from "@app/domain";
import { base64urlEncode, sha256Hex } from "@app/evidence";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Services } from "../app-env.js";
import {
  generateRefreshToken,
  isAgentToken,
  isRefreshTokenShape,
  issueAgentToken,
  revokeAgentTokens,
} from "../auth/agent-tokens.js";
import type { Auth } from "../auth/better-auth.js";
import { createAgentPrincipal, disablePrincipal } from "../auth/principals.js";
import {
  agentSessions,
  agentTokens,
  oauthRefreshTokens,
  oauthRequests,
  principals,
} from "../db/schema.js";
import type { RedeemedDeviceCode } from "./device.js";
import { OAuthProtocolError } from "./errors.js";
import { DELEGABLE_SCOPES, parseRequestedScopes, scopeString } from "./scopes.js";
import { canonicalResource } from "./urls.js";

export const ACCESS_TOKEN_TTL_SEC = 3600;
const DAY_MS = 86_400_000;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

type RequestRow = typeof oauthRequests.$inferSelect;
type SessionRow = typeof agentSessions.$inferSelect;

function param(p: URLSearchParams, name: string, required: true): string;
function param(p: URLSearchParams, name: string, required?: false): string | null;
function param(p: URLSearchParams, name: string, required = false): string | null {
  const all = p.getAll(name);
  if (all.length > 1) throw new OAuthProtocolError("invalid_request", `${name} must appear once`);
  const v = all[0] ?? null;
  if (required && (v === null || v === "")) {
    throw new OAuthProtocolError("invalid_request", `${name} is required`);
  }
  return v === "" ? null : v;
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64urlEncode(new Uint8Array(digest));
}

/** Requested `resource` at the token endpoint must be one the grant covers; narrows the audience. */
function narrowAudience(p: URLSearchParams, granted: readonly string[]): string[] {
  const requested = p.getAll("resource");
  if (requested.length === 0) return [...granted];
  const out: string[] = [];
  for (const raw of requested) {
    const canon = canonicalResource(raw);
    if (canon === null || !granted.includes(canon)) {
      throw new OAuthProtocolError(
        "invalid_target",
        `resource ${raw} was not granted; this grant covers ${granted.join(", ")}`,
      );
    }
    if (!out.includes(canon)) out.push(canon);
  }
  return out;
}

async function issueTokens(
  svc: Services,
  session: SessionRow,
  principal: Principal,
  scopes: readonly Scope[],
  audience: readonly string[],
  now: Date,
): Promise<TokenResponse> {
  const sessionEnd = Date.parse(session.expiresAt);
  const accessEnd = Math.min(now.getTime() + ACCESS_TOKEN_TTL_SEC * 1000, sessionEnd);
  const access = await issueAgentToken(svc.store, {
    principalId: principal.id,
    scopes: [...scopes],
    createdBy: session.ownerId,
    expiresAt: new Date(accessEnd),
    now,
    audience,
    sessionId: session.id,
  });
  const refresh = generateRefreshToken();
  await svc.store.db.insert(oauthRefreshTokens).values({
    id: `rt_${crypto.randomUUID().replaceAll("-", "")}`,
    sessionId: session.id,
    tokenHash: await sha256Hex(refresh),
    createdAt: now.toISOString(),
    expiresAt: session.expiresAt,
    rotatedAt: null,
    revokedAt: null,
  });
  return {
    access_token: access.token,
    token_type: "Bearer",
    expires_in: Math.max(1, Math.floor((accessEnd - now.getTime()) / 1000)),
    refresh_token: refresh,
    scope: scopeString(scopes),
  };
}

/** Revoke a whole session: tokens, refresh tokens, and the principal itself. */
export async function revokeSession(
  svc: Services,
  session: Pick<SessionRow, "id" | "principalId">,
  by: string,
  reason: string,
): Promise<number> {
  const now = svc.clock.now();
  const revoked = await revokeAgentTokens(svc.store, session.principalId, now);
  await disablePrincipal(svc.store, session.principalId, now);
  await svc.store.db
    .update(agentSessions)
    .set({ revokedAt: now.toISOString(), revokedBy: by })
    .where(and(eq(agentSessions.id, session.id), isNull(agentSessions.revokedAt)));
  await svc.audit.append({
    principalId: by,
    action: "agent-session.revoked",
    subject: `principal:${session.principalId}`,
    payload: { sessionId: session.id, revokedTokens: revoked, reason },
  });
  return revoked;
}

/** First exchange of an approved request: new agent principal + session + tokens. */
async function createSession(
  svc: Services,
  row: RequestRow,
  ownerUserId: string | null,
  audience: readonly string[],
  now: Date,
): Promise<TokenResponse> {
  const owner = row.ownerId ? await svc.store.getPrincipal(row.ownerId) : null;
  if (owner?.kind !== "human") {
    throw new OAuthProtocolError("invalid_grant", "the approving account no longer exists");
  }
  const ownerRow = await svc.store.db
    .select({ userId: principals.userId, disabledAt: principals.disabledAt })
    .from(principals)
    .where(eq(principals.id, owner.id))
    .get();
  if (!ownerRow || ownerRow.disabledAt !== null) {
    throw new OAuthProtocolError("invalid_grant", "the approving account is disabled");
  }
  if (ownerUserId !== null && ownerRow.userId !== ownerUserId) {
    // Device flow: the better-auth user who approved must be the principal we recorded.
    throw new OAuthProtocolError(
      "invalid_grant",
      "the device code was approved by another account",
    );
  }
  // Re-check at issuance: only delegable scopes the human still holds.
  const granted = z.array(Scope).catch([]).parse(row.grantedScopes);
  const scopes = granted.filter((s) => DELEGABLE_SCOPES.includes(s) && owner.scopes.includes(s));
  if (scopes.length === 0) {
    throw new OAuthProtocolError("invalid_grant", "none of the granted scopes can be issued");
  }
  const repoIds =
    row.grantedRepoIds === null ? null : z.array(z.string()).parse(row.grantedRepoIds);
  const days = row.sessionDays ?? 1;
  const principal = await createAgentPrincipal(svc.store, {
    name: row.agentName ?? row.clientName,
    ownerId: owner.id,
    scopes,
    repoIds,
    now,
  });
  const session: SessionRow = {
    id: `ses_${crypto.randomUUID().replaceAll("-", "")}`,
    principalId: principal.id,
    ownerId: owner.id,
    flow: row.flow,
    clientId: row.clientId,
    clientName: row.clientName,
    clientUri: row.clientUri,
    audience: [...row.audience],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + days * DAY_MS).toISOString(),
    revokedAt: null,
    revokedBy: null,
  };
  await svc.store.db.insert(agentSessions).values(session);
  await svc.store.db
    .update(oauthRequests)
    .set({ sessionId: session.id })
    .where(eq(oauthRequests.id, row.id));
  const tokens = await issueTokens(svc, session, principal, scopes, audience, now);
  await svc.audit.append({
    principalId: owner.id,
    action: "agent-session.created",
    subject: `principal:${principal.id}`,
    payload: {
      sessionId: session.id,
      flow: row.flow,
      clientId: row.clientId,
      clientName: row.clientName,
      scopes,
      repoIds,
      audience: session.audience,
      expiresAt: session.expiresAt,
    },
  });
  return tokens;
}

export async function exchangeAuthorizationCode(
  svc: Services,
  p: URLSearchParams,
): Promise<TokenResponse> {
  const code = param(p, "code", true);
  const clientId = param(p, "client_id", true);
  const redirectUri = param(p, "redirect_uri");
  const verifier = param(p, "code_verifier");
  const now = svc.clock.now();
  const row = await svc.store.db
    .select()
    .from(oauthRequests)
    .where(eq(oauthRequests.codeHash, await sha256Hex(code)))
    .get();
  if (row?.flow !== "authorization_code") {
    throw new OAuthProtocolError("invalid_grant", "unknown authorization code");
  }
  if (row.status === "redeemed") {
    // Code replay: someone else may hold it. Kill what the first redemption created.
    const session = row.sessionId
      ? await svc.store.db
          .select()
          .from(agentSessions)
          .where(eq(agentSessions.id, row.sessionId))
          .get()
      : undefined;
    if (session) await revokeSession(svc, session, session.ownerId, "authorization code reused");
    throw new OAuthProtocolError(
      "invalid_grant",
      "authorization code already used; the session it created is revoked",
    );
  }
  if (row.status !== "approved")
    throw new OAuthProtocolError("invalid_grant", "authorization code is not approved");
  if (row.codeExpiresAt === null || Date.parse(row.codeExpiresAt) <= now.getTime()) {
    throw new OAuthProtocolError("invalid_grant", "authorization code expired");
  }
  if (row.clientId !== clientId)
    throw new OAuthProtocolError("invalid_grant", "client_id does not match the code");
  if (redirectUri !== row.redirectUri) {
    throw new OAuthProtocolError(
      "invalid_grant",
      "redirect_uri does not match the authorization request",
    );
  }
  if (verifier === null) {
    throw new OAuthProtocolError("invalid_request", "code_verifier is required (PKCE S256)");
  }
  if (
    !VERIFIER.test(verifier) ||
    row.codeChallenge === null ||
    (await s256(verifier)) !== row.codeChallenge
  ) {
    throw new OAuthProtocolError(
      "invalid_grant",
      "code_verifier does not match the code_challenge",
    );
  }
  const audience = narrowAudience(p, row.audience);
  // Single use, atomically.
  const claimed = await svc.store.db
    .update(oauthRequests)
    .set({ status: "redeemed" })
    .where(and(eq(oauthRequests.id, row.id), eq(oauthRequests.status, "approved")))
    .returning({ id: oauthRequests.id });
  if (claimed.length === 0)
    throw new OAuthProtocolError("invalid_grant", "authorization code already used");
  return createSession(svc, row, null, audience, now);
}

/** RFC 8628 §3.5 errors the plugin's state machine raises; passed through unchanged. */
const PluginDeviceError = z.object({
  error: z.enum([
    "authorization_pending",
    "slow_down",
    "expired_token",
    "access_denied",
    "invalid_grant",
    "invalid_request",
  ]),
  error_description: z.string().optional(),
});

export async function exchangeDeviceCode(
  svc: Services,
  auth: Auth,
  p: URLSearchParams,
): Promise<TokenResponse> {
  const deviceCode = param(p, "device_code", true);
  const clientId = param(p, "client_id", true);
  let redeemed: RedeemedDeviceCode;
  try {
    redeemed = await auth.api.redeemAgentDeviceCode({ body: { deviceCode, clientId } });
  } catch (e) {
    const body =
      typeof e === "object" && e !== null && "body" in e ? (e as { body: unknown }).body : null;
    const parsed = PluginDeviceError.safeParse(body);
    if (parsed.success) {
      throw new OAuthProtocolError(
        parsed.data.error,
        parsed.data.error_description ?? parsed.data.error,
      );
    }
    throw e;
  }
  const now = svc.clock.now();
  const row = await svc.store.db
    .select()
    .from(oauthRequests)
    .where(
      and(
        eq(oauthRequests.deviceCodeId, redeemed.deviceCodeId),
        eq(oauthRequests.flow, "device_code"),
      ),
    )
    .get();
  if (row?.status !== "approved") {
    // Approved outside the consent API (should be impossible: /device/approve is disabled). Fail closed.
    throw new OAuthProtocolError("access_denied", "no recorded consent for this device code");
  }
  const claimed = await svc.store.db
    .update(oauthRequests)
    .set({ status: "redeemed" })
    .where(and(eq(oauthRequests.id, row.id), eq(oauthRequests.status, "approved")))
    .returning({ id: oauthRequests.id });
  if (claimed.length === 0)
    throw new OAuthProtocolError("invalid_grant", "device code already used");
  return createSession(svc, row, redeemed.userId, row.audience, now);
}

export async function exchangeRefreshToken(
  svc: Services,
  p: URLSearchParams,
): Promise<TokenResponse> {
  const token = param(p, "refresh_token", true);
  const clientId = param(p, "client_id", true);
  if (!isRefreshTokenShape(token))
    throw new OAuthProtocolError("invalid_grant", "unknown refresh token");
  const now = svc.clock.now();
  const joined = await svc.store.db
    .select({ rt: oauthRefreshTokens, session: agentSessions })
    .from(oauthRefreshTokens)
    .innerJoin(agentSessions, eq(agentSessions.id, oauthRefreshTokens.sessionId))
    .where(eq(oauthRefreshTokens.tokenHash, await sha256Hex(token)))
    .get();
  if (!joined) throw new OAuthProtocolError("invalid_grant", "unknown refresh token");
  const { rt, session } = joined;
  if (rt.revokedAt !== null || session.revokedAt !== null) {
    throw new OAuthProtocolError("invalid_grant", "refresh token revoked");
  }
  if (rt.rotatedAt !== null) {
    await revokeSession(svc, session, session.ownerId, "refresh token reused");
    throw new OAuthProtocolError(
      "invalid_grant",
      "refresh token already used; the session is revoked",
    );
  }
  if (Date.parse(rt.expiresAt) <= now.getTime() || Date.parse(session.expiresAt) <= now.getTime()) {
    throw new OAuthProtocolError("invalid_grant", "the session expired; authorize again");
  }
  if (session.clientId !== clientId)
    throw new OAuthProtocolError("invalid_grant", "client_id does not match");
  const principal = await svc.store.getPrincipal(session.principalId);
  const disabled = await svc.store.db
    .select({ disabledAt: principals.disabledAt })
    .from(principals)
    .where(eq(principals.id, session.principalId))
    .get();
  if (principal?.kind !== "agent" || !disabled || disabled.disabledAt !== null) {
    throw new OAuthProtocolError("invalid_grant", "the agent was revoked");
  }
  // Optional narrowing; never widening, and never an approval-class scope.
  let scopes: Scope[] = [...principal.scopes];
  const scopeParam = param(p, "scope");
  if (scopeParam !== null) {
    const parsed = parseRequestedScopes(scopeParam);
    if (!parsed.ok) throw new OAuthProtocolError("invalid_scope", parsed.description);
    const wider = parsed.scopes.filter((s) => !principal.scopes.includes(s));
    if (wider.length > 0) {
      throw new OAuthProtocolError(
        "invalid_scope",
        `not granted to this session: ${wider.join(", ")}`,
      );
    }
    scopes = parsed.scopes;
  }
  const audience = narrowAudience(p, session.audience);
  const rotated = await svc.store.db
    .update(oauthRefreshTokens)
    .set({ rotatedAt: now.toISOString() })
    .where(
      and(
        eq(oauthRefreshTokens.id, rt.id),
        isNull(oauthRefreshTokens.rotatedAt),
        isNull(oauthRefreshTokens.revokedAt),
      ),
    )
    .returning({ id: oauthRefreshTokens.id });
  if (rotated.length === 0)
    throw new OAuthProtocolError("invalid_grant", "refresh token already used");
  return issueTokens(svc, session, principal, scopes, audience, now);
}

/**
 * RFC 7009. Public clients: possession of the token is the proof. An access token is revoked on its
 * own; a refresh token ends the whole session (tokens + principal). Unknown tokens are a no-op.
 */
export async function revokeToken(svc: Services, p: URLSearchParams): Promise<void> {
  const token = param(p, "token", true);
  const now = svc.clock.now();
  if (isAgentToken(token)) {
    await svc.store.db
      .update(agentTokens)
      .set({ revokedAt: now.toISOString() })
      .where(and(eq(agentTokens.tokenHash, await sha256Hex(token)), isNull(agentTokens.revokedAt)));
    return;
  }
  if (isRefreshTokenShape(token)) {
    const joined = await svc.store.db
      .select({ session: agentSessions })
      .from(oauthRefreshTokens)
      .innerJoin(agentSessions, eq(agentSessions.id, oauthRefreshTokens.sessionId))
      .where(eq(oauthRefreshTokens.tokenHash, await sha256Hex(token)))
      .get();
    if (joined && joined.session.revokedAt === null) {
      await revokeSession(
        svc,
        joined.session,
        joined.session.principalId,
        "client revoked its refresh token",
      );
    }
  }
}
