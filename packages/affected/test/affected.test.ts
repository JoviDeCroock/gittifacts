import { describe, expect, it } from "vitest";
import {
  AffectedSet,
  ALL_TESTS,
  type Analyzer,
  CONFIG_SENTINEL,
  computeAffectedSet,
  conflictBetween,
  conflictComponents,
  contentNeeded,
  coverageMapOf,
  parseCoverageMap,
} from "../src/index.js";
import { affected, type Files, tree } from "./helpers.js";

const json = (v: unknown) => JSON.stringify(v, null, 2);

/**
 * A small monorepo:
 *   @m/core   src/math.ts ← src/index.ts (barrel), src/internal.ts (not re-exported)
 *   @m/app    src/main.ts (Worker "app-worker") → @m/core, ./routes/a.ts, ./routes/b.ts
 *   @m/tools  standalone
 */
const REPO: Files = {
  "package.json": json({ name: "root", private: true }),
  "tsconfig.json": json({ compilerOptions: { strict: true } }),
  "README.md": "# repo\n",
  "packages/core/package.json": json({ name: "@m/core", exports: { ".": "./src/index.ts" } }),
  "packages/core/src/index.ts": 'export * from "./math.js";\n',
  "packages/core/src/math.ts":
    'import { clamp } from "./internal.js";\nexport function add(a: number, b: number): number {\n  return clamp(a + b);\n}\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n',
  "packages/core/src/internal.ts":
    "export function clamp(n: number): number {\n  return Math.min(n, 1e9);\n}\n",
  "packages/core/test/math.test.ts": 'import { add } from "../src/math.js";\nadd(1, 2);\n',
  "packages/core/test/internal.test.ts": 'import { clamp } from "../src/internal.js";\nclamp(1);\n',
  "packages/core/test/__snapshots__/math.test.ts.snap": "exports[`x`] = 1;\n",
  "packages/app/package.json": json({ name: "@m/app", private: true }),
  "packages/app/wrangler.jsonc":
    '{\n  // the Worker\n  "name": "app-worker",\n  "main": "src/main.ts",\n}\n',
  "packages/app/src/main.ts":
    'import { add } from "@m/core";\nimport { a } from "./routes/a.js";\nimport { b } from "./routes/b.js";\nexport default { fetch: () => new Response(String(add(a(), b()))) };\n',
  "packages/app/src/routes/a.ts": "export const a = () => 1;\n",
  "packages/app/src/routes/b.ts": "export const b = () => 2;\n",
  "packages/app/test/a.test.ts": 'import { a } from "../src/routes/a.js";\na();\n',
  "packages/app/test/main.test.ts": 'import worker from "../src/main.js";\nworker.fetch();\n',
  "packages/tools/package.json": json({ name: "@m/tools" }),
  "packages/tools/src/index.ts": "export const tool = 1;\n",
  "packages/tools/test/tool.test.ts": 'import { tool } from "../src/index.js";\n',
  "packages/tools/data/table.csv": "a,b\n",
};

