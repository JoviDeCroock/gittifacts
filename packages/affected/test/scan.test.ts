import { describe, expect, it } from "vitest";
import { exportSurface, sameSurface } from "../src/exports.js";
import { relativeStringLiterals, scanModule } from "../src/scan.js";

const specs = (src: string): string[] =>
  scanModule(src).refs.map((r) => `${r.kind}:${r.specifier}`);

describe("scanModule: static forms", () => {
  it("finds every import/export form", () => {
    const src = `
      import def from "./a";
      import * as ns from './b';
      import { x, y as z } from "./c.js";
      import def2, { w } from "./d";
      import "./side-effect";
      import type { T } from "./types";
      import type Def from "./type-default";
      import { type U, V } from "./mixed";
      export * from "./e";
      export * as ens from "./f";
      export { g, h as i } from "./g";
      export type { TT } from "./tt";
      export { local };
      export const k = 1;
      import json from "./data.json" with { type: "json" };
    `;
    expect(specs(src)).toEqual([
      "import:./a",
      "import:./b",
      "import:./c.js",
      "import:./d",
      "import:./side-effect",
      "import:./types",
      "import:./type-default",
      "import:./mixed",
      "export:./e",
      "export:./f",
      "export:./g",
      "export:./tt",
      "import:./data.json",
    ]);
    const refs = scanModule(src).refs;
    expect(refs.find((r) => r.specifier === "./types")?.typeOnly).toBe(true);
    expect(refs.find((r) => r.specifier === "./type-default")?.typeOnly).toBe(true);
    expect(refs.find((r) => r.specifier === "./mixed")?.typeOnly).toBe(false);
    expect(refs.find((r) => r.specifier === "./tt")?.typeOnly).toBe(true);
  });

  it("handles multi-line import lists and an imported binding named `from`", () => {
    const src = `import {\n  a,\n  from,\n  b,\n} from "./multi";\nimport { type } from "./named-type";`;
    expect(specs(src)).toEqual(["import:./multi", "import:./named-type"]);
    expect(scanModule(src).refs[1]?.typeOnly).toBe(false);
  });

  it("reports line numbers", () => {
    const refs = scanModule(
      `// header\n\nimport a from "./a";\n\n\nconst b = require("./b");`,
    ).refs;
    expect(refs.map((r) => r.line)).toEqual([3, 6]);
  });
});

describe("scanModule: dynamic forms", () => {
  it("finds import(), require(), require.resolve and import.meta.resolve", () => {
    const src = `
      const a = await import("./lazy");
      const b = require('./cjs');
      const c = require.resolve("./resolved");
      const d = import.meta.resolve("./meta-resolved");
      const { e } = await import(\`./no-subst\`);
      import x = require("./ts-import-equals");
    `;
    expect(specs(src)).toEqual([
      "dynamic:./lazy",
      "require:./cjs",
      "require:./resolved",
      "dynamic:./meta-resolved",
      "dynamic:./no-subst",
      "require:./ts-import-equals",
    ]);
  });

  it("turns computed specifiers with a static relative prefix into globs, others into opaque loads", () => {
    const scan = scanModule(`
      const m = await import(\`./locales/\${lang}.json\`);
      const n = require("./plugins/" + name);
      const o = await import(\`./a/\${x}/b/\${y}.js\`);
      const p = await import(specifier);
      const q = require(\`\${base}/x\`);
    `);
    expect(scan.templates.map((t) => t.parts)).toEqual([
      ["./locales/", ".json"],
      ["./plugins/", ""],
      ["./a/", "/b/", ".js"],
    ]);
    expect(scan.opaque.map((o) => o.kind)).toEqual(["dynamic", "require"]);
  });

  it("finds import.meta.glob, new URL(…, import.meta.url) and vi/jest mocks", () => {
    const src = `
      const pages = import.meta.glob("./pages/*.tsx");
      const many = import.meta.glob(["./a/*.ts", "./b/**/*.md"]);
      const worker = new URL("./worker.js", import.meta.url);
      vi.mock("./mocked");
      jest.mock('../jest-mocked', () => ({}));
      const actual = await vi.importActual("./actual");
    `;
    expect(specs(src)).toEqual([
      "glob:./pages/*.tsx",
      "glob:./a/*.ts",
      "glob:./b/**/*.md",
      "url:./worker.js",
      "mock:./mocked",
      "mock:../jest-mocked",
      "mock:./actual",
    ]);
  });

  it("reads triple-slash references", () => {
    const refs = scanModule(
      `/// <reference path="globals.d.ts" />\n/// <reference types="vite/client" />\n`,
    ).refs;
    expect(refs.map((r) => [r.specifier, r.typeOnly])).toEqual([
      ["./globals.d.ts", false],
      ["vite/client", true],
    ]);
  });
});

