/**
 * What an unclaimed project can never have (onboarding §4): secrets, custom domains, production
 * deploys (a `deployTarget`), Lane 0 / auto-merge. The platform has no API that sets secrets or
 * custom domains at all; `PATCH /repos/{id}/deploy-target` calls `assertClaimedFor` first. These
 * refusals are the gate any such API must call first, and the store calls
 * `guardUnclaimedRepoWrite` on every repo write as the last line of defence (a deploy target on an
 * unclaimed repo is refused even from internal code).
 *
 * Dependency-free on purpose: the store (src/store/d1-store.ts) and the error mapper
 * (src/errors.ts) both import it.
 */
export type UnclaimedRefusal =
  | "secrets"
  | "custom domains"
  | "production deploys"
  | "a deploy target"
  | "Lane 0 / auto-merge";

export class UnclaimedLimitError extends Error {
  override readonly name = "UnclaimedLimitError";
  constructor(
    readonly refused: UnclaimedRefusal,
    readonly repoId: string,
  ) {
    super(`unclaimed project ${repoId} can't have ${refused}`);
  }
}

/** Throws unless `repo` is claimed. */
export function assertClaimedFor(
  repo: { id: string; claim: { status: "claimed" | "unclaimed" } },
  refused: UnclaimedRefusal,
): void {
  if (repo.claim.status !== "claimed") throw new UnclaimedLimitError(refused, repo.id);
}

/**
 * Store-level guard for every repo row written: an unclaimed repo may never carry a deploy
 * target (refused), and its stored policy always has Lane 0 and verified-revert auto-merge off
 * (normalized, like the coordinator's `restrictForClaim`).
 */
export function guardUnclaimedRepoWrite<
  R extends {
    id: string;
    claim: { status: "claimed" | "unclaimed" };
    deployTarget: string | null;
    policy: { lane0Enabled: boolean; autoMergeVerifiedReverts: boolean };
  },
>(repo: R): R {
  if (repo.claim.status === "claimed") return repo;
  if (repo.deployTarget !== null) throw new UnclaimedLimitError("a deploy target", repo.id);
  if (!repo.policy.lane0Enabled && !repo.policy.autoMergeVerifiedReverts) return repo;
  return {
    ...repo,
    policy: { ...repo.policy, lane0Enabled: false, autoMergeVerifiedReverts: false },
  };
}
