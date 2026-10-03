/**
 * GitHub mode routes (mounted by src/app.ts):
 *
 *   GET  /api/v1/github                 our Apps + the installations you linked (humans)
 *   POST /api/v1/github/manifests       a manifest + signed state to create an App (platform admins)
 *   GET  /github/manifest/callback      GitHub → us after "Create GitHub App" (browser)
 *   GET  /github/setup                  GitHub → us after an install (browser; verified, see setup.ts)
 *   GET  /github/oauth/callback         the user authorization that proves the install is yours
 *   POST /github/webhooks               every App's webhook (src/github/webhook.ts)
 *
 * Browser routes answer with redirects, never JSON: problems land on /settings/github?error=….
 */
import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv, Caller, Services } from "../app-env.js";
import { callerOf, requirePrincipal, resolveCaller } from "../auth/middleware.js";
import { ApiError } from "../errors.js";
import { type ApiApp, body, errors, json, SECURITY } from "../routes/common.js";
import { finishManifest, finishSetup } from "./callbacks.js";
import { ManifestRequest } from "./manifest.js";
import { assertTargetAccess } from "../access/access.js";
import { GithubOverview, githubOverview } from "./overview.js";
import { setPrWrites } from "./pr-index.js";
import { beginSetup, FlowError, settingsUrl, startManifest } from "./setup.js";
import { GITHUB_WEBHOOK_PATH, handleGithubWebhook } from "./webhook.js";

const TAG = ["github"];
const human = requirePrincipal([], { humanOnly: true });

const ManifestStartSchema = z
  .object({
    kind: z.enum(["reader", "actor"]),
    name: z.string(),
    org: z.string().nullable(),
    action: z.string().describe("Form action on github.com (carries ?state=)"),
    manifest: z.string().describe("The `manifest` form field (JSON)"),
    state: z.string(),
    expiresAt: z.string(),
  })
  .meta({ id: "GithubManifestStart" });

const overview = createRoute({
  method: "get",
  path: "/api/v1/github",
  tags: TAG,
  security: SECURITY,
  summary: "GitHub mode: our GitHub Apps and the installations you linked (with their repos)",
  middleware: [human] as const,
  responses: { 200: json(GithubOverview, "Overview"), ...errors(401, 403) },
});

const manifest = createRoute({
  method: "post",
  path: "/api/v1/github/manifests",
  tags: TAG,
  security: SECURITY,
  summary: "Platform admins: a GitHub App manifest and a signed one-hour state to create the App",
  description:
    "The browser form-POSTs `manifest` to `action`. kind=actor (per-customer Actor App) needs GITHUB_ACTOR_APPS=on and an org.",
  middleware: [human] as const,
  request: { body: body(ManifestRequest) },
  responses: { 200: json(ManifestStartSchema, "Form data"), ...errors(400, 401, 403) },
});

const prWrites = createRoute({
  method: "put",
  path: "/api/v1/github/repos/{repoId}/pr-writes",
  tags: TAG,
  security: SECURITY,
  summary: "Repo owners: turn the tour review and summary comment on GitHub PRs on or off",
  description:
    "The gittifacts/lane check run is always posted. Off: nothing else is written to the repo's pull requests.",
  middleware: [human] as const,
  request: { params: z.object({ repoId: z.string().min(1).max(64) }), body: body(z.object({ value: z.enum(["on", "off"]) })) },
  responses: { 200: json(z.object({ repoId: z.string(), prWrites: z.enum(["on", "off"]) }), "Saved"), ...errors(400, 401, 403, 404) },
});

type Flow = (svc: Services, caller: Caller, query: Record<string, string>) => Promise<string>;

/** A browser leg: signed-in human or off to sign in; any failure lands on the settings page. */
function browser(flow: Flow) {
  return async (c: Context<AppEnv>) => {
    const caller = await resolveCaller(c);
    if (!caller || caller.principal.kind !== "human") {
      const url = new URL(c.req.url);
      return c.redirect(`/signin?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
    }
    try {
      return c.redirect(await flow(c.get("services"), caller, c.req.query()), 303);
    } catch (err) {
      if (err instanceof FlowError) return c.redirect(settingsUrl({ error: err.code }), 303);
      if (err instanceof ApiError && err.status === 403) {
        return c.redirect(settingsUrl({ error: "not-admin" }), 303);
      }
      console.error("github flow failed", (err as Error).name, (err as Error).message);
      return c.redirect(settingsUrl({ error: "internal" }), 303);
    }
  };
}

export function registerGithubRoutes(app: ApiApp): void {
  app.openapi(overview, async (c) =>
    c.json(await githubOverview(c.get("services"), callerOf(c)), 200),
  );
  app.openapi(manifest, async (c) => {
    try {
      const out = await startManifest(c.get("services"), callerOf(c), c.req.valid("json"));
      return c.json(out, 200);
    } catch (err) {
      if (err instanceof FlowError) {
        throw new ApiError(err.code === "actor-apps-disabled" ? 403 : 400, err.code, err.code);
      }
      throw err;
    }
  });

  app.openapi(prWrites, async (c) => {
    const svc = c.get("services");
    const caller = callerOf(c);
    const { repoId } = c.req.valid("param");
    await assertTargetAccess(svc, caller.principal, { repoId }, "admin");
    const repo = await svc.store.getRepo(repoId);
    if (repo?.host == null) throw new ApiError(404, "not-found", "not a GitHub repository graded here");
    const { value } = c.req.valid("json");
    await setPrWrites(svc.store.db, { repoId, value, by: caller.principal.id, at: svc.clock.now().toISOString() });
    await svc.audit.append({ principalId: caller.principal.id, action: "github.pr-writes", subject: `repo:${repoId}`, payload: { value } });
    return c.json({ repoId, prWrites: value }, 200);
  });

  app.get("/github/manifest/callback", browser(finishManifest));
  app.get("/github/setup", browser(beginSetup));
  app.get("/github/oauth/callback", browser(finishSetup));
  app.post(GITHUB_WEBHOOK_PATH, handleGithubWebhook);

  for (const [path, summary] of [
    ["/github/manifest/callback", "GitHub redirect after creating an App (code + state); browser only"],
    ["/github/setup", "GitHub redirect after installing an App; verified through user authorization"],
    ["/github/oauth/callback", "User authorization callback: links the installation if it is yours"],
  ] as const) {
    app.openAPIRegistry.registerPath({
      method: "get",
      path,
      tags: TAG,
      summary,
      responses: {
        302: { description: "To sign in first" },
        303: { description: "To /settings/github (with created, linked or error)" },
      },
    });
  }
  app.openAPIRegistry.registerPath({
    method: "post",
    path: GITHUB_WEBHOOK_PATH,
    tags: TAG,
    summary: "GitHub App webhooks (HMAC-SHA-256 per App, deduplicated by delivery id, queued)",
    request: {
      headers: z.object({
        "x-github-hook-installation-target-id": z.string(),
        "x-hub-signature-256": z.string(),
        "x-github-delivery": z.string(),
        "x-github-event": z.string(),
      }),
    },
    responses: {
      202: { description: "Queued (or a duplicate delivery, acknowledged)" },
      401: { description: "Unknown App or bad signature" },
      429: { description: "Too many requests from this address" },
      503: { description: "Could not queue; GitHub may redeliver" },
    },
  });
}
