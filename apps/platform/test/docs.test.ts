/**
 * /docs: pages from the docs build (static assets), HTML for browsers and markdown for agents
 * (`Accept: text/markdown` or a `.md` suffix), real 404s instead of the SPA fallback, and the
 * `https://<host>` placeholder replaced with the request's origin.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { makeApp, ORIGIN } from "./http.js";

const FILES: Record<string, [string, string]> = {
  "/docs/index.json": [
    "application/json",
    JSON.stringify({ version: 1, base: "/docs", pages: [{ slug: "" }, { slug: "guides/git" }] }),
  ],
  "/docs/": ["text/html", "<!doctype html><h1>gittifacts docs</h1><a href=\"https://&lt;host&gt;/mcp\">mcp</a>"],
  "/docs/index.md": ["text/markdown", "# gittifacts docs\n\nMCP: `https://<host>/mcp`\n"],
  "/docs/guides/git": ["text/html", "<!doctype html><h1>Committing and pushing with git</h1>"],
  "/docs/guides/git.md": ["text/markdown", "# Committing and pushing with git\n\n`git clone https://<host>/git/o/r.git`\n"],
  "/docs/404": ["text/html", "<!doctype html><h1>Page not found</h1>"],
  "/docs/llms-full.txt": ["text/plain", "# gittifacts documentation (full text)\n\nURL: https://<host>/docs\n"],
  "/docs/_assets/docs.css": ["text/css", "body{}"],
};

/** The assets binding as configured (not_found_handling: single-page-application). */
const assets = {
  async fetch(input: Request | string | URL): Promise<Response> {
    const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname;
    const hit = FILES[path];
    if (hit) return new Response(hit[1], { headers: { "content-type": hit[0] } });
    return new Response("<!doctype html><div id=app></div>", { headers: { "content-type": "text/html" } });
  },
};

async function get(path: string, headers: Record<string, string> = {}, method = "GET") {
  const { app } = makeApp();
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}${path}`, { method, headers, redirect: "manual" });
  const res = await app.fetch(req, { ...env, ASSETS: assets as unknown as Fetcher }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("/docs", () => {
  it("serves a page as HTML to browsers, with its markdown twin linked and the origin filled in", async () => {
    const res = await get("/docs", { accept: "text/html,*/*" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("vary")).toContain("Accept");
    expect(res.headers.get("link")).toBe('</docs/index.md>; rel="alternate"; type="text/markdown"');
    const html = await res.text();
    expect(html).toContain(`href="${ORIGIN}/mcp"`);
    expect(html).not.toContain("&lt;host&gt;");
  });

  it("serves markdown for Accept: text/markdown and for a .md suffix", async () => {
    const negotiated = await get("/docs/guides/git", { accept: "text/markdown" });
    expect(negotiated.status).toBe(200);
    expect(negotiated.headers.get("content-type")).toContain("text/markdown");
    expect(await negotiated.text()).toContain(`git clone ${ORIGIN}/git/o/r.git`);

    const suffixed = await get("/docs/guides/git.md");
    expect(suffixed.headers.get("content-type")).toContain("text/markdown");
    expect(await suffixed.text()).toContain("# Committing and pushing with git");

    const home = await get("/docs/index.md");
    expect(await home.text()).toContain(`MCP: \`${ORIGIN}/mcp\``);
  });

  it("answers unknown pages with a real 404 (never the SPA), as HTML or markdown", async () => {
    const html = await get("/docs/nope", { accept: "text/html" });
    expect(html.status).toBe(404);
    expect(await html.text()).toContain("Page not found");
    const md = await get("/docs/nope.md");
    expect(md.status).toBe(404);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    const asset = await get("/docs/_assets/missing.js");
    expect(asset.status).toBe(404);
  });

  it("serves llms-full.txt and assets, and drops trailing slashes", async () => {
    const full = await get("/docs/llms-full.txt");
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toContain("text/markdown");
    expect(await full.text()).toContain(`URL: ${ORIGIN}/docs`);
    const css = await get("/docs/_assets/docs.css");
    expect(css.status).toBe(200);
    expect(await css.text()).toBe("body{}");
    const slash = await get("/docs/guides/git/");
    expect(slash.status).toBe(301);
    expect(slash.headers.get("location")).toBe("/docs/guides/git");
  });

  it("answers HEAD without a body", async () => {
    const res = await get("/docs/guides/git", {}, "HEAD");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  // With packages/docs built into packages/web/dist (deploy:prepare does it), the real assets
  // binding must serve pages the way this route asks for them (html_handling, .md, index.json).
  it("serves the real docs build through the assets binding when it is present", async () => {
    const { app } = makeApp();
    const probe = await env.ASSETS.fetch(new Request(`${ORIGIN}/docs/index.json`));
    if (!(probe.headers.get("content-type") ?? "").includes("json")) return; // docs not built
    const fetchReal = async (path: string, headers: Record<string, string> = {}) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`${ORIGIN}${path}`, { headers }), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const home = await fetchReal("/docs", { accept: "text/html" });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("<h1");
    const section = await fetchReal("/docs/guides", { accept: "text/html" });
    expect(section.status).toBe(200);
    const page = await fetchReal("/docs/guides/git", { accept: "text/html" });
    expect(await page.text()).toContain("Commit and push with git");
    const md = await fetchReal("/docs/guides/git.md");
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(await md.text()).toMatch(/^# Commit and push with git/);
    const missing = await fetchReal("/docs/guides/nope", { accept: "text/html" });
    expect(missing.status).toBe(404);
  });
});
