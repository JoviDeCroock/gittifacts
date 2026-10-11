import { env } from "cloudflare:workers";
import type { Plan } from "@app/domain";
import { documentSigningBytes, parseKeySet, sha256Base64url, verifyDocument } from "@app/evidence";
import { describe, expect, it } from "vitest";
import { planApprovalDocument, verifyPlanApproval } from "../src/services/plans.js";
import { Purpose, platformSigner } from "../src/signing.js";
import { addMember, repoFixture, store } from "./fixtures.js";
import { call, createAgent, expectError, json, makeApp, signUpHuman } from "./http.js";

const draft = (repoId: string, extra: Record<string, unknown> = {}) => ({
  repoId,
  title: "Rate limit logins",
  intent: "Stop credential stuffing by limiting login attempts per IP.",
  acceptanceCriteria: ["The 6th attempt within a minute returns 429"],
  scopePaths: ["src/auth/**"],
  ...extra,
});

async function setup() {
  const { app } = makeApp();
  const repo = repoFixture();
  await store().insertRepo(repo);
  const alice = await signUpHuman(app, "Alice");
  const bob = await signUpHuman(app, "Bob");
  const agent = await createAgent(app, alice.cookie);
  // Alice owns the repo (her agent drafts), Bob is a maintainer (approves plans).
  await addMember(store(), repo.id, alice.principal.id, "owner");
  await addMember(store(), repo.id, bob.principal.id, "maintainer");
  return { app, repo, alice, bob, agent };
}

