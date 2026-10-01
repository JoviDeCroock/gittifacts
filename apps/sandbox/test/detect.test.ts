/** `gittifacts-runner detect`: the ::detect:: contract, through the built bundle. */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DetectReport } from "@app/conventions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli, document, ensureBundle, REPO_ROOT, type TempRepo, tempRepo } from "./helpers.js";

const PREFIX = "::detect::";
const cleanups: Array<() => void> = [];

beforeAll(() => ensureBundle(), 120_000);
afterAll(() => {
  for (const c of cleanups) c();
});

function repo(files: Record<string, string>): TempRepo {
  const r = tempRepo(files, {});
  cleanups.push(r.cleanup);
  return r;
}

describe("gittifacts-runner detect", () => {
  it("prints one validated ::detect:: document for a git checkout (tracked files only)", async () => {
    const r = repo({
      "package.json": JSON.stringify({
        name: "demo",
        scripts: { test: "vitest run", build: "tsc -p ." },
        devDependencies: { vitest: "4.1.11", typescript: "6.0.3", esbuild: "0.25.0" },
      }),
      "pnpm-lock.yaml":
        "lockfileVersion: '9.0'\n\npackages:\n  esbuild@0.25.0:\n    resolution: {integrity: x}\n",
      "tsconfig.json": '{ "compilerOptions": { "strict": true } }',
      "wrangler.toml": 'name = "demo-worker"\nmain = "src/index.ts"\n',
    });
    // Untracked files (and node_modules) are not the repository.
    writeFileSync(join(r.dir, "jest.config.js"), "module.exports = {}");
    const res = await cli(["detect"], r.dir);
    expect(res.code).toBe(0);
    const doc = DetectReport.parse(document(res, PREFIX));
    expect(doc).toMatchObject({
      sha: r.head,
      packageManager: "pnpm",
      testRunner: "vitest",
      testConfigs: [],
      workers: ["demo-worker"],
      tsconfig: { strict: true },
      buildScriptsNeedingApproval: [{ name: "esbuild", versions: ["0.25.0"], source: "known" }],
    });
    expect(doc.uncertain.join("\n")).toMatch(/ERR_PNPM_IGNORED_BUILDS/);
    expect(res.stderr).toMatch(/detect: \d+ file\(s\)/);
  });

  it("walks a plain directory and honours --sha", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gittifacts-detect-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ packages: {} }));
    const sha = "c".repeat(40);
    const doc = DetectReport.parse(document(await cli(["detect", "--sha", sha], dir), PREFIX));
    expect(doc).toMatchObject({ sha, packageManager: "npm", testRunner: "jest" });
  });

  it("detects the import fixture (fixtures/imports/clock-api) with its failing test", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gittifacts-detect-fixture-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    cpSync(join(REPO_ROOT, "fixtures", "imports", "clock-api"), dir, { recursive: true });
    const doc = DetectReport.parse(document(await cli(["detect"], dir), PREFIX));
    expect(doc).toMatchObject({
      packageManager: "pnpm",
      testRunner: "vitest",
      testCommand: "pnpm run test",
      workers: ["clock-api"],
      tsconfig: { path: "tsconfig.json" },
    });
    expect(doc.confidence).not.toBe("low");
  });
});
