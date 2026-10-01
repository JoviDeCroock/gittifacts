/**
 * GET /api/oauth/authorize (OAuth 2.1 authorization code + PKCE, MCP 2026-07-28 profile).
 *
 * Order matters (RFC 6749 §4.1.2.1): until the client and its redirect_uri are verified, errors
 * are shown here and never redirected; after that they go back to the client with `state` and
 * `iss` (RFC 9207). A valid request is stored and the browser goes to the consent screen, where a
 * signed-in human decides; nothing is granted here.
 */
import { base64urlEncode } from "@app/evidence";
import type { Services } from "../app-env.js";
import { oauthRequests } from "../db/schema.js";
import { redirectAllowed, resolveClient } from "./clients.js";
import { parseRequestedScopes } from "./scopes.js";
import { type OAuthUrls, resolveAudience } from "./urls.js";

/** How long the human has to decide on the consent screen. */
export const REQUEST_TTL_MS = 10 * 60_000;

const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

export type AuthorizeOutcome =
  | { kind: "consent"; location: string; requestId: string }
  | { kind: "redirect-error"; location: string }
  | { kind: "error"; message: string; explanation: string };

export function randomId(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return base64urlEncode(b);
}

export function errorRedirect(
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
  issuer: string,
): string {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  u.searchParams.set("error_description", description);
  if (state !== null) u.searchParams.set("state", state);
  u.searchParams.set("iss", issuer);
  return u.toString();
}

function single(q: URLSearchParams, name: string): string | null | "repeated" {
  const all = q.getAll(name);
  if (all.length > 1) return "repeated";
  return all[0] ?? null;
}

export async function startAuthorization(
  svc: Services,
  urls: OAuthUrls,
  q: URLSearchParams,
): Promise<AuthorizeOutcome> {
  const clientId = single(q, "client_id");
  if (clientId === "repeated" || clientId === null) {
    return {
      kind: "error",
      message: "client_id is required (exactly once)",
      explanation: "Send client_id: an https URL serving your Client ID Metadata Document.",
    };
  }
  const resolved = await resolveClient(clientId);
  if (!resolved.ok) {
    return {
      kind: "error",
      message: resolved.message,
      explanation:
        "MCP clients identify themselves with a Client ID Metadata Document (an https client_id URL); dynamic client registration is not offered.",
    };
  }
  const client = resolved.client;
  const rawRedirect = single(q, "redirect_uri");
  if (rawRedirect === "repeated") {
    return {
      kind: "error",
      message: "redirect_uri must appear once",
      explanation: "Send one redirect_uri.",
    };
  }
  const redirectUri =
    rawRedirect ?? (client.redirectUris.length === 1 ? (client.redirectUris[0] ?? null) : null);
  if (redirectUri === null || !redirectAllowed(client, redirectUri)) {
    return {
      kind: "error",
      message: `redirect_uri ${rawRedirect ?? "(missing)"} is not registered for ${client.clientId}`,
      explanation:
        "The redirect_uri must exactly match one listed in the client's metadata document (any port for http loopback).",
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
  const method = single(q, "code_challenge_method");
  if (challenge === null || challenge === "repeated") {
    return fail(
      "invalid_request",
      "PKCE is required: send code_challenge with code_challenge_method=S256",
    );
  }
  if (method !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256 (plain is not accepted)");
  }
  if (!CODE_CHALLENGE.test(challenge)) {
    return fail(
      "invalid_request",
      "code_challenge must be a base64url SHA-256 of the code_verifier",
    );
  }
  const scopeRaw = single(q, "scope");
  if (scopeRaw === "repeated") return fail("invalid_scope", "scope must appear once");
  const scopes = parseRequestedScopes(scopeRaw);
  if (!scopes.ok) return fail("invalid_scope", scopes.description);
  const audience = resolveAudience(urls, q.getAll("resource"), "authorization_code");
  if (!audience.ok) return fail("invalid_target", audience.description);

  const now = svc.clock.now();
  const id = randomId();
  await svc.store.db.insert(oauthRequests).values({
    id,
    flow: "authorization_code",
    clientId: client.clientId,
    clientName: client.name,
    clientUri: client.uri,
    clientKind: client.kind,
    redirectUri,
    state,
    codeChallenge: challenge,
    deviceCodeId: null,
    audience: audience.audience,
    requestedScopes: scopes.scopes,
    status: "pending",
    ownerId: null,
    grantedScopes: null,
    grantedRepoIds: null,
    sessionDays: null,
    agentName: null,
    codeHash: null,
    codeExpiresAt: null,
    sessionId: null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + REQUEST_TTL_MS).toISOString(),
    decidedAt: null,
  });
  return {
    kind: "consent",
    requestId: id,
    location: `${urls.consent}?request=${encodeURIComponent(id)}`,
  };
}
