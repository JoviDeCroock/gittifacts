/**
 * The review loop, agent side (workerd: real ChangeCoordinator + MergeQueue DOs and the
 * ChangeWorkflow). An agent pushes, asks for a review and long-polls for the merge; a human
 * requests changes over HTTP with a comment. The agent's wait answers at once with
 * `changes-requested` (it used to run into its timeout forever), get_change_status shows the
 * comment, who wrote it and for which head, and the next steps say: address it, push a new head,
 * ask again. The agent pushes again; the human rejects; the wait answers `rejected`. Agents that
 * try to review are told where a person does it. Fake: Artifacts, containers, CI and the model.
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
import { createPlatformClient, type PlatformClient } from "@app/mcp/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { COORDINATOR_OPTIONS } from "../../src/coordinator.js";
import { buildPorts } from "../../src/runtime/ports.js";
import {
  call,
  createAgent,
  expectError,
  json,
  ORIGIN,
  signUpHuman,
  type TestApp,
} from "../http.js";
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

let fakes: IntegrationFakes;

beforeEach(() => {
  fakes = resetIntegrationFakes();
});

/** Push `files` to the change's fork and run its ChangeWorkflow up to the review request. */
async function pushAndGrade(
  changeId: string,
  before: string,
  files: Record<string, string>,
  disposables: AsyncDisposable[],
): Promise<string> {
  const forkName = `task-${changeId}`;
  const head = fakes.git.commit(forkName, "main", files);
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
      payload: { ref: "refs/heads/main", before, after: head },
    },
  });
  await workflow.waitForStepResult({ name: "ci-start" });
  await fakes.ci.finish(env, ciRunIdFor(instanceId));
  await workflow.waitForStepResult({ name: "request-review" });
  return head;
}

/** Long-poll for the merge (the call an agent makes after request_review). */
async function waitForMerge(mcp: PlatformClient, changeId: string) {
  const r = await mcp.tools.wait_for_change({ changeId, until: "merged", timeoutSec: 60 });
  if (r.isError) throw new Error(JSON.stringify(r.content));
  return r.structuredContent;
}

