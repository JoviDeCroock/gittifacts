/**
 * Password reset: off (503 with a fix, sign-in options say so) on a deployment without outbound
 * e-mail, which is production today; with a fake Email Service binding, the whole journey: request,
 * the e-mailed link, the web form's redirect, a new password, every old session signed out.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { OutboundEmail } from "../src/auth/email.js";
import { call, expectError, json, makeApp, ORIGIN, type TestApp } from "./http.js";

/** Like `call`, with extra bindings (the fake EMAIL) on the env. */
async function callWith(
  app: TestApp,
  extra: Record<string, unknown>,
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN });
  if (opts.cookie) headers.set("cookie", opts.cookie);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  const ctx = createExecutionContext();
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const req = new Request(`${ORIGIN}${path}`, { method, headers, body, redirect: "manual" });
  const res = await app.fetch(req, { ...env, ...extra }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const PASSWORD = "correct-horse-battery-staple";

async function signUp(app: TestApp, email: string): Promise<string> {
  const res = await call(app, "POST", "/api/auth/sign-up/email", {
    body: { email, password: PASSWORD, name: "Rita" },
  });
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .find((c) => c.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

describe("password reset", () => {
  it("without outbound e-mail: the option is off and the request endpoint says why", async () => {
    const { app } = makeApp();
    expect(await json(await call(app, "GET", "/api/v1/sign-in-options"))).toEqual({
      passwordReset: false,
    });
    const res = await call(app, "POST", "/api/auth/request-password-reset", {
      body: { email: "someone@example.com", redirectTo: `${ORIGIN}/reset-password` },
    });
    const err = await expectError(res, 503, "not-configured");
    expect(err.error.fix.explanation).toContain("can't send e-mail");
    // Half-configured (a sender without a binding) is still off.
    const half = await callWith(
      app,
      { EMAIL_FROM: "noreply@example.com" },
      "GET",
      "/api/v1/sign-in-options",
    );
    expect(await json(half)).toMatchObject({ passwordReset: false });
  });

  it("with e-mail: request, follow the link, set a new password; old sessions end", async () => {
    const { app } = makeApp();
    const sent: OutboundEmail[] = [];
    const mail = {
      EMAIL: { send: async (m: OutboundEmail) => void sent.push(m) },
      EMAIL_FROM: "noreply@gittifacts.test",
    };
    expect(await json(await callWith(app, mail, "GET", "/api/v1/sign-in-options"))).toMatchObject({
      passwordReset: true,
    });
    const email = `reset-${Date.now()}@example.com`;
    const oldCookie = await signUp(app, email);

    // An unknown e-mail gets the same answer and no mail: the endpoint is no account oracle.
    const unknown = await callWith(app, mail, "POST", "/api/auth/request-password-reset", {
      body: { email: "nobody-here@example.com", redirectTo: `${ORIGIN}/reset-password` },
    });
    expect(unknown.status).toBe(200);
    expect(sent).toHaveLength(0);

    const asked = await callWith(app, mail, "POST", "/api/auth/request-password-reset", {
      body: { email, redirectTo: `${ORIGIN}/reset-password` },
    });
    expect(asked.status).toBe(200);
    expect(sent).toHaveLength(1);
    const msg = sent[0]!;
    expect(msg).toMatchObject({
      to: email,
      from: "noreply@gittifacts.test",
      subject: "Reset your gittifacts password",
    });
    const link = /https?:\/\/\S+/.exec(msg.text)?.[0];
    expect(link).toBeDefined();
    expect(msg.html).toContain("Choose a new password");

    // The e-mailed link redirects to the web form with the token.
    const url = new URL(link!);
    const landed = await callWith(app, mail, "GET", `${url.pathname}${url.search}`);
    expect(landed.status).toBe(302);
    const form = new URL(landed.headers.get("location")!, ORIGIN);
    expect(form.pathname).toBe("/reset-password");
    const token = form.searchParams.get("token")!;
    expect(token.length).toBeGreaterThan(10);

    const NEW = "a-brand-new-password-42";
    const reset = await callWith(app, mail, "POST", "/api/auth/reset-password", {
      body: { newPassword: NEW, token },
    });
    expect(reset.status).toBe(200);
    // Single use.
    const again = await callWith(app, mail, "POST", "/api/auth/reset-password", {
      body: { newPassword: "yet-another-password-1", token },
    });
    expect(again.status).toBe(400);

    expect((await call(app, "GET", "/api/v1/me", { cookie: oldCookie })).status).toBe(401);
    const oldPw = await call(app, "POST", "/api/auth/sign-in/email", {
      body: { email, password: PASSWORD },
    });
    expect(oldPw.status).toBe(401);
    const newPw = await call(app, "POST", "/api/auth/sign-in/email", {
      body: { email, password: NEW },
    });
    expect(newPw.status).toBe(200);
  });
});
