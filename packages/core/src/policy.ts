/**
 * The policy that governs a Change is the one on the default branch at its BASE sha, never the
 * head. `lane0Enabled` is owned by the platform toggle (`setLane0`, which requires shadow-mode
 * agreement): a policy file can force Lane 0 off (`lane0Enabled: false`) but cannot turn it on.
 *
 * The pure half lives here (host-agnostic); reading the file at BASE is host plumbing
 * (`resolvePolicy` in `@app/coordinator`).
 */

import type { ClassifyResult } from "@app/classifier";
import { defaultPolicy, type LaneReason, type Repo, RepoPolicy } from "@app/domain";

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