describe("scanModule: things that are not imports", () => {
  it("ignores comments, strings and template text", () => {
    const src = `
      // import a from "./commented";
      /* import b from "./block";
         require("./block-require") */
      const s = 'import c from "./in-string"';
      const t = "require('./in-double')";
      const u = \`import d from "./in-template" \${"x"} require("./also")\`;
      const v = \`
        import e from "./multiline-template";
      \`;
    `;
    expect(specs(src)).toEqual([]);
  });

  it("ignores member accesses and object keys named import/require/export", () => {
    const src = `
      obj.import("./member");
      obj.require("./member-require");
      const cfg = { import: "./dist/index.js", require: "./dist/index.cjs", export: 1 };
      function require(x) { return x; }
      router.export({ from: "./nope" });
    `;
    expect(specs(src)).toEqual([]);
  });

  it("survives regex literals containing quotes, slashes and backticks", () => {
    const src = `
      const re = /["'\`]/g;
      const re2 = /\\/\\/ not a comment/;
      const re3 = /[/"]+/;
      if (/^import/.test(x)) {}
      const div = a / b / c;
      import z from "./after-regex";
    `;
    expect(specs(src)).toEqual(["import:./after-regex"]);
  });

  it("tolerates JSX text with apostrophes and slashes", () => {
    const src = `
      import React from "react";
      export const C = () => (
        <div>
          <p>Don't stop: it's fine // really</p>
          <a href="https://example.com">it's a link</a>
        </div>
      );
      const L = lazy(() => import("./LazyPage"));
    `;
    expect(specs(src)).toEqual(["import:react", "dynamic:./LazyPage"]);
  });

  it("handles nested template substitutions", () => {
    const src = `
      const s = \`a \${cond ? \`b \${x} c\` : "d"} e\`;
      const lazy = () => import("./after-nested");
      const t = \`\${\`\${\`deep\`}\`}\`;
      const w = await import(\`./w/\${\`\${k}\`}.ts\`);
    `;
    const scan = scanModule(src);
    expect(scan.refs.map((r) => r.specifier)).toEqual(["./after-nested"]);
    expect(scan.templates.map((t) => t.parts)).toEqual([["./w/", ".ts"]]);
  });

  it("never throws on malformed input", () => {
    for (const src of [
      "`unterminated ${",
      "'open",
      "/* open",
      "import {",
      'import x from "',
      "}}}{{{",
      "/",
    ]) {
      expect(() => scanModule(src)).not.toThrow();
    }
  });

  it("does not treat a shebang as code", () => {
    expect(specs(`#!/usr/bin/env node\nimport a from "./a";`)).toEqual(["import:./a"]);
  });
});

describe("relativeStringLiterals", () => {
  it("lists relative string literals (test-runner setup files)", () => {
    expect(
      relativeStringLiterals(
        `export default { test: { setupFiles: ["./test/setup.ts"], name: "x", root: '../up' } }`,
      ),
    ).toEqual(["./test/setup.ts", "../up"]);
  });
});

describe("exportSurface", () => {
  const same = (a: string, b: string) => sameSurface(exportSurface(a), exportSurface(b));

  it("ignores function bodies, comments and whitespace", () => {
    expect(
      same(
        "export function f(a: number): string { return String(a); }",
        "// doc\nexport function f(a: number): string {\n  const x = a * 2; // changed\n  return String(x);\n}",
      ),
    ).toBe(true);
    expect(
      same(
        "export const g = (a: number) => { return a; };",
        "export const g = (a: number) => { return a + 1; };",
      ),
    ).toBe(true);
  });

  it("sees signature, type and value changes", () => {
    expect(
      same(
        "export function f(a: number): string { return ''; }",
        "export function f(a: number, b?: string): string { return ''; }",
      ),
    ).toBe(false);
    expect(
      same("export interface I { a: number }", "export interface I { a: number; b: string }"),
    ).toBe(false);
    expect(same("export const VERSION = '1';", "export const VERSION = '2';")).toBe(false);
    expect(same("export type T = 'a' | 'b';", "export type T = 'a';")).toBe(false);
  });

  it("tracks additions, removals and re-exports", () => {
    expect(
      exportSurface("export function a() {}\nexport const b = 1;\nexport default class {}").size,
    ).toBe(3);
    expect(same("export * from './a';", "export * from './b';")).toBe(false);
    expect(same("export { x } from './a';", "export { x, y } from './a';")).toBe(false);
    expect(same("export function a() {}", "export function a() {}\nexport function b() {}")).toBe(
      false,
    );
  });

  it("describes local export lists through their declarations", () => {
    const a = "function f(a: number) { return a; }\nexport { f as g };";
    const b = "function f(a: string) { return a; }\nexport { f as g };";
    expect([...exportSurface(a).keys()]).toEqual(["g"]);
    expect(same(a, b)).toBe(false);
    expect(same(a, "function f(a: number) { return a * 2; }\nexport { f as g };")).toBe(true);
  });

  it("keeps return-type object literals but drops the body", () => {
    expect(
      same(
        "export function f(): { a: number } { return { a: 1 }; }",
        "export function f(): { a: number } { return { a: 2 }; }",
      ),
    ).toBe(true);
    expect(
      same(
        "export function f(): { a: number } { return { a: 1 }; }",
        "export function f(): { a: string } { return { a: '' }; }",
      ),
    ).toBe(false);
  });

  it("compares class member signatures, not method bodies", () => {
    const a = "export class A extends B { x = 1; m(a: number): void { run(a); } }";
    expect(same(a, "export class A extends B { x = 1; m(a: number): void { run(a + 1); } }")).toBe(
      true,
    );
    expect(same(a, "export class A extends B { x = 1; m(a: string): void { run(a); } }")).toBe(
      false,
    );
  });
});
