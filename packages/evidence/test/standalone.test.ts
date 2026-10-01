import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type EvidenceItem, summarizeItem } from "../src/index.js";
import { sampleItems } from "./helpers.js";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)[^'"]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

describe("package boundaries", () => {
  const files = walk(srcDir);

  it("never imports other @app/* packages", () => {
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(IMPORT_RE)) {
        expect(m[1] ?? m[2], relative(srcDir, f)).not.toMatch(/^@app\//);
      }
    }
  });

  it("keeps Node-only modules under src/cli and src/node (Workers-safe root)", () => {
    for (const f of files) {
      const rel = relative(srcDir, f);
      if (rel.startsWith("cli/") || rel.startsWith("node/")) continue;
      for (const m of readFileSync(f, "utf8").matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2] ?? "";
        expect(spec, rel).not.toMatch(/^node:|^(fs|path|child_process|os|crypto|util)$/);
        expect(spec === "zod" || spec.startsWith("."), `${rel} imports ${spec}`).toBe(true);
        expect(spec, rel).not.toMatch(/\/(cli|node)\//);
      }
      const code = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      expect(code, rel).not.toMatch(/\bBuffer\b|\bprocess\./);
    }
  });
});

describe("summarizeItem", () => {
  it("summarizes every sample item", () => {
    expect(sampleItems().map(summarizeItem)).toEqual([
      "proven (1 test)",
      "75% of 4 changed executable lines covered",
      "measurement failed: stryker crashed: café ☕ 😀",
      "no hits (1 pattern)",
    ]);
  });

  it("covers every kind", () => {
    const sha = "a".repeat(40);
    const items: EvidenceItem[] = [
      {
        id: "t",
        kind: "test-run",
        status: "ok",
        sha,
        step: "test",
        runner: "vitest",
        passed: 10,
        failed: 1,
        skipped: 2,
        durationMs: 5,
        failures: [],
      },
      {
        id: "m",
        kind: "mutation",
        status: "ok",
        tool: "stryker",
        files: [],
        killed: 3,
        survived: 1,
        timedOut: 0,
        noCoverage: 0,
        score: 0.75,
        survivors: [],
      },
      {
        id: "m2",
        kind: "mutation",
        status: "skipped",
        note: "no valid mutants",
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
        id: "p",
        kind: "public-api",
        status: "ok",
        classification: "additive",
        packages: [{ name: "a", entry: ".", added: [{ symbol: "x" }], removed: [], changed: [] }],
      },
      {
        id: "d",
        kind: "dependencies",
        status: "ok",
        added: [],
        removed: [],
        changed: [],
        newInstallScripts: [{ name: "x", script: "postinstall", command: "y" }],
        lockfileChanged: true,
      },
      {
        id: "s",
        kind: "sensitive-paths",
        status: "ok",
        patterns: ["a", "b"],
        hits: [
          { path: "a", pattern: "a" },
          { path: "b", pattern: "b" },
          { path: "c", pattern: "b" },
          { path: "d", pattern: "b" },
        ],
      },
      { id: "v", kind: "preview", status: "ok", url: "https://x.example" },
      {
        id: "sc",
        kind: "screenshots",
        status: "ok",
        shots: [
          { route: "/", viewport: "mobile", diffRatio: 0.02 },
          { route: "/a", viewport: "desktop" },
        ],
      },
      { id: "at", kind: "agent-trace", status: "ok", provider: "claude", traceId: "tr_1" },
      {
        id: "tr",
        kind: "transform",
        status: "ok",
        transform: "prettier",
        command: "prettier -w .",
        verified: false,
        files: ["a"],
        mismatchedFiles: ["a"],
      },
      {
        id: "l",
        kind: "llm-judgment",
        status: "ok",
        question: "scope-drift",
        outcome: "concern",
        rationale: "r",
        model: "m",
      },
    ];
    expect(items.map(summarizeItem)).toEqual([
      "10 passed, 1 failed, 2 skipped (vitest)",
      "score 75% (3 killed, 0 timed out, 1 survived, 0 no coverage)",
      "skipped: no valid mutants",
      "additive (+1 -0 ~0)",
      "+0 -0 ~0, 1 new install script, lockfile changed",
      "4 hits: a, b, c, ...",
      "https://x.example",
      "2 shots, max diff 2%",
      "claude trace tr_1",
      "prettier: NOT reproduced (1 mismatched)",
      "scope-drift: concern (m)",
    ]);
  });
});
