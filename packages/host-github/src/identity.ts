/**
 * Who wrote a pull request (spec §3.2): a human, a known coding agent, or another bot
 * (Dependabot, Renovate). Author kind is an input to grading, never a way past the gates: every
 * kind gets the same lane rules.
 */
import type { IdentityKind } from "@app/host";

/** Bot accounts of coding agents (configurable per deployment through `extraAgents`). */
export const KNOWN_AGENT_LOGINS: readonly string[] = [
  "copilot-swe-agent[bot]",
  "Copilot",
  "devin-ai-integration[bot]",
  "claude[bot]",
  "cursor[bot]",
  "chatgpt-codex-connector[bot]",
  "google-labs-jules[bot]",
  "sweep-ai[bot]",
  "openhands-agent",
];

/** Branch prefixes coding agents push from when they act through a human's account. */
export const AGENT_BRANCH_PREFIXES: readonly string[] = [
  "copilot/",
  "codex/",
  "claude/",
  "cursor/",
  "devin/",
  "jules/",
];

export interface AuthorInput {
  login: string;
  /** GitHub's account type: "User" | "Bot" | "Organization". */
  type: string;
  /** The PR's head branch (agent conventions). */
  headRef?: string | null;
}

export function classifyAuthor(
  author: AuthorInput,
  opts: { extraAgents?: readonly string[] } = {},
): IdentityKind {
  const login = author.login;
  if (KNOWN_AGENT_LOGINS.includes(login) || (opts.extraAgents ?? []).includes(login)) {
    return "agent";
  }
  if (author.type === "Bot" || login.endsWith("[bot]")) return "bot";
  const ref = author.headRef ?? "";
  if (AGENT_BRANCH_PREFIXES.some((p) => ref.startsWith(p))) return "agent";
  return "human";
}
