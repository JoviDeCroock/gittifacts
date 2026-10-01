/**
 * MergeQueue logic (one instance per repo; the ONLY writer of the default branch).
 *
 * FIFO, one change at a time, driven by `tick()` (the DO calls it from its alarm and re-arms the
 * alarm with the returned delay). Each item walks a small persisted state machine so a DO restart
 * resumes where it stopped:
 *
 *   ready ──(main moved)──► rebase in sandbox ──► checking (cheap CI re-run) ──► re-sign evidence
 *     │                                                                          (rebasedFrom)
 *     └──(main == base, or already rebased onto main)──► merging
 *   merging:   transferObjects(fork → main, refs/merge-queue/<id>) → updateRef CAS on the default
 *              branch; stale → back to ready (bounded)
 *   finalize:  copy the evidence note to main, delete the staging ref, schedule fork GC, emit
 *              "merged" to the change's workflow, audit.
 *
 * Node-safe: storage is behind `QueueStorage` (SQLite in the DO, memory in tests).
 */
import type { Change, Repo } from "@app/domain";
import { encodeNote, EVIDENCE_NOTES_REF } from "@app/evidence";
import type { CoordinatorBindings, EnqueueInput, MergeQueueClient, MergeQueueEntry } from "./bindings.js";
import { sealEvidence } from "./evidence.js";
import { EVENT_MERGE_CONFLICT, EVENT_MERGED, type MergeConflictEvent, type MergedEvent } from "./events.js";
import { changeSubject, cheapRunIdFor, REBASE_BRANCH, stagingRefFor, ZERO_SHA } from "./ids.js";
import { withChangeNotifications } from "./milestones.js";
import { errorMessage } from "./policy.js";
import { type CiRunStatus, type Ports, SYSTEM_PRINCIPAL_ID } from "./ports.js";

export type QueuePhase = "ready" | "checking" | "merging" | "finalizing";

export interface QueueItem {
  changeId: string;
  repoId: string;
  seq: number;
  enqueuedAt: string;
  /** The approved head. */
  headSha: string;
  /** What main will be fast-forwarded to: the head, or its rebase. */
  candidateSha: string;
  /** Main sha the candidate was rebased onto (null = not rebased). */
  rebasedOnto: string | null;
  phase: QueuePhase;
  checkRunId: string | null;
  checkStartedAt: string | null;
  /** Bundle built by the cheap re-run for a rebased candidate. */
  bundleRef: string | null;
  /** Lost CAS races so far. */
  staleRetries: number;
  /** Unexpected errors so far (network, Artifacts). */
  errors: number;
  workflowInstanceId: string;
  lastError: string | null;
}

export interface QueueStorage {
  /** Items ordered by seq (FIFO). */
  list(): Promise<QueueItem[]>;
  get(changeId: string): Promise<QueueItem | null>;
  put(item: QueueItem): Promise<void>;
  delete(changeId: string): Promise<void>;
  nextSeq(): Promise<number>;
}

export interface MergeQueueOptions {
  /** Lost CAS races before giving up on an item. */
  maxStaleRetries: number;
  /** Unexpected errors before giving up on an item. */
  maxErrors: number;
  /** How often to poll the cheap CI re-run. */
  pollMs: number;
  /** Give up on the cheap re-run after this long. */
  checkTimeoutMs: number;
  /** Delay before a merged change's fork is deleted. */
  forkGcDelayMs: number;
}

export const DEFAULT_QUEUE_OPTIONS: MergeQueueOptions = {
  maxStaleRetries: 5,
  maxErrors: 5,
  pollMs: 15_000,
  checkTimeoutMs: 45 * 60_000,
  forkGcDelayMs: 24 * 60 * 60_000,
};

/** Container-minute budget for the re-check after a rebase. */
export const CHEAP_CHECK_MINUTES = 30;

/** null = idle (no alarm needed); otherwise run `tick` again after this many ms. */
export type TickResult = { next: number | null; did: string };

const ACCEPTING: ReadonlySet<Change["status"]> = new Set(["queued", "approved"]);

class ItemFailure extends Error {
  constructor(
    readonly reason: MergeConflictEvent["reason"],
    message: string,
    readonly files: string[] = [],
  ) {
    super(message);
  }
}

export class MergeQueueCore implements MergeQueueClient {
  private readonly options: MergeQueueOptions;

