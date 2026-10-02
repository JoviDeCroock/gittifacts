/**
 * `PushRouter`: started by `triggers.events` for every `cf.artifacts.repo.pushed` in the namespace.
 * Validates the event and hands it to `coordinator.onPush`, which routes change-fork pushes to
 * the change's ChangeCoordinator DO (deletes, non-branch refs and main repos are ignored), then to
 * the runtime's optional `onPushEvent` observer (every push, main repos included).
 *
 *   "triggers": { "events": [{ "type": "cf.artifacts.repo.pushed",
 *     "filter": { "namespace": "gittifacts-eu" },
 *     "targets": [{ "type": "workflow", "workflow_name": "push-router" }] }] }
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { parsePushEvent } from "./push-router.js";
import { resolveRuntime } from "./runtime.js";
import { createCoordinator } from "./service.js";
import { fromWorkflowStep, RETRY } from "./step.js";

export interface PushRouterOutput {
  routed: boolean;
  reason: string | null;
}

export class PushRouter extends WorkflowEntrypoint<unknown, unknown> {
  override async run(
    event: Readonly<WorkflowEvent<unknown>>,
    workflowStep: WorkflowStep,
  ): Promise<PushRouterOutput> {
    const { ports, bindings, runtime } = resolveRuntime(this.env, "default");
    const parsed = parsePushEvent(event.payload, ports.git.namespace);
    if (!parsed.ok) return { routed: false, reason: parsed.reason };
    const step = fromWorkflowStep(workflowStep);
    await step.do("route", RETRY.quick, async () => {
      const coordinator = createCoordinator(ports, bindings, runtime.coordinatorOptions);
      await coordinator.onPush({
        repoName: parsed.repoName,
        ref: parsed.ref,
        before: parsed.before,
        after: parsed.after,
      });
      return true;
    });
    const observe = runtime.onPushEvent;
    if (observe) {
      // Observers (integration webhooks) run in their own step and never fail the routing.
      try {
        await step.do("observe", RETRY.quick, async () => {
          await observe(this.env, {
            namespace: parsed.namespace,
            repoName: parsed.repoName,
            ref: parsed.ref,
            before: parsed.before,
            after: parsed.after,
          });
          return true;
        });
      } catch (e) {
        console.error("push observer failed", parsed.repoName, parsed.ref, e);
      }
    }
    return { routed: true, reason: null };
  }
}
