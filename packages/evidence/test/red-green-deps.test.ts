import { describe, expect, it } from "vitest";
import {
  DependencyDiff,
  dependencyDiff,
  parseSimpleRange,
  parseVersion,
  RedGreenProof,
  redGreenDetails,
  redGreenProof,
  redGreenVerdict,
  semverBump,
  type TestResult,
} from "../src/index.js";
import { BASE_SHA, HEAD_SHA } from "./helpers.js";

const t = (id: string) => ({ id, file: `test/${id}.test.ts`, name: id });
const r = (id: string, outcome: TestResult["outcome"]): TestResult => ({ id, outcome });

describe("redGreenVerdict", () => {
  it("no tests → no-tests", () => {
    expect(redGreenVerdict([], [r("a", "fail")], [r("a", "pass")])).toBe("no-tests");
  });

  it.each([
    ["fail on base, pass on head", [r("a", "fail")], [r("a", "pass")], "proven"],
    ["error on base", [r("a", "error")], [r("a", "pass")], "proven"],
    ["missing on base (test file is new)", [], [r("a", "pass")], "proven"],
    ["explicit missing on base", [r("a", "missing")], [r("a", "pass")], "proven"],
    ["already passing on base", [r("a", "pass")], [r("a", "pass")], "not-proven"],
    ["fails on head", [r("a", "fail")], [r("a", "fail")], "not-proven"],
    ["not run on head", [r("a", "fail")], [], "not-proven"],
    [
      "flaky on base (one pass) is not red",
      [r("a", "fail"), r("a", "pass")],
      [r("a", "pass")],
      "not-proven",
    ],
    [
      "flaky on head is not green",
      [r("a", "fail")],
      [r("a", "pass"), r("a", "fail")],
      "not-proven",
    ],
  ] as const)("single test: %s", (_n, base, head, verdict) => {
    expect(redGreenVerdict([t("a")], [...base], [...head])).toBe(verdict);
  });

  it("needs ≥1 red on base and ALL green on head", () => {
    const tests = [t("a"), t("b")];
    // b was already passing; a is the real red→green: still proven.
    expect(
      redGreenVerdict(tests, [r("a", "fail"), r("b", "pass")], [r("a", "pass"), r("b", "pass")]),
    ).toBe("proven");
    // one head failure breaks it
    expect(
      redGreenVerdict(tests, [r("a", "fail"), r("b", "fail")], [r("a", "pass"), r("b", "error")]),
    ).toBe("not-proven");
    // results for unlisted tests are ignored
    expect(
      redGreenVerdict([t("a")], [r("a", "fail"), r("z", "fail")], [r("a", "pass"), r("z", "fail")]),
    ).toBe("proven");
  });

  it("details explain each test", () => {
    expect(redGreenDetails([t("a"), t("a"), t("b")], [r("a", "error")], [r("a", "pass")])).toEqual([
      { id: "a", base: "error", head: "pass", red: true, green: true },
      { id: "b", base: "missing", head: "missing", red: true, green: false },
    ]);
  });

  it("redGreenProof builds a schema-valid item", () => {
    const item = redGreenProof({
      tests: [t("a")],
      base: { sha: BASE_SHA, results: [r("a", "fail")] },
      head: { sha: HEAD_SHA, results: [r("a", "pass")] },
      logRef: "r2://logs/1",
    });
    expect(RedGreenProof.parse(item)).toEqual(item);
    expect(item).toMatchObject({
      id: "red-green",
      status: "ok",
      verdict: "proven",
      logRef: "r2://logs/1",
    });
  });
});

