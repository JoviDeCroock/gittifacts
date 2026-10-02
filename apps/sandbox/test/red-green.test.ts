/**
 * `evidence red-green` with pre-existing tests: a test that fails on base and passes on head
 * proves the change even when the change doesn't touch it (an imported repo's failing test, fixed
 * by a source-only change). Real vitest (the monorepo's), through the built bundle.
 */
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { RedGreenProof } from "@app/evidence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  name: "rg-demo",
  private: true,
  type: "module",
  scripts: { test: "vitest run" },
  devDependencies: { vitest: "4.1.11" },
});

/** A vitest repo (node_modules linked from the monorepo, untracked) with a base and a head. */
function repo(base: Files, head: Files): TempRepo {
  const r = tempRepo({ "package.json": PKG, ".gitignore": "node_modules\n", ...base }, head);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(r.dir, "node_modules"), "dir");
  repos.push(r);
  return r;
}

async function redGreen(r: TempRepo, env: NodeJS.ProcessEnv = {}): Promise<RedGreenProof> {
  const res = await cli(
    ["evidence", "red-green", "--base", r.base, "--head", r.head, "--cwd", r.dir],
    r.dir,
    env,
  );
  return RedGreenProof.parse(document(res));
}

const MATH = (body: string) => `export function half(n: number): number {\n  ${body}\n}\n`;
const MATH_TEST = `import { expect, it } from "vitest";
import { half } from "../src/math.js";

it("halves even numbers", () => {
  expect(half(4)).toBe(2);
});

it("rounds odd numbers down", () => {
  expect(half(5)).toBe(2);
});
`;
const BROKEN = { "src/math.ts": MATH("return n / 2;"), "test/math.test.ts": MATH_TEST };
const ROUNDED = "test/math.test.ts > rounds odd numbers down";

describe("red-green: pre-existing tests", { timeout: 240_000 }, () => {
  it("a source-only fix of an already failing test is proven", async () => {
    const r = repo(BROKEN, { "src/math.ts": MATH("return Math.floor(n / 2);") });
    const item = await redGreen(r);
    expect(item).toMatchObject({
      status: "ok",
      verdict: "proven",
      tests: [{ id: ROUNDED, file: "test/math.test.ts", name: "rounds odd numbers down" }],
      base: { sha: r.base, results: [{ id: ROUNDED, outcome: "fail" }] },
      head: { sha: r.head, results: [{ id: ROUNDED, outcome: "pass" }] },
    });
    expect(item.note).toMatch(/pre-existing, fail on base and pass on head/);
  });

  it("a pre-existing failure the change does not fix is listed: not-proven", async () => {
    const r = repo(BROKEN, { "src/math.ts": MATH("return Math.round(n / 2);") });
    const item = await redGreen(r);
    expect(item).toMatchObject({
      status: "ok",
      verdict: "not-proven",
      tests: [{ id: ROUNDED }],
      base: { results: [{ id: ROUNDED, outcome: "fail" }] },
      head: { results: [{ id: ROUNDED, outcome: "fail" }] },
    });
    expect(item.note).toMatch(/still fail on head/);
  });

  it("still blocks the proof of a new test that is red on base and green on head", async () => {
    const double = `import { expect, it } from "vitest";
import { double } from "../src/math.js";

it("doubles", () => {
  expect(double(3)).toBe(6);
});
`;
    const r = repo(BROKEN, {
      "src/math.ts": `${MATH("return n / 2;")}export const double = (n: number) => n * 2;\n`,
      "test/double.test.ts": double,
    });
    const item = await redGreen(r);
    expect(item.verdict).toBe("not-proven");
    const outcomes = (side: "base" | "head") =>
      Object.fromEntries(item[side].results.map((x) => [x.id, x.outcome]));
    expect(outcomes("base")).toEqual({
      "test/double.test.ts > doubles": expect.stringMatching(/^(fail|missing)$/),
      [ROUNDED]: "fail",
    });
    expect(outcomes("head")).toEqual({
      "test/double.test.ts > doubles": "pass",
      [ROUNDED]: "fail",
    });
  });

  it("a healthy base and a source-only change: no-tests (nothing was red)", async () => {
    const fixed = { ...BROKEN, "src/math.ts": MATH("return Math.floor(n / 2);") };
    const r = repo(fixed, { "src/math.ts": MATH("return Math.trunc(n / 2);") });
    const item = await redGreen(r);
    expect(item).toMatchObject({ status: "ok", verdict: "no-tests", tests: [] });
    expect(item.note).toMatch(/no test fails on base as committed/);
  });

  it("a flaky base failure (fails once, passes on the confirming run) is not red", async () => {
    const flaky = `import { existsSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";

it("flaky", () => {
  const marker = process.env.RG_FLAKY_MARKER ?? "";
  const first = !existsSync(marker);
  if (first) writeFileSync(marker, "seen");
  expect(first).toBe(false);
});
`;
    const r = repo({ "test/flaky.test.ts": flaky }, { "README.md": "docs\n" });
    const item = await redGreen(r, { RG_FLAKY_MARKER: join(r.dir, "..", "flaky-marker") });
    expect(item).toMatchObject({ status: "ok", verdict: "no-tests", tests: [] });
    expect(item.note).toMatch(/failed once on base, then passed \(flaky: not red\)/);
  });

  it("a test file that fails to load on base and passes on head is proven (base: error)", async () => {
    const r = repo(
      {
        // A syntax error on base: every test file importing it fails to load.
        "src/math.ts": "export function half(n: number): number {\n  return n / 2;\n",
        "test/math.test.ts": MATH_TEST,
      },
      { "src/math.ts": MATH("return Math.floor(n / 2);") },
    );
    const item = await redGreen(r);
    expect(item.verdict).toBe("proven");
    expect(item.base.results.map((x) => x.outcome)).toEqual(["error", "error"]);
    expect(item.head.results.map((x) => x.outcome)).toEqual(["pass", "pass"]);
  });

  it("never installs base dependencies just to look for fixed tests: no-tests with a note", async () => {
    const pkg = JSON.parse(PKG) as Record<string, unknown>;
    const r = repo(BROKEN, {
      "package.json": JSON.stringify({ ...pkg, dependencies: { "left-pad": "1.3.0" } }),
      "src/math.ts": MATH("return Math.floor(n / 2);"),
    });
    const item = await redGreen(r);
    expect(item).toMatchObject({ status: "ok", verdict: "no-tests", tests: [] });
    expect(item.note).toMatch(/pre-existing tests not checked: base and head install different/);
  });
});
