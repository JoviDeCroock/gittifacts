/**
 * `policy` (also `evidence policy`): the repository policy as of BASE, plus whether head touches
 * `.platform/**`. The policy file is read from the base commit's git objects, never from the
 * working tree (which is head): a change must not be governed by a policy it edits.
 */
import { join } from "node:path";
import { POLICY_PATH, RepoPolicy } from "@app/domain";
import { z } from "zod";
import { loadChanges } from "../lib/changes.js";
import type { Context } from "../lib/context.js";
import { readBlob } from "../lib/git.js";
import { bundleModule, evaluateDefaultExport } from "../lib/module-eval.js";

export const PolicyDocument = z
  .object({
    kind: z.literal("policy"),
    /** ok: read (or absent → defaults); error: the base policy could not be evaluated or is invalid. */
    status: z.enum(["ok", "error"]),
    /** The commit the policy was read from (always base). */
    sha: z.string(),
    path: z.literal(POLICY_PATH),
    /** `default`: no policy file at base, the platform defaults apply. */
    source: z.enum(["file", "default"]),
    /** The module's default export as JSON, exactly as evaluated (null when absent or failed). */
    policy: z.unknown(),
    /** `RepoPolicy.parse(policy)` with defaults applied (null when absent, failed or invalid). */
    resolved: RepoPolicy.nullable(),
    /** Validation problems and unknown keys. */
    issues: z.array(z.string()),
    note: z.string().optional(),
    /** Head adds, edits, renames or deletes anything under `.platform/`. */
    platformChanged: z.boolean(),
    platformPaths: z.array(z.string()),
    /** `.platform/policy.ts` itself changes. */
    policyChanged: z.boolean(),
  })
  .strict();
export type PolicyDocument = z.infer<typeof PolicyDocument>;

export interface BasePolicy {
  source: "file" | "default";
  raw: unknown;
  resolved: RepoPolicy | null;
  issues: string[];
  error: string | null;
}

/** Evaluate `.platform/policy.ts` at `rev`. */
export async function readPolicyAt(ctx: Context, rev: string): Promise<BasePolicy> {
  const text = await readBlob(ctx.repo, rev, POLICY_PATH);
  if (text === null) {
    return {
      source: "default",
      raw: null,
      resolved: RepoPolicy.parse({}),
      issues: [],
      error: null,
    };
  }
  const bundled = await bundleModule(
    { kind: "git", repo: ctx.repo, rev, path: POLICY_PATH },
    join(ctx.tmp, "policy"),
  );
  if (!bundled.ok)
    return {
      source: "file",
      raw: null,
      resolved: null,
      issues: [],
      error: `cannot compile ${POLICY_PATH}: ${bundled.error}`,
    };
  const evaluated = await evaluateDefaultExport(bundled.file, ctx.tmp);
  if (!evaluated.ok)
    return { source: "file", raw: null, resolved: null, issues: [], error: evaluated.error };
  const raw = evaluated.value;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      source: "file",
      raw,
      resolved: null,
      issues: [],
      error: `${POLICY_PATH} must \`export default\` an object`,
    };
  }
  const issues: string[] = [];
  const unknown = Object.keys(raw).filter((k) => !(k in RepoPolicy.shape));
  if (unknown.length > 0) issues.push(`unknown keys (ignored): ${unknown.join(", ")}`);
  const parsed = RepoPolicy.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 20))
      issues.push(`${i.path.join(".") || "(root)"}: ${i.message}`);
    return {
      source: "file",
      raw,
      resolved: null,
      issues,
      error: `${POLICY_PATH} at ${rev.slice(0, 12)} is not a valid policy`,
    };
  }
  return { source: "file", raw, resolved: parsed.data, issues, error: null };
}

export async function policy(ctx: Context): Promise<PolicyDocument> {
  const [base, changes] = await Promise.all([readPolicyAt(ctx, ctx.base), loadChanges(ctx)]);
  const platformPaths = changes.touched.filter((p) => p.startsWith(".platform/"));
  const doc: PolicyDocument = {
    kind: "policy",
    status: base.error === null ? "ok" : "error",
    sha: ctx.base,
    path: POLICY_PATH,
    source: base.source,
    policy: base.raw,
    resolved: base.resolved,
    issues: base.issues,
    platformChanged: platformPaths.length > 0,
    platformPaths,
    policyChanged: platformPaths.includes(POLICY_PATH),
  };
  const note = [
    base.error,
    base.source === "default" ? `no ${POLICY_PATH} at base; platform defaults apply` : null,
  ]
    .filter((n): n is string => n !== null)
    .join("; ");
  if (note !== "") doc.note = note.slice(0, 4000);
  return doc;
}
