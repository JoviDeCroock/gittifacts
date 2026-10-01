/**
 * Per-repo resource scoping for agent principals (`Principal.repoIds`).
 *
 * A delegated session defaults to "can open Changes on repo X": its principal carries the repo ids
 * the human picked. `null` (or absent) means every repo the owner can access. Humans are never
 * repo-restricted here (their access is the repo's own policy).
 *
 * Enforced in three places that all call into this module:
 * - `requirePrincipal` (every HTTP route): the repo of `{repoId}`, `{planId}`, `{changeId}`, a JSON
 *   body's `repoId`/`planId`/`changeId`, or an audit `subject`;
 * - the MCP backend (every tool that names a repo, plan or change);
 * - the service layer (capabilities/whoami and list_repos only list granted repos; blobs; plans).
 */
import type { Principal } from "@app/domain";
import type { Context } from "hono";
import type { AppEnv, Caller, Services } from "../app-env.js";
import { ApiError } from "../errors.js";

/** The repo ids an agent is limited to, or null when it is not repo-restricted. */
export function restrictedRepoIds(p: Principal): readonly string[] | null {
  if (p.kind !== "agent") return null;
  return p.repoIds ?? null;
}

export function repoAllowed(p: Principal, repoId: string): boolean {
  const ids = restrictedRepoIds(p);
  return ids === null || ids.includes(repoId);
}

export function filterRepos<T extends { id: string }>(p: Principal, repos: readonly T[]): T[] {
  const ids = restrictedRepoIds(p);
  return ids === null ? [...repos] : repos.filter((r) => ids.includes(r.id));
}

export function repoNotGranted(p: Principal, repoId: string | null): ApiError {
  const allowed = restrictedRepoIds(p) ?? [];
  const where = repoId === null ? "this resource" : `repo ${repoId}`;
  return new ApiError(
    403,
    "repo-not-granted",
    `this agent session was not granted ${where}`,
    { repoId, allowedRepoIds: allowed },
    {
      explanation:
        `The human who approved this session limited it to ${allowed.length === 0 ? "no repos" : allowed.join(", ")}. ` +
        "Work on one of those (whoami lists them), or ask the human to approve a new session for this repo: connect again and pick it on the consent screen. A session can never widen its own repos.",
      call: "whoami({})",
    },
  );
}

export function assertRepoAllowed(p: Principal, repoId: string): void {
  if (!repoAllowed(p, repoId)) throw repoNotGranted(p, repoId);
}

export interface RepoTarget {
  repoId?: string | undefined;
  planId?: string | undefined;
  changeId?: string | undefined;
}

/**
 * The repos a request names. Unknown plan/change ids resolve to nothing: the handler answers
 * 404 for those, which leaks nothing about other repos.
 */
export async function reposOf(svc: Services, t: RepoTarget): Promise<string[]> {
  const out: string[] = [];
  if (t.repoId) out.push(t.repoId);
  if (t.planId) {
    const plan = await svc.store.getPlan(t.planId);
    if (plan) out.push(plan.repoId);
  }
  if (t.changeId) {
    const change = await svc.store.getChange(t.changeId);
    if (change) out.push(change.repoId);
  }
  return out;
}

/** Throws `repo-not-granted` when a repo-restricted agent names a repo outside its grant. */
export async function assertTargetAllowed(
  svc: Services,
  p: Principal,
  t: RepoTarget,
): Promise<void> {
  if (restrictedRepoIds(p) === null) return;
  for (const repoId of await reposOf(svc, t)) assertRepoAllowed(p, repoId);
}

/** `repo:<id>` / `plan:<id>` / `change:<id>` audit subjects → a target; anything else → null. */
export function targetOfSubject(subject: string): RepoTarget | null {
  const m = /^(repo|plan|change):(.+)$/.exec(subject);
  if (!m) return null;
  const id = m[2];
  if (m[1] === "repo") return { repoId: id };
  if (m[1] === "plan") return { planId: id };
  return { changeId: id };
}

/** Listing endpoints that span every repo: a repo-restricted agent must name a subject. */
const GLOBAL_LISTINGS = new Set(["/api/v1/audit"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

async function bodyTarget(c: Context<AppEnv>): Promise<RepoTarget> {
  if (c.req.method === "GET" || c.req.method === "HEAD") return {};
  if (!(c.req.header("content-type") ?? "").includes("application/json")) return {};
  // Read as text so later readers (validator, idempotency fingerprint) see the exact same bytes.
  const raw = await c.req.text();
  if (raw.length === 0) return {};
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return {}; // the route's validator rejects it
  }
  if (typeof body !== "object" || body === null) return {};
  const b = body as Record<string, unknown>;
  return { repoId: str(b.repoId), planId: str(b.planId), changeId: str(b.changeId) };
}

/** Route-level enforcement used by `requirePrincipal` for repo-restricted agents. */
export async function assertRouteRepoAccess(c: Context<AppEnv>, caller: Caller): Promise<void> {
  const p = caller.principal;
  if (restrictedRepoIds(p) === null) return;
  const svc = c.get("services");
  const params = c.req.param() as Record<string, string | undefined>;
  await assertTargetAllowed(svc, p, {
    repoId: str(params.repoId),
    planId: str(params.planId),
    changeId: str(params.changeId),
  });
  await assertTargetAllowed(svc, p, await bodyTarget(c));
  const subject = c.req.query("subject");
  const path = new URL(c.req.url).pathname;
  if (subject !== undefined) {
    const t = targetOfSubject(subject);
    if (t === null) throw repoNotGranted(p, null);
    await assertTargetAllowed(svc, p, t);
  } else if (GLOBAL_LISTINGS.has(path)) {
    throw repoNotGranted(p, null);
  }
}
