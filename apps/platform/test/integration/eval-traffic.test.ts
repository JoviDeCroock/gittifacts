/**
 * Signed eval traffic (O6): creations whose `x-gittifacts-eval-sig` verifies are keyed by their
 * eval run instead of their IP and ASN (Cloudflare's shared Worker egress), under the same global
 * cap; anything unsigned or badly signed keeps the normal keys, and eval projects are ordinary
 * unclaimed projects. Real AbuseLimiter DOs, D1 and the app (HTTP + MCP).
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { anonymousClient } from "../../src/limits/client.js";
import { DEFAULT_UNCLAIMED_LIMITS } from "../../src/limits/config.js";
import { creationKeys, RateLimited, takeCreation } from "../../src/limits/creation.js";
import {
  EVAL_RUN_HEADER,
  EVAL_SIG_HEADER,
  evalRunSignature,
  verifiedEvalRun,
} from "../../src/limits/eval-traffic.js";
import { resetIntegrationFakes } from "./fakes.js";
import { platformApp } from "./harness.js";
import {
  createUnclaimed,
  freshIp,
  request,
  resetSharedLimiters,
  rpc,
  toolResult,
} from "./unclaimed-helpers.js";

// Test vector: Node's createHmac("sha256", SECRET).update(RUN).digest("hex"), i.e. exactly what
// apps/evals/src/env.ts `evalHeaderFn` sends (WebCrypto HMAC-SHA-256, lowercase hex).
const SECRET = "eval-traffic-test-secret-0123456789abcdef";
const RUN = "m-20261002-120000-abcd--t2--kimi--r1";
const RUN_SIG = "bcbee4d9094dc105cf87bcde2be91b10657eb9b6b58e64c5322360924f18e9f9";

const signedReq = (headers: Record<string, string>, ip = "203.0.113.7") =>
  new Request("http://localhost/api/v1/projects", {
    method: "POST",
    headers: { "cf-connecting-ip": ip, ...headers },
    cf: { asn: 13335, country: "US" },
  } as RequestInit);
const evalHeaders = (run: string, sig: string) => ({
  [EVAL_RUN_HEADER]: run,
  [EVAL_SIG_HEADER]: sig,
});

beforeEach(async () => {
  resetIntegrationFakes();
  await resetSharedLimiters([64_777]);
});

describe("eval-traffic signature (fails closed to the normal keys)", () => {
  const withSecret = { EVAL_TRAFFIC_SECRET: SECRET };

  it("verifies exactly what the evals Worker signs", async () => {
    expect(await evalRunSignature(SECRET, RUN)).toBe(RUN_SIG);
    expect(await verifiedEvalRun(signedReq(evalHeaders(RUN, RUN_SIG)), withSecret)).toBe(RUN);
    const upper = signedReq(evalHeaders(RUN, RUN_SIG.toUpperCase()));
    expect(await verifiedEvalRun(upper, withSecret)).toBe(RUN);
  });

  it.each([
    ["no headers", {}],
    ["run id without a signature", { [EVAL_RUN_HEADER]: RUN }],
    ["signature without a run id", { [EVAL_SIG_HEADER]: RUN_SIG }],
    ["a flipped signature", evalHeaders(RUN, `${RUN_SIG.slice(0, -1)}0`)],
    ["another run's signature", evalHeaders(`${RUN}x`, RUN_SIG)],
    ["a truncated signature", evalHeaders(RUN, RUN_SIG.slice(0, 32))],
    ["a malformed run id", evalHeaders("run id with spaces", RUN_SIG)],
    ["an oversized run id", evalHeaders("r".repeat(200), RUN_SIG)],
  ])("%s → not eval traffic", async (_name, headers: Record<string, string>) => {
    expect(await verifiedEvalRun(signedReq(headers), withSecret)).toBeNull();
  });

  it("without a platform secret (or a short one) nothing verifies", async () => {
    const req = () => signedReq(evalHeaders(RUN, RUN_SIG));
    expect(await verifiedEvalRun(req(), {})).toBeNull();
    expect(await verifiedEvalRun(req(), { EVAL_TRAFFIC_SECRET: "" })).toBeNull();
    const short = "short-secret";
    const shortSig = await evalRunSignature(short, RUN);
    const r = signedReq(evalHeaders(RUN, shortSig));
    expect(await verifiedEvalRun(r, { EVAL_TRAFFIC_SECRET: short })).toBeNull();
  });

  it("anonymousClient: the run is added; IP hash, ASN and country are unchanged", async () => {
    const e = { BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET, ...withSecret };
    const plain = await anonymousClient(signedReq({}), e);
    const signed = await anonymousClient(signedReq(evalHeaders(RUN, RUN_SIG)), e);
    const forged = await anonymousClient(signedReq(evalHeaders(RUN, "0".repeat(64))), e);
    expect(plain.evalRun).toBeNull();
    expect(signed).toEqual({ ...plain, evalRun: RUN });
    expect(forged).toEqual(plain);
  });
});

describe("creation keys for eval traffic", () => {
  const at = Date.parse("2026-10-02T12:00:00Z");
  const client = (evalRun: string | null) => ({
    ipHash: `ip-${crypto.randomUUID()}`,
    asn: 13335,
    country: null,
    evalRun,
  });

  it("a verified run replaces the IP and ASN keys; the global key stays", () => {
    const keys = (c: ReturnType<typeof client>) =>
      creationKeys(c, DEFAULT_UNCLAIMED_LIMITS).map((k) => k.key);
    const plain = client(null);
    expect(keys(plain)).toEqual([`ip:${plain.ipHash}`, "asn:13335", "global"]);
    expect(keys(client(RUN))).toEqual([`eval:${RUN}`, "global"]);
  });

  it("each run has its own budget (3), and never charges the IP or ASN buckets", async () => {
    await env.ABUSE_LIMITER.getByName("global").reset();
    const l = DEFAULT_UNCLAIMED_LIMITS;
    const run = `run-${crypto.randomUUID()}`;
    const c = client(run);
    for (let i = 0; i < l.creation.evalRun.capacity; i++) await takeCreation(env, c, l, at);
    const err = await takeCreation(env, c, l, at).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimited);
    expect(err).toMatchObject({ status: 429, scope: "eval-run", code: "rate-limited" });
    expect((err as RateLimited).message).toMatch(/by this eval run \(3 per run\)/);
    // Another run from the very same address and network is unaffected.
    await takeCreation(env, { ...c, evalRun: `run-${crypto.randomUUID()}` }, l, at);
    const ipLevel = await env.ABUSE_LIMITER.getByName(`ip:${c.ipHash}`).levels({
      buckets: [{ name: "hour", ...l.creation.ipHour }],
      atMs: at,
    });
    expect(ipLevel.hour).toBe(l.creation.ipHour.capacity);
    await env.ABUSE_LIMITER.getByName("global").reset();
  });

  it("the global cap still applies to eval traffic", async () => {
    await env.ABUSE_LIMITER.getByName("global").reset();
    const l = {
      ...DEFAULT_UNCLAIMED_LIMITS,
      creation: {
        ...DEFAULT_UNCLAIMED_LIMITS.creation,
        globalHour: { capacity: 1, periodSec: 3600 },
      },
    };
    await takeCreation(env, client(`run-${crypto.randomUUID()}`), l, at);
    const other = client(`run-${crypto.randomUUID()}`);
    await expect(takeCreation(env, other, l, at)).rejects.toMatchObject({ scope: "global" });
    // The refused run's own token was refunded.
    const level = await env.ABUSE_LIMITER.getByName(`eval:${other.evalRun}`).levels({
      buckets: [{ name: "run", ...l.creation.evalRun }],
      atMs: at,
    });
    expect(level.run).toBe(l.creation.evalRun.capacity);
    await env.ABUSE_LIMITER.getByName("global").reset();
  });
});

describe("through the API: eval projects are ordinary unclaimed projects", () => {
  // One shared egress address and network, like Cloudflare's Worker egress; one creation per IP.
  const from = () => ({ ip: freshIp(), asn: 64_777 });
  const tight = (creation: Record<string, unknown> = {}) => ({
    EVAL_TRAFFIC_SECRET: SECRET,
    UNCLAIMED_LIMITS: JSON.stringify({
      creation: { ipHour: { capacity: 1, periodSec: 3600 }, ...creation },
    }),
  });
  const signed = async (run: string) => evalHeaders(run, await evalRunSignature(SECRET, run));
  const createdPayload = async (projectId: string) => {
    const row = await env.DB.prepare(
      "SELECT payload FROM audit_events WHERE action = 'project.unclaimed-created' AND subject = ?",
    )
      .bind(`repo:${projectId}`)
      .first<{ payload: string }>();
    return JSON.parse(row?.payload ?? "null") as { creator: Record<string, unknown> };
  };
  const creatorIpHash = async (projectId: string) =>
    (await env.DB.prepare(
      "SELECT creator_ip_hash AS h, status FROM project_claims WHERE repo_id = ?",
    )
      .bind(projectId)
      .first<{ h: string; status: string }>()) ?? null;

  it("a valid signature: per-run buckets from one address; the IP bucket is left alone", async () => {
    const app = platformApp();
    const egress = from();
    const run = `m-test-${crypto.randomUUID().slice(0, 8)}--t2--kimi--r1`;
    const headers = await signed(run);
    const env1 = tight();
    const made = [];
    for (let i = 0; i < 3; i++)
      made.push(await createUnclaimed(app, {}, { env: env1, from: egress, headers }));
    const fourth = await request(app, "POST", "/api/v1/projects", {
      env: env1,
      from: egress,
      headers,
      body: {},
    });
    expect(fourth.status).toBe(429);
    const body = (await fourth.json()) as { error: { details: { scope: string } } };
    expect(body.error.details.scope).toBe("eval-run");
    // Another run, same address: its own budget.
    await createUnclaimed(app, {}, { env: env1, from: egress, headers: await signed(`${run}x`) });
    // Unsigned traffic from that address still has its whole (tight) IP bucket: one, then 429 ip.
    const plain = await createUnclaimed(app, {}, { env: env1, from: egress });
    const again = await request(app, "POST", "/api/v1/projects", {
      env: env1,
      from: egress,
      body: {},
    });
    expect(again.status).toBe(429);
    expect(((await again.json()) as typeof body).error.details.scope).toBe("ip");

    // Audited as eval-keyed; otherwise the same project as anyone's from that address.
    const first = made[0];
    if (first === undefined) throw new Error("no project");
    expect((await createdPayload(first.projectId)).creator).toMatchObject({
      evalRun: run,
      asn: 64_777,
    });
    expect((await createdPayload(plain.projectId)).creator).not.toHaveProperty("evalRun");
    const [a, b] = [await creatorIpHash(first.projectId), await creatorIpHash(plain.projectId)];
    expect(a).toEqual({ h: b?.h, status: "unclaimed" });
    expect(first).toMatchObject({ claimUrl: expect.any(String), token: expect.any(String) });
  });

  it("a bad signature or no platform secret: the normal IP bucket (no bypass)", async () => {
    const app = platformApp();
    const run = `m-test-${crypto.randomUUID().slice(0, 8)}--t1--kimi--r1`;
    const forged = evalHeaders(run, "f".repeat(64));
    const egress = from();
    await createUnclaimed(app, {}, { env: tight(), from: egress, headers: forged });
    const second = await request(app, "POST", "/api/v1/projects", {
      env: tight(),
      from: egress,
      headers: forged,
      body: {},
    });
    expect(second.status).toBe(429);
    expect(
      ((await second.json()) as { error: { details: { scope: string } } }).error.details.scope,
    ).toBe("ip");
    // A correct signature is worthless when the platform has no secret configured.
    const noSecret = { ...tight(), EVAL_TRAFFIC_SECRET: "" };
    const other = from();
    await createUnclaimed(app, {}, { env: noSecret, from: other, headers: await signed(run) });
    const third = await request(app, "POST", "/api/v1/projects", {
      env: noSecret,
      from: other,
      headers: await signed(run),
      body: {},
    });
    expect(third.status).toBe(429);
  });

  it("the global cap still binds eval traffic (also over MCP, which carries the run through)", async () => {
    const app = platformApp();
    const run = `m-test-${crypto.randomUUID().slice(0, 8)}--t4--gptoss--r2`;
    const e = tight({ globalHour: { capacity: 1, periodSec: 3600 } });
    const r = await rpc(
      app,
      { id: 1, method: "tools/call", params: { name: "create_project", arguments: {} } },
      { env: e, from: from(), headers: await signed(run) },
    );
    const out = toolResult(r.body);
    expect(out.ok).toBe(true);
    const projectId = (out.value as { projectId: string }).projectId;
    expect((await createdPayload(projectId)).creator).toMatchObject({ evalRun: run });
    const blocked = await request(app, "POST", "/api/v1/projects", {
      env: e,
      from: from(),
      headers: await signed(`${run}b`),
      body: {},
    });
    expect(blocked.status).toBe(429);
    expect(
      ((await blocked.json()) as { error: { details: { scope: string } } }).error.details.scope,
    ).toBe("global");
  });
});
