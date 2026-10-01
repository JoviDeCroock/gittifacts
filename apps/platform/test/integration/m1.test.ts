/**
 * M1 vertical slice, locally: repo → start_change (MCP) → push event → PushRouter → ChangeCoordinator
 * DO → ChangeWorkflow → CI (reported like CiRunWorkflow) → evidence → classification → MCP status,
 * wait_for_change, SSE and the CI log behind the run's logRef.
 *
 * Real: the Hono app and MCP server, better-auth + agent tokens, D1Store, the AuditLog DO, the
 * platform signing key, the coordinator facade, the ChangeCoordinator (platform subclass) and
 * MergeQueue DOs, the PushRouter and ChangeWorkflow Workflows. Fake: see ./fakes.ts.
 */
import {
  createExecutionContext,
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
import type { Change, PipelineRun } from "@app/domain";
import { createPlatformClient } from "@app/mcp/client";
import { beforeEach, describe, expect, it } from "vitest";
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

/** The app with the real coordinator facade over the same Ports the DOs and Workflows get. */
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

/** Reads SSE frames until one named `event` arrives. */
async function firstEvent(
  res: Response,
  event: string,
): Promise<{ id: string | null; data: unknown }> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`stream ended before a "${event}" event`);
      buffer += value;
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = frame.split("\n");
        if (lines.includes(`event: ${event}`)) {
          const id = lines.find((l) => l.startsWith("id: "))?.slice(4) ?? null;
          const data = lines
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          return { id, data: JSON.parse(data) as unknown };
        }
        end = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel();
  }
}

let fakes: IntegrationFakes;

beforeEach(() => {
  fakes = resetIntegrationFakes();
});

