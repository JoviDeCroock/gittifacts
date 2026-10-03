/**
 * The agent-facing queue API (§5): `enqueue`, `queue_status`, `wait_for_merge`, `dequeue`,
 * `reprioritize`, `queue_overview`, freeze/thaw. Runs inside the MergeQueue DO; callers (HTTP
 * routes, MCP tools) authenticate, check scopes and who may act on the Change first. Results are
 * plain data with `{ ok: false, error: { code, message, fix } }` for refusals (RPC-safe).
 */
import type { ErrorFix } from "@app/domain";
import { type PriorityClass, TERMINAL_STATES } from "@app/merge-queue";
import type { QueueIntent } from "./context.js";
import type { MergeQueueService } from "./service.js";
import { entryView, overviewView, type QueueEntryView, type QueueOverviewView } from "./views.js";

export interface QueueActor {
  principalId: string;
  kind: "human" | "agent" | "system";
  sessionId: string | null;
}

export interface QueueRequest {
  changeId: string;
  priority?: "normal" | "security" | "incident";
  dependsOn?: string[];
  plangroup?: string | null;
  landTogether?: boolean;
  groupSize?: number | null;
  landMode?: "atomic" | "incremental";
  /** Required (an approved incident Plan) for an agent asking for the incident class. */
  incidentPlanId?: string | null;
  by: QueueActor;
}

export interface QueueRequestResult {
  changeId: string;
  /** In the queue now (the ChangeWorkflow admitted it); false = registered, admitted on approval. */
  admitted: boolean;
  state: string;
  position: number;
  track: string | null;
  etaSeconds: number;
  predictedPassProbability: number;
  reason: string;
}

export type QueueRefusal = { ok: false; error: { code: string; message: string; fix: ErrorFix } };
export type QueueResult<T> = ({ ok: true } & T) | QueueRefusal;

export interface WaitForMergeResult {
  reason: "merged" | "ejected" | "dequeued" | "frozen" | "timeout" | "not-queued";
  status: QueueEntryView | null;
  frozen: boolean;
}

const refuse = (code: string, message: string, fix: ErrorFix): QueueRefusal => ({
  ok: false,
  error: { code, message, fix },
});

const q = (s: string) => JSON.stringify(s);

/** Why a registered (not yet admitted) Change is not in the queue, from its status. */
function pendingReason(status: string, lane: number | null): string {
  switch (status) {
    case "awaiting-push":
    case "running":
      return "CI and evidence are still running; it joins the queue once it is approved (Lane 0 joins automatically).";
    case "awaiting-review":
      return `Lane ${lane ?? "?"}: waits for a human review; it joins the queue as soon as it is approved.`;
    case "failing":
      return "the Change is failing; fix it and push again (the options you gave are kept).";
    default:
      return `the Change is ${status}; it joins the queue when its workflow admits it.`;
  }
}

export class QueueAgentApi {
  constructor(private readonly svc: MergeQueueService) {}

  private get state() {
    return this.svc.loop.state;
  }

  private intentOf = (changeId: string) => this.svc.store.getIntent<QueueIntent>(changeId);

  private view(changeId: string): QueueEntryView | null {
    return entryView(this.state, changeId, this.svc.ctx.now(), this.intentOf, this.svc.stalls());
  }

  async status(changeId: string): Promise<QueueEntryView | null> {
    await this.svc.init();
    return this.view(changeId);
  }

  async overview(): Promise<QueueOverviewView> {
    await this.svc.init();
    return overviewView({
      repoId: this.svc.ctx.repoId,
      state: this.state,
      trains: this.svc.loop.trains,
      halted: this.svc.loop.halted,
      now: this.svc.ctx.now(),
      intentOf: this.intentOf,
      stalls: this.svc.stalls(),
    });
  }

