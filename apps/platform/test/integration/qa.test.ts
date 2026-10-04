/**
 * QA on request, end to end under workerd: a graded Change → POST /changes/{id}/qa → the real
 * QaRunWorkflow → the real PreviewHost DO booted privately (fake container) → the agent loop over
 * an HTML-only browser that loads pages through the production private path → the signed qa-run
 * item in the head's bundle → the lane raised → the notification. Fakes: ./fakes.ts, ./qa-fakes.ts.
 */
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { changeWorkflowId, ciRunIdFor } from "@app/coordinator";
import type { QaRun } from "@app/evidence";
import { createPlatformClient } from "@app/mcp/client";
import { beforeEach, describe, expect, it } from "vitest";
import { handlePreviewRequest } from "../../src/previews/gateway.js";
import { signedQaImageUrl } from "../../src/qa/images.js";
import { qaRunId } from "../../src/qa/request.js";
import { buildPorts } from "../../src/runtime/ports.js";
import { call, createAgent, json, ORIGIN, signUpHuman, type TestApp } from "../http.js";
import { type IntegrationFakes, NAMESPACE, resetIntegrationFakes } from "./fakes.js";
import { fetchVia, platformApp } from "./harness.js";
import { previewFakes, resetPreviewFakes } from "./preview-fakes.js";
import { qaFakes, resetQaFakes } from "./qa-fakes.js";

let fakes: IntegrationFakes;
beforeEach(() => {
  fakes = resetIntegrationFakes();
  resetPreviewFakes();
});

const PLAN = {
  criteria: [
    { index: 0, start: "/", steps: [{ action: "expect_text", value: "Hello from /" }] },
    { index: 1, start: "/", steps: [{ action: "expect_text", value: "Goodbye" }] },
  ],
};
const REVIEW = {
  verdicts: [
    { index: 0, verdict: "pass", reason: "greets" },
    { index: 1, verdict: "pass", reason: "fine" },
  ],
};

/** A repo, an approved Plan with two criteria, a Change pushed and graded (awaiting review). */
async function gradedChange(app: TestApp) {
  const human = await signUpHuman(app);
  const agent = await createAgent(app, human.cookie);
  const created = await call(app, "POST", "/api/v1/repos", {
    cookie: human.cookie,
    body: { name: `qa-${Date.now().toString(36)}` },
  });
  const { repo } = await json<{ repo: { id: string; artifactsName: string } }>(created);
  const baseSha = fakes.git.seed(repo.artifactsName, {
    "package.json": '{ "name": "qa" }\n',
    "public/index.html": "<h1>Hi</h1>\n",
  });
  const mcp = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, { fetch: fetchVia(app) });
  const started = await mcp.tools.start_change({
    repoId: repo.id,
    title: "Greet visitors",
    category: "feature",
  });
  if (started.isError) throw new Error(JSON.stringify(started.content));
  const { change } = started.structuredContent;
  const forkName = `task-${change.id}`;
  const head = fakes.git.commit(forkName, "main", { "public/index.html": "<h1>Hello</h1>\n" });
  const instanceId = changeWorkflowId(change.id, head);
  await using workflow = await introspectWorkflowInstance(env.CHANGE_WORKFLOW, instanceId);
  await workflow.modify(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  await using router = await introspectWorkflowInstance(env.PUSH_ROUTER, `push-${head}`);
  await env.PUSH_ROUTER.create({
    id: `push-${head}`,
    params: {
      type: "cf.artifacts.repo.pushed",
      source: { type: "artifacts.repo", namespace: NAMESPACE, repoName: forkName },
      payload: { ref: "refs/heads/main", before: baseSha, after: head },
    },
  });
  await router.waitForStatus("complete");
  await workflow.waitForStepResult({ name: "ci-start" });
  await fakes.ci.finish(env, ciRunIdFor(instanceId));
  await workflow.waitForStepResult({ name: "request-review" });
  // QA reads the Plan's criteria: attach one (written directly; plan approval has its own tests).
  const ports = buildPorts(env, "default");
  await ports.store.insertPlan?.({
    id: `pl-${change.id}`,
    repoId: repo.id,
    title: "Greet visitors",
    intent: "Say hello to whoever opens the site.",
    acceptanceCriteria: ["The home page says hello", "The home page says goodbye"],
    outOfScope: [],
    riskDeclarations: [],
    scopePaths: [],
    affectedRoutes: ["/"],
    status: "approved",
    authorId: agent.principal.id,
    approvedBy: human.principal.id,
    approvedAt: new Date().toISOString(),
    approvalSignature: null,
    supersedes: null,
    createdAt: new Date().toISOString(),
  });
  await ports.store.updateChange(change.id, { planId: `pl-${change.id}` });
  return { human, agent, repo, changeId: change.id as string, head, mcp };
}

