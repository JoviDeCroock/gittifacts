/**
 * The CLI as an npm tarball, packed into the static assets by `packages/cli` `pack:assets`
 * (the package is not on npm yet):
 *
 *   GET /cli/gittifacts.tgz          the latest build (`npx -y https://<host>/cli/gittifacts.tgz`)
 *   GET /cli/gittifacts-<v>.tgz      the same build under its version
 *   GET /cli/latest.json             { name, version, tarball, integrity, shasum, size }
 *   GET /cli                         redirects to the CLI guide
 *
 * Anything else under /cli is a real 404: the assets binding would answer it with the SPA's
 * HTML and a 200, which npm would then try to unpack.
 */
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import type { ApiApp } from "./common.js";

export const CLI_BASE = "/cli";
export const CLI_GUIDE = "/docs/get-started/cli";

const TARBALL = /^\/cli\/gittifacts(-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)?\.tgz$/;
const LATEST_JSON = "/cli/latest.json";

function notFound(c: Context<AppEnv>, path: string): Response {
  const origin = new URL(c.req.url).origin;
  const body = `No CLI file at ${path}. The CLI is ${origin}${CLI_BASE}/gittifacts.tgz (npx -y ${origin}${CLI_BASE}/gittifacts.tgz --help); guide: ${origin}${CLI_GUIDE}\n`;
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
  } else if (path === LATEST_JSON) {
    type = "application/json; charset=utf-8";
    cache = "public, max-age=60";
  } else {
    return notFound(c, path);
  }
  const res = await c.env.ASSETS.fetch(new Request(`${url.origin}${path}`));
  if (res.status !== 200 || (res.headers.get("content-type") ?? "").includes("text/html")) {
    return notFound(c, path);
  }
  // Keep what the assets binding said about the bytes (length, etag, any content-encoding).
  const headers = new Headers(res.headers);
  headers.set("content-type", type);
  headers.set("cache-control", cache);
  headers.set("access-control-allow-origin", "*");
  if (tarball !== null) {
    headers.set("content-disposition", `attachment; filename="${path.slice(CLI_BASE.length + 1)}"`);
  }
  return new Response(c.req.method === "HEAD" ? null : res.body, { status: 200, headers });
}

export function registerCliRoutes(app: ApiApp): void {
  app.get(CLI_BASE, (c) => c.redirect(CLI_GUIDE, 302));
  app.get(`${CLI_BASE}/*`, serveCli);
}
