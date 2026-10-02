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
    expect(doc.auth.deviceFlow).toEqual({ available: true, command: "npx gittifacts login" });
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

  it("/ shows visitors the landing page and signed-in people the app", async () => {
    const { app } = makeApp();
    const visitor = await call(app, "GET", "/", { headers: { accept: "text/html" } });
    expect(visitor.status).toBe(200);
    expect(visitor.headers.get("vary")).toContain("Cookie");
    expect(links(visitor.headers.get("link"))["service-doc"]).toBe(`${ORIGIN}/start`);
    const landing = await visitor.text();
    expect(landing).toContain('id="hero-title"');
    expect(landing).toContain('<link rel="service-doc" type="text/markdown" href="/start">');
    // Absolute URLs baked into the static page point at this host.
    expect(landing).toContain(`<link rel="canonical" href="${ORIGIN}/"`);
    expect(landing).toContain(`content="${ORIGIN}/og.png"`);
    expect(landing).toContain(`>${ORIGIN}/start</code>`);
    expect(landing).not.toContain("decroockjovi.workers.dev");

    const human = await signUpHuman(app);
    const signedIn = await call(app, "GET", "/", {
      headers: { accept: "text/html", cookie: human.cookie },
    });
    expect(signedIn.status).toBe(200);
    const spa = await signedIn.text();
    expect(spa).toContain('<div id="app">');
    expect(spa).not.toContain('id="hero-title"');

    // A stale session cookie is a visitor; ?mock keeps the demo app reachable.
    const stale = await call(app, "GET", "/", {
      headers: { accept: "text/html", cookie: "better-auth.session_token=expired.token" },
    });
    expect(await stale.text()).toContain('id="hero-title"');
    const mock = await call(app, "GET", "/?mock", { headers: { accept: "text/html" } });
    expect(await mock.text()).toContain('<div id="app">');

    // Revalidation: the landing's ETag gets a 304 for a visitor, never for a signed-in person.
    const etag = visitor.headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    const again = await call(app, "GET", "/", {
      headers: { accept: "text/html", "if-none-match": etag },
    });
    expect(again.status).toBe(304);
    expect(again.headers.get("vary")).toContain("Cookie");
    const switched = await call(app, "GET", "/", {
      headers: { accept: "text/html", "if-none-match": etag, cookie: human.cookie },
    });
    expect(switched.status).toBe(200);
    expect(await switched.text()).toContain('<div id="app">');
  });

  it("an agent asking / for JSON or markdown gets the guide itself", async () => {
    const { app } = makeApp();
    const json = await call(app, "GET", "/", { headers: { accept: "application/json" } });
    expect(StartDoc.safeParse(await json.json()).success).toBe(true);
    const md = await call(app, "GET", "/", { headers: { accept: "text/markdown" } });
    expect(await md.text()).toMatch(/^# gittifacts: start here/);
  });
});
