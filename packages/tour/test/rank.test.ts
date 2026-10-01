import type { EvidenceItem } from "@app/evidence";
import { describe, expect, it } from "vitest";
import { checkHunkRef, renderDiff } from "../src/diff.js";
import { lane2Anchor, rankHunks, refHitsCandidate, symbolName } from "../src/rank.js";
import {
  BREAKING_REASON,
  breakingApiDiff,
  breakingApiEvidence,
  diffOf,
  FORMAT_DECL_HEAD_LINE,
  file,
  hunk,
  plan,
} from "./support/scenario.js";

describe("rankHunks: breaking-api", () => {
  const diff = breakingApiDiff();
  const ranking = rankHunks({ diff, evidence: breakingApiEvidence(), plan: plan(), reasons: [BREAKING_REASON] });

  it("ranks the formatMoney declaration first, above a larger test hunk", () => {
    const top = ranking[0]!;
    expect(top).toMatchObject({ rank: 1, path: "src/format.ts", hunkIndex: 0 });
    const test = ranking.find((r) => r.path === "test/format.test.ts")!;
    expect(test.changedLines).toBeGreaterThan(top.changedLines);
    const breaking = top.factors.find((f) => f.code === "api-breaking")!;
    expect(breaking).toMatchObject({ evidenceRef: "public-api", symbols: ["formatMoney"], weight: 3 });
    expect(breaking.focus).toEqual({ file: "src/format.ts", startLine: FORMAT_DECL_HEAD_LINE, endLine: FORMAT_DECL_HEAD_LINE, side: "head" });
  });

  it("anchors the top hunk to the api.breaking Lane-2 reason", () => {
    const anchor = lane2Anchor(ranking[0]!, [BREAKING_REASON]);
    expect(anchor?.reason.code).toBe("api.breaking");
    // A Lane-2 reason anchored to a different evidence item does not count.
    expect(lane2Anchor(ranking[0]!, [{ ...BREAKING_REASON, evidenceRef: "other-api" }])).toBeNull();
    expect(lane2Anchor(ranking[0]!, [{ ...BREAKING_REASON, lane: 1 }])).toBeNull();
  });

  it("never locates symbols in docs", () => {
    const readme = ranking.find((r) => r.path === "README.md")!;
    expect(readme.factors).toEqual([]);
  });

  it("is deterministic", () => {
    const again = rankHunks({ diff, evidence: breakingApiEvidence(), plan: plan(), reasons: [BREAKING_REASON] });
    expect(again.map((r) => `${r.path}#${r.hunkIndex}`)).toEqual(ranking.map((r) => `${r.path}#${r.hunkIndex}`));
  });

  it("refHitsCandidate checks file and line overlap on the right side", () => {
    const top = ranking[0]!;
    expect(refHitsCandidate({ file: "src/format.ts", startLine: 13, endLine: 13, side: "head" }, top)).toBe(true);
    expect(refHitsCandidate({ file: "src/format.ts", startLine: 36, endLine: 39, side: "head" }, top)).toBe(false);
    expect(refHitsCandidate({ file: "src/index.ts", startLine: 5, endLine: 5, side: "head" }, top)).toBe(false);
  });
});

