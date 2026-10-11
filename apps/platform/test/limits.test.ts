/**
 * O3 abuse limits, unit level (workerd: the real AbuseLimiter and ProjectLedger Durable Objects).
 * End-to-end enforcement through the API, MCP and the workflows is in
 * integration/unclaimed.test.ts.
 */
import { env } from "cloudflare:workers";
import { defaultPolicy } from "@app/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  TEST_SECRET_FAIL,
  TEST_SECRET_PASS,
  TEST_SECRET_SPENT,
  verifyTurnstile,
} from "../src/claim/turnstile.js";
import { clampRequest } from "../src/limits/ci-quota.js";
import { anonymousClient, limitAddress } from "../src/limits/client.js";
import { DEFAULT_UNCLAIMED_LIMITS, unclaimedLimits } from "../src/limits/config.js";
import { RateLimited, takeCreation } from "../src/limits/creation.js";
import {
  type FlagReader,
  unclaimedCreationState,
  writeOverride,
} from "../src/limits/kill-switch.js";
import { guardUnclaimedRepoWrite, UnclaimedLimitError } from "../src/limits/refusals.js";
import { anonymousAllowed } from "../src/mcp/route.js";
import { store } from "./fixtures.js";

const flags = (value: boolean | "error" | "throw"): FlagReader => ({
  async getBooleanDetails(_key, def) {
    if (value === "throw") throw new Error("flagship unreachable");
    if (value === "error") return { value: def, errorCode: "FLAG_NOT_FOUND", reason: "ERROR" };
    return { value, reason: "TARGETING_MATCH" };
  },
});

describe("kill switch (Flagship flag + D1 override, fail closed)", () => {
  it("follows the flag, and fails closed when the flag can't be evaluated", async () => {
    const s = store();
    await writeOverride(s, null, "test", new Date());
    expect((await unclaimedCreationState(s, flags(true))).enabled).toBe(true);
    expect(await unclaimedCreationState(s, flags(false))).toMatchObject({
      enabled: false,
      source: "flag",
    });
    for (const broken of [flags("error"), flags("throw"), undefined]) {
      expect(await unclaimedCreationState(s, broken)).toMatchObject({
        enabled: false,
        source: "flag-unavailable",
        flag: null,
      });
    }
  });

  it("the admin override: off always wins; on only bridges an unreachable flag", async () => {
    const s = store();
    await writeOverride(s, "off", "admin", new Date());
    expect(await unclaimedCreationState(s, flags(true))).toMatchObject({
      enabled: false,
      source: "override",
    });
    await writeOverride(s, "on", "admin", new Date());
    expect((await unclaimedCreationState(s, flags("throw"))).enabled).toBe(true);
    // A flag explicitly set to false still stops creation.
    expect((await unclaimedCreationState(s, flags(false))).enabled).toBe(false);
    await writeOverride(s, null, "admin", new Date());
    expect((await unclaimedCreationState(s, flags("throw"))).enabled).toBe(false);
  });
});

describe("creation rate limits (AbuseLimiter token buckets)", () => {
  // Durable Object storage outlives a test here: leave the shared keys as we found them.
  afterEach(async () => {
    for (const key of ["global", "asn:1", "asn:2"]) await env.ABUSE_LIMITER.getByName(key).reset();
  });

  const tiny = (over: Partial<typeof DEFAULT_UNCLAIMED_LIMITS.creation>) => ({
    ...DEFAULT_UNCLAIMED_LIMITS,
    creation: { ...DEFAULT_UNCLAIMED_LIMITS.creation, ...over },
  });
  const client = (ip: string, asn: number | null) => ({ ipHash: ip, asn, country: null });
  const at = Date.parse("2026-10-02T12:00:00Z");

  it("per IP: the burst, then 429 with Retry-After; refills over time", async () => {
    const l = tiny({ ipHour: { capacity: 2, periodSec: 3600 } });
    const c = client(`ip-${crypto.randomUUID()}`, null);
    await takeCreation(env, c, l, at);
    await takeCreation(env, c, l, at);
    const err = await takeCreation(env, c, l, at).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimited);
    expect(err).toMatchObject({ status: 429, code: "rate-limited", scope: "ip" });
    expect((err as RateLimited).retryAfterSec).toBe(1800);
    expect((err as RateLimited).fix.explanation).toMatch(/Wait/);
    await takeCreation(env, c, l, at + 3_600_000);
  });

  it("per ASN across IPs, and a refusal refunds the keys that said yes", async () => {
    const asn = 64_000 + Math.floor(Math.random() * 1000);
    const l = tiny({ asnHour: { capacity: 2, periodSec: 3600 } });
    await takeCreation(env, client(`a-${crypto.randomUUID()}`, asn), l, at);
    await takeCreation(env, client(`b-${crypto.randomUUID()}`, asn), l, at);
    const third = client(`c-${crypto.randomUUID()}`, asn);
    await expect(takeCreation(env, third, l, at)).rejects.toMatchObject({ scope: "asn" });
    // The third IP's token was given back: it is not charged for the refused request.
    const levels = await env.ABUSE_LIMITER.getByName(`ip:${third.ipHash}`).levels({
      buckets: [{ name: "hour", ...l.creation.ipHour }],
      atMs: at,
    });
    expect(levels.hour).toBe(l.creation.ipHour.capacity);
  });

  it("platform-wide (global) across IPs and networks", async () => {
    // The global bucket is shared by every test file: give this test its own capacity window.
    const l = tiny({
      globalHour: { capacity: 1, periodSec: 3600 },
      globalDay: { capacity: 1000, periodSec: 86_400 },
    });
    const later = at + 10 * 86_400_000;
    await takeCreation(env, client(`g1-${crypto.randomUUID()}`, 1), l, later);
    await expect(
      takeCreation(env, client(`g2-${crypto.randomUUID()}`, 2), l, later),
    ).rejects.toMatchObject({ scope: "global", code: "rate-limited" });
  });
});

