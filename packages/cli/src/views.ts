/**
 * `--human` views: a tool's JSON document reshaped for reading (the JSON output never changes).
 * `get-change-status --human` used to print the raw document: "Status running, Lane -", a STEPS
 * column of JSON and no preview URL (journey 10). Here it is a summary, the latest run's steps
 * as a table, the reasons for the lane, and the next steps.
 */
import { LANE_LABELS } from "@app/domain/vocabulary";
import { isRecord } from "./tools/schema.js";

type Doc = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const short = (sha: unknown): string => str(sha)?.slice(0, 12) ?? "-";
const records = (v: unknown): Doc[] => (Array.isArray(v) ? v.filter(isRecord) : []);

const STATUS_NOTE: Record<string, string> = {
  "awaiting-push": "nothing pushed yet",
  running: "CI, evidence and grading in progress",
  failing: "a CI step failed, or the evidence did not verify",
  "awaiting-review": "waiting for a human review",
  approved: "approved; joining the merge queue",
  queued: "in the merge queue",
  merged: "on the default branch",
  "rolling-out": "merged and rolling out",
  released: "merged and fully rolled out",
  reverted: "reverted",
  rejected: "rejected by a reviewer",
  abandoned: "closed without merging",
};

const STEP_MARK: Record<string, string> = {
  passed: "✓",
  failed: "✗",
  errored: "✗",
  running: "…",
  queued: "…",
  cached: "✓",
  skipped: "-",
  cancelled: "-",
  superseded: "-",
};

function statusLine(change: Doc, bootstrap: boolean): string {
  const status = str(change.status) ?? "unknown";
  if (bootstrap && status === "released") return "released (the first CI run passed)";
  if (bootstrap && status === "running") return "running (the first CI run and preview)";
  const note = STATUS_NOTE[status];
  return note === undefined ? status : `${status} (${note})`;
}

function laneLine(change: Doc, classification: Doc | null, bootstrap: boolean): string {
  if (bootstrap) return "none (the first Change is never classified)";
  const lane = change.lane ?? classification?.lane;
  if (typeof lane !== "number") {
    return change.status === "running" ? "not yet (assigned after the evidence)" : "-";
  }
  const label = lane === 0 || lane === 1 || lane === 2 ? LANE_LABELS[lane] : null;
  const computed = change.computedLane ?? classification?.computedLane;
  const shadow = classification?.shadow === true ? "; auto-merge is calibrating on this repo" : "";
  const extra =
    typeof computed === "number" && computed !== lane
      ? `; the evidence alone says ${(computed === 0 || computed === 1 || computed === 2 ? LANE_LABELS[computed].name : String(computed)).toLowerCase()}`
      : "";
  return label
    ? `${label.name} (${label.badge})${extra}${shadow}`
    : `Lane ${lane}${extra}${shadow}`;
}

/** `get_change_status` for people. */
export function changeStatusView(doc: Doc): Doc {
  const change = isRecord(doc.change) ? doc.change : {};
  const classification = isRecord(doc.classification) ? doc.classification : null;
  const bootstrap = (str(change.id) ?? "").startsWith("bs-");
  const runs = records(doc.runs);
  const head = str(change.headSha);
  const latest = runs.find((r) => head !== null && r.headSha === head) ?? runs[0] ?? null;
  const steps = records(latest?.steps).map((s) => {
    const status = str(s.status) ?? "-";
    return {
      step: str(s.name) ?? "-",
      kind: str(s.kind) ?? "-",
      status: `${STEP_MARK[status] ?? " "} ${status}`,
      log: str(s.logRef) ?? "-",
    };
  });
  const reasons = records(classification?.reasons ?? change.laneReasons)
    .filter((r) => typeof r.lane === "number" && r.lane > 0)
    .map((r) => ({ lane: r.lane, code: r.code, why: r.message }));
  const older = runs
    .filter((r) => r !== latest)
    .map((r) => ({ run: r.id, head: short(r.headSha), status: r.status }));
  return {
    change: str(change.id) ?? "-",
    title: str(change.title) ?? "-",
    status: statusLine(change, bootstrap),
    lane: laneLine(change, classification, bootstrap),
    preview: str(doc.previewUrl) ?? (bootstrap || head !== null ? "not up yet" : "-"),
    head: head === null ? "nothing pushed yet" : `${short(head)} (base ${short(change.baseSha)})`,
    plan: str(change.planId) ?? "none",
    latestRun:
      latest === null
        ? "no run yet"
        : `${str(latest.status) ?? "-"} (${str(latest.id) ?? "?"}${latest.headSha === head ? "" : `, at ${short(latest.headSha)}`})`,
    ...(steps.length > 0 ? { steps } : {}),
    ...(reasons.length > 0 ? { raisedBy: reasons } : {}),
    ...(older.length > 0 ? { olderRuns: older } : {}),
    ...(Array.isArray(doc.nextSteps) ? { nextSteps: doc.nextSteps } : {}),
    ...(typeof doc.idempotencyKey === "string" ? { idempotencyKey: doc.idempotencyKey } : {}),
  };
}

/** Tool name → its `--human` view (tools without one render their JSON as it is). */
export const HUMAN_VIEWS: Readonly<Record<string, (doc: Doc) => Doc>> = {
  get_change_status: changeStatusView,
};
