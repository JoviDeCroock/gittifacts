/**
 * Onboarding's golden path (DECISIONS 2026-10-11), workerd: an agent calls create_project without
 * credentials → the platform drafts the template's sample Plan (author: system) → a human claims
 * the repo and approves the Plan (nobody approved it before: not the platform, not the agent) →
 * the agent builds it on a Change and pushes → CI, signed evidence, a lane → request_review → the
 * human approves → the merge queue lands it with a why note → the getting-started checklist ticks
 * all five steps and time-to-first-merge is recorded.
 *
 * Real: the app, MCP server, auth, D1, the claim flow, ChangeCoordinator + MergeQueue DOs,
 * ChangeWorkflow, BatchRunWorkflow. Fake: Artifacts, CI containers, previews (./fakes.ts).
 */
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { parseCall, TEMPLATES } from "@app/conventions";
import { SYSTEM_PRINCIPAL_ID } from "@app/coordinator";
import { decodeWhyNote, WHY_NOTES_REF } from "@app/evidence";
import { createPlatformClient, type PlatformClient } from "@app/mcp/client";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_DUMMY_TOKEN } from "../../src/claim/turnstile.js";
import { projectOnboarding } from "../../src/db/schema.js";
import { GettingStartedSchema } from "../../src/services/getting-started.js";
import { store } from "../fixtures.js";
import { ORIGIN, signUpHuman } from "../http.js";
import { type IntegrationFakes, NAMESPACE, resetIntegrationFakes } from "./fakes.js";
import { platformApp } from "./harness.js";
import { resetPreviewFakes } from "./preview-fakes.js";
import { createUnclaimed, fetchWith, request, resetSharedLimiters } from "./unclaimed-helpers.js";

let fakes: IntegrationFakes;
beforeEach(async () => {
  await resetSharedLimiters();
  fakes = resetIntegrationFakes();
  resetPreviewFakes();
});

type App = ReturnType<typeof platformApp>;

async function body<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Finish every CI run still going (the bootstrap, the Change, queue batches) until `done`. */
async function driveCi(done: () => Promise<boolean> | boolean, timeout = 30_000): Promise<void> {
  await vi.waitFor(
    async () => {
      for (const [id, run] of [...fakes.ci.runs])
        if (run.status.status === "running") await fakes.ci.finish(env, id);
      expect(await done()).toBe(true);
    },
    { timeout, interval: 50 },
  );
}

async function changeOf(app: App, cookie: string, changeId: string) {
  const res = await request(app, "GET", `/api/v1/changes/${changeId}`, { cookie });
  expect(res.status).toBe(200);
  return (
    await body<{ change: { status: string; lane: number | null; planId: string | null } }>(res)
  ).change;
}

