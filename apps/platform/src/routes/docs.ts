/**
 * The documentation at /docs (built by packages/docs into the static assets, see its build.ts).
 *
 *   GET /docs, /docs/<page>          HTML for browsers; the markdown twin for
 *                                    `Accept: text/markdown` (without text/html)
 *   GET /docs/<page>.md              the markdown twin
 *   GET /docs/llms-full.txt          every page in one markdown file (also llms.txt, index.json,
 *                                    search-index.json, sitemap.xml, _assets/*)
 *
 * Pages are looked up in the build's manifest (/docs/index.json), so an unknown path is a real
 * 404, never the SPA fallback the assets binding would serve. Text responses get the
 * `https://<host>` placeholder the build writes replaced with the request's origin, so copied
 * commands work against the host they were read on.
 */
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import type { ApiApp } from "./common.js";

export const DOCS_BASE = "/docs";
const HOST_PLACEHOLDER = "https://<host>";
const HOST_PLACEHOLDER_HTML = "https://&lt;host&gt;";

/** Build outputs served as they are (besides the pages). */
const FILES: Record<string, string> = {
  "/docs/llms-full.txt": "text/markdown; charset=utf-8",
  "/docs/llms.txt": "text/plain; charset=utf-8",
  "/docs/index.json": "application/json; charset=utf-8",
  "/docs/search-index.json": "application/json; charset=utf-8",
  "/docs/sitemap.xml": "application/xml; charset=utf-8",
};

const CACHE = "public, max-age=300";

interface AssetFetcher {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

const manifests = new WeakMap<object, Promise<Set<string> | null>>();

/** Slugs of every page in the build (`""` is the docs home), or null when docs aren't built. */
export function docsManifest(assets: AssetFetcher, origin: string): Promise<Set<string> | null> {
  let cached = manifests.get(assets);
  if (cached === undefined) {
    cached = assets
      .fetch(new Request(`${origin}${DOCS_BASE}/index.json`))
      .then(async (res) => {
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
        const doc = (await res.json()) as { pages?: { slug?: unknown }[] };
        return new Set((doc.pages ?? []).map((p) => String(p.slug ?? "")));
      })
      .catch(() => null);
    manifests.set(assets, cached);
    // A failed load is retried on the next request instead of being remembered.
    void cached.then((m) => {
      if (m === null) manifests.delete(assets);
    });
  }
  return cached;
}

/** Markdown when asked for it and HTML wasn't: agents send `Accept: text/markdown`. */
export function prefersMarkdown(accept: string | undefined): boolean {
  const a = (accept ?? "").toLowerCase();
  return a.includes("text/markdown") && !a.includes("text/html");
}

function withOrigin(text: string, origin: string): string {
  return text.replaceAll(HOST_PLACEHOLDER, origin).replaceAll(HOST_PLACEHOLDER_HTML, origin);
}

async function fetchAsset(c: Context<AppEnv>, path: string): Promise<Response | null> {
  const origin = new URL(c.req.url).origin;
  const res = await c.env.ASSETS.fetch(new Request(`${origin}${path}`));
  return res.status === 200 ? res : null;
}

function textResponse(c: Context<AppEnv>, body: string, type: string, status: number, link?: string) {
  const headers = new Headers({ "content-type": type, "cache-control": CACHE, vary: "Accept" });
  if (link !== undefined) headers.set("link", link);
  if (type.startsWith("text/markdown") || type.startsWith("text/plain")) {
    headers.set("access-control-allow-origin", "*");
  }
  return new Response(c.req.method === "HEAD" ? null : body, { status, headers });
}

async function notFound(c: Context<AppEnv>, markdown: boolean): Promise<Response> {
  const origin = new URL(c.req.url).origin;
  if (!markdown) {
    const page = await fetchAsset(c, `${DOCS_BASE}/404`);
    if (page !== null) {
      return textResponse(c, withOrigin(await page.text(), origin), "text/html; charset=utf-8", 404);
    }
  }
  const body = `# Page not found\n\nThere is no docs page at ${new URL(c.req.url).pathname}. Every page is listed in ${origin}${DOCS_BASE}/llms.txt.\n`;
  return textResponse(c, body, "text/markdown; charset=utf-8", 404);
}

export async function serveDocs(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url);
  const path = url.pathname;
  if (path.length > DOCS_BASE.length + 1 && path.endsWith("/")) {
    return c.redirect(`${path.replace(/\/+$/, "")}${url.search}`, 301);
  }
  if (path.startsWith(`${DOCS_BASE}/_assets/`)) {
    const res = await fetchAsset(c, path);
    const html = (res?.headers.get("content-type") ?? "").includes("text/html");
    return res !== null && !html ? res : notFound(c, true);
  }
  const fileType = FILES[path];
  if (fileType !== undefined) {
    const res = await fetchAsset(c, path);
    if (res === null || (res.headers.get("content-type") ?? "").includes("text/html")) {
      return notFound(c, true);
    }
    return textResponse(c, withOrigin(await res.text(), url.origin), fileType, 200);
  }

  const markdown = path.endsWith(".md") || prefersMarkdown(c.req.header("accept"));
  const rest = path === DOCS_BASE || path === `${DOCS_BASE}/` ? "" : path.slice(DOCS_BASE.length + 1);
  const name = rest.replace(/\.md$/, "");
  const slug = name === "index" ? "" : name;
  const pages = await docsManifest(c.env.ASSETS, url.origin);
  if (pages === null || !pages.has(slug)) return notFound(c, markdown);

  const mdPath = slug === "" ? `${DOCS_BASE}/index.md` : `${DOCS_BASE}/${slug}.md`;
  const res = await fetchAsset(c, markdown ? mdPath : slug === "" ? `${DOCS_BASE}/` : `${DOCS_BASE}/${slug}`);
  if (res === null) return notFound(c, markdown);
  const body = withOrigin(await res.text(), url.origin);
  return markdown
    ? textResponse(c, body, "text/markdown; charset=utf-8", 200)
    : textResponse(c, body, "text/html; charset=utf-8", 200, `<${mdPath}>; rel="alternate"; type="text/markdown"`);
}

export function registerDocsRoutes(app: ApiApp): void {
  app.get(DOCS_BASE, serveDocs);
  app.get(`${DOCS_BASE}/*`, serveDocs);
}
