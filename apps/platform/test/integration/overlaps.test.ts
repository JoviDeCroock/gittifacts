/**
 * Agents are told about overlapping work (workerd: real ChangeCoordinator DO + ChangeWorkflow,
 * D1 and the platform's HTTP + MCP). Cloudflare's "next Git platform" brief asks first how agents
 * coordinate and know about each other's work: agent A starts a change from Plan P and pushes
 * src/x.ts; agent B starts one from the same plan for src/x.ts and start_change names A's change
 * (same plan, same path) with who wrote it and its page; agent C, planless on src/y.ts, hears of
 * nothing (B, with nothing pushed, is "unchecked", not silently dropped); once B pushes, A's
 * get_change_status and GET /changes/:id/overlaps list B. Fake: Artifacts, containers, CI, model.
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
import type { OverlapReport, Principal } from "@app/domain";
import { createPlatformClient, type PlatformClient } from "@app/mcp/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { COORDINATOR_OPTIONS } from "../../src/coordinator.js";
import { buildPorts } from "../../src/runtime/ports.js";
import { call, json, ORIGIN, signUpHuman, type TestApp } from "../http.js";
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

interface Agent {
  name: string;
  principal: Principal;
  token: string;
  mcp: PlatformClient;
}

async function agentNamed(app: TestApp, cookie: string, name: string): Promise<Agent> {
  const res = await call(app, "POST", "/api/v1/principals/agents", {
    cookie,
    body: { name, scopes: ["repo:read", "plan:create", "change:create"] },
  });
  expect(res.status).toBe(201);
  const { token, principal } = await json<{ token: string; principal: Principal }>(res);
  const mcp = await createPlatformClient(`${ORIGIN}/mcp`, token, { fetch: fetchVia(app) });
  return { name, principal, token, mcp };
}

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

/** What every overlap entry must say about the other change and its author. */
function expectOverlap(
  report: OverlapReport | null,
  other: { changeId: string; title: string; agent: Agent },
  planId: string,
) {
  expect(report).not.toBeNull();
  expect(report?.overlaps).toEqual([
    expect.objectContaining({
      changeId: other.changeId,
      title: other.title,
      planId,
      pathsKnown: true,
      url: `${ORIGIN}/changes/${other.changeId}`,
      author: { id: other.agent.principal.id, kind: "agent", name: other.agent.name },
      reasons: [
        expect.objectContaining({ code: "same-plan", paths: [] }),
        expect.objectContaining({ code: "same-paths", paths: ["src/x.ts"], morePaths: 0 }),
      ],
    }),
  ]);
}

