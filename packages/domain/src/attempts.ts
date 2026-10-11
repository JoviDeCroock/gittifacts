/**
 * Comparing attempts at one Plan (pure: no I/O, no clocks, no randomness).
 *
 * Several agents may attempt the same approved Plan, each its own Change. `rankAttempts` orders
 * them by what the machines proved (lane, CI, tests, red/green, scope, coverage, mutation, public
 * API, diff size, time to green) so a person can pick one. Unknown escalates: a missing or errored
 * signal ranks below a measured good one, never above it, and an attempt still grading is never
 * recommended over a finished one.
 */
import { Sha } from "@app/evidence";
import { z } from "zod";
import { ChangeStatus, Id, IsoDate, Lane } from "./model.js";

export const AttemptCi = z.enum(["passed", "failed", "unknown"]);
export type AttemptCi = z.infer<typeof AttemptCi>;

export const AttemptTests = z.object({
  state: z.enum(["passed", "failing", "unknown"]),
  passed: z.number().int().nonnegative().nullable(),
  failed: z.number().int().nonnegative().nullable(),
});
export type AttemptTests = z.infer<typeof AttemptTests>;

export const AttemptRedGreen = z.enum(["proven", "not-required", "not-proven", "unknown"]);
export type AttemptRedGreen = z.infer<typeof AttemptRedGreen>;

export const AttemptScope = z.object({
  state: z.enum(["within", "not-applicable", "drift", "unknown"]),
  /** The classifier's words for a drift ("Files outside the plan's scopePaths: …"). */
  detail: z.string().max(500).nullable(),
});
export type AttemptScope = z.infer<typeof AttemptScope>;

export const AttemptPublicApi = z.enum(["none", "additive", "breaking", "unknown"]);
export type AttemptPublicApi = z.infer<typeof AttemptPublicApi>;

/** What the platform knows about one attempt (one Change on the Plan) at its current head. */
export const AttemptFacts = z.object({
  changeId: Id,
  title: z.string().min(1).max(200),
  status: ChangeStatus,
  headSha: Sha.nullable(),
  lane: Lane.nullable(),
  author: z.object({
    id: Id,
    name: z.string(),
    kind: z.enum(["human", "agent", "system", "integration"]),
  }),
  ci: AttemptCi,
  tests: AttemptTests,
  redGreen: AttemptRedGreen,
  scope: AttemptScope,
  publicApi: AttemptPublicApi,
  /** Changed-line coverage ratio (0–1); null: not measured. */
  coverage: z.number().min(0).max(1).nullable(),
  /** Mutation score (0–1); null: not measured. */
  mutation: z.number().min(0).max(1).nullable(),
  /** Added + deleted lines and files at the head; null: no diff yet. */
  diff: z
    .object({ lines: z.number().int().nonnegative(), files: z.number().int().nonnegative() })
    .nullable(),
  /** From the Change's start to its green CI run's end; null: not green (yet). */
  timeToGreenMs: z.number().int().nonnegative().nullable(),
  startedAt: IsoDate,
});
export type AttemptFacts = z.infer<typeof AttemptFacts>;

/** Where an attempt stands: graded (finished), still being graded, or closed. */
export const AttemptStanding = z.enum(["finished", "grading", "closed"]);
export type AttemptStanding = z.infer<typeof AttemptStanding>;

export const RankedAttempt = AttemptFacts.extend({
  rank: z.number().int().min(1),
  standing: AttemptStanding,
  /** CI passed and no test fails: the attempt can be recommended. */
  green: z.boolean(),
  /** Short, human-readable: "Lane 1", "tests pass (12)", "red/green proven", "42 lines". */
  reasons: z.array(z.string()),
  recommended: z.boolean(),
  /** A person can pick it now (it is awaiting review, or already approved). */
  pickable: z.boolean(),
});
export type RankedAttempt = z.infer<typeof RankedAttempt>;

export const AttemptsRanking = z.object({
  attempts: z.array(RankedAttempt),
  recommended: z
    .object({
      changeId: Id,
      /** True when nothing has finished grading yet: it leads so far, it isn't proven. */
      provisional: z.boolean(),
      why: z.string(),
    })
    .nullable(),
  /** One line for people: "3 attempts: 2 finished, 1 still grading". */
  summary: z.string(),
});
export type AttemptsRanking = z.infer<typeof AttemptsRanking>;

// ---------------------------------------------------------------- facts from lane reasons

