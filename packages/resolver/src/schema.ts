/** What the resolver model must return. Validated with zod; the JSON Schema is sent to the model. */
import { toModelJsonSchema } from "@app/tour";
import { z } from "zod";

export const ModelRegion = z.object({
  /** Path of a conflicted file, exactly as shown. */
  file: z.string().min(1).max(4096),
  /** 1-based number of the conflict region in that file. */
  conflict: z.number().int().positive(),
  /** The lines that replace the whole region (markers included), without any marker. */
  text: z.string().max(400_000),
});
export type ModelRegion = z.infer<typeof ModelRegion>;

export const ModelFileEdit = z.object({
  path: z.string().min(1).max(4096),
  /** Complete new content; null deletes the file. */
  content: z.string().max(2_000_000).nullable(),
});
export type ModelFileEdit = z.infer<typeof ModelFileEdit>;

export const ModelResolution = z.object({
  status: z.enum(["resolved", "cannot-resolve", "not-a-conflict"]),
  regions: z.array(ModelRegion).max(1000),
  files: z.array(ModelFileEdit).max(100),
  semanticConflictWith: z.string().max(200).nullable(),
  rationale: z.string().trim().min(1).max(4000),
});
export type ModelResolution = z.infer<typeof ModelResolution>;

export const RESOLUTION_JSON_SCHEMA = toModelJsonSchema(ModelResolution);
