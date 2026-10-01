/** `RolloutWorkflow`: one instance per merged change (`rollout-<changeId>`). Body: `runRollout`. */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { RolloutParams } from "./events.js";
import { type RolloutOutput, runRollout } from "./rollout-flow.js";
import { resolveRuntime } from "./runtime.js";
import { fromWorkflowStep } from "./step.js";

export { evaluateHealth } from "./health.js";

export class RolloutWorkflow extends WorkflowEntrypoint<unknown, RolloutParams> {
  override async run(event: Readonly<WorkflowEvent<RolloutParams>>, step: WorkflowStep): Promise<RolloutOutput> {
    const { ports, bindings } = resolveRuntime(this.env, "default");
    return runRollout({ ports, bindings }, event.payload, fromWorkflowStep(step));
  }
}
