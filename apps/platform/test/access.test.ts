/**
 * Repo membership (src/access/): what a stranger, each role, an agent of each role and an
 * integration may do. Lifecycle calls go to a mocked CoordinatorApi (the facade's own access port
 * is covered in packages/coordinator and test/integration/access-claim.test.ts).
 */
import { env } from "cloudflare:workers";
import type { Change, Repo } from "@app/domain";
import { describe, expect, it, vi } from "vitest";
import { DoAudit } from "../src/audit/audit.js";
import {
  addMember,
  changeFixture,
  classificationFixture,
  diffFixture,
  evidenceFixture,
  planFixture,
  repoFixture,
  runFixture,
  store,
  tourFixture,
} from "./fixtures.js";
import { call, createAgent, expectError, json, makeApp, signUpHuman, type TestApp } from "./http.js";

export async function world(coordinator: Parameters<typeof makeApp>[0] = {}) {
  const { app, coordinator: mock } = makeApp(coordinator);
  const alice = await signUpHuman(app, "Alice");
  const aliceAgent = await createAgent(app, alice.cookie);
  const bob = await signUpHuman(app, "Bob");
  const bobAgent = await createAgent(app, bob.cookie);
  const s = store();
  // Alice creates the repo: insertRepo makes her its owner member.
  const repo = repoFixture({
    claim: { status: "claimed", ownerId: alice.principal.id, expiresAt: null },
  });
  await s.insertRepo(repo);
  const plan = planFixture(repo.id, aliceAgent.principal.id);
  await s.insertPlan(plan);
  const change = changeFixture(repo.id, aliceAgent.principal.id, { planId: plan.id });
  await s.insertChange(change);
  await s.putDiff(change.id, diffFixture());
  await s.putEvidence(await evidenceFixture(change.id));
  await s.putTour(tourFixture(change.id));
  await s.putClassification(change.id, change.headSha ?? "", classificationFixture());
  const run = runFixture(change.id);
  await s.upsertRun(run);
  const blob = `ci-logs/${run.id}/test.log`;
  await env.BLOBS.put(blob, "ok\n");
  await new DoAudit(env).append({
    principalId: alice.principal.id,
    action: "test.secret-event",
    subject: `change:${change.id}`,
    payload: {},
  });
  return { app, mock, s, alice, aliceAgent, bob, bobAgent, repo, plan, change, blob };
}

type World = Awaited<ReturnType<typeof world>>;

/** Every read route of the repo, its plan and its change. */
export function readPaths(w: Pick<World, "repo" | "plan" | "change" | "blob">): string[] {
  const c = `/api/v1/changes/${w.change.id}`;
  return [
    `/api/v1/repos/${w.repo.id}`,
    `/api/v1/repos/${w.repo.id}/plans`,
    `/api/v1/repos/${w.repo.id}/changes`,
    `/api/v1/repos/${w.repo.id}/members`,
    `/api/v1/repos/${w.repo.id}/queue`,
    `/api/v1/plans/${w.plan.id}`,
    c,
    `${c}/diff`,
    `${c}/evidence`,
    `${c}/tour`,
    `${c}/reviews`,
    `${c}/rollout`,
    `${c}/issues`,
    `${c}/events`,
    `/api/v1/audit?subject=change:${w.change.id}`,
    `/api/v1/blobs/${encodeURIComponent(w.blob)}`,
  ];
}

async function status(app: TestApp, path: string, auth: { cookie?: string; token?: string }) {
  const res = await call(app, "GET", path, auth);
  const body = await res.text();
  return { path, status: res.status, code: res.status >= 400 ? JSON.parse(body).error?.code : null };
}

