/**
 * Synthetic merge queue for mock mode. Nothing here is real. `repo_billing` carries a busy queue
 * (express revert track, speculative batches, bisection, a landing lane, an ejected change and two
 * deploy trains); `?frozen` adds a revert-in-progress freeze, `?halted` an invariant stop and
 * `?stalled` a batch whose tree build was given up plus a retrying affected-set analysis.
 * Other known repos have an empty queue; unknown ids answer 404 like the real API.
 */
import { ApiError } from "./client.js";
import { b64u, NOW, sha } from "./fixture-kit.js";
import type { QueueEntryView, QueueOverlap, QueueOverviewView, QueueStall } from "./queue.js";

const MIN = 60_000;
const KNOWN = new Set(["repo_billing", "repo_edge", "repo_dashboard", "repo_ios", "repo_widget"]);

type EntryInput = Partial<QueueEntryView> &
  Pick<QueueEntryView, "changeId" | "title" | "lane" | "state" | "reason">;

function entry(e: EntryInput & { enqueuedMin: number }): QueueEntryView {
  const { enqueuedMin, ...rest } = e;
  return {
    authorId: "prn_coder07",
    priority: "normal",
    hold: null,
    trackId: null,
    batch: null,
    position: null,
    etaSeconds: null,
    blocking: [],
    predictedPassProbability: null,
    frozen: false,
    dependsOn: [],
    plangroup: null,
    ejectReason: null,
    mergedSha: null,
    stall: null,
    overlaps: [],
    ...rest,
    enqueuedAt: NOW - enqueuedMin * MIN,
  };
}

/** The one overlap in the demo: two agents' changes both edit the billing date formatter. */
function sharedFormat(
  changeId: string,
  title: string,
  author: { id: string; name: string },
): QueueOverlap {
  return {
    changeId,
    title,
    author: { ...author, kind: "agent" },
    pathsKnown: true,
    reasons: [
      {
        code: "same-paths",
        message: "Touches the same path: src/billing/format.ts",
        paths: ["src/billing/format.ts"],
        morePaths: 0,
      },
    ],
  };
}

function billingEntries(): QueueEntryView[] {
  return [
    entry({
      changeId: "chg_rv8b1",
      title: "Revert “Batch ledger writes per tenant”",
      authorId: "prn_platform",
      priority: "revert",
      lane: 0,
      state: "speculating",
      trackId: "express",
      batch: { id: "b_51", state: "running", size: 1, chainPosition: 1 },
      position: 1,
      etaSeconds: 260,
      predictedPassProbability: 0.97,
      reason:
        "Express track: reverts go ahead of everything else. CI is running on main plus this revert.",
      enqueuedMin: 4,
    }),
    entry({
      changeId: "chg_tz7k2",
      title: "Fix invoice due dates drifting a day for customers far from UTC",
      lane: 1,
      state: "speculating",
      trackId: "1",
      batch: { id: "b_41", state: "running", size: 2, chainPosition: 1 },
      position: 2,
      etaSeconds: 540,
      predictedPassProbability: 0.91,
      reason: "In batch b_41 with 1 other change. CI is running on main plus both changes.",
      overlaps: [
        sharedFormat("chg_lc3m9", "Fall back to en-US when a customer's receipt locale is missing", {
          id: "prn_coder12",
          name: "fleet-coder-12",
        }),
      ],
      enqueuedMin: 19,
    }),
    entry({
      changeId: "chg_lc3m9",
      title: "Fall back to en-US when a customer's receipt locale is missing",
      authorId: "prn_coder12",
      lane: 1,
      state: "speculating",
      trackId: "1",
      batch: { id: "b_41", state: "running", size: 2, chainPosition: 1 },
      position: 3,
      etaSeconds: 540,
      predictedPassProbability: 0.88,
      reason: "In batch b_41 with 1 other change. CI is running on main plus both changes.",
      overlaps: [
        sharedFormat("chg_tz7k2", "Fix invoice due dates drifting a day for customers far from UTC", {
          id: "prn_coder07",
          name: "fleet-coder-07",
        }),
      ],
      enqueuedMin: 17,
    }),
    entry({
      changeId: "chg_ss4h8",
      title: "Shorten sessions to 12 hours and rotate them on role change",
      priority: "security",
      lane: 2,
      state: "passed",
      trackId: "3",
      batch: { id: "b_44", state: "passed", size: 1, chainPosition: 1 },
      position: 4,
      etaSeconds: 95,
      predictedPassProbability: 0.94,
      reason:
        "Passed in batch b_44. Track 1 landed first, so it is rechecking its 2 impacted test targets on the new main before it lands.",
      enqueuedMin: 31,
    }),
    entry({
      changeId: "chg_cm6t3",
      title: "Rename fetchInvoice to getInvoice across the service",
      lane: 1,
      state: "speculating",
      trackId: "1",
      batch: { id: "b_42", state: "building", size: 1, chainPosition: 2 },
      position: 5,
      etaSeconds: 960,
      predictedPassProbability: 0.86,
      reason:
        "Building on top of batch b_41 before it finishes, so it can land right after b_41 if both pass.",
      enqueuedMin: 12,
    }),
    entry({
      changeId: "chg_pg5q1",
      title: "Add cursor pagination to listInvoices in the SDK",
      lane: 1,
      state: "speculating",
      trackId: "2",
      batch: { id: "b_37", state: "bisecting", size: 2, chainPosition: 1 },
      position: 6,
      etaSeconds: 420,
      predictedPassProbability: 0.83,
      reason:
        "Batch b_37 failed and is being bisected. This change passed on its own in probe b_37a, so it lands as soon as the culprit is found.",
      enqueuedMin: 44,
    }),
    entry({
      changeId: "chg_br8w4",
      title: "Remove the deprecated Invoice.total field from the SDK",
      lane: 2,
      state: "speculating",
      trackId: "2",
      batch: { id: "b_37", state: "bisecting", size: 2, chainPosition: 1 },
      position: 7,
      etaSeconds: 780,
      predictedPassProbability: 0.42,
      reason:
        "Batch b_37 failed and is being bisected. Probe b_37b tests this change alone on main plus chg_pg5q1. Placed last in the batch because it is the likeliest to fail.",
      enqueuedMin: 41,
    }),
  ];
}

