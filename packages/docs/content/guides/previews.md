---
title: Previews and screenshots
description: Every Change head gets a live preview URL and screenshots of its routes. How they are built, how to choose routes, and what to do when one fails.
order: 9
audience: both
---

# Previews and screenshots

Every Change gets a preview of its head: the project running in a container, behind the platform's preview gateway. Its screenshots become evidence, so a reviewer sees the UI without checking anything out.

## 1. Find the URL

| URL | Serves |
|---|---|
| `https://p-<changeId>-pv.resynapse.dev` | The Change's latest head |
| `https://p-<changeId>-<sha8>-pv.resynapse.dev` | One pinned head (first 8 characters of the commit) |

`create_project` returns the bootstrap preview as `previewUrl`; `get_change_status` returns it for any Change. Expected: "Building…" until CI is green, then the app.

## 2. Know what serves it

The preview starts from the CI **build** step's snapshot, so it serves exactly what was built:

- **A Worker** (a `wrangler.jsonc`, `wrangler.json` or `wrangler.toml`): `wrangler dev`, local mode, against the build output when it is one module.
- **A static site** (no wrangler config): the first of `dist/`, `build/`, `out/`, `public/`, `_site/`, `site/` with an `index.html`, served as static assets.
- **No preview:** libraries (`ts-library`) and projects without a build step.

Previews have no internet access and no secrets. They sleep after 10 idle minutes and wake on the next request ("Starting preview…" for pages, `503` with `Retry-After` for other requests).

## 3. Choose the routes to screenshot

Screenshots (desktop and mobile) are taken of the union of:

1. `previewRoutes` in `.platform/policy.ts`;
2. `affectedRoutes` in the Change's Plan;
3. the template's own routes.

Declare routes in the Plan when the Change touches specific pages:

```text
create_plan({ repoId: "rp_9xk2m", title: "Redesign settings", intent: "Settings is hard to scan on phones; group it into sections.", acceptanceCriteria: ["Settings shows three sections on a 390px screen"], scopePaths: ["src/**"], affectedRoutes: ["/settings"] })
```

The screenshots are `screenshots:<route>` evidence items; the tour links them. **Coming soon:** before/after pairs (today the platform captures the head only).

## 4. Know the gateway's rules

- Every HTML page gets a banner naming the Change; unclaimed projects' previews say "Unclaimed project — not verified".
- Responses carry `X-Robots-Tag: noindex` and can't be framed.
- `/cdn-cgi/*` is blocked, and cookies scoped to another domain are dropped.
- Only the 3 newest previews of an unclaimed project stay live.

## When a preview fails

| Symptom | Meaning | Fix |
|---|---|---|
| `preview` evidence `status: "error"` (lane rises to 1) | The server didn't start from the build snapshot | Run the build and `npx wrangler dev` locally; check `wrangler.jsonc` `main` points at the build output |
| `screenshots` `status: "skipped"` | Browser Run was unavailable or rate-limited | Nothing to fix; screenshots are informational. An `error` status (not `skipped`) raises the lane to 1 |
| Stuck on "Building…" | CI hasn't passed for this head | `get_change_status` names the failing step |

A preview reported by a connected deploy platform (Netlify, Cloudflare Workers Builds…) arrives as a separate signed `preview` item: [Deployments API](/docs/guides/integrations/deployments).
