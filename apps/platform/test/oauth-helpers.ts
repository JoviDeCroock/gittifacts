import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Repo } from "@app/domain";
import { base64urlEncode } from "@app/evidence";
import { createPlatformClient } from "@app/mcp/client";
import { expect, vi } from "vitest";
import { repoFixture, store } from "./fixtures.js";
import { call, json, ORIGIN, type TestApp } from "./http.js";

export const CLIENT_ID = "https://client.example/oauth/client.json";
export const REDIRECT = "https://client.example/callback";
export const MCP_RESOURCE = `${ORIGIN}/mcp`;
export const API_RESOURCE = `${ORIGIN}/api`;
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface OAuthErrorBody {
  error: string;
  error_description: string;
  fix: { explanation: string };
}

export function cimdDocument(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: CLIENT_ID,
    client_name: "Example MCP Client",
    client_uri: "https://client.example",
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...over,
  };
}

/** Serve the client's metadata document (CIMD) from the test; everything else passes through. */
export function mockCimd(doc: Record<string, unknown> = cimdDocument()) {
  const real = globalThis.fetch;
  const seen: string[] = [];
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://client.example/")) {
        seen.push(url);
        if (url === CLIENT_ID) {
          return new Response(JSON.stringify(doc), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }
      return real(input, init);
    });
  return { spy, seen };
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = base64urlEncode(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64urlEncode(new Uint8Array(digest)) };
}

/** application/x-www-form-urlencoded POST, the way OAuth clients and CLIs call (no Origin, no cookie). */
export async function postForm(
  app: TestApp,
  path: string,
  params: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(params).toString(),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

export async function expectOAuthError(
  res: Response,
  status: number,
  error: string,
): Promise<OAuthErrorBody> {
  const body = await json<OAuthErrorBody>(res);
  expect({ status: res.status, error: body.error }).toEqual({ status, error });
  expect(body.fix.explanation.length).toBeGreaterThan(0);
  return body;
}

/** `n` claimed repos; `ownerId` (a human) owns them, so it can see them and delegate them. */
export async function seedRepos(n: number, ownerId: string | null = null): Promise<Repo[]> {
  const s = store();
  const out: Repo[] = [];
  for (let i = 0; i < n; i++) {
    const r = repoFixture({ claim: { status: "claimed", ownerId, expiresAt: null } });
    await s.insertRepo(r);
    out.push(r);
  }
  return out;
}

export interface AuthorizeParams {
  scope?: string;
  resource?: string | null;
  state?: string;
  challenge: string;
  method?: string | null;
  redirectUri?: string;
  clientId?: string;
}

export function authorizeQuery(p: AuthorizeParams): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId ?? CLIENT_ID,
    redirect_uri: p.redirectUri ?? REDIRECT,
    state: p.state ?? "st-1",
    scope: p.scope ?? "repo:read change:create",
  });
  if (p.challenge !== "") q.set("code_challenge", p.challenge);
  if (p.method !== null) q.set("code_challenge_method", p.method ?? "S256");
  if (p.resource !== null) q.set("resource", p.resource ?? MCP_RESOURCE);
  return q.toString();
}

/** authorize → consent screen request id (asserts the 302). */
export async function startAuthorize(app: TestApp, p: AuthorizeParams): Promise<string> {
  const res = await call(app, "GET", `/api/oauth/authorize?${authorizeQuery(p)}`);
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location") ?? "");
  expect(`${loc.origin}${loc.pathname}`).toBe(`${ORIGIN}/oauth/consent`);
  const id = loc.searchParams.get("request");
  expect(id).toBeTruthy();
  return id ?? "";
}

export interface Decision {
  scopes?: string[];
  repoIds: string[] | null;
  sessionDays?: number;
  name?: string;
}

/** Approve on the consent screen; returns the code from the redirect. */
export async function approveRequest(
  app: TestApp,
  cookie: string,
  requestId: string,
  d: Decision,
): Promise<{ code: string; redirect: URL }> {
  const res = await call(app, "POST", `/api/v1/oauth/requests/${requestId}/approve`, {
    cookie,
    body: {
      scopes: d.scopes ?? ["repo:read", "change:create"],
      repoIds: d.repoIds,
      sessionDays: d.sessionDays ?? 7,
      ...(d.name ? { name: d.name } : {}),
    },
  });
  expect(res.status).toBe(200);
  const { redirectTo } = await json<{ redirectTo: string }>(res);
  const redirect = new URL(redirectTo);
  return { code: redirect.searchParams.get("code") ?? "", redirect };
}

/** The whole authorization-code + PKCE dance for a signed-in human. */
export async function connectClient(
  app: TestApp,
  cookie: string,
  d: Decision & { scope?: string; resource?: string },
): Promise<TokenResponse> {
  const { verifier, challenge } = await pkce();
  const id = await startAuthorize(app, {
    challenge,
    ...(d.scope ? { scope: d.scope } : {}),
    ...(d.resource ? { resource: d.resource } : {}),
  });
  const { code } = await approveRequest(app, cookie, id, d);
  const res = await postForm(app, "/api/oauth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    resource: d.resource ?? MCP_RESOURCE,
  });
  expect(res.status).toBe(200);
  return json<TokenResponse>(res);
}

export function fetchVia(app: TestApp) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(input, init), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
}

export function mcpClient(app: TestApp, token: string) {
  return createPlatformClient(`${ORIGIN}/mcp`, token, { fetch: fetchVia(app) });
}

/**
 * POST /mcp with a raw JSON-RPC body (for status/header assertions). A tool that needs a token:
 * since O3, initialize, tools/list, create_project and whoami are also served without one.
 */
export async function rawMcp(app: TestApp, token?: string): Promise<Response> {
  return call(app, "POST", "/mcp", {
    ...(token ? { token } : {}),
    headers: { accept: "application/json, text/event-stream" },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_repos", arguments: {} },
    },
  });
}
