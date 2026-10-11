/**
 * What an agent (and the person accountable for it) can read about its work, over the real Worker
 * with D1 and the AuditLog DO (coordinator mocked): the audit log names an agent's owner, filters
 * by actor, action and repo (HTTP and `list_audit_events`), and `get_rollout` gives the same view
 * as a change's rollout page.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { parseToolError } from "@app/mcp";
import { createPlatformClient } from "@app/mcp/client";
import { describe, expect, it } from "vitest";
import { conflictResolutionItem } from "@app/evidence";
import { DoAudit } from "../src/audit/audit.js";
import {
  changeFixture,
  classificationFixture,
  evidenceFixture,
  HEAD_SHA,
  repoFixture,
  store,
  tourFixture,
} from "./fixtures.js";
import { call, createAgent, json, makeApp, ORIGIN, signUpHuman, type TestApp } from "./http.js";

function fetchVia(app: TestApp) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(input, init), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
}

/** A human (Ada) who owns a repo, her agent, and one change the agent started. */
async function setup() {
  const { app } = makeApp();
  const human = await signUpHuman(app, "Ada");
  const agent = await createAgent(app, human.cookie);
  const s = store();
  const repo = repoFixture({
    claim: { status: "claimed", ownerId: human.principal.id, expiresAt: null },
  });
  await s.insertRepo(repo);
  const change = changeFixture(repo.id, agent.principal.id);
  await s.insertChange(change);
  await s.putClassification(change.id, HEAD_SHA, classificationFixture());
  const mcp = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, { fetch: fetchVia(app) });
  return { app, human, agent, repo, change, mcp };
}

function errorOf(result: { isError?: boolean; content?: unknown }) {
  expect(result.isError).toBe(true);
  return parseToolError((result.content as { text: string }[])[0]!.text);
}

interface AuditPage {
  events: { seq: number; principalId: string; action: string; subject: string }[];
  nextCursor: string | null;
  subjects: Record<string, { title: string; repoId: string | null; repoName: string | null }>;
  principals: Record<
    string,
    { name: string; kind: string; ownerId: string | null; ownerName: string | null }
  >;
}

