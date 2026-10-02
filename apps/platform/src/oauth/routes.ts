/**
 * Routes for delegated agent auth (onboarding O4). Mounted from `registerIdentityRoutes`.
 *
 * Protocol (RFC 6749 errors, CORS-open, no cookies):
 *   GET  /.well-known/oauth-authorization-server          RFC 8414
 *   GET  /.well-known/oauth-protected-resource[/mcp|/api]  RFC 9728
 *   GET  /api/oauth/authorize                              code + PKCE S256 → consent screen
 *   POST /api/oauth/token                                  authorization_code | refresh_token | device_code
 *   POST /api/oauth/revoke                                 RFC 7009
 *   POST /api/auth/device/code                             RFC 8628 (better-auth plugin, mounted by better-auth)
 * Platform JSON (signed-in humans only, `{ error: { code, message, fix } }`):
 *   GET  /api/v1/oauth/requests/{id}          + POST …/approve, …/deny
 *   GET  /api/v1/oauth/device/{userCode}      + POST …/approve, …/deny
 *   GET  /api/v1/agent-sessions               + POST /api/v1/agent-sessions/{principalId}/revoke
 */
import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import { z } from "zod";
import { ErrorSchema, IdempotencyHeaders } from "../api/schemas.js";
import type { AppEnv } from "../app-env.js";
import { authFor, callerOf, requirePrincipal } from "../auth/middleware.js";
import { idempotent } from "../idempotency.js";
import { type ApiApp, body, errors, json, SECURITY } from "../routes/common.js";
import { startAuthorization } from "./authorize.js";
import {
  approveAuthorization,
  approveDevice,
  ConsentDecisionBody,
  ConsentViewSchema,
  denyAuthorization,
  denyDevice,
  getAuthorizationConsent,
  getDeviceConsent,
} from "./consent.js";
import { urlsFor } from "./context.js";
import { OAuthProtocolError, oauthErrorBody } from "./errors.js";
import {
  AS_METADATA_PATH,
  authorizationServerMetadata,
  DEVICE_GRANT_TYPE,
  protectedResourceDocuments,
} from "./metadata.js";
import { AgentSessionSchema, listAgentSessions, revokeAgentSession } from "./sessions.js";
import {
  exchangeAuthorizationCode,
  exchangeDeviceCode,
  exchangeRefreshToken,
  revokeToken,
  type TokenResponse,
} from "./tokens.js";
import { isIntegrationClientId } from "../integrations/crypto.js";
import { authorizeIntegration } from "../integrations/install.js";
import {
  integrationRevokeEndpoint,
  integrationTokenEndpoint,
  isIntegrationRequest,
} from "../integrations/tokens.js";
import { OAUTH_PATHS } from "./urls.js";

const CORS_OPEN: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization, MCP-Protocol-Version",
};

const NO_STORE: Record<string, string> = { "cache-control": "no-store", pragma: "no-cache" };

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_OPEN, ...headers },
  });
}

/** Form (RFC 6749) or JSON bodies → URLSearchParams. */
async function readParams(c: Context<AppEnv>): Promise<URLSearchParams> {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  // arrayBuffer: workerd warns when .text() reads a form-encoded body.
  const raw = new TextDecoder().decode(await c.req.arrayBuffer());
  if (type.includes("application/x-www-form-urlencoded") || type === "") {
    return new URLSearchParams(raw);
  }
  if (type.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new OAuthProtocolError("invalid_request", "body is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new OAuthProtocolError("invalid_request", "body must be an object");
    }
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") p.append(k, v);
      else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") p.append(k, x);
    }
    return p;
  }
  throw new OAuthProtocolError(
    "invalid_request",
    "send application/x-www-form-urlencoded (RFC 6749 §3.2)",
  );
}

async function protocol(c: Context<AppEnv>, run: () => Promise<Response>): Promise<Response> {
  const host = urlsFor(c).origin;
  try {
    return await run();
  } catch (e) {
    if (e instanceof OAuthProtocolError)
      return jsonResponse(oauthErrorBody(e, host), e.status, NO_STORE);
    console.error("oauth endpoint failed", e);
    const err = new OAuthProtocolError("server_error", "unexpected error; retry", 500);
    return jsonResponse(oauthErrorBody(err, host), 500, NO_STORE);
  }
}

