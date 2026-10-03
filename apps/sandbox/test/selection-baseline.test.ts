/**
 * Evidence on the tests that reach the Change (test selection), failures compared with the base
 * commit (pre-existing ones don't count), and mutation testing of code no test covers. Real
 * vitest and Stryker (the monorepo's), through the built bundle.
 */
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { CoverageDelta, MutationScore, newFailureCount, stripAnsi, TestRun } from "@app/evidence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noTestsFound } from "../src/commands/mutation.js";
import { failureSignature } from "../src/lib/baseline.js";
import {
  cli,
  document,
  ensureBundle,
  type Files,
  REPO_ROOT,
  type TempRepo,
  tempRepo,
} from "./helpers.js";

const repos: TempRepo[] = [];
beforeAll(() => ensureBundle(), 120_000);
afterAll(() => {
  for (const r of repos) r.cleanup();
});

const PKG = JSON.stringify({
  name: "sel-demo",
  private: true,
  type: "module",
  scripts: { test: "vitest run" },
  devDependencies: { vitest: "4.1.11" },
});

function repo(base: Files, head: Files): TempRepo {
  const r = tempRepo({ "package.json": PKG, ".gitignore": "node_modules\n", ...base }, head);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(r.dir, "node_modules"), "dir");
  repos.push(r);
  return r;
}

async function evidence(kind: string, r: TempRepo, env: NodeJS.ProcessEnv = {}): Promise<unknown> {
  const res = await cli(
    ["evidence", kind, "--base", r.base, "--head", r.head, "--cwd", r.dir],
    r.dir,
    env,
  );
  return document(res);
}

const HALF = (body: string) => `export function half(n: number): number {\n  ${body}\n}\n`;
const HALF_TEST = `import { expect, it } from "vitest";
import { half } from "../src/math.js";

it("rounds odd numbers down", () => {
  expect(half(5)).toBe(2);
});
`;
const ROUNDED = "test/math.test.ts > rounds odd numbers down";
const UNTESTED =
  "export function label(n: number): string {\n  return n > 0 ? '+' + n : String(n);\n}\n";

describe("failure signatures", () => {
  it("ignore colours, checkout roots and stack frames, and keep the assertion", () => {
    const base =
      "\u001b[31mAssertionError: expected 2.5 to be 2\u001b[39m\n    at /tmp/x/base/test/a.test.ts:4:3";
    const head = "AssertionError: expected 2.5 to be 2\n    at /workspace/test/a.test.ts:9:3";
    expect(failureSignature(base, ["/tmp/x/base"])).toBe(failureSignature(head, ["/workspace"]));
    expect(failureSignature("Error: Cannot find /tmp/x/base/src/a.ts", ["/tmp/x/base"])).toBe(
      "Error: Cannot find <root>/src/a.ts",
    );
    expect(failureSignature("AssertionError: expected 3 to be 2", [])).not.toBe(
      failureSignature(head, []),
    );
  });

  it("read Stryker's no-tests exit as a mutant count", () => {
    const out =
      "\u001b[32m09:08:11 (812) INFO\u001b[39m Instrumented 1 source file(s) with 7 mutant(s)\nINFO No tests were found";
    expect(noTestsFound(0, stripAnsi(out))).toBe(7);
    expect(noTestsFound(1, "No tests were found")).toBeNull();
    expect(noTestsFound(0, "No tests were found")).toBeNull();
  });
});

