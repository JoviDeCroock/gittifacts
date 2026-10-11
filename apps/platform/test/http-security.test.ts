/**
 * Platform-wide HTTP hardening (security audit 2026-10-11), through the real Worker app:
 * - M1: frame/nosniff/referrer headers on every response, assets included; `__Host-` session
 *   cookies on https;
 * - M2: rate limits in front of sign-in/up, OAuth authorize/token and the device code;
 * - M13: cookie-authenticated mutations must come from the platform's own origin.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, expectError, json, makeApp, ORIGIN, signUpHuman, type TestApp } from "./http.js";

interface SendOptions {
  headers?: Record<string, string>;
  body?: unknown;
  form?: Record<string, string>;
  env?: Record<string, unknown>;
}

/** One request against the app, with optional env overrides and no default Origin. */
async function send(app: TestApp, method: string, url: string, opts: SendOptions = {}) {
  const headers = new Headers(opts.headers);
  let body: string | undefined;
  if (opts.form !== undefined) {
    body = new URLSearchParams(opts.form).toString();
    headers.set("content-type", "application/x-www-form-urlencoded");
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers.set("content-type", "application/json");
  }
  const full = url.startsWith("http") ? url : `${ORIGIN}${url}`;
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(full, { method, headers, body, redirect: "manual" }),
    { ...env, ...opts.env },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** A Workers Rate Limiting stand-in that really counts, per key. */
function countingLimiter(limit: number) {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
}

function expectSecurityHeaders(res: Response): void {
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
}

describe("M1: security headers on every platform response", () => {
  it("API JSON, errors, better-auth and the SPA's assets all carry them", async () => {
    const { app } = makeApp();
    expectSecurityHeaders(await call(app, "GET", "/api/v1/health"));
    expectSecurityHeaders(await call(app, "GET", "/api/v1/me")); // 401 envelope
    expectSecurityHeaders(await call(app, "GET", "/api/v1/no-such-route")); // 404 envelope
    // The SPA's HTML comes straight from the real ASSETS binding (immutable headers).
    expectSecurityHeaders(
      await send(app, "GET", "/changes/ch_123", { headers: { accept: "text/html" } }),
    );
    const signUp = await call(app, "POST", "/api/auth/sign-up/email", {
      body: {
        email: `hdr-${Date.now()}@example.com`,
        password: "correct-horse-battery",
        name: "H",
      },
    });
    expect(signUp.status).toBe(200);
    expectSecurityHeaders(signUp);
  });

  it("keeps a stricter policy a response already set, and adds frame-ancestors beside it", async () => {
    const { app } = makeApp();
    const assets = {
      fetch: async () =>
        new Response("<svg/>", {
          headers: {
            "content-type": "image/svg+xml",
            "content-security-policy": "default-src 'none'; sandbox",
            "referrer-policy": "no-referrer",
          },
        }),
    };
    const res = await send(app, "GET", "/thing.svg", { env: { ASSETS: assets } });
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'; sandbox");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("M1: __Host- session cookies on https", () => {
  const HTTPS = "https://platform.test";
  const over = { BETTER_AUTH_URL: HTTPS };

  it("sets __Host- cookies (Secure, Path=/, no Domain) that sign in; a plain one is ignored", async () => {
    const { app } = makeApp();
    const res = await send(app, "POST", `${HTTPS}/api/auth/sign-up/email`, {
      env: over,
      headers: { origin: HTTPS },
      body: {
        email: `host-${Date.now()}@example.com`,
        password: "correct-horse-battery",
        name: "H",
      },
    });
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie().filter((c) => c.includes("better-auth."));
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) {
      expect(c).toMatch(/^__Host-better-auth\./);
      expect(c).toMatch(/;\s*Secure/i);
      expect(c).toMatch(/;\s*Path=\//i);
      expect(c).not.toMatch(/;\s*Domain=/i);
    }
    const session = cookies.find((c) => c.startsWith("__Host-better-auth.session_token="));
    expect(session).toBeDefined();
    const pair = session!.split(";")[0]!;
    const me = await send(app, "GET", `${HTTPS}/api/v1/me`, {
      env: over,
      headers: { cookie: pair },
    });
    expect(me.status).toBe(200);
    // A sibling Worker can set `better-auth.session_token` with Domain=: the platform never reads it.
    const tossed = pair.replace(/^__Host-/, "");
    const asTossed = await send(app, "GET", `${HTTPS}/api/v1/me`, {
      env: over,
      headers: { cookie: tossed },
    });
    expect(asTossed.status).toBe(401);
  });

  it("keeps plain cookie names on http (local dev)", async () => {
    const { app } = makeApp();
    const { cookie } = await signUpHuman(app);
    expect(cookie.startsWith("better-auth.session_token=")).toBe(true);
  });
});

describe("M2: rate limits on the auth endpoints", () => {
  const roomy = () => countingLimiter(1_000);

  it("limits sign-in per client IP: 429, the error envelope and Retry-After", async () => {
    const { app } = makeApp();
    const AUTH_LIMITER = countingLimiter(3);
    const limits = { AUTH_LIMITER, AUTH_EMAIL_LIMITER: roomy(), OAUTH_LIMITER: roomy() };
    const signIn = (ip: string) =>
      send(app, "POST", "/api/auth/sign-in/email", {
        env: limits,
        headers: { origin: ORIGIN, "cf-connecting-ip": ip },
        body: { email: `nobody-${Math.random()}@example.com`, password: "wrong-password-1" },
      });
    for (let i = 0; i < 3; i++) expect((await signIn("203.0.113.7")).status).toBe(401);
    const limited = await signIn("203.0.113.7");
    const body = await expectError(limited, 429, "rate-limited");
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(body.error.details).toMatchObject({ bucket: "sign-in", by: "address" });
    expectSecurityHeaders(limited);
    // Another address has its own budget.
    expect((await signIn("198.51.100.4")).status).toBe(401);
    expect(AUTH_LIMITER.keys).toContain("sign-in:ip:203.0.113.7");
  });

  it("limits sign-in per normalized e-mail across addresses", async () => {
    const { app } = makeApp();
    const AUTH_EMAIL_LIMITER = countingLimiter(2);
    const limits = { AUTH_LIMITER: roomy(), AUTH_EMAIL_LIMITER, OAUTH_LIMITER: roomy() };
    const emails = ["victim@example.com", "Victim@Example.com", " VICTIM@example.com "];
    const results = [];
    for (const [i, email] of emails.entries()) {
      results.push(
        await send(app, "POST", "/api/auth/sign-in/email", {
          env: limits,
          headers: { origin: ORIGIN, "cf-connecting-ip": `192.0.2.${i + 1}` },
          body: { email, password: "wrong-password-1" },
        }),
      );
    }
    expect(results.map((r) => r.status)).toEqual([401, 401, 429]);
    const body = await json<{ error: { details: unknown } }>(results[2]!);
    expect(body.error.details).toMatchObject({ bucket: "sign-in", by: "e-mail" });
    expect(new Set(AUTH_EMAIL_LIMITER.keys)).toEqual(new Set(["sign-in:email:victim@example.com"]));
  });

  it("limits sign-up, password reset, OAuth authorize and token, the device code; nothing else", async () => {
    const { app } = makeApp();
    const denyAll = { limit: async () => ({ success: false }) };
    const limits = { AUTH_LIMITER: denyAll, AUTH_EMAIL_LIMITER: denyAll, OAUTH_LIMITER: denyAll };
    const ip = { "cf-connecting-ip": "203.0.113.9", origin: ORIGIN };
    const limited = [
      await send(app, "POST", "/api/auth/sign-up/email", {
        env: limits,
        headers: ip,
        body: { email: "x@example.com", password: "correct-horse-battery", name: "X" },
      }),
      await send(app, "GET", "/api/oauth/authorize?client_id=x&response_type=code", {
        env: limits,
        headers: ip,
      }),
      await send(app, "POST", "/api/oauth/token", {
        env: limits,
        headers: ip,
        form: { grant_type: "refresh_token", refresh_token: "nope" },
      }),
      await send(app, "POST", "/api/auth/device/code", {
        env: limits,
        headers: ip,
        form: { client_id: "gittifacts-cli" },
      }),
      await send(app, "POST", "/api/auth/request-password-reset", {
        env: limits,
        headers: ip,
        body: { email: "x@example.com", redirectTo: "/reset-password" },
      }),
    ];
    for (const res of limited) {
      await expectError(res, 429, "rate-limited");
      expect(res.headers.get("retry-after")).toBe("60");
    }
    // Everything else is untouched, reading the session included.
    expect((await send(app, "GET", "/api/v1/health", { env: limits, headers: ip })).status).toBe(
      200,
    );
    expect(
      (await send(app, "GET", "/api/auth/get-session", { env: limits, headers: ip })).status,
    ).toBe(200);
  });

  it("fails closed when a limiter binding is missing", async () => {
    const { app } = makeApp();
    const res = await send(app, "POST", "/api/auth/sign-in/email", {
      env: { AUTH_LIMITER: undefined },
      headers: { origin: ORIGIN },
      body: { email: "a@example.com", password: "wrong-password-1" },
    });
    expect(res.status).toBe(500);
  });
});

describe("M13: cookie-authenticated mutations come from the platform's own origin", () => {
  const AGENT = { name: "csrf-bot", scopes: ["repo:read"] };

  it("refuses a foreign Origin, Origin: null and cross-site/same-site Sec-Fetch-Site", async () => {
    const { app } = makeApp();
    const { cookie } = await signUpHuman(app);
    for (const headers of [
      { origin: "https://evil.example" },
      { origin: "https://tenant.decroockjovi.workers.dev" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      // A project Worker on a sibling subdomain is same-site, not same-origin.
      { "sec-fetch-site": "same-site" },
    ] as Record<string, string>[]) {
      const res = await send(app, "POST", "/api/v1/principals/agents", {
        headers: { ...headers, cookie },
        body: AGENT,
      });
      const body = await expectError(res, 403, "foreign-origin");
      expect(body.error.details).toMatchObject({ allowedOrigin: ORIGIN });
    }
    // Nothing was created: the caller still owns no agents.
    const { principals } = await json<{ principals: unknown[] }>(
      await call(app, "GET", "/api/v1/principals", { cookie }),
    );
    expect(principals).toHaveLength(1);
  });

  it("lets the platform's own pages and non-browser clients through", async () => {
    const { app } = makeApp();
    const { cookie } = await signUpHuman(app);
    for (const headers of [
      { origin: ORIGIN },
      { "sec-fetch-site": "same-origin" },
      {}, // curl with a cookie: no Origin, no Sec-Fetch-Site
    ] as Record<string, string>[]) {
      const res = await send(app, "POST", "/api/v1/principals/agents", {
        headers: { ...headers, cookie },
        body: AGENT,
      });
      expect(res.status).toBe(201);
    }
    // Reads are never checked.
    const read = await send(app, "GET", "/api/v1/me", {
      headers: { origin: "https://evil.example", cookie },
    });
    expect(read.status).toBe(200);
  });

  it("leaves bearer calls, better-auth's routes and the OAuth token endpoint to their own checks", async () => {
    const { app } = makeApp();
    const { cookie } = await signUpHuman(app);
    const evil = { origin: "https://evil.example", cookie };
    const bearer = await send(app, "POST", "/api/v1/principals/agents", {
      headers: { ...evil, authorization: "Bearer gtf_not-a-real-token" },
      body: AGENT,
    });
    expect(bearer.status).toBe(401);
    // better-auth refuses an untrusted Origin on its own routes.
    const signOut = await send(app, "POST", "/api/auth/sign-out", { headers: evil, body: {} });
    expect(signOut.status).toBe(403);
    expect(JSON.stringify(await signOut.json())).not.toContain("foreign-origin");
    // RFC 6749: CORS-open, cookies ignored, answers with its own protocol error.
    const token = await send(app, "POST", "/api/oauth/token", {
      headers: evil,
      form: { grant_type: "refresh_token", refresh_token: "nope" },
    });
    expect(token.status).toBe(400);
    expect((await call(app, "GET", "/api/v1/me", { cookie })).status).toBe(200);
  });
});
