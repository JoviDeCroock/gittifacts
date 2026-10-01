import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CoverageDelta,
  changedLineCoverage,
  createPathResolver,
  MutationScore,
  mergeCoverage,
  mutationScore,
  ProducerInputError,
  parseIstanbul,
  parseLcov,
  parseStrykerReport,
  parseUnifiedDiff,
} from "../src/index.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// The changed lines of the real diff fixture: math.ts [10,13,14,15,16], text.ts [10], ...
const changed = parseUnifiedDiff(fixture("rename-binary.u0.diff")).changedLines;

describe("parseLcov", () => {
  const lcov = parseLcov(fixture("lcov.info"));

  it("reads DA lines per SF record", () => {
    expect([...lcov.keys()]).toEqual([
      "/home/runner/work/app/app/src/math.ts",
      "/home/runner/work/app/app/src/text.ts",
      "/home/runner/work/app/app/packages/web/src/index.ts",
    ]);
    const math = lcov.get("/home/runner/work/app/app/src/math.ts");
    expect(math?.get(10)).toBe(3);
    expect(math?.get(15)).toBe(0);
    expect(math?.has(13)).toBe(false); // blank line: not executable
  });

  it("sums repeated records, tolerates CRLF, checksums and junk", () => {
    const text =
      "TN:a\r\nSF:x.ts\r\nDA:1,2\r\nDA:2,0,abc123\r\nend_of_record\r\nSF:x.ts\nDA:1,3\nDA:2,1\nDA:0,9\nDA:x,1\nend_of_record\nDA:9,9\n";
    const m = parseLcov(text);
    expect([...(m.get("x.ts") ?? new Map()).entries()]).toEqual([
      [1, 5],
      [2, 1],
    ]);
  });
});

describe("parseIstanbul", () => {
  it("uses statement start lines, max count per line, and unwraps {data}", () => {
    const m = parseIstanbul(fixture("coverage-final.json"));
    expect(
      [...(m.get("/home/runner/work/app/app/src/text.ts") ?? new Map()).entries()].sort(
        (a, b) => a[0] - b[0],
      ),
    ).toEqual([
      [2, 2],
      [6, 0],
      [10, 5],
      [14, 0],
    ]);
    expect(m.get("/home/runner/work/app/app/src/legacy.js")?.get(3)).toBe(7);
  });

  it("rejects non-istanbul input", () => {
    expect(() => parseIstanbul("nope")).toThrow(ProducerInputError);
    expect(() => parseIstanbul([1, 2])).toThrow(ProducerInputError);
    expect(() => parseIstanbul({ "a.ts": { s: {} } })).toThrow(/a\.ts/);
  });
});

describe("changedLineCoverage", () => {
  it("computes coverage of executable changed lines (real lcov + real diff)", () => {
    const item = changedLineCoverage(parseLcov(fixture("lcov.info")), changed);
    expect(CoverageDelta.parse(item)).toEqual(item);
    expect(item).toMatchObject({
      id: "coverage",
      status: "ok",
      changedLines: 5,
      coveredChangedLines: 3,
      ratio: 0.6,
      files: [
        { path: "src/math.ts", changed: 4, covered: 2, uncoveredLines: [15, 16] },
        { path: "src/text.ts", changed: 1, covered: 1, uncoveredLines: [] },
      ],
      unmeasuredFiles: ["docs/README.md", "src/café.ts", "src/with space.ts"],
    });
  });

  it("treatMissingAsUncovered counts absent source files", () => {
    const item = changedLineCoverage(parseLcov(fixture("lcov.info")), changed, {
      treatMissingAsUncovered: (p) => p.endsWith(".ts"),
    });
    expect(item.changedLines).toBe(7);
    expect(item.coveredChangedLines).toBe(3);
    expect(item.files.map((f) => f.path)).toEqual(
      ["src/math.ts", "src/text.ts", "src/café.ts", "src/with space.ts"].sort(),
    );
  });

  it("ratio is 1 when no executable line changed", () => {
    const item = changedLineCoverage(parseLcov(fixture("lcov.info")), {
      "src/math.ts": [4, 8, 13],
    });
    expect(item).toMatchObject({
      changedLines: 0,
      coveredChangedLines: 0,
      ratio: 1,
      files: [],
      status: "ok",
    });
  });

  it("an empty report with changed lines is an error, not a pass", () => {
    const item = changedLineCoverage(new Map(), { "src/a.ts": [1] });
    expect(item.status).toBe("error");
    expect(item.ratio).toBe(1);
    expect(item.unmeasuredFiles).toEqual(["src/a.ts"]);
  });

  it("strips an explicit root and merges lcov with istanbul", () => {
    const merged = mergeCoverage(
      parseLcov(fixture("lcov.info")),
      parseIstanbul(fixture("coverage-final.json")),
    );
    const item = changedLineCoverage(
      merged,
      { "src/text.ts": [6, 10], "src/legacy.js": [3] },
      {
        root: "/home/runner/work/app/app/",
      },
    );
    expect(item.files).toEqual([
      { path: "src/legacy.js", changed: 1, covered: 1, uncoveredLines: [] },
      { path: "src/text.ts", changed: 2, covered: 1, uncoveredLines: [6] },
    ]);
  });

  it("caps uncoveredLines at the schema limit", () => {
    const lines = new Map<number, number>();
    const changedBig: number[] = [];
    for (let i = 1; i <= 2500; i++) {
      lines.set(i, 0);
      changedBig.push(i);
    }
    const item = changedLineCoverage(new Map([["big.ts", lines]]), { "big.ts": changedBig });
    expect(item.files[0]?.uncoveredLines).toHaveLength(2000);
    expect(item.changedLines).toBe(2500);
    expect(() => CoverageDelta.parse(item)).not.toThrow();
  });
});

