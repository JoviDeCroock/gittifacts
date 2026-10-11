/**
 * A deploy-train rollback timed like the live M4 run 8 (STATUS.md, 2026-10-03): the Workers Logs
 * poll detects the regression 23.9 s after the first error, the flag goes off 0.1 s later, the
 * Worker rolls back at +1.1 s and the revert opens at +6.8 s; the revert lands 81.5 s after that.
 * The train recorded no error-rate sample with it (lastCheck null), like the live run.
 */
import { b64u, NOW, PLATFORM_KEY_ID, sha } from "./fixture-kit.js";
import {
  apiNone,
  depsNone,
  file,
  hunk,
  reason,
  type Scenario,
  scenario,
  sensitive,
  stop,
  testRun,
} from "./scenario-kit.js";
import type { TimelineEvent } from "./types.js";

const EDGE = "repo_edge";
/** The merge, 40 minutes ago; every time below is milliseconds after it. */
const T0 = NOW - 40 * 60_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();

function events(
  subject: string,
  startSeq: number,
  rows: [ms: number, action: string, summary: string][],
): TimelineEvent[] {
  return rows.map(([ms, action, summary], i) => ({
    seq: startSeq + i,
    at: at(ms),
    principalId: "system",
    action,
    subject,
    payloadHash: b64u(`${subject}:${startSeq + i}:payload`, 43),
    prevHash: b64u(`${subject}:${startSeq + i - 1}`, 43),
    hash: b64u(`${subject}:${startSeq + i}`, 43),
    signature: b64u(`${subject}:${startSeq + i}:sig`, 86),
    keyId: PLATFORM_KEY_ID,
    summary,
  }));
}

const VERSION = "a636ad56-cef1-4b77-8513-947baa177c7c";
const PREVIOUS = "11dee25a-2820-441c-bd17-e2856e22b1ba";

const trainChange: Scenario = {
  ...scenario({
    id: "chg_tr2m4",
    repoId: EDGE,
    planId: null,
    title: "Speed up / (with a bug that throws for some traffic)",
    category: "feature",
    authorId: "prn_coder07",
    status: "reverted",
    computedLane: 2,
    lane: 2,
    createdMin: 60,
    updatedMin: 37,
    flagKey: "change-chg_tr2m4",
    merged: true,
    revertedBy: "chg_rv2m5",
    rolloutState: {
      status: "rolled-back",
      versionId: VERSION,
      previousVersionId: PREVIOUS,
      stages: [
        { percent: 50, startedAt: at(154_300), completedAt: null },
        { percent: 100, startedAt: null, completedAt: null },
      ],
      watchUntil: null,
      flagKey: "change-chg_tr2m4",
      lastCheck: null,
    },
    issues: [
      {
        id: "iss_m4r8",
        changeId: "chg_tr2m4",
        title: "m4 regression for n=<number> · at / (index.js)",
        count: 6,
        firstSeen: at(161_700),
        lastSeen: at(186_000),
        versionId: VERSION,
        url: "https://dash.cloudflare.com/",
      },
    ],
    reasons: [
      reason(
        "llm.concern",
        2,
        "The reviewer agent flagged a hidden behavior change: / throws for some inputs behind the flag.",
      ),
    ],
    files: [
      file("src/index.ts", "modified", [
        hunk(
          4,
          4,
          `
 export default {
-  async fetch(req: Request): Promise<Response> {
+  async fetch(req: Request, env: Env): Promise<Response> {
+    if (await isChangeEnabled(env, "chg_tr2m4")) maybeThrow(req);`,
        ),
      ]),
    ],
    tour: {
      stops: [
        stop(
          "risk",
          "risk",
          "Some requests throw behind the flag",
          "The new path throws for about 2 in 5 values of n.",
          [],
          [],
        ),
      ],
      leastConfident: ["How often n hits the throwing branch in production traffic."],
      notDone: ["No load test of the new path."],
    },
    items: [testRun("chg_tr2m4", 12), apiNone(), depsNone(), sensitive([])],
  }),
  timeline: events("change:chg_tr2m4", 830, [
    [-62_000, "change.approved", "Approved for merge"],
    [0, "change.merged", `Merged as ${sha("chg_tr2m4:merged").slice(0, 7)}`],
    [3_200, "rollout.via-train", "Rolling out on a deploy train"],
    [
      185_600,
      "deploy.regression-attributed",
      "Regression attributed in train t2, seen by the Workers Logs poll (telemetry-t2-1)",
    ],
    [185_700, "deploy.flag-off", "Deploy flag off"],
    [186_700, "rollout.rolled-back", "Rolled back to the previous version"],
    [192_400, "change.revert-opened", "Revert change chg_rv2m5 opened"],
  ]),
};

const trainRevert: Scenario = {
  ...scenario({
    id: "chg_rv2m5",
    repoId: EDGE,
    planId: null,
    title: "Revert: Speed up / (with a bug that throws for some traffic)",
    category: "revert",
    authorId: "prn_platform",
    status: "released",
    computedLane: 0,
    lane: 0,
    createdMin: 37,
    updatedMin: 30,
    merged: true,
    revertOf: "chg_tr2m4",
    agentTrace: false,
    reasons: [reason("revert.verified", 0, "Exact inverse of merged change chg_tr2m4.")],
    files: [
      file("src/index.ts", "modified", [
        hunk(
          4,
          4,
          `
 export default {
-  async fetch(req: Request, env: Env): Promise<Response> {
-    if (await isChangeEnabled(env, "chg_tr2m4")) maybeThrow(req);
+  async fetch(req: Request): Promise<Response> {`,
        ),
      ]),
    ],
    items: [testRun("chg_rv2m5", 12), apiNone(), depsNone(), sensitive([])],
  }),
  timeline: events("change:chg_rv2m5", 842, [
    [192_900, "change.revert-verified", "Verified as a pure revert"],
    [273_900, "change.merged", `Merged as ${sha("chg_rv2m5:merged").slice(0, 7)}`],
    [276_800, "rollout.via-train", "Rolling out on a deploy train"],
  ]),
};

export const TRAIN_SCENARIOS: Scenario[] = [trainChange, trainRevert];
