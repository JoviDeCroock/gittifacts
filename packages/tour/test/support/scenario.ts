/**
 * Builders for diffs, evidence and classifications, plus the scenarios the tests (and the live
 * script) run against. The breaking-api scenario mirrors fixtures/breaking-api: formatMoney gains a
 * required `options` parameter.
 */
import type { ClassifyResult } from "@app/classifier";
import type { Change, ChangeDiff, ChangeDiffFile, DiffHunk, DiffLine, LaneReason, Plan } from "@app/domain";
import type { EvidenceItem, SignedEvidence } from "@app/evidence";
import type { ModelTour, ModelTourStop } from "../../src/schema.js";
import type { TourInput } from "../../src/tour.js";

export const BASE_SHA = "a".repeat(40);
export const HEAD_SHA = "b".repeat(40);
export const CHANGE_ID = "chg_breaking_api";

type Line = [kind: " " | "+" | "-", text: string];

/** Build a hunk from lines; numbers are assigned from the starts. */
export function hunk(oldStart: number, newStart: number, lines: readonly Line[], header = ""): DiffHunk {
  let oldNo = oldStart;
  let newNo = newStart;
  const out: DiffLine[] = [];
  for (const [k, text] of lines) {
    if (k === " ") out.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text });
    else if (k === "+") out.push({ kind: "add", oldNo: null, newNo: newNo++, text });
    else out.push({ kind: "del", oldNo: oldNo++, newNo: null, text });
  }
  const oldLines = out.filter((l) => l.kind !== "add").length;
  const newLines = out.filter((l) => l.kind !== "del").length;
  return {
    header: header || `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
    oldStart: oldLines === 0 ? 0 : oldStart,
    oldLines,
    newStart: newLines === 0 ? 0 : newStart,
    newLines,
    lines: out,
  };
}

export function file(
  path: string,
  hunks: DiffHunk[],
  opts: Partial<Pick<ChangeDiffFile, "status" | "previousPath" | "transformVerified" | "binary" | "truncated">> = {},
): ChangeDiffFile {
  const additions = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "add").length, 0);
  const deletions = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "del").length, 0);
  return {
    path,
    previousPath: opts.previousPath ?? null,
    status: opts.status ?? "modified",
    additions,
    deletions,
    binary: opts.binary ?? false,
    transformVerified: opts.transformVerified ?? false,
    hunks,
    truncated: opts.truncated ?? false,
  };
}

export function diffOf(files: ChangeDiffFile[]): ChangeDiff {
  return {
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

export function signed(items: EvidenceItem[], changeId = CHANGE_ID, headSha = HEAD_SHA): SignedEvidence {
  return {
    changeId,
    headSha,
    items,
    attestation: {
      v: 1,
      alg: "Ed25519",
      keyId: "test-key",
      payloadDigest: "digest",
      signature: "signature",
      signedAt: "2026-10-01T12:00:00.000Z",
      signer: "gittifacts-test",
    },
  };
}

export function classification(lane: 0 | 1 | 2, reasons: LaneReason[] = []): ClassifyResult {
  return {
    lane,
    computedLane: lane,
    reasons,
    shadow: false,
    blocked: false,
    requiresHumanApproval: false,
    checklist: [],
  };
}

export function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "plan_money_symbols",
    repoId: "repo_money",
    title: "Let formatMoney() render currency symbols",
    intent:
      "Product wants amounts like €1234.56 in receipts. Give formatMoney an options parameter with a required style and update every caller in this repository.",
    acceptanceCriteria: [
      'formatMoney(value, { style: "code" }) returns exactly what formatMoney(value) returned before',
      'formatMoney(value, { style: "symbol" }) returns e.g. €1234.56, $0.05, ¥980 and -£12.30',
      "parseMoney still parses the code style",
      "README examples use the new signature",
    ],
    outOfScope: ["Locale-aware formatting via Intl", "Parsing the symbol style"],
    riskDeclarations: [
      { area: "public API", description: "Breaking: formatMoney gains a required options parameter." },
    ],
    scopePaths: ["src/format.ts", "src/index.ts", "test/format.test.ts", "README.md"],
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

// ---------------------------------------------------------------- breaking-api

/** src/format.ts hunk 1: the formatMoney signature change. Head lines 1-26. */
export const FORMAT_DECL_HUNK = hunk(1, 1, [
  [" ", 'import { minorDigits, requireCurrency } from "./internal/currency.js";'],
  ["-", 'import { type Money, money } from "./money.js";'],
  ["+", 'import { type CurrencyCode, type Money, money } from "./money.js";'],
  ["+", ""],
  ["+", "export interface FormatOptions {"],
  ["+", '  readonly style: "code" | "symbol";'],
  ["+", "}"],
  ["+", ""],
  ["+", 'const SYMBOLS: Readonly<Record<CurrencyCode, string>> = { EUR: "€", USD: "$", GBP: "£", JPY: "¥" };'],
  [" ", ""],
  [" ", "/**"],
  ["-", " * Formats money as a plain decimal followed by its ISO code: `-1234.50 EUR`, `980 JPY`."],
  ["+", " * Formats money in the requested style. Both styles are deterministic and locale-independent."],
  [" ", " */"],
  ["-", "export function formatMoney(value: Money): string {"],
  ["+", "export function formatMoney(value: Money, options: FormatOptions): string {"],
  [" ", "  const digits = minorDigits(value.currency);"],
  [" ", '  const sign = value.amount < 0 ? "-" : "";'],
  [" ", "  const absolute = Math.abs(value.amount);"],
  ["-", "  if (digits === 0) {"],
  ["-", "    return `${sign}${absolute} ${value.currency}`;"],
  ["-", "  }"],
  [" ", "  const scale = 10 ** digits;"],
  ["-", "  const whole = Math.floor(absolute / scale);"],
  ["-", '  const fraction = String(absolute % scale).padStart(digits, "0");'],
  ["-", "  return `${sign}${whole}.${fraction} ${value.currency}`;"],
  ["+", "  const number ="],
  ["+", "    digits === 0"],
  ["+", "      ? String(absolute)"],
  ["+", '      : `${Math.floor(absolute / scale)}.${String(absolute % scale).padStart(digits, "0")}`;'],
  ["+", '  return options.style === "symbol"'],
  ["+", "    ? `${sign}${SYMBOLS[value.currency]}${number}`"],
  ["+", "    : `${sign}${number} ${value.currency}`;"],
  [" ", "}"],
]);
/** The head line of `export function formatMoney(value: Money, options: FormatOptions)`. */
export const FORMAT_DECL_HEAD_LINE: number = (() => {
  const line = FORMAT_DECL_HUNK.lines.find((l) => l.kind === "add" && l.text.startsWith("export function formatMoney"));
  if (line?.newNo == null) throw new Error("scenario: declaration line missing");
  return line.newNo;
})();

/** src/format.ts hunk 2: parseMoney's doc comment mentions formatMoney. */
export const FORMAT_DOC_HUNK = hunk(22, 36, [
  [" ", "const MONEY_PATTERN = /^(-?)(\\d+)(?:\\.(\\d+))? ([A-Z]{3})$/;"],
  [" ", ""],
  ["-", "/** Parses the output of {@link formatMoney} back into Money. Throws on anything else. */"],
  ["+", '/** Parses the `"code"` style of {@link formatMoney} back into Money. Throws on anything else. */'],
  [" ", "export function parseMoney(input: string): Money {"],
]);

function testHunk(): DiffHunk {
  const lines: Line[] = [[" ", 'describe("formatMoney", () => {']];
  for (const [amount, cur, out] of [
    ["123456", "EUR", "1234.56 EUR"],
    ["5", "USD", "0.05 USD"],
    ["980", "JPY", "980 JPY"],
    ["-1230", "GBP", "-12.30 GBP"],
  ] as const) {
    lines.push(["-", `  expect(formatMoney(money(${amount}, "${cur}"))).toBe("${out}");`]);
    lines.push(["+", `  expect(formatMoney(money(${amount}, "${cur}"), { style: "code" })).toBe("${out}");`]);
  }
  lines.push([" ", "});"], ["+", ""], ["+", 'describe("formatMoney with style: symbol", () => {']);
  lines.push(["+", '  it("puts the currency symbol in front of the amount", () => {']);
  for (const [amount, cur, out] of [
    ["123456", "EUR", "€1234.56"],
    ["5", "USD", "$0.05"],
    ["980", "JPY", "¥980"],
  ] as const) {
    lines.push(["+", `    expect(formatMoney(money(${amount}, "${cur}"), { style: "symbol" })).toBe("${out}");`]);
  }
  for (let cents = 1; cents <= 24; cents++) {
    lines.push(["+", `    expect(formatMoney(money(${cents}, "USD"), { style: "symbol" })).toBe("$0.${String(cents).padStart(2, "0")}");`]);
  }
  lines.push(["+", "  });"], ["+", '  it("puts the minus sign before the symbol", () => {']);
  lines.push(["+", '    expect(formatMoney(money(-1230, "GBP"), { style: "symbol" })).toBe("-£12.30");']);
  lines.push(["+", "  });"], ["+", "});"]);
  return hunk(10, 10, lines);
}

export function breakingApiDiff(): ChangeDiff {
  return diffOf([
    file("README.md", [
      hunk(12, 12, [
        [" ", "```ts"],
        ["-", 'formatMoney(money(123456, "EUR")); // "1234.56 EUR"'],
        ["+", 'formatMoney(money(123456, "EUR"), { style: "code" }); // "1234.56 EUR"'],
        ["+", 'formatMoney(money(123456, "EUR"), { style: "symbol" }); // "€1234.56"'],
        [" ", "```"],
      ]),
    ]),
    file("src/format.ts", [FORMAT_DECL_HUNK, FORMAT_DOC_HUNK]),
    file("src/index.ts", [
      hunk(4, 4, [
        [" ", 'export { allocate } from "./allocate.js";'],
        ["+", 'export type { FormatOptions } from "./format.js";'],
        [" ", 'export { formatMoney, parseMoney } from "./format.js";'],
      ]),
    ]),
    file("test/format.test.ts", [testHunk()]),
  ]);
}

