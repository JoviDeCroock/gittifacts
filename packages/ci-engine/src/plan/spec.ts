/**
 * `PipelineSpec`: the static DAG a pipeline file evaluates to in plan mode.
 *
 * Plain module (zod only): it is imported by the platform Worker, which validates every spec it
 * receives, and by the sandbox runner CLI, which validates before printing.
 */
import { z } from "zod";

export const PIPELINE_SPEC_VERSION = 1;
export const MAX_STEPS = 50;
export const MAX_COMMAND_LENGTH = 8_192;
export const MAX_ENV_ENTRIES = 32;
export const MAX_ENV_VALUE_LENGTH = 1_024;
export const MAX_CACHE_INPUTS = 32;
/** Serialized spec ceiling. Keeps Workflow params and step outputs far below the 1 MiB limit. */
export const MAX_SPEC_BYTES = 256 * 1024;
export const MAX_STEP_TIMEOUT_MINUTES = 30;
export const DEFAULT_STEP_TIMEOUT_MINUTES = 25;

/**
 * Workflow step names the engine uses for itself. Pipeline steps are named after user steps
 * verbatim (so `restartFrom(runId, name)` maps onto `instance.restart({ from: { name } })`), which
 * means user steps cannot take these names.
 */
export const RESERVED_STEP_NAMES: readonly string[] = ["prepare", "plan", "finalize"];

/** Letters, digits, `.`, `_`, `-`; starts with a letter or digit. No `:` (reserved for `evidence:*`). */
export const STEP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/** Env keys the platform sets itself or that would change how git authenticates. */
export const RESERVED_ENV_PREFIXES: readonly string[] = [
  "GITTIFACTS_",
  "GIT_CONFIG_",
  "ARTIFACTS_",
];

export const CacheScope = z.enum(["global", "repo"]);
export type CacheScope = z.infer<typeof CacheScope>;

export const InstanceType = z.enum([
  "lite",
  "standard-1",
  "standard-2",
  "standard-3",
  "standard-4",
]);
export type InstanceType = z.infer<typeof InstanceType>;
export const DEFAULT_INSTANCE: InstanceType = "standard-2";

export const StepName = z
  .string()
  .regex(STEP_NAME_PATTERN, "step names use letters, digits, '.', '_' or '-' (max 63)");

const noNul = (s: string) => !s.includes("\0");

/** A path relative to the repository root. No absolute paths, no `..`, no empty segments. */
export const RelativePath = z
  .string()
  .min(1)
  .max(256)
  .refine(noNul, "must not contain NUL")
  .refine((p) => !p.startsWith("/"), "must be relative to the repository root")
  .refine(
    (p) => p.split("/").every((seg) => seg !== ".." && seg !== ""),
    "must not contain '..' or empty segments",
  );

export const MAX_ARTIFACTS_PER_STEP = 8;

export const ArtifactName = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/,
    "artifact names use letters, digits, '.', '_' or '-' (max 63)",
  );

export const ArtifactSpec = z
  .object({
    name: ArtifactName,
    paths: z.array(RelativePath).min(1).max(32),
    /** A missing path skips the artifact (with a note) instead of failing the step. */
    optional: z.boolean().optional(),
  })
  .strict();
export type ArtifactSpec = z.infer<typeof ArtifactSpec>;

export const CacheGlob = z
  .string()
  .min(1)
  .max(256)
  .refine(noNul, "must not contain NUL")
  .refine((p) => !p.startsWith("/"), "globs are relative to the repository root")
  .refine((p) => !p.split("/").includes(".."), "globs must not contain '..'");

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Null when `key` is acceptable, otherwise why not. */
export function envKeyProblem(key: string): string | null {
  if (!ENV_KEY_PATTERN.test(key)) return `env key "${key}" must match [A-Za-z_][A-Za-z0-9_]*`;
  const reserved = RESERVED_ENV_PREFIXES.find((p) => key.toUpperCase().startsWith(p));
  return reserved === undefined ? null : `env key "${key}" is reserved (prefix ${reserved})`;
}

export const StepEnv = z
  .record(z.string(), z.string().max(MAX_ENV_VALUE_LENGTH).refine(noNul, "must not contain NUL"))
  .superRefine((env, ctx) => {
    const keys = Object.keys(env);
    if (keys.length > MAX_ENV_ENTRIES)
      ctx.addIssue({ code: "custom", message: `at most ${MAX_ENV_ENTRIES} env entries` });
    for (const key of keys) {
      const problem = envKeyProblem(key);
      if (problem !== null) ctx.addIssue({ code: "custom", message: problem, path: [key] });
    }
  });

