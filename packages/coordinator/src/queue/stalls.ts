/**
 * Stalls: what the queue view shows when something is not moving. Built from the outbox (commands
 * the shell keeps retrying, with their last error), a short log of problems (commands given up,
 * builds that errored, batches past their timeout) and the core state. Every stall says why (the
 * error's class and redacted message) and what happens next: an automatic retry at a time, a
 * rebuild at a time, or a person who has to act.
 */
import type { QueueState } from "@app/merge-queue";
import { type CommandFailure, parseFailureText } from "./failure.js";
import type { OutboxRow } from "./store.js";

/** One thing that went wrong, kept in `mq_meta` (newest last, at most PROBLEMS_KEPT). */
export interface QueueProblem {
  at: number;
  kind: "dropped" | "build-errored" | "timed-out";
  command: string | null;
  batchId: string | null;
  changeIds: string[];
  attempts: number | null;
  errorClass: string | null;
  message: string;
}

export type StallNext =
  | { kind: "retry"; at: number }
  | { kind: "rebuild"; at: number | null }
  | { kind: "human"; message: string };

export interface QueueStall {
  /** retrying: a step keeps failing and is retried; stalled: nothing moves until `next`. */
  state: "retrying" | "stalled" | "needs-human";
  /** What is stuck, in words ("Building the batch tree"). */
  what: string;
  command: string;
  batchId: string | null;
  changeIds: string[];
  /** Failed attempts so far (of `maxAttempts` before the shell gives the step up). */
  attempts: number;
  maxAttempts: number;
  error: CommandFailure | null;
  /** When it started (the batch's start, or the first recorded problem); null when unknown. */
  since: number | null;
  next: StallNext;
}

export const PROBLEMS_KEPT = 30;
/** Problems older than this no longer explain anything on screen. */
const PROBLEM_TTL_MS = 2 * 3_600_000;

const WHAT: Record<string, string> = {
  BuildBatchTree: "Building the batch tree",
  StartBatchRun: "Starting the batch's CI run",
  RunFlakeRecheck: "Re-checking failed tests",
  RequestResolution: "Resolving a conflict",
  ComputeAffectedSet: "Computing the affected set",
  Cas: "Landing on main",
  RequestApproval: "Asking a person for approval",
  StartDeployTrain: "Deploying a train",
  KillFlag: "Turning a flag off",
  RollbackTrain: "Rolling a train back",
  RequestRevert: "Opening a revert",
};

/** Commands whose failure holds something up (the rest are bookkeeping: audit, events, GC). */
export function blocking(type: string): boolean {
  return type in WHAT;
}

export function whatOf(type: string): string {
  return WHAT[type] ?? type;
}

/** The batch and Changes a command is about (best effort; unknown fields are ignored). */
export function idsOf(command: unknown): { batchId: string | null; changeIds: string[] } {
  const c = (command ?? {}) as Record<string, unknown>;
  const batchId = typeof c.batchId === "string" ? c.batchId : null;
  const ids = new Set<string>();
  if (typeof c.changeId === "string") ids.add(c.changeId);
  if (Array.isArray(c.entries))
    for (const e of c.entries) {
      if (typeof e === "string") ids.add(e);
      else if (
        e !== null &&
        typeof e === "object" &&
        typeof (e as { changeId?: unknown }).changeId === "string"
      )
        ids.add((e as { changeId: string }).changeId);
    }
  return { batchId, changeIds: [...ids] };
}

export function typeOf(command: unknown): string {
  const t = (command as { type?: unknown } | null)?.type;
  return typeof t === "string" ? t : "unknown";
}

/** What happens after the shell gives a command up (said in the audit and on screen). */
export function afterDrop(type: string): string {
  switch (type) {
    case "BuildBatchTree":
      return "the batch is rebuilt at once; after repeated failures its Changes are ejected (infra-error)";
    case "StartBatchRun":
    case "RunFlakeRecheck":
      return "the run counts as errored and the batch is retried";
    case "ComputeAffectedSet":
      return "the affected set counts as unknown (conflicts with everything, never parallel)";
    case "RequestResolution":
      return "the resolution counts as failed";
    case "Cas":
      return "the landing is rejected and tried again from main's real position";
    case "RequestApproval":
      return "needs a human: nobody was told this Change needs approval; open it and approve the resolution";
    case "StartDeployTrain":
      return "the train counts as failed to deploy";
    case "RequestRevert":
      return "needs a human: the Change is rolled back but not reverted; revert it by hand";
    default:
      return "dropped; nothing waits on it";
  }
}

