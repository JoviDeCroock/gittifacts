/**
 * The agent's side over MCP (the transport agents actually use), against the served Worker: the
 * tool list, whoami, a Change's status and evidence, and wait_for_change returning at once for a
 * state already reached. The Change itself came through the real pipeline (lib/world.ts).
 */
import { createPlatformClient } from "@app/mcp/client";
import { expect, test } from "../../lib/fixtures.js";

test("MCP: an agent reads its Change's status, evidence and walkthrough", async ({ baseURL, agentWork }) => {
  const mcp = await createPlatformClient(`${baseURL}/mcp`, agentWork.agentToken);
  try {
    const tools = await mcp.client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const tool of ["create_project", "start_change", "wait_for_change", "get_change_status", "get_evidence"]) {
      expect(names).toContain(tool);
    }
    const status = await mcp.tools.get_change_status({ changeId: agentWork.changeId });
    if (status.isError) throw new Error(JSON.stringify(status.content));
    expect(status.structuredContent.change).toMatchObject({ id: agentWork.changeId, status: "awaiting-review" });
    expect(status.structuredContent.classification?.lane).toBeGreaterThanOrEqual(1);

    const waited = await mcp.tools.wait_for_change({ changeId: agentWork.changeId, until: "evidence_ready", timeoutSec: 5 });
    if (waited.isError) throw new Error(JSON.stringify(waited.content));
    expect(waited.structuredContent).toMatchObject({ reached: true });

    const evidence = await mcp.tools.get_evidence({ changeId: agentWork.changeId });
    if (evidence.isError) throw new Error(JSON.stringify(evidence.content));
    expect(evidence.structuredContent.verification).toMatchObject({ ok: true });
  } finally {
    await mcp.client.close();
  }
});

test("an agent can never approve: the review route refuses agent tokens", async ({ request, baseURL, agentWork }) => {
  const res = await request.post(`${baseURL}/api/v1/changes/${agentWork.changeId}/review`, {
    headers: { authorization: `Bearer ${agentWork.agentToken}`, origin: baseURL as string, "idempotency-key": `e2e-${Date.now()}` },
    data: { decision: "approve", headSha: agentWork.head },
  });
  expect([401, 403]).toContain(res.status());
});