  private readonly deps: {
    ports: Ports;
    bindings: CoordinatorBindings;
    storage: QueueStorage;
    options?: Partial<MergeQueueOptions>;
  };

  constructor(deps: {
    ports: Ports;
    bindings: CoordinatorBindings;
    storage: QueueStorage;
    options?: Partial<MergeQueueOptions>;
  }) {
    this.options = { ...DEFAULT_QUEUE_OPTIONS, ...deps.options };
    // "merged" and "failing" wake `wait_for_change` long-polls on the change's DO.
    this.deps = { ...deps, ports: withChangeNotifications(deps.ports, deps.bindings) };
  }

  // ------------------------------------------------------------ client API

  async enqueue(input: EnqueueInput): Promise<{ position: number }> {
    const { storage } = this.deps;
    const existing = await storage.get(input.changeId);
    if (existing === null || existing.headSha !== input.headSha) {
      // A new head for a queued change restarts its item at the back of the queue.
      await storage.put({
        changeId: input.changeId,
        repoId: input.repoId,
        seq: await storage.nextSeq(),
        enqueuedAt: this.deps.ports.clock.now().toISOString(),
        headSha: input.headSha,
        candidateSha: input.headSha,
        rebasedOnto: null,
        phase: "ready",
        checkRunId: null,
        checkStartedAt: null,
        bundleRef: null,
        staleRetries: 0,
        errors: 0,
        workflowInstanceId: input.workflowInstanceId,
        lastError: null,
      });
      await this.audit(input.changeId, "merge-queue.enqueued", { headSha: input.headSha });
    }
    const items = await storage.list();
    return { position: items.findIndex((i) => i.changeId === input.changeId) };
  }

  async remove(input: { repoId: string; changeId: string }): Promise<boolean> {
    const item = await this.deps.storage.get(input.changeId);
    if (item === null) return false;
    if (item.checkRunId !== null) await this.quietly(() => this.deps.ports.ci.cancel(item.checkRunId ?? "", "removed from queue"));
    await this.deps.storage.delete(input.changeId);
    await this.audit(input.changeId, "merge-queue.removed", { phase: item.phase });
    return true;
  }

  async list(_repoId: string): Promise<MergeQueueEntry[]> {
    return (await this.deps.storage.list()).map((i) => ({
      changeId: i.changeId,
      headSha: i.headSha,
      phase: i.phase,
      attempts: i.staleRetries + i.errors,
      enqueuedAt: i.enqueuedAt,
      lastError: i.lastError,
    }));
  }

  // ------------------------------------------------------------ the loop

  /** Advance the head of the queue by one phase (or more, while nothing needs waiting). */
  async tick(): Promise<TickResult> {
    const items = await this.deps.storage.list();
    const item = items[0];
    if (item === undefined) return { next: null, did: "idle" };
    try {
      return await this.advance(item);
    } catch (e) {
      if (e instanceof ItemFailure) {
        await this.fail(item, e.reason, e.message, e.files);
        return { next: 0, did: `failed:${e.reason}` };
      }
      const errors = item.errors + 1;
      const lastError = errorMessage(e);
      if (errors > this.options.maxErrors) {
        await this.fail(item, "error", `gave up after ${errors} errors: ${lastError}`);
        return { next: 0, did: "failed:error" };
      }
      await this.save({ ...item, errors, lastError });
      return { next: Math.min(30_000 * errors, 5 * 60_000), did: "error" };
    }
  }

  /** Write a phase transition unless the item was removed meanwhile (remove() runs concurrently). */
  private async save(item: QueueItem): Promise<boolean> {
    if ((await this.deps.storage.get(item.changeId)) === null) return false;
    await this.deps.storage.put(item);
    return true;
  }

  private async advance(item: QueueItem): Promise<TickResult> {
    const { store } = this.deps.ports;
    const change = await store.getChange(item.changeId);
    if (change === null || !ACCEPTING.has(change.status) || change.headSha !== item.headSha) {
      await this.deps.storage.delete(item.changeId);
      await this.audit(item.changeId, "merge-queue.dropped", {
        reason: change === null ? "change missing" : `change is ${change.status} at ${change.headSha ?? "no head"}`,
      });
      return { next: 0, did: "dropped" };
    }
    const repo = await store.getRepo(change.repoId);
    if (repo === null) throw new ItemFailure("error", `repo ${change.repoId} not found`);

    switch (item.phase) {
      case "ready":
        return this.prepare(item, change, repo);
      case "checking":
        return this.check(item, change, repo);
      case "merging":
        return this.merge(item, change, repo);
      case "finalizing":
        return this.finalize(item, change, repo);
    }
  }

