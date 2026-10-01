import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { declaredEntries, discoverEntries, extractPackageSurfaces, mapToSource } from "../src/lib/api-surface.js";
import { isMeasuredSource, isTestFile, isTestSupportFile, lineRanges, measuredChangedLines } from "../src/lib/patterns.js";
import { detectTestRunner, parseJsonReport, runnerArgs, shellWords } from "../src/lib/test-runner.js";
import { detectPreview } from "../src/commands/preview.js";
import { REPO_ROOT } from "./helpers.js";

const dirs: string[] = [];
function tmp(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gittifacts-units-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("patterns", () => {
  it("recognises vitest/jest test files", () => {
    expect(isTestFile("test/a.test.ts")).toBe(true);
    expect(isTestFile("src/x.spec.tsx")).toBe(true);
    expect(isTestFile("src/__tests__/x.ts")).toBe(true);
    expect(isTestFile("src/x.ts")).toBe(false);
    expect(isTestFile("node_modules/a/a.test.ts")).toBe(false);
  });

  it("treats test helpers as support files and keeps them out of measured source", () => {
    expect(isTestSupportFile("test/helpers.ts")).toBe(true);
    expect(isMeasuredSource("test/helpers.ts")).toBe(false);
    expect(isMeasuredSource("src/money.ts")).toBe(true);
    expect(isMeasuredSource("src/types.d.ts")).toBe(false);
    expect(isMeasuredSource("vitest.config.ts")).toBe(false);
    expect(isMeasuredSource(".platform/policy.ts")).toBe(false);
    expect(isMeasuredSource("README.md")).toBe(false);
  });

  it("restricts changed lines and collapses ranges", () => {
    expect(measuredChangedLines({ "src/a.ts": [3, 1, 2], "README.md": [1], "test/a.test.ts": [4] })).toEqual({ "src/a.ts": [3, 1, 2] });
    expect(lineRanges([5, 1, 2, 3, 9, 10])).toEqual([
      [1, 3],
      [5, 5],
      [9, 10],
    ]);
  });
});

describe("test runner detection", () => {
  it("splits shell words with quotes", () => {
    expect(shellWords(`vitest run --config "a b.ts" 'x'`)).toEqual(["vitest", "run", "--config", "a b.ts", "x"]);
  });

  it("follows package-manager scripts to the runner and keeps config flags", () => {
    const dir = tmp({
      "package.json": JSON.stringify({ scripts: { test: "pnpm run unit", unit: "NODE_ENV=test vitest run --config vitest.unit.ts --coverage" } }),
    });
    // vitest resolves from the monorepo when linked; here it is not installed.
    const r = detectTestRunner(dir, "pnpm run test");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/uses vitest .* not installed/);
  });

  it("resolves the installed runner binary", () => {
    const r = detectTestRunner(REPO_ROOT, "vitest run --config x.ts --reporter dot");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.runner.kind).toBe("vitest");
    expect(r.runner.args).toEqual(["--config", "x.ts"]);
    expect(r.runner.bin).toMatch(/vitest\.mjs$/);
    const args = runnerArgs({ runner: r.runner, dir: REPO_ROOT, reportPath: "/tmp/r.json", files: ["test/a.test.ts"] });
    expect(args).toContain("--outputFile.json=/tmp/r.json");
    expect(args.at(-1)).toBe("test/a.test.ts");
  });

  it("reports when no supported runner is configured", () => {
    const dir = tmp({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) });
    const r = detectTestRunner(dir, null);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/could not find a supported test runner/) });
  });

  it("parses vitest/jest JSON reports, including files that failed to load", () => {
    const report = {
      testResults: [
        {
          name: "/repo/test/a.test.ts",
          status: "passed",
          assertionResults: [
            { ancestorTitles: ["a"], title: "works", status: "passed", duration: 1 },
            { ancestorTitles: ["a"], title: "breaks", status: "failed", failureMessages: ["boom"] },
            { ancestorTitles: [], title: "later", status: "pending" },
          ],
        },
        { name: "/repo/test/b.test.ts", status: "failed", message: "SyntaxError: x", assertionResults: [] },
      ],
    };
    const { files, tests } = parseJsonReport(report, "/repo");
    expect(tests.map((t) => [t.id, t.outcome])).toEqual([
      ["test/a.test.ts > a > works", "pass"],
      ["test/a.test.ts > a > breaks", "fail"],
      ["test/a.test.ts > later", "skip"],
    ]);
    expect(files).toEqual([
      { file: "test/a.test.ts", loadError: null },
      { file: "test/b.test.ts", loadError: "SyntaxError: x" },
    ]);
  });
});