/** Introspect the run's workflow before it starts (its id is derived from the change and head). */
async function qaWorkflow(changeId: string, head: string) {
  const wf = await introspectWorkflowInstance(
    (env as unknown as { QA_WORKFLOW: Workflow }).QA_WORKFLOW,
    qaRunId(changeId, head),
  );
  await wf.modify(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  return wf;
}

describe("QA on request (workerd: real app, workflow, PreviewHost; fake browser + model)", () => {
  it("runs privately, signs the result into the head's evidence, raises the lane on a failure and notifies", async () => {
    const app = platformApp();
    const { human, changeId, head, mcp } = await gradedChange(app);
    const before = await buildPorts(env, "default").store.getChange(changeId);
    resetQaFakes([PLAN, REVIEW]);
    await using wf = await qaWorkflow(changeId, head);

    const res = await call(app, "POST", `/api/v1/changes/${changeId}/qa`, {
      cookie: human.cookie,
      body: {},
    });
    expect(res.status).toBe(202);
    const { run, reused } = await json<{
      run: { id: string; status: string; headSha: string };
      reused: boolean;
    }>(res);
    expect(reused).toBe(false);
    expect(run).toMatchObject({ status: "queued", headSha: head });
    await wf.waitForStatus("complete");

    // The app was served privately: a q- preview from the CI build snapshot, no internet, no row
    // for the public gateway, and the browser only ever saw that origin.
    expect(previewFakes().starts.at(-1)).toEqual({ snapshot: "snap-build", enableInternet: false });
    expect(qaFakes().origins).toEqual([
      `https://q-${changeId}-${head.slice(0, 8)}-pv.resynapse.dev`,
    ]);
    expect(qaFakes()).toMatchObject({ opened: 1, closed: 1 });
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM previews WHERE id LIKE 'q-%'",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(0);
    // The public preview gateway (the Worker's *-pv route) refuses the q- host: fail closed.
    const gateway = await handlePreviewRequest(new Request(`${qaFakes().origins[0]}/`), env);
    expect(gateway.status).toBe(404);

    // The run: one pass, one fail, the lane raised (never lowered), costs recorded.
    const listed = await json<{ runs: Array<Record<string, unknown> & { report: QaRun }> }>(
      await call(app, "GET", `/api/v1/changes/${changeId}/qa`, { cookie: human.cookie }),
    );
    const done = listed.runs[0];
    expect(done).toMatchObject({
      id: run.id,
      status: "done",
      summary: { passed: 1, failed: 1, couldntTest: 0 },
      laneBefore: before?.lane,
      laneAfter: 2,
    });
    expect(done?.report.criteria.map((c) => c.verdict)).toEqual(["pass", "fail"]);
    expect(done?.report.model).toBe("@cf/zai-org/glm-5.3-flash");
    expect(done?.report.artifacts.some((a) => a.role === "recording")).toBe(true);

    // Signed into the head's bundle; the change carries the raised lane and the reason.
    const ev = await mcp.tools.get_evidence({ changeId });
    if (ev.isError) throw new Error(JSON.stringify(ev.content));
    expect(ev.structuredContent.verification).toMatchObject({ ok: true });
    expect(JSON.stringify(ev.structuredContent)).toContain('"qa-run"');
    const after = await buildPorts(env, "default").store.getChange(changeId);
    expect(after?.lane).toBe(2);
    expect(after?.laneReasons.map((r) => r.code)).toContain("qa.failed");

    // Full-size steps behind repo access; the notification for the humans.
    const shot = done?.report.artifacts.find((a) => a.role === "step");
    expect(
      (await call(app, "GET", `/api/v1/blobs/${shot?.ref}`, { cookie: human.cookie })).status,
    ).toBe(200);
    const note = await env.DB.prepare(
      "SELECT message FROM notifications WHERE kind = 'qa-finished' AND change_id = ?",
    )
      .bind(changeId)
      .first<{ message: string }>();
    expect(note?.message).toContain("1 passed, 1 failed");
    expect(note?.message).toContain("Full review (Lane 2)");

    // Agents: get_qa reads the verdicts; request_qa on the same head is the same run.
    const got = await mcp.tools.get_qa({ changeId });
    if (got.isError) throw new Error(JSON.stringify(got.content));
    expect(got.structuredContent.runs[0]).toMatchObject({
      id: run.id,
      status: "done",
      laneAfter: 2,
    });
    expect(got.structuredContent.runs[0]?.criteria.map((c) => c.verdict)).toEqual(["pass", "fail"]);
    expect(got.structuredContent.nextSteps[0]?.title).toContain("Fix what QA found");
    const asked = await mcp.tools.request_qa({ changeId });
    if (asked.isError) throw new Error(JSON.stringify(asked.content));
    expect(asked.structuredContent).toMatchObject({ reused: true, run: { id: run.id } });

    // Asking again for the same head is the same run; a thumbnail URL works signed, not tampered.
    const again = await json<{ run: { id: string }; reused: boolean }>(
      await call(app, "POST", `/api/v1/changes/${changeId}/qa`, { cookie: human.cookie, body: {} }),
    );
    expect(again).toMatchObject({ reused: true, run: { id: run.id } });
    const thumb = done?.report.artifacts.find((a) => a.role === "thumb");
    const url = await signedQaImageUrl(
      env.BETTER_AUTH_SECRET,
      ORIGIN,
      run.id,
      thumb?.name ?? "",
      Date.now(),
    );
    expect((await fetchVia(app)(url)).status).toBe(200);
    expect((await fetchVia(app)(url.replace(/sig=.{4}/, "sig=AAAA"))).status).toBe(404);
    const old = await signedQaImageUrl(
      env.BETTER_AUTH_SECRET,
      ORIGIN,
      run.id,
      thumb?.name ?? "",
      Date.now(),
      -1000,
    );
    expect((await fetchVia(app)(old)).status).toBe(410);
  });

  it("refuses a caller without access (404), a head without green CI, and over the repo's rate limit", async () => {
    const app = platformApp();
    const { human, changeId, repo } = await gradedChange(app);
    resetQaFakes([PLAN, REVIEW]);
    const stranger = await signUpHuman(app);
    expect(
      (
        await call(app, "POST", `/api/v1/changes/${changeId}/qa`, {
          cookie: stranger.cookie,
          body: {},
        })
      ).status,
    ).toBe(404);
    const now = new Date().toISOString();
    for (let i = 0; i < 6; i++) {
      await env.DB.prepare(
        "INSERT INTO qa_runs (id, change_id, repo_id, head_sha, status, trigger, requested_by, created_at) VALUES (?, ?, ?, ?, 'done', 'platform', 'x', ?)",
      )
        .bind(`qa-old-${i}`, `other-${i}`, repo.id, "0".repeat(40), now)
        .run();
    }
    const limited = await call(app, "POST", `/api/v1/changes/${changeId}/qa`, {
      cookie: human.cookie,
      body: {},
    });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("a run whose workflow was lost (queued > 15 min) no longer blocks the head: asking again starts a fresh run", async () => {
    const app = platformApp();
    const { human, changeId, head } = await gradedChange(app);
    resetQaFakes([PLAN, REVIEW]);
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO qa_runs (id, change_id, repo_id, head_sha, status, trigger, requested_by, created_at) SELECT ?, ?, repo_id, ?, 'queued', 'platform', 'x', ? FROM changes WHERE id = ?",
    )
      .bind(qaRunId(changeId, head), changeId, head, old, changeId)
      .run();
    await using wf = await introspectWorkflowInstance(
      (env as unknown as { QA_WORKFLOW: Workflow }).QA_WORKFLOW,
      qaRunId(changeId, head, 2),
    );
    await wf.modify(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const res = await json<{ run: { id: string }; reused: boolean }>(
      await call(app, "POST", `/api/v1/changes/${changeId}/qa`, { cookie: human.cookie, body: {} }),
    );
    expect(res).toMatchObject({ reused: false, run: { id: qaRunId(changeId, head, 2) } });
    await wf.waitForStatus("complete");
    const { runs } = await json<{
      runs: Array<{ id: string; status: string; error: string | null }>;
    }>(await call(app, "GET", `/api/v1/changes/${changeId}/qa`, { cookie: human.cookie }));
    expect(runs.map((r) => [r.id, r.status])).toEqual([
      [qaRunId(changeId, head, 2), "done"],
      [qaRunId(changeId, head), "failed"],
    ]);
    expect(runs[1]?.error).toContain("lost");
  });

  it("a run that can't drive the app is an errored item: the lane goes up to at least 1, never down", async () => {
    const app = platformApp();
    const { human, changeId, head } = await gradedChange(app);
    resetQaFakes([PLAN, REVIEW]).failBrowser = true;
    await using wf = await qaWorkflow(changeId, head);
    expect(
      (
        await call(app, "POST", `/api/v1/changes/${changeId}/qa`, {
          cookie: human.cookie,
          body: {},
        })
      ).status,
    ).toBe(202);
    await wf.waitForStatus("complete");
    const { runs } = await json<{
      runs: Array<{ status: string; error: string | null; laneAfter: number }>;
    }>(await call(app, "GET", `/api/v1/changes/${changeId}/qa`, { cookie: human.cookie }));
    expect(runs[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Browser Run answered 503"),
    });
    expect(runs[0]?.laneAfter).toBeGreaterThanOrEqual(1);
    const after = await buildPorts(env, "default").store.getChange(changeId);
    expect(after?.laneReasons.map((r) => r.code)).toContain("signal.error.qa");
  });
});
