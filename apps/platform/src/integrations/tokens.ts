/**
 * The token endpoint for integration clients (`client_id` = `gtic_…`), dispatched from
 * POST /api/oauth/token and /api/oauth/revoke:
 *
 * - client authentication: confidential clients with `client_secret_basic` or `client_secret_post`
 *   (exactly one method), public clients with none; PKCE S256 is required for both.
 * - `authorization_code` → access token (`gti_…`, 1 h, audience `<origin>/api`) + refresh token
 *   (`gtir_…`, rotated on every use) bound to the installation the human approved.
 * - `refresh_token` → a new pair; replaying a rotated refresh token (or an authorization code)
 *   revokes every token of the installation (the installation itself stays).
 * Every issue is audit-logged (`integration.token-issued`, subject `installation:<id>`).
 */
import { IntegrationScope } from "@app/domain";
import { base64urlEncode, sha256Hex } from "@app/evidence";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Services } from "../app-env.js";
import { revokeAgentTokens } from "../auth/agent-tokens.js";
import {
  agentTokens,
  installations,
  integrationAuthorizations,
  integrationSecrets,
  oauthRefreshTokens,
} from "../db/schema.js";
import { OAuthProtocolError } from "../oauth/errors.js";
import type { OAuthUrls } from "../oauth/urls.js";
import { ACCESS_TOKEN_TTL_SEC, issueAccessToken } from "./auth.js";
import {
  isClientSecretShape,
  isIntegrationAccessToken,
  isIntegrationClientId,
  isIntegrationRefreshToken,
  REFRESH_TOKEN_PREFIX,
  randomSecret,
  timingSafeEqual,
} from "./crypto.js";
import { getInstallation, type InstallationRow } from "./installations.js";
import { getIntegrationByClientId, type IntegrationRow } from "./registry.js";

/** Refresh tokens live this long after their last rotation (an idle installation re-authorizes). */
export const REFRESH_TOKEN_TTL_DAYS = 180;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export interface IntegrationTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
  /** Extension member: the installation these tokens act for. */
  installation_id: string;
}

export interface ClientCredentials {
  clientId: string | null;
  clientSecret: string | null;
  via: "basic" | "post" | "none";
}

/** RFC 6749 §2.3.1: Basic (form-urlencoded id:secret) or body parameters, never both. */
export function clientCredentials(
  authorization: string | undefined,
  p: URLSearchParams,
): ClientCredentials {
  const m = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(authorization ?? "");
  if (m?.[1]) {
    if (p.has("client_secret")) {
      throw new OAuthProtocolError(
        "invalid_request",
        "use one client authentication method, not Basic and client_secret",
      );
    }
    let decoded: string;
    try {
      decoded = atob(m[1]);
    } catch {
      throw new OAuthProtocolError("invalid_client", "malformed Basic credentials", 401);
    }
    const i = decoded.indexOf(":");
    if (i < 0) throw new OAuthProtocolError("invalid_client", "malformed Basic credentials", 401);
    const id = decodeURIComponent(decoded.slice(0, i).replace(/\+/g, " "));
    const secret = decodeURIComponent(decoded.slice(i + 1).replace(/\+/g, " "));
    const bodyId = p.get("client_id");
    if (bodyId !== null && bodyId !== id) {
      throw new OAuthProtocolError(
        "invalid_request",
        "client_id in the body differs from the Basic credentials",
      );
    }
    return { clientId: id, clientSecret: secret, via: "basic" };
  }
  const secrets = p.getAll("client_secret");
  if (secrets.length > 1)
    throw new OAuthProtocolError("invalid_request", "client_secret must appear once");
  return {
    clientId: p.get("client_id"),
    clientSecret: secrets[0] ?? null,
    via: secrets.length > 0 ? "post" : "none",
  };
}

/** Is this token request (or revocation) from an integration client? */
export function isIntegrationRequest(
  authorization: string | undefined,
  p: URLSearchParams,
): boolean {
  try {
    return isIntegrationClientId(clientCredentials(authorization, p).clientId);
  } catch {
    return false;
  }
}

