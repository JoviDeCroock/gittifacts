/**
 * Placeholder `CoordinatorApi` until the real coordinator (packages/coordinator) is wired in
 * src/coordinator.ts. Every lifecycle call fails with an `upstream` error (HTTP 502).
 */
import { type CoordinatorApi, CoordinatorError } from "@app/coordinator";

function notWired(): never {
  throw new CoordinatorError("upstream", "coordinator not wired", {
    explanation:
      "The change lifecycle engine is not deployed on this instance yet. Plans, reads and identity work; retry lifecycle calls later.",
  });
}

export const coordinatorStub: CoordinatorApi = {
  createRepo: async () => notWired(),
  importRepo: async () => notWired(),
  startChange: async () => notWired(),
  refreshPushGrant: async () => notWired(),
  onPush: async () => notWired(),
  submitReview: async () => notWired(),
  kill: async () => notWired(),
  setLane0: async () => notWired(),
  onIssue: async () => notWired(),
  abandon: async () => notWired(),
  waitFor: async () => notWired(),
  watchChange: async () => notWired(),
};
