/**
 * Lanes: naming, grouping, filtering, and the observation-chart model behind "why this lane".
 * Pure functions only.
 */
import type { Change, ChangeStatus, Lane, LaneReason } from "@app/domain";
import { groupLaneReasons } from "@app/domain/lane-reasons";
import { LANE_LABELS, type LaneLabel, laneLabel } from "@app/domain/vocabulary";
import type { ShadowStats } from "../api/types.js";

/** The lane's name ("Quick review"), its badge ("Lane 1") and one line on what a person does. */
export type LaneMeta = LaneLabel;

/** The app's only lane wording; it comes from `@app/domain`, shared with the CLI, `/start` and GitHub. */
export const LANES: Record<Lane, LaneMeta> = LANE_LABELS;

/** "Quick review (Lane 1)": the name first, the numeral as its badge. */
export function laneTitle(lane: Lane): string {
  return laneLabel(lane);
}

export const LANE_ORDER: Lane[] = [2, 1, 0];

// ---------------------------------------------------------------- grouping

export type LaneGroupKey = "lane2" | "lane1" | "lane0" | "unrouted";

export interface LaneGroup<T> {
  key: LaneGroupKey;
  lane: Lane | null;
  /** Lane 0 group while shadow mode is on: computed auto-merge, routed to a human. */
  shadow: boolean;
  items: T[];
}

type Groupable = Pick<Change, "lane" | "computedLane" | "status" | "updatedAt">;

export function groupKeyFor(change: Groupable): LaneGroupKey {
  if (change.lane === 2) return "lane2";
  if (change.computedLane === 0 && (change.lane === 0 || change.lane === 1)) return "lane0";
  if (change.lane === 1) return "lane1";
  if (change.lane === 0) return "lane0";
  return "unrouted";
}

const STATUS_RANK: Partial<Record<ChangeStatus, number>> = {
  "awaiting-review": 0,
  failing: 1,
  "rolling-out": 2,
  running: 3,
};

/**
 * Lane 2 first, then Lane 1, then Lane 0 (shadow), then changes not routed yet.
 * Inside a group: awaiting review first, then most recently updated.
 */
