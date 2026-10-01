/**
 * What the reviewer model must return. These are NOT the domain `Tour` shape: the platform adds
 * ids, the transform stop and provenance, and post-processing turns a `ModelTour` into `Tour.stops`.
 */
import { TourVerdict } from "@app/domain";
import { z } from "zod";
import type { JsonSchema } from "./llm.js";

/** Stop kinds the model may use. "transform" is reserved for the platform's deterministic stop. */
export const MODEL_STOP_KINDS = ["intent", "behavior", "risk", "proof", "uncovered", "other"] as const;

const text = (max: number) => z.string().trim().min(1).max(max);

export const ModelHunkRef = z.object({
  file: text(500),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  side: z.enum(["head", "base"]),
});
export type ModelHunkRef = z.infer<typeof ModelHunkRef>;

export const ModelTourStop = z.object({
  kind: z.enum(MODEL_STOP_KINDS),
  title: text(160),
  why: text(1200),
  hunkRefs: z.array(ModelHunkRef).max(20),
  evidenceRefs: z.array(text(200)).max(20),
  verdict: TourVerdict,
});
export type ModelTourStop = z.infer<typeof ModelTourStop>;

export const ModelTour = z.object({
  stops: z.array(ModelTourStop).min(1).max(15),
  leastConfident: z.array(text(600)).min(1).max(10),
  notDone: z.array(text(600)).min(1).max(10),
});
export type ModelTour = z.infer<typeof ModelTour>;

export const JUDGE_QUESTIONS = ["scope-drift", "plan-conformance", "hidden-behavior-change"] as const;
export type JudgeQuestion = (typeof JUDGE_QUESTIONS)[number];

export const JudgeOutcome = z.enum(["no-concern", "concern", "unsure"]);
export type JudgeOutcome = z.infer<typeof JudgeOutcome>;

export const ModelJudgment = z.object({
  question: z.enum(JUDGE_QUESTIONS),
  outcome: JudgeOutcome,
  rationale: text(2000),
});

export const ModelJudgeOutput = z.object({
  judgments: z.array(ModelJudgment).min(1).max(6),
});
export type ModelJudgeOutput = z.infer<typeof ModelJudgeOutput>;

/** Keywords structured-output implementations reject; zod still enforces them client-side. */
const UNSUPPORTED_KEYWORDS = new Set([
  "$schema",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "maxItems",
]);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    // minItems is only reliably supported as 0 or 1.
    if (key === "minItems" && typeof value === "number" && value > 1) continue;
    out[key] = strip(value);
  }
  return out;
}

/** JSON Schema for `output_config.format` / `response_format`, derived from the zod schema. */
export function toModelJsonSchema(schema: z.ZodType): JsonSchema {
  return strip(z.toJSONSchema(schema)) as JsonSchema;
}

export const TOUR_JSON_SCHEMA: JsonSchema = toModelJsonSchema(ModelTour);
export const JUDGE_JSON_SCHEMA: JsonSchema = toModelJsonSchema(ModelJudgeOutput);

/** Compact, model-readable list of validation problems (for the one regeneration). */
export function formatIssues(error: z.ZodError, max = 20): string {
  const lines = error.issues.slice(0, max).map((issue) => {
    const path = issue.path.length === 0 ? "(root)" : issue.path.map(String).join(".");
    return `- ${path}: ${issue.message}`;
  });
  if (error.issues.length > max) lines.push(`- … and ${error.issues.length - max} more`);
  return lines.join("\n");
}