describe("createPathResolver", () => {
  it("matches exact, unique suffix, and refuses ambiguity", () => {
    const resolve = createPathResolver(["/ci/a/src/x.ts", "/ci/b/src/x.ts", "lib\\y.ts", "./z.ts"]);
    expect(resolve("a/src/x.ts")).toBe("/ci/a/src/x.ts");
    expect(resolve("src/x.ts")).toBeUndefined();
    expect(resolve("lib/y.ts")).toBe("lib\\y.ts");
    expect(resolve("z.ts")).toBe("./z.ts");
    expect(resolve("x.ts")).toBeUndefined();
    // a suffix must start at a path boundary
    expect(createPathResolver(["/ci/notsrc/x.ts"])("src/x.ts")).toBeUndefined();
  });
});

describe("mutationScore (Stryker report)", () => {
  const report = parseStrykerReport(fixture("stryker-mutation.json"));

  it("restricts to mutants on changed lines", () => {
    const item = mutationScore(report, changed);
    expect(MutationScore.parse(item)).toEqual(item);
    expect(item).toMatchObject({
      id: "mutation",
      status: "ok",
      tool: "stryker",
      files: ["src/math.ts"],
      killed: 2,
      survived: 2,
      timedOut: 1,
      noCoverage: 2,
    });
    expect(item.score).toBeCloseTo(3 / 7, 10);
    expect(item.survivors).toEqual([
      {
        file: "src/math.ts",
        line: 10,
        mutator: "ConditionalExpression",
        replacement: "false",
        status: "Survived",
      },
      {
        file: "src/math.ts",
        line: 10,
        mutator: "StringLiteral",
        replacement: '""',
        status: "Survived",
      },
      {
        file: "src/math.ts",
        line: 14,
        mutator: "BlockStatement",
        replacement: "{}",
        status: "NoCoverage",
      },
      {
        file: "src/math.ts",
        line: 15,
        mutator: "ArithmeticOperator",
        replacement: "a * b",
        status: "NoCoverage",
      },
    ]);
    expect(item.note).toMatch(/1 mutants on changed lines were not valid/);
  });

  it("multi-line mutants intersect any changed line in their span", () => {
    const item = mutationScore(report, { "src/math.ts": [6] });
    expect(item).toMatchObject({
      survived: 1,
      killed: 0,
      survivors: [{ line: 5, mutator: "BlockStatement" }],
    });
  });

  it("no mutants on changed lines → skipped with score 0", () => {
    const item = mutationScore(report, { "docs/README.md": [1] });
    expect(item).toMatchObject({ status: "skipped", score: 0, files: [], survivors: [] });
  });

  it("unknown statuses make the item an error", () => {
    const r = parseStrykerReport({
      schemaVersion: "2",
      files: {
        "a.ts": {
          mutants: [
            {
              id: 1,
              mutatorName: "X",
              location: { start: { line: 1 }, end: { line: 1 } },
              status: "Killed",
            },
            {
              id: 2,
              mutatorName: "X",
              location: { start: { line: 1 }, end: { line: 1 } },
              status: "Flaky",
            },
          ],
        },
      },
    });
    const item = mutationScore(r, { "a.ts": [1] });
    expect(item.status).toBe("error");
    expect(item.note).toMatch(/Flaky/);
  });

  it("rejects malformed reports", () => {
    expect(() => parseStrykerReport("{")).toThrow(ProducerInputError);
    expect(() =>
      parseStrykerReport({ schemaVersion: "1", files: { "a.ts": { mutants: [{}] } } }),
    ).toThrow(/mutation-testing-report-schema/);
  });
});