export function groupByLane<T extends Groupable>(
  changes: T[],
  lane0Enabled: boolean,
): LaneGroup<T>[] {
  const buckets: Record<LaneGroupKey, T[]> = { lane2: [], lane1: [], lane0: [], unrouted: [] };
  for (const c of changes) buckets[groupKeyFor(c)].push(c);
  const sort = (a: T, b: T) =>
    (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  const groups: LaneGroup<T>[] = [
    { key: "lane2", lane: 2, shadow: false, items: buckets.lane2.sort(sort) },
    { key: "lane1", lane: 1, shadow: false, items: buckets.lane1.sort(sort) },
    { key: "lane0", lane: 0, shadow: !lane0Enabled, items: buckets.lane0.sort(sort) },
    { key: "unrouted", lane: null, shadow: false, items: buckets.unrouted.sort(sort) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

// ---------------------------------------------------------------- filters

export type ChangeFilter = "review" | "active" | "closed" | "all";

export const FILTERS: { id: ChangeFilter; label: string }[] = [
  { id: "review", label: "To review" },
  { id: "active", label: "In flight" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];

const ACTIVE: ChangeStatus[] = [
  "awaiting-push",
  "running",
  "failing",
  "approved",
  "queued",
  "merged",
  "rolling-out",
];
const CLOSED: ChangeStatus[] = ["released", "reverted", "rejected", "abandoned"];

export function matchesFilter(status: ChangeStatus, filter: ChangeFilter): boolean {
  switch (filter) {
    case "review":
      return status === "awaiting-review";
    case "active":
      return ACTIVE.includes(status);
    case "closed":
      return CLOSED.includes(status);
    case "all":
      return true;
  }
}

/**
 * What the lane block says for a change without a lane. An open change (waiting for a push,
 * checks running or failing) is routed once its checks pass; only a closed one never will be.
 */
export function unroutedCopy(status: ChangeStatus, id: string): { title: string; line: string } {
  if (id.startsWith("bs-"))
    return {
      title: "Not routed",
      line: "The platform's first change merges without review, so it has no lane.",
    };
  if (status === "failing")
    return {
      title: "Not routed yet",
      line: "The lane is computed once the author pushes a fix and checks pass.",
    };
  if (status === "awaiting-push" || status === "running" || status === "awaiting-review")
    return {
      title: "Not routed yet",
      line: "The lane is computed once checks pass and evidence is signed.",
    };
  return { title: "Not routed", line: "This change closed before a lane was computed." };
}

/**
 * Why a change has no tour, in the change's own state, and what the reader can do instead
 * (`runStatus`: the latest pipeline run's status, if any).
 */
export function noTourCopy(
  change: {
    id: string;
    status: ChangeStatus;
    lane: Lane | null;
    laneReasons: readonly { code: string }[];
    headSha?: string | null;
  },
  runStatus?: string,
): { title: string; body: string; showDiff: boolean } {
  const tourFailed = change.laneReasons.some((r) => r.code === "tour.failed");
  // Awaiting a push with a head already there: a reviewer sent it back (the agent reads the comment
  // with get_change_status and its wait answers changes-requested).
  if (change.status === "awaiting-push" && change.headSha)
    return {
      title: "Sent back to the author",
      body: "A reviewer requested changes on this head. The author has the comment and pushes a new head; checks, evidence and a new walkthrough follow.",
      showDiff: true,
    };
  if (change.status === "awaiting-push")
    return {
      title: "Waiting for the first push",
      body: "The author has not pushed a head yet. Checks, evidence and the walkthrough follow the push.",
      showDiff: false,
    };
  if (change.status === "running" || runStatus === "running" || runStatus === "queued")
    return {
      title: "The walkthrough is not written yet",
      body: "The reviewer agent writes the walkthrough once the checks pass and the evidence is signed. Nothing can be approved until then.",
      showDiff: false,
    };
  if (change.status === "failing")
    // The chip and the decision bar already say "checks failed"; this section says what it holds.
    return {
      title: "What failed",
      body: "There is nothing to review until the author pushes a fix. The failing step is below.",
      showDiff: false,
    };
  if (change.status === "awaiting-review")
    return tourFailed
      ? {
          title: "No walkthrough: the reviewer agent could not write one",
          body: "Review the change itself. Every changed file is below, the evidence is one step away, and the lane panel lists what was and was not measured.",
          showDiff: true,
        }
      : {
          title: "The reviewer agent is writing the walkthrough",
          body: "You can already read the diff below and the signed evidence. The walkthrough usually follows within a minute.",
          showDiff: true,
        };
  if (change.id.startsWith("bs-"))
    return {
      title: "No walkthrough for the first change",
      body: "The platform's first commit sets up CI and the first preview. It merges without review, so no walkthrough is written.",
      showDiff: false,
    };
  if (change.lane === 0)
    return {
      title: "No walkthrough: this change auto-merged",
      body: "In auto-merge (Lane 0) the evidence alone decides and nobody reviews, so no walkthrough is written. The diff and the signed evidence are the record.",
      showDiff: true,
    };
  return {
    title: tourFailed
      ? "No walkthrough: the reviewer agent could not write one"
      : "No walkthrough for this change",
    body: "It was decided without a walkthrough. The diff and the signed evidence are the record.",
    showDiff: true,
  };
}

// ---------------------------------------------------------------- observation chart

export type ReasonFamily =
  | "proof"
  | "coverage"
  | "mutation"
  | "api"
  | "dependencies"
  | "sensitive"
  | "size"
  | "scope"
  | "policy"
  | "model"
  | "transform"
  | "revert"
  | "checks"
  | "signature"
  | "migration"
  | "budget"
  | "tour"
  | "informational"
  | "resolution"
  | "lane0"
  | "missing"
  | "shadow"
  | "other";

const FAMILY_LABEL: Record<ReasonFamily, string> = {
  proof: "Proof",
  coverage: "Coverage",
  mutation: "Mutation",
  api: "Public API",
  dependencies: "Dependencies",
  sensitive: "Sensitive paths",
  size: "Size",
  scope: "Plan scope",
  policy: "Policy file",
  model: "Model judgment",
  transform: "Transform",
  revert: "Revert",
  checks: "CI checks",
  signature: "Signature",
  migration: "Migrations",
  budget: "Model budget",
  tour: "Walkthrough",
  informational: "Previews and traces",
  resolution: "Conflict resolution",
  lane0: "Auto-merge setting",
  missing: "Missing measurement",
  shadow: "Calibrating",
  other: "Other",
};

/** What a `signal.*.<measurement>` code measured, so "skip accepted" rows sit in their own family. */
const MEASUREMENT_FAMILY: Record<string, ReasonFamily> = {
  coverage: "coverage",
  mutation: "mutation",
  "public-api": "api",
  dependencies: "dependencies",
  "sensitive-paths": "sensitive",
  "red-green": "proof",
  "test-run": "proof",
  "llm-judgment": "model",
  transform: "transform",
  "conflict-resolution": "resolution",
};

/** Names a missing or failed measurement in its row label ("Test run", not "Missing signal"). */
const MEASUREMENT_LABEL: Record<string, string> = {
  coverage: "Coverage",
  mutation: "Mutation",
  "public-api": "Public API",
  dependencies: "Dependencies",
  "sensitive-paths": "Sensitive paths",
  "red-green": "Red → green proof",
  "test-run": "Test run",
  "llm-judgment": "Model judgment",
  transform: "Transform",
  "conflict-resolution": "Conflict resolution",
  screenshots: "Screenshots",
  preview: "Preview",
  "agent-trace": "Agent trace",
  quarantine: "Quarantine",
  evidence: "Evidence",
  "diff-stats": "Diff size",
};

export function reasonFamily(code: string): ReasonFamily {
  const head = code.split(".")[0] ?? "";
  if (code.startsWith("signal.missing") || code.startsWith("signal.error")) return "missing";
  if (code.startsWith("signal.skip-accepted."))
    return MEASUREMENT_FAMILY[code.split(".")[2] ?? ""] ?? "other";
  switch (head) {
    case "proof":
    case "tests":
    case "red-green":
      return "proof";
    case "ci":
      return "checks";
    case "evidence":
      return "signature";
    case "migration":
      return "migration";
    case "budget":
      return "budget";
    case "tour":
      return "tour";
    case "informational":
      return "informational";
    case "resolution":
      return "resolution";
    case "merge-queue":
      // The queue's resolution reasons (novel lines, edits outside the hunks) are the resolution's.
      return code.startsWith("merge-queue.resolution") ? "resolution" : "other";
    case "lane0":
      return "lane0";
    case "coverage":
      return "coverage";
    case "mutation":
      return "mutation";
    case "api":
      return "api";
    case "deps":
    case "dependency":
    case "dependencies":
      return "dependencies";
    case "sensitive":
      return "sensitive";
    case "size":
      return "size";
    case "scope":
    case "plan":
      return "scope";
    case "policy":
      return "policy";
    case "llm":
    case "model":
      return "model";
    case "transform":
      return "transform";
    case "revert":
      return "revert";
    case "shadow":
      return "shadow";
    default:
      return "other";
  }
}

/** A row label: the family, or for a missing or failed measurement, what was not measured. */
export function familyLabel(code: string): string {
  const family = reasonFamily(code);
  if (family === "missing") {
    const parts = code.split(".");
    const what = MEASUREMENT_LABEL[parts[2] ?? ""];
    if (what) return `${what} ${parts[1] === "error" ? "failed" : "missing"}`;
  }
  return FAMILY_LABEL[family];
}

export interface ChartRow {
  reason: LaneReason;
  family: ReasonFamily;
  label: string;
  /** The row's marker sits in the column of the minimum lane it forces. */
  lane: Lane;
  /** A missing or failed measurement: plotted hollow, because unknown escalates. */
  unknown: boolean;
  /** This row alone would force the computed lane. */
  decisive: boolean;
}

export interface TriageChart {
  rows: ChartRow[];
  computedLane: Lane;
  routedLane: Lane;
  /** Shadow mode raised the route above what the evidence computed. */
  shadowRaised: boolean;
  shadowReason: LaneReason | null;
}

function maxLane(a: Lane, b: Lane): Lane {
  return a >= b ? a : b;
}

export function triageChart(
  reasons: LaneReason[],
  computed: Lane | null,
  routed: Lane | null,
): TriageChart {
  const shadowReason = reasons.find((r) => reasonFamily(r.code) === "shadow") ?? null;
  const signals = reasons.filter((r) => reasonFamily(r.code) !== "shadow");
  const fromSignals = signals.reduce<Lane>((acc, r) => maxLane(acc, r.lane), 0);
  const computedLane = computed ?? fromSignals;
  const routedLane = routed ?? maxLane(computedLane, shadowReason?.lane ?? 0);
  const rows = signals
    .map((reason, index) => ({ reason, index }))
    .sort((a, b) => b.reason.lane - a.reason.lane || a.index - b.index)
    .map(({ reason }) => {
      const family = reasonFamily(reason.code);
      return {
        reason,
        family,
        label: familyLabel(reason.code),
        lane: reason.lane,
        unknown: family === "missing" || /\.(missing|error|skipped|unknown)\b/.test(reason.code),
        decisive: reason.lane === computedLane && computedLane > 0,
      };
    });
  return { rows, computedLane, routedLane, shadowRaised: routedLane > computedLane, shadowReason };
}

/**
 * The chart's rows in reading order (groupLaneReasons): the reasons that set the lane, then the
 * ones that raised it less far, and the checks that passed folded away. A measurement that is
 * missing never folds into "passed", whatever lane it carries (the Unknown Is Not Green Rule).
 */
export function foldChart(rows: readonly ChartRow[]): { shown: ChartRow[]; passing: ChartRow[] } {
  const byReason = new Map(rows.map((r) => [r.reason, r] as const));
  const g = groupLaneReasons(rows.map((r) => r.reason));
  const pick = (reasons: readonly LaneReason[]) =>
    reasons.map((x) => byReason.get(x)).filter((r): r is ChartRow => r !== undefined);
  const passed = pick(g.passing);
  return {
    shown: [...pick(g.deciding), ...pick(g.raising), ...passed.filter((r) => r.unknown)],
    passing: passed.filter((r) => !r.unknown),
  };
}

// ---------------------------------------------------------------- shadow agreement

export type ShadowState = "collecting" | "below" | "eligible";

export interface ShadowProgress {
  state: ShadowState;
  /** 0..1 agreement, null while there are too few samples to count. */
  ratio: number | null;
  threshold: number;
  samples: number;
  agreed: number;
  needed: number;
  headline: string;
  detail: string;
}

export function pct(x: number, digits = 0): string {
  const v = x * 100;
  const fixed = v.toFixed(digits);
  return `${digits > 0 && fixed.endsWith(`.${"0".repeat(digits)}`) ? Math.round(v) : fixed}%`;
}

export function shadowProgress(s: ShadowStats): ShadowProgress {
  const base = {
    ratio: s.ratio,
    threshold: s.threshold,
    samples: s.samples,
    agreed: s.agreed,
    needed: s.needed,
  };
  if (s.needed > 0 || s.ratio === null) {
    return {
      ...base,
      state: "collecting",
      headline: `${s.samples} of ${s.samples + s.needed} reviews collected`,
      detail: `Agreement counts after ${s.needed} more ${s.needed === 1 ? "review" : "reviews"} of auto-merge candidates.`,
    };
  }
  if (s.eligibleToEnableLane0 || s.ratio >= s.threshold) {
    return {
      ...base,
      state: "eligible",
      headline: `${pct(s.ratio, 1)} agreement`,
      detail: `Meets the ${pct(s.threshold)} threshold over ${s.samples} reviews. Auto-merge can be turned on.`,
    };
  }
  const missing = Math.max(0, Math.ceil((s.threshold * s.samples - s.agreed) / (1 - s.threshold)));
  return {
    ...base,
    state: "below",
    headline: `${pct(s.ratio, 1)} agreement`,
    detail: `${s.agreed} of ${s.samples} reviews agreed. Needs ${pct(s.threshold)}: about ${missing} more agreeing ${missing === 1 ? "review" : "reviews"}.`,
  };
}

/** The one reason that best explains a change's lane, for list rows. */
export function topReason(
  reasons: LaneReason[],
  computed: Lane | null,
  routed: Lane | null,
): { label: string; message: string; shadow: boolean } | null {
  if (reasons.length === 0) return null;
  const chart = triageChart(reasons, computed, routed);
  if (chart.shadowRaised)
    return {
      label: "Calibrating",
      message: `The evidence alone says ${LANES[chart.computedLane].name.toLowerCase()}; auto-merge is calibrating, so it is routed to you.`,
      shadow: true,
    };
  const row = chart.rows.find((r) => r.decisive) ?? chart.rows[0];
  return row ? { label: row.label, message: row.reason.message, shadow: false } : null;
}
