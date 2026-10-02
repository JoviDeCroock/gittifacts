/** Contract additions requested by the web UI (docs/api.md "Additions"). */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { summarizeAudit } from "../src/audit/summary.js";
import { addMember, HEAD_SHA, runFixture, seedWorld, store, uid } from "./fixtures.js";
import { call, createAgent, expectError, json, makeApp, signUpHuman } from "./http.js";

async function world() {
  const { app } = makeApp();
  const human = await signUpHuman(app, "Owner");
  const agent = await createAgent(app, human.cookie);
  const s = store();
  const seeded = await seedWorld(s);
  await addMember(s, seeded.repo.id, human.principal.id, "owner");
  return {
    app,
    human,
    agent,
    s,
    repo: seeded.repo,
    change: seeded.change,
    seedHuman: seeded.human,
  };
}

describe("GET /api/v1/principals/:id", () => {
  it("returns a principal with its owner's name", async () => {
    const { app, human, agent } = await world();
    const res = await json<{ principal: { id: string; kind: string; ownerName?: string } }>(
      await call(app, "GET", `/api/v1/principals/${agent.principal.id}`, { cookie: human.cookie }),
    );
    expect(res.principal).toMatchObject({
      id: agent.principal.id,
      kind: "agent",
      ownerName: "Owner",
    });
    await expectError(
      await call(app, "GET", "/api/v1/principals/nobody", { cookie: human.cookie }),
      404,
      "not-found",
    );
  });
});

describe("GET /api/v1/changes/:id/reviews", () => {
  it("lists reviews with reviewer names", async () => {
    const { app, agent, s, change, seedHuman } = await world();
    await s.putReview({
      id: uid("rev"),
      changeId: change.id,
      headSha: HEAD_SHA,
      reviewerId: seedHuman,
      decision: "request-changes",
      humanLane: 2,
      computedLane: 1,
      comment: "needs a test",
      createdAt: new Date().toISOString(),
    });
    const res = await json<{
      reviews: { decision: string; reviewerId: string }[];
      principals: Record<string, { name: string }>;
    }>(await call(app, "GET", `/api/v1/changes/${change.id}/reviews`, { token: agent.token }));
    expect(res.reviews).toHaveLength(1);
    expect(res.reviews[0]).toMatchObject({ decision: "request-changes", reviewerId: seedHuman });
    expect(res.principals[seedHuman]?.name).toBe("Ada");
  });
});

describe("GET /api/v1/blobs/:ref", () => {
  it("serves a CI log of a run the caller's repo owns, inertly", async () => {
    const { app, agent, s, change } = await world();
    const run = runFixture(change.id);
    await s.upsertRun(run);
    const ref = `ci-logs/${run.id}/test.log`;
    await env.BLOBS.put(ref, "ok 12 tests\n");
    const res = await call(app, "GET", `/api/v1/blobs/${encodeURIComponent(ref)}`, {
      token: agent.token,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res.text()).toBe("ok 12 tests\n");

    // Unencoded slashes work too.
    const raw = await call(app, "GET", `/api/v1/blobs/${ref}`, { token: agent.token });
    expect(await raw.text()).toBe("ok 12 tests\n");
  });

  it("never serves HTML as HTML, and 404s unattributable or unknown refs", async () => {
    const { app, agent, change } = await world();
    const html = `screenshots/${change.id}/evil.html`;
    await env.BLOBS.put(html, "<script>alert(1)</script>", {
      httpMetadata: { contentType: "text/html" },
    });
    const res = await call(app, "GET", `/api/v1/blobs/${encodeURIComponent(html)}`, {
      token: agent.token,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    await res.arrayBuffer();

    await env.BLOBS.put("misc/orphan.txt", "who owns me?");
    await expectError(
      await call(app, "GET", `/api/v1/blobs/${encodeURIComponent("misc/orphan.txt")}`, {
        token: agent.token,
      }),
      404,
      "not-found",
    );
    await expectError(
      await call(app, "GET", `/api/v1/blobs/${encodeURIComponent(`ci-logs/${uid("run")}/x.log`)}`, {
        token: agent.token,
      }),
      404,
      "not-found",
    );
    await expectError(
      await call(app, "GET", `/api/v1/blobs/${encodeURIComponent("../etc/passwd")}`, {
        token: agent.token,
      }),
      400,
      "invalid-request",
    );
  });

  it("requires authentication", async () => {
    const { app } = await world();
    await expectError(await call(app, "GET", "/api/v1/blobs/ci-logs/x/y.log"), 401, "unauthorized");
  });
});

describe("audit summaries and principal names", () => {
  it("adds a readable summary and a principals map to audit pages", async () => {
    const { app, human, agent } = await world();
    const page = await json<{
      events: { action: string; summary: string; principalId: string }[];
      principals: Record<string, { name: string; kind: string }>;
    }>(
      await call(app, "GET", `/api/v1/audit?subject=principal:${agent.principal.id}`, {
        cookie: human.cookie,
      }),
    );
    expect(page.events[0]).toMatchObject({
      action: "principal.agent-created",
      summary: 'Agent "builder-bot" registered with repo:read, plan:create, change:create',
    });
    expect(page.principals[human.principal.id]).toMatchObject({ name: "Owner", kind: "human" });
  });

  it("summarizes known actions, honors payload.summary, humanizes the rest", () => {
    const ev = (action: string) => ({ action, subject: "change:c1" });
    expect(summarizeAudit(ev("rollout.stage"), { percent: 25 })).toBe("Stage 25% started");
    expect(
      summarizeAudit(ev("rollout.regression"), { errorRate: 0.031, maxErrorRateIncrease: 0.01 }),
    ).toBe("Error rate 3.1% exceeded the 1.0% limit");
    expect(summarizeAudit(ev("anything"), { summary: "Custom line" })).toBe("Custom line");
    expect(summarizeAudit(ev("merge-queue.conflict"), { reason: "main moved" })).toBe(
      "Merge queue conflict: main moved",
    );
    expect(summarizeAudit(ev("plan.approved"), null)).toBe("Plan approved");
  });
});