export const RED_GREEN_TESTS = [
  { id: "t1", file: "test/format.test.ts", name: "formatMoney with style: symbol > puts the currency symbol in front of the amount" },
  { id: "t2", file: "test/format.test.ts", name: "formatMoney with style: symbol > puts the minus sign before the symbol" },
];

export function breakingApiEvidence(): EvidenceItem[] {
  return [
    {
      id: "red-green",
      kind: "red-green",
      status: "ok",
      tests: RED_GREEN_TESTS,
      base: { sha: BASE_SHA, results: [{ id: "t1", outcome: "fail" }, { id: "t2", outcome: "fail" }] },
      head: { sha: HEAD_SHA, results: [{ id: "t1", outcome: "pass" }, { id: "t2", outcome: "pass" }] },
      verdict: "proven",
    },
    {
      id: "test-run",
      kind: "test-run",
      status: "ok",
      sha: HEAD_SHA,
      step: "test",
      runner: "vitest",
      passed: 24,
      failed: 0,
      skipped: 0,
      durationMs: 812,
      failures: [],
    },
    {
      id: "coverage",
      kind: "coverage",
      status: "ok",
      changedLines: 20,
      coveredChangedLines: 20,
      ratio: 1,
      files: [{ path: "src/format.ts", changed: 20, covered: 20, uncoveredLines: [] }],
    },
    {
      id: "mutation",
      kind: "mutation",
      status: "ok",
      tool: "stryker",
      files: ["src/format.ts"],
      killed: 18,
      survived: 0,
      timedOut: 0,
      noCoverage: 0,
      score: 1,
      survivors: [],
    },
    {
      id: "public-api",
      kind: "public-api",
      status: "ok",
      classification: "breaking",
      packages: [
        {
          name: "money",
          entry: "src/index.ts",
          added: [{ symbol: "FormatOptions", after: 'interface FormatOptions { readonly style: "code" | "symbol" }' }],
          removed: [],
          changed: [
            {
              symbol: "formatMoney",
              before: "function formatMoney(value: Money): string",
              after: "function formatMoney(value: Money, options: FormatOptions): string",
            },
          ],
        },
      ],
    },
    {
      id: "dependencies",
      kind: "dependencies",
      status: "ok",
      added: [],
      removed: [],
      changed: [],
      newInstallScripts: [],
      lockfileChanged: false,
    },
    { id: "sensitive-paths", kind: "sensitive-paths", status: "ok", patterns: ["**/auth/**"], hits: [] },
  ];
}

