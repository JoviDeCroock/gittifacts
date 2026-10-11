/**
 * Separation of duties on `.platform/**` (security audit 2026-10-11, M12), workerd: the real
 * coordinator facade with the platform's repo-access port (members counted in D1), real DOs and
 * the ChangeWorkflow. An agent changes `.platform/policy.ts`; people review over HTTP.
 *
 * - A solo project's only human approves their own agent's policy change (recorded). A pending
 *   invite is not a member, so it doesn't end the solo exception.
 * - With a second human maintainer, the agent's owner is refused (self-approval); the other
 *   maintainer approves. A reviewer-role human is refused (approving policy needs a maintainer).
 */
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { changeWorkflowId, ciRunIdFor } from "@app/coordinator";
import type { Principal } from "@app/domain";
import { createPlatformClient } from "@app/mcp/client";
import { beforeEach, describe, expect, it } from "vitest";
import {
  call,
  createAgent,
  expectError,
  json,
  ORIGIN,
  signUpHuman,
  type TestApp,
} from "../http.js";
import { type IntegrationFakes, NAMESPACE, resetIntegrationFakes } from "./fakes.js";
import { fetchVia, platformApp } from "./harness.js";

let fakes: IntegrationFakes;

beforeEach(() => {
  fakes = resetIntegrationFakes();
});

interface PolicyChange {
  repoId: string;
  changeId: string;
  disposables: AsyncDisposable[];
}

/** `owner` creates a repo; their agent changes `.platform/policy.ts`, graded up to review. */
async function agentPolicyChange(
  app: TestApp,
  owner: { cookie: string },
  name: string,
): Promise<PolicyChange> {
  const agent = await createAgent(app, owner.cookie);
  const created = await call(app, "POST", "/api/v1/repos", {
    cookie: owner.cookie,
    body: { name: `${name}-${Date.now().toString(36)}` },
  });
  expect(created.status).toBe(201);
  const { repo } = await json<{ repo: { id: string; artifactsName: string } }>(created);
  const baseSha = fakes.git.seed(repo.artifactsName, {
    "package.json": '{ "name": "sod", "scripts": { "test": "vitest run" } }\n',
    "src/a.ts": "export const a = (x: number) => x + 1;\n",
    "test/a.test.ts": 'import { a } from "../src/a";\n',
  });
  const mcp = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, { fetch: fetchVia(app) });
  const disposables: AsyncDisposable[] = [];
  try {
    const started = await mcp.tools.start_change({
      repoId: repo.id,
      title: "Tighten the review policy",
      category: "chore",
    });
    if (started.isError) throw new Error(JSON.stringify(started.content));
    const changeId = started.structuredContent.change.id;
    const forkName = `task-${changeId}`;
    const head = fakes.git.commit(forkName, "main", {
      ".platform/policy.ts": `export default { lane0: false }; // ${name}\n`,
    });
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
    await fakes.ci.finish(env, ciRunIdFor(instanceId));
    await workflow.waitForStepResult({ name: "request-review" });
    const status = await mcp.tools.get_change_status({ changeId });
    if (status.isError) throw new Error(JSON.stringify(status.content));
    expect(status.structuredContent.change.status).toBe("awaiting-review");
    return { repoId: repo.id, changeId, disposables };
  } catch (e) {
    for (const d of disposables) await d[Symbol.asyncDispose]();
    throw e;
  } finally {
    await mcp.client.close();
  }
}

const approve = (app: TestApp, changeId: string, cookie: string) =>
  call(app, "POST", `/api/v1/changes/${changeId}/review`, {
    cookie,
    body: { decision: "approve" },
  });

/** The `change.reviewed` audit entries of a change, oldest first (the API shows no payloads). */
async function reviewedAudit(changeId: string) {
  const rows = await env.DB.prepare(
    "SELECT principal_id, payload FROM audit_events WHERE action = 'change.reviewed' AND subject = ? ORDER BY seq",
  )
    .bind(`change:${changeId}`)
    .all<{ principal_id: string; payload: string }>();
  return rows.results.map((r) => ({
    principalId: r.principal_id,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
  }));
}

async function addMember(
  app: TestApp,
  repoId: string,
  ownerCookie: string,
  who: Principal,
  role: string,
) {
  const res = await call(app, "POST", `/api/v1/repos/${repoId}/members`, {
    cookie: ownerCookie,
    body: { principalId: who.id, role },
  });
  expect(res.status).toBe(201);
}

describe("separation of duties on .platform/ (workerd: real facade, access port, DOs, workflow)", () => {
  it("a solo project's only human approves their own agent's policy change; a pending invite doesn't count", async () => {
    const app = platformApp();
    const owner = await signUpHuman(app, "Solo");
    const c = await agentPolicyChange(app, owner, "solo");
    try {
      // An open invite is not a member: the owner is still the repo's only human.
      const invited = await call(app, "POST", `/api/v1/repos/${c.repoId}/members`, {
        cookie: owner.cookie,
        body: { email: `pending-${Date.now()}@example.com`, role: "maintainer" },
      });
      expect(invited.status).toBe(202);

      expect((await approve(app, c.changeId, owner.cookie)).status).toBe(200);
      const [reviewed] = await reviewedAudit(c.changeId);
      expect(reviewed).toMatchObject({
        principalId: owner.principal.id,
        payload: {
          decision: "approve",
          requiresHumanApproval: true,
          approvedByAgentOwner: true,
          soloOwnerApprovedOwnAgentPolicy: true,
        },
      });
    } finally {
      for (const d of c.disposables) await d[Symbol.asyncDispose]();
    }
  });

  it("with other humans: a reviewer-role human and the agent's owner are refused; another maintainer approves", async () => {
    const app = platformApp();
    const owner = await signUpHuman(app, "Olga");
    const c = await agentPolicyChange(app, owner, "team");
    try {
      const maint = await signUpHuman(app, "Mia");
      const reviewer = await signUpHuman(app, "Rex");
      await addMember(app, c.repoId, owner.cookie, maint.principal, "maintainer");
      await addMember(app, c.repoId, owner.cookie, reviewer.principal, "reviewer");

      // A reviewer-role human can't approve a policy change (they may still request changes).
      await expectError(await approve(app, c.changeId, reviewer.cookie), 403, "forbidden");
      // The authoring agent's owner can't approve it while the repo has other humans.
      const self = await expectError(
        await approve(app, c.changeId, owner.cookie),
        403,
        "self-approval",
      );
      expect(self.error.fix.call).toBe(`list_members({ repoId: "${c.repoId}" })`);
      expect(await reviewedAudit(c.changeId)).toEqual([]);

      // Another maintainer approves.
      expect((await approve(app, c.changeId, maint.cookie)).status).toBe(200);
      const [reviewed] = await reviewedAudit(c.changeId);
      expect(reviewed).toMatchObject({
        principalId: maint.principal.id,
        payload: { decision: "approve", requiresHumanApproval: true, approvedByAgentOwner: false },
      });
      expect(reviewed?.payload).not.toHaveProperty("soloOwnerApprovedOwnAgentPolicy");
    } finally {
      for (const d of c.disposables) await d[Symbol.asyncDispose]();
    }
  });
});