describe("public API discovery", () => {
  it("reads entry points from exports conditions and types", () => {
    expect(declaredEntries({ exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./node": "./dist/node.js" } })).toEqual([
      [".", "./dist/index.d.ts"],
      ["./node", "./dist/node.js"],
    ]);
    expect(declaredEntries({ types: "./lib/index.d.ts" })).toEqual([[".", "./lib/index.d.ts"]]);
    expect(declaredEntries({ exports: "./src/index.ts" })).toEqual([[".", "./src/index.ts"]]);
  });

  it("maps built declarations back to their sources", () => {
    const files = new Set(["src/index.ts", "pkg/src/node.ts", "types/manual.d.ts"]);
    const exists = (p: string) => files.has(p);
    expect(mapToSource("./dist/index.d.ts", "", exists, { outDir: "dist", rootDir: "src" })).toBe("src/index.ts");
    expect(mapToSource("./dist/index.js", "", exists, {})).toBe("src/index.ts");
    expect(mapToSource("./build/node.js", "pkg", exists, {})).toBe("pkg/src/node.ts");
    expect(mapToSource("./types/manual.d.ts", "", exists, {})).toBe("types/manual.d.ts");
    expect(mapToSource("./dist/missing.d.ts", "", exists, {})).toBeNull();
  });

  it("reports entries it cannot map instead of dropping them", () => {
    const tree: Record<string, string> = { "package.json": JSON.stringify({ name: "x", exports: { ".": "./dist/index.js", "./*": "./dist/*.js" } }) };
    const d = discoverEntries(["package.json"], { exists: (p) => p in tree, read: (p) => tree[p] ?? null });
    expect(d.entries).toEqual([]);
    expect(d.problems).toEqual(["x: cannot map export . (./dist/index.js) to a TypeScript source", "x: wildcard export ./* is not analysed"]);
  });

  it("extracts a normalized surface through re-exports", () => {
    const dir = tmp({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", rootDir: "src", outDir: "dist", types: [] }, include: ["src"] }),
      "src/index.ts": `export { area, type Shape } from "./shapes.js";\nexport * from "./more.js";\nexport default class Box { constructor(public size: number) {} private secret = 1; grow(by = 1): Box { return new Box(this.size + by); } }\n`,
      "src/shapes.ts": `export interface Shape { kind: "circle" | "square"; size: number; label?: string }\nexport function area(s: Shape): number { return s.size * s.size; }\nexport function area2(): void {}\n`,
      "src/more.ts": `export const VERSION = "1";\nexport enum Color { Red = 1, Blue = 2 }\nexport type Pair<T> = [T, T];\n`,
    });
    const r = extractPackageSurfaces(dir, [{ name: "x", dir: "", entry: ".", source: "src/index.ts" }]).get(".");
    expect(r?.error).toBeUndefined();
    expect(r?.surface).toEqual({
      area: "function (s: Shape): number",
      Shape: 'interface {\n  kind: "circle" | "square"\n  label?: string | undefined\n  size: number\n}',
      VERSION: 'const: "1"',
      Color: "enum { Red = 1, Blue = 2 }",
      Pair: "type<T> = [T, T]",
      default: "class {\n  new (size: number): Box\n  grow: (by?: number | undefined) => Box\n  size: number\n}",
    });
  });
});

describe("preview detection", () => {
  const base = { ip: "0.0.0.0", port: 8787, persistTo: "/tmp/state" };

  it("serves a dry-run build output without re-bundling", () => {
    const dir = tmp({ "wrangler.jsonc": "{}", "dist/index.js": "export default {}", "dist/index.js.map": "{}", "dist/README.md": "This folder contains the built output assets for the worker" });
    const r = detectPreview({ dir, ...base });
    expect(r.ok && r.plan.mode).toBe("built-output");
    expect(r.ok && r.plan.args.slice(0, 3)).toEqual(["dev", join(dir, "dist", "index.js"), "--no-bundle"]);
    expect(r.ok && r.plan.args).toEqual(expect.arrayContaining(["--ip", "0.0.0.0", "--port", "8787", "--local"]));
  });

  it("lets wrangler bundle from source when there is no build output", () => {
    const dir = tmp({ "wrangler.toml": 'name = "x"' });
    const r = detectPreview({ dir, ...base });
    expect(r.ok && r.plan).toMatchObject({ kind: "worker", mode: "source" });
  });

  it("prefers a redirected config written by a build tool", () => {
    const dir = tmp({ "wrangler.jsonc": "{}", ".wrangler/deploy/config.json": JSON.stringify({ configPath: "../../dist/server/wrangler.json" }), "dist/server/wrangler.json": "{}" });
    const r = detectPreview({ dir, ...base });
    expect(r.ok && r.plan.mode).toBe("redirected-config");
    expect(r.ok && r.plan.args.slice(0, 3)).toEqual(["dev", "-c", join(dir, "dist", "server", "wrangler.json")]);
  });

  it("serves a static site's assets", () => {
    const dir = tmp({ "build/index.html": "<h1>x</h1>", "package.json": "{}" });
    const r = detectPreview({ dir, ...base });
    expect(r.ok && r.plan).toMatchObject({ kind: "static", mode: "assets" });
    expect(r.ok && r.plan.args.slice(0, 3)).toEqual(["dev", "--assets", join(dir, "build")]);
  });

  it("fails clearly when there is nothing to serve", () => {
    const r = detectPreview({ dir: tmp({ "package.json": "{}" }), ...base });
    expect(r.ok).toBe(false);
  });
});
