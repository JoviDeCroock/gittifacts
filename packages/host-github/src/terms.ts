/**
 * Every user-facing word gittifacts writes on a GitHub pull request (check run, summary comment,
 * walkthrough review), in one place, so a rename of a product term is one edit here. The terms
 * follow docs/ux-review/terminology-2026-10-04.md as the user decided it: lanes are named
 * "Auto-merge · Quick review · Full review" with "(Lane N)" as a badge, GitHub mode is
 * "Report-only", the tour is a "walkthrough", and the check-run button approves the change.
 * Machine names stay (the `tour` field, the `approve_tour` action id, the `gittifacts/lane` name).
 */
import type { Lane, LaneReason } from "@app/domain";

export const TERMS = {
  product: "gittifacts",
  laneBadge: (n: Lane) => `Lane ${n}`,
  laneName: { 0: "Auto-merge", 1: "Quick review", 2: "Full review" } as Record<Lane, string>,
  /** What a person has to do, per lane. */
  laneAsk: {
    0: "Nothing for a person to do: the evidence decides.",
    1: "A person reads the walkthrough and approves the change.",
    2: "A person reads the diff, with the walkthrough as a guide.",
  } as Record<Lane, string>,
  /** A Lane 0 that still needs a person (it changes .platform/). */
  policyAsk: "A person who is not the author approves it (it changes gittifacts policy).",
  tour: "walkthrough",
  stop: "stop",
  plan: "Plan",
  reportOnly: "Report-only",
  reportOnlyNote: "Report-only: gittifacts grades this pull request but never blocks, approves or merges it.",
  /** Shadow raised a Lane 0 to a person: auto-merge is calibrating on this repo. */
  calibrating: "auto-merge is calibrating",
  calibratingLong: "the evidence says auto-merge, but auto-merge is still calibrating on this repo",
  blockedWhy: "CI failed or the evidence did not verify",
  /** Stop verdicts as a reader sees them. */
  verdict: { proven: "Proven", unproven: "Not proven", risk: "Risk" },
  uncovered: "Not covered by tests",
  openTour: "Open the walkthrough",
  approveButton: { label: "Approve change", description: "Approve this change on gittifacts" },
  fullReviewButton: { label: "Request full review", description: "Ask for a full human review" },
} as const;

/** "Full review (Lane 2)" */
export const laneLabel = (lane: Lane): string => `${TERMS.laneName[lane]} (${TERMS.laneBadge(lane)})`;

const words = (s: string) => s.replace(/-/g, " ");

/** Short phrases per reason code (fits a check-run title after "Full review (Lane 2) · "). */
const PHRASE: Record<string, string> = {
  "api.breaking": "breaking public API change",
  "api.additive": "public API changed",
  "dependency.added": "new dependency",
  "dependency.removed": "dependency removed",
  "dependency.major": "major dependency upgrade",
  "dependency.minor": "dependency upgrade",
  "dependency.patch": "dependency patch",
  "dependency.patch-not-allowed": "dependency upgrade",
  "dependency.other-bump": "dependency upgrade",
  "dependency.prerelease": "prerelease dependency",
  "dependency.install-script": "dependency runs an install script",
  "dependency.lockfile-only": "lockfile changed",
  "sensitive.hit": "touches sensitive files",
  "migration.touched": "database migration changed",
  "policy.changed": "changes gittifacts policy",
  "plan.missing": "no Plan linked",
  "plan.not-approved": "Plan not approved yet",
  "plan.scope-undeclared": "Plan names no files",
  "scope.drift": "goes beyond its Plan",
  "scope.out-of-scope": "goes beyond its Plan",
  "size.lines-over-lane0": "too large to auto-merge",
  "size.files-over-lane0": "too many files to auto-merge",
  "size.lines-over-lane1": "large change",
  "size.files-over-lane1": "touches many files",
  "coverage.below-threshold": "changed lines not covered by tests",
  "mutation.below-threshold": "tests miss injected bugs",
  "mutation.no-coverage": "tests miss injected bugs",
  "red-green.not-proven": "no test fails before the change",
  "red-green.no-tests": "no test shows the fix",
  "tests.failing": "tests fail",
  "tests.quarantined": "a flaky test is involved",
  "ci.failed": "CI failed",
  "ci.errored": "CI did not finish",
  "ci.cancelled": "CI was cancelled",
  "ci.unknown": "CI result unknown",
  "evidence.unverified": "evidence did not verify",
  "budget.exceeded": "AI budget used up",
  "tour.failed": "no tour could be written",
  "transform.mismatch": "codemod output differs",
  "transform.unverified": "codemod not verified",
  "shadow.lane0-disabled": "auto-merge is calibrating",
};

/** One short phrase for a reason ("possible hidden behavior change", "public API changed"). */
export function reasonPhrase(r: Pick<LaneReason, "code" | "message">): string {
  const known = PHRASE[r.code];
  if (known !== undefined) return known;
  if (r.code === "llm.concern" || r.code === "llm.unsure") {
    const q = /Model judgment on ([a-z-]+)/.exec(r.message)?.[1];
    const what = q === undefined ? "a concern" : words(q);
    return r.code === "llm.concern" ? `possible ${what}` : `unsure about ${what}`;
  }
  const m = /^signal\.(missing|error)\.(.+)$/.exec(r.code);
  // Unknown escalates: say plainly that something was not measured.
  if (m !== null) return `${words(m[2] ?? "a check")} ${m[1] === "error" ? "failed to run" : "did not run"}`;
  return words(r.code.split(".")[0] ?? r.code);
}

/** The reason that decides the lane: the first raised reason at the computed lane. */
export function decisiveReason<R extends Pick<LaneReason, "code" | "message" | "lane">>(reasons: readonly R[]): R | null {
  const top = reasons.reduce((n, r) => Math.max(n, r.lane), 0);
  return top === 0 ? null : (reasons.find((r) => r.lane === top) ?? null);
}

/** The one-line why: "possible hidden behavior change", or the calibrating line for a raised Lane 0. */
export function laneWhy(v: { lane: Lane; computedLane: Lane; reasons: readonly LaneReason[] }, opts: { long?: boolean } = {}): string {
  if (v.lane > v.computedLane && v.computedLane === 0) return opts.long === true ? TERMS.calibratingLong : TERMS.calibrating;
  const d = decisiveReason(v.reasons.filter((r) => !r.code.startsWith("shadow.")));
  return d === null ? "all checks passed" : reasonPhrase(d);
}

export const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
export const short = (sha: string) => sha.slice(0, 7);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
