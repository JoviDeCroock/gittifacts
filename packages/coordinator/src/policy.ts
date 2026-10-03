/**
 * The policy that governs a Change is the one on the default branch at its BASE sha, never the
 * head. The pure rules (claim restriction, the Lane 0 toggle, parsing, escalation) moved to
 * `@app/core` and are re-exported here; reading the file at BASE is native plumbing and stays.
 */

import {
  errorMessage,
  parsePolicyExport,
  type ResolvedPolicy,
  restrictForClaim,
  unavailablePolicy,
} from "@app/core";
import type { Repo } from "@app/domain";
import type { Ports } from "./ports.js";

export {
  errorMessage,
  escalateForPolicy,
  POLICY_UNAVAILABLE_CODE,
  type PolicySource,
  parsePolicyExport,
  type ResolvedPolicy,
  restrictForClaim,
  unavailablePolicy,
  withLane0Toggle,
} from "@app/core";

/**
 * Evaluate the policy at `sha` of `repoName` in the sandbox. `repo` may be null (import: no row
 * yet). Caches the result on the repo row when `sha` is the current default-branch head.
 */
export async function resolvePolicy(
  ports: Pick<Ports, "sandbox" | "store" | "git">,
  input: {
    repo: Repo | null;
    /** Claim state when `repo` is null (import); otherwise `repo.claim.status`. */
    claim?: Repo["claim"]["status"];
    repoName: string;
    sha: string;
    cache?: boolean;
    /** "throw" lets a workflow step retry a failing sandbox before giving up. */
    onSandboxError?: "unavailable" | "throw";
  },
): Promise<ResolvedPolicy> {
  const claim = input.repo?.claim.status ?? input.claim ?? "claimed";
  const resolved = await resolveRaw(ports, input);
  return { ...resolved, policy: restrictForClaim(resolved.policy, claim) };
}

async function resolveRaw(
  ports: Pick<Ports, "sandbox" | "store" | "git">,
  input: {
    repo: Repo | null;
    repoName: string;
    sha: string;
    cache?: boolean;
    onSandboxError?: "unavailable" | "throw";
  },
): Promise<ResolvedPolicy> {
  const { repo, sha } = input;
  if (repo !== null && repo.policySha === sha) {
    return { policy: repo.policy, source: "cache", error: null };
  }
  const toggle = repo?.policy.lane0Enabled ?? false;
  let raw: unknown;
  try {
    raw = await ports.sandbox.evaluatePolicy({ repo: input.repoName, sha });
  } catch (e) {
    if (input.onSandboxError === "throw") throw e;
    return unavailablePolicy(repo, `policy evaluation failed: ${errorMessage(e)}`);
  }
  const parsed = parsePolicyExport(raw, toggle);
  if ("error" in parsed) return unavailablePolicy(repo, parsed.error);
  if (repo !== null && input.cache !== false) {
    const head = await ports.git.branchHead(repo.artifactsName, repo.defaultBranch);
    if (head === sha) await ports.store.setRepoPolicy(repo.id, parsed.policy, sha);
  }
  return { policy: parsed.policy, source: parsed.source, error: null };
}
