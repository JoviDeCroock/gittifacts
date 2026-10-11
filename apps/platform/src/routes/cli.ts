/**
 * The CLI as an npm tarball, packed into the static assets by `packages/cli` `pack:assets`
 * (the package is not on npm yet):
 *
 *   GET /cli/v2/gittifacts.tgz       the latest build (`npx -y https://<host>/cli/v2/gittifacts.tgz`)
 *   GET /cli/gittifacts.tgz          the same bytes (the pre-v2 path, kept for old docs and scripts)
 *   GET /cli/gittifacts-<v>.tgz      the same build under its version
 *   GET /cli/latest.json             { name, version, tarball, integrity, shasum, size }
 *   GET /cli/version.json            { sha256, size, builtAt } of the bundled cli.mjs: the CLI's
 *                                    self-update compares its own file with it
 *   GET /cli                         redirects to the CLI guide
 *
 * The canonical path moved to /cli/v2/ once (DECISIONS 2026-10-11): npx reuses its install for
 * a tarball URL it has seen, so a new path is what gets builds from before the self-update a
 * fresh install. The old path is served from the v2 file, so it is never a stale build.
 *
 * Anything else under /cli is a real 404: the assets binding would answer it with the SPA's
 * HTML and a 200, which npm would then try to unpack.
 */
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import type { ApiApp } from "./common.js";

export const CLI_BASE = "/cli";
export const CLI_GUIDE = "/docs/get-started/cli";
export const CLI_TARBALL = "/cli/v2/gittifacts.tgz";
/** Before v2: answered with the v2 file. */
const LEGACY_TARBALL = "/cli/gittifacts.tgz";

const TARBALL = /^\/cli\/(?:v2\/gittifacts|gittifacts(-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)?)\.tgz$/;
const LATEST_JSON = "/cli/latest.json";
const VERSION_JSON = "/cli/version.json";

function notFound(c: Context<AppEnv>, path: string): Response {
  const origin = new URL(c.req.url).origin;
  const body = `No CLI file at ${path}. The CLI is ${origin}${CLI_TARBALL} (npx -y ${origin}${CLI_TARBALL} --help); guide: ${origin}${CLI_GUIDE}\n`;
  return new Response(c.req.method === "HEAD" ? null : body, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function serveCli(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url);
  const path = url.pathname;
  const tarball = TARBALL.exec(path);
  let type: string;
  let cache: string;
  if (tarball !== null) {
    type = "application/gzip";
    // Short for both: a rebuild may change the bytes behind the same version.
    cache = "public, max-age=300";
  } else if (path === LATEST_JSON || path === VERSION_JSON) {
    type = "application/json; charset=utf-8";
    // version.json: what every CLI checks (at most every 10 minutes) before running.
    cache = "public, max-age=60";
  } else {
    return notFound(c, path);
  }
  const asset = path === LEGACY_TARBALL ? CLI_TARBALL : path;
  const res = await c.env.ASSETS.fetch(new Request(`${url.origin}${asset}`));
  if (res.status !== 200 || (res.headers.get("content-type") ?? "").includes("text/html")) {
    return notFound(c, path);
  }
  // Keep what the assets binding said about the bytes (length, etag, any content-encoding).
  const headers = new Headers(res.headers);
  headers.set("content-type", type);
  headers.set("cache-control", cache);
  headers.set("access-control-allow-origin", "*");
  if (tarball !== null) {
    headers.set(
      "content-disposition",
      `attachment; filename="${path.slice(path.lastIndexOf("/") + 1)}"`,
    );
  }
  return new Response(c.req.method === "HEAD" ? null : res.body, { status: 200, headers });
}

export function registerCliRoutes(app: ApiApp): void {
  app.get(CLI_BASE, (c) => c.redirect(CLI_GUIDE, 302));
  app.get(`${CLI_BASE}/*`, serveCli);
}
