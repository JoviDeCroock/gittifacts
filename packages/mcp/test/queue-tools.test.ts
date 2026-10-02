/** Merge-queue tools and search_tools (src/tools/queue.ts). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlatformClient, type PlatformClient } from "../src/client.js";
import { parseToolError, searchTools } from "../src/index.js";
import { fakeBackend, queueEntry } from "./support/fake-backend.js";
import { bearerFor, serveMcp } from "./support/http-server.js";

const ejected = queueEntry({
  changeId: "chg_2",
  state: "ejected",
  ejectReason: {
    code: "tests-failed",
    message: "fails __run__ on the queue's tree (reproduced; not a flake)",
    fix: { explanation: "Fix it on top of main.", call: 'open_workspace({ changeId: "chg_2" })' },
    evidenceRefs: [],
    failingTests: ["__run__"],
    upstream: ["chg_1"],
  },
});
const backend = fakeBackend({
  async queueStatus(_caller, changeId) {
    return changeId === "chg_2" ? ejected : null;
  },
});
let server: Awaited<ReturnType<typeof serveMcp>>;
let mcp: PlatformClient;
let readOnly: PlatformClient;

beforeAll(async () => {
  server = await serveMcp(backend);
  mcp = await createPlatformClient(server.url, bearerFor("ag_1"));
  readOnly = await createPlatformClient(server.url, bearerFor("ag_ro", ["repo:read"]));
});

afterAll(async () => {
  await mcp.client.close();
  await readOnly.client.close();
  await server.close();
});

describe("merge queue tools", () => {
  it("enqueue returns position, track, ETA and the predicted pass probability", async () => {
    const r = await mcp.tools.enqueue({
      changeId: "chg_1",
      priority: "security",
      idempotencyKey: "k1",
    });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    expect(r.structuredContent).toMatchObject({
      changeId: "chg_1",
      admitted: true,
      position: 0,
      etaSeconds: 720,
      predictedPassProbability: 0.96,
    });
    expect(r.structuredContent.nextSteps[0]?.call).toBe('wait_for_merge({ changeId: "chg_1" })');
    expect(backend.calls).toContain("enqueue:chg_1:security:k1");
  });

  it("queue_status of an ejected Change hands the agent the fix call and the upstream culprit", async () => {
    const r = await mcp.tools.queue_status({ changeId: "chg_2" });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    expect(r.structuredContent.status?.ejectReason?.fix.call).toBe(
      'open_workspace({ changeId: "chg_2" })',
    );
    expect(r.structuredContent.status?.ejectReason?.upstream).toEqual(["chg_1"]);
    expect(r.structuredContent.nextSteps[0]?.call).toBe('open_workspace({ changeId: "chg_2" })');
    const none = await mcp.tools.queue_status({ changeId: "chg_9" });
    expect(none.isError).toBeFalsy();
    expect(!none.isError && none.structuredContent.queued).toBe(false);
  });

  it("wait_for_merge long-polls (≤ 55 s) and reports the outcome", async () => {
    const r = await mcp.tools.wait_for_merge({ changeId: "chg_1", timeoutSec: 30 });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    expect(r.structuredContent).toMatchObject({ reason: "merged", frozen: false });
    expect(backend.calls).toContain("waitForMerge:chg_1:30000");
    const tooLong = await mcp.tools.wait_for_merge({ changeId: "chg_1", timeoutSec: 600 } as never);
    expect(tooLong.isError).toBe(true);
  });

  it("a read-only agent can watch the queue but not enqueue, dequeue or reprioritize", async () => {
    expect((await readOnly.tools.queue_overview({ repoId: "repo_1" })).isError).toBeFalsy();
    for (const r of [
      await readOnly.tools.enqueue({ changeId: "chg_1" }),
      await readOnly.tools.dequeue({ changeId: "chg_1" }),
      await readOnly.tools.reprioritize({ changeId: "chg_1", priority: "incident" }),
    ]) {
      const content = r.content as { type: string; text: string }[];
      expect(parseToolError(content[0]?.text ?? "")?.error.code).toBe("insufficient-scope");
    }
  });

  it("search_tools finds tools by name and description, with an example call", async () => {
    const r = await mcp.tools.search_tools({ query: "merge my change" });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    const names = r.structuredContent.tools.map((t) => t.name);
    expect(names).toContain("wait_for_merge");
    expect(names).toContain("enqueue");
    const ws = await mcp.tools.search_tools({ query: "run a shell command in a sandbox" });
    expect(!ws.isError && ws.structuredContent.tools[0]?.name).toBe("ws_exec");
    expect(!ws.isError && ws.structuredContent.tools[0]?.example).toContain("ws_exec({");
    expect(
      searchTools("wfm", [{ name: "wait_for_merge", description: "x", example: "" }]),
    ).toHaveLength(1);
  });
});
