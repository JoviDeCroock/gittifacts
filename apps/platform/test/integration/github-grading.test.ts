/**
 * GitHub mode end to end in workerd: a verified `pull_request.opened` delivery → the queue
 * consumer → GithubSync (mirror fetch with a revoked-after token, the PR's Change, the in-progress
 * `gittifacts/lane` run) → the real ChangeCoordinator DO → the real ChangeWorkflow (CI on the
 * mirror, evidence, classification) → the verdict on the check run, through the write-gate DO.
 * GitHub's API is stubbed; Artifacts, CI and the model are the integration fakes.
 */
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { changeWorkflowId, ciRunIdFor } from "@app/coordinator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/app-env.js";
import { handleGithubEvent } from "../../src/github/consumer.js";
import { upsertInstallation } from "../../src/github/store.js";
import type { GithubEventMessage } from "../../src/github/webhook.js";
import { createPlatformClient } from "@app/mcp/client";
import { githubInstallationLinks } from "../../src/db/github-schema.js";
import { store } from "../fixtures.js";
import { APP_ID, jsonRes, stubGithub } from "../github-helpers.js";
import { createAgent, ORIGIN, signUpHuman } from "../http.js";
import { fetchVia, platformApp } from "./harness.js";
import { type IntegrationFakes, resetIntegrationFakes } from "./fakes.js";

const API = "https://api.github.com";
const INSTALLATION = 777001;
const REPO = { id: 31337, name: "widgets", owner: "acme" };

/** The Reader App comes from Worker config (vitest.config.ts); only its installation is seeded. */
async function seedReaderApp() {
  await upsertInstallation(store().db, {
    id: INSTALLATION, appId: APP_ID, account: { login: "acme", id: 99, type: "Organization" },
    repositorySelection: "selected", permissions: { checks: "write" }, events: ["pull_request"], suspendedAt: null,
  }, new Date());
}

const repository = { id: REPO.id, name: REPO.name, full_name: `${REPO.owner}/${REPO.name}`, private: true, default_branch: "main", owner: { login: REPO.owner, id: 99, type: "Organization" } };

function prPayload(base: string, head: string) {
  return {
    action: "opened",
    number: 7,
    installation: { id: INSTALLATION },
    repository,
    pull_request: {
      number: 7, title: "fix: total() drops the last cent", body: "Fixes the rounding.", state: "open", draft: false,
      merged: false, merge_commit_sha: null, html_url: `https://github.com/acme/widgets/pull/7`,
      user: { login: "octo-dev", id: 5150, type: "User" }, labels: [],
      head: { ref: "fix-total", sha: head, repo: { id: REPO.id, full_name: "acme/widgets" } },
      base: { ref: "main", sha: base, repo: { id: REPO.id, full_name: "acme/widgets" } },
    },
  };
}

