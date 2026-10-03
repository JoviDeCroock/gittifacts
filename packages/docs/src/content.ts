/**
 * The content tree: every `content/**.md` file with its front matter, slug, URLs and place in
 * the navigation. Pure apart from reading files; the build, the checks and the tests share it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const CONTENT_DIR = join(import.meta.dirname, "..", "content");

/** Where pages are served. */
export const BASE = "/docs";

export const Audience = z.enum(["agents", "humans", "both", "integrators"]);
export type Audience = z.infer<typeof Audience>;

/** Sidebar groups inside a section, in order (guides use them). */
export const GROUPS = ["Daily work", "Review", "Set up a repo", "GitHub", "Help"] as const;

export const FrontMatter = z
  .object({
    title: z.string().min(1).max(80),
    description: z.string().min(1).max(300),
    order: z.number().int().min(0).max(1000),
    /** Who the page is written for. Pages without one are for everyone. */
    audience: Audience.default("both"),
    /** Shorter title for the sidebar. */
    nav: z.string().min(1).max(40).optional(),
    /** The sidebar group within its section (see GROUPS). */
    group: z.enum(GROUPS).optional(),
    /** Written by `generate/` from the code: never edit by hand. */
    generated: z.boolean().default(false),
  })
  .strict();
export type FrontMatter = z.infer<typeof FrontMatter>;

/** Section folders, in navigation order, with their titles. */
export const SECTIONS: readonly { dir: string; title: string }[] = [
  { dir: "get-started", title: "Get started" },
  { dir: "concepts", title: "Concepts" },
  { dir: "guides", title: "Guides" },
  { dir: "guides/integrations", title: "Integrations" },
  { dir: "reference", title: "Reference" },
];

export interface Page {
  /** Path under content/, with forward slashes (`guides/git.md`). */
  file: string;
  /** `""` for the docs home, else `guides/git` (an `index.md` takes its folder's slug). */
  slug: string;
  /** `/docs` or `/docs/guides/git`. */
  url: string;
  /** The markdown twin: `/docs/index.md` or `/docs/guides/git.md`. */
  mdUrl: string;
  /** The section folder (`""` for top-level pages such as the home and the security model). */
  section: string;
  fm: FrontMatter;
  /** Markdown without the front matter. */
  body: string;
  /** The file as written. */
  raw: string;
}

export function urlOf(slug: string): string {
  return slug === "" ? BASE : `${BASE}/${slug}`;
}

export function mdUrlOf(slug: string): string {
  return slug === "" ? `${BASE}/index.md` : `${BASE}/${slug}.md`;
}

export function slugOf(file: string): string {
  const noExt = file.replace(/\.md$/, "");
  if (noExt === "index") return "";
  return noExt.endsWith("/index") ? noExt.slice(0, -"/index".length) : noExt;
}

/** The section a page belongs to: the deepest known section folder that contains it. */
export function sectionOf(file: string): string {
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  const known = SECTIONS.map((s) => s.dir).filter((d) => dir === d || dir.startsWith(`${d}/`));
  return known.sort((a, b) => b.length - a.length)[0] ?? "";
}

const FENCE = /^---\n([\s\S]*?)\n---\n?/;

export function splitFrontMatter(raw: string): { data: unknown; body: string } {
  const m = FENCE.exec(raw);
  if (m === null) return { data: null, body: raw };
  return { data: parseYaml(m[1] ?? ""), body: raw.slice(m[0].length) };
}

export function parsePage(file: string, raw: string): Page {
  const { data, body } = splitFrontMatter(raw);
  const fm = FrontMatter.safeParse(data);
  if (!fm.success) {
    const issues = fm.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`${file}: invalid front matter\n  ${issues.join("\n  ")}`);
  }
  const slug = slugOf(file);
  return {
    file,
    slug,
    url: urlOf(slug),
    mdUrl: mdUrlOf(slug),
    section: sectionOf(file),
    fm: fm.data,
    body,
    raw,
  };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** Every page, in reading order (see `orderPages`). */
export function loadPages(dir: string = CONTENT_DIR): Page[] {
  const pages = walk(dir).map((full) => {
    const file = relative(dir, full).split(sep).join("/");
    return parsePage(file, readFileSync(full, "utf8"));
  });
  return orderPages(pages);
}

function sectionRank(section: string): number {
  if (section === "") return -1;
  const i = SECTIONS.findIndex((s) => s.dir === section);
  return i < 0 ? SECTIONS.length : i;
}

/**
 * Reading order: the home first; then each section in SECTIONS order, its index page first and
 * the rest by `order`, then title. Top-level pages other than the home go last (security model).
 */
export function orderPages(pages: readonly Page[]): Page[] {
  const isIndex = (p: Page) => p.slug === p.section;
  const rank = (p: Page) => (p.slug === "" ? -2 : p.section === "" ? 1000 : sectionRank(p.section));
  return [...pages].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Number(isIndex(b)) - Number(isIndex(a)) ||
      a.fm.order - b.fm.order ||
      a.fm.title.localeCompare(b.fm.title),
  );
}

export function sectionTitle(section: string): string {
  return SECTIONS.find((s) => s.dir === section)?.title ?? "";
}
