/**
 * The whole static site in memory: path (relative to the output dir, which is served at /docs)
 * → contents. Deterministic: no timestamps, stable ordering. `build.ts` writes it to disk.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { BASE, githubBlocks, listed, type Page, sectionTitle } from "./content.js";
import { escapeHtml } from "./highlight.js";
import { HOST_PLACEHOLDER, pageHtml, shellHtml } from "./layout.js";
import { plainText, renderMarkdown, resolveHref, stripMarkers } from "./markdown.js";
import { pagesList } from "./nav.js";

export type Site = Map<string, string | Uint8Array>;

const PAGES_MARKER = "<!-- pages -->";
const require = createRequire(import.meta.url);

/** The page's markdown as served: the pages marker expanded and relative links made absolute. */
export function markdownTwin(pages: readonly Page[], page: Page): string {
  let body = githubBlocks(page.body).replace(PAGES_MARKER, () => pagesList(pages.filter((p) => listed(p)), page));
  body = body.replace(
    /\]\((?!https?:|mailto:|\/|#)([^)\s]+)\)/g,
    (_m, href: string) => `](${resolveHref(href, page.file)})`,
  );
  return `${body.trim()}\n`;
}

/** Output file of a page's HTML (`index.html` for the home, else `<slug>.html`). */
export function htmlFileOf(page: Page): string {
  return page.slug === "" ? "index.html" : `${page.slug}.html`;
}

export function mdFileOf(page: Page): string {
  return page.slug === "" ? "index.md" : `${page.slug}.md`;
}

function stripMarkdown(md: string): string {
  return plainText(
    md
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/^#+\s+/gm, "")
      .replace(/^\s*[-*>|]+/gm, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function notFoundPage(): Page {
  const body = [
    "# Page not found",
    "",
    "There is no docs page at this address. Try the search box, the [docs home](/docs), or the [full text for agents](/docs/llms-full.txt).",
    "",
  ].join("\n");
  return {
    file: "404.md",
    slug: "404",
    url: "/docs/404",
    mdUrl: "/docs/404.md",
    section: "",
    fm: {
      title: "Page not found",
      description: "No docs page at this address.",
      order: 0,
      audience: "both",
      generated: false,
    },
    body,
    raw: body,
  };
}

function css(): string {
  const tokens = readFileSync(
    join(import.meta.dirname, "..", "..", "web", "src", "styles", "tokens.css"),
    "utf8",
  );
  const own = ["docs.css", "prose.css", "blocks.css", "steps.css", "frame.css"].map((f) =>
    readFileSync(join(import.meta.dirname, "assets", f), "utf8"),
  );
  return `/* tokens.css from packages/web (one source for the design tokens) */\n${tokens}\n${own.join("\n")}`;
}

const FONTS: Record<string, string> = {
  "next-latin.woff2":
    "@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2",
  "next-latin-ext.woff2":
    "@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-ext-wght-normal.woff2",
  "mono-latin.woff2":
    "@fontsource-variable/atkinson-hyperlegible-mono/files/atkinson-hyperlegible-mono-latin-wght-normal.woff2",
};

export function buildSite(pages: readonly Page[]): Site {
  const site: Site = new Map();
  const manifest: unknown[] = [];
  const search: unknown[] = [];
  const full: string[] = [
    "# gittifacts documentation (full text)",
    "",
    `> Every page of ${HOST_PLACEHOLDER}/docs as markdown, in reading order. Each page is also served alone: append .md to its URL or send Accept: text/markdown.`,
    "",
  ];
  const index: string[] = [
    "# gittifacts docs",
    "",
    "> Task-first documentation for agents and humans. Each link is the page's markdown twin.",
    "",
    `Everything in one file: ${HOST_PLACEHOLDER}/docs/llms-full.txt`,
    "",
    `Start here: agents read ${HOST_PLACEHOLDER}/docs/get-started/agents.md (or ${HOST_PLACEHOLDER}/start); people pick a path at ${HOST_PLACEHOLDER}/docs.`,
  ];
  let lastSection: string | null = null;
  // What a person browses (sidebar, previous/next, search); every page is still built.
  const shown = pages.filter((p) => listed(p));

  for (const page of pages) {
    const md = markdownTwin(pages, page);
    const rendered = renderMarkdown(md, page.file);
    site.set(htmlFileOf(page), pageHtml(shown, page, rendered));
    const twin = stripMarkers(md);
    site.set(mdFileOf(page), twin);
    full.push("---", "", `URL: ${HOST_PLACEHOLDER}${page.url}`, "", twin);
    const section = sectionTitle(page.section) || "Docs";
    if (section !== lastSection) index.push("", `## ${section}`);
    lastSection = section;
    index.push(`- [${page.fm.title}](${HOST_PLACEHOLDER}${page.mdUrl}): ${page.fm.description}`);
    manifest.push({
      slug: page.slug,
      url: page.url,
      md: page.mdUrl,
      title: page.fm.title,
      description: page.fm.description,
      section: page.section,
      sectionTitle: sectionTitle(page.section),
      audience: page.fm.audience,
      generated: page.fm.generated,
      headings: rendered.headings.map((h) => ({ depth: h.depth, id: h.id, text: h.text })),
    });
    if (listed(page)) search.push({
      u: page.url,
      t: page.fm.title,
      s: sectionTitle(page.section),
      d: page.fm.description,
      h: rendered.headings.map((h) => [h.id, h.text]),
      x: stripMarkdown(md).slice(0, 4000),
    });
  }

  const missing = notFoundPage();
  site.set("404.html", pageHtml(shown, missing, renderMarkdown(missing.body, missing.file)));
  site.set("llms-full.txt", full.join("\n"));
  site.set("llms.txt", `${index.join("\n")}\n`);
  site.set(
    "index.json",
    `${JSON.stringify({ version: 1, base: BASE, pages: manifest }, null, 2)}\n`,
  );
  site.set("search-index.json", JSON.stringify(search));
  const host = escapeHtml(HOST_PLACEHOLDER);
  site.set(
    "sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
      .map((p) => `<url><loc>${host}${p.url}</loc></url>`)
      .join("\n")}\n</urlset>\n`,
  );
  site.set("_assets/docs.css", css());
  // The frame of pages the Worker renders per request (/start, /llms.txt for browsers).
  site.set("_assets/shell.html", shellHtml());
  site.set(
    "_assets/docs.js",
    ["search.js", "docs.js"]
      .map((f) => readFileSync(join(import.meta.dirname, "assets", f), "utf8"))
      .join("\n"),
  );
  for (const [name, spec] of Object.entries(FONTS)) {
    site.set(`_assets/fonts/${name}`, new Uint8Array(readFileSync(require.resolve(spec))));
  }
  return site;
}
