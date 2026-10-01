/**
 * Lanes: naming, grouping, filtering, and the observation-chart model behind "why this lane".
 * Pure functions only.
 */
import type { Change, ChangeStatus, Lane, LaneReason } from "@app/domain";
import type { ShadowStats } from "../api/types.js";

export interface LaneMeta {
  lane: Lane;
  name: string;
  short: string;
  description: string;
}

export const LANES: Record<Lane, LaneMeta> = {
  0: { lane: 0, name: "Lane 0", short: "Auto-merge", description: "Merges on evidence alone." },
  1: { lane: 1, name: "Lane 1", short: "Glance", description: "Approve the tour, usually in under three minutes." },
  2: { lane: 2, name: "Lane 2", short: "Full review", description: "Read the diff with the tour as a guide." },
};

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
export function groupByLane<T extends Groupable>(changes: T[], lane0Enabled: boolean): LaneGroup<T>[] {
  const buckets: Record<LaneGroupKey, T[]> = { lane2: [], lane1: [], lane0: [], unrouted: [] };
  for (const c of changes) buckets[groupKeyFor(c)].push(c);
  const sort = (a: T, b: T) =>
    (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
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
  { id: "review", label: "Needs review" },
  { id: "active", label: "In flight" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];

const ACTIVE: ChangeStatus[] = ["awaiting-push", "running", "failing", "approved", "queued", "merged", "rolling-out"];
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
  missing: "Missing signal",
  shadow: "Shadow mode",
  other: "Other",
};

export function reasonFamily(code: string): ReasonFamily {
  const head = code.split(".")[0] ?? "";
  if (code.startsWith("signal.missing") || code.startsWith("signal.error")) return "missing";
  switch (head) {
    case "proof":
    case "tests":
      return "proof";
    case "coverage":
      return "coverage";
    case "mutation":
      return "mutation";
    case "api":
      return "api";
    case "deps":
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

export function familyLabel(code: string): string {
  return FAMILY_LABEL[reasonFamily(code)];
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

export function triageChart(reasons: LaneReason[], computed: Lane | null, routed: Lane | null): TriageChart {
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
        label: FAMILY_LABEL[family],
        lane: reason.lane,
        unknown: family === "missing" || /\.(missing|error|skipped|unknown)\b/.test(reason.code),
        decisive: reason.lane === computedLane && computedLane > 0,
      };
    });
  return { rows, computedLane, routedLane, shadowRaised: routedLane > computedLane, shadowReason };
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
  const base = { ratio: s.ratio, threshold: s.threshold, samples: s.samples, agreed: s.agreed, needed: s.needed };
  if (s.needed > 0 || s.ratio === null) {
    return {
      ...base,
      state: "collecting",
      headline: `${s.samples} of ${s.samples + s.needed} reviews collected`,
      detail: `Agreement counts after ${s.needed} more ${s.needed === 1 ? "review" : "reviews"} of Lane 0 candidates.`,
    };
  }
  if (s.eligibleToEnableLane0 || s.ratio >= s.threshold) {
    return {
      ...base,
      state: "eligible",
      headline: `${pct(s.ratio, 1)} agreement`,
      detail: `Meets the ${pct(s.threshold)} threshold over ${s.samples} reviews. Lane 0 can be turned on.`,
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
