/**
 * One term per concept, app-wide. Labels and tones for statuses, verdicts and stop kinds.
 */
import type { ChangeStatus, PlanStatus, RolloutState, TourStop, TourVerdict } from "@app/domain";
import type { IconId } from "../components/Icon.js";

export type Tone = "neutral" | "ok" | "warn" | "danger" | "action";

export interface StatusMeta {
  label: string;
  tone: Tone;
  icon: IconId;
}

export const CHANGE_STATUS: Record<ChangeStatus, StatusMeta> = {
  "awaiting-push": { label: "Awaiting push", tone: "neutral", icon: "upload" },
  running: { label: "Checks running", tone: "neutral", icon: "loader" },
  failing: { label: "Checks failing", tone: "danger", icon: "x-circle" },
  "awaiting-review": { label: "Awaiting review", tone: "action", icon: "eye" },
  approved: { label: "Approved", tone: "ok", icon: "check-circle" },
  queued: { label: "In merge queue", tone: "neutral", icon: "list-ordered" },
  merged: { label: "Merged", tone: "ok", icon: "git-merge" },
  "rolling-out": { label: "Rolling out", tone: "warn", icon: "rocket" },
  released: { label: "Released", tone: "ok", icon: "badge-check" },
  reverted: { label: "Reverted", tone: "danger", icon: "undo" },
  rejected: { label: "Rejected", tone: "neutral", icon: "ban" },
  abandoned: { label: "Abandoned", tone: "neutral", icon: "archive" },
};

export const PLAN_STATUS: Record<PlanStatus, StatusMeta> = {
  draft: { label: "Awaiting approval", tone: "action", icon: "file-text" },
  approved: { label: "Approved", tone: "ok", icon: "check-circle" },
  superseded: { label: "Superseded", tone: "neutral", icon: "archive" },
  rejected: { label: "Rejected", tone: "neutral", icon: "ban" },
};

export const ROLLOUT_STATUS: Record<RolloutState["status"], StatusMeta> = {
  pending: { label: "Pending", tone: "neutral", icon: "pause" },
  rolling: { label: "Rolling out", tone: "warn", icon: "rocket" },
  watching: { label: "Watching", tone: "warn", icon: "eye" },
  released: { label: "Released", tone: "ok", icon: "badge-check" },
  "rolling-back": { label: "Rolling back", tone: "danger", icon: "undo" },
  "rolled-back": { label: "Rolled back", tone: "danger", icon: "undo" },
  failed: { label: "Failed", tone: "danger", icon: "x-circle" },
};

export interface VerdictMeta {
  label: string;
  /** Spoken explanation, for aria and tooltips. */
  explain: string;
}

export const VERDICT: Record<TourVerdict, VerdictMeta> = {
  proven: { label: "Proven", explain: "Backed by signed evidence." },
  unproven: { label: "Unproven", explain: "No evidence proves this. Read it yourself." },
  risk: { label: "Risk", explain: "Evidence shows a risk worth your attention." },
};

export const STOP_KIND: Record<TourStop["kind"], string> = {
  intent: "Intent",
  behavior: "Behavior",
  risk: "Riskiest hunk",
  proof: "Proof",
  uncovered: "Not covered",
  transform: "Verified transform",
  other: "Note",
};

export const CATEGORY_LABEL: Record<string, string> = {
  fix: "Fix",
  feature: "Feature",
  refactor: "Refactor",
  dependency: "Dependency",
  transform: "Transform",
  revert: "Revert",
  docs: "Docs",
  chore: "Chore",
};

export function shortSha(sha: string | null | undefined, n = 7): string {
  return sha ? sha.slice(0, n) : "—";
}

/** Middle-truncate an opaque hash for display: "kQ3x9…a8Zp". */
export function shortHash(hash: string, head = 6, tail = 4): string {
  return hash.length <= head + tail + 1 ? hash : `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${new Intl.NumberFormat("en").format(n)} ${n === 1 ? one : many}`;
}

export const num = new Intl.NumberFormat("en");
