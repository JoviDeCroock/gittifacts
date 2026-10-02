/**
 * The repo role model (pure: no I/O). See DECISIONS.md "Repo membership".
 *
 *   reader      read the repo: plans, changes, evidence, tours, rollouts, its audit events
 *   reviewer    + contribute (its agents draft plans and start changes) + review changes
 *   maintainer  + approve/reject plans, pull the kill switch on a rollout
 *   owner       + members, deploy target, Lane 0, merge-queue freeze/thaw, policy-sensitive acts
 *
 * Global scopes stay a second ceiling (a need is met only with one of NEED_SCOPES[need]), and
 * review/approve/admin are for humans only: agents never approve, whatever their owner's role.
 */
import type { Principal, Scope } from "@app/domain";
import { REPO_ROLES } from "../db/access-schema.js";

export { REPO_ROLES };
export type RepoRole = (typeof REPO_ROLES)[number];

/** What a call needs on a repo. */
export type RepoNeed = "read" | "contribute" | "review" | "approve" | "admin";
export const REPO_NEEDS: readonly RepoNeed[] = ["read", "contribute", "review", "approve", "admin"];

const RANK: Record<RepoRole, number> = { reader: 1, reviewer: 2, maintainer: 3, owner: 4 };

/** The least role that meets a need. */
export const MIN_ROLE: Record<RepoNeed, RepoRole> = {
  read: "reader",
  contribute: "reviewer",
  review: "reviewer",
  approve: "maintainer",
  admin: "owner",
};

/** Global-scope ceiling: the principal must hold at least one of these. */
export const NEED_SCOPES: Record<RepoNeed, readonly Scope[]> = {
  // Integrations may hold only their own scopes (e.g. deployments:write): each implies seeing
  // the repos of their installation. The route's own scope list still applies on top.
  read: ["repo:read", "contents:read", "webhooks", "deployments:write", "checks:write"],
  contribute: ["plan:create", "change:create"],
  review: ["change:review"],
  approve: ["plan:approve", "change:review"],
  admin: ["repo:admin", "policy:admin"],
};

/** "Humans approve intent": only humans review, approve or administer. */
export const HUMAN_ONLY_NEEDS: readonly RepoNeed[] = ["review", "approve", "admin"];

/** What each need is called in messages. */
export const NEED_TEXT: Record<RepoNeed, string> = {
  read: "reading this repo",
  contribute: "drafting plans and starting changes",
  review: "reviewing changes",
  approve: "approving plans and pulling the kill switch",
  admin: "administering the repo (members, deploy target, Lane 0)",
};

export function isRepoRole(v: unknown): v is RepoRole {
  return typeof v === "string" && (REPO_ROLES as readonly string[]).includes(v);
}

export function roleAtLeast(role: RepoRole | null, min: RepoRole): boolean {
  return role !== null && RANK[role] >= RANK[min];
}

/** The lower of two roles (null = no access). */
export function minRole(a: RepoRole | null, b: RepoRole | null): RepoRole | null {
  if (a === null || b === null) return null;
  return RANK[a] <= RANK[b] ? a : b;
}

export function isSystem(p: Principal): boolean {
  return p.kind === "system";
}

/** Why a principal with `role` may not meet `need` (null = it may). */
export type Refusal = "human-only" | "scope" | "role";

export function refusalFor(p: Principal, role: RepoRole | null, need: RepoNeed): Refusal | null {
  if (isSystem(p)) return null;
  if (HUMAN_ONLY_NEEDS.includes(need) && p.kind !== "human") return "human-only";
  if (!NEED_SCOPES[need].some((s) => p.scopes.includes(s))) return "scope";
  if (!roleAtLeast(role, MIN_ROLE[need])) return "role";
  return null;
}

export function allows(p: Principal, role: RepoRole | null, need: RepoNeed): boolean {
  return role !== null && refusalFor(p, role, need) === null;
}

/**
 * The need a route's scope list implies (requirePrincipal's default): the strongest scope wins.
 * Routes whose need differs from their scope (the kill switch is `change:review` but `approve`)
 * pass it explicitly.
 */
export function needForScopes(scopes: readonly Scope[]): RepoNeed {
  if (scopes.includes("repo:admin") || scopes.includes("policy:admin")) return "admin";
  if (scopes.includes("plan:approve")) return "approve";
  if (scopes.includes("change:review")) return "review";
  if (scopes.includes("plan:create") || scopes.includes("change:create")) return "contribute";
  return "read";
}
