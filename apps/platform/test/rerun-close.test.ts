/**
 * rerun_ci / close_change over HTTP and MCP: the routes forward the caller and the reason to the
 * coordinator (which checks author-or-maintainer and audits), honour Idempotency-Key, and hide
 * changes from strangers. get_change_status carries the preview URL from the head's evidence.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CoordinatorApi } from "@app/coordinator";
import type { Change } from "@app/domain";
import { createPlatformClient } from "@app/mcp/client";
import { describe, expect, it, vi } from "vitest";
import { addMember, changeFixture, evidenceFixture, HEAD_SHA, seedWorld, store } from "./fixtures.js";
import {
  call,
  createAgent,
  expectError,
  json,
  makeApp,
  ORIGIN,
  signUpHuman,
  type TestApp,
} from "./http.js";

function fetchVia(app: TestApp) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(input, init), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
}

async function world() {
  const rerun = vi.fn<CoordinatorApi["rerun"]>(async (_actor, changeId) => {
    const change = (await store().getChange(changeId)) as Change;
    return {
      change: { ...change, status: "running" },
      headSha: change.headSha ?? HEAD_SHA,
      instanceId: `wf-${changeId}-r1`,
      superseded: `wf-${changeId}`,
    };
  });
  const abandon = vi.fn<CoordinatorApi["abandon"]>(async (_actor, changeId) => {
    const change = (await store().getChange(changeId)) as Change;
    return { ...change, status: "abandoned" };
  });
  const { app } = makeApp({ rerun, abandon });
  const human = await signUpHuman(app);
  const agent = await createAgent(app, human.cookie);
  const s = store();
  const seeded = await seedWorld(s);
  await addMember(s, seeded.repo.id, human.principal.id, "owner");
  const mine = changeFixture(seeded.repo.id, agent.principal.id, { status: "failing" });
  await s.insertChange(mine);
  return { app, human, agent, s, repo: seeded.repo, mine, rerun, abandon };
}

describe("POST /api/v1/changes/{id}/rerun and /close", () => {
  it("forward the caller and reason; a retried key does not act twice", async () => {
    const { app, agent, mine, rerun, abandon } = await world();
    const headers = { "idempotency-key": "rerun-1" };
    const first = await call(app, "POST", `/api/v1/changes/${mine.id}/rerun`, {
      token: agent.token,
      headers,
      body: { reason: "flaky" },
    });
    expect(first.status).toBe(202);
    expect(await json(first)).toMatchObject({
      change: { id: mine.id, status: "running" },
      instanceId: `wf-${mine.id}-r1`,
    });
    const again = await call(app, "POST", `/api/v1/changes/${mine.id}/rerun`, {
      token: agent.token,
      headers,
      body: { reason: "flaky" },
    });
    expect(again.status).toBe(202);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(rerun.mock.calls[0]?.[0].id).toBe(agent.principal.id);
    expect(rerun.mock.calls[0]?.[2]).toBe("flaky");

    const closed = await call(app, "POST", `/api/v1/changes/${mine.id}/close`, {
      token: agent.token,
      body: { reason: "superseded" },
    });
    expect(closed.status).toBe(200);
    expect(await json(closed)).toMatchObject({ change: { status: "abandoned" } });
    expect(abandon.mock.calls[0]?.[2]).toBe("superseded");
  });

  it("a stranger gets not-found and never reaches the coordinator", async () => {
    const { app, mine, rerun, abandon } = await world();
    const stranger = await signUpHuman(app, "Mallory");
    for (const path of ["rerun", "close"]) {
      await expectError(
        await call(app, "POST", `/api/v1/changes/${mine.id}/${path}`, {
          cookie: stranger.cookie,
          body: {},
        }),
        404,
        "not-found",
      );
    }
    expect(rerun).not.toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
  });
});

describe("MCP rerun_ci, close_change and get_change_status.previewUrl", () => {
  it("reach the coordinator as the agent; the status carries the evidence's preview", async () => {
    const { app, agent, s, mine, rerun, abandon } = await world();
    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, { fetch: fetchVia(app) });
    try {
      const r = await mcp.tools.rerun_ci({ changeId: mine.id, reason: "flaky" });
      if (r.isError) throw new Error(JSON.stringify(r.content));
      expect(r.structuredContent.change.status).toBe("running");
      expect(rerun).toHaveBeenCalledTimes(1);
      const c = await mcp.tools.close_change({ changeId: mine.id, idempotencyKey: "close-1" });
      if (c.isError) throw new Error(JSON.stringify(c.content));
      expect(c.structuredContent.change.status).toBe("abandoned");
      expect(abandon).toHaveBeenCalledTimes(1);

      const none = await mcp.tools.get_change_status({ changeId: mine.id });
      if (none.isError) throw new Error(JSON.stringify(none.content));
      expect(none.structuredContent.previewUrl).toBeNull();
      const ev = await evidenceFixture(mine.id);
      const url = "https://p-preview.example.dev";
      await s.putEvidence({
        ...ev,
        items: [...ev.items, { id: "preview", kind: "preview", status: "ok", url }],
      });
      await s.updateChange(mine.id, { evidenceId: ev.id });
      const withPreview = await mcp.tools.get_change_status({ changeId: mine.id });
      if (withPreview.isError) throw new Error(JSON.stringify(withPreview.content));
      expect(withPreview.structuredContent.previewUrl).toBe(url);
    } finally {
      await mcp.client.close();
    }
  });
});
