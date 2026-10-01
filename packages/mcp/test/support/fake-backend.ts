import type { ApiError, Change, Plan, Repo, Tour } from "@app/domain";
import { defaultPolicy } from "@app/domain";
import type { McpBackend } from "../../src/index.js";

export const SHA = "a".repeat(40);
export const HEAD = "b".repeat(40);

export class NotFound extends Error {}

export const repo: Repo = {
  id: "repo_1",
  namespace: "gittifacts-eu",
  artifactsName: "r-repo_1",
  name: "app",
  defaultBranch: "main",
  jurisdiction: "eu",
  importedFrom: null,
  policy: defaultPolicy(),
  policySha: SHA,
  deployTarget: null,
  claim: { status: "claimed", ownerId: "hu_1", expiresAt: null },
  template: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};

export function change(over: Partial<Change> = {}): Change {
  return {
    id: "chg_1",
    repoId: repo.id,
    planId: "plan_1",
    title: "Rate limit logins",
    claim: { category: "feature", summary: null },
    baseSha: SHA,
    headSha: HEAD,
    forkName: "task-chg_1",
    authorId: "ag_1",
    status: "awaiting-review",
    computedLane: 1,
    lane: 1,
    laneReasons: [{ code: "size.lane1", lane: 1, message: "medium diff" }],
    evidenceId: null,
    tourId: null,
    flagKey: null,
    mergedSha: null,
    rolloutState: null,
    revertOf: null,
    revertedBy: null,
    agentTraceId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:01:00.000Z",
    ...over,
  };
}

export const tour: Tour = {
  id: "tour_1",
  changeId: "chg_1",
  headSha: HEAD,
  stops: [
    {
      kind: "intent",
      title: "Limiter runs first",
      why: "Before the password check.",
      hunkRefs: [{ file: "src/login.ts", startLine: 1, endLine: 3, side: "head" }],
      evidenceRefs: ["tests"],
      verdict: "proven",
    },
  ],
  leastConfident: ["clock skew"],
  notDone: ["per-account limits"],
  generatedBy: {
    principalId: "system",
    model: "fake",
    promptVersion: "v1",
    attempts: 1,
    costUsd: 0,
  },
  createdAt: "2026-10-01T00:02:00.000Z",
};

/** In-memory McpBackend; records calls. */
export function fakeBackend(over: Partial<McpBackend> = {}): McpBackend & { calls: string[] } {
  const calls: string[] = [];
  const base: McpBackend = {
    async whoami(caller) {
      calls.push("whoami");
      return {
        principal: {
          id: caller.principalId,
          kind: "agent",
          name: "bot",
          ownerId: "hu_1",
          keys: [],
          scopes: [],
        },
        canApprove: false,
        repos: [
          { id: repo.id, name: repo.name, claim: repo.claim, actions: ["read", "create-plan"] },
        ],
        quotas: {
          enforced: false,
          ciMinutesPerDay: null,
          ciMinutesUsedToday: null,
          artifactsOpsPerDay: null,
        },
      };
    },
    async listRepos() {
      calls.push("listRepos");
      return [
        {
          ...repo,
          counts: { lane0: 0, lane1: 1, lane2: 0, awaitingReview: 1, rollingOut: 0, failing: 0 },
        },
      ];
    },
    async createPlan(caller, input, opts) {
      calls.push(`createPlan:${opts.idempotencyKey ?? "-"}`);
      const plan: Plan = {
        id: "plan_1",
        ...input,
        supersedes: input.supersedes ?? null,
        status: "draft",
        authorId: caller.principalId,
        approvedBy: null,
        approvedAt: null,
        approvalSignature: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      };
      return plan;
    },
    async startChange(_caller, input) {
      calls.push("startChange");
      return {
        change: change({
          title: input.title,
          status: "awaiting-push",
          headSha: null,
          lane: null,
          computedLane: null,
        }),
        remote: {
          url: "https://git.example/task-chg_1.git",
          username: "x",
          token: "t",
          expiresAt: "2026-10-01T01:00:00Z",
          branch: "main",
        },
      };
    },
    async getChangeStatus(_caller, changeId) {
      calls.push(`getChangeStatus:${changeId}`);
      if (changeId !== "chg_1") throw new NotFound(`change ${changeId}`);
      return {
        change: change(),
        runs: [
          {
            id: "run_1",
            changeId,
            headSha: HEAD,
            engine: "workflows",
            status: "passed",
            startedAt: null,
            finishedAt: null,
            steps: [{ name: "test", kind: "user", status: "passed", durationMs: 1, logRef: null }],
          },
        ],
        classification: {
          lane: 1,
          computedLane: 1,
          reasons: [{ code: "size.lane1", lane: 1, message: "medium diff" }],
          shadow: false,
          blocked: false,
          requiresHumanApproval: false,
        },
      };
    },
    async getEvidence() {
      throw new NotFound("evidence");
    },
    async getTour() {
      return { tour, stale: false };
    },
    async requestReview(_caller, changeId) {
      calls.push(`requestReview:${changeId}`);
      return { change: change(), notified: true };
    },
    async listIssuesForChange() {
      return [];
    },
    async refreshPushToken() {
      return {
        url: "https://git.example/task-chg_1.git",
        username: "x",
        token: "t2",
        expiresAt: "2026-10-01T02:00:00Z",
        branch: "main",
      };
    },
    async waitForChange(_caller, _id, _until) {
      return { change: change({ status: "merged" }), reached: true, reason: "reached" };
    },
    errorEnvelope(err: unknown): ApiError {
      if (err instanceof NotFound) {
        return {
          error: {
            code: "not-found",
            message: `${err.message} not found`,
            fix: { explanation: "List what exists.", call: "list_repos({})" },
          },
        };
      }
      return {
        error: { code: "internal", message: "internal error", fix: { explanation: "Retry." } },
      };
    },
  };
  return Object.assign({ ...base, ...over }, { calls });
}
