/**
 * The QA run's seams: the browser (Browser Run in production; tests configure a fake), the model
 * client (the reviewer's, on the platform default model), and the private preview the app is
 * served from. `configureQaRuntime` swaps the first two, like the workspace and import runtimes.
 */

import type { QaBrowser } from "@app/qa";
import { DEFAULT_PRICES, type LlmClient, reviewerLlmFromEnv } from "@app/tour";
import type { Bindings } from "../app-env.js";
import { previewZone } from "../previews/ids.js";
import type { PreviewConfig, PreviewState } from "../previews/preview-host.js";
import { PREVIEW_ID_HEADER } from "../previews/preview-host.js";
import { resolveReviewerModel, WORKERS_AI_PRICES } from "../runtime/ports.js";
import { type AppFetch, BrowserRunQa } from "./browser-run.js";

export interface OpenedBrowser extends QaBrowser {
  close(): Promise<void>;
}

export interface QaRuntime {
  browser(env: Bindings, origin: string, app: AppFetch): Promise<OpenedBrowser>;
  llm(env: Bindings, policyModel: string): LlmClient | null;
}

const KEY = "__gittifactsQaRuntime";

export const defaultQaRuntime: QaRuntime = {
  browser: async (env, origin, app) => {
    if (env.BROWSER === undefined) throw new Error("Browser Run is not bound in this environment");
    const b = new BrowserRunQa(env.BROWSER as unknown as Fetcher, origin, app);
    await b.open();
    return b;
  },
  llm: (env, policyModel) => {
    try {
      const prices = { ...DEFAULT_PRICES, ...WORKERS_AI_PRICES };
      return reviewerLlmFromEnv(env, { model: resolveReviewerModel(env, policyModel), prices });
    } catch {
      return null;
    }
  },
};

export function configureQaRuntime(runtime: Partial<QaRuntime>): void {
  (globalThis as Record<string, unknown>)[KEY] = { ...defaultQaRuntime, ...runtime };
}

export function qaRuntime(): QaRuntime {
  return (
    ((globalThis as Record<string, unknown>)[KEY] as QaRuntime | undefined) ?? defaultQaRuntime
  );
}

/** The private preview of a head: `q-<changeId>-<sha8>`, never registered with the gateway. */
export function privatePreviewId(changeId: string, headSha: string): string {
  return `q-${changeId}-${headSha.slice(0, 8)}`.toLowerCase().slice(0, 63);
}

/** The app's origin in the QA browser: a `q-` host the public gateway refuses (fail closed). */
export function qaOrigin(
  env: { PREVIEW_ZONE?: string; PREVIEW_HOST_SUFFIX?: string },
  previewId: string,
): string {
  const suffix = previewZone(env);
  return `https://${previewId}${suffix}`;
}

type HostStub = {
  ensure(config: PreviewConfig, opts: { waitMs: number }): Promise<PreviewState>;
  fetch(request: Request): Promise<Response>;
  destroy?(): Promise<void>;
};

export function previewStub(env: Bindings, previewId: string): HostStub {
  return env.PREVIEW_HOST.getByName(previewId) as unknown as HostStub;
}

/** Requests from the QA page → the private preview (our headers only). */
export function appFetchFor(env: Bindings, previewId: string): AppFetch {
  const stub = previewStub(env, previewId);
  return async (req) => {
    const headers = new Headers(req.headers);
    for (const name of [...headers.keys()])
      if (name.startsWith("x-gittifacts-")) headers.delete(name);
    headers.set(PREVIEW_ID_HEADER, previewId);
    const init: RequestInit = { method: req.method, headers, redirect: "manual" };
    if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.arrayBuffer();
    return stub.fetch(new Request(req.url, init));
  };
}
