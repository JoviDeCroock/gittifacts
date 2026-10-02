/**
 * Link check: every `/docs/...` link (written absolute or as a relative `.md` path) resolves to a
 * page, and every `#anchor` to a heading on that page. Other root-relative links must be platform
 * paths; external links must be well-formed URLs.
 */
import { BASE, type Page } from "../content.js";
import { renderMarkdown, resolveHref } from "../markdown.js";
import { markdownTwin } from "../site.js";
import type { Extracted } from "./extract.js";
import type { Problem } from "./problem.js";

/** Root-relative paths served by the platform (not docs pages). */
const PLATFORM_PATHS = [
  /^\/$/,
  /^\/start$/,
  /^\/llms\.txt$/,
  /^\/openapi\.json$/,
  /^\/mcp(\/server-card)?$/,
  /^\/\.well-known\/[a-z0-9./-]+$/,
  /^\/api\/v1\/[A-Za-z0-9{}/._-]+$/,
  /^\/(signin|agents|audit|claim|device|oauth\/consent|settings\/integrations(\/developer)?)(\/.*)?$/,
  /^\/(repos|changes|plans)\/.+$/,
];

/** Heading ids per page slug (h1–h6), from the rendered page. */
export function anchorsBySlug(pages: readonly Page[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of pages) {
    const html = renderMarkdown(markdownTwin(pages, p), p.file).html;
    out.set(p.slug, new Set([...html.matchAll(/<h[1-6] id="([^"]+)"/g)].map((m) => m[1] ?? "")));
  }
  return out;
}

export function checkLinks(
  page: Page,
  x: Extracted,
  anchors: ReadonlyMap<string, Set<string>>,
): Problem[] {
  const problems: Problem[] = [];
  const own = anchors.get(page.slug) ?? new Set<string>();
  for (const { href, line } of x.links) {
    const where = { file: page.file, line, rule: "links" as const };
    const url = resolveHref(href, page.file);
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      if (/^https?:\/\//.test(url)) {
        try {
          new URL(url.replace("<host>", "example.com"));
        } catch {
          problems.push({ ...where, message: `malformed URL ${href}` });
        }
      }
      continue;
    }
    const [path = "", hash] = url.split("#");
    if (path === "") {
      if (hash !== undefined && !own.has(hash)) problems.push({ ...where, message: `no heading #${hash} on this page` });
      continue;
    }
    if (path === BASE || path.startsWith(`${BASE}/`)) {
      if (/\/docs\/(llms-full\.txt|llms\.txt|index\.json|sitemap\.xml)$/.test(path)) continue;
      const slug = path === BASE ? "" : path.slice(BASE.length + 1).replace(/\.md$/, "").replace(/^index$/, "");
      const target = anchors.get(slug);
      if (target === undefined) {
        problems.push({ ...where, message: `no docs page at ${path} (from ${href})` });
      } else if (hash !== undefined && !target.has(hash)) {
        problems.push({ ...where, message: `no heading #${hash} on ${path}` });
      }
      continue;
    }
    if (!PLATFORM_PATHS.some((re) => re.test(path))) {
      problems.push({ ...where, message: `unknown site path ${path} (not a docs page or a platform route)` });
    }
  }
  return problems;
}
