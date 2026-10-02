/** What each repo role (and an agent of each role) may do, over HTTP and MCP. */
import type { Change } from "@app/domain";
import { createPlatformClient } from "@app/mcp/client";
import { describe, expect, it, vi } from "vitest";
import type { RepoRole } from "../src/access/roles.js";
import { world } from "./access-helpers.js";
import { addMember } from "./fixtures.js";
import { call, createAgent, expectError, json, ORIGIN, signUpHuman } from "./http.js";
import { fetchWith } from "./integration/unclaimed-helpers.js";

const coordinatorSpies = () => ({
  submitReview: vi.fn(async () => ({}) as Change),
  kill: vi.fn(async () => ({}) as Change),
  setLane0: vi.fn(async () => ({}) as never),
  startChange: vi.fn(async () => ({ change: {} as Change, remote: {} as never })),
});

/** The world plus Carol with `role` on the repo, and an agent of hers. */
async function withMember(role: RepoRole) {
  const spies = coordinatorSpies();
  const w = await world(spies);
  const carol = await signUpHuman(w.app, "Carol");
  await addMember(w.s, w.repo.id, carol.principal.id, role);
  const agent = await createAgent(w.app, carol.cookie);
  return { ...w, spies, carol, agent };
}

const draft = (repoId: string) => ({
  repoId,
  title: "Tidy the logs",
  intent: "Less noise in the request log.",
  acceptanceCriteria: ["No debug lines in production"],
});

