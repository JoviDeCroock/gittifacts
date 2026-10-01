/**
 * `evidence sensitive-paths`: changed paths (both sides of renames) matched against the BASE
 * policy's `sensitivePaths`. When the base policy can't be read, the default patterns are still
 * applied (hits are reported) but the item is an error: unknown patterns never read as "no hit".
 */
import { defaultPolicy } from "@app/domain";
import { type SensitivePathHits, sensitivePathHits } from "@app/evidence";
import { loadChanges } from "../lib/changes.js";
import type { Context } from "../lib/context.js";
import { withNote } from "./items.js";
import { readPolicyAt } from "./policy.js";

export async function sensitivePaths(ctx: Context, id = "sensitive-paths"): Promise<SensitivePathHits> {
  const [base, changes] = await Promise.all([readPolicyAt(ctx, ctx.base), loadChanges(ctx)]);
  if (base.resolved === null) {
    const item = sensitivePathHits(changes.touched, defaultPolicy().sensitivePaths, { id });
    return { ...item, status: "error", note: `base policy unavailable (${base.error ?? "unknown error"}); matched against the default patterns` };
  }
  const item = sensitivePathHits(changes.touched, base.resolved.sensitivePaths, { id });
  return base.source === "default" ? withNote(item, "no policy file at base; default patterns") : item;
}
