/**
 * The HTML shell of every docs page, in the product's design system (packages/web DESIGN.md):
 * top bar with search, sidebar, article, on-page TOC, previous/next, footer.
 *
 * Absolute URLs use the `https://<host>` placeholder; the platform Worker replaces it with the
 * request's origin when it serves the page (apps/platform/src/routes/docs.ts).
 */
import type { Page } from "./content.js";
import { escapeHtml } from "./highlight.js";
import type { Heading } from "./markdown.js";
import { breadcrumbs, prevNext, sidebar, toc } from "./nav.js";

export const HOST_PLACEHOLDER = "https://<host>";
export const ASSET_VERSION = "1";

const AUDIENCE: Record<Page["fm"]["audience"], string | null> = {
  agents: "For agents",
  humans: "For humans",
  integrators: "For integrators",
  both: null,
};

const BRAND_MARK = `<svg class="brand-mark" width="32" height="22" viewBox="0 0 32 22" aria-hidden="true" focusable="false"><path d="M7.5 1 H29 Q31 1 31 3 V19 Q31 21 29 21 H7.5 L1 14.2 V7.8 Z M11.4 11 a2.2 2.2 0 1 0 -4.4 0 a2.2 2.2 0 1 0 4.4 0 Z" fill-rule="evenodd"/><path d="M16 7.2 h10.5 M16 11 h10.5 M16 14.8 h6.5" class="brand-mark__lines"/></svg>`;

/** Applies a saved theme before first paint (same storage key as the app and the landing). */
const THEME_INIT = `try{var t=localStorage.getItem("gf:theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

function head(page: Page): string {
  const title = page.slug === "" ? "gittifacts docs" : `${page.fm.title} · gittifacts docs`;
  const a = (p: string) => `/docs/_assets/${p}?v=${ASSET_VERSION}`;
  return `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(page.fm.description)}">
<link rel="canonical" href="${HOST_PLACEHOLDER}${page.url}">
<link rel="alternate" type="text/markdown" href="${page.mdUrl}">
<link rel="describedby" type="text/plain" href="/docs/llms-full.txt">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f7fafc" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0c1118" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/docs/_assets/fonts/next-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${a("docs.css")}">
<script>${THEME_INIT}</script>
<script src="${a("docs.js")}" defer></script>
</head>`;
}

function topbar(menu = true): string {
  const button = menu
    ? `<button type="button" class="icon-btn topbar__menu" aria-label="Open navigation" aria-controls="sidebar" aria-expanded="false" data-menu><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>\n`
    : "";
  return `<header class="topbar">
<div class="topbar__inner">
${button}<a href="/docs" class="brand" aria-label="gittifacts docs home">${BRAND_MARK}<span class="brand__word">gittifacts</span><span class="brand__docs">docs</span></a>
<form class="search" role="search" data-search hidden>
<label for="q" class="sr-only">Search the docs</label>
<input id="q" name="q" type="search" placeholder="Search docs" autocomplete="off" spellcheck="false" aria-controls="search-results" aria-expanded="false">
<kbd class="search__key" aria-hidden="true">/</kbd>
<div id="search-results" class="search__results" role="listbox" hidden></div>
</form>
<nav class="topbar__links" aria-label="Machine documents">
<a href="/start">Start guide</a>
<a href="/docs/llms-full.txt">llms-full.txt</a>
<a href="/" class="topbar__app">Open app</a>
</nav>
</div>
</header>`;
}

function footer(): string {
  return `<footer class="footer">
<div class="footer__inner">
<p class="footer__brand">${BRAND_MARK}<span>gittifacts docs. Humans approve intent; machines prove conformance.</span></p>
<ul class="footer__links">
<li><a href="/start">Start guide</a></li>
<li><a href="/llms.txt">llms.txt</a></li>
<li><a href="/docs/llms-full.txt">llms-full.txt</a></li>
<li><a href="/openapi.json">OpenAPI</a></li>
<li><a href="/mcp/server-card">MCP server card</a></li>
</ul>
<fieldset class="theme" data-theme-switch hidden><legend class="sr-only">Theme</legend>
<label><input type="radio" name="theme" value="system"><span>System</span></label>
<label><input type="radio" name="theme" value="light"><span>Light</span></label>
<label><input type="radio" name="theme" value="dark"><span>Dark</span></label>
</fieldset>
</div>
</footer>`;
}

/** Puts the meta line (audience, generated, markdown link) right under the page's H1. */
function withMeta(html: string, meta: string): string {
  const end = html.indexOf("</h1>");
  return end < 0 ? meta + html : `${html.slice(0, end + 5)}\n${meta}${html.slice(end + 5)}`;
}

export function pageHtml(
  pages: readonly Page[],
  page: Page,
  body: { html: string; headings: Heading[] },
): string {
  const audience = AUDIENCE[page.fm.audience];
  const meta = [
    audience ? `<span class="chip">${audience}</span>` : "",
    page.fm.generated ? `<span class="chip chip--gen">Generated from code</span>` : "",
    `<a class="meta__md" href="${page.mdUrl}">View as Markdown</a>`,
  ].join("");
  // Pages start with their own H1 (so the markdown twin reads well); keep it as the title.
  return `<!doctype html>
<html lang="en">
${head(page)}
<body>
<a href="#main" class="skip-link">Skip to content</a>
${topbar()}
<div class="shell">
<aside id="sidebar" class="sidebar" aria-label="Documentation">${sidebar(pages, page)}</aside>
<main id="main" class="main">
<article class="article">
${breadcrumbs(pages, page)}
<div class="prose">
${withMeta(body.html, `<div class="article__meta">${meta}</div>`)}
</div>
${prevNext(pages, page)}
</article>
${toc(body.headings)}
</main>
</div>
${footer()}
<p id="copy-status" class="sr-only" aria-live="polite"></p>
</body>
</html>
`;
}

/**
 * The docs look for a page the Worker renders at request time (`/start` and `/llms.txt` for a
 * browser, apps/platform/src/routes/front-page.ts): the same head, top bar and footer, one
 * column, no sidebar. Built to `_assets/shell.html`; the Worker reads it from the static assets
 * (the docs route never serves HTML from `_assets/`) and replaces these markers.
 */
export const SHELL_MARKERS = {
  title: "<!--gf:title-->",
  description: "<!--gf:description-->",
  canonical: "<!--gf:canonical-->",
  alternate: "<!--gf:alternate-->",
  content: "<!--gf:content-->",
} as const;

export function shellHtml(): string {
  const m = SHELL_MARKERS;
  const a = (p: string) => `/docs/_assets/${p}?v=${ASSET_VERSION}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${m.title}</title>
<meta name="description" content="${m.description}">
<link rel="canonical" href="${m.canonical}">
<link rel="alternate" type="text/markdown" href="${m.alternate}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f7fafc" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0c1118" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/docs/_assets/fonts/next-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${a("docs.css")}">
<script>${THEME_INIT}</script>
<script src="${a("docs.js")}" defer></script>
</head>
<body>
<a href="#main" class="skip-link">Skip to content</a>
${topbar(false)}
<div class="shell shell--single">
<main id="main" class="main">
<article class="article">
<div class="prose">
${m.content}
</div>
</article>
</main>
</div>
${footer()}
<p id="copy-status" class="sr-only" aria-live="polite"></p>
</body>
</html>
`;
}
