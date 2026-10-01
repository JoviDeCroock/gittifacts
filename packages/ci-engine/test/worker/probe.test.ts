import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("runs a workflow calling a DO", async () => {
  const e = env as unknown as { PROBE_WF: Workflow<{ x: number }>; CI_BUCKET: R2Bucket };
  await using inst = await introspectWorkflowInstance(e.PROBE_WF, "p1");
  await e.PROBE_WF.create({ id: "p1", params: { x: 2 } });
  await inst.waitForStatus("complete");
  expect(await inst.getOutput()).toEqual({ sum: 10 });
  expect(await (await e.CI_BUCKET.get("k"))?.text()).toBe("10");
  const h = await e.PROBE_WF.get("p1");
  expect((await h.status()).status).toBe("complete");
});
