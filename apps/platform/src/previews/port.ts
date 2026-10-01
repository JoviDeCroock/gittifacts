/**
 * The coordinator's `Previews` port on Cloudflare: records the pinned preview in D1, boots its
 * `PreviewHost` (waiting until it serves), and screenshots it with Browser Run
 * (docs/research/release-observability.md §5), storing PNGs in R2 under
 * `screenshots/<changeId>/<head12>/<viewport><route>.png` (served by GET /api/v1/blobs/:ref).
 */

import { isTemplateId, TEMPLATES } from "@app/conventions";
import type { PreviewOutcome, PreviewRequest, Previews } from "@app/coordinator";
import type { Screenshots } from "@app/evidence";
import { eq } from "drizzle-orm";
import { previews } from "../db/schema.js";
import type { D1Store } from "../store/d1-store.js";
import { previewIdFor, previewUrlFor, previewZone } from "./ids.js";
import type { PreviewConfig, PreviewState } from "./preview-host.js";

/** How long the workflow's preview step waits for a boot before reporting it. */
export const START_WAIT_MS = 120_000;
const MAX_ROUTES = 4;
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
} as const;

export interface PreviewsEnv {
  BLOBS: R2Bucket;
  PREVIEW_ZONE?: string;
  PREVIEW_HOST: {
    getByName(name: string): {
      ensure(config: PreviewConfig, opts: { waitMs: number }): Promise<PreviewState>;
    };
  };
  BROWSER?: Pick<BrowserRun, "quickAction">;
}

