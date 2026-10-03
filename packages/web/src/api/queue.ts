/**
 * Merge queue overview: `GET /api/v1/repos/:repoId/queue` (docs/prompts/03-merge-queue.md §5).
 * Types mirror the platform's `QueueOverviewView`; the response is validated with zod at this
 * boundary so a malformed queue fails loudly instead of rendering half a state.
 */
import { z } from "zod";
import { ApiError, request } from "./client.js";
import { isMockMode } from "./mode.js";

export type Lane = 0 | 1 | 2;
export type EntryState =
  | "waiting"
  | "speculating"
  | "resolving"
  | "passed"
  | "merged"
  | "ejected"
  | "dequeued";
export type BatchState =
  | "pending"
  | "building"
  | "ready"
  | "running"
  | "rechecking"
  | "passed"
  | "landing"
  | "landed"
  | "failed"
  | "bisecting"
  | "cancelled";
export type Priority = "revert" | "incident" | "security" | "normal";
export type Hold = "affected" | "dependency" | "group" | "approval";
export type EjectCode =
  | "tests-failed"
  | "semantic-conflict"
  | "textual-conflict"
  | "resolution-budget-exhausted"
  | "dependency-ejected"
  | "group-member-failed"
  | "infra-error"
  | "superseded";

export interface EjectReason {
  code: EjectCode;
  message: string;
  fix: { explanation: string; call?: string; command?: string };
  evidenceRefs: string[];
  failingTests: string[];
  upstream: string[];
}

export type StallState = "retrying" | "stalled" | "needs-human";

/** Something is not moving: why (class + redacted message) and what happens next. */
export interface QueueStall {
  state: StallState;
  what: string;
  command: string;
  batchId: string | null;
  changeIds: string[];
  attempts: number;
  maxAttempts: number;
  error: { errorClass: string; message: string } | null;
  /** epoch ms */
  since: number | null;
  next: { kind: "retry"; at: number } | { kind: "rebuild"; at: number | null } | { kind: "human"; message: string };
}

export interface QueueEntryView {
  changeId: string;
  title: string | null;
  authorId: string;
  priority: Priority;
  lane: Lane;
  state: EntryState;
  hold: Hold | null;
  trackId: string | null;
  batch: { id: string; state: BatchState; size: number; chainPosition: number } | null;
  position: number | null;
  etaSeconds: number | null;
  blocking: string[];
  reason: string;
  predictedPassProbability: number | null;
  frozen: boolean;
  /** epoch ms */
  enqueuedAt: number;
  dependsOn: string[];
  plangroup: string | null;
  ejectReason: EjectReason | null;
  mergedSha: string | null;
  /** Set while a step holding this change keeps failing or stopped (then there is no ETA). */
  stall: StallState | null;
}

export type FreezeKind = "post-merge-check" | "revert-in-progress" | "manual";

export interface FreezeReason {
  kind: FreezeKind;
  at: number;
  sha: string | null;
  changeId: string | null;
  signer: { principalId: string; signature: string } | null;
  message: string;
}

export type TrainState =
  | "deploying"
  | "watching"
  | "killing"
  | "rolling-back"
  | "released"
  | "rolled-back"
  | "failed";

export interface TrainView {
  id: string;
  worker: string;
  state: TrainState;
  changeIds: string[];
  versionId: string | null;
  watchUntil: number | null;
  killed: string[];
}

export type BatchKind = "chain" | "probe" | "landing";

export interface TrackBatch {
  id: string;
  state: BatchState;
  kind: BatchKind;
  entries: string[];
}

export interface QueueTrack {
  id: string;
  express: boolean;
  batches: TrackBatch[];
}

export interface LandingBatch {
  id: string;
  state: BatchState;
  members: string[];
  targets: "all" | string[];
}

export interface QueueOverviewView {
  repoId: string;
  mainSha: string;
  frozen: boolean;
  freezeReasons: FreezeReason[];
  halted: { code: string; message: string; at: number } | null;
  tracks: QueueTrack[];
  landing: LandingBatch[];
  /** Active entries first, then recent terminal ones. */
  entries: QueueEntryView[];
  waiting: number;
  resolving: number;
  throughputPerHour: number;
  timeInQueueMs: { p50: number | null; p95: number | null };
  ciDurationMs: number;
  quarantined: string[];
  flakeRates: Record<string, number>;
  trains: TrainView[];
  stalls: QueueStall[];
  updatedAt: number;
}

// ---------------------------------------------------------------- runtime validation

const ids = z.array(z.string());
const lane = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const batchState = z.enum([
  "pending",
  "building",
  "ready",
  "running",
  "rechecking",
  "passed",
  "landing",
  "landed",
  "failed",
  "bisecting",
  "cancelled",
]);

const ejectReason = z.object({
  code: z.enum([
    "tests-failed",
    "semantic-conflict",
    "textual-conflict",
    "resolution-budget-exhausted",
    "dependency-ejected",
    "group-member-failed",
    "infra-error",
    "superseded",
  ]),
  message: z.string(),
  fix: z.object({
    explanation: z.string(),
    call: z.string().optional(),
    command: z.string().optional(),
  }),
  evidenceRefs: ids,
  failingTests: ids,
  upstream: ids,
});

