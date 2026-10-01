export {
  type ApplyResult,
  applyModelResolution,
  normalizeText,
  type ResolvedFileChange,
} from "./apply.js";
export {
  type EjectCause,
  type EjectContext,
  ejectReason,
  type ResolverEjectCode,
  type ResolverEjectReason,
} from "./eject.js";
export {
  ApplyResolutionDoc,
  ConflictFileDoc,
  ConflictKind,
  MERGE_PREFIX,
  MergeAttempt,
  MergeMarkers,
  parseMergeOutput,
} from "./merge-doc.js";
export { applyFileDiff, buildPatch, PatchError } from "./patch.js";
export {
  buildResolverPrompt,
  buildRetryPrompt,
  fitText,
  neutralize,
  RESOLVER_PROMPT_VERSION,
  RESOLVER_SYSTEM_PROMPT,
  type ResolverPromptInput,
  renderConflicts,
  renderContextFiles,
  renderPlan,
} from "./prompt.js";
export {
  applyFailed,
  type ConflictResolver,
  type ContextFileInput,
  createResolver,
  type FailingTest,
  RESOLUTION_EVIDENCE_ID,
  RESOLVER_PRINCIPAL_ID,
  type ResolutionOutcome,
  type ResolverCallRecord,
  type ResolverDiagnostics,
  type ResolverInput,
  type ResolverOptions,
  type SemanticConflictInput,
  type UpstreamChangeInput,
} from "./resolver.js";
export { ModelFileEdit, ModelRegion, ModelResolution, RESOLUTION_JSON_SCHEMA } from "./schema.js";
export {
  ABBREVIATE_ABOVE_LINES,
  buildWorkspace,
  type ConflictedFile,
  type ContextFile,
  type Eol,
  eolOf,
  type Workspace,
  type WorkspaceResult,
} from "./workspace.js";
