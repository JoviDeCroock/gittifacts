export {
  AFFECTED_VERSION,
  type ComputeInput,
  computeAffectedSet,
  contentNeeded,
  defaultAnalyzers,
  TEST_IMPACT_NAME,
} from "./affected.js";
export { PATH_RULES_NAME, pathRulesAnalyzer } from "./analyzers/path-rules.js";
export {
  MAX_SCAN_BYTES,
  TS_ANALYZER_NAME,
  TS_ANALYZER_VERSION,
  type TsPartialGraph,
  tsAnalyzer,
} from "./analyzers/ts.js";
export {
  configScope,
  isCodeFile,
  isConfigFile,
  isDocFile,
  isMetaFile,
  isScannedFile,
  isTestFile,
  isTestRunnerConfig,
  isTestSupportFile,
  snapshotOwner,
} from "./classify.js";
export {
  type Conflict,
  type ConflictReason,
  conflictBetween,
  conflictComponents,
} from "./conflict.js";
export {
  COVERAGE_MAP_FORMAT,
  CoverageMapError,
  coverageMapOf,
  type ParsedCoverageMap,
  parseCoverageMap,
} from "./coverage.js";
export { type ExportSurface, exportSurface, sameSurface } from "./exports.js";
export { ModuleGraph } from "./graph.js";
export { parseJsonc, stripJsonc } from "./jsonc.js";
export { createFileMatcher, globToRegExp } from "./paths.js";
export { isBuiltinSpecifier, matchSubpathMap, Resolver, splitPackageSpecifier } from "./resolve.js";
export {
  type ModuleRef,
  type ModuleScan,
  type RefKind,
  relativeStringLiterals,
  scanModule,
  setupFileLiterals,
  type TemplateGlob,
  type Token,
  tokenize,
} from "./scan.js";
export {
  AffectedSet,
  ALL_TESTS,
  type Analyzer,
  type AnalyzerContext,
  AnalyzerReport,
  type ChangeStatus,
  CONFIG_SENTINEL,
  type CoverageMap,
  type Edge,
  type FileChange,
  type PartialGraph,
  type RepoTree,
} from "./types.js";
export {
  discoverWorkers,
  isWorkerConfigFile,
  type WorkerConfig,
  type WorkerDiscovery,
} from "./workers.js";
