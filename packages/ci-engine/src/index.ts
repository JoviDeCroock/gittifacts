/**
 * `@app/ci-engine`: CI for Changes. The default engine is `WorkflowsCiEngine`
 * (`CiRunWorkflow` + `Runner` on `ctx.container`). The `@cloudflare/ci` adapter is opt-in from
 * `@app/ci-engine/cloudflare` and is not imported here.
 *
 * The platform Worker must export `CiRunWorkflow` and `Runner` from its entry module.
 */

export { compileGlobs, globToRegExp } from "./cache/glob.js";
export { computeCacheKey, matchBlobs } from "./cache/key.js";
export { CACHE_MAX_AGE_MS, CachePointer, cachePointerKey } from "./cache/pointer.js";
export type { RepoReader, TreeBlob } from "./cache/tree.js";
export * from "./engine.js";
export * from "./evidence-steps.js";
export * from "./plan/index.js";
export {
  buildRunStatus,
  CancelRecord,
  type InstanceStatusLike,
  loadRunSnapshot,
  PipelineRecord,
  RunKeys,
  RunOutput,
  RunRecord,
  StepRecord,
  summarizeUsage,
  UsageRecord,
} from "./run-store.js";
export {
  type DurableResult,
  type DurableRunnerStub,
  RunnerJobId,
  RunnerJobLostError,
  RunnerJobState,
  runDurably,
  runOnRunner,
} from "./runner/client.js";
export type { ContainerLike, ExecProcessLike } from "./runner/container.js";
export { pumpText } from "./runner/container.js";
export {
  CONTAINERS_CA_PATH,
  EGRESS_GATEWAY_EXPORT,
  EgressDenial,
  EgressProps,
  egressDecision,
  REGISTRY_HOSTS,
} from "./runner/egress.js";
export { CiEgressGateway, type EgressGatewayEnv } from "./runner/egress-gateway.js";
export { EvidenceDocument, parseEvidenceDocument } from "./runner/evidence.js";
export {
  PlanJob,
  PlanOutcome,
  RunnerJob,
  type RunnerJobInput,
  RunnerOutcome,
  type RunnerRpc,
  runnerName,
} from "./runner/job.js";
export {
  EVIDENCE_MARKER,
  lastMarkedLine,
  PLAN_MARKER,
  PREVIEW_MARKER,
  parsePlanOutput,
} from "./runner/markers.js";
export { createStreamRedactor, REDACTED, redactText } from "./runner/redact.js";
export type { ContainerTime, RunnerEnv } from "./runner/runner-do.js";
export { Runner, snapshotName, stepEnv } from "./runner/runner-do.js";
// The image's shell contract, for other `ctx.container` hosts on the same image (previews).
export {
  CHECKOUT_SCRIPT,
  checkoutEnv,
  RUNNER_HOME,
  RUNNER_USER,
  ROOT_USER,
  shellQuote,
  timedCommandArgv,
  trustCaScript,
  WORKSPACE,
} from "./runner/shell.js";
export * from "./select.js";
export type { ObjectStore } from "./storage.js";
export type {
  CacheKeys,
  CiWorkflowEnv,
  Prepared,
  ResolvedPipeline,
  RunnerNamespace,
  RunSinkNamespace,
  StepResult,
} from "./workflows/ci-run.js";
export { CiRunWorkflow, stepConfig, toStepStatus } from "./workflows/ci-run.js";
export { CI_PIPELINE_FILE, ENGINE_STEPS } from "./workflows/constants.js";
export type {
  RunnerControlNamespace,
  WorkflowBackedEngineOptions,
  WorkflowInstanceLike,
  WorkflowLike,
  WorkflowsCiEngineOptions,
} from "./workflows/engine.js";
export { WorkflowBackedEngine, WorkflowsCiEngine } from "./workflows/engine.js";
