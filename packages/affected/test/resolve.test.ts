import { describe, expect, it } from "vitest";
import { Resolver } from "../src/resolve.js";

function resolver(files: Record<string, string>): Resolver {
  return new Resolver({ files: Object.keys(files).sort(), read: (p) => files[p] ?? null });
}

const json = (v: unknown) => JSON.stringify(v);

describe("relative specifiers", () => {
  const r = resolver({
    "src/a.ts": "",
    "src/b.tsx": "",
    "src/c/index.ts": "",
    "src/d.js": "",
    "src/e.mts": "",
    "src/f.d.ts": "",
    "src/data.json": "",
    "src/icon.svg": "",
    "src/g/package.json": json({ main: "./lib/main.js" }),
    "src/g/lib/main.js": "",
  });

  it("probes extensions, index files and TS's .js → .ts mapping", () => {
    expect(r.resolve("src/x.ts", "./a")).toEqual(["src/a.ts"]);
    expect(r.resolve("src/x.ts", "./a.js")).toEqual(["src/a.ts"]);
    expect(r.resolve("src/x.ts", "./b")).toEqual(["src/b.tsx"]);
    expect(r.resolve("src/x.ts", "./b.js")).toEqual(["src/b.tsx"]);
    expect(r.resolve("src/x.ts", "./c")).toEqual(["src/c/index.ts"]);
    expect(r.resolve("src/x.ts", "./c/index.js")).toEqual(["src/c/index.ts"]);
    expect(r.resolve("src/x.ts", "./d.js")).toEqual(["src/d.js"]);
    expect(r.resolve("src/x.ts", "./e.mjs")).toEqual(["src/e.mts"]);
    expect(r.resolve("src/x.ts", "./f")).toEqual(["src/f.d.ts"]);
    expect(r.resolve("src/x.ts", "./data.json")).toEqual(["src/data.json"]);
    expect(r.resolve("src/x.ts", "./icon.svg?raw")).toEqual(["src/icon.svg"]);
    expect(r.resolve("src/sub/x.ts", "../a")).toEqual(["src/a.ts"]);
    expect(r.resolve("src/x.ts", "./g")).toEqual(["src/g/lib/main.js"]);
  });

  it("returns null for missing files and never escapes the repo", () => {
    expect(r.resolve("src/x.ts", "./missing")).toBeNull();
    expect(r.resolve("src/x.ts", "../../../etc/passwd")).toBeNull();
  });

  it("treats builtins and npm packages as external", () => {
    expect(r.resolve("src/x.ts", "node:fs")).toEqual([]);
    expect(r.resolve("src/x.ts", "fs/promises")).toEqual([]);
    expect(r.resolve("src/x.ts", "cloudflare:workers")).toEqual([]);
    expect(r.resolve("src/x.ts", "react")).toEqual([]);
    expect(r.resolve("src/x.ts", "@scope/not-here/sub")).toEqual([]);
  });
});

describe("tsconfig paths and baseUrl", () => {
  const r = resolver({
    "tsconfig.base.json": `{
      // comments and trailing commas are fine
      "compilerOptions": { "paths": { "@shared/*": ["./libs/shared/*"], "@exact": ["./libs/exact/main.ts"], }, },
    }`,
    "apps/web/tsconfig.json": json({
      extends: "../../tsconfig.base.json",
      compilerOptions: { paths: { "@/*": ["./src/*"] } },
    }),
    "apps/web/src/app.ts": "",
    "apps/web/src/lib/util.ts": "",
    "apps/api/tsconfig.json": json({
      extends: "../../tsconfig.base.json",
      compilerOptions: { baseUrl: "../.." },
    }),
    "apps/rooted/tsconfig.json": json({
      extends: "../../tsconfig.base.json",
      compilerOptions: { baseUrl: ".", paths: { "~/*": ["src/*"] } },
    }),
    "apps/rooted/src/thing.ts": "",
    "apps/api/src/main.ts": "",
    "libs/shared/log.ts": "",
    "libs/exact/main.ts": "",
    "libs/plain/thing.ts": "",
  });

  it("applies the nearest tsconfig's paths (relative to the tsconfig that declares them)", () => {
    expect(r.resolve("apps/web/src/app.ts", "@/lib/util")).toEqual(["apps/web/src/lib/util.ts"]);
  });

  it("resolves paths against baseUrl when one is set", () => {
    expect(r.resolve("apps/rooted/src/a.ts", "~/thing")).toEqual(["apps/rooted/src/thing.ts"]);
    expect(r.resolve("apps/rooted/src/a.ts", "src/thing")).toEqual(["apps/rooted/src/thing.ts"]);
  });

  it("inherits paths and baseUrl through extends", () => {
    expect(r.resolve("apps/api/src/main.ts", "@shared/log")).toEqual(["libs/shared/log.ts"]);
    expect(r.resolve("apps/api/src/main.ts", "@exact")).toEqual(["libs/exact/main.ts"]);
    expect(r.resolve("apps/api/src/main.ts", "libs/plain/thing")).toEqual(["libs/plain/thing.ts"]);
  });
});

