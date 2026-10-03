import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/app-env.js";
import {
  githubKeys,
  kekBytes,
  openCredential,
  sealCredential,
  signState,
  verifiedStateNonce,
  verifyGithubSignature,
} from "../src/github/crypto.js";
import { callEnv, delivery, fakeQueue, newAppId, seedApp, WEBHOOK_SECRET } from "./github-helpers.js";
import { makeApp } from "./http.js";

const KEK = (env as Bindings).GITHUB_APP_KEK;
const OTHER_KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

describe("GitHub App credential sealing (GITHUB_APP_KEK)", () => {
  it("round-trips, and never stores plaintext", async () => {
    const keys = await githubKeys(KEK);
    const sealed = await sealCredential(keys, 42, "pem", "-----BEGIN RSA PRIVATE KEY-----x");
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("PRIVATE");
    expect(await openCredential(keys, 42, "pem", sealed)).toBe("-----BEGIN RSA PRIVATE KEY-----x");
    // A fresh IV every time.
    expect(await sealCredential(keys, 42, "pem", "same")).not.toBe(await sealCredential(keys, 42, "pem", "same"));
  });

  it("refuses another App id, another field, a tampered ciphertext or another key", async () => {
    const keys = await githubKeys(KEK);
    const sealed = await sealCredential(keys, 42, "webhook_secret", "s3cret");
    await expect(openCredential(keys, 43, "webhook_secret", sealed)).rejects.toThrow();
    await expect(openCredential(keys, 42, "client_secret", sealed)).rejects.toThrow();
    const [v, iv, ct] = sealed.split(".") as [string, string, string];
    const flipped = `${v}.${iv}.${ct.startsWith("A") ? "B" : "A"}${ct.slice(1)}`;
    await expect(openCredential(keys, 42, "webhook_secret", flipped)).rejects.toThrow();
    await expect(openCredential(await githubKeys(OTHER_KEK), 42, "webhook_secret", sealed)).rejects.toThrow();
  });

  it("requires a 32-byte base64 KEK", () => {
    expect(() => kekBytes(undefined)).toThrow(/not set/);
    expect(() => kekBytes(btoa("short"))).toThrow(/32 bytes/);
    expect(kekBytes(KEK).length).toBe(32);
  });

  it("states carry a MAC: forged or altered states are rejected", async () => {
    const keys = await githubKeys(KEK);
    const state = await signState(keys, "nonce-0123456789abcdef");
    expect(await verifiedStateNonce(keys, state)).toBe("nonce-0123456789abcdef");
    expect(await verifiedStateNonce(keys, state.replace("nonce-0", "nonce-1"))).toBeNull();
    expect(await verifiedStateNonce(await githubKeys(OTHER_KEK), state)).toBeNull();
    expect(await verifiedStateNonce(keys, "garbage")).toBeNull();
  });

  it("verifies X-Hub-Signature-256 over the raw body", async () => {
    const body = new TextEncoder().encode('{"zen":"Design for failure."}');
    // GitHub's documented test vector (validating-webhook-deliveries).
    const docBody = new TextEncoder().encode("Hello, World!");
    expect(
      await verifyGithubSignature(
        "It's a Secret to Everybody",
        docBody,
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      ),
    ).toBe(true);
    expect(await verifyGithubSignature("x", body, null)).toBe(false);
    expect(await verifyGithubSignature("x", body, "sha1=abc")).toBe(false);
  });
});

describe("POST /github/webhooks", () => {
  const { app } = makeApp();

  it("rejects an unknown App id and a bad or missing signature with 401", async () => {
    const appId = await seedApp();
    const queue = fakeQueue();
    const unknown = await delivery(newAppId() + 10_000, "pull_request", { action: "opened" });
    const r1 = await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", unknown);
    expect(r1.status).toBe(401);
    const forged = await delivery(appId, "pull_request", { action: "opened" }, { secret: "wrong" });
    const r2 = await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", forged);
    expect(r2.status).toBe(401);
    const good = await delivery(appId, "pull_request", { action: "opened" });
    const { "x-hub-signature-256": _sig, ...unsigned } = good.headers;
    const r3 = await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", { ...good, headers: unsigned });
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
    const appId = await seedApp();
    const queue = fakeQueue();
    const d = await delivery(appId, "pull_request", { action: "opened", installation: { id: 77 } });
    const r1 = await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", d);
    expect(r1.status).toBe(202);
    expect(queue.sent).toEqual([
      expect.objectContaining({ deliveryId: d.id, appId, event: "pull_request", action: "opened", installationId: 77 }),
    ]);
    const r2 = await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", d);
    expect(r2.status).toBe(202);
    expect(await r2.json()).toMatchObject({ duplicate: true });
    expect(queue.sent).toHaveLength(1);
  });

  it("forgets the delivery when the queue is down (503), so GitHub's redelivery is processed", async () => {
    const appId = await seedApp();
    const queue = fakeQueue();
    queue.fail = true;
    const d = await delivery(appId, "push", { ref: "refs/heads/main" });
    expect((await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", d)).status).toBe(503);
    queue.fail = false;
    expect((await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", d)).status).toBe(202);
    expect(queue.sent).toHaveLength(1);
  });

  it("spills payloads over 96 KB to R2 and acknowledges pings without queuing", async () => {
    const appId = await seedApp();
    const queue = fakeQueue();
    const big = await delivery(appId, "push", { commits: "x".repeat(120_000) });
    expect((await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", big)).status).toBe(202);
    const ref = queue.sent[0]?.payloadRef;
    expect(ref).toBe(`github/deliveries/${big.id}.json`);
    expect(await (await env.BLOBS.get(ref!))?.text()).toBe(big.body);
    const ping = await delivery(appId, "ping", { zen: "Keep it logically awesome." });
    expect((await callEnv(app, { GITHUB_EVENTS: queue }, "POST", "/github/webhooks", ping)).status).toBe(202);
    expect(queue.sent).toHaveLength(1);
  });

  it("rate-limits by client IP before verifying anything", async () => {
    const queue = fakeQueue();
    const limiter = { limit: async () => ({ success: false }) };
    const d = await delivery(await seedApp(), "push", {});
    const res = await callEnv(app, { GITHUB_EVENTS: queue, GITHUB_WEBHOOK_LIMITER: limiter }, "POST", "/github/webhooks", d);
    expect(res.status).toBe(429);
    expect(WEBHOOK_SECRET.length).toBeGreaterThan(0);
  });
});
