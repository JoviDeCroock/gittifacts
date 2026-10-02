/**
 * `BatchRunWorkflow`: one instance per merge-queue batch run or flake re-check
 * (`mq-<repoId>-<epoch>-<runId>`). The body is `runBatchRun` (queue/batch-run.ts). It reads
 * only the default role's Ports: CI and read access to the main repo; it never writes a ref.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { type BatchRunOutput, type BatchRunParams, runBatchRun } from "./queue/batch-run.js";
import { resolveRuntime } from "./runtime.js";
import { fromWorkflowStep } from "./step.js";

export class BatchRunWorkflow extends WorkflowEntrypoint<unknown, BatchRunParams> {
  override async run(
    event: Readonly<WorkflowEvent<BatchRunParams>>,
    step: WorkflowStep,
  ): Promise<BatchRunOutput> {
    const { ports, bindings } = resolveRuntime(this.env, "default");
    return runBatchRun({ ports, bindings }, event.payload, fromWorkflowStep(step));
  }
}
