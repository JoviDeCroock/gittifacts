/**
 * The dashboard checklist as data: which of the three steps are done, which one is running, and
 * whether the checklist shows in full, as a slim banner (all done) or not at all (dismissed).
 * Pure, so the rules are unit-tested; the component only renders this.
 */
import type { GettingStarted } from "../api/getting-started.js";

export type StepId = "agent" | "try" | "repo";
export type StepState = "todo" | "running" | "failed" | "done";

export interface ChecklistView {
  steps: { id: StepId; state: StepState }[];
  done: number;
  allDone: boolean;
  /** full: the checklist; banner: all done, one slim line; hidden: dismissed. */
  mode: "full" | "banner" | "hidden";
}

function tryState(gs: GettingStarted): StepState {
  if (gs.firstGreen !== null) return "done";
  const b = gs.latestBootstrap;
  if (b === null) return "todo";
  if (b.status === "running") return "running";
  // A bootstrap without a preview (a library template) can't be green "plus a preview", but its
  // CI did pass: the server then reports the passed run as firstGreen. Anything else failed.
  return b.status === "green" ? "done" : "failed";
}

export function checklistView(gs: GettingStarted, dismissed: boolean): ChecklistView {
  const steps: ChecklistView["steps"] = [
    { id: "agent", state: gs.agent.connected ? "done" : "todo" },
    { id: "try", state: tryState(gs) },
    { id: "repo", state: gs.repo.connected ? "done" : "todo" },
  ];
  const done = steps.filter((s) => s.state === "done").length;
  const allDone = done === steps.length;
  return { steps, done, allDone, mode: dismissed ? "hidden" : allDone ? "banner" : "full" };
}

/** Per-user dismissal (localStorage; a private window simply shows the checklist again). */
export function dismissKey(principalId: string): string {
  return `gf:getting-started:dismissed:${principalId}`;
}

export function readDismissed(principalId: string): boolean {
  try {
    return window.localStorage.getItem(dismissKey(principalId)) === "1";
  } catch {
    return false;
  }
}

export function writeDismissed(principalId: string, value: boolean): void {
  try {
    if (value) window.localStorage.setItem(dismissKey(principalId), "1");
    else window.localStorage.removeItem(dismissKey(principalId));
  } catch {
    /* storage unavailable: dismissed for this page only */
  }
}

/** "38 s", "1 min 12 s": the first green's duration in the quiet line. */
export function durationLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m} min` : `${m} min ${rest} s`;
}

/** How often the dashboard re-reads the state while a first run is going (ms). */
export const POLL_MS = 2500;

/** The agent prompt step 1 copies: the platform's own /start URL. */
export function agentPrompt(origin: string): string {
  return `use ${origin}/start`;
}
