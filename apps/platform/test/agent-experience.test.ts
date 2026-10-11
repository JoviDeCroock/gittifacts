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
import { changeFixture, classificationFixture, HEAD_SHA, repoFixture, store } from "./fixtures.js";
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
  principals: Record<string, { name: string; kind: string; ownerId: string | null; ownerName: string | null }>;
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

    const byHuman = await page(`actor=${human.principal.id}`);
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
          { percent: 5, startedAt: "2026-10-01T00:10:00.000Z", completedAt: "2026-10-01T00:20:00.000Z" },
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
