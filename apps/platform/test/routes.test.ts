import { env } from "cloudflare:workers";
import { CoordinatorError } from "@app/coordinator";
import type { Change, Repo } from "@app/domain";
import { describe, expect, it, vi } from "vitest";
import { DoAudit } from "../src/audit/audit.js";
import {
  changeFixture,
  classificationFixture,
  diffFixture,
  evidenceFixture,
  HEAD_SHA,
  runFixture,
  seedWorld,
  store,
  tourFixture,
  uid,
} from "./fixtures.js";
import { call, createAgent, expectError, json, makeApp, signUpHuman } from "./http.js";

async function world(coordinator = {}) {
  const { app, coordinator: mock } = makeApp(coordinator);
  const human = await signUpHuman(app);
  const agent = await createAgent(app, human.cookie);
  const s = store();
  const seeded = await seedWorld(s);
  return {
    app,
    mock,
    human,
    agent,
    s,
    repo: seeded.repo,
    plan: seeded.plan,
    change: seeded.change,
  };
}

describe("repo read routes", () => {
  it("lists repos with lane counts and shadow stats, and returns one repo", async () => {
    const { app, agent, repo, s, human } = await world();
    await s.insertChange(
      changeFixture(repo.id, agent.principal.id, { status: "failing", lane: 2 }),
    );
    const list = await json<{
      repos: (Repo & { counts: Record<string, number>; shadow: Record<string, unknown> })[];
    }>(await call(app, "GET", "/api/v1/repos", { token: agent.token }));
    const mine = list.repos.find((r) => r.id === repo.id)!;
    expect(mine.counts).toEqual({
      lane0: 0,
      lane1: 1,
      lane2: 1,
      awaitingReview: 1,
      rollingOut: 0,
      failing: 1,
      plansAwaitingApproval: 1,
    });
    expect(mine.shadow).toEqual({
      samples: 0,
      agreed: 0,
      ratio: null,
      needed: 25,
      threshold: 0.95,
      eligibleToEnableLane0: false,
    });
    expect(mine.claim).toEqual({ status: "claimed", ownerId: null, expiresAt: null });

    const detail = await json<{ repo: Repo; counts: unknown; shadow: unknown }>(
      await call(app, "GET", `/api/v1/repos/${repo.id}`, { cookie: human.cookie }),
    );
    expect(detail.repo).toEqual(repo);
    expect(detail.counts).toEqual(mine.counts);
    await expectError(
      await call(app, "GET", "/api/v1/repos/missing", { token: agent.token }),
      404,
      "not-found",
    );
  });

  it("lists changes with plan title/author and filters by status and lane", async () => {
    const { app, agent, repo, plan, change } = await world();
    const res = await json<{
      changes: (Change & { planTitle: string; authorName: string; authorKind: string })[];
    }>(await call(app, "GET", `/api/v1/repos/${repo.id}/changes`, { token: agent.token }));
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0]).toMatchObject({
      id: change.id,
      planTitle: plan.title,
      authorKind: "agent",
    });
    const none = await json<{ changes: unknown[] }>(
      await call(app, "GET", `/api/v1/repos/${repo.id}/changes?status=merged,released&lane=1`, {
        token: agent.token,
      }),
    );
    expect(none.changes).toHaveLength(0);
    await expectError(
      await call(app, "GET", `/api/v1/repos/${repo.id}/changes?status=bogus`, {
        token: agent.token,
      }),
      400,
      "invalid-request",
    );
  });
});

