import type { ApiError, Change, Plan, Repo, Tour } from "@app/domain";
import { defaultPolicy } from "@app/domain";
import type { McpBackend, PlanData, QueueEntry, WorkspaceView } from "../../src/index.js";

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

export function workspaceView(over: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    workspaceId: "ws-chg_1",
    changeId: "chg_1",
    repoId: repo.id,
    forkName: "task-chg_1",
    branch: "main",
    baseSha: SHA,
    headSha: HEAD,
    status: "ready",
    network: "open",
    expiresAt: "2026-10-01T02:00:00.000Z",
    idleSleepSec: 600,
    restoredFrom: "image",
    usage: { containerSeconds: 3, projectSecondsRemaining: null },
    ...over,
  };
}

/** A queue entry as the platform returns it. */
export function queueEntry(over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    changeId: "chg_1",
    title: "Fix a",
    authorId: "ag_1",
    priority: "normal",
    lane: 0,
    state: "waiting",
    hold: null,
    trackId: null,
    batch: null,
    position: 0,
    etaSeconds: 720,
    blocking: [],
    reason: "waiting for the next batch",
    predictedPassProbability: 0.96,
    frozen: false,
    enqueuedAt: 1_759_312_800_000,
    dependsOn: [],
    plangroup: null,
    ejectReason: null,
    mergedSha: null,
    ...over,
  };
}

