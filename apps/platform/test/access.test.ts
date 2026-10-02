/**
 * Repo membership (src/access/): what a stranger, each role, an agent of each role and an
 * integration may do. Lifecycle calls go to a mocked CoordinatorApi (the facade's own access port
 * is covered in packages/coordinator and test/integration/access-claim.test.ts).
 */
import type { Change, Repo } from "@app/domain";
import { describe, expect, it, vi } from "vitest";
import { readPaths, status, world } from "./access-helpers.js";
import { addMember } from "./fixtures.js";
import { call, expectError, json } from "./http.js";

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
      [
        "POST",
        `/api/v1/repos/${w.repo.id}/members`,
        { principalId: w.bob.principal.id, role: "owner" },
      ],
    ];
    for (const [method, path, body] of writes) {
      await expectError(await call(w.app, method, path, { ...bob, body }), 404, "not-found");
    }
    for (const [path, body] of [
      [
        "/api/v1/plans",
        { repoId: w.repo.id, title: "Mine now", intent: "x", acceptanceCriteria: ["y"] },
      ],
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

describe("principal lookups", () => {
  it("show only principals you share a repo with (or your own); everyone else is 404", async () => {
    const w = await world();
    const look = (id: string, auth: { cookie?: string; token?: string }) =>
      call(w.app, "GET", `/api/v1/principals/${id}`, auth);
    expect((await look(w.aliceAgent.principal.id, { cookie: w.alice.cookie })).status).toBe(200);
    expect((await look(w.alice.principal.id, { token: w.aliceAgent.token })).status).toBe(200);
    for (const id of [w.alice.principal.id, w.aliceAgent.principal.id]) {
      await expectError(await look(id, { cookie: w.bob.cookie }), 404, "not-found");
      await expectError(await look(id, { token: w.bobAgent.token }), 404, "not-found");
    }
    await addMember(w.s, w.repo.id, w.bob.principal.id, "reader");
    const agent = await json<{ principal: { ownerName?: string } }>(
      await look(w.aliceAgent.principal.id, { cookie: w.bob.cookie }),
    );
    expect(agent.principal.ownerName).toBe("Alice");
  });
});
