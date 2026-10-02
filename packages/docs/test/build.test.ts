/**
 * The static build: every page as HTML and markdown, the machine files, determinism.
 */
import { describe, expect, it } from "vitest";
import { loadPages } from "../src/content.js";
import { buildSite, htmlFileOf, mdFileOf } from "../src/site.js";

const pages = loadPages();
const site = buildSite(pages);
const text = (path: string) => {
  const v = site.get(path);
  if (typeof v !== "string") throw new Error(`missing ${path}`);
  return v;
};

describe("docs build", () => {
  it("renders every page as HTML with one h1, the sidebar and its markdown twin linked", () => {
    for (const p of pages) {
      const html = text(htmlFileOf(p));
      expect(html.match(/<h1[ >]/g)?.length, p.file).toBe(1);
      expect(html).toContain(`<link rel="alternate" type="text/markdown" href="${p.mdUrl}">`);
      for (const other of pages) expect(html).toContain(`href="${other.url}"`);
    }
  });

  it("writes markdown twins with absolute links and no front matter", () => {
    for (const p of pages) {
      const md = text(mdFileOf(p));
      expect(md.startsWith("---"), p.file).toBe(false);
      expect(md, p.file).not.toMatch(/\]\((?!https?:|\/|#|mailto:)[^)]*\.md/);
      expect(md, p.file).not.toContain("<!-- pages -->");
    }
  });

  it("lists every page in index.json, llms.txt, llms-full.txt, the sitemap and the search index", () => {
    const manifest = JSON.parse(text("index.json")) as { pages: { slug: string }[] };
    expect(manifest.pages.map((p) => p.slug)).toEqual(pages.map((p) => p.slug));
    const full = text("llms-full.txt");
    const llms = text("llms.txt");
    const sitemap = text("sitemap.xml");
    const search = JSON.parse(text("search-index.json")) as { u: string }[];
    for (const p of pages) {
      expect(full).toContain(`URL: https://<host>${p.url}\n`);
      expect(llms).toContain(`(https://<host>${p.mdUrl})`);
      expect(sitemap).toContain(`<loc>https://&lt;host&gt;${p.url}</loc>`);
      expect(search.some((s) => s.u === p.url)).toBe(true);
    }
  });

  it("ships the design tokens, fonts, script and a 404 page", () => {
    expect(text("_assets/docs.css")).toContain("--action:");
    expect(text("_assets/docs.js")).toContain("gfDocsSearch");
    expect(site.get("_assets/fonts/next-latin.woff2")).toBeInstanceOf(Uint8Array);
    expect(text("404.html")).toContain("Page not found");
  });

  it("is deterministic", () => {
    const again = buildSite(loadPages());
    for (const [path, v] of site) {
      if (typeof v === "string") expect(again.get(path), path).toBe(v);
    }
  });

  it("puts code blocks behind copy buttons and wraps tables", () => {
    const html = text("guides/git.html");
    expect(html).toContain("data-copy hidden>Copy</button>");
    expect(html).toContain('<div class="table-wrap" tabindex="0"><table>');
  });
});
