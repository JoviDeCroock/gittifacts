/**
 * O5 import detection, locally: a repo imported from a URL (the clock-api fixture's shape) gets
 * its `.platform/*` + AGENTS.md proposed as a draft Plan authored by the platform plus a Change on
 * a fork, pushed by a platform workspace; the push runs the normal flow and lands in Lane 2 with
 * requiresHumanApproval. Nothing touches the default branch.
 *
 * Real: everything but Artifacts (FakeGitHost), CI (EngineShapedCi), the model, the workspace
 * container (in-memory machine) and the detection job, which runs the real `inspectRepo` over the
 * fork's files instead of a Runner container (test/worker-entry.ts).
 */
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { changeWorkflowId, ciRunIdFor } from "@app/coordinator";
import { createPlatformClient } from "@app/mcp/client";
import { beforeEach, describe, expect, it } from "vitest";
import { call, createAgent, json, ORIGIN, signUpHuman } from "../http.js";
import { type IntegrationFakes, NAMESPACE, resetIntegrationFakes } from "./fakes.js";
import { fetchVia, platformApp } from "./harness.js";
import { resetFakeWorkspaces } from "./workspace-fakes.js";

const URL = "https://github.com/gittifacts-fixtures/clock-api.git";
const CLOCK_API = {
  "package.json": JSON.stringify({
    name: "clock-api",
    packageManager: "pnpm@11.27.0",
    scripts: {
      typecheck: "tsc --noEmit",
      test: "vitest run",
      build: "esbuild src/index.ts --bundle --outfile=dist/index.js",
    },
    devDependencies: { esbuild: "0.28.2", typescript: "6.0.3", vitest: "4.1.11" },
  }),
  "pnpm-lock.yaml":
    "lockfileVersion: '9.0'\n\npackages:\n  esbuild@0.28.2:\n    resolution: {integrity: x}\n",
  "pnpm-workspace.yaml": "allowBuilds:\n  esbuild: true\n",
  "tsconfig.json": '{ "compilerOptions": { "strict": true } }',
  "wrangler.jsonc": '{ "name": "clock-api", "main": "dist/index.js" }',
  "src/clock.ts": "export const formatOffset = (m: number) => String(Math.floor(m / 60));\n",
  "test/clock.test.ts": 'import { formatOffset } from "../src/clock";\n',
};

let fakes: IntegrationFakes;
beforeEach(() => {
  fakes = resetIntegrationFakes();
  resetFakeWorkspaces();
  fakes.git.importSources.set(URL, { files: CLOCK_API });
});

describe("import detection → Plan + Change (O5)", () => {
  it("proposes .platform/* and AGENTS.md as a draft system Plan + Lane 2 Change, never applied", async () => {
    const app = platformApp();
    const human = await signUpHuman(app);
    const agent = await createAgent(app, human.cookie);
    const name = `imp-${Date.now().toString(36)}`;
    const res = await call(app, "POST", "/api/v1/repos", {
      cookie: human.cookie,
      body: { name, importFrom: URL },
    });
    expect(res.status).toBe(201);
    const { repo } = await json<{ repo: { id: string; artifactsName: string } }>(res);
    const baseSha = (await fakes.git.branchHead(repo.artifactsName, "main")) ?? "";

    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, { fetch: fetchVia(app) });
    try {
      const r = await mcp.tools.propose_platform_config({ repoId: repo.id, waitSec: 45 });
      if (r.isError) throw new Error(JSON.stringify(r.content));
      const p = r.structuredContent;
      expect(p).toMatchObject({ status: "proposed", baseSha });
      expect(p.detection).toMatchObject({
        packageManager: "pnpm",
        testRunner: "vitest",
        workers: ["clock-api"],
      });
      const planId = p.planId ?? "";
      const changeId = p.changeId ?? "";

      // The Plan: a draft by the platform, every doubt a risk, scoped to the three files.
      const planRes = await call(app, "GET", `/api/v1/plans/${planId}`, { cookie: human.cookie });
      const { plan } = await json<{
        plan: {
          status: string;
          authorId: string;
          scopePaths: string[];
          riskDeclarations: Array<{ description: string }>;
        };
      }>(planRes);
      expect(plan).toMatchObject({ status: "draft", authorId: "system" });
      expect(plan.scopePaths).toEqual([".platform/ci.ts", ".platform/policy.ts", "AGENTS.md"]);
      // Every doubt detection reported is a risk the human reads (plus the generators' own).
      const risks = plan.riskDeclarations.map((r) => r.description);
      for (const doubt of p.detection?.uncertain ?? []) {
        expect(risks).toContain(`Detection is unsure: ${doubt}`);
      }
      for (const risk of plan.riskDeclarations)
        expect(risk.description).toMatch(/^Detection is unsure: /);

      // The Change: a chore by the platform, the files on its fork only.
      const forkName = `task-${changeId}`;
      const head = (await fakes.git.branchHead(forkName, "main")) ?? "";
      const files = fakes.git.filesAt(head);
      expect(files[".platform/ci.ts"]).toContain('name: "install"');
      expect(files[".platform/policy.ts"]).toContain("shadow: {");
      // Lane 0 belongs to the owner's toggle: the proposed file must not force it off.
      expect(files[".platform/policy.ts"]).not.toMatch(/^\s*lane0Enabled\s*:/m);
      expect(files["AGENTS.md"]).toContain("pnpm run test");
      expect(await fakes.git.branchHead(repo.artifactsName, "main")).toBe(baseSha);

      // Idempotent per default-branch commit: asking again returns the same proposal.
      const again = await mcp.tools.propose_platform_config({ repoId: repo.id, waitSec: 0 });
      if (again.isError) throw new Error(JSON.stringify(again.content));
      expect(again.structuredContent).toMatchObject({ proposalId: p.proposalId, changeId });

      // The push runs the normal flow: Lane 2, human approval required.
      const instanceId = changeWorkflowId(changeId, head);
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
      await workflow.waitForStepResult({ name: "classify" });
      const status = await mcp.tools.get_change_status({ changeId });
      if (status.isError) throw new Error(JSON.stringify(status.content));
      expect(status.structuredContent.classification).toMatchObject({
        lane: 2,
        requiresHumanApproval: true,
      });
      expect(status.structuredContent.change.category).toBe("chore");
    } finally {
      await mcp.client.close();
    }
  });

  it("create_project({ from }) points the agent at propose_platform_config after the first CI", async () => {
    const app = platformApp();
    const human = await signUpHuman(app);
    const agent = await createAgent(app, human.cookie);
    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, { fetch: fetchVia(app) });
    try {
      const name = `imp-${Date.now().toString(36)}`;
      const r = await mcp.tools.create_project({ from: URL, name });
      if (r.isError) throw new Error(JSON.stringify(r.content));
      const p = r.structuredContent;
      const calls = p.nextSteps.map((s) => s.call ?? "");
      expect(calls[0]).toMatch(/^wait_for_change\(\{ changeId: "bs-/);
      expect(calls[1]).toBe(`propose_platform_config({ repoId: "${p.projectId}", waitSec: 45 })`);
    } finally {
      await mcp.client.close();
    }
  });
});