describe("the review loop, agent side (workerd: real DOs + Workflows)", () => {
  it("changes requested over HTTP reach the agent: the wait answers, status shows the comment and the next steps", async () => {
    const app = platformApp();
    const human = await signUpHuman(app, "Ada");
    const agent = await createAgent(app, human.cookie);
    const created = await call(app, "POST", "/api/v1/repos", {
      cookie: human.cookie,
      body: { name: `loop-${Date.now().toString(36)}` },
    });
    expect(created.status).toBe(201);
    const { repo } = await json<{ repo: { id: string; artifactsName: string } }>(created);
    const baseSha = fakes.git.seed(repo.artifactsName, {
      "package.json": '{ "name": "loop", "scripts": { "test": "vitest run" } }\n',
      "src/a.ts": "export const a = (x: number) => x + 1;\n",
      "test/a.test.ts": 'import { a } from "../src/a";\n',
    });
    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, { fetch: fetchVia(app) });
    const disposables: AsyncDisposable[] = [];
    try {
      const started = await mcp.tools.start_change({
        repoId: repo.id,
        title: "Fix the off-by-one in a()",
        category: "fix",
      });
      if (started.isError) throw new Error(JSON.stringify(started.content));
      const changeId = started.structuredContent.change.id;
      const page = `${ORIGIN}/changes/${changeId}`;
      expect(started.structuredContent.url).toBe(page);

      const head1 = await pushAndGrade(
        changeId,
        baseSha,
        {
          "src/a.ts": "export const a = (x: number) => x + 2;\n",
          "test/a.test.ts": 'import { a } from "../src/a";\n// regression test\n',
        },
        disposables,
      );
      const asked = await mcp.tools.request_review({ changeId, message: "ready" });
      if (asked.isError) throw new Error(JSON.stringify(asked.content));
      expect(asked.structuredContent.url).toBe(page);
      // Honest about delivery: nothing is sent, so the first step is handing a person the page.
      expect(asked.structuredContent.requested).toBe(true);
      expect(asked.structuredContent.nextSteps[0]?.title).toBe(
        `Hand a person the change's page: ${page}`,
      );
      expect(asked.structuredContent.nextSteps[1]).toMatchObject({
        call: `wait_for_change({ changeId: "${changeId}", until: "merged" })`,
        why: expect.stringContaining("changes-requested"),
      });

      // An agent can't review (its own change or any other); the refusal says where a person does.
      const refused = await expectError(
        await call(app, "POST", `/api/v1/changes/${changeId}/review`, {
          token: agent.token,
          body: { decision: "approve" },
        }),
        403,
        "forbidden",
      );
      expect(refused.error.fix.call).toBe(`request_review({ changeId: "${changeId}" })`);
      expect(refused.error.fix.explanation).toContain(page);

      // The agent long-polls for the merge while a human reads it and asks for changes.
      const waiting = waitForMerge(mcp, changeId);
      const comment =
        "a(0) must still be 1: keep the old behaviour for zero and add a test for it.";
      const reviewed = await call(app, "POST", `/api/v1/changes/${changeId}/review`, {
        cookie: human.cookie,
        body: { decision: "request-changes", comment },
      });
      expect(reviewed.status).toBe(200);
      const waited = await waiting;
      expect(waited).toMatchObject({ reached: false, reason: "changes-requested" });
      expect(waited.change).toMatchObject({ status: "awaiting-push", headSha: head1 });
      expect(waited.nextSteps[0]?.call).toBe(`get_change_status({ changeId: "${changeId}" })`);

      // get_change_status: the review (who, what, for which head) and what to do about it.
      const status = await mcp.tools.get_change_status({ changeId });
      if (status.isError) throw new Error(JSON.stringify(status.content));
      const s = status.structuredContent;
      expect(s.url).toBe(page);
      expect(s.reviews).toEqual([
        expect.objectContaining({
          decision: "request-changes",
          comment,
          headSha: head1,
          current: true,
          reviewer: { id: human.principal.id, name: "Ada", kind: "human" },
          withdrawn: false,
          withdrawnReason: null,
        }),
      ]);
      expect(s.nextSteps[0]).toMatchObject({
        title: `Changes requested on ${head1.slice(0, 7)} by Ada: address the comment`,
        why: comment,
      });
      expect(s.nextSteps.map((n) => n.call)).toEqual([
        undefined,
        `refresh_push_token({ changeId: "${changeId}" })`,
        `request_review({ changeId: "${changeId}" })`,
      ]);
      expect(JSON.stringify(s.nextSteps)).not.toContain("Nothing has been pushed yet");

      // The agent pushes a new head; the human rejects it; the wait answers `rejected`.
      const head2 = await pushAndGrade(
        changeId,
        head1,
        {
          "src/a.ts": "export const a = (x: number) => (x === 0 ? 1 : x + 2);\n",
          "test/a.test.ts": 'import { a } from "../src/a";\n// a(0) stays 1\n',
        },
        disposables,
      );
      const again = await mcp.tools.get_change_status({ changeId });
      if (again.isError) throw new Error(JSON.stringify(again.content));
      expect(again.structuredContent.change).toMatchObject({
        headSha: head2,
        status: "awaiting-review",
      });
      // The first review stays, bound to the head it was given for.
      expect(again.structuredContent.reviews.map((r) => [r.headSha, r.current])).toEqual([
        [head1, false],
      ]);
      const waitingAgain = waitForMerge(mcp, changeId);
      const rejected = await call(app, "POST", `/api/v1/changes/${changeId}/review`, {
        cookie: human.cookie,
        body: { decision: "reject", comment: "Out of scope after all." },
      });
      expect(rejected.status).toBe(200);
      expect(await waitingAgain).toMatchObject({ reached: false, reason: "rejected" });
      const last = await mcp.tools.get_change_status({ changeId });
      if (last.isError) throw new Error(JSON.stringify(last.content));
      expect(last.structuredContent.nextSteps[0]).toMatchObject({
        title: "Rejected by Ada: this change ended",
        why: "Out of scope after all.",
      });
    } finally {
      for (const d of disposables) await d[Symbol.asyncDispose]();
      await mcp.client.close();
    }
  });
});
