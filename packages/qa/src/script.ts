/**
 * The step DSL the model writes and the runner executes, and the model's three outputs (plan,
 * repair, review), each validated with zod. Invalid model output never becomes a pass: a criterion
 * without a valid script is "couldn't test".
 */
import { QaAction, QaVerdict } from "@app/evidence";
import { type JsonSchema, toModelJsonSchema } from "@app/tour";
import { z } from "zod";

export const Step = z.object({
  action: QaAction,
  /** CSS selector or `text=<visible text>`; for goto the path; for expect_url a path fragment. */
  target: z.string().max(300).optional(),
  /** fill/select value, press key, expected text, wait milliseconds. */
  value: z.string().max(300).optional(),
});
export type Step = z.infer<typeof Step>;

export const CriterionScript = z.object({
  index: z.number().int().min(0),
  /** Path to open first. */
  start: z.string().max(300),
  steps: z.array(Step).max(20),
  /** Set when this criterion can't be checked in a browser (needs login, external data, …). */
  untestable: z.string().max(500).optional(),
});
export type CriterionScript = z.infer<typeof CriterionScript>;

export const ModelPlan = z.object({ criteria: z.array(CriterionScript).max(50) });
export type ModelPlan = z.infer<typeof ModelPlan>;

export const ModelRepair = z.object({
  steps: z.array(Step).max(20),
  giveUp: z.string().max(500).optional(),
});
export type ModelRepair = z.infer<typeof ModelRepair>;

export const ModelReview = z.object({
  verdicts: z
    .array(
      z.object({
        index: z.number().int().min(0),
        verdict: QaVerdict,
        reason: z.string().max(1000),
      }),
    )
    .max(50),
});
export type ModelReview = z.infer<typeof ModelReview>;

export const PLAN_JSON_SCHEMA: JsonSchema = toModelJsonSchema(ModelPlan);
export const REPAIR_JSON_SCHEMA: JsonSchema = toModelJsonSchema(ModelRepair);
export const REVIEW_JSON_SCHEMA: JsonSchema = toModelJsonSchema(ModelReview);

export const isExpectation = (s: Pick<Step, "action">) => s.action.startsWith("expect_");

/** Parse a model answer: the structured JSON when present, else the first JSON object in the text. */
export function parseModelJson<T>(
  schema: z.ZodType<T>,
  res: { json?: unknown; text: string },
): T | null {
  const candidates: unknown[] = [];
  if (res.json !== undefined) candidates.push(res.json);
  const start = res.text.indexOf("{");
  const end = res.text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      candidates.push(JSON.parse(res.text.slice(start, end + 1)));
    } catch {
      // not JSON
    }
  }
  for (const c of candidates) {
    const parsed = schema.safeParse(c);
    if (parsed.success) return parsed.data;
  }
  return null;
}
