import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import type { Bindings } from "../src/app-env.js";
import { githubKeys, githubSignature, sealCredential } from "../src/github/crypto.js";
import type { GithubEventMessage } from "../src/github/webhook.js";
import { insertApp } from "../src/github/store.js";
import { store } from "./fixtures.js";
import { ORIGIN, type TestApp } from "./http.js";

export const WEBHOOK_SECRET = "whsec-test-0123456789";
export const CLIENT_SECRET = "cs-test-secret";
export const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----\n";

let nextAppId = 900_000 + Math.floor(Math.random() * 50_000);
export const newAppId = () => nextAppId++;

/** Insert an App row the way the manifest callback would (sealed credentials). */
export async function seedApp(id = newAppId(), kind: "reader" | "actor" = "reader") {
  const keys = await githubKeys((env as Bindings).GITHUB_APP_KEK);
  const now = new Date().toISOString();
  await insertApp(store().db, {
    id,
    kind,
    slug: `gittifacts-test-${id}`,
    name: `gittifacts test ${id}`,
    ownerLogin: "gf-test-org",
    ownerType: "Organization",
    clientId: `Iv23test${id}`,
    htmlUrl: `https://github.com/apps/gittifacts-test-${id}`,
    clientSecretEnc: await sealCredential(keys, id, "client_secret", CLIENT_SECRET),
    webhookSecretEnc: await sealCredential(keys, id, "webhook_secret", WEBHOOK_SECRET),
    pemEnc: await sealCredential(keys, id, "pem", PEM),
    permissions: { metadata: "read", checks: "write" },
    events: ["pull_request"],
    createdBy: "hu_test",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

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
  const id = opts.id ?? `0f6c5e10-${Date.now().toString(16)}-${(deliveries++).toString(16).padStart(4, "0")}`;
  return {
    id,
    body,
    headers: {
      "x-github-delivery": id,
      "x-github-event": event,
      "x-github-hook-id": "1",
      "x-github-hook-installation-target-type": "integration",
      "x-github-hook-installation-target-id": String(appId),
      "x-hub-signature-256": await githubSignature(opts.secret ?? WEBHOOK_SECRET, new TextEncoder().encode(body)),
      "cf-connecting-ip": "192.0.2.10",
    },
  };
}

/** Stub GitHub (api.github.com + github.com) with a route table; returns the calls seen. */
export function stubGithub(routes: Record<string, (req: Request) => Response | Promise<Response>>) {
  const seen: { method: string; url: string; body: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const key = `${req.method} ${url.origin}${url.pathname}`;
    seen.push({ method: req.method, url: req.url, body: req.method === "GET" ? "" : await req.clone().text() });
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ message: `no stub for ${key}` }), { status: 599 });
    return handler(req);
  });
  return seen;
}

export const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A real RSA private key (PKCS#8 PEM), generated per run: App JWTs must sign. */
export async function rsaPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

/** An App row whose PEM can really sign (for code paths that mint JWTs). */
export async function seedSigningApp(id = newAppId()): Promise<number> {
  await seedApp(id);
  const keys = await githubKeys((env as Bindings).GITHUB_APP_KEK);
  const { githubApps } = await import("../src/db/github-schema.js");
  const { eq } = await import("drizzle-orm");
  await store().db.update(githubApps).set({ pemEnc: await sealCredential(keys, id, "pem", await rsaPem()) }).where(eq(githubApps.id, id));
  return id;
}