export async function authenticateClient(
  svc: Services,
  creds: ClientCredentials,
): Promise<IntegrationRow> {
  const integration = creds.clientId ? await getIntegrationByClientId(svc, creds.clientId) : null;
  if (!integration) throw new OAuthProtocolError("invalid_client", "unknown client_id", 401);
  if (integration.clientType === "public") {
    if (creds.clientSecret !== null) {
      throw new OAuthProtocolError(
        "invalid_client",
        "public clients have no secret; authenticate with PKCE only",
        401,
      );
    }
    return integration;
  }
  if (creds.clientSecret === null || !isClientSecretShape(creds.clientSecret)) {
    throw new OAuthProtocolError(
      "invalid_client",
      "client authentication failed: send client_secret_basic or client_secret_post",
      401,
    );
  }
  const hash = await sha256Hex(creds.clientSecret);
  const secret = await svc.store.db
    .select()
    .from(integrationSecrets)
    .where(and(eq(integrationSecrets.secretHash, hash), isNull(integrationSecrets.revokedAt)))
    .get();
  if (
    !secret ||
    secret.integrationId !== integration.id ||
    !timingSafeEqual(secret.secretHash, hash)
  ) {
    throw new OAuthProtocolError("invalid_client", "client authentication failed", 401);
  }
  svc.waitUntil(
    svc.store.db
      .update(integrationSecrets)
      .set({ lastUsedAt: svc.clock.now().toISOString() })
      .where(eq(integrationSecrets.id, secret.id)),
  );
  return integration;
}

function param(p: URLSearchParams, name: string): string | null {
  const all = p.getAll(name);
  if (all.length > 1) throw new OAuthProtocolError("invalid_request", `${name} must appear once`);
  const v = all[0] ?? null;
  return v === "" ? null : v;
}

function required(p: URLSearchParams, name: string): string {
  const v = param(p, name);
  if (v === null) throw new OAuthProtocolError("invalid_request", `${name} is required`);
  return v;
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64urlEncode(new Uint8Array(digest));
}

function scopesOf(raw: unknown): IntegrationScope[] {
  return z.array(IntegrationScope).catch([]).parse(raw);
}

/** Kill every token of an installation (code or refresh replay); the installation stays. */
async function revokeInstallationTokens(
  svc: Services,
  inst: InstallationRow,
  reason: string,
): Promise<void> {
  const revoked = await revokeAgentTokens(svc.store, inst.principalId, svc.clock.now());
  await svc.audit.append({
    principalId: inst.principalId,
    action: "integration.tokens-revoked",
    subject: `installation:${inst.id}`,
    payload: { summary: `All tokens revoked: ${reason}`, revokedTokens: revoked, reason },
  });
}

async function issuePair(
  svc: Services,
  urls: OAuthUrls,
  inst: InstallationRow,
  scopes: readonly IntegrationScope[],
  grant: "authorization_code" | "refresh_token",
): Promise<IntegrationTokenResponse> {
  const now = svc.clock.now();
  const access = await issueAccessToken(svc, inst, scopes, [urls.apiResource], now);
  const refresh = randomSecret(REFRESH_TOKEN_PREFIX);
  await svc.store.db.insert(oauthRefreshTokens).values({
    id: `rt_${crypto.randomUUID().replaceAll("-", "")}`,
    sessionId: inst.sessionId,
    tokenHash: await sha256Hex(refresh),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_DAYS * 86_400_000).toISOString(),
    rotatedAt: null,
    revokedAt: null,
  });
  await svc.audit.append({
    principalId: inst.principalId,
    action: "integration.token-issued",
    subject: `installation:${inst.id}`,
    payload: {
      summary: `Access token ${access.token.slice(0, 12)}… issued (${grant})`,
      grant,
      prefix: access.token.slice(0, 12),
      scopes,
      expiresAt: access.expiresAt.toISOString(),
    },
  });
  return {
    access_token: access.token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SEC,
    refresh_token: refresh,
    scope: scopes.join(" "),
    installation_id: inst.id,
  };
}

