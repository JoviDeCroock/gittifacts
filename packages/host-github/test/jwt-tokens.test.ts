import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GithubApi, GithubHttpError } from "../src/api.js";
import { GithubRateLimited, WriteGovernor } from "../src/governor.js";
import { importAppKey, signAppJwt } from "../src/jwt.js";
import { InstallationTokens } from "../src/tokens.js";

// GitHub hands out PKCS#1 PEMs ("BEGIN RSA PRIVATE KEY").
const { privateKey: PEM, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const NOW = new Date("2026-10-03T12:00:00Z");
const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

describe("App JWT (RS256, WebCrypto)", () => {
  it("signs with a PKCS#1 key; the signature verifies; iat − 60 s, exp ≤ 10 min, iss = client id", async () => {
    expect(PEM).toContain("BEGIN RSA PRIVATE KEY");
    const { jwt } = await signAppJwt({ key: await importAppKey(PEM), issuer: "Iv23abc", now: NOW });
    const [h, p, sig] = jwt.split(".") as [string, string, string];
    expect(b64json(h)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = b64json(p);
    const now = NOW.getTime() / 1000;
    expect(claims).toEqual({ iat: now - 60, exp: now - 60 + 540, iss: "Iv23abc" });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey(publicKey), Buffer.from(sig, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("installation tokens", () => {
  it("mints per repo with minimal permissions, never shows the value, and revokes", async () => {
    const calls: { method: string; url: string; auth: string; body: unknown }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      calls.push({ method: init.method ?? "GET", url, auth: headers.get("authorization") ?? "", body: init.body ? JSON.parse(String(init.body)) : null });
      expect(headers.get("x-github-api-version")).toBe("2026-03-10");
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ token: "ghs_secret_value_0123456789", expires_at: "2026-10-03T13:00:00Z" }, { status: 201 });
    }) as typeof globalThis.fetch;
    const tokens = new InstallationTokens({ appId: 1, clientId: "Iv23abc", privateKey: PEM }, { fetch, now: () => NOW });
    const seen = await tokens.withToken(77, { repositoryIds: [101], permissions: { checks: "write", contents: "read" } }, async (t) => {
      expect(JSON.stringify({ t })).not.toContain("ghs_secret");
      expect(String(t)).not.toContain("ghs_secret");
      return t.authorization();
    });
    expect(seen).toBe("Bearer ghs_secret_value_0123456789");
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.github.com/app/installations/77/access_tokens",
      body: { repository_ids: [101], permissions: { checks: "write", contents: "read" } },
    });
    expect(calls[0]?.auth).toMatch(/^Bearer ey/);
    expect(calls[1]).toMatchObject({ method: "DELETE", url: "https://api.github.com/installation/token", auth: "Bearer ghs_secret_value_0123456789" });
  });
});

describe("REST client", () => {
  it("sends If-None-Match and serves a 304 from the cache", async () => {
    let n = 0;
    const fetch = (async (_url: string, init: RequestInit) => {
      n++;
      const inm = new Headers(init.headers).get("if-none-match");
      if (inm === '"v1"') return new Response(null, { status: 304 });
      return Response.json({ number: 1 }, { headers: { etag: '"v1"' } });
    }) as typeof globalThis.fetch;
    const api = new GithubApi({ token: async () => "t", fetch });
    expect(await api.get("/repos/a/b/pulls/1")).toEqual({ number: 1 });
    expect(await api.get("/repos/a/b/pulls/1")).toEqual({ number: 1 });
    expect(n).toBe(2);
  });

  it("turns secondary limits into retry-afters and other errors into GithubHttpError", async () => {
    const limited = new GithubApi({ token: async () => "t", fetch: (async () => new Response("{}", { status: 403, headers: { "retry-after": "30" } })) as typeof fetch });
    await expect(limited.get("/x")).rejects.toMatchObject({ name: "GithubRateLimited", retryAfterSec: 30 });
    const missing = new GithubApi({ token: async () => "t", fetch: (async () => Response.json({ message: "Not Found" }, { status: 404 })) as typeof fetch });
    await expect(missing.get("/x")).rejects.toBeInstanceOf(GithubHttpError);
  });
});

describe("write governor (≤ 80/min, ≤ 500/h, serialized)", () => {
  it("waits inside a minute, refuses beyond the hour budget", async () => {
    let now = 0;
    const slept: number[] = [];
    const g = new WriteGovernor({ now: () => now, sleep: async (ms) => { slept.push(ms); now += ms; }, maxWaitMs: 60_000 });
    for (let i = 0; i < 80; i++) await g.run(async () => i);
    expect(slept).toEqual([]);
    await g.run(async () => "81st");
    expect(slept).toEqual([60_000]);
    const strict = new WriteGovernor({ now: () => now, perHour: 2, maxWaitMs: 1_000 });
    await strict.run(async () => 1);
    await strict.run(async () => 2);
    await expect(strict.run(async () => 3)).rejects.toBeInstanceOf(GithubRateLimited);
  });

  it("runs writes one at a time", async () => {
    const g = new WriteGovernor();
    let active = 0;
    let peak = 0;
    await Promise.all([1, 2, 3].map(() => g.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    })));
    expect(peak).toBe(1);
  });
});
