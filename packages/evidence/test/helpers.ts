import type { EvidenceItem, EvidencePayload, WhyRecord } from "../src/index.js";

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

/** A why-note record (refs/notes/why) as the merge queue builds it, landed as `landedSha`. */
export function sampleWhyRecord(landedSha: string, headSha: string = landedSha): WhyRecord {
  return {
    format: "gittifacts.why/v1",
    changeId: "chg_cli",
    title: "Guard division by zero",
    category: "fix",
    headSha,
    landedSha,
    author: { id: "ag_1", kind: "agent", name: "builder-bot" },
    accountable: { id: "usr_ada", kind: "human", name: "Ada" },
    plan: {
      id: "pln_1",
      title: "Division guard",
      intent: "div(x, 0) must throw instead of returning Infinity",
      acceptanceCriteria: ["div(1, 0) throws RangeError"],
      outOfScope: ["other operators"],
      approvedBy: { id: "usr_bo", kind: "human", name: "Bo" },
      approvedAt: "2026-10-01T11:00:00.000Z",
      approvalSignature: null,
    },
    lane: 1,
    laneReasons: [{ code: "signal.public-api", lane: 1, message: "public API changed" }],
    approvals: [
      {
        reviewer: { id: "usr_bo", kind: "human", name: "Bo" },
        headSha,
        at: "2026-10-01T11:30:00.000Z",
        source: "platform",
      },
    ],
    agentTrace: { provider: "claude-code", traceId: "trace-1" },
    evidenceId: "ev_1",
    landedAt: "2026-10-01T12:00:00.000Z",
  };
}