const RequestIdParam = z.object({ id: z.string().min(16).max(128) });
const UserCodeParam = z.object({ userCode: z.string().min(4).max(64) });
const PrincipalParam = z.object({ principalId: z.string().min(1).max(64) });
const humanOnly = requirePrincipal([], { humanOnly: true });

const getRequest = createRoute({
  method: "get",
  path: "/api/v1/oauth/requests/{id}",
  tags: ["oauth"],
  summary: "What an OAuth client asks for, in plain terms (consent screen)",
  description: "Humans only. The first signed-in human to open a request owns its decision.",
  security: SECURITY,
  middleware: [humanOnly] as const,
  request: { params: RequestIdParam },
  responses: {
    200: json(z.object({ consent: ConsentViewSchema }), "Consent"),
    ...errors(401, 403, 404),
  },
});

const RedirectSchema = z.object({ redirectTo: z.string() });

const approveRequest = createRoute({
  method: "post",
  path: "/api/v1/oauth/requests/{id}/approve",
  tags: ["oauth"],
  summary:
    "Approve an OAuth client: scopes, repos and session length; returns where to send the browser",
  description:
    "Humans only. Scopes must be a subset of repo:read, plan:create, change:create you hold; agents can never get plan:approve, change:review, policy:admin or repo:admin. repoIds: specific repos, or null for every repo (explicit).",
  security: SECURITY,
  middleware: [humanOnly, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: RequestIdParam, body: body(ConsentDecisionBody) },
  responses: { 200: json(RedirectSchema, "Approved"), ...errors(400, 401, 403, 404, 409) },
});

const denyRequest = createRoute({
  method: "post",
  path: "/api/v1/oauth/requests/{id}/deny",
  tags: ["oauth"],
  summary: "Deny an OAuth client; returns where to send the browser",
  security: SECURITY,
  middleware: [humanOnly, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: RequestIdParam },
  responses: { 200: json(RedirectSchema, "Denied"), ...errors(401, 403, 404, 409) },
});

const getDevice = createRoute({
  method: "get",
  path: "/api/v1/oauth/device/{userCode}",
  tags: ["oauth"],
  summary: "What a device (CLI) login asks for (device screen); binds the code to you",
  security: SECURITY,
  middleware: [humanOnly] as const,
  request: { params: UserCodeParam },
  responses: {
    200: json(z.object({ consent: ConsentViewSchema }), "Consent"),
    ...errors(401, 403, 404, 409),
  },
});

const approveDeviceRoute = createRoute({
  method: "post",
  path: "/api/v1/oauth/device/{userCode}/approve",
  tags: ["oauth"],
  summary: "Approve a device login with scopes, repos and session length",
  security: SECURITY,
  middleware: [humanOnly, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: UserCodeParam, body: body(ConsentDecisionBody) },
  responses: {
    200: json(z.object({ status: z.literal("approved") }), "Approved"),
    ...errors(400, 401, 403, 404, 409),
  },
});

const denyDeviceRoute = createRoute({
  method: "post",
  path: "/api/v1/oauth/device/{userCode}/deny",
  tags: ["oauth"],
  summary: "Deny a device login",
  security: SECURITY,
  middleware: [humanOnly, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: UserCodeParam },
  responses: {
    200: json(z.object({ status: z.literal("denied") }), "Denied"),
    ...errors(401, 403, 404, 409),
  },
});

const listSessions = createRoute({
  method: "get",
  path: "/api/v1/agent-sessions",
  tags: ["oauth"],
  summary: "Your agents' sessions: client, scopes, repos, created, last used, expiry, status",
  security: SECURITY,
  middleware: [humanOnly] as const,
  responses: {
    200: json(z.object({ sessions: z.array(AgentSessionSchema) }), "Sessions"),
    ...errors(401, 403),
  },
});

const revokeSessionRoute = createRoute({
  method: "post",
  path: "/api/v1/agent-sessions/{principalId}/revoke",
  tags: ["oauth"],
  summary: "Revoke an agent session: all its tokens stop working now and the agent is disabled",
  security: SECURITY,
  middleware: [humanOnly, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: PrincipalParam },
  responses: {
    200: json(z.object({ session: AgentSessionSchema }), "Revoked"),
    ...errors(401, 403, 404),
  },
});