describe("semver", () => {
  it.each([
    ["^1.2.3", "^2.0.0", "major"],
    ["^1.2.3", "^1.3.0", "minor"],
    ["^1.2.3", "^1.2.4", "patch"],
    ["~1.2.3", "~1.2.9", "patch"],
    ["1.2.3", "1.4.0", "minor"],
    ["=1.2.3", "v2.0.0", "major"],
    ["2.0.0", "1.9.9", "major"], // downgrade: magnitude counts
    ["^1", "^2", "major"],
    ["1.x", "1.2.x", "minor"],
    ["^0.2.3", "^0.3.0", "major"], // 0.x: minor is breaking
    ["^0.2.3", "^0.2.9", "patch"],
    ["0.0.3", "0.0.4", "major"], // 0.0.x: every change is breaking
    ["1.2.3-beta.1", "1.2.3-beta.2", "prerelease"],
    ["1.2.3-rc.1", "1.2.3", "prerelease"],
    ["1.2.3", "1.3.0-rc.0", "prerelease"],
    ["1.2.3", "2.0.0-rc.0", "major"],
    ["1.2.3", "^1.2.3", "other"], // operator change
    ["^1.2.3", "~1.2.3", "other"],
    ["1.2.3", "1.2.3+build.5", "other"], // build metadata only
    ["workspace:*", "workspace:^1.0.0", "other"],
    ["workspace:^1.0.0", "workspace:^2.0.0", "other"],
    ["github:user/repo#v1", "github:user/repo#v2", "other"],
    ["git+https://github.com/u/r.git#1.0.0", "git+https://github.com/u/r.git#2.0.0", "other"],
    ["user/repo", "user/repo#semver:^2", "other"],
    ["file:../a", "file:../b", "other"],
    ["latest", "next", "other"],
    ["*", "^1.0.0", "other"],
    [">=1.2.3 <2", ">=2", "other"],
    ["^1.0.0 || ^2.0.0", "^3.0.0", "other"],
    ["1.2.3 - 2.0.0", "2.0.0", "other"],
    ["npm:string-width@^4.2.0", "npm:string-width@^5.0.0", "major"],
    ["npm:a@^1.0.0", "npm:b@^1.0.1", "other"],
    ["^1.2.3", "npm:x@^1.2.3", "other"],
  ] as const)("%s → %s is %s", (from, to, bump) => {
    expect(semverBump(from, to)).toBe(bump);
  });

  it("parses versions and simple ranges", () => {
    expect(parseVersion("v1.2.3-rc.1+b")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["rc", "1"],
    });
    expect(parseVersion("1")).toEqual({ major: 1, minor: 0, patch: 0, prerelease: [] });
    expect(parseVersion("01.2.3")).toBeNull();
    expect(parseSimpleRange("~1.2")).toMatchObject({
      op: "tilde",
      version: { major: 1, minor: 2 },
    });
    expect(parseSimpleRange(">=1")).toBeNull();
  });
});