describe("overlapping work (workerd: real DOs + Workflows)", () => {
  it("start_change names open changes on the same plan or paths; get_change_status re-checks once heads exist", async () => {
    const app = platformApp();
    const human = await signUpHuman(app, "Ada");
    const created = await call(app, "POST", "/api/v1/repos", {
      cookie: human.cookie,
      body: { name: `overlap-${Date.now().toString(36)}` },
    });
    expect(created.status).toBe(201);
    const { repo } = await json<{ repo: { id: string; artifactsName: string } }>(created);
    const baseSha = fakes.git.seed(repo.artifactsName, {
      "package.json": '{ "name": "overlap", "scripts": { "test": "vitest run" } }\n',
      "src/x.ts": "export const x = (n: number) => n + 1;\n",
      "src/y.ts": "export const y = (n: number) => n * 2;\n",
      "test/x.test.ts": 'import { x } from "../src/x";\n',
    });
    const a = await agentNamed(app, human.cookie, "agent-a");
    const b = await agentNamed(app, human.cookie, "agent-b");
    const c = await agentNamed(app, human.cookie, "agent-c");

    // Plan P (scope src/x.ts), approved by the human. A change with nothing pushed is compared
    // on its stated paths plus its plan's scope, so a broad scope would reach C's src/y.ts.
    const drafted = await call(app, "POST", "/api/v1/plans", {
      token: a.token,
      body: {
        repoId: repo.id,
        title: "Make x add two",
        intent: "x must add two to its input, not one",
        acceptanceCriteria: ["x(0) returns 2"],
        scopePaths: ["src/x.ts"],
      },
    });
    expect(drafted.status).toBe(201);
    const { plan } = await json<{ plan: { id: string } }>(drafted);
    const approved = await call(app, "POST", `/api/v1/plans/${plan.id}/approve`, {
      cookie: human.cookie,
      body: {},
    });
    expect(approved.status).toBe(200);

    const disposables: AsyncDisposable[] = [];
    try {
      // A starts first: nobody else is working yet.
      const titleA = "Make x add two";
      const startedA = await a.mcp.tools.start_change({
        repoId: repo.id,
        planId: plan.id,
        title: titleA,
        category: "feature",
      });
      if (startedA.isError) throw new Error(JSON.stringify(startedA.content));
      const changeA = startedA.structuredContent.change.id;
      expect(startedA.structuredContent.overlaps).toMatchObject({
        overlaps: [],
        comparedPaths: ["src/x.ts"],
        unchecked: [],
      });
      await pushAndGrade(
        changeA,
        baseSha,
        {
          "src/x.ts": "export const x = (n: number) => n + 2;\n",
          "test/x.test.ts": 'import { x } from "../src/x";\n// x(0) is 2\n',
        },
        disposables,
      );

      // B starts from the same plan for src/x.ts: told about A (same plan, same path), by name.
      const titleB = "Guard x against NaN";
      const startedB = await b.mcp.tools.start_change({
        repoId: repo.id,
        planId: plan.id,
        title: titleB,
        category: "feature",
        paths: ["src/x.ts"],
      });
      if (startedB.isError) throw new Error(JSON.stringify(startedB.content));
      const changeB = startedB.structuredContent.change.id;
      expectOverlap(
        startedB.structuredContent.overlaps,
        { changeId: changeA, title: titleA, agent: a },
        plan.id,
      );
      expect(startedB.structuredContent.overlaps?.overlaps[0]).toMatchObject({
        status: "awaiting-review",
      });
      expect(startedB.structuredContent.nextSteps[0]).toMatchObject({
        title: `Another open change overlaps yours: ${titleA} (agent-a)`,
        call: `get_change_status({ changeId: "${changeA}" })`,
      });

      // C, planless, on src/y.ts (over HTTP): nothing overlaps. B has nothing pushed, but it said
      // it would touch src/x.ts, so it is compared on that (not unchecked).
      const startedC = await call(app, "POST", "/api/v1/changes", {
        token: c.token,
        body: { repoId: repo.id, title: "Double y", category: "feature", paths: ["src/y.ts"] },
      });
      expect(startedC.status).toBe(201);
      const c1 = await json<{ change: { id: string }; overlaps: OverlapReport | null }>(startedC);
      expect(c1.overlaps).toMatchObject({ overlaps: [], comparedPaths: ["src/y.ts"] });
      expect(c1.overlaps?.unchecked).toEqual([]);
      const changeC = c1.change.id;

      // Bounded input: too many paths is a 400, not a slow scan.
      const tooMany = await call(app, "POST", "/api/v1/changes", {
        token: c.token,
        body: {
          repoId: repo.id,
          title: "Too broad",
          category: "feature",
          paths: Array.from({ length: 51 }, (_, i) => `src/f${i}.ts`),
        },
      });
      expect(tooMany.status).toBe(400);

      // B pushes src/x.ts. A re-checks: B is listed, with the same reasons.
      await pushAndGrade(
        changeB,
        baseSha,
        { "src/x.ts": "export const x = (n: number) => (Number.isNaN(n) ? 0 : n + 1);\n" },
        disposables,
      );
      const statusA = await a.mcp.tools.get_change_status({ changeId: changeA });
      if (statusA.isError) throw new Error(JSON.stringify(statusA.content));
      expectOverlap(statusA.structuredContent.overlaps, { changeId: changeB, title: titleB, agent: b }, plan.id);
      // C has nothing pushed but said src/y.ts: compared on that, no overlap, not unchecked.
      expect(statusA.structuredContent.overlaps?.unchecked).toEqual([]);
      expect(statusA.structuredContent.overlaps?.comparedPaths.sort()).toEqual([
        "src/x.ts",
        "test/x.test.ts",
      ]);

      // The same report over HTTP (what the web reads), for a person.
      const http = await call(app, "GET", `/api/v1/changes/${changeA}/overlaps`, {
        cookie: human.cookie,
      });
      expect(http.status).toBe(200);
      const h = await json<{ changeId: string; overlaps: OverlapReport }>(http);
      expect(h.changeId).toBe(changeA);
      expectOverlap(h.overlaps, { changeId: changeB, title: titleB, agent: b }, plan.id);

      // C's status: still nothing overlaps on y.
      const statusC = await c.mcp.tools.get_change_status({ changeId: changeC });
      if (statusC.isError) throw new Error(JSON.stringify(statusC.content));
      expect(statusC.structuredContent.overlaps?.overlaps).toEqual([]);
    } finally {
      for (const d of disposables) await d[Symbol.asyncDispose]();
      for (const x of [a, b, c]) await x.mcp.client.close();
    }
  });

  it("two agents starting before either pushes see each other by their stated paths", async () => {
    const app = platformApp();
    const human = await signUpHuman(app, "Ada");
    const created = await call(app, "POST", "/api/v1/repos", {
      cookie: human.cookie,
      body: { name: `intent-${Date.now().toString(36)}` },
    });
    expect(created.status).toBe(201);
    const { repo } = await json<{ repo: { id: string; artifactsName: string } }>(created);
    fakes.git.seed(repo.artifactsName, {
      "package.json": '{ "name": "intent" }\n',
      "src/x.ts": "export const x = 1;\n",
    });
    const a = await agentNamed(app, human.cookie, "agent-a");
    const b = await agentNamed(app, human.cookie, "agent-b");
    try {
      const startedA = await a.mcp.tools.start_change({
        repoId: repo.id,
        title: "Rework x",
        category: "refactor",
        paths: ["src/x.ts"],
      });
      if (startedA.isError) throw new Error(JSON.stringify(startedA.content));
      const changeA = startedA.structuredContent.change.id;
      expect(startedA.structuredContent.change.headSha).toBeNull();

      // B, no plan, same path, A still has nothing pushed: same-paths from A's stated intent.
      const startedB = await b.mcp.tools.start_change({
        repoId: repo.id,
        title: "Rename x",
        category: "refactor",
        paths: ["src/x.ts"],
      });
      if (startedB.isError) throw new Error(JSON.stringify(startedB.content));
      const changeB = startedB.structuredContent.change.id;
      const told = startedB.structuredContent.overlaps;
      expect(told?.overlaps).toEqual([
        expect.objectContaining({
          changeId: changeA,
          headSha: null,
          planId: null,
          pathsKnown: true,
          pathsFrom: "intended",
          author: { id: a.principal.id, kind: "agent", name: "agent-a" },
          reasons: [expect.objectContaining({ code: "same-paths", paths: ["src/x.ts"] })],
        }),
      ]);
      expect(told?.unchecked).toEqual([]);

      // And A, re-checking before anyone pushed, hears of B the same way.
      const statusA = await a.mcp.tools.get_change_status({ changeId: changeA });
      if (statusA.isError) throw new Error(JSON.stringify(statusA.content));
      expect(statusA.structuredContent.overlaps?.overlaps).toEqual([
        expect.objectContaining({
          changeId: changeB,
          pathsFrom: "intended",
          reasons: [expect.objectContaining({ code: "same-paths", paths: ["src/x.ts"] })],
        }),
      ]);
    } finally {
      for (const x of [a, b]) await x.mcp.client.close();
    }
  });
});
