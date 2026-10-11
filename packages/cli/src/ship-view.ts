/**
 * What `gittifacts ship` reports once the lane is known: the lane by name, the reasons that set
 * it (groupLaneReasons: deciding first, passing checks folded), the Change's page and ONE next
 * step. The JSON document and the terminal text say the same thing.
 */

import type { Lane, LaneReason } from "@app/domain";
import { groupLaneReasons } from "@app/domain/lane-reasons";
import { LANE_LABELS } from "@app/domain/vocabulary";
import { isRecord } from "./tools/schema.js";

type Doc = Record<string, unknown>;

export interface NextStep {
  title: string;
  call?: string;
  command: string;
}

export interface ShipSummary {
  changeId: string;
  url: string | null;
  status: string;
  headSha: string | null;
  lane: Lane | null;
  /** "Quick review (Lane 1)". */
  laneName: string | null;
  /** The reasons that put the Change in its lane. */
  reasons: LaneReason[];
  /** How many more reasons raised it less far, and how many checks passed. */
  alsoRaising: number;
  checksPassed: number;
  failedSteps: string[];
  previewUrl: string | null;
  nextStep: NextStep;
}

const isLane = (v: unknown): v is Lane => v === 0 || v === 1 || v === 2;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function reasonsOf(v: unknown): LaneReason[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isRecord)
    .flatMap((r) =>
      typeof r.code === "string" && isLane(r.lane) && typeof r.message === "string"
        ? [{ code: r.code, lane: r.lane, message: r.message }]
        : [],
    );
}

function nextStepFor(id: string, status: string, lane: Lane | null, failed: string[]): NextStep {
  if (status === "failing") {
    return {
      title: `Fix CI${failed.length > 0 ? ` (${failed.join(", ")} failed)` : ""}, commit, and ship again`,
      call: `get_change_status({ changeId: "${id}" })`,
      command: `gittifacts get-change-status ${id} --human`,
    };
  }
  if (lane === null) {
    return {
      title: "Wait for the lane",
      call: `wait_for_change({ changeId: "${id}", until: "lane_assigned" })`,
      command: `gittifacts wait ${id} --until lane_assigned`,
    };
  }
  if (lane === 0) {
    return {
      title: "Nothing to do: it merges on its own",
      call: `wait_for_change({ changeId: "${id}", until: "merged" })`,
      command: `gittifacts wait ${id} --until merged`,
    };
  }
  return {
    title: "Ask a person to review it",
    call: `request_review({ changeId: "${id}" })`,
    command: `gittifacts request-review ${id}`,
  };
}

/** Reads a get_change_status document (external input) into the summary. */
export function shipSummary(status: Doc): ShipSummary {
  const change = isRecord(status.change) ? status.change : {};
  const classification = isRecord(status.classification) ? status.classification : null;
  const id = str(change.id) ?? "";
  const lane = isLane(change.lane) ? change.lane : null;
  const reasons = reasonsOf(classification?.reasons ?? change.laneReasons);
  const groups = groupLaneReasons(reasons);
  const head = str(change.headSha);
  const runs = Array.isArray(status.runs) ? status.runs.filter(isRecord) : [];
  const run = runs.find((r) => r.headSha === head) ?? runs[0];
  const failedSteps = (Array.isArray(run?.steps) ? run.steps.filter(isRecord) : [])
    .filter((s) => s.status === "failed" || s.status === "errored")
    .map((s) => str(s.name) ?? "?");
  const st = str(change.status) ?? "unknown";
  return {
    changeId: id,
    url: str(status.url),
    status: st,
    headSha: head,
    lane,
    laneName: lane === null ? null : `${LANE_LABELS[lane].name} (${LANE_LABELS[lane].badge})`,
    reasons: groups.deciding,
    alsoRaising: groups.raising.length,
    checksPassed: groups.passing.length,
    failedSteps,
    previewUrl: str(status.previewUrl),
    nextStep: nextStepFor(id, st, lane, failedSteps),
  };
}

/** The terminal text: a handful of lines. */
export function shipText(s: ShipSummary, pushed: string | null): string {
  const lines: string[] = [];
  lines.push(pushed ? `Shipped ${s.changeId}: pushed ${pushed}` : `Shipped ${s.changeId}`);
  if (s.status === "failing") {
    lines.push(`CI failed${s.failedSteps.length > 0 ? `: ${s.failedSteps.join(", ")}` : ""}`);
  }
  if (s.laneName) {
    lines.push(`Lane: ${s.laneName}`);
    for (const r of s.reasons.slice(0, 3)) lines.push(`  - ${r.message} (${r.code})`);
    const more = s.reasons.length - 3 + s.alsoRaising;
    const tail = [
      more > 0 ? `${more} more raised it` : "",
      s.checksPassed > 0 ? `${s.checksPassed} checks passed` : "",
    ];
    const t = tail.filter(Boolean).join("; ");
    if (t) lines.push(`  ${t}`);
  } else if (s.status !== "failing") {
    lines.push("Lane: not assigned yet");
  }
  if (s.url) lines.push(`Change: ${s.url}`);
  lines.push(`Next: ${s.nextStep.title}`, `  $ ${s.nextStep.command}`);
  return `${lines.join("\n")}\n`;
}