export const BREAKING_REASON: LaneReason = {
  code: "api.breaking",
  lane: 2,
  message: "Public API has breaking changes: formatMoney.",
  evidenceRef: "public-api",
};

export function breakingApiInput(overrides: Partial<TourInput> = {}): TourInput {
  return {
    change: {
      id: CHANGE_ID,
      title: "Let formatMoney() render currency symbols",
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
    },
    plan: plan(),
    diff: breakingApiDiff(),
    evidence: signed(breakingApiEvidence()),
    classification: classification(2, [
      BREAKING_REASON,
      { code: "tests.passed", lane: 0, message: "24 test(s) passed across 1 test run(s)." },
    ]),
    budget: { changeId: CHANGE_ID, limitUsd: 5, spentUsd: 0 },
    ...overrides,
  };
}

/** A full Change, including the author's summary, for "never in the prompt" tests. */
export function fullChange(summary: string): Change {
  return {
    id: CHANGE_ID,
    repoId: "repo_money",
    planId: "plan_money_symbols",
    title: "Let formatMoney() render currency symbols",
    claim: { category: "feature", summary },
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    forkName: "task-chg_breaking_api",
    authorId: "agent_author",
    status: "running",
    computedLane: null,
    lane: null,
    laneReasons: [],
    evidenceId: null,
    tourId: null,
    flagKey: null,
    mergedSha: null,
    rolloutState: null,
    revertOf: null,
    revertedBy: null,
    agentTraceId: null,
    createdAt: "2026-10-01T11:00:00.000Z",
    updatedAt: "2026-10-01T11:00:00.000Z",
  };
}