describe("the audit log names who is accountable and filters by actor, action and repo", () => {
  it("GET /api/v1/audit: an agent's events carry its owner's name; actor, action and repoId narrow", async () => {
    const { app, human, agent, repo, change, mcp } = await setup();
    try {
      const asked = await mcp.tools.request_review({ changeId: change.id });
      if (asked.isError) throw new Error(JSON.stringify(asked.content));
    } finally {
      await mcp.client.close();
    }
    const page = async (query: string) => {
      const res = await call(app, "GET", `/api/v1/audit?${query}`, { cookie: human.cookie });
      expect(res.status).toBe(200);
      return json<AuditPage>(res);
    };

    const byAgent = await page(`actor=${agent.principal.id}`);
    expect(byAgent.events.length).toBeGreaterThan(0);
    expect(byAgent.events.every((e) => e.principalId === agent.principal.id)).toBe(true);
    expect(byAgent.events.map((e) => e.action)).toContain("change.review-requested");
    // The band and the audit rows say "agent of Ada" in production, not only on demo data.
    expect(byAgent.principals[agent.principal.id]).toMatchObject({
      kind: "agent",
      ownerId: human.principal.id,
      ownerName: "Ada",
    });

    // Subjects are named for reading: the change's title and repo, the agent's name.
    expect(byAgent.subjects[`change:${change.id}`]).toEqual({
      title: change.title,
      repoId: repo.id,
      repoName: repo.name,
    });

    const byHuman = await page(`actor=${human.principal.id}`);
    const issued = byHuman.events.find((e) => e.subject === `principal:${agent.principal.id}`);
    expect(issued).toBeDefined();
    expect(byHuman.subjects[`principal:${agent.principal.id}`]).toEqual({
      title: "builder-bot",
      repoId: null,
      repoName: null,
    });
    expect(byHuman.events.every((e) => e.principalId === human.principal.id)).toBe(true);
    expect(byHuman.events.map((e) => e.action)).not.toContain("change.review-requested");

    const byAction = await page("action=change.review-requested");
    expect(byAction.events.length).toBeGreaterThan(0);
    expect(byAction.events.every((e) => e.action === "change.review-requested")).toBe(true);
    // Not a prefix or a substring: an action matches exactly.
    expect((await page("action=change.review")).events).toEqual([]);

    const inRepo = await page(`repoId=${repo.id}`);
    expect(inRepo.events.map((e) => e.subject)).toContain(`change:${change.id}`);
    expect(inRepo.events.every((e) => e.subject !== `principal:${agent.principal.id}`)).toBe(true);
    const elsewhere = await call(app, "GET", "/api/v1/audit?repoId=repo_elsewhere", {
      cookie: human.cookie,
    });
    expect(elsewhere.status).toBe(404);
  });

  it("list_audit_events: the caller's own trail with owners, the page to hand a person, and paging", async () => {
    const { agent, change, mcp } = await setup();
    try {
      await mcp.tools.request_review({ changeId: change.id, message: "first" });
      await mcp.tools.request_review({ changeId: change.id, message: "second" });
      const r = await mcp.tools.list_audit_events({ actor: agent.principal.id, limit: 1 });
      if (r.isError) throw new Error(JSON.stringify(r.content));
      const out = r.structuredContent;
      expect(out.events).toHaveLength(1);
      expect(out.events[0]).toMatchObject({
        action: "change.review-requested",
        subject: `change:${change.id}`,
        actor: { id: agent.principal.id, kind: "agent", ownerName: "Ada" },
        about: { title: change.title },
      });
      expect(out.chain.verified).toBe(true);
      expect(out.url).toBe(`${ORIGIN}/audit?actor=${agent.principal.id}`);
      expect(out.nextCursor).not.toBeNull();
      expect(out.nextSteps.map((s) => s.call)).toContain(
        `list_audit_events({ actor: "${agent.principal.id}", limit: 1, cursor: "${out.nextCursor}" })`,
      );
      const older = await mcp.tools.list_audit_events({
        actor: agent.principal.id,
        limit: 1,
        cursor: out.nextCursor ?? undefined,
      });
      if (older.isError) throw new Error(JSON.stringify(older.content));
      expect(older.structuredContent.events[0]!.seq).toBeLessThan(out.events[0]!.seq);

      // A repo the caller can't see answers like one that doesn't exist.
      const unknown = errorOf(await mcp.tools.list_audit_events({ repoId: "repo_nope" }));
      expect(unknown?.error.code).toBe("not-found");
    } finally {
      await mcp.client.close();
    }
  });
});

describe("get_rollout", () => {
  it("is the rollout page's view: stages, last check, flag, policy from the base, timeline and url", async () => {
    const { agent, repo, mcp } = await setup();
    const s = store();
    const merged = changeFixture(repo.id, agent.principal.id, {
      status: "rolling-out",
      mergedSha: HEAD_SHA,
      flagKey: "change-rollout",
      rolloutState: {
        status: "rolling",
        versionId: "v2",
        previousVersionId: "v1",
        stages: [
          {
            percent: 5,
            startedAt: "2026-10-01T00:10:00.000Z",
            completedAt: "2026-10-01T00:20:00.000Z",
          },
          { percent: 25, startedAt: "2026-10-01T00:20:00.000Z", completedAt: null },
        ],
        watchUntil: null,
        flagKey: "change-rollout",
        lastCheck: {
          at: "2026-10-01T00:25:00.000Z",
          errorRate: 0.002,
          baselineErrorRate: 0.001,
          requests: 1200,
          newIssueGroups: 0,
        },
      },
    });
    await s.insertChange(merged);
    try {
      const r = await mcp.tools.get_rollout({ changeId: merged.id });
      if (r.isError) throw new Error(JSON.stringify(r.content));
      const out = r.structuredContent;
      expect(out).toMatchObject({
        changeId: merged.id,
        status: "rolling-out",
        mergedSha: HEAD_SHA,
        revertedBy: null,
        rollout: {
          status: "rolling",
          versionId: "v2",
          flagKey: "change-rollout",
          lastCheck: { errorRate: 0.002, requests: 1200 },
        },
        policy: { stages: [5, 25, 100] },
        url: `${ORIGIN}/changes/${merged.id}/rollout`,
      });
      expect(out.rollout?.stages.map((st) => st.percent)).toEqual([5, 25]);
      expect(Array.isArray(out.timeline)).toBe(true);
      // While it rolls out: watch for a revert and for production issues.
      expect(out.nextSteps.map((n) => n.call)).toEqual(
        expect.arrayContaining([
          `wait_for_change({ changeId: "${merged.id}", until: "reverted" })`,
          `list_issues_for_change({ changeId: "${merged.id}" })`,
        ]),
      );
    } finally {
      await mcp.client.close();
    }
  });
});