async function liveInstallation(
  svc: Services,
  id: string | null,
  integration: IntegrationRow,
): Promise<InstallationRow> {
  const inst = id ? await getInstallation(svc, id) : null;
  if (!inst || inst.integrationId !== integration.id || inst.status !== "active") {
    throw new OAuthProtocolError(
      "invalid_grant",
      "the installation was removed; install the integration again",
    );
  }
  return inst;
}

export async function exchangeIntegrationCode(
  svc: Services,
  urls: OAuthUrls,
  p: URLSearchParams,
  integration: IntegrationRow,
): Promise<IntegrationTokenResponse> {
  const code = required(p, "code");
  const redirectUri = param(p, "redirect_uri");
  const verifier = param(p, "code_verifier");
  const now = svc.clock.now();
  const row = await svc.store.db
    .select()
    .from(integrationAuthorizations)
    .where(eq(integrationAuthorizations.codeHash, await sha256Hex(code)))
    .get();
  if (!row || row.integrationId !== integration.id) {
    throw new OAuthProtocolError("invalid_grant", "unknown authorization code");
  }
  if (row.status === "redeemed") {
    const inst = row.installationId ? await getInstallation(svc, row.installationId) : null;
    if (inst) await revokeInstallationTokens(svc, inst, "authorization code reused");
    throw new OAuthProtocolError(
      "invalid_grant",
      "authorization code already used; the installation's tokens are revoked",
    );
  }
  if (row.status !== "approved")
    throw new OAuthProtocolError("invalid_grant", "authorization code is not approved");
  if (row.codeExpiresAt === null || Date.parse(row.codeExpiresAt) <= now.getTime()) {
    throw new OAuthProtocolError("invalid_grant", "authorization code expired");
  }
  if (redirectUri !== null && redirectUri !== row.redirectUri) {
    throw new OAuthProtocolError(
      "invalid_grant",
      "redirect_uri does not match the authorization request",
    );
  }
  if (verifier === null)
    throw new OAuthProtocolError("invalid_request", "code_verifier is required (PKCE S256)");
  if (!VERIFIER.test(verifier) || (await s256(verifier)) !== row.codeChallenge) {
    throw new OAuthProtocolError(
      "invalid_grant",
      "code_verifier does not match the code_challenge",
    );
  }
  for (const r of p.getAll("resource")) {
    if (r.replace(/\/+$/, "") !== urls.apiResource) {
      throw new OAuthProtocolError(
        "invalid_target",
        `integration tokens are for ${urls.apiResource} only`,
      );
    }
  }
  const claimed = await svc.store.db
    .update(integrationAuthorizations)
    .set({ status: "redeemed" })
    .where(
      and(
        eq(integrationAuthorizations.id, row.id),
        eq(integrationAuthorizations.status, "approved"),
      ),
    )
    .returning({ id: integrationAuthorizations.id });
  if (claimed.length === 0)
    throw new OAuthProtocolError("invalid_grant", "authorization code already used");
  const inst = await liveInstallation(svc, row.installationId, integration);
  const granted = scopesOf(inst.scopes);
  const scopes = scopesOf(row.requestedScopes).filter((s) => granted.includes(s));
  if (scopes.length === 0)
    throw new OAuthProtocolError("invalid_grant", "none of the requested permissions is granted");
  return issuePair(svc, urls, inst, scopes, "authorization_code");
}

