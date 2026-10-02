/**
 * The prerendered landing page: structure, links agents and crawlers rely on, honest labels,
 * and a size budget for the static HTML.
 */
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { EXAMPLE, MEASURED } from "../src/landing/content.js";
import { renderLanding } from "../src/landing/render.js";

const html = await renderLanding();

function all(re: RegExp): string[] {
  return [...html.matchAll(re)].map((m) => m[1] ?? "");
}

describe("landing page", () => {
  it("has one h1 with the rule, then h2 sections and no skipped heading levels", () => {
    expect(all(/<h1[^>]*>/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>.*Humans approve intent\..*Machines prove conformance\./);
    const levels = all(/<h([1-6])\b/g).map(Number);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
    }
  });

  it("links the human action and every machine document", () => {
    const hrefs = new Set(all(/href="([^"]+)"/g));
    for (const href of ["/signin", "/start", "/llms.txt", "/openapi.json", "/mcp/server-card"]) {
      expect(hrefs.has(href), href).toBe(true);
    }
    // In-page anchors point at sections that exist.
    for (const href of hrefs) {
      if (href.startsWith("#")) expect(html).toContain(`id="${href.slice(1)}"`);
    }
  });

  it("never links off-site (the GitHub repo is private) and never hydrates", () => {
    const external = all(/(?:href|src)="(https?:[^"]+)"/g).filter(
      (u) => !u.startsWith("https://gittifacts.decroockjovi.workers.dev"),
    );
    expect(external).toEqual([]);
    expect(html).not.toContain('type="isodata"');
  });

  it("gives every image alt text and real dimensions", () => {
    const imgs = all(/(<img[^>]*>)/g);
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      expect(img).toMatch(/alt="[^"]{12,}"/);
      expect(img).toMatch(/width="\d+"/);
      expect(img).toMatch(/height="\d+"/);
      expect(img).toContain('loading="lazy"');
    }
  });

  it("labels the example as demo data and quotes only measured numbers", () => {
    expect(html).toContain("Example change, demo data.");
    expect(html).toContain(EXAMPLE.id);
    expect(html).toContain("36 to 48 seconds");
    expect(html).toContain(MEASURED.pushToEvidence);
    expect(html).toContain(MEASURED.tourCost);
  });

  it("keeps copy buttons hidden until the script enables them", () => {
    const buttons = all(/(<button[^>]*data-copy[^>]*>)/g);
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b).toContain("hidden");
      expect(b).toMatch(/aria-label="[^"]+"/);
    }
  });

  it("stays small: the static body is under 20 KB gzipped", () => {
    expect(gzipSync(html).byteLength).toBeLessThan(20_000);
  });
});