function billingWaitingAndDone(): QueueEntryView[] {
  return [
    entry({
      changeId: "chg_wr5p8",
      title: "Upgrade wrangler to 4.42",
      authorId: "prn_coder12",
      lane: 1,
      state: "waiting",
      hold: "affected",
      trackId: "2",
      position: 8,
      etaSeconds: 1680,
      blocking: ["chg_br8w4"],
      predictedPassProbability: 0.79,
      reason:
        "Waiting on conflicting Change chg_br8w4 in track 2: both change the SDK's generated types.",
      enqueuedMin: 26,
    }),
    entry({
      changeId: "chg_nm3k4",
      title: "Per-tenant invoice number sequences",
      lane: 1,
      state: "waiting",
      hold: "dependency",
      trackId: "1",
      position: 9,
      etaSeconds: 1980,
      blocking: ["chg_cm6t3"],
      dependsOn: ["chg_cm6t3"],
      predictedPassProbability: 0.81,
      reason: "Stacked on chg_cm6t3. It joins a batch once chg_cm6t3 lands.",
      enqueuedMin: 9,
    }),
    entry({
      changeId: "chg_pd2n6",
      title: "Render invoice PDFs with pdf-lib and sharp",
      authorId: "prn_coder12",
      lane: 2,
      state: "resolving",
      trackId: "3",
      position: 10,
      etaSeconds: 2400,
      predictedPassProbability: 0.64,
      reason:
        "No longer applies cleanly: chg_fx2r7 changed src/invoices/totals.ts after this change was written. A resolver agent is writing a resolution commit (attempt 1 of 2); the result is re-classified and can only keep or raise the lane.",
      enqueuedMin: 52,
    }),
    entry({
      changeId: "chg_pl9c2",
      title: "Raise billing's mutation threshold to 70% and coverage to 85%",
      authorId: "prn_dev",
      lane: 2,
      state: "waiting",
      hold: "approval",
      reason: "Lane 2: waits for a human approval before it can join a batch.",
      enqueuedMin: 7,
    }),
    entry({
      changeId: "chg_dr1x5",
      title: "Add jittered backoff to webhook retries",
      lane: 2,
      state: "ejected",
      trackId: "3",
      predictedPassProbability: 0.58,
      reason:
        "Ejected after bisection named it as the culprit of batch b_39. The other changes re-formed into new batches.",
      ejectReason: {
        code: "tests-failed",
        message:
          "test/webhooks/retry.test.ts › gives up after 8 attempts failed on main plus this change, and passes on main alone. Re-run twice on both trees: not flaky.",
        fix: {
          explanation:
            "The retry cap moved from 8 to 10 attempts, but the test still expects 8. Open a workspace on this change, fix the cap or the test, push, and enqueue it again.",
          call: 'open_workspace({ changeId: "chg_dr1x5" })',
        },
        evidenceRefs: [`log_${b64u("dr1x5-b39-log", 16)}`],
        failingTests: ["test/webhooks/retry.test.ts › gives up after 8 attempts"],
        upstream: [],
      },
      enqueuedMin: 88,
    }),
    entry({
      changeId: "chg_fx2r7",
      title: "Cache FX rates for 60 seconds when totalling invoices",
      lane: 1,
      state: "merged",
      trackId: "3",
      predictedPassProbability: 0.93,
      mergedSha: sha("fx2r7-merged"),
      reason: "Merged 14 minutes ago in batch b_39 and deploying in train trn_31.",
      enqueuedMin: 96,
    }),
  ];
}

