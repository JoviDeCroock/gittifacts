/**
 * The merge-queue tools' slice of the platform `McpBackend` (packages/mcp/src/tools/queue.ts):
 * repo-scoped (delegated sessions), mutations idempotent per (principal, key), rules in
 * ./service.ts (the same functions the HTTP routes call).
 */
import type { QueueToolsBackend } from "@app/mcp";
import type { Services } from "../app-env.js";
import type { McpBackendHelpers } from "../workspace/mcp.js";
import {
  dequeueChange,
  enqueueChange,
  queueOverview,
  queueStatus,
  reprioritizeChange,
  waitForMerge,
} from "./service.js";

export function createQueueMcpBackend(svc: Services, h: McpBackendHelpers): QueueToolsBackend {
  return {
    async enqueue(mc, input, opts) {
      const caller = await h.scoped(mc, { changeId: input.changeId });
      return h.idem(caller, "enqueue", opts.idempotencyKey, input, async () => {
        return enqueueChange(svc, caller, {
          changeId: input.changeId,
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
          ...(input.plangroup === undefined ? {} : { plangroup: input.plangroup }),
          ...(input.landTogether === undefined ? {} : { landTogether: input.landTogether }),
          ...(input.groupSize === undefined ? {} : { groupSize: input.groupSize }),
          ...(input.landMode === undefined ? {} : { landMode: input.landMode }),
          ...(input.incidentPlanId === undefined ? {} : { incidentPlanId: input.incidentPlanId }),
        });
      });
    },
    async queueStatus(mc, changeId) {
      await h.scoped(mc, { changeId });
      return queueStatus(svc, changeId);
    },
    async waitForMerge(mc, changeId, timeoutMs) {
      await h.scoped(mc, { changeId });
      return waitForMerge(svc, changeId, timeoutMs);
    },
    async dequeue(mc, changeId, opts) {
      const caller = await h.scoped(mc, { changeId });
      return h.idem(caller, "dequeue", opts.idempotencyKey, { changeId }, async () => {
        const r = await dequeueChange(svc, caller, changeId);
        return { status: r.status, removed: r.removed };
      });
    },
    async reprioritize(mc, input, opts) {
      const caller = await h.scoped(mc, { changeId: input.changeId });
      return h.idem(caller, "reprioritize", opts.idempotencyKey, input, async () => {
        const r = await reprioritizeChange(svc, caller, {
          changeId: input.changeId,
          priority: input.priority,
          ...(input.incidentPlanId === undefined ? {} : { incidentPlanId: input.incidentPlanId }),
        });
        return { status: r.status };
      });
    },
    async queueOverview(mc, repoId) {
      await h.scoped(mc, { repoId });
      return queueOverview(svc, repoId);
    },
  };
}