// ---------------------------------------------------------------- model replies

export function stop(overrides: Partial<ModelTourStop> = {}): ModelTourStop {
  return {
    kind: "other",
    title: "A stop",
    why: "Because it matters.",
    hunkRefs: [],
    evidenceRefs: [],
    verdict: "unproven",
    ...overrides,
  };
}

export const INTENT_STOP = stop({
  kind: "intent",
  title: "formatMoney gains a style option",
  why: "The plan asks for a symbol style next to today's code style. The diff adds FormatOptions with a required style and keeps the code output unchanged.",
  hunkRefs: [{ file: "src/format.ts", startLine: 4, endLine: 9, side: "head" }],
  verdict: "unproven",
});

export const BEHAVIOR_STOP = stop({
  kind: "behavior",
  title: "Symbol style renders €1234.56",
  why: "New tests show formatMoney(money(123456, 'EUR'), { style: 'symbol' }) returns €1234.56 and failed on base.",
  hunkRefs: [{ file: "test/format.test.ts", startLine: 16, endLine: 24, side: "head" }],
  evidenceRefs: ["red-green"],
  verdict: "proven",
});

export const RISK_DECL_STOP = stop({
  kind: "risk",
  title: "formatMoney now requires options",
  why: "Every existing call formatMoney(value) stops compiling. The plan declares this breaking change.",
  hunkRefs: [{ file: "src/format.ts", startLine: FORMAT_DECL_HEAD_LINE, endLine: FORMAT_DECL_HEAD_LINE, side: "head" }],
  evidenceRefs: ["public-api"],
  verdict: "risk",
});

export const PROOF_STOP = stop({
  kind: "proof",
  title: "Red-green proof for the symbol style",
  why: "Both symbol-style tests fail on base and pass on head; coverage of changed lines is 100%.",
  hunkRefs: [{ file: "test/format.test.ts", startLine: 16, endLine: 24, side: "head" }],
  evidenceRefs: ["red-green", "coverage"],
  verdict: "proven",
});

export const UNCOVERED_STOP = stop({
  kind: "uncovered",
  title: "Downstream callers are not checked",
  why: "Nothing here builds packages that depend on this one, so their breakage is not measured.",
  verdict: "unproven",
});

export function goodModelTour(overrides: Partial<ModelTour> = {}): ModelTour {
  return {
    stops: [INTENT_STOP, BEHAVIOR_STOP, RISK_DECL_STOP, PROOF_STOP, UNCOVERED_STOP],
    leastConfident: ["Whether any caller outside this repository still uses the one-argument form."],
    notDone: ["Did not check the README renders correctly."],
    ...overrides,
  };
}
