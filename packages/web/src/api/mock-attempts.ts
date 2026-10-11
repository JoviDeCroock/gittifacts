/**
 * Mock mode's attempts at one plan: `GET /api/v1/plans/:planId/attempts` and
 * `POST /api/v1/plans/:planId/attempts/:changeId/pick`, over the mock database. The ranking is the
 * domain's own `rankAttempts`, so the demo orders attempts by the server's rules. Picking approves
 * the attempt (same rules as the review route: never your own, awaiting review or already
 * approved, at the head you saw) and closes the other open attempts as superseded.
 */
import { type AttemptFacts, rankAttempts, signalsFromReasons } from "@app/domain/attempts";
import type { Change } from "@app/domain";
import type { PlanAttemptsView, PickResult, PickedAttempt } from "./attempts.js";
import type { RawResponse } from "./client.js";
import type { MockDb } from "./fixtures.js";
import { principalRef } from "./fixtures.js";
import type { Scenario } from "./scenario-kit.js";

const picks = new Map<string, PickedAttempt>();

const FIX: Record<string, string> = {
  not_found: "Check the link, or go back to the plan.",
  "already-picked": "Reload the plan to see which attempt was picked.",
  "invalid-state": "Only an attempt awaiting review, or already approved, can be picked. Reload the plan.",
  own_change: "Ask a teammate with the change:review scope to pick.",
  "head-moved": "Reload the plan and look at the new head before you pick.",
};

const ok = (body: unknown): RawResponse => ({ status: 200, body: structuredClone(body) });
const fail = (status: number, code: string, message: string): RawResponse => ({
  status,
  body: { error: { code, message, fix: { explanation: FIX[code] ?? "Retry, or reload the page." } } },
});

/** What the platform knows about one attempt, from its lane reasons, evidence, run and diff. */
export function factsOf(s: Scenario, author: AttemptFacts["author"]): AttemptFacts {
  const c = s.change;
  const sig = signalsFromReasons(c.laneReasons, c.status);
  const items = s.evidence?.items ?? [];
  const run = s.runs.find((r) => r.headSha === c.headSha) ?? s.runs[0];
  const ci = sig.ci !== "unknown" ? sig.ci : run?.status === "passed" ? "passed" : run?.status === "failed" ? "failed" : "unknown";
  const tr = items.find((i) => i.kind === "test-run");
  const tests: AttemptFacts["tests"] =
    tr?.kind === "test-run" ? { state: tr.failed > 0 ? "failing" : "passed", passed: tr.passed, failed: tr.failed } : { state: sig.testsState, passed: null, failed: null };
  const rg = items.find((i) => i.kind === "red-green");
  const redGreen = sig.redGreen !== "unknown" || rg?.kind !== "red-green" ? sig.redGreen : rg.verdict === "proven" ? "proven" : "not-proven";
  const cov = items.find((i) => i.kind === "coverage");
  const api = items.find((i) => i.kind === "public-api");
  const publicApi = sig.publicApi !== "unknown" || api?.kind !== "public-api" ? sig.publicApi : api.classification;
  const finished = run?.finishedAt ? Date.parse(run.finishedAt) - Date.parse(c.createdAt) : null;
  return {
    changeId: c.id,
    title: c.title,
    status: c.status,
    headSha: c.headSha,
    lane: c.lane,
    author,
    ci,
    tests,
    redGreen,
    scope: sig.scope,
    publicApi,
    coverage: cov?.kind === "coverage" ? cov.ratio : null,
    mutation: null,
    diff: c.headSha ? { lines: s.diff.additions + s.diff.deletions, files: s.diff.files.length } : null,
    timeToGreenMs: ci === "passed" && finished !== null && finished >= 0 ? finished : null,
    startedAt: c.createdAt,
  };
}

function onPlan(db: MockDb, planId: string): Scenario[] {
  return db.scenarios.filter((s) => s.change.planId === planId);
}

function authorOf(db: MockDb, id: string): AttemptFacts["author"] {
  const p = principalRef(db.principals, id);
  return { id: p.id, name: p.name, kind: p.kind };
}

export function listAttempts(db: MockDb, planId: string): RawResponse {
  if (!db.plans.some((p) => p.id === planId)) return fail(404, "not_found", "No such plan.");
  const ranking = rankAttempts(onPlan(db, planId).map((s) => factsOf(s, authorOf(db, s.change.authorId))));
  const view: PlanAttemptsView = { planId, ...ranking, picked: picks.get(planId) ?? null };
  return ok(view);
}

/** Attempts the pick closes: still open and not yet in the merge queue. */
const CLOSABLE: ReadonlySet<Change["status"]> = new Set(["awaiting-push", "running", "failing", "awaiting-review", "approved"]);
const DONE: ReadonlySet<Change["status"]> = new Set(["abandoned", "rejected", "reverted", "merged", "rolling-out", "released"]);

export function pickAttempt(
  db: MockDb,
  planId: string,
  changeId: string,
  body: { headSha?: string; comment?: string },
  audit: (principalId: string, action: string, subject: string) => void,
): RawResponse {
  const plan = db.plans.find((p) => p.id === planId);
  if (!plan) return fail(404, "not_found", "No such plan.");
  if (plan.status !== "approved") return fail(409, "invalid-state", `This plan is ${plan.status}; only an approved plan's attempts can be picked.`);
  const attempts = onPlan(db, planId);
  const s = attempts.find((a) => a.change.id === changeId);
  if (!s) return fail(404, "not_found", "That change is not an attempt at this plan.");
  const c = s.change;
  const prior = picks.get(planId);
  if (prior && prior.changeId !== changeId) return fail(409, "already-picked", "Another attempt at this plan was already picked.");
  if (c.authorId === db.me) return fail(403, "own_change", "You authored this attempt, so someone else has to pick it.");
  if (c.status !== "awaiting-review" && c.status !== "approved" && c.status !== "queued") return fail(409, "invalid-state", `This attempt is ${c.status}, not awaiting review.`);
  if (body.headSha && c.headSha && body.headSha !== c.headSha) return fail(409, "head-moved", "The attempt has a new head since you looked.");

  const now = new Date().toISOString();
  const approved = c.status === "awaiting-review";
  if (approved) {
    c.status = "approved";
    c.updatedAt = now;
    audit(db.me, "review.approve", `change:${c.id}`);
  }
  const me = principalRef(db.principals, db.me);
  const picked: PickedAttempt = prior ?? { changeId, by: { id: me.id, name: me.name }, at: now };
  picks.set(planId, picked);
  const superseded: PickResult["superseded"] = [];
  const notClosed: PickResult["notClosed"] = [];
  for (const other of attempts) {
    const o = other.change;
    if (o.id === changeId || DONE.has(o.status)) continue;
    if (!CLOSABLE.has(o.status)) {
      notClosed.push({ changeId: o.id, error: `It is ${o.status} and stays in the merge queue.` });
      continue;
    }
    o.status = "abandoned";
    o.updatedAt = now;
    superseded.push({ changeId: o.id, title: o.title, status: o.status });
    audit(db.me, "change.superseded", `change:${o.id}`);
  }
  if (!prior) audit(db.me, "plan.attempt-picked", `plan:${planId}`);
  const result: PickResult = { planId, picked, change: c, approved, superseded, notClosed };
  return ok(result);
}
