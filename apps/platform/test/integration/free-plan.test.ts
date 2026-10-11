/**
 * The free plan and the spend breaker, end to end (src/limits/plans.ts, src/limits/plan-gate.ts,
 * src/spend/*): claimed projects' CI clamped and refused per project and per account, the daily
 * AI budget, preview metering and limits, and the breaker stopping new paid work (but not the
 * merge queue) until an admin resumes it.
 *
 * Real: app, D1, ChangeCoordinator (+ settlement, spend), ChangeWorkflow, PushRouter,
 * ProjectLedger, PreviewHost, AuditLog. Fake: Artifacts, CI containers, preview container.
 */
import { introspectWorkflow, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  bootstrapChangeIdFor,
  type CiEngine,
  type CiRunRequest,
  changeWorkflowId,
  ciRunIdFor,
} from "@app/coordinator";
import type { ProjectCreated } from "@app/mcp";
import { createPlatformClient } from "@app/mcp/client";
import { beforeEach, describe, expect, it } from "vitest";
import { DoAudit } from "../../src/audit/audit.js";
import { PLAN_STEP, withUnclaimedLimits } from "../../src/limits/ci-quota.js";
import { AI_USD_MICROS, PREVIEW_MS } from "../../src/limits/plan-gate.js";
import { previewIdFor } from "../../src/previews/ids.js";
import { PlatformPreviews } from "../../src/previews/port.js";
import { runSpendWatch } from "../../src/spend/breaker.js";
import { recordSpend, SPEND_LEDGER, spendOn } from "../../src/spend/meter.js";
import { containerUsd } from "../../src/spend/prices.js";
import { store } from "../fixtures.js";
import { createAgent, ORIGIN, signUpHuman } from "../http.js";
import { type IntegrationFakes, resetIntegrationFakes } from "./fakes.js";
import { platformApp } from "./harness.js";
import { fakeBrowser, previewFakes, resetPreviewFakes } from "./preview-fakes.js";
import { fetchWith, request, resetSharedLimiters } from "./unclaimed-helpers.js";
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
const day = async (name: string, metric: string) =>
  (await ledger(name).counters({ metrics: [{ metric, period: "day" }], atMs: Date.now() }))[metric];

type App = ReturnType<typeof platformApp>;

/** A claimed project (a human's) from a template: its bootstrap CI run starts at once. */
async function claimedProject(app: App, cookie: string, name: string) {
  const res = await request(app, "POST", "/api/v1/projects", {
    cookie,
    body: { template: "workers-api", name },
  });
  const p = (await res.json()) as ProjectCreated & { error?: unknown };
  expect(res.status, JSON.stringify(p.error)).toBe(201);
  const head = fakes.git.head(name) as string;
  const runId = ciRunIdFor(changeWorkflowId(bootstrapChangeIdFor(p.projectId), head));
  return { p, runId };
}

/** The run's refusal (a failed run whose only step is the plan's), once the Change records it. */
async function refusedRun(runId: string) {
  const run = await until("the refused run", async () => {
    const r = await store().getRun(runId);
    return r?.status === "failed" ? r : undefined;
  });
  expect(fakes.ci.runs.has(runId)).toBe(false);
  expect(run.steps.map((s) => s.name)).toEqual([PLAN_STEP]);
  const log = await env.CI_BUCKET.get(`ci-logs/${runId}/${PLAN_STEP}.log`);
  return (await log?.text()) ?? "";
}

async function fastWorkflows() {
  const workflows = await introspectWorkflow(env.CHANGE_WORKFLOW);
  await workflows.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  return workflows;
}