  /**
   * `enqueue`: record the options, and if the ChangeWorkflow already admitted this head apply
   * what can change in flight (priority). It never admits a Change by itself: routing (review,
   * Lane 0 auto-merge, unclaimed projects) stays the ChangeWorkflow's decision.
   */
  async request(input: QueueRequest): Promise<QueueResult<QueueRequestResult>> {
    await this.svc.init();
    const { store } = this.svc.ctx.ports;
    const change = await store.getChange(input.changeId);
    if (change === null || change.repoId !== this.svc.ctx.repoId)
      return refuse("not-found", `no change ${input.changeId} in this repo`, {
        explanation: "Check the change id (get_change_status lists your changes' status).",
      });
    if (input.priority === "incident" && input.by.kind !== "human") {
      const plan = input.incidentPlanId ? await store.getPlan(input.incidentPlanId) : null;
      if (plan === null || plan.repoId !== change.repoId || plan.status !== "approved")
        return refuse(
          "forbidden",
          "the incident class needs a human or an approved incident Plan",
          {
            explanation:
              "Pass incidentPlanId of an approved Plan for this incident, or ask a human to reprioritize.",
            call: `create_plan({ repoId: ${q(change.repoId)}, title: "Incident: <what>", intent: "<why this is an incident>", acceptanceCriteria: ["<done when>"] })`,
          },
        );
    }
    const prior = this.intentOf(change.id);
    const opts = { ...(prior?.options ?? {}) };
    if (input.priority !== undefined) opts.priority = input.priority;
    if (input.dependsOn !== undefined)
      opts.dependsOn = [...new Set(input.dependsOn)].filter((d) => d !== change.id);
    if (input.plangroup !== undefined) opts.plangroup = input.plangroup;
    if (input.landTogether !== undefined) opts.landTogether = input.landTogether;
    if (input.groupSize !== undefined) opts.groupSize = input.groupSize;
    if (input.landMode !== undefined) opts.landMode = input.landMode;
    if (input.incidentPlanId !== undefined) opts.incidentPlanId = input.incidentPlanId;
    const intent: QueueIntent = {
      workflowInstanceId: prior?.workflowInstanceId ?? null,
      options: opts,
      requestedBy: input.by,
      admittedHead: prior?.admittedHead ?? null,
      title: change.title,
      updatedAt: this.svc.ctx.now(),
    };
    this.svc.store.putIntent(change.id, intent);
    const e = this.state.entries[change.id];
    const active = e !== undefined && !TERMINAL_STATES.has(e.state) && e.headSha !== null;
    if (active && input.priority !== undefined && input.priority !== e.priority) {
      this.svc.dispatchShellEvent({
        type: "Reprioritized",
        changeId: change.id,
        priority: input.priority,
        by: { principalId: input.by.principalId, kind: input.by.kind },
        incidentPlanId: input.incidentPlanId ?? null,
      });
    }
    await this.svc.arm();
    const v = active ? this.view(change.id) : null;
    if (v !== null)
      return {
        ok: true,
        changeId: change.id,
        admitted: true,
        state: v.state,
        position: v.position ?? 0,
        track: v.trackId,
        etaSeconds: v.etaSeconds ?? 0,
        predictedPassProbability: v.predictedPassProbability ?? 0,
        reason: v.reason,
      };
    const s = this.state;
    const waiting = Object.values(s.entries).filter((x) => x.state === "waiting").length;
    return {
      ok: true,
      changeId: change.id,
      admitted: false,
      state: "pending-admission",
      position: waiting,
      track: null,
      etaSeconds: Math.round(
        (s.stats.ciDurationMs * (1.2 + waiting / Math.max(1, s.config.maxBatchSize))) / 1000,
      ),
      predictedPassProbability: Math.round(s.stats.batchPassRate * 1000) / 1000,
      reason: pendingReason(change.status, change.lane),
    };
  }

  async dequeue(input: {
    changeId: string;
    by: QueueActor;
  }): Promise<QueueResult<{ status: QueueEntryView | null; removed: boolean }>> {
    await this.svc.init();
    const e = this.state.entries[input.changeId];
    const prior = this.intentOf(input.changeId);
    if (prior !== null)
      this.svc.store.putIntent(input.changeId, {
        ...prior,
        options: {},
        updatedAt: this.svc.ctx.now(),
      });
    if (e === undefined || TERMINAL_STATES.has(e.state))
      return { ok: true, status: this.view(input.changeId), removed: false };
    this.svc.dispatchShellEvent({
      type: "Dequeued",
      changeId: input.changeId,
      by: input.by.principalId,
    });
    await this.svc.arm();
    return { ok: true, status: this.view(input.changeId), removed: true };
  }

  async reprioritize(input: {
    changeId: string;
    priority: PriorityClass;
    by: QueueActor;
    incidentPlanId?: string | null;
  }): Promise<QueueResult<{ status: QueueEntryView | null }>> {
    if (input.priority === "revert" && input.by.kind !== "human")
      return refuse("forbidden", "only reverts (or a human) use the revert class", {
        explanation: "Revert Changes get the revert class automatically.",
      });
    const r = await this.request({
      changeId: input.changeId,
      ...(input.priority === "revert" ? {} : { priority: input.priority }),
      incidentPlanId: input.incidentPlanId ?? null,
      by: input.by,
    });
    if (!r.ok) return r;
    if (input.priority === "revert") {
      this.svc.dispatchShellEvent({
        type: "Reprioritized",
        changeId: input.changeId,
        priority: "revert",
        by: { principalId: input.by.principalId, kind: input.by.kind },
        incidentPlanId: null,
      });
    }
    return { ok: true, status: this.view(input.changeId) };
  }

  /** `wait_for_merge`: until merged, ejected or dequeued, the queue freezing, or `timeoutMs` (≤ 55 s). */
  async waitForMerge(changeId: string, timeoutMs: number): Promise<WaitForMergeResult> {
    await this.svc.init();
    const deadline = this.svc.ctx.now() + Math.min(Math.max(0, timeoutMs), 55_000);
    const frozenAtStart = this.state.freeze.reasons.length > 0;
    for (;;) {
      const s = this.state;
      const e = s.entries[changeId];
      const frozen = s.freeze.reasons.length > 0;
      const status = this.view(changeId);
      if (e === undefined) {
        const pending = this.intentOf(changeId) !== null;
        if (!pending) return { reason: "not-queued", status: null, frozen };
      } else if (e.state === "merged" || e.state === "ejected" || e.state === "dequeued") {
        return { reason: e.state, status, frozen };
      }
      if (frozen && !frozenAtStart) return { reason: "frozen", status, frozen };
      const remaining = deadline - this.svc.ctx.now();
      if (remaining <= 0) return { reason: "timeout", status, frozen };
      await this.svc.awaitChange(remaining);
    }
  }

  /** Human-signed freeze/thaw (the caller checked the human and produced the signature). */
  async setFrozen(input: {
    frozen: boolean;
    signer: { principalId: string; kind: "human"; signature: string };
    reason: string;
  }): Promise<QueueResult<{ frozen: boolean }>> {
    await this.svc.init();
    this.svc.dispatchShellEvent({
      type: input.frozen ? "Freeze" : "Thaw",
      signer: input.signer,
      reason: input.reason,
    });
    await this.svc.arm();
    return { ok: true, frozen: this.state.freeze.reasons.length > 0 };
  }
}
