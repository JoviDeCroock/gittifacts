/**
 * `QueueShell` (packages/merge-queue/src/shell.ts) on the coordinator's Ports. Every handler is
 * idempotent: the loop re-runs a command whose result was not committed (crash, retry), and the
 * result event echoes the ids the core gave it.
 */
import {
  AffectedSet,
  type Command,
  type CommandOf,
  type CoreEventInput,
  type QueueShell,
  unknownAffectedSet,
} from "@app/merge-queue";
import { createOrGet, terminateQuietly } from "../bindings.js";
import { changeSubject, ZERO_SHA } from "../ids.js";
import type { BatchRunParams } from "./batch-run.js";
import { casHandler } from "./cas.js";
import type { QueueContext } from "./context.js";
import { onQueueEvent } from "./emit.js";
import { openFlakyTestPlan, requestApproval } from "./human.js";
import { resolutionHandler } from "./resolve.js";

type Emit = (event: CoreEventInput) => Promise<void>;

/** `refs/queue/<batchId>` → the sha the DO pointed it at (so GC can delete it with CAS). */
const refKey = (refName: string) => `ref:${refName}`;

export class CoordinatorQueueShell implements QueueShell {
  constructor(private readonly ctx: QueueContext) {}

  dispatch(cmd: Command, emit: Emit): Promise<void> {
    switch (cmd.type) {
      case "BuildBatchTree":
        return this.buildBatchTree(cmd, emit);
      case "StartBatchRun":
        return this.startBatchRun(cmd, emit);
      case "CancelBatchRun":
        return this.cancelBatchRun(cmd);
      case "RunFlakeRecheck":
        return this.runFlakeRecheck(cmd, emit);
      case "RequestResolution":
        return this.requestResolution(cmd, emit);
      case "ComputeAffectedSet":
        return this.computeAffectedSet(cmd, emit);
      case "Cas":
        return this.cas(cmd, emit);
      case "DeleteQueueRef":
        return this.deleteQueueRef(cmd);
      case "Emit":
        return this.emit(cmd);
      case "Audit":
        return this.audit(cmd);
      case "OpenPlan":
        return this.openPlan(cmd);
      case "RequestApproval":
        return this.requestApproval(cmd, emit);
      case "Telemetry":
        return this.telemetry(cmd);
    }
  }

  /** The result the protocol allows for a command that failed for good (null: drop it). */
  giveUp(cmd: Command, error: string): CoreEventInput | null {
    switch (cmd.type) {
      case "StartBatchRun":
        return {
          type: "BatchResult",
          batchId: cmd.batchId,
          runId: cmd.runId,
          treeSha: cmd.treeSha,
          outcome: "errored",
          scope: cmd.targets,
        };
      case "ComputeAffectedSet":
        // Unknown conflicts with everything: never defaults to parallel.
        return {
          type: "AffectedSetComputed",
          changeId: cmd.changeId,
          headSha: cmd.headSha,
          affected: unknownAffectedSet(),
        };
      case "RequestResolution":
        return {
          type: "ResolutionResult",
          changeId: cmd.changeId,
          attempt: cmd.attempt,
          resolverId: "system:resolver",
          outcome: {
            status: "failed",
            message: `resolution could not run: ${error}`.slice(0, 2000),
          },
        };
      case "Cas":
        // Never "ok" without proof; the next CAS finds main's real position (stale → ok if it moved).
        return {
          type: "CasResult",
          casId: cmd.casId,
          result: "rejected",
          detail: error.slice(0, 2000),
        };
      default:
        return null;
    }
  }

  // ------------------------------------------------------------ batch trees