describe("test selection and baselines", { timeout: 240_000 }, () => {
  it("test-run runs only the tests that reach the change (none: nothing runs)", async () => {
    const r = repo(
      {
        "src/math.ts": HALF("return Math.floor(n / 2);"),
        "test/math.test.ts": HALF_TEST,
        "src/label.ts": UNTESTED,
      },
      { "src/label.ts": UNTESTED.replace("String(n)", "'' + n") },
    );
    const item = TestRun.parse(await evidence("test-run", r));
    expect(item).toMatchObject({ status: "ok", passed: 0, failed: 0 });
    expect(item.selection).toMatchObject({ mode: "affected", files: 0 });
    expect(item.note).toMatch(/no test ran: no test file reaches the changed files/);
    const cov = CoverageDelta.parse(await evidence("coverage", r));
    expect(cov).toMatchObject({ status: "ok", ratio: 0, coveredChangedLines: 0 });
    expect(cov.selection).toMatchObject({ mode: "affected", files: 0 });
  });

  it("a config change runs the whole suite (unknown impact escalates)", async () => {
    const r = repo(
      { "src/math.ts": HALF("return Math.floor(n / 2);"), "test/math.test.ts": HALF_TEST },
      { "vitest.config.ts": "export default {};\n" },
    );
    const item = TestRun.parse(await evidence("test-run", r));
    expect(item).toMatchObject({ status: "ok", passed: 1, failed: 0, selection: { mode: "all" } });
  });

  it("failures identical on base are pre-existing; new ones count; base results are cached", async () => {
    const triple = `import { expect, it } from "vitest";
import { triple } from "../src/math.js";

it("triples", () => {
  expect(triple(2)).toBe(7);
});
`;
    const r = repo(
      { "src/math.ts": HALF("return n / 2;"), "test/math.test.ts": HALF_TEST },
      {
        "src/math.ts": `${HALF("return n / 2;")}export const triple = (n: number) => n * 3;\n`,
        "test/triple.test.ts": triple,
      },
    );
    const dir = join(r.dir, "..", "baselines");
    mkdirSync(dir, { recursive: true });
    const env = {
      GITTIFACTS_BASELINE_IN: dir,
      GITTIFACTS_BASELINE_OUT: join(dir, "test-run.json"),
    };
    const item = TestRun.parse(await evidence("test-run", r, env));
    expect(item).toMatchObject({ status: "ok", failed: 2, preExisting: [ROUNDED] });
    expect(item.baseline).toEqual({ sha: r.base, status: "ok", source: "run" });
    expect(newFailureCount(item, r.base)).toBe(1);
    expect(item.note).toMatch(/1 fail identically on base .* \(pre-existing, not counted\), 1 new/);
    const again = TestRun.parse(await evidence("test-run", r, env));
    expect(again.baseline).toMatchObject({ status: "ok", source: "cache" });
    expect(again.preExisting).toEqual([ROUNDED]);
  });

  it("without a baseline (base installs other dependencies) every failure counts", async () => {
    const pkg = JSON.parse(PKG) as Record<string, unknown>;
    const r = repo(
      { "src/math.ts": HALF("return n / 2;"), "test/math.test.ts": HALF_TEST },
      {
        "package.json": JSON.stringify({ ...pkg, dependencies: { "left-pad": "1.3.0" } }),
        "src/math.ts": HALF("return n / 2; // still wrong"),
      },
    );
    const item = TestRun.parse(await evidence("test-run", r));
    expect(item).toMatchObject({ failed: 1, baseline: { sha: r.base, status: "unavailable" } });
    expect(item.preExisting).toBeUndefined();
    expect(newFailureCount(item, r.base)).toBe(1);
  });

  it("mutation of code no test reaches is a measured no-coverage result, not an error", async () => {
    const r = repo(
      {
        "src/math.ts": HALF("return Math.floor(n / 2);"),
        "test/math.test.ts": HALF_TEST,
        "src/label.ts": UNTESTED,
      },
      { "src/label.ts": UNTESTED.replace("n > 0", "n >= 0") },
    );
    const item = MutationScore.parse(await evidence("mutation", r));
    expect(item.status).toBe("ok");
    expect(item).toMatchObject({
      killed: 0,
      survived: 0,
      timedOut: 0,
      score: 0,
      files: ["src/label.ts"],
    });
    expect(item.noCoverage).toBeGreaterThan(0);
    expect(item.note).toMatch(/no test covers the changed files/);
    expect(item.note ?? "").not.toContain("\u001b[");
  });
});