const entry = z.object({
  changeId: z.string(),
  title: z.string().nullable(),
  authorId: z.string(),
  priority: z.enum(["revert", "incident", "security", "normal"]),
  lane,
  state: z.enum(["waiting", "speculating", "resolving", "passed", "merged", "ejected", "dequeued"]),
  hold: z.enum(["affected", "dependency", "group", "approval"]).nullable(),
  trackId: z.string().nullable(),
  batch: z
    .object({ id: z.string(), state: batchState, size: z.number(), chainPosition: z.number() })
    .nullable(),
  position: z.number().nullable(),
  etaSeconds: z.number().nullable(),
  blocking: ids,
  reason: z.string(),
  predictedPassProbability: z.number().nullable(),
  frozen: z.boolean(),
  enqueuedAt: z.number(),
  dependsOn: ids,
  plangroup: z.string().nullable(),
  ejectReason: ejectReason.nullable(),
  mergedSha: z.string().nullable(),
  // Older servers do not send it: nothing is known to be stalled.
  stall: z.enum(["retrying", "stalled", "needs-human"]).nullable().default(null),
});

const stall = z.object({
  state: z.enum(["retrying", "stalled", "needs-human"]),
  what: z.string(),
  command: z.string(),
  batchId: z.string().nullable(),
  changeIds: ids,
  attempts: z.number(),
  maxAttempts: z.number(),
  error: z.object({ errorClass: z.string(), message: z.string() }).nullable(),
  since: z.number().nullable(),
  next: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("retry"), at: z.number() }),
    z.object({ kind: z.literal("rebuild"), at: z.number().nullable() }),
    z.object({ kind: z.literal("human"), message: z.string() }),
  ]),
});

const overview: z.ZodType<QueueOverviewView> = z.object({
  repoId: z.string(),
  mainSha: z.string(),
  frozen: z.boolean(),
  freezeReasons: z.array(
    z.object({
      kind: z.enum(["post-merge-check", "revert-in-progress", "manual"]),
      at: z.number(),
      sha: z.string().nullable(),
      changeId: z.string().nullable(),
      signer: z.object({ principalId: z.string(), signature: z.string() }).nullable(),
      message: z.string(),
    }),
  ),
  halted: z.object({ code: z.string(), message: z.string(), at: z.number() }).nullable(),
  tracks: z.array(
    z.object({
      id: z.string(),
      express: z.boolean(),
      batches: z.array(
        z.object({
          id: z.string(),
          state: batchState,
          kind: z.enum(["chain", "probe", "landing"]),
          entries: ids,
        }),
      ),
    }),
  ),
  landing: z.array(
    z.object({
      id: z.string(),
      state: batchState,
      members: ids,
      targets: z.union([z.literal("all"), ids]),
    }),
  ),
  entries: z.array(entry),
  waiting: z.number(),
  resolving: z.number(),
  throughputPerHour: z.number(),
  timeInQueueMs: z.object({ p50: z.number().nullable(), p95: z.number().nullable() }),
  ciDurationMs: z.number(),
  quarantined: ids,
  flakeRates: z.record(z.string(), z.number()),
  trains: z.array(
    z.object({
      id: z.string(),
      worker: z.string(),
      state: z.enum([
        "deploying",
        "watching",
        "killing",
        "rolling-back",
        "released",
        "rolled-back",
        "failed",
      ]),
      changeIds: ids,
      versionId: z.string().nullable(),
      watchUntil: z.number().nullable(),
      killed: ids,
    }),
  ),
  stalls: z.array(stall).default([]),
  updatedAt: z.number(),
});

/** Validates an overview from the wire; throws `invalid_response` like the review payloads do. */
export function parseQueueOverview(value: unknown): QueueOverviewView {
  const result = overview.safeParse(value);
  if (!result.success) {
    throw new ApiError(
      502,
      "invalid_response",
      "The merge queue from the server did not match the expected shape.",
      result.error.issues,
    );
  }
  return result.data;
}

// ---------------------------------------------------------------- fetch

/** Mock-only switches for screenshots and demos: `?frozen`, `?halted`, `?stalled`. */
function mockVariant(): { frozen: boolean; halted: boolean; stalled: boolean } {
  if (typeof window === "undefined") return { frozen: false, halted: false, stalled: false };
  const q = new URLSearchParams(window.location.search);
  return { frozen: q.has("frozen"), halted: q.has("halted"), stalled: q.has("stalled") };
}

export async function fetchQueueOverview(repoId: string): Promise<QueueOverviewView> {
  if (isMockMode()) {
    const mock = await import("./mock-queue.js");
    return parseQueueOverview(await mock.mockQueueOverview(repoId, mockVariant()));
  }
  const body = await request<unknown>("GET", `/api/v1/repos/${encodeURIComponent(repoId)}/queue`);
  return parseQueueOverview(body);
}

/** How often the view refreshes against the real API. */
export const QUEUE_POLL_MS = 10_000;
