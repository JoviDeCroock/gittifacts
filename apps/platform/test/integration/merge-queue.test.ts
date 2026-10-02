/**
 * The merge queue through the platform (workerd): MCP + HTTP parity on the real MergeQueue DO and
 * a real BatchRunWorkflow. An agent registers enqueue options before review (they wait for the
 * approval), a human approves, the queue tests the batch on main and lands it with CAS, and the
 * agent sees it through wait_for_merge, queue_status, the overview and the SSE events. Freezing
 * is human-only and signed. Fake: Artifacts, containers, CI and the model (./fakes.ts).
 */
import {
  createExecutionContext,
  introspectWorkflow,
  introspectWorkflowInstance,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  changeWorkflowId,
  ciRunIdFor,
  cloudflareBindings,
  createCoordinator,
} from "@app/coordinator";
import { createPlatformClient } from "@app/mcp/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { COORDINATOR_OPTIONS } from "../../src/coordinator.js";
import { buildPorts } from "../../src/runtime/ports.js";
import { call, createAgent, json, ORIGIN, signUpHuman, type TestApp } from "../http.js";
import {
  type IntegrationFakes,
  integrationOverrides,
  NAMESPACE,
  resetIntegrationFakes,
} from "./fakes.js";

function fetchVia(app: TestApp) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(input, init), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
}

function platformApp(): TestApp {
  return createApp({
    coordinator: (e) =>
      createCoordinator(
        buildPorts(e, "default", { overrides: integrationOverrides("default") }),
        cloudflareBindings(e),
        COORDINATOR_OPTIONS,
      ),
  });
}

/** The first `queue` SSE events (reads until `n` arrived). */
async function queueEvents(
  res: Response,
  n: number,
): Promise<{ id: string; data: { type: string } }[]> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const out: { id: string; data: { type: string } }[] = [];
  let buffer = "";
  try {
    while (out.length < n) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const lines = buffer.slice(0, end).split("\n");
        buffer = buffer.slice(end + 2);
        if (lines.includes("event: queue")) {
          const id = lines.find((l) => l.startsWith("id: "))?.slice(4) ?? "";
          const data = lines
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          out.push({ id, data: JSON.parse(data) as { type: string } });
        }
        end = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel();
  }
  return out;
}

let fakes: IntegrationFakes;

beforeEach(() => {
  fakes = resetIntegrationFakes();
});

