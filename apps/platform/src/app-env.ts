import type { Audit, Clock, CoordinatorApi, Notifier } from "@app/coordinator";
import type { Principal } from "@app/domain";
import { DoAudit } from "./audit/audit.js";
import type { SessionUser } from "./auth/principals.js";
import type { CoordinatorFactory } from "./coordinator.js";
import { D1Notifier } from "./notifier.js";
import { type PlatformSigner, platformSigner } from "./signing.js";
import { D1Store } from "./store/d1-store.js";

/** Worker bindings (generated `Env`) plus optional, untyped-by-wrangler vars. */
export type Bindings = Env & {
  BETTER_AUTH_URL?: string;
  /** O3 claim page (no secret: claims fail closed; src/claim/turnstile.ts). */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** "1" (dev, tests, E2E only): no secret falls back to Cloudflare's always-pass test keys. */
  TURNSTILE_TEST_KEYS?: string;
  /** Comma-separated principal ids (hu_…) of platform admins (kill-switch override). */
  PLATFORM_ADMINS?: string;
  /** Comma-separated principal ids (humans or agents) with read-only access to every repo. */
  PLATFORM_AUDITORS?: string;
  /** JSON override of unclaimed-project limits (src/limits/config.ts). */
  UNCLAIMED_LIMITS?: string;
  /**
   * GitHub mode (src/github/app-config.ts): the Reader App's vars and secrets. The Actor App (M5)
   * uses the same names with `GITHUB_ACTOR_APP_`; read through `githubApp(env, kind)`.
   */
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_WEBHOOK_SECRET_PREVIOUS?: string;
  /** Comma-separated `owner/repo`: GitHub mode acts on these repos only (src/github/allowlist.ts). */
  GITHUB_REPO_ALLOWLIST?: string;
  /** Verified GitHub deliveries (queue `gittifacts-github-events`). */
  GITHUB_EVENTS?: import("./github/webhook.js").GithubEventsQueue;
  GITHUB_WEBHOOK_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  /** On-request QA runs (src/qa/workflow.ts), one instance per run id. */
  QA_WORKFLOW?: { create(opts: { id: string; params: unknown }): Promise<unknown> };
};

/**
 * Who is calling: a signed-in human (better-auth session), an agent (gtf_ bearer token) or an
 * installed integration (gti_ bearer token, src/integrations).
 */
export interface Caller {
  principal: Principal;
  user: SessionUser | null;
  via: "session" | "agent-token" | "integration-token";
  /** Agent tokens: unix seconds; sessions: undefined. */
  expiresAtSec?: number;
}

/**
 * Per-request dependencies shared by HTTP routes and MCP tools (the "service functions" both
 * call take this). Built once per request; cheap.
 */
export interface Services {
  env: Bindings;
  store: D1Store;
  audit: Audit;
  notifier: Notifier;
  clock: Clock;
  coordinator: CoordinatorApi;
  signer(): Promise<PlatformSigner>;
  waitUntil(p: Promise<unknown>): void;
  /** AuditLog instance this deployment writes to. */
  auditLog: string;
  /** The platform origin agents see (BETTER_AUTH_URL, else the request's origin). */
  origin: string;
}

export interface AppOptions {
  coordinator: CoordinatorFactory;
  clock?: Clock;
  /** AuditLog DO name (tests use their own). */
  auditLog?: string;
}

export function createServices(
  env: Bindings,
  ctx: ExecutionContext,
  opts: AppOptions,
  origin: string,
): Services {
  const clock = opts.clock ?? { now: () => new Date() };
  const now = () => clock.now();
  const store = new D1Store(env.DB, env.BLOBS, now);
  const auditLog = opts.auditLog ?? "global";
  return {
    env,
    store,
    audit: new DoAudit(env, auditLog),
    notifier: new D1Notifier(store, now, env),
    clock,
    coordinator: opts.coordinator(env, ctx, origin),
    signer: () => platformSigner(env),
    waitUntil: (p) => ctx.waitUntil(p),
    auditLog,
    origin,
  };
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    services: Services;
    caller: Caller | null | undefined;
  };
};