function registerProtocolDocs(app: ApiApp): void {
  const form = (schema: z.ZodType) => ({
    content: { "application/x-www-form-urlencoded": { schema } },
    required: true,
  });
  const oauthError = {
    description: "RFC 6749 §5.2 error, plus a `fix`",
    content: {
      "application/json": {
        schema: z.object({ error: z.string(), error_description: z.string(), fix: z.unknown() }),
      },
    },
  };
  app.openAPIRegistry.registerPath({
    method: "get",
    path: OAUTH_PATHS.authorize,
    tags: ["oauth"],
    summary:
      "OAuth 2.1 authorization endpoint (code + PKCE S256 required); redirects to the consent screen",
    request: {
      query: z.object({
        response_type: z.literal("code"),
        client_id: z
          .string()
          .describe("https URL of a Client ID Metadata Document, or gittifacts-cli"),
        redirect_uri: z.string(),
        code_challenge: z.string(),
        code_challenge_method: z.literal("S256"),
        scope: z.string().optional().describe("Subset of: repo:read plan:create change:create"),
        state: z.string().optional(),
        resource: z
          .string()
          .optional()
          .describe("RFC 8707: <origin>/mcp (default) or <origin>/api"),
      }),
    },
    responses: {
      302: { description: "To the consent screen, or back to the client with error/state/iss" },
      400: {
        description: "Unknown client or redirect_uri",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: OAUTH_PATHS.token,
    tags: ["oauth"],
    summary:
      "Token endpoint: authorization_code (PKCE), refresh_token (rotating), device_code (RFC 8628)",
    request: {
      body: form(
        z.object({
          grant_type: z.enum(["authorization_code", "refresh_token", DEVICE_GRANT_TYPE]),
          client_id: z.string(),
          code: z.string().optional(),
          code_verifier: z.string().optional(),
          redirect_uri: z.string().optional(),
          refresh_token: z.string().optional(),
          device_code: z.string().optional(),
          scope: z.string().optional(),
          resource: z.string().optional(),
        }),
      ),
    },
    responses: {
      200: {
        description: "Tokens (agent token bound to a new agent principal)",
        content: {
          "application/json": {
            schema: z.object({
              access_token: z.string(),
              token_type: z.literal("Bearer"),
              expires_in: z.number(),
              refresh_token: z.string(),
              scope: z.string(),
            }),
          },
        },
      },
      400: oauthError,
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: OAUTH_PATHS.revoke,
    tags: ["oauth"],
    summary: "RFC 7009 revocation (refresh token: ends the whole session)",
    request: {
      body: form(z.object({ token: z.string(), token_type_hint: z.string().optional() })),
    },
    responses: { 200: { description: "Revoked (or unknown: also 200)" }, 400: oauthError },
  });
}

export function registerOAuthRoutes(app: ApiApp): void {
  // ---- discovery
  app.get(AS_METADATA_PATH, (c) =>
    jsonResponse(authorizationServerMetadata(urlsFor(c)), 200, {
      "cache-control": "public, max-age=3600",
    }),
  );
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource/api",
  ]) {
    app.get(path, (c) => {
      const doc = protectedResourceDocuments(urlsFor(c), c.env.VERSION?.id ?? "dev").find(
        (d) => d.path === path,
      );
      if (!doc) return jsonResponse({ error: "not_found" }, 404);
      return new Response(JSON.stringify(doc.body), {
        status: 200,
        headers: { "content-type": doc.contentType, ...doc.headers },
      });
    });
  }

  // ---- protocol
  app.get(OAUTH_PATHS.authorize, async (c) => {
    const urls = urlsFor(c);
    const q = new URL(c.req.url).searchParams;
    // Integration clients (deploy platforms, `gtic_…`) install on repos instead (src/integrations).
    const out = isIntegrationClientId(q.get("client_id"))
      ? await authorizeIntegration(c.get("services"), urls, q)
      : await startAuthorization(c.get("services"), urls, q);
    if (out.kind !== "error") return c.redirect(out.location, 302);
    if ((c.req.header("accept") ?? "").includes("text/html")) {
      const u = new URL(urls.consent);
      u.searchParams.set("error", "invalid_request");
      u.searchParams.set("error_description", out.message);
      return c.redirect(u.toString(), 302);
    }
    return c.json(
      {
        error: {
          code: "invalid-request",
          message: out.message,
          fix: { explanation: out.explanation, docsUrl: `${urls.origin}/start` },
        },
      },
      400,
    );
  });

  for (const path of [OAUTH_PATHS.token, OAUTH_PATHS.revoke]) {
    app.options(path, () => new Response(null, { status: 204, headers: CORS_OPEN }));
  }

  app.post(OAUTH_PATHS.token, (c) =>
    protocol(c, async () => {
      const svc = c.get("services");
      const p = await readParams(c);
      const authorization = c.req.header("authorization");
      if (isIntegrationRequest(authorization, p)) {
        const out = await integrationTokenEndpoint(svc, urlsFor(c), p, authorization);
        return jsonResponse(out, 200, NO_STORE);
      }
      const grant = p.get("grant_type");
      let tokens: TokenResponse;
      if (grant === "authorization_code") tokens = await exchangeAuthorizationCode(svc, p);
      else if (grant === "refresh_token") tokens = await exchangeRefreshToken(svc, p);
      else if (grant === DEVICE_GRANT_TYPE) tokens = await exchangeDeviceCode(svc, authFor(c), p);
      else {
        throw new OAuthProtocolError(
          "unsupported_grant_type",
          `grant_type ${grant ?? "(missing)"} is not supported`,
        );
      }
      return jsonResponse(tokens, 200, NO_STORE);
    }),
  );

  app.post(OAUTH_PATHS.revoke, (c) =>
    protocol(c, async () => {
      const p = await readParams(c);
      const authorization = c.req.header("authorization");
      if (isIntegrationRequest(authorization, p)) {
        await integrationRevokeEndpoint(c.get("services"), p, authorization);
      } else {
        await revokeToken(c.get("services"), p);
      }
      return jsonResponse({}, 200, NO_STORE);
    }),
  );

  // ---- consent (authorization code)
  app.openapi(getRequest, async (c) => {
    const consent = await getAuthorizationConsent(
      c.get("services"),
      urlsFor(c),
      callerOf(c),
      c.req.valid("param").id,
    );
    return c.json({ consent }, 200);
  });
  app.openapi(approveRequest, async (c) =>
    c.json(
      await approveAuthorization(
        c.get("services"),
        urlsFor(c),
        callerOf(c),
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
      200,
    ),
  );
  app.openapi(denyRequest, async (c) =>
    c.json(
      await denyAuthorization(c.get("services"), urlsFor(c), callerOf(c), c.req.valid("param").id),
      200,
    ),
  );

  // ---- consent (device flow)
  app.openapi(getDevice, async (c) => {
    const consent = await getDeviceConsent(
      c.get("services"),
      urlsFor(c),
      callerOf(c),
      authFor(c),
      c.req.raw.headers,
      c.req.valid("param").userCode,
    );
    return c.json({ consent }, 200);
  });
  app.openapi(approveDeviceRoute, async (c) =>
    c.json(
      await approveDevice(
        c.get("services"),
        urlsFor(c),
        callerOf(c),
        authFor(c),
        c.req.raw.headers,
        c.req.valid("param").userCode,
        c.req.valid("json"),
      ),
      200,
    ),
  );
  app.openapi(denyDeviceRoute, async (c) =>
    c.json(
      await denyDevice(
        c.get("services"),
        urlsFor(c),
        callerOf(c),
        authFor(c),
        c.req.raw.headers,
        c.req.valid("param").userCode,
      ),
      200,
    ),
  );

  // ---- sessions
  app.openapi(listSessions, async (c) =>
    c.json({ sessions: await listAgentSessions(c.get("services"), callerOf(c)) }, 200),
  );
  app.openapi(revokeSessionRoute, async (c) =>
    c.json(
      {
        session: await revokeAgentSession(
          c.get("services"),
          urlsFor(c),
          callerOf(c),
          c.req.valid("param").principalId,
        ),
      },
      200,
    ),
  );

  registerProtocolDocs(app);
}