  async buildBatchTree(cmd: CommandOf<"BuildBatchTree">, emit: Emit): Promise<void> {
    const { git } = this.ctx.ports;
    const repo = await this.ctx.repo();
    const main = repo.artifactsName;
    const specs = await Promise.all(
      cmd.entries.map((e) => this.ctx.replaySpec(e.changeId, e.headSha)),
    );
    // Fast path: every head already sits on the tip before it (a lone Change on an unmoved base,
    // or a stack): the heads ARE the batch commits, no container needed.
    const chained = specs.every(
      (s, i) => s.replayBase === (i === 0 ? cmd.baseSha : specs[i - 1]?.headSha),
    );
    let result: Extract<CoreEventInput, { type: "RebaseResult" }>["result"];
    if (chained && specs.length > 0) {
      const commits: { changeId: string; commitSha: string; treeSha: string }[] = [];
      for (const s of specs) {
        await git.transferObjects(s.repo, main, s.headSha, cmd.refName);
        const treeSha = await git.treeOf(main, s.headSha);
        if (treeSha === null) throw new Error(`${s.headSha} has no tree in ${main}`);
        commits.push({ changeId: s.changeId, commitSha: s.headSha, treeSha });
      }
      const last = commits[commits.length - 1] as (typeof commits)[number];
      result = { status: "clean", tipSha: last.commitSha, treeSha: last.treeSha, commits };
    } else {
      await this.ctx.deps.jobs.ensureScratch({ mainRepo: main, scratch: this.ctx.scratch });
      const built = await this.ctx.deps.jobs.buildBatch({
        scratch: this.ctx.scratch,
        baseRepo: main,
        baseSha: cmd.baseSha,
        entries: specs,
        ref: `refs/heads/mq/${cmd.batchId}`,
      });
      if (built.status === "error") throw new Error(`batch ${cmd.batchId}: ${built.note}`);
      if (built.status === "conflict") {
        const upstream = [
          ...new Set(
            built.upstreamCommits
              .map((sha) => this.ctx.deps.store.changeOfCommit(sha))
              .filter((id): id is string => id !== null && id !== built.changeId),
          ),
        ];
        result = { status: "conflict", changeId: built.changeId, files: built.files, upstream };
      } else {
        // The DO is the only writer of refs/queue/*: copy the scratch tip into the main repo.
        await git.transferObjects(this.ctx.scratch, main, built.tipSha, cmd.refName);
        result = {
          status: "clean",
          tipSha: built.tipSha,
          treeSha: built.treeSha,
          commits: built.commits,
        };
      }
    }
    if (result.status === "clean") {
      this.ctx.deps.store.putCommits(
        result.commits.map((c) => ({ sha: c.commitSha, changeId: c.changeId })),
      );
      this.ctx.deps.store.putRun(refKey(cmd.refName), { sha: result.tipSha });
    }
    await emit({ type: "RebaseResult", batchId: cmd.batchId, result });
  }

  async deleteQueueRef(cmd: CommandOf<"DeleteQueueRef">): Promise<void> {
    const known = this.ctx.deps.store.getRun<{ sha: string }>(refKey(cmd.refName));
    if (known === null) return; // never written (build failed or still pending)
    const repo = await this.ctx.repo();
    const r = await this.ctx.ports.git.updateRef(
      repo.artifactsName,
      cmd.refName,
      known.sha,
      ZERO_SHA,
    );
    // Stale: already deleted (a retried GC) or rewritten by a rebuild that recorded its own sha.
    if (!r.ok && r.reason !== "stale") throw new Error(`delete ${cmd.refName}: ${r.detail}`);
  }

  // ------------------------------------------------------------ runs

  private async runParams(
    command: BatchRunParams["command"],
    changeId: string,
  ): Promise<BatchRunParams> {
    const repo = await this.ctx.repo();
    return {
      repoId: repo.id,
      mainRepo: repo.artifactsName,
      changeId,
      ciRunPrefix: this.ciPrefix(command.runId),
      network: repo.claim.status === "claimed" ? "open" : "registries-only",
      targetsSupported: this.ctx.deps.targetsSupported === true,
      command,
    };
  }

  /** CI run ids are global (engine workflow ids, pipeline_runs keys): repo + epoch + run. */
  private ciPrefix(runId: string): string {
    return `mq-${this.ctx.repoId}-${this.ctx.deps.epoch}-${runId}`.slice(0, 90);
  }

  private instanceId(runId: string): string {
    return `mq-${this.ctx.repoId}-${this.ctx.deps.epoch}-${runId}`.slice(0, 100);
  }

