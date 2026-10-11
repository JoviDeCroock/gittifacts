/**
 * The words a new person meets, each with a one-line hint and the docs page that explains it.
 * Day-one vocabulary is Plan, Change and review lane; everything else (calibrating, evidence,
 * walkthrough, policy, scopes, mission control, attempts…) gets a <Term> where it first appears,
 * so the screen teaches the word instead of assuming it. Hints follow the docs glossary
 * (packages/docs/content/index.md) and the lane words come from @app/domain/vocabulary. Pure.
 */
import type { Scope } from "@app/domain";
import { LANE_LABELS } from "@app/domain/vocabulary";

export type TermId =
  | "plan"
  | "change"
  | "lane"
  | "evidence"
  | "walkthrough"
  | "calibrating"
  | "policy"
  | "merge-queue"
  | "unclaimed"
  | "scopes"
  | "attestation"
  | "mission-control"
  | "attempts"
  | "reason"
  | "scope-paths"
  | "rollout";

export interface TermDef {
  /** The word as a heading would print it. */
  word: string;
  /** One sentence: what it means for the person reading. */
  hint: string;
  /** The docs page (and anchor) that explains it. */
  href: string;
}

const lanes = [0, 1, 2] as const;
const laneLine = lanes.map((l) => `${LANE_LABELS[l].name} (${LANE_LABELS[l].badge})`).join(", ");

export const TERMS: Record<TermId, TermDef> = {
  plan: { word: "Plan", hint: "What should change and how to tell it worked. A person who didn't write it approves it before work starts.", href: "/docs/concepts/plans" },
  change: { word: "Change", hint: "Like a pull request, plus its proof: one unit of work an agent pushes to its own fork.", href: "/docs/concepts/changes" },
  lane: { word: "Review lane", hint: `How much review a Change gets, decided from what it proves: ${laneLine}.`, href: "/docs/concepts/lanes" },
  evidence: { word: "Evidence", hint: "What the platform proves about a Change and signs: tests, red/green proof, coverage, API and dependency diffs.", href: "/docs/concepts/evidence" },
  walkthrough: { word: "Walkthrough", hint: "A short guide to a Change by a second agent, riskiest part first, every stop tied to evidence.", href: "/docs/concepts/tours" },
  calibrating: { word: "Calibrating", hint: "Auto-merge is off. People review everything until their lane picks agree with the platform's often enough.", href: "/docs/concepts/lanes#calibrating" },
  policy: { word: "Policy", hint: "The repo's rules for lanes, in .platform/policy.ts, always read from the default branch.", href: "/docs/guides/write-a-policy" },
  "merge-queue": { word: "Merge queue", hint: "The only thing that writes the default branch. It tests Changes together before they land.", href: "/docs/concepts/merge-queue" },
  unclaimed: { word: "Unclaimed repo", hint: "An agent made this repo without an account. It has previews only and is deleted after 7 days unless a person claims it.", href: "/docs/concepts/unclaimed-projects" },
  scopes: { word: "Scopes", hint: "What an account or agent may do at all. The repo role then decides per repo.", href: "/docs/concepts/principals-and-scopes#scopes" },
  attestation: { word: "Attestation", hint: "The platform's signature over the evidence, so anyone can check it later from a plain clone.", href: "/docs/concepts/evidence#signed-and-stored-twice" },
  "mission-control": { word: "Mission control", hint: "A live board of the agents working in this repo and where each of their Changes is.", href: "/docs/guides/make-a-change" },
  attempts: { word: "Attempts", hint: "Several agents tried the same Plan. Compare them by evidence and pick one; the others close.", href: "/docs/guides/make-a-change#6-ask-a-human-to-review" },
  reason: { word: "Reason", hint: "Why a Change needs at least a given lane. The highest reason wins; a missing measurement only raises it.", href: "/docs/reference/lane-reasons" },
  "scope-paths": { word: "Scope paths", hint: "The files a Plan's Changes may touch. A Change outside them is flagged as scope drift and gets a full review.", href: "/docs/concepts/plans#what-a-plan-holds" },
  rollout: { word: "Rollout", hint: "A merged Change deploys gradually behind its own flag and reverts itself if production gets worse.", href: "/docs/concepts/rollouts-and-flags" },
};

/** Scope ids in people's words. The raw id stays visible beside it, never alone. */
export const SCOPE_WORDS: Record<Scope, string> = {
  "repo:read": "Read repos, Plans, Changes and evidence",
  "plan:create": "Draft Plans",
  "change:create": "Open Changes and push to their forks",
  "plan:approve": "Approve or reject Plans",
  "change:review": "Review Changes",
  "repo:admin": "Manage members, deploy target and auto-merge",
  "policy:admin": "Change the review policy",
  "contents:read": "Clone the code (integrations)",
  webhooks: "Receive events (integrations)",
  "deployments:write": "Report deployments (integrations)",
  "checks:write": "Report checks (integrations)",
};

export function scopeWords(scope: string): string {
  return (SCOPE_WORDS as Record<string, string>)[scope] ?? scope;
}
