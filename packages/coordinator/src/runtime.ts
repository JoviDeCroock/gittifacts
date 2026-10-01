/**
 * How the coordinator's Durable Objects and Workflows (instantiated by the runtime with only
 * `env`) get their Ports. The Worker that exports them calls `configureCoordinatorRuntime` once at
 * module top level:
 *
 *   configureCoordinatorRuntime<Env>({
 *     ports: (env, role) => buildPorts(env, role),   // role "merge-queue" may write main repos
 *   });
 *   export { ChangeCoordinator, MergeQueue, ChangeWorkflow, RolloutWorkflow, PushRouter } from "@app/coordinator/workers";
 */
import type { CoordinatorBindings } from "./bindings.js";
import { type CoordinatorEnv, cloudflareBindings } from "./cloudflare-bindings.js";
import type { MergeQueueOptions } from "./merge-queue.js";
import type { Ports, PortsRole } from "./ports.js";
import type { CoordinatorOptions } from "./service.js";

export interface CoordinatorRuntime<Env = unknown> {
  ports(env: Env, role: PortsRole): Ports;
  /** Defaults to `cloudflareBindings(env)` (bindings named per BINDING_NAMES). */
  bindings?(env: Env): CoordinatorBindings;
  coordinatorOptions?: CoordinatorOptions;
  mergeQueueOptions?: Partial<MergeQueueOptions>;
}

let current: CoordinatorRuntime<unknown> | null = null;

export function configureCoordinatorRuntime<Env>(runtime: CoordinatorRuntime<Env>): void {
  current = runtime as unknown as CoordinatorRuntime<unknown>;
}

export function getCoordinatorRuntime(): CoordinatorRuntime<unknown> {
  if (current === null) {
    throw new Error(
      "coordinator runtime not configured: call configureCoordinatorRuntime() in the Worker entry",
    );
  }
  return current;
}

export interface ResolvedRuntime {
  ports: Ports;
  bindings: CoordinatorBindings;
  runtime: CoordinatorRuntime<unknown>;
}

export function resolveRuntime(env: unknown, role: PortsRole): ResolvedRuntime {
  const runtime = getCoordinatorRuntime();
  const bindings = runtime.bindings
    ? runtime.bindings(env)
    : cloudflareBindings(env as CoordinatorEnv);
  return { ports: runtime.ports(env, role), bindings, runtime };
}