const FREEZE_MESSAGE =
  "Reverting “Batch ledger writes per tenant”: the error rate on billing-ledger breached its budget during train trn_30. Only reverts and incident fixes land until the revert is on main.";

/** `?stalled`: the journey 06 stall (a build given up, nothing moving) and a step being retried. */
function billingStalls(): QueueStall[] {
  return [
    {
      state: "stalled",
      what: "Building the batch tree",
      command: "BuildBatchTree",
      batchId: "b_42",
      changeIds: ["chg_cm6t3"],
      attempts: 6,
      maxAttempts: 6,
      error: {
        errorClass: "Error",
        message: "queue build job failed (WorkflowInternalError): Network connection lost",
      },
      since: NOW - 7 * MIN,
      next: { kind: "rebuild", at: NOW + 8 * MIN },
    },
    {
      state: "retrying",
      what: "Computing the affected set",
      command: "ComputeAffectedSet",
      batchId: null,
      changeIds: ["chg_wr5p8"],
      attempts: 2,
      maxAttempts: 6,
      error: { errorClass: "TypeError", message: "fetch failed: https://[redacted]@artifacts.example/billing.git" },
      since: null,
      next: { kind: "retry", at: NOW + 40_000 },
    },
  ];
}

function withStalls(entries: QueueEntryView[], stalls: QueueStall[]): QueueEntryView[] {
  return entries.map((e) => {
    const x = stalls.find((st) => st.changeIds.includes(e.changeId));
    if (x === undefined || e.state === "merged" || e.state === "ejected") return e;
    const why = x.error ? `: ${x.error.errorClass}: ${x.error.message}` : "";
    return {
      ...e,
      stall: x.state,
      etaSeconds: null,
      reason:
        x.state === "stalled"
          ? `stalled: ${x.what.toLowerCase()} stopped${why}; rebuilt automatically after the build timeout`
          : `retrying: ${x.what.toLowerCase()} failed ${x.attempts} times${why}`,
    };
  });
}