export const Command = z
  .string()
  .min(1)
  .max(MAX_COMMAND_LENGTH)
  .refine(noNul, "must not contain NUL")
  .refine((c) => c.trim().length > 0, "must not be blank");

export const StepSpec = z
  .object({
    name: StepName,
    command: Command,
    /** Working directory relative to the checkout (`/workspace`). */
    cwd: RelativePath.optional(),
    env: StepEnv.optional(),
    /** Globs over git blob SHAs at the head commit. A hit skips the command and reuses the snapshot. */
    cache: z
      .object({ inputs: z.array(CacheGlob).min(1).max(MAX_CACHE_INPUTS) })
      .strict()
      .optional(),
    /** The step whose container snapshot this step starts from (`x.runner(...)`), or null for a fresh checkout. */
    parent: StepName.nullable(),
    /** Steps that must finish first (derived from await ordering in plan mode). Excludes `parent`. */
    after: z.array(StepName).max(MAX_STEPS),
    /**
     * Who may reuse this step's cached snapshot. `global`: any repository whose cache inputs are
     * byte-identical (e.g. every project from one template); the step then runs with only its
     * cache inputs in `/workspace`, so the snapshot holds nothing else from the repository.
     * `repo`: this repository only. Default: `global` for install-like root steps, else `repo`.
     * Only root steps (no parent) can be `global`. Ignored without `cache`.
     */
    cacheScope: CacheScope.optional(),
    /**
     * Build outputs to keep: after the command succeeds each is uploaded as
     * `tar -C /workspace -cz <paths>` (paths relative to the repository root). A missing path
     * fails the step unless the artifact is `optional`. Steps with artifacts are snapshotted too.
     */
    artifacts: z.array(ArtifactSpec).max(MAX_ARTIFACTS_PER_STEP).optional(),
    instance: InstanceType.optional(),
    timeoutMinutes: z.number().int().min(1).max(MAX_STEP_TIMEOUT_MINUTES).optional(),
  })
  .strict();
export type StepSpec = z.infer<typeof StepSpec>;

const INSTALL_LIKE = /\b(?:install|ci)\b/;

/** A root step with cache inputs whose command installs dependencies (`pnpm install`, `npm ci`, ...). */
export function isInstallLike(step: Pick<StepSpec, "command" | "parent" | "cache">): boolean {
  return step.parent === null && step.cache !== undefined && INSTALL_LIKE.test(step.command);
}

/** The scope a cached step's snapshot is shared in, or null when the step is not cached. */
export function effectiveCacheScope(
  step: Pick<StepSpec, "command" | "parent" | "cache" | "cacheScope">,
): CacheScope | null {
  if (step.cache === undefined) return null;
  if (step.parent !== null) return "repo";
  return step.cacheScope ?? (isInstallLike(step) ? "global" : "repo");
}

/** Steps a template seed run executes: the global-scope cached steps (always roots). */
export function seedPipeline(pipeline: PipelineSpec): PipelineSpec {
  const steps = pipeline.steps
    .filter((s) => effectiveCacheScope(s) === "global")
    .map((s) => ({ ...s, after: [] }));
  return { ...pipeline, steps };
}

const INSTANCE_ORDER: readonly InstanceType[] = [
  "lite",
  "standard-1",
  "standard-2",
  "standard-3",
  "standard-4",
];

/** `instance`, or `max` when `instance` is larger. */
export function clampInstance(instance: InstanceType, max: InstanceType): InstanceType {
  return INSTANCE_ORDER.indexOf(instance) > INSTANCE_ORDER.indexOf(max) ? max : instance;
}

export const PipelineSpec = z
  .object({
    version: z.literal(PIPELINE_SPEC_VERSION),
    /** `file`: evaluated from `.platform/ci.ts`; `default`: detected from the repository. */
    source: z.enum(["file", "default"]),
    steps: z.array(StepSpec).max(MAX_STEPS, `a pipeline has at most ${MAX_STEPS} steps`),
    warnings: z.array(z.string().max(500)).max(50).default([]),
  })
  .strict()
  .superRefine((spec, ctx) => {
    for (const issue of [...graphIssues(spec.steps), ...artifactIssues(spec.steps)]) {
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
    }
    const bytes = new TextEncoder().encode(JSON.stringify(spec)).byteLength;
    if (bytes > MAX_SPEC_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `pipeline spec is ${bytes} bytes; the limit is ${MAX_SPEC_BYTES}`,
      });
    }
  });