describe("rankHunks: tiers", () => {
  const big = (path: string, n: number, name = "v") =>
    file(path, [hunk(1, 1, Array.from({ length: n }, (_, i) => ["+", `const ${name}${i} = ${i};`] as ["+", string]))]);

  it("orders sensitive > breaking API > scope drift > dependencies > uncovered > survivors > size", () => {
    const diff = diffOf([
      big("src/huge.ts", 300),
      big("src/auth/session.ts", 2),
      big("src/api.ts", 2, "apiFn"),
      big("scripts/outside.ts", 2),
      file("package.json", [hunk(5, 5, [["-", '    "zod": "^3.0.0",'], ["+", '    "left-pad": "1.0.0",']])]),
      big("src/uncovered.ts", 3),
      big("src/mutants.ts", 3),
    ]);
    const evidence: EvidenceItem[] = [
      { id: "sensitive", kind: "sensitive-paths", status: "ok", patterns: ["**/auth/**"], hits: [{ path: "src/auth/session.ts", pattern: "**/auth/**" }] },
      {
        id: "api",
        kind: "public-api",
        status: "ok",
        classification: "breaking",
        packages: [{ name: "p", entry: "src/index.ts", added: [], removed: [], changed: [{ symbol: "apiFn0" }] }],
      },
      {
        id: "deps",
        kind: "dependencies",
        status: "ok",
        added: [{ name: "left-pad", version: "1.0.0", dev: false, manifest: "package.json" }],
        removed: [],
        changed: [],
        newInstallScripts: [],
        lockfileChanged: true,
      },
      {
        id: "cov",
        kind: "coverage",
        status: "ok",
        changedLines: 3,
        coveredChangedLines: 0,
        ratio: 0,
        files: [{ path: "src/uncovered.ts", changed: 3, covered: 0, uncoveredLines: [1, 2, 3] }],
      },
      {
        id: "mut",
        kind: "mutation",
        status: "ok",
        tool: "stryker",
        files: ["src/mutants.ts"],
        killed: 0,
        survived: 2,
        timedOut: 0,
        noCoverage: 0,
        score: 0,
        survivors: [
          { file: "src/mutants.ts", line: 1, mutator: "ArithmeticOperator" },
          { file: "src/mutants.ts", line: 2, mutator: "ArithmeticOperator" },
        ],
      },
    ];
    const p = plan({ scopePaths: ["src/**", "package.json"] });
    const ranking = rankHunks({ diff, evidence, plan: p });
    expect(ranking.map((r) => r.path)).toEqual([
      "src/auth/session.ts",
      "src/api.ts",
      "scripts/outside.ts",
      "package.json",
      "src/uncovered.ts",
      "src/mutants.ts",
      "src/huge.ts",
    ]);
    expect(ranking.find((r) => r.path === "package.json")!.factors[0]).toMatchObject({
      code: "dependency",
      reasonCodes: ["dependency.added"],
      weight: 3,
    });
  });

  it("raises a file named by any Lane-2 reason (e.g. a sensitive glob from the base policy)", () => {
    const diff = diffOf([big("src/big.ts", 50), big("src/billing/charge.ts", 1)]);
    const ranking = rankHunks({
      diff,
      evidence: [],
      plan: null,
      reasons: [{ code: "sensitive.hit", lane: 2, message: "Touches sensitive paths: src/billing/charge.ts." }],
    });
    expect(ranking[0]!.path).toBe("src/billing/charge.ts");
    expect(lane2Anchor(ranking[0]!, [{ code: "sensitive.hit", lane: 2, message: "x" }])).not.toBeNull();
  });

  it("flags platform policy and migration files", () => {
    const diff = diffOf([big("src/a.ts", 20), big(".platform/policy.ts", 1), big("db/migrations/0002.sql", 1)]);
    const ranking = rankHunks({ diff, evidence: [], plan: null });
    expect(ranking.slice(0, 2).map((r) => r.factors[0]?.code).sort()).toEqual(["migration", "policy-file"]);
  });

  it("extracts the last identifier of a qualified symbol", () => {
    expect(symbolName("Money#amount")).toBe("amount");
    expect(symbolName("ns.formatMoney")).toBe("formatMoney");
    expect(symbolName("default")).toBe("default");
    expect(symbolName("()")).toBeNull();
  });
});

describe("diff helpers", () => {
  const diff = breakingApiDiff();

  it("checkHunkRef keeps, clamps or rejects refs", () => {
    expect(checkHunkRef(diff, { file: "src/format.ts", startLine: 13, endLine: 13, side: "head" })).toMatchObject({ ok: true, clamped: false });
    expect(checkHunkRef(diff, { file: "src/format.ts", startLine: 20, endLine: 13, side: "head" })).toMatchObject({
      ok: true,
      ref: { startLine: 13, endLine: 20 },
    });
    expect(checkHunkRef(diff, { file: "src/format.ts", startLine: 2, endLine: 2, side: "base" })).toMatchObject({ ok: true });
    expect(checkHunkRef(diff, { file: "src/format.ts", startLine: 30, endLine: 31, side: "head" })).toEqual({ ok: false, reason: "outside-hunks" });
    expect(checkHunkRef(diff, { file: "nope.ts", startLine: 1, endLine: 1, side: "head" })).toEqual({ ok: false, reason: "unknown-file" });
  });

  it("renderDiff drops plain big hunks first and never drops the riskiest", () => {
    const ranking = rankHunks({ diff, evidence: breakingApiEvidence(), plan: plan() });
    const slots = ranking.map((r) => ({ path: r.path, hunkIndex: r.hunkIndex, rank: r.rank, hasRisk: r.factors.length > 0 }));
    const full = renderDiff(diff, slots, Number.POSITIVE_INFINITY);
    expect(full.omitted).toEqual([]);
    const tight = renderDiff(diff, slots, Math.floor(full.tokens / 2));
    const omitted = tight.omitted.map((o) => o.path);
    expect(omitted[0]).toBe("README.md"); // no risk factor: goes first
    expect(omitted).not.toContain("src/format.ts#0");
    expect(tight.text).toContain("export function formatMoney(value: Money, options: FormatOptions)");
    expect(tight.tokens).toBeLessThan(full.tokens);
  });

  it("renderDiff cuts the riskiest hunk short only when it alone exceeds the budget", () => {
    const ranking = rankHunks({ diff, evidence: breakingApiEvidence(), plan: plan() });
    const slots = ranking.map((r) => ({ path: r.path, hunkIndex: r.hunkIndex, rank: r.rank, hasRisk: r.factors.length > 0 }));
    const tiny = renderDiff(diff, slots, 150);
    expect(tiny.partial).toEqual([expect.objectContaining({ path: "src/format.ts", hunkIndex: 0 })]);
    expect(tiny.text).toContain("more lines not shown");
  });

  it("summarizes lockfile hunks instead of showing them", () => {
    const d = diffOf([file("pnpm-lock.yaml", [hunk(1, 1, [["+", "LOCKFILE-CONTENT: 1"]])])]);
    const r = renderDiff(d, [], Number.POSITIVE_INFINITY);
    expect(r.text).not.toContain("LOCKFILE-CONTENT");
    expect(r.omitted).toEqual([expect.objectContaining({ path: "pnpm-lock.yaml", why: "lockfile" })]);
  });
});
