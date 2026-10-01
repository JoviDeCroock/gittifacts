/** `gittifacts-runner affected`: the ::affected:: contract, through the built bundle. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AffectedSet } from "@app/affected";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli, document, ensureBundle, type TempRepo, tempRepo } from "./helpers.js";

const PREFIX = "::affected::";
const repos: TempRepo[] = [];
function repo(
  base: Parameters<typeof tempRepo>[0],
  head: Parameters<typeof tempRepo>[1],
): TempRepo {
  const r = tempRepo(base, head);
  repos.push(r);
  return r;
}

beforeAll(() => ensureBundle(), 120_000);
afterAll(() => {
  for (const r of repos) r.cleanup();
});

const BASE = {
  "package.json": JSON.stringify({ name: "demo", private: true, type: "module" }),
  "packages/lib/package.json": JSON.stringify({
    name: "@d/lib",
    exports: { ".": "./src/index.ts" },
  }),
  "packages/lib/src/index.ts": 'export * from "./sum.js";\n',
  "packages/lib/src/sum.ts":
    "export function sum(a: number, b: number): number {\n  return a + b;\n}\n",
  "packages/lib/test/sum.test.ts": 'import { sum } from "../src/sum.js";\nsum(1, 2);\n',
  "packages/app/wrangler.toml": 'name = "demo-app"\nmain = "src/main.ts"\n',
  "packages/app/package.json": JSON.stringify({ name: "@d/app", private: true }),
  "packages/app/src/main.ts":
    'import { sum } from "@d/lib";\nexport default { fetch: () => new Response(String(sum(1, 2))) };\n',
  "packages/app/test/main.test.ts": 'import worker from "../src/main.js";\nworker.fetch();\n',
  "packages/other/src/x.ts": "export const x = 1;\n",
  "packages/other/test/x.test.ts": 'import { x } from "../src/x.js";\n',
};
const BODY_CHANGE = {
  "packages/lib/src/sum.ts":
    "export function sum(a: number, b: number): number {\n  return b + a;\n}\n",
};

function parse(out: Awaited<ReturnType<typeof cli>>): AffectedSet {
  return AffectedSet.parse(document(out, PREFIX));
}

describe("affected", () => {
  it("prints one ::affected:: line with the change's AffectedSet", async () => {
    const r = repo(BASE, BODY_CHANGE);
    const out = await cli(["affected", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir);
    expect(out.code).toBe(0);
    const set = parse(out);
    expect(set).toMatchObject({
      files: ["packages/lib/src/sum.ts"],
      modules: ["packages/app/src/main.ts", "packages/lib/src/index.ts", "packages/lib/src/sum.ts"],
      testTargets: ["packages/app/test/main.test.ts", "packages/lib/test/sum.test.ts"],
      publicApi: false,
      deploysTo: ["demo-app"],
      complete: true,
    });
    expect(set.analyzers.map((a) => a.name)).toEqual([
      "affected",
      "ts-js",
      "path-rules",
      "test-impact",
      "public-api",
      "workers",
    ]);
    expect(out.stderr).toMatch(/affected: 1 changed path/);
  });

  it("narrows test targets with a coverage map from another checkout directory", async () => {
    const r = repo(BASE, BODY_CHANGE);
    const map = join(mkdtempSync(join(tmpdir(), "gtf-cov-")), "coverage-map.json");
    writeFileSync(
      map,
      JSON.stringify({
        format: "gittifacts.coverage-map",
        version: 1,
        commit: r.base,
        tests: {
          "/ci/workspace/packages/lib/test/sum.test.ts": ["/ci/workspace/packages/lib/src/sum.ts"],
          "/ci/workspace/packages/app/test/main.test.ts": [
            "/ci/workspace/packages/app/src/main.ts",
          ],
        },
      }),
    );
    const out = await cli(
      ["affected", "--base", r.base, "--head", r.head, "--coverage-map", map, "--cwd", r.dir],
      r.dir,
    );
    const set = parse(out);
    expect(set.testTargets).toEqual(["packages/lib/test/sum.test.ts"]);
    expect(set.analyzers.find((a) => a.name === "test-impact")?.note).toMatch(/^coverage map @/);
  });

  it("falls back to static selection when the coverage map is unusable, and says so", async () => {
    const r = repo(BASE, BODY_CHANGE);
    const map = join(mkdtempSync(join(tmpdir(), "gtf-cov-")), "bad.json");
    writeFileSync(map, "{ not json");
    const set = parse(
      await cli(
        ["affected", "--base", r.base, "--head", r.head, "--coverage-map", map, "--cwd", r.dir],
        r.dir,
      ),
    );
    expect(set.complete).toBe(true);
    expect(set.testTargets).toEqual([
      "packages/app/test/main.test.ts",
      "packages/lib/test/sum.test.ts",
    ]);
    expect(set.analyzers.find((a) => a.name === "test-impact")?.note).toMatch(
      /unusable .*static test selection/,
    );
  });

  it("takes publicApi from a public-api evidence item when given one", async () => {
    const r = repo(BASE, {
      "packages/lib/src/sum.ts":
        "export function sum(a: number, b: number, c = 0): number {\n  return a + b + c;\n}\n",
    });
    expect(
      parse(await cli(["affected", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir))
        .publicApi,
    ).toBe(true);
    const evidence = join(mkdtempSync(join(tmpdir(), "gtf-api-")), "public-api.json");
    writeFileSync(
      evidence,
      JSON.stringify({
        id: "public-api",
        kind: "public-api",
        status: "ok",
        classification: "none",
        packages: [],
      }),
    );
    const set = parse(
      await cli(
        [
          "affected",
          "--base",
          r.base,
          "--head",
          r.head,
          "--public-api-evidence",
          evidence,
          "--cwd",
          r.dir,
        ],
        r.dir,
      ),
    );
    expect(set.publicApi).toBe(false);
    expect(set.analyzers.find((a) => a.name === "public-api")?.note).toBe(
      "from the public-api evidence item",
    );
  });

  it("marks config changes with *config* and all tests", async () => {
    const r = repo(BASE, {
      "package.json": JSON.stringify({
        name: "demo",
        private: true,
        type: "module",
        version: "2.0.0",
      }),
    });
    const set = parse(
      await cli(["affected", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir),
    );
    expect(set).toMatchObject({
      modules: ["*config*", "package.json"],
      testTargets: ["*"],
      complete: true,
    });
  });

  it("fails closed: a commit it cannot read still prints a document (complete: false), exit 0", async () => {
    const r = repo(BASE, BODY_CHANGE);
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const out = await cli(["affected", "--base", missing, "--head", r.head, "--cwd", r.dir], r.dir);
    expect(out.code).toBe(0);
    expect(parse(out)).toMatchObject({ complete: false, testTargets: ["*"], publicApi: true });
  });

  it("an unknown file type makes the set incomplete", async () => {
    const r = repo(
      { ...BASE, "packages/other/data.csv": "a,b\n" },
      { "packages/other/data.csv": "a,b,c\n" },
    );
    const set = parse(
      await cli(["affected", "--base", r.base, "--head", r.head, "--cwd", r.dir], r.dir),
    );
    expect(set.complete).toBe(false);
    expect(set.analyzers[0]?.note).toMatch(
      /no analyzer understands the dependents of: packages\/other\/data\.csv/,
    );
  });

  it("exits 2 without --base", async () => {
    const r = repo(BASE, BODY_CHANGE);
    const out = await cli(["affected", "--head", r.head, "--cwd", r.dir], r.dir);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
  });
});
