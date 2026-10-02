/**
 * O6 eval task 2 ("Import <repo> and fix the failing test"), runner side: the import fixture
 * fixtures/imports/clock-api (published as github.com/JoviDeCroock/gittifacts-fixture-clock-api)
 * already has a failing test. The fix an agent should make is source-only (one line in
 * src/clock.ts) and must still end with red/green proof: the pre-existing test fails on base and
 * passes on head. Built bundle, real vitest (the monorepo's 4.1.11, the fixture's own version).
 *
 * Skip with SKIP_E2E=1.
 */
import { readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { RedGreenProof, TestRun } from "@app/evidence";
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

const SKIP = process.env.SKIP_E2E === "1";
const FIXTURE = join(REPO_ROOT, "fixtures", "imports", "clock-api");
const FAILING = "test/clock.test.ts > formatOffset > formats offsets west of UTC";

/** The fixture's files as one repository (what `create_project({ from })` imports). */
function fixtureFiles(dir = FIXTURE, out: Files = {}): Files {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".wrangler"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) fixtureFiles(path, out);
    else out[relative(FIXTURE, path)] = readFileSync(path, "utf8");
  }
  return out;
}

let r: TempRepo | undefined;

describe.skipIf(SKIP)("import fixture clock-api: a source-only fix of its failing test", () => {
  beforeAll(() => {
    ensureBundle();
    const base = fixtureFiles();
    const clock = base["src/clock.ts"] ?? "";
    expect(clock).toContain("Math.floor(minutes / 60)");
    // The one-line fix: truncate toward zero, so -210 min is -03:30, not -04:30.
    const fixed = clock.replace("Math.floor(minutes / 60)", "Math.trunc(minutes / 60)");
    r = tempRepo(base, { "src/clock.ts": fixed });
    symlinkSync(join(REPO_ROOT, "node_modules"), join(r.dir, "node_modules"), "dir");
  }, 180_000);
  afterAll(() => r?.cleanup());

  const evidence = async (kind: string): Promise<unknown> => {
    if (r === undefined) throw new Error("fixture repository not prepared");
    const res = await cli(
      ["evidence", kind, "--base", r.base, "--head", r.head, "--cwd", r.dir],
      r.dir,
    );
    return document(res);
  };

  it("red-green: the pre-existing failing test proves the fix", { timeout: 300_000 }, async () => {
    const item = RedGreenProof.parse(await evidence("red-green"));
    expect(item, item.note).toMatchObject({
      status: "ok",
      verdict: "proven",
      tests: [{ id: FAILING, file: "test/clock.test.ts" }],
      base: { results: [{ id: FAILING, outcome: "fail" }] },
      head: { results: [{ id: FAILING, outcome: "pass" }] },
    });
    expect(item.note).toMatch(/pre-existing, fail on base and pass on head/);
  });

  it("test-run: the whole suite is green at head", { timeout: 300_000 }, async () => {
    const run = TestRun.parse(await evidence("test-run"));
    expect(run).toMatchObject({ status: "ok", failed: 0 });
    expect(run.passed).toBeGreaterThanOrEqual(7);
  });
});
