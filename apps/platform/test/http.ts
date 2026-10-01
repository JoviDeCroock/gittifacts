import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CoordinatorApi } from "@app/coordinator";
import type { Principal } from "@app/domain";
import { expect } from "vitest";
import { createApp } from "../src/app.js";
import { coordinatorStub } from "../src/coordinator-stub.js";

export const ORIGIN = "http://localhost";

export type TestApp = ReturnType<typeof createApp>;

/** The real app with a mocked CoordinatorApi (lifecycle calls). */
export function makeApp(coordinator: Partial<CoordinatorApi> = {}): {
  app: TestApp;
  coordinator: CoordinatorApi;
} {
  const mock: CoordinatorApi = { ...coordinatorStub, ...coordinator };
  return { app: createApp({ coordinator: () => mock }), coordinator: mock };
}

export interface CallOptions {
  token?: string;
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function call(
  app: TestApp,
  method: string,
  path: string,
  opts: CallOptions = {},
): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  if (method !== "GET" && !headers.has("origin")) headers.set("origin", ORIGIN);
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    fix: { explanation: string; call?: string; command?: string };
    details?: unknown;
  };
}

/** Assert status + error code, and that every error carries a fix hint. */
export async function expectError(
  res: Response,
  status: number,
  code: string,
): Promise<ErrorEnvelope> {
  const body = await json<ErrorEnvelope>(res);
  expect({ status: res.status, code: body.error?.code }).toEqual({ status, code });
  expect(body.error.fix.explanation.length).toBeGreaterThan(0);
  return body;
}

let users = 0;

/** Sign up a human via better-auth; returns the session cookie and the auto-created principal. */
export async function signUpHuman(
  app: TestApp,
  name = "Ada",
): Promise<{ cookie: string; principal: Principal }> {
  users++;
  const email = `user${users}-${Date.now()}@example.com`;
  const res = await call(app, "POST", "/api/auth/sign-up/email", {
    body: { email, password: "correct-horse-battery-staple", name },
  });
  expect(res.status).toBe(200);
  await res.text();
  const setCookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("better-auth.session_token="));
  expect(setCookie).toBeDefined();
  const cookie = setCookie!.split(";")[0]!;
  const me = await call(app, "GET", "/api/v1/me", { cookie });
  expect(me.status).toBe(200);
  const { principal } = await json<{ principal: Principal }>(me);
  return { cookie, principal };
}

export async function createAgent(
  app: TestApp,
  cookie: string,
  scopes: string[] = ["repo:read", "plan:create", "change:create"],
): Promise<{ token: string; principal: Principal }> {
  const res = await call(app, "POST", "/api/v1/principals/agents", {
    cookie,
    body: { name: "builder-bot", scopes },
  });
  expect(res.status).toBe(201);
  return json<{ token: string; principal: Principal }>(res);
}