/** In-memory McpBackend; records calls. */
export function fakeBackend(over: Partial<McpBackend> = {}): McpBackend & { calls: string[] } {
  const calls: string[] = [];
  const plans = new Map<string, PlanData>();
  const base: McpBackend = {
    webUrl(page) {
      return "planId" in page
        ? `https://gittifacts.test/plans/${page.planId}`
        : `https://gittifacts.test/changes/${page.changeId}`;
    },
    async getPlan(_caller, planId) {
      calls.push(`getPlan:${planId}`);
      const plan = plans.get(planId);
      if (plan === undefined) throw new NotFound(`plan ${planId}`);
      return { plan, changes: [], principals: {} };
    },
    async listChanges(_caller, repoId, filter) {
      calls.push(`listChanges:${repoId}:${filter.status ?? "-"}`);
      const rows = [
        change(),
        change({ id: "chg_2", authorId: "ag_2", status: "running", title: "Cache sessions" }),
      ].filter((c) => c.repoId === repoId && (filter.status === undefined || c.status === filter.status));
      return rows.map((c) => ({
        ...c,
        planTitle: c.planId === null ? null : "Rate limit logins",
        authorName: c.authorId === "ag_1" ? "bot" : "other-bot",
        authorKind: "agent" as const,
      }));
    },
    async listPlans(_caller, repoId) {
      calls.push(`listPlans:${repoId}`);
      return { plans: [...plans.values()].filter((p) => p.repoId === repoId), principals: {} };
    },
    async withdrawPlan(caller, planId, reason) {
      calls.push(`withdrawPlan:${planId}`);
      const plan = plans.get(planId);
      if (plan === undefined) throw new NotFound(`plan ${planId}`);
      const withdrawn: PlanData = {
        ...plan,
        status: "rejected",
        rejectedBy: caller.principalId,
        rejectedAt: "2026-10-01T00:05:00.000Z",
        rejectionReason: reason ?? "withdrawn by its author",
      };
      plans.set(planId, withdrawn);
      return withdrawn;
    },
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
    async createProject(_caller, input, opts) {
      calls.push(`createProject:${opts.idempotencyKey ?? "-"}`);
      return {
        repoId: repo.id,
        projectId: repo.id,
        name: input.name ?? "app",
        template: input.template ?? null,
        defaultBranch: "main",
        remote: {
          url: "https://acc.artifacts.cloudflare.net/git/ns/task-chg_2.git",
          username: "x",
          token: "art_tok",
          expiresAt: "2026-10-01T01:00:00.000Z",
          branch: "main",
          changeId: "chg_2",
        },
        token: null,
        mcpUrl: "https://gittifacts.test/mcp",
        previewUrl: `https://p-bs-${repo.id}.preview.test`,
        claimUrl: null,
        bootstrapChangeId: `bs-${repo.id}`,
        nextSteps: [
          {
            title: "Wait for the first CI run and preview",
            call: `wait_for_change({ changeId: "bs-${repo.id}", until: "evidence_ready", timeoutSec: 120 })`,
          },
          { title: "Push", command: "git push" },
        ],
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
    async listMembers(_caller, repoId) {
      calls.push(`listMembers:${repoId}`);
      return {
        repoId,
        members: [
          { principalId: "hu_1", name: "Ada", role: "owner", addedAt: "2026-10-01T00:00:00.000Z" },
        ],
        viewerRole: "owner",
      };
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
      plans.set(plan.id, { ...plan, rejectedBy: null, rejectedAt: null, rejectionReason: null });
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
        reviews: [],
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
    async rerunCi(_caller, changeId, reason, opts) {
      calls.push(`rerunCi:${changeId}:${reason ?? "-"}:${opts.idempotencyKey ?? "-"}`);
      if (changeId !== "chg_1") throw new NotFound(`change ${changeId}`);
      return { change: change({ status: "running", lane: null, computedLane: null }), headSha: HEAD };
    },
    async closeChange(_caller, changeId, reason, opts) {
      calls.push(`closeChange:${changeId}:${reason ?? "-"}:${opts.idempotencyKey ?? "-"}`);
      if (changeId !== "chg_1") throw new NotFound(`change ${changeId}`);
      return change({ status: "abandoned" });
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
    // Remote workspaces (tools/workspace.ts) and import detection (tools/import.ts).
    async openWorkspace(_caller, input, opts) {
      calls.push(`openWorkspace:${input.changeId}:${opts.idempotencyKey ?? "-"}`);
      if (input.changeId !== "chg_1") throw new NotFound(`change ${input.changeId}`);
      return workspaceView({ status: "ready" });
    },
    async closeWorkspace(_caller, workspaceId) {
      calls.push(`closeWorkspace:${workspaceId}`);
      return workspaceView({ status: "closed" });
    },
    async wsExec(_caller, input) {
      calls.push(`wsExec:${input.command}:${input.timeoutSec ?? "-"}`);
      return {
        exitCode: 0,
        timedOut: false,
        durationMs: 12,
        stdout: "ok\n",
        stderr: "",
        stdoutBytes: 3,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
    async wsRead(_caller, input) {
      calls.push(`wsRead:${input.path}`);
      return {
        path: input.path,
        content: "line 1\n",
        binary: false,
        sizeBytes: 7,
        totalLines: 1,
        startLine: 1,
        endLine: 1,
        truncated: false,
      };
    },
    async wsWrite(_caller, input) {
      calls.push(`wsWrite:${input.path}:${input.patch === undefined ? "content" : "patch"}`);
      return {
        path: input.path,
        mode: input.patch === undefined ? "content" : "patch",
        bytes: (input.content ?? input.patch ?? "").length,
        created: false,
      };
    },
    async wsDiff() {
      return { baseSha: SHA, files: [], patch: "", truncated: false };
    },
    async wsCommitPush(_caller, input) {
      calls.push(`wsCommitPush:${input.message}`);
      return {
        changeId: "chg_1",
        branch: "main",
        commitSha: "c".repeat(40),
        previousHead: HEAD,
        filesChanged: 1,
        pushed: true,
      };
    },
    async proposePlatformConfig(_caller, input, opts) {
      calls.push(
        `proposePlatformConfig:${input.repoId}:${input.rerun}:${opts.idempotencyKey ?? "-"}`,
      );
      return {
        proposalId: "pcfg-1",
        repoId: input.repoId,
        status: "proposed",
        baseSha: SHA,
        planId: "plan_9",
        changeId: "chg_9",
        detection: {
          confidence: "medium",
          packageManager: "pnpm",
          testRunner: "vitest",
          workers: ["clock-api"],
          uncertain: ["No typecheck script: CI runs `tsc --noEmit` with the root tsconfig.json."],
          buildScriptsNeedingApproval: [],
        },
        error: null,
        startedAt: "2026-10-01T00:00:00.000Z",
      };
    },
    async enqueue(_caller, input, opts) {
      calls.push(
        `enqueue:${input.changeId}:${input.priority ?? "-"}:${opts.idempotencyKey ?? "-"}`,
      );
      return {
        changeId: input.changeId,
        admitted: true,
        state: "waiting",
        position: 0,
        track: null,
        etaSeconds: 720,
        predictedPassProbability: 0.96,
        reason: "waiting for the next batch",
      };
    },
    async queueStatus(_caller, changeId) {
      calls.push(`queueStatus:${changeId}`);
      return queueEntry({ changeId });
    },
    async waitForMerge(_caller, changeId, timeoutMs) {
      calls.push(`waitForMerge:${changeId}:${timeoutMs}`);
      return {
        reason: "merged",
        frozen: false,
        status: queueEntry({ changeId, state: "merged", mergedSha: SHA }),
      };
    },
    async dequeue(_caller, changeId) {
      calls.push(`dequeue:${changeId}`);
      return { removed: true, status: queueEntry({ changeId, state: "dequeued" }) };
    },
    async reprioritize(_caller, input) {
      calls.push(`reprioritize:${input.changeId}:${input.priority}`);
      return { status: queueEntry({ changeId: input.changeId, priority: input.priority }) };
    },
    async queueOverview(_caller, repoId) {
      calls.push(`queueOverview:${repoId}`);
      return {
        repoId,
        mainSha: SHA,
        frozen: false,
        freezeReasons: [],
        halted: null,
        tracks: [
          {
            id: "t1",
            express: false,
            batches: [{ id: "b1", state: "running", kind: "chain", entries: ["chg_1"] }],
          },
        ],
        landing: [],
        entries: [queueEntry({ changeId: "chg_1", state: "speculating" })],
        waiting: 0,
        resolving: 0,
        throughputPerHour: 4,
        timeInQueueMs: { p50: 600_000, p95: 1_200_000 },
        ciDurationMs: 600_000,
        quarantined: [],
        flakeRates: {},
      };
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