describe("ProjectLedger quotas", () => {
  it("charges up to a limit, never past it; day counters reset at UTC midnight", async () => {
    const l = env.PROJECT_LEDGER.getByName(`q-${crypto.randomUUID()}`);
    const day1 = Date.parse("2026-10-02T23:00:00Z");
    const c = (amount: number, atMs = day1) =>
      l.charge({ metric: "artifacts-ops", amount, limit: 5, period: "day", atMs });
    expect(await c(3)).toMatchObject({ ok: true, used: 3 });
    expect(await c(3)).toMatchObject({ ok: false, used: 3, limit: 5 });
    expect(await c(2)).toMatchObject({ ok: true, used: 5 });
    expect(await c(1, day1 + 2 * 3_600_000)).toMatchObject({ ok: true, used: 1 });
  });

  it("CI minutes: reserve (clamped to what's left, idempotent per run), then settle to actual", async () => {
    const l = env.PROJECT_LEDGER.getByName(`ci-${crypto.randomUUID()}`);
    const atMs = Date.parse("2026-10-02T10:00:00Z");
    const r = (runId: string) =>
      l.reserveCi({ runId, maxMinutes: 10, perDay: 25, minMinutes: 1, atMs });
    expect(await r("a")).toEqual({ ok: true, minutes: 10 });
    expect(await r("a")).toEqual({ ok: true, minutes: 10 });
    expect(await r("b")).toEqual({ ok: true, minutes: 10 });
    expect(await r("c")).toEqual({ ok: true, minutes: 5 });
    expect(await r("d")).toEqual({ ok: false, usedMinutes: 25 });
    expect(await l.settleCi({ runId: "a", actualMinutes: 0.5 })).toBe(true);
    expect(await l.settleCi({ runId: "a", actualMinutes: 9 })).toBe(false);
    const used = await l.counters({ metrics: [{ metric: "ci-minutes", period: "day" }], atMs });
    // 25 reserved, then run a used 0.5 of its 10: 15.5, so 9 whole minutes are left today.
    expect(used["ci-minutes"]).toBe(15.5);
    expect(await r("e")).toEqual({ ok: true, minutes: 9 });
  });
});

describe("CI requests of unclaimed projects", () => {
  it("are clamped: minutes granted, smaller caps, registries-only, read-only global cache", () => {
    const l = unclaimedLimits({});
    const req = clampRequest(
      {
        runId: "run-x",
        changeId: "x",
        repo: { remote: "https://example.com/r.git", tokenProvider: "artifacts" },
        artifactsRepo: "task-x",
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        limits: { maxMinutes: 90 },
        network: "open",
      },
      7,
      l,
    ) as unknown as Record<string, unknown>;
    expect(req).toMatchObject({
      network: "registries-only",
      cache: { global: "read-only" },
      limits: {
        maxMinutes: 7,
        maxLogBytes: l.ci.maxLogBytes,
        maxArtifactBytes: l.ci.maxArtifactBytes,
        instance: l.ci.instance,
      },
    });
  });

  it("limits come from UNCLAIMED_LIMITS / UNCLAIMED_TTL_DAYS; a bad override keeps the defaults", () => {
    const l = unclaimedLimits({
      UNCLAIMED_LIMITS: JSON.stringify({
        ci: { minutesPerDay: 5 },
        creation: { ipHour: { capacity: 1 } },
      }),
      UNCLAIMED_TTL_DAYS: "3",
    });
    expect(l.ci).toMatchObject({ minutesPerDay: 5, minutesPerRun: 10 });
    expect(l.creation.ipHour).toEqual({ capacity: 1, periodSec: 3600 });
    expect(l.ttlDays).toBe(3);
    expect(unclaimedLimits({ UNCLAIMED_LIMITS: '{"ci":{"minutesPerDay":-1}}' })).toEqual(
      DEFAULT_UNCLAIMED_LIMITS,
    );
    expect(unclaimedLimits({}).ttlDays).toBe(7);
  });
});

