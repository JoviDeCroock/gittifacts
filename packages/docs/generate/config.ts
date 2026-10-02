/**
 * `.platform/policy.ts` and `.platform/ci.ts` references: the RepoPolicy zod schema (types and
 * defaults via JSON Schema, words from the source's doc comments), the pipeline recorder's
 * RunnerOptions and the PipelineSpec limits, plus the files the platform generates for templates.
 */
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import {
  DEFAULT_INSTANCE,
  DEFAULT_STEP_TIMEOUT_MINUTES,
  InstanceType,
  MAX_ARTIFACTS_PER_STEP,
  MAX_CACHE_INPUTS,
  MAX_COMMAND_LENGTH,
  MAX_ENV_ENTRIES,
  MAX_ENV_VALUE_LENGTH,
  MAX_SPEC_BYTES,
  MAX_STEP_TIMEOUT_MINUTES,
  MAX_STEPS,
  RESERVED_ENV_PREFIXES,
  RESERVED_STEP_NAMES,
  STEP_NAME_PATTERN,
} from "@app/ci-engine/plan";
import { CI_PATH, POLICY_PATH, RepoPolicy, TRANSFORMS_DIR } from "@app/domain";
import { z } from "zod";
import { cell, code, fence, type GeneratedPage, header, join, table } from "./lib/md.js";
import { constraintsOf, type JsonSchema, typeOf } from "./lib/schema.js";
import { propertyDocs } from "./lib/tsdoc.js";

