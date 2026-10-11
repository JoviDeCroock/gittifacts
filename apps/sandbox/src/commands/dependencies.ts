/**
 * `evidence dependencies`: every package.json at base and head, read from git objects (never
 * from the working tree, which an install step may have touched), diffed by the pure producer.
 * Every lockfile the change touches is read the same way at both commits and handed over, so
 * the producer can check that each lockfile change is explained by a recorded patch bump
 * (security audit M7). A lockfile missing at one side is left out of that side's map; one too
 * big to read is left out of both, which the producer reports as unchecked (never verified).
 */
import { type DependencyDiff, dependencyDiff, LOCKFILE_NAMES } from "@app/evidence";
import { loadChanges } from "../lib/changes.js";
import type { Context } from "../lib/context.js";
import { git, readBlob } from "../lib/git.js";
import { log } from "../lib/log.js";
import { readManifests } from "../lib/repo.js";

/** Largest lockfile read (bytes); stays under the runner's 8 MiB capture of git's stdout. */
export const MAX_LOCKFILE_BYTES = 8 * 1024 * 1024 - 1024;

function isLockfile(path: string): boolean {
  return (LOCKFILE_NAMES as readonly string[]).includes(path.slice(path.lastIndexOf("/") + 1));
}

/** Size of the blob at `rev:path`, or null when it is absent there. */
async function blobSize(repo: string, rev: string, path: string): Promise<number | null> {
  const r = await git(repo, ["cat-file", "-s", `${rev}:${path}`], { allowFail: true });
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isSafeInteger(n) ? n : null;
}

type Texts = Record<string, string>;

/** Texts of the touched lockfiles at base and head, from git objects. */
export async function readLockfiles(
  repo: string,
  base: string,
  head: string,
  touched: readonly string[],
): Promise<{ base: Texts; head: Texts }> {
  const out = { base: {} as Texts, head: {} as Texts };
  for (const path of [...new Set(touched.filter(isLockfile))].sort()) {
    const sizes = await Promise.all([blobSize(repo, base, path), blobSize(repo, head, path)]);
    if (sizes.some((s) => s !== null && s > MAX_LOCKFILE_BYTES)) {
      log(`${path}: larger than ${MAX_LOCKFILE_BYTES} bytes, not read (left unchecked)`);
      continue;
    }
    const [b, h] = await Promise.all([
      sizes[0] === null ? null : readBlob(repo, base, path),
      sizes[1] === null ? null : readBlob(repo, head, path),
    ]);
    if (b !== null) out.base[path] = b;
    if (h !== null) out.head[path] = h;
  }
  return out;
}

export async function dependencies(ctx: Context): Promise<DependencyDiff> {
  const [base, head, changes] = await Promise.all([
    readManifests(ctx.repo, ctx.base),
    readManifests(ctx.repo, ctx.head),
    loadChanges(ctx),
  ]);
  const lockfiles = await readLockfiles(ctx.repo, ctx.base, ctx.head, changes.touched);
  return dependencyDiff(base, head, { changedPaths: changes.touched, lockfiles });
}
