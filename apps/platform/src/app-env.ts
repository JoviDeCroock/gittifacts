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
  /** O3 claim page (unset: Cloudflare's always-pass test keys; src/claim/turnstile.ts). */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** Comma-separated principal ids (hu_…) of platform admins (kill-switch override). */
  PLATFORM_ADMINS?: string;
  /** Comma-separated principal ids (humans or agents) with read-only access to every repo. */
  PLATFORM_AUDITORS?: string;
  /** JSON override of unclaimed-project limits (src/limits/config.ts). */
  UNCLAIMED_LIMITS?: string;
};

/** Who is calling: a signed-in human (better-auth session) or an agent (gtf_ bearer token). */
export interface Caller {
  principal: Principal;
  user: SessionUser | null;
  via: "session" | "agent-token";
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
    notifier: new D1Notifier(store, now),
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