const REPO = pathJoin(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(pathJoin(REPO, p), "utf8");

interface Row {
  path: string;
  schema: JsonSchema;
}

function flatten(s: JsonSchema, prefix = ""): Row[] {
  const rows: Row[] = [];
  for (const [k, v] of Object.entries(s.properties ?? {})) {
    const path = prefix === "" ? k : `${prefix}.${k}`;
    rows.push({ path, schema: v });
    if (v.properties) rows.push(...flatten(v, path));
  }
  return rows;
}

/** Words for fields whose schema has no doc comment yet (a doc comment in policy.ts wins). */
const FALLBACK: Record<string, string> = {
  version: "Schema version.",
  shadow: "Shadow mode: when the UI offers to enable Lane 0.",
  sensitivePaths: "Globs. A Change touching any of them is Lane 2 (full human review).",
  thresholds: "What a Change must meet for Lane 0, and the size above which it is Lane 2.",
  "thresholds.lane0MaxFiles": "Max files changed for Lane 0.",
  "thresholds.lane1MaxFiles": "Above this many files a change is Lane 2 on size alone.",
  dependencies: "Dependency changes allowed in Lane 0.",
  planlessLane0: "Categories that may reach Lane 0 without an approved Plan.",
  rollout: "Gradual rollout of merged Changes to the repo's deploy target.",
  ai: "Model calls (reviewer agent, tours, judgments) per Change.",
  "ai.reviewerModel": '"auto" picks the platform default reviewer model.',
};

/** Doc comment for a dotted path, else for its suffixes (RolloutPolicy fields live in their own object). */
function docFor(docs: Map<string, string>, path: string): string {
  const parts = path.split(".");
  for (let i = 0; i < parts.length; i++) {
    const d = docs.get(parts.slice(i).join("."));
    if (d !== undefined && (i === 0 || parts.length - i === 1)) return d;
  }
  return FALLBACK[path] ?? "";
}

function policyPage(): GeneratedPage {
  const schema = z.toJSONSchema(RepoPolicy, { io: "input", unrepresentable: "any" }) as JsonSchema;
  const docs = propertyDocs(pathJoin(REPO, "packages/domain/src/policy.ts"));
  const rows = flatten(schema).map(({ path, schema: s }) => {
    const def = s.default === undefined || s.properties ? "" : code(JSON.stringify(s.default));
    const range = constraintsOf({ ...s, default: undefined });
    return [code(path), cell(`${typeOf(s)}${range ? ` (${range})` : ""}`), cell(def), cell(docFor(docs, path))];
  });
  const template = read("templates/workers-api/.platform/policy.ts");
  return {
    file: "reference/policy.md",
    content: join(
      header(
        { title: "Policy schema (.platform/policy.ts)", nav: "Policy schema", description: "Every RepoPolicy field with its type, default and meaning, and the policy file new projects start with.", order: 40 },
        ["packages/domain/src/policy.ts", "templates/workers-api/.platform/policy.ts"],
        `\`${POLICY_PATH}\` default-exports a plain object validated against \`RepoPolicy\`. The platform reads it from the **base** commit of every Change, never from the Change's head, so an edit applies to Changes that start after it merges. A Change that touches \`.platform/**\` is always Lane 2 and needs a human's approval.`,
      ),
      "## Fields",
      "Fields you leave out take their default. Nested objects are listed with dotted paths.",
      table(["Field", "Type", "Default", "Meaning"], rows),
      "## The file new projects get",
      fence("ts", template),
      "Guide: [Write a policy](/docs/guides/write-a-policy).",
    ),
  };
}

function ciPage(): GeneratedPage {
  const docs = propertyDocs(pathJoin(REPO, "packages/ci-engine/src/plan/recorder.ts"));
  const options: [string, string, string][] = [
    ["name", "string", `Step name: ${code(STEP_NAME_PATTERN.source)}. Not ${RESERVED_STEP_NAMES.map(code).join(", ")}, and no \`:\` (reserved for \`evidence:*\`).`],
    ["command", "string", `Shell command (\`sh -c\`), max ${MAX_COMMAND_LENGTH} characters.`],
    ["cwd", "string", docs.get("cwd") || "Working directory, relative to the repository root."],
    ["env", "Record<string, string>", `At most ${MAX_ENV_ENTRIES} entries, values up to ${MAX_ENV_VALUE_LENGTH} characters. Keys starting with ${RESERVED_ENV_PREFIXES.map(code).join(", ")} are reserved.`],
    ["cache", "{ inputs: string[] }", `Up to ${MAX_CACHE_INPUTS} globs. When none of the matching files changed, the step is skipped and its last result and snapshot are reused.`],
    ["cacheScope", '"global" | "repo"', docs.get("cacheScope") ?? ""],
    ["artifacts", "{ name, paths, optional? }[]", `${docs.get("artifacts") ?? ""} At most ${MAX_ARTIFACTS_PER_STEP} per step; names are unique across the pipeline. The build step's \`bundle\` is what a rollout deploys.`],
    ["instance", InstanceType.options.map((o) => JSON.stringify(o)).join(" | "), `${docs.get("instance") ?? ""} Default \`${DEFAULT_INSTANCE}\`.`],
    ["timeoutMinutes", "number", `1–${MAX_STEP_TIMEOUT_MINUTES}, default ${DEFAULT_STEP_TIMEOUT_MINUTES}.`],
    ["config", "{ timeout?, commandTimeoutMs?, retries?, snapshotRetentionSeconds? }", docs.get("config") ?? ""],
    ["secrets, cloudflareCredentials, sourceControlCredentials", "—", docs.get("secrets") ?? "Rejected."],
  ];
  const template = read("templates/workers-api/.platform/ci.ts");
  return {
    file: "reference/ci-dsl.md",
    content: join(
      header(
        { title: "CI DSL (.platform/ci.ts)", nav: "CI DSL", description: "The pipeline function, runner options, caching, artifacts, limits and the environment every step gets.", order: 41 },
        ["packages/ci-engine/src/plan/recorder.ts", "packages/ci-engine/src/plan/spec.ts", "packages/ci-engine/RUNNER_CONTRACT.md", "templates/workers-api/.platform/ci.ts"],
        `\`${CI_PATH}\` default-exports \`async (ci) => { ... }\`. The platform evaluates it in a sandbox in plan mode (no \`node_modules\`, git host only, 120 s) and records a static DAG of steps. \`ci.runner(opts)\` starts a step from a fresh checkout; \`step.runner(opts)\` starts one from that step's container snapshot (reusing its install). Steps you start without awaiting in between run in parallel. The platform adds its evidence steps after yours. Without the file, a default pipeline is detected from \`package.json\`.`,
      ),
      "## Runner options",
      table(["Option", "Type", "Meaning"], options.map(([k, t, m]) => [code(k), cell(code(t)), cell(m)])),
      "## Pipeline limits",
      table(
        ["Limit", "Value"],
        [
          ["Steps per pipeline", String(MAX_STEPS)],
          ["Serialized pipeline size", `${MAX_SPEC_BYTES / 1024} KiB`],
          ["Step timeout", `${DEFAULT_STEP_TIMEOUT_MINUTES} min default, ${MAX_STEP_TIMEOUT_MINUTES} min max`],
          ["Command length", `${MAX_COMMAND_LENGTH} characters`],
          ["Cache inputs per step", String(MAX_CACHE_INPUTS)],
          ["Artifacts per step", String(MAX_ARTIFACTS_PER_STEP)],
        ],
      ),
      "## Step environment",
      "Each step runs in its own container as user `runner` in `/workspace` (a shallow, blobless checkout at the head commit, no credentials). The whole environment is `HOME=/home/runner`, `CI=true`, `LANG=C.UTF-8`, `TERM=dumb`, the step's own `env`, then `GITTIFACTS=1`, `GITTIFACTS_RUN_ID`, `GITTIFACTS_STEP` and `GITTIFACTS_HEAD_SHA`. Evidence steps also get `GITTIFACTS_BASE_SHA`. In merge-queue batch runs, user steps get `GITTIFACTS_TEST_TARGETS` (the affected test targets); a test command that ignores it runs everything. Steps never get secrets or platform tokens.",
      "## The file new projects get",
      fence("ts", template),
      `Reproducible transforms live in \`${TRANSFORMS_DIR}\`. Guides: [Configure CI](/docs/guides/configure-ci), [Reproducible transforms](/docs/guides/transforms).`,
    ),
  };
}

export function generateConfig(): GeneratedPage[] {
  return [policyPage(), ciPage()];
}