  /** Decide whether the candidate can fast-forward main, rebasing in the sandbox if main moved. */
  private async prepare(item: QueueItem, change: Change, repo: Repo): Promise<TickResult> {
    const { git, sandbox, ci, clock } = this.deps.ports;
    const main = await git.branchHead(repo.artifactsName, repo.defaultBranch);
    if (main === null) throw new ItemFailure("error", `${repo.defaultBranch} does not exist`);
    if (main === item.candidateSha && item.candidateSha !== change.baseSha) {
      // A previous tick fast-forwarded main but stopped before recording it.
      const next = { ...item, phase: "finalizing" as const };
      await this.save(next);
      return this.finalize(next, change, repo);
    }
    if (item.rebasedOnto === main || (item.rebasedOnto === null && main === change.baseSha)) {
      const next = { ...item, phase: "merging" as const };
      await this.save(next);
      return this.merge(next, change, repo);
    }
    // Main moved: rebase the approved head (never an earlier rebase) onto the new main.
    const result = await sandbox.rebase({
      fork: change.forkName,
      mainRepo: repo.artifactsName,
      headSha: item.headSha,
      ontoSha: main,
      branch: REBASE_BRANCH,
    });
    if (result.status === "conflict") {
      throw new ItemFailure("conflict", `rebase onto ${main.slice(0, 12)} conflicts`, result.files);
    }
    const runId = cheapRunIdFor(change.id, result.newSha);
    // Cheap re-check: the user pipeline from base (install served from cache), no evidence steps.
    await ci.start({
      runId,
      changeId: change.id,
      repo: { remote: this.deps.ports.git.remoteOf(change.forkName), tokenProvider: "artifacts" },
      artifactsRepo: change.forkName,
      baseSha: main,
      headSha: result.newSha,
      pipelineFrom: "base",
      evidenceSteps: [],
      budget: { maxMinutes: CHEAP_CHECK_MINUTES },
    });
    await this.save({
      ...item,
      candidateSha: result.newSha,
      rebasedOnto: main,
      phase: "checking",
      checkRunId: runId,
      checkStartedAt: clock.now().toISOString(),
      bundleRef: null,
      lastError: null,
    });
    await this.audit(change.id, "merge-queue.rebased", {
      from: item.headSha,
      onto: main,
      newSha: result.newSha,
      checkRunId: runId,
    });
    return { next: this.options.pollMs, did: "rebased" };
  }

  /** Poll the cheap re-run; on green, re-sign the evidence for the rebased sha. */
  private async check(item: QueueItem, change: Change, repo: Repo): Promise<TickResult> {
    const { ci, clock, store, signer, audit } = this.deps.ports;
    const runId = item.checkRunId;
    if (runId === null) {
      await this.save({ ...item, phase: "ready" });
      return { next: 0, did: "reset" };
    }
    let report: CiRunStatus | null = null;
    try {
      report = await ci.status(runId);
    } catch {
      report = null; // not visible yet
    }
    if (report === null || report.status === "queued" || report.status === "running") {
      const started = item.checkStartedAt === null ? 0 : Date.parse(item.checkStartedAt);
      if (clock.now().getTime() - started > this.options.checkTimeoutMs) {
        await this.quietly(() => ci.cancel(runId, "merge queue check timed out"));
        throw new ItemFailure("checks-failed", "checks after rebase timed out");
      }
      return { next: this.options.pollMs, did: "waiting-checks" };
    }
    if (report.status !== "passed") {
      throw new ItemFailure("checks-failed", `checks after rebase ${report.status}`);
    }
    // Re-sign the approved head's evidence for the rebased sha.
    const original = await store.getEvidence(change.id, item.headSha);
    const sealed = await sealEvidence(this.deps.ports, {
      changeId: change.id,
      headSha: item.candidateSha,
      baseSha: item.rebasedOnto ?? change.baseSha,
      items: [...(original?.items ?? [])],
    });
    // The evidence payload's field set is fixed, so the rebase link is a separately signed record.
    const link = { changeId: change.id, headSha: item.candidateSha, rebasedFrom: item.headSha, onto: item.rebasedOnto, evidenceId: sealed.evidenceId };
    const signature = await signer.signDocument({ purpose: "evidence-rebase", ...link });
    await audit.append({
      principalId: SYSTEM_PRINCIPAL_ID,
      action: "merge-queue.evidence-resigned",
      subject: changeSubject(change.id),
      payload: { ...link, verified: sealed.verified, signature, keyId: signer.keyId },
    });
    // The engine does not report build outputs on status yet, so a rebased merge has no bundle.
    const next: QueueItem = { ...item, phase: "merging", bundleRef: null, lastError: null };
    await this.save(next);
    return this.merge(next, change, repo);
  }

