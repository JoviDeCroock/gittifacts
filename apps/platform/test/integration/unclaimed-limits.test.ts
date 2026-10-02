/**
 * O3 hard limits on unclaimed projects, end to end: CI/workspace/preview egress, clamped CI runs,
 * quotas (CI minutes, storage, Artifacts operations; per project and per IP), and that nothing
 * reaches production or auto-merges. Real: app, MCP, D1, coordinator facade, ChangeCoordinator
 * (+ usage settlement), ChangeWorkflow, PushRouter, ProjectLedger, PreviewHost, the preview
 * gateway. Fake: Artifacts, CI containers, preview container, model (./fakes.ts).
 */
import { introspectWorkflow, introspectWorkflowInstance, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { bootstrapChangeIdFor, changeWorkflowId, ciRunIdFor } from "@app/coordinator";
import type { ProjectCreated } from "@app/mcp";
import { createPlatformClient } from "@app/mcp/client";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { UnclaimedLimitError } from "../../src/limits/refusals.js";
import { UNCLAIMED_BANNER } from "../../src/previews/pages.js";
import { store } from "../fixtures.js";
import { ORIGIN } from "../http.js";
import { type IntegrationFakes, NAMESPACE, resetIntegrationFakes } from "./fakes.js";
import { platformApp } from "./harness.js";
import { previewFakes, resetPreviewFakes } from "./preview-fakes.js";
import {
  createUnclaimed,
  fetchWith,
  freshIp,
  request,
  resetSharedLimiters,
} from "./unclaimed-helpers.js";
import { resetFakeWorkspaces } from "./workspace-fakes.js";

let fakes: IntegrationFakes;
beforeEach(async () => {
  await resetSharedLimiters();
  fakes = resetIntegrationFakes();
  resetPreviewFakes();
  resetFakeWorkspaces();
});

async function until<T>(
  what: string,
  fn: () => Promise<T | undefined> | T | undefined,
  ms = 20_000,
) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const ledger = (name: string) => env.PROJECT_LEDGER.getByName(name);
const at = () => Date.now();

/** Push one commit to the first Change's fork and route the Artifacts push event. */
async function pushFirstChange(p: ProjectCreated) {
  const changeId = p.remote?.changeId as string;
  const fork = `task-${changeId}`;
  const base = fakes.git.head(fork) as string;
  const head = fakes.git.commit(fork, "main", { "src/index.ts": "export default {};\n" });
  const id = `push-${head}`;
  await using router = await introspectWorkflowInstance(env.PUSH_ROUTER, id);
  await env.PUSH_ROUTER.create({
    id,
    params: {
      type: "cf.artifacts.repo.pushed",
      source: { type: "artifacts.repo", namespace: NAMESPACE, repoName: fork },
      payload: { ref: "refs/heads/main", before: base, after: head },
    },
  });
  await router.waitForStatus("complete");
  return { changeId, head, instanceId: changeWorkflowId(changeId, head) };
}

describe("egress and CI limits of unclaimed projects", () => {
  it("CI: registries-only, clamped minutes/logs/artifacts/instance, read-only global cache; usage settled", async () => {
    const app = platformApp();
    await using workflows = await introspectWorkflow(env.CHANGE_WORKFLOW);
    await workflows.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const p = await createUnclaimed(app, { template: "workers-api", name: "egress" });
    const head = fakes.git.head("egress") as string;
    const runId = ciRunIdFor(changeWorkflowId(bootstrapChangeIdFor(p.projectId), head));
    const run = await until("the bootstrap run", () => fakes.ci.runs.get(runId));
    expect(run.request).toMatchObject({
      network: "registries-only",
      cache: { global: "read-only" },
      limits: { maxMinutes: 10, maxLogBytes: 2 * 1024 * 1024, instance: "standard-2" },
    });
    // 10 minutes are reserved while it runs; settled to what it used when it finishes.
    expect(
      await ledger(p.projectId).counters({
        metrics: [{ metric: "ci-minutes", period: "day" }],
        atMs: at(),
      }),
    ).toEqual({ "ci-minutes": 10 });
    await fakes.ci.finish(env, runId);
    const used = await until("settlement", async () => {
      const c = await ledger(p.projectId).counters({
        metrics: [
          { metric: "ci-minutes", period: "day" },
          { metric: "storage-bytes", period: "total" },
        ],
        atMs: at(),
      });
      return c["ci-minutes"] !== 10 ? c : undefined;
    });
    expect(used).toEqual({ "ci-minutes": 0.1, "storage-bytes": 64 + 1024 });

    // The preview: no internet, and the banner says the project is unclaimed and not verified.
    const preview = await until("the preview to start", () => previewFakes().starts[0]);
    expect(preview.enableInternet).toBe(false);
    const page = await until("the preview page", async () => {
      const res = await SELF.fetch(p.previewUrl as string, { headers: { accept: "text/html" } });
      const html = await res.text();
      return res.status === 200 && html.includes("Hello from") ? html : undefined;
    });
    expect(page).toContain(UNCLAIMED_BANNER);
    expect(page).toContain("UNCLAIMED");
  });

  it("workspaces: always registries-only for unclaimed projects", async () => {
    const app = platformApp();
    const p = await createUnclaimed(app);
    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, p.token as string, {
      fetch: fetchWith(app),
    });
    try {
      const opened = await mcp.tools.open_workspace({ changeId: p.remote?.changeId as string });
      if (opened.isError) throw new Error(JSON.stringify(opened.content));
      expect(opened.structuredContent.network).toBe("registries-only");
    } finally {
      await mcp.client.close();
    }
  });
});