describe("change read routes", () => {
  it("returns the change with plan, runs and classification", async () => {
    const { app, agent, s, change, plan } = await world();
    const run = runFixture(change.id);
    await s.upsertRun(run);
    const cls = classificationFixture();
    await s.putClassification(change.id, HEAD_SHA, cls);
    const body = await json<Record<string, unknown>>(
      await call(app, "GET", `/api/v1/changes/${change.id}`, { token: agent.token }),
    );
    expect(body).toMatchObject({
      change,
      plan: { ...plan, rejectedBy: null, rejectedAt: null, rejectionReason: null },
      runs: [run],
      classification: cls,
    });
    expect(Object.keys(body.principals as object)).toContain(change.authorId);
  });

  it("serves diff, evidence (verified), tour, rollout timeline and issues", async () => {
    const { app, agent, s, change } = await world();
    for (const path of ["diff", "evidence", "tour"]) {
      const err = await expectError(
        await call(app, "GET", `/api/v1/changes/${change.id}/${path}`, { token: agent.token }),
        404,
        "not-found",
      );
      expect(err.error.fix.call).toBe(`get_change_status({ changeId: "${change.id}" })`);
    }

    const diff = diffFixture();
    await s.putDiff(change.id, diff);
    expect(
      await json(
        await call(app, "GET", `/api/v1/changes/${change.id}/diff`, { token: agent.token }),
      ),
    ).toEqual({
      diff,
    });

    const ev = await evidenceFixture(change.id);
    await s.putEvidence(ev);
    const evRes = await json<{ evidence: unknown; verification: { ok: boolean; keyId?: string } }>(
      await call(app, "GET", `/api/v1/changes/${change.id}/evidence`, { token: agent.token }),
    );
    expect(evRes.evidence).toEqual(ev);
    expect(evRes.verification).toEqual({ ok: true, keyId: ev.attestation.keyId });

    // Tampered evidence (an item injected after signing) fails verification.
    await env.DB.prepare(
      "UPDATE evidence SET json = json_set(json, '$.items[0].passed', 999) WHERE change_id = ?",
    )
      .bind(change.id)
      .run();
    const tampered = await json<{ verification: { ok: boolean; reason?: string } }>(
      await call(app, "GET", `/api/v1/changes/${change.id}/evidence`, { token: agent.token }),
    );
    expect(tampered.verification.ok).toBe(false);

    const tour = tourFixture(change.id);
    await s.putTour(tour);
    expect(
      await json(
        await call(app, "GET", `/api/v1/changes/${change.id}/tour`, { token: agent.token }),
      ),
    ).toEqual({
      tour,
      stale: false,
    });

    // A re-push moves the head: the old tour is still served, marked stale.
    await s.updateChange(change.id, { headSha: "c".repeat(40) });
    const stale = await json<{ tour: { id: string }; stale: boolean }>(
      await call(app, "GET", `/api/v1/changes/${change.id}/tour`, { token: agent.token }),
    );
    expect(stale).toMatchObject({ tour: { id: tour.id }, stale: true });
    await s.updateChange(change.id, { headSha: HEAD_SHA });

    await new DoAudit(env).append({
      principalId: "system",
      action: "rollout.stage",
      subject: `change:${change.id}`,
      payload: { percent: 5 },
    });
    // The rollout policy comes from the change's base, not the repo's current policy.
    const repoNow = (await s.getRepo(change.repoId))!;
    await s.setRepoPolicy(
      change.repoId,
      { ...repoNow.policy, rollout: { ...repoNow.policy.rollout, stages: [10, 100] } },
      change.baseSha,
    );
    await s.setRepoPolicy(
      change.repoId,
      { ...repoNow.policy, rollout: { ...repoNow.policy.rollout, stages: [50, 100] } },
      "d".repeat(40),
    );
    const rollout = await json<{
      rollout: unknown;
      timeline: { action: string; summary: string; principalId: string }[];
      policy: { stages: number[] };
      policySha: string;
      principals: Record<string, { kind: string }>;
    }>(await call(app, "GET", `/api/v1/changes/${change.id}/rollout`, { token: agent.token }));
    expect(rollout.rollout).toBeNull();
    expect(rollout.timeline.map((e) => [e.action, e.summary])).toEqual([
      ["rollout.stage", "Stage 5% started"],
    ]);
    expect(rollout.policy.stages).toEqual([10, 100]);
    expect(rollout.policySha).toBe(change.baseSha);
    expect(rollout.principals.system?.kind).toBe("system");

    await s.putIssue({
      id: uid("iss"),
      changeId: change.id,
      title: "Error: boom",
      count: 2,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      versionId: null,
      url: null,
      scriptName: "app",
      raw: {},
    });
    const issues = await json<{ issues: { title: string }[] }>(
      await call(app, "GET", `/api/v1/changes/${change.id}/issues`, { token: agent.token }),
    );
    expect(issues.issues.map((i) => i.title)).toEqual(["Error: boom"]);
  });
});