describe("agent outputs name who is accountable and what to hand a person", () => {
  it("whoami names the owner and the agents page; get_change_status the author and its owner", async () => {
    const { agent, change, mcp } = await setup();
    try {
      const me = await mcp.tools.whoami();
      if (me.isError) throw new Error(JSON.stringify(me.content));
      expect(me.structuredContent).toMatchObject({
        principalId: agent.principal.id,
        ownerName: "Ada",
        agentsUrl: `${ORIGIN}/agents`,
      });
      expect(me.structuredContent.nextSteps[0]?.title).toBe(
        `Ada answers for you and can inspect or revoke you at ${ORIGIN}/agents`,
      );

      const st = await mcp.tools.get_change_status({ changeId: change.id });
      if (st.isError) throw new Error(JSON.stringify(st.content));
      expect(st.structuredContent.author).toEqual({
        id: agent.principal.id,
        name: "builder-bot",
        kind: "agent",
        ownerId: agent.principal.ownerId,
        ownerName: "Ada",
      });
      expect(st.structuredContent.resolution).toBeNull();
    } finally {
      await mcp.client.close();
    }
  });

  it("get_evidence and get_tour hand over their pages and say what to do next", async () => {
    const { change, mcp } = await setup();
    const s = store();
    await s.putEvidence(await evidenceFixture(change.id));
    const tour = tourFixture(change.id);
    await s.putTour({
      ...tour,
      stops: tour.stops.map((st, i) => (i === 0 ? { ...st, verdict: "unproven" as const } : st)),
    });
    await s.updateChange(change.id, { tourId: tour.id });
    try {
      const ev = await mcp.tools.get_evidence({ changeId: change.id });
      if (ev.isError) throw new Error(JSON.stringify(ev.content));
      expect(ev.structuredContent.url).toBe(`${ORIGIN}/changes/${change.id}/evidence`);
      expect(ev.structuredContent.nextSteps[0]?.call).toBe(
        `get_tour({ changeId: "${change.id}" })`,
      );

      const t = await mcp.tools.get_tour({ changeId: change.id });
      if (t.isError) throw new Error(JSON.stringify(t.content));
      expect(t.structuredContent.url).toBe(`${ORIGIN}/changes/${change.id}`);
      expect(t.structuredContent.nextSteps[0]?.title).toMatch(
        /^Turn 1 unproven stop\(s\) into proven ones/,
      );
    } finally {
      await mcp.client.close();
    }
  });

  it("get_change_status carries the merge queue's resolution: what lands, and that it needs a fresh approval", async () => {
    const { change, mcp } = await setup();
    const s = store();
    const resolved = "e".repeat(40);
    const item = conflictResolutionItem({
      upstreamChanges: [{ changeId: "chg_upstream", sha: "f".repeat(40) }],
      ontoSha: "f".repeat(40),
      scope: {
        conflictHunks: [{ file: "README.md", startLine: 1, endLine: 1 }],
        touchesOutsideConflictHunks: false,
        novelLines: 1,
      },
      resolutionDiff: "diff --git a/README.md b/README.md\n",
      semanticConflictWith: null,
      rationale: "Kept both.",
      resolver: { model: "m", principalId: "system:resolver", promptVersion: "v" },
      attempts: 1,
    });
    const ev = await evidenceFixture(change.id, resolved);
    await s.putEvidence({ ...ev, items: [...ev.items, item] });
    const audit = new DoAudit(env);
    const subject = `change:${change.id}`;
    await audit.append({
      principalId: "system:merge-queue",
      action: "merge-queue.resolution",
      subject,
      payload: {
        attempt: 1,
        kind: "textual",
        status: "resolved",
        headSha: HEAD_SHA,
        newHead: resolved,
      },
    });
    await audit.append({
      principalId: "system:merge-queue",
      action: "merge-queue.approval-requested",
      subject,
      payload: { lane: 1, reasons: ["merge-queue.resolution-novel-lines"] },
    });
    try {
      const st = await mcp.tools.get_change_status({ changeId: change.id });
      if (st.isError) throw new Error(JSON.stringify(st.content));
      expect(st.structuredContent.resolution).toEqual({
        headSha: resolved,
        originalHeadSha: HEAD_SHA,
        kind: "textual",
        at: expect.any(String),
        files: ["README.md"],
        upstream: [{ changeId: "chg_upstream", title: null }],
        approvalRequested: true,
      });
      expect(st.structuredContent.nextSteps.slice(0, 2)).toEqual([
        expect.objectContaining({
          title: `The merge queue resolved a textual conflict: eeeeeee lands, not your head ${HEAD_SHA.slice(0, 7)}`,
          call: `get_evidence({ changeId: "${change.id}" })`,
        }),
        expect.objectContaining({
          title: "A person must approve the resolution before it lands",
          call: `request_review({ changeId: "${change.id}" })`,
        }),
      ]);
    } finally {
      await mcp.client.close();
    }
  });
});

