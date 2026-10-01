/**
 * `whoami` (MCP) / `GET /api/v1/capabilities`: what the caller is, what it may do, and where.
 * Quotas are placeholders until onboarding O3 enforces them.
 */
import type { Principal, Repo, Scope } from "@app/domain";
import type { Caller, Services } from "../app-env.js";
import type { SessionUser } from "../auth/principals.js";
import { filterRepos } from "../auth/repo-scope.js";

export const REPO_ACTIONS = [
  "read",
  "create-plan",
  "start-change",
  "approve-plan",
  "review-change",
  "admin",
  "enable-lane0",
] as const;
export type RepoAction = (typeof REPO_ACTIONS)[number];

export interface RepoCapability {
  id: string;
  name: string;
  defaultBranch: string;
  claim: Repo["claim"];
  template: string | null;
  actions: RepoAction[];
  aiBudgetUsdPerChange: number;
}

export interface Quotas {
  /** Not enforced yet (onboarding O3); null = unlimited / unknown. */
  enforced: boolean;
  ciMinutesPerDay: number | null;
  ciMinutesUsedToday: number | null;
  artifactsOpsPerDay: number | null;
  storageBytes: number | null;
}

export interface Capabilities {
  principal: Principal;
  user: SessionUser | null;
  scopes: Scope[];
  /** Humans with plan:approve. Agents: always false. */
  canApprove: boolean;
  repos: RepoCapability[];
  quotas: Quotas;
}

export function repoActions(principal: Principal, repo: Repo): RepoAction[] {
  const has = (s: Scope) => principal.scopes.includes(s);
  const human = principal.kind === "human";
  const claimed = repo.claim.status === "claimed";
  const actions: RepoAction[] = [];
  if (has("repo:read")) actions.push("read");
  if (has("plan:create")) actions.push("create-plan");
  if (has("change:create")) actions.push("start-change");
  if (human && has("plan:approve")) actions.push("approve-plan");
  if (human && has("change:review")) actions.push("review-change");
  if (human && claimed && has("repo:admin")) actions.push("admin");
  // Unclaimed projects never get Lane 0 / auto-merge (onboarding §4).
  if (human && claimed && has("repo:admin") && !repo.policy.lane0Enabled)
    actions.push("enable-lane0");
  return actions;
}

export async function capabilities(svc: Services, caller: Caller): Promise<Capabilities> {
  // Repo-restricted agents (delegated sessions) only see the repos they were granted.
  const repos = caller.principal.scopes.includes("repo:read")
    ? filterRepos(caller.principal, await svc.store.listRepos())
    : [];
  return {
    principal: caller.principal,
    user: caller.user,
    scopes: caller.principal.scopes,
    canApprove:
      caller.principal.kind === "human" && caller.principal.scopes.includes("plan:approve"),
    repos: repos.map((repo) => ({
      id: repo.id,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      claim: repo.claim,
      template: repo.template,
      actions: repoActions(caller.principal, repo),
      aiBudgetUsdPerChange: repo.policy.ai.budgetUsdPerChange,
    })),
    quotas: {
      enforced: false,
      ciMinutesPerDay: null,
      ciMinutesUsedToday: null,
      artifactsOpsPerDay: null,
      storageBytes: null,
    },
  };
}
