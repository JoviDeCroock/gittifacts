/**
 * The backtest report and the per-repo calibration (spec §3.7). Pure.
 *
 * Historical PRs rarely have a Plan, and without an approved Plan there is no Lane 0. So next to
 * the lane as graded, the report computes each PR's **evidence lane**: the highest lane any
 * reason forces once the Plan requirement (`plan.*`, `scope.*`) and shadow mode (`shadow.*`) are
 * set aside, i.e. "with an approved Plan covering it, and Lane 0 on". "Would have auto-merged"
 * counts evidence-lane-0 PRs that nothing else held for a human.
 *
 * Calibration: of those, how many were reverted or patched (same lines) within 14 days. Lane 0
 * can be turned on for the repo only with enough known outcomes and a false-Lane-0 rate ≤ 2 %;
 * otherwise the report names the PRs and the reasons the classifier gave, to tighten the policy.
 */
import type { MergedPr } from "./listing.js";
import type { PatchOutcome } from "./patches.js";
import type { RevertLink } from "./reverts.js";

export interface GradedPr {
  number: number;
  lane: 0 | 1 | 2;
  computedLane: 0 | 1 | 2;
  blocked: boolean;
  requiresHumanApproval: boolean;
  reasons: { code: string; lane: 0 | 1 | 2 }[];
}

const SET_ASIDE = /^(plan|scope|shadow)\./;

export function evidenceLane(g: Pick<GradedPr, "reasons">): 0 | 1 | 2 {
  return g.reasons.filter((r) => !SET_ASIDE.test(r.code)).reduce<0 | 1 | 2>((m, r) => (r.lane > m ? r.lane : m), 0);
}

export const wouldAutoMerge = (g: GradedPr) => !g.blocked && !g.requiresHumanApproval && evidenceLane(g) === 0;

export const CALIBRATION = { minSamples: 25, minCandidates: 5, maxFalseRate: 0.02 } as const;

export interface BacktestReport {
  window: { since: string; until: string; days: number };
  listed: number;
  graded: number;
  skipped: { number: number; reason: string }[];
  lanes: Record<"0" | "1" | "2", number>;
  evidenceLanes: Record<"0" | "1" | "2", number>;
  wouldAutoMerge: { count: number; percent: number };
  afterwards: {
    reverted: { number: number; by: number }[];
    patched: { number: number; by: number }[];
    unknown: number;
  };
  /** Up to three PRs graded for a full review (evidence lane 2) that merged fastest. */
  fastFullReviews: { number: number; title: string; hoursToMerge: number; reasons: string[] }[];
  reverts: number;
  calibration: {
    samples: number;
    candidates: number;
    bad: number;
    falseRate: number | null;
    eligible: boolean;
    reason: string;
  };
}

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

export function backtestReport(input: {
  since: Date;
  until: Date;
  listed: readonly MergedPr[];
  graded: ReadonlyMap<number, GradedPr>;
  skipped: readonly { number: number; reason: string }[];
  reverts: ReadonlyMap<number, RevertLink>;
  patches: ReadonlyMap<number, PatchOutcome>;
}): BacktestReport {
  const graded = input.listed.filter((p) => input.graded.has(p.number));
  const lanes = { "0": 0, "1": 0, "2": 0 };
  const evidence = { "0": 0, "1": 0, "2": 0 };
  const candidates: MergedPr[] = [];
  for (const p of graded) {
    const g = input.graded.get(p.number) as GradedPr;
    lanes[String(g.lane) as "0"]++;
    evidence[String(evidenceLane(g)) as "0"]++;
    if (wouldAutoMerge(g)) candidates.push(p);
  }
  const reverted: { number: number; by: number }[] = [];
  const patched: { number: number; by: number }[] = [];
  let unknown = 0;
  for (const p of candidates) {
    const r = input.reverts.get(p.number);
    const q = input.patches.get(p.number) ?? "unknown";
    if (r !== undefined) reverted.push({ number: p.number, by: r.by });
    else if (typeof q === "object") patched.push({ number: p.number, by: q.by });
    else if (q === "unknown") unknown++;
  }
  const fast = graded
    .filter((p) => evidenceLane(input.graded.get(p.number) as GradedPr) === 2)
    .map((p) => ({
      number: p.number,
      title: p.title,
      hoursToMerge: Math.round(((Date.parse(p.mergedAt) - Date.parse(p.createdAt)) / 3_600_000) * 10) / 10,
      reasons: (input.graded.get(p.number) as GradedPr).reasons.filter((r) => r.lane === 2).map((r) => r.code),
    }))
    .sort((a, b) => a.hoursToMerge - b.hoursToMerge)
    .slice(0, 3);
  const known = candidates.length - unknown;
  const bad = reverted.length + patched.length;
  const samples = graded.filter((p) => input.reverts.has(p.number) || (input.patches.get(p.number) ?? "unknown") !== "unknown").length;
  const falseRate = known === 0 ? null : bad / known;
  const c = CALIBRATION;
  const reason =
    samples < c.minSamples
      ? `only ${samples} graded PRs with a known outcome (needs ${c.minSamples})`
      : known < c.minCandidates
        ? `only ${known} Lane 0 candidates with a known outcome (needs ${c.minCandidates})`
        : (falseRate ?? 1) > c.maxFalseRate
          ? `${bad} of ${known} Lane 0 candidates were reverted or patched within 14 days: tighten the policy first`
          : `${known} Lane 0 candidates, ${bad} reverted or patched`;
  return {
    window: { since: input.since.toISOString(), until: input.until.toISOString(), days: Math.round((input.until.getTime() - input.since.getTime()) / 86_400_000) },
    listed: input.listed.length,
    graded: graded.length,
    skipped: [...input.skipped],
    lanes,
    evidenceLanes: evidence,
    wouldAutoMerge: { count: candidates.length, percent: pct(candidates.length, graded.length) },
    afterwards: { reverted, patched, unknown },
    fastFullReviews: fast,
    reverts: input.reverts.size,
    calibration: {
      samples,
      candidates: known,
      bad,
      falseRate,
      eligible: samples >= c.minSamples && known >= c.minCandidates && (falseRate ?? 1) <= c.maxFalseRate,
      reason,
    },
  };
}