function billing(variant: { frozen: boolean; halted: boolean; stalled: boolean }): QueueOverviewView {
  const freezes = variant.frozen;
  const stalls = variant.stalled ? billingStalls() : [];
  const entries = withStalls([...billingEntries(), ...billingWaitingAndDone()], stalls).map((e) => {
    if (
      !freezes ||
      e.priority === "revert" ||
      e.priority === "incident" ||
      e.state === "merged" ||
      e.state === "ejected"
    ) {
      return e;
    }
    return {
      ...e,
      frozen: true,
      etaSeconds: null,
      reason: `Frozen until the revert lands; it keeps speculating meanwhile. ${e.reason}`,
    };
  });
  return {
    repoId: "repo_billing",
    mainSha: sha(freezes ? "billing-main-bad" : "billing-main"),
    frozen: freezes,
    freezeReasons: freezes
      ? [
          {
            kind: "revert-in-progress",
            at: NOW - 6 * MIN,
            sha: sha("billing-main-bad"),
            changeId: "chg_rv8b1",
            signer: { principalId: "prn_platform", signature: b64u("freeze-billing-revert", 86) },
            message: FREEZE_MESSAGE,
          },
        ]
      : [],
    halted: variant.halted
      ? {
          code: "main-moved-outside-queue",
          message: `main moved to ${sha("billing-main-foreign").slice(0, 12)} without a queue compare-and-swap. Only the merge queue may write the default branch.`,
          at: NOW - 2 * MIN,
        }
      : null,
    tracks: [
      {
        id: "express",
        express: true,
        batches: [{ id: "b_51", state: "running", kind: "chain", entries: ["chg_rv8b1"] }],
      },
      {
        id: "1",
        express: false,
        batches: [
          { id: "b_41", state: "running", kind: "chain", entries: ["chg_tz7k2", "chg_lc3m9"] },
          { id: "b_42", state: "building", kind: "chain", entries: ["chg_cm6t3"] },
        ],
      },
      {
        id: "2",
        express: false,
        batches: [
          { id: "b_37", state: "bisecting", kind: "chain", entries: ["chg_pg5q1", "chg_br8w4"] },
          { id: "b_37a", state: "passed", kind: "probe", entries: ["chg_pg5q1"] },
          { id: "b_37b", state: "running", kind: "probe", entries: ["chg_br8w4"] },
        ],
      },
      {
        id: "3",
        express: false,
        batches: [{ id: "b_44", state: "passed", kind: "chain", entries: ["chg_ss4h8"] }],
      },
    ],
    landing: [
      { id: "lnd_8", state: "landed", members: ["chg_fx2r7"], targets: "all" },
      {
        id: "lnd_9",
        state: "rechecking",
        members: ["chg_ss4h8"],
        targets: ["test/auth/sessions.test.ts", "test/auth/roles.test.ts"],
      },
    ],
    entries,
    waiting: 3,
    resolving: 1,
    throughputPerHour: 5.4,
    timeInQueueMs: { p50: 23 * MIN, p95: 71 * MIN },
    ciDurationMs: 6 * MIN + 40_000,
    quarantined: [
      "test/pdf/render.test.ts › embeds subset fonts",
      "test/webhooks/signature.test.ts › rejects stale timestamps",
    ],
    flakeRates: {
      "test/pdf/render.test.ts › embeds subset fonts": 0.07,
      "test/webhooks/signature.test.ts › rejects stale timestamps": 0.12,
      "test/invoices/totals.test.ts › rounds half-even across currencies": 0.02,
    },
    trains: [
      {
        id: "trn_31",
        worker: "billing-api",
        state: "watching",
        changeIds: ["chg_fx2r7"],
        versionId: "v-7f3c2a1",
        watchUntil: NOW + 18 * MIN,
        killed: [],
      },
      {
        id: "trn_30",
        worker: "billing-ledger",
        state: freezes ? "rolling-back" : "killing",
        changeIds: ["chg_lg8b0"],
        versionId: "v-c41e9b2",
        watchUntil: null,
        killed: ["chg_lg8b0"],
      },
    ],
    stalls,
    updatedAt: Date.now(),
  };
}

function empty(repoId: string): QueueOverviewView {
  return {
    repoId,
    mainSha: sha(`${repoId}-main`),
    frozen: false,
    freezeReasons: [],
    halted: null,
    tracks: [],
    landing: [],
    entries: [],
    waiting: 0,
    resolving: 0,
    throughputPerHour: 0,
    timeInQueueMs: { p50: null, p95: null },
    ciDurationMs: 0,
    quarantined: [],
    flakeRates: {},
    trains: [],
    stalls: [],
    updatedAt: Date.now(),
  };
}

export async function mockQueueOverview(
  repoId: string,
  variant: { frozen: boolean; halted: boolean; stalled: boolean },
): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 220));
  if (!KNOWN.has(repoId)) {
    throw new ApiError(404, "not_found", "No repository with that id.", undefined, {
      explanation: "Check the link, or go back to the repository list.",
    });
  }
  return structuredClone(repoId === "repo_billing" ? billing(variant) : empty(repoId));
}
