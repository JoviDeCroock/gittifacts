/**
 * Security headers on every platform response (security audit M1): API JSON, errors, better-auth,
 * and the static assets (the SPA's HTML, docs, the CLI tarball) that pass through `ASSETS.fetch`.
 *
 * Project Workers share the platform's registrable domain (`*.<account>.workers.dev`), so a
 * tenant page could frame `/oauth/consent` or a plan approval and ride the Lax session cookie.
 * Nothing on the platform is meant to be framed: `frame-ancestors 'none'` + `X-Frame-Options`.
 *
 * Headers a route already set are kept (blobs and QA thumbnails send a stricter sandboxed CSP);
 * a CSP without `frame-ancestors` gets a second policy appended, and browsers enforce both.
 * No `script-src` policy here: the SPA's build has not been audited against one.
 */
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";

export const FRAME_ANCESTORS = "frame-ancestors 'none'";

const DEFAULTS: readonly (readonly [string, string])[] = [
  ["x-frame-options", "DENY"],
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
];

/** Call after `next()`: adds what the response lacks, never weakens what it has. */
export function applySecurityHeaders(c: Context<AppEnv>): void {
  // A WebSocket upgrade's 101 carries the socket; leave it exactly as the handler built it.
  if (c.res.status === 101) return;
  const headers = c.res.headers;
  const csp = headers.get("content-security-policy");
  if (csp === null || !/frame-ancestors/i.test(csp)) {
    c.header("content-security-policy", FRAME_ANCESTORS, { append: true });
  }
  for (const [name, value] of DEFAULTS) {
    if (!c.res.headers.has(name)) c.header(name, value);
  }
}