describe("M1 vertical slice (workerd, real platform + coordinator, fake Artifacts/containers/model)", () => {
  it("an agent starts a change over MCP, pushes, and gets test results, evidence and a lane", async () => {
    const app = platformApp();
    const human = await signUpHuman(app);
    const agent = await createAgent(app, human.cookie);

    // 1. A human creates the repo (Artifacts create); its first commit lands like a template's.
    const name = `m1-${Date.now().toString(36)}`;
    const created = await call(app, "POST", "/api/v1/repos", {
      cookie: human.cookie,
      body: { name },
    });
    expect(created.status).toBe(201);
    const { repo } = await json<{ repo: { id: string; artifactsName: string; namespace: string } }>(
      created,
    );
    expect(repo.namespace).toBe(NAMESPACE);
    const baseSha = fakes.git.seed(repo.artifactsName, {
      "package.json": '{ "name": "m1", "scripts": { "test": "vitest run" } }\n',
      "src/a.ts": "export const a = (x: number) => x + 1;\n",
      "test/a.test.ts": 'import { a } from "../src/a";\n',
    });

    // 2. The agent starts a change over MCP and gets a push grant for its fork only.
    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, { fetch: fetchVia(app) });
    try {
      const started = await mcp.tools.start_change({
        repoId: repo.id,
        title: "Fix the off-by-one in a()",
        category: "fix",
      });
      if (started.isError) throw new Error(JSON.stringify(started.content));
      const { change, remote } = started.structuredContent;
      expect(change).toMatchObject({ status: "awaiting-push" });
      expect(remote.url).toContain(`task-${change.id}`);
      expect(remote.token.length).toBeGreaterThan(0);
      const forkName = `task-${change.id}`;
      expect(fakes.git.tokens.at(-1)).toMatchObject({ repo: forkName, scope: "write" });

      // 3. The agent pushes one commit to its fork; Artifacts emits cf.artifacts.repo.pushed.
      const head = fakes.git.commit(forkName, "main", {
        "src/a.ts": "export const a = (x: number) => x + 2;\n",
        "test/a.test.ts": 'import { a } from "../src/a";\n// adds a regression test\n',
      });
      const instanceId = changeWorkflowId(change.id, head);
      const runId = ciRunIdFor(instanceId);
      await using workflow = await introspectWorkflowInstance(env.CHANGE_WORKFLOW, instanceId);
      await workflow.modify(async (m) => {
        await m.disableSleeps();
        await m.disableRetryDelays();
      });
      await using router = await introspectWorkflowInstance(env.PUSH_ROUTER, `push-${head}`);
      await env.PUSH_ROUTER.create({
        id: `push-${head}`,
        params: {
          type: "cf.artifacts.repo.pushed",
          source: { type: "artifacts.repo", namespace: NAMESPACE, repoName: forkName },
          payload: { ref: "refs/heads/main", before: baseSha, after: head },
        },
      });
      await router.waitForStatus("complete");
      expect(await router.getOutput()).toEqual({ routed: true, reason: null });

      // 4. The ChangeWorkflow plans and starts CI for this head (run id = PipelineRun.id).
      await workflow.waitForStepResult({ name: "ci-start" });
      expect(fakes.ci.runs.get(runId)?.request).toMatchObject({
        changeId: change.id,
        artifactsRepo: forkName,
        headSha: head,
        baseSha,
        pipelineFrom: "base",
      });

      // An agent long-polls for the lane while CI is still running.
      const waiting = mcp.tools.wait_for_change({
        changeId: change.id,
        until: "lane_assigned",
        timeoutSec: 120,
      });

      // 5. CI finishes green and reports through the ChangeCoordinator DO (the run sink).
      const sink = await fakes.ci.finish(env, runId);
      expect(sink).toMatchObject({ accepted: true, forwarded: true });
      await workflow.waitForStepResult({ name: "classify" });

      const waited = await waiting;
      if (waited.isError) throw new Error(JSON.stringify(waited.content));
      expect(waited.structuredContent).toMatchObject({ reached: true, reason: "reached" });
      expect(waited.structuredContent.change.lane).not.toBeNull();

      // 6. get_change_status over MCP: the run's steps (test results) and the lane with reasons.
      await workflow.waitForStepResult({ name: "request-review" });
      const status = await mcp.tools.get_change_status({ changeId: change.id });
      if (status.isError) throw new Error(JSON.stringify(status.content));
      const s = status.structuredContent;
      expect(s.change).toMatchObject({ id: change.id, headSha: head, status: "awaiting-review" });
      const run = s.runs.find((r) => r.id === runId);
      expect(run).toMatchObject({ headSha: head, status: "passed" });
      expect(run?.steps).toEqual(
        expect.arrayContaining([
          { name: "test", kind: "user", status: "passed", logRef: `ci-logs/${runId}/test.log` },
          expect.objectContaining({
            name: "evidence:red-green",
            kind: "evidence",
            status: "passed",
          }),
        ]),
      );
      expect(s.classification).not.toBeNull();
      expect(s.classification?.lane).toBe(s.change.lane);
      // Planless: Lane 0 needs an approved plan, so this lands in Lane 1 with a reason saying so.
      expect(s.classification?.lane).toBeGreaterThanOrEqual(1);
      expect(s.classification?.reasons.length).toBeGreaterThan(0);

      // The classification is stored per head; the change row carries the lane.
      const stored: Change | null = await buildPorts(env, "default").store.getChange(change.id);
      expect(stored).toMatchObject({ lane: s.change.lane, evidenceId: expect.any(String) });

      // 7. Evidence over MCP: signed by the platform key, the test run among the items.
      const evidence = await mcp.tools.get_evidence({ changeId: change.id });
      if (evidence.isError) throw new Error(JSON.stringify(evidence.content));
      expect(evidence.structuredContent.verification).toMatchObject({ ok: true });
      expect(JSON.stringify(evidence.structuredContent)).toContain("test-run");

      // 8. The run's logRef resolves through the blob route (CI_BUCKET and BLOBS share the bucket).
      const logRes = await call(app, "GET", `/api/v1/blobs/ci-logs/${runId}/test.log`, {
        token: agent.token,
      });
      expect(logRes.status).toBe(200);
      expect(await logRes.text()).toContain("12 passed");

      // 9. SSE: the change as a stream; the event id is the version to resume from.
      const sse = await call(app, "GET", `/api/v1/changes/${change.id}/events`, {
        token: agent.token,
      });
      expect(sse.status).toBe(200);
      expect(sse.headers.get("content-type")).toContain("text/event-stream");
      const first = await firstEvent(sse, "change");
      expect(first.id).toMatch(/^[0-9a-f]{16}$/);
      expect(first.data).toMatchObject({ change: { id: change.id, status: "awaiting-review" } });

      // 10. The audit timeline reads as a story (coordinator actions carry summaries).
      const rollout = await call(app, "GET", `/api/v1/changes/${change.id}/rollout`, {
        token: agent.token,
      });
      expect(rollout.status).toBe(200);
      const { timeline } = await json<{ timeline: Array<{ action: string; summary: string }> }>(
        rollout,
      );
      const summaries = Object.fromEntries(timeline.map((e) => [e.action, e.summary]));
      expect(summaries).toMatchObject({
        "change.started": "Change started",
        "change.pushed": `Pushed ${head.slice(0, 7)}`,
        "change.ci-passed": "CI passed",
        "change.classified": `Routed to Lane ${s.change.lane}`,
      });

      // Only the fork was written; the main repo's branch is untouched.
      expect(fakes.git.writes.every((w) => w.repo === forkName)).toBe(true);
      expect(await fakes.git.branchHead(repo.artifactsName, "main")).toBe(baseSha);
    } finally {
      await mcp.client.close();
    }
  });

  it("the run sink maps the engine's artifacts.bundle onto the change workflow's bundleRef", async () => {
    const { withBundleRef } = await import("../../src/runtime/change-coordinator.js");
    const key = "ci-artifacts/run-x/build/bundle.tgz";
    const summary = {
      id: "run-x",
      artifacts: { bundle: { key, bytes: 1, sha256: "0".repeat(64) } },
    };
    expect(withBundleRef(summary)).toMatchObject({ outputs: { bundleRef: key } });
    expect(withBundleRef({ ...summary, outputs: { bundleRef: "kept" } })).toMatchObject({
      outputs: { bundleRef: "kept" },
    });
    expect(withBundleRef({ id: "run-y" })).toEqual({ id: "run-y" });
  });

  it("the Workers Issues webhook forwards to the real coordinator", async () => {
    const app = platformApp();
    const res = await call(app, "POST", "/webhooks/workers-issues", {
      headers: { "cf-webhook-auth": "test-issues-webhook-secret" },
      body: {
        name: "Workers Issues",
        text: "TypeError in fetch",
        ts: 1_790_000_000,
        data: { issueId: "iss-m1", service: "app", scriptVersion: { id: "v-none" } },
      },
    });
    expect(res.status).toBe(202);
    expect(await json(res)).toMatchObject({ issueId: "iss-m1", forwarded: true });
  });

  it("PipelineRun ids are the CI run ids the coordinator hands the engine", () => {
    const run: Pick<PipelineRun, "id"> = { id: ciRunIdFor(changeWorkflowId("c1", "a".repeat(40))) };
    expect(run.id).toBe(`run-c1-${"a".repeat(12)}`);
  });
});
