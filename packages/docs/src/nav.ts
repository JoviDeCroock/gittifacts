/**
 * Navigation pieces of a page: the sidebar (sections and their pages), breadcrumbs, the on-page
 * table of contents and previous/next links. All derived from the ordered page list.
 */
import { type Page, SECTIONS, sectionTitle } from "./content.js";
import { escapeHtml } from "./highlight.js";
import type { Heading } from "./markdown.js";

const navTitle = (p: Page) => p.fm.nav ?? p.fm.title;

function link(p: Page, current: Page): string {
  const here = p.slug === current.slug ? ' aria-current="page"' : "";
  return `<li><a href="${p.url}"${here}>${escapeHtml(navTitle(p))}</a></li>`;
}

/** Sidebar: top-level pages, then one group per section (its index page first). */
export function sidebar(pages: readonly Page[], current: Page): string {
  const groups: string[] = [];
  const top = pages.filter((p) => p.section === "" && p.slug !== "security");
  groups.push(`<ul class="nav__list">${top.map((p) => link(p, current)).join("")}</ul>`);
  for (const s of SECTIONS) {
    const inSection = pages.filter((p) => p.section === s.dir);
    if (inSection.length === 0) continue;
    const index = inSection.find((p) => p.slug === s.dir);
    const head = index
      ? `<a href="${index.url}"${index.slug === current.slug ? ' aria-current="page"' : ""}>${escapeHtml(s.title)}</a>`
      : escapeHtml(s.title);
    const rest = inSection.filter((p) => p !== index);
    const nested = s.dir.includes("/") ? " nav__group--nested" : "";
    groups.push(
      `<div class="nav__group${nested}"><p class="nav__title">${head}</p><ul class="nav__list">${rest
        .map((p) => link(p, current))
        .join("")}</ul></div>`,
    );
  }
  const security = pages.find((p) => p.slug === "security");
  if (security) groups.push(`<ul class="nav__list">${link(security, current)}</ul>`);
  return `<nav class="nav" aria-label="Documentation">${groups.join("")}</nav>`;
}

export function breadcrumbs(pages: readonly Page[], page: Page): string {
  if (page.slug === "") return "";
  const crumbs = [`<li><a href="/docs">Docs</a></li>`];
  const parts = page.section === "" ? [] : page.section.split("/");
  for (let i = 0; i < parts.length; i++) {
    const dir = parts.slice(0, i + 1).join("/");
    if (dir === page.slug) break;
    const index = pages.find((p) => p.slug === dir);
    const title = escapeHtml(sectionTitle(dir) || dir);
    crumbs.push(index ? `<li><a href="${index.url}">${title}</a></li>` : `<li>${title}</li>`);
  }
  return `<nav class="crumbs" aria-label="Breadcrumb"><ol>${crumbs.join("")}</ol></nav>`;
}

export function toc(headings: readonly Heading[]): string {
  const items = headings
    .map(
      (h) =>
        `<li class="toc__d${h.depth}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`,
    )
    .join("");
  if (headings.length < 2) return "";
  return `<nav class="toc" aria-labelledby="toc-title"><p id="toc-title" class="toc__title">On this page</p><ul>${items}</ul></nav>`;
}

export function prevNext(pages: readonly Page[], page: Page): string {
  const i = pages.findIndex((p) => p.slug === page.slug);
  const prev = i > 0 ? pages[i - 1] : undefined;
  const next = i >= 0 && i < pages.length - 1 ? pages[i + 1] : undefined;
  const card = (p: Page | undefined, rel: "prev" | "next") =>
    p === undefined
      ? "<span></span>"
      : `<a class="pager__link pager__link--${rel}" href="${p.url}" rel="${rel}"><span class="pager__dir">${rel === "prev" ? "Previous" : "Next"}</span><span class="pager__title">${escapeHtml(p.fm.title)}</span></a>`;
  return `<nav class="pager" aria-label="Previous and next">${card(prev, "prev")}${card(next, "next")}</nav>`;
}

/** The markdown list a `<!-- pages -->` marker expands to: the section's other pages. */
export function pagesList(pages: readonly Page[], page: Page): string {
  const section = page.slug;
  const nestedIndex = (p: Page) =>
    p.slug === p.section &&
    p.section.startsWith(`${section}/`) &&
    !p.section.slice(section.length + 1).includes("/");
  const children = pages.filter((p) => p !== page && (p.section === section || nestedIndex(p)));
  return children.map((p) => `- [${p.fm.title}](${p.url}): ${p.fm.description}`).join("\n");
}
