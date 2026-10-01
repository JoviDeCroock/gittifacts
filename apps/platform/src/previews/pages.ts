/**
 * What the preview gateway adds to and says around a preview: the banner every HTML response
 * carries, and the small pages for "building", "starting", "failed" and "no such preview".
 *
 * The banner is a custom element positioned with inline `!important` declarations (which beat
 * every author stylesheet) and its content lives in a closed declarative shadow root, so page CSS
 * cannot restyle, hide or cover it (it sits at the maximum z-index). Page scripts could still
 * remove it; nothing served through the gateway is trusted, which is why it also carries
 * `X-Robots-Tag: noindex` and `frame-ancestors 'none'`.
 */

export const BANNER_TAG = "gittifacts-preview-banner";
export const BANNER_HEIGHT_PX = 28;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

export function bannerText(projectName: string, changeId: string): string {
  return `Preview of ${projectName} · change ${changeId} · not production · gittifacts`;
}

/** The banner element plus a spacer that keeps normal-flow content below it. */
export function bannerHtml(projectName: string, changeId: string): string {
  const host = [
    "all:initial",
    "position:fixed",
    "top:0",
    "left:0",
    "right:0",
    `height:${BANNER_HEIGHT_PX}px`,
    "z-index:2147483647",
    "display:block",
    "visibility:visible",
    "opacity:1",
    "pointer-events:auto",
    "transform:none",
    "clip-path:none",
  ]
    .map((d) => `${d} !important`)
    .join(";");
  const style = `:host{all:initial}div{box-sizing:border-box;height:${BANNER_HEIGHT_PX}px;padding:0 12px;display:flex;align-items:center;gap:8px;background:#1d1b16;color:#fffbe8;font:600 13px/1 ui-sans-serif,system-ui,sans-serif;border-bottom:2px solid #f5b800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}b{color:#f5b800}`;
  const text = escapeHtml(bannerText(projectName, changeId));
  return (
    `<${BANNER_TAG} role="note" aria-label="${text}" style="${host}">` +
    `<template shadowrootmode="closed"><style>${style}</style><div><b>PREVIEW</b><span>${text}</span></div></template>` +
    `</${BANNER_TAG}>` +
    `<div aria-hidden="true" style="all:initial !important;display:block !important;height:${BANNER_HEIGHT_PX}px !important"></div>`
  );
}

export function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").toLowerCase().includes("text/html");
}

const PAGE_HEADERS = {
  "x-robots-tag": "noindex, nofollow",
  "content-security-policy": "frame-ancestors 'none'",
  "cache-control": "no-store",
  // The gateway does not add a second banner to pages that already carry one.
  "x-gittifacts-page": "1",
};

function page(
  status: number,
  title: string,
  body: string,
  opts: { refreshSeconds?: number; projectName?: string; changeId?: string },
): string {
  const banner =
    opts.projectName !== undefined && opts.changeId !== undefined
      ? bannerHtml(opts.projectName, opts.changeId)
      : "";
  const refresh =
    opts.refreshSeconds === undefined
      ? ""
      : `<meta http-equiv="refresh" content="${opts.refreshSeconds}">`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${refresh}<title>${escapeHtml(title)}</title><style>body{font:16px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;color:#1d1b16;background:#fffdf5}main{max-width:36rem;margin:15vh auto 0;padding:0 1rem}h1{font-size:1.25rem}p{color:#4a463c}</style></head><body>${banner}<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p><small>gittifacts preview · HTTP ${status}</small></p></main></body></html>`;
}

/** 503 "come back in a moment": a self-refreshing page for browsers, Retry-After for the rest. */
export function busyPage(
  request: Request,
  opts: {
    title: string;
    body: string;
    projectName?: string;
    changeId?: string;
    retryAfter?: number;
  },
): Response {
  const retry = String(opts.retryAfter ?? 3);
  if (!wantsHtml(request)) {
    return new Response(`${opts.title} ${opts.body}\n`, {
      status: 503,
      headers: {
        ...PAGE_HEADERS,
        "content-type": "text/plain; charset=utf-8",
        "retry-after": retry,
      },
    });
  }
  return new Response(
    page(503, opts.title, opts.body, { ...opts, refreshSeconds: Number(retry) }),
    {
      status: 503,
      headers: {
        ...PAGE_HEADERS,
        "content-type": "text/html; charset=utf-8",
        "retry-after": retry,
      },
    },
  );
}

export function errorPage(
  request: Request,
  status: 404 | 410 | 502 | 503,
  title: string,
  body: string,
  opts: { projectName?: string; changeId?: string } = {},
): Response {
  if (!wantsHtml(request)) {
    return new Response(`${title}: ${body}\n`, {
      status,
      headers: { ...PAGE_HEADERS, "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(page(status, title, body, opts), {
    status,
    headers: { ...PAGE_HEADERS, "content-type": "text/html; charset=utf-8" },
  });
}