describe("a second human sees nothing of the first human's repo", () => {
  it("every read route is 404 (as if it did not exist), for Bob and Bob's agent; Alice reads them all", async () => {
    const w = await world();
    for (const path of readPaths(w)) {
      if (path.endsWith("/events")) continue; // a stream: checked below
      // (The queue overview reads the repo's git, which these fixtures don't have.)
      if (!path.endsWith("/queue")) {
        expect(await status(w.app, path, { cookie: w.alice.cookie }), path).toMatchObject({
          status: 200,
        });
      }
      for (const auth of [{ cookie: w.bob.cookie }, { token: w.bobAgent.token }]) {
        expect(await status(w.app, path, auth)).toEqual({ path, status: 404, code: "not-found" });
      }
    }
    const sse = await call(w.app, "GET", `/api/v1/changes/${w.change.id}/events`, {
      cookie: w.bob.cookie,
    });
    expect(sse.status).toBe(404);
    await sse.text();
  });

  it("listings leave the repo out: repos, capabilities and the global audit log", async () => {
    const w = await world();
    for (const auth of [{ cookie: w.bob.cookie }, { token: w.bobAgent.token }]) {
      const repos = await json<{ repos: Repo[] }>(await call(w.app, "GET", "/api/v1/repos", auth));
      expect(repos.repos.map((r) => r.id)).not.toContain(w.repo.id);
      const caps = await json<{ repos: { id: string }[] }>(
        await call(w.app, "GET", "/api/v1/capabilities", auth),
      );
      expect(caps.repos.map((r) => r.id)).not.toContain(w.repo.id);
    }
    const bobAudit = await json<{ events: { action: string; subject: string }[] }>(
      await call(w.app, "GET", "/api/v1/audit?limit=200", { cookie: w.bob.cookie }),
    );
    expect(bobAudit.events.map((e) => e.subject)).not.toContain(`change:${w.change.id}`);
    expect(bobAudit.events.map((e) => e.subject)).not.toContain(`repo:${w.repo.id}`);
    const aliceAudit = await json<{ events: { subject: string }[] }>(
      await call(w.app, "GET", "/api/v1/audit?limit=200", { cookie: w.alice.cookie }),
    );
    expect(aliceAudit.events.map((e) => e.subject)).toContain(`change:${w.change.id}`);
    const caps = await json<{ repos: { id: string; role: string; actions: string[] }[] }>(
      await call(w.app, "GET", "/api/v1/capabilities", { cookie: w.alice.cookie }),
    );
    expect(caps.repos.find((r) => r.id === w.repo.id)).toMatchObject({ role: "owner" });
  });

  it("Bob can neither approve the plan, review or kill the change, nor act through his agent", async () => {
    const submitReview = vi.fn(async () => ({}) as Change);
    const kill = vi.fn(async () => ({}) as Change);
    const startChange = vi.fn();
    const w = await world({ submitReview, kill, startChange });
    const bob = { cookie: w.bob.cookie };
    const writes: Array<[string, string, unknown]> = [
      ["POST", `/api/v1/plans/${w.plan.id}/approve`, {}],
      ["POST", `/api/v1/plans/${w.plan.id}/reject`, { comment: "no" }],
      ["POST", `/api/v1/changes/${w.change.id}/review`, { decision: "approve" }],
      ["POST", `/api/v1/changes/${w.change.id}/kill`, { reason: "mine now" }],
      ["PATCH", `/api/v1/repos/${w.repo.id}/lane0`, { enabled: true }],
      ["POST", `/api/v1/repos/${w.repo.id}/members`, { principalId: w.bob.principal.id, role: "owner" }],
    ];
    for (const [method, path, body] of writes) {
      await expectError(await call(w.app, method, path, { ...bob, body }), 404, "not-found");
    }
    for (const [path, body] of [
      ["/api/v1/plans", { repoId: w.repo.id, title: "Mine now", intent: "x", acceptanceCriteria: ["y"] }],
      ["/api/v1/changes", { repoId: w.repo.id, title: "Mine now", category: "fix" }],
    ] as const) {
      await expectError(
        await call(w.app, "POST", path, { token: w.bobAgent.token, body }),
        404,
        "not-found",
      );
    }
    expect(submitReview).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(startChange).not.toHaveBeenCalled();
    expect((await w.s.getPlan(w.plan.id))?.status).toBe("draft");
  });
});
