/**
 * `@app/ci-engine/cloudflare`: the opt-in `@cloudflare/ci` adapter. Not imported by the default
 * entry. A Worker that wants it exports `GittifactsCIWorkflow` (plus `CiSandbox` from
 * `@cloudflare/ci/worker`) and calls `selectCiEngineWithCloudflare(env, { engine })`.
 */
export {
  CloudflareCiEngine,
  type CloudflareCiEngineOptions,
  type CloudflareCiEnv,
  type CloudflareCiParams,
  cloudflareCiEngineFactory,
  isCloudflareCiEnv,
  selectCiEngineWithCloudflare,
} from "./engine.js";
export {
  failureOutput,
  type ReplayContext,
  type ReplayHooks,
  type ReplayResult,
  type ReplayStepResult,
  replayPipeline,
  toRunnerOptions,
} from "./replay.js";
export { buildReplaySummary, replayStepStatus } from "./summary.js";
export type { CfCiContext, CfCiParams, CfRunnerOptions, CfRunnerResult } from "./types.js";
export { type GittifactsCfBindings, GittifactsCIWorkflow } from "./workflow.js";
