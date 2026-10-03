/**
 * The front door (docs/prompts/02-onboarding.md §2): everything an agent told only "use <host>"
 * needs to work out the rest.
 *
 *   GET /                              the landing page (no session) or the web app, with `Link`
 *                                      headers (and <link> tags) to the rest
 *   GET /start                         machine guide: markdown, JSON with `Accept: application/json`,
 *                                      or a page for a browser (`Accept: text/html`, same content)
 *   GET /start.md                      the guide as markdown, whatever the Accept header
 *   GET /llms.txt                      llmstxt.org index (a page for a browser, like /start)
 *   GET /openapi.json                  alias of /api/v1/openapi.json
 *   GET /mcp/server-card               MCP Server Card (draft SEP-2127)
 *   GET /.well-known/ai-catalog.json   AI Catalog (draft) pointing at the card
 *
 * RFC 9728 protected-resource metadata and RFC 8414 authorization-server metadata are served by
 * the OAuth routes (src/oauth/routes.ts); only the card and the catalog come from here.
 */
import {
  aiCatalogLinkHeader,
  llmsTxt,
  mcpDiscovery,
  serverCardPath,
  startGuide,
  type UnclaimedQuotaHints,
  type WellKnownDocument,
} from "@app/conventions";
import { defaultPolicy } from "@app/domain";
import { sha256Hex } from "@app/evidence";
import { getSessionCookie } from "better-auth/cookies";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import { authFor } from "../auth/middleware.js";
import { quotaHints, unclaimedLimits } from "../limits/config.js";
import { unclaimedCreationState } from "../limits/kill-switch.js";
import { urlsFor } from "../oauth/context.js";
import { delegatedAuthHints } from "../oauth/metadata.js";
import { DELEGABLE_SCOPES } from "../oauth/scopes.js";
import { limitsFor, type WorkspaceConfigVars } from "../workspace/model.js";
import type { ApiApp } from "./common.js";
import { frontPageHtml, loadShell, type PageInput } from "./front-page.js";

export const FRONT_DOOR_PATHS = {
  start: "/start",
  startMarkdown: "/start.md",
  llmsTxt: "/llms.txt",
  openapi: "/openapi.json",
  serverCard: "/mcp/server-card",
  aiCatalog: "/.well-known/ai-catalog.json",
} as const;

/** Whether credential-less create_project works right now (kill switch) and its limits. */
export interface UnclaimedHints {
  enabled: boolean;
  quotas: UnclaimedQuotaHints;
}

export async function unclaimedHints(c: Context<AppEnv>): Promise<UnclaimedHints> {
  const state = await unclaimedCreationState(c.get("services").store, c.env.FLAGS);
  const ws = limitsFor(
    { claim: { status: "unclaimed", ownerId: null, expiresAt: null }, policy: defaultPolicy() },
    c.env as unknown as WorkspaceConfigVars,
  );
  return {
    enabled: state.enabled,
    quotas: quotaHints(unclaimedLimits(c.env), Math.round((ws.cpuSecondsPerDay ?? 0) / 60)),
  };
}

export interface FrontDoorUrls {
  origin: string;
  mcpUrl: string;
  openapiUrl: string;
  issuer: string;
}

export function frontDoorUrls(c: Context<AppEnv>): FrontDoorUrls {
  const u = urlsFor(c);
  return {
    origin: u.origin,
    mcpUrl: u.mcpResource,
    openapiUrl: `${u.origin}${FRONT_DOOR_PATHS.openapi}`,
    issuer: u.issuer,
  };
}

export function startDocument(urls: FrontDoorUrls, unclaimed: UnclaimedHints) {
  return startGuide({
    host: urls.origin,
    mcpUrl: urls.mcpUrl,
    openapiUrl: urls.openapiUrl,
    authHints: {
      unclaimedProjects: unclaimed.enabled,
      unclaimedTtlDays: Math.max(1, Math.round(unclaimed.quotas.ttlDays)),
      unclaimedQuotas: unclaimed.quotas,
      ...delegatedAuthHints(urls.origin),
    },
  });
}

/** The draft discovery documents this module serves (not the OAuth ones). */
export function discoveryDocuments(urls: FrontDoorUrls, version: string): WellKnownDocument[] {
  return mcpDiscovery({
    host: urls.origin,
    mcpUrl: urls.mcpUrl,
    version,
    authorizationServers: [urls.issuer],
    scopes: DELEGABLE_SCOPES,
  }).filter((d) => !d.path.startsWith("/.well-known/oauth-protected-resource"));
}

/** `Link` header pointing at every front-door document (RFC 8288; RFC 8631 relations). */
export function frontDoorLinks(urls: FrontDoorUrls): string {
  const o = urls.origin;
  return [
    `<${o}${FRONT_DOOR_PATHS.start}>; rel="service-doc"; type="text/markdown"`,
    `<${o}${FRONT_DOOR_PATHS.llmsTxt}>; rel="describedby"; type="text/plain"`,
    `<${urls.openapiUrl}>; rel="service-desc"; type="application/openapi+json"`,
    `<${o}${serverCardPath(urls.mcpUrl)}>; rel="mcp-server-card"; type="application/mcp-server-card+json"`,
    aiCatalogLinkHeader(o),
  ].join(", ");
}

