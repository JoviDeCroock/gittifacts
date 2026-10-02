/**
 * A `CoordinatorApi` for route/MCP tests that inject their own lifecycle behaviour: every method
 * a test does not override fails with an `upstream` error (HTTP 502), like a coordinator whose
 * dependencies are down. The deployed Worker always uses the real coordinator (src/coordinator.ts).
 */
import { type CoordinatorApi, CoordinatorError } from "@app/coordinator";

function down(): never {
  throw new CoordinatorError("upstream", "coordinator unavailable", {
    explanation: "The change lifecycle engine did not answer. Retry with the same idempotency key.",
  });
}

export const unavailableCoordinator: CoordinatorApi = {
  createRepo: async () => down(),
  importRepo: async () => down(),
  startBootstrapChange: async () => down(),
  startChange: async () => down(),
  refreshPushGrant: async () => down(),
  onPush: async () => down(),
  submitReview: async () => down(),
  kill: async () => down(),
  setLane0: async () => down(),
  ensureProjectFlags: async () => down(),
  onIssue: async () => down(),
  abandon: async () => down(),
  waitFor: async () => down(),
  watchChange: async () => down(),
};
