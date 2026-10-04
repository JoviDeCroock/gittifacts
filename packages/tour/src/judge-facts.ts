/**
 * Facts the platform established itself, by running code in a sandbox, that the judge may rely
 * on: they come from the change's signed evidence, never from its author. A verified transform
 * reproduced files byte for byte; the public-API diff compared declarations at base and head.
 *
 * They only answer questions the diff alone can't (did the head come from the codemod? did the
 * public types change?). The judge's answers stay raise-only for the classifier.
 */
import type { EvidenceItem } from "@app/evidence";
import { z } from "zod";

export const JudgeFacts = z
  .object({
    /** Transforms re-run on base in a clean sandbox that reproduced every listed file. */
    transforms: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            command: z.string().min(1).max(500),
            files: z.array(z.string().min(1)).max(10_000),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    /** The public-API diff's classification; null when there is none (or it errored). */
    publicApi: z.enum(["none", "additive", "breaking"]).nullable().default(null),
  })
  .strict();
export type JudgeFacts = z.infer<typeof JudgeFacts>;

/** The facts in a change's (signed) evidence items; failed or unverified items give none. */
export function judgeFactsFrom(items: readonly EvidenceItem[]): JudgeFacts {
  const transforms: JudgeFacts["transforms"] = [];
  let publicApi: JudgeFacts["publicApi"] = null;
  for (const i of items) {
    if (i.status !== "ok") continue;
    if (
      i.kind === "transform" &&
      i.verified &&
      i.mismatchedFiles.length === 0 &&
      i.files.length > 0
    ) {
      transforms.push({ name: i.transform, command: i.command, files: [...i.files] });
    } else if (i.kind === "public-api") {
      publicApi = i.classification;
    }
  }
  return { transforms, publicApi };
}

export const NO_FACTS: JudgeFacts = { transforms: [], publicApi: null };
