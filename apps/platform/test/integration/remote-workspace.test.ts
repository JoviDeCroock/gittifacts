/**
 * O5 acceptance, locally: a remote-only agent (no shell, no git) does the whole loop over MCP:
 * create_plan → start_change → open_workspace → ws_write → ws_exec("pnpm test") → ws_commit_push
 * → wait_for_change(evidence_ready) → get_tour.
 *
 * Real: the Hono app and MCP server, agent tokens, D1, AuditLog, the coordinator facade, the
 * ChangeCoordinator DO, PushRouter + ChangeWorkflow, and the Workspace + ProjectLedger DOs (TTL,
 * owner checks, quotas, token minting through the fork-only GitHost). Fake: Artifacts
 * (FakeGitHost), CI (EngineShapedCi), the reviewer model, and the workspace container
 * (./workspace-fakes.ts: files in memory, `pnpm test` answered from them, the push becomes a
 * FakeGitHost commit whose Artifacts push event the test delivers, as the m1 test does).
 */
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { changeWorkflowId, ciRunIdFor } from "@app/coordinator";
import { createPlatformClient } from "@app/mcp/client";
import { beforeEach, describe, expect, it } from "vitest";
import { call, createAgent, json, ORIGIN, signUpHuman } from "../http.js";
import { type IntegrationFakes, NAMESPACE, resetIntegrationFakes } from "./fakes.js";
import { fetchVia, platformApp } from "./harness.js";
import { type FakeWorkspaces, fakeMachineFor, resetFakeWorkspaces } from "./workspace-fakes.js";

const BUGGY = "export const add = (a: number, b: number) => a - b;\n";
const FIXED = "export const add = (a: number, b: number) => a + b;\n";

let fakes: IntegrationFakes;
let ws: FakeWorkspaces;

beforeEach(() => {
  fakes = resetIntegrationFakes();
  ws = resetFakeWorkspaces();
  // `pnpm test` passes once src/add.ts adds.
  ws.onExec = (command, files) =>
    command === "pnpm test"
      ? files["src/add.ts"] === FIXED
        ? { exitCode: 0, stdout: " ✓ test/add.test.ts (1 test)\n Tests  1 passed (1)\n" }
        : { exitCode: 1, stdout: " ✗ add > adds\n Tests  1 failed (1)\n" }
      : null;
});

type ToolResult = { isError?: boolean; content?: unknown };
type Structured<R> = R extends { structuredContent: infer S } ? S : never;

function ok<R extends ToolResult>(r: R): Structured<R> {
  if (r.isError) throw new Error(JSON.stringify(r.content));
  return (r as unknown as { structuredContent: Structured<R> }).structuredContent;
}

describe("remote-only agent over MCP (O5 acceptance)", () => {
  it("plans, opens a workspace, fixes a test, pushes, gets evidence and a tour", async () => {
    const app = platformApp();
    const human = await signUpHuman(app);
    const agent = await createAgent(app, human.cookie);
    const name = `rw-${Date.now().toString(36)}`;
    const created = await call(app, "POST", "/api/v1/repos", {
      cookie: human.cookie,
      body: { name },
    });
    const { repo } = await json<{ repo: { id: string; artifactsName: string } }>(created);
    const baseSha = fakes.git.seed(repo.artifactsName, {
      "package.json": '{ "name": "rw", "scripts": { "test": "vitest run" } }\n',
      "src/add.ts": BUGGY,
      "test/add.test.ts": 'import { add } from "../src/add";\n// expect(add(1, 2)).toBe(3)\n',
    });

    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, { fetch: fetchVia(app) });
    try {
      const { plan } = ok(
        await mcp.tools.create_plan({
          repoId: repo.id,
          title: "Fix add()",
          intent: "add() subtracts; it must add.",
          acceptanceCriteria: ["add(1, 2) === 3"],
          scopePaths: ["src/**", "test/**"],
        }),
      );
      const { change } = ok(
        await mcp.tools.start_change({
          repoId: repo.id,
          planId: plan.id,
          title: "Fix add()",
          category: "fix",
        }),
      );
      const opened = ok(await mcp.tools.open_workspace({ changeId: change.id }));
      expect(opened).toMatchObject({
        workspaceId: `ws-${change.id}`,
        status: "ready",
        branch: "main",
      });
      expect(opened.headSha).toBe(baseSha);
      expect(opened.network).toBe("open"); // a human's project is claimed
      expect(opened.tools.map((t) => t.name)).toContain("ws_commit_push");
      const workspaceId = opened.workspaceId;

      const red = ok(await mcp.tools.ws_exec({ workspaceId, command: "pnpm test" }));
      expect(red.exitCode).toBe(1);
      const read = ok(await mcp.tools.ws_read({ workspaceId, path: "src/add.ts" }));
      expect(read.content).toBe(BUGGY);
      ok(await mcp.tools.ws_write({ workspaceId, path: "src/add.ts", content: FIXED }));
      const green = ok(await mcp.tools.ws_exec({ workspaceId, command: "pnpm test" }));
      expect(green).toMatchObject({ exitCode: 0, timedOut: false });
      const diff = ok(await mcp.tools.ws_diff({ workspaceId }));
      expect(diff.files).toEqual([
        { path: "src/add.ts", status: "modified", additions: 1, deletions: 1 },
      ]);

      const pushed = ok(await mcp.tools.ws_commit_push({ workspaceId, message: "fix: add adds" }));
      expect(pushed).toMatchObject({
        changeId: change.id,
        branch: "main",
        pushed: true,
        filesChanged: 1,
      });
      const head = pushed.commitSha;
      const forkName = `task-${change.id}`;
      expect(ws.pushes).toEqual([{ fork: forkName, branch: "main", before: baseSha, after: head }]);
      // The workspace only ever held tokens for the fork; main is untouched.
      const minted = fakes.git.tokens.filter((t) =>
        fakeMachineFor(workspaceId).tokens.some((u) => u.token === t.token),
      );
      expect(minted.map((t) => [t.repo, t.scope])).toEqual([
        [forkName, "read"],
        [forkName, "write"],
      ]);
      expect(await fakes.git.branchHead(repo.artifactsName, "main")).toBe(baseSha);

      // Artifacts emits cf.artifacts.repo.pushed for the fork; the normal push flow takes over.
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
      const waiting = mcp.tools.wait_for_change({
        changeId: change.id,
        until: "evidence_ready",
        timeoutSec: 120,
      });
      await fakes.ci.finish(env, ciRunIdFor(instanceId));
      const evidence = ok(await waiting);
      expect(evidence).toMatchObject({ reached: true });

      const tourReady = ok(
        await mcp.tools.wait_for_change({
          changeId: change.id,
          until: "tour_ready",
          timeoutSec: 120,
        }),
      );
      expect(tourReady.reached).toBe(true);
      const { tour } = ok(await mcp.tools.get_tour({ changeId: change.id }));
      expect(tour.headSha).toBe(head);
      expect(tour.stops.length).toBeGreaterThan(0);

      const closed = ok(await mcp.tools.close_workspace({ workspaceId }));
      expect(closed.status).toBe("closed");
      const audit = await call(app, "GET", `/api/v1/audit?subject=change:${change.id}`, {
        cookie: human.cookie,
      });
      const actions = (await json<{ events: Array<{ action: string }> }>(audit)).events.map(
        (e) => e.action,
      );
      expect(actions).toEqual(
        expect.arrayContaining(["workspace.opened", "workspace.pushed", "workspace.closed"]),
      );
    } finally {
      await mcp.client.close();
    }
  });
});
