/**
 * Plain-words copy for the consent and device screens:
 *
 *   "Claude Code wants to: open Changes on acme/api · read acme/api"
 *   "It can never: approve plans or changes · change policy · administer repositories"
 *
 * Pure (no DOM, no clocks), so the exact sentences are unit-tested. The screens render the parts
 * (`can`, `never`) as lists and use `summary` for the heading and the document title.
 */
import type { Scope } from "@app/domain";

/** Repos the session would act on: display names, or every repo (an explicit choice). */
export type RepoSelection = { kind: "some"; names: readonly string[] } | { kind: "all" };

export interface ConsentCopyInput {
  clientName: string;
  scopes: readonly Scope[];
  repos: RepoSelection;
  /** Scopes an agent can never hold (from the server); defaults to the four approval-class ones. */
  never?: readonly Scope[];
}

export interface ConsentCopy {
  /** "Claude Code wants to:" */
  lead: string;
  /** One phrase per granted capability, most consequential first. */
  can: string[];
  /** "Claude Code wants to: open Changes on acme/api · read acme/api" */
  summary: string;
  /** Things no agent can do, whatever is picked. */
  never: string[];
  /** "It can never approve plans or changes, change policy or administer repositories." */
  neverSentence: string;
}

const DEFAULT_NEVER: readonly Scope[] = ["plan:approve", "change:review", "policy:admin", "repo:admin"];

/** Most consequential first: opening Changes is the point of a session. */
const ORDER: readonly Scope[] = ["change:create", "plan:create", "repo:read"];

/** "acme/api", "acme/api and acme/web", "acme/api, acme/web and 2 more", "all your repositories". */
export function repoPhrase(repos: RepoSelection): string {
  if (repos.kind === "all") return "all your repositories";
  const names = [...new Set(repos.names.map((n) => n.trim()).filter((n) => n.length > 0))];
  if (names.length === 0) return "no repository yet";
  if (names.length === 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const rest = names.length - 2;
  return `${names[0]}, ${names[1]} and ${rest} more`;
}

function scopePhrase(scope: Scope, where: string): string | null {
  switch (scope) {
    case "change:create":
      return `open Changes on ${where}`;
    case "plan:create":
      return `draft Plans for ${where}`;
    case "repo:read":
      return `read ${where}`;
    default:
      // Approval-class scopes are never granted to an agent, so they never appear as "can".
      return null;
  }
}

/** Approval-class scopes in words; plan:approve and change:review read as one thing. */
export function neverPhrases(never: readonly Scope[]): string[] {
  const out: string[] = [];
  if (never.includes("plan:approve") || never.includes("change:review")) out.push("approve plans or changes");
  if (never.includes("policy:admin")) out.push("change policy");
  if (never.includes("repo:admin")) out.push("administer repositories");
  return out;
}

/** "a", "a or b", "a, b or c" */
function orList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

export function consentCopy(input: ConsentCopyInput): ConsentCopy {
  const name = input.clientName.trim() || "This app";
  const where = repoPhrase(input.repos);
  const can = ORDER.filter((s) => input.scopes.includes(s))
    .map((s) => scopePhrase(s, where))
    .filter((p): p is string => p !== null);
  const lead = `${name} wants to:`;
  const never = neverPhrases(input.never ?? DEFAULT_NEVER);
  return {
    lead,
    can,
    summary: can.length > 0 ? `${lead} ${can.join(" · ")}` : `${name} asks for nothing yet. Pick what it may do.`,
    never,
    neverSentence: never.length > 0 ? `It can never ${orList(never)}.` : "",
  };
}

/** "for 1 day", "for 30 days" */
export function sessionLengthPhrase(days: number): string {
  return days === 1 ? "for 1 day" : `for ${days} days`;
}

/** Human labels for what the token reaches. */
export function audiencePhrase(labels: readonly string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return `through the ${labels[0]}`;
  return `through the ${labels.slice(0, -1).join(", ")} and the ${labels[labels.length - 1]}`;
}

/** Device user codes are shown and typed as XXXX-XXXX; the server ignores dashes and case. */
export function formatUserCode(raw: string): string {
  const clean = raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}