export async function refreshIntegrationToken(
  svc: Services,
  urls: OAuthUrls,
  p: URLSearchParams,
  integration: IntegrationRow,
): Promise<IntegrationTokenResponse> {
  const token = required(p, "refresh_token");
  if (!isIntegrationRefreshToken(token))
    throw new OAuthProtocolError("invalid_grant", "unknown refresh token");
  const now = svc.clock.now();
  const rt = await svc.store.db
    .select()
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, await sha256Hex(token)))
    .get();
  const inst = rt
    ? await svc.store.db
        .select()
        .from(installations)
        .where(eq(installations.sessionId, rt.sessionId))
        .get()
    : undefined;
  if (!rt || !inst || inst.integrationId !== integration.id) {
    throw new OAuthProtocolError("invalid_grant", "unknown refresh token");
  }
  if (inst.status !== "active")
    throw new OAuthProtocolError("invalid_grant", "the installation was removed");
  if (rt.revokedAt !== null) throw new OAuthProtocolError("invalid_grant", "refresh token revoked");
  if (rt.rotatedAt !== null) {
    await revokeInstallationTokens(svc, inst, "refresh token reused");
    throw new OAuthProtocolError(
      "invalid_grant",
      "refresh token already used; the installation's tokens are revoked",
    );
  }
  if (Date.parse(rt.expiresAt) <= now.getTime()) {
    throw new OAuthProtocolError(
      "invalid_grant",
      "refresh token expired; run the install flow again",
    );
  }
  let scopes = scopesOf(inst.scopes);
  const narrow = param(p, "scope");
  if (narrow !== null) {
    const asked = narrow.split(/\s+/).filter(Boolean);
    const wider = asked.filter((s) => !scopes.includes(s as IntegrationScope));
    if (wider.length > 0)
      throw new OAuthProtocolError(
        "invalid_scope",
        `not granted to this installation: ${wider.join(", ")}`,
      );
    scopes = scopes.filter((s) => asked.includes(s));
  }
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
  return issuePair(svc, urls, inst, scopes, "refresh_token");
}

/** RFC 7009: revoke one access or refresh token of this integration (unknown tokens: no-op). */
export async function revokeIntegrationToken(
  svc: Services,
  p: URLSearchParams,
  integration: IntegrationRow,
): Promise<void> {
  const token = required(p, "token");
  const now = svc.clock.now().toISOString();
  const hash = await sha256Hex(token);
  const ownsPrincipal = async (principalId: string) =>
    (await svc.store.db
      .select({ id: installations.id })
      .from(installations)
      .where(
        and(
          eq(installations.principalId, principalId),
          eq(installations.integrationId, integration.id),
        ),
      )
      .get()) !== undefined;
  if (isIntegrationAccessToken(token)) {
    const row = await svc.store.db
      .select()
      .from(agentTokens)
      .where(eq(agentTokens.tokenHash, hash))
      .get();
    if (row && (await ownsPrincipal(row.principalId))) {
      await svc.store.db
        .update(agentTokens)
        .set({ revokedAt: now })
        .where(and(eq(agentTokens.id, row.id), isNull(agentTokens.revokedAt)));
    }
    return;
  }
  if (isIntegrationRefreshToken(token)) {
    const rt = await svc.store.db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.tokenHash, hash))
      .get();
    const inst = rt
      ? await svc.store.db
          .select()
          .from(installations)
          .where(eq(installations.sessionId, rt.sessionId))
          .get()
      : undefined;
    if (rt && inst?.integrationId === integration.id) {
      await svc.store.db
        .update(oauthRefreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(oauthRefreshTokens.id, rt.id), isNull(oauthRefreshTokens.revokedAt)));
    }
  }
}

/** POST /api/oauth/token for an integration client: authenticate, then the grant. */
export async function integrationTokenEndpoint(
  svc: Services,
  urls: OAuthUrls,
  p: URLSearchParams,
  authorization: string | undefined,
): Promise<IntegrationTokenResponse> {
  const integration = await authenticateClient(svc, clientCredentials(authorization, p));
  const grant = p.get("grant_type");
  if (grant === "authorization_code") return exchangeIntegrationCode(svc, urls, p, integration);
  if (grant === "refresh_token") return refreshIntegrationToken(svc, urls, p, integration);
  throw new OAuthProtocolError(
    "unsupported_grant_type",
    `grant_type ${grant ?? "(missing)"} is not supported for integrations (authorization_code, refresh_token)`,
  );
}

/** POST /api/oauth/revoke for an integration client (RFC 7009; confidential clients authenticate). */
export async function integrationRevokeEndpoint(
  svc: Services,
  p: URLSearchParams,
  authorization: string | undefined,
): Promise<void> {
  const integration = await authenticateClient(svc, clientCredentials(authorization, p));
  await revokeIntegrationToken(svc, p, integration);
}
