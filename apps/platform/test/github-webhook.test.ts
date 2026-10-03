import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { appForId, githubApp, missingConfig } from "../src/github/app-config.js";
import {
  signInstallState,
  verifyGithubSignature,
  verifyInstallState,
} from "../src/github/crypto.js";
import {
  APP_ID,
  callEnv,
  delivery,
  fakeQueue,
  otherAppId,
  UNCONFIGURED,
  WEBHOOK_SECRET,
} from "./github-helpers.js";
import { makeApp } from "./http.js";

const SECRET = "test-secret-test-secret-test-secret-0123456789";

describe("GitHub App config (Worker vars and secrets)", () => {
  const full = {
    GITHUB_APP_ID: "123",
    GITHUB_APP_SLUG: "gittifacts",
    GITHUB_APP_CLIENT_ID: "Iv23abc",
    GITHUB_APP_CLIENT_SECRET: "cs",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\\nMII\\n-----END RSA PRIVATE KEY-----",
    GITHUB_APP_WEBHOOK_SECRET: "wh",
  };

  it("names what is missing (never values) and is null until complete", () => {
    expect(missingConfig({})).toEqual([
      "GITHUB_APP_ID",
      "GITHUB_APP_SLUG",
      "GITHUB_APP_CLIENT_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_WEBHOOK_SECRET",
      "GITHUB_APP_CLIENT_SECRET",
    ]);
    expect(githubApp({ ...full, GITHUB_APP_WEBHOOK_SECRET: " " })).toBeNull();
    expect(missingConfig({ ...full, GITHUB_APP_ID: "abc" })).toEqual(["GITHUB_APP_ID (a number)"]);
    expect(missingConfig(full)).toEqual([]);
  });

  it("restores a one-line PEM, keeps the previous webhook secret during a rotation, finds Apps by id", () => {
    const app = githubApp({ ...full, GITHUB_APP_WEBHOOK_SECRET_PREVIOUS: "old" });
    expect(app?.privateKey).toBe(
      "-----BEGIN RSA PRIVATE KEY-----\nMII\n-----END RSA PRIVATE KEY-----",
    );
    expect(app?.webhookSecrets).toEqual(["wh", "old"]);
    const actor = Object.fromEntries(
      Object.entries(full).map(([k, v]) => [k.replace("GITHUB_APP", "GITHUB_ACTOR_APP"), v]),
    );
    const both = { ...full, ...actor, GITHUB_ACTOR_APP_ID: "456" };
    expect(appForId(both, 123)?.kind).toBe("reader");
    expect(appForId(both, 456)?.kind).toBe("actor");
    expect(appForId(both, 789)).toBeNull();
    expect(githubApp(full, "actor")).toBeNull();
  });
});

describe("GitHub mode crypto", () => {
  it("install state: signed, expiring, bound to its fields", async () => {
    const s = { principalId: "hu_1", installationId: 77, nonce: "n-0123456789", exp: 2_000 };
    const state = await signInstallState(SECRET, s);
    expect(await verifyInstallState(SECRET, state, 1_000)).toEqual(s);
    expect(await verifyInstallState(SECRET, state, 2_000)).toBeNull();
    expect(await verifyInstallState(`${SECRET}x`, state, 1_000)).toBeNull();
    const [body, mac] = state.split(".") as [string, string];
    const forged = btoa(JSON.stringify({ ...s, principalId: "hu_2" }))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(await verifyInstallState(SECRET, `${forged}.${mac}`, 1_000)).toBeNull();
    expect(
      await verifyInstallState(
        SECRET,
        `${body}.${mac.startsWith("A") ? "B" : "A"}${mac.slice(1)}`,
        1_000,
      ),
    ).toBeNull();
    expect(await verifyInstallState(SECRET, "garbage", 1_000)).toBeNull();
  });

  it("verifies X-Hub-Signature-256 over the raw body, against the current or previous secret", async () => {
    const body = new TextEncoder().encode('{"zen":"Design for failure."}');
    // GitHub's documented test vector (validating-webhook-deliveries).
    const docBody = new TextEncoder().encode("Hello, World!");
    const docSig = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(await verifyGithubSignature("It's a Secret to Everybody", docBody, docSig)).toBe(true);
    expect(
      await verifyGithubSignature(["new", "It's a Secret to Everybody"], docBody, docSig),
    ).toBe(true);
    expect(await verifyGithubSignature(["new", ""], docBody, docSig)).toBe(false);
    expect(await verifyGithubSignature("x", body, null)).toBe(false);
    expect(await verifyGithubSignature("x", body, "sha1=abc")).toBe(false);
  });
});

