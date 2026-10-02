/**
 * What the reviewer model must return. These are NOT the domain `Tour` shape: the platform adds
 * ids, the transform stop and provenance, and post-processing turns a `ModelTour` into `Tour.stops`.
 */
import { TourVerdict } from "@app/domain";
import { z } from "zod";
import type { JsonSchema } from "./llm.js";

/** Stop kinds the model may use. "transform" is reserved for the platform's deterministic stop. */
export const MODEL_STOP_KINDS = [
  "intent",
  "behavior",
  "risk",
  "proof",
  "uncovered",
  "other",
] as const;

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

export const JUDGE_QUESTIONS = [
  "scope-drift",
  "plan-conformance",
  "hidden-behavior-change",
] as const;
export type JudgeQuestion = (typeof JUDGE_QUESTIONS)[number];

export const JudgeOutcome = z.enum(["no-concern", "concern", "unsure"]);
export type JudgeOutcome = z.infer<typeof JudgeOutcome>;

/**
 * How a cited hunk relates to the plan:
 * - "contradicts": it does something differently from what a plan sentence says;
 * - "goes-beyond": it does more than a plan sentence asks;
 * - "not-in-plan": nothing in the plan mentions the behavior (the only option without a plan).
 */
export const PLAN_BASES = ["contradicts", "goes-beyond", "not-in-plan"] as const;
export const PlanBasis = z.enum(PLAN_BASES);
export type PlanBasis = z.infer<typeof PlanBasis>;

/**
 * The evidence every "concern" must carry: a hunk of the diff the model was shown, and the plan
 * sentence it contradicts or goes beyond (or the statement that the plan does not mention it).
 * A concern without one valid citation is downgraded to "unsure" (see judge-citations.ts).
 */
export const ModelCitation = z.object({
  /** Exactly as in the diff's `=== path ===` header. */
  file: text(500),
  /** N of `@@ hunk N` in that file (1-based). */
  hunk: z.number().int().positive(),
  /** What the hunk does that the plan does not ask for, in one sentence. */
  behavior: text(600),
  planBasis: PlanBasis,
  /** Copied word for word from the plan; null only for "not-in-plan". */
  planQuote: z.string().trim().max(1000).nullable(),
});
export type ModelCitation = z.infer<typeof ModelCitation>;

/** Every field is required (strict structured output); "no-concern"/"unsure" send `citations: []`. */
export const ModelJudgment = z.object({
  question: z.enum(JUDGE_QUESTIONS),
  outcome: JudgeOutcome,
  rationale: text(2000),
  citations: z.array(ModelCitation).max(10),
});
export type ModelJudgment = z.infer<typeof ModelJudgment>;

export const ModelJudgeOutput = z.object({
  judgments: z.array(ModelJudgment).min(1).max(6),
});
export type ModelJudgeOutput = z.infer<typeof ModelJudgeOutput>;

/**
 * What the judge reads back: the same fields, but lenient, so one malformed citation (or a model
 * that ignores the schema) never discards the outcome itself. Citations are checked one by one.
 */
export const LenientModelJudgment = z.object({
  question: z.enum(JUDGE_QUESTIONS),
  outcome: JudgeOutcome,
  rationale: text(2000),
  /** Unreadable citations count as none: a concern then becomes "unsure", nothing else changes. */
  citations: z.array(z.unknown()).max(50).optional().catch(undefined),
});

/** One citation, read leniently: a hunk given as "2" or "hunk 2" is accepted, `behavior` may be missing. */
export const LenientModelCitation = z.object({
  file: text(500),
  hunk: z.union([
    z.number().int().positive(),
    z
      .string()
      .regex(/^\s*(?:@@\s*)?(?:hunk\s*)?#?\d+\b/i)
      .transform((s) => Number(/\d+/.exec(s)![0])),
  ]),
  behavior: z.string().trim().max(600).optional().catch(undefined),
  planBasis: PlanBasis,
  planQuote: z.string().trim().max(1000).nullable().optional().catch(null),
});
export type LenientModelCitation = z.infer<typeof LenientModelCitation>;

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
