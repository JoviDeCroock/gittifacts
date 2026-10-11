/**
 * Attempts at one Plan: several agents may attempt the same approved Plan, each its own Change.
 * `compareAttempts` gathers what the platform already knows about each (lane reasons, sealed
 * evidence, the diff, the green run) and ranks them with @app/domain's pure `rankAttempts`.
 * `pickAttempt` is a person picking one: it approves that Change through the normal review path
 * and closes the other open attempts as superseded (services/attempts-pick.ts).
 *
 * Unknown escalates: a fact that can't be read is left unknown (it ranks below a measured one),
 * never guessed. Bounded: the newest MAX_ATTEMPTS Changes on the plan, one diff read each.
 */
import {
  type AttemptFacts,
  type AttemptsRanking,
  type Change,
  type Evidence,
  rankAttempts,
  signalsFromReasons,
} from "@app/domain";
import { newFailureCount } from "@app/evidence";
import { assertPlanAccess } from "../access/access.js";
import type { Caller, Services } from "../app-env.js";
import type { PlanPick, PrincipalRef } from "../store/d1-store.js";

/** At most this many attempts are compared (the newest). */
export const MAX_ATTEMPTS = 20;

export interface PickedView {
  changeId: string;
  by: { id: string; name: string };
  at: string;
}

export type AttemptsView = AttemptsRanking & { planId: string; picked: PickedView | null };

async function quietly<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`compare_attempts: ${what} failed`, err);
    return null;
  }
}

function evidenceNumbers(evidence: Evidence | null) {
  if (evidence === null) return { passed: null, failed: null, coverage: null, mutation: null };
  let passed: number | null = null;
  let failed: number | null = null;
  let coverage: number | null = null;
  let mutation: number | null = null;
  for (const item of evidence.items) {
    if (item.kind === "test-run" && item.status === "ok") {
      passed = (passed ?? 0) + item.passed;
      failed = (failed ?? 0) + newFailureCount(item, evidence.baseSha);
    } else if (item.kind === "coverage" && item.status === "ok") {
      coverage = coverage === null ? item.ratio : Math.min(coverage, item.ratio);
    } else if (item.kind === "mutation" && item.status === "ok") {
      mutation = mutation === null ? item.score : Math.min(mutation, item.score);
    }
  }
  return { passed, failed, coverage, mutation };
}

/** What the platform knows about one attempt at its current head. */
export async function attemptFacts(
  svc: Services,
  change: Change,
  author: PrincipalRef | undefined,
): Promise<AttemptFacts> {
  const signals = signalsFromReasons(change.laneReasons, change.status);
  const head = change.headSha;
  const [evidence, diff, runs] = await Promise.all([
    head !== null && change.evidenceId !== null
      ? quietly("evidence", () => svc.store.getEvidence(change.id, head))
      : Promise.resolve(null),
    head !== null
      ? quietly("diff", () => svc.store.getDiff(change.id, head))
      : Promise.resolve(null),
    head !== null && signals.ci === "passed"
      ? quietly("runs", () => svc.store.listRuns(change.id, head))
      : Promise.resolve(null),
  ]);
  const n = evidenceNumbers(evidence);
  const green = runs?.find((r) => r.status === "passed" && r.finishedAt !== null);
  const ttg =
    green?.finishedAt == null ? null : Date.parse(green.finishedAt) - Date.parse(change.createdAt);
  return {
    changeId: change.id,
    title: change.title,
    status: change.status,
    headSha: head,
    lane: change.lane,
    author: {
      id: change.authorId,
      name: author?.name ?? change.authorId,
      kind: author?.kind ?? "agent",
    },
    ci: signals.ci,
    tests: { state: signals.testsState, passed: n.passed, failed: n.failed },
    redGreen: signals.redGreen,
    scope: signals.scope,
    publicApi: signals.publicApi,
    coverage: n.coverage,
    mutation: n.mutation,
    diff:
      diff === null ? null : { lines: diff.additions + diff.deletions, files: diff.files.length },
    timeToGreenMs: ttg !== null && Number.isFinite(ttg) && ttg >= 0 ? Math.round(ttg) : null,
    startedAt: change.createdAt,
  };
}

export async function pickedView(svc: Services, pick: PlanPick | null): Promise<PickedView | null> {
  if (pick === null) return null;
  const refs = await svc.store.principalRefs([pick.pickedBy]);
  return {
    changeId: pick.changeId,
    by: { id: pick.pickedBy, name: refs[pick.pickedBy]?.name ?? pick.pickedBy },
    at: pick.pickedAt,
  };
}

/** Rank the attempts at a plan (read access to its repo). */
export async function compareAttempts(
  svc: Services,
  caller: Caller,
  planId: string,
): Promise<AttemptsView> {
  await assertPlanAccess(svc, caller.principal, planId, "read");
  return rankPlanAttempts(svc, planId);
}

/** The ranking without an access check (callers check first). */
export async function rankPlanAttempts(svc: Services, planId: string): Promise<AttemptsView> {
  const changes = (await svc.store.listChangesForPlan(planId)).slice(0, MAX_ATTEMPTS);
  const [refs, pick] = await Promise.all([
    svc.store.principalRefs(changes.map((c) => c.authorId)),
    svc.store.getPlanPick(planId),
  ]);
  const facts = await Promise.all(changes.map((c) => attemptFacts(svc, c, refs[c.authorId])));
  return { planId, ...rankAttempts(facts), picked: await pickedView(svc, pick) };
}
