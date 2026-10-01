/**
 * Where everything lives. The platform is both the authorization server (issuer = the origin,
 * no path, so metadata sits at `/.well-known/oauth-authorization-server`) and the protected
 * resources it issues tokens for: the MCP endpoint and the HTTP API.
 *
 * Protocol endpoints sit under `/api/oauth/*` because `/api/*` already runs the Worker first
 * (wrangler `run_worker_first`); `/oauth/consent` and `/device` are SPA screens.
 */
export const OAUTH_PATHS = {
  authorize: "/api/oauth/authorize",
  token: "/api/oauth/token",
  revoke: "/api/oauth/revoke",
  /** better-auth device-authorization plugin (RFC 8628 §3.1). */
  deviceCode: "/api/auth/device/code",
  /** SPA screens. */
  consent: "/oauth/consent",
  device: "/device",
  asMetadata: "/.well-known/oauth-authorization-server",
} as const;

export interface OAuthUrls {
  origin: string;
  issuer: string;
  mcpResource: string;
  apiResource: string;
  authorize: string;
  token: string;
  revoke: string;
  deviceCode: string;
  verification: string;
  consent: string;
  asMetadata: string;
}

export function oauthUrls(origin: string): OAuthUrls {
  const o = new URL(origin).origin;
  return {
    origin: o,
    issuer: o,
    mcpResource: `${o}/mcp`,
    apiResource: `${o}/api`,
    authorize: `${o}${OAUTH_PATHS.authorize}`,
    token: `${o}${OAUTH_PATHS.token}`,
    revoke: `${o}${OAUTH_PATHS.revoke}`,
    deviceCode: `${o}${OAUTH_PATHS.deviceCode}`,
    verification: `${o}${OAUTH_PATHS.device}`,
    consent: `${o}${OAUTH_PATHS.consent}`,
    asMetadata: `${o}${OAUTH_PATHS.asMetadata}`,
  };
}

/**
 * Canonical form of a resource indicator (RFC 8707 §2): absolute http(s) URI, no fragment,
 * lower-case scheme and host, no trailing slash. Null when it isn't one.
 */
export function canonicalResource(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.hash !== "" || raw.includes("#") || u.username !== "" || u.password !== "") return null;
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

export type AudienceResult = { ok: true; audience: string[] } | { ok: false; description: string };

/**
 * Resolve requested `resource` values to an audience. No resource: the MCP server for the code
 * flow (MCP clients MUST send it; we default rather than fail), both platform resources for the
 * device flow (a CLI uses the HTTP API and MCP).
 */
export function resolveAudience(
  urls: Pick<OAuthUrls, "mcpResource" | "apiResource">,
  requested: readonly string[],
  flow: "authorization_code" | "device_code",
): AudienceResult {
  const known = [urls.mcpResource, urls.apiResource];
  if (requested.length === 0) {
    return { ok: true, audience: flow === "device_code" ? known : [urls.mcpResource] };
  }
  const out: string[] = [];
  for (const raw of requested) {
    const canon = canonicalResource(raw);
    if (canon === null || !known.includes(canon)) {
      return {
        ok: false,
        description: `unknown resource "${raw}"; this authorization server issues tokens for ${known.join(" and ")}`,
      };
    }
    if (!out.includes(canon)) out.push(canon);
  }
  return { ok: true, audience: out };
}

/** Does a token audience admit this resource? NULL audience = any platform resource. */
export function audienceAllows(audience: readonly string[] | null, resource: string): boolean {
  return audience === null || audience.includes(resource);
}
