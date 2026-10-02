/**
 * Installing an integration: OAuth 2.1 authorization code + PKCE on the platform's authorization
 * server, with the HTTP API as the only audience (`<origin>/api`) and integration scopes.
 *
 *   GET /api/oauth/authorize?client_id=gtic_…  → (this module) → /integrations/install?request=…
 *   human picks repos and approves            → installation (+ its integration principal) → code
 *   POST /api/oauth/token                      → ./tokens.ts
 *
 * Errors before the client and redirect_uri are verified are shown, never redirected (RFC 6749
 * §4.1.2.1); after that they go back to the client with `state` and `iss`.
 */
import { IntegrationScope } from "@app/domain";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Services } from "../app-env.js";
import { integrationAuthorizations } from "../db/schema.js";
import { type AuthorizeOutcome, errorRedirect, randomId } from "../oauth/authorize.js";
import { canonicalResource, type OAuthUrls } from "../oauth/urls.js";
import { getIntegrationByClientId, type IntegrationRow } from "./registry.js";
import { integrationScopesOf, parseIntegrationScopes } from "./scopes.js";

/** How long the human has to decide on the install screen. */
export const INSTALL_REQUEST_TTL_MS = 10 * 60_000;
export const INSTALL_SCREEN_PATH = "/integrations/install";

const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

function single(q: URLSearchParams, name: string): string | null | "repeated" {
  const all = q.getAll(name);
  if (all.length > 1) return "repeated";
  return all[0] ?? null;
}

export async function startIntegrationAuthorization(
  svc: Services,
  urls: OAuthUrls,
  q: URLSearchParams,
  integration: IntegrationRow,
): Promise<AuthorizeOutcome> {
  const rawRedirect = single(q, "redirect_uri");
  if (rawRedirect === "repeated") {
    return { kind: "error", message: "redirect_uri must appear once", explanation: "Send one redirect_uri." };
  }
  const registered = integration.redirectUris;
  const redirectUri = rawRedirect ?? (registered.length === 1 ? (registered[0] ?? null) : null);
  if (redirectUri === null || !registered.includes(redirectUri)) {
    return {
      kind: "error",
      message: `redirect_uri ${rawRedirect ?? "(missing)"} is not registered for ${integration.name}`,
      explanation:
        "Integration redirect URIs must match one registered in the developer portal exactly (Settings → Integrations → Developer).",
    };
  }
  const stateRaw = single(q, "state");
  const state = stateRaw === "repeated" ? null : stateRaw;
  const fail = (error: string, description: string): AuthorizeOutcome => ({
    kind: "redirect-error",
    location: errorRedirect(redirectUri, error, description, state, urls.issuer),
  });
  if (stateRaw === "repeated") return fail("invalid_request", "state must appear once");
  if (state !== null && state.length > 2048) return fail("invalid_request", "state is too long");
  if (single(q, "response_type") !== "code") {
    return fail("unsupported_response_type", "only response_type=code is supported");
  }
  const challenge = single(q, "code_challenge");
  if (challenge === null || challenge === "repeated" || single(q, "code_challenge_method") !== "S256") {
    return fail(
      "invalid_request",
      "PKCE is required for every integration: send code_challenge with code_challenge_method=S256",
    );
  }
  if (!CODE_CHALLENGE.test(challenge)) {
    return fail("invalid_request", "code_challenge must be a base64url SHA-256 of the code_verifier");
  }
  const scopeRaw = single(q, "scope");
  if (scopeRaw === "repeated") return fail("invalid_scope", "scope must appear once");
  const scopes = parseIntegrationScopes(scopeRaw, integrationScopesOf(integration.scopes));
  if (!scopes.ok) return fail("invalid_scope", scopes.description);
  for (const raw of q.getAll("resource")) {
    if (canonicalResource(raw) !== urls.apiResource) {
      return fail(
        "invalid_target",
        `integrations get tokens for the HTTP API only: send resource=${urls.apiResource} or omit it`,
      );
    }
  }
  const now = svc.clock.now();
  const id = randomId();
  await svc.store.db.insert(integrationAuthorizations).values({
    id,
    integrationId: integration.id,
    redirectUri,
    state,
    codeChallenge: challenge,
    requestedScopes: scopes.scopes,
    audience: [urls.apiResource],
    status: "pending",
    ownerId: null,
    repoSelection: null,
    grantedRepoIds: null,
    installationId: null,
    codeHash: null,
    codeExpiresAt: null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + INSTALL_REQUEST_TTL_MS).toISOString(),
    decidedAt: null,
  });
  return {
    kind: "consent",
    requestId: id,
    location: `${urls.origin}${INSTALL_SCREEN_PATH}?request=${encodeURIComponent(id)}`,
  };
}

export const InstallDecisionBody = z
  .object({
    /** `all`: every repo you may install on, now and later; `selected`: exactly `repoIds`. */
    repoSelection: z.enum(["all", "selected"]),
    repoIds: z.array(z.string().min(1).max(64)).max(200).default([]),
  })
  .meta({ id: "InstallDecision" });
export type InstallDecisionBody = z.infer<typeof InstallDecisionBody>;

export type AuthorizationRow = typeof integrationAuthorizations.$inferSelect;

export function requestedScopesOf(row: AuthorizationRow): IntegrationScope[] {
  return z.array(IntegrationScope).catch([]).parse(row.requestedScopes);
}

/** Bind an unowned request to the first human who opens it. */
export async function bindAuthorization(svc: Services, id: string, humanId: string): Promise<void> {
  await svc.store.db
    .update(integrationAuthorizations)
    .set({ ownerId: humanId })
    .where(and(eq(integrationAuthorizations.id, id), isNull(integrationAuthorizations.ownerId)));
}

/** `/api/oauth/authorize` for an integration `client_id` (gtic_…). */
export async function authorizeIntegration(
  svc: Services,
  urls: OAuthUrls,
  q: URLSearchParams,
): Promise<AuthorizeOutcome> {
  const all = q.getAll("client_id");
  const integration = all.length === 1 && all[0] ? await getIntegrationByClientId(svc, all[0]) : null;
  if (!integration) {
    return {
      kind: "error",
      message: "unknown integration client_id",
      explanation: "Register the integration in the developer portal (Settings → Integrations → Developer) and use its client_id.",
    };
  }
  return startIntegrationAuthorization(svc, urls, q, integration);
}
