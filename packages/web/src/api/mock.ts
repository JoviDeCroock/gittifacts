/**
 * In-browser mock backend. Implements the docs/api.md paths over an in-memory copy of the
 * synthetic fixtures, with realistic latency and the same error envelope as the real API.
 * Mutations (approve, review, kill, create agent) persist for the life of the tab.
 */
import type { Change, Lane } from "@app/domain";
import invoiceAfter from "./mock-assets/invoice-after.png";
import invoiceBefore from "./mock-assets/invoice-before.png";
import { b64u, ago, sha } from "./fixture-kit.js";
import { type MockDb, chainEvents, createDb, principalRef } from "./fixtures.js";
import type { RawResponse } from "./client.js";
import { createClaimMock } from "./mock-claim.js";
import { mockCreatedProjects, mockFreshAccount } from "./mock-getting-started.js";
import type { Scenario } from "./scenario-kit.js";
import type {
  AuditPage,
  ChangeDetail,
  ChangeSummary,
  ClassifyResult,
  LaneCounts,
  Principal,
  RepoSummary,
  ReviewDecisionKind,
  Scope,
} from "./types.js";

const db: MockDb = createDb();

const AUTH_KEY = "gf:mock-auth";

function signedIn(): boolean {
  try {
    return window.sessionStorage.getItem(AUTH_KEY) !== "out";
  } catch {
    return true;
  }
}

export function mockSignIn(): void {
  try {
    window.sessionStorage.removeItem(AUTH_KEY);
  } catch {
    /* private mode: stay signed in for the page */
  }
}

