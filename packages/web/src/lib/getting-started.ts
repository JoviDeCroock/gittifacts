/**
 * The dashboard checklist as data: the golden path (DECISIONS 2026-10-11) in five steps, which are
 * done, which one is running, and whether the checklist shows in full, as a slim banner (all done)
 * or not at all (dismissed). Pure, so the rules are unit-tested; the component only renders this.
 *
 *   repo    1. create a repo (a template or an import)
 *   agent   2. connect your agent (its MCP client)
 *   plan    3. approve your first plan (the sample plan of a template repo)
 *   review  4. review your first Change (the agent built the plan)
 *   merge   5. the first merge, with its time-to-first-merge
 */
import type { GettingStarted } from "../api/getting-started.js";

export type StepId = "repo" | "agent" | "plan" | "review" | "merge";
export type StepState = "todo" | "running" | "failed" | "done";

export interface ChecklistView {
  steps: { id: StepId; state: StepState }[];
  done: number;
  allDone: boolean;
  /** full: the checklist; banner: all done, one slim line; hidden: dismissed. */
  mode: "full" | "banner" | "hidden";
}

function mergeState(gs: GettingStarted): StepState {
  if (gs.firstMerge !== null) return "done";
  // Approved and not merged yet: the merge queue is landing it.
  return gs.review?.approved ? "running" : "todo";
}

export function checklistView(gs: GettingStarted, dismissed: boolean): ChecklistView {
  const steps: ChecklistView["steps"] = [
    { id: "repo", state: gs.projects > 0 ? "done" : "todo" },
    { id: "agent", state: gs.agent.connected ? "done" : "todo" },
    { id: "plan", state: gs.plan?.approved ? "done" : "todo" },
    { id: "review", state: gs.review?.approved ? "done" : "todo" },
    { id: "merge", state: mergeState(gs) },
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

/** "38 s", "1 min 12 s", "2 h 5 min": a first green's or a first merge's duration. */
export function durationLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
  }
  return rest === 0 ? `${m} min` : `${m} min ${rest} s`;
}

/** How often the dashboard re-reads the state while a first run is going (ms). */
export const POLL_MS = 2500;

/** The shortest agent prompt: the platform's own /start URL. */
export function agentPrompt(origin: string): string {
  return `use ${origin}/start`;
}

/** Step 4's prompt: the agent builds the approved plan (it reads /start first). */
export function buildPrompt(origin: string, repoId: string, planId: string): string {
  return `Use ${origin}/start. In repo ${repoId}, build plan ${planId}.`;
}
