import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_ID,
  APP_SLUG,
  callEnv,
  CLIENT_SECRET,
  UNCONFIGURED,
  WEBHOOK_SECRET,
} from "./github-helpers.js";
import { makeApp, signUpHuman } from "./http.js";

afterEach(() => vi.restoreAllMocks());

describe("GitHub App from Worker config (no in-app App creation)", () => {
  const { app } = makeApp();

  it("shows the configured App and its install link, never a credential", async () => {
    const h = await signUpHuman(app);
    const res = await callEnv(app, {}, "GET", "/api/v1/github", { cookie: h.cookie });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      app: {
        id: APP_ID,
        slug: APP_SLUG,
        htmlUrl: `https://github.com/apps/${APP_SLUG}`,
        installUrl: `https://github.com/apps/${APP_SLUG}/installations/new`,
      },
      missing: [],
      installations: [],
      webhookUrl: "http://localhost/github/webhooks",
    });
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain(WEBHOOK_SECRET);
    expect(text).not.toContain("PRIVATE KEY");
  });

  it("says GitHub mode isn't configured and names what's missing", async () => {
    const h = await signUpHuman(app);
    const res = await callEnv(
      app,
      { ...UNCONFIGURED, GITHUB_APP_ID: "4242" },
      "GET",
      "/api/v1/github",
      { cookie: h.cookie },
    );
    expect(await res.json()).toMatchObject({
      app: null,
      missing: [
        "GITHUB_APP_SLUG",
        "GITHUB_APP_CLIENT_ID",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_APP_WEBHOOK_SECRET",
        "GITHUB_APP_CLIENT_SECRET",
      ],
    });
    // The install leg ends on the settings page with the reason.
    const setup = await callEnv(
      app,
      UNCONFIGURED,
      "GET",
      "/github/setup?installation_id=1&setup_action=install",
      { cookie: h.cookie },
    );
    expect(setup.headers.get("location")).toBe("/settings/github?error=not-configured");
  });

  it("the manifest flow is gone", async () => {
    const h = await signUpHuman(app);
    const res = await callEnv(
      app,
      { PLATFORM_ADMINS: h.principal.id },
      "POST",
      "/api/v1/github/manifests",
      { cookie: h.cookie, body: {} },
    );
    expect(res.status).toBe(404);
    const cb = await callEnv(app, {}, "GET", "/github/manifest/callback?code=abc&state=x", {
      cookie: h.cookie,
    });
    expect(cb.status).not.toBe(303);
  });
});
