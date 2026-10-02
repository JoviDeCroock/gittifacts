import { describe, expect, it } from "vitest";
import {
  defaultEvidenceSteps,
  EvidenceStepList,
  evidenceCommand,
  evidenceKindOf,
  evidenceOptionsFor,
  evidenceStepIssues,
} from "../../src/evidence-steps.js";
import { defaultPipeline, detectRepoFeatures } from "../../src/plan/defaults.js";

const facts = {
  rootEntries: ["package.json", "pnpm-lock.yaml", "tsconfig.json", ".platform"],
  packageJson: { scripts: { test: "vitest run", build: "tsc" }, exports: "./dist/index.js" },
  platformEntries: ["transforms"],
};

describe("defaultEvidenceSteps", () => {
  it("derives the full set for a TS repo with tests and transforms", () => {
    const pipeline = defaultPipeline(facts);
    const opts = evidenceOptionsFor(pipeline, detectRepoFeatures(facts));
    expect(opts).toMatchObject({
      installStep: "install",
      testCommand: "pnpm run test",
      packageManager: "pnpm",
    });
    const steps = defaultEvidenceSteps(opts);
    expect(EvidenceStepList.safeParse(steps).success).toBe(true);
    expect(evidenceStepIssues(pipeline, steps)).toEqual([]);
    expect(steps.map((s) => [s.name, s.parent, s.requiresGreen])).toEqual([
      ["evidence:dependencies", null, false],
      ["evidence:policy", null, false],
      ["evidence:red-green", "install", false],
      ["evidence:test-run", "install", false],
      ["evidence:coverage", "install", true],
      ["evidence:mutation", "install", true],
      ["evidence:public-api", "install", false],
      ["evidence:transforms", "install", false],
    ]);
    expect(steps.find((s) => s.name === "evidence:coverage")?.command).toBe(
      `gittifacts-runner evidence coverage --base "$GITTIFACTS_BASE_SHA" --head "$GITTIFACTS_HEAD_SHA" --package-manager pnpm --test-command 'pnpm run test'`,
    );
  });

  it("drops test-based steps without tests but keeps red-green to report no-tests", () => {
    const steps = defaultEvidenceSteps({
      installStep: null,
      testCommand: null,
      packageManager: null,
      hasTypeScript: false,
      hasTransforms: false,
    });
    expect(steps.map((s) => s.name)).toEqual([
      "evidence:dependencies",
      "evidence:policy",
      "evidence:red-green",
    ]);
  });

  it("can disable mutation testing", () => {
    const steps = defaultEvidenceSteps({
      installStep: "install",
      testCommand: "npm test",
      packageManager: "npm",
      hasTypeScript: false,
      hasTransforms: false,
      mutation: false,
    });
    expect(steps.map((s) => s.name)).not.toContain("evidence:mutation");
  });

  it("reports evidence steps whose parent is not in the pipeline", () => {
    const pipeline = defaultPipeline({ rootEntries: ["main.go"], packageJson: null });
    const steps = defaultEvidenceSteps({
      installStep: "install",
      testCommand: null,
      packageManager: null,
      hasTypeScript: false,
      hasTransforms: false,
    });
    expect(evidenceStepIssues(pipeline, steps)).toEqual([
      'evidence step "evidence:red-green" starts from unknown step "install"',
    ]);
  });

  it("rejects duplicates and maps names to kinds", () => {
    const s = defaultEvidenceSteps({
      installStep: null,
      testCommand: null,
      packageManager: null,
      hasTypeScript: false,
      hasTransforms: false,
    });
    expect(EvidenceStepList.safeParse([...s, s[0]]).success).toBe(false);
    expect(evidenceKindOf("evidence:public-api")).toBe("public-api");
    expect(evidenceCommand("policy")).toBe(
      'gittifacts-runner evidence policy --base "$GITTIFACTS_BASE_SHA" --head "$GITTIFACTS_HEAD_SHA"',
    );
  });
});
