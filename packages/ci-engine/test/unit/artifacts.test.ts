import { describe, expect, it } from "vitest";
import { CloudflareCiEngine } from "../../src/cloudflare/engine.js";
import { defaultBundleArtifact, defaultPipeline } from "../../src/plan/defaults.js";
import { recordPipeline } from "../../src/plan/recorder.js";
import { parsePipelineSpec } from "../../src/plan/spec.js";
import { FakeWorkflow } from "./fake-workflow.js";
import { MemoryStore, SHA_A, SHA_B } from "./helpers.js";

describe("artifact declarations", () => {
  it("are recorded in plan mode", async () => {
    const spec = await recordPipeline(async (ci) => {
      const install = ci.runner({ name: "install", command: "pnpm i" });
      await install.runner({
        name: "build",
        command: "pnpm build",
        artifacts: [{ name: "bundle", paths: ["dist"] }],
      });
    });
    expect(spec.steps[1]?.artifacts).toEqual([{ name: "bundle", paths: ["dist"] }]);
  });

  it("must have unique names across the pipeline and relative paths", () => {
    const step = (name: string, artifacts: unknown) => ({
      name,
      command: "x",
      parent: null,
      after: [],
      artifacts,
    });
    const dup = parsePipelineSpec({
      version: 1,
      source: "file",
      steps: [
        step("a", [{ name: "bundle", paths: ["dist"] }]),
        step("b", [{ name: "bundle", paths: ["out"] }]),
      ],
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok)
      expect(dup.error).toMatch(/artifact "bundle" of step "b" is also declared by step "a"/);
    const abs = parsePipelineSpec({
      version: 1,
      source: "file",
      steps: [step("a", [{ name: "x", paths: ["/etc"] }])],
    });
    expect(abs.ok).toBe(false);
    const empty = parsePipelineSpec({
      version: 1,
      source: "file",
      steps: [step("a", [{ name: "x", paths: [] }])],
    });
    expect(empty.ok).toBe(false);
  });

  it("default to the template's buildOutput, else an optional dist", () => {
    expect(defaultBundleArtifact({ buildOutput: "out" })).toEqual({
      name: "bundle",
      paths: ["out"],
    });
    expect(defaultBundleArtifact({ buildOutput: ["dist", "public"] })).toEqual({
      name: "bundle",
      paths: ["dist", "public"],
    });
    expect(defaultBundleArtifact(null)).toEqual({
      name: "bundle",
      paths: ["dist"],
      optional: true,
    });
    expect(defaultBundleArtifact({ buildOutput: "../escape" })).toEqual({
      name: "bundle",
      paths: ["dist"],
      optional: true,
    });
    const spec = defaultPipeline({
      rootEntries: ["package.json", "pnpm-lock.yaml", "template.json"],
      packageJson: { scripts: { build: "vite build", test: "vitest" } },
      templateJson: { buildOutput: "out" },
    });
    expect(spec.steps.find((s) => s.name === "build")?.artifacts).toEqual([
      { name: "bundle", paths: ["out"] },
    ]);
    expect(spec.steps.find((s) => s.name === "test")?.artifacts).toBeUndefined();
  });

  it("are refused by the cloudflare-ci engine (fails closed)", async () => {
    const engine = new CloudflareCiEngine({
      workflow: new FakeWorkflow(),
      bucket: new MemoryStore(),
      namespace: "ns",
    });
    await expect(
      engine.start({
        runId: "cf-art",
        changeId: "c",
        repo: { remote: "https://x/r.git", tokenProvider: "artifacts" },
        artifactsRepo: "fork",
        headSha: SHA_A,
        baseSha: SHA_B,
        pipeline: {
          version: 1,
          source: "file",
          steps: [
            {
              name: "build",
              command: "x",
              parent: null,
              after: [],
              artifacts: [{ name: "b", paths: ["dist"] }],
            },
          ],
          warnings: [],
        },
        evidenceSteps: [],
        limits: { maxMinutes: 5 },
      }),
    ).rejects.toThrow(/cannot upload build artifacts/);
  });
});
