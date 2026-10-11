/**
 * The queue's problem log (what the queue view's stalls explain themselves with) and the
 * notifications a stall sends. Nothing here changes queue state: it records and tells people.
 */
import type { CommandOf } from "@app/merge-queue";
import type { QueueContext } from "./context.js";
import type { CommandFailure } from "./failure.js";
import { afterDrop, idsOf, PROBLEMS_KEPT, type QueueProblem, typeOf, whatOf } from "./stalls.js";
import type { OutboxRow, QueueStore } from "./store.js";

const PROBLEMS_KEY = "problems";

export function recordProblem(store: QueueStore, p: QueueProblem): void {
  store.pushMeta(PROBLEMS_KEY, p, PROBLEMS_KEPT);
}

export function recentProblems(store: QueueStore): QueueProblem[] {
  return store.getMeta<QueueProblem[]>(PROBLEMS_KEY) ?? [];
}

function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min >= 1 ? `${min} min` : `${Math.round(ms / 1000)} s`;
}

/**
 * The shell gave a command up: record why, audit it (class, redacted message, what it was about,
 * what happens next) and, when nothing automatic follows, tell a person.
 */
export async function commandDropped(
  ctx: QueueContext,
  row: OutboxRow,
  failure: CommandFailure,
): Promise<void> {
  const type = typeOf(row.command);
  const { batchId, changeIds } = idsOf(row.command);
  const next = afterDrop(type);
  recordProblem(ctx.deps.store, {
    at: ctx.now(),
    kind: "dropped",
    command: type,
    batchId,
    changeIds,
    attempts: row.attempts + 1,
    errorClass: failure.errorClass,
    message: failure.message,
  });
  await ctx.audit(ctx.repoSubject(), "merge-queue.command-dropped", {
    lane: row.lane,
    type,
    attempts: row.attempts + 1,
    errorClass: failure.errorClass,
    error: failure.message,
    batchId,
    changeIds,
    next,
  });
  if (next.startsWith("needs a human") && changeIds[0] !== undefined)
    await ctx.ports.notifier.notify({
      kind: "failing",
      changeId: changeIds[0],
      repoId: ctx.repoId,
      message: `The merge queue could not finish "${whatOf(type)}" for ${changeIds.join(", ")} after ${row.attempts + 1} attempts (${failure.errorClass}: ${failure.message}). Next: ${next}.`,
    });
}

/**
 * Core audits that explain a stall: a build that errored (recorded for the view) and a batch past
 * its build/run timeout (recorded, and a person is told: the queue was stuck that long).
 */
export async function onCoreAudit(ctx: QueueContext, cmd: CommandOf<"Audit">): Promise<void> {
  const batchId = cmd.subject.startsWith("batch:") ? cmd.subject.slice("batch:".length) : null;
  const p = cmd.payload;
  if (cmd.action === "merge-queue.build-errored") {
    const message = typeof p.message === "string" ? p.message : "unknown error";
    const m = /^([A-Za-z_$][\w$.]{0,99}): ([\s\S]*)$/.exec(message);
    recordProblem(ctx.deps.store, {
      at: ctx.now(),
      kind: "build-errored",
      command: "BuildBatchTree",
      batchId,
      changeIds: batchId === null ? [] : (idsOfBatch(ctx, batchId) ?? []),
      attempts: null,
      errorClass: m?.[1] ?? null,
      message: m?.[2] ?? message,
    });
    return;
  }
  if (cmd.action !== "merge-queue.batch-timed-out") return;
  const changeIds = Array.isArray(p.changeIds)
    ? p.changeIds.filter((x): x is string => typeof x === "string")
    : [];
  const limitMs = typeof p.limitMs === "number" ? p.limitMs : 0;
  const state = typeof p.state === "string" ? p.state : "running";
  const before = recentProblems(ctx.deps.store)
    .filter((x) => x.batchId === batchId)
    .at(-1);
  const why =
    before === undefined
      ? "no error was recorded (the step was lost)"
      : `last error: ${before.errorClass ?? "Error"}: ${before.message}`;
  recordProblem(ctx.deps.store, {
    at: ctx.now(),
    kind: "timed-out",
    command: state === "building" ? "BuildBatchTree" : "StartBatchRun",
    batchId,
    changeIds,
    attempts: before?.attempts ?? null,
    errorClass: before?.errorClass ?? null,
    message: `${state === "building" ? "building the tree" : "the CI run"} took longer than ${duration(limitMs)}; ${why}`,
  });
  if (changeIds[0] === undefined) return;
  await ctx.ports.notifier.notify({
    kind: "failing",
    changeId: changeIds[0],
    repoId: ctx.repoId,
    message: `The merge queue was stuck: batch ${batchId ?? "?"} (${changeIds.join(", ")}) spent over ${duration(limitMs)} ${state === "building" ? "building its tree" : "in CI"} (${why}). It is rebuilt now; if it keeps failing, its Changes are ejected with infra-error.`,
  });
}

function idsOfBatch(ctx: QueueContext, batchId: string): string[] | null {
  const b = ctx.deps.state().batches[batchId];
  return b === undefined ? null : [...b.carried, ...b.units.flatMap((u) => u.changeIds)];
}
