/**
 * The dashboard checklist's state (`GET /api/v1/me/getting-started`): each step ticks from real
 * rows, scoped to the caller's own memberships and agents.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GettingStartedSchema } from "../src/services/getting-started.js";
import { changeFixture, repoFixture, runFixture, store } from "./fixtures.js";
import { call, createAgent, json, makeApp, signUpHuman } from "./http.js";

async function state(app: ReturnType<typeof makeApp>["app"], cookie: string) {
  const res = await call(app, "GET", "/api/v1/me/getting-started", { cookie });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return GettingStartedSchema.parse(await json(res));
}

async function onboardingRow(
  projectId: string,
  principalId: string,
  over: Record<string, unknown>,
) {
  const row = {
    template: "workers-api",
    source: "template",
    bootstrap_change_id: null,
    created_at: new Date().toISOString(),
    outcome: null,
    ms_to_green: null,
    ms_to_preview: null,
    evidence_at: null,
    preview_ready_at: null,
    ...over,
  };
  await env.DB.prepare(
    "INSERT INTO project_onboarding (project_id, template, source, principal_id, bootstrap_change_id, created_at, outcome, ms_to_green, ms_to_preview, evidence_at, preview_ready_at, ms_to_respond) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 900)",
  )
    .bind(
      projectId,
      row.template,
      row.source,
      principalId,
      row.bootstrap_change_id,
      row.created_at,
      row.outcome,
      row.ms_to_green,
      row.ms_to_preview,
      row.evidence_at,
      row.preview_ready_at,
    )
    .run();
}

describe("getting started", () => {
  it("a brand-new account has nothing ticked", async () => {
    const { app } = makeApp();
    const ada = await signUpHuman(app, "Ada");
    expect(await state(app, ada.cookie)).toEqual({
      projects: 0,
      agent: { connected: false, name: null },
      firstGreen: null,
      latestBootstrap: null,
      repo: { connected: false, via: null },
    });
  });

  it("is humans only and needs a session", async () => {
    const { app } = makeApp();
    expect((await call(app, "GET", "/api/v1/me/getting-started")).status).toBe(401);
    const ada = await signUpHuman(app, "Ada");
    const agent = await createAgent(app, ada.cookie);
    const res = await call(app, "GET", "/api/v1/me/getting-started", { token: agent.token });
    expect(res.status).toBe(403);
  });

  it("ticks the agent once the human owns one with a live token; revoking it unticks", async () => {
    const { app } = makeApp();
    const ada = await signUpHuman(app, "Ada");
    const agent = await createAgent(app, ada.cookie);
    const on = await state(app, ada.cookie);
    expect(on.agent).toEqual({ connected: true, name: agent.principal.name });
    // Someone else's agent never counts.
    const bob = await signUpHuman(app, "Bob");
    expect((await state(app, bob.cookie)).agent.connected).toBe(false);
    const revoked = await call(app, "DELETE", `/api/v1/principals/${agent.principal.id}/tokens`, {
      cookie: ada.cookie,
      headers: { "idempotency-key": "revoke-getting-started-1" },
    });
    expect(revoked.status).toBe(200);
    expect((await state(app, ada.cookie)).agent.connected).toBe(false);
  });

  it("follows the first bootstrap from running to green, with its preview", async () => {
    const { app } = makeApp();
    const ada = await signUpHuman(app, "Ada");
    const s = store();
    const repo = repoFixture({
      template: "workers-api",
      claim: { status: "claimed", ownerId: ada.principal.id, expiresAt: null },
    });
    await s.insertRepo(repo);
    const created = new Date(Date.now() - 40_000).toISOString();
    await onboardingRow(repo.id, ada.principal.id, {
      bootstrap_change_id: "chboot1",
      created_at: created,
    });
    const running = await state(app, ada.cookie);
    expect(running.projects).toBe(1);
    expect(running.firstGreen).toBeNull();
    expect(running.latestBootstrap).toMatchObject({
      projectId: repo.id,
      projectName: repo.name,
      changeId: "chboot1",
      status: "running",
      msToFirstGreen: null,
    });
    expect(running.latestBootstrap?.previewUrl).toBe("https://p-chboot1-pv.resynapse.dev");

    await env.DB.prepare(
      "UPDATE project_onboarding SET outcome = 'green', ms_to_green = 31000, ms_to_preview = 38000, preview_ready_at = ?, evidence_at = ? WHERE project_id = ?",
    )
      .bind(new Date().toISOString(), new Date().toISOString(), repo.id)
      .run();
    const green = await state(app, ada.cookie);
    expect(green.latestBootstrap?.status).toBe("green");
    expect(green.firstGreen).toMatchObject({
      projectId: repo.id,
      changeId: "chboot1",
      msToFirstGreen: 38_000,
    });
    expect(green.firstGreen?.previewUrl).toBe(green.latestBootstrap?.previewUrl);
    // Another human, not a member, sees none of it.
    const bob = await signUpHuman(app, "Bob");
    expect(await state(app, bob.cookie)).toMatchObject({ projects: 0, firstGreen: null });
  });

  it("a passed CI run counts as the first green, and an imported repo brings a repo in", async () => {
    const { app } = makeApp();
    const ada = await signUpHuman(app, "Ada");
    const s = store();
    const repo = repoFixture({
      importedFrom: "https://github.com/acme/widgets",
      claim: { status: "claimed", ownerId: ada.principal.id, expiresAt: null },
    });
    await s.insertRepo(repo);
    expect((await state(app, ada.cookie)).repo).toEqual({ connected: true, via: "import" });
    const change = changeFixture(repo.id, ada.principal.id);
    await s.insertChange(change);
    await s.upsertRun(runFixture(change.id, { status: "failed" }));
    expect((await state(app, ada.cookie)).firstGreen).toBeNull();
    await s.upsertRun(runFixture(change.id));
    expect((await state(app, ada.cookie)).firstGreen).toMatchObject({
      projectId: repo.id,
      changeId: change.id,
      previewUrl: null,
    });
  });
});
