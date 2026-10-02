/**
 * One eval run, start to finish, behind seams (Workflow steps, model, network, sandbox, store),
 * so the same code runs in the `EvalRunWorkflow` and in tests:
 *
 *   preflight (/start: is credential-less creation on?) → fresh agent loop → checker (with grace)
 *   → per-run safety (audit log) → record (R2 result + transcript, Analytics Engine) → cleanup
 */
import { z } from "zod";
import { type AgentRun, type DurableStep, runAgent } from "../agent/loop.js";
import type { ChatModel } from "../agent/model.js";
import { PlatformApi } from "../check/api.js";
import { runSafety } from "../check/safety.js";
import { type CheckOutput, checkRun } from "../check/tasks.js";
import type { EvalConfig } from "../env.js";
import { findModel, type ModelDef, neuronsFor, usdForNeurons } from "../models.js";
import { redactDeep } from "../redact.js";
import { RunResult, type StopReason, TaskIdSchema } from "../results.js";
import type { ShellResult } from "../sandbox.js";
import type { ResultStore } from "../store.js";
import { systemPrompt, TASKS, taskPrompt } from "../tasks.js";
import { HarnessTools } from "../tools/executor.js";
import { type FetchLike, probePreview } from "../tools/probe.js";

export const RunParams = z.object({
  runId: z.string().min(1).max(100),
  matrixId: z.string().min(1).max(64),
  task: TaskIdSchema,
  /** Model id (`@cf/…`). */
  model: z.string().min(1),
  attempt: z.number().int().min(1),
});
export type RunParams = z.infer<typeof RunParams>;

export interface RunDeps {
  cfg: EvalConfig;
  model: ChatModel;
  /** Network for the agent's tools and the preview probes. */
  fetcher: FetchLike;
  /** Network for the checkers (with the admin token). */
  adminFetcher: FetchLike;
  adminToken: string | null;
  shell: (command: string, timeoutSec: number) => Promise<ShellResult>;
  destroySandbox: () => Promise<void>;
  evalHeaders: (url: URL) => Record<string, string>;
  store: ResultStore;
  writePoint: (r: RunResult) => void;
  step: DurableStep;
  sleep: (ms: number) => Promise<void>;
}

const StartJson = z.object({
  auth: z.object({ anonymous: z.object({ available: z.boolean() }).passthrough() }).passthrough(),
});

/** null = go; otherwise why nothing can run (credential-less creation is switched off). */
export async function preflight(fetcher: FetchLike, host: string): Promise<string | null> {
  try {
    const res = await fetcher(`${host}/start`, { headers: { accept: "application/json" } });
    if (!res.ok) return null; // A broken front door is the platform's failure: let the agent hit it.
    const start = StartJson.safeParse(await res.json());
    if (start.success && start.data.auth.anonymous.available === false) {
      return "credential-less project creation is disabled on the platform (kill switch)";
    }
  } catch {
    // same as above
  }
  return null;
}

/** A result for a run where no agent ran (skipped, blocked, or infrastructure failure). */
export function stubResult(
  p: RunParams,
  model: ModelDef | undefined,
  stop: StopReason,
  note: string,
): RunResult {
  const now = new Date().toISOString();
  return {
    v: 1,
    runId: p.runId,
    matrixId: p.matrixId,
    task: p.task,
    model: p.model,
    modelShort: model?.short ?? p.model,
    provider: model?.provider ?? "unknown",
    attempt: p.attempt,
    stop,
    note,
    success: false,
    checks: [],
    startedAt: now,
    endedAt: now,
    wallMs: 0,
    turns: 0,
    toolCalls: 0,
    toolCounts: {},
    errors: { tool: 0, codes: [] },
    ttfgMs: null,
    ttfgSource: null,
    tokens: { prompt: 0, completion: 0, cached: 0 },
    neurons: 0,
    costUsd: 0,
    safety: { violations: [], subjects: 0 },
    ids: { repoIds: [], changeIds: [], planIds: [], previewUrls: [] },
    finalMessage: null,
  };
}

async function record(
  deps: RunDeps,
  r: RunResult,
  transcript: AgentRun["transcript"],
): Promise<RunResult> {
  const parsed = RunResult.parse(redactDeep(r));
  await deps.step("record", "io", async () => {
    await deps.store.putTranscript(parsed.matrixId, parsed.runId, redactDeep(transcript));
    await deps.store.putRun(parsed);
    deps.writePoint(parsed);
    return true;
  });
  return parsed;
}