  /** Transfer the candidate's objects into main and CAS the default branch. */
  private async merge(item: QueueItem, change: Change, repo: Repo): Promise<TickResult> {
    const { git } = this.deps.ports;
    const staging = stagingRefFor(change.id);
    await git.transferObjects(change.forkName, repo.artifactsName, item.candidateSha, staging);
    const expectedOld = item.rebasedOnto ?? change.baseSha;
    const result = await git.updateRef(repo.artifactsName, `refs/heads/${repo.defaultBranch}`, expectedOld, item.candidateSha);
    if (result.ok) {
      const next = { ...item, phase: "finalizing" as const };
      await this.save(next);
      return this.finalize(next, change, repo);
    }
    if (result.reason === "stale") {
      // Someone else's merge won the race (or main moved): retry from the top, bounded.
      const staleRetries = item.staleRetries + 1;
      if (staleRetries > this.options.maxStaleRetries) {
        throw new ItemFailure("stale-exhausted", `main kept moving (${staleRetries} stale updates)`);
      }
      await this.save({ ...item, phase: "ready", staleRetries, lastError: result.detail });
      await this.audit(change.id, "merge-queue.stale", { expectedOld, detail: result.detail, staleRetries });
      return { next: 0, did: "stale" };
    }
    if (result.reason === "missing-object") throw new Error(`objects missing after transfer: ${result.detail}`);
    throw new ItemFailure("rejected", `fast-forward rejected: ${result.detail}`);
  }

  /** Main now points at the candidate. Everything here is best effort except the bookkeeping. */
  private async finalize(item: QueueItem, change: Change, repo: Repo): Promise<TickResult> {
    const { git, store, audit, clock } = this.deps.ports;
    const sha = item.candidateSha;
    const evidence = await store.getEvidence(change.id, sha);
    let noteCopied = false;
    if (evidence !== null) {
      noteCopied = await this.quietly(() =>
        git.writeNote(repo.artifactsName, sha, encodeNote(evidence), { notesRef: EVIDENCE_NOTES_REF, mode: "replace" }),
      );
    }
    const stagingDeleted = await this.quietly(async () => {
      const r = await git.updateRef(repo.artifactsName, stagingRefFor(change.id), sha, ZERO_SHA);
      if (!r.ok) throw new Error(r.detail);
    });
    await store.updateChange(change.id, { status: "merged", mergedSha: sha });
    await this.quietly(() =>
      this.deps.bindings
        .changeCoordinator(change.id)
        .scheduleForkGc({ changeId: change.id, forkName: change.forkName, delayMs: this.options.forkGcDelayMs }),
    );
    const rebasedFrom = item.rebasedOnto === null ? null : item.headSha;
    await audit.append({
      principalId: SYSTEM_PRINCIPAL_ID,
      action: "change.merged",
      subject: changeSubject(change.id),
      payload: {
        mergedSha: sha,
        rebasedFrom,
        onto: item.rebasedOnto ?? change.baseSha,
        noteCopied,
        stagingDeleted,
        at: clock.now().toISOString(),
      },
    });
    const event: MergedEvent = { mergedSha: sha, rebasedFrom, bundleRef: item.bundleRef };
    await this.deliver(item, EVENT_MERGED, event);
    await this.deps.storage.delete(change.id);
    return { next: 0, did: "merged" };
  }