describe("module closure", () => {
  it("walks importers transitively, across workspace packages", () => {
    const s = affected(REPO, {
      "packages/core/src/internal.ts":
        REPO["packages/core/src/internal.ts"]?.replace("1e9", "1e6") ?? "",
    });
    expect(s.complete).toBe(true);
    expect(s.files).toEqual(["packages/core/src/internal.ts"]);
    expect(s.modules).toEqual([
      "packages/app/src/main.ts",
      "packages/core/src/index.ts",
      "packages/core/src/internal.ts",
      "packages/core/src/math.ts",
    ]);
    expect(s.testTargets).toEqual([
      "packages/app/test/main.test.ts",
      "packages/core/test/internal.test.ts",
      "packages/core/test/math.test.ts",
    ]);
    expect(s.deploysTo).toEqual(["app-worker"]);
    expect(s.publicApi).toBe(false);
    expect(AffectedSet.parse(s)).toEqual(s);
  });

  it("keeps independent leaves apart", () => {
    const s = affected(REPO, { "packages/tools/src/index.ts": "export const tool = 2;\n" });
    expect(s.modules).toEqual(["packages/tools/src/index.ts"]);
    expect(s.testTargets).toEqual(["packages/tools/test/tool.test.ts"]);
    expect(s.deploysTo).toEqual([]);
  });

  it("adds the targets of new import edges (a new caller overlaps changes to its callee)", () => {
    const s = affected(REPO, {
      "packages/tools/src/index.ts":
        'import { mul } from "@m/core";\nexport const tool = mul(1, 2);\n',
    });
    expect(s.modules).toContain("packages/core/src/index.ts");
    expect(s.modules).not.toContain("packages/core/src/math.ts");
    const other = affected(REPO, {
      "packages/core/src/math.ts":
        REPO["packages/core/src/math.ts"]?.replace("a * b", "a * b + 0") ?? "",
    });
    expect(conflictBetween(s, other)?.reasons).toEqual(["modules"]);
  });

  it("finds dependents of deleted and renamed files", () => {
    const del = affected(REPO, { "packages/app/src/routes/b.ts": null });
    expect(del.files).toEqual(["packages/app/src/routes/b.ts"]);
    expect(del.modules).toContain("packages/app/src/main.ts");
    expect(del.testTargets).toEqual(["packages/app/test/main.test.ts"]);
  });

  it("routes snapshot changes to their test", () => {
    const s = affected(REPO, {
      "packages/core/test/__snapshots__/math.test.ts.snap": "exports[`x`] = 2;\n",
    });
    expect(s.complete).toBe(true);
    expect(s.testTargets).toEqual(["packages/core/test/math.test.ts"]);
    expect(s.modules).toEqual(["packages/core/test/__snapshots__/math.test.ts.snap"]);
  });

  it("a docs-only change affects nothing else", () => {
    const s = affected(REPO, { "README.md": "# repo!\n" });
    expect(s).toMatchObject({
      files: ["README.md"],
      modules: ["README.md"],
      testTargets: [],
      publicApi: false,
      deploysTo: [],
      complete: true,
    });
  });
});

describe("config files", () => {
  it("add the *config* sentinel, select all tests and stay complete", () => {
    const s = affected(REPO, { "tsconfig.json": json({ compilerOptions: { strict: false } }) });
    expect(s.complete).toBe(true);
    expect(s.modules).toEqual([CONFIG_SENTINEL, "tsconfig.json"]);
    expect(s.testTargets).toEqual([ALL_TESTS]);
    // A root build config can change every bundle.
    expect(s.deploysTo).toEqual(["app-worker"]);
  });

  it("a package manifest deploys the Workers that bundle that package", () => {
    const s = affected(REPO, {
      "packages/core/package.json": json({
        name: "@m/core",
        version: "1.0.1",
        exports: { ".": "./src/index.ts" },
      }),
    });
    expect(s.modules).toContain(CONFIG_SENTINEL);
    expect(s.deploysTo).toEqual(["app-worker"]);
    expect(s.publicApi).toBe(false);
    const tools = affected(REPO, {
      "packages/tools/package.json": json({ name: "@m/tools", version: "2.0.0" }),
    });
    expect(tools.deploysTo).toEqual([]);
  });

  it("conflict with everything", () => {
    const cfg = affected(REPO, {
      "packages/tools/package.json": json({ name: "@m/tools", version: "2.0.0" }),
    });
    const docs = affected(REPO, { "README.md": "x" });
    expect(conflictBetween(cfg, docs)?.reasons).toEqual(["config"]);
  });

  it("a touched setup file selects every test under the runner config that loads it", () => {
    const base: Files = {
      ...REPO,
      "packages/app/vitest.config.ts":
        'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { setupFiles: ["./test/setup.ts"] } });\n',
      "packages/app/test/setup.ts": "globalThis.x = 1;\n",
    };
    const s = affected(base, { "packages/app/test/setup.ts": "globalThis.x = 2;\n" });
    expect(s.complete).toBe(true);
    expect(s.modules).not.toContain(CONFIG_SENTINEL);
    expect(s.testTargets).toEqual([
      "packages/app/test/a.test.ts",
      "packages/app/test/main.test.ts",
    ]);
  });
});

