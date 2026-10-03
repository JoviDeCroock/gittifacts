/** Native refs and identities in host terms. */
import type { Change, Principal } from "@app/domain";
import type { ArtifactsChangeRef, IdentityKind } from "@app/host";

/** Native principals → host identity kinds (`system` and `integration` principals are bots). */
export function identityKindOf(kind: Principal["kind"] | undefined): IdentityKind {
  if (kind === "human" || kind === "agent") return kind;
  return "bot";
}

export function nativeRef(change: Pick<Change, "repoId" | "id">): ArtifactsChangeRef {
  return { host: "artifacts", repoId: change.repoId, changeId: change.id };
}
