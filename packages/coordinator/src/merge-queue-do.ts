/**
 * `MergeQueue` Durable Object (one per repo, addressed by repo id): the agent-native merge queue
 * (docs/prompts/03-merge-queue.md). The ONLY writer of a repo's default branch and of
 * `refs/queue/*`: its Ports are built for the "merge-queue" role, the only role whose GitHost may
 * mint (≤ 300 s, never returned) main-repo write tokens.
 *
 * Same class name and binding as the serial queue it replaces (no migration: its SQLite tables
 * stay, and items still in them are adopted on first use). The loop, handlers and API are in
 * ./queue (node-safe); this class only wires them to the DO's SQLite, alarm and RPC.
 */
import { DurableObject } from "cloudflare:workers";
import type { PriorityClass } from "@app/merge-queue";
import type { EnqueueInput, MergeQueueClient, MergeQueueEntry } from "./bindings.js";
import {
  type QueueActor,
  QueueAgentApi,
  type QueueRequest,
  type QueueRequestResult,
  type QueueResult,
  type WaitForMergeResult,
} from "./queue/agent-api.js";
import { MergeQueueService } from "./queue/service.js";
import type { EventRow } from "./queue/store.js";
import type { QueueEntryView, QueueOverviewView } from "./queue/views.js";
import { resolveRuntime } from "./runtime.js";

export class MergeQueue extends DurableObject<unknown> implements MergeQueueClient {
  private svc: MergeQueueService | null = null;
  private apiInstance: QueueAgentApi | null = null;

  private async repoIdOf(given?: string): Promise<string> {
    const known = await this.ctx.storage.get<string>("repoId");
    if (given !== undefined && given !== "" && known !== given) {
      if (known !== undefined) throw new Error(`this merge queue serves ${known}, not ${given}`);
      await this.ctx.storage.put("repoId", given);
      return given;
    }
    if (known === undefined) throw new Error("merge queue has no repo yet");
    return known;
  }

  private async service(repoId?: string): Promise<MergeQueueService> {
    if (this.svc !== null) return this.svc;
    const id = await this.repoIdOf(repoId);
    const { ports, bindings, runtime } = resolveRuntime(this.env, "merge-queue");
    const q = runtime.mergeQueue?.(this.env);
    if (q === undefined)
      throw new Error("the agent-native merge queue is not configured (runtime.mergeQueue)");
    const storage = this.ctx.storage;
    this.svc = new MergeQueueService({
      repoId: id,
      ports,
      bindings,
      sql: storage.sql,
      transact: (fn) => storage.transactionSync(fn),
      jobs: q.jobs,
      batchRuns: q.batchRuns,
      ...(q.resolver === undefined ? {} : { resolver: q.resolver }),
      targetsSupported: q.targetsSupported === true,
      trains: q.trains === true,
      ...(q.config === undefined ? {} : { config: q.config }),
      alarm: { get: () => storage.getAlarm(), set: (at) => storage.setAlarm(at) },
    });
    return this.svc;
  }

  private async api(repoId?: string): Promise<QueueAgentApi> {
    const svc = await this.service(repoId);
    this.apiInstance ??= new QueueAgentApi(svc);
    return this.apiInstance;
  }

  // ------------------------------------------------------------ ChangeWorkflow / coordinator

  async enqueue(input: EnqueueInput): Promise<{ position: number }> {
    return (await this.service(input.repoId)).enqueue(input);
  }

  async remove(input: { repoId: string; changeId: string }): Promise<boolean> {
    return (await this.service(input.repoId)).remove(input);
  }

  async list(repoId: string): Promise<MergeQueueEntry[]> {
    return (await this.service(repoId)).list();
  }

  async onQueueResult(input: { event: unknown; meta?: Record<string, unknown>; repoId?: string }) {
    return (await this.service(input.repoId)).onQueueResult(input);
  }

  async approved(input: {
    changeId: string;
    lane: 0 | 1 | 2;
    approver: { principalId: string; kind: "human" | "agent" | "system" };
  }): Promise<void> {
    return (await this.service()).approved(input);
  }

  async onIssue(input: {
    worker: string;
    versionId: string;
    issueId: string;
    frames: { file: string; fn?: string }[];
  }): Promise<boolean> {
    return (await this.service()).onIssue(input);
  }

  // ------------------------------------------------------------ agents (MCP / HTTP)

  async queueRequest(
    repoId: string,
    input: QueueRequest,
  ): Promise<QueueResult<QueueRequestResult>> {
    return (await this.api(repoId)).request(input);
  }

  async queueStatus(repoId: string, changeId: string): Promise<QueueEntryView | null> {
    return (await this.api(repoId)).status(changeId);
  }

  async queueOverview(repoId: string): Promise<QueueOverviewView> {
    return (await this.api(repoId)).overview();
  }

  async waitForMerge(
    repoId: string,
    changeId: string,
    timeoutMs: number,
  ): Promise<WaitForMergeResult> {
    return (await this.api(repoId)).waitForMerge(changeId, timeoutMs);
  }

  async dequeue(repoId: string, input: { changeId: string; by: QueueActor }) {
    return (await this.api(repoId)).dequeue(input);
  }

  async reprioritize(
    repoId: string,
    input: {
      changeId: string;
      priority: PriorityClass;
      by: QueueActor;
      incidentPlanId?: string | null;
    },
  ) {
    return (await this.api(repoId)).reprioritize(input);
  }

  async setFrozen(
    repoId: string,
    input: {
      frozen: boolean;
      signer: { principalId: string; kind: "human"; signature: string };
      reason: string;
    },
  ) {
    return (await this.api(repoId)).setFrozen(input);
  }

  async queueEvents(
    repoId: string,
    input: { since: number; timeoutMs: number; changeId?: string },
  ): Promise<{ events: EventRow[]; last: number }> {
    return (await this.service(repoId)).watch(input);
  }

  async resume(repoId: string, by: string): Promise<void> {
    return (await this.service(repoId)).resume(by);
  }

  override async alarm(): Promise<void> {
    const svc = await this.service().catch(() => null);
    if (svc === null) return;
    await svc.alarm();
  }
}