describe("completeness", () => {
  it("is false when no analyzer understands a touched file's dependents", () => {
    const s = affected(REPO, { "packages/tools/data/table.csv": "a,b,c\n" });
    expect(s.complete).toBe(false);
    expect(s.testTargets).toEqual([ALL_TESTS]);
    expect(s.publicApi).toBe(true);
    expect(s.deploysTo).toEqual(["app-worker"]);
    expect(s.analyzers.find((a) => a.name === "affected")?.note).toMatch(
      /no analyzer understands the dependents of: packages\/tools\/data\/table\.csv/,
    );
    const docs = affected(REPO, { "README.md": "x" });
    expect(conflictBetween(s, docs)?.reasons).toContain("incomplete");
  });

  it("a non-code file that something imports is understood", () => {
    const base: Files = {
      ...REPO,
      "packages/tools/data/labels.json": "{}",
      "packages/tools/src/index.ts":
        'import labels from "../data/labels.json";\nexport const tool = labels;\n',
    };
    const s = affected(base, { "packages/tools/data/labels.json": '{"a":1}' });
    expect(s.complete).toBe(true);
    expect(s.modules).toEqual(["packages/tools/data/labels.json", "packages/tools/src/index.ts"]);
  });

  it("is false when the closure reaches a package with unresolvable references", () => {
    const base: Files = {
      ...REPO,
      "packages/web/package.json": json({ name: "@m/web" }),
      "packages/web/src/page.ts": 'import { x } from "@/helpers";\nexport const page = x;\n',
      "packages/web/src/helpers.ts": "export const x = 1;\n",
    };
    const s = affected(base, { "packages/web/src/helpers.ts": "export const x = 2;\n" });
    expect(s.complete).toBe(false);
    expect(s.analyzers.find((a) => a.name === "affected")?.note).toMatch(/unresolvable references/);
    // A change elsewhere is unaffected by that hole.
    expect(
      affected(base, { "packages/tools/src/index.ts": "export const tool = 3;\n" }).complete,
    ).toBe(true);
  });

  it("is false when an analyzer crashes", () => {
    const boom: Analyzer = {
      name: "boom",
      version: "0",
      supports: () => true,
      reads: () => false,
      analyze: () => {
        throw new Error("kaput");
      },
    };
    const s = computeAffectedSet({
      head: tree({ ...REPO, "README.md": "y" }),
      base: tree(REPO),
      changes: [{ status: "modified", path: "README.md" }],
      analyzers: [boom],
    });
    expect(s.complete).toBe(false);
    expect(s.analyzers.find((a) => a.name === "boom")).toMatchObject({
      complete: false,
      note: "analyzer failed: kaput",
    });
  });
});