describe("GitHub mode in workerd", () => {
  let fakes: IntegrationFakes;
  beforeEach(() => {
    fakes = resetIntegrationFakes();
  });
  afterEach(() => vi.restoreAllMocks());

  it("a pull request is mirrored, graded by the ChangeWorkflow and its verdict lands on gittifacts/lane", async () => {
    await seedReaderApp();
    // The human who linked the installation owns its graded repos (and their agents can read them).
    const app = platformApp();
    const human = await signUpHuman(app, "Ines");
    await store().db.insert(githubInstallationLinks).values({
      installationId: INSTALLATION, principalId: human.principal.id, githubLogin: "ines", linkedAt: new Date().toISOString(),
    });
    const gh = `github.com/${REPO.owner}/${REPO.name}`;
    const base = fakes.git.seed(gh, { "src/total.ts": "export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n", "README.md": "# widgets\n" });
    fakes.git.repo(gh).refs.set("refs/heads/fix-total", base);
    const head = fakes.git.commit(gh, "fix-total", { "src/total.ts": "export const total = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0));\n" });
    const checks: { method: string; body: Record<string, unknown> }[] = [];
    const prWrites: { what: string; body: Record<string, unknown> }[] = [];
    const tokens = { minted: 0, revoked: 0 };
    stubGithub({
      [`POST ${API}/app/installations/${INSTALLATION}/access_tokens`]: () => (tokens.minted++, jsonRes({ token: `ghs_integration_token_${tokens.minted}`, expires_at: "2030-01-01T00:00:00Z" }, 201)),
      [`DELETE ${API}/installation/token`]: () => (tokens.revoked++, new Response(null, { status: 204 })),
      [`GET ${API}/repos/acme/widgets/compare/${base}...${head}`]: () => jsonRes({ merge_base_commit: { sha: base } }),
      [`POST ${API}/repos/acme/widgets/check-runs`]: async (req) => (checks.push({ method: "POST", body: await req.json() }), jsonRes({ id: 9911 }, 201)),
      [`PATCH ${API}/repos/acme/widgets/check-runs/9911`]: async (req) => (checks.push({ method: "PATCH", body: await req.json() }), jsonRes({ id: 9911 })),
      // M3 (the installation is linked, so PR writes are on): the tour review and the summary.
      [`POST ${API}/repos/acme/widgets/pulls/7/reviews`]: async (req) => (prWrites.push({ what: "review", body: await req.json() }), jsonRes({ id: 5501, node_id: "PRR_5501" })),
      [`GET ${API}/repos/acme/widgets/pulls/7/reviews/5501/comments`]: () => jsonRes([{ id: 77001 }]),
      [`POST ${API}/repos/acme/widgets/issues/7/comments`]: async (req) => (prWrites.push({ what: "summary", body: await req.json() }), jsonRes({ id: 88001 }, 201)),
    });
    const changeId = `gh-${REPO.id}-7`;
    const instanceId = changeWorkflowId(changeId, head);
    await using workflow = await introspectWorkflowInstance(env.CHANGE_WORKFLOW, instanceId);
    const msg: GithubEventMessage = {
      v: 1, deliveryId: crypto.randomUUID(), appId: APP_ID, event: "pull_request", action: "opened",
      installationId: INSTALLATION, receivedAt: new Date().toISOString(), payload: prPayload(base, head),
    };
    await handleGithubEvent({ db: store().db, blobs: env.BLOBS, now: () => new Date(), env: env as Bindings }, msg);

    // The mirror holds the head on its PR branch, fetched with a token; the Change points at it.
    expect(fakes.git.head(`ghm-${REPO.id}`, `gittifacts/pr/7`)).toBe(head);
    expect(fakes.git.externalFetches.every((f) => f.authed)).toBe(true);
    expect(checks[0]).toMatchObject({ method: "POST", body: { name: "gittifacts/lane", head_sha: head, status: "in_progress" } });

    await workflow.waitForStepResult({ name: "ci-start" });
    expect(fakes.ci.runs.get(ciRunIdFor(instanceId))?.request).toMatchObject({ artifactsRepo: `ghm-${REPO.id}`, headSha: head, baseSha: base });
    await fakes.ci.finish(env, ciRunIdFor(instanceId));
    await workflow.waitForStepResult({ name: "graded-on-host" });
    await workflow.waitForStepResult({ name: "publish-summary" });

    // The lane goes into the open run while the tour is written (still in progress), then the run completes.
    const patches = checks.filter((c) => c.method === "PATCH");
    expect(patches[0]?.body).toMatchObject({ status: "in_progress", output: { title: "Quick review (Lane 1) so far · walkthrough coming" } });
    expect(patches[0]?.body).not.toHaveProperty("conclusion");
    const patch = patches.find((c) => c.body.status === "completed");
    expect(patch?.body).toMatchObject({ status: "completed", details_url: `http://localhost/changes/${changeId}` });
    expect(["success", "neutral", "action_required"]).toContain(patch?.body.conclusion);
    expect(String((patch?.body.output as { title: string }).title)).toMatch(/^Quick review \(Lane 1\) · /);
    const change = await store().getChange(changeId);
    expect(change).toMatchObject({ status: "awaiting-review", forkName: `ghm-${REPO.id}`, host: { kind: "github", number: 7, fork: false } });
    expect(change?.lane).not.toBeNull();
    // The summary comment (lane ≥ 1). Lane 0 is in shadow mode by default, so this PR is Lane 1 and
    // gets a tour; the fake tour has one intent stop and nothing a person must look at on the diff,
    // so no review is posted (the summary links the tour).
    expect(change?.lane).toBe(1);
    expect(prWrites.find((w) => w.what === "review")).toBeUndefined();
    expect(String(prWrites.find((w) => w.what === "summary")?.body.body)).toContain("gittifacts:summary");
    expect(String(prWrites.find((w) => w.what === "summary")?.body.body)).toContain("Open the walkthrough on gittifacts");
    // Every token minted for a job was revoked.
    expect(tokens.minted).toBeGreaterThan(0);
    expect(tokens.revoked).toBe(tokens.minted);

    // MCP in GitHub mode: get_change_status({ github: "owner/repo#123" }).
    const agent = await createAgent(app, human.cookie);
    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, { fetch: fetchVia(app) });
    try {
      const status = await mcp.tools.get_change_status({ github: "acme/widgets#7" });
      if (status.isError) throw new Error(JSON.stringify(status.content));
      expect(status.structuredContent.change).toMatchObject({ id: changeId, headSha: head, status: "awaiting-review" });
      const unknown = await mcp.tools.get_change_status({ github: "acme/other#1" });
      expect(unknown.isError).toBe(true);
    } finally {
      await mcp.client.close();
    }
  });
});
