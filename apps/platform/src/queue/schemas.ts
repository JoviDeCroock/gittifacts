/** OpenAPI schemas of the merge-queue API (the coordinator's `QueueEntryView` / overview). */
import { z } from "zod";

export const PriorityBody = z.enum(["normal", "security", "incident"]);

export const EnqueueBody = z
  .object({
    priority: PriorityBody.optional().describe(
      "Default normal; incident needs a human or incidentPlanId",
    ),
    dependsOn: z
      .array(z.string().min(1).max(64))
      .max(50)
      .optional()
      .describe("Changes this one is stacked on"),
    plangroup: z.string().min(1).max(64).nullable().optional(),
    landTogether: z
      .boolean()
      .optional()
      .describe("Plan-group members merge in one CAS or not at all"),
    groupSize: z.number().int().positive().max(100).nullable().optional(),
    landMode: z.enum(["atomic", "incremental"]).optional().describe("How a stack lands"),
    incidentPlanId: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

export const ReprioritizeBody = z
  .object({
    priority: z.enum(["normal", "security", "incident", "revert"]),
    incidentPlanId: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

export const FreezeBody = z.object({ reason: z.string().min(1).max(2000) }).strict();

const Fix = z.object({
  explanation: z.string(),
  call: z.string().optional(),
  command: z.string().optional(),
});

export const EjectReasonSchema = z.object({
  code: z.string(),
  message: z.string(),
  fix: Fix,
  evidenceRefs: z.array(z.string()),
  failingTests: z.array(z.string()),
  upstream: z.array(z.string()),
});

export const QueueEntrySchema = z.object({
  changeId: z.string(),
  title: z.string().nullable(),
  authorId: z.string(),
  priority: z.string(),
  lane: z.number().int(),
  state: z.string(),
  hold: z.string().nullable(),
  trackId: z.string().nullable(),
  batch: z
    .object({ id: z.string(), state: z.string(), size: z.number(), chainPosition: z.number() })
    .nullable(),
  position: z.number().nullable(),
  etaSeconds: z.number().nullable(),
  blocking: z.array(z.string()),
  reason: z.string(),
  predictedPassProbability: z.number().nullable(),
  frozen: z.boolean(),
  enqueuedAt: z.number(),
  dependsOn: z.array(z.string()),
  plangroup: z.string().nullable(),
  ejectReason: EjectReasonSchema.nullable(),
  mergedSha: z.string().nullable(),
});

export const EnqueueResultSchema = z.object({
  changeId: z.string(),
  admitted: z.boolean(),
  state: z.string(),
  position: z.number(),
  track: z.string().nullable(),
  etaSeconds: z.number(),
  predictedPassProbability: z.number(),
  reason: z.string(),
});

export const WaitForMergeSchema = z.object({
  reason: z.enum(["merged", "ejected", "dequeued", "frozen", "timeout", "not-queued"]),
  status: QueueEntrySchema.nullable(),
  frozen: z.boolean(),
});

const FreezeReasonSchema = z.object({
  kind: z.string(),
  at: z.number(),
  sha: z.string().nullable(),
  changeId: z.string().nullable(),
  signer: z.object({ principalId: z.string(), signature: z.string() }).nullable(),
  message: z.string(),
});

export const QueueOverviewSchema = z.object({
  repoId: z.string(),
  mainSha: z.string(),
  frozen: z.boolean(),
  freezeReasons: z.array(FreezeReasonSchema),
  halted: z.object({ code: z.string(), message: z.string(), at: z.number() }).nullable(),
  tracks: z.array(
    z.object({
      id: z.string(),
      express: z.boolean(),
      batches: z.array(
        z.object({
          id: z.string(),
          state: z.string(),
          kind: z.string(),
          entries: z.array(z.string()),
        }),
      ),
    }),
  ),
  landing: z.array(
    z.object({
      id: z.string(),
      state: z.string(),
      members: z.array(z.string()),
      targets: z.union([z.literal("all"), z.array(z.string())]),
    }),
  ),
  entries: z.array(QueueEntrySchema),
  waiting: z.number(),
  resolving: z.number(),
  throughputPerHour: z.number(),
  timeInQueueMs: z.object({ p50: z.number().nullable(), p95: z.number().nullable() }),
  ciDurationMs: z.number(),
  quarantined: z.array(z.string()),
  flakeRates: z.record(z.string(), z.number()),
  trains: z.array(
    z.object({
      id: z.string(),
      worker: z.string(),
      state: z.string(),
      changeIds: z.array(z.string()),
      versionId: z.string().nullable(),
      watchUntil: z.number().nullable(),
      killed: z.array(z.string()),
    }),
  ),
  updatedAt: z.number(),
});
