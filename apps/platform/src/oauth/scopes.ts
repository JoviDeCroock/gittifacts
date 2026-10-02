/**
 * Scope policy for delegated agent sessions. Humans approve intent: approval-class scopes are
 * never offered, never parsed into a grant, and never issued, whatever an OAuth `scope` string,
 * a consent body or a refresh request says.
 */
import { INTEGRATION_ONLY_SCOPES, Scope } from "@app/domain";
import { AGENT_ALLOWED_SCOPES } from "../auth/principals.js";

/** What a delegated session can ever hold (same ceiling as manually created agents). */
export const DELEGABLE_SCOPES: readonly Scope[] = AGENT_ALLOWED_SCOPES;

/**
 * Never grantable to an agent, by any path: the approval/admin class. (Integration-only scopes
 * are not grantable to agents either, but they are not shown as "never" on the agent consent
 * screen: they mean nothing to an agent; `parseRequestedScopes` still rejects them.)
 */
export const NEVER_DELEGATED: readonly Scope[] = Scope.options.filter(
  (s) => !AGENT_ALLOWED_SCOPES.includes(s) && !INTEGRATION_ONLY_SCOPES.includes(s),
);

/** "Can open Changes on repo X": the default when a client asks for nothing specific. */
export const DEFAULT_SESSION_SCOPES: readonly Scope[] = ["repo:read", "change:create"];

/** OAuth/OIDC scopes generic clients append. They grant nothing here and are dropped. */
const IGNORED_SCOPES = new Set(["openid", "profile", "email", "offline_access"]);

export type ScopeParse =
  | { ok: true; scopes: Scope[] }
  | { ok: false; error: "invalid_scope"; description: string; never: Scope[]; unknown: string[] };

/**
 * Parse an RFC 6749 `scope` string from a client. Approval-class scopes are an error (not silently
 * dropped) so a client learns at once that no agent can hold them.
 */
export function parseRequestedScopes(raw: string | null | undefined): ScopeParse {
  const tokens = (raw ?? "").split(/\s+/).filter((t) => t.length > 0);
  const scopes: Scope[] = [];
  const never: Scope[] = [];
  const unknown: string[] = [];
  for (const t of tokens) {
    if (IGNORED_SCOPES.has(t)) continue;
    const parsed = Scope.safeParse(t);
    if (!parsed.success) {
      if (!unknown.includes(t)) unknown.push(t);
      continue;
    }
    const s = parsed.data;
    if (!DELEGABLE_SCOPES.includes(s)) {
      if (!never.includes(s)) never.push(s);
      continue;
    }
    if (!scopes.includes(s)) scopes.push(s);
  }
  if (never.length > 0) {
    return {
      ok: false,
      error: "invalid_scope",
      description: `agents can never hold ${never.join(", ")}: humans approve plans and changes. Request a subset of ${DELEGABLE_SCOPES.join(" ")}`,
      never,
      unknown,
    };
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      error: "invalid_scope",
      description: `unknown scope ${unknown.join(", ")}; supported: ${DELEGABLE_SCOPES.join(" ")}`,
      never,
      unknown,
    };
  }
  return { ok: true, scopes: scopes.length > 0 ? scopes : [...DEFAULT_SESSION_SCOPES] };
}

export type GrantCheck =
  | { ok: true; scopes: Scope[] }
  | { ok: false; reason: "not-delegable" | "not-held" | "empty"; rejected: Scope[] };

/**
 * The scopes a human picked on the consent screen: a non-empty subset of what agents may hold and
 * of what the human holds (you cannot delegate what you don't have).
 */
export function checkGrantedScopes(picked: readonly Scope[], held: readonly Scope[]): GrantCheck {
  const unique = [...new Set(picked)];
  const notDelegable = unique.filter((s) => !DELEGABLE_SCOPES.includes(s));
  if (notDelegable.length > 0)
    return { ok: false, reason: "not-delegable", rejected: notDelegable };
  const notHeld = unique.filter((s) => !held.includes(s));
  if (notHeld.length > 0) return { ok: false, reason: "not-held", rejected: notHeld };
  if (unique.length === 0) return { ok: false, reason: "empty", rejected: [] };
  return { ok: true, scopes: unique };
}

export function scopeString(scopes: readonly string[]): string {
  return scopes.join(" ");
}
