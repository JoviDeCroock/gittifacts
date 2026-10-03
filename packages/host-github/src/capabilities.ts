/**
 * What the GitHub host can do (docs/research/github-app.md, decisions 1 and 4). M2 is shadow
 * mode: the platform grades and posts one check run, and never merges, pushes or comments.
 * `canMerge` needs the per-customer Actor App and a configured ruleset path (M5).
 */
import type { HostCapabilities } from "@app/host";

export interface GithubRepoSetup {
  /** The Actor App (contents: write) is installed on this repo and path A is configured. */
  actorReady: boolean;
  /** The repo requires GitHub's merge queue on its default branch. */
  hostQueueRequired: boolean;
}

export const SHADOW_SETUP: GithubRepoSetup = { actorReady: false, hostQueueRequired: false };

export function githubCapabilities(setup: GithubRepoSetup = SHADOW_SETUP): HostCapabilities {
  // Bypass never carries into a required merge queue (research §2): no Lane 0 merge there.
  const canMerge = setup.actorReady && !setup.hostQueueRequired;
  return {
    canMerge,
    // Resolver pushes are M5 (same-repo branches, or forks with maintainer edits).
    canPushToChangeBranch: false,
    hasOwnMergeQueue: false,
    // We act as a required check on merge_group from M5; in shadow mode we don't plug in.
    hasHostMergeQueue: false,
    // Evidence is signed and linked from the check run; never pushed as git notes (§3.3).
    supportsNotes: false,
    // Tours become inline review comments in M3; shadow mode posts none.
    supportsInlineTourStops: false,
    identityKinds: ["human", "agent", "bot"],
    mergeMode: canMerge ? "bypass-direct" : "none",
    hostQueueRequired: setup.hostQueueRequired,
  };
}
