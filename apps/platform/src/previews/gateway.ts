/**
 * The preview gateway: requests for `<previewId>.<PREVIEW_ZONE>` (wrangler route
 * `*.preview.resynapse.dev/*`) go to the `PreviewHost` of that preview, never to the platform.
 *
 * - `p-<changeId>-<sha8>` is one head; `p-<changeId>` the change's newest previewed head.
 * - `/cdn-cgi/*` is blocked: `wrangler dev` serves its local explorer there.
 * - Every response gets `X-Robots-Tag: noindex`, `frame-ancestors 'none'` and loses any
 *   `Set-Cookie` with a `Domain` attribute (a preview may only set host-only cookies, so one
 *   preview can never set cookies for its siblings or the zone).
 * - HTML responses get the preview banner (src/previews/pages.ts) injected with HTMLRewriter.
 * - Before a preview exists (CI still running) the URL serves a "building" page.
 */
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { previews } from "../db/schema.js";
import { D1Store } from "../store/d1-store.js";
import { parsePreviewHost, previewZone } from "./ids.js";
import { BANNER_TAG, bannerHtml, busyPage, errorPage } from "./pages.js";
import { PREVIEW_ID_HEADER } from "./preview-host.js";

export interface GatewayEnv {
  DB: D1Database;
  BLOBS: R2Bucket;
  PREVIEW_HOST: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
  PREVIEW_ZONE?: string;
}

interface Resolved {
  id: string;
  changeId: string;
  projectName: string;
  status: "starting" | "ready" | "failed";
  detail: string | null;
}

/** Latest-alias lookups are cached briefly per isolate (a preview request should not cost a D1 read). */
const aliasCache = new Map<string, { value: Resolved | null; until: number }>();
const ALIAS_TTL_MS = 5_000;

async function resolve(
  env: GatewayEnv,
  host: string,
): Promise<{
  target: ReturnType<typeof parsePreviewHost>;
  row: Resolved | null;
}> {
  const target = parsePreviewHost(host, previewZone(env));
  if (target === null) return { target, row: null };
  const cached = aliasCache.get(target.previewId);
  if (cached !== undefined && cached.until > Date.now()) return { target, row: cached.value };
  const db = drizzle(env.DB);
  const columns = {
    id: previews.id,
    changeId: previews.changeId,
    projectName: previews.projectName,
    status: previews.status,
    detail: previews.detail,
  };
  let row: Resolved | undefined;
  if (target.kind === "pinned") {
    row = await db.select(columns).from(previews).where(eq(previews.id, target.previewId)).get();
  }
  // A latest alias (or a label that only looked pinned): the change's newest preview.
  const changeId =
    row === undefined && target.kind === "pinned"
      ? `${target.changeId}-${target.sha8}`
      : target.changeId;
  row ??= await db
    .select(columns)
    .from(previews)
    .where(eq(previews.changeId, target.kind === "latest" ? target.changeId : changeId))
    .orderBy(desc(previews.createdAt))
    .get();
  const value = row ?? null;
  // Only cache settled answers: a building preview must show up as soon as it is ready.
  if (value !== null && value.status !== "starting") {
    aliasCache.set(target.previewId, { value, until: Date.now() + ALIAS_TTL_MS });
  }
  return { target, row: value };
}

/** Header hygiene for everything the gateway returns. */
export function hardenHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  const cookies = out.getSetCookie();
  out.delete("set-cookie");
  for (const cookie of cookies) {
    // Host-only cookies stay; a Domain attribute could reach sibling previews or the zone.
    if (!/;\s*domain\s*=/i.test(cookie)) out.append("set-cookie", cookie);
  }
  out.set("x-robots-tag", "noindex, nofollow");
  out.append("content-security-policy", "frame-ancestors 'none'");
  out.set("x-frame-options", "DENY");
  out.set("referrer-policy", "no-referrer");
  return out;
}

function isHtml(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
}

/** Inject the banner at the start of <body> (or the end of a body-less document). */
export function withBanner(res: Response, projectName: string, changeId: string): Response {
  const banner = bannerHtml(projectName, changeId);
  let inserted = false;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  const rewritten = new HTMLRewriter()
    .on("body", {
      element(el) {
        if (inserted) return;
        inserted = true;
        el.prepend(banner, { html: true });
      },
    })
    .onDocument({
      end(end) {
        if (!inserted) end.append(banner, { html: true });
      },
    })
    .transform(new Response(res.body, { status: res.status, statusText: res.statusText, headers }));
  return rewritten;
}

async function changeStatus(env: GatewayEnv, changeId: string): Promise<string | null> {
  const change = await new D1Store(env.DB, env.BLOBS).getChange(changeId);
  return change?.status ?? null;
}

export async function handlePreviewRequest(request: Request, env: GatewayEnv): Promise<Response> {
  const url = new URL(request.url);
  const { target, row } = await resolve(env, url.hostname);
  if (target === null) {
    return errorPage(request, 404, "No such preview", `${url.hostname} is not a preview address.`);
  }
  if (url.pathname === "/cdn-cgi" || url.pathname.startsWith("/cdn-cgi/")) {
    return errorPage(
      request,
      404,
      "Not available on previews",
      "/cdn-cgi/* is blocked on previews.",
    );
  }
  if (row === null) {
    const status = await changeStatus(env, target.changeId);
    if (status === null) {
      return errorPage(request, 404, "No such preview", `There is no change ${target.changeId}.`);
    }
    if (status === "running" || status === "awaiting-push") {
      return busyPage(request, {
        title: "Building…",
        body: "CI is building this change; its preview appears here as soon as the build is green. This page reloads by itself.",
        changeId: target.changeId,
        projectName: "this project",
        retryAfter: 5,
      });
    }
    if (status === "failing") {
      return errorPage(
        request,
        404,
        "No preview",
        "CI did not pass for this change, so there is no build to preview.",
      );
    }
    return errorPage(
      request,
      404,
      "No preview",
      "This change has no preview (nothing to serve, or it was never built).",
    );
  }
  if (row.status === "failed") {
    return errorPage(request, 502, "The preview failed to start", row.detail ?? "unknown error", {
      projectName: row.projectName,
      changeId: row.changeId,
    });
  }

  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.startsWith("x-gittifacts-")) headers.delete(name);
  }
  headers.set(PREVIEW_ID_HEADER, row.id);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", "https");
  const forwarded = new Request(request.url, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
    redirect: "manual",
  });
  let res: Response;
  try {
    res = await env.PREVIEW_HOST.getByName(row.id).fetch(forwarded);
  } catch (e) {
    return errorPage(
      request,
      502,
      "The preview is unreachable",
      e instanceof Error ? e.message : String(e),
      {
        projectName: row.projectName,
        changeId: row.changeId,
      },
    );
  }
  const hardened = new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: hardenHeaders(res.headers),
  });
  hardened.headers.set("x-gittifacts-preview", row.id);
  // Pages the gateway/host wrote themselves already carry the banner.
  if (!isHtml(hardened) || request.method === "HEAD") return hardened;
  return res.headers.get("x-gittifacts-page") === "1"
    ? hardened
    : withBanner(hardened, row.projectName, row.changeId);
}

export { BANNER_TAG };