  async startBatchRun(cmd: CommandOf<"StartBatchRun">, _emit: Emit): Promise<void> {
    const changeId = cmd.entries[0] ?? this.firstEntryOf(cmd.batchId);
    if (changeId === null) throw new Error(`batch ${cmd.batchId} has no entries`);
    const id = this.instanceId(cmd.runId);
    await createOrGet(this.ctx.deps.batchRuns, id, await this.runParams(cmd, changeId));
    this.ctx.deps.store.putRun(cmd.runId, { instanceId: id, batchId: cmd.batchId });
  }

  async cancelBatchRun(cmd: CommandOf<"CancelBatchRun">): Promise<void> {
    await terminateQuietly(this.ctx.deps.batchRuns, this.instanceId(cmd.runId));
    const prefix = this.ciPrefix(cmd.runId);
    for (const suffix of ["r", "kb1", "kb2", "kb3", "km1", "km2", "km3"])
      await this.ctx.ports.ci
        .cancel(`${prefix}-${suffix}`.slice(0, 100), cmd.reason)
        .catch(() => undefined);
  }

  async runFlakeRecheck(cmd: CommandOf<"RunFlakeRecheck">, _emit: Emit): Promise<void> {
    const changeId = this.firstEntryOf(cmd.batchId);
    if (changeId === null) throw new Error(`batch ${cmd.batchId} has no entries`);
    const id = this.instanceId(cmd.runId);
    await createOrGet(this.ctx.deps.batchRuns, id, await this.runParams(cmd, changeId));
    this.ctx.deps.store.putRun(cmd.runId, { instanceId: id, batchId: cmd.batchId });
  }

  private firstEntryOf(batchId: string): string | null {
    const b = this.ctx.deps.state().batches[batchId];
    return b?.lineage[0] ?? b?.units[0]?.changeIds[0] ?? null;
  }

  // ------------------------------------------------------------ analysis, resolution, CAS

  async computeAffectedSet(cmd: CommandOf<"ComputeAffectedSet">, emit: Emit): Promise<void> {
    const spec = await this.ctx.replaySpec(cmd.changeId, cmd.headSha);
    const raw = await this.ctx.deps.jobs.affected({
      repo: spec.repo,
      baseSha: spec.replayBase,
      headSha: cmd.headSha,
    });
    const parsed = AffectedSet.safeParse(raw);
    if (!parsed.success) {
      await this.ctx.audit(changeSubject(cmd.changeId), "merge-queue.affected-set-invalid", {
        headSha: cmd.headSha,
        issue: parsed.error.issues[0]?.message ?? "invalid",
      });
    }
    await emit({
      type: "AffectedSetComputed",
      changeId: cmd.changeId,
      headSha: cmd.headSha,
      // An unreadable analysis is unknown, which conflicts with everything (never parallel).
      affected: parsed.success ? parsed.data : unknownAffectedSet(),
    });
  }

  requestResolution(cmd: CommandOf<"RequestResolution">, emit: Emit): Promise<void> {
    return resolutionHandler(this.ctx, cmd, emit);
  }

  cas(cmd: CommandOf<"Cas">, emit: Emit): Promise<void> {
    return casHandler(this.ctx, cmd, emit);
  }

  // ------------------------------------------------------------ events, audit, humans

  emit(cmd: CommandOf<"Emit">): Promise<void> {
    return onQueueEvent(this.ctx, cmd.event);
  }

  async audit(cmd: CommandOf<"Audit">): Promise<void> {
    await this.ctx.ports.audit.append({
      principalId: cmd.principalId,
      action: cmd.action,
      subject: cmd.subject,
      payload: {
        ...cmd.payload,
        repoId: this.ctx.repoId,
        ...(cmd.signature === null ? {} : { signature: cmd.signature }),
      },
    });
  }

  openPlan(cmd: CommandOf<"OpenPlan">): Promise<void> {
    return openFlakyTestPlan(this.ctx, cmd);
  }

  requestApproval(cmd: CommandOf<"RequestApproval">, _emit: Emit): Promise<void> {
    return requestApproval(this.ctx, cmd);
  }

  async telemetry(cmd: CommandOf<"Telemetry">): Promise<void> {
    // Prediction/outcome log for a learned model (Workers Logs); not audited.
    console.log(
      JSON.stringify({ mergeQueueTelemetry: cmd.kind, repoId: this.ctx.repoId, ...cmd.data }),
    );
  }
}