describe("unclaimed repos never store a deploy target, Lane 0 or revert auto-merge", () => {
  const repo = (status: "claimed" | "unclaimed", deployTarget: string | null) => ({
    id: "r1",
    claim: { status },
    deployTarget,
    policy: { ...defaultPolicy(), lane0Enabled: true, autoMergeVerifiedReverts: true },
  });

  it("refuses a deploy target and normalizes the policy", () => {
    expect(() => guardUnclaimedRepoWrite(repo("unclaimed", "prod-worker"))).toThrow(
      UnclaimedLimitError,
    );
    expect(guardUnclaimedRepoWrite(repo("unclaimed", null)).policy).toMatchObject({
      lane0Enabled: false,
      autoMergeVerifiedReverts: false,
    });
    expect(guardUnclaimedRepoWrite(repo("claimed", "prod-worker")).deployTarget).toBe(
      "prod-worker",
    );
  });
});

describe("Turnstile", () => {
  const input = { token: "XXXX.DUMMY.TOKEN.XXXX", remoteIp: "203.0.113.9" };
  it("Cloudflare's test secrets behave as documented, without the network", async () => {
    const offline = (() => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch;
    // No secret: fails closed unless test keys are explicitly opted in.
    expect(await verifyTurnstile({}, input, offline)).toMatchObject({
      success: false,
      errorCodes: ["turnstile-not-configured"],
    });
    expect(await verifyTurnstile({ TURNSTILE_TEST_KEYS: "1" }, input, offline)).toMatchObject({
      success: true,
      testKeys: true,
    });
    expect(
      await verifyTurnstile({ TURNSTILE_SECRET_KEY: TEST_SECRET_PASS }, input, offline),
    ).toMatchObject({ success: true });
    expect(
      await verifyTurnstile({ TURNSTILE_SECRET_KEY: TEST_SECRET_FAIL }, input, offline),
    ).toMatchObject({ success: false });
    expect(
      await verifyTurnstile({ TURNSTILE_SECRET_KEY: TEST_SECRET_SPENT }, input, offline),
    ).toMatchObject({
      success: false,
      errorCodes: ["timeout-or-duplicate"],
    });
  });

  it("a real secret is checked with Siteverify; unreachable means not verified", async () => {
    const seen: FormData[] = [];
    const ok = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.body as FormData);
      return Response.json({ success: true, "error-codes": [] });
    }) as unknown as typeof fetch;
    const real = { TURNSTILE_SECRET_KEY: "0x4AAAA-real-secret" };
    expect(await verifyTurnstile(real, input, ok)).toMatchObject({
      success: true,
      testKeys: false,
    });
    expect(seen[0]?.get("secret")).toBe("0x4AAAA-real-secret");
    expect(seen[0]?.get("remoteip")).toBe("203.0.113.9");
    const no = (async () =>
      Response.json({
        success: false,
        "error-codes": ["invalid-input-response"],
      })) as unknown as typeof fetch;
    expect(await verifyTurnstile(real, input, no)).toMatchObject({ success: false });
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect((await verifyTurnstile(real, input, down)).success).toBe(false);
  });
});

describe("anonymous callers", () => {
  it("are keyed by a hashed IP (IPv6 /64) and their ASN; the raw IP is never kept", async () => {
    expect(limitAddress("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
    expect(limitAddress("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(limitAddress("203.0.113.9")).toBe("203.0.113.9");
    const req = (ip: string) =>
      new Request("http://localhost/mcp", {
        headers: { "cf-connecting-ip": ip },
        cf: { asn: 13335, country: "BE" },
      } as RequestInit);
    const a = await anonymousClient(req("2001:db8:abcd:12::1"), env);
    const b = await anonymousClient(req("2001:db8:abcd:12::ffff"), env);
    expect(a).toEqual(b);
    expect(a.asn).toBe(13335);
    expect(a.ipHash).not.toContain("2001");
  });

  it("MCP: only initialize, tools/list, create_project and whoami pass without a token", async () => {
    const post = (body: unknown) =>
      new Request("http://localhost/mcp", { method: "POST", body: JSON.stringify(body) });
    const rpc = (method: string, params: unknown = {}) => ({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });
    for (const ok of [
      rpc("initialize"),
      rpc("notifications/initialized"),
      rpc("tools/list"),
      rpc("tools/call", { name: "create_project", arguments: {} }),
      rpc("tools/call", { name: "whoami", arguments: {} }),
    ]) {
      expect(await anonymousAllowed(post(ok)), JSON.stringify(ok)).toBe(true);
    }
    for (const no of [
      rpc("tools/call", { name: "start_change", arguments: {} }),
      rpc("tools/call", { name: "list_repos" }),
      rpc("resources/list"),
      [rpc("tools/list"), rpc("tools/call", { name: "get_evidence" })],
      "not json",
    ]) {
      expect(await anonymousAllowed(post(no)), JSON.stringify(no)).toBe(false);
    }
  });
});