async function etagged(
  c: Context<AppEnv>,
  body: string,
  contentType: string,
  headers: Record<string, string>,
): Promise<Response> {
  const etag = `"${(await sha256Hex(body)).slice(0, 32)}"`;
  const h = new Headers({ ...headers, "content-type": contentType, etag, vary: "Accept" });
  const inm = c.req.header("if-none-match");
  if (inm?.split(",").some((t) => t.trim() === etag)) {
    return new Response(null, { status: 304, headers: h });
  }
  return new Response(c.req.method === "HEAD" ? null : body, { status: 200, headers: h });
}

const CACHE = { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" };

function wantsJson(c: Context<AppEnv>): boolean {
  const accept = (c.req.header("accept") ?? "").toLowerCase();
  return accept.includes("application/json") && !accept.includes("text/markdown");
}

export type FrontDoorFormat = "json" | "markdown" | "html";

/**
 * Which representation of a front-door document to send. Agents get markdown: `text/markdown`,
 * curl's and most HTTP clients' `*\/*`, anything that doesn't name HTML. A browser (it names
 * `text/html` and not `text/markdown`) gets the same content as a page. `?format=` overrides it
 * (`md`/`markdown`/`text`, `json`, `html`), for links between the representations.
 */
export function negotiateFormat(
  accept: string | undefined,
  format: string | undefined,
  json: boolean,
): FrontDoorFormat {
  const f = (format ?? "").toLowerCase();
  if (f === "md" || f === "markdown" || f === "text" || f === "txt") return "markdown";
  if (f === "html") return "html";
  if (f === "json" && json) return "json";
  const a = (accept ?? "").toLowerCase();
  if (json && a.includes("application/json") && !a.includes("text/markdown")) return "json";
  if (a.includes("text/html") && !a.includes("text/markdown")) return "html";
  return "markdown";
}

/** A front-door document as a page, framed like the docs. */
async function htmlPage(c: Context<AppEnv>, page: PageInput, headers: Record<string, string>) {
  const shell = await loadShell(c.env.ASSETS, new URL(c.req.url).origin);
  return etagged(c, frontPageHtml(shell, page), "text/html; charset=utf-8", headers);
}

/** The prerendered marketing page (packages/web/landing.html), served at `/` without a session. */
export const LANDING_ASSET = "/landing";
/** The origin baked into the static landing HTML; rewritten to the request's origin. */
const LANDING_ORIGIN = "https://gittifacts.decroockjovi.workers.dev";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * A URL as escaped HTML with <wbr> after "//" and each host dot and before each path "/", the
 * same break points the prerendered landing uses, so long hosts never break mid-word on phones.
 */
export function breakableUrlHtml(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(.*)$/i.exec(url);
  const parts = m
    ? [m[1] ?? "", ...(m[2] ?? "").split(/(?<=\.)/), ...(m[3] ?? "").split(/(?=\/)/)]
    : [url];
  return parts
    .filter(Boolean)
    .map((p) => p.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c))
    .join("<wbr>");
}

/** A signed-in person gets the app at `/`; only a request carrying a session cookie is checked. */
async function hasSession(c: Context<AppEnv>): Promise<boolean> {
  if (!getSessionCookie(c.req.raw)) return false;
  try {
    return (await authFor(c).api.getSession({ headers: c.req.raw.headers })) !== null;
  } catch {
    return false;
  }
}

/** `/` for a browser: the landing page for visitors, the app for people with a session (or `?mock`). */
async function homeAsset(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url);
  if (!url.searchParams.has("mock") && !(await hasSession(c))) {
    const landing = await c.env.ASSETS.fetch(new Request(new URL(LANDING_ASSET, url), c.req.raw));
    if (landing.status === 200 || landing.status === 304) return landing;
  }
  return c.env.ASSETS.fetch(c.req.raw);
}