describe("lifecycle routes call the CoordinatorApi", () => {
  it("POST /changes forwards to startChange with the caller and idempotency key", async () => {
    const startChange = vi.fn(async (_actor, input: { repoId: string }) => ({
      change: changeFixture(input.repoId, "x"),
      remote: {
        url: "https://git.example/r.git",
        username: "x",
        token: "t",
        expiresAt: "2026-10-01T00:00:00Z",
        branch: "main",
      },
    }));
    const { app, agent, repo } = await world({ startChange });
    const res = await call(app, "POST", "/api/v1/changes", {
      token: agent.token,
      body: { repoId: repo.id, title: "Do it", category: "fix" },
      headers: { "idempotency-key": "start-1" },
    });
    expect(res.status).toBe(201);
    expect(startChange).toHaveBeenCalledTimes(1);
    const [actor, input] = startChange.mock.calls[0]!;
    expect(actor).toMatchObject({ id: agent.principal.id, kind: "agent" });
    expect(input).toMatchObject({
      repoId: repo.id,
      title: "Do it",
      category: "fix",
      idempotencyKey: "start-1",
    });
  });

  it("maps CoordinatorError codes to statuses and keeps the coordinator's fix", async () => {
    const submitReview = vi.fn(async () => {
      throw new CoordinatorError("self-approval", "authors cannot review their own change", {
        explanation: "Ask another human to review this change.",
        call: 'request_review({ changeId: "c1" })',
      });
    });
    const { app, human, change } = await world({ submitReview });
    const body = await expectError(
      await call(app, "POST", `/api/v1/changes/${change.id}/review`, {
        cookie: human.cookie,
        body: { decision: "approve" },
      }),
      403,
      "self-approval",
    );
    expect(body.error.fix.call).toBe('request_review({ changeId: "c1" })');
  });

  it("agents cannot review or kill (no scope, humans only)", async () => {
    const { app, agent, change } = await world();
    await expectError(
      await call(app, "POST", `/api/v1/changes/${change.id}/review`, {
        token: agent.token,
        body: { decision: "approve" },
      }),
      403,
      "forbidden",
    );
    await expectError(
      await call(app, "POST", `/api/v1/changes/${change.id}/kill`, {
        token: agent.token,
        body: { reason: "x" },
      }),
      403,
      "forbidden",
    );
  });

  it("an unavailable coordinator answers 502 upstream with a fix", async () => {
    const { app, agent, change } = await world();
    await expectError(
      await call(app, "POST", `/api/v1/changes/${change.id}/token`, { token: agent.token }),
      502,
      "upstream",
    );
  });

  it("request-review notifies and audits, and only the author (or owner) may ask", async () => {
    const { app, human, agent, s, repo } = await world();
    const mine = changeFixture(repo.id, agent.principal.id);
    await s.insertChange(mine);
    const res = await call(app, "POST", `/api/v1/changes/${mine.id}/request-review`, {
      token: agent.token,
      body: { message: "stuck on flaky test" },
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ notified: true, change: { id: mine.id } });
    const n = await env.DB.prepare("SELECT kind, message FROM notifications WHERE change_id = ?")
      .bind(mine.id)
      .first();
    expect(n).toEqual({ kind: "review-requested", message: "stuck on flaky test" });

    // The owning human may ask too; a stranger may not.
    expect(
      (
        await call(app, "POST", `/api/v1/changes/${mine.id}/request-review`, {
          cookie: human.cookie,
          body: {},
        })
      ).status,
    ).toBe(200);
    const stranger = await signUpHuman(app, "Mallory");
    await expectError(
      await call(app, "POST", `/api/v1/changes/${mine.id}/request-review`, {
        cookie: stranger.cookie,
        body: {},
      }),
      403,
      "forbidden",
    );
  });
});

describe("audit route", () => {
  it("pages newest first with a cursor and reports a tampered mirror", async () => {
    const { app, human } = await world();
    const audit = new DoAudit(env);
    const subject = `repo:${uid("audit")}`;
    for (let i = 0; i < 5; i++)
      await audit.append({ principalId: "system", action: "t", subject, payload: { i } });
    const p1 = await json<{
      events: { seq: number }[];
      nextCursor: string | null;
      chain: { verified: boolean };
    }>(
      await call(app, "GET", `/api/v1/audit?subject=${subject}&limit=3`, { cookie: human.cookie }),
    );
    expect(p1.events).toHaveLength(3);
    expect(p1.chain.verified).toBe(true);
    expect(p1.nextCursor).toBe(String(p1.events[2]!.seq));
    const p2 = await json<{ events: { seq: number }[]; nextCursor: string | null }>(
      await call(app, "GET", `/api/v1/audit?subject=${subject}&limit=3&cursor=${p1.nextCursor}`, {
        cookie: human.cookie,
      }),
    );
    expect(p2.events).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();

    const target = p1.events[1]!.seq;
    await env.DB.prepare(
      "UPDATE audit_events SET action = 'forged' WHERE seq = ? AND log = 'global'",
    )
      .bind(target)
      .run();
    const bad = await json<{ chain: { verified: boolean; brokenAt?: number } }>(
      await call(app, "GET", `/api/v1/audit?subject=${subject}`, { cookie: human.cookie }),
    );
    expect(bad.chain).toEqual({ verified: false, brokenAt: target });
  });
});
