import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { describe, expect, it } from "vitest";

const PUBLIC = join(import.meta.dirname, "..", "public");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

const pages = files(PUBLIC).filter((f) => f.endsWith(".html"));

/** Resolves a site-relative URL the way Workers static assets does (`/about/` → about/index.html). */
function resolves(url: string, fromPage: string): boolean {
  const path = url.split(/[?#]/)[0] ?? "";
  if (path === "") return true;
  const base = posix.dirname(`/${relative(PUBLIC, fromPage).split("\\").join("/")}`);
  const abs = path.startsWith("/") ? path : posix.join(base, path);
  const candidates = abs.endsWith("/")
    ? [`${abs}index.html`]
    : [abs, `${abs}.html`, `${abs}/index.html`];
  return candidates.some((c) => existsSync(join(PUBLIC, c)));
}

describe("site", () => {
  it("has a home page and a 404 page", () => {
    expect(existsSync(join(PUBLIC, "index.html"))).toBe(true);
    expect(existsSync(join(PUBLIC, "404.html"))).toBe(true);
  });

  describe.each(pages.map((p) => [relative(PUBLIC, p), p]))("%s", (_name, page) => {
    const html = readFileSync(page, "utf8");

    it("has a lang, a title, a viewport and a description", () => {
      expect(html).toMatch(/<html[^>]*\slang="[a-z-]+"/i);
      expect(html).toMatch(/<title>[^<]+<\/title>/i);
      expect(html).toMatch(/<meta name="viewport"/i);
      expect(html).toMatch(/<meta name="description" content="[^"]+"/i);
    });

    it("only links to files that exist", () => {
      const urls = [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1] ?? "");
      const internal = urls.filter((u) => !/^(?:[a-z]+:|\/\/|#)/i.test(u));
      const broken = internal.filter((u) => !resolves(u, page));
      expect(broken).toEqual([]);
    });
  });
});
