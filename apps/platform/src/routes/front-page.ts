/**
 * The front door's machine documents (`/start`, `/llms.txt`) as a page for people: the same
 * markdown, rendered to HTML at request time and framed in the docs look.
 *
 * The frame is the docs build's `/docs/_assets/shell.html` (packages/docs `shellHtml`), read from
 * the static assets once per isolate; without it (tests, a build without docs) a small inline
 * frame keeps the page readable on a phone. Raw HTML in the markdown is shown as text, never
 * interpreted.
 */
import { Marked, type Tokens } from "marked";

/** Same markers as packages/docs `SHELL_MARKERS` (checked by both packages' tests). */
export const SHELL_MARKERS = {
  title: "<!--gf:title-->",
  description: "<!--gf:description-->",
  canonical: "<!--gf:canonical-->",
  alternate: "<!--gf:alternate-->",
  content: "<!--gf:content-->",
} as const;

/** Where the docs build puts the shell (served at its extensionless path). */
export const SHELL_ASSET = "/docs/_assets/shell";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** GitHub-style heading ids (the same rule as the docs build), so `/start#templates` works. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

export interface RenderedPage {
  /** The first h1's text, or null. */
  title: string | null;
  html: string;
}

/** Markdown → HTML with heading anchors, copyable code blocks and wrapped tables. */
export function renderMarkdownPage(markdown: string): RenderedPage {
  let title: string | null = null;
  const used = new Map<string, number>();
  // `breaks`: these documents put each call and each "Returns …" on its own line.
  const marked = new Marked({ gfm: true, breaks: true });
  marked.use({
    renderer: {
      heading({ tokens, depth, text }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const plain = text.replace(/[`*_]/g, "").trim();
        const base = slugify(plain) || "section";
        const n = used.get(base) ?? 0;
        used.set(base, n + 1);
        const id = n === 0 ? base : `${base}-${n}`;
        if (depth === 1) {
          title ??= plain;
          return `<h1 id="${id}">${inner}</h1>\n`;
        }
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`;
      },
      code({ text, lang }: Tokens.Code) {
        const label = escapeHtml((lang ?? "").split(/\s+/)[0] || "text");
        return [
          `<div class="code" data-lang="${label}">`,
          `<div class="code__head"><span class="code__lang">${label}</span>`,
          `<button type="button" class="copy" data-copy hidden>Copy</button></div>`,
          `<pre tabindex="0"><code>${escapeHtml(text)}</code></pre></div>\n`,
        ].join("");
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        return `<aside class="note">${this.parser.parse(tokens)}</aside>\n`;
      },
      // `<token>` and `<changeId>` placeholders are text, and so is any other raw HTML.
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(text);
      },
    },
  });
  const html = marked
    .parse(markdown, { async: false })
    .replace(/<table>/g, '<div class="table-wrap" tabindex="0"><table>')
    .replace(/<\/table>/g, "</table></div>");
  return { title, html };
}

/** Puts `meta` right under the page's h1 (or first, without one). */
function withMeta(html: string, meta: string): string {
  const end = html.indexOf("</h1>");
  return end < 0 ? meta + html : `${html.slice(0, end + 5)}\n${meta}${html.slice(end + 5)}`;
}

/** The frame used when the docs shell isn't in the static assets. */
export const FALLBACK_SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${SHELL_MARKERS.title}</title>
<meta name="description" content="${SHELL_MARKERS.description}">
<link rel="canonical" href="${SHELL_MARKERS.canonical}">
<link rel="alternate" type="text/markdown" href="${SHELL_MARKERS.alternate}">
<meta name="color-scheme" content="light dark">
<style>
body{margin:0;font:17px/1.6 system-ui,sans-serif;overflow-wrap:break-word;background:Canvas;color:CanvasText}
main{max-width:48rem;margin:0 auto;padding:16px}
code{font-family:ui-monospace,monospace;font-size:.9em;overflow-wrap:anywhere}
pre{overflow-x:auto;padding:12px;border:1px solid GrayText;border-radius:6px}
pre code{overflow-wrap:normal}
.anchor{display:none}
.table-wrap{overflow-x:auto}
</style>
</head>
<body>
<main id="main" class="prose">
${SHELL_MARKERS.content}
</main>
</body>
</html>
`;

export interface PageInput {
  markdown: string;
  /** The <title> (default: the first h1). */
  title?: string;
  /** Absolute URL of this page (canonical). */
  url: string;
  description: string;
  /** Where the raw document is (`<link rel="alternate">`, "View as …" link). */
  alternates: Array<{ href: string; label: string; type: string }>;
}

/** The full HTML page: `shell` (the docs frame or FALLBACK_SHELL) filled with the document. */
export function frontPageHtml(shell: string, input: PageInput): string {
  const { title, html } = renderMarkdownPage(input.markdown);
  const links = input.alternates
    .map((a) => `<a class="meta__md" href="${escapeHtml(a.href)}">${escapeHtml(a.label)}</a>`)
    .join("");
  const content = withMeta(html, `<div class="article__meta">${links}</div>`);
  const fill: Record<string, string> = {
    [SHELL_MARKERS.title]: escapeHtml(input.title ?? title ?? "gittifacts"),
    [SHELL_MARKERS.description]: escapeHtml(input.description),
    [SHELL_MARKERS.canonical]: escapeHtml(input.url),
    [SHELL_MARKERS.alternate]: escapeHtml(input.alternates[0]?.href ?? input.url),
    [SHELL_MARKERS.content]: content,
  };
  let out = shell;
  for (const [marker, value] of Object.entries(fill)) out = out.split(marker).join(value);
  return out;
}

interface AssetFetcher {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

const shells = new WeakMap<object, Promise<string | null>>();

/** The docs shell from the static assets (memoized per binding; a miss is retried next time). */
export function loadShell(assets: AssetFetcher, origin: string): Promise<string> {
  let cached = shells.get(assets);
  if (cached === undefined) {
    cached = assets
      .fetch(new Request(`${origin}${SHELL_ASSET}`))
      .then(async (res) => {
        if (!res.ok) return null;
        const text = await res.text();
        return text.includes(SHELL_MARKERS.content) ? text : null;
      })
      .catch(() => null);
    shells.set(assets, cached);
    void cached.then((s) => {
      if (s === null) shells.delete(assets);
    });
  }
  return cached.then((s) => s ?? FALLBACK_SHELL);
}
