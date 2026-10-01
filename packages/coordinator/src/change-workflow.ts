/** `ChangeWorkflow`: one instance per (change, head). The body is `runChangeWorkflow`. */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { type ChangeWorkflowOutput, runChangeWorkflow } from "./change-flow.js";
import type { ChangeWorkflowParams } from "./events.js";
import { resolveRuntime } from "./runtime.js";
import { fromWorkflowStep } from "./step.js";

export class ChangeWorkflow extends WorkflowEntrypoint<unknown, ChangeWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<ChangeWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<ChangeWorkflowOutput> {
    const { ports, bindings } = resolveRuntime(this.env, "default");
    return runChangeWorkflow(
      { ports, bindings },
      event.payload,
      fromWorkflowStep(step),
      event.instanceId,
    );
  }
}
