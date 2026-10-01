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
import { buildPorts } from "./runtime/ports.js";

export type CoordinatorFactory = (env: Bindings, ctx: ExecutionContext) => CoordinatorApi;

/** Shared by the HTTP facade and the PushRouter workflow (configureCoordinatorRuntime). */
export const COORDINATOR_OPTIONS: CoordinatorOptions = { jurisdiction: "eu" };

export const getCoordinator: CoordinatorFactory = (env) =>
  createCoordinator(buildPorts(env, "default"), cloudflareBindings(env), COORDINATOR_OPTIONS);
