/**
 * GitHub mode routes (mounted by src/app.ts):
 *
 *   GET  /api/v1/github                 our App (from config) + the installations you linked (humans)
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
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { repoAllowed } from "./allowlist.js";
import { finishSetup } from "./callbacks.js";
import { assertTargetAccess } from "../access/access.js";
import { GithubOverview, githubOverview } from "./overview.js";
import { latestBacktest, startBacktest } from "./backtests.js";
import { setPrWrites } from "./pr-index.js";
import { beginSetup, FlowError, NONCE_COOKIE, settingsUrl } from "./setup.js";
import { GITHUB_WEBHOOK_PATH, handleGithubWebhook } from "./webhook.js";

const TAG = ["github"];
const human = requirePrincipal([], { humanOnly: true });

const overview = createRoute({
  method: "get",
  path: "/api/v1/github",
  tags: TAG,
  security: SECURITY,
  summary:
    "GitHub mode: our GitHub App (or which config is missing) and the installations you linked",
  middleware: [human] as const,
  responses: { 200: json(GithubOverview, "Overview"), ...errors(401, 403) },
});

const prWrites = createRoute({
  method: "put",
  path: "/api/v1/github/repos/{repoId}/pr-writes",
  tags: TAG,
  security: SECURITY,
  summary: "Repo owners: turn the walkthrough review and summary comment on GitHub PRs on or off",
  description:
    "The gittifacts/lane check run is always posted. Off: nothing else is written to the repo's pull requests.",
  middleware: [human] as const,
  request: {
    params: z.object({ repoId: z.string().min(1).max(64) }),
    body: body(z.object({ value: z.enum(["on", "off"]) })),
  },
  responses: {
    200: json(z.object({ repoId: z.string(), prWrites: z.enum(["on", "off"]) }), "Saved"),
    ...errors(400, 401, 403, 404),
  },
});

const BacktestView = z
  .object({
    id: z.string(),
    status: z.enum(["running", "done", "failed"]),
    since: z.string(),
    until: z.string(),
    maxPrs: z.number().int(),
    report: z
      .unknown()
      .nullable()
      .describe("BacktestReport (packages/host-github/src/backtest/report.ts) once done"),
    eligible: z.boolean().nullable(),
    error: z.string().nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .meta({ id: "GithubBacktest" });

const startBacktestRoute = createRoute({
  method: "post",
  path: "/api/v1/github/repos/{repoId}/backtests",
  tags: TAG,
  security: SECURITY,
  summary:
    "Repo owners: backtest the repository's merged PRs (lanes, later reverts and patches, calibration)",
  description:
    "Grades the newest settled merged PRs of the window with the live pipeline (no tours, nothing written to GitHub). One at a time per repo.",
  middleware: [human] as const,
  request: {
    params: z.object({ repoId: z.string().min(1).max(64) }),
    body: body(
      z.object({
        days: z.number().int().min(14).max(365).default(90),
        maxPrs: z.number().int().min(1).max(100).default(24),
      }),
    ),
  },
  responses: {
    202: json(z.object({ id: z.string(), started: z.boolean() }), "Started (or already running)"),
    ...errors(400, 401, 403, 404),
  },
});

const latestBacktestRoute = createRoute({
  method: "get",
  path: "/api/v1/github/repos/{repoId}/backtests/latest",
  tags: TAG,
  security: SECURITY,
  summary: "The repository's latest backtest and its report",
  middleware: [human] as const,
  request: { params: z.object({ repoId: z.string().min(1).max(64) }) },
  responses: {
    200: json(z.object({ backtest: BacktestView.nullable() }), "Latest"),
    ...errors(401, 403, 404),
  },
});

type Flow = (
  svc: Services,
  caller: Caller,
  query: Record<string, string>,
  nonce: string | undefined,
) => Promise<{ redirect: string; nonce?: string } | string>;

/**
 * A browser leg: signed-in human or off to sign in; any failure lands on the settings page. The
 * install nonce rides in an HttpOnly cookie set by /github/setup and cleared by the callback.
 */
