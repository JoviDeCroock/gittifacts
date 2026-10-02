/**
 * O3: the claim flow (Turnstile, single use, idempotent, ownership transfer, limits lifted) and
 * TTL expiry (everything deleted except the audit trail), through the real app and D1.
 */
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { bootstrapChangeIdFor, changeWorkflowId, ciRunIdFor } from "@app/coordinator";
import type { ProjectCreated } from "@app/mcp";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DoAudit } from "../../src/audit/audit.js";
import { expireUnclaimedProjects } from "../../src/claim/expire.js";
import { TEST_DUMMY_TOKEN, TEST_SECRET_FAIL } from "../../src/claim/turnstile.js";
import { previews, principals, projectClaims, repos } from "../../src/db/schema.js";
import { store } from "../fixtures.js";
import { createAgent, signUpHuman } from "../http.js";
import { type IntegrationFakes, resetIntegrationFakes } from "./fakes.js";
import { platformApp } from "./harness.js";
import { resetPreviewFakes } from "./preview-fakes.js";
import { createUnclaimed, request, resetSharedLimiters } from "./unclaimed-helpers.js";

let fakes: IntegrationFakes;
beforeEach(async () => {
  await resetSharedLimiters();
  fakes = resetIntegrationFakes();
  resetPreviewFakes();
});

type Envelope = { error: { code: string; fix: { explanation: string } } };
const tokenOf = (p: ProjectCreated) => (p.claimUrl as string).split("/claim/")[1] as string;

async function claim(
  app: ReturnType<typeof platformApp>,
  p: ProjectCreated,
  o: { cookie?: string; token?: string; env?: Record<string, unknown>; turnstile?: string } = {},
) {
  return request(app, "POST", `/api/v1/claims/${tokenOf(p)}`, {
    ...(o.cookie ? { cookie: o.cookie } : {}),
    ...(o.token ? { token: o.token } : {}),
    ...(o.env ? { env: o.env } : {}),
    body: { turnstileToken: o.turnstile ?? TEST_DUMMY_TOKEN },
  });
}

