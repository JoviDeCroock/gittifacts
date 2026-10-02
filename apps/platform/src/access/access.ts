/**
 * THE repo access chokepoint. Every route, service, MCP tool, stream, blob read and coordinator
 * call that names a repo (or a plan, change, blob or audit subject of one) asks here.
 *
 * Effective role of a principal on a repo:
 *   system       owner everywhere
 *   auditor      reader everywhere, unclaimed projects included (PLATFORM_AUDITORS); read-only
 *   human        its `repo_members` role; none on an unclaimed project (nobody is a member)
 *   agent        owned: its owner's role, only on `repoIds` when set (else 403 repo-not-granted);
 *                ownerless (O3): `reviewer` on its own unclaimed project (enough to contribute)
 *   integration  `reader` on its installation's repos while the installing human is a member
 * and then `refusalFor` adds the ceilings: global scopes, and review/approve/admin humans-only.
 */
import type { Change, Plan, Principal, Repo } from "@app/domain";
import { restrictedRepoIds } from "../auth/repo-scope.js";
import type { D1Store } from "../store/d1-store.js";
import { type AccessVars, isPlatformAuditor } from "./config.js";
import { noSuchChange, noSuchPlan, noSuchRepo, refused, repoNotGranted } from "./errors.js";
import { memberRole, membershipsOf } from "./members-store.js";
import { isSystem, type RepoNeed, type RepoRole, refusalFor } from "./roles.js";

/** What the checks read: `Services` satisfies it. */
export interface AccessDeps {
  store: D1Store;
  env: AccessVars;
}

export type AccessVia =
  | "system"
  | "auditor"
  | "member"
  | "owner"
  | "project"
  | "installation"
  | "none";

export interface RepoAccess {
  role: RepoRole | null;
  via: AccessVia;
  /** An agent outside its session's repos whose owner could see the repo (403, not 404). */
  notGranted: boolean;
}

const NONE: RepoAccess = { role: null, via: "none", notGranted: false };

/** Per-request memo (deps = the request's Services), so route + service checks cost one query. */
const memo = new WeakMap<object, Map<string, Promise<RepoAccess>>>();

function memoFor(deps: AccessDeps): Map<string, Promise<RepoAccess>> {
  let m = memo.get(deps);
  if (!m) {
    m = new Map();
    memo.set(deps, m);
  }
  return m;
}

function inGrant(p: Principal, repoId: string): boolean {
  const ids = restrictedRepoIds(p);
  return ids === null || ids.includes(repoId);
}

async function resolve(deps: AccessDeps, p: Principal, repo: Repo): Promise<RepoAccess> {
  if (isSystem(p)) return { role: "owner", via: "system", notGranted: false };
  if (isPlatformAuditor(p, deps.env)) {
    return inGrant(p, repo.id)
      ? { role: "reader", via: "auditor", notGranted: false }
      : { role: null, via: "none", notGranted: true };
  }
  const claimed = repo.claim.status === "claimed";
  if (p.kind === "human") {
    const role = claimed ? await memberRole(deps.store, repo.id, p.id) : null;
    return role === null ? NONE : { role, via: "member", notGranted: false };
  }
  if (p.kind === "agent" && p.ownerId === null) {
    // O3: an unclaimed project's own agent, on its own project only.
    const own = !claimed && (p.repoIds ?? []).includes(repo.id);
    return own ? { role: "reviewer", via: "project", notGranted: false } : NONE;
  }
  if ((p.kind === "agent" || p.kind === "integration") && p.ownerId !== null) {
    const ownerRole = claimed ? await memberRole(deps.store, repo.id, p.ownerId) : null;
    if (ownerRole === null) return NONE;
    if (!inGrant(p, repo.id)) return { role: null, via: "none", notGranted: true };
    return p.kind === "agent"
      ? { role: ownerRole, via: "owner", notGranted: false }
      : { role: "reader", via: "installation", notGranted: false };
  }
  return NONE;
}

/** How `p` may access `repo` (memoized per request). */
export function repoAccess(deps: AccessDeps, p: Principal, repo: Repo): Promise<RepoAccess> {
  const m = memoFor(deps);
  const key = `${p.id}\u0000${repo.id}\u0000${repo.claim.status}`;
  let r = m.get(key);
  if (!r) {
    r = resolve(deps, p, repo);
    m.set(key, r);
  }
  return r;
}

/** The principal's effective role on a repo (null: it may not even see it). */
export async function effectiveRole(
  deps: AccessDeps,
  p: Principal,
  repo: Repo | string,
): Promise<RepoRole | null> {
  const r = typeof repo === "string" ? await deps.store.getRepo(repo) : repo;
  return r === null ? null : (await repoAccess(deps, p, r)).role;
}

