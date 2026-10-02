import { env } from "cloudflare:workers";
import type { ClassifyResult } from "@app/classifier";
import {
  type Change,
  type ChangeDiff,
  defaultPolicy,
  type Evidence,
  type PipelineRun,
  type Plan,
  type Repo,
  type Tour,
} from "@app/domain";
import { putMember } from "../src/access/members-store.js";
import type { RepoRole } from "../src/access/roles.js";
import { principals } from "../src/db/schema.js";
import { platformSigner } from "../src/signing.js";
import { D1Store } from "../src/store/d1-store.js";

export const BASE_SHA = "a".repeat(40);
export const HEAD_SHA = "b".repeat(40);

let n = 0;
export function uid(prefix: string): string {
  n++;
  return `${prefix}_${Date.now().toString(36)}${n}`;
}

export function store(): D1Store {
  return new D1Store(env.DB, env.BLOBS);
}

export async function seedPrincipal(
  s: D1Store,
  p: {
    id?: string;
    kind: "human" | "agent" | "system";
    name?: string;
    ownerId?: string | null;
    scopes?: string[];
  },
): Promise<string> {
  const id = p.id ?? uid(p.kind === "human" ? "hu" : "ag");
  await s.db.insert(principals).values({
    id,
    kind: p.kind,
    name: p.name ?? id,
    ownerId: p.ownerId ?? null,
    userId: null,
    scopes: p.scopes ?? [],
    createdAt: new Date().toISOString(),
  });
  return id;
}

/** Make a human principal a member of a repo (repo access, src/access/). */
export async function addMember(
  s: D1Store,
  repoId: string,
  principalId: string,
  role: RepoRole = "owner",
): Promise<void> {
  await putMember(s, {
    repoId,
    principalId,
    role,
    addedBy: "system",
    addedAt: new Date().toISOString(),
  });
}

export function repoFixture(over: Partial<Repo> = {}): Repo {
  const id = over.id ?? uid("repo");
  return {
    id,
    namespace: "gittifacts-eu",
    artifactsName: `r-${id}`,
    name: `name-${id}`,
    defaultBranch: "main",
    jurisdiction: "eu",
    importedFrom: null,
    policy: defaultPolicy(),
    policySha: BASE_SHA,
    deployTarget: null,
    claim: { status: "claimed", ownerId: null, expiresAt: null },
    template: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

export function planFixture(repoId: string, authorId: string, over: Partial<Plan> = {}): Plan {
  return {
    id: uid("plan"),
    repoId,
    title: "Add rate limiting",
    intent: "Limit login attempts per IP to stop credential stuffing.",
    acceptanceCriteria: ["6th attempt within a minute gets 429"],
    outOfScope: [],
    riskDeclarations: [],
    scopePaths: ["src/auth/**"],
    affectedRoutes: [],
    status: "draft",
    authorId,
    approvedBy: null,
    approvedAt: null,
    approvalSignature: null,
    supersedes: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

export function changeFixture(
  repoId: string,
  authorId: string,
  over: Partial<Change> = {},
): Change {
  const id = over.id ?? uid("chg");
  const now = new Date().toISOString();
  return {
    id,
    repoId,
    planId: null,
    title: "Rate limit logins",
    claim: { category: "feature", summary: "adds a limiter" },
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    forkName: `task-${id}`,
    authorId,
    status: "awaiting-review",
    computedLane: 1,
    lane: 1,
    laneReasons: [{ code: "size.lane1", lane: 1, message: "diff is medium sized" }],
    evidenceId: null,
    tourId: null,
    flagKey: null,
    mergedSha: null,
    rolloutState: null,
    revertOf: null,
    revertedBy: null,
    agentTraceId: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

export function diffFixture(over: Partial<ChangeDiff> = {}): ChangeDiff {
  return {
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    additions: 2,
    deletions: 1,
    files: [
      {
        path: "src/auth/login.ts",
        previousPath: null,
        status: "modified",
        additions: 2,
        deletions: 1,
        binary: false,
        transformVerified: false,
        truncated: false,
        hunks: [
          {
            header: "@@ -1,2 +1,3 @@",
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 3,
            lines: [
              { kind: "ctx", oldNo: 1, newNo: 1, text: "export function login() {" },
              { kind: "del", oldNo: 2, newNo: null, text: "  return ok();" },
              { kind: "add", oldNo: null, newNo: 2, text: "  limit();" },
              { kind: "add", oldNo: null, newNo: 3, text: "  return ok();" },
            ],
          },
        ],
      },
    ],
    ...over,
  };
}

export async function evidenceFixture(changeId: string, headSha = HEAD_SHA): Promise<Evidence> {
  const signer = await platformSigner(env);
  const signed = await signer.signEvidence({
    changeId,
    headSha,
    items: [
      {
        id: "tests",
        kind: "test-run",
        status: "ok",
        sha: headSha,
        step: "test",
        runner: "vitest",
        passed: 12,
        failed: 0,
        skipped: 0,
        durationMs: 1234,
        failures: [],
      },
    ],
  });
  return {
    ...signed,
    id: uid("ev"),
    baseSha: BASE_SHA,
    createdAt: new Date().toISOString(),
    notesWritten: true,
  };
}

export function runFixture(changeId: string, over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: uid("run"),
    changeId,
    headSha: HEAD_SHA,
    engine: "workflows",
    status: "passed",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    finishedAt: new Date().toISOString(),
    steps: [
      { name: "install", kind: "user", status: "passed", durationMs: 2000, logRef: null },
      { name: "test", kind: "user", status: "passed", durationMs: 1234, logRef: "logs/test" },
    ],
    ...over,
  };
}

export function classificationFixture(over: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    lane: 1,
    computedLane: 1,
    reasons: [{ code: "size.lane1", lane: 1, message: "diff is medium sized" }],
    shadow: false,
    blocked: false,
    requiresHumanApproval: false,
    checklist: [{ gate: "ci", passed: true, detail: "CI passed" }],
    ...over,
  };
}

export function tourFixture(changeId: string, over: Partial<Tour> = {}): Tour {
  return {
    id: uid("tour"),
    changeId,
    headSha: HEAD_SHA,
    stops: [
      {
        kind: "intent",
        title: "Login is rate limited",
        why: "The limiter runs before the password check.",
        hunkRefs: [{ file: "src/auth/login.ts", startLine: 2, endLine: 3, side: "head" }],
        evidenceRefs: ["tests"],
        verdict: "proven",
      },
    ],
    leastConfident: ["Limiter window under clock skew"],
    notDone: ["No per-account limit"],
    generatedBy: {
      principalId: "system",
      model: "fake",
      promptVersion: "v1",
      attempts: 1,
      costUsd: 0.01,
    },
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/** A repo with one human, one agent (owned by the human) and one change authored by the agent. */
export async function seedWorld(s: D1Store = store()) {
  const human = await seedPrincipal(s, {
    kind: "human",
    name: "Ada",
    scopes: [
      "repo:read",
      "repo:admin",
      "plan:create",
      "plan:approve",
      "change:create",
      "change:review",
      "policy:admin",
    ],
  });
  const agent = await seedPrincipal(s, {
    kind: "agent",
    name: "builder-bot",
    ownerId: human,
    scopes: ["repo:read", "plan:create", "change:create"],
  });
  const repo = repoFixture();
  await s.insertRepo(repo);
  const plan = planFixture(repo.id, agent);
  await s.insertPlan(plan);
  const change = changeFixture(repo.id, agent, { planId: plan.id });
  await s.insertChange(change);
  return { s, human, agent, repo, plan, change };
}