describe("the free plan: CI", () => {
  it("clamps a claimed project's run, settles container-minutes per project and account, and refuses past either day", async () => {
    const app = platformApp();
    await using _wf = await fastWorkflows();
    const human = await signUpHuman(app);
    const account = `account:${human.principal.id}`;
    const name = `fp-${crypto.randomUUID().slice(0, 8)}`;
    const { p, runId } = await claimedProject(app, human.cookie, name);
    const run = await until("the bootstrap run", () => fakes.ci.runs.get(runId));
    expect(run.request.limits).toMatchObject({ maxMinutes: 30, instance: "standard-2" });
    expect(run.request.network).not.toBe("registries-only");
    // Nothing is held while it runs; its container-minutes count when it finishes.
    expect(await day(p.projectId, "ci-minutes")).toBe(0);
    await fakes.ci.finish(env, runId);
    await until("settlement", async () =>
      ((await day(account, "ci-minutes")) ?? 0) > 0 ? true : undefined,
    );
    expect(await day(p.projectId, "ci-minutes")).toBe(0.1);
    expect(await day(account, "ci-minutes")).toBe(0.1);

    // Runs don't hold minutes, so concurrent ones never refuse each other; the last run of the
    // day gets what is left of it; past the project's 120 container-minutes nothing starts.
    const asked: Array<{ runId: string; maxMinutes: number | undefined }> = [];
    const inner: CiEngine = {
      status: (id) => fakes.ci.status(id),
      cancel: (id, why) => fakes.ci.cancel(id, why),
      restartFrom: () => fakes.ci.restartFrom(),
      start: async (r) => {
        asked.push({ runId: r.runId, maxMinutes: r.limits?.maxMinutes });
        return { runId: r.runId };
      },
    };
    const gate = withUnclaimedLimits({ ci: inner, audit: new DoAudit(env) }, env).ci;
    const changeId = bootstrapChangeIdFor(p.projectId);
    const startRun = (id: string) => gate.start({ runId: id, changeId } as CiRunRequest);
    await Promise.all([
      startRun("par-1"),
      startRun("par-2"),
      startRun("par-3"),
      startRun("par-4"),
      startRun("par-5"),
    ]);
    expect(asked.map((a) => a.maxMinutes)).toEqual([30, 30, 30, 30, 30]);
    const atMs = Date.now();
    await ledger(p.projectId).add({ metric: "ci-minutes", amount: 119.4, period: "day", atMs });
    await startRun("last");
    expect(asked.at(-1)).toEqual({ runId: "last", maxMinutes: 1 });
    await ledger(p.projectId).add({ metric: "ci-minutes", amount: 0.5, period: "day", atMs });
    await startRun("refused");
    expect(asked.map((a) => a.runId)).not.toContain("refused");
    expect(await (await env.CI_BUCKET.get(`ci-logs/refused/${PLAN_STEP}.log`))?.text()).toMatch(
      /project .* free-plan ci-minutes quota \(120\/120\)/,
    );

    // The account's day is spent (2 × 120 container-minutes): a second project's CI never starts.
    await ledger(account).add({
      metric: "ci-minutes",
      amount: 240,
      period: "day",
      atMs: Date.now(),
    });
    const second = await claimedProject(app, human.cookie, `${name}-b`);
    const reason = await refusedRun(second.runId);
    expect(reason).toContain("the account that owns project");
    expect(reason).toMatch(/ci-minutes quota \(240\.1\/240\)/);
    expect(reason).toMatch(/resets at \d{4}-\d\d-\d\dT00:00/);

    // Another human's project is untouched by that account's day.
    const other = await signUpHuman(app);
    const third = await claimedProject(app, other.cookie, `${name}-c`);
    await until("the other account's run", () => fakes.ci.runs.get(third.runId));
  });
});

/** An empty claimed project (no CI) and one Change on it. */
async function claimedChange(app: App, cookie: string) {
  const res = await request(app, "POST", "/api/v1/projects", {
    cookie,
    body: { name: `fpc-${crypto.randomUUID().slice(0, 8)}` },
  });
  const p = (await res.json()) as ProjectCreated;
  const started = await request(app, "POST", "/api/v1/changes", {
    cookie,
    body: { repoId: p.projectId, title: "Work", category: "feature" },
  });
  expect(started.status).toBe(201);
  const { change } = (await started.json()) as { change: { id: string } };
  return { repoId: p.projectId, changeId: change.id };
}

