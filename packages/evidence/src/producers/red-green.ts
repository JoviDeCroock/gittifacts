/**
 * Red→green proof: the change's new/changed tests fail on base and pass on head.
 *
 * - "proven": ≥1 listed test is red on base (fail / error / missing) AND every listed
 *   test is green on head.
 * - "not-proven": tests are listed but that pattern does not hold.
 * - "no-tests": nothing is listed.
 *
 * Conservative with duplicate results (retries, multiple runners): a test is red on
 * base only if NO base result passed, and green on head only if EVERY head result passed.
 */
import type { RedGreenProof, TestOutcome, TestRef } from "../schema.js";

export interface TestResult {
  id: string;
  outcome: TestOutcome;
}

export type RedGreenVerdict = RedGreenProof["verdict"];

export interface RedGreenTestDetail {
  id: string;
  base: TestOutcome;
  head: TestOutcome;
  /** Failed/errored/missing on base. */
  red: boolean;
  /** Passed on head. */
  green: boolean;
}

const SEVERITY: Record<TestOutcome, number> = { error: 3, fail: 2, missing: 1, pass: 0 };

function group(results: readonly TestResult[]): Map<string, TestOutcome[]> {
  const m = new Map<string, TestOutcome[]>();
  for (const r of results) {
    const list = m.get(r.id);
    if (list) list.push(r.outcome);
    else m.set(r.id, [r.outcome]);
  }
  return m;
}

function worst(outcomes: readonly TestOutcome[]): TestOutcome {
  let w: TestOutcome = "pass";
  for (const o of outcomes) if (SEVERITY[o] > SEVERITY[w]) w = o;
  return w;
}

function uniqueIds(tests: readonly { id: string }[]): string[] {
  return [...new Set(tests.map((t) => t.id))];
}

export function redGreenDetails(
  tests: readonly { id: string }[],
  baseResults: readonly TestResult[],
  headResults: readonly TestResult[],
): RedGreenTestDetail[] {
  const base = group(baseResults);
  const head = group(headResults);
  return uniqueIds(tests).map((id) => {
    const b = base.get(id) ?? [];
    const h = head.get(id) ?? [];
    const baseOutcome: TestOutcome =
      b.length === 0 ? "missing" : b.includes("pass") ? "pass" : worst(b);
    const headOutcome: TestOutcome = h.length === 0 ? "missing" : worst(h);
    return {
      id,
      base: baseOutcome,
      head: headOutcome,
      red: baseOutcome !== "pass",
      green: headOutcome === "pass",
    };
  });
}

export function redGreenVerdict(
  tests: readonly { id: string }[],
  baseResults: readonly TestResult[],
  headResults: readonly TestResult[],
): RedGreenVerdict {
  const details = redGreenDetails(tests, baseResults, headResults);
  if (details.length === 0) return "no-tests";
  return details.some((d) => d.red) && details.every((d) => d.green) ? "proven" : "not-proven";
}

export interface RedGreenInput {
  id?: string;
  tests: TestRef[];
  base: { sha: string; results: TestResult[] };
  head: { sha: string; results: TestResult[] };
  note?: string;
  logRef?: string;
}

/** Build a `red-green` evidence item (status "ok": the measurement itself succeeded). */
export function redGreenProof(input: RedGreenInput): RedGreenProof {
  const item: RedGreenProof = {
    id: input.id ?? "red-green",
    kind: "red-green",
    status: "ok",
    tests: input.tests,
    base: {
      sha: input.base.sha,
      results: input.base.results.map(({ id, outcome }) => ({ id, outcome })),
    },
    head: {
      sha: input.head.sha,
      results: input.head.results.map(({ id, outcome }) => ({ id, outcome })),
    },
    verdict: redGreenVerdict(input.tests, input.base.results, input.head.results),
  };
  if (input.note !== undefined) item.note = input.note;
  if (input.logRef !== undefined) item.logRef = input.logRef;
  return item;
}
