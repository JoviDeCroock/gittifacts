import { RepoPolicy } from "@app/domain";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  type PipelineFunction,
  PipelineSpec,
  recordPipeline,
} from "../../ci-engine/src/plan/index.js";
import {
  defaultCiTs,
  defaultPolicyTs,
  defaultPolicyValue,
  detectProject,
  PLACEHOLDER_SELF,
  TEMPLATE_IDS,
  TEMPLATES,
  templateGeneratedFiles,
} from "../src/index.js";

const PLACEHOLDER_SELF_CLAIMED = { ...PLACEHOLDER_SELF, claimed: true };

/** Transpiles a generated `.platform/*.ts` file and imports it (as the sandbox would). */
async function load(text: string): Promise<unknown> {
  const js = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
  )) as { default: unknown };
  return mod.default;
}

function typeErrors(text: string): string[] {
  const host = ts.createCompilerHost({
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
  });
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang) =>
    name === "ci.ts" ? ts.createSourceFile(name, text, lang) : original(name, lang);
  const program = ts.createProgram(
    ["ci.ts"],
    {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      lib: ["lib.es2022.d.ts"],
      types: [],
    },
    host,
  );
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

interface Recorded {
  name: string;
  command: string;
  parent: string | null;
  inputs: string[] | null;
  after: string[];
}

/**
 * The ci-engine's plan-mode recorder (the code that evaluates `.platform/ci.ts` in the sandbox),
 * mapped to a compact shape. Like `@cloudflare/ci`, `runner()` exists on the awaited result only.
 */
async function record(pipeline: unknown): Promise<Recorded[]> {
  const spec = await recordPipeline(pipeline as PipelineFunction);
  expect(PipelineSpec.safeParse(spec).success).toBe(true);
  return spec.steps.map((s) => ({
    name: s.name,
    command: s.command,
    parent: s.parent,
    inputs: s.cache?.inputs ?? null,
    after: s.after,
  }));
}

describe("defaultCiTs", () => {
  it.each([...TEMPLATE_IDS])(
    "%s: typechecks standalone and records install → 4 parallel checks",
    async (id) => {
      const file = defaultCiTs(TEMPLATES[id].features);
      expect(file.path).toBe(".platform/ci.ts");
      expect(file).toMatchObject({ confidence: "high", uncertain: [] });
      expect(file.text).not.toMatch(/^import /m);
      expect(typeErrors(file.text)).toEqual([]);
      const steps = await record(await load(file.text));
      expect(steps.map((s) => [s.name, s.parent])).toEqual([
        ["install", null],
        ["lint", "install"],
        ["typecheck", "install"],
        ["test", "install"],
        ["build", "install"],
      ]);
      expect(steps[0]?.command).toBe("pnpm install --frozen-lockfile");
      expect(steps[0]?.inputs).toContain("pnpm-lock.yaml");
      for (const s of steps.slice(1)) {
        expect(s.command).toBe(`pnpm run ${s.name}`);
        expect(s.inputs).toEqual(TEMPLATES[id].features.cacheInputs);
        // Parallel: each check waits only for its parent (install), not for its siblings.
        expect(s.after).toEqual([]);
      }
    },
  );

  it("declares the build step's bundle artifact (what rollouts deploy) only when asked", async () => {
    const file = defaultCiTs(TEMPLATES["workers-api"].features, undefined, { bundle: "dist" });
    expect(typeErrors(file.text)).toEqual([]);
    const spec = await recordPipeline((await load(file.text)) as PipelineFunction);
    expect(spec.steps.find((s) => s.name === "build")?.artifacts).toEqual([
      { name: "bundle", paths: ["dist"] },
    ]);
    expect(spec.steps.filter((s) => (s.artifacts?.length ?? 0) > 0).map((s) => s.name)).toEqual([
      "build",
    ]);
    const plain = await recordPipeline(
      (await load(defaultCiTs(TEMPLATES["workers-api"].features).text)) as PipelineFunction,
    );
    expect(plain.steps.some((s) => (s.artifacts?.length ?? 0) > 0)).toBe(false);
  });

  it("only deployable templates get the bundle artifact", () => {
    expect(TEMPLATE_IDS.filter((id) => TEMPLATES[id].deployable)).toEqual(["workers-api"]);
    expect(
      templateGeneratedFiles("workers-api", PLACEHOLDER_SELF_CLAIMED)[".platform/ci.ts"],
    ).toContain('artifacts: [{ name: "bundle", paths: ["dist"] }]');
    expect(
      templateGeneratedFiles("preact-app", PLACEHOLDER_SELF_CLAIMED)[".platform/ci.ts"],
    ).not.toContain("artifacts: [");
  });

  it("carries detection uncertainty and skips caching for imports", async () => {
    const detection = detectProject({
      rootEntries: ["package.json", "package-lock.json", "tsconfig.json"],
      packageJson: { scripts: { test: "jest" } },
    });
    const file = defaultCiTs(detection.features, detection);
    expect(file.uncertain).toEqual(detection.uncertain);
    expect(file.uncertain.some((u) => u.includes("typecheck"))).toBe(true);
    const steps = await record(await load(file.text));
    expect(steps.map((s) => [s.name, s.command, s.inputs])).toEqual([
      [
        "install",
        "npm ci --no-audit --no-fund",
        ["**/package.json", "package-lock.json", ".npmrc"],
      ],
      ["typecheck", "npx tsc --noEmit", null],
      ["test", "npm run test", null],
    ]);
  });

  it("writes an empty pipeline when there is no package.json", async () => {
    const detection = detectProject({ rootEntries: ["main.go"], packageJson: null });
    const file = defaultCiTs(detection.features, detection);
    expect(file.confidence).toBe("low");
    expect(typeErrors(file.text)).toEqual([]);
    expect(await record(await load(file.text))).toEqual([]);
  });
});

