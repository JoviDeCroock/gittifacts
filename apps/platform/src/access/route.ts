/**
 * Route-level enforcement, run by `requirePrincipal` on every authenticated HTTP route: the repo
 * of a `{repoId}`/`{planId}`/`{changeId}` path param, of a JSON body's `repoId`/`planId`/
 * `changeId`, and of an audit `subject` must allow the route's need (derived from its scopes, or
 * given explicitly). Services re-check on what they load; this catches a route that forgets.
 */
import type { Context } from "hono";
import type { AppEnv, Caller } from "../app-env.js";
import { restrictedRepoIds, targetOfSubject } from "../auth/repo-scope.js";
import { ApiError } from "../errors.js";
import { type AccessTarget, assertTargetAccess } from "./access.js";
import { isPlatformAuditor } from "./config.js";
import { repoNotGranted } from "./errors.js";
import type { RepoNeed } from "./roles.js";

/** Listings that span every repo: a repo-restricted principal must name a subject. */
const GLOBAL_LISTINGS = new Set(["/api/v1/audit"]);

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

async function bodyTarget(c: Context<AppEnv>): Promise<AccessTarget> {
  if (READ_METHODS.has(c.req.method)) return {};
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

export function auditorReadOnly(): ApiError {
  return new ApiError(403, "forbidden", "platform auditors are read-only", undefined, {
    explanation:
      "This principal is a platform auditor (PLATFORM_AUDITORS): it can read every repo and the audit log, and never write, review or approve.",
  });
}

export async function assertRouteAccess(
  c: Context<AppEnv>,
  caller: Caller,
  need: RepoNeed,
): Promise<void> {
  const svc = c.get("services");
  const p = caller.principal;
  if (!READ_METHODS.has(c.req.method) && isPlatformAuditor(p, svc.env)) throw auditorReadOnly();
  const params = c.req.param() as Record<string, string | undefined>;
  await assertTargetAccess(
    svc,
    p,
    { repoId: str(params.repoId), planId: str(params.planId), changeId: str(params.changeId) },
    need,
  );
  await assertTargetAccess(svc, p, await bodyTarget(c), need);
  const subject = c.req.query("subject");
  const restricted = restrictedRepoIds(p) !== null;
  if (subject !== undefined) {
    const t = targetOfSubject(subject);
    if (t !== null) await assertTargetAccess(svc, p, t, "read");
    else if (restricted) throw repoNotGranted(p, null);
  } else if (restricted && GLOBAL_LISTINGS.has(new URL(c.req.url).pathname)) {
    throw repoNotGranted(p, null);
  }
}
