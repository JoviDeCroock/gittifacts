import { describe, expect, it } from "vitest";
import { commandsFor, detectProject, installCommand } from "../src/index.js";

const pkg = (extra: Record<string, unknown> = {}) => ({
  scripts: { lint: "eslint .", typecheck: "tsc --noEmit", test: "vitest run", build: "tsc -p tsconfig.build.json" },
  devDependencies: { typescript: "6.0.3", vitest: "4.1.11" },
  ...extra,
});

describe("detectProject", () => {
  it("is sure about a conventional pnpm + vitest + TS project", () => {
    const d = detectProject({ rootEntries: ["package.json", "pnpm-lock.yaml", "tsconfig.json", "src"], packageJson: pkg() });
    expect(d.features).toMatchObject({
      hasPackageJson: true,
      packageManager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      scripts: { lint: "lint", typecheck: "typecheck", test: "test", build: "build" },
      typescript: true,
      testRunner: "vitest",
      worker: false,
      cacheInputs: null,
    });
    expect(d.confidence).toBe("high");
    expect(d.uncertain).toEqual([expect.stringMatching(/^Step caching is off/)]);
  });

  it("prefers packageManager over lockfiles and notes the mismatch", () => {
    const d = detectProject({ rootEntries: ["package.json", "package-lock.json"], packageJson: pkg({ packageManager: "pnpm@11.0.0" }) });
    expect(d.features.packageManager).toBe("pnpm");
    expect(d.features.lockfile).toBeNull();
    expect(d.uncertain.some((u) => u.includes("packageManager says pnpm"))).toBe(true);
    expect(d.confidence).toBe("medium");
  });

  it("assumes npm without a lockfile and says so", () => {
    const d = detectProject({ rootEntries: ["package.json"], packageJson: pkg() });
    expect(d.features.packageManager).toBe("npm");
    expect(d.uncertain.some((u) => u.startsWith("No lockfile"))).toBe(true);
  });

  it("flags missing tests, typecheck and odd runners", () => {
    const none = detectProject({ rootEntries: ["package.json", "yarn.lock", "tsconfig.json"], packageJson: { scripts: { test: 'echo "Error: no test specified" && exit 1' } } });
    expect(none.features.testRunner).toBeNull();
    expect(none.uncertain.some((u) => u.startsWith("No test script"))).toBe(true);
    expect(none.uncertain.some((u) => u.startsWith("No typecheck script"))).toBe(true);
    const mocha = detectProject({ rootEntries: ["package.json", "bun.lock"], packageJson: { scripts: { test: "mocha" } } });
    expect(mocha.features.packageManager).toBe("bun");
    expect(mocha.features.testRunner).toBe("unknown");
    const jest = detectProject({ rootEntries: ["package.json"], packageJson: { scripts: { test: "jest --ci" } } });
    expect(jest.features.testRunner).toBe("jest");
  });

  it("detects Workers and notes a missing build", () => {
    const d = detectProject({ rootEntries: ["package.json", "pnpm-lock.yaml", "wrangler.jsonc"], packageJson: { scripts: { test: "vitest" } } });
    expect(d.features.worker).toBe(true);
    expect(d.uncertain.some((u) => u.includes("Worker without a build script"))).toBe(true);
  });

  it("is low-confidence without a usable package.json", () => {
    expect(detectProject({ rootEntries: ["README.md"], packageJson: null })).toMatchObject({ confidence: "low", features: { hasPackageJson: false } });
    expect(detectProject({ rootEntries: ["package.json"], packageJson: "not json" }).confidence).toBe("low");
  });
});

describe("commandsFor", () => {
  it("uses each package manager's syntax", () => {
    const d = detectProject({ rootEntries: ["package.json", "package-lock.json", "tsconfig.json"], packageJson: { scripts: { test: "vitest run" } } });
    expect(commandsFor(d.features)).toEqual({
      install: "npm ci --no-audit --no-fund",
      lint: null,
      typecheck: "npx tsc --noEmit",
      test: "npm run test",
      build: null,
      testFile: "npx vitest run",
      dev: null,
    });
    expect(installCommand("yarn", null)).toBe("yarn install");
    expect(installCommand("bun", "bun.lock")).toBe("bun install --frozen-lockfile");
  });
});
