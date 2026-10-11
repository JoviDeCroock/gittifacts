/**
 * `wait_for_change(merged)` settles when the machines send a change back (workerd: real
 * ChangeCoordinator DO and ChangeWorkflow; fakes for Artifacts, CI and the model). An agent that
 * pushed and long-polls for the merge used to hold until its timeout, then call again forever,
 * while CI was red: the wait now answers `failing` and the next steps say to fix and push.
 */
import {
  createExecutionContext,
  introspectWorkflowInstance,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { changeWorkflowId, ciRunIdFor } from "@app/coordinator";
import { createPlatformClient } from "@app/mcp/client";
import { beforeEach, describe, expect, it } from "vitest";
import { call, createAgent, json, ORIGIN, signUpHuman, type TestApp } from "../http.js";
import { type IntegrationFakes, NAMESPACE, resetIntegrationFakes } from "./fakes.js";
import { platformApp } from "./platform-app.js";

function fetchVia(app: TestApp) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(input, init), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
}

let fakes: IntegrationFakes;

beforeEach(() => {
  fakes = resetIntegrationFakes();
});

describe("wait_for_change answers `failing` (workerd: real DOs + Workflows)", () => {
  it("a merged wait settles when CI goes red on the pushed head, with fix-and-push next steps", async () => {
    const app = platformApp();
    const human = await signUpHuman(app, "Ada");
    const agent = await createAgent(app, human.cookie);
    const created = await call(app, "POST", "/api/v1/repos", {
      cookie: human.cookie,
      body: { name: `red-${Date.now().toString(36)}` },
    });
    expect(created.status).toBe(201);
    const { repo } = await json<{ repo: { id: string; artifactsName: string } }>(created);
    const baseSha = fakes.git.seed(repo.artifactsName, {
      "package.json": '{ "name": "red", "scripts": { "test": "vitest run" } }\n',
      "src/a.ts": "export const a = (x: number) => x + 1;\n",
    });
    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, { fetch: fetchVia(app) });
    const disposables: AsyncDisposable[] = [];
    try {
      const started = await mcp.tools.start_change({
        repoId: repo.id,
        title: "Change a()",
        category: "feature",
      });
      if (started.isError) throw new Error(JSON.stringify(started.content));
      const changeId = started.structuredContent.change.id;

      // The agent waits for the merge before CI has said anything.
      const waiting = mcp.tools.wait_for_change({ changeId, until: "merged", timeoutSec: 60 });

      const forkName = `task-${changeId}`;
      const head = fakes.git.commit(forkName, "main", { "src/a.ts": "export const a = 1;\n" });
      const instanceId = changeWorkflowId(changeId, head);
      const workflow = await introspectWorkflowInstance(env.CHANGE_WORKFLOW, instanceId);
      disposables.push(workflow);
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
      await fakes.ci.finish(env, ciRunIdFor(instanceId), { failTests: 1 });

      const r = await waiting;
      if (r.isError) throw new Error(JSON.stringify(r.content));
      expect(r.structuredContent).toMatchObject({
        reached: false,
        reason: "failing",
        change: { id: changeId, status: "failing", headSha: head },
      });
      expect(r.structuredContent.nextSteps[0]).toMatchObject({
        title: "Fix CI and push again",
        call: `get_change_status({ changeId: "${changeId}" })`,
      });
      // A new wait answers at once while it stays red; one for the evidence still says reached.
      const again = await mcp.tools.wait_for_change({ changeId, until: "merged", timeoutSec: 5 });
      if (again.isError) throw new Error(JSON.stringify(again.content));
      expect(again.structuredContent.reason).toBe("failing");
      const evidence = await mcp.tools.wait_for_change({
        changeId,
        until: "evidence_ready",
        timeoutSec: 5,
      });
      if (evidence.isError) throw new Error(JSON.stringify(evidence.content));
      expect(evidence.structuredContent.reason).toBe("reached");
    } finally {
      for (const d of disposables) await d[Symbol.asyncDispose]();
      await mcp.client.close();
    }
  });
});
