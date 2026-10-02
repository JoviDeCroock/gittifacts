/**
 * A mock deploy platform for the integrations acceptance test: a fake Artifacts git upstream
 * (smart HTTP over `https://fake.artifacts.test`), a webhook receiver at
 * `https://deploy.example/hooks`, and the OAuth client side (PKCE, Basic client auth).
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { configureIntegrationGitHost } from "../src/integrations/git-host.js";
import { ORIGIN, type TestApp } from "./http.js";

export const HOOK_URL = "https://deploy.example/hooks";
export const CALLBACK = "https://deploy.example/oauth/callback";
export const UPSTREAM = "https://fake.artifacts.test";

/** Bytes the fake upstream answers with (passed through verbatim by the proxy). */
export const ADVERTISEMENT = "001e# service=git-upload-pack\n0000003fbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/heads/main\0side-band-64k\n0000";
export const PACK_RESULT = "0008NAK\nPACK-fake";

export interface Seen {
  upstream: { url: string; method: string; authorization: string | null; body: string; gitProtocol: string | null }[];
  hooks: { headers: Record<string, string>; body: string }[];
  minted: { repo: string; scope: string; ttl: number }[];
}

/** Fake Artifacts (token minting + smart HTTP) and the webhook receiver; everything else passes. */
export function mockPlatform(): Seen {
  const seen: Seen = { upstream: [], hooks: [], minted: [] };
  configureIntegrationGitHost(() => ({
    async mintToken(repo, scope, ttl) {
      seen.minted.push({ repo, scope, ttl });
      return { token: `art_v2_fake_${repo}?expires=9999999999`, expiresAt: "2099-01-01T00:00:00.000Z" };
    },
    remoteOf: (name) => `${UPSTREAM}/git/gittifacts-eu/${name}.git`,
  }));
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url.startsWith(UPSTREAM)) {
      seen.upstream.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.get("authorization"),
        body: req.method === "POST" ? bytesText(await req.arrayBuffer()) : "",
        gitProtocol: req.headers.get("git-protocol"),
      });
      const refs = req.url.includes("/info/refs");
      return new Response(refs ? ADVERTISEMENT : PACK_RESULT, {
        status: 200,
        headers: {
          "content-type": refs ? "application/x-git-upload-pack-advertisement" : "application/x-git-upload-pack-result",
        },
      });
    }
    if (req.url === HOOK_URL) {
      seen.hooks.push({ headers: Object.fromEntries(req.headers), body: await req.text() });
      return new Response("ok", { status: 200 });
    }
    return real(input, init);
  });
  return seen;
}

/** A raw request through the app (git clients: custom auth, binary bodies). */
export async function raw(
  app: TestApp,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body }) }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** Binary git bodies as text, without workerd's "not text" warning. */
export const bytesText = (b: ArrayBuffer) => new TextDecoder().decode(b);

export const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;

export async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