describe("test impact", () => {
  const edit = {
    "packages/core/src/math.ts": REPO["packages/core/src/math.ts"]?.replace("a * b", "b * a") ?? "",
  };

  it("static: test files whose import closure meets the change", () => {
    expect(affected(REPO, edit).testTargets).toEqual([
      "packages/app/test/main.test.ts",
      "packages/core/test/math.test.ts",
    ]);
  });

  it("coverage map: only tests that executed the closure (more precise than imports)", () => {
    const coverage = coverageMapOf({
      "packages/core/test/math.test.ts": [
        "packages/core/src/math.ts",
        "packages/core/src/internal.ts",
      ],
      "packages/core/test/internal.test.ts": ["packages/core/src/internal.ts"],
      // main.test.ts imports the barrel but never ran math.ts
      "packages/app/test/main.test.ts": ["packages/app/src/main.ts", "packages/core/src/index.ts"],
      "packages/app/test/a.test.ts": ["packages/app/src/routes/a.ts"],
      "packages/tools/test/tool.test.ts": ["packages/tools/src/index.ts"],
    });
    const s = affected(REPO, edit, { coverage });
    // main.test.ts imports math.ts through the barrel but never executed it.
    expect(s.testTargets).toEqual(["packages/core/test/math.test.ts"]);
    expect(s.analyzers.find((a) => a.name === "test-impact")?.note).toBe(
      "coverage map (5 tests): 1 by coverage (static alone: 2)",
    );
    const narrow = affected(
      REPO,
      {
        "packages/core/src/internal.ts":
          "export function clamp(n: number): number {\n  return n;\n}\n",
      },
      { coverage },
    );
    expect(narrow.testTargets).toEqual([
      "packages/core/test/internal.test.ts",
      "packages/core/test/math.test.ts",
    ]);
  });

  it("falls back to static analysis for files the map never saw and tests missing from it", () => {
    const base: Files = { ...REPO, "packages/core/src/fresh.ts": "export const fresh = 1;\n" };
    const s = affected(
      base,
      {
        "packages/core/src/fresh.ts": "export const fresh = 2;\n",
        "packages/core/test/fresh.test.ts": 'import { fresh } from "../src/fresh.js";\n',
        "packages/core/test/old-fresh.test.ts": 'import { fresh } from "../src/fresh.js";\n',
      },
      {
        coverage: coverageMapOf({
          "packages/core/test/math.test.ts": ["packages/core/src/math.ts"],
        }),
      },
    );
    expect(s.testTargets).toEqual([
      "packages/core/test/fresh.test.ts",
      "packages/core/test/old-fresh.test.ts",
    ]);
    expect(s.analyzers.find((a) => a.name === "test-impact")?.note).toMatch(/static fallback/);
  });

  it("parses istanbul-per-test and wrapped coverage maps with absolute paths", () => {
    const files = Object.keys(REPO);
    const istanbul = {
      "/ci/checkout/packages/core/test/math.test.ts": {
        "/ci/checkout/packages/core/src/math.ts": {
          path: "/ci/checkout/packages/core/src/math.ts",
          statementMap: {},
          s: { "0": 3 },
          f: {},
          b: {},
        },
        "/ci/checkout/packages/core/src/internal.ts": {
          path: "/ci/checkout/packages/core/src/internal.ts",
          s: { "0": 0 },
          f: { "0": 0 },
          b: { "0": [0, 0] },
        },
      },
    };
    const parsed = parseCoverageMap(istanbul, { files });
    expect([...(parsed.map.tests.get("packages/core/test/math.test.ts") ?? [])]).toEqual([
      "packages/core/src/math.ts",
    ]);
    const wrapped = parseCoverageMap(
      JSON.stringify({
        format: "gittifacts.coverage-map",
        version: 1,
        commit: "abc",
        root: "/w",
        tests: {
          "/w/packages/app/test/a.test.ts": ["/w/packages/app/src/routes/a.ts", "/w/gone.ts"],
          "/w/old.test.ts": [],
        },
      }),
      { files },
    );
    expect(wrapped.map.commit).toBe("abc");
    expect([...(wrapped.map.tests.get("packages/app/test/a.test.ts") ?? [])]).toEqual([
      "packages/app/src/routes/a.ts",
    ]);
    expect(wrapped.notes).toEqual([
      "1 test(s) in the map are not in the tree",
      "1 covered path(s) matched no file in the tree",
    ]);
    expect(() => parseCoverageMap({ format: "nope" }, { files })).toThrow(/coverage map must be/);
    expect(() => parseCoverageMap("{", { files })).toThrow(/not JSON/);
  });
});

