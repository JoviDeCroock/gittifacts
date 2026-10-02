import { beforeEach, describe, expect, it } from "vitest";
import type { EvalConfig } from "../../src/env.js";
import { MODELS } from "../../src/models.js";
import type { RunResult } from "../../src/results.js";
import type { ShellResult } from "../../src/sandbox.js";
import { ResultStore, runIdFor } from "../../src/store.js";
import type { TaskId } from "../../src/tasks.js";
import { type RunDeps, runEvalCore } from "../../src/workflows/run-core.js";
import { ADMIN_TOKEN, FakePlatform, fakePlatformFetch, HOST, SUFFIX } from "../fake-platform.js";
import { FakeBucket } from "../fake-r2.js";
import { cachingStep, FakeClock, ScriptedModel, type ScriptedTurn } from "../fakes.js";

const FIXTURE = "https://github.com/JoviDeCroock/gittifacts-fixture-clock-api";
const cfg: EvalConfig = {
  host: HOST,
  previewSuffix: SUFFIX,
  gatewayId: "gittifacts",
  importRepoUrl: FIXTURE,
  runsPerCell: 5,
  concurrency: 2,
  maxToolCalls: 60,
  maxWallMs: 900_000,
  tokenBudget: 1_500_000,
  checkGraceMs: 0,
};

let platform: FakePlatform;
let bucket: FakeBucket;
let points: RunResult[];
let shellCalls: string[];
let destroyed: number;

function deps(script: ScriptedTurn[], over: Partial<RunDeps> = {}): RunDeps {
  const f = fakePlatformFetch(platform);
  return {
    cfg,
    model: new ScriptedModel(script),
    fetcher: f,
    adminFetcher: f,
    adminToken: ADMIN_TOKEN,
    shell: async (command): Promise<ShellResult> => {
      shellCalls.push(command);
      return {
        exitCode: 0,
        output: "ok",
        outputBytes: 2,
        truncated: false,
        timedOut: false,
        durationMs: 1,
        error: null,
      };
    },
    destroySandbox: async () => {
      destroyed++;
    },
    evalHeaders: (u): Record<string, string> =>
      u.origin === HOST ? { "x-gittifacts-eval-run": "run-1" } : {},
    store: new ResultStore(bucket.asR2()),
    writePoint: (r) => points.push(r),
    step: cachingStep(new FakeClock(Date.now(), 0)),
    sleep: async () => {},
    ...over,
  };
}

const params = (task: TaskId, model = MODELS[0]!) => ({
  runId: runIdFor("m-test", task, model.short, 1),
  matrixId: "m-test",
  task,
  model: model.id,
  attempt: 1,
});

const createCall = (body: Record<string, unknown>): ScriptedTurn => ({
  call: "http_fetch",
  args: { url: `${HOST}/api/v1/projects`, method: "POST", body },
});

beforeEach(() => {
  platform = new FakePlatform();
  platform.autoGreen = true;
  bucket = new FakeBucket();
  points = [];
  shellCalls = [];
  destroyed = 0;
});

describe("runEvalCore", () => {
  it("task 1: the agent creates a project, the checker sees the preview serve the time; recorded with TTFG", async () => {
    const r = await runEvalCore(
      params("t1"),
      deps([
        { call: "http_fetch", args: { url: `${HOST}/start` } },
        createCall({ template: "workers-api", name: "clock" }),
        { final: "Deployed." },
      ]),
    );
    expect(r.checks.map((c) => [c.name, c.pass])).toEqual([
      ["project-created", true],
      ["preview-serves-time", true],
    ]);
    expect(r).toMatchObject({
      success: true,
      stop: "final",
      toolCalls: 2,
      modelShort: "kimi",
      provider: "moonshot",
    });
    expect(r.ttfgMs).not.toBeNull();
    expect(["probe", "evidence"]).toContain(r.ttfgSource);
    expect(r.ids.repoIds).toHaveLength(1);
    expect(r.safety.violations).toEqual([]);
    expect(r.neurons).toBeGreaterThan(0);
    // Stored in R2 (result + redacted transcript) and in Analytics Engine.
    const stored = await new ResultStore(bucket.asR2()).getRun(r.runId);
    expect(stored).toEqual(r);
    const transcript = JSON.stringify(await new ResultStore(bucket.asR2()).getTranscript(r.runId));
    expect(transcript).toContain("api/v1/projects");
    expect(transcript).not.toMatch(/gtf_unclaimed_r/);
    expect(points).toHaveLength(1);
    // The agent's platform traffic is tagged with the run; the checker uses the admin token.
    expect(platform.requests.some((q) => q.evalRun === "run-1")).toBe(true);
    expect(platform.requests.some((q) => q.auth === `Bearer ${ADMIN_TOKEN}`)).toBe(true);
    expect(destroyed).toBe(1);
  });

  it("task 1 fails when the agent stops before creating anything", async () => {
    const r = await runEvalCore(params("t1"), deps([{ final: "I can't." }]));
    expect(r.success).toBe(false);
    expect(r.checks[0]).toMatchObject({ name: "project-created", pass: false });
  });

  it("task 4 offers no shell: a shell attempt is an unknown-tool error and fails no-shell", async () => {
    const r = await runEvalCore(
      params("t4"),
      deps([
        { call: "shell", args: { command: "ls" } },
        createCall({ template: "workers-api" }),
        { final: "ok" },
      ]),
    );
    expect(shellCalls).toEqual([]);
    expect(r.errors.tool).toBe(1);
    expect(r.checks.find((c) => c.name === "no-shell")).toMatchObject({
      pass: false,
      detail: "1 shell calls",
    });
    expect(r.checks.find((c) => c.name === "used-open-workspace")!.pass).toBe(false);
    expect(r.success).toBe(false);
  });

  it("task 2 is skipped without a fixture URL; nothing runs", async () => {
    const r = await runEvalCore(params("t2"), deps([], { cfg: { ...cfg, importRepoUrl: null } }));
    expect(r).toMatchObject({
      stop: "skipped",
      note: "fixture repo not published",
      success: false,
      toolCalls: 0,
    });
  });

  it("is blocked (no agent, no tokens spent) when credential-less creation is off", async () => {
    platform.anonymousAvailable = false;
    const model = new ScriptedModel([{ final: "x" }]);
    const r = await runEvalCore(params("t3"), deps([], { model }));
    expect(r.stop).toBe("blocked");
    expect(r.note).toMatch(/kill switch/);
    expect(model.seen).toHaveLength(0);
  });

  it("records model-error when the model keeps failing, and fails the run", async () => {
    const r = await runEvalCore(params("t1", MODELS[1]!), deps([{ throws: "5xx" }]));
    expect(r).toMatchObject({ stop: "model-error", success: false, provider: "openai" });
    expect(r.note).toContain("5xx");
  });

  it("a safety violation fails an otherwise green run", async () => {
    platform.onCreate = (id) => {
      platform.plans.set(id, ["p1"]);
      platform.event({ principalId: `anon-${id}`, action: "plan.approved", subject: "plan:p1" });
    };
    const r = await runEvalCore(
      params("t1"),
      deps([createCall({ template: "workers-api" }), { final: "done" }]),
    );
    expect(r.checks.every((c) => c.pass)).toBe(true);
    expect(r.safety.violations.map((v) => v.kind)).toEqual(["agent-approval"]);
    expect(r.success).toBe(false);
  });
});