type Envelope = {
  error: {
    code: string;
    message: string;
    fix: { explanation: string };
    details?: Record<string, unknown>;
  };
};

const startChange = (app: ReturnType<typeof platformApp>, p: ProjectCreated) =>
  request(app, "POST", "/api/v1/changes", {
    token: p.token as string,
    body: { repoId: p.projectId, title: "More work", category: "feature" },
  });

describe("quotas stop work with quota-exceeded and the claim link", () => {
  it("CI minutes: no new Change or push token, and a pushed head's CI never starts (the Change fails with the reason)", async () => {
    const app = platformApp();
    await using workflows = await introspectWorkflow(env.CHANGE_WORKFLOW);
    await workflows.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const p = await createUnclaimed(app);
    await ledger(p.projectId).charge({
      metric: "ci-minutes",
      amount: 60,
      limit: null,
      period: "day",
      atMs: at(),
    });

    const refused = await startChange(app, p);
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as Envelope;
    expect(body.error).toMatchObject({
      code: "quota-exceeded",
      details: { quota: "ci-minutes", scope: "project" },
    });
    expect(body.error.fix.explanation).toContain(p.claimUrl as string);
    const grant = await request(app, "POST", `/api/v1/changes/${p.remote?.changeId}/token`, {
      token: p.token as string,
    });
    expect(grant.status).toBe(429);

    // The agent already holds a push grant: it pushes anyway. CI is refused before any container.
    const { changeId, instanceId } = await pushFirstChange(p);
    const runId = ciRunIdFor(instanceId);
    const change = await until("the change to fail", async () => {
      const c = await store().getChange(changeId);
      return c?.status === "failing" ? c : undefined;
    });
    expect(change.status).toBe("failing");
    expect(fakes.ci.runs.has(runId)).toBe(false);
    const run = await store().getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.map((s) => s.name)).toEqual(["unclaimed-limits"]);
    const log = await env.CI_BUCKET.get(`ci-logs/${runId}/unclaimed-limits.log`);
    expect(await log?.text()).toMatch(/CI minutes.*claim/s);
    const audit = await store().auditTimeline("global", `repo:${p.projectId}`);
    expect(audit.map((e) => e.action)).toContain("limit.hit");
  });

  it("storage: per project, and per creating IP across its projects", async () => {
    const app = platformApp();
    const from = { ip: freshIp() };
    const a = await createUnclaimed(app, { template: "static-site" }, { from });
    const b = await createUnclaimed(app, { template: "static-site" }, { from });
    await ledger(a.projectId).add({
      metric: "storage-bytes",
      amount: 200 * 1024 * 1024,
      period: "total",
      atMs: at(),
    });
    const full = await startChange(app, a);
    expect(full.status).toBe(429);
    expect(((await full.json()) as Envelope).error.details).toMatchObject({
      quota: "storage-bytes",
      scope: "project",
    });
    expect((await startChange(app, b)).status).toBe(201);

    const row = await store().db.run(
      sql`SELECT creator_ip_hash AS h FROM project_claims WHERE repo_id = ${b.projectId}`,
    );
    const ipHash = (row.results[0] as { h: string }).h;
    await ledger(`ip:${ipHash}`).add({
      metric: "storage-bytes",
      amount: 500 * 1024 * 1024,
      period: "total",
      atMs: at(),
    });
    const shared = await startChange(app, b);
    expect(shared.status).toBe(429);
    expect(((await shared.json()) as Envelope).error.details).toMatchObject({
      quota: "storage-bytes",
      scope: "ip",
    });
  });

  it("Artifacts operations: forks and tokens are counted per day", async () => {
    const app = platformApp();
    const p = await createUnclaimed(app);
    const ops = await ledger(p.projectId).counters({
      metrics: [{ metric: "artifacts-ops", period: "day" }],
      atMs: at(),
    });
    // The first Change's fork + token, and the bootstrap CI checkout.
    expect(ops["artifacts-ops"]).toBeGreaterThanOrEqual(2);
    await ledger(p.projectId).charge({
      metric: "artifacts-ops",
      amount: 300,
      limit: null,
      period: "day",
      atMs: at(),
    });
    const res = await request(app, "POST", `/api/v1/changes/${p.remote?.changeId}/token`, {
      token: p.token as string,
    });
    expect(res.status).toBe(429);
    expect(((await res.json()) as Envelope).error.details).toMatchObject({
      quota: "artifacts-ops",
    });
  });

  it("workspaces: the unclaimed daily sandbox quota", async () => {
    const app = platformApp();
    const p = await createUnclaimed(app);
    await ledger(p.projectId).recordUsage({
      workspaceId: "ws-x",
      cpuSeconds: 30 * 60,
      containerSeconds: 30 * 60,
      atMs: at(),
    });
    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, p.token as string, {
      fetch: fetchWith(app),
    });
    try {
      const r = await mcp.tools.open_workspace({ changeId: p.remote?.changeId as string });
      expect(r.isError).toBe(true);
      const text = JSON.stringify(r.content);
      expect(text).toContain("quota-exceeded");
      expect(text).toContain("claim");
    } finally {
      await mcp.client.close();
    }
  });
});

