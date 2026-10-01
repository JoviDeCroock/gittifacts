/**
 * The policy that governs a Change is the one on the default branch at its BASE sha, never the
 * head. `lane0Enabled` is owned by the platform toggle (`setLane0`, which requires shadow-mode
 * agreement): a policy file can force Lane 0 off (`lane0Enabled: false`) but cannot turn it on.
 */

import type { ClassifyResult } from "@app/classifier";
import { defaultPolicy, type LaneReason, type Repo, RepoPolicy } from "@app/domain";
import type { Ports } from "./ports.js";

export type PolicySource = "cache" | "file" | "default" | "unavailable";

export interface ResolvedPolicy {
  policy: RepoPolicy;
  source: PolicySource;
  /** Why the policy could not be read (source "unavailable"). */
  error: string | null;
}

/**
 * Unclaimed projects (onboarding §4) never auto-merge: no Lane 0 and no verified-revert
 * auto-merge, whatever the policy file or toggle says.
 */
export function restrictForClaim(policy: RepoPolicy, claim: Repo["claim"]["status"]): RepoPolicy {
  if (claim === "claimed") return policy;
  return { ...policy, lane0Enabled: false, autoMergeVerifiedReverts: false };
}

/** Apply the platform toggle to a parsed file policy. */
export function withLane0Toggle(policy: RepoPolicy, raw: unknown, toggle: boolean): RepoPolicy {
  const fileForcesOff =
    typeof raw === "object" &&
    raw !== null &&
    (raw as { lane0Enabled?: unknown }).lane0Enabled === false;
  return { ...policy, lane0Enabled: toggle && !fileForcesOff };
}

/** Parse what `.platform/policy.ts` exported. `null` (no file) → defaults. */
export function parsePolicyExport(
  raw: unknown,
  toggle: boolean,
): { policy: RepoPolicy; source: "file" | "default" } | { error: string } {
  if (raw === null || raw === undefined) {
    return { policy: { ...defaultPolicy(), lane0Enabled: toggle }, source: "default" };
  }
  const parsed = RepoPolicy.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { error: `invalid .platform/policy.ts: ${issues}` };
  }
  return { policy: withLane0Toggle(parsed.data, raw, toggle), source: "file" };
}

/**
 * A policy we could not read is unknown: fall back to the cached (or default) policy with Lane 0
 * off, and the caller raises the lane (see `escalateForPolicy`).
 */
export function unavailablePolicy(
  repo: Pick<Repo, "policy"> | null,
  error: string,
): ResolvedPolicy {
  const base = repo?.policy ?? defaultPolicy();
  return { policy: { ...base, lane0Enabled: false }, source: "unavailable", error };
}

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

export const POLICY_UNAVAILABLE_CODE = "policy.unavailable";

/**
 * Unknown → escalate: when the base policy could not be read, the routed lane is at least 1
 * (never auto-merge under a policy we could not see). `computedLane` stays what the classifier
 * computed so shadow-mode statistics are not skewed.
 */
export function escalateForPolicy(
  result: ClassifyResult,
  resolved: ResolvedPolicy,
): ClassifyResult {
  if (resolved.source !== "unavailable") return result;
  const reason: LaneReason = {
    code: POLICY_UNAVAILABLE_CODE,
    lane: 1,
    message: `The base policy could not be read (${resolved.error ?? "unknown error"}); Lane 0 is off for this change.`,
  };
  return {
    ...result,
    lane: result.lane === 0 ? 1 : result.lane,
    reasons: [reason, ...result.reasons],
  };
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : JSON.stringify(e);
}
