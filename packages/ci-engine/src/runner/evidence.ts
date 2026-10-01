/** Parsing the evidence document an evidence command produces. Runtime-agnostic. */
import { EvidenceItem } from "@app/evidence";
import { z } from "zod";
import { formatIssues } from "../plan/spec.js";
import { errorMessage } from "./container.js";

/** One `EvidenceItem` or an array of up to 50. */
export const EvidenceDocument = z.union([z.array(EvidenceItem).max(50), EvidenceItem]);

export function parseEvidenceDocument(
  raw: string,
): { ok: true; items: EvidenceItem[] } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `evidence is not JSON: ${errorMessage(error)}` };
  }
  const parsed = EvidenceDocument.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: `evidence does not match the schema\n${formatIssues(parsed.error)}`,
    };
  }
  return { ok: true, items: Array.isArray(parsed.data) ? parsed.data : [parsed.data] };
}
