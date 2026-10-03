import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import type { Bindings } from "../src/app-env.js";
import { githubSignature } from "../src/github/crypto.js";
import type { GithubEventMessage } from "../src/github/webhook.js";
import { ORIGIN, type TestApp } from "./http.js";

const cfg = env as Bindings;
/** The Reader App the test Worker is configured with (vitest.config.ts). */
export const APP_ID = Number(cfg.GITHUB_APP_ID);
export const APP_SLUG = cfg.GITHUB_APP_SLUG as string;
export const CLIENT_ID = cfg.GITHUB_APP_CLIENT_ID as string;
export const WEBHOOK_SECRET = cfg.GITHUB_APP_WEBHOOK_SECRET as string;
export const CLIENT_SECRET = cfg.GITHUB_APP_CLIENT_SECRET as string;

/** Env overrides with GitHub mode unconfigured (every Reader App name blank). */
export const UNCONFIGURED = {
  GITHUB_APP_ID: "",
  GITHUB_APP_SLUG: "",
  GITHUB_APP_CLIENT_ID: "",
  GITHUB_APP_CLIENT_SECRET: "",
  GITHUB_APP_PRIVATE_KEY: "",
  GITHUB_APP_WEBHOOK_SECRET: "",
} satisfies Partial<Bindings>;

/** An App id that isn't ours (someone else's App, or a stale one). */
let nextAppId = 900_000 + Math.floor(Math.random() * 50_000);
export const otherAppId = () => nextAppId++;

export interface FakeQueue {
  sent: GithubEventMessage[];
  fail: boolean;
  send(body: GithubEventMessage): Promise<void>;
}

export function fakeQueue(): FakeQueue {
  const q: FakeQueue = {
    sent: [],
    fail: false,
    async send(body) {
      if (q.fail) throw new Error("queue down");
      q.sent.push(body);
    },
  };
  return q;
}

/** Call the app with env overrides (admins, a fake queue, …). */
export async function callEnv(
  app: TestApp,
  over: Partial<Bindings> & Record<string, unknown>,
  method: string,
  path: string,
  opts: { cookie?: string; body?: string | object; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  if (method !== "GET" && !headers.has("origin")) headers.set("origin", ORIGIN);
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, body, redirect: "manual" }),
    { ...env, ...over },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

let deliveries = 0;

/** A signed GitHub delivery for `appId`. */
export async function delivery(
  appId: number,
  event: string,
  payload: object,
  opts: { secret?: string; id?: string } = {},
) {
  const body = JSON.stringify(payload);
  const id =
    opts.id ??
    `0f6c5e10-${Date.now().toString(16)}-${(deliveries++).toString(16).padStart(4, "0")}`;
  return {
    id,
    body,
    headers: {
      "x-github-delivery": id,
      "x-github-event": event,
      "x-github-hook-id": "1",
      "x-github-hook-installation-target-type": "integration",
      "x-github-hook-installation-target-id": String(appId),
      "x-hub-signature-256": await githubSignature(
        opts.secret ?? WEBHOOK_SECRET,
        new TextEncoder().encode(body),
      ),
      "cf-connecting-ip": "192.0.2.10",
    },
  };
}

/** Stub GitHub (api.github.com + github.com) with a route table; returns the calls seen. */
export function stubGithub(routes: Record<string, (req: Request) => Response | Promise<Response>>) {
  const seen: { method: string; url: string; body: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      const key = `${req.method} ${url.origin}${url.pathname}`;
      seen.push({
        method: req.method,
        url: req.url,
        body: req.method === "GET" ? "" : await req.clone().text(),
      });
      const handler = routes[key];
      if (!handler)
        return new Response(JSON.stringify({ message: `no stub for ${key}` }), { status: 599 });
      return handler(req);
    },
  );
  return seen;
}

export const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