export function mockSignOut(): void {
  try {
    window.sessionStorage.setItem(AUTH_KEY, "out");
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- helpers

const ok = (body: unknown, status = 200): RawResponse => ({ status, body: structuredClone(body) });
const FIX: Record<string, string> = {
  unauthenticated: "Sign in again; your session cookie is missing or expired.",
  not_found: "Check the link, or go back to the repository list.",
  own_plan: "Ask a teammate with the plan:approve scope to review it.",
  own_change: "Ask a teammate with the change:review scope to review it.",
  not_draft: "Reload the plan to see its current state.",
  not_reviewable: "Reload the change to see its current state.",
  comment_required: "Add a comment and submit again.",
  reason_required: "Add a reason and submit again.",
  shadow_threshold_not_met: "Keep reviewing Lane 0 candidates until agreement reaches the policy threshold.",
  not_rolling_out: "Reload the rollout; it may already have finished or rolled back.",
  invalid_name: "Pick a name like fleet-coder-08.",
  name_taken: "Pick a different name, or revoke and reuse the old agent.",
  forbidden: "Ask the agent's owner to do it.",
  evidence_not_ready: "Wait for the pipeline to finish; evidence is signed at the end.",
  tour_not_ready: "Wait for the pipeline to pass; the reviewer agent writes the tour right after.",
};
const fail = (status: number, code: string, message: string): RawResponse => ({
  status,
  body: { error: { code, message, fix: { explanation: FIX[code] ?? "Retry, or reload the page." } } },
});
const idempotent = new Map<string, RawResponse>();

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function latency(method: string): number {
  const base = method === "GET" ? 140 : 520;
  return base + Math.round(Math.random() * 180);
}

function me(): Principal {
  return db.principals.find((p) => p.id === db.me)!;
}

function scenarioById(id: string): Scenario | undefined {
  return db.scenarios.find((s) => s.change.id === id);
}

function appendAudit(principalId: string, action: string, subject: string): void {
  const last = db.audit[db.audit.length - 1];
  const [event] = chainEvents([[0, principalId, action, subject]], (last?.seq ?? -1) + 1, last?.hash);
  if (event) db.audit.push(event);
}

function countsFor(repoId: string): LaneCounts {
  const changes = db.scenarios.map((s) => s.change).filter((c) => c.repoId === repoId);
  const open = changes.filter((c) => !["released", "reverted", "rejected", "abandoned"].includes(c.status));
  return {
    lane0: open.filter((c) => c.computedLane === 0).length,
    lane1: open.filter((c) => c.lane === 1 && c.computedLane !== 0).length,
    lane2: open.filter((c) => c.lane === 2).length,
    awaitingReview: changes.filter((c) => c.status === "awaiting-review").length,
    rollingOut: changes.filter((c) => c.status === "rolling-out").length,
    failing: changes.filter((c) => c.status === "failing").length,
  };
}

function summary(c: Change): ChangeSummary {
  const author = principalRef(db.principals, c.authorId);
  const plan = c.planId ? db.plans.find((p) => p.id === c.planId) : undefined;
  return {
    ...c,
    planTitle: plan?.title ?? null,
    authorName: author.name,
    authorKind: author.kind === "human" ? "human" : "agent",
  };
}

function classification(c: Change): ClassifyResult | null {
  if (c.lane === null || c.computedLane === null) return null;
  return { lane: c.lane, computedLane: c.computedLane, reasons: c.laneReasons };
}

function parseBody<T extends object>(body: unknown): Partial<T> {
  return typeof body === "object" && body !== null ? (body as Partial<T>) : {};
}

// ---------------------------------------------------------------- routes

type Handler = (params: string[], query: URLSearchParams, body: unknown) => RawResponse;

const routes: [method: string, pattern: RegExp, handler: Handler][] = [
  ["GET", /^\/api\/v1\/me$/, () => ok({ principal: me(), user: db.user })],

  [
    "GET",
    /^\/api\/v1\/principals$/,
    () => ok({ principals: db.principals.filter((p) => p.id === db.me || p.ownerId === db.me) }),
  ],

  [
    "GET",
    /^\/api\/v1\/principals\/([^/]+)$/,
    ([id]) => (db.principals.some((p) => p.id === id) ? ok({ principal: principalRef(db.principals, id!) }) : fail(404, "not_found", "No such principal.")),
  ],

  [
    "POST",
    /^\/api\/v1\/principals\/agents$/,
    (_p, _q, body) => {
      const input = parseBody<{ name: string; scopes: Scope[] }>(body);
      const name = (input.name ?? "").trim();
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) {
        return fail(400, "invalid_name", "Use 2–41 lowercase letters, digits or hyphens, starting with a letter or digit.");
      }
      if (db.principals.some((p) => p.name === name)) return fail(409, "name_taken", `An agent called ${name} already exists.`);
      const scopes = (input.scopes ?? []).filter((s) => s !== "plan:approve");
      const id = `prn_${b64u(`${name}:${Date.now()}`, 8).toLowerCase()}`;
      const principal: Principal = {
        id,
        kind: "agent",
        name,
        ownerId: db.me,
        keys: [{ id: `key_${b64u(id, 8)}`, alg: "Ed25519", publicKey: b64u(`${id}:pub`, 43), createdAt: new Date().toISOString(), revokedAt: null }],
        scopes,
      };
      db.principals.push(principal);
      appendAudit(db.me, "principal.created", `principal:${id}`);
      return ok({ principal, token: `gfa_${b64u(`${id}:token:${Date.now()}`, 40)}` }, 201);
    },
  ],

  [
    "DELETE",
    /^\/api\/v1\/principals\/([^/]+)\/tokens$/,
    ([id]) => {
      const p = db.principals.find((x) => x.id === id);
      if (!p) return fail(404, "not_found", "No such principal.");
      if (p.ownerId !== db.me) return fail(403, "forbidden", "You can only revoke tokens for agents you own.");
      let revoked = 0;
      for (const k of p.keys) {
        if (k.revokedAt === null) {
          k.revokedAt = new Date().toISOString();
          revoked++;
        }
      }
      appendAudit(db.me, "tokens.revoked", `principal:${p.id}`);
      return ok({ revoked });
    },
  ],

  [
    "GET",
    /^\/api\/v1\/repos$/,
    () => {
      const repos: RepoSummary[] = db.repos.map((r) => ({ ...r.repo, counts: countsFor(r.repo.id), shadow: r.shadow }));
      if (!mockFreshAccount()) return ok({ repos });
      // `?gs=new`: a brand-new account sees only the projects "Try it now" made in this tab.
      const base = repos[0];
      const fresh: RepoSummary[] = base
        ? mockCreatedProjects().map((p) => ({ ...base, id: p.id, name: p.name, template: p.template, counts: countsFor(p.id) }))
        : [];
      return ok({ repos: fresh });
    },
  ],

  [
    "GET",
    /^\/api\/v1\/repos\/([^/]+)$/,
    ([id]) => {
      const r = db.repos.find((x) => x.repo.id === id);
      return r ? ok({ repo: r.repo, shadow: r.shadow, counts: countsFor(r.repo.id) }) : fail(404, "not_found", "No such repository.");
    },
  ],

  [
    "PATCH",
    /^\/api\/v1\/repos\/([^/]+)\/lane0$/,
    ([id], _q, body) => {
      const r = db.repos.find((x) => x.repo.id === id);
      if (!r) return fail(404, "not_found", "No such repository.");
      const { enabled } = parseBody<{ enabled: boolean }>(body);
      if (enabled && !r.shadow.eligibleToEnableLane0) {
        return fail(409, "shadow_threshold_not_met", "Agreement is below the policy threshold, so Lane 0 stays in shadow mode.");
      }
      r.repo.policy.lane0Enabled = Boolean(enabled);
      appendAudit(db.me, enabled ? "lane0.enabled" : "lane0.disabled", `repo:${r.repo.id}`);
      return ok({ repo: r.repo });
    },
  ],

  ["GET", /^\/api\/v1\/repos\/([^/]+)\/plans$/, ([id]) => ok({ plans: db.plans.filter((p) => p.repoId === id) })],

  [
    "GET",
    /^\/api\/v1\/plans\/([^/]+)$/,
    ([id]) => {
      const plan = db.plans.find((p) => p.id === id);
      if (!plan) return fail(404, "not_found", "No such plan.");
      return ok({ plan, changes: db.scenarios.map((s) => s.change).filter((c) => c.planId === id) });
    },
  ],

  [
    "POST",
    /^\/api\/v1\/plans\/([^/]+)\/(approve|reject)$/,
    ([id, verb], _q, body) => {
      const plan = db.plans.find((p) => p.id === id);
      if (!plan) return fail(404, "not_found", "No such plan.");
      if (plan.authorId === db.me) return fail(403, "own_plan", "You wrote this plan, so someone else has to approve or reject it.");
      if (plan.status !== "draft") return fail(409, "not_draft", `This plan is already ${plan.status}.`);
      const { comment } = parseBody<{ comment: string }>(body);
      if (verb === "reject") {
        if (!comment?.trim()) return fail(400, "comment_required", "Say why you are rejecting the plan.");
        plan.status = "rejected";
        appendAudit(db.me, "plan.rejected", `plan:${plan.id}`);
      } else {
        plan.status = "approved";
        plan.approvedBy = db.me;
        plan.approvedAt = new Date().toISOString();
        plan.approvalSignature = b64u(`${plan.id}:approval:${Date.now()}`, 86);
        appendAudit(db.me, "plan.approved", `plan:${plan.id}`);
      }
      return ok({ plan });
    },
  ],

  [
    "GET",
    /^\/api\/v1\/repos\/([^/]+)\/changes$/,
    ([id], q) => {
      const status = q.get("status");
      const lane = q.get("lane");
      const changes = db.scenarios
        .map((s) => s.change)
        .filter((c) => c.repoId === id)
        .filter((c) => !status || c.status === status)
        .filter((c) => !lane || String(c.lane) === lane)
        .map(summary);
      return ok({ changes });
    },
  ],

  [
    "GET",
    /^\/api\/v1\/changes\/([^/]+)$/,
    ([id]) => {
      const s = scenarioById(id!);
      if (!s) return fail(404, "not_found", "No such change.");
      const detail: ChangeDetail = {
        change: s.change,
        plan: s.change.planId ? (db.plans.find((p) => p.id === s.change.planId) ?? null) : null,
        runs: s.runs,
        classification: classification(s.change),
      };
      return ok(detail);
    },
  ],

  ["GET", /^\/api\/v1\/changes\/([^/]+)\/diff$/, ([id]) => withScenario(id, (s) => ok({ diff: s.diff }))],

  [
    "GET",
    /^\/api\/v1\/changes\/([^/]+)\/evidence$/,
    ([id]) =>
      withScenario(id, (s) =>
        s.evidence ? ok({ evidence: s.evidence, verification: s.verification }) : fail(404, "evidence_not_ready", "Evidence is signed when the pipeline finishes."),
      ),
  ],

  [
    "GET",
    /^\/api\/v1\/changes\/([^/]+)\/tour$/,
    ([id]) => withScenario(id, (s) => (s.tour ? ok({ tour: s.tour }) : fail(404, "tour_not_ready", "The reviewer agent writes the tour after the pipeline passes."))),
  ],

  ["GET", /^\/api\/v1\/changes\/([^/]+)\/resolution$/, ([id]) => withScenario(id, (s) => ok({ resolution: s.resolution ?? null }))],

  [
    "POST",
    /^\/api\/v1\/changes\/([^/]+)\/review$/,
    ([id], _q, body) =>
      withScenario(id, (s) => {
        const c = s.change;
        if (c.authorId === db.me) return fail(403, "own_change", "You authored this change, so someone else has to review it.");
        if (c.status !== "awaiting-review") return fail(409, "not_reviewable", `This change is ${c.status}, not awaiting review.`);
        const input = parseBody<{ decision: ReviewDecisionKind; humanLane: Lane; comment: string }>(body);
        if (input.decision !== "approve" && !input.comment?.trim()) {
          return fail(400, "comment_required", "Tell the author what to change.");
        }
        const next: Record<ReviewDecisionKind, Change["status"]> = { approve: "approved", "request-changes": "awaiting-push", reject: "rejected" };
        c.status = input.decision ? next[input.decision] : c.status;
        c.updatedAt = new Date().toISOString();
        if (input.humanLane !== undefined && c.computedLane === 0) {
          const repo = db.repos.find((r) => r.repo.id === c.repoId);
          if (repo) {
            repo.shadow.samples += 1;
            if (input.humanLane === 0) repo.shadow.agreed += 1;
            repo.shadow.needed = Math.max(0, repo.shadow.needed - 1);
            repo.shadow.ratio = repo.shadow.needed > 0 ? null : repo.shadow.agreed / repo.shadow.samples;
            repo.shadow.eligibleToEnableLane0 = repo.shadow.ratio !== null && repo.shadow.ratio >= repo.shadow.threshold;
          }
        }
        appendAudit(db.me, `review.${input.decision ?? "approve"}`, `change:${c.id}`);
        return ok({ change: c });
      }),
  ],

  [
    "GET",
    /^\/api\/v1\/changes\/([^/]+)\/rollout$/,
    ([id]) => withScenario(id, (s) => ok({ rollout: s.change.rolloutState, timeline: s.timeline ?? db.audit.filter((e) => e.subject === `change:${s.change.id}`) })),
  ],

  [
    "POST",
    /^\/api\/v1\/changes\/([^/]+)\/kill$/,
    ([id], _q, body) =>
      withScenario(id, (s) => {
        const c = s.change;
        const { reason } = parseBody<{ reason: string }>(body);
        if (!reason?.trim()) return fail(400, "reason_required", "Give a reason; it goes into the audit log and the revert change.");
        if (!c.rolloutState || !["rolling", "watching", "pending"].includes(c.rolloutState.status)) {
          return fail(409, "not_rolling_out", "Only a change that is rolling out or being watched can be killed.");
        }
        const revertId = `chg_rv${c.id.slice(4, 8)}`;
        c.rolloutState.status = "rolled-back";
        c.status = "reverted";
        c.revertedBy = revertId;
        c.updatedAt = new Date().toISOString();
        if (!scenarioById(revertId)) {
          const revert: Change = {
            ...structuredClone(c),
            id: revertId,
            title: `Revert “${c.title}”`,
            claim: { category: "revert", summary: reason },
            authorId: "prn_platform",
            status: "queued",
            computedLane: 0,
            lane: 0,
            laneReasons: [{ code: "revert.verified", lane: 0, message: `Exact inverse of ${c.id}.` }],
            revertOf: c.id,
            revertedBy: null,
            rolloutState: null,
            flagKey: null,
            mergedSha: null,
            headSha: sha(`${revertId}:head`),
            evidenceId: null,
            tourId: null,
            planId: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          db.scenarios.push({
            change: revert,
            diff: { baseSha: c.baseSha, headSha: revert.headSha!, files: [], additions: 0, deletions: 0 },
            tour: null,
            evidence: null,
            verification: { ok: false, reason: "Evidence is signed when the revert's pipeline finishes." },
            runs: [],
            issues: [],
          });
        }
        appendAudit(db.me, "rollout.killed", `change:${c.id}`);
        appendAudit("prn_platform", "flag.disabled", `change:${c.id}`);
        appendAudit("prn_platform", "revert.opened", `change:${revertId}`);
        return ok({ change: c });
      }),
  ],

  ["GET", /^\/api\/v1\/changes\/([^/]+)\/issues$/, ([id]) => withScenario(id, (s) => ok({ issues: s.issues }))],

  [
    "GET",
    /^\/api\/v1\/audit$/,
    (_p, q) => {
      const subject = q.get("subject")?.trim() ?? "";
      const limit = Math.min(100, Number(q.get("limit") ?? 25) || 25);
      const cursor = q.get("cursor");
      const newestFirst = [...db.audit].reverse();
      const filtered = subject ? newestFirst.filter((e) => e.subject.includes(subject) || e.action.includes(subject)) : newestFirst;
      const start = cursor ? filtered.findIndex((e) => e.seq < Number(cursor)) : 0;
      const page = start < 0 ? [] : filtered.slice(start, start + limit);
      const last = page[page.length - 1];
      const more = start >= 0 && start + limit < filtered.length;
      const ids = new Set(page.map((e) => e.principalId));
      const body: AuditPage = {
        events: page,
        nextCursor: more && last ? String(last.seq) : null,
        chain: { verified: true },
        principals: Object.fromEntries([...ids].map((id) => [id, principalRef(db.principals, id)])),
      };
      return ok(body);
    },
  ],
];

function withScenario(id: string | undefined, fn: (s: Scenario) => RawResponse): RawResponse {
  const s = id ? scenarioById(id) : undefined;
  return s ? fn(s) : fail(404, "not_found", "No such change.");
}

// Claim links are readable signed out, so they are answered before the session check in route().
const claims = createClaimMock({
  viewer: () => (signedIn() ? { signedIn: true, principalId: db.me, name: me().name } : { signedIn: false, principalId: null, name: null }),
});

export async function handle(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<RawResponse> {
  await wait(latency(method));
  if (path.startsWith("/api/v1/claims/")) return claims.handle(method, path, body);
  const replayKey = method !== "GET" && idempotencyKey ? `${method} ${path} ${idempotencyKey}` : null;
  const replay = replayKey ? idempotent.get(replayKey) : undefined;
  if (replay) return structuredClone(replay);
  const res = route(method, path, body);
  if (replayKey && res.status < 500) idempotent.set(replayKey, structuredClone(res));
  return res;
}

function route(method: string, path: string, body: unknown): RawResponse {
  const url = new URL(path, window.location.origin);
  if (url.pathname !== "/api/v1/me" && !signedIn()) return fail(401, "unauthenticated", "Sign in to continue.");
  if (url.pathname === "/api/v1/me" && !signedIn()) return fail(401, "unauthenticated", "Sign in to continue.");
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const match = pattern.exec(url.pathname);
    if (match) return handler(match.slice(1).map(decodeURIComponent), url.searchParams, body);
  }
  return fail(404, "not_found", `No mock route for ${method} ${url.pathname}.`);
}

const ARTIFACTS: Record<string, string> = {
  "shot:invoice-before": invoiceBefore,
  "shot:invoice-after": invoiceAfter,
};

export function artifactUrl(ref: string): string {
  return ARTIFACTS[ref] ?? "";
}

/** Exposed for the demo banner. */
export const MOCK_GENERATED_AT = ago(0);
