/**
 * Markdown → HTML for one page (marked, with the docs' own renderers): heading anchors and a
 * table of contents, code blocks with a copy button and syntax-light highlighting, wrapped tables,
 * notes, "Coming soon" chips, and links resolved to absolute `/docs/...` URLs.
 */
import { Marked, type Token, type Tokens } from "marked";
import { BASE, slugOf } from "./content.js";
import { escapeHtml, highlight } from "./highlight.js";

export interface Heading {
  depth: number;
  id: string;
  text: string;
}

export interface Rendered {
  html: string;
  /** h2 and h3, in order: the on-page table of contents and the search index. */
  headings: Heading[];
}

/** GitHub-style anchor ids: lowercase, punctuation dropped, spaces to hyphens. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Inline markdown → plain text (headings in the TOC, titles in the search index). */
export function plainText(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim();
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * A link as written in `file` (path under content/) → the URL pages use. Relative links to other
 * markdown files (`./oauth.md#scopes`, `../concepts/lanes.md`) become `/docs/...` page URLs;
 * absolute and external links are kept.
 */
export function resolveHref(href: string, file: string): string {
  if (href === "" || href.startsWith("#") || href.startsWith("/") || EXTERNAL.test(href)) {
    return href;
  }
  const [pathPart = "", hash = ""] = href.split(/(?=#)/);
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")).split("/") : [];
  for (const seg of pathPart.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") dir.pop();
    else dir.push(seg);
  }
  const target = dir.join("/");
  if (!target.endsWith(".md")) return `${BASE}/${target}${hash}`;
  const slug = slugOf(target);
  return `${slug === "" ? BASE : `${BASE}/${slug}`}${hash}`;
}

export function renderMarkdown(body: string, file: string): Rendered {
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  const uniqueId = (text: string) => {
    const base = slugify(text) || "section";
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };

  const marked = new Marked({ gfm: true });
  marked.use({
    walkTokens(token: Token) {
      if (token.type === "link") token.href = resolveHref(token.href, file);
    },
    renderer: {
      heading({ tokens, depth, text }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const plain = plainText(text);
        const id = uniqueId(plain);
        if (depth === 2 || depth === 3) headings.push({ depth, id, text: plain });
        if (depth === 1) return `<h1 id="${id}">${inner}</h1>\n`;
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`;
      },
      code({ text, lang }: Tokens.Code) {
        const language = (lang ?? "").split(/\s+/)[0] ?? "";
        const label = language === "" ? "text" : language;
        // A one-line tool call wraps instead of scrolling: it is read, not aligned.
        const wrap = /^[a-z][a-z0-9_]*\(\{.*\}\)$/.test(text.trim()) ? " code--wrap" : "";
        return [
          `<div class="code${wrap}" data-lang="${escapeHtml(label)}">`,
          `<div class="code__head"><span class="code__lang">${escapeHtml(label)}</span>`,
          `<button type="button" class="copy" data-copy hidden>Copy</button></div>`,
          `<pre tabindex="0"><code>${highlight(text, language)}</code></pre></div>\n`,
        ].join("");
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        return `<aside class="note">${this.parser.parse(tokens)}</aside>\n`;
      },
    },
  });

  let html = marked.parse(body, { async: false });
  html = html
    .replace(/<table>/g, '<div class="table-wrap" tabindex="0"><table>')
    .replace(/<\/table>/g, "</table></div>")
    .replace(/<strong>Coming soon([.:]?)<\/strong>/g, '<span class="soon">Coming soon</span>');
  return { html, headings };
}
