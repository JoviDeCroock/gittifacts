/**
 * Platform-mandated evidence steps. They are appended to every pipeline and run after the user's
 * steps, inside the same kind of sandbox, through the `gittifacts-runner evidence <kind>` CLI
 * (see RUNNER_CONTRACT.md). Their output is a JSON `EvidenceItem` (or an array of them).
 */
import { z } from "zod";
import { DEFAULT_INSTALL_STEP, type PackageManager, type RepoFeatures } from "./plan/defaults.js";
import {
  Command,
  InstanceType,
  MAX_STEP_TIMEOUT_MINUTES,
  type PipelineSpec,
  StepName,
} from "./plan/spec.js";
import { shellQuote } from "./runner/shell.js";

export const EVIDENCE_KINDS = [
  "red-green",
  "coverage",
  "mutation",
  "public-api",
  "dependencies",
  "transforms",
  "policy",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EvidenceStepName = z.enum([
  "evidence:red-green",
  "evidence:coverage",
  "evidence:mutation",
  "evidence:public-api",
  "evidence:dependencies",
  "evidence:transforms",
  "evidence:policy",
]);
export type EvidenceStepName = z.infer<typeof EvidenceStepName>;

export const EvidenceStepSpec = z
  .object({
    name: EvidenceStepName,
    command: Command,
    /** User step whose snapshot this starts from (usually `install`), or null for a fresh checkout. */
    parent: StepName.nullable(),
    /** Skip unless every user step passed. Otherwise it runs whenever its parent passed. */
    requiresGreen: z.boolean(),
    instance: InstanceType.optional(),
    timeoutMinutes: z.number().int().min(1).max(MAX_STEP_TIMEOUT_MINUTES).optional(),
  })
  .strict();
export type EvidenceStepSpec = z.infer<typeof EvidenceStepSpec>;

export const EvidenceStepList = z
  .array(EvidenceStepSpec)
  .max(EVIDENCE_KINDS.length)
  .superRefine((steps, ctx) => {
    const seen = new Set<string>();
    steps.forEach((s, i) => {
      if (seen.has(s.name))
        ctx.addIssue({ code: "custom", message: `duplicate evidence step "${s.name}"`, path: [i] });
      seen.add(s.name);
    });
  });

export function evidenceKindOf(name: EvidenceStepName): EvidenceKind {
  return name.slice("evidence:".length) as EvidenceKind;
}

export function isEvidenceStepName(name: string): name is EvidenceStepName {
  return EvidenceStepName.safeParse(name).success;
}

/** The runner CLI invocation. `$GITTIFACTS_BASE_SHA`/`$GITTIFACTS_HEAD_SHA` are set by the Runner. */
export function evidenceCommand(
  kind: EvidenceKind,
  opts: { testCommand?: string | null; packageManager?: PackageManager | null } = {},
): string {
  const parts = [
    "gittifacts-runner",
    "evidence",
    kind,
    "--base",
    '"$GITTIFACTS_BASE_SHA"',
    "--head",
    '"$GITTIFACTS_HEAD_SHA"',
  ];
  if (opts.packageManager) parts.push("--package-manager", opts.packageManager);
  if (opts.testCommand) parts.push("--test-command", shellQuote(opts.testCommand));
  return parts.join(" ");
}

export interface EvidenceOptions {
  /** User step evidence steps that need dependencies start from. Null: fresh checkout. */
  installStep: string | null;
  /** How to run the test suite; null when the repo has no tests. */
  testCommand: string | null;
  packageManager: PackageManager | null;
  hasTypeScript: boolean;
  hasPublicApi?: boolean;
  hasTransforms: boolean;
  /** Mutation testing is the most expensive signal. Default: on when there are tests. */
  mutation?: boolean;
}

/**
 * Which evidence steps a repository gets. Steps whose measurement is meaningless without green
 * tests (`coverage`, `mutation`) require green; the rest run whenever their parent step passed,
 * because "the build is red" must not hide, e.g., a breaking API change or a new install script.
 * A repository without tests still gets `red-green` so the evidence says "no tests" explicitly.
 */
export function defaultEvidenceSteps(opts: EvidenceOptions): EvidenceStepSpec[] {
  const { installStep, testCommand, packageManager } = opts;
  const common = { packageManager };
  const steps: EvidenceStepSpec[] = [
    {
      name: "evidence:dependencies",
      command: evidenceCommand("dependencies", common),
      parent: null,
      requiresGreen: false,
      instance: "standard-1",
      timeoutMinutes: 10,
    },
    {
      name: "evidence:policy",
      command: evidenceCommand("policy", common),
      parent: null,
      requiresGreen: false,
      instance: "standard-1",
      timeoutMinutes: 10,
    },
    {
      name: "evidence:red-green",
      command: evidenceCommand("red-green", { ...common, testCommand }),
      parent: installStep,
      requiresGreen: false,
    },
  ];
  if (testCommand !== null) {
    steps.push({
      name: "evidence:coverage",
      command: evidenceCommand("coverage", { ...common, testCommand }),
      parent: installStep,
      requiresGreen: true,
    });
    if (opts.mutation !== false) {
      steps.push({
        name: "evidence:mutation",
        command: evidenceCommand("mutation", { ...common, testCommand }),
        parent: installStep,
        requiresGreen: true,
        instance: "standard-4",
        timeoutMinutes: MAX_STEP_TIMEOUT_MINUTES,
      });
    }
  }
  if (opts.hasTypeScript || opts.hasPublicApi === true) {
    steps.push({
      name: "evidence:public-api",
      command: evidenceCommand("public-api", common),
      parent: installStep,
      requiresGreen: false,
    });
  }
  if (opts.hasTransforms) {
    steps.push({
      name: "evidence:transforms",
      command: evidenceCommand("transforms", common),
      parent: installStep,
      requiresGreen: false,
    });
  }
  return steps;
}

/**
 * Evidence options for a resolved pipeline: the install step is the default `install` step when
 * present, else the first root step whose command installs dependencies; the test command is the
 * `test` step's command.
 */
export function evidenceOptionsFor(
  pipeline: PipelineSpec,
  features: RepoFeatures,
): EvidenceOptions {
  const install =
    pipeline.steps.find((s) => s.name === DEFAULT_INSTALL_STEP && s.parent === null) ??
    pipeline.steps.find((s) => s.parent === null && /\b(install|ci)\b/.test(s.command));
  const test = pipeline.steps.find((s) => s.name === "test");
  return {
    installStep: install?.name ?? null,
    testCommand: test?.command ?? null,
    packageManager: features.packageManager,
    hasTypeScript: features.hasTypeScript,
    hasPublicApi: features.hasPublicApi,
    hasTransforms: features.hasTransforms,
  };
}

/** Problems with evidence steps relative to a pipeline (unknown parents). */
export function evidenceStepIssues(
  pipeline: PipelineSpec,
  steps: readonly EvidenceStepSpec[],
): string[] {
  const names = new Set(pipeline.steps.map((s) => s.name));
  return steps
    .filter((s) => s.parent !== null && !names.has(s.parent))
    .map((s) => `evidence step "${s.name}" starts from unknown step "${s.parent}"`);
}
