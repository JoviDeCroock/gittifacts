/**
 * Test entry (`main` for the vitest pool): the production Worker module, with the coordinator's
 * Ports for Artifacts, containers and the reviewer model swapped for fakes (test/integration/
 * fakes.ts says why each one). Re-configuring after `src/index.ts` ran its own
 * `configureCoordinatorRuntime` makes the Durable Objects and Workflows use these.
 */
import { configureCoordinatorRuntime } from "@app/coordinator/workers";
import type { Bindings } from "../src/app-env.js";
import { COORDINATOR_OPTIONS } from "../src/coordinator.js";
import { buildPorts } from "../src/runtime/ports.js";
import { integrationOverrides } from "./integration/fakes.js";

export * from "../src/index.js";
export { default } from "../src/index.js";

configureCoordinatorRuntime<Bindings>({
  ports: (env, role) => buildPorts(env, role, { overrides: integrationOverrides(role) }),
  coordinatorOptions: COORDINATOR_OPTIONS,
});
