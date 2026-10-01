import { describe, expect, it } from "vitest";
import {
  diffApiSurface,
  expandBraces,
  firstMatchingPattern,
  globToRegExp,
  matchGlob,
  matchPathPattern,
  maxClassification,
  PublicApiDiff,
  publicApiDiff,
  SensitivePathHits,
  sensitivePathHits,
} from "../src/index.js";

describe("matchGlob (whole path)", () => {
  it.each([
    // *
    ["*.ts", "a.ts", true],
    ["*.ts", "src/a.ts", false],
    ["*.ts", ".ts", true],
    ["src/*", "src/a", true],
    ["src/*", "src/a/b", false],
    ["src/*", "src/", true],
    ["*", ".env", true], // dotfiles match
    [".env*", ".env.local", true],
    ["a*b*c", "aXXbYYc", true],
    ["a*b*c", "a/b/c", false],
    ["***.ts", "x.ts", true], // runs of * collapse
    // ?
    ["?.md", "a.md", true],
    ["?.md", "ab.md", false],
    ["a?b", "a/b", false],
    ["?", "😀", true], // one code point
    // **
    ["**", "any/depth/at.all", true],
    ["**", "", true],
    ["**/*.pem", "key.pem", true],
    ["**/*.pem", "deep/er/key.pem", true],
    ["**/*.pem", ".secrets/key.pem", true],
    ["**/*.pem", "key.pem.bak", false],
    ["src/**", "src", true],
    ["src/**", "src/a/b.ts", true],
    ["src/**", "srcx/a", false],
    ["src/**/test/*.ts", "src/test/a.ts", true],
    ["src/**/test/*.ts", "src/a/b/test/a.ts", true],
    ["src/**/test/*.ts", "src/a/b/test/x/a.ts", false],
    [".github/**", ".github/workflows/ci.yml", true],
    ["a/**/**/b", "a/b", true],
    ["a/**/**/b", "a/x/y/b", true],
    ["a**b", "aXb", true], // ** inside a segment is just *
    ["a**b", "a/b", false],
    // braces
    ["*.{ts,tsx}", "a.tsx", true],
    ["*.{ts,tsx}", "a.js", false],
    ["{src,lib}/**/*.{js,mjs}", "lib/x/y.mjs", true],
    ["{a,{b,c}}.txt", "c.txt", true],
    ["{a,b/**}", "b/c/d", true],
    ["{x}.txt", "{x}.txt", true], // no comma: literal
    ["{,.}env", ".env", true], // empty alternative
    ["{,.}env", "env", true],
    ["file{.txt", "file{.txt", true], // unclosed: literal
    // classes
    ["[abc].ts", "b.ts", true],
    ["[abc].ts", "d.ts", false],
    ["[a-c].ts", "c.ts", true],
    ["[!a].ts", "b.ts", true],
    ["[!a].ts", "a.ts", false],
    ["[!a]x", "/x", false], // negated class never matches /
    ["x[", "x[", true], // unclosed: literal
    ["[]]", "]", true],
    // escapes and regex metacharacters
    ["\\*.ts", "*.ts", true],
    ["\\*.ts", "a.ts", false],
    ["a+b(c)|d$.^", "a+b(c)|d$.^", true],
    ["a.b", "aXb", false],
    ["v1-2.txt", "v1-2.txt", true],
    ["./src/*.ts", "src/a.ts", false], // patterns are not normalized by matchGlob
  ] as const)("%s ~ %s → %s", (pattern, path, expected) => {
    expect(matchGlob(pattern, path)).toBe(expected);
  });

  it("normalizes a leading ./ on the path", () => {
    expect(matchGlob("src/*.ts", "./src/a.ts")).toBe(true);
  });

  it("brace expansion", () => {
    expect(expandBraces("src/{a,b}.{ts,js}")).toEqual([
      "src/a.ts",
      "src/a.js",
      "src/b.ts",
      "src/b.js",
    ]);
    expect(expandBraces("{{a,b}}")).toEqual(["{a}", "{b}"]);
    expect(expandBraces("\\{a,b}")).toEqual(["\\{a,b}"]);
    expect(expandBraces("[{]a,b}")).toEqual(["[{]a,b}"]);
    expect(() => expandBraces("{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}")).toThrow(
      /more than/,
    );
  });

  it("compiles to a cached, anchored RegExp", () => {
    const re = globToRegExp("src/**/*.ts");
    expect(globToRegExp("src/**/*.ts")).toBe(re);
    expect(re.source.startsWith("^")).toBe(true);
  });
});