export type PipelineSpec = z.infer<typeof PipelineSpec>;
export type PipelineSpecInput = z.input<typeof PipelineSpec>;

export interface GraphIssue {
  message: string;
  path: (string | number)[];
}

/** The steps a step waits for: its parent (snapshot source) plus `after`. */
export function stepDependencies(step: {
  parent: string | null;
  after: readonly string[];
}): string[] {
  const deps = step.parent === null ? [] : [step.parent];
  for (const a of step.after) if (!deps.includes(a)) deps.push(a);
  return deps;
}

/** Structural checks zod can't express per field: unique names, known references, no cycles. */
export function graphIssues(
  steps: readonly { name: string; parent: string | null; after: readonly string[] }[],
): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const index = new Map<string, number>();
  steps.forEach((step, i) => {
    if (RESERVED_STEP_NAMES.includes(step.name)) {
      issues.push({ message: `step name "${step.name}" is reserved`, path: ["steps", i, "name"] });
    }
    if (index.has(step.name)) {
      issues.push({ message: `duplicate step name "${step.name}"`, path: ["steps", i, "name"] });
    } else {
      index.set(step.name, i);
    }
  });
  steps.forEach((step, i) => {
    if (step.parent !== null) {
      if (step.parent === step.name) {
        issues.push({
          message: `step "${step.name}" cannot be its own parent`,
          path: ["steps", i, "parent"],
        });
      } else if (!index.has(step.parent)) {
        issues.push({
          message: `step "${step.name}" starts from unknown step "${step.parent}"`,
          path: ["steps", i, "parent"],
        });
      }
    }
    const seen = new Set<string>();
    step.after.forEach((dep, j) => {
      if (dep === step.name) {
        issues.push({
          message: `step "${step.name}" cannot wait for itself`,
          path: ["steps", i, "after", j],
        });
      } else if (!index.has(dep)) {
        issues.push({
          message: `step "${step.name}" waits for unknown step "${dep}"`,
          path: ["steps", i, "after", j],
        });
      } else if (seen.has(dep)) {
        issues.push({
          message: `step "${step.name}" lists "${dep}" twice in after`,
          path: ["steps", i, "after", j],
        });
      }
      seen.add(dep);
    });
  });
  if (issues.length > 0) return issues;

  // Cycle detection (iterative DFS, white/grey/black).
  const state = new Map<string, 0 | 1 | 2>();
  const byName = new Map(steps.map((s) => [s.name, s] as const));
  for (const root of steps) {
    if (state.get(root.name) === 2) continue;
    const stack: { name: string; deps: string[]; next: number }[] = [
      { name: root.name, deps: stepDependencies(root), next: 0 },
    ];
    state.set(root.name, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (top.next >= top.deps.length) {
        state.set(top.name, 2);
        stack.pop();
        continue;
      }
      const dep = top.deps[top.next++]!;
      const s = state.get(dep) ?? 0;
      if (s === 1) {
        const cycle = [
          ...stack.slice(stack.findIndex((f) => f.name === dep)).map((f) => f.name),
          dep,
        ];
        issues.push({ message: `dependency cycle: ${cycle.join(" -> ")}`, path: ["steps"] });
        return issues;
      }
      if (s === 0) {
        state.set(dep, 1);
        const depStep = byName.get(dep)!;
        stack.push({ name: dep, deps: stepDependencies(depStep), next: 0 });
      }
    }
  }
  return issues;
}

/** Artifact names are unique across the pipeline (the run summary is keyed by name). */
export function artifactIssues(
  steps: readonly Pick<StepSpec, "name" | "artifacts">[],
): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const owner = new Map<string, string>();
  steps.forEach((step, i) => {
    (step.artifacts ?? []).forEach((a, j) => {
      const prev = owner.get(a.name);
      if (prev !== undefined) {
        issues.push({
          message: `artifact "${a.name}" of step "${step.name}" is also declared by step "${prev}"`,
          path: ["steps", i, "artifacts", j, "name"],
        });
      } else {
        owner.set(a.name, step.name);
      }
    });
  });
  return issues;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Formats zod issues as `path: message` lines. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 20)
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("\n");
}

/** Validates untrusted input (runner CLI output, Workflow params) as a `PipelineSpec`. */
export function parsePipelineSpec(input: unknown): ParseResult<PipelineSpec> {
  const parsed = PipelineSpec.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: formatIssues(parsed.error) };
}

export function emptyPipeline(source: PipelineSpec["source"] = "default"): PipelineSpec {
  return { version: PIPELINE_SPEC_VERSION, source, steps: [], warnings: [] };
}
