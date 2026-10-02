/**
 * POST /mcp — stateless streamable HTTP MCP (SDK v2 `createMcpHandler`, a fresh server per
 * request), behind an Origin check and the agent bearer gate.
 *
 * Auth gate (MCP 2026-07-28 authorization, RFC 6750 / RFC 9728 / RFC 8707):
 * - no token, and the request only initializes, lists tools or calls create_project / whoami →
 *   served anonymously (O3: create_project then makes an unclaimed project with its own token);
 * - no token otherwise → 401 `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="…"`
 *   so OAuth clients discover the authorization server;
 * - invalid, expired, revoked token or disabled principal → 401 `error="invalid_token"`;
 * - a token whose audience is not this MCP server (e.g. HTTP-API-only) → 401 `error="invalid_token"`.
 * Scope and repo checks happen per tool (`insufficient-scope` / `repo-not-granted` tool errors).
 */
import { fixFor, mcpAuthChallenge } from "@app/conventions";
import { createMcpServer } from "@app/mcp";
import {
  type AuthInfo,
  createMcpHandler,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import { verifyAgentToken } from "../auth/agent-tokens.js";
import { authBaseUrl } from "../auth/better-auth.js";
import { toErrorResponse } from "../errors.js";
import { anonymousClient } from "../limits/client.js";
import { enforceUnclaimedRequestRate } from "../limits/request-limit.js";
import { urlsFor } from "../oauth/context.js";
import { DELEGABLE_SCOPES } from "../oauth/scopes.js";
import { audienceAllows } from "../oauth/urls.js";
import { ANONYMOUS_CLIENT_ID, createPlatformMcpBackend } from "./backend.js";

export const MCP_PATH = "/mcp";

/** JSON-RPC methods a caller without credentials may send (O3, unclaimed projects). */
const ANONYMOUS_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
]);
/** Tools a caller without credentials may call. */
export const ANONYMOUS_TOOLS = new Set(["create_project", "whoami"]);

/** True when every message in the request is one an anonymous caller may send. */
export async function anonymousAllowed(req: Request): Promise<boolean> {
  // GET (SSE) and DELETE (session end) carry no tool call; the stateless handler answers 405.
  if (req.method !== "POST") return req.method === "GET" || req.method === "DELETE";
  let body: unknown;
  try {
    body = await req.clone().json();
  } catch {
    return false;
  }
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return false;
  return messages.every((m) => {
    if (typeof m !== "object" || m === null) return false;
    const { method, params } = m as { method?: unknown; params?: unknown };
    if (typeof method !== "string") return false;
    if (ANONYMOUS_METHODS.has(method)) return true;
    if (method !== "tools/call" || typeof params !== "object" || params === null) return false;
    const name = (params as { name?: unknown }).name;
    return typeof name === "string" && ANONYMOUS_TOOLS.has(name);
  });
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1] ?? null;
}

function challenge(
  status: 401,
  wwwAuthenticate: string,
  message: string,
  host: string,
  explanation?: string,
): Response {
  const base = fixFor("unauthorized", { host });
  const body = {
    error: {
      code: "unauthorized",
      message,
      fix: explanation === undefined ? base : { ...base, explanation },
    },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "www-authenticate": wwwAuthenticate,
      "cache-control": "no-store",
    },
  });
}

export async function handleMcp(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url);
  // Browsers may only call from our own origin (DNS-rebinding / CSRF); no Origin (agents) is fine.
  const allowed = [...new Set([new URL(authBaseUrl(c.env, url.origin)).hostname, url.hostname])];
  const badOrigin = originValidationResponse(c.req.raw, allowed);
  if (badOrigin) return badOrigin;

  const svc = c.get("services");
  const urls = urlsFor(c);
  const discovery = {
    host: urls.origin,
    mcpUrl: urls.mcpResource,
    authorizationServers: [urls.issuer],
    scopes: DELEGABLE_SCOPES,
  };

  const token = bearerToken(c.req.header("authorization"));
  if (!token) {
    // O3: without credentials an agent may initialize, list tools and call create_project or
    // whoami (an unclaimed project and its own token); everything else still gets the OAuth
    // challenge, so OAuth clients discover the authorization server as before.
    if (await anonymousAllowed(c.req.raw)) {
      const anonymous = await anonymousClient(c.req.raw, c.env);
      const backend = createPlatformMcpBackend(svc);
      const handler = createMcpHandler(() => createMcpServer(backend));
      return handler.fetch(c.req.raw, {
        authInfo: {
          token: "",
          clientId: ANONYMOUS_CLIENT_ID,
          // Only what create_project's own scope check asks for; the gate and the backend admit
          // nothing but create_project and whoami for this caller.
          scopes: ["repo:read", "change:create"],
          expiresAt: Math.floor(svc.clock.now().getTime() / 1000) + 600,
          resource: new URL(urls.mcpResource),
          extra: { anonymous },
        },
      });
    }
    // RFC 6750 §3.1: no error code when the request carried no credentials.
    return challenge(401, mcpAuthChallenge(discovery), "authentication required", urls.origin);
  }
  const v = await verifyAgentToken(svc.store, token, svc.clock.now(), svc.waitUntil);
  if (!v) {
    return challenge(
      401,
      mcpAuthChallenge(discovery, {
        code: "invalid_token",
        description: "invalid, expired or revoked token",
      }),
      "invalid, expired or revoked agent token",
      urls.origin,
    );
  }
  if (!audienceAllows(v.audience, urls.mcpResource)) {
    return challenge(
      401,
      mcpAuthChallenge(discovery, {
        code: "invalid_token",
        description: `token audience is not ${urls.mcpResource}`,
      }),
      `this token was issued for ${v.audience?.join(", ")}, not this MCP server`,
      urls.origin,
      `Authorize again with resource=${urls.mcpResource} (MCP clients do this from the 401's resource_metadata).`,
    );
  }

  // O3: an unclaimed project's token is limited to so many requests per minute.
  try {
    await enforceUnclaimedRequestRate(c.env, v.principal);
  } catch (e) {
    const r = toErrorResponse(e);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: {
        "content-type": "application/json",
        "retry-after": "60",
        "cache-control": "no-store",
      },
    });
  }

  const authInfo: AuthInfo = {
    token,
    clientId: v.principal.id,
    scopes: [...v.principal.scopes],
    // The SDK expects expiresAt, even for long-lived tokens.
    expiresAt: v.expiresAtSec,
    resource: new URL(urls.mcpResource),
    extra: { principal: v.principal },
  };

  const backend = createPlatformMcpBackend(svc);
  const handler = createMcpHandler(() => createMcpServer(backend));
  return handler.fetch(c.req.raw, { authInfo });
}
