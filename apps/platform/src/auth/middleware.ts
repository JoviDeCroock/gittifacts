import type { Scope } from "@app/domain";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, Caller } from "../app-env.js";
import { ApiError, forbidden, unauthorized } from "../errors.js";
import { urlsFor } from "../oauth/context.js";
import { audienceAllows } from "../oauth/urls.js";
import { isAgentToken, verifyAgentToken } from "./agent-tokens.js";
import { createAuth } from "./better-auth.js";
import { ensureHumanPrincipal } from "./principals.js";
import { assertRouteRepoAccess } from "./repo-scope.js";

export function authFor(c: Context<AppEnv>) {
  return createAuth(c.env, {
    origin: new URL(c.req.url).origin,
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1] ?? null;
}

/**
 * Resolve the caller once per request: a `gtf_` bearer token → agent principal; otherwise a
 * better-auth session (cookie, or a session token as bearer) → human principal, created with the
 * default human scopes on first sign-in. An agent token that fails verification never falls back
 * to the session. A token bound to another resource (e.g. an MCP-only OAuth token) is refused
 * with a 401 that says which resource it is for (RFC 8707 audience check).
 */
export async function resolveCaller(c: Context<AppEnv>): Promise<Caller | null> {
  const cached = c.get("caller");
  if (cached !== undefined) return cached;
  const { store, clock } = c.get("services");
  let caller: Caller | null = null;
  const token = bearerToken(c.req.header("authorization"));
  if (token && isAgentToken(token)) {
    const v = await verifyAgentToken(store, token, clock.now(), (p) => c.executionCtx.waitUntil(p));
    if (v) {
      const api = urlsFor(c).apiResource;
      if (!audienceAllows(v.audience, api)) {
        c.set("caller", null);
        throw new ApiError(
          401,
          "unauthorized",
          `this token was issued for ${v.audience?.join(", ")}, not the HTTP API (${api})`,
          { audience: v.audience, resource: api },
          {
            explanation: `Use this token only with ${v.audience?.join(", ")}. For the HTTP API, authorize again with resource=${api} (or use the device flow, whose tokens cover both).`,
          },
        );
      }
    }
    caller = v
      ? { principal: v.principal, user: null, via: "agent-token", expiresAtSec: v.expiresAtSec }
      : null;
  } else {
    const session = await authFor(c).api.getSession({ headers: c.req.raw.headers });
    if (session) {
      const user = {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image ?? null,
      };
      const principal = await ensureHumanPrincipal(store, user, clock.now());
      caller = { principal, user, via: "session" };
    }
  }
  c.set("caller", caller);
  return caller;
}

export function callerOf(c: Context<AppEnv>): Caller {
  const caller = c.get("caller");
  if (!caller) throw unauthorized();
  return caller;
}

export function assertScopes(caller: Caller, scopes: readonly Scope[]): void {
  const missing = scopes.filter((s) => !caller.principal.scopes.includes(s));
  if (missing.length > 0) {
    throw new ApiError(403, "insufficient-scope", `missing scope: ${missing.join(", ")}`, {
      required: scopes,
      missing,
    });
  }
}

/**
 * Route guard: 401 without a principal, 403 when a scope is missing (code `insufficient-scope`),
 * when `humanOnly` and the caller is an agent, or when a repo-restricted agent names a repo,
 * plan or change outside its grant (code `repo-not-granted`).
 */
export function requirePrincipal(
  scopes: readonly Scope[] = [],
  opts: { humanOnly?: boolean } = {},
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const caller = await resolveCaller(c);
    if (!caller) throw unauthorized();
    if (opts.humanOnly && caller.principal.kind !== "human") {
      throw forbidden("only a human may do this", { kind: caller.principal.kind });
    }
    assertScopes(caller, scopes);
    await assertRouteRepoAccess(c, caller);
    await next();
  };
}