function routeKey(route: string): string {
  const clean = route.split(/[?#]/)[0] ?? "/";
  const path = clean === "/" || clean === "" ? "/index" : clean.replace(/\/+$/, "/index");
  return path.replace(/[^A-Za-z0-9/_.-]/g, "_").slice(0, 200);
}

export class PlatformPreviews implements Previews {
  constructor(
    private readonly env: PreviewsEnv,
    private readonly store: D1Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(req: PreviewRequest): Promise<PreviewOutcome> {
    const zone = previewZone(this.env);
    if (req.template !== null && isTemplateId(req.template)) {
      if (TEMPLATES[req.template].manifest.previewCommand === null) {
        return {
          status: "skipped",
          url: null,
          reason: `${req.template} has no runtime to serve: its first green is CI and the public-API diff (informational)`,
        };
      }
    }
    const step =
      req.snapshots.build !== undefined
        ? "build"
        : req.snapshots.install !== undefined
          ? "install"
          : null;
    const snapshotId = step === null ? undefined : req.snapshots[step];
    if (step === null || snapshotId === undefined) {
      return {
        status: "skipped",
        url: null,
        reason:
          "the pipeline left no build (or install) snapshot to start a preview from (informational)",
      };
    }
    const url = previewUrlFor(zone, req.changeId);
    const pinnedUrl = previewUrlFor(zone, req.changeId, req.headSha);
    if (url === null || pinnedUrl === null) {
      return {
        status: "skipped",
        url: null,
        reason: "the change id does not fit a preview hostname",
      };
    }
    const id = previewIdFor(req.changeId, req.headSha);
    const repo = await this.store.getRepo(req.repoId);
    const config: PreviewConfig = {
      previewId: id,
      changeId: req.changeId,
      repoId: req.repoId,
      projectName: repo?.name ?? req.artifactsRepo,
      headSha: req.headSha,
      artifactsRepo: req.artifactsRepo,
      snapshotId,
      snapshotStep: step,
      template: req.template,
      claimed: req.claimed,
    };
    const at = this.now().toISOString();
    await this.store.db
      .insert(previews)
      .values({
        ...config,
        id,
        status: "starting",
        detail: null,
        createdAt: at,
        readyAt: null,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: previews.id,
        set: { snapshotId, snapshotStep: step, status: "starting", detail: null, updatedAt: at },
      });
    let state: PreviewState;
    try {
      state = await this.env.PREVIEW_HOST.getByName(id).ensure(config, { waitMs: START_WAIT_MS });
    } catch (e) {
      state = {
        status: "failed",
        detail: e instanceof Error ? e.message : String(e),
        readyAt: null,
        bootMs: null,
      };
    }
    const done = this.now().toISOString();
    if (state.status === "ready") {
      await this.store.db
        .update(previews)
        .set({ status: "ready", readyAt: state.readyAt ?? done, updatedAt: done })
        .where(eqId(id));
      return { status: "ready", url, pinnedUrl, readyMs: state.bootMs ?? 0 };
    }
    const reason =
      state.status === "failed"
        ? `the preview failed to start: ${state.detail ?? "unknown error"}`
        : `the preview did not answer within ${START_WAIT_MS / 1000} s`;
    if (state.status === "failed") {
      await this.store.db
        .update(previews)
        .set({ status: "failed", detail: reason.slice(0, 2000), updatedAt: done })
        .where(eqId(id));
    }
    return { status: "error", url, reason };
  }

  async screenshots(input: {
    changeId: string;
    headSha: string;
    url: string;
    routes: string[];
    template: string | null;
  }): Promise<Screenshots> {
    const browser = this.env.BROWSER;
    if (browser === undefined || typeof browser.quickAction !== "function") {
      return {
        id: "screenshots",
        kind: "screenshots",
        status: "skipped",
        note: "Browser Run is not bound in this environment (informational)",
        shots: [],
      };
    }
    const templateRoutes =
      input.template !== null && isTemplateId(input.template)
        ? TEMPLATES[input.template].manifest.routes
        : [];
    const routes = [...new Set([...input.routes, ...templateRoutes])].slice(0, MAX_ROUTES);
    if (routes.length === 0) routes.push("/");
    const base = previewUrlFor(previewZone(this.env), input.changeId, input.headSha) ?? input.url;
    const shots: Screenshots["shots"] = [];
    const failures: string[] = [];
    let limited = false;
    outer: for (const route of routes) {
      for (const [viewport, size] of Object.entries(VIEWPORTS) as Array<
        [keyof typeof VIEWPORTS, (typeof VIEWPORTS)[keyof typeof VIEWPORTS]]
      >) {
        let res: Response;
        try {
          res = await browser.quickAction("screenshot", {
            url: `${base}${route.startsWith("/") ? route : `/${route}`}`,
            viewport: { ...size },
            screenshotOptions: { type: "png" },
            gotoOptions: { waitUntil: "networkidle0", timeout: 20_000 },
          });
        } catch (e) {
          failures.push(`${route} (${viewport}): ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        if (res.status === 429) {
          limited = true;
          await res.body?.cancel();
          break outer;
        }
        if (!res.ok || res.body === null) {
          failures.push(`${route} (${viewport}): Browser Run answered ${res.status}`);
          await res.body?.cancel();
          continue;
        }
        const key = `screenshots/${input.changeId}/${input.headSha.slice(0, 12)}/${viewport}${routeKey(route)}.png`;
        await this.env.BLOBS.put(key, res.body, {
          httpMetadata: { contentType: "image/png" },
          customMetadata: { changeId: input.changeId },
        });
        shots.push({ route, viewport, afterRef: key });
      }
    }
    if (shots.length > 0) {
      return {
        id: "screenshots",
        kind: "screenshots",
        status: "ok",
        ...(failures.length + (limited ? 1 : 0) > 0
          ? {
              note: [limited ? "Browser Run rate limit reached" : null, ...failures]
                .filter(Boolean)
                .join("; ")
                .slice(0, 4000),
            }
          : {}),
        shots,
      };
    }
    if (limited) {
      return {
        id: "screenshots",
        kind: "screenshots",
        status: "skipped",
        note: "Browser Run rate limit reached before any screenshot (informational)",
        shots: [],
      };
    }
    return {
      id: "screenshots",
      kind: "screenshots",
      status: "error",
      note: `no screenshot could be taken: ${failures.join("; ")}`.slice(0, 4000),
      shots: [],
    };
  }
}

function eqId(id: string) {
  return eq(previews.id, id);
}
