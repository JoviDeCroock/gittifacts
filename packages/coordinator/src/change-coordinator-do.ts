/**
 * `ChangeCoordinator` Durable Object (one per change, addressed by change id). All logic lives in
 * `ChangeCoordinatorCore`; this class wires DO storage and the GC alarm.
 */
import type { Change, WaitUntil } from "@app/domain";
import { DurableObject } from "cloudflare:workers";
import type {
  ChangeCoordinatorClient,
  ChangeCoordinatorState,
  PushInput,
  PushOutcome,
} from "./bindings.js";
import { ChangeCoordinatorCore } from "./change-coordinator.js";
import { resolveRuntime } from "./runtime.js";

export class ChangeCoordinator extends DurableObject<unknown> implements ChangeCoordinatorClient {
  private coreInstance: ChangeCoordinatorCore | null = null;

  private get core(): ChangeCoordinatorCore {
    if (this.coreInstance === null) {
      const { ports, bindings } = resolveRuntime(this.env, "default");
      const storage = this.ctx.storage;
      this.coreInstance = new ChangeCoordinatorCore({
        ports,
        bindings,
        storage: {
          get: <T>(key: string) => storage.get<T>(key),
          put: <T>(key: string, value: T) => storage.put<T>(key, value),
        },
        alarms: { setAlarm: (at) => storage.setAlarm(at) },
      });
    }
    return this.coreInstance;
  }

  onPush(input: PushInput): Promise<PushOutcome> {
    return this.core.onPush(input);
  }

  registerRun(input: { changeId: string; instanceId: string; runId: string }): Promise<void> {
    return this.core.registerRun(input);
  }

  recordSpend(input: { changeId: string; usd: number }): Promise<number> {
    return this.core.recordSpend(input);
  }

  spent(changeId: string): Promise<number> {
    return this.core.spent(changeId);
  }

  abandon(changeId: string): Promise<void> {
    return this.core.abandon(changeId);
  }

  scheduleForkGc(input: { changeId: string; forkName: string; delayMs: number }): Promise<void> {
    return this.core.scheduleForkGc(input);
  }

  state(changeId: string): Promise<ChangeCoordinatorState> {
    return this.core.state(changeId);
  }

  waitFor(input: { changeId: string; until: WaitUntil; timeoutMs: number }): Promise<{
    change: Change | null;
    reached: boolean;
    reason: "reached" | "timeout" | "unreachable";
  }> {
    return this.core.waitFor(input);
  }

  watch(input: { changeId: string; since: string | null; timeoutMs: number }): Promise<{
    change: Change | null;
    changed: boolean;
  }> {
    return this.core.watch(input);
  }

  changed(changeId: string): Promise<void> {
    return this.core.changed(changeId);
  }

  claimKey(input: { changeId: string; key: string; ttlMs: number }): Promise<boolean> {
    return this.core.claimKey(input);
  }

  releaseKey(input: { changeId: string; key: string }): Promise<void> {
    return this.core.releaseKey(input);
  }

  override async alarm(): Promise<void> {
    const next = await this.core.alarm();
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}
