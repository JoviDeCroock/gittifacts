/** `EvalMatrixWorkflow`: one instance per matrix (instance id = matrix id). See matrix-core.ts. */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { configOf, type EvalEnv } from "../env.js";
import { ResultStore } from "../store.js";
import {
  type InstanceStatus,
  type MatrixDeps,
  MatrixParams,
  runMatrixCore,
} from "./matrix-core.js";
import { durableStep } from "./run.js";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class EvalMatrixWorkflow extends WorkflowEntrypoint<EvalEnv, MatrixParams> {
  protected deps(step: WorkflowStep): MatrixDeps {
    const env = this.env;
    return {
      cfg: configOf(env),
      store: new ResultStore(env.RESULTS),
      step: durableStep(step),
      sleep: (name, ms) => step.sleep(name, ms),
      fetcher: (input, init) => fetch(input, init),
      adminFetcher: (input, init) => fetch(input, init),
      adminToken: env.EVAL_ADMIN_TOKEN || null,
      startRun: async (params) => {
        try {
          await env.EVAL_RUN_WORKFLOW.create({ id: params.runId, params });
        } catch (e) {
          // Idempotent: a retried tick finds the instance it already created.
          if (!/already exists|duplicate/i.test(errText(e))) throw e;
        }
      },
      runStatus: async (runId) => {
        try {
          const s = await (await env.EVAL_RUN_WORKFLOW.get(runId)).status();
          return {
            status: s.status as InstanceStatus,
            ...(s.error ? { error: s.error.message } : {}),
          };
        } catch (e) {
          return { status: "unknown", error: errText(e) };
        }
      },
      stopRun: async (runId) => {
        await (await env.EVAL_RUN_WORKFLOW.get(runId)).terminate();
      },
    };
  }

  override async run(event: Readonly<WorkflowEvent<MatrixParams>>, step: WorkflowStep) {
    return runMatrixCore(MatrixParams.parse(event.payload), this.deps(step));
  }
}
