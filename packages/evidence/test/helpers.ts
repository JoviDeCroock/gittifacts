import type { EvidenceItem, EvidencePayload } from "../src/index.js";

export const BASE_SHA = "1111111111111111111111111111111111111111";
export const HEAD_SHA = "2222222222222222222222222222222222222222";

export function sampleItems(): EvidenceItem[] {
  return [
    {
      id: "red-green",
      kind: "red-green",
      status: "ok",
      tests: [{ id: "t1", file: "test/math.test.ts", name: "div by zero throws" }],
      base: { sha: BASE_SHA, results: [{ id: "t1", outcome: "fail" }] },
      head: { sha: HEAD_SHA, results: [{ id: "t1", outcome: "pass" }] },
      verdict: "proven",
    },
    {
      id: "coverage",
      kind: "coverage",
      status: "ok",
      changedLines: 4,
      coveredChangedLines: 3,
      ratio: 0.75,
      files: [{ path: "src/math.ts", changed: 4, covered: 3, uncoveredLines: [12] }],
    },
    {
      id: "mutation",
      kind: "mutation",
      status: "error",
      note: "stryker crashed: café ☕ 😀",
      tool: "stryker",
      files: [],
      killed: 0,
      survived: 0,
      timedOut: 0,
      noCoverage: 0,
      score: 0,
      survivors: [],
    },
    {
      id: "sensitive-paths",
      kind: "sensitive-paths",
      status: "ok",
      patterns: [".github/**"],
      hits: [],
    },
  ];
}

export function samplePayload(overrides: Partial<EvidencePayload> = {}): EvidencePayload {
  return { changeId: "chg_01JABCDEF", headSha: HEAD_SHA, items: sampleItems(), ...overrides };
}

/** Deep clone through JSON (what a note round-trip does). */
export function jsonClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