function browser(flow: Flow) {
  return async (c: Context<AppEnv>) => {
    const caller = await resolveCaller(c);
    if (!caller || caller.principal.kind !== "human") {
      const url = new URL(c.req.url);
      return c.redirect(`/signin?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
    }
    try {
      const out = await flow(c.get("services"), caller, c.req.query(), getCookie(c, NONCE_COOKIE));
      const to = typeof out === "string" ? out : out.redirect;
      if (typeof out !== "string" && out.nonce !== undefined) {
        setCookie(c, NONCE_COOKIE, out.nonce, {
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
          path: "/github",
          maxAge: 600,
        });
      } else {
        deleteCookie(c, NONCE_COOKIE, { path: "/github" });
      }
      return c.redirect(to, 303);
    } catch (err) {
      deleteCookie(c, NONCE_COOKIE, { path: "/github" });
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

  app.openapi(prWrites, async (c) => {
    const svc = c.get("services");
    const caller = callerOf(c);
    const { repoId } = c.req.valid("param");
    await assertTargetAccess(svc, caller.principal, { repoId }, "admin");
    const repo = await svc.store.getRepo(repoId);
    if (repo?.host == null)
      throw new ApiError(404, "not-found", "not a GitHub repository graded here");
    const { value } = c.req.valid("json");
    await setPrWrites(svc.store.db, {
      repoId,
      value,
      by: caller.principal.id,
      at: svc.clock.now().toISOString(),
    });
    await svc.audit.append({
      principalId: caller.principal.id,
      action: "github.pr-writes",
      subject: `repo:${repoId}`,
      payload: { value },
    });
    return c.json({ repoId, prWrites: value }, 200);
  });

  app.openapi(startBacktestRoute, async (c) => {
    const svc = c.get("services");
    const caller = callerOf(c);
    const { repoId } = c.req.valid("param");
    await assertTargetAccess(svc, caller.principal, { repoId }, "admin");
    const repo = await svc.store.getRepo(repoId);
    if (repo?.host == null)
      throw new ApiError(404, "not-found", "not a GitHub repository graded here");
    const { days, maxPrs } = c.req.valid("json");
    if (
      !repoAllowed(
        svc.env as unknown as Record<string, unknown>,
        `${repo.host.owner}/${repo.host.repo}`,
      )
    ) {
      throw new ApiError(
        403,
        "repo-not-allowed",
        "this platform runs GitHub mode for an allowlist of repositories only",
      );
    }
    const out = await startBacktest(svc.env, {
      installationId: repo.host.installationId,
      appId: repo.host.appId,
      githubRepoId: repo.host.githubRepoId,
      fullName: `${repo.host.owner}/${repo.host.repo}`,
      by: caller.principal.id,
      days,
      maxPrs,
    });
    return c.json(out, 202);
  });
  app.openapi(latestBacktestRoute, async (c) => {
    const svc = c.get("services");
    const { repoId } = c.req.valid("param");
    await assertTargetAccess(svc, callerOf(c).principal, { repoId }, "read");
    const b = await latestBacktest(svc.store.db, repoId);
    return c.json(
      {
        backtest:
          b === null
            ? null
            : {
                id: b.id,
                status: b.status,
                since: b.since,
                until: b.until,
                maxPrs: b.maxPrs,
                report: b.report ?? null,
                eligible: b.eligible ?? null,
                error: b.error,
                createdAt: b.createdAt,
                finishedAt: b.finishedAt,
              },
      },
      200,
    );
  });

  app.get(
    "/github/setup",
    browser((svc, caller, q) => beginSetup(svc, caller, q)),
  );
  app.get(
    "/github/oauth/callback",
    browser((svc, caller, q, nonce) => finishSetup(svc, caller, q, nonce)),
  );
  app.post(GITHUB_WEBHOOK_PATH, handleGithubWebhook);

  for (const [path, summary] of [
    [
      "/github/setup",
      "GitHub redirect after installing an App; verified through user authorization",
    ],
    [
      "/github/oauth/callback",
      "User authorization callback: links the installation if it is yours",
    ],
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
