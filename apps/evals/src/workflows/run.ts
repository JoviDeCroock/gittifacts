/**
 * `EvalRunWorkflow`: one instance per run (instance id = run id). Every model turn and tool call
 * is its own step: a model turn retries (Workers AI capacity errors), a tool call never does (it
 * may have side effects on the platform), and tool/model outputs are marked sensitive because
 * they carry the agent's short-lived platform tokens.
 */
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import type { DurableStep, StepKind } from "../agent/loop.js";
import { WorkersAiModel } from "../agent/model.js";
import { configOf, type EvalEnv, evalHeaderFn } from "../env.js";
import { findModel } from "../models.js";
import type { RunResult } from "../results.js";
import { ResultStore, writeRunPoint } from "../store.js";
import { type RunDeps, RunParams, runEvalCore } from "./run-core.js";

export const STEP_CONFIG: Record<StepKind, WorkflowStepConfig> = {
  clock: { retries: { limit: 0, delay: 1000 }, timeout: "1 minute" },
  model: {
    retries: { limit: 3, delay: "15 seconds", backoff: "exponential" },
    timeout: "5 minutes",
    sensitive: "output",
  },
  tool: { retries: { limit: 0, delay: 1000 }, timeout: "12 minutes", sensitive: "output" },
  io: { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
};

export function durableStep(step: WorkflowStep): DurableStep {
  return <T>(name: string, kind: StepKind, fn: () => Promise<T>) =>
    step.do(name, STEP_CONFIG[kind], async () => (await fn()) as Rpc.Serializable<T>) as Promise<T>;
}

export class EvalRunWorkflow extends WorkflowEntrypoint<EvalEnv, RunParams> {
  /** Production wiring; tests override it with a scripted model and a fake platform. */
  protected async deps(params: RunParams, step: WorkflowStep): Promise<RunDeps> {
    const env = this.env;
    const cfg = configOf(env);
    const def = findModel(params.model);
    if (!def) throw new Error(`unknown model ${params.model}`);
    const sandbox = env.EVAL_SANDBOX.getByName(params.runId);
    return {
      cfg,
      model: new WorkersAiModel({
        ai: env.AI,
        model: def,
        gatewayId: cfg.gatewayId,
        metadata: { run: params.runId, task: params.task, model: def.short },
      }),
      fetcher: (input, init) => fetch(input, init),
      adminFetcher: (input, init) => fetch(input, init),
      adminToken: env.EVAL_ADMIN_TOKEN || null,
      shell: (command, secs) => sandbox.exec(command, secs, params.runId),
      destroySandbox: () => sandbox.destroy(),
      evalHeaders: await evalHeaderFn(cfg, params.runId, env.EVAL_TRAFFIC_SECRET),
      store: new ResultStore(env.RESULTS),
      writePoint: (r: RunResult) => writeRunPoint(env.EVAL_METRICS, r),
      step: durableStep(step),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
  }

  override async run(event: Readonly<WorkflowEvent<RunParams>>, step: WorkflowStep) {
    const params = RunParams.parse(event.payload);
    const result = await runEvalCore(params, await this.deps(params, step));
    return { runId: result.runId, success: result.success, stop: result.stop };
  }
}
