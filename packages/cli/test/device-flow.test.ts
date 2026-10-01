import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CLIENT_ID,
  DEVICE_GRANT,
  discoverEndpoints,
  oauthErrorOf,
  pollForToken,
} from "../src/auth/device-flow.js";
import { CliError, EXIT } from "../src/errors.js";
import { harness, run } from "./support/io.js";
import { type FakeOAuth, fakeOAuthServer, granted, pending, slowDown } from "./support/oauth-server.js";

let server: FakeOAuth | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function clockAndSleep() {
  const t = { now: 0, sleeps: [] as number[] };
  return {
    t,
    now: () => t.now,
    sleep: async (ms: number) => {
      t.sleeps.push(ms);
      t.now += ms;
    },
  };
}

async function poll(answers: FakeOAuth["tokenAnswers"], over: { interval?: number; expires?: number } = {}) {
  server = await fakeOAuthServer({ tokenAnswers: answers });
  const c = clockAndSleep();
  const p = pollForToken({
    fetch: (i, init) => fetch(i, init),
    host: server.host,
    tokenUrl: `${server.host}/api/oauth/token`,
    clientId: "cli",
    deviceCode: "dev_123",
    intervalSec: over.interval ?? 5,
    expiresInSec: over.expires ?? 1800,
    now: c.now,
    sleep: c.sleep,
  });
  return { p, c, server };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return (e as CliError).body.code;
  }
  throw new Error("expected an error");
}

describe("device flow polling (RFC 8628 §3.5)", () => {
  it("keeps polling on authorization_pending and adds 5s on slow_down", async () => {
    const { p, c, server: s } = await poll([pending, slowDown, pending, granted]);
    await expect(p).resolves.toEqual({
      accessToken: "sess_abc",
      tokenType: "Bearer",
      expiresIn: 3600,
      scope: "repo:read change:create",
    });
    expect(c.t.sleeps).toEqual([5000, 5000, 10000, 10000]);
    const polls = s.requests.filter((r) => r.path.endsWith("/token"));
    expect(polls).toHaveLength(4);
    expect(polls[0]?.form).toEqual({ grant_type: DEVICE_GRANT, device_code: "dev_123", client_id: "cli" });
  });

  it("stops on expired_token", async () => {
    const { p } = await poll([pending, { status: 400, body: { error: "expired_token" } }]);
    expect(await codeOf(p)).toBe("device-code-expired");
  });

  it("stops on access_denied", async () => {
    const { p } = await poll([{ status: 400, body: { error: "access_denied" } }]);
    expect(await codeOf(p)).toBe("access-denied");
  });

  it("gives up when the code's lifetime runs out locally", async () => {
    const { p, c, server: s } = await poll([pending], { interval: 5, expires: 12 });
    expect(await codeOf(p)).toBe("device-code-expired");
    expect(c.t.sleeps).toEqual([5000, 5000, 5000]);
    expect(s.requests.filter((r) => r.path.endsWith("/token"))).toHaveLength(2);
  });

  it("backs off on server errors, then recovers", async () => {
    const { p, c } = await poll([{ status: 503, body: "down" }, pending, granted]);
    await expect(p).resolves.toMatchObject({ accessToken: "sess_abc" });
    expect(c.t.sleeps).toEqual([5000, 10000, 5000]);
  });

  it("says the flow is unavailable when the token endpoint doesn't exist", async () => {
    const { p } = await poll([{ status: 404, body: { error: "not_found" } }]);
    expect(await codeOf(p)).toBe("device-flow-unavailable");
  });

  it("fails on an unknown error code", async () => {
    const { p } = await poll([{ status: 400, body: { error: "invalid_grant", error_description: "Invalid device code" } }]);
    expect(await codeOf(p)).toBe("device-flow-failed");
  });

  it("reads better-auth style `code` bodies too", () => {
    expect(oauthErrorOf({ code: "AUTHORIZATION_PENDING", message: "Authorization pending" })).toEqual({
      error: "authorization_pending",
      description: "Authorization pending",
    });
  });
});

describe("endpoint discovery", () => {
  it("falls back to the platform's paths (better-auth device code, /api/oauth/token)", async () => {
    server = await fakeOAuthServer();
    const e = await discoverEndpoints((i, init) => fetch(i, init), server.host);
    expect(e).toEqual({
      deviceAuthorizationUrl: `${server.host}/api/auth/device/code`,
      tokenUrl: `${server.host}/api/oauth/token`,
      clientId: DEFAULT_CLIENT_ID,
      source: "default",
    });
  });

  it("uses RFC 8414 metadata: the device endpoint and the AS token endpoint", async () => {
    server = await fakeOAuthServer({
      metadata: {
        device_authorization_endpoint: "/oauth/device",
        token_endpoint: "/oauth/token",
        grant_types_supported: ["authorization_code", DEVICE_GRANT],
      },
    });
    const e = await discoverEndpoints((i, init) => fetch(i, init), server.host);
    expect(e).toMatchObject({
      deviceAuthorizationUrl: `${server.host}/oauth/device`,
      tokenUrl: `${server.host}/oauth/token`,
      source: "metadata",
    });
    server.metadata = { device_authorization_endpoint: "/oauth/device", token_endpoint: "/oauth/token" };
    const e2 = await discoverEndpoints((i, init) => fetch(i, init), server.host);
    expect(e2.tokenUrl).toBe(`${server.host}/oauth/token`);
    // metadata without device support says nothing about the device flow
    server.metadata = { token_endpoint: "/oauth/token", grant_types_supported: ["authorization_code"] };
    const e3 = await discoverEndpoints((i, init) => fetch(i, init), server.host);
    expect(e3).toMatchObject({ tokenUrl: `${server.host}/api/oauth/token`, source: "default" });
  });

  it("prefers /start's deviceFlow block and its client id; flags win over everything", async () => {
    server = await fakeOAuthServer({
      start: {
        auth: {
          deviceFlow: {
            available: true,
            command: "npx gittifacts login",
            deviceAuthorizationEndpoint: "/api/auth/device/code",
            tokenEndpoint: "/api/oauth/token",
            clientId: "gittifacts-cli-prod",
          },
        },
      },
    });
    const e = await discoverEndpoints((i, init) => fetch(i, init), server.host);
    expect(e).toMatchObject({ clientId: "gittifacts-cli-prod", source: "start" });
    const o = await discoverEndpoints((i, init) => fetch(i, init), server.host, {
      deviceCodeUrl: "https://auth.example/device",
      tokenUrl: "https://auth.example/token",
      clientId: "x",
    });
    expect(o).toEqual({
      deviceAuthorizationUrl: "https://auth.example/device",
      tokenUrl: "https://auth.example/token",
      clientId: "x",
      source: "override",
    });
  });
});

