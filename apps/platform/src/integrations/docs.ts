/**
 * GET /docs/integrations — the integrator guide, negotiated like /start:
 * markdown by default (agents, curl), HTML for browsers (`Accept: text/html`), JSON with
 * `Accept: application/json` (endpoints, scopes, events, headers).
 */
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import { urlsFor } from "../oauth/context.js";
import type { ApiApp } from "../routes/common.js";
import { integrationsMarkdown } from "./docs-content.js";
import { INTEGRATION_SCOPES, SCOPE_WORDS, WebhookEvent } from "./scopes.js";

export const DOCS_PATH = "/docs/integrations";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(https?:\/\/[^\s<)|]+[^\s<)|.,:;])/g, '<a href="$1">$1</a>');
}

/** Markdown → HTML for the subset the guide uses (headings, lists, tables, fences, paragraphs). */
export function renderMarkdown(md: string): string {
  const out: string[] = [];
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) body.push(lines[i++] ?? "");
      i++;
      out.push(
        `<pre><code${lang ? ` data-lang="${esc(lang)}"` : ""}>${esc(body.join("\n"))}</code></pre>`,
      );
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h?.[1] && h[2] !== undefined) {
      const n = h[1].length;
      const id = h[2]
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      out.push(`<h${n} id="${id}">${inline(h[2])}</h${n}>`);
      i++;
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("|")) {
        const cells = (lines[i] ?? "")
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim());
        if (!cells.every((c) => /^-+$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      out.push(
        `<div class="table"><table><thead><tr>${(head ?? []).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    const li = /^(\s*)(-|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2] ?? "");
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)(-|\d+\.)\s+(.*)$/.exec(lines[i] ?? "");
        if (!m) break;
        items.push(`<li>${inline(m[3] ?? "")}</li>`);
        i++;
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^(#|```|\||\s*-\s|\s*\d+\.\s)/.test(lines[i] ?? "")
    ) {
      para.push(lines[i++] ?? "");
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

const CSS = `:root{--paper:oklch(98.3% .004 250);--sheet:oklch(99.5% .002 250);--panel:oklch(96.4% .006 250);--hair:oklch(90.5% .01 250);--ink:oklch(23% .035 262);--ink2:oklch(42% .028 258);--teal:oklch(47% .088 196)}
@media (prefers-color-scheme:dark){:root{--paper:oklch(17.5% .016 258);--sheet:oklch(20.5% .018 258);--panel:oklch(23.5% .02 258);--hair:oklch(30% .02 258);--ink:oklch(94% .008 250);--ink2:oklch(80% .01 250);--teal:oklch(76% .105 190)}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:400 1rem/1.55 "Atkinson Hyperlegible Next",ui-sans-serif,system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}h1{font-size:1.75rem;line-height:1.25;letter-spacing:-.012em}h2{font-size:1.1875rem;margin-top:2.2em;padding-top:1em;border-top:1px solid var(--hair)}
p,li{max-width:72ch}a{color:var(--teal)}code{font:400 .8125rem/1.6 ui-monospace,SF Mono,Menlo,monospace;background:var(--panel);border-radius:3px;padding:0 3px}
pre{background:var(--panel);border:1px solid var(--hair);border-radius:12px;padding:12px 16px;overflow:auto}pre code{background:none;padding:0}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.9375rem}th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--hair)}th{color:var(--ink2);font-weight:560}`;

function html(md: string, origin: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Integrations · gittifacts</title><link rel="alternate" type="text/markdown" href="${origin}${DOCS_PATH}"><style>${CSS}</style></head><body><main>${renderMarkdown(md)}</main></body></html>`;
}

export function integrationsJson(origin: string) {
  return {
    docs: `${origin}${DOCS_PATH}`,
    oauth: {
      metadata: `${origin}/.well-known/oauth-authorization-server`,
      authorize: `${origin}/api/oauth/authorize`,
      token: `${origin}/api/oauth/token`,
      revoke: `${origin}/api/oauth/revoke`,
      resource: `${origin}/api`,
      pkce: "S256 (required)",
      clientAuthentication: ["client_secret_basic", "client_secret_post", "none (public clients)"],
      accessTokenTtlSeconds: 3600,
      refreshTokens: "rotating; reuse revokes the installation's tokens",
    },
    scopes: INTEGRATION_SCOPES.map((s) => ({ scope: s, ...SCOPE_WORDS[s] })),
    git: {
      repository: `${origin}/git/<owner>/<repo>.git`,
      change: `${origin}/git/<owner>/<repo>/changes/<changeId>.git`,
      auth: ["Basic x-access-token:<token>", "Bearer <token>"],
      services: ["git-upload-pack"],
      refused: ["git-receive-pack"],
    },
    webhooks: {
      events: WebhookEvent.options,
      headers: [
        "X-Gittifacts-Event",
        "X-Gittifacts-Delivery",
        "X-Gittifacts-Signature-256",
        "X-Gittifacts-Installation-Id",
      ],
      signature: "sha256=<hex HMAC-SHA-256(webhook secret, raw body)>",
      retries: "10s, 30s, 2m, 10m, 30m, 1h, 2h",
    },
    deployments: {
      create: `POST ${origin}/api/v1/repos/{repoId}/deployments`,
      status: `POST ${origin}/api/v1/deployments/{deploymentId}/statuses`,
      states: ["queued", "in_progress", "success", "failure", "error"],
    },
    installation: `GET ${origin}/api/v1/installation`,
    openapi: `${origin}/api/v1/openapi.json`,
  };
}

function negotiate(c: Context<AppEnv>): "html" | "json" | "markdown" {
  const accept = (c.req.header("accept") ?? "").toLowerCase();
  if (accept.includes("text/markdown")) return "markdown";
  if (accept.includes("application/json")) return "json";
  if (accept.includes("text/html")) return "html";
  return "markdown";
}

export function registerIntegrationDocs(app: ApiApp): void {
  app.get(DOCS_PATH, (c) => {
    const origin = urlsFor(c).origin;
    const headers = {
      vary: "Accept",
      "cache-control": "public, max-age=300",
      link: `<${origin}${DOCS_PATH}>; rel="service-doc"`,
    };
    const kind = negotiate(c);
    if (kind === "json") return c.json(integrationsJson(origin), 200, headers);
    const md = integrationsMarkdown(origin);
    if (kind === "html") return c.html(html(md, origin), 200, headers);
    return c.body(md, 200, { ...headers, "content-type": "text/markdown; charset=utf-8" });
  });
}