/** The lane-reason codes one attempt carries (the classifier's stable catalogue). */
export interface AttemptSignals {
  ci: AttemptCi;
  testsState: AttemptTests["state"];
  redGreen: AttemptRedGreen;
  scope: AttemptScope;
  publicApi: AttemptPublicApi;
}

const has = (codes: ReadonlySet<string>, ...want: string[]) => want.some((c) => codes.has(c));

/**
 * Signals from a Change's lane reasons (the classifier already weighed the evidence) and its
 * status. Anything the reasons don't settle is `unknown`; a failing Change without a CI reason
 * yet failed CI (the platform marks it failing before it classifies).
 */
export function signalsFromReasons(
  reasons: ReadonlyArray<{ code: string; message: string }>,
  status: ChangeStatus,
): AttemptSignals {
  const codes = new Set(reasons.map((r) => r.code));
  const ci: AttemptCi = codes.has("ci.passed")
    ? "passed"
    : codes.has("ci.failed")
      ? "failed"
      : status === "failing" && !has(codes, "ci.errored", "ci.cancelled", "ci.unknown")
        ? "failed"
        : "unknown";
  const testsState: AttemptTests["state"] = codes.has("tests.failing")
    ? "failing"
    : has(codes, "signal.missing.test-run", "signal.error.test-run")
      ? "unknown"
      : has(codes, "tests.passed", "tests.preexisting")
        ? "passed"
        : "unknown";
  const redGreen: AttemptRedGreen = has(codes, "red-green.not-proven", "red-green.no-tests")
    ? "not-proven"
    : has(codes, "signal.missing.red-green", "signal.error.red-green")
      ? "unknown"
      : codes.has("red-green.proven")
        ? "proven"
        : codes.has("red-green.not-required")
          ? "not-required"
          : "unknown";
  const drift = reasons.find((r) => r.code === "scope.drift" || r.code === "scope.out-of-scope");
  const scope: AttemptScope = drift
    ? { state: "drift", detail: drift.message.slice(0, 500) }
    : has(codes, "plan.scope-undeclared", "signal.missing.diff-stats")
      ? { state: "unknown", detail: null }
      : codes.has("scope.within")
        ? { state: "within", detail: null }
        : codes.has("scope.not-applicable")
          ? { state: "not-applicable", detail: null }
          : { state: "unknown", detail: null };
  const publicApi: AttemptPublicApi = codes.has("api.breaking")
    ? "breaking"
    : has(codes, "signal.missing.public-api", "signal.error.public-api")
      ? "unknown"
      : codes.has("api.additive")
        ? "additive"
        : codes.has("api.none")
          ? "none"
          : "unknown";
  return { ci, testsState, redGreen, scope, publicApi };
}

// ---------------------------------------------------------------- ranking

const CLOSED: ReadonlySet<ChangeStatus> = new Set(["abandoned", "rejected", "reverted"]);
const GRADING: ReadonlySet<ChangeStatus> = new Set(["awaiting-push", "running"]);
const PICKABLE: ReadonlySet<ChangeStatus> = new Set(["awaiting-review", "approved", "queued"]);

export function standingOf(a: Pick<AttemptFacts, "status">): AttemptStanding {
  if (CLOSED.has(a.status)) return "closed";
  if (GRADING.has(a.status)) return "grading";
  return "finished";
}

const isGreen = (a: AttemptFacts) => a.ci === "passed" && a.tests.state !== "failing";

/** Finished and green, finished but not green, still grading, closed. */
function tier(a: AttemptFacts): number {
  const s = standingOf(a);
  if (s === "finished") return isGreen(a) ? 0 : 1;
  return s === "grading" ? 2 : 3;
}

const pct = (x: number) => Math.round(x * 100);
/** Higher is better; not measured is worst. Compared at whole percents, so noise doesn't decide. */
const ratioKey = (x: number | null) => (x === null ? 2 : 1 - pct(x) / 100);

/** Every key ascending: the lower, the better. */
function keys(a: AttemptFacts): number[] {
  return [
    tier(a),
    a.lane ?? 3,
    { passed: 0, unknown: 1, failing: 2 }[a.tests.state],
    { passed: 0, unknown: 1, failed: 2 }[a.ci],
    { proven: 0, "not-required": 0, unknown: 1, "not-proven": 2 }[a.redGreen],
    { within: 0, "not-applicable": 0, unknown: 1, drift: 2 }[a.scope.state],
    ratioKey(a.coverage),
    ratioKey(a.mutation),
    { none: 0, additive: 1, unknown: 2, breaking: 3 }[a.publicApi],
    a.diff?.lines ?? Number.POSITIVE_INFINITY,
    a.timeToGreenMs ?? Number.POSITIVE_INFINITY,
  ];
}