describe("gittifacts login / logout", () => {
  it("prints the URL and code, polls, and stores the token 0600 keyed by host", async () => {
    server = await fakeOAuthServer({ tokenAnswers: [pending, granted] });
    const h = harness();
    const r = await run(h, ["login", "--host", server.host]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`${server.host}/device?user_code=ABCD-EFGH`);
    expect(r.stderr).toContain("ABCD-EFGH");
    const out = r.json() as Record<string, unknown>;
    expect(out).toMatchObject({ loggedIn: true, host: server.host, tokenType: "Bearer", scope: "repo:read change:create" });
    expect(JSON.stringify(out)).not.toContain("sess_abc");

    const path = join(h.dir, "config", "credentials.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(h.dir, "config")).mode & 0o777).toBe(0o700);
    const creds = JSON.parse(readFileSync(path, "utf8"));
    expect(creds.defaultHost).toBe(server.host);
    expect(creds.hosts[server.host].login).toMatchObject({ token: "sess_abc", via: "device-flow" });
    expect(server.requests.find((q) => q.path.endsWith("/device/code"))?.form).toEqual({ client_id: DEFAULT_CLIENT_ID });

    const out2 = await run(h, ["logout"]);
    expect(out2.json()).toMatchObject({ loggedOut: true, host: server.host, removed: { login: true } });
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.hosts[server.host]).toBeUndefined();
    expect(after.defaultHost).toBeUndefined();
    h.cleanup();
  });

  it("--no-wait hands an agent the code as JSON; --device-code finishes it", async () => {
    server = await fakeOAuthServer({ tokenAnswers: [granted] });
    const h = harness();
    const started = await run(h, ["login", "--host", server.host, "--no-wait", "--scope", "repo:read"]);
    expect(started.code).toBe(0);
    const doc = started.json() as { deviceCode: string; userCode: string; nextSteps: { command?: string }[] };
    expect(doc).toMatchObject({ deviceCode: "dev_123", userCode: "ABCD-EFGH", verificationUri: `${server.host}/device` });
    expect(doc.nextSteps[1]?.command).toBe(
      `gittifacts login --host ${server.host} --device-code dev_123 --interval 5 --expires-in 1800`,
    );
    expect(server.requests.find((q) => q.path.endsWith("/device/code"))?.form.scope).toBe("repo:read");
    expect(existsSync(join(h.dir, "config", "credentials.json"))).toBe(false);

    const done = await run(h, ["login", "--host", server.host, "--device-code", "dev_123", "--interval", "2"]);
    expect(done.code).toBe(0);
    expect(h.sleeps).toEqual([2000]);
    h.cleanup();
  });

  it("reports access_denied with a fix and stores nothing", async () => {
    server = await fakeOAuthServer({ tokenAnswers: [{ status: 400, body: { error: "access_denied" } }] });
    const h = harness();
    const r = await run(h, ["login", "--host", server.host]);
    expect(r.code).toBe(EXIT.error);
    expect(r.json()).toMatchObject({
      error: { code: "access-denied", fix: { command: `gittifacts login --host ${server.host}` } },
    });
    expect(existsSync(join(h.dir, "config", "credentials.json"))).toBe(false);
    h.cleanup();
  });

  it("says the device flow is unavailable when the endpoint is missing", async () => {
    server = await fakeOAuthServer();
    server.deviceCodeStatus = 404;
    const h = harness();
    const r = await run(h, ["login", "--host", server.host]);
    expect(r.json()).toMatchObject({ error: { code: "device-flow-unavailable", fix: { explanation: expect.stringContaining("GITTIFACTS_TOKEN") } } });
    h.cleanup();
  });

  it("Ctrl-C stops waiting cleanly (exit 130)", async () => {
    server = await fakeOAuthServer({ tokenAnswers: [pending] });
    let interruptNow: () => void = () => {};
    const h = harness({
      sleep: async (_ms, signal) => {
        interruptNow();
        if (signal?.aborted) throw signal.reason;
      },
    });
    interruptNow = () => h.interrupt();
    const r = await run(h, ["login", "--host", server.host]);
    expect(r.code).toBe(EXIT.interrupted);
    expect(r.json()).toMatchObject({ error: { code: "interrupted", fix: { command: expect.stringContaining("--device-code dev_123") } } });
    h.cleanup();
  });
});