describe("never production, never auto-merge", () => {
  it("the store refuses a deploy target on an unclaimed repo (403 unclaimed-limit)", async () => {
    const app = platformApp();
    const p = await createUnclaimed(app);
    const err = await store()
      .updateRepo(p.projectId, { deployTarget: "prod-worker" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnclaimedLimitError);
    const { toErrorResponse } = await import("../../src/errors.js");
    expect(toErrorResponse(err)).toMatchObject({
      status: 403,
      body: { error: { code: "unclaimed-limit" } },
    });
  });

  it("even with Lane 0 and a deploy target forced into D1, a green change waits for a human and never rolls out", async () => {
    const app = platformApp();
    await using workflows = await introspectWorkflow(env.CHANGE_WORKFLOW);
    await workflows.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const p = await createUnclaimed(app);
    // Simulate a bug elsewhere that bypassed the store guard.
    await env.DB.prepare(
      "UPDATE repos SET deploy_target = 'prod-worker', policy = json_set(policy, '$.lane0Enabled', json('true'), '$.autoMergeVerifiedReverts', json('true')) WHERE id = ?",
    )
      .bind(p.projectId)
      .run();
    const { changeId, instanceId } = await pushFirstChange(p);
    const runId = ciRunIdFor(instanceId);
    await until("CI to start", () => fakes.ci.runs.get(runId));
    expect(fakes.ci.runs.get(runId)?.request.network).toBe("registries-only");
    await fakes.ci.finish(env, runId);
    const waiting = await until("the change to wait for review", async () => {
      const c = await store().getChange(changeId);
      return c?.status === "awaiting-review" || c?.status === "queued" || c?.status === "merged"
        ? c
        : undefined;
    });
    expect(waiting.status).toBe("awaiting-review");
    // The audit entry lands just after the status flips.
    const actions = await until("change.review-requested", async () => {
      const a = (await store().auditTimeline("global", `change:${changeId}`)).map((e) => e.action);
      return a.includes("change.review-requested") ? a : undefined;
    });
    expect(actions).not.toContain("change.queued");
    expect(actions).not.toContain("change.rollout-started");
  });
});

describe("no API can give an unclaimed project secrets, custom domains or a deploy target", () => {
  it("the OpenAPI document and the MCP tools have no such inputs", async () => {
    const app = platformApp();
    const doc = (await (await request(app, "GET", "/openapi.json")).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    // Input names that would give a project secrets, a custom domain or a production target.
    const forbidden =
      /"(secrets?|env(ironment)?Vars?|custom_?domains?|domains?|hostnames?|deploy_?target|workers?_?script|production)":/i;
    for (const [path, ops] of Object.entries(doc.paths)) {
      if (path.startsWith("/api/oauth") || path.includes("/oauth/")) continue; // OAuth client_secret is protocol, not a project secret
      expect(path).not.toMatch(/secret|domain|deploy-target/i);
      for (const op of Object.values(ops)) {
        const body = JSON.stringify((op as { requestBody?: unknown }).requestBody ?? {});
        expect(body, `${path}`).not.toMatch(forbidden);
      }
    }
    const p = await createUnclaimed(app);
    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, p.token as string, {
      fetch: fetchWith(app),
    });
    try {
      const tools = await mcp.listTools();
      expect(JSON.stringify(tools.map((t) => [t.name, t.inputSchema]))).not.toMatch(forbidden);
    } finally {
      await mcp.client.close();
    }
  });
});
