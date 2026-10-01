/**
 * The plan-mode surface of `@app/ci-engine` (recorder, PipelineSpec, default pipelines, package
 * manager detection). Imported from the package's `src/plan` directly because the package does
 * not export a `./plan` subpath yet; this file is the single place to switch once it does.
 */
export {
  DEFAULT_INSTALL_STEP,
  defaultPipeline,
  detectPackageManager,
  detectRepoFeatures,
  installCommand,
  lockfileFor,
  type PackageManager,
  PipelineSpec,
  PlanError,
  type RepoFacts,
  recordPipeline,
  resolvePipelineExport,
} from "../../../../packages/ci-engine/src/plan/index.js";
