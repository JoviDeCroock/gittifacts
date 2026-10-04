/**
 * The front door: an agent told only "use <host>" fetches `/`, follows its links, and finds the
 * MCP server, how to authenticate and the three calls that ship something.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { parseCall, StartDoc } from "@app/conventions";
import { createPlatformClient } from "@app/mcp/client";
import { describe, expect, it } from "vitest";
import { call, createAgent, makeApp, ORIGIN, signUpHuman, type TestApp } from "./http.js";

/** `Link` header → rel → absolute URL. */
function links(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(/,\s*(?=<)/)) {
    const m = /^<([^>]+)>;\s*rel="([^"]+)"/.exec(part.trim());
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[2]] = m[1];
  }
  return out;
}

function fetchVia(app: TestApp) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(input, init), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
}

describe("front door", () => {
  it("/ → links → /start → the MCP server and the 3 calls, all of them real tools", async () => {
    const { app } = makeApp();
    const get = (url: string, accept?: string) =>
      call(
        app,
        "GET",
        url.replace(ORIGIN, ""),
        accept === undefined ? {} : { headers: { accept } },
      );

    const home = await get("/", "text/html");
    expect(home.status).toBe(200);
    const rel = links(home.headers.get("link"));
    expect(Object.keys(rel).sort()).toEqual(
      ["ai-catalog", "describedby", "mcp-server-card", "service-desc", "service-doc"].sort(),
    );
    const html = await home.text();
    expect(html).toContain('<link rel="service-doc" type="text/markdown" href="/start">');

    // /start as JSON: the machine guide.
    const startRes = await get(rel["service-doc"] as string, "application/json");
    expect(startRes.status).toBe(200);
    expect(startRes.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    const doc = StartDoc.parse(await startRes.json());
    expect(doc.mcp.url).toBe(`${ORIGIN}/mcp`);
    expect(doc.auth.oauth.available).toBe(true);
    expect(doc.auth.deviceFlow).toEqual({
      available: true,
      command: `npx -y ${ORIGIN}/cli/gittifacts.tgz --host ${ORIGIN} login`,
    });
    expect(doc.cli.tarball).toBe(`${ORIGIN}/cli/gittifacts.tgz`);
    const calls = doc.ship.map((s) => parseCall(s.call ?? ""));
    expect(calls.map((c) => c?.tool)).toEqual([
      "create_project",
      "wait_for_change",
      "get_change_status",
    ]);

    // Every call in the guide names a tool the MCP server really has.
    const human = await signUpHuman(app);
    const agent = await createAgent(app, human.cookie);
    const mcp = await createPlatformClient(doc.mcp.url, agent.token, { fetch: fetchVia(app) });
    try {
      const tools = new Set((await mcp.listTools()).map((t) => t.name));
      for (const step of [...doc.ship, ...doc.loop]) {
        if (step.call === undefined) continue;
        expect(tools.has(parseCall(step.call)?.tool ?? ""), step.call).toBe(true);
      }
    } finally {
      await mcp.client.close();
    }

    // Markdown by default, revalidation with the ETag.
    const md = await get("/start");
    expect(md.headers.get("content-type")).toContain("text/markdown");
    const mdText = await md.text();
    expect(mdText).toContain("create_project(");
    expect(mdText).toContain(`${ORIGIN}/mcp`);
    const same = await call(app, "GET", "/start", {
      headers: { "if-none-match": md.headers.get("etag") ?? "" },
    });
    expect(same.status).toBe(304);

    // llms.txt, the server card, the AI catalog, the OpenAPI alias.
    const llms = await (await get(rel.describedby as string)).text();
    expect(llms).toContain(`(${ORIGIN}/start)`);
    expect(llms).toContain(`(${ORIGIN}/mcp)`);
    const card = (await (await get(rel["mcp-server-card"] as string)).json()) as {
      remotes: Array<{ url: string; type: string }>;
    };
    expect(card.remotes[0]).toMatchObject({ type: "streamable-http", url: `${ORIGIN}/mcp` });
    const catalog = (await (await get(rel["ai-catalog"] as string)).json()) as {
      entries: Array<{ url: string }>;
    };
    expect(catalog.entries[0]?.url).toBe(rel["mcp-server-card"]);
    const alias = (await (await get(rel["service-desc"] as string)).json()) as {
      paths: Record<string, unknown>;
    };
    const canonical = (await (await get("/api/v1/openapi.json")).json()) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(alias.paths).sort()).toEqual(Object.keys(canonical.paths).sort());
    expect(alias.paths["/api/v1/projects"]).toBeDefined();
    // OAuth discovery stays with the OAuth routes.
    const prm = await get("/.well-known/oauth-protected-resource/mcp");
    expect(prm.status).toBe(200);
  });

  it("/ is the landing page for everyone; /dashboard and deep links are the app", async () => {
    const { app } = makeApp();
    const visitor = await call(app, "GET", "/", { headers: { accept: "text/html" } });
    expect(visitor.status).toBe(200);
    // Not session-dependent: no Cookie in Vary, so caches may share it.
    expect(visitor.headers.get("vary")).toContain("Accept");
    expect(visitor.headers.get("vary")).not.toContain("Cookie");
    expect(links(visitor.headers.get("link"))["service-doc"]).toBe(`${ORIGIN}/start`);
    const landing = await visitor.text();
    expect(landing).toContain('id="hero-title"');
    expect(landing).toContain('<link rel="service-doc" type="text/markdown" href="/start">');
    // Absolute URLs baked into the static page point at this host.
    expect(landing).toContain(`<link rel="canonical" href="${ORIGIN}/"`);
    expect(landing).toContain(`content="${ORIGIN}/og.png"`);
    expect(landing.replace(/<wbr>/g, "")).toContain(`>${ORIGIN}/start</code>`);
    expect(landing).toContain("http://<wbr>localhost<wbr>/start");
    expect(landing).not.toContain("decroockjovi.workers.dev");
    // The nav's session link: "Sign in" in the markup, swapped client-side when signed in.
    expect(landing).toContain("data-session-link");

    // Signed in, stale cookie or ?mock: still the landing page, never the app.
    const human = await signUpHuman(app);
    for (const headers of [
      { accept: "text/html", cookie: human.cookie },
      { accept: "text/html", cookie: "better-auth.session_token=expired.token" },
    ]) {
      const res = await call(app, "GET", "/", { headers });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="hero-title"');
      expect(html).not.toContain('<div id="app">');
    }
    const mock = await call(app, "GET", "/?mock", { headers: { accept: "text/html" } });
    expect(await mock.text()).toContain('id="hero-title"');

    // The app: /dashboard and every deep link agents print, signed in or not (the SPA itself
    // sends a visitor to /signin?next=…).
    for (const path of [
      "/dashboard",
      "/changes/ch_x",
      "/repos/rp_x",
      "/settings/github",
      "/claim/tok",
    ]) {
      for (const cookie of [undefined, human.cookie]) {
        const res = await call(app, "GET", path, {
          headers: { accept: "text/html", ...(cookie ? { cookie } : {}) },
        });
        expect(res.status, path).toBe(200);
        expect(await res.text(), path).toContain('<div id="app">');
      }
    }

    // Revalidation: the landing's ETag gets a 304, signed in or not.
    const etag = visitor.headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    for (const cookie of [undefined, human.cookie]) {
      const again = await call(app, "GET", "/", {
        headers: { accept: "text/html", "if-none-match": etag, ...(cookie ? { cookie } : {}) },
      });
      expect(again.status).toBe(304);
    }
  });

  it("an agent asking / for JSON or markdown gets the guide itself", async () => {
    const { app } = makeApp();
    const json = await call(app, "GET", "/", { headers: { accept: "application/json" } });
    expect(StartDoc.safeParse(await json.json()).success).toBe(true);
    const md = await call(app, "GET", "/", { headers: { accept: "text/markdown" } });
    expect(await md.text()).toMatch(/^# gittifacts: start here/);
  });

  it("/start and /llms.txt: markdown for agents, the same content as a page for a browser", async () => {
    const { app } = makeApp();
    const get = (path: string, accept?: string) =>
      call(app, "GET", path, accept === undefined ? {} : { headers: { accept } });
    const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

    const md = await (await get("/start", "text/markdown")).text();
    // curl and most HTTP clients send */*: markdown, like no Accept at all.
    for (const accept of ["*/*", "text/plain", "text/markdown, text/html", undefined]) {
      const res = await get("/start", accept);
      expect(res.headers.get("content-type"), String(accept)).toContain("text/markdown");
      expect(await res.text()).toBe(md);
    }
    const page = await get("/start", BROWSER);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("vary")).toContain("Accept");
    expect(page.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(page.headers.get("etag")).not.toBe((await get("/start")).headers.get("etag"));
    const html = await page.text();
    expect(html).toContain('name="viewport"');
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/start.md">');
    expect(html).toContain('<a class="meta__md" href="/start.md">View as Markdown</a>');
    // Every heading of the guide, as a heading with an anchor.
    for (const [, level, text] of md.matchAll(/^(#{1,3}) (.+)$/gm)) {
      const plain = (text ?? "").replace(/[`*]/g, "");
      expect(html).toMatch(
        new RegExp(`<h${level?.length} id="[^"]+">.*${escapeRe(plain.replace(/'/g, "&#39;"))}`),
      );
    }
    // URLs are links; placeholders and other angle brackets are text, never markup.
    expect(html).toContain(`<a href="${ORIGIN}/mcp">${ORIGIN}/mcp</a>`);
    expect(html).toContain(`<a href="${ORIGIN}/llms.txt">`);
    expect(html).toContain("Bearer &lt;token&gt;");
    expect(html).not.toMatch(/<token>|<changeId>/);
    expect(html).toContain('id="templates"');
    // Revalidation and HEAD work on the page too.
    const again = await call(app, "GET", "/start", {
      headers: { accept: BROWSER, "if-none-match": page.headers.get("etag") ?? "" },
    });
    expect(again.status).toBe(304);
    const head = await call(app, "HEAD", "/start", { headers: { accept: BROWSER } });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/html");
    expect(await head.text()).toBe("");

    // /start.md is markdown whatever the browser asks for; ?format= links the representations.
    const twin = await get("/start.md", BROWSER);
    expect(twin.headers.get("content-type")).toContain("text/markdown");
    expect(await twin.text()).toBe(md);
    const asJson = await get("/start?format=json", BROWSER);
    expect(StartDoc.safeParse(await asJson.json()).success).toBe(true);
    expect((await get("/start", "application/json")).headers.get("content-type")).toContain(
      "application/json",
    );

    // llms.txt: plain text for agents, a page for a browser.
    const text = await get("/llms.txt", "*/*");
    expect(text.headers.get("content-type")).toContain("text/plain");
    const llms = await text.text();
    const llmsPage = await get("/llms.txt", BROWSER);
    expect(llmsPage.headers.get("content-type")).toContain("text/html");
    const llmsHtml = await llmsPage.text();
    expect(llmsHtml).toContain("<title>llms.txt · gittifacts</title>");
    expect(llmsHtml).toContain(`<a href="${ORIGIN}/start">Start guide</a>`);
    expect(llmsHtml).toContain('href="/llms.txt?format=text"');
    expect(await (await get("/llms.txt?format=text", BROWSER)).text()).toBe(llms);
  });
});

describe("front door pages", () => {
  it("are framed by the docs build's shell when the static assets have it", async () => {
    const shell =
      '<!doctype html><title><!--gf:title--></title><link rel="canonical" href="<!--gf:canonical-->"><link rel="alternate" type="text/markdown" href="<!--gf:alternate-->"><meta name="description" content="<!--gf:description-->"><div class="shell shell--single"><!--gf:content--></div>';
    const assets = {
      async fetch(input: Request | string | URL): Promise<Response> {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.pathname === "/docs/_assets/shell") {
          return new Response(shell, { headers: { "content-type": "text/html" } });
        }
        return new Response("not found", { status: 404 });
      },
    };
    const { app } = makeApp();
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`${ORIGIN}/start`, { headers: { accept: "text/html" } }),
      { ...env, ASSETS: assets as unknown as Fetcher },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const html = await res.text();
    expect(html).toContain('<div class="shell shell--single"><h1 id="gittifacts-start-here">');
    expect(html).toContain("<title>Start here · gittifacts</title>");
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/start">`);
    expect(html).not.toContain("<!--gf:");
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("landing first-green bar geometry", () => {
  it("never runs past the axis: end − start, both clamped (staging's 446 s p90 overflowed)", async () => {
    const { rangeStyle } = await import("../src/routes/front-door.js");
    expect(rangeStyle(40, 75)).toBe("left:44.4%;width:38.9%;");
    expect(rangeStyle(60, 446)).toBe("left:66.7%;width:33.3%;");
    expect(rangeStyle(120, 600)).toBe("left:100%;width:0%;");
  });
});