describe("a person's agents: limited to repos at creation, listed with their owner's membership", () => {
  it("POST /principals/agents takes repoIds (only repos the creator can reach; omitted = all), and GET members lists each member's agents that can act there", async () => {
    const { app, human, agent, repo } = await setup();
    const s = store();
    const other = repoFixture({
      claim: { status: "claimed", ownerId: human.principal.id, expiresAt: null },
    });
    await s.insertRepo(other);
    const create = (body: Record<string, unknown>) =>
      call(app, "POST", "/api/v1/principals/agents", {
        cookie: human.cookie,
        body: { name: "scoped-bot", scopes: ["repo:read"], ...body },
      });

    const limited = await create({ repoIds: [other.id], expiresInDays: 7 });
    expect(limited.status).toBe(201);
    const { principal: scoped } = await json<{
      principal: { id: string; repoIds?: string[] | null };
    }>(limited);
    expect(scoped.repoIds).toEqual([other.id]);

    // A repo the creator can't reach is refused, not silently dropped.
    const stranger = await signUpHuman(app, "Eve");
    const theirs = repoFixture({
      claim: { status: "claimed", ownerId: stranger.principal.id, expiresAt: null },
    });
    await s.insertRepo(theirs);
    const refused = await create({ repoIds: [theirs.id] });
    expect(refused.status).toBe(400);
    expect((await json<{ error: { code: string } }>(refused)).error.code).toBe("invalid-request");

    // Omitted: every repo the creator can reach (the agent from setup() works like that).
    expect(agent.principal.repoIds ?? null).toBeNull();

    const members = async (repoId: string) => {
      const res = await call(app, "GET", `/api/v1/repos/${repoId}/members`, {
        cookie: human.cookie,
      });
      expect(res.status).toBe(200);
      const body = await json<{
        members: { principalId: string; agents: { principalId: string; name: string }[] }[];
      }>(res);
      return body.members.find((m) => m.principalId === human.principal.id)?.agents ?? [];
    };
    expect((await members(repo.id)).map((a) => a.principalId)).toEqual([agent.principal.id]);
    expect((await members(other.id)).map((a) => a.principalId).sort()).toEqual(
      [agent.principal.id, scoped.id].sort(),
    );
  });
});

describe("an agent ends its own session (what `gittifacts logout` calls)", () => {
  it("GET /me names the token's principal; DELETE its tokens with the same bearer revokes them", async () => {
    const { app, human, agent } = await setup();
    const me = await call(app, "GET", "/api/v1/me", { token: agent.token });
    expect(me.status).toBe(200);
    const { principal } = await json<{ principal: { id: string } }>(me);
    expect(principal.id).toBe(agent.principal.id);
    const revoked = await call(app, "DELETE", `/api/v1/principals/${principal.id}/tokens`, {
      token: agent.token,
    });
    expect(revoked.status).toBe(200);
    expect((await json<{ revoked: number }>(revoked)).revoked).toBeGreaterThan(0);
    expect((await call(app, "GET", "/api/v1/me", { token: agent.token })).status).toBe(401);
    // Recorded for the person who owns it.
    const trail = await json<AuditPage>(
      await call(
        app,
        "GET",
        `/api/v1/audit?action=principal.tokens-revoked&actor=${agent.principal.id}`,
        {
          cookie: human.cookie,
        },
      ),
    );
    expect(trail.events.map((e) => e.subject)).toEqual([`principal:${agent.principal.id}`]);
  });
});