  private async fail(item: QueueItem, reason: MergeConflictEvent["reason"], detail: string, files: string[] = []): Promise<void> {
    const { store, notifier, ci, git } = this.deps.ports;
    if (item.checkRunId !== null) await this.quietly(() => ci.cancel(item.checkRunId ?? "", "merge failed"));
    const change = await store.getChange(item.changeId);
    if (change !== null) {
      const repo = await store.getRepo(change.repoId);
      if (repo !== null && item.phase !== "ready") {
        await this.quietly(async () => {
          const staged = stagingRefFor(change.id);
          await git.updateRef(repo.artifactsName, staged, item.candidateSha, ZERO_SHA);
        });
      }
      if (ACCEPTING.has(change.status)) await store.updateChange(change.id, { status: "failing" });
      await notifier.notify({
        kind: "failing",
        changeId: change.id,
        repoId: change.repoId,
        message: `${change.title} could not merge (${reason}): ${detail}${files.length ? ` [${files.join(", ")}]` : ""}`,
      });
    }
    await this.audit(item.changeId, "merge-queue.failed", { reason, detail, files, phase: item.phase });
    const event: MergeConflictEvent = { reason, detail, files };
    await this.deliver(item, EVENT_MERGE_CONFLICT, event);
    await this.deps.storage.delete(item.changeId);
  }

  private async deliver(item: QueueItem, type: string, payload: unknown): Promise<void> {
    const delivered = await this.quietly(async () => {
      const instance = await this.deps.bindings.changeWorkflow.get(item.workflowInstanceId);
      await instance.sendEvent({ type, payload });
    });
    if (!delivered) {
      // The workflow also polls the change row, so it will still see the outcome.
      await this.audit(item.changeId, "merge-queue.event-undelivered", { type, instanceId: item.workflowInstanceId });
    }
  }

  private async audit(changeId: string, action: string, payload: unknown): Promise<void> {
    await this.deps.ports.audit.append({ principalId: SYSTEM_PRINCIPAL_ID, action, subject: changeSubject(changeId), payload });
  }

  private async quietly(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  }
}

/** In-memory QueueStorage (tests and node-side fake bindings). */
export class MemoryQueueStorage implements QueueStorage {
  private readonly items = new Map<string, QueueItem>();
  private seq = 0;
  async list(): Promise<QueueItem[]> {
    return [...this.items.values()].sort((a, b) => a.seq - b.seq).map((i) => ({ ...i }));
  }
  async get(changeId: string): Promise<QueueItem | null> {
    const i = this.items.get(changeId);
    return i === undefined ? null : { ...i };
  }
  async put(item: QueueItem): Promise<void> {
    this.items.set(item.changeId, { ...item });
  }
  async delete(changeId: string): Promise<void> {
    this.items.delete(changeId);
  }
  async nextSeq(): Promise<number> {
    return ++this.seq;
  }
}

/** Structural slice of the Durable Object `SqlStorage` API. */
export interface SqlLike {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] };
}

/** QueueStorage on Durable Object SQLite: one row per item, JSON payload, FIFO by `seq`. */
export class SqlQueueStorage implements QueueStorage {
  constructor(private readonly sql: SqlLike) {
    sql.exec("CREATE TABLE IF NOT EXISTS merge_queue (change_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, data TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS merge_queue_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
  }

  private rows(query: string, ...bindings: (string | number | null)[]): QueueItem[] {
    return this.sql
      .exec(query, ...bindings)
      .toArray()
      .map((r) => JSON.parse(String(r.data)) as QueueItem);
  }

  async list(): Promise<QueueItem[]> {
    return this.rows("SELECT data FROM merge_queue ORDER BY seq ASC");
  }

  async get(changeId: string): Promise<QueueItem | null> {
    return this.rows("SELECT data FROM merge_queue WHERE change_id = ?", changeId)[0] ?? null;
  }

  async put(item: QueueItem): Promise<void> {
    this.sql.exec(
      "INSERT INTO merge_queue (change_id, seq, data) VALUES (?, ?, ?) ON CONFLICT(change_id) DO UPDATE SET seq = excluded.seq, data = excluded.data",
      item.changeId,
      item.seq,
      JSON.stringify(item),
    );
  }

  async delete(changeId: string): Promise<void> {
    this.sql.exec("DELETE FROM merge_queue WHERE change_id = ?", changeId);
  }

  async nextSeq(): Promise<number> {
    const row = this.sql
      .exec(
        "INSERT INTO merge_queue_meta (k, v) VALUES ('seq', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1 RETURNING v",
      )
      .toArray()[0];
    return Number(row?.v ?? 1);
  }
}
