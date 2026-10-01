import { describe, expect, it } from "vitest";
import {
  DETECT_PREFIX,
  DetectReport,
  inspectRepo,
  npmInstallScriptPackages,
  parseDetectOutput,
  parseJsonc,
  pnpmLockPackages,
  type RepoTree,
} from "../src/index.js";

function tree(files: Record<string, string>): RepoTree {
  return { files: Object.keys(files), read: (p) => files[p] ?? null };
}

const PNPM_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:
  .:
    devDependencies:
      esbuild:
        specifier: 0.25.0
        version: 0.25.0

packages:
  '@esbuild/linux-x64@0.25.0':
    resolution: {integrity: sha512-x}
  esbuild@0.25.0:
    resolution: {integrity: sha512-y}
    hasBin: true
  sharp@0.34.1:
    resolution: {integrity: sha512-z}
  vitest@4.1.11:
    resolution: {integrity: sha512-w}

snapshots:
  esbuild@0.25.0: {}
`;

const worker = {
  "package.json": JSON.stringify({
    name: "clock",
    packageManager: "pnpm@11.27.0",
    scripts: {
      test: "vitest run",
      build: "esbuild src/index.ts --bundle --outdir=dist",
      typecheck: "tsc --noEmit",
    },
    devDependencies: { esbuild: "0.25.0", vitest: "4.1.11", typescript: "6.0.3", sharp: "0.34.1" },
  }),
  "pnpm-lock.yaml": PNPM_LOCK,
  "pnpm-workspace.yaml": "# settings\nallowBuilds:\n  esbuild: true\n",
  "tsconfig.json": '{\n  // comment\n  "compilerOptions": { "strict": true, },\n}\n',
  "wrangler.jsonc": '{ "name": "clock-api", // the worker\n "main": "src/index.ts" }',
  "src/index.ts": "export default {};",
  "test/fixtures/wrangler.toml": 'name = "not-a-worker"',
};

describe("inspectRepo", () => {
  it("reports a pnpm + vitest Worker with its name, tsconfig and unapproved build scripts", () => {
    const r = inspectRepo(tree(worker), { sha: "a".repeat(40) });
    expect(DetectReport.parse(r)).toEqual(r);
    expect(r).toMatchObject({
      sha: "a".repeat(40),
      packageManager: "pnpm",
      packageManagerSpec: "pnpm@11.27.0",
      lockfile: "pnpm-lock.yaml",
      testRunner: "vitest",
      testCommand: "pnpm run test",
      buildCommand: "pnpm run build",
      installCommand: "pnpm install --frozen-lockfile",
      tsconfig: { path: "tsconfig.json", strict: true, extends: null, references: 0 },
      workers: ["clock-api"],
      workerConfigs: [{ path: "wrangler.jsonc", name: "clock-api" }],
      approvedBuilds: ["esbuild"],
    });
    // esbuild is approved; sharp is not.
    expect(r.buildScriptsNeedingApproval).toEqual([
      { name: "sharp", versions: ["0.34.1"], source: "known" },
    ]);
    expect(r.uncertain.join("\n")).toMatch(/ERR_PNPM_IGNORED_BUILDS\) for: sharp/);
    expect(r.uncertain.join("\n")).toMatch(/lockfiles don't record/);
    expect(r.confidence).not.toBe("high");
  });

  it("refines an unknown test runner from a vitest config and says so", () => {
    const r = inspectRepo(
      tree({
        "package.json": JSON.stringify({ scripts: { test: "node scripts/test.mjs" } }),
        "package-lock.json": JSON.stringify({ packages: {} }),
        "vitest.config.ts": "export default {}",
      }),
    );
    expect(r.testRunner).toBe("vitest");
    expect(r.features.testRunner).toBe("vitest");
    expect(r.testConfigs).toEqual(["vitest.config.ts"]);
    expect(r.uncertain.some((u) => u.startsWith("The test runner is neither"))).toBe(false);
    expect(r.uncertain.join("\n")).toMatch(/doesn't call vitest directly/);
  });

  it("is low-confidence without a package.json and never throws on junk", () => {
    const r = inspectRepo(tree({ "README.md": "# hi", "wrangler.toml": "[vars]\nX = 1" }));
    expect(r.confidence).toBe("low");
    expect(r.features.hasPackageJson).toBe(false);
    expect(r.workerConfigs).toEqual([{ path: "wrangler.toml", name: null }]);
    expect(r.uncertain.join("\n")).toMatch(/wrangler\.toml has no readable `name`/);

    const junk = inspectRepo(tree({ "package.json": "{ not json", "tsconfig.json": "{{" }));
    expect(junk.uncertain.join("\n")).toMatch(/could not be parsed/);
  });

  it("notes monorepos and npm install scripts", () => {
    const r = inspectRepo(
      tree({
        "package.json": JSON.stringify({ workspaces: ["packages/*"], scripts: { test: "jest" } }),
        "package-lock.json": JSON.stringify({
          packages: {
            "": {},
            "node_modules/bcrypt": { version: "5.1.1", hasInstallScript: true },
          },
        }),
      }),
    );
    expect(r.workspaces).toEqual(["packages/*"]);
    expect(r.uncertain.join("\n")).toMatch(/A monorepo/);
    expect(r.buildScriptsNeedingApproval).toEqual([]);
    expect(r.notes.join("\n")).toMatch(/npm runs install scripts of 1 package\(s\) \(bcrypt\)/);
  });

  it("round-trips through the ::detect:: line", () => {
    const r = inspectRepo(tree(worker));
    const out = `log line\n${DETECT_PREFIX}${JSON.stringify(r)}\n`;
    expect(parseDetectOutput(out)).toEqual(r);
    expect(parseDetectOutput("no marker")).toBeNull();
    expect(parseDetectOutput(`${DETECT_PREFIX}{"version":2}`)).toBeNull();
  });
});

describe("parsers", () => {
  it("parseJsonc strips comments and trailing commas but not // inside strings", () => {
    expect(parseJsonc('{ "url": "https://x", /* c */ "a": [1,2,], }')).toEqual({
      url: "https://x",
      a: [1, 2],
    });
    expect(parseJsonc("{")).toBeNull();
  });

  it("pnpmLockPackages reads v9 and v6 keys", () => {
    expect([...pnpmLockPackages(PNPM_LOCK).keys()]).toEqual([
      "@esbuild/linux-x64",
      "esbuild",
      "sharp",
      "vitest",
    ]);
    expect(pnpmLockPackages("packages:\n  /left-pad@1.3.0:\n    x: 1\n").get("left-pad")).toEqual([
      "1.3.0",
    ]);
  });

  it("npmInstallScriptPackages tolerates junk", () => {
    expect(npmInstallScriptPackages("nope").size).toBe(0);
  });
});
