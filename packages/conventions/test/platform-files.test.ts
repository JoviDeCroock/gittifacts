import { RepoPolicy } from "@app/domain";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { defaultCiTs, defaultPolicyTs, detectProject, TEMPLATE_IDS, TEMPLATES } from "../src/index.js";

/** Transpiles a generated `.platform/*.ts` file and imports it (as the sandbox would). */
async function load(text: string): Promise<unknown> {
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)) as { default: unknown };
  return mod.default;
}

function typeErrors(text: string): string[] {
  const host = ts.createCompilerHost({ strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts"] });
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang) => (name === "ci.ts" ? ts.createSourceFile(name, text, lang) : original(name, lang));
  const program = ts.createProgram(["ci.ts"], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts"], types: [] }, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

interface Recorded {
  name: string;
  command: string;
  parent: string | null;
  inputs: string[] | null;
}

/** A minimal stand-in for the ci-engine's plan-mode recorder. */
async function record(pipeline: unknown): Promise<Recorded[]> {
  const steps: Recorded[] = [];
  type Spec = { name: string; command: string; cache?: { inputs: string[] } };
  const runner = (parent: string | null) => (spec: Spec) => {
    steps.push({ name: spec.name, command: spec.command, parent, inputs: spec.cache?.inputs ?? null });
    const p = Promise.resolve({ exitCode: 0 });
    return Object.assign(p, { runner: runner(spec.name) });
  };
  await (pipeline as (ci: unknown) => Promise<void>)({ runner: runner(null) });
  return steps;
}

describe("defaultCiTs", () => {
  it.each([...TEMPLATE_IDS])("%s: typechecks standalone and records install → 4 parallel checks", async (id) => {
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
    }
  });

  it("carries detection uncertainty and skips caching for imports", async () => {
    const detection = detectProject({ rootEntries: ["package.json", "package-lock.json", "tsconfig.json"], packageJson: { scripts: { test: "jest" } } });
    const file = defaultCiTs(detection.features, detection);
    expect(file.uncertain).toEqual(detection.uncertain);
    expect(file.uncertain.some((u) => u.includes("typecheck"))).toBe(true);
    const steps = await record(await load(file.text));
    expect(steps.map((s) => [s.name, s.command, s.inputs])).toEqual([
      ["install", "npm ci --no-audit --no-fund", ["**/package.json", "package-lock.json", ".npmrc"]],
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
    const file = defaultPolicyTs({ previewRoutes: ["/", "/about/"], extraSensitivePaths: ["src/secrets/**"] });
    expect(file.path).toBe(".platform/policy.ts");
    const policy = RepoPolicy.parse(await load(file.text));
    expect(policy.lane0Enabled).toBe(false);
    expect(policy.previewRoutes).toEqual(["/", "/about/"]);
    expect(policy.sensitivePaths).toEqual([...RepoPolicy.parse({}).sensitivePaths, "src/secrets/**"]);
    expect(policy).toEqual(RepoPolicy.parse({ previewRoutes: ["/", "/about/"], sensitivePaths: policy.sensitivePaths }));
    expect(file.text).toContain("// Shadow mode");
    for (const line of file.text.split("\n")) expect(line.length).toBeLessThanOrEqual(110);
  });

  it("flags unknown preview routes for imported Workers", () => {
    expect(defaultPolicyTs({ worker: true })).toMatchObject({ confidence: "medium", uncertain: [expect.stringMatching(/previewRoutes is empty/)] });
    expect(defaultPolicyTs({ worker: true, previewRoutes: ["/"] }).uncertain).toEqual([]);
  });
});