describe("POST /github/webhooks", () => {
  const { app } = makeApp();

  it("answers 503 while GitHub mode isn't configured (GitHub retries nothing; the cron redelivers)", async () => {
    const queue = fakeQueue();
    const d = await delivery(APP_ID, "pull_request", { action: "opened" });
    const res = await callEnv(
      app,
      { GITHUB_EVENTS: queue, ...UNCONFIGURED },
      "POST",
      "/github/webhooks",
      d,
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "github-not-configured",
    );
    expect(queue.sent).toHaveLength(0);
  });

  it("accepts the previous webhook secret during a rotation", async () => {
    const queue = fakeQueue();
    const d = await delivery(
      APP_ID,
      "push",
      { ref: "refs/heads/main" },
      { secret: "whsec-previous" },
    );
    const over = {
      GITHUB_EVENTS: queue,
      GITHUB_APP_WEBHOOK_SECRET: "whsec-next",
      GITHUB_APP_WEBHOOK_SECRET_PREVIOUS: "whsec-previous",
    };
    expect((await callEnv(app, over, "POST", "/github/webhooks", d)).status).toBe(202);
    const stale = await delivery(APP_ID, "push", { ref: "refs/heads/main" });
    expect((await callEnv(app, over, "POST", "/github/webhooks", stale)).status).toBe(401);
  });

  it("rejects another App id and a bad or missing signature with 401", async () => {
    const appId = APP_ID;
    const queue = fakeQueue();
    const unknown = await delivery(otherAppId(), "pull_request", { action: "opened" });
    const r1 = await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", unknown);
    expect(r1.status).toBe(401);
    const forged = await delivery(appId, "pull_request", { action: "opened" }, { secret: "wrong" });
    const r2 = await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", forged);
    expect(r2.status).toBe(401);
    const good = await delivery(appId, "pull_request", { action: "opened" });
    const { "x-hub-signature-256": _sig, ...unsigned } = good.headers;
    const r3 = await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", {
      ...good,
      headers: unsigned,
    });
    expect(r3.status).toBe(401);
    // A body changed after signing.
    const r4 = await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", {
      ...good,
      body: good.body.replace("opened", "closed"),
    });
    expect(r4.status).toBe(401);
    expect(queue.sent).toHaveLength(0);
  });

  it("queues a verified delivery once (redeliveries are acknowledged, not re-queued)", async () => {
    const appId = APP_ID;
    const queue = fakeQueue();
    const d = await delivery(appId, "pull_request", { action: "opened", installation: { id: 77 } });
    const r1 = await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", d);
    expect(r1.status).toBe(202);
    expect(queue.sent).toEqual([
      expect.objectContaining({
        deliveryId: d.id,
        appId,
        event: "pull_request",
        action: "opened",
        installationId: 77,
      }),
    ]);
    const r2 = await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", d);
    expect(r2.status).toBe(202);
    expect(await r2.json()).toMatchObject({ duplicate: true });
    expect(queue.sent).toHaveLength(1);
  });

  it("forgets the delivery when the queue is down (503), so GitHub's redelivery is processed", async () => {
    const appId = APP_ID;
    const queue = fakeQueue();
    queue.fail = true;
    const d = await delivery(appId, "push", { ref: "refs/heads/main" });
    expect(
      (await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", d)).status,
    ).toBe(503);
    queue.fail = false;
    expect(
      (await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", d)).status,
    ).toBe(202);
    expect(queue.sent).toHaveLength(1);
  });

  it("spills payloads over 96 KB to R2 and acknowledges pings without queuing", async () => {
    const appId = APP_ID;
    const queue = fakeQueue();
    const big = await delivery(appId, "push", { commits: "x".repeat(120_000) });
    expect(
      (await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", big)).status,
    ).toBe(202);
    const ref = queue.sent[0]?.payloadRef;
    expect(ref).toBe(`github/deliveries/${big.id}.json`);
    expect(await (await env.BLOBS.get(ref!))?.text()).toBe(big.body);
    const ping = await delivery(appId, "ping", { zen: "Keep it logically awesome." });
    expect(
      (await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", ping)).status,
    ).toBe(202);
    expect(queue.sent).toHaveLength(1);
  });

  it("rate-limits by client IP before verifying anything", async () => {
    const queue = fakeQueue();
    const limiter = { limit: async () => ({ success: false }) };
    const d = await delivery(APP_ID, "push", {});
    const res = await callEnv(
      app,
      { GITHUB_EVENTS: queue, GITHUB_WEBHOOK_LIMITER: limiter },
      "POST",
      "/github/webhooks",
      d,
    );
    expect(res.status).toBe(429);
    expect(WEBHOOK_SECRET.length).toBeGreaterThan(0);
  });
});
