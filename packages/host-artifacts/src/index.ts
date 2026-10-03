/**
 * `@app/host-artifacts`: the native host adapter (Cloudflare Artifacts as the source of truth,
 * the platform's own merge queue, git-notes evidence).
 *
 * The adapter is a thin layer over the coordinator's ports. The native plumbing it stands on
 * stays where it was (`@app/coordinator/adapters`: ArtifactsGitHost over `@app/gitwire`; the
 * MergeQueue DO; `@app/coordinator`'s native grading helpers) and is re-exported here, so new
 * code can import native plumbing from one place while every old import path keeps working.
 */

export {
  durableStages,
  persistClassification,
  persistTour,
  storeGradeData,
} from "@app/coordinator";
export {
  type ArtifactsBindingLike,
  ArtifactsGitHost,
  type ArtifactsGitHostOptions,
} from "@app/coordinator/adapters";
export {
  ArtifactsHost,
  type ArtifactsHostDeps,
  SANDBOX_TOKEN_TTL_SECONDS,
} from "./artifacts-host.js";
export { ANCESTRY_LIMIT, normalizeArtifactsEvent } from "./events.js";
export { identityKindOf, nativeRef } from "./ref.js";
