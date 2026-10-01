/**
 * `gittifacts-runner` output protocol (apps/sandbox/README.md): logs go to stderr; the result is
 * the last stdout line, prefixed with a marker (`::plan::`, `::evidence::`, `::preview::`).
 * Runtime-agnostic.
 */
import { z } from "zod";
import { type PipelineSpec, parsePipelineSpec } from "../plan/spec.js";

export const PLAN_MARKER = "::plan::";
export const EVIDENCE_MARKER = "::evidence::";
export const PREVIEW_MARKER = "::preview::";

/** The payload of the last line starting with `marker`, or null. */
export function lastMarkedLine(text: string, marker: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").replace(/\r$/, "");
    if (line.startsWith(marker)) return line.slice(marker.length);
  }
  return null;
}

/** `::plan::{"error","file"}`: the pipeline file is the author's problem, not the platform's. */
export const PlanAuthorError = z.object({ error: z.string().min(1), file: z.string().optional() });

export type PlanParse =
  | { ok: true; spec: PipelineSpec }
  | { ok: false; error: string; author: boolean };

/** Parses `gittifacts-runner plan` stdout. */
export function parsePlanOutput(stdout: string, file: string): PlanParse {
  const payload = lastMarkedLine(stdout, PLAN_MARKER);
  if (payload === null) {
    return {
      ok: false,
      author: false,
      error: `gittifacts-runner plan printed no ${PLAN_MARKER} line`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return { ok: false, author: false, error: `the ${PLAN_MARKER} line is not JSON` };
  }
  const authorError = PlanAuthorError.safeParse(json);
  if (authorError.success) {
    return {
      ok: false,
      author: true,
      error: `${authorError.data.file ?? file}: ${authorError.data.error}`,
    };
  }
  const spec = parsePipelineSpec(json);
  if (!spec.ok) {
    return {
      ok: false,
      author: true,
      error: `${file} describes an invalid pipeline\n${spec.error}`,
    };
  }
  return { ok: true, spec: spec.value };
}
