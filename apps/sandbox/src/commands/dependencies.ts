/**
 * `evidence dependencies`: every package.json at base and head, read from git objects (never
 * from the working tree, which an install step may have touched), diffed by the pure producer.
 * The lockfile flag comes from the paths the change touches.
 */
import { type DependencyDiff, dependencyDiff } from "@app/evidence";
import { loadChanges } from "../lib/changes.js";
import type { Context } from "../lib/context.js";
import { readManifests } from "../lib/repo.js";

export async function dependencies(ctx: Context): Promise<DependencyDiff> {
  const [base, head, changes] = await Promise.all([readManifests(ctx.repo, ctx.base), readManifests(ctx.repo, ctx.head), loadChanges(ctx)]);
  return dependencyDiff(base, head, { changedPaths: changes.touched });
}
