import { introspectWorkflow, introspectWorkflowInstance, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { EvalEnv } from "../../src/env.js";
import { MatrixView, RunResult } from "../../src/results.js";
import { runIdFor } from "../../src/store.js";
import { HOST } from "../fake-platform.js";
import type { ScriptedTurn } from "../fakes.js";
import type { TestEvalSandbox } from "./entry.js";

const e = env as unknown as Omit<EvalEnv, "EVAL_SANDBOX"> & {
  EVAL_SANDBOX: DurableObjectNamespace<TestEvalSandbox>;
};
const ORIGIN = "https://evals.test";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe("EvalRunWorkflow", () => {
  it("runs a fresh agent end to end: tools (incl. the sandbox), checker, safety, R2 result", async () => {
    const runId = runIdFor("m-20261003-030000-wf01", "t1", "kimi", 1);
    const script: ScriptedTurn[] = [
      { call: "http_fetch", args: { url: `${HOST}/start` } },
      { call: "shell", args: { command: "node --version" } },
      {
        call: "http_fetch",
        args: { url: `${HOST}/api/v1/projects`, method: "POST", body: { template: "workers-api" } },
      },
      { final: "Deployed." },
    ];
    await e.RESULTS.put(`test-scripts/${runId}.json`, JSON.stringify(script));
    await using inst = await introspectWorkflowInstance(e.EVAL_RUN_WORKFLOW, runId);
    await inst.modify(async (m) => {
      await m.disableRetryDelays();
    });
    await e.EVAL_RUN_WORKFLOW.create({
      id: runId,
      params: {
        runId,
        matrixId: "m-20261003-030000-wf01",
        task: "t1",
        model: "@cf/moonshotai/kimi-k2.7-code",
        attempt: 1,
      },
    });
    await inst.waitForStatus("complete");
    expect(await inst.getOutput()).toEqual({ runId, success: true, stop: "final" });
    const obj = await e.RESULTS.get(
      `evals/onboarding/matrices/m-20261003-030000-wf01/runs/${runId}.json`,
    );
    const r = RunResult.parse(await obj!.json());
    expect(r).toMatchObject({
      success: true,
      toolCalls: 3,
      toolCounts: { http_fetch: 2, shell: 1 },
    });
    expect(r.ttfgMs).not.toBeNull();
    const sandbox = await e.EVAL_SANDBOX.getByName(runId).inspect();
    expect(sandbox.starts).toBe(1);
    expect(sandbox.destroyed).toBe(1);
    // The API serves the run and its transcript.
    const res = await SELF.fetch(`${ORIGIN}/runs/${runId}`, { headers: auth("read-token") });
    expect(RunResult.parse(await res.json()).runId).toBe(runId);
    const t = await SELF.fetch(`${ORIGIN}/runs/${runId}/transcript`, {
      headers: auth("read-token"),
    });
    expect(JSON.stringify(await t.json())).toContain("ran: exec timeout");
  });
});

describe("EvalRunWorkflow, remote-only (task 4)", () => {
  it("drives the platform over MCP only: create_project + open_workspace, no shell offered", async () => {
    const matrixId = "m-20261003-030000-wf04";
    const runId = runIdFor(matrixId, "t4", "gptoss", 1);
    const script: ScriptedTurn[] = [
      { call: "mcp_connect", args: { url: `${HOST}/mcp` } },
      { call: "mcp_list_tools" },
      {
        call: "mcp_call",
        args: { name: "create_project", arguments: { template: "workers-api" } },
      },
      { call: "mcp_call", args: { name: "open_workspace", arguments: { changeId: "c1" } } },
      { final: "Deployed without a shell." },
    ];
    await e.RESULTS.put(`test-scripts/${runId}.json`, JSON.stringify(script));
    await using inst = await introspectWorkflowInstance(e.EVAL_RUN_WORKFLOW, runId);
    await inst.modify(async (m) => {
      await m.disableRetryDelays();
    });
    await e.EVAL_RUN_WORKFLOW.create({
      id: runId,
      params: { runId, matrixId, task: "t4", model: "@cf/openai/gpt-oss-120b", attempt: 1 },
    });
    await inst.waitForStatus("complete");
    const obj = await e.RESULTS.get(`evals/onboarding/matrices/${matrixId}/runs/${runId}.json`);
    const r = RunResult.parse(await obj!.json());
    expect(r.checks.map((c) => [c.name, c.pass])).toEqual([
      ["project-created", true],
      ["preview-serves-time", true],
      ["no-shell", true],
      ["used-open-workspace", true],
    ]);
    expect(r).toMatchObject({
      success: true,
      errors: { tool: 0 },
      toolCounts: { mcp_connect: 1, mcp_list_tools: 1, mcp_call: 2 },
    });
    expect((await e.EVAL_SANDBOX.getByName(runId).inspect()).starts).toBe(0);
  });
});

describe("HTTP API + EvalMatrixWorkflow", () => {
  it("guards POST /runs and the read endpoints with their tokens", async () => {
    expect((await SELF.fetch(`${ORIGIN}/runs`, { method: "POST", body: "{}" })).status).toBe(401);
    expect(
      (
        await SELF.fetch(`${ORIGIN}/runs`, {
          method: "POST",
          headers: auth("read-token"),
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect((await SELF.fetch(`${ORIGIN}/matrices`, { headers: auth("nope") })).status).toBe(401);
    const bad = await SELF.fetch(`${ORIGIN}/runs`, {
      method: "POST",
      headers: auth("api-token"),
      body: '{"tasks":["t9"]}',
    });
    expect(bad.status).toBe(400);
  });

  // Note: the local Workflows engine logs a few "Worker's code had hung" cancellations for run
  // instances created from inside the matrix's steps; the runs still complete and record results.
  it("POST /runs starts a matrix that runs, sweeps and reports; the gates read it back", async () => {
    await using matrices = await introspectWorkflow(e.EVAL_MATRIX_WORKFLOW);
    await using runs = await introspectWorkflow(e.EVAL_RUN_WORKFLOW);
    await matrices.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    await runs.modifyAll(async (m) => {
      await m.disableRetryDelays();
    });
    const res = await SELF.fetch(`${ORIGIN}/runs`, {
      method: "POST",
      headers: auth("api-token"),
      body: JSON.stringify({ tasks: ["t1"], models: ["kimi", "gptoss"], runsPerCell: 1 }),
    });
    expect(res.status).toBe(202);
    const started = (await res.json()) as { matrixId: string; runIds: string[] };
    expect(started.runIds).toHaveLength(2);
    const [matrix] = await matrices.get();
    await matrix!.waitForStatus("complete");
    const view = MatrixView.parse(
      await (
        await SELF.fetch(`${ORIGIN}/matrices/${started.matrixId}`, { headers: auth("read-token") })
      ).json(),
    );
    expect(view.complete).toBe(true);
    expect(view.runs.map((r) => [r.modelShort, r.success])).toEqual(
      expect.arrayContaining([
        ["kimi", true],
        ["gptoss", true],
      ]),
    );
    expect(view.sweep).toMatchObject({ complete: true, violations: [] });
    const latest = await SELF.fetch(`${ORIGIN}/matrices/latest?complete=1`, {
      headers: auth("read-token"),
    });
    expect(MatrixView.parse(await latest.json()).matrix.matrixId).toBe(started.matrixId);
    const report = await (
      await SELF.fetch(`${ORIGIN}/matrices/${started.matrixId}/report`, {
        headers: auth("read-token"),
      })
    ).text();
    expect(report).toContain("# Onboarding eval report");
    expect(report).toContain("| t1 Workers API → preview | kimi | 1 | 1/1 (100%)");
  });
});
