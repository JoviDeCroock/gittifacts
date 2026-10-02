/**
 * `whoami` (MCP) / `GET /api/v1/capabilities`: what the caller is, what it may do, and where.
 * Quotas: an unclaimed project's agent gets its project's hard limits and today's use (O3).
 */
import type { Principal, Repo, Scope } from "@app/domain";
import { type AccessDeps, filterAccessible, repoAccess } from "../access/access.js";
import { isPlatformAuditor } from "../access/config.js";
import { allows, type RepoRole } from "../access/roles.js";
import type { Caller, Services } from "../app-env.js";
import type { SessionUser } from "../auth/principals.js";
import { unclaimedLimits } from "../limits/config.js";
import { usageOf } from "../limits/quotas.js";
import { isUnclaimedAgent } from "../limits/request-limit.js";

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
  /** The caller's effective role (an agent: its owner's; src/access/). */
  role: RepoRole | null;
  actions: RepoAction[];
  aiBudgetUsdPerChange: number;
}

export interface Quotas {
  /** True for an unclaimed project's agent (hard limits, O3); null = not metered. */
  enforced: boolean;
  ciMinutesPerDay: number | null;
  ciMinutesUsedToday: number | null;
  artifactsOpsPerDay: number | null;
  /** The storage quota (bytes); usage is in the ledger. */
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

/** What `principal` may do on `repo` with effective role `role` (scopes and role both apply). */
export function repoActions(
  principal: Principal,
  repo: Repo,
  role: RepoRole | null,
  readOnly = false,
): RepoAction[] {
  const has = (s: Scope) => principal.scopes.includes(s);
  const may = (need: Parameters<typeof allows>[2]) => allows(principal, role, need);
  const claimed = repo.claim.status === "claimed";
  const actions: RepoAction[] = [];
  if (may("read")) actions.push("read");
  if (readOnly) return actions; // platform auditors
  if (may("contribute") && has("plan:create")) actions.push("create-plan");
  if (may("contribute") && has("change:create")) actions.push("start-change");
  if (may("approve") && has("plan:approve")) actions.push("approve-plan");
  if (may("review")) actions.push("review-change");
  if (claimed && may("admin") && has("repo:admin")) actions.push("admin");
  // Unclaimed projects never get Lane 0 / auto-merge (onboarding §4).
  if (claimed && may("admin") && has("policy:admin") && !repo.policy.lane0Enabled)
    actions.push("enable-lane0");
  return actions;
}

async function roleOn(deps: AccessDeps, p: Principal, repo: Repo): Promise<RepoRole | null> {
  return (await repoAccess(deps, p, repo)).role;
}

export async function capabilities(svc: Services, caller: Caller): Promise<Capabilities> {
  // Only repos the caller can read: members' repos; agents via their owner, within their grant.
  const repos = caller.principal.scopes.includes("repo:read")
    ? await filterAccessible(svc, caller.principal, await svc.store.listRepos())
    : [];
  const roles = await Promise.all(repos.map((repo) => roleOn(svc, caller.principal, repo)));
  const readOnly = isPlatformAuditor(caller.principal, svc.env);
  return {
    principal: caller.principal,
    user: caller.user,
    scopes: caller.principal.scopes,
    canApprove:
      caller.principal.kind === "human" &&
      !readOnly &&
      caller.principal.scopes.includes("plan:approve"),
    repos: repos.map((repo, i) => ({
      id: repo.id,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      claim: repo.claim,
      template: repo.template,
      role: roles[i] ?? null,
      actions: repoActions(caller.principal, repo, roles[i] ?? null, readOnly),
      aiBudgetUsdPerChange: repo.policy.ai.budgetUsdPerChange,
    })),
    quotas: await quotasFor(svc, caller.principal, repos),
  };
}

/**
 * An unclaimed project's agent sees its project's hard limits and today's use (O3); everyone
 * else is not metered here (null = no platform quota).
 */
async function quotasFor(svc: Services, principal: Principal, repos: Repo[]): Promise<Quotas> {
  const project = repos.find((r) => r.claim.status !== "claimed");
  if (!isUnclaimedAgent(principal) || project === undefined) {
    return {
      enforced: false,
      ciMinutesPerDay: null,
      ciMinutesUsedToday: null,
      artifactsOpsPerDay: null,
      storageBytes: null,
    };
  }
  const l = unclaimedLimits(svc.env);
  const used = await usageOf(svc.env, svc.store, project.id, svc.clock.now().getTime());
  return {
    enforced: true,
    ciMinutesPerDay: l.ci.minutesPerDay,
    ciMinutesUsedToday: Math.ceil(used.project.ciMinutesUsedToday),
    artifactsOpsPerDay: l.artifactsOpsPerDay,
    storageBytes: l.storageBytes,
  };
}
