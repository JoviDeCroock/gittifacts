/**
 * The agent's side over MCP (the transport agents actually use), against the served Worker: the
 * tool list, whoami, a Change's status and evidence, and wait_for_change returning at once for a
 * state already reached. The Change itself came through the real pipeline (lib/world.ts).
 */
import { createPlatformClient } from "@app/mcp/client";
import { expect, test } from "../../lib/fixtures.js";

test("MCP: an agent reads its Change's status, evidence and walkthrough", async ({
  baseURL,
  agentWork,
}) => {
  const mcp = await createPlatformClient(`${baseURL}/mcp`, agentWork.agentToken);
  try {
    const tools = await mcp.client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const tool of [
      "create_project",
      "start_change",
      "wait_for_change",
      "get_change_status",
      "get_evidence",
    ]) {
      expect(names).toContain(tool);
    }
    const status = await mcp.tools.get_change_status({ changeId: agentWork.changeId });
    if (status.isError) throw new Error(JSON.stringify(status.content));
    expect(status.structuredContent.change).toMatchObject({
      id: agentWork.changeId,
      status: "awaiting-review",
    });
    expect(status.structuredContent.classification?.lane).toBeGreaterThanOrEqual(1);

    const waited = await mcp.tools.wait_for_change({
      changeId: agentWork.changeId,
      until: "evidence_ready",
      timeoutSec: 5,
    });
    if (waited.isError) throw new Error(JSON.stringify(waited.content));
    expect(waited.structuredContent).toMatchObject({ reached: true });

    const evidence = await mcp.tools.get_evidence({ changeId: agentWork.changeId });
    if (evidence.isError) throw new Error(JSON.stringify(evidence.content));
    expect(evidence.structuredContent.verification).toMatchObject({ ok: true });
  } finally {
    await mcp.client.close();
  }
});

test("an agent can never approve: the review route refuses agent tokens", async ({
  request,
  baseURL,
  agentWork,
}) => {
  const res = await request.post(`${baseURL}/api/v1/changes/${agentWork.changeId}/review`, {
    headers: {
      authorization: `Bearer ${agentWork.agentToken}`,
      origin: baseURL as string,
      "idempotency-key": `e2e-${Date.now()}`,
    },
    data: { decision: "approve", headSha: agentWork.head },
  });
  expect([401, 403]).toContain(res.status());
});

test("MCP: the agent knows who answers for it, asks for a review honestly and reads its own audit trail", async ({
  request,
  baseURL,
  human,
  agentWork,
}) => {
  const mcp = await createPlatformClient(`${baseURL}/mcp`, agentWork.agentToken);
  try {
    const me = await mcp.tools.whoami();
    if (me.isError) throw new Error(JSON.stringify(me.content));
    expect(me.structuredContent).toMatchObject({
      ownerName: human.name,
      agentsUrl: `${baseURL}/agents`,
    });
    const agentId = me.structuredContent.principalId;

    const status = await mcp.tools.get_change_status({ changeId: agentWork.changeId });
    if (status.isError) throw new Error(JSON.stringify(status.content));
    expect(status.structuredContent.author).toMatchObject({
      id: agentId,
      kind: "agent",
      ownerName: human.name,
    });
    expect(status.structuredContent.resolution).toBeNull();

    // Nobody is messaged: the output says the request is recorded and the first step is the hand-off.
    const asked = await mcp.tools.request_review({ changeId: agentWork.changeId });
    if (asked.isError) throw new Error(JSON.stringify(asked.content));
    expect(asked.structuredContent.requested).toBe(true);
    expect(asked.structuredContent).not.toHaveProperty("notified");
    expect(asked.structuredContent.nextSteps[0]?.title).toContain(
      `${baseURL}/changes/${agentWork.changeId}`,
    );

    const trail = await mcp.tools.list_audit_events({
      actor: agentId,
      action: "change.review-requested",
    });
    if (trail.isError) throw new Error(JSON.stringify(trail.content));
    expect(trail.structuredContent.chain.verified).toBe(true);
    expect(trail.structuredContent.events[0]).toMatchObject({
      subject: `change:${agentWork.changeId}`,
      actor: { id: agentId, ownerName: human.name },
    });

    // Not merged yet: no rollout, and the page to hand a person.
    const rollout = await mcp.tools.get_rollout({ changeId: agentWork.changeId });
    if (rollout.isError) throw new Error(JSON.stringify(rollout.content));
    expect(rollout.structuredContent).toMatchObject({
      rollout: null,
      url: `${baseURL}/changes/${agentWork.changeId}/rollout`,
    });

    // The person sees the same trail over HTTP: the agent named with its owner, the subject by title.
    const res = await request.get(`${baseURL}/api/v1/audit?actor=${agentId}`, {
      headers: { cookie: human.cookie },
    });
    expect(res.status()).toBe(200);
    const page = (await res.json()) as {
      events: { principalId: string }[];
      principals: Record<string, { ownerName: string | null }>;
      subjects: Record<string, { title: string; repoId: string | null }>;
    };
    expect(page.events.every((e) => e.principalId === agentId)).toBe(true);
    expect(page.principals[agentId]?.ownerName).toBe(human.name);
    expect(page.subjects[`change:${agentWork.changeId}`]).toMatchObject({
      repoId: agentWork.repoId,
    });
  } finally {
    await mcp.client.close();
  }
});