describe("workspace packages", () => {
  const r = resolver({
    "packages/str/package.json": json({ name: "@w/str", exports: "./src/index.ts" }),
    "packages/str/src/index.ts": "",
    "packages/cond/package.json": json({
      name: "@w/cond",
      exports: {
        ".": { types: "./src/index.ts", import: "./src/index.ts" },
        "./node": "./src/node.ts",
      },
    }),
    "packages/cond/src/index.ts": "",
    "packages/cond/src/node.ts": "",
    "packages/pattern/package.json": json({
      name: "@w/pattern",
      exports: { "./*": "./src/*.ts", "./internal/*": null, "./package.json": "./package.json" },
    }),
    "packages/pattern/src/a.ts": "",
    "packages/pattern/src/deep/b.ts": "",
    "packages/built/package.json": json({
      name: "@w/built",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./x": "./dist/x/index.js",
      },
    }),
    "packages/built/tsconfig.json": json({
      compilerOptions: { outDir: "dist", rootDir: "lib-src" },
    }),
    "packages/built/lib-src/index.ts": "",
    "packages/built/lib-src/x/index.ts": "",
    "packages/legacy/package.json": json({ name: "legacy", main: "dist/main.js" }),
    "packages/legacy/src/main.ts": "",
    "packages/bare/package.json": json({ name: "bare" }),
    "packages/bare/src/index.ts": "",
    "packages/bare/src/extra.ts": "",
    "packages/imports/package.json": json({
      name: "@w/imports",
      imports: { "#internal/*": "./src/internal/*.ts", "#dep": "@w/str" },
    }),
    "packages/imports/src/a.ts": "",
    "packages/imports/src/internal/helper.ts": "",
    "packages/broken/package.json": json({ name: "@w/broken", exports: "./dist/gone.js" }),
  });

  it("resolves exports strings, conditions and subpaths", () => {
    expect(r.resolve("x.ts", "@w/str")).toEqual(["packages/str/src/index.ts"]);
    expect(r.resolve("x.ts", "@w/cond")).toEqual(["packages/cond/src/index.ts"]);
    expect(r.resolve("x.ts", "@w/cond/node")).toEqual(["packages/cond/src/node.ts"]);
  });

  it("resolves exports patterns", () => {
    expect(r.resolve("x.ts", "@w/pattern/a")).toEqual(["packages/pattern/src/a.ts"]);
    expect(r.resolve("x.ts", "@w/pattern/deep/b")).toEqual(["packages/pattern/src/deep/b.ts"]);
  });

  it("maps built targets back to sources (tsconfig outDir/rootDir, dist → src)", () => {
    expect(r.resolve("x.ts", "@w/built")).toEqual(["packages/built/lib-src/index.ts"]);
    expect(r.resolve("x.ts", "@w/built/x")).toEqual(["packages/built/lib-src/x/index.ts"]);
    expect(r.resolve("x.ts", "legacy")).toEqual(["packages/legacy/src/main.ts"]);
  });

  it("falls back to src/index and deep imports without exports", () => {
    expect(r.resolve("x.ts", "bare")).toEqual(["packages/bare/src/index.ts"]);
    expect(r.resolve("x.ts", "bare/extra")).toEqual(["packages/bare/src/extra.ts"]);
  });

  it("resolves package.json imports of the importer's package", () => {
    expect(r.resolve("packages/imports/src/a.ts", "#internal/helper")).toEqual([
      "packages/imports/src/internal/helper.ts",
    ]);
    expect(r.resolve("packages/imports/src/a.ts", "#dep")).toEqual(["packages/str/src/index.ts"]);
  });

  it("reports a local package whose entry maps to no file as unresolved (null), not external", () => {
    expect(r.resolve("x.ts", "@w/broken")).toBeNull();
    expect(r.isLocalPackageSpecifier("@w/broken")).toBe(true);
  });

  it("maps relative imports of build output to sources", () => {
    expect(r.resolve("packages/built/test/a.test.ts", "../dist/x/index.js")).toEqual([
      "packages/built/lib-src/x/index.ts",
    ]);
  });
});