describe("dependencyDiff", () => {
  const base = {
    "package.json": JSON.stringify({
      name: "root",
      private: true,
      scripts: { build: "tsc", prepare: "husky" },
      devDependencies: { typescript: "6.0.3", vitest: "4.1.11" },
    }),
    "packages/web/package.json": JSON.stringify({
      name: "@app/web",
      dependencies: { preact: "^10.20.0", "left-pad": "^1.3.0", zod: "^3.23.0" },
      peerDependencies: { react: "^18.0.0" },
    }),
    "packages/gone/package.json": JSON.stringify({
      name: "gone",
      dependencies: { lodash: "^4.17.21" },
    }),
  };
  const head = {
    "package.json": JSON.stringify({
      name: "root",
      private: true,
      scripts: { build: "tsc", prepare: "husky install", postinstall: "node scripts/setup.js" },
      devDependencies: { typescript: "6.0.3", vitest: "4.2.0", esbuild: "0.28.2" },
    }),
    "packages/web/package.json": JSON.stringify({
      name: "@app/web",
      dependencies: { preact: "^10.24.0", zod: "^4.6.5", "is-odd": "github:i/is-odd" },
      peerDependencies: { react: "^19.0.0" },
      optionalDependencies: { fsevents: "2.3.3" },
    }),
    "packages/new/package.json": JSON.stringify({
      name: "new-pkg",
      scripts: { install: "node-gyp rebuild" },
      dependencies: { nan: "^2.0.0" },
    }),
  };

  it("reports added/removed/changed deps across manifests and sections", () => {
    const d = dependencyDiff(base, head, { changedPaths: ["package.json", "pnpm-lock.yaml"] });
    expect(DependencyDiff.parse(d)).toEqual(d);
    expect(d.status).toBe("ok");
    expect(d.lockfileChanged).toBe(true);
    expect(d.added).toEqual([
      {
        name: "esbuild",
        version: "0.28.2",
        dev: true,
        manifest: "package.json",
        section: "devDependencies",
      },
      {
        name: "nan",
        version: "^2.0.0",
        dev: false,
        manifest: "packages/new/package.json",
        section: "dependencies",
      },
      {
        name: "fsevents",
        version: "2.3.3",
        dev: false,
        manifest: "packages/web/package.json",
        section: "optionalDependencies",
      },
      {
        name: "is-odd",
        version: "github:i/is-odd",
        dev: false,
        manifest: "packages/web/package.json",
        section: "dependencies",
      },
    ]);
    expect(d.removed.map((x) => [x.manifest, x.name])).toEqual([
      ["packages/gone/package.json", "lodash"],
      ["packages/web/package.json", "left-pad"],
    ]);
    expect(d.changed.map((x) => [x.name, x.from, x.to, x.bump, x.section])).toEqual([
      ["vitest", "4.1.11", "4.2.0", "minor", "devDependencies"],
      ["preact", "^10.20.0", "^10.24.0", "minor", "dependencies"],
      ["react", "^18.0.0", "^19.0.0", "major", "peerDependencies"],
      ["zod", "^3.23.0", "^4.6.5", "major", "dependencies"],
    ]);
  });

  it("flags new or changed lifecycle scripts", () => {
    const d = dependencyDiff(base, head);
    expect(d.newInstallScripts).toEqual([
      {
        name: "root",
        script: "postinstall",
        command: "node scripts/setup.js",
        manifest: "package.json",
      },
      { name: "root", script: "prepare", command: "husky install", manifest: "package.json" },
      {
        name: "new-pkg",
        script: "install",
        command: "node-gyp rebuild",
        manifest: "packages/new/package.json",
      },
    ]);
    expect(d.lockfileChanged).toBe(false);
  });

  it("detects lockfiles in nested dirs and honors an explicit flag", () => {
    expect(
      dependencyDiff({}, {}, { changedPaths: ["apps/x/package-lock.json"] }).lockfileChanged,
    ).toBe(true);
    expect(dependencyDiff({}, {}, { changedPaths: ["docs/yarn.lock.md"] }).lockfileChanged).toBe(
      false,
    );
    expect(
      dependencyDiff({}, {}, { lockfileChanged: true, changedPaths: [] }).lockfileChanged,
    ).toBe(true);
  });

  it("an unparseable manifest is an error, not silence", () => {
    const d = dependencyDiff(
      { "package.json": "{}" },
      { "package.json": "{ nope", "b/package.json": '{"dependencies":{"x":1}}' },
    );
    expect(d.status).toBe("error");
    expect(d.note).toMatch(/head package\.json: invalid JSON/);
    expect(d.note).toMatch(/head b\/package\.json: dependencies\.x/);
  });

  it("no changes → empty ok item", () => {
    const d = dependencyDiff(base, base);
    expect(d).toMatchObject({
      status: "ok",
      added: [],
      removed: [],
      changed: [],
      newInstallScripts: [],
    });
  });

  it("is not fooled by prototype-looking names", () => {
    const d = dependencyDiff(
      { "package.json": JSON.stringify({ dependencies: {} }) },
      { "package.json": '{"dependencies":{"constructor":"1.0.0","__proto__":"2.0.0"}}' },
    );
    expect(d.added.map((a) => a.name).sort()).toEqual(["__proto__", "constructor"]);
  });
});
