/**
 * Platform-level grants from Worker vars (principal ids, never e-mails: e-mail sign-up is
 * unverified, so an address could be registered before its owner does).
 *
 * - `PLATFORM_ADMINS`: may read platform-wide audit events (and use the admin routes in
 *   src/limits/routes.ts). Admin status gives no repo access.
 * - `PLATFORM_AUDITORS`: read-only on every repo, unclaimed projects included, and the whole
 *   audit log; refused on every mutation (the onboarding eval's checker). Use a dedicated
 *   principal: an auditor's own memberships are capped at `reader` too.
 */
import type { Principal } from "@app/domain";

export interface AccessVars {
  PLATFORM_ADMINS?: string | undefined;
  PLATFORM_AUDITORS?: string | undefined;
}

function idList(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function isPlatformAdmin(p: Principal, env: AccessVars): boolean {
  return p.kind === "human" && idList(env.PLATFORM_ADMINS).includes(p.id);
}

/** Humans or agents (an operator's checker token); never integrations or the system. */
export function isPlatformAuditor(p: Principal, env: AccessVars): boolean {
  return (p.kind === "human" || p.kind === "agent") && idList(env.PLATFORM_AUDITORS).includes(p.id);
}
