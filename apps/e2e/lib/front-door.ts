/**
 * HTTP checks of what agents read first, shared by the pre-deploy gate and the post-deploy smoke.
 * Each returns the list of failures (empty = pass) so one run reports every broken URL at once.
 */
import { expect, type APIRequestContext } from "@playwright/test";

interface UrlCheck {
  path: string;
  accept: string;
  status?: number;
  /** Substring the content-type must contain. */
  type: string;
  /** Substring the body must contain (`{origin}` is replaced). */
  body?: string;
}

const CHECKS: UrlCheck[] = [
  // Agents get markdown (curl's */*), browsers the same content as a page, JSON on request.
  { path: "/start", accept: "*/*", type: "text/markdown", body: "{origin}/mcp" },
  { path: "/start", accept: "text/html,application/xhtml+xml", type: "text/html", body: "<html" },
  { path: "/start", accept: "application/json", type: "application/json" },
  { path: "/start.md", accept: "text/html", type: "text/markdown" },
  { path: "/llms.txt", accept: "*/*", type: "text/plain", body: "/start" },
  { path: "/llms.txt", accept: "text/html", type: "text/html" },
  { path: "/openapi.json", accept: "*/*", type: "application/json", body: "/api/v1/projects" },
  { path: "/mcp/server-card", accept: "*/*", type: "json" },
  { path: "/.well-known/ai-catalog.json", accept: "*/*", type: "json" },
  { path: "/.well-known/gittifacts-keys.json", accept: "*/*", type: "application/json" },
  { path: "/.well-known/oauth-protected-resource/mcp", accept: "*/*", type: "json" },
  { path: "/cli/gittifacts.tgz", accept: "*/*", type: "gzip" },
  { path: "/docs", accept: "text/html", type: "text/html", body: "<h1" },
  { path: "/docs/llms.txt", accept: "*/*", type: "text/plain" },
  { path: "/docs/llms-full.txt", accept: "*/*", type: "text/markdown" },
  { path: "/docs/index.json", accept: "*/*", type: "application/json" },
  { path: "/docs/get-started/agents", accept: "text/html", type: "text/html", body: "<h1" },
  { path: "/docs/get-started/agents.md", accept: "*/*", type: "text/markdown" },
  { path: "/docs/no-such-page", accept: "text/html", status: 404, type: "text/html" },
];

export async function checkFrontDoor(request: APIRequestContext, origin: string): Promise<string[]> {
  const failures: string[] = [];
  for (const c of CHECKS) {
    const res = await request.get(`${origin}${c.path}`, { headers: { accept: c.accept }, maxRedirects: 0 });
    const want = c.status ?? 200;
    const type = res.headers()["content-type"] ?? "";
    const where = `${c.path} (accept ${c.accept})`;
    if (res.status() !== want) failures.push(`${where}: HTTP ${res.status()}, want ${want}`);
    else if (!type.includes(c.type)) failures.push(`${where}: content-type ${type}, want ${c.type}`);
    else if (c.body !== undefined) {
      const needle = c.body.replace("{origin}", origin);
      if (!(await res.text()).includes(needle)) failures.push(`${where}: body lacks ${JSON.stringify(needle)}`);
    }
  }
  // `/` points every agent at the rest (RFC 8288 Link header).
  const home = await request.get(`${origin}/`, { headers: { accept: "text/html" } });
  const link = home.headers().link ?? "";
  for (const rel of ["service-doc", "describedby", "service-desc", "mcp-server-card"]) {
    if (!link.includes(`rel="${rel}"`)) failures.push(`/ Link header lacks rel="${rel}"`);
  }
  // MCP with a bad token: 401 that says where to authenticate (RFC 9728), never a 5xx.
  const mcp = await request.post(`${origin}/mcp`, {
    headers: {
      authorization: "Bearer gtf_e2e_invalid",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  if (mcp.status() !== 401 || !(mcp.headers()["www-authenticate"] ?? "").includes("resource_metadata=")) {
    failures.push(`POST /mcp with a bad token: HTTP ${mcp.status()}, want 401 with resource_metadata`);
  }
  failures.push(...(await checkListedUrls(request, origin)));
  return failures;
}

/** Every same-origin URL /start and /docs/llms.txt print must resolve (no dead links for agents). */
export async function checkListedUrls(request: APIRequestContext, origin: string): Promise<string[]> {
  const failures: string[] = [];
  const urls = new Set<string>();
  for (const doc of ["/start", "/llms.txt", "/docs/llms.txt"]) {
    const text = await (await request.get(`${origin}${doc}`, { headers: { accept: "text/markdown" } })).text();
    for (const m of text.matchAll(/https?:\/\/[^\s)<>"'`\]]+/g)) {
      const url = m[0].replace(/[.,;:]+$/, "");
      // Templates ({repoId}, <changeId>) and endpoints that need a body or credentials.
      if (!url.startsWith(origin) || /[{<]|%7B|%3C/.test(url)) continue;
      const path = new URL(url).pathname;
      if (/^\/(mcp|api\/|git\/|webhooks\/|github\/|oauth\/|claim\/)/.test(path) || path === "/mcp") continue;
      urls.add(url);
    }
  }
  for (const url of urls) {
    const res = await request.get(url, { headers: { accept: "*/*" } });
    if (res.status() >= 400) failures.push(`listed URL ${url}: HTTP ${res.status()}`);
  }
  if (urls.size < 5) failures.push(`only ${urls.size} same-origin URLs found in /start, /llms.txt and /docs/llms.txt`);
  return failures;
}

/**
 * A GitHub delivery with a wrong signature is refused before anything is queued: 401. Where GitHub
 * mode is deliberately off (staging, `SMOKE_GITHUB=off`), the refusal is 503 github-not-configured.
 */
export async function checkWebhookRejectsBadSignature(request: APIRequestContext, origin: string): Promise<void> {
  const res = await request.post(`${origin}/github/webhooks`, {
    headers: {
      "content-type": "application/json",
      "x-github-event": "ping",
      "x-github-delivery": `e2e-${Date.now()}`,
      "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
    },
    data: { zen: "e2e" },
  });
  if (process.env.SMOKE_GITHUB === "off") {
    expect(res.status()).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("github-not-configured");
  } else {
    expect(res.status()).toBe(401);
  }
}