describe("roles", () => {
  it("reader: reads, and is refused (insufficient-role) on review, approval, kill and through its agent", async () => {
    const m = await withMember("reader");
    const carol = { cookie: m.carol.cookie };
    expect((await call(m.app, "GET", `/api/v1/changes/${m.change.id}`, carol)).status).toBe(200);
    for (const [method, path, body] of [
      ["POST", `/api/v1/changes/${m.change.id}/review`, { decision: "approve" }],
      ["POST", `/api/v1/plans/${m.plan.id}/approve`, {}],
      ["POST", `/api/v1/changes/${m.change.id}/kill`, { reason: "x" }],
      ["PATCH", `/api/v1/repos/${m.repo.id}/lane0`, { enabled: false }],
    ] as const) {
      const err = await expectError(
        await call(m.app, method, path, { ...carol, body }),
        403,
        "insufficient-role",
      );
      expect(err.error.details).toMatchObject({ repoId: m.repo.id, role: "reader" });
      expect(err.error.fix.call).toBe(`list_members({ repoId: "${m.repo.id}" })`);
    }
    // The reader's agent can read but not draft plans or start changes (HTTP and MCP).
    const token = { token: m.agent.token };
    expect((await call(m.app, "GET", `/api/v1/repos/${m.repo.id}`, token)).status).toBe(200);
    await expectError(
      await call(m.app, "POST", "/api/v1/changes", {
        ...token,
        body: { repoId: m.repo.id, title: "x y z", category: "fix" },
      }),
      403,
      "insufficient-role",
    );
    await expectError(
      await call(m.app, "POST", "/api/v1/plans", { ...token, body: draft(m.repo.id) }),
      403,
      "insufficient-role",
    );
    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, m.agent.token, {
      fetch: fetchWith(m.app),
    });
    try {
      const start = await mcp.tools.start_change({
        repoId: m.repo.id,
        title: "Sneak",
        category: "fix",
      });
      expect(start.isError).toBe(true);
      expect(JSON.stringify(start.content)).toContain("insufficient-role");
      const plan = await mcp.tools.create_plan(draft(m.repo.id));
      expect(JSON.stringify(plan.content)).toContain("insufficient-role");
      const status = await mcp.tools.get_change_status({ changeId: m.change.id });
      expect(status.isError).toBeFalsy();
      const members = await mcp.tools.list_members({ repoId: m.repo.id });
      expect(members.structuredContent).toMatchObject({ yourRole: "reader" });
    } finally {
      await mcp.client.close();
    }
    expect(m.spies.submitReview).not.toHaveBeenCalled();
    expect(m.spies.startChange).not.toHaveBeenCalled();
  });

  it("reviewer: reviews, its agent starts changes; approving plans and the kill switch need a maintainer", async () => {
    const m = await withMember("reviewer");
    const carol = { cookie: m.carol.cookie };
    const review = await call(m.app, "POST", `/api/v1/changes/${m.change.id}/review`, {
      ...carol,
      body: { decision: "approve" },
    });
    expect(review.status).toBe(200);
    expect(m.spies.submitReview).toHaveBeenCalledOnce();
    await expectError(
      await call(m.app, "POST", `/api/v1/plans/${m.plan.id}/approve`, { ...carol, body: {} }),
      403,
      "insufficient-role",
    );
    await expectError(
      await call(m.app, "POST", `/api/v1/changes/${m.change.id}/kill`, {
        ...carol,
        body: { reason: "x" },
      }),
      403,
      "insufficient-role",
    );
    const started = await call(m.app, "POST", "/api/v1/changes", {
      token: m.agent.token,
      body: { repoId: m.repo.id, title: "Tidy logs", category: "fix" },
    });
    expect(started.status).toBe(201);
    expect(m.spies.startChange).toHaveBeenCalledOnce();
  });

  it("maintainer: approves plans and pulls the kill switch; Lane 0 and the deploy target are the owner's", async () => {
    const m = await withMember("maintainer");
    const carol = { cookie: m.carol.cookie };
    const approved = await call(m.app, "POST", `/api/v1/plans/${m.plan.id}/approve`, {
      ...carol,
      body: {},
    });
    expect(approved.status).toBe(200);
    expect((await json<{ plan: { approvedBy: string } }>(approved)).plan.approvedBy).toBe(
      m.carol.principal.id,
    );
    expect(
      (
        await call(m.app, "POST", `/api/v1/changes/${m.change.id}/kill`, {
          ...carol,
          body: { reason: "x" },
        })
      ).status,
    ).toBe(200);
    expect(m.spies.kill).toHaveBeenCalledOnce();
    await expectError(
      await call(m.app, "PATCH", `/api/v1/repos/${m.repo.id}/lane0`, {
        ...carol,
        body: { enabled: true },
      }),
      403,
      "insufficient-role",
    );
    await expectError(
      await call(m.app, "PATCH", `/api/v1/repos/${m.repo.id}/deploy-target`, {
        ...carol,
        body: { script: "api" },
      }),
      403,
      "insufficient-role",
    );
    // The owner may.
    expect(
      (
        await call(m.app, "PATCH", `/api/v1/repos/${m.repo.id}/lane0`, {
          cookie: m.alice.cookie,
          body: { enabled: true },
        })
      ).status,
    ).toBe(200);
    expect(m.spies.setLane0).toHaveBeenCalledOnce();
  });

  it("capabilities list each repo's role and the actions it allows", async () => {
    const expected: Record<RepoRole, string[]> = {
      reader: ["read"],
      reviewer: ["read", "create-plan", "start-change", "review-change"],
      maintainer: ["read", "create-plan", "start-change", "approve-plan", "review-change"],
      owner: [
        "read",
        "create-plan",
        "start-change",
        "approve-plan",
        "review-change",
        "admin",
        "enable-lane0",
      ],
    };
    for (const role of Object.keys(expected) as RepoRole[]) {
      const m = await withMember(role);
      const caps = await json<{ repos: { id: string; role: string; actions: string[] }[] }>(
        await call(m.app, "GET", "/api/v1/capabilities", { cookie: m.carol.cookie }),
      );
      expect(caps.repos.find((r) => r.id === m.repo.id)).toMatchObject({
        role,
        actions: expected[role],
      });
      const agentCaps = await json<{ repos: { id: string; actions: string[] }[] }>(
        await call(m.app, "GET", "/api/v1/capabilities", { token: m.agent.token }),
      );
      const agentActions = agentCaps.repos.find((r) => r.id === m.repo.id)?.actions;
      expect(agentActions).toEqual(
        role === "reader" ? ["read"] : ["read", "create-plan", "start-change"],
      );
    }
  });
});