/** Throws unless `p` may do `need` on `repo`; `hidden` is the 404 to throw when it may not see it. */
async function check(
  deps: AccessDeps,
  p: Principal,
  repo: Repo,
  need: RepoNeed,
  hidden: () => Error,
): Promise<void> {
  const a = await repoAccess(deps, p, repo);
  if (a.role === null) throw a.notGranted ? repoNotGranted(p, repo.id) : hidden();
  if (a.via === "auditor" && need !== "read") throw refused(p, repo.id, need, "auditor", a.role);
  const why = refusalFor(p, a.role, need);
  if (why !== null) throw refused(p, repo.id, need, why, a.role);
}

/** The repo, after checking `p` may do `need` on it (404 when it may not see it). */
export async function assertRepoAccess(
  deps: AccessDeps,
  p: Principal,
  repoId: string,
  need: RepoNeed,
): Promise<Repo> {
  const repo = await deps.store.getRepo(repoId);
  if (!repo) throw noSuchRepo(repoId);
  await check(deps, p, repo, need, () => noSuchRepo(repoId));
  return repo;
}

/** The change, after checking `p` may do `need` on its repo (404 when it may not see it). */
export async function assertChangeAccess(
  deps: AccessDeps,
  p: Principal,
  changeId: string,
  need: RepoNeed,
): Promise<Change> {
  const change = await deps.store.getChange(changeId);
  if (!change) throw noSuchChange(changeId);
  const repo = await deps.store.getRepo(change.repoId);
  if (!repo) throw noSuchChange(changeId);
  await check(deps, p, repo, need, () => noSuchChange(changeId));
  return change;
}

/** The plan, after checking `p` may do `need` on its repo (404 when it may not see it). */
export async function assertPlanAccess(
  deps: AccessDeps,
  p: Principal,
  planId: string,
  need: RepoNeed,
): Promise<Plan> {
  const plan = await deps.store.getPlan(planId);
  if (!plan) throw noSuchPlan(planId);
  const repo = await deps.store.getRepo(plan.repoId);
  if (!repo) throw noSuchPlan(planId);
  await check(deps, p, repo, need, () => noSuchPlan(planId));
  return plan;
}

export interface AccessTarget {
  repoId?: string | undefined;
  planId?: string | undefined;
  changeId?: string | undefined;
}

/**
 * Every repo a request names must allow `need`. Ids that don't exist are skipped: the handler
 * answers 404 for those itself (and its service re-checks access on what it loads).
 */
export async function assertTargetAccess(
  deps: AccessDeps,
  p: Principal,
  t: AccessTarget,
  need: RepoNeed,
): Promise<void> {
  if (t.repoId !== undefined) {
    const repo = await deps.store.getRepo(t.repoId);
    if (repo) await check(deps, p, repo, need, () => noSuchRepo(repo.id));
  }
  if (t.planId !== undefined && (await deps.store.getPlan(t.planId)) !== null) {
    await assertPlanAccess(deps, p, t.planId, need);
  }
  if (t.changeId !== undefined && (await deps.store.getChange(t.changeId)) !== null) {
    await assertChangeAccess(deps, p, t.changeId, need);
  }
}

/** True when `p` may do `need` on `repo` (no throw). */
export async function canAccess(
  deps: AccessDeps,
  p: Principal,
  repo: Repo,
  need: RepoNeed,
): Promise<boolean> {
  try {
    await check(deps, p, repo, need, () => noSuchRepo(repo.id));
    return true;
  } catch {
    return false;
  }
}

/**
 * The repos `p` can read: "all" (system, unrestricted auditors) or a set of ids. Agents get their
 * owner's memberships within their grant; integrations their installation's repos the installer
 * is still a member of; an unclaimed project's agent its unclaimed project.
 */
export async function accessibleRepoIds(
  deps: AccessDeps,
  p: Principal,
): Promise<"all" | Set<string>> {
  if (isSystem(p)) return "all";
  const grant = restrictedRepoIds(p);
  if (isPlatformAuditor(p, deps.env)) return grant === null ? "all" : new Set(grant);
  const within = (ids: Iterable<string>) =>
    new Set([...ids].filter((id) => grant === null || grant.includes(id)));
  if (p.kind === "human") return new Set((await membershipsOf(deps.store, p.id)).keys());
  if (p.kind === "agent" && p.ownerId === null) {
    const out = new Set<string>();
    for (const id of grant ?? []) {
      const repo = await deps.store.getRepo(id);
      if (repo && repo.claim.status !== "claimed") out.add(id);
    }
    return out;
  }
  if ((p.kind === "agent" || p.kind === "integration") && p.ownerId !== null) {
    return within((await membershipsOf(deps.store, p.ownerId)).keys());
  }
  return new Set();
}

/** Keep only the repos `p` can read. */
export async function filterAccessible<T extends { id: string }>(
  deps: AccessDeps,
  p: Principal,
  repos: readonly T[],
): Promise<T[]> {
  const ids = await accessibleRepoIds(deps, p);
  return ids === "all" ? [...repos] : repos.filter((r) => ids.has(r.id));
}
