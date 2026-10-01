/**
 * Where routes and MCP tools get the `CoordinatorApi`. They never talk to Durable Objects or
 * Workflows directly.
 *
 * TODO(lead): replace `coordinatorStub` with the real factory from @app/coordinator, e.g.
 *   (env, ctx) => createCoordinatorApi(buildPorts(env, ctx, "default"))
 */
import type { CoordinatorApi } from "@app/coordinator";
import type { Bindings } from "./app-env.js";
import { coordinatorStub } from "./coordinator-stub.js";

export type CoordinatorFactory = (env: Bindings, ctx: ExecutionContext) => CoordinatorApi;

export const getCoordinator: CoordinatorFactory = (_env, _ctx) => coordinatorStub;
