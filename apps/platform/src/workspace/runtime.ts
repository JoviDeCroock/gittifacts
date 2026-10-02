/**
 * Seams for the Workspace Durable Object, set once at module top level of the Worker entry (like
 * `configureCoordinatorRuntime`). Production leaves them unset: the DO drives `ctx.container`
 * through `ContainerMachine`. Workerd tests can't run containers, so they install an in-memory
 * machine (test/integration/workspace-fakes.ts) and, optionally, a clock.
 *
 * Kept on globalThis: the test file and the Durable Object may load different module instances
 * of this file inside one isolate.
 */
import type { WorkspaceMachine } from "./machine.js";

export interface WorkspaceRuntime {
  /** The container for one workspace (`name` = workspace id). */
  machine?(ctx: DurableObjectState, name: string): WorkspaceMachine;
  /** Epoch milliseconds (TTL, idle sleep, usage days). */
  now?(): number;
}

const KEY = "__gittifactsWorkspaceRuntime";

export function configureWorkspaceRuntime(runtime: WorkspaceRuntime): void {
  (globalThis as unknown as Record<string, WorkspaceRuntime>)[KEY] = runtime;
}

export function workspaceRuntime(): WorkspaceRuntime {
  return (globalThis as unknown as Record<string, WorkspaceRuntime | undefined>)[KEY] ?? {};
}