describe("merge queue over HTTP + MCP (workerd: real MergeQueue DO + BatchRunWorkflow)", () => {
  it("enqueue before review → human approval → batch tested on main → CAS → merged, seen by every API", async () => {
    const app = platformApp();
    const human = await signUpHuman(app);
    const agent = await createAgent(app, human.cookie);
    const other = await createAgent(app, human.cookie);
    const created = await call(app, "POST", "/api/v1/repos", {
      cookie: human.cookie,
      body: { name: `mq-${Date.now().toString(36)}` },
    });
    expect(created.status).toBe(201);
    const { repo } = await json<{ repo: { id: string; artifactsName: string } }>(created);
    const baseSha = fakes.git.seed(repo.artifactsName, {
      "package.json": '{ "name": "mq", "scripts": { "test": "vitest run" } }\n',
      "src/a.ts": "export const a = (x: number) => x + 1;\n",
      "test/a.test.ts": 'import { a } from "../src/a";\n',
    });

    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, { fetch: fetchVia(app) });
    await using batchRuns = await introspectWorkflow(env.BATCH_RUN_WORKFLOW);
    await batchRuns.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    try {
      const started = await mcp.tools.start_change({
        repoId: repo.id,
        title: "Fix a()",
        category: "fix",
      });
      if (started.isError) throw new Error(JSON.stringify(started.content));
      const { change } = started.structuredContent;
      const forkName = `task-${change.id}`;
      const head = fakes.git.commit(forkName, "main", {
        "src/a.ts": "export const a = (x: number) => x + 2;\n",
        "test/a.test.ts": 'import { a } from "../src/a";\n// regression test\n',
      });
      const instanceId = changeWorkflowId(change.id, head);
      await using workflow = await introspectWorkflowInstance(env.CHANGE_WORKFLOW, instanceId);
      await workflow.modify(async (m) => {
        await m.disableSleeps();
        await m.disableRetryDelays();
      });
      await env.PUSH_ROUTER.create({
        id: `push-${head}`,
        params: {
          type: "cf.artifacts.repo.pushed",
          source: { type: "artifacts.repo", namespace: NAMESPACE, repoName: forkName },
          payload: { ref: "refs/heads/main", before: baseSha, after: head },
        },
      });
      await workflow.waitForStepResult({ name: "ci-start" });
      await fakes.ci.finish(env, ciRunIdFor(instanceId));
      await workflow.waitForStepResult({ name: "request-review" });

      // Before review: the options are recorded, the Change is not admitted (routing stays the workflow's).
      const early = await mcp.tools.enqueue({ changeId: change.id, priority: "security" });
      if (early.isError) throw new Error(JSON.stringify(early.content));
      expect(early.structuredContent).toMatchObject({
        admitted: false,
        state: "pending-admission",
      });
      expect(early.structuredContent.reason).toContain("human review");
      // Only the author (or its owner / a reviewer) may change its queue entry.
      const foreign = await call(app, "POST", `/api/v1/changes/${change.id}/queue`, {
        token: other.token,
        body: {},
      });
      expect(foreign.status).toBe(403);

      // A human approves: the ChangeWorkflow admits it; the DO builds refs/queue/<batch> and a
      // BatchRunWorkflow runs CI on that commit in the main repo.
      const review = await call(app, "POST", `/api/v1/changes/${change.id}/review`, {
        cookie: human.cookie,
        body: { decision: "approve" },
      });
      expect(review.status).toBe(200);
      const queueRun = await vi.waitFor(
        () => {
          const id = [...fakes.ci.runs.keys()].find((k) => k.startsWith("mq-"));
          if (id === undefined) throw new Error("no queue run yet");
          return id;
        },
        { timeout: 20_000, interval: 50 },
      );
      expect(fakes.ci.runs.get(queueRun)?.request).toMatchObject({
        artifactsRepo: repo.artifactsName,
        headSha: head,
        evidenceSteps: [],
      });
      const status = await call(app, "GET", `/api/v1/changes/${change.id}/queue`, {
        token: agent.token,
      });
      const { status: entry } = await json<{ status: { state: string; priority: string } | null }>(
        status,
      );
      expect(entry).toMatchObject({ state: "speculating", priority: "security" });

      await fakes.ci.finish(env, queueRun);
      const merged = await mcp.tools.wait_for_merge({ changeId: change.id, timeoutSec: 30 });
      if (merged.isError) throw new Error(JSON.stringify(merged.content));
      expect(merged.structuredContent).toMatchObject({ reason: "merged", frozen: false });
      expect(fakes.git.head(repo.artifactsName)).toBe(head);
      await workflow.waitForStatus("complete");

      const wait = await call(app, "GET", `/api/v1/changes/${change.id}/queue/wait?timeoutSec=1`, {
        token: agent.token,
      });
      expect(await json(wait)).toMatchObject({ reason: "merged" });
      const overview = await call(app, "GET", `/api/v1/repos/${repo.id}/queue`, {
        token: agent.token,
      });
      const o = await json<{
        entries: { changeId: string; state: string }[];
        throughputPerHour: number;
      }>(overview);
      expect(o.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ changeId: change.id, state: "merged" })]),
      );
      expect(o.throughputPerHour).toBe(1);
      const sse = await call(app, "GET", `/api/v1/repos/${repo.id}/queue/events?since=0`, {
        token: agent.token,
      });
      const events = await queueEvents(sse, 2);
      expect(events.map((e) => e.data.type)).toEqual(["entered_batch", "merged"]);
      // refs/queue/* are garbage-collected once the batch landed.
      await vi.waitFor(() => {
        const refs = [...fakes.git.repo(repo.artifactsName).refs.keys()].filter((r) =>
          r.startsWith("refs/queue/"),
        );
        expect(refs).toEqual([]);
      });

      // Freezing is human-only and signed.
      const agentFreeze = await call(app, "POST", `/api/v1/repos/${repo.id}/queue/freeze`, {
        token: agent.token,
        body: { reason: "incident" },
      });
      expect(agentFreeze.status).toBe(403);
      const freeze = await call(app, "POST", `/api/v1/repos/${repo.id}/queue/freeze`, {
        cookie: human.cookie,
        body: { reason: "incident: payments are down" },
      });
      expect(await json(freeze)).toEqual({ frozen: true });
    } finally {
      await mcp.client.close();
    }
  });
});