function entriesOf(b: QueueState["batches"][string]): string[] {
  return [...b.carried, ...b.units.flatMap((u) => u.changeIds)];
}

function errorOf(p: QueueProblem | undefined): CommandFailure | null {
  if (p === undefined) return null;
  return p.errorClass === null
    ? parseFailureText(p.message)
    : { errorClass: p.errorClass, message: p.message };
}

/** Everything that is not moving right now, for the queue view (pure). */
export function stallsOf(input: {
  state: QueueState;
  outbox: OutboxRow[];
  problems: QueueProblem[];
  maxAttempts: number;
  now: number;
}): QueueStall[] {
  const { state: s, now } = input;
  const out: QueueStall[] = [];
  const covered = new Set<string>();
  const recent = input.problems.filter((p) => now - p.at <= PROBLEM_TTL_MS);
  const lastFor = (batchId: string) => recent.filter((p) => p.batchId === batchId).at(-1);

  // 1. A step that keeps failing: the shell retries it with backoff.
  for (const row of input.outbox) {
    const type = typeOf(row.command);
    if (row.attempts === 0 || !blocking(type)) continue;
    const { batchId, changeIds } = idsOf(row.command);
    const b = batchId === null ? undefined : s.batches[batchId];
    if (batchId !== null && b === undefined) continue;
    out.push({
      state: "retrying",
      what: whatOf(type),
      command: type,
      batchId,
      changeIds: changeIds.length > 0 || b === undefined ? changeIds : entriesOf(b),
      attempts: row.attempts,
      maxAttempts: input.maxAttempts,
      error: row.lastError === null ? null : parseFailureText(row.lastError),
      since: b?.startedAt ?? null,
      next: { kind: "retry", at: row.nextAt },
    });
    if (batchId !== null) covered.add(batchId);
  }

  const buildCommands = new Set(
    input.outbox
      .filter((r) => typeOf(r.command) === "BuildBatchTree")
      .map((r) => idsOf(r.command).batchId),
  );
  for (const b of Object.values(s.batches)) {
    if (covered.has(b.id)) continue;
    const last = lastFor(b.id);
    // 2. Building, but no build command left (given up or lost): nothing moves until the
    //    core's build timeout rebuilds it.
    if (b.state === "building" && b.startedAt !== null && !buildCommands.has(b.id)) {
      out.push({
        state: "stalled",
        what: "Building the batch tree",
        command: "BuildBatchTree",
        batchId: b.id,
        changeIds: entriesOf(b),
        attempts: last?.attempts ?? 0,
        maxAttempts: input.maxAttempts,
        error: errorOf(last),
        since: b.startedAt,
        next: { kind: "rebuild", at: b.startedAt + s.config.buildTimeoutMs },
      });
      continue;
    }
    // 3. Rebuilt after a failure (an errored build, a timeout): say why it runs again.
    if ((b.state === "pending" || b.state === "building") && b.infraRetries > 0 && last) {
      out.push({
        state: "retrying",
        what: "Rebuilding the batch tree after a failure",
        command: "BuildBatchTree",
        batchId: b.id,
        changeIds: entriesOf(b),
        attempts: b.infraRetries,
        maxAttempts: s.config.maxInfraRetries + 1,
        error: errorOf(last),
        since: last.at,
        next: { kind: "rebuild", at: null },
      });
    }
  }

  // 4. A step given up that leaves a person to act (nothing automatic follows).
  for (const p of recent) {
    if (p.kind !== "dropped" || p.command === null) continue;
    const next = afterDrop(p.command);
    if (!next.startsWith("needs a human")) continue;
    const live = p.changeIds.filter((id) => {
      const e = s.entries[id];
      return (
        e !== undefined && e.state !== "merged" && e.state !== "ejected" && e.state !== "dequeued"
      );
    });
    if (p.command === "RequestApproval" && live.length === 0) continue;
    out.push({
      state: "needs-human",
      what: whatOf(p.command),
      command: p.command,
      batchId: p.batchId,
      changeIds: p.changeIds,
      attempts: p.attempts ?? 0,
      maxAttempts: input.maxAttempts,
      error: errorOf(p),
      since: p.at,
      next: { kind: "human", message: next.replace(/^needs a human: /, "") },
    });
  }
  return out;
}

/** The stall holding up a Change (its own step, or its batch's), if any. */
export function stallFor(
  stalls: QueueStall[],
  changeId: string,
  batchId: string | null,
): QueueStall | null {
  return (
    stalls.find(
      (x) => x.changeIds.includes(changeId) || (batchId !== null && x.batchId === batchId),
    ) ?? null
  );
}