describe("matchPathPattern (gitignore-style)", () => {
  it.each([
    ["*.pem", "certs/prod/server.pem", true], // no slash → any depth
    ["*.pem", "server.pem", true],
    [".env*", "apps/api/.env.production", true],
    ["Dockerfile", "services/api/Dockerfile", true],
    ["infra", "infra/main.tf", true], // matches a parent dir
    ["infra", "x/infra/main.tf", true],
    ["infra", "infrastructure/main.tf", false],
    ["/infra", "x/infra/main.tf", false], // leading / anchors
    ["/infra", "infra/main.tf", true],
    ["infra/", "infra/main.tf", true], // trailing / = directory only
    ["infra/", "infra", false],
    ["infra/", "a/infra/b", true],
    [".github/workflows/", ".github/workflows/ci.yml", true],
    ["src/auth/**", "src/auth/session.ts", true],
    ["src/auth/**", "lib/src/auth/session.ts", false], // has a slash → anchored
    ["src/*", "src/a/b.ts", true], // src/a matches src/*, so everything under it does
    ["**/migrations/*.sql", "db/migrations/001.sql", true],
    [".platform/policy.ts", ".platform/policy.ts", true],
    ["./.platform/policy.ts", ".platform/policy.ts", true],
    ["package.json", "packages/a/package.json", true],
    ["/package.json", "packages/a/package.json", false],
  ] as const)("%s ~ %s → %s", (pattern, path, expected) => {
    expect(matchPathPattern(pattern, path)).toBe(expected);
  });

  it("firstMatchingPattern returns the first hit in order", () => {
    expect(firstMatchingPattern(["*.md", "docs/**", "**"], "docs/a.md")).toBe("*.md");
    expect(firstMatchingPattern(["*.md"], "a.ts")).toBeUndefined();
  });
});

describe("sensitivePathHits", () => {
  it("reports every (path, pattern) hit", () => {
    const item = sensitivePathHits(
      [
        ".github/workflows/ci.yml",
        "src/auth/session.ts",
        "README.md",
        "certs/dev.pem",
        "src/auth/session.ts",
      ],
      [".github/**", "src/auth/**", "*.pem", "**/session.*"],
    );
    expect(SensitivePathHits.parse(item)).toEqual(item);
    expect(item.status).toBe("ok");
    expect(item.hits).toEqual([
      { path: ".github/workflows/ci.yml", pattern: ".github/**" },
      { path: "src/auth/session.ts", pattern: "src/auth/**" },
      { path: "src/auth/session.ts", pattern: "**/session.*" },
      { path: "certs/dev.pem", pattern: "*.pem" },
    ]);
  });

  it("no patterns or no hits is ok with empty hits", () => {
    expect(sensitivePathHits(["a"], [])).toMatchObject({ status: "ok", hits: [], patterns: [] });
    expect(sensitivePathHits([], ["**"])).toMatchObject({ status: "ok", hits: [] });
  });

  it("a pattern that cannot be evaluated is an error", () => {
    const bomb = "{a,b}".repeat(12);
    const item = sensitivePathHits(["a"], [bomb, "a"]);
    expect(item.status).toBe("error");
    expect(item.hits).toEqual([{ path: "a", pattern: "a" }]);
    expect(item.note).toMatch(/invalid patterns/);
  });
});

describe("diffApiSurface", () => {
  const base = {
    add: "(a: number, b: number) => number",
    sub: "(a: number, b: number) => number",
    Config: "interface Config { url: string }",
  };

  it("none when identical", () => {
    expect(diffApiSurface(base, { ...base })).toEqual({
      classification: "none",
      added: [],
      removed: [],
      changed: [],
    });
  });

  it("additive when only added", () => {
    const d = diffApiSurface(base, { ...base, mul: "(a: number, b: number) => number" });
    expect(d.classification).toBe("additive");
    expect(d.added).toEqual([{ symbol: "mul", after: "(a: number, b: number) => number" }]);
  });

  it("breaking when removed or changed (even alongside additions)", () => {
    const { sub: _sub, ...rest } = base;
    const removed = diffApiSurface(base, { ...rest, mul: "x" });
    expect(removed).toMatchObject({
      classification: "breaking",
      removed: [{ symbol: "sub", before: base.sub }],
    });
    const changed = diffApiSurface(base, {
      ...base,
      Config: "interface Config { url: string; retries?: number }",
    });
    expect(changed.classification).toBe("breaking");
    expect(changed.changed).toEqual([
      {
        symbol: "Config",
        before: "interface Config { url: string }",
        after: "interface Config { url: string; retries?: number }",
      },
    ]);
  });

  it("sorts symbols and ignores prototype names", () => {
    const d = diffApiSurface({}, { z: "1", constructor: "class", toString: "fn", a: "2" });
    expect(d.added.map((a) => a.symbol)).toEqual(["a", "constructor", "toString", "z"]);
    expect(diffApiSurface({ constructor: "class" }, {}).removed).toEqual([
      { symbol: "constructor", before: "class" },
    ]);
  });

  it("truncates huge signatures to the schema limit", () => {
    const d = diffApiSurface({}, { big: "x".repeat(10_000) });
    expect(d.added[0]?.after?.length).toBe(4000);
  });

  it("publicApiDiff aggregates packages and treats a removed entry as breaking", () => {
    const item = publicApiDiff([
      { name: "@app/a", entry: ".", base: { f: "1" }, head: { f: "1", g: "2" } },
      { name: "@app/b", entry: "./node", base: {}, head: null },
      { name: "@app/c", entry: ".", base: null, head: { h: "3" } },
    ]);
    expect(PublicApiDiff.parse(item)).toEqual(item);
    expect(item.classification).toBe("breaking");
    expect(item.packages[0]?.added).toEqual([{ symbol: "g", after: "2" }]);
    expect(maxClassification("none", "additive")).toBe("additive");
    expect(maxClassification()).toBe("none");
    expect(
      publicApiDiff([{ name: "@app/a", entry: ".", base: { f: "1" }, head: { f: "1" } }])
        .classification,
    ).toBe("none");
  });
});