export function registerFrontDoorRoutes(app: ApiApp, openapi: () => unknown): void {
  const start = async (c: Context<AppEnv>, forced?: FrontDoorFormat) => {
    const urls = frontDoorUrls(c);
    const doc = startDocument(urls, await unclaimedHints(c));
    const links = { ...CACHE, link: frontDoorLinks(urls) };
    const format = forced ?? negotiateFormat(c.req.header("accept"), c.req.query("format"), true);
    if (format === "json") {
      return etagged(c, JSON.stringify(doc.json, null, 2), "application/json; charset=utf-8", links);
    }
    if (format === "html") {
      return htmlPage(
        c,
        {
          markdown: doc.markdown,
          title: "Start here · gittifacts",
          url: `${urls.origin}${FRONT_DOOR_PATHS.start}`,
          description:
            "How an agent starts on gittifacts: the MCP server, authentication, and the three calls that create a project, run CI and return a live preview.",
          alternates: [
            { href: FRONT_DOOR_PATHS.startMarkdown, label: "View as Markdown", type: "text/markdown" },
            { href: `${FRONT_DOOR_PATHS.start}?format=json`, label: "JSON", type: "application/json" },
          ],
        },
        links,
      );
    }
    return etagged(c, doc.markdown, "text/markdown; charset=utf-8", links);
  };
  app.get(FRONT_DOOR_PATHS.start, (c) => start(c));
  app.get(FRONT_DOOR_PATHS.startMarkdown, (c) => start(c, "markdown"));

  app.get(FRONT_DOOR_PATHS.llmsTxt, async (c) => {
    const urls = frontDoorUrls(c);
    const text = llmsTxt({
      host: urls.origin,
      mcpUrl: urls.mcpUrl,
      openapiUrl: urls.openapiUrl,
      oauth: delegatedAuthHints(urls.origin).oauth,
      unclaimed: await unclaimedHints(c),
    });
    const headers = { ...CACHE, link: frontDoorLinks(urls) };
    if (negotiateFormat(c.req.header("accept"), c.req.query("format"), false) === "html") {
      return htmlPage(
        c,
        {
          markdown: text,
          title: "llms.txt · gittifacts",
          url: `${urls.origin}${FRONT_DOOR_PATHS.llmsTxt}`,
          description: "The llms.txt index of gittifacts: where an agent starts, and every machine document.",
          alternates: [
            { href: `${FRONT_DOOR_PATHS.llmsTxt}?format=text`, label: "View as plain text", type: "text/plain" },
          ],
        },
        headers,
      );
    }
    return etagged(c, text, "text/plain; charset=utf-8", headers);
  });

  app.get(FRONT_DOOR_PATHS.openapi, (c) =>
    c.json(openapi() as Record<string, unknown>, 200, CACHE),
  );

  for (const path of [FRONT_DOOR_PATHS.serverCard, FRONT_DOOR_PATHS.aiCatalog]) {
    app.get(path, async (c) => {
      const doc = discoveryDocuments(frontDoorUrls(c), c.env.VERSION?.id ?? "dev").find(
        (d) => d.path === path,
      );
      if (doc === undefined) return c.notFound();
      return etagged(c, JSON.stringify(doc.body), doc.contentType, doc.headers);
    });
  }

  // The web app, with the front door in its headers and <head>, so a crawler or an agent that
  // only fetches "/" finds /start, /llms.txt, the OpenAPI document and the MCP card.
  app.get("/", async (c) => {
    const urls = frontDoorUrls(c);
    const accept = (c.req.header("accept") ?? "").toLowerCase();
    if (!accept.includes("text/html") && (accept.includes("text/markdown") || wantsJson(c))) {
      // An agent asking for something other than HTML gets the start guide directly.
      const doc = startDocument(urls, await unclaimedHints(c));
      const links = { ...CACHE, link: frontDoorLinks(urls) };
      return wantsJson(c)
        ? etagged(c, JSON.stringify(doc.json, null, 2), "application/json; charset=utf-8", links)
        : etagged(c, doc.markdown, "text/markdown; charset=utf-8", links);
    }
    const asset = await homeAsset(c);
    const res = new Response(asset.body, asset);
    res.headers.append("link", frontDoorLinks(urls));
    res.headers.append("vary", "Accept, Cookie");
    if (!(res.headers.get("content-type") ?? "").includes("text/html")) return res;
    const tags = [
      `<link rel="service-doc" type="text/markdown" href="${FRONT_DOOR_PATHS.start}">`,
      `<link rel="describedby" type="text/plain" href="${FRONT_DOOR_PATHS.llmsTxt}">`,
      `<link rel="service-desc" type="application/openapi+json" href="${FRONT_DOOR_PATHS.openapi}">`,
      `<link rel="ai-catalog" href="${FRONT_DOOR_PATHS.aiCatalog}">`,
    ].join("");
    return (
      new HTMLRewriter()
        .on("head", {
          element(el) {
            el.append(tags, { html: true });
          },
        })
        // The landing page's absolute URLs (canonical, Open Graph, the copyable /start URL).
        .on("[data-origin]", {
          element(el) {
            for (const name of ["href", "content"]) {
              const v = el.getAttribute(name);
              if (v?.startsWith(LANDING_ORIGIN))
                el.setAttribute(name, urls.origin + v.slice(LANDING_ORIGIN.length));
            }
          },
        })
        .on("[data-origin-text]", {
          element(el) {
            const url = `${urls.origin}${el.getAttribute("data-origin-text") ?? ""}`;
            el.setInnerContent(breakableUrlHtml(url), { html: true });
          },
        })
        .transform(res)
    );
  });
}
