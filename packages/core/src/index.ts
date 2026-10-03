/**
 * `@app/core`: the host-agnostic domain. It never knows which host a change lives on.
 *
 * - the vocabulary: Change, Plan, Tour, Evidence, policy schemas (`@app/domain`)
 * - the classifier (`@app/classifier`) and the policy rules around it
 * - evidence assembly, and `gradeChange`: the grading pipeline both hosts run
 * - the host boundary types (`@app/host`), re-exported for convenience
 *
 * Heavier engines are subpaths so importing the core stays cheap: `@app/core/evidence` (the
 * evidence engine), `@app/core/queue` (merge-queue core), `@app/core/tour` (reviewer agent).
 */
export * from "@app/classifier";
export * from "@app/domain";
export type {
  ChangeMeta,
  ChangeRef,
  Degradation,
  DiffInfo,
  HostAdapter,
  HostCapabilities,
  HostEvent,
  LaneAction,
  LaneVerdict,
  MergeResult,
  SandboxCheckout,
} from "@app/host";
export * from "./evidence.js";
export { gradeChange } from "./grade.js";
export { type MemoryGradeOptions, type MemoryGradeState, memoryGradeDeps } from "./memory.js";
export * from "./policy.js";
export * from "./ports.js";
