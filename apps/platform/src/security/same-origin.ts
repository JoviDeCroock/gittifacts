/**
 * CSRF guard for cookie-authenticated REST mutations (security audit M13).
 *
 * A non-GET/HEAD/OPTIONS request under `/api/` that carries the better-auth session cookie and no
 * `Authorization` header must come from the platform's own origin: `Origin` equal to the
 * browser-facing origin (BETTER_AUTH_URL, else the request's) or the request's own origin, the
 * same pair `/mcp` accepts (src/mcp/route.ts). Without `Origin`, `Sec-Fetch-Site` must be
 * `same-origin` or `none`. A request with neither header is not a browser (curl, scripts): a
 * browser always sends `Origin` on a non-GET fetch or form post, so it passes.
 *
 * Exempt, because they are cross-origin by design or guard themselves:
 * - `/api/auth/*`: better-auth checks `Origin` against `trustedOrigins` on its own routes;
 * - `/api/oauth/token`, `/api/oauth/revoke`: RFC 6749/7009 endpoints, CORS `*`, no cookies read;
 * - webhooks (`/webhooks/*`, `/github/webhooks`), `/git/*` and `/mcp` are outside `/api/`
 *   (`/mcp` has its own Origin check), and bearer/basic-authenticated calls carry `Authorization`.
 * The other CORS `*` endpoints (stats, docs, CLI, front door) are GET-only.
 */
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env.js";
import { ApiError, toErrorResponse } from "../errors.js";
import { originOf } from "../oauth/context.js";
import { OAUTH_PATHS } from "../oauth/urls.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const EXEMPT_PREFIXES = ["/api/auth/"] as const;
const EXEMPT_PATHS = new Set<string>([OAUTH_PATHS.token, OAUTH_PATHS.revoke]);
/** better-auth's session cookies, plain (http) or `__Host-`-prefixed (https). */
const SESSION_COOKIE = /(?:^|;\s*)(?:__Host-|__Secure-)?better-auth\.session_(?:token|data)=/;

function needsCheck(c: Context<AppEnv>, path: string): boolean {
  if (SAFE_METHODS.has(c.req.method)) return false;
  if (EXEMPT_PATHS.has(path) || EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return false;
  if (c.req.header("authorization")) return false;
  return SESSION_COOKIE.test(c.req.header("cookie") ?? "");
}

/** Why the request is refused, or null when it may proceed. */
export function crossSiteReason(c: Context<AppEnv>): string | null {
  const url = new URL(c.req.url);
  if (!needsCheck(c, url.pathname)) return null;
  const allowed = new Set([originOf(c), url.origin]);
  const origin = c.req.header("origin");
  if (origin !== undefined) {
    return allowed.has(origin) ? null : `Origin ${origin} is not this platform`;
  }
  const site = c.req.header("sec-fetch-site");
  if (site === undefined || site === "same-origin" || site === "none") return null;
  return `Sec-Fetch-Site: ${site}`;
}

export const sameOriginGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const reason = crossSiteReason(c);
  if (reason === null) return next();
  const err = new ApiError(
    403,
    "foreign-origin",
    `cross-site request refused: ${reason}`,
    { allowedOrigin: originOf(c) },
    {
      explanation: `A request signed in with the session cookie must come from the platform's own pages (${originOf(c)}). Scripts and agents send \`Authorization: Bearer …\` instead of the cookie.`,
    },
  );
  const r = toErrorResponse(err);
  return c.json(r.body, r.status);
};