describe("the free plan: AI and previews", () => {
  it("model spend is the platform's and the day's: past a project's $0.50 every Change's budget reads as spent", async () => {
    const app = platformApp();
    const human = await signUpHuman(app);
    const a = await claimedChange(app, human.cookie);
    const coordinator = (id: string) => env.COORDINATOR.getByName(id);
    const before = (await spendOn(env, Date.now())).bySource.llm;
    await coordinator(a.changeId).recordSpend({ changeId: a.changeId, usd: 0.2 });
    expect((await spendOn(env, Date.now())).bySource.llm).toBeCloseTo(before + 0.2, 6);
    expect(await day(a.repoId, AI_USD_MICROS)).toBe(200_000);
    expect(await coordinator(a.changeId).spent(a.changeId)).toBeCloseTo(0.2, 6);

    await coordinator(a.changeId).recordSpend({ changeId: a.changeId, usd: 0.3 });
    const b = await request(app, "POST", "/api/v1/changes", {
      cookie: human.cookie,
      body: { repoId: a.repoId, title: "More", category: "feature" },
    });
    const { change } = (await b.json()) as { change: { id: string } };
    // A fresh Change on the same project has spent nothing, but today's budget is gone.
    expect(await coordinator(change.id).spent(change.id)).toBeGreaterThanOrEqual(0.5);
  });

  it("previews are metered while they run, stopped after their boot limit, and paused past the day", async () => {
    const port = new PlatformPreviews({ ...env, BROWSER: fakeBrowser }, store());
    const repoId = `r-${crypto.randomUUID().slice(0, 8)}`;
    const req = (n: number) => ({
      changeId: `c${n}-${repoId}`,
      repoId,
      artifactsRepo: `task-c${n}`,
      headSha: `${n}`.repeat(40),
      snapshots: { build: `snap-${n}` },
      claimed: true,
      template: "workers-api",
    });
    expect((await port.start(req(1))).status).toBe("ready");
    const host = env.PREVIEW_HOST.getByName(previewIdFor(req(1).changeId, req(1).headSha));
    // An hour and a minute later (the free plan's boot limit is 60 minutes):
    const ran = 61 * 60_000;
    await runInDurableObject(host, async (_o, state) => {
      const m = (await state.storage.get("meter")) as { bootedAt: number; since: number };
      await state.storage.put("meter", { ...m, bootedAt: m.bootedAt - ran, since: m.since - ran });
    });
    const before = (await spendOn(env, Date.now())).bySource.preview;
    expect(await runDurableObjectAlarm(host)).toBe(true);
    const preview = (await spendOn(env, Date.now())).bySource.preview - before;
    expect(preview).toBeGreaterThanOrEqual(containerUsd("standard-1", ran) - 1e-6);
    expect(await day(repoId, PREVIEW_MS)).toBeGreaterThanOrEqual(ran);
    expect(
      await runInDurableObject(host, (_o, state) => state.storage.get("meter")),
    ).toBeUndefined();

    // 180 preview-minutes a day: the next boot is refused with the reason, nothing starts.
    await ledger(repoId).add({
      metric: PREVIEW_MS,
      amount: 180 * 60_000,
      period: "day",
      atMs: Date.now(),
    });
    const starts = previewFakes().starts.length;
    const out = await port.start(req(2));
    expect(out).toMatchObject({ status: "error" });
    expect(out.status === "error" ? out.reason : "").toMatch(/preview-minutes/);
    expect(previewFakes().starts.length).toBe(starts);
  });
});