export function compareAttempts(a: AttemptFacts, b: AttemptFacts): number {
  const ka = keys(a);
  const kb = keys(b);
  for (let i = 0; i < ka.length; i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d !== 0 && !Number.isNaN(d)) return d < 0 ? -1 : 1;
  }
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? -1 : 1;
  return a.changeId < b.changeId ? -1 : a.changeId > b.changeId ? 1 : 0;
}

/** "4m 10s", "52s", "1h 3m". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The short reasons a person reads on the attempt's card, best known first. */
export function attemptReasons(a: AttemptFacts): string[] {
  const standing = standingOf(a);
  const done = standing === "finished";
  const out: string[] = [];
  if (standing === "grading") out.push("still grading");
  if (standing === "closed") out.push("closed");
  out.push(a.lane === null ? "no lane yet" : `Lane ${a.lane}`);
  if (a.ci === "failed") out.push("CI failed");
  else if (a.ci === "unknown" && done) out.push("CI not measured");
  if (a.tests.state === "passed")
    out.push(a.tests.passed === null ? "tests pass" : `tests pass (${a.tests.passed})`);
  else if (a.tests.state === "failing")
    out.push(
      a.tests.failed === null ? "tests failing" : `${plural(a.tests.failed, "test")} failing`,
    );
  else if (done) out.push("tests not measured");
  if (a.redGreen === "proven") out.push("red/green proven");
  else if (a.redGreen === "not-proven") out.push("red/green not proven");
  else if (a.redGreen === "unknown" && done) out.push("red/green not measured");
  if (a.scope.state === "drift") out.push("scope drift");
  else if (a.scope.state === "within") out.push("within plan scope");
  else if (a.scope.state === "unknown" && done) out.push("scope not checked");
  if (a.coverage !== null) out.push(`coverage ${pct(a.coverage)}%`);
  if (a.mutation !== null) out.push(`mutation ${pct(a.mutation)}%`);
  if (a.publicApi === "breaking") out.push("breaks public API");
  else if (a.publicApi === "additive") out.push("adds public API");
  else if (a.publicApi === "unknown" && done) out.push("public API not measured");
  if (a.diff !== null) out.push(plural(a.diff.lines, "line"));
  if (a.timeToGreenMs !== null && a.ci === "passed")
    out.push(`green in ${formatDuration(a.timeToGreenMs)}`);
  return out;
}

/**
 * Rank the attempts at one Plan, best first. The recommendation is the best finished green
 * attempt; when nothing has finished grading, the attempt leading so far (provisional); when
 * everything finished but nothing is green, none.
 */
export function rankAttempts(facts: readonly AttemptFacts[]): AttemptsRanking {
  const sorted = [...facts].sort(compareAttempts);
  const best = sorted.find((a) => tier(a) === 0);
  const anyFinished = sorted.some((a) => standingOf(a) === "finished");
  const leading = !anyFinished ? sorted.find((a) => standingOf(a) === "grading") : undefined;
  const pick = best ?? leading;
  const attempts: RankedAttempt[] = sorted.map((a, i) => ({
    ...a,
    rank: i + 1,
    standing: standingOf(a),
    green: isGreen(a),
    reasons: attemptReasons(a),
    recommended: pick !== undefined && a.changeId === pick.changeId,
    pickable: PICKABLE.has(a.status),
  }));
  const count = (s: AttemptStanding) => attempts.filter((a) => a.standing === s).length;
  const parts = [
    count("finished") > 0 ? `${count("finished")} finished` : null,
    count("grading") > 0 ? `${count("grading")} still grading` : null,
    count("closed") > 0 ? `${count("closed")} closed` : null,
  ].filter((p): p is string => p !== null);
  const summary = `${plural(attempts.length, "attempt")}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`;
  const top = attempts.find((a) => a.recommended);
  const recommended =
    top === undefined
      ? null
      : {
          changeId: top.changeId,
          provisional: best === undefined,
          why:
            best === undefined
              ? `Nothing has finished grading; this one leads so far: ${top.reasons.slice(1).join(" · ")}`
              : `Best evidence of ${plural(count("finished"), "finished attempt")}: ${top.reasons.join(" · ")}`,
        };
  return { attempts, recommended, summary };
}