describe("defaultPolicyTs", () => {
  it("evaluates to a valid RepoPolicy in shadow mode with the given routes", async () => {
    const file = defaultPolicyTs({
      previewRoutes: ["/", "/about/"],
      extraSensitivePaths: ["src/secrets/**"],
    });
    expect(file.path).toBe(".platform/policy.ts");
    const policy = RepoPolicy.parse(await load(file.text));
    expect(policy.lane0Enabled).toBe(false);
    expect(policy.previewRoutes).toEqual(["/", "/about/"]);
    expect(policy.sensitivePaths).toEqual([
      ...RepoPolicy.parse({}).sensitivePaths,
      "src/secrets/**",
    ]);
    expect(policy).toEqual(
      RepoPolicy.parse({ previewRoutes: ["/", "/about/"], sensitivePaths: policy.sensitivePaths }),
    );
    expect(file.text).toContain("// Shadow mode");
    for (const line of file.text.split("\n")) expect(line.length).toBeLessThanOrEqual(110);
  });

  it("leaves lane0Enabled out: the owner's toggle owns it, and `false` in the file would force Lane 0 off", async () => {
    const opts = [{}, { previewRoutes: ["/"] }, { worker: true }];
    for (const o of opts) {
      const raw = (await load(defaultPolicyTs(o).text)) as Record<string, unknown>;
      expect(raw).not.toHaveProperty("lane0Enabled");
      expect(defaultPolicyTs(o).text).not.toMatch(/^\s*lane0Enabled\s*:/m);
    }
    for (const id of TEMPLATE_IDS) {
      const files = templateGeneratedFiles(id, PLACEHOLDER_SELF_CLAIMED);
      expect(files[".platform/policy.ts"] ?? "").not.toMatch(/^\s*lane0Enabled\s*:/m);
    }
  });

  it("defaultPolicyValue is exactly what the generated file exports (cached at create time)", async () => {
    for (const id of TEMPLATE_IDS) {
      const opts = { previewRoutes: TEMPLATES[id].previewRoutes };
      expect(RepoPolicy.parse(await load(defaultPolicyTs(opts).text))).toEqual(
        defaultPolicyValue(opts),
      );
    }
    expect(RepoPolicy.parse(await load(defaultPolicyTs().text))).toEqual(defaultPolicyValue());
  });

  it("flags unknown preview routes for imported Workers", () => {
    expect(defaultPolicyTs({ worker: true })).toMatchObject({
      confidence: "medium",
      uncertain: [expect.stringMatching(/previewRoutes is empty/)],
    });
    expect(defaultPolicyTs({ worker: true, previewRoutes: ["/"] }).uncertain).toEqual([]);
  });
});