describe("claim flow", () => {
  it("shows the project to anyone with the link; a human + Turnstile claims it once; the agent keeps working, unlimited", async () => {
    const app = platformApp();
    const p = await createUnclaimed(app, { template: "workers-api", name: "claim me" });
    const view = await request(app, "GET", `/api/v1/claims/${tokenOf(p)}`);
    expect(view.status).toBe(200);
    expect(await view.json()).toMatchObject({
      status: "unclaimed",
      project: {
        id: p.projectId,
        name: "claim-me",
        template: "workers-api",
        previewUrl: p.previewUrl,
      },
      createdBy: { kind: "agent", name: expect.stringContaining("Unclaimed agent") },
      claimedBy: null,
      turnstile: { siteKey: "1x00000000000000000000AA" },
      viewer: { signedIn: false },
      claiming: expect.arrayContaining([expect.any(String)]),
      limits: expect.arrayContaining([expect.stringMatching(/registries/i)]),
    });
    expect((await request(app, "GET", "/api/v1/claims/gtc_nope")).status).toBe(404);

    // Not signed in → 401 with a sign-in link; an agent can never claim.
    const anon = await claim(app, p);
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as Envelope).error.fix.explanation).toContain(
      "/signin?next=/claim/",
    );
    expect((await claim(app, p, { token: p.token as string })).status).toBe(403);

    // Turnstile fails → 403 turnstile-failed, nothing changes.
    const human = await signUpHuman(app, "Owner");
    const failed = await claim(app, p, {
      cookie: human.cookie,
      env: { TURNSTILE_SECRET_KEY: TEST_SECRET_FAIL },
    });
    expect(failed.status).toBe(403);
    expect(((await failed.json()) as Envelope).error.code).toBe("turnstile-failed");
    expect((await store().getRepo(p.projectId))?.claim.status).toBe("unclaimed");

    // Passes → the human owns the project and its agent; previews lose the unclaimed banner.
    const ok = await claim(app, p, { cookie: human.cookie });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      status: "claimed",
      ownerId: human.principal.id,
      alreadyClaimed: false,
      next: { repoPath: `/repos/${p.projectId}` },
    });
    const repo = await store().getRepo(p.projectId);
    expect(repo?.claim).toEqual({
      status: "claimed",
      ownerId: human.principal.id,
      expiresAt: null,
    });
    const row = await store()
      .db.select()
      .from(projectClaims)
      .where(eq(projectClaims.repoId, p.projectId))
      .get();
    const agent = await store()
      .db.select()
      .from(principals)
      .where(eq(principals.id, row?.agentPrincipalId ?? ""))
      .get();
    expect(agent).toMatchObject({
      kind: "agent",
      ownerId: human.principal.id,
      repoIds: [p.projectId],
    });
    expect(agent?.scopes.sort()).toEqual(["change:create", "plan:create", "repo:read"]);
    const rows = await store()
      .db.select()
      .from(previews)
      .where(eq(previews.repoId, p.projectId))
      .all();
    expect(rows.every((r) => r.claimed)).toBe(true);
    const audit = await store().auditTimeline("global", `repo:${p.projectId}`);
    expect(audit.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "project.unclaimed-created",
        "project.claim-refused",
        "project.claimed",
      ]),
    );

    // Limits lifted: no quotas reported, no per-token limit, start_change no longer metered.
    const caps = await request(app, "GET", "/api/v1/capabilities", {
      token: p.token as string,
      env: { UNCLAIMED_TOKEN_LIMITER: { limit: async () => ({ success: false }) } },
    });
    expect(caps.status).toBe(200);
    expect(((await caps.json()) as { quotas: { enforced: boolean } }).quotas.enforced).toBe(false);
    await env.PROJECT_LEDGER.getByName(p.projectId).charge({
      metric: "ci-minutes",
      amount: 1000,
      limit: null,
      period: "day",
      atMs: Date.now(),
    });
    const more = await request(app, "POST", "/api/v1/changes", {
      token: p.token as string,
      body: { repoId: p.projectId, title: "After the claim", category: "feature" },
    });
    expect(more.status).toBe(201);

    // Idempotent for the same human (even with a spent Turnstile token); single-use for others.
    const again = await claim(app, p, {
      cookie: human.cookie,
      env: { TURNSTILE_SECRET_KEY: TEST_SECRET_FAIL },
    });
    expect(await again.json()).toMatchObject({ status: "claimed", alreadyClaimed: true });
    const other = await signUpHuman(app, "Latecomer");
    const late = await claim(app, p, { cookie: other.cookie });
    expect(late.status).toBe(409);
    const after = await request(app, "GET", `/api/v1/claims/${tokenOf(p)}`, {
      cookie: human.cookie,
    });
    expect(await after.json()).toMatchObject({
      status: "claimed",
      project: { expiresAt: null },
      claimedBy: { principalId: human.principal.id },
      viewer: { signedIn: true, isClaimer: true },
    });
  });

  it("after a claim, the project's CI gets the claimed tier (open egress, no clamp)", async () => {
    const app = platformApp();
    await using workflows = await introspectWorkflow(env.CHANGE_WORKFLOW);
    await workflows.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const p = await createUnclaimed(app, { template: "workers-api", name: "tiered" });
    const human = await signUpHuman(app);
    expect((await claim(app, p, { cookie: human.cookie })).status).toBe(200);
    const fork = `task-${p.remote?.changeId}`;
    const base = fakes.git.head(fork) as string;
    const head = fakes.git.commit(fork, "main", { "src/x.ts": "export const x = 1;\n" });
    await env.PUSH_ROUTER.create({
      id: `push-${head}`,
      params: {
        type: "cf.artifacts.repo.pushed",
        source: { type: "artifacts.repo", namespace: "gittifacts-eu", repoName: fork },
        payload: { ref: "refs/heads/main", before: base, after: head },
      },
    });
    const runId = ciRunIdFor(changeWorkflowId(p.remote?.changeId as string, head));
    const deadline = Date.now() + 20_000;
    while (!fakes.ci.runs.has(runId) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    expect(fakes.ci.runs.get(runId)?.request).toMatchObject({
      network: "open",
      limits: { maxMinutes: 90 },
    });
  });
});