describe("public API", () => {
  it("is true when an exported signature reachable from a package entry changes", () => {
    const s = affected(REPO, {
      "packages/core/src/math.ts":
        REPO["packages/core/src/math.ts"]?.replace(
          "mul(a: number, b: number)",
          "mul(a: number, b: number, c = 1)",
        ) ?? "",
    });
    expect(s.publicApi).toBe(true);
    expect(s.analyzers.find((a) => a.name === "public-api")?.note).toMatch(
      /packages\/core\/src\/math\.ts: exported signatures changed/,
    );
  });

  it("is false for body-only changes and for files no entry reaches", () => {
    expect(
      affected(REPO, {
        "packages/core/src/internal.ts":
          "export function clamp(n: number): number {\n  return n;\n}\n",
      }).publicApi,
    ).toBe(false);
    const base: Files = {
      ...REPO,
      "packages/core/scripts/gen.ts": "export function gen(a: number) {}\n",
    };
    expect(
      affected(base, { "packages/core/scripts/gen.ts": "export function gen(a: string) {}\n" })
        .publicApi,
    ).toBe(false);
  });

  it("an internal module's exported signature counts when the entry reaches it (types flow through)", () => {
    expect(
      affected(REPO, {
        "packages/core/src/internal.ts":
          "export function clamp(n: number, max = 1): number {\n  return n;\n}\n",
      }).publicApi,
    ).toBe(true);
  });

  it("a manifest's entry fields count; a precise verdict from evidence wins", () => {
    expect(
      affected(REPO, {
        "packages/core/package.json": json({
          name: "@m/core",
          exports: { ".": "./src/index.ts", "./math": "./src/math.ts" },
        }),
      }).publicApi,
    ).toBe(true);
    const edit = {
      "packages/core/src/math.ts": `${REPO["packages/core/src/math.ts"]}export const extra = 1;\n`,
    };
    expect(affected(REPO, edit).publicApi).toBe(true);
    expect(affected(REPO, edit, { publicApi: false }).publicApi).toBe(false);
  });
});

describe("Workers", () => {
  it("reads wrangler.toml and assets directories; ignores test-pool configs", () => {
    const base: Files = {
      ...REPO,
      "packages/site/wrangler.toml":
        'name = "site"\nmain = "src/index.ts"\n\n[assets]\ndirectory = "./public"\n',
      "packages/site/src/index.ts": "export default {};\n",
      "packages/site/public/logo.svg": "<svg/>",
      "packages/site/public/index.html": '<html><script src="./app.js"></script></html>',
      "packages/site/public/app.js": "console.log(1);\n",
      "packages/app/test/worker/wrangler.jsonc": '{ "name": "test-pool" }',
    };
    const s = affected(base, { "packages/site/public/app.js": "console.log(2);\n" });
    expect(s.complete).toBe(true);
    expect(s.modules).toEqual(["packages/site/public/app.js", "packages/site/public/index.html"]);
    expect(s.deploysTo).toEqual(["site"]);
    const logo = affected(base, { "packages/site/public/logo.svg": "<svg></svg>" });
    expect(logo.deploysTo).toEqual(["site"]);
    expect(logo.analyzers.find((a) => a.name === "workers")?.note).toBe(
      "2 Worker(s): app-worker (packages/app), site (packages/site)",
    );
  });
});

describe("conflicts", () => {
  const a = affected(REPO, { "packages/app/src/routes/a.ts": "export const a = () => 3;\n" });
  const b = affected(REPO, { "packages/app/src/routes/b.ts": "export const b = () => 4;\n" });
  const t = affected(REPO, { "packages/tools/src/index.ts": "export const tool = 5;\n" });

  it("closures meeting at a shared importer conflict; disjoint ones do not", () => {
    expect(conflictBetween(a, b)).toEqual({
      reasons: ["modules", "tests"],
      shared: {
        files: [],
        modules: ["packages/app/src/main.ts"],
        tests: ["packages/app/test/main.test.ts"],
      },
    });
    expect(conflictBetween(a, t)).toBeNull();
    expect(
      conflictComponents(
        new Map([
          ["a", a],
          ["b", b],
          ["t", t],
        ]),
      ),
    ).toEqual([["a", "b"], ["t"]]);
  });

  it("`*` test targets meet any non-empty test set", () => {
    const all = { ...t, testTargets: [ALL_TESTS] };
    expect(conflictBetween(all, a)?.reasons).toEqual(["tests"]);
    expect(conflictBetween(all, { ...a, testTargets: [] })).toBeNull();
  });
});

describe("contentNeeded", () => {
  it("asks only for files the analyzers read", () => {
    expect(contentNeeded("src/a.ts")).toBe(true);
    expect(contentNeeded("packages/x/package.json")).toBe(true);
    expect(contentNeeded("tsconfig.base.json")).toBe(true);
    expect(contentNeeded("apps/w/wrangler.toml")).toBe(true);
    expect(contentNeeded("docs/logo.png")).toBe(false);
    expect(contentNeeded("data/table.csv")).toBe(false);
  });
});