describe("plans", () => {
  it("an agent drafts a plan; a different human approves it with a verifiable signature", async () => {
    const { app, repo, bob, agent } = await setup();
    const created = await call(app, "POST", "/api/v1/plans", {
      token: agent.token,
      body: draft(repo.id),
    });
    expect(created.status).toBe(201);
    const { plan } = await json<{ plan: Plan }>(created);
    expect(plan).toMatchObject({
      status: "draft",
      authorId: agent.principal.id,
      outOfScope: [],
      approvalSignature: null,
    });

    const approved = await call(app, "POST", `/api/v1/plans/${plan.id}/approve`, {
      cookie: bob.cookie,
      body: { comment: "lgtm" },
    });
    expect(approved.status).toBe(200);
    const { plan: ap } = await json<{ plan: Plan }>(approved);
    expect(ap).toMatchObject({ status: "approved", approvedBy: bob.principal.id });
    expect(ap.approvalSignature).toMatch(/^[A-Za-z0-9_-]{86}$/);

    // Verify independently with the published key set and @app/evidence.
    const keysRes = await call(app, "GET", "/.well-known/gittifacts-keys.json");
    expect(keysRes.status).toBe(200);
    const keys = parseKeySet(await keysRes.json());
    expect(keys).toHaveLength(1);
    const doc = await planApprovalDocument(ap);
    const bytes = documentSigningBytes(doc, Purpose.planApproval);
    const result = await verifyDocument(
      doc,
      {
        v: 1,
        alg: "Ed25519",
        keyId: keys[0]!.keyId!,
        payloadDigest: await sha256Base64url(bytes),
        signature: ap.approvalSignature,
        signedAt: ap.approvedAt,
        signer: "gittifacts",
        purpose: Purpose.planApproval,
      },
      keys,
    );
    expect(result.ok).toBe(true);

    // Tampering with the approved content breaks verification.
    const signer = await platformSigner(env);
    expect((await verifyPlanApproval(signer, ap, keys[0]!.keyId!)).ok).toBe(true);
    expect(
      (
        await verifyPlanApproval(
          signer,
          { ...ap, intent: `${ap.intent} (edited)` },
          keys[0]!.keyId!,
        )
      ).ok,
    ).toBe(false);

    // The read route returns the approved plan; the audit log has both events.
    const detail = await json<{ plan: Plan; changes: unknown[] }>(
      await call(app, "GET", `/api/v1/plans/${plan.id}`, { token: agent.token }),
    );
    expect(detail).toEqual({
      plan: ap,
      changes: [],
      principals: {
        [agent.principal.id]: {
          id: agent.principal.id,
          name: "builder-bot",
          kind: "agent",
          ownerId: agent.principal.ownerId,
          ownerName: "Alice",
        },
        [bob.principal.id]: {
          id: bob.principal.id,
          name: "Bob",
          kind: "human",
          ownerId: null,
          ownerName: null,
        },
      },
    });
    expect(ap).toMatchObject({ rejectedBy: null, rejectedAt: null, rejectionReason: null });
    const audit = await json<{
      events: { action: string; subject: string }[];
      chain: { verified: boolean };
    }>(await call(app, "GET", `/api/v1/audit?subject=plan:${plan.id}`, { cookie: bob.cookie }));
    expect(audit.events.map((e) => e.action)).toEqual(["plan.approved", "plan.created"]);
    expect(audit.chain.verified).toBe(true);
  });

  it("an agent cannot approve a plan (not even with a forged scope request)", async () => {
    const { app, repo, alice, agent } = await setup();
    const { plan } = await json<{ plan: Plan }>(
      await call(app, "POST", "/api/v1/plans", { cookie: alice.cookie, body: draft(repo.id) }),
    );
    const res = await call(app, "POST", `/api/v1/plans/${plan.id}/approve`, {
      token: agent.token,
      body: {},
    });
    await expectError(res, 403, "forbidden");
  });

  it("a human cannot approve their own plan", async () => {
    const { app, repo, alice } = await setup();
    const { plan } = await json<{ plan: Plan }>(
      await call(app, "POST", "/api/v1/plans", { cookie: alice.cookie, body: draft(repo.id) }),
    );
    const body = await expectError(
      await call(app, "POST", `/api/v1/plans/${plan.id}/approve`, {
        cookie: alice.cookie,
        body: {},
      }),
      403,
      "self-approval",
    );
    expect(body.error.fix.explanation).toMatch(/someone else/);
  });

  it("approving a superseding plan supersedes the earlier approved plan", async () => {
    const { app, repo, bob, agent } = await setup();
    const first = (
      await json<{ plan: Plan }>(
        await call(app, "POST", "/api/v1/plans", { token: agent.token, body: draft(repo.id) }),
      )
    ).plan;
    await call(app, "POST", `/api/v1/plans/${first.id}/approve`, { cookie: bob.cookie, body: {} });
    const second = (
      await json<{ plan: Plan }>(
        await call(app, "POST", "/api/v1/plans", {
          token: agent.token,
          body: draft(repo.id, { title: "Rate limit logins v2", supersedes: first.id }),
        }),
      )
    ).plan;
    expect(
      (
        await call(app, "POST", `/api/v1/plans/${second.id}/approve`, {
          cookie: bob.cookie,
          body: {},
        })
      ).status,
    ).toBe(200);
    const plans = await json<{ plans: Plan[] }>(
      await call(app, "GET", `/api/v1/repos/${repo.id}/plans`, { token: agent.token }),
    );
    const byId = new Map(plans.plans.map((p) => [p.id, p.status]));
    expect(byId.get(first.id)).toBe("superseded");
    expect(byId.get(second.id)).toBe("approved");
    // A superseded plan cannot be approved again.
    await expectError(
      await call(app, "POST", `/api/v1/plans/${first.id}/approve`, {
        cookie: bob.cookie,
        body: {},
      }),
      409,
      "invalid-state",
    );
  });

  it("rejects a draft; unknown repo and missing fields are clear errors", async () => {
    const { app, repo, bob, agent } = await setup();
    const { plan } = await json<{ plan: Plan }>(
      await call(app, "POST", "/api/v1/plans", { token: agent.token, body: draft(repo.id) }),
    );
    const rej = await call(app, "POST", `/api/v1/plans/${plan.id}/reject`, {
      cookie: bob.cookie,
      body: { comment: "too broad" },
    });
    const rejected = (
      await json<{ plan: Plan & { rejectedBy: string; rejectionReason: string } }>(rej)
    ).plan;
    expect(rejected).toMatchObject({
      status: "rejected",
      rejectedBy: bob.principal.id,
      rejectionReason: "too broad",
    });
    const reread = await json<{ plans: (Plan & { rejectedAt: string | null })[] }>(
      await call(app, "GET", `/api/v1/repos/${repo.id}/plans`, { token: agent.token }),
    );
    expect(reread.plans[0]?.rejectedAt).not.toBeNull();

    const missing = await expectError(
      await call(app, "POST", "/api/v1/plans", { token: agent.token, body: draft("nope") }),
      404,
      "not-found",
    );
    expect(missing.error.fix.call).toBe("list_repos({})");
    const invalid = await expectError(
      await call(app, "POST", "/api/v1/plans", {
        token: agent.token,
        body: { repoId: repo.id, title: "x" },
      }),
      400,
      "invalid-request",
    );
    expect(Array.isArray(invalid.error.details)).toBe(true);
  });

  it("Idempotency-Key replays the first response and refuses a different body", async () => {
    const { app, repo, agent } = await setup();
    const headers = { "idempotency-key": "plan-create-1" };
    const a = await call(app, "POST", "/api/v1/plans", {
      token: agent.token,
      body: draft(repo.id),
      headers,
    });
    const b = await call(app, "POST", "/api/v1/plans", {
      token: agent.token,
      body: draft(repo.id),
      headers,
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    const pa = (await json<{ plan: Plan }>(a)).plan;
    const pb = (await json<{ plan: Plan }>(b)).plan;
    expect(pb.id).toBe(pa.id);
    const plans = await json<{ plans: Plan[] }>(
      await call(app, "GET", `/api/v1/repos/${repo.id}/plans`, { token: agent.token }),
    );
    expect(plans.plans).toHaveLength(1);

    await expectError(
      await call(app, "POST", "/api/v1/plans", {
        token: agent.token,
        body: draft(repo.id, { title: "Something else entirely" }),
        headers,
      }),
      409,
      "idempotency-key-reuse",
    );

    // A failed request does not burn the key: fix the body and retry with the same key.
    const k2 = { "idempotency-key": "plan-create-2" };
    await expectError(
      await call(app, "POST", "/api/v1/plans", {
        token: agent.token,
        body: draft("missing-repo"),
        headers: k2,
      }),
      404,
      "not-found",
    );
    expect(
      (
        await call(app, "POST", "/api/v1/plans", {
          token: agent.token,
          body: draft(repo.id),
          headers: k2,
        })
      ).status,
    ).toBe(201);
  });
});