describe("TTL expiry (cron)", () => {
  const released: string[] = [];
  beforeEach(() => {
    released.length = 0;
  });
  const deps = (nowMs: number, git: { deleteRepo(n: string): Promise<void> } = fakes.git) => ({
    store: store(),
    blobs: env.BLOBS,
    audit: new DoAudit(env),
    git: () => git,
    abandonChange: async (id: string) => {
      await env.COORDINATOR.getByName(id).abandon(id);
    },
    closeWorkspace: async () => {},
    destroyPreview: async (id: string) => {
      await env.PREVIEW_HOST.getByName(id).destroy();
    },
    deleteWorker: async (script: string) => {
      released.push(`worker:${script}`);
    },
    deleteFlagApp: async (appId: string) => {
      released.push(`app:${appId}`);
    },
    now: () => new Date(nowMs),
  });

  it("deletes an expired unclaimed project everywhere except the audit log; claimed and unexpired ones stay", async () => {
    const app = platformApp();
    await using workflows = await introspectWorkflow(env.CHANGE_WORKFLOW);
    await workflows.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const p = await createUnclaimed(app, { template: "workers-api", name: "short-lived" });
    const kept = await createUnclaimed(app, { template: "static-site", name: "kept" });
    const human = await signUpHuman(app);
    expect((await claim(app, kept, { cookie: human.cookie })).status).toBe(200);

    const bootstrapId = bootstrapChangeIdFor(p.projectId);
    const head = fakes.git.head("short-lived") as string;
    const runId = ciRunIdFor(changeWorkflowId(bootstrapId, head));
    const deadline = Date.now() + 20_000;
    while (!fakes.ci.runs.has(runId) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    await fakes.ci.finish(env, runId);
    await env.BLOBS.put(`screenshots/${bootstrapId}/${head.slice(0, 12)}/desktop-index.png`, "png");
    expect((await env.BLOBS.list({ prefix: `ci-logs/${runId}/` })).objects.length).toBeGreaterThan(
      0,
    );

    const expiresAt = Date.parse((await store().getRepo(p.projectId))?.claim.expiresAt ?? "");
    // Not yet due: nothing happens.
    expect(await expireUnclaimedProjects(deps(expiresAt - 60_000))).toEqual([]);

    const results = await expireUnclaimedProjects(deps(expiresAt + 1000));
    expect(results).toEqual([expect.objectContaining({ repoId: p.projectId, ok: true })]);
    expect(fakes.git.deleted).toEqual(
      expect.arrayContaining(["short-lived", `task-${p.remote?.changeId}`]),
    );
    expect(await store().getRepo(p.projectId)).toBeNull();
    expect(await store().getChange(bootstrapId)).toBeNull();
    expect(await store().getChange(p.remote?.changeId as string)).toBeNull();
    for (const prefix of [`ci-logs/${runId}/`, `screenshots/${bootstrapId}/`]) {
      expect((await env.BLOBS.list({ prefix })).objects).toEqual([]);
    }
    const row = await store()
      .db.select()
      .from(projectClaims)
      .where(eq(projectClaims.repoId, p.projectId))
      .get();
    expect(row).toMatchObject({ status: "expired", expiredAt: expect.any(String) });
    expect(
      await store().db.select().from(previews).where(eq(previews.repoId, p.projectId)).all(),
    ).toEqual([]);

    // The token is dead, the claim link says expired, and the audit trail is intact.
    expect((await request(app, "GET", "/api/v1/me", { token: p.token as string })).status).toBe(
      401,
    );
    expect(await (await request(app, "GET", `/api/v1/claims/${tokenOf(p)}`)).json()).toMatchObject({
      status: "expired",
    });
    expect((await claim(app, p, { cookie: human.cookie })).status).toBe(410);
    const audit = (await store().auditTimeline("global", `repo:${p.projectId}`)).map(
      (e) => e.action,
    );
    expect(audit).toEqual(expect.arrayContaining(["project.unclaimed-created", "project.expired"]));

    // The claimed project is untouched, even long after the TTL.
    expect(await expireUnclaimedProjects(deps(expiresAt + 30 * 86_400_000))).toEqual([]);
    expect(await store().getRepo(kept.projectId)).not.toBeNull();
  });

  it("a failed delete leaves the project expiring (no claim can win), and the next run finishes it", async () => {
    const app = platformApp();
    const p = await createUnclaimed(app, { template: "static-site", name: "flaky-delete" });
    const expiresAt = Date.parse((await store().getRepo(p.projectId))?.claim.expiresAt ?? "");
    let fail = true;
    const flaky = {
      deleteRepo: async (n: string) => {
        if (fail) throw new Error("UPSTREAM_UNAVAILABLE");
        await fakes.git.deleteRepo(n);
      },
    };
    const first = await expireUnclaimedProjects(deps(expiresAt + 1000, flaky));
    expect(first).toEqual([
      expect.objectContaining({ ok: false, error: expect.stringContaining("UPSTREAM") }),
    ]);
    const row = await store()
      .db.select()
      .from(projectClaims)
      .where(eq(projectClaims.repoId, p.projectId))
      .get();
    expect(row?.status).toBe("expiring");
    const human = await signUpHuman(app);
    expect((await claim(app, p, { cookie: human.cookie })).status).toBe(410);
    fail = false;
    expect(await expireUnclaimedProjects(deps(expiresAt + 2000, flaky))).toEqual([
      expect.objectContaining({ repoId: p.projectId, ok: true }),
    ]);
    expect(await store().getRepo(p.projectId)).toBeNull();
    await createAgent(app, human.cookie);
  });
  it("deletes a project's Worker, then its own Flagship app (a bound app cannot be deleted)", async () => {
    const app = platformApp();
    const p = await createUnclaimed(app, { template: "static-site", name: "with-app" });
    const expiresAt = Date.parse((await store().getRepo(p.projectId))?.claim.expiresAt ?? "");
    // Unclaimed projects never get a deploy target through the API; write one directly to cover
    // project deletion in general (the Worker goes first, then the app it binds).
    await store()
      .db.update(repos)
      .set({ deployTarget: `gf-${p.projectId}-api`, flagshipAppId: `app-${p.projectId}` })
      .where(eq(repos.id, p.projectId));
    const results = await expireUnclaimedProjects(deps(expiresAt + 1000));
    expect(results).toEqual([
      expect.objectContaining({
        ok: true,
        workerDeleted: `gf-${p.projectId}-api`,
        flagAppDeleted: `app-${p.projectId}`,
      }),
    ]);
    expect(released).toEqual([`worker:gf-${p.projectId}-api`, `app:app-${p.projectId}`]);
    expect(await store().getRepo(p.projectId)).toBeNull();
  });
});
