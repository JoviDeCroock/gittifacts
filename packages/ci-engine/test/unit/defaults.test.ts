import { describe, expect, it } from "vitest";
import {
  defaultPipeline,
  detectPackageManager,
  detectRepoFeatures,
  installCommand,
} from "../../src/plan/defaults.js";
import { parsePipelineSpec } from "../../src/plan/spec.js";

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  scripts,
  ...extra,
});

describe("detectPackageManager", () => {
  it("uses the lockfile", () => {
    expect(
      detectPackageManager({ rootEntries: ["package.json", "pnpm-lock.yaml"], packageJson: {} }),
    ).toBe("pnpm");
    expect(
      detectPackageManager({ rootEntries: ["package.json", "package-lock.json"], packageJson: {} }),
    ).toBe("npm");
    expect(
      detectPackageManager({ rootEntries: ["package.json", "yarn.lock"], packageJson: {} }),
    ).toBe("yarn");
    expect(
      detectPackageManager({
        rootEntries: ["package.json", "yarn.lock", ".yarnrc.yml"],
        packageJson: {},
      }),
    ).toBe("yarn-berry");
    expect(
      detectPackageManager({ rootEntries: ["package.json", "bun.lock"], packageJson: {} }),
    ).toBe("bun");
  });

  it("prefers the packageManager field", () => {
    expect(
      detectPackageManager({
        rootEntries: ["package.json", "package-lock.json"],
        packageJson: { packageManager: "pnpm@9.1.0" },
      }),
    ).toBe("pnpm");
    expect(
      detectPackageManager({
        rootEntries: ["package.json"],
        packageJson: { packageManager: "yarn@4.2.0" },
      }),
    ).toBe("yarn-berry");
  });

  it("defaults to npm without a lockfile and to null without package.json", () => {
    expect(detectPackageManager({ rootEntries: ["package.json"], packageJson: {} })).toBe("npm");
    expect(detectPackageManager({ rootEntries: ["README.md"], packageJson: null })).toBeNull();
  });
});

describe("defaultPipeline", () => {
  it("builds install + present scripts for pnpm", () => {
    const spec = defaultPipeline({
      rootEntries: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json"],
      packageJson: pkg({
        lint: "biome check .",
        typecheck: "tsc -b",
        test: "vitest run",
        build: "vite build",
      }),
    });
    expect(parsePipelineSpec(spec).ok).toBe(true);
    expect(spec.source).toBe("default");
    expect(spec.steps.map((s) => [s.name, s.command, s.parent])).toEqual([
      ["install", "pnpm install --frozen-lockfile", null],
      ["lint", "pnpm run lint", "install"],
      ["typecheck", "pnpm run typecheck", "install"],
      ["test", "pnpm run test", "install"],
      ["build", "pnpm run build", "install"],
    ]);
    expect(spec.steps[0]?.cache?.inputs).toEqual([
      "**/package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "patches/**",
      ".yarn/releases/**",
      ".yarn/plugins/**",
    ]);
    expect(spec.steps[0]?.cacheScope).toBe("global");
  });

  it("skips missing scripts and npm's placeholder test", () => {
    const spec = defaultPipeline({
      rootEntries: ["package.json", "package-lock.json"],
      packageJson: pkg({ test: 'echo "Error: no test specified" && exit 1', "type-check": "tsc" }),
    });
    expect(spec.steps.map((s) => [s.name, s.command])).toEqual([
      ["install", "npm ci --no-audit --no-fund"],
      ["typecheck", "npm run type-check"],
    ]);
    expect(spec.warnings).toContain("no test script in package.json");
  });

  it("does not cache installs without a lockfile", () => {
    const spec = defaultPipeline({
      rootEntries: ["package.json"],
      packageJson: pkg({ test: "node --test" }),
    });
    expect(spec.steps[0]).toMatchObject({
      name: "install",
      command: "npm install --no-audit --no-fund",
    });
    expect(spec.steps[0]?.cache).toBeUndefined();
  });

  it("is empty without package.json", () => {
    const spec = defaultPipeline({ rootEntries: ["main.go"], packageJson: null });
    expect(spec.steps).toEqual([]);
    expect(parsePipelineSpec(spec).ok).toBe(true);
  });

  it("covers every package manager's install command", () => {
    expect(installCommand("yarn", true)).toMatch(/--frozen-lockfile/);
    expect(installCommand("yarn-berry", true)).toMatch(/--immutable/);
    expect(installCommand("bun", true)).toMatch(/--frozen-lockfile/);
  });
});

describe("detectRepoFeatures", () => {
  it("detects TypeScript, public API, transforms and the pipeline file", () => {
    const f = detectRepoFeatures({
      rootEntries: ["package.json", "pnpm-lock.yaml", ".platform"],
      packageJson: pkg(
        { test: "vitest" },
        { exports: { ".": "./src/index.ts" }, devDependencies: { typescript: "6" } },
      ),
      platformEntries: ["ci.ts", "policy.ts", "transforms"],
    });
    expect(f).toMatchObject({
      packageManager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      hasTypeScript: true,
      hasPublicApi: true,
      hasTransforms: true,
      hasPipelineFile: true,
      scripts: { test: "test", lint: null },
    });
  });
});
