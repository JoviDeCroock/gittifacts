/**
 * `MergeQueue` Durable Object (one per repo, addressed by repo id): the ONLY writer of a repo's
 * default branch. Its Ports are built for the "merge-queue" role, the only role whose GitHost may
 * mint (≤ 300 s, never returned) main-repo write tokens. The queue lives in DO SQLite; an
 * alarm-driven loop advances the head item (see merge-queue.ts).
 */
import { DurableObject } from "cloudflare:workers";
import type { EnqueueInput, MergeQueueClient, MergeQueueEntry } from "./bindings.js";
import { MergeQueueCore, SqlQueueStorage } from "./merge-queue.js";
import { resolveRuntime } from "./runtime.js";

export class MergeQueue extends DurableObject<unknown> implements MergeQueueClient {
  private coreInstance: MergeQueueCore | null = null;

  private get core(): MergeQueueCore {
    if (this.coreInstance === null) {
      const { ports, bindings, runtime } = resolveRuntime(this.env, "merge-queue");
      this.coreInstance = new MergeQueueCore({
        ports,
        bindings,
        storage: new SqlQueueStorage(this.ctx.storage.sql),
        ...(runtime.mergeQueueOptions ? { options: runtime.mergeQueueOptions } : {}),
      });
    }
    return this.coreInstance;
  }

  async enqueue(input: EnqueueInput): Promise<{ position: number }> {
    const result = await this.core.enqueue(input);
    await this.arm(0);
    return result;
  }

  remove(input: { repoId: string; changeId: string }): Promise<boolean> {
    return this.core.remove(input);
  }

  list(repoId: string): Promise<MergeQueueEntry[]> {
    return this.core.list(repoId);
  }

  override async alarm(): Promise<void> {
    const { next } = await this.core.tick();
    if (next !== null) await this.arm(next);
  }

  /** Make sure an alarm fires within `delayMs` (keeps an earlier one). */
  private async arm(delayMs: number): Promise<void> {
    const at = Date.now() + delayMs;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
}
