/**
 * Pushes that grade nothing are told, not swallowed: a push to another branch of the fork, a tag,
 * or the branch still at the base goes through the real PushRouter and ChangeCoordinator DO, and
 * get_change_status / wait_for_change (MCP) report it as pushIssues with the fix. A push to the
 * right branch clears them. Fakes: ./fakes.ts (Artifacts, CI).
 */
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { changeWorkflowId } from "@app/coordinator";
import { createPlatformClient } from "@app/mcp/client";
import { beforeEach, describe, expect, it } from "vitest";
import { call, createAgent, json, ORIGIN, signUpHuman } from "../http.js";
import { type IntegrationFakes, NAMESPACE, resetIntegrationFakes } from "./fakes.js";
import { fetchVia, platformApp } from "./harness.js";

let fakes: IntegrationFakes;
beforeEach(() => {
  fakes = resetIntegrationFakes();
});

async function routePush(forkName: string, ref: string, before: string, after: string, n: number) {
  const id = `push-${after.slice(0, 12)}-${n}`;
  await using router = await introspectWorkflowInstance(env.PUSH_ROUTER, id);
  await env.PUSH_ROUTER.create({
    id,
    params: {
      type: "cf.artifacts.repo.pushed",
      source: { type: "artifacts.repo", namespace: NAMESPACE, repoName: forkName },
      payload: { ref, before, after },
    },
  });
  await router.waitForStatus("complete");
}

describe("ignored pushes (workerd, real PushRouter + ChangeCoordinator)", () => {
  it("reports a wrong branch, a tag and no new commits with the fix, then clears on a real push", async () => {
    const app = platformApp();
    const human = await signUpHuman(app);
    const agent = await createAgent(app, human.cookie);
    const created = await call(app, "POST", "/api/v1/repos", {
      cookie: human.cookie,
      body: { name: `pi-${Date.now().toString(36)}` },
    });
    expect(created.status).toBe(201);
    const { repo } = await json<{ repo: { id: string; artifactsName: string } }>(created);
    const baseSha = fakes.git.seed(repo.artifactsName, { "src/a.ts": "export const a = 1;\n" });

    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, { fetch: fetchVia(app) });
    try {
      const started = await mcp.tools.start_change({
        repoId: repo.id,
        title: "Bump a",
        category: "feature",
      });
      if (started.isError) throw new Error(JSON.stringify(started.content));
      const { change } = started.structuredContent;
      const fork = `task-${change.id}`;

      // 1. The agent pushes its commit to a branch of its own naming: nothing grades it.
      const work = fakes.git.commit(fork, "my-feature", { "src/a.ts": "export const a = 2;\n" });
      await routePush(fork, "refs/heads/my-feature", baseSha, work, 1);
      const s1 = await mcp.tools.get_change_status({ changeId: change.id });
      if (s1.isError) throw new Error(JSON.stringify(s1.content));
      expect(s1.structuredContent.change.status).toBe("awaiting-push");
      expect(s1.structuredContent.pushIssues).toEqual([
        expect.objectContaining({
          kind: "wrong-ref",
          ref: "refs/heads/my-feature",
          expectedRef: "refs/heads/main",
          sha: work,
          fix: expect.objectContaining({ command: "git push <fork> HEAD:main" }),
        }),
      ]);
      expect(s1.structuredContent.nextSteps[0]).toMatchObject({
        title: expect.stringContaining("Your push to refs/heads/my-feature graded nothing"),
        command: "git push <fork> HEAD:main",
      });

      // 2. wait_for_change times out, and says why instead of "call again".
      const w = await mcp.tools.wait_for_change({
        changeId: change.id,
        until: "evidence_ready",
        timeoutSec: 1,
      });
      if (w.isError) throw new Error(JSON.stringify(w.content));
      expect(w.structuredContent.reason).toBe("timeout");
      expect(w.structuredContent.warning).toContain("your last push graded nothing");
      expect(w.structuredContent.pushIssues).toHaveLength(1);
      expect(w.structuredContent.nextSteps[0]?.command).toBe("git push <fork> HEAD:main");

      // 3. A tag, and main still at the base: both recorded, newest last.
      await routePush(fork, "refs/tags/v1", baseSha, work, 2);
      await routePush(fork, "refs/heads/main", baseSha, baseSha, 3);
      const s2 = await mcp.tools.get_change_status({ changeId: change.id });
      if (s2.isError) throw new Error(JSON.stringify(s2.content));
      expect(s2.structuredContent.pushIssues?.map((i) => i.kind)).toEqual([
        "wrong-ref",
        "tag",
        "no-new-commits",
      ]);
      expect(s2.structuredContent.nextSteps[0]?.title).toContain("refs/heads/main");

      // 4. The right push grades and clears them.
      const head = fakes.git.commit(fork, "main", { "src/a.ts": "export const a = 3;\n" });
      await using workflow = await introspectWorkflowInstance(
        env.CHANGE_WORKFLOW,
        changeWorkflowId(change.id, head),
      );
      await workflow.modify(async (m) => {
        await m.disableSleeps();
        await m.disableRetryDelays();
      });
      await routePush(fork, "refs/heads/main", baseSha, head, 4);
      const s3 = await mcp.tools.get_change_status({ changeId: change.id });
      if (s3.isError) throw new Error(JSON.stringify(s3.content));
      expect(s3.structuredContent.change).toMatchObject({ headSha: head, status: "running" });
      expect(s3.structuredContent.pushIssues).toEqual([]);
    } finally {
      await mcp.client.close();
    }
  });
});