describe("golden path: create_project → sample plan → build → review → merge (workerd)", () => {
  it("a human approves the platform's sample plan, an agent builds it, the queue lands it; the checklist ticks all five and time-to-first-merge is recorded", async () => {
    const app = platformApp();
    await using workflows = await introspectWorkflow(env.CHANGE_WORKFLOW);
    await workflows.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    await using batches = await introspectWorkflow(env.BATCH_RUN_WORKFLOW);
    await batches.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    let mcp: PlatformClient | null = null;
    try {
      // ------------------------------------------------ 1. create_project, no credentials
      const t0 = Date.now();
      const p = await createUnclaimed(app, { template: "workers-api", name: "golden path" });
      const sample = TEMPLATES["workers-api"].samplePlan;
      expect(p.samplePlanId).toMatch(/^plan_sample_[0-9a-f]{24}$/);
      const planId = p.samplePlanId as string;
      const agentToken = p.token as string;

      // nextSteps: reconnect with the token, the first CI, then the golden path (claim → approve →
      // build → lane → review → merge).
      const calls = p.nextSteps.map(
        (s) => parseCall(s.call ?? "")?.tool ?? s.command?.split(" ")[0],
      );
      expect(p.nextSteps[0]?.title).toMatch(/^Reconnect/);
      expect(calls.slice(1, 9)).toEqual([
        "wait_for_change",
        "whoami",
        "get_plan",
        "start_change",
        "git",
        "wait_for_change",
        "request_review",
        "wait_for_change",
      ]);
      expect(p.nextSteps[2]?.why).toContain(p.claimUrl as string);
      expect(p.nextSteps[3]?.why).toContain(`${ORIGIN}/plans/${planId}`);
      expect(parseCall(p.nextSteps[4]?.call ?? "")?.args).toMatchObject({
        repoId: p.repoId,
        planId,
      });

      // The sample Plan: a draft by the platform, the template's task.
      const got = await request(app, "GET", `/api/v1/plans/${planId}`, { token: agentToken });
      expect(got.status).toBe(200);
      expect((await body<{ plan: Record<string, unknown> }>(got)).plan).toMatchObject({
        repoId: p.repoId,
        title: sample.title,
        acceptanceCriteria: sample.acceptanceCriteria,
        scopePaths: sample.scopePaths,
        status: "draft",
        authorId: SYSTEM_PRINCIPAL_ID,
        approvedBy: null,
      });

      // ------------------------------------------------ 2. nobody approves it but a claimer
      const approve = (o: { token?: string; cookie?: string }) =>
        request(app, "POST", `/api/v1/plans/${planId}/approve`, { ...o, body: {} });
      expect((await approve({ token: agentToken })).status).toBe(403);
      const human = await signUpHuman(app, "Grace");
      expect([403, 404]).toContain((await approve({ cookie: human.cookie })).status);
      const claimToken = (p.claimUrl as string).split("/claim/")[1] as string;
      const claimed = await request(app, "POST", `/api/v1/claims/${claimToken}`, {
        cookie: human.cookie,
        body: { turnstileToken: TEST_DUMMY_TOKEN },
      });
      expect(claimed.status).toBe(200);
      const approved = await approve({ cookie: human.cookie });
      expect(approved.status).toBe(200);
      expect((await body<{ plan: Record<string, unknown> }>(approved)).plan).toMatchObject({
        status: "approved",
        approvedBy: human.principal.id,
        authorId: SYSTEM_PRINCIPAL_ID,
      });

      // ------------------------------------------------ 3. the agent builds it on a Change
      mcp = await createPlatformClient(`${ORIGIN}/mcp`, agentToken, { fetch: fetchWith(app) });
      const started = await mcp.tools.start_change({
        repoId: p.repoId,
        planId,
        title: sample.title,
        category: "feature",
        idempotencyKey: "golden-path-1",
      });
      if (started.isError) throw new Error(JSON.stringify(started.content));
      const changeId = started.structuredContent.change.id;
      const forkName = `task-${changeId}`;
      const base = fakes.git.head(forkName) as string;
      const app0 = fakes.git.filesAt(base)["src/app.ts"] ?? "";
      const head = fakes.git.commit(forkName, "main", {
        "src/app.ts": app0.replace(
          '"/health": () => json({ ok: true }),',
          '"/health": () => json({ ok: true }),\n  "/version": () => json({ version: "0.0.0" }),',
        ),
        "test/version.test.ts":
          'import { expect, it } from "vitest";\nimport { handle } from "../src/app.js";\n\nit("GET /version", async () => {\n  const res = await handle(new Request("https://x.test/version"));\n  expect(await res.json()).toEqual({ version: "0.0.0" });\n});\n',
      });
      await env.PUSH_ROUTER.create({
        id: `push-${head}`,
        params: {
          type: "cf.artifacts.repo.pushed",
          source: { type: "artifacts.repo", namespace: NAMESPACE, repoName: forkName },
          payload: { ref: "refs/heads/main", before: base, after: head },
        },
      });
      // CI (and the bootstrap's) finish; evidence is signed; the lane is set and a human is asked.
      await driveCi(
        async () => (await changeOf(app, human.cookie, changeId)).status === "awaiting-review",
      );
      const graded = await changeOf(app, human.cookie, changeId);
      expect(graded.planId).toBe(planId);
      expect(graded.lane).not.toBeNull();
      const evidence = await mcp.tools.get_evidence({ changeId });
      if (evidence.isError) throw new Error(JSON.stringify(evidence.content));

      // ------------------------------------------------ 4. review: the agent asks, the human approves
      const asked = await mcp.tools.request_review({ changeId });
      if (asked.isError) throw new Error(JSON.stringify(asked.content));
      const self = await request(app, "POST", `/api/v1/changes/${changeId}/review`, {
        token: agentToken,
        body: { decision: "approve" },
      });
      expect(self.status).toBe(403);
      const review = await request(app, "POST", `/api/v1/changes/${changeId}/review`, {
        cookie: human.cookie,
        body: { decision: "approve" },
      });
      expect(review.status).toBe(200);

      // ------------------------------------------------ 5. the merge queue lands it
      await driveCi(() => {
        const main = fakes.git.head(p.name);
        return main !== null && fakes.git.filesAt(main)["test/version.test.ts"] !== undefined;
      });
      const merged = await mcp.tools.wait_for_change({ changeId, until: "merged", timeoutSec: 30 });
      if (merged.isError) throw new Error(JSON.stringify(merged.content));
      expect(merged.structuredContent).toMatchObject({ reached: true });
      const notes = [...(fakes.git.repo(p.name).notes.get(WHY_NOTES_REF) ?? new Map()).values()];
      const why = notes.map((t) => decodeWhyNote(t)).find((n) => n.changeId === changeId);
      expect(why?.plan).toMatchObject({
        id: planId,
        approvedBy: expect.objectContaining({ id: human.principal.id, kind: "human" }),
      });

      // ------------------------------------------------ 6. time-to-first-merge, and the checklist
      const elapsed = Date.now() - t0;
      const row = await vi.waitFor(async () => {
        const r = await store()
          .db.select()
          .from(projectOnboarding)
          .where(eq(projectOnboarding.projectId, p.repoId))
          .get();
        expect(r?.msToFirstMerge).not.toBeNull();
        return r;
      });
      expect(row).toMatchObject({ samplePlanId: planId, firstMergeChangeId: changeId });
      expect(row?.msToFirstMerge).toBeGreaterThan(0);
      expect(row?.msToFirstMerge).toBeLessThanOrEqual(elapsed + 1000);

      const gs = await request(app, "GET", "/api/v1/me/getting-started", {
        cookie: human.cookie,
      });
      expect(gs.status).toBe(200);
      const state = GettingStartedSchema.parse(await gs.json());
      // 1. a repo, 2. an agent (the claimed project's agent is now the human's), 3. the plan,
      // 4. the review, 5. the first merge with its time.
      expect(state.projects).toBe(1);
      expect(state.agent.connected).toBe(true);
      expect(state.plan).toMatchObject({ approved: true, planId, sample: true });
      expect(state.review).toMatchObject({ approved: true, changeId });
      expect(state.firstMerge).toMatchObject({
        projectId: p.repoId,
        changeId,
        title: sample.title,
        msToFirstMerge: row?.msToFirstMerge,
      });

      // The internal dashboard reports it next to time-to-first-green.
      const report = await request(app, "GET", "/internal/ttfg?days=1", {
        cookie: human.cookie,
        env: { PLATFORM_ADMINS: human.principal.id, CF_API_TOKEN: "" },
      });
      expect(report.status).toBe(200);
      const r = await body<{ firstMerge: { merged: number; p50Ms: number | null } }>(report);
      expect(r.firstMerge.merged).toBeGreaterThanOrEqual(1);
      expect(r.firstMerge.p50Ms).not.toBeNull();
    } finally {
      await mcp?.client.close();
    }
  }, 90_000);
});
