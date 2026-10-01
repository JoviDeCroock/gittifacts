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
import type { Bindings } from "./app-env.js";
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

/** Coordinator options for request handlers: new repos get an initial commit (templates). */
export function facadeOptions(origin: string): CoordinatorOptions {
  return {
    ...COORDINATOR_OPTIONS,
    initialCommit: initialCommitProvider({ host: origin, mcpUrl: `${origin}/mcp` }),
  };
}

export const getCoordinator: CoordinatorFactory = (env, _ctx, origin) =>
  createCoordinator(buildPorts(env, "default"), cloudflareBindings(env), facadeOptions(origin));