export async function runEvalCore(params: RunParams, deps: RunDeps): Promise<RunResult> {
  const { cfg, step } = deps;
  const model = findModel(params.model);
  const prompt = taskPrompt(params.task, { importRepoUrl: cfg.importRepoUrl ?? undefined });
  if (!prompt.ok) return record(deps, stubResult(params, model, "skipped", prompt.skipReason), []);
  if (!model)
    return record(
      deps,
      stubResult(params, model, "infra-error", `unknown model ${params.model}`),
      [],
    );

  const blocked = await step("preflight", "io", () => preflight(deps.fetcher, cfg.host));
  if (blocked !== null) return record(deps, stubResult(params, model, "blocked", blocked), []);

  const task = TASKS[params.task];
  const tools = new HarnessTools(task.tools, {
    fetcher: deps.fetcher,
    shell: deps.shell,
    previewSuffix: cfg.previewSuffix,
    evalHeaders: deps.evalHeaders,
    probes: task.previews,
  });
  let agent: AgentRun;
  try {
    agent = await runAgent({
      system: systemPrompt(cfg.host),
      task: prompt.text,
      model: deps.model,
      tools,
      step,
      limits: {
        maxToolCalls: cfg.maxToolCalls,
        maxWallMs: cfg.maxWallMs,
        maxTokens: cfg.tokenBudget,
        maxTurns: cfg.maxToolCalls + 20,
      },
      contextChars: model.contextChars,
    });
  } finally {
    await tools.close();
  }
  const got = tools.collected();

  const check: CheckOutput = await step("check", "io", async () => {
    if (!deps.adminToken) {
      return {
        success: false,
        checks: [{ name: "checker", pass: false, detail: "EVAL_ADMIN_TOKEN is not set" }],
        ttfgMs: null,
        ttfgSource: null,
        repoIds: [],
        changeIds: [],
      };
    }
    const api = new PlatformApi(cfg.host, deps.adminToken, deps.adminFetcher);
    return checkRun(
      {
        task: params.task,
        startedAt: agent.startedAt,
        endedAt: agent.endedAt,
        harvest: got.harvest,
        firstGreen: got.firstGreen,
        toolCounts: agent.toolCounts,
        mcpCalls: got.mcpCalls,
        importRepoUrl: cfg.importRepoUrl,
        previewSuffix: cfg.previewSuffix,
      },
      {
        api,
        probe: (url) =>
          probePreview(deps.fetcher, url, { headers: deps.evalHeaders(new URL(url)) }),
        now: () => Date.now(),
        sleep: deps.sleep,
      },
      { graceMs: cfg.checkGraceMs },
    );
  });

  const safety = await step("safety", "io", async () => {
    if (!deps.adminToken) return { violations: [], subjects: 0 };
    const api = new PlatformApi(cfg.host, deps.adminToken, deps.adminFetcher);
    const repoIds = [...new Set([...check.repoIds, ...got.harvest.repoIds])];
    return runSafety(api, {
      repoIds,
      changeIds: got.harvest.changeIds,
      planIds: got.harvest.planIds,
    });
  });

  await step("cleanup", "io", async () => {
    await deps.destroySandbox();
    return true;
  });

  const neurons = neuronsFor(model, agent.usage);
  const result: RunResult = {
    ...stubResult(params, model, agent.stop, agent.modelError ?? ""),
    note: agent.modelError,
    success: check.success && safety.violations.length === 0,
    checks: check.checks,
    startedAt: new Date(agent.startedAt).toISOString(),
    endedAt: new Date(agent.endedAt).toISOString(),
    wallMs: agent.endedAt - agent.startedAt,
    turns: agent.turns,
    toolCalls: agent.toolCalls,
    toolCounts: agent.toolCounts,
    errors: { tool: agent.toolErrors, codes: agent.errorCodes },
    ttfgMs: check.ttfgMs,
    ttfgSource: check.ttfgSource,
    tokens: agent.usage,
    neurons,
    costUsd: usdForNeurons(neurons),
    safety,
    ids: {
      repoIds: check.repoIds,
      changeIds: check.changeIds,
      planIds: got.harvest.planIds,
      previewUrls: got.harvest.previewUrls,
    },
    finalMessage: agent.finalMessage === null ? null : agent.finalMessage.slice(0, 2000),
  };
  return record(deps, result, agent.transcript);
}
