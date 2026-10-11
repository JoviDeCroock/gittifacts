import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { auditLogStub, DoAudit } from "../src/audit/audit.js";
import { entryHashOf, GENESIS_HASH, payloadHashOf, verifyEntries } from "../src/audit/chain.js";
import { platformSigner } from "../src/signing.js";
import { callEnv } from "./github-helpers.js";
import { call, expectError, json, makeApp, signUpHuman } from "./http.js";

let counter = 0;
/** Storage is isolated per test file, not per test: give every test its own log. */
function freshLog(): string {
  counter++;
  return `test-log-${counter}`;
}

async function appendMany(n: number, log: string) {
  const audit = new DoAudit(env, log);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(
      await audit.append({
        principalId: "system",
        action: "test.event",
        subject: `change:c${i % 2}`,
        payload: { i },
      }),
    );
  }
  return out;
}

describe("AuditLog DO", () => {
  it("appends a hash chain starting at genesis, signed by the platform key", async () => {
    const log = freshLog();
    const events = await appendMany(3, log);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events[0]!.prevHash).toBe(GENESIS_HASH);
    expect(events[1]!.prevHash).toBe(events[0]!.hash);
    expect(events[2]!.prevHash).toBe(events[1]!.hash);
    expect(events[0]!.payloadHash).toBe(await payloadHashOf({ i: 0 }));
    expect(await entryHashOf(events[2]!)).toBe(events[2]!.hash);
    const signer = await platformSigner(env);
    expect(events[0]!.keyId).toBe(signer.keyId);
    expect((await verifyEntries(events, signer)).verified).toBe(true);
    expect(await auditLogStub(env, log).verifyChain()).toMatchObject({
      verified: true,
      checked: 3,
      headSeq: 3,
    });
  });

  it("mirrors every entry to D1", async () => {
    const log = freshLog();
    await appendMany(2, log);
    const rows = await env.DB.prepare(
      "SELECT seq, hash, payload FROM audit_events WHERE log = ? ORDER BY seq",
    )
      .bind(log)
      .all<{
        seq: number;
        hash: string;
        payload: string;
      }>();
    expect(rows.results.map((r) => r.seq)).toEqual([1, 2]);
    expect(JSON.parse(rows.results[1]!.payload)).toEqual({ i: 1 });
  });

  it("serializes concurrent appends into one chain", async () => {
    const log = freshLog();
    const audit = new DoAudit(env, log);
    const events = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        audit.append({
          principalId: "system",
          action: "burst",
          subject: "repo:r1",
          payload: { i },
        }),
      ),
    );
    expect(events.map((e) => e.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await auditLogStub(env, log).verifyChain()).verified).toBe(true);
  });

  it("detects a tampered payload, field, or broken link; a break stays reported until a full re-verify", async () => {
    const log = freshLog();
    await appendMany(4, log);
    const stub = auditLogStub(env, log);
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec(
        "UPDATE events SET payload = ? WHERE seq = 2",
        JSON.stringify({ i: 99 }),
      );
    });
    expect(await stub.verifyChain()).toMatchObject({
      verified: false,
      brokenAt: 2,
      verifiedThrough: 1,
    });

    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec(
        "UPDATE events SET payload = ? WHERE seq = 2",
        JSON.stringify({ i: 1 }),
      );
    });
    // Repaired, but a recorded break is sticky for reads: only a full re-verify clears it.
    expect(await stub.verifyChain()).toMatchObject({ verified: false, brokenAt: 2 });
    expect(await stub.verifyChainFull()).toMatchObject({
      verified: true,
      checked: 4,
      verifiedThrough: 4,
      complete: true,
    });
    expect((await stub.verifyChain()).verified).toBe(true);

    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec("UPDATE events SET action = 'forged' WHERE seq = 3");
    });
    // Behind the checkpoint (4): reads do not re-check it; the full re-verify does.
    expect((await stub.verifyChain()).verified).toBe(true);
    expect(await stub.verifyChainFull()).toMatchObject({ verified: false, brokenAt: 3 });
    expect(await stub.verifyChain()).toMatchObject({ verified: false, brokenAt: 3 });
  });

  it("verifies incrementally from a checkpoint, a bounded number of entries per read", async () => {
    const log = freshLog();
    await appendMany(3, log);
    const stub = auditLogStub(env, log);
    expect(await stub.verifyChain()).toMatchObject({
      verified: true,
      checked: 3,
      verifiedThrough: 3,
      headSeq: 3,
      complete: true,
    });
    // Nothing new: only the checkpoint entry is re-checked.
    expect(await stub.verifyChain()).toMatchObject({ verified: true, checked: 1 });

    await appendMany(3, log);
    // Honest about the unverified tail: not "verified", not broken either.
    const partial = await stub.verifyChain({ limit: 2 });
    expect(partial).toMatchObject({
      verified: false,
      verifiedThrough: 5,
      headSeq: 6,
      complete: false,
    });
    expect(partial.brokenAt).toBeUndefined();
    expect(await stub.verifyChain()).toMatchObject({
      verified: true,
      verifiedThrough: 6,
      complete: true,
    });

    // Rewriting the checkpoint entry itself (even re-hashed) is caught on the next read.
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec(
        "UPDATE events SET subject = 'change:x', hash = 'forged' WHERE seq = 6",
      );
    });
    expect(await stub.verifyChain()).toMatchObject({ verified: false, brokenAt: 6 });
  });

  it("detects a deleted entry and a re-signed forgery with another key", async () => {
    const log = freshLog();
    const events = await appendMany(3, log);
    const stub = auditLogStub(env, log);
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec("DELETE FROM events WHERE seq = 2");
    });
    expect(await stub.verifyChain()).toMatchObject({ verified: false, brokenAt: 3 });

    // A forged entry whose hash is internally consistent but whose signature is not the platform's.
    const signer = await platformSigner(env);
    const forged = { ...events[1]!, subject: "change:other" };
    forged.hash = await entryHashOf(forged);
    const r = await verifyEntries([events[0]!, forged], signer);
    expect(r).toMatchObject({ verified: false, brokenAt: 2 });
    expect(r.reason).toMatch(/signature/);
  });
});

describe("audit API", () => {
  it("GET /api/v1/audit reports how far the chain is verified; full re-verify is admin-only", async () => {
    const { app } = makeApp();
    const ada = await signUpHuman(app, "Ada");
    await new DoAudit(env).append({
      principalId: ada.principal.id,
      action: "test.event",
      subject: `principal:${ada.principal.id}`,
      payload: {},
    });
    const page = await json<{ chain: Record<string, unknown> }>(
      await call(app, "GET", "/api/v1/audit", { cookie: ada.cookie }),
    );
    expect(page.chain).toMatchObject({ verified: true, complete: true });
    expect(page.chain.verifiedThrough).toBe(page.chain.headSeq);

    await expectError(
      await callEnv(app, {}, "POST", "/api/v1/admin/audit/verify", { cookie: ada.cookie }),
      403,
      "forbidden",
    );
    const full = await callEnv(
      app,
      { PLATFORM_ADMINS: ada.principal.id },
      "POST",
      "/api/v1/admin/audit/verify",
      { cookie: ada.cookie },
    );
    expect(full.status).toBe(200);
    const body = await json<{ verified: boolean; checked: number; headSeq: number }>(full);
    expect(body).toMatchObject({ verified: true, complete: true });
    expect(body.checked).toBe(body.headSeq);
  });
});