describe("the spend breaker", () => {
  it("past the hard budget: alerts once, refuses new CI (not the merge queue's), workspaces and creation; an admin resumes", async () => {
    const app = platformApp();
    await using _wf = await fastWorkflows();
    const admin = await signUpHuman(app);
    const asAdmin = { cookie: admin.cookie, env: { PLATFORM_ADMINS: admin.principal.id } };
    const spend = ledger(SPEND_LEDGER);
    const over = 25_000_000; // $25 of CI, over the $20 default
    await recordSpend(env, { source: "ci", usd: 25, ref: "test" });
    try {
      const view = await request(app, "GET", "/api/v1/admin/spend", asAdmin);
      expect(view.status).toBe(200);
      expect(await view.json()).toMatchObject({
        level: "hard",
        paused: true,
        softUsd: 5,
        hardUsd: 20,
      });
      expect(
        (await request(app, "GET", "/api/v1/admin/spend", { cookie: admin.cookie })).status,
      ).toBe(403);

      // The cron alerts once per day and level.
      expect(await runSpendWatch(env)).toMatchObject({ level: "hard", paused: true });
      await runSpendWatch(env);
      const alerts = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'platform.spend-hard'",
      ).first<{ n: number }>();
      expect(alerts?.n).toBe(1);

      // New paid work is refused: a claimed project's CI, a workspace, unclaimed creation.
      const { p, runId } = await claimedProject(
        app,
        admin.cookie,
        `brk-${crypto.randomUUID().slice(0, 8)}`,
      );
      expect(await refusedRun(runId)).toMatch(/paused new paid work.*\$20\.00/);
      const agent = await createAgent(app, admin.cookie);
      const mcp = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, {
        fetch: fetchWith(app),
      });
      try {
        const mine = await mcp.tools.start_change({
          repoId: p.projectId,
          title: "Fix",
          category: "fix",
        });
        if (mine.isError) throw new Error(JSON.stringify(mine.content));
        const ws = await mcp.tools.open_workspace({ changeId: mine.structuredContent.change.id });
        expect(ws.isError).toBe(true);
        expect(JSON.stringify(ws.content)).toMatch(/quota-exceeded.*paused new paid work/);
      } finally {
        await mcp.client.close();
      }
      const anon = await request(app, "POST", "/api/v1/projects", { body: {} });
      expect(anon.status).toBe(503);

      // The merge queue still lands approved Changes (its CI port goes through the same gate).
      const started: string[] = [];
      const inner: CiEngine = {
        status: (id) => fakes.ci.status(id),
        cancel: (id, reason) => fakes.ci.cancel(id, reason),
        restartFrom: () => fakes.ci.restartFrom(),
        start: async (r) => {
          started.push(r.runId);
          return { runId: r.runId };
        },
      };
      const gated = (role: "default" | "merge-queue") =>
        withUnclaimedLimits({ ci: inner, audit: new DoAudit(env) }, env, role).ci;
      const landing = { runId: "mq-run", changeId: bootstrapChangeIdFor(p.projectId) };
      await gated("merge-queue").start(landing as CiRunRequest);
      await gated("default").start({ ...landing, runId: "other-run" } as CiRunRequest);
      expect(started).toEqual(["mq-run"]);

      // An admin resumes for the rest of the day.
      const resumed = await request(app, "PUT", "/api/v1/admin/spend-breaker", {
        ...asAdmin,
        body: { mode: "resume" },
      });
      expect(await resumed.json()).toMatchObject({
        level: "hard",
        paused: false,
        resumedBy: admin.principal.id,
      });
      const again = await claimedProject(
        app,
        admin.cookie,
        `brk-${crypto.randomUUID().slice(0, 8)}`,
      );
      await until("CI after resuming", () => fakes.ci.runs.get(again.runId));
    } finally {
      await spend.add({ metric: "usd-micros:ci", amount: -over, period: "day", atMs: Date.now() });
      await request(app, "PUT", "/api/v1/admin/spend-breaker", {
        ...asAdmin,
        body: { mode: "auto" },
      });
    }
  });
});
