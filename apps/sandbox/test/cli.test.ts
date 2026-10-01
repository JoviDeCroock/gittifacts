/** The CLI contract, through the built bundle, on small throwaway repositories. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli, document, ensureBundle, type TempRepo, tempRepo } from "./helpers.js";

const repos: TempRepo[] = [];
function repo(base: Parameters<typeof tempRepo>[0], head: Parameters<typeof tempRepo>[1]): TempRepo {
  const r = tempRepo(base, head);
  repos.push(r);
  return r;
}

beforeAll(() => ensureBundle(), 120_000);
afterAll(() => {
  for (const r of repos) r.cleanup();
});

const PKG = JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { a: "^1.0.0" } }, null, 2);

describe("output contract", () => {
  it("prints usage and exits 0 for --help, 2 for usage errors", async () => {
    const help = await cli(["--help"], process.cwd());
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/gittifacts-runner evidence <kind>/);
    expect((await cli(["evidence", "nope"], process.cwd())).code).toBe(2);
    expect((await cli(["frobnicate"], process.cwd())).code).toBe(2);
  });

  it("prints exactly one ::evidence:: line and logs to stderr", async () => {
    const r = repo({ "package.json": PKG }, { "package.json": PKG.replace('"a": "^1.0.0"', '"a": "^1.0.0",\n    "b": "2.0.0"') });
    const out = await cli(["evidence", "dependencies", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir);
    expect(out.code).toBe(0);
    expect(document(out)).toMatchObject({ kind: "dependencies", status: "ok", added: [{ name: "b", version: "2.0.0", dev: false }], lockfileChanged: false });
  });

  it("also writes the document to $GITTIFACTS_EVIDENCE_OUT", async () => {
    const r = repo({ "package.json": PKG }, { "README.md": "hi" });
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const out = join(mkdtempSync(join(tmpdir(), "gtf-out-")), "evidence.json");
    const res = await cli(["evidence", "dependencies", "--cwd", r.dir], r.dir, { GITTIFACTS_BASE_SHA: r.base, GITTIFACTS_HEAD_SHA: r.head, GITTIFACTS_EVIDENCE_OUT: out });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(document(res));
  });

  it("reports a measurement it cannot make as an error item (exit 0) without leaking the token", async () => {
    const r = repo({ "a.txt": "a" }, { "a.txt": "b" });
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const res = await cli(["evidence", "red-green", "--base", missing, "--head", r.head, "--cwd", r.dir], r.dir, {
      GITTIFACTS_REMOTE: "http://127.0.0.1:9/repo.git",
      GITTIFACTS_TOKEN: "art_v2_supersecret_token_value",
    });
    expect(res.code).toBe(0);
    expect(document(res)).toMatchObject({ kind: "red-green", status: "error", verdict: "not-proven" });
    expect(res.stdout + res.stderr).not.toContain("supersecret");
  });

  it("says no-tests when the change touches no test", async () => {
    const r = repo({ "src/a.ts": "export const a = 1;\n" }, { "src/a.ts": "export const a = 2;\n" });
    const res = await cli(["evidence", "red-green", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir);
    expect(document(res)).toMatchObject({ status: "ok", verdict: "no-tests", tests: [] });
  });

  it("emits a ChangeDiff for `diff`", async () => {
    const r = repo({ "a.txt": "one\ntwo\n" }, { "a.txt": "one\n2\n", "b.txt": "new\n" });
    const doc = document(await cli(["diff", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir));
    expect(doc).toMatchObject({
      additions: 2,
      deletions: 1,
      files: [
        { path: "a.txt", status: "modified", additions: 1, deletions: 1, hunks: [{ oldStart: 1, newStart: 1 }] },
        { path: "b.txt", status: "added", additions: 1, deletions: 0 },
      ],
    });
  });
});

describe("policy", () => {
  const VALID = 'export default { version: 1, lane0Enabled: false, sensitivePaths: ["secret/**"] };\n';

  it("reads the policy from BASE and flags .platform changes at head", async () => {
    const r = repo({ ".platform/policy.ts": VALID, "secret/x.txt": "a" }, { ".platform/policy.ts": VALID.replace("secret/**", "nothing/**"), "secret/x.txt": "b" });
    const doc = document(await cli(["policy", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir));
    expect(doc).toMatchObject({
      kind: "policy",
      status: "ok",
      source: "file",
      sha: r.base,
      policy: { sensitivePaths: ["secret/**"] },
      platformChanged: true,
      policyChanged: true,
      platformPaths: [".platform/policy.ts"],
    });
    // The CI evidence step gets an EvidenceItem governed by the base policy.
    const ev = document(await cli(["evidence", "policy", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir));
    expect(ev).toEqual([
      expect.objectContaining({ id: "policy:sensitive-paths", kind: "sensitive-paths", status: "ok", hits: expect.arrayContaining([{ path: "secret/x.txt", pattern: "secret/**" }]) }),
    ]);
  });

  it("is an error, not defaults, when the base policy is invalid", async () => {
    const r = repo({ ".platform/policy.ts": 'export default { lane0Enabled: "yes" };\n' }, { "a.txt": "x" });
    const doc = document(await cli(["policy", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir));
    expect(doc).toMatchObject({ status: "error", resolved: null, issues: [expect.stringMatching(/^lane0Enabled/)] });
    const sp = document(await cli(["evidence", "sensitive-paths", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir));
    expect(sp).toMatchObject({ status: "error" });
  });

  it("uses the platform defaults when there is no policy file", async () => {
    const r = repo({ "a.txt": "a" }, { "a.txt": "b" });
    expect(document(await cli(["policy", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir))).toMatchObject({ status: "ok", source: "default", policy: null });
  });

  it("follows relative imports in the base tree and shims definePolicy", async () => {
    const r = repo(
      {
        ".platform/policy.ts": 'import { definePolicy } from "@gittifacts/policy";\nimport { PATHS } from "./paths";\nexport default definePolicy({ sensitivePaths: PATHS });\n',
        ".platform/paths.ts": 'export const PATHS: string[] = ["infra/**"];\n',
      },
      { "a.txt": "x" },
    );
    expect(document(await cli(["policy", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir))).toMatchObject({ status: "ok", policy: { sensitivePaths: ["infra/**"] } });
  });
});

describe("plan", () => {
  it("records a pipeline file into a PipelineSpec", async () => {
    const ci = `import { definePipeline } from "@gittifacts/ci";
export default definePipeline(async (ci) => {
  const install = await ci.runner({ name: "install", command: "pnpm install --frozen-lockfile", cache: { inputs: ["pnpm-lock.yaml"] } });
  await Promise.all([install.runner({ name: "test", command: "pnpm test" }), install.runner({ name: "lint", command: "pnpm lint" })]);
});
`;
    const r = repo({ ".platform/ci.ts": ci }, {});
    const doc = document(await cli(["plan", ".platform/ci.ts", "--sha", r.head, "--cwd", r.dir], r.dir), "::plan::");
    expect(doc).toMatchObject({
      version: 1,
      source: "file",
      steps: [
        { name: "install", parent: null },
        { name: "test", parent: "install" },
        { name: "lint", parent: "install" },
      ],
    });
  });

  it("reports an author error as an error document", async () => {
    const r = repo({ ".platform/ci.ts": 'export default async () => { throw new Error("nope"); };\n' }, {});
    const res = await cli(["plan", "--cwd", r.dir], r.dir);
    expect(res.code).toBe(0);
    expect(document(res, "::plan::")).toEqual({ error: "the pipeline function threw: nope", file: ".platform/ci.ts" });
  });

  it("falls back to the default pipeline without a file", async () => {
    const r = repo({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) }, {});
    expect(document(await cli(["plan", "--cwd", r.dir], r.dir), "::plan::")).toMatchObject({ source: "default", steps: [{ name: "install" }, { name: "test" }] });
  });
});

describe("transforms", () => {
  const SCRIPT = `import { readFileSync, writeFileSync } from "node:fs";
for (const f of ["src/a.ts", "src/b.ts"]) writeFileSync(f, readFileSync(f, "utf8").replaceAll("oldName", "newName"));
`;
  const base = { ".platform/transforms/rename.mjs": SCRIPT, "src/a.ts": "export const oldName = 1;\n", "src/b.ts": "import { oldName } from './a';\n" };

  it("verifies a head that is exactly the base script's output", async () => {
    const r = repo(base, { "src/a.ts": "export const newName = 1;\n", "src/b.ts": "import { newName } from './a';\n" });
    const doc = document(await cli(["evidence", "transforms", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir));
    expect(doc).toEqual([
      expect.objectContaining({ id: "transform:rename", status: "ok", verified: true, files: ["src/a.ts", "src/b.ts"], mismatchedFiles: [], command: "node .platform/transforms/rename.mjs" }),
    ]);
  });

  it("lists hand edits on top of the transform as mismatches", async () => {
    const r = repo(base, { "src/a.ts": "export const newName = 2;\n", "src/b.ts": "import { newName } from './a';\n" });
    expect(document(await cli(["evidence", "transforms", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir))).toEqual([
      expect.objectContaining({ status: "ok", verified: false, files: ["src/b.ts"], mismatchedFiles: ["src/a.ts"] }),
    ]);
  });

  it("skips a transform the change did not apply", async () => {
    const r = repo(base, { "README.md": "docs\n" });
    expect(document(await cli(["evidence", "transforms", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir))).toEqual([
      expect.objectContaining({ status: "skipped", verified: false, files: [], mismatchedFiles: [] }),
    ]);
  });

  it("never runs a transform script that only exists at head", async () => {
    const r = repo({ "src/a.ts": "export const oldName = 1;\n" }, { ".platform/transforms/evil.mjs": 'import { writeFileSync } from "node:fs"; writeFileSync("src/a.ts", "pwned");\n', "src/a.ts": "pwned" });
    expect(document(await cli(["evidence", "transforms", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir))).toEqual([]);
  });

  it("is an error when the base script fails", async () => {
    const r = repo({ ".platform/transforms/broken.mjs": "process.exit(3);\n", "a.txt": "a" }, { "a.txt": "b" });
    expect(document(await cli(["evidence", "transforms", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir))).toEqual([
      expect.objectContaining({ id: "transform:broken", status: "error", verified: false, note: expect.stringMatching(/exited 3/) }),
    ]);
  });
});

describe("unmeasurable signals", () => {
  it("coverage and mutation of a change without source lines are not measured, never faked", async () => {
    const r = repo({ "package.json": PKG }, { "README.md": "docs\n" });
    const cov = document(await cli(["evidence", "coverage", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir));
    expect(cov).toMatchObject({ status: "ok", changedLines: 0, ratio: 1 });
    const mut = document(await cli(["evidence", "mutation", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir));
    expect(mut).toMatchObject({ status: "skipped", score: 0, killed: 0 });
  });

  it("coverage without a usable test runner is an error item", async () => {
    const r = repo({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }), "src/a.ts": "export const a = 1;\n" }, { "src/a.ts": "export const a = 2;\n" });
    const cov = document(await cli(["evidence", "coverage", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir));
    expect(cov).toMatchObject({ status: "error", note: expect.stringMatching(/supported test runner/) });
  });

  it("refuses to measure a working tree that is not at head", async () => {
    const r = repo({ "src/a.ts": "export const a = 1;\n", "test/a.test.ts": 'it("x", () => {});\n' }, { "src/a.ts": "export const a = 2;\n", "test/a.test.ts": 'it("y", () => {});\n' });
    const { gitSync } = await import("./helpers.js");
    gitSync(r.dir, ["checkout", "-q", "main"]);
    const doc = document(await cli(["evidence", "red-green", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir));
    expect(doc).toMatchObject({ status: "error", note: expect.stringMatching(/not checked out at head/) });
  });
});
