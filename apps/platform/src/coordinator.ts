/**
 * Where routes and MCP tools get the `CoordinatorApi`. They never talk to Durable Objects or
 * Workflows directly: the facade does, through `cloudflareBindings(env)` (COORDINATOR,
 * MERGE_QUEUE, CHANGE_WORKFLOW, ROLLOUT_WORKFLOW).
 */
import {
  type CoordinatorApi,
  type CoordinatorOptions,
  cloudflareBindings,
  createCoordinator,
} from "@app/coordinator";
import { repoAccessPort } from "./access/port.js";
import type { Bindings } from "./app-env.js";
import { guardImportGrants } from "./import/push-grant-runtime.js";
import { unclaimedLimits } from "./limits/config.js";
import { initialCommitProvider } from "./projects/initial-commit.js";
import { buildPorts } from "./runtime/ports.js";

/** `origin`: the platform origin agents see (written into new repos' AGENTS.md). */
export type CoordinatorFactory = (
  env: Bindings,
  ctx: ExecutionContext,
  origin: string,
) => CoordinatorApi;

/** Shared by the HTTP facade and the PushRouter workflow (configureCoordinatorRuntime). */
export const COORDINATOR_OPTIONS: CoordinatorOptions = { jurisdiction: "eu" };

/**
 * Coordinator options for request handlers: new repos get an initial commit (templates), and
 * unclaimed ones expire after the configured TTL (`UNCLAIMED_TTL_DAYS`, src/limits/config.ts).
 */
export function facadeOptions(
  origin: string,
  env: { UNCLAIMED_LIMITS?: string; UNCLAIMED_TTL_DAYS?: string } = {},
): CoordinatorOptions {
  const ttlDays = unclaimedLimits(env).ttlDays;
  return {
    ...COORDINATOR_OPTIONS,
    unclaimedTtlMs: Math.round(ttlDays * 86_400_000),
    initialCommit: initialCommitProvider({
      host: origin,
      mcpUrl: `${origin}/mcp`,
      unclaimedTtlDays: ttlDays,
    }),
  };
}

/**
 * Request facades check repo membership on every actor-driven call (src/access/), and close a
 * live import-by-push grant before any Change starts (src/import/push-grant.ts).
 */
export const getCoordinator: CoordinatorFactory = (env, ctx, origin) =>
  guardImportGrants(
    createCoordinator(
      buildPorts(env, "default", { overrides: { access: repoAccessPort(env) } }),
      cloudflareBindings(env),
      facadeOptions(origin, env),
    ),
    env,
    ctx,
    origin,
  );
