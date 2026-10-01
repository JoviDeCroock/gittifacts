/** Builders for resolver tests: merge documents shaped like `gittifacts-runner merge-attempt` output. */
import type { Plan } from "@app/domain";
import type { ConflictFileDoc, MergeAttempt } from "../src/merge-doc.js";
import type { ResolverInput } from "../src/resolver.js";

export const BASE = "a".repeat(40);
export const ONTO = "b".repeat(40);
export const HEAD = "c".repeat(40);
export const CONFLICT = "d".repeat(40);
export const MERGED = "e".repeat(40);
export const UP_SHA = "f".repeat(40);

export const MARKERS = { size: 13, ours: "upstream", base: "base", theirs: "change" } as const;
const O = `${"<".repeat(13)} upstream`;
const B = `${"|".repeat(13)} base`;
const M = "=".repeat(13);
const C = `${">".repeat(13)} change`;

/** A diff3 region as merge-attempt writes it. */
export function region(ours: string[], base: string[], theirs: string[]): string[] {
  return [O, ...ours, B, ...base, M, ...theirs, C];
}

export const lines = (...ls: string[]) => `${ls.join("\n")}\n`;

/** src/handlers.ts: both sides appended a handler and a map entry (two regions). */
export const HANDLERS_MERGED = lines(
  "export type Handler = (input: string) => string;",
  "",
  "export const upper: Handler = (s) => s.toUpperCase();",
  ...region(
    ['export const reverse: Handler = (s) => [...s].reverse().join("");'],
    [],
    ["export const trim: Handler = (s) => s.trim();"],
  ),
  "",
  "export const handlers: Record<string, Handler> = {",
  "  upper,",
  ...region(["  reverse,"], [], ["  trim,"]),
  "};",
);

export const HANDLERS_RESOLVED = lines(
  "export type Handler = (input: string) => string;",
  "",
  "export const upper: Handler = (s) => s.toUpperCase();",
  'export const reverse: Handler = (s) => [...s].reverse().join("");',
  "export const trim: Handler = (s) => s.trim();",
  "",
  "export const handlers: Record<string, Handler> = {",
  "  upper,",
  "  reverse,",
  "  trim,",
  "};",
);

export function conflictFile(overrides: Partial<ConflictFileDoc> = {}): ConflictFileDoc {
  return {
    path: "src/handlers.ts",
    kind: "content",
    mode: "100644",
    binary: false,
    tooLarge: false,
    base: "base\n",
    ours: "ours\n",
    theirs: "theirs\n",
    merged_with_markers: HANDLERS_MERGED,
    ...overrides,
  };
}

export function conflictDoc(files: ConflictFileDoc[] = [conflictFile()]): MergeAttempt {
  return {
    status: "conflict",
    base: BASE,
    onto: ONTO,
    head: HEAD,
    conflictSha: CONFLICT,
    files,
    markers: { ...MARKERS },
    upstreamCommits: [{ sha: UP_SHA, subject: "Add the reverse handler" }],
    messages: ["CONFLICT (content): Merge conflict in src/handlers.ts"],
  };
}

export function cleanDoc(): MergeAttempt {
  return {
    status: "clean",
    base: BASE,
    onto: ONTO,
    head: HEAD,
    newSha: MERGED,
    files: [],
    markers: { ...MARKERS },
    upstreamCommits: [],
    messages: [],
  };
}

export function plan(id: string, title: string, overrides: Partial<Plan> = {}): Plan {
  return {
    id,
    repoId: "repo_1",
    title,
    intent: `${title}. Keep everything else as it is.`,
    acceptanceCriteria: [`${title} works`],
    outOfScope: [],
    riskDeclarations: [],
    scopePaths: ["src/**", "test/**"],
    affectedRoutes: [],
    status: "approved",
    authorId: "agent_author",
    approvedBy: "human_owner",
    approvedAt: "2026-10-01T10:00:00.000Z",
    approvalSignature: "sig",
    supersedes: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    ...overrides,
  };
}

export function input(overrides: Partial<ResolverInput> = {}): ResolverInput {
  return {
    change: { id: "chg_trim", title: "Add a trim handler", baseSha: BASE, headSha: HEAD },
    plan: plan("plan_trim", "Add a trim handler"),
    diff: "diff --git a/src/handlers.ts b/src/handlers.ts\n+export const trim\n",
    upstream: [
      {
        changeId: "chg_reverse",
        sha: UP_SHA,
        title: "Add the reverse handler",
        plan: plan("plan_reverse", "Add the reverse handler"),
        diff: "diff --git a/src/handlers.ts b/src/handlers.ts\n+export const reverse\n",
      },
    ],
    merge: conflictDoc(),
    budget: { changeId: "chg_trim", limitUsd: 0.5, spentUsd: 0 },
    ...overrides,
  };
}

/** The correct region answer for HANDLERS_MERGED. */
export function goodAnswer(overrides: Record<string, unknown> = {}) {
  return {
    status: "resolved",
    regions: [
      {
        file: "src/handlers.ts",
        conflict: 1,
        text: 'export const reverse: Handler = (s) => [...s].reverse().join("");\nexport const trim: Handler = (s) => s.trim();',
      },
      { file: "src/handlers.ts", conflict: 2, text: "  reverse,\n  trim,\n" },
    ],
    files: [],
    semanticConflictWith: null,
    rationale: "Both sides added a handler; kept both definitions and both map entries.",
    ...overrides,
  };
}
